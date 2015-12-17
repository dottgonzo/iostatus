var app = require('express')();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var Promise = require('promise');
var socketioJwt   = require("socketio-jwt");
var rpj = require('request-promise-json');
jwt = require('jsonwebtoken');
var bodyParser = require('body-parser');

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())

var secret='test public key';

io.use(socketioJwt.authorize({
  secret: secret,
  handshake: true
}));

server.listen(9090);




app.get('/', function (req, res) {
  res.json({online:true})
});

function authcouch(user,password,db){
  return new Promise(function(resolve,reject){
    rpj.get('http://'+user+':'+password+'@192.168.122.44:5984/'+db).then(function(){
      resolve({success:true})
    }).catch(function(err){
      reject({error:'wrong credentials'})
    })
  })

}


app.post('/login', function (req, res) {
  authcouch(req.body.user,req.body.password,req.body.db).then(function(){
    var token = jwt.sign({ user:req.body.user,password:req.body.password,db:req.body.db,serial:req.body.serial }, secret);
    res.json({success:true,token:token})
  }).catch(function(err){
    res.json(err)
  })
});

app.get('/ip', function (req, res) {
  res.json({ip:req.connection.remoteAddress})
});



io.on('connection', function (socket) {

});
