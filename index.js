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
Aedes.on('client', function (client) {
    console.log(client.username);
    console.log(client.password);
    console.log("new client" + client.id);
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
    packet.payloadString = packet.payload.toString();
    packet.payloadLength = packet.payload.length;
    packet.payload = JSON.stringify(packet.payload);
    packet.timestamp = new Date();
    console.log("publish");
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

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm5hbWVzIjpbImF1dGhjb3VjaCIsImF1dGhvcml6ZXNvY2tldCJdLCJtYXBwaW5ncyI6IkFBQUEsSUFBWSxHQUFHLFdBQU0sS0FBSyxDQUFDLENBQUE7QUFDM0IsSUFBWSxDQUFDLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDNUIsSUFBWSxPQUFPLFdBQU0sVUFBVSxDQUFDLENBQUE7QUFDcEMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxFQUFFLFdBQU0sV0FBWSxDQUFDLENBQUE7QUFDakMsSUFBWSxPQUFPLFdBQU0sU0FBUyxDQUFDLENBQUE7QUFDbkMsSUFBWSxHQUFHLFdBQU0sY0FBYyxDQUFDLENBQUE7QUFHcEMsSUFBTyxhQUFhLFdBQVcsZUFBZSxDQUFDLENBQUM7QUFFaEQsSUFBTyxXQUFXLFdBQVcsdUJBQXVCLENBQUMsQ0FBQztBQUN0RCxJQUFPLFVBQVUsV0FBVyxzQkFBc0IsQ0FBQyxDQUFDO0FBRXBELElBQUksV0FBVyxHQUFLLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUM1QyxJQUFJLEdBQUcsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUMxQyxJQUFJLEtBQUssR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7QUFHN0IsSUFBSSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDcEIsSUFBSSxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6QyxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUM7QUFNcEIsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUEsQ0FBQztJQUNuQyxNQUFNLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFBO0FBQ3pDLENBQUM7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QUNKLENBQUMsQ0FBQyxDQUFDO0FBQ0gsR0FBRyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsRUFBRSxVQUFVLEdBQUcsRUFBRSxHQUFHO0lBQ25ELENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFDLFVBQVMsUUFBUTtRQUN0RCxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM5QyxDQUFDLENBQUMsQ0FBQTtBQUNKLENBQUMsQ0FBQyxDQUFDO0FBQ0gsR0FBRyxDQUFDLElBQUksQ0FBQyx1QkFBdUIsRUFBRSxVQUFVLEdBQUcsRUFBRSxHQUFHO0lBQ2xELENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFDLFVBQVMsUUFBUTtRQUN0RCxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM3QyxDQUFDLENBQUMsQ0FBQTtBQUNKLENBQUMsQ0FBQyxDQUFDO0FBQ0gsR0FBRyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsRUFBRSxVQUFVLEdBQUcsRUFBRSxHQUFHO0lBQ25ELENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFDLFVBQVMsUUFBUTtRQUN0RCxFQUFFLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM5QyxDQUFDLENBQUMsQ0FBQTtBQUNKLENBQUMsQ0FBQyxDQUFDO0FBRUgsRUFBRSxDQUFDLEVBQUUsQ0FBQyxZ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QUcsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBQyxVQUFTLFFBQVE7b0JBQ2xELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxFQUFDLE1BQU0sRUFBQyxDQUFDLENBQUMsTUFBTSxFQUFDLElBQUksRUFBQyxJQUFJLEVBQUMsQ0FBQyxDQUFDO2dCQUNwRSxDQUFDLENBQUMsQ0FBQTtZQUVKLENBQUMsQ0FBQyxDQUFBO1FBQ0osQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsRUFBRSxDQUFDLElBQUksRUFBRSxVQUFVLEtBQUs7WUFDN0IsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBQyxVQUFTLFFBQVE7Z0JBQ2xELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksRUFBRSxFQUFDLE1BQU0sRUFBQyxDQUFDLENBQUMsTUFBTSxFQUFDLENBQUMsQ0FBQztZQUN4RCxDQUFDLENBQUMsQ0FBQTtRQUNKLENBQUMsQ0FBQyxDQUFBO0lBRU4sQ0FBQztJQUFDLElBQUksQ0FBQSxDQUFDO1FBQ0wsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsT0FBTyxFQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQTtRQUNqQyxNQUFNLENBQUMsRUFBRSxDQUFDLFlBQVksRUFBRTtZQUN0QixRQUFRLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQTtRQUM1QixDQUFDLENBQUMsQ0FBQztJQUVMLENBQUM7SUFFRCxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMiLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBuZXQgZnJvbSBcIm5ldFwiO1xuaW1wb3J0ICogYXMgXyBmcm9tIFwibG9kYXNoXCI7XG5pbXBvcnQgKiBhcyBQcm9taXNlIGZyb20gXCJibHVlYmlyZFwiO1xuaW1wb3J0ICogYXMgYm9keVBhcnNlciBmcm9tIFwiYm9keS1wYXJzZXJcIjtcbmltcG9ydCAqIGFzIHBhdGhFeGlzdHMgZnJvbSBcInBhdGgtZXhpc3RzXCI7XG5pbXBvcnQgKiBhcyBJTyBmcm9tIFwic29ja2V0LmlvXCIgO1xuaW1wb3J0ICogYXMgZXhwcmVzcyBmcm9tIFwiZXhwcmVzc1wiO1xuaW1wb3J0ICogYXMgand0IGZyb20gXCJqc29ud2VidG9rZW5cIjtcbmltcG9ydCAqIGFzIHJlZGlzIGZyb20gXCJyZWRpc1wiO1xuXG5pbXBvcnQgY291Y2hqc29uY29uZiA9IHJlcXVpcmUoXCJjb3VjaGpzb25jb25mXCIpO1xuXG5pbXBvcnQgbWFjaENsaWVudHMgPSByZXF1aXJlKFwiLi9tb2R1bGVzL21hY2hDbGllbnRzXCIpO1xuaW1wb3J0IGF1ZENsaWVudHMgPSByZXF1aXJlKFwiLi9tb2R1bGVzL2F1ZENsaWVudHNcIik7XG5cbmxldCBzb2NrZXRpb0p3dCAgID0gcmVxdWlyZShcInNvY2tldGlvLWp3dFwiKTtcbmxldCBycGogPSByZXF1aXJlKCdyZXF1ZXN0LXByb21pc2UtanNvbicpO1xubGV0IGFlZGVzID0gcmVxdWlyZShcImFlZGVzXCIpO1xuXG5cbmxldCBhcHAgPSBleHByZXNzKCk7XG5sZXQgc2VydmVyID0gcmVxdWlyZSgnaHR0cCcpLlNlcnZlcihhcHApO1xubGV0IGlvID0gSU8oc2VydmVyKTtcblxuXG5cblxuXG5pZiAoIXBhdGhFeGlzdHMuc3luYygnLi9jb25mLmpzb24nKSl7XG4gIHRocm93IEVycm9yKCdubyBjb25maWd1cmF0aW9uIGZvdW5kZWQnKVxufVxubGV0IGNvbmY9cmVxdWlyZSgnLi9jb25mLmpzb24nKVxuXG5sZXQgQ09VQ0hEQj0gbmV3IGNvdWNoanNvbmNvbmYoY29uZi5jb3VjaGRiKVxuXG5sZXQgTWFjaGluZXM9bmV3IG1hY2hDbGllbnRzKENPVUNIREIpO1xubGV0IEF1ZGl0b3JzPW5ldyBhdWRDbGllbnRzKCk7XG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZFxuYXBwLnVzZShib2R5UGFyc2VyLnVybGVuY29kZWQoeyBleHRlbmRlZDogZmFsc2UgfSkpXG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL2pzb25cbmFwcC51c2UoYm9keVBhcnNlci5qc29uKCkpXG5cblxuXG5pby51c2Uoc29ja2V0aW9Kd3QuYXV0aG9yaXplKHtcbiAgc2VjcmV0OiBjb25mLnNlY3JldCxcbiAgaGFuZHNoYWtlOiB0cnVlXG59KSk7XG5cbnNlcnZlci5saXN0ZW4oY29uZi5wb3J0KTtcblxuXG5sZXQgQWVkZXMgPSBhZWRlcygpXG5sZXQgQXNlcnZlciA9IG5ldC5jcmVhdGVTZXJ2ZXIoQWVkZXMuaGFuZGxlKVxuXG5Bc2VydmVyLmxpc3RlbigxODgzLCBmdW5jdGlvbiAoKSB7XG4gIGNvbnNvbGUubG9nKCdNUVRUIHNlcnZlciBsaXN0ZW5pbmcgb24gcG9ydCcsIDE4ODMpXG59KTtcblxuQWVkZXMub24oJ2NsaWVudCcsIGZ1bmN0aW9uKGNsaWVudCkge1xuICAgIFxuICAgICBjb25zb2xlLmxvZyhjbGllbnQudXNlcm5hbWUpXG4gICAgICAgICBjb25zb2xlLmxvZyhjbGllbnQucGFzc3dvcmQpXG4gY29uc29sZS5sb2coXCJuZXcgY2xpZW50XCIrY2xpZW50LmlkKVxufSk7XG5cbkFlZGVzLm9uKCdjbGllbnREaXNjb25uZWN0JywgZnVuY3Rpb24oY2xpZW50KSB7XG5jb25zb2xlLmxvZyhcImNsaWVudERpc2Nvbm5lY3RcIilcbn0pO1xuXG5BZWRlcy5vbignc3Vic2NyaWJlJywgZnVuY3Rpb24odG9waWMsIGNsaWVudCkge1xuY29uc29sZS5sb2coXCJzdWJzY3JpYmVcIilcbn0pO1xuXG5BZWRlcy5vbigndW5zdWJzY3JpYmUnLCBmdW5jdGlvbih0b3BpYywgY2xpZW50KSB7XG5jb25zb2xlLmxvZyhcInVuc3Vic2NyaWJlXCIpXG59KTtcblxuQWVkZXMub24oJ3B1Ymxpc2gnLCBmdW5jdGlvbihwYWNrZXQsIGNsaWVudCkge1xuXG4gIGlmKCEgY2xpZW50KSByZXR1cm47XG4gIFxuICBwYWNrZXQucGF5bG9hZFN0cmluZyA9IHBhY2tldC5wYXlsb2FkLnRvU3RyaW5nKCk7XG4gIHBhY2tldC5wYXlsb2FkTGVuZ3RoID0gcGFja2V0LnBheWxvYWQubGVuZ3RoO1xuICBwYWNrZXQucGF5bG9hZCA9IEpTT04uc3RyaW5naWZ5KHBhY2tldC5wYXlsb2FkKTtcbiAgcGFja2V0LnRpbWVzdGFtcCA9IG5ldyBEYXRlKCk7XG5cbmNvbnNvbGUubG9nKFwicHVibGlzaFwiKVxuXG59KTtcblxuXG5pbnRlcmZhY2UgSVNvY2tldCB7XG5cbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgZW1pdDpGdW5jdGlvbjtcbiAgICAgICAgICAgICAgICBvbjpGdW5jdGlvbjtcbiAgICBkZWNvZGVkX3Rva2VuOntcbiAgICAgICAgZGI6c3RyaW5nO1xuICAgICAgICB1c2VyOnN0cmluZztcbiAgICAgICAgcGFzc3dvcmQ6c3RyaW5nO1xuICAgICAgICBzZXJpYWw6c3RyaW5nO1xuICAgICAgICBzZXJpYWxzOnN0cmluZ1tdXG4gICAgfVxufVxuXG5cblxuXG5hcHAuZ2V0KCcvJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIHJlcy5qc29uKHtvbmxpbmU6dHJ1ZX0pXG59KTtcblxuXG5cblxuZnVuY3Rpb24gYXV0aGNvdWNoKHVzZXI6c3RyaW5nLHBhc3N3b3JkOnN0cmluZyxkYjpzdHJpbmcpe1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSxyZWplY3Qpe1xuICAgIHJwai5nZXQoQ09VQ0hEQi5mb3IodXNlcixwYXNzd29yZCxkYikpLnRoZW4oZnVuY3Rpb24oKXtcbiAgICAgIHJlc29sdmUoe3N1Y2Nlc3M6dHJ1ZX0pXG4gICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKXtcbiAgICAgIHJlamVjdCh7ZXJyb3I6J3dyb25nIGNyZWRlbnRpYWxzJ30pXG4gICAgfSlcbiAgfSlcbn1cblxuZnVuY3Rpb24gYXV0aG9yaXplc29ja2V0KHByb2ZpbGUpOnt9e1xucmV0dXJuIGp3dC5zaWduKHByb2ZpbGUsIGNvbmYuc2VjcmV0LCB7IGV4cGlyZXNJbk1pbnV0ZXM6IDYwKjUgfSk7XG59XG5cbmFwcC5wb3N0KCcvbG9naW4nLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgYXV0aGNvdWNoKHJlcS5ib2R5LnVzZXIscmVxLmJvZHkucGFzc3dvcmQscmVxLmJvZHkuZGIpLnRoZW4oZnVuY3Rpb24oKXtcblxuICBsZXQgdG9rZW49YXV0aG9yaXplc29ja2V0KHsgdXNlcjpyZXEuYm9keS51c2VyLHBhc3N3b3JkOnJlcS5ib2R5LnBhc3N3b3JkLGRiOnJlcS5ib2R5LmRiLHNlcmlhbDpyZXEuYm9keS5zZXJpYWwgfSlcblxuICAgIHJlcy5qc29uKHtzdWNjZXNzOnRydWUsdG9rZW46dG9rZW59KVxuICB9KS5jYXRjaChmdW5jdGlvbihlcnIpe1xuICAgIHJlcy5qc29uKGVycilcbiAgfSlcbn0pO1xuXG5hcHAuZ2V0KCcvaXAnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgcmVzLmpzb24oe2lwOnJlcS5oZWFkZXJzWyd4LWZvcndhcmRlZC1mb3InXX0pXG59KTtcblxuYXBwLmdldCgnL3NvY2tldHMnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgcmVzLmpzb24oTWFjaGluZXMuc29ja2V0cygpKVxufSk7XG5hcHAuZ2V0KCcvbWFjaGluZXMvOnNlcmlhbC9zb2NrZXRzJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIHJlcy5qc29uKE1hY2hpbmVzLnNvY2tldHMocmVxLnBhcmFtcy5zZXJpYWwpKVxufSk7XG5hcHAuZ2V0KCcvbWFjaGluZXMnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgcmVzLmpzb24oTWFjaGluZXMubGlzdCgpKVxufSk7XG5hcHAuZ2V0KCcvYXBwLzphcHAvbWFjaGluZXMnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAvLyByZXMuanNvbihNYWNoaW5lcy5zZXJpYWxzKCkpXG59KTtcblxuYXBwLmdldCgnL21hY2hpbmVzLzpzZXJpYWwvbWVzc2FnZS86bWVzc2FnZScsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICBfLm1hcChNYWNoaW5lcy5pb3MocmVxLnBhcmFtcy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldCl7XG4gICAgc29ja2V0LmVtaXQoJ21lc3NhZ2UnLCByZXEucGFyYW1zLm1lc3NhZ2UpO1xuXG4gIH0pXG4gIHJlcy5qc29uKHt9KVxuXG59KTtcblxuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL21lc3NhZ2UnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtZXNzYWdlJywgcmVxLmJvZHkuZGF0YSk7XG4gIH0pXG5cbn0pO1xuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL2RhdGEnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdkYXRhJywgcmVxLmJvZHkuZGF0YSk7XG4gIH0pXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC9leGVjJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIF8ubWFwKE1hY2hpbmVzLmxpc3QocmVxLnBhcmFtcy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnZXhlYycsIHJlcS5ib2R5LmRhdGEpO1xuICB9KVxufSk7XG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvbnBtJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIF8ubWFwKE1hY2hpbmVzLmxpc3QocmVxLnBhcmFtcy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbnBtJywgcmVxLmJvZHkuZGF0YSk7XG4gIH0pXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC90YXNrJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIF8ubWFwKE1hY2hpbmVzLmxpc3QocmVxLnBhcmFtcy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICBpby50byhzb2NrZXRpZCkuZW1pdCgndGFzaycsIHJlcS5ib2R5LmRhdGEpO1xuICB9KVxufSk7XG5cbmlvLm9uKCdjb25uZWN0aW9uJywgZnVuY3Rpb24gKHNvY2tldDpJU29ja2V0KSB7XG4gIGxldCBjID0gc29ja2V0LmRlY29kZWRfdG9rZW47XG5cbiAgaWYoYy5kYil7XG4gICAgY29uc29sZS5sb2coYy5kYilcblxuICAgIE1hY2hpbmVzLmFkZChjLnVzZXIsYy5wYXNzd29yZCxjLmRiLGMuc2VyaWFsLHNvY2tldCk7XG4gICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBjb25uZWN0aW9uJywge3NlcmlhbDpjLnNlcmlhbH0pO1xuICAgIH0pXG5cbiAgICBzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCBmdW5jdGlvbiAoKSB7XG5cbiAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkaXNjb25uZWN0aW9uJywge3NlcmlhbDpjLnNlcmlhbH0pO1xuICAgICAgfSlcblxuICAgICAgTWFjaGluZXMucmVtb3ZlKGMuc2VyaWFsLHNvY2tldC5pZCk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdtZXNzYWdlJywgZnVuY3Rpb24gKG1lc3NhZ2UpIHtcbiAgICAgIE1hY2hpbmVzLnB1c2hkYXRhKGMuc2VyaWFsLCdtZXNzYWdlJyxtZXNzYWdlKS50aGVuKGZ1bmN0aW9uKGRvY3Mpe1xuXG4gICAgICAgIF8ubWFwKEF1ZGl0b3JzLmZvcnNlcmlhbChjLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIG1lc3NhZ2UnLCB7c2VyaWFsOmMuc2VyaWFsLGRhdGE6bWVzc2FnZX0pO1xuICAgICAgICB9KVxuICAgICAgfSlcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ2RhdGEnLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgTWFjaGluZXMucHVzaGRhdGEoYy5zZXJpYWwsJ2RhdGEnLGRhdGEpLnRoZW4oZnVuY3Rpb24oZG9jcyl7XG5cbiAgICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgZGF0YScsIHtzZXJpYWw6Yy5zZXJpYWwsZGF0YTpkYXRhfSk7XG4gICAgICAgIH0pXG4gICAgICB9KVxuICAgIH0pO1xuICAgIHNvY2tldC5vbignZG9jcycsIGZ1bmN0aW9uIChkb2NzKSB7XG4gICAgICBNYWNoaW5lcy5wdXNoZGF0YShjLnNlcmlhbCwnZG9jcycsZG9jcykudGhlbihmdW5jdGlvbihkb2NzKXtcbiAgICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgZG9jcycsIHtzZXJpYWw6Yy5zZXJpYWwsZGF0YTpkb2NzfSk7XG4gICAgICAgIH0pXG5cbiAgICAgIH0pXG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCd1cCcsIGZ1bmN0aW9uIChkYXRhcykge1xuICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIHVwJywge3NlcmlhbDpjLnNlcmlhbH0pO1xuICAgICAgfSlcbiAgICB9KVxuXG59IGVsc2V7XG4gIEF1ZGl0b3JzLmFkZChjLnNlcmlhbHMsc29ja2V0LmlkKVxuICBzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCBmdW5jdGlvbiAoKSB7XG4gICAgQXVkaXRvcnMucmVtb3ZlKHNvY2tldC5pZClcbiAgfSk7XG5cbn1cblxuY29uc29sZS5sb2coJ2hlbGxvISAnLCBzb2NrZXQuaWQpO1xufSk7XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
