var async = require('async'),
 readline = require('readline'),
 fs = require ('fs');

// read your config from a JSON file 
var data = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
var key = data.key;
var server = data.server;
var port = data.port;

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

var Bus = require('../lib/bus');
var bus = Bus.create(
  {
    redis: ['redis://' + key + '@' + server + ':' + port ],
    redisOptions: [{tls: true}]
  });
  

bus.on('error', function (err) {
  // an error has occurred
console.log('error: ' + err);
});

var q;

bus.on('online', function() {
    console.log('bus is now online');
    console.log('attaching to a queue');
    q = bus.queue('foo');

    q.on('attached', function () {
      sendMessages();
    });
    q.attach();
  });

  bus.on('offline', function () {
    // the bus is offline - redis is down...
  console.log('offline');
});



// connect the redis instances
bus.connect();

function sendMessages() {
  rl.question('How many messages do you want to send (enter a number)? > ', function(answer) {
    answer = parseInt(answer);
    var time = process.hrtime();
    var messages = [];

    for (var i = 0; i<answer; i++) {
          messages.push({ message: "hello world", itemInBatch: answer, timestampOfBatch: new Date().toISOString() });
    }
    
    async.map(messages, function(message, mapCallback) {
      q.push(message, mapCallback);
        
    }, function(err, results) {
      var diff = process.hrtime(time);
      var millis = diff[1] / 1000000;
      var messagesPerSecond = (answer / millis) * 1000;
      console.log('sent ' + answer + ' messages in ' + millis + ' milliseconds. Thruput = ' + messagesPerSecond + ' messages / second');
      sendMessages();
      
    });    
  });
}