var fs = require('fs');
var events = require('events');
var util = require('util');
var crypto = require('crypto');
var redis = require('redis')
var Logger = require('./logger');
var Connection = require('./connection');
var WSPool = require('./wspool');
var Queue = require('./queue');
var Channel = require('./channel');
var Persistify = require('./persistify');
var Pubsub = require('./pubsub');
var FederationServer = require('./fedserver');
var Federate = require('./federate');

/**
 * A message bus.
 * Options:
 *  - redis - url string of a single redis to connect to or an array of string urls to connects to. a url must have the form redis://<host>[:<port>]
 *  - federate - object with the following options:
 *    - server - an http/https server object to listen for incoming federate connections. if undefined then federation server will not be open.
 *    - secret - a secret key to authenticate with the federates. this key must be shared among all federates. default is 'notsosecret'.
 *    - path - specifies the path within the server to accept federation connections on
 * @constructor
 */
function Bus(options) {
  events.EventEmitter.call(this);

  this.id = "bus:" + crypto.randomBytes(8).toString('hex');
  this.logger = new Logger(this.id);

  this.connections = [];

  this.online = false;
  this.eventsCallbacks = {};

  this._options(options);

  this._startFederationServer();

  if (this.options.redis.length > 0) {
    this._loadScripts();
  } else {
    var _this = this;
    process.nextTick(function() {
      _this.emit('online');
    });
  }
}

util.inherits(Bus, events.EventEmitter);

/**
 * Setup bus options
 * @param options options to set
 * @private
 */
Bus.prototype._options = function(options) {
  this.options = options || {};
  this.withRedis(redis);

  if (!this.options.redis) {
    this.options.redis = [];
  }

  if (!this.options.redisOptions) {
    this.options.redisOptions = [];
  }

  if (typeof this.options.redis === 'string') {
    this.options.redis = [this.options.redis];
  }

  if (this.options.logLevel) {
    this.logger.level(this.options.logLevel);
  }

  if (this.options.logger) {
    this.withLog(this.options.logger);
  }

  this.wspool = new WSPool(this, this.options.federate);
};

/**
 * Turn debug messages to the log on or off
 * @param on
 */
Bus.prototype.debug = function(on) {
  this.logger.level(on ? 5 : 2);
  return this;
};

/**
 * Set the logger object
 * @param logger
 */
Bus.prototype.withLog = function(logger) {
  this.logger.withLog(logger);
  return this;
};

/**
 * Set the redis library to use for creating connections
 * @param redis
 */
Bus.prototype.withRedis = function(redis) {
  this._redis = redis;
  return this;
};

Bus.prototype._startFederationServer = function() {
  if (this.options.federate && this.options.federate.server) {
    this.fedServer = new FederationServer(this, this.options.federate);
  }
};

/**
 * Load the lua scripts used for managing the queue
 * @private
 */
Bus.prototype._loadScripts = function() {
  this.scripts = {};
  this.scriptsToLoad = 0;
  this.scriptsLoaded = false;
  this._readScript('push');
  this._readScript('pop');
  this._readScript('ack');
  this._readScript('index');
};

/**
 * Read a single script to memory
 * @param name the script name to load
 * @private
 */
Bus.prototype._readScript = function(name) {
  ++this.scriptsToLoad;
  var _this = this;
  var file = __dirname + '/lua/'+name+'.lua';
  fs.readFile(file, function(err, content) {
    if (err) {
      _this.logger.isDebug() && _this.logger.debug('error reading lua script ' + file + ': ' + JSON.stringify(err));
      _this.emit('error', err);
      return;
    }
    _this.scripts[name] = {content: content.toString().trim(), name: name};
    if (--_this.scriptsToLoad === 0) {
      _this.scriptsLoaded = true;
      _this._online();
    }
  });
};

/**
 * Get the hash of a script by name
 * @param name
 * @returns {*}
 * @private
 */
Bus.prototype._script = function(name) {
  return this.scripts[name].hash;
};

/**
 * Connect the bus to the specified urls.
 * Events: error, online, offline
 */
Bus.prototype.connect = function() {
  if (this.connections.length > 0) {
    this.emit('error', 'already connected');
    return;
  }

  this.logger.isDebug() && this.logger.debug("bus connecting to: " + this.options.redis);

  var _this = this;
  // open the connections to redis
  var readies = 0;
  this.options.redis.forEach(function(url, index) {
    if (url.indexOf('redis:') === 0) {
      var connection = new Connection(index, _this);
      _this.connections.push(connection);

      var _onConnectionEnd = function (err) {
        if (readies > 0 && --readies === 0) {
          _this.connectionsReady = false;
          _this._offline(err);
        }
      };

      var _onConnectionClose = function (err) {
      };

      var _onConnectionError = function (err) {
        _this.emit('error', err);
      };

      var _onConnectionConnect = function () {
      };

      var _onConnectionReady = function () {
        _this.logger.isDebug() &&  _this.logger.debug("connection to " + url + " is ready");
        // emit the ready event only when all connections are ready
        if (++readies === _this.connections.length) {
          _this.connectionsReady = true;
          _this._online();
        }
      };

      var _onConnectionSubscribe = function (channel, count) {
        if (_this.eventsCallbacks[channel]) {
          _this.eventsCallbacks[channel]('subscribe', channel, count);
        }
      };

      var _onConnectionUnsubscribe = function (channel, count) {
        if (_this.eventsCallbacks[channel]) {
          _this.eventsCallbacks[channel]('unsubscribe', channel, count);
        }
      };

      var _onConnectionMessage = function (message) {
        if (_this.eventsCallbacks[message.channel]) {
          _this.eventsCallbacks[message.channel]('message', message.channel, message.message);
        }
      };

//      var _onConnectionShutdown = function() {
//        connection.removeListener("end", _onConnectionEnd);
//        connection.removeListener("close", _onConnectionClose);
//        connection.removeListener("error", _onConnectionError);
//        connection.removeListener("connect", _onConnectionConnect);
//        connection.removeListener("ready", _onConnectionReady);
//        connection.removeListener("subscribe", _onConnectionSubscribe);
//        connection.removeListener("unsubscribe", _onConnectionUnsubscribe);
//        connection.removeListener("message", _onConnectionMessage);
//        connection.removeListener("shutdown", _onConnectionShutdown);
//        connection.disconnect();
//        _onConnectionEnd(null);
//      };

      connection.on("end", _onConnectionEnd);
      connection.on("close", _onConnectionClose);
      connection.on("error", _onConnectionError);
      connection.on("connect", _onConnectionConnect);
      connection.on("ready", _onConnectionReady);
      connection.on("subscribe", _onConnectionSubscribe);
      connection.on("unsubscribe", _onConnectionUnsubscribe);
      connection.on("message", _onConnectionMessage);
//      connection.on('shutdown', _onConnectionShutdown);

      // currently redis options only contains tls. will allow this to be extended in future versions (e.g. retry strategy)
      connection.connect(url, _this.options.redisOptions[index]);
    } else {
      _this.emit('error', 'unsupported protocol for ' + url);
    }
  });

  if (this.fedServer) {
    this.fedServer.listen();
  }
};


/**
 * Invoked when the bus is online, i.e. all connections are ready
 */
Bus.prototype._online = function() {
  if (this.connectionsReady && this.scriptsLoaded) {
    this.logger.isDebug() && this.logger.debug("uploading scripts to redis");
    var _this = this;
    var scriptKeys = Object.keys(_this.scripts);
    var dones = scriptKeys.length * this.connections.length;
    // load the scripts to redis
    this.connections.forEach(function(connection) {
      scriptKeys.forEach(function(key) {
        var script = _this.scripts[key];
        // calculate the hash of the script
        script.hash = crypto.createHash("sha1").update(script.content).digest("hex");
        // send the script to redis
        connection.script('load', script.content, function(err, resp) {
          if (err) {
            _this.emit('error', 'failed to upload script ' + script.name + ' to redis: ' + err);
          }
          if (--dones === 0) {
            _this.online = true;
            _this.logger.isDebug() && _this.logger.debug("bus is online");
            _this.emit('online');
          }
        });
      });
    });
  }
};

/**
 * Invoked when the bus is offline, i.e. all connections are down
 */
Bus.prototype._offline = function(err) {
  var shouldEmit = this.isOnline();
  this.online = false;
  this.logger.isDebug() && this.logger.debug("bus is offline");
  if (shouldEmit) {
    this.emit('offline', err);
  }
};

/**
 * Returns whether the bus is online or not
 * @returns {boolean|*}
 */
Bus.prototype.isOnline = function() {
  return this.online;
};

/**
 * Get the first available connection
 * @returns {*}
 * @private
 */
Bus.prototype._connectionOne = function() {
  return this.connections[0];
};

/**
 * Get the next available connection
 * @returns {*}
 * @private
 */
Bus.prototype._connectionFor = function(key) {
  var sum = 0;
  for (var i = 0; i < key.length; ++i) {
    sum += key.charCodeAt(i);
  }
  var index = sum % this.connections.length;
  return this.connections[index];
};

/**
 * Get an existing connection to redis to serve the specified key.
 * A random connection is chosen if the key does not exist anywhere.
 * @param key
 * @param cb
 * @private
 */
Bus.prototype._connection = function(key, cb) {
  // most of the time the connections state will be stable so the fastest
  // way is to directly search a specific connection.
  var _this = this;
  var responses = this.connections.length;

  var _callback = function(connection) {
    if (connection) {
      cb && cb(connection);
      _callback = null;
      return;
    }
    if (--responses === 0) {
      // got a response from all the connections
      _callback = null;
      connection = _this._connectionFor(key);
      cb && cb(connection);
    }
  };

  // search for the key in all the connections
  this.connections.forEach(function(c) {
    if (!c.isReady()) {
      _callback && _callback(null);
      return;
    }
    c.exists(key, function(err, resp) {
      if (err) {
        _this.emit('error', "error searching for existing key " + key + ": " + err);
      }
      if (resp === 1) {
        // found it
        _callback && _callback(c);
      } else {
        _callback && _callback(null);
      }
    });
  });
};

/**
 * Disconnect all redis connections, close the fedserver and close all the wspool websocket connections
 */
Bus.prototype.disconnect = function() {
  this.logger.isDebug() && this.logger.debug("disconnecting");

  this.connections.forEach(function(c) {
    c.disconnect();
  });
  this.connections = [];

  if (this.fedServer) {
    this.fedServer.close();
    this.fedServer = null;
  }

  if (this.wspool) {
    this.wspool.close();
    this.wspool = null;
  }
};

/**
 * Subscribe to events on the specified channels on the provided connection
 * @param connection
 * @param channels
 * @param cb
 * @private
 */
Bus.prototype._subscribe = function(connection, channels, cb) {
  if (!Array.isArray(channels)) {
    channels = [channels];
  }
  var _this = this;
  channels.forEach(function(channel) {
    _this.eventsCallbacks[channel] = cb;
  });
  connection.subscribe(channels, function(err) {
    if (err) {
      _this.emit('error', "error subscribing to channels " + channels + ": " + err);
    }
  });
};

/**
 * Unsubscribe from events on the specified channels on the provided connection
 * @param connection
 * @param channels
 * @private
 */
Bus.prototype._unsubscribe = function(connection, channels) {
  if (!Array.isArray(channels)) {
    channels = [channels];
  }
  var _this = this;
  channels.forEach(function(channel) {
    if (_this.eventsCallbacks[channel]) {
      _this.eventsCallbacks[channel]('unsubscribe', channel);
      delete _this.eventsCallbacks[channel];
    }
  });
  connection.unsubscribe(channels, function(err) {
    if (err) {
      _this.emit('error', "error unsubscribing from channels " + channels + ": " + err);
    }
  });
};

/**
 * Create a message queue.
 * @param name
 * @returns {Queue} a Queue object
 */
Bus.prototype.queue = function(name) {
  return new Queue(this, name);
};

/***
 * Create a bi-directional channel.
 * @param name the name of the channel
 * @param local the name of the local endpoint. default is 'client' if calling #connect and 'server' if calling #listen.
 * @param remote the name of the remote endpoint. default is 'server' if calling #connect and 'client' if calling #listen.
 * @returns {Channel} a Channel object
 */
Bus.prototype.channel = function(name, local, remote) {
  return new Channel(this, name, local, remote);
};

/**
 * Persistify the provided object, enabling the object to be persisted to redis
 * @param name name of the object
 * @param object the object to persist
 * @param attributes array of property names to persist in the object. The properties will be automatically defined on the object.
 * @returns {*}
 */
Bus.prototype.persistify = function(name, object, attributes) {
  return Persistify(this, name, object, attributes);
};

/**
 * Create a pubsub channel.
 * @param name
 * @returns {Pubsub} a Pubsub object
 */
Bus.prototype.pubsub = function(name) {
  return new Pubsub(this, name);
};

/**
 * Federate an object to the specified remote bus
 * @param object queue, channel or persisted object
 * @param target string url of the remote bus to federate to
 * @returns {Federate} the federation object. It's possible to use the federation object only after the 'ready' event is emitted.
 */
Bus.prototype.federate = function(object, target) {
  return new Federate(object, target, this.wspool, this.options.federate);
};

function create(options) {
  return new Bus(options);
}

exports = module.exports.create = create;