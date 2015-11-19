var fs = require ('fs');


// read your config from a JSON file 
var data = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
var key = data.key;
var server = data.server;
var port = data.port;

var Bus = require('../lib/bus');
var bus = Bus.create(
  {
    redis: ['redis://' + key + '@' + server + ':' + port ],
    redisOptions: [{tls: true}]
  });
  
bus.on('online', function() {
    console.log('bus is now online');
    console.log('attaching to a queue');
    var q = bus.queue('foo');
    
    q.on('attached', function() {
      // fired when we successfully attach to a queue
      console.log('attached to queue. messages will soon start flowing in...');
    });
    
    q.on('message', function(message, id) {
      // on receipt of a message, display it here
      // uncomment / comment the following line for quiet / noisy mode 
      if (id % 100 == 0) 
      console.log(id + ' : ' + message);
      
      q.ack(id, function(err) {
        // acked message
      })
      
    });

    // attach to queue
    q.attach();
    // set reliable to be true and always ask for messages that have not been acked
    // in the future we'll persist the value as last and pass it up here
    q.consume({reliable: true, last: 0})
  });

bus.connect();
