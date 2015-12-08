var fs = require('fs');

// read your config from a JSON file 
var data = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
var key = data.key;
var server = data.server;
var port = data.port;
var queueNames = ['/location', '/test', 'foo'];    
var queues = {};

var Bus = require('../lib/bus');
var bus = Bus.create(
    {
        redis: ['redis://' + key + '@' + server + ':' + port],
        redisOptions: [
            {
                tls: {
                }
            }
        ]
    });

bus.on('online', function () {
    console.log('bus is now online');
    queueNames.forEach(function (queueName) {
        console.log('attaching to queue: ' + queueName);
        queues[queueName] = bus.queue(queueName);
        // attach to queue
        queues[queueName].attach();
        // set reliable to be true and always ask for messages that have not been acked
        // in the future we'll persist the value as last and pass it up here
        queues[queueName].consume({ reliable: true, last: 0 })

        queues[queueName].on('attached', function () {
            // fired when we successfully attach to a queue
            console.log('attached to queue ' + queueName + '. messages will soon start flowing in...');
        });

        queues[queueName].on('message', function (message, id) {
            // on receipt of a message, display it here
            // uncomment / comment the following line for quiet / noisy mode 
            //if (id % 100 == 0) 
            console.log('[' + queueName + ']: ' + id + ' : ' + message);

            queues[queueName].ack(id, function (err) {
                // acked message
            })
        });   
    });

});

bus.on('error', function (err) {
    console.log('error on busmq: ' + err);
});

bus.on('offline', function () {
    // the bus is offline - redis is down...
    console.log('bus is offline');
    console.log("bus status: " + bus.isOnline())
});

bus.connect();
