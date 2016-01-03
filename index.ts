import * as _ from "lodash";
import * as Promise from "bluebird";
import * as bodyParser from "body-parser";
import * as pathExists from "path-exists";
import couchjsonconf = require("couchjsonconf");
let app = require('express')();
let server = require('http').Server(app);
let io = require('socket.io')(server);

let socketioJwt   = require("socketio-jwt");
let rpj = require('request-promise-json');
let jwt = require('jsonwebtoken');

import machClients = require("./modules/machClients");

import audClients = require("./modules/audClients");


if (!pathExists.sync('./conf.json')){
  throw Error('no configuration founded')
}
let conf=require('./conf.json')

let COUCHDB= new couchjsonconf(conf.couchdb)

let Machines=new machClients(COUCHDB);
let Auditors=new audClients();

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())



io.use(socketioJwt.authorize({
  secret: conf.secret,
  handshake: true
}));

server.listen(conf.port);

app.get('/', function (req, res) {
  res.json({online:true})
});




function authcouch(user:string,password:string,db:string){
  return new Promise(function(resolve,reject){
    rpj.get(COUCHDB.for(user,password,db)).then(function(){
      resolve({success:true})
    }).catch(function(err){
      reject({error:'wrong credentials'})
    })
  })
}

function authorizesocket(profile):{}{
return jwt.sign(profile, conf.secret, { expiresInMinutes: 60*5 });
}

app.post('/login', function (req, res) {
  authcouch(req.body.user,req.body.password,req.body.db).then(function(){

  let token=authorizesocket({ user:req.body.user,password:req.body.password,db:req.body.db,serial:req.body.serial })

    res.json({success:true,token:token})
  }).catch(function(err){
    res.json(err)
  })
});

app.get('/ip', function (req, res) {
  res.json({ip:req.connection.remoteAddress})
});

app.get('/sockets', function (req, res) {
  res.json(Machines.sockets())
});
app.get('/machines/:serial/sockets', function (req, res) {
  res.json(Machines.sockets(req.params.serial))
});
app.get('/machines', function (req, res) {
  res.json(Machines.list())
});
app.get('/app/:app/machines', function (req, res) {
 // res.json(Machines.serials())
});

app.get('/machines/:serial/message/:message', function (req, res) {
  _.map(Machines.ios(req.params.serial),function(socket){
    socket.emit('message', req.params.message);

  })
  res.json({})

});

app.post('/machines/:serial/message', function (req, res) {
  _.map(Machines.list(req.params.serial),function(socketid){
    io.to(socketid).emit('message', req.body.data);
  })

});
app.post('/machines/:serial/data', function (req, res) {
  _.map(Machines.list(req.params.serial),function(socketid){
    io.to(socketid).emit('data', req.body.data);
  })
});
app.post('/machines/:serial/exec', function (req, res) {
  _.map(Machines.list(req.params.serial),function(socketid){
    io.to(socketid).emit('exec', req.body.data);
  })
});
app.post('/machines/:serial/npm', function (req, res) {
  _.map(Machines.list(req.params.serial),function(socketid){
    io.to(socketid).emit('npm', req.body.data);
  })
});
app.post('/machines/:serial/task', function (req, res) {
  _.map(Machines.list(req.params.serial),function(socketid){
    io.to(socketid).emit('task', req.body.data);
  })
});

io.on('connection', function (socket) {
  let c = socket.decoded_token;

  if(c.db){
    console.log(c.db)

    Machines.add(c.user,c.password,c.db,c.serial,socket);
    _.map(Auditors.forserial(c.serial),function(socketid){
      io.to(socketid).emit('machine connection', {serial:c.serial});
    })

    socket.on('disconnect', function () {

      _.map(Auditors.forserial(c.serial),function(socketid){
        io.to(socketid).emit('machine disconnection', {serial:c.serial});
      })

      Machines.remove(c.serial,socket.id);
    });
    socket.on('message', function (message) {
      Machines.pushdata(c.serial,'message',message).then(function(docs){

        _.map(Auditors.forserial(c.serial),function(socketid){
          io.to(socketid).emit('machine message', {serial:c.serial,data:message});
        })
      })
    });
    socket.on('data', function (data) {
      Machines.pushdata(c.serial,'data',data).then(function(docs){

        _.map(Auditors.forserial(c.serial),function(socketid){
          io.to(socketid).emit('machine data', {serial:c.serial,data:data});
        })
      })
    });
    socket.on('docs', function (docs) {
      Machines.pushdata(c.serial,'docs',docs).then(function(docs){
        _.map(Auditors.forserial(c.serial),function(socketid){
          io.to(socketid).emit('machine docs', {serial:c.serial,data:docs});
        })

      })
    });
    socket.on('up', function (datas) {
      _.map(Auditors.forserial(c.serial),function(socketid){
        io.to(socketid).emit('machine up', {serial:c.serial});
      })
    })

} else{
  Auditors.add(c.serials,socket.id)
  socket.on('disconnect', function () {
    Auditors.remove(socket.id)
  });

}

console.log('hello! ', socket.id);
});