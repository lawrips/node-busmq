// test to make sure redis is working using the library directly
var fs = require ('fs');

// read your config from a JSON file 
var data = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
var key = data.key;
var server = data.server;
var port = data.port;

var redisOptions = {
  tls: true,
  auth_pass: key
}

var redis = require('redis')
  client = redis.createClient(port, server, redisOptions);
  
client.on('connect', function() {
  client.auth(key, function (err, result) {
    if (err) console.log(err);
    console.log(result);
  });
});
