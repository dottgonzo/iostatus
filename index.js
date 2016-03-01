var net = require("net");
var _ = require("lodash");
var Promise = require("bluebird");
var bodyParser = require("body-parser");
var pathExists = require("path-exists");
var IO = require("socket.io");
var express = require("express");
var jwt = require("jsonwebtoken");
var couchjsonconf = require("couchjsonconf");
var machClients = require("./modules/machClients");
var audClients = require("./modules/audClients");
var socketioJwt = require("socketio-jwt");
var rpj = require('request-promise-json');
var aedes = require("aedes");
var app = express();
var server = require('http').Server(app);
var io = IO(server);
if (!pathExists.sync('./conf.json')) {
    throw Error('no configuration founded');
}
var conf = require('./conf.json');
var COUCHDB = new couchjsonconf(conf.couchdb);
var Machines = new machClients(COUCHDB);
var Auditors = new audClients();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
io.use(socketioJwt.authorize({
    secret: conf.secret,
    handshake: true
}));
server.listen(conf.port);
var Aedes = aedes();
var Aserver = net.createServer(Aedes.handle);
Aserver.listen(1883, function () {
    console.log('MQTT server listening on port', 1883);
});
Aedes.authenticate = function (client, username, token, callback) {
    var db = jwt.verify(JSON.parse(token + ""), conf.secret).db;
    var password = jwt.verify(JSON.parse(token + ""), conf.secret).password;
    console.log("auth");
    console.log(username);
    console.log(password);
    console.log(db);
    authcouch(username, password, db).then(function () {
        console.log("authorized " + username);
        client.couch = { username: username, password: password, db: db };
        callback(null, true);
    }).catch(function () {
        console.log("unauthorized " + username);
        callback(null);
    });
};
Aedes.on('client', function (client) {
    console.log("new client" + client.id);
    console.log(client.couch);
});
Aedes.on('clientDisconnect', function (client) {
    console.log("clientDisconnect");
});
Aedes.on('subscribe', function (topic, client) {
    console.log("subscribe");
});
Aedes.on('unsubscribe', function (topic, client) {
    console.log("unsubscribe");
});
Aedes.on('publish', function (packet, client) {
    if (!client)
        return;
    var obj = JSON.parse(packet.payload.toString());
    console.log("publish");
    if (packet.topic.split("/").length > 1 && packet.topic.split("/")[0] == "data" && client.couch && client.couch && client.couch.username) {
        console.log("save");
        rpj.post("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + '/', obj).then(function () {
            console.log("backup");
        }).catch(function (err) {
            console.log("save error " + err);
        });
    }
});
app.get('/', function (req, res) {
    res.json({ online: true });
});
function authcouch(user, password, db) {
    return new Promise(function (resolve, reject) {
        rpj.get(COUCHDB.for(user, password, db)).then(function () {
            resolve({ success: true });
        }).catch(function (err) {
            reject({ error: 'wrong credentials' });
        });
    });
}
function authorizesocket(profile) {
    return jwt.sign(profile, conf.secret, { expiresInMinutes: 60 * 5 });
}
app.post('/login', function (req, res) {
    authcouch(req.body.user, req.body.password, req.body.db).then(function () {
        var token = authorizesocket({ user: req.body.user, password: req.body.password, db: req.body.db, serial: req.body.serial });
        res.json({ success: true, token: token });
    }).catch(function (err) {
        res.json(err);
    });
});
app.get('/ip', function (req, res) {
    res.json({ ip: req.headers['x-forwarded-for'] });
});
app.get('/sockets', function (req, res) {
    res.json(Machines.sockets());
});
app.get('/machines/:serial/sockets', function (req, res) {
    res.json(Machines.sockets(req.params.serial));
});
app.get('/machines', function (req, res) {
    res.json(Machines.list());
});
app.get('/app/:app/machines', function (req, res) {
});
app.get('/machines/:serial/message/:message', function (req, res) {
    _.map(Machines.ios(req.params.serial), function (socket) {
        socket.emit('message', req.params.message);
    });
    res.json({});
});
app.post('/machines/:serial/message', function (req, res) {
    _.map(Machines.list(req.params.serial), function (socketid) {
        io.to(socketid).emit('message', req.body.data);
    });
});
app.post('/machines/:serial/data', function (req, res) {
    _.map(Machines.list(req.params.serial), function (socketid) {
        io.to(socketid).emit('data', req.body.data);
    });
});
app.post('/machines/:serial/exec', function (req, res) {
    _.map(Machines.list(req.params.serial), function (socketid) {
        io.to(socketid).emit('exec', req.body.data);
    });
});
app.post('/machines/:serial/npm', function (req, res) {
    _.map(Machines.list(req.params.serial), function (socketid) {
        io.to(socketid).emit('npm', req.body.data);
    });
});
app.post('/machines/:serial/task', function (req, res) {
    _.map(Machines.list(req.params.serial), function (socketid) {
        io.to(socketid).emit('task', req.body.data);
    });
});
io.on('connection', function (socket) {
    var c = socket.decoded_token;
    if (c.db) {
        console.log(c.db);
        Machines.add(c.user, c.password, c.db, c.serial, socket);
        _.map(Auditors.forserial(c.serial), function (socketid) {
            io.to(socketid).emit('machine connection', { serial: c.serial });
        });
        socket.on('disconnect', function () {
            _.map(Auditors.forserial(c.serial), function (socketid) {
                io.to(socketid).emit('machine disconnection', { serial: c.serial });
            });
            Machines.remove(c.serial, socket.id);
        });
        socket.on('message', function (message) {
            Machines.pushdata(c.serial, 'message', message).then(function (docs) {
                _.map(Auditors.forserial(c.serial), function (socketid) {
                    io.to(socketid).emit('machine message', { serial: c.serial, data: message });
                });
            });
        });
        socket.on('data', function (data) {
            Machines.pushdata(c.serial, 'data', data).then(function (docs) {
                _.map(Auditors.forserial(c.serial), function (socketid) {
                    io.to(socketid).emit('machine data', { serial: c.serial, data: data });
                });
            });
        });
        socket.on('docs', function (docs) {
            Machines.pushdata(c.serial, 'docs', docs).then(function (docs) {
                _.map(Auditors.forserial(c.serial), function (socketid) {
                    io.to(socketid).emit('machine docs', { serial: c.serial, data: docs });
                });
            });
        });
        socket.on('up', function (datas) {
            _.map(Auditors.forserial(c.serial), function (socketid) {
                io.to(socketid).emit('machine up', { serial: c.serial });
            });
        });
    }
    else {
        Auditors.add(c.serials, socket.id);
        socket.on('disconnect', function () {
            Auditors.remove(socket.id);
        });
    }
    console.log('hello! ', socket.id);
});

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm5hbWVzIjpbImF1dGhjb3VjaCIsImF1dGhvcml6ZXNvY2tldCJdLCJtYXBwaW5ncyI6IkFBQUEsSUFBWSxHQUFHLFdBQU0sS0FBSyxDQUFDLENBQUE7QUFDM0IsSUFBWSxDQUFDLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDNUIsSUFBWSxPQUFPLFdBQU0sVUFBVSxDQUFDLENBQUE7QUFDcEMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxFQUFFLFdBQU0sV0FBVyxDQUFDLENBQUE7QUFDaEMsSUFBWSxPQUFPLFdBQU0sU0FBUyxDQUFDLENBQUE7QUFDbkMsSUFBWSxHQUFHLFdBQU0sY0FBYyxDQUFDLENBQUE7QUFHcEMsSUFBTyxhQUFhLFdBQVcsZUFBZSxDQUFDLENBQUM7QUFFaEQsSUFBTyxXQUFXLFdBQVcsdUJBQXVCLENBQUMsQ0FBQztBQUN0RCxJQUFPLFVBQVUsV0FBVyxzQkFBc0IsQ0FBQyxDQUFDO0FBRXBELElBQUksV0FBVyxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUMxQyxJQUFJLEdBQUcsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUMxQyxJQUFJLEtBQUssR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7QUFHN0IsSUFBSSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDcEIsSUFBSSxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6QyxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUM7QUFNcEIsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsQyxNQUFNLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFBO0FBQzNDLENBQUM7QUFDRCxJQUFJLElBQUksR0FBRyxPQUFPLENBQUMsYUFBYSxDQUFDLENBQUE7QUFFakMsSUFBSSxPQUFPLEdBQUcsSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFBO0FBRTdDLElBQUksUUFBUSxHQUFHLElBQUksV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3hDLElBQUksUUFBUSxHQUFHLElBQUksVUFBVSxFQUFFLENBQUM7QUFHaEMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQTtBQUduRCxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFBO0FBSTFCLEVBQUUsQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQztJQUN6QixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07SUFDbkIsU0FBUyxFQUFFLElBQUk7Q0FDbEIsQ0FBQyxDQUFDLENBQUM7QUFFSixNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUd6QixJQUFJLEtBQUssR0FBRyxLQUFLLEVBQUUsQ0FBQTtBQUNuQixJQUFJLE9BQU8sR0FBRyxHQUFHLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQTtBQUU1QyxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRTtJQUNqQixPQUFPLENBQUMsR0FBRyxDQUFDLCtCQUErQixFQUFFLElBQUksQ0FBQyxDQUFBO0FBQ3RELENBQUMsQ0FBQyxDQUFDO0FBR0gsS0FBSyxDQUFDLFlBQVksR0FBRyxVQUFTLE1BQU0sRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLFFBQVE7SUFFM0QsSUFBSSxFQUFFLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFBO0lBQzNELElBQUksUUFBUSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFFBQVEsQ0FBQTtJQUN2RSxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFBO0lBQ25CLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUE7SUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQTtJQUNyQixPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFBO0lBRWYsU0FBUyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ25DLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxHQUFHLFFBQVEsQ0FBQyxDQUFBO1FBQ3JDLE1BQU0sQ0FBQyxLQUFLLEdBQUcsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFBO1FBQ2pFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUE7SUFDeEIsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO1FBQ0wsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFlLEdBQUcsUUFBUSxDQUFDLENBQUE7UUFDdkMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFBO0lBQ2xCLENBQUMsQ0FBQyxDQUFBO0FBS04sQ0FBQyxDQUFBO0FBRUQsS0FBSyxDQUFDLEVBQUUsQ0FBQyxRQUFRLEVBQUUsVUFBUyxNQUFNO0lBRzlCLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxHQUFHLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQTtJQUVyQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQTtBQUU3QixDQUFDLENBQUMsQ0FBQztBQUVILEtBQUssQ0FBQyxFQUFFLENBQUMsa0JBQWtCLEVBQUUsVUFBUyxNQUFNO0lBQ3hDLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtBQUNuQyxDQUFDLENBQUMsQ0FBQztBQUVILEtBQUssQ0FBQyxFQUFFLENBQUMsV0FBVyxFQUFFLFVBQVMsS0FBSyxFQUFFLE1BQU07SUFDeEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQTtBQUM1QixDQUFDLENBQUMsQ0FBQztBQUVILEtBQUssQ0FBQyxFQUFFLENBQUMsYUFBYSxFQUFFLFVBQVMsS0FBSyxFQUFFLE1BQU07SUFDMUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQTtBQUM5QixDQUFDLENBQUMsQ0FBQztBQUVILEtBQUssQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLFVBQVMsTUFBTSxFQUFFLE1BQU07SUFFdkMsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7UUFBQyxNQUFNLENBQUM7SUFFcEIsSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDaEQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUV2QixFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLE1BQU0sSUFBRSxNQUFNLENBQUMsS0FBSyxJQUFFLE1BQU0sQ0FBQyxLQUFLLElBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO1FBRXBJLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7UUFFaEIsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEdBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEdBQUMsR0FBRyxHQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxHQUFDLHVCQUF1QixHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxHQUFHLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUM7WUFDMUgsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUMxQixDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBUyxHQUFHO1lBQ2pCLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxHQUFHLEdBQUcsQ0FBQyxDQUFDO1FBQ3JDLENBQUMsQ0FBQyxDQUFDO0lBR1AsQ0FBQztBQUtMLENBQUMsQ0FBQyxDQUFDO0FBb0JILEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDMUIsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFBO0FBQzlCLENBQUMsQ0FBQyxDQUFDO0FBS0gsbUJBQW1CLElBQVksRUFBRSxRQUFnQixFQUFFLEVBQVU7SUFDekRBLE1BQU1BLENBQUNBLElBQUlBLE9BQU9BLENBQUNBLFVBQVNBLE9BQU9BLEVBQUVBLE1BQU1BO1FBQ3ZDLEdBQUcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQzFDLE9BQU8sQ0FBQyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFBO1FBQzlCLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFTLEdBQUc7WUFDakIsTUFBTSxDQUFDLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixFQUFFLENBQUMsQ0FBQTtRQUMxQyxDQUFDLENBQUMsQ0FBQTtJQUNOLENBQUMsQ0FBQ0EsQ0FBQUE7QUFDTkEsQ0FBQ0E7QUFFRCx5QkFBeUIsT0FBTztJQUM1QkMsTUFBTUEsQ0FBQ0EsR0FBR0EsQ0FBQ0EsSUFBSUEsQ0FBQ0EsT0FBT0EsRUFBRUEsSUFBSUEsQ0FBQ0EsTUFBTUEsRUFBRUEsRUFBRUEsZ0JBQWdCQSxFQUFFQSxFQUFFQSxHQUFHQSxDQUFDQSxFQUFFQSxDQUFDQSxDQUFDQTtBQUN4RUEsQ0FBQ0E7QUFFRCxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxVQUFTLEdBQUcsRUFBRSxHQUFHO0lBQ2hDLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUUxRCxJQUFJLEtBQUssR0FBRyxlQUFlLENBQUMsRUFBRSxJQUFJLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLEVBQUUsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFBO1FBRTNILEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFBO0lBQzdDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFTLEdBQUc7UUFDakIsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQTtJQUNqQixDQUFDLENBQUMsQ0FBQTtBQUNOLENBQUMsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsVUFBUyxHQUFHLEVBQUUsR0FBRztJQUM1QixHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLEdBQUcsQ0FBQyxPQUFPLENBQUMsaUJBQWlCLENBQUMsRUFBRSxDQUFDLENBQUE7QUFDcEQsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxVQUFTLEdBQUcsRUFBRSxHQUFHO0lBQ2pDLEdBQUcsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUE7QUFDaEMsQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsR0FBRyxDQUFDLDJCQUEyQixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDbEQsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQTtBQUNqRCxDQUFDLENBQUMsQ0FBQztBQUNILEdBQUcsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDbEMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQTtBQUM3QixDQUFDLENBQUMsQ0FBQztBQUNILEdBQUcsQ0FBQyxHQUFHLENBQUMsb0JBQW9CLEVBQUUsVUFBUyxHQUFHLEVBQUUsR0FBRztBQUUvQyxDQUFDLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsb0NBQW9DLEVBQUUsVUFBUyxHQUFHLEVBQUUsR0FBRztJQUMzRCxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxVQUFTLE1BQU07UUFDbEQsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUUvQyxDQUFDLENBQUMsQ0FBQTtJQUNGLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUE7QUFFaEIsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsSUFBSSxDQUFDLDJCQUEyQixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDbkQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ25ELENBQUMsQ0FBQyxDQUFBO0FBRU4sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDaEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2hELENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDaEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2hELENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHVCQUF1QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDL0MsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQy9DLENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDaEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2hELENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFFSCxFQUFFLENBQUMsRUFBRSxDQUFDLFlBQVksRUFBRSxVQUFTLE1BQWU7SUFDeEMsSUFBSSxDQUFDLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQztJQUU3QixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUNQLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBRWpCLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztRQUN6RCxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFVBQVMsUUFBUTtZQUNqRCxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxvQkFBb0IsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUNyRSxDQUFDLENBQUMsQ0FBQTtRQUVGLE1BQU0sQ0FBQyxFQUFFLENBQUMsWUFBWSxFQUFFO1lBRXBCLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO2dCQUNqRCxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyx1QkFBdUIsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztZQUN4RSxDQUFDLENBQUMsQ0FBQTtZQUVGLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDekMsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLFNBQVMsRUFBRSxVQUFTLE9BQU87WUFDakMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBUyxJQUFJO2dCQUU5RCxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFVBQVMsUUFBUTtvQkFDakQsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztnQkFDakYsQ0FBQyxDQUFDLENBQUE7WUFDTixDQUFDLENBQUMsQ0FBQTtRQUNOLENBQUMsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsVUFBUyxJQUFJO1lBQzNCLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVMsSUFBSTtnQkFFeEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxVQUFTLFFBQVE7b0JBQ2pELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUMzRSxDQUFDLENBQUMsQ0FBQTtZQUNOLENBQUMsQ0FBQyxDQUFBO1FBQ04sQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxVQUFTLElBQUk7WUFDM0IsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBUyxJQUFJO2dCQUN4RCxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFVBQVMsUUFBUTtvQkFDakQsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBQzNFLENBQUMsQ0FBQyxDQUFBO1lBRU4sQ0FBQyxDQUFDLENBQUE7UUFDTixDQUFDLENBQUMsQ0FBQztRQUNILE1BQU0sQ0FBQyxFQUFFLENBQUMsSUFBSSxFQUFFLFVBQVMsS0FBSztZQUMxQixDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFVBQVMsUUFBUTtnQkFDakQsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1lBQzdELENBQUMsQ0FBQyxDQUFBO1FBQ04sQ0FBQyxDQUFDLENBQUE7SUFFTixDQUFDO0lBQUMsSUFBSSxDQUFDLENBQUM7UUFDSixRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBQ2xDLE1BQU0sQ0FBQyxFQUFFLENBQUMsWUFBWSxFQUFFO1lBQ3BCLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBQzlCLENBQUMsQ0FBQyxDQUFDO0lBRVAsQ0FBQztJQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyIsImZpbGUiOiJpbmRleC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIG5ldCBmcm9tIFwibmV0XCI7XG5pbXBvcnQgKiBhcyBfIGZyb20gXCJsb2Rhc2hcIjtcbmltcG9ydCAqIGFzIFByb21pc2UgZnJvbSBcImJsdWViaXJkXCI7XG5pbXBvcnQgKiBhcyBib2R5UGFyc2VyIGZyb20gXCJib2R5LXBhcnNlclwiO1xuaW1wb3J0ICogYXMgcGF0aEV4aXN0cyBmcm9tIFwicGF0aC1leGlzdHNcIjtcbmltcG9ydCAqIGFzIElPIGZyb20gXCJzb2NrZXQuaW9cIjtcbmltcG9ydCAqIGFzIGV4cHJlc3MgZnJvbSBcImV4cHJlc3NcIjtcbmltcG9ydCAqIGFzIGp3dCBmcm9tIFwianNvbndlYnRva2VuXCI7XG5pbXBvcnQgKiBhcyByZWRpcyBmcm9tIFwicmVkaXNcIjtcblxuaW1wb3J0IGNvdWNoanNvbmNvbmYgPSByZXF1aXJlKFwiY291Y2hqc29uY29uZlwiKTtcblxuaW1wb3J0IG1hY2hDbGllbnRzID0gcmVxdWlyZShcIi4vbW9kdWxlcy9tYWNoQ2xpZW50c1wiKTtcbmltcG9ydCBhdWRDbGllbnRzID0gcmVxdWlyZShcIi4vbW9kdWxlcy9hdWRDbGllbnRzXCIpO1xuXG5sZXQgc29ja2V0aW9Kd3QgPSByZXF1aXJlKFwic29ja2V0aW8tand0XCIpO1xubGV0IHJwaiA9IHJlcXVpcmUoJ3JlcXVlc3QtcHJvbWlzZS1qc29uJyk7XG5sZXQgYWVkZXMgPSByZXF1aXJlKFwiYWVkZXNcIik7XG5cblxubGV0IGFwcCA9IGV4cHJlc3MoKTtcbmxldCBzZXJ2ZXIgPSByZXF1aXJlKCdodHRwJykuU2VydmVyKGFwcCk7XG5sZXQgaW8gPSBJTyhzZXJ2ZXIpO1xuXG5cblxuXG5cbmlmICghcGF0aEV4aXN0cy5zeW5jKCcuL2NvbmYuanNvbicpKSB7XG4gICAgdGhyb3cgRXJyb3IoJ25vIGNvbmZpZ3VyYXRpb24gZm91bmRlZCcpXG59XG5sZXQgY29uZiA9IHJlcXVpcmUoJy4vY29uZi5qc29uJylcblxubGV0IENPVUNIREIgPSBuZXcgY291Y2hqc29uY29uZihjb25mLmNvdWNoZGIpXG5cbmxldCBNYWNoaW5lcyA9IG5ldyBtYWNoQ2xpZW50cyhDT1VDSERCKTtcbmxldCBBdWRpdG9ycyA9IG5ldyBhdWRDbGllbnRzKCk7XG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZFxuYXBwLnVzZShib2R5UGFyc2VyLnVybGVuY29kZWQoeyBleHRlbmRlZDogZmFsc2UgfSkpXG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL2pzb25cbmFwcC51c2UoYm9keVBhcnNlci5qc29uKCkpXG5cblxuXG5pby51c2Uoc29ja2V0aW9Kd3QuYXV0aG9yaXplKHtcbiAgICBzZWNyZXQ6IGNvbmYuc2VjcmV0LFxuICAgIGhhbmRzaGFrZTogdHJ1ZVxufSkpO1xuXG5zZXJ2ZXIubGlzdGVuKGNvbmYucG9ydCk7XG5cblxubGV0IEFlZGVzID0gYWVkZXMoKVxubGV0IEFzZXJ2ZXIgPSBuZXQuY3JlYXRlU2VydmVyKEFlZGVzLmhhbmRsZSlcblxuQXNlcnZlci5saXN0ZW4oMTg4MywgZnVuY3Rpb24oKSB7XG4gICAgY29uc29sZS5sb2coJ01RVFQgc2VydmVyIGxpc3RlbmluZyBvbiBwb3J0JywgMTg4Mylcbn0pO1xuXG5cbkFlZGVzLmF1dGhlbnRpY2F0ZSA9IGZ1bmN0aW9uKGNsaWVudCwgdXNlcm5hbWUsIHRva2VuLCBjYWxsYmFjaykge1xuXG4gICAgbGV0IGRiID0gand0LnZlcmlmeShKU09OLnBhcnNlKHRva2VuICsgXCJcIiksIGNvbmYuc2VjcmV0KS5kYlxuICAgIGxldCBwYXNzd29yZCA9IGp3dC52ZXJpZnkoSlNPTi5wYXJzZSh0b2tlbiArIFwiXCIpLCBjb25mLnNlY3JldCkucGFzc3dvcmRcbiAgICBjb25zb2xlLmxvZyhcImF1dGhcIilcbiAgICBjb25zb2xlLmxvZyh1c2VybmFtZSlcbiAgICBjb25zb2xlLmxvZyhwYXNzd29yZClcbiAgICBjb25zb2xlLmxvZyhkYilcbiAgICAvLyBcbiAgICBhdXRoY291Y2godXNlcm5hbWUsIHBhc3N3b3JkLCBkYikudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJhdXRob3JpemVkIFwiICsgdXNlcm5hbWUpXG4gICAgICAgIGNsaWVudC5jb3VjaCA9IHsgdXNlcm5hbWU6IHVzZXJuYW1lLCBwYXNzd29yZDogcGFzc3dvcmQsIGRiOiBkYiB9XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHRydWUpXG4gICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFwidW5hdXRob3JpemVkIFwiICsgdXNlcm5hbWUpXG4gICAgICAgIGNhbGxiYWNrKG51bGwpXG4gICAgfSlcblxuXG5cblxufVxuXG5BZWRlcy5vbignY2xpZW50JywgZnVuY3Rpb24oY2xpZW50KSB7XG5cblxuICAgIGNvbnNvbGUubG9nKFwibmV3IGNsaWVudFwiICsgY2xpZW50LmlkKVxuXG4gICAgY29uc29sZS5sb2coY2xpZW50LmNvdWNoKVxuXG59KTtcblxuQWVkZXMub24oJ2NsaWVudERpc2Nvbm5lY3QnLCBmdW5jdGlvbihjbGllbnQpIHtcbiAgICBjb25zb2xlLmxvZyhcImNsaWVudERpc2Nvbm5lY3RcIilcbn0pO1xuXG5BZWRlcy5vbignc3Vic2NyaWJlJywgZnVuY3Rpb24odG9waWMsIGNsaWVudCkge1xuICAgIGNvbnNvbGUubG9nKFwic3Vic2NyaWJlXCIpXG59KTtcblxuQWVkZXMub24oJ3Vuc3Vic2NyaWJlJywgZnVuY3Rpb24odG9waWMsIGNsaWVudCkge1xuICAgIGNvbnNvbGUubG9nKFwidW5zdWJzY3JpYmVcIilcbn0pO1xuXG5BZWRlcy5vbigncHVibGlzaCcsIGZ1bmN0aW9uKHBhY2tldCwgY2xpZW50KSB7XG5cbiAgICBpZiAoIWNsaWVudCkgcmV0dXJuO1xuXG4gICAgbGV0IG9iaiA9IEpTT04ucGFyc2UocGFja2V0LnBheWxvYWQudG9TdHJpbmcoKSk7XG4gICAgY29uc29sZS5sb2coXCJwdWJsaXNoXCIpO1xuICAgIFxuICAgIGlmIChwYWNrZXQudG9waWMuc3BsaXQoXCIvXCIpLmxlbmd0aCA+IDEgJiYgcGFja2V0LnRvcGljLnNwbGl0KFwiL1wiKVswXSA9PSBcImRhdGFcIiYmY2xpZW50LmNvdWNoJiZjbGllbnQuY291Y2gmJmNsaWVudC5jb3VjaC51c2VybmFtZSkge1xuICAgICAgICAvLyAgICBycGoucG9zdCgpXG4gICAgY29uc29sZS5sb2coXCJzYXZlXCIpO1xuICAgIFxuICAgICAgICBycGoucG9zdChcImh0dHA6Ly9cIitjbGllbnQuY291Y2gudXNlcm5hbWUrXCI6XCIrY2xpZW50LmNvdWNoLnBhc3N3b3JkK1wiQDE5Mi4xNjguMTIyLjQ0OjU5ODQvXCIgKyBjbGllbnQuY291Y2guZGIgKyAnLycsIG9iaikudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKFwiYmFja3VwXCIpO1xuICAgICAgICB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKFwic2F2ZSBlcnJvciBcIiArIGVycik7XG4gICAgICAgIH0pO1xuXG5cbiAgICB9XG5cblxuXG5cbn0pO1xuXG5cbmludGVyZmFjZSBJU29ja2V0IHtcblxuICAgIGlkOiBzdHJpbmc7XG4gICAgZW1pdDogRnVuY3Rpb247XG4gICAgb246IEZ1bmN0aW9uO1xuICAgIGRlY29kZWRfdG9rZW46IHtcbiAgICAgICAgZGI6IHN0cmluZztcbiAgICAgICAgdXNlcjogc3RyaW5nO1xuICAgICAgICBwYXNzd29yZDogc3RyaW5nO1xuICAgICAgICBzZXJpYWw6IHN0cmluZztcbiAgICAgICAgc2VyaWFsczogc3RyaW5nW11cbiAgICB9XG59XG5cblxuXG5cbmFwcC5nZXQoJy8nLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIHJlcy5qc29uKHsgb25saW5lOiB0cnVlIH0pXG59KTtcblxuXG5cblxuZnVuY3Rpb24gYXV0aGNvdWNoKHVzZXI6IHN0cmluZywgcGFzc3dvcmQ6IHN0cmluZywgZGI6IHN0cmluZykge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgcnBqLmdldChDT1VDSERCLmZvcih1c2VyLCBwYXNzd29yZCwgZGIpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgcmVzb2x2ZSh7IHN1Y2Nlc3M6IHRydWUgfSlcbiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICByZWplY3QoeyBlcnJvcjogJ3dyb25nIGNyZWRlbnRpYWxzJyB9KVxuICAgICAgICB9KVxuICAgIH0pXG59XG5cbmZ1bmN0aW9uIGF1dGhvcml6ZXNvY2tldChwcm9maWxlKToge30ge1xuICAgIHJldHVybiBqd3Quc2lnbihwcm9maWxlLCBjb25mLnNlY3JldCwgeyBleHBpcmVzSW5NaW51dGVzOiA2MCAqIDUgfSk7XG59XG5cbmFwcC5wb3N0KCcvbG9naW4nLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIGF1dGhjb3VjaChyZXEuYm9keS51c2VyLCByZXEuYm9keS5wYXNzd29yZCwgcmVxLmJvZHkuZGIpLnRoZW4oZnVuY3Rpb24oKSB7XG5cbiAgICAgICAgbGV0IHRva2VuID0gYXV0aG9yaXplc29ja2V0KHsgdXNlcjogcmVxLmJvZHkudXNlciwgcGFzc3dvcmQ6IHJlcS5ib2R5LnBhc3N3b3JkLCBkYjogcmVxLmJvZHkuZGIsIHNlcmlhbDogcmVxLmJvZHkuc2VyaWFsIH0pXG5cbiAgICAgICAgcmVzLmpzb24oeyBzdWNjZXNzOiB0cnVlLCB0b2tlbjogdG9rZW4gfSlcbiAgICB9KS5jYXRjaChmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgcmVzLmpzb24oZXJyKVxuICAgIH0pXG59KTtcblxuYXBwLmdldCgnL2lwJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICByZXMuanNvbih7IGlwOiByZXEuaGVhZGVyc1sneC1mb3J3YXJkZWQtZm9yJ10gfSlcbn0pO1xuXG5hcHAuZ2V0KCcvc29ja2V0cycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgcmVzLmpzb24oTWFjaGluZXMuc29ja2V0cygpKVxufSk7XG5hcHAuZ2V0KCcvbWFjaGluZXMvOnNlcmlhbC9zb2NrZXRzJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICByZXMuanNvbihNYWNoaW5lcy5zb2NrZXRzKHJlcS5wYXJhbXMuc2VyaWFsKSlcbn0pO1xuYXBwLmdldCgnL21hY2hpbmVzJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICByZXMuanNvbihNYWNoaW5lcy5saXN0KCkpXG59KTtcbmFwcC5nZXQoJy9hcHAvOmFwcC9tYWNoaW5lcycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgLy8gcmVzLmpzb24oTWFjaGluZXMuc2VyaWFscygpKVxufSk7XG5cbmFwcC5nZXQoJy9tYWNoaW5lcy86c2VyaWFsL21lc3NhZ2UvOm1lc3NhZ2UnLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIF8ubWFwKE1hY2hpbmVzLmlvcyhyZXEucGFyYW1zLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldCkge1xuICAgICAgICBzb2NrZXQuZW1pdCgnbWVzc2FnZScsIHJlcS5wYXJhbXMubWVzc2FnZSk7XG5cbiAgICB9KVxuICAgIHJlcy5qc29uKHt9KVxuXG59KTtcblxuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL21lc3NhZ2UnLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIF8ubWFwKE1hY2hpbmVzLmxpc3QocmVxLnBhcmFtcy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWVzc2FnZScsIHJlcS5ib2R5LmRhdGEpO1xuICAgIH0pXG5cbn0pO1xuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL2RhdGEnLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIF8ubWFwKE1hY2hpbmVzLmxpc3QocmVxLnBhcmFtcy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnZGF0YScsIHJlcS5ib2R5LmRhdGEpO1xuICAgIH0pXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC9leGVjJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ2V4ZWMnLCByZXEuYm9keS5kYXRhKTtcbiAgICB9KVxufSk7XG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvbnBtJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ25wbScsIHJlcS5ib2R5LmRhdGEpO1xuICAgIH0pXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC90YXNrJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ3Rhc2snLCByZXEuYm9keS5kYXRhKTtcbiAgICB9KVxufSk7XG5cbmlvLm9uKCdjb25uZWN0aW9uJywgZnVuY3Rpb24oc29ja2V0OiBJU29ja2V0KSB7XG4gICAgbGV0IGMgPSBzb2NrZXQuZGVjb2RlZF90b2tlbjtcblxuICAgIGlmIChjLmRiKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGMuZGIpXG5cbiAgICAgICAgTWFjaGluZXMuYWRkKGMudXNlciwgYy5wYXNzd29yZCwgYy5kYiwgYy5zZXJpYWwsIHNvY2tldCk7XG4gICAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBjb25uZWN0aW9uJywgeyBzZXJpYWw6IGMuc2VyaWFsIH0pO1xuICAgICAgICB9KVxuXG4gICAgICAgIHNvY2tldC5vbignZGlzY29ubmVjdCcsIGZ1bmN0aW9uKCkge1xuXG4gICAgICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIGRpc2Nvbm5lY3Rpb24nLCB7IHNlcmlhbDogYy5zZXJpYWwgfSk7XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICBNYWNoaW5lcy5yZW1vdmUoYy5zZXJpYWwsIHNvY2tldC5pZCk7XG4gICAgICAgIH0pO1xuICAgICAgICBzb2NrZXQub24oJ21lc3NhZ2UnLCBmdW5jdGlvbihtZXNzYWdlKSB7XG4gICAgICAgICAgICBNYWNoaW5lcy5wdXNoZGF0YShjLnNlcmlhbCwgJ21lc3NhZ2UnLCBtZXNzYWdlKS50aGVuKGZ1bmN0aW9uKGRvY3MpIHtcblxuICAgICAgICAgICAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIG1lc3NhZ2UnLCB7IHNlcmlhbDogYy5zZXJpYWwsIGRhdGE6IG1lc3NhZ2UgfSk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0pO1xuICAgICAgICBzb2NrZXQub24oJ2RhdGEnLCBmdW5jdGlvbihkYXRhKSB7XG4gICAgICAgICAgICBNYWNoaW5lcy5wdXNoZGF0YShjLnNlcmlhbCwgJ2RhdGEnLCBkYXRhKS50aGVuKGZ1bmN0aW9uKGRvY3MpIHtcblxuICAgICAgICAgICAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIGRhdGEnLCB7IHNlcmlhbDogYy5zZXJpYWwsIGRhdGE6IGRhdGEgfSk7XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0pO1xuICAgICAgICBzb2NrZXQub24oJ2RvY3MnLCBmdW5jdGlvbihkb2NzKSB7XG4gICAgICAgICAgICBNYWNoaW5lcy5wdXNoZGF0YShjLnNlcmlhbCwgJ2RvY3MnLCBkb2NzKS50aGVuKGZ1bmN0aW9uKGRvY3MpIHtcbiAgICAgICAgICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkb2NzJywgeyBzZXJpYWw6IGMuc2VyaWFsLCBkYXRhOiBkb2NzIH0pO1xuICAgICAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIH0pXG4gICAgICAgIH0pO1xuICAgICAgICBzb2NrZXQub24oJ3VwJywgZnVuY3Rpb24oZGF0YXMpIHtcbiAgICAgICAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgdXAnLCB7IHNlcmlhbDogYy5zZXJpYWwgfSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICB9KVxuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgQXVkaXRvcnMuYWRkKGMuc2VyaWFscywgc29ja2V0LmlkKVxuICAgICAgICBzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIEF1ZGl0b3JzLnJlbW92ZShzb2NrZXQuaWQpXG4gICAgICAgIH0pO1xuXG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ2hlbGxvISAnLCBzb2NrZXQuaWQpO1xufSk7XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
