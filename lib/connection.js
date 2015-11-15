var util = require('util');
var events = require('events');
var _url = require('url');
var Logger = require('./logger');

/**
 * The commands to issue on write connections
 * @private
 */
var _writeCommands = [
  'sadd', 'srem', 'lpush', 'rpush', 'llen', 'lindex', 'del', 'exists', 'set',
  'rpop', 'lpop', 'lrange', 'ltrim', 'incr', 'decr', 'persist', 'expire',
  'hmset', 'hget', 'hset', 'hsetnx', 'hdel', 'hgetall', 'publish', 'eval', 'evalsha',
  'multi', 'exec', 'script', 'send_command'];

/**
 * The commands to issue on read connections
 * @private
 */
var _readCommands = ['subscribe', 'unsubscribe'];

/**
 * A connection to redis.
 * Connects to redis with a write connection and a read connection.
 * The write connection is used to emit commands to redis.
 * The read connection is used to listen for events.
 * This is required because once a connection is used to wait for events
 * it cannot be used to issue further requests.
 * @param index the index of the connection within the hosting bus
 * @param bus the bus object using the connection
 * @constructor
 */
function Connection(index, bus) {
  events.EventEmitter.call(this);
  this.setMaxListeners(0); // remove limit on listeners
  this.index = index;
  this.id = bus.id + ":connection:" + index;
  this._redis = bus._redis;
  this._logger = bus.logger.withTag(this.id);
  this.connected = false;
  this.ready = 0;
  this.pendingCommands = [];
}

util.inherits(Connection, events.EventEmitter);

/**
 * Increment the number of ready redis connections
 * @returns {number} the new ready counter
 * @private
 */
Connection.prototype._incReady = function() {
  return ++this.ready;
};

/**
 * Decrement the number of ready redis connections
 * @returns {number} the new ready counter
 * @private
 */
Connection.prototype._decReady = function() {
  if (this.ready > 0) {
    --this.ready;
  }
  return this.ready;
};

Connection.prototype._shouldEmitReady = function() {
  return this.isReady();
};

Connection.prototype._shouldEmitEnd = function() {
  return this.ready === 0;
};

/**
 * Returns true if both redis connections are ready.
 * @returns {boolean} true if both redis connection are ready
 */
Connection.prototype.isReady = function() {
  return this.connected && this.ready === 2;
};

/**
 * Connects to redis at the specified url
 * @param url the url to connect to
 */
Connection.prototype.connect = function(url, options) {
  if (this.connected) {
    return;
  }

  this._logger.isDebug() && this._logger.debug("connecting to: " + url);

  this.connected = true;
  this.url = url;
  var parsed = _url.parse(url);
  this.auth = parsed.auth;
  this.host = parsed.hostname;
  this.port = parsed.port || 6379;
  // currently redis options only contains tls. will allow this to be extended in future versions (e.g. retry strategy)
  if (options) {
    if (options.tls === true) {
      this.tls = true;
    }
  }

  var _this = this;

  function emit(event, message) {
    // emit the ready event only once when all connections are ready.
    // all other events pass through
    if (event === 'ready') {
      if (_this._shouldEmitReady()) {
        _this.emit(event, message);
        _this.endEmitted = false;
        // if we have pending commands, fire them now
        _this.pendingCommands.forEach(function(pending) {
          pending.command.apply(null, pending.args);
        });
        _this.pendingCommands = [];
      }
    } else if (event === 'end') {
      if (_this._shouldEmitEnd() && !_this.endEmitted) {
        _this.endEmitted = true;
        _this.emit(event, message);
      }
    } else {
      _this.emit(event, message);
    }
  }

  // open physical connections to redis.
  this.clients = {};
  // this connection is used for everything but listening for events
  this._connect('write', _writeCommands, function(event, message) {
    emit(event, message);
  });
  // this connection is used to listen for events.
  this._connect('read', _readCommands, function(event, message) {
    emit(event, message);
  });
};

/**
 * Open a physical connection to redis
 * @param type the type of the connection
 * @param commands set of commands to map from the {Connection} object to this physical connection
 * @param cb emit redis connection events to this cb
 * @returns a physical connection to redis
 * @private
 */
Connection.prototype._connect = function(type, commands, cb) {
  var _this = this;
  var connName = this.id + ":" + type;
  var client = this._redis.createClient(this.port, this.host, {tls: this.tls, auth_pass: this.auth});
  client.name = connName;

  this._setupListeners(client, type, cb);

  // setup sending the specified commands on the right connection
  commands.forEach(function(c) {
    // expose the commands on our object and delegate to the right redis connection
    _this[c] = function() {
      // type will be 'write' or 'read'.
      // in effect, we will get something like: this.lrpop = this['write']['lrpop'] to invoke
      // the 'lrpop' command on the 'write' connection

      var commandArgs = Array.prototype.slice.call(arguments);

      // if this connection is not ready, do not try to emit command.
      // store this invocation and it will fire once 'ready' is received
      if (!_this.isReady()) {
        if (c === 'multi') {
          _this.pendingCommands.push({command: _this['send_command'], args: ['MULTI', []]});
        } else {
          _this.pendingCommands.push({command: _this[c], args: commandArgs});
        }
        return _this;
      }

      // we want to intercept errors to handle special ones
      if (arguments.length > 0 && typeof arguments[arguments.length - 1] === 'function') {
        var origCB = arguments[arguments.length - 1];
        arguments[arguments.length - 1] = function() {
          // check if the first argument is an Error
          if (arguments.length > 0) {
            var arg = arguments[0];
            if (arg && typeof arg === 'object' && arg.constructor && arg.constructor.name === 'Error') {
              // special handling of READONLY error - redis turned into slave
              if (arg.message && arg.message.indexOf('READONLY') === 0) {
                _this._logger.isDebug() && _this._logger.debug('redis is in slave mode - ending connection');
                _this.pendingCommands.push({command: _this[c], args: commandArgs});
                _this.clients.read.retry_delay = 1000;
                _this.clients.read.retry_backoff = 1;
                _this.clients.read.stream.end();
                _this.clients.write.retry_delay = 1000;
                _this.clients.write.retry_backoff = 1;
                _this.clients.write.stream.end();
                return;
              }
            }
          }
          origCB.apply(null, arguments);
        }
      }

      return _this.clients[type][c].apply(client, arguments);
    }
  });

  // push the connection into the physical connections array
  this.clients[type] = client;
};

/**
 * Hookup event listeners to a redis connection
 * @param client
 * @param type
 * @param cb
 * @private
 */
Connection.prototype._setupListeners = function(client, type, cb) {
  var _this = this;
  var clientLogger = this._logger.withTag(client.name);
  var active = true;

  function cleanup() {
    client.removeListener('shutdown', _onClientShutdown);
    client.removeListener('end', _onClientEnd);
    client.removeListener('close', _onClientClose);
    client.removeListener('error', _onClientError);
    client.removeListener('connect', _onClientConnect);
    client.removeListener('ready', _onClientReady);
    client.removeListener('drain', _onClientDrain);
    client.removeListener('unsubscribe', _onClientUnsubscribe);
    client.removeListener('subscribe', _onClientSubscribe);
    client.removeListener('message', _onClientMessage);
  }

  var _onClientEnd = function (err) {
    clientLogger.isDebug() && clientLogger.debug("received end. error: " + err);
    _this._stopPingPong(client);
    _this._decReady();
    active && cb && cb('end', err);
  };

  var _onClientClose = function (err) {
    clientLogger.isDebug() && clientLogger.debug("received close. error: " + err);
//    _this._stopPingPong(client);
//    _this._decReady();
//    active && cb && cb('close', err);
  };

  var _onClientError = function (err) {
    clientLogger.isDebug() && clientLogger.debug("received error: " + err);
    active && cb && cb('error', err);
  };

  var _onClientConnect = function () {
    clientLogger.isDebug() && clientLogger.debug("received connected");
    active && cb && cb('connect');
  };

  var _onClientReady = function () {
    _this._incReady();
    clientLogger.isDebug() && clientLogger.debug("received ready");
    if (client.server_info.role !== 'master') {
      clientLogger.isDebug() && clientLogger.debug('redis role is ' + client.server_info.role + ' but must be master. disconnecting and retrying connection in 1000ms');
      client.retry_delay = 1000;
      client.retry_backoff = 1;
      client.stream.end();
      return;
    }
    // ping-pong only 'write' connections
    if (type === 'write') {
      client.client('SETNAME', client.name);
      _this._startPingPong(client, clientLogger);
    }
    active && cb && cb('ready');
  };

  var _onClientDrain = function () {
    if (type === 'write') {
      active && cb && cb('drain');
    }
  };

  var _onClientUnsubscribe = function (channel, count) {
    active && cb && cb('unsubscribe', channel, count);
  };

  var _onClientSubscribe = function (channel, count) {
    active && cb && cb('subscribe', channel, count);
  };

  var _onClientMessage  = function (channel, message) {
    active && cb && cb('message', {channel: channel, message: message});
  };

  var _onClientShutdown = function() {
    // a requested shutdown by us
    active = false; // no more callbacks
    _this._stopPingPong(client);
    client.end();
    _this._decReady();
    cb && cb('end');
    cleanup();
  };

  client.on('shutdown', _onClientShutdown);
  client.on('end', _onClientEnd);
  client.on('close', _onClientClose);
  client.on('error', _onClientError);
  client.on('connect', _onClientConnect);
  client.on('ready', _onClientReady);
  client.on('drain', _onClientDrain);
  client.on('unsubscribe', _onClientUnsubscribe);
  client.on('subscribe', _onClientSubscribe);
  client.on('message', _onClientMessage);
};

/**
 * Continuously ping-pongs the server to check that it is still alive
 * @private
 */
Connection.prototype._startPingPong = function(client, clientLogger) {
  if (client._pingPong) {
    return;
  }

  client._pingPong = setInterval(function() {
    client.ping(function(err, resp) {
      if (err) {
        clientLogger.isDebug() && clientLogger.debug('error in ping-pong: ' + err);
      }
    });
  }, 1000);
};

/**
 * Stop the ping pong timer
 * @param client
 * @private
 */
Connection.prototype._stopPingPong = function(client) {
  if (!client._pingPong) {
    return;
  }

  clearInterval(client._pingPong);
  client._pingPong = null;
};

/**
 * Disconnect from redis. Ends all redis connections.
 */
Connection.prototype.disconnect = function() {
  if (!this.connected) {
    return;
  }

  this._logger.isDebug() && this._logger.debug("disconnecting");

  this.clients.write.emit('shutdown');
  this.clients.read.emit('shutdown');

  this.connected = false;
};

exports = module.exports = Connection;