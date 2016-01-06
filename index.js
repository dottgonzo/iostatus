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
    console.log(client);
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

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm5hbWVzIjpbImF1dGhjb3VjaCIsImF1dGhvcml6ZXNvY2tldCJdLCJtYXBwaW5ncyI6IkFBQUEsSUFBWSxHQUFHLFdBQU0sS0FBSyxDQUFDLENBQUE7QUFDM0IsSUFBWSxDQUFDLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDNUIsSUFBWSxPQUFPLFdBQU0sVUFBVSxDQUFDLENBQUE7QUFDcEMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxFQUFFLFdBQU0sV0FBWSxDQUFDLENBQUE7QUFDakMsSUFBWSxPQUFPLFdBQU0sU0FBUyxDQUFDLENBQUE7QUFDbkMsSUFBWSxHQUFHLFdBQU0sY0FBYyxDQUFDLENBQUE7QUFHcEMsSUFBTyxhQUFhLFdBQVcsZUFBZSxDQUFDLENBQUM7QUFFaEQsSUFBTyxXQUFXLFdBQVcsdUJBQXVCLENBQUMsQ0FBQztBQUN0RCxJQUFPLFVBQVUsV0FBVyxzQkFBc0IsQ0FBQyxDQUFDO0FBRXBELElBQUksV0FBVyxHQUFLLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUM1QyxJQUFJLEdBQUcsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUMxQyxJQUFJLEtBQUssR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7QUFHN0IsSUFBSSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDcEIsSUFBSSxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6QyxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUM7QUFNcEIsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUEsQ0FBQztJQUNuQyxNQUFNLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFBO0FBQ3pDLENBQUM7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QUMsR0FBRyxDQUFDLG9DQUFvQyxFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDOUQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxNQUFNO1FBQ25ELE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7SUFFN0MsQ0FBQyxDQUFDLENBQUE7SUFDRixHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFBO0FBRWQsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsSUFBSSxDQUFDLDJCQUEyQixFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDdEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxRQUFRO1FBQ3RELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2pELENBQUMsQ0FBQyxDQUFBO0FBRUosQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDbkQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxRQUFRO1FBQ3RELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlDLENBQUMsQ0FBQyxDQUFBO0FBQ0osQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDbkQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxRQUFRO1FBQ3RELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlDLENBQUMsQ0FBQyxDQUFBO0FBQ0osQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHVCQUF1QixFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDbEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxRQUFRO1FBQ3RELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzdDLENBQUMsQ0FBQyxDQUFBO0FBQ0osQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVUsR0FBRyxFQUFFLEdBQUc7SUFDbkQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUMsVUFBUyxRQUFRO1FBQ3RELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlDLENBQUMsQ0FBQyxDQUFBO0FBQ0osQ0FBQyxDQUFDLENBQUM7QUFFSCxFQUFFLENBQUMsRUFBRSxDQUFDLFlBQVksRUFBRSxVQUFVLE1BQWM7SUFDMUMsSUFBSSxDQUFDLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQztJ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UTtvQkFDbEQsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLEVBQUMsTUFBTSxFQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUMsSUFBSSxFQUFDLElBQUksRUFBQyxDQUFDLENBQUM7Z0JBQ3BFLENBQUMsQ0FBQyxDQUFBO1lBRUosQ0FBQyxDQUFDLENBQUE7UUFDSixDQUFDLENBQUMsQ0FBQztRQUNILE1BQU0sQ0FBQyxFQUFFLENBQUMsSUFBSSxFQUFFLFVBQVUsS0FBSztZQUM3QixDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFDLFVBQVMsUUFBUTtnQkFDbEQsRUFBRSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFLEVBQUMsTUFBTSxFQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUMsQ0FBQyxDQUFDO1lBQ3hELENBQUMsQ0FBQyxDQUFBO1FBQ0osQ0FBQyxDQUFDLENBQUE7SUFFTixDQUFDO0lBQUMsSUFBSSxDQUFBLENBQUM7UUFDTCxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLEVBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBQ2pDLE1BQU0sQ0FBQyxFQUFFLENBQUMsWUFBWSxFQUFFO1lBQ3RCLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBQzVCLENBQUMsQ0FBQyxDQUFDO0lBRUwsQ0FBQztJQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUNsQyxDQUFDLENBQUMsQ0FBQyIsImZpbGUiOiJpbmRleC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIG5ldCBmcm9tIFwibmV0XCI7XG5pbXBvcnQgKiBhcyBfIGZyb20gXCJsb2Rhc2hcIjtcbmltcG9ydCAqIGFzIFByb21pc2UgZnJvbSBcImJsdWViaXJkXCI7XG5pbXBvcnQgKiBhcyBib2R5UGFyc2VyIGZyb20gXCJib2R5LXBhcnNlclwiO1xuaW1wb3J0ICogYXMgcGF0aEV4aXN0cyBmcm9tIFwicGF0aC1leGlzdHNcIjtcbmltcG9ydCAqIGFzIElPIGZyb20gXCJzb2NrZXQuaW9cIiA7XG5pbXBvcnQgKiBhcyBleHByZXNzIGZyb20gXCJleHByZXNzXCI7XG5pbXBvcnQgKiBhcyBqd3QgZnJvbSBcImpzb253ZWJ0b2tlblwiO1xuaW1wb3J0ICogYXMgcmVkaXMgZnJvbSBcInJlZGlzXCI7XG5cbmltcG9ydCBjb3VjaGpzb25jb25mID0gcmVxdWlyZShcImNvdWNoanNvbmNvbmZcIik7XG5cbmltcG9ydCBtYWNoQ2xpZW50cyA9IHJlcXVpcmUoXCIuL21vZHVsZXMvbWFjaENsaWVudHNcIik7XG5pbXBvcnQgYXVkQ2xpZW50cyA9IHJlcXVpcmUoXCIuL21vZHVsZXMvYXVkQ2xpZW50c1wiKTtcblxubGV0IHNvY2tldGlvSnd0ICAgPSByZXF1aXJlKFwic29ja2V0aW8tand0XCIpO1xubGV0IHJwaiA9IHJlcXVpcmUoJ3JlcXVlc3QtcHJvbWlzZS1qc29uJyk7XG5sZXQgYWVkZXMgPSByZXF1aXJlKFwiYWVkZXNcIik7XG5cblxubGV0IGFwcCA9IGV4cHJlc3MoKTtcbmxldCBzZXJ2ZXIgPSByZXF1aXJlKCdodHRwJykuU2VydmVyKGFwcCk7XG5sZXQgaW8gPSBJTyhzZXJ2ZXIpO1xuXG5cblxuXG5cbmlmICghcGF0aEV4aXN0cy5zeW5jKCcuL2NvbmYuanNvbicpKXtcbiAgdGhyb3cgRXJyb3IoJ25vIGNvbmZpZ3VyYXRpb24gZm91bmRlZCcpXG59XG5sZXQgY29uZj1yZXF1aXJlKCcuL2NvbmYuanNvbicpXG5cbmxldCBDT1VDSERCPSBuZXcgY291Y2hqc29uY29uZihjb25mLmNvdWNoZGIpXG5cbmxldCBNYWNoaW5lcz1uZXcgbWFjaENsaWVudHMoQ09VQ0hEQik7XG5sZXQgQXVkaXRvcnM9bmV3IGF1ZENsaWVudHMoKTtcblxuLy8gcGFyc2UgYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkXG5hcHAudXNlKGJvZHlQYXJzZXIudXJsZW5jb2RlZCh7IGV4dGVuZGVkOiBmYWxzZSB9KSlcblxuLy8gcGFyc2UgYXBwbGljYXRpb24vanNvblxuYXBwLnVzZShib2R5UGFyc2VyLmpzb24oKSlcblxuXG5cbmlvLnVzZShzb2NrZXRpb0p3dC5hdXRob3JpemUoe1xuICBzZWNyZXQ6IGNvbmYuc2VjcmV0LFxuICBoYW5kc2hha2U6IHRydWVcbn0pKTtcblxuc2VydmVyLmxpc3Rlbihjb25mLnBvcnQpO1xuXG5cbmxldCBBZWRlcyA9IGFlZGVzKClcbmxldCBBc2VydmVyID0gbmV0LmNyZWF0ZVNlcnZlcihBZWRlcy5oYW5kbGUpXG5cbkFzZXJ2ZXIubGlzdGVuKDE4ODMsIGZ1bmN0aW9uICgpIHtcbiAgY29uc29sZS5sb2coJ01RVFQgc2VydmVyIGxpc3RlbmluZyBvbiBwb3J0JywgMTg4Mylcbn0pO1xuXG5BZWRlcy5vbignY2xpZW50JywgZnVuY3Rpb24oY2xpZW50KSB7XG4gICAgXG4gICAgIGNvbnNvbGUubG9nKGNsaWVudClcbiAgICBcbiBjb25zb2xlLmxvZyhcIm5ldyBjbGllbnRcIitjbGllbnQuaWQpXG59KTtcblxuQWVkZXMub24oJ2NsaWVudERpc2Nvbm5lY3QnLCBmdW5jdGlvbihjbGllbnQpIHtcbmNvbnNvbGUubG9nKFwiY2xpZW50RGlzY29ubmVjdFwiKVxufSk7XG5cbkFlZGVzLm9uKCdzdWJzY3JpYmUnLCBmdW5jdGlvbih0b3BpYywgY2xpZW50KSB7XG5jb25zb2xlLmxvZyhcInN1YnNjcmliZVwiKVxufSk7XG5cbkFlZGVzLm9uKCd1bnN1YnNjcmliZScsIGZ1bmN0aW9uKHRvcGljLCBjbGllbnQpIHtcbmNvbnNvbGUubG9nKFwidW5zdWJzY3JpYmVcIilcbn0pO1xuXG5BZWRlcy5vbigncHVibGlzaCcsIGZ1bmN0aW9uKHBhY2tldCwgY2xpZW50KSB7XG5cbiAgaWYoISBjbGllbnQpIHJldHVybjtcbiAgXG4gIHBhY2tldC5wYXlsb2FkU3RyaW5nID0gcGFja2V0LnBheWxvYWQudG9TdHJpbmcoKTtcbiAgcGFja2V0LnBheWxvYWRMZW5ndGggPSBwYWNrZXQucGF5bG9hZC5sZW5ndGg7XG4gIHBhY2tldC5wYXlsb2FkID0gSlNPTi5zdHJpbmdpZnkocGFja2V0LnBheWxvYWQpO1xuICBwYWNrZXQudGltZXN0YW1wID0gbmV3IERhdGUoKTtcblxuY29uc29sZS5sb2coXCJwdWJsaXNoXCIpXG5cbn0pO1xuXG5cbmludGVyZmFjZSBJU29ja2V0IHtcblxuICAgICAgICBpZDogc3RyaW5nO1xuICAgICAgICBlbWl0OkZ1bmN0aW9uO1xuICAgICAgICAgICAgICAgIG9uOkZ1bmN0aW9uO1xuICAgIGRlY29kZWRfdG9rZW46e1xuICAgICAgICBkYjpzdHJpbmc7XG4gICAgICAgIHVzZXI6c3RyaW5nO1xuICAgICAgICBwYXNzd29yZDpzdHJpbmc7XG4gICAgICAgIHNlcmlhbDpzdHJpbmc7XG4gICAgICAgIHNlcmlhbHM6c3RyaW5nW11cbiAgICB9XG59XG5cblxuXG5cbmFwcC5nZXQoJy8nLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgcmVzLmpzb24oe29ubGluZTp0cnVlfSlcbn0pO1xuXG5cblxuXG5mdW5jdGlvbiBhdXRoY291Y2godXNlcjpzdHJpbmcscGFzc3dvcmQ6c3RyaW5nLGRiOnN0cmluZyl7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLHJlamVjdCl7XG4gICAgcnBqLmdldChDT1VDSERCLmZvcih1c2VyLHBhc3N3b3JkLGRiKSkudGhlbihmdW5jdGlvbigpe1xuICAgICAgcmVzb2x2ZSh7c3VjY2Vzczp0cnVlfSlcbiAgICB9KS5jYXRjaChmdW5jdGlvbihlcnIpe1xuICAgICAgcmVqZWN0KHtlcnJvcjond3JvbmcgY3JlZGVudGlhbHMnfSlcbiAgICB9KVxuICB9KVxufVxuXG5mdW5jdGlvbiBhdXRob3JpemVzb2NrZXQocHJvZmlsZSk6e317XG5yZXR1cm4gand0LnNpZ24ocHJvZmlsZSwgY29uZi5zZWNyZXQsIHsgZXhwaXJlc0luTWludXRlczogNjAqNSB9KTtcbn1cblxuYXBwLnBvc3QoJy9sb2dpbicsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICBhdXRoY291Y2gocmVxLmJvZHkudXNlcixyZXEuYm9keS5wYXNzd29yZCxyZXEuYm9keS5kYikudGhlbihmdW5jdGlvbigpe1xuXG4gIGxldCB0b2tlbj1hdXRob3JpemVzb2NrZXQoeyB1c2VyOnJlcS5ib2R5LnVzZXIscGFzc3dvcmQ6cmVxLmJvZHkucGFzc3dvcmQsZGI6cmVxLmJvZHkuZGIsc2VyaWFsOnJlcS5ib2R5LnNlcmlhbCB9KVxuXG4gICAgcmVzLmpzb24oe3N1Y2Nlc3M6dHJ1ZSx0b2tlbjp0b2tlbn0pXG4gIH0pLmNhdGNoKGZ1bmN0aW9uKGVycil7XG4gICAgcmVzLmpzb24oZXJyKVxuICB9KVxufSk7XG5cbmFwcC5nZXQoJy9pcCcsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICByZXMuanNvbih7aXA6cmVxLmhlYWRlcnNbJ3gtZm9yd2FyZGVkLWZvciddfSlcbn0pO1xuXG5hcHAuZ2V0KCcvc29ja2V0cycsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICByZXMuanNvbihNYWNoaW5lcy5zb2NrZXRzKCkpXG59KTtcbmFwcC5nZXQoJy9tYWNoaW5lcy86c2VyaWFsL3NvY2tldHMnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgcmVzLmpzb24oTWFjaGluZXMuc29ja2V0cyhyZXEucGFyYW1zLnNlcmlhbCkpXG59KTtcbmFwcC5nZXQoJy9tYWNoaW5lcycsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICByZXMuanNvbihNYWNoaW5lcy5saXN0KCkpXG59KTtcbmFwcC5nZXQoJy9hcHAvOmFwcC9tYWNoaW5lcycsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuIC8vIHJlcy5qc29uKE1hY2hpbmVzLnNlcmlhbHMoKSlcbn0pO1xuXG5hcHAuZ2V0KCcvbWFjaGluZXMvOnNlcmlhbC9tZXNzYWdlLzptZXNzYWdlJywgZnVuY3Rpb24gKHJlcSwgcmVzKSB7XG4gIF8ubWFwKE1hY2hpbmVzLmlvcyhyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0KXtcbiAgICBzb2NrZXQuZW1pdCgnbWVzc2FnZScsIHJlcS5wYXJhbXMubWVzc2FnZSk7XG5cbiAgfSlcbiAgcmVzLmpzb24oe30pXG5cbn0pO1xuXG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvbWVzc2FnZScsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21lc3NhZ2UnLCByZXEuYm9keS5kYXRhKTtcbiAgfSlcblxufSk7XG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvZGF0YScsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ2RhdGEnLCByZXEuYm9keS5kYXRhKTtcbiAgfSlcbn0pO1xuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL2V4ZWMnLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdleGVjJywgcmVxLmJvZHkuZGF0YSk7XG4gIH0pXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC9ucG0nLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCducG0nLCByZXEuYm9keS5kYXRhKTtcbiAgfSlcbn0pO1xuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL3Rhc2snLCBmdW5jdGlvbiAocmVxLCByZXMpIHtcbiAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksZnVuY3Rpb24oc29ja2V0aWQpe1xuICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCd0YXNrJywgcmVxLmJvZHkuZGF0YSk7XG4gIH0pXG59KTtcblxuaW8ub24oJ2Nvbm5lY3Rpb24nLCBmdW5jdGlvbiAoc29ja2V0OklTb2NrZXQpIHtcbiAgbGV0IGMgPSBzb2NrZXQuZGVjb2RlZF90b2tlbjtcblxuICBpZihjLmRiKXtcbiAgICBjb25zb2xlLmxvZyhjLmRiKVxuXG4gICAgTWFjaGluZXMuYWRkKGMudXNlcixjLnBhc3N3b3JkLGMuZGIsYy5zZXJpYWwsc29ja2V0KTtcbiAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIGNvbm5lY3Rpb24nLCB7c2VyaWFsOmMuc2VyaWFsfSk7XG4gICAgfSlcblxuICAgIHNvY2tldC5vbignZGlzY29ubmVjdCcsIGZ1bmN0aW9uICgpIHtcblxuICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIGRpc2Nvbm5lY3Rpb24nLCB7c2VyaWFsOmMuc2VyaWFsfSk7XG4gICAgICB9KVxuXG4gICAgICBNYWNoaW5lcy5yZW1vdmUoYy5zZXJpYWwsc29ja2V0LmlkKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ21lc3NhZ2UnLCBmdW5jdGlvbiAobWVzc2FnZSkge1xuICAgICAgTWFjaGluZXMucHVzaGRhdGEoYy5zZXJpYWwsJ21lc3NhZ2UnLG1lc3NhZ2UpLnRoZW4oZnVuY3Rpb24oZG9jcyl7XG5cbiAgICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSxmdW5jdGlvbihzb2NrZXRpZCl7XG4gICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgbWVzc2FnZScsIHtzZXJpYWw6Yy5zZXJpYWwsZGF0YTptZXNzYWdlfSk7XG4gICAgICAgIH0pXG4gICAgICB9KVxuICAgIH0pO1xuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICBNYWNoaW5lcy5wdXNoZGF0YShjLnNlcmlhbCwnZGF0YScsZGF0YSkudGhlbihmdW5jdGlvbihkb2NzKXtcblxuICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkYXRhJywge3NlcmlhbDpjLnNlcmlhbCxkYXRhOmRhdGF9KTtcbiAgICAgICAgfSlcbiAgICAgIH0pXG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdkb2NzJywgZnVuY3Rpb24gKGRvY3MpIHtcbiAgICAgIE1hY2hpbmVzLnB1c2hkYXRhKGMuc2VyaWFsLCdkb2NzJyxkb2NzKS50aGVuKGZ1bmN0aW9uKGRvY3Mpe1xuICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkb2NzJywge3NlcmlhbDpjLnNlcmlhbCxkYXRhOmRvY3N9KTtcbiAgICAgICAgfSlcblxuICAgICAgfSlcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ3VwJywgZnVuY3Rpb24gKGRhdGFzKSB7XG4gICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLGZ1bmN0aW9uKHNvY2tldGlkKXtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgdXAnLCB7c2VyaWFsOmMuc2VyaWFsfSk7XG4gICAgICB9KVxuICAgIH0pXG5cbn0gZWxzZXtcbiAgQXVkaXRvcnMuYWRkKGMuc2VyaWFscyxzb2NrZXQuaWQpXG4gIHNvY2tldC5vbignZGlzY29ubmVjdCcsIGZ1bmN0aW9uICgpIHtcbiAgICBBdWRpdG9ycy5yZW1vdmUoc29ja2V0LmlkKVxuICB9KTtcblxufVxuXG5jb25zb2xlLmxvZygnaGVsbG8hICcsIHNvY2tldC5pZCk7XG59KTtcbiJdLCJzb3VyY2VSb290IjoiL3NvdXJjZS8ifQ==
