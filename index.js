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
Aedes.authenticate = function (client, username, password, callback) {
    console.log("auth");
    console.log(username);
    console.log(password + "");
    callback(null);
};
Aedes.on('client', function (client) {
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

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm5hbWVzIjpbImF1dGhjb3VjaCIsImF1dGhvcml6ZXNvY2tldCJdLCJtYXBwaW5ncyI6IkFBQUEsSUFBWSxHQUFHLFdBQU0sS0FBSyxDQUFDLENBQUE7QUFDM0IsSUFBWSxDQUFDLFdBQU0sUUFBUSxDQUFDLENBQUE7QUFDNUIsSUFBWSxPQUFPLFdBQU0sVUFBVSxDQUFDLENBQUE7QUFDcEMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxVQUFVLFdBQU0sYUFBYSxDQUFDLENBQUE7QUFDMUMsSUFBWSxFQUFFLFdBQU0sV0FBVyxDQUFDLENBQUE7QUFDaEMsSUFBWSxPQUFPLFdBQU0sU0FBUyxDQUFDLENBQUE7QUFDbkMsSUFBWSxHQUFHLFdBQU0sY0FBYyxDQUFDLENBQUE7QUFHcEMsSUFBTyxhQUFhLFdBQVcsZUFBZSxDQUFDLENBQUM7QUFFaEQsSUFBTyxXQUFXLFdBQVcsdUJBQXVCLENBQUMsQ0FBQztBQUN0RCxJQUFPLFVBQVUsV0FBVyxzQkFBc0IsQ0FBQyxDQUFDO0FBRXBELElBQUksV0FBVyxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUMxQyxJQUFJLEdBQUcsR0FBRyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUMxQyxJQUFJLEtBQUssR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7QUFHN0IsSUFBSSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDcEIsSUFBSSxNQUFNLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6QyxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUM7QUFNcEIsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsQyxNQUFNLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFBO0FBQzNDLENBQUM7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QUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2hELENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDaEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2hELENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHVCQUF1QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDL0MsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQy9DLENBQUMsQ0FBQyxDQUFBO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLHdCQUF3QixFQUFFLFVBQVMsR0FBRyxFQUFFLEdBQUc7SUFDaEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBUyxRQUFRO1FBQ3JELEVBQUUsQ0FBQyxF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Q0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyIsImZpbGUiOiJpbmRleC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIG5ldCBmcm9tIFwibmV0XCI7XG5pbXBvcnQgKiBhcyBfIGZyb20gXCJsb2Rhc2hcIjtcbmltcG9ydCAqIGFzIFByb21pc2UgZnJvbSBcImJsdWViaXJkXCI7XG5pbXBvcnQgKiBhcyBib2R5UGFyc2VyIGZyb20gXCJib2R5LXBhcnNlclwiO1xuaW1wb3J0ICogYXMgcGF0aEV4aXN0cyBmcm9tIFwicGF0aC1leGlzdHNcIjtcbmltcG9ydCAqIGFzIElPIGZyb20gXCJzb2NrZXQuaW9cIjtcbmltcG9ydCAqIGFzIGV4cHJlc3MgZnJvbSBcImV4cHJlc3NcIjtcbmltcG9ydCAqIGFzIGp3dCBmcm9tIFwianNvbndlYnRva2VuXCI7XG5pbXBvcnQgKiBhcyByZWRpcyBmcm9tIFwicmVkaXNcIjtcblxuaW1wb3J0IGNvdWNoanNvbmNvbmYgPSByZXF1aXJlKFwiY291Y2hqc29uY29uZlwiKTtcblxuaW1wb3J0IG1hY2hDbGllbnRzID0gcmVxdWlyZShcIi4vbW9kdWxlcy9tYWNoQ2xpZW50c1wiKTtcbmltcG9ydCBhdWRDbGllbnRzID0gcmVxdWlyZShcIi4vbW9kdWxlcy9hdWRDbGllbnRzXCIpO1xuXG5sZXQgc29ja2V0aW9Kd3QgPSByZXF1aXJlKFwic29ja2V0aW8tand0XCIpO1xubGV0IHJwaiA9IHJlcXVpcmUoJ3JlcXVlc3QtcHJvbWlzZS1qc29uJyk7XG5sZXQgYWVkZXMgPSByZXF1aXJlKFwiYWVkZXNcIik7XG5cblxubGV0IGFwcCA9IGV4cHJlc3MoKTtcbmxldCBzZXJ2ZXIgPSByZXF1aXJlKCdodHRwJykuU2VydmVyKGFwcCk7XG5sZXQgaW8gPSBJTyhzZXJ2ZXIpO1xuXG5cblxuXG5cbmlmICghcGF0aEV4aXN0cy5zeW5jKCcuL2NvbmYuanNvbicpKSB7XG4gICAgdGhyb3cgRXJyb3IoJ25vIGNvbmZpZ3VyYXRpb24gZm91bmRlZCcpXG59XG5sZXQgY29uZiA9IHJlcXVpcmUoJy4vY29uZi5qc29uJylcblxubGV0IENPVUNIREIgPSBuZXcgY291Y2hqc29uY29uZihjb25mLmNvdWNoZGIpXG5cbmxldCBNYWNoaW5lcyA9IG5ldyBtYWNoQ2xpZW50cyhDT1VDSERCKTtcbmxldCBBdWRpdG9ycyA9IG5ldyBhdWRDbGllbnRzKCk7XG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZFxuYXBwLnVzZShib2R5UGFyc2VyLnVybGVuY29kZWQoeyBleHRlbmRlZDogZmFsc2UgfSkpXG5cbi8vIHBhcnNlIGFwcGxpY2F0aW9uL2pzb25cbmFwcC51c2UoYm9keVBhcnNlci5qc29uKCkpXG5cblxuXG5pby51c2Uoc29ja2V0aW9Kd3QuYXV0aG9yaXplKHtcbiAgICBzZWNyZXQ6IGNvbmYuc2VjcmV0LFxuICAgIGhhbmRzaGFrZTogdHJ1ZVxufSkpO1xuXG5zZXJ2ZXIubGlzdGVuKGNvbmYucG9ydCk7XG5cblxubGV0IEFlZGVzID0gYWVkZXMoKVxubGV0IEFzZXJ2ZXIgPSBuZXQuY3JlYXRlU2VydmVyKEFlZGVzLmhhbmRsZSlcblxuQXNlcnZlci5saXN0ZW4oMTg4MywgZnVuY3Rpb24oKSB7XG4gICAgY29uc29sZS5sb2coJ01RVFQgc2VydmVyIGxpc3RlbmluZyBvbiBwb3J0JywgMTg4Mylcbn0pO1xuXG5cbkFlZGVzLmF1dGhlbnRpY2F0ZSA9IGZ1bmN0aW9uKGNsaWVudCwgdXNlcm5hbWUsIHBhc3N3b3JkLCBjYWxsYmFjaykge1xuXG5cbiAgICBjb25zb2xlLmxvZyhcImF1dGhcIilcbiAgICBjb25zb2xlLmxvZyh1c2VybmFtZSlcbiAgICBjb25zb2xlLmxvZyggcGFzc3dvcmQrXCJcIilcbiAgICAvLyBcbiAgICBjYWxsYmFjayhudWxsKVxufVxuXG5BZWRlcy5vbignY2xpZW50JywgZnVuY3Rpb24oY2xpZW50KSB7XG5cblxuICAgIGNvbnNvbGUubG9nKFwibmV3IGNsaWVudFwiICsgY2xpZW50LmlkKVxufSk7XG5cbkFlZGVzLm9uKCdjbGllbnREaXNjb25uZWN0JywgZnVuY3Rpb24oY2xpZW50KSB7XG4gICAgY29uc29sZS5sb2coXCJjbGllbnREaXNjb25uZWN0XCIpXG59KTtcblxuQWVkZXMub24oJ3N1YnNjcmliZScsIGZ1bmN0aW9uKHRvcGljLCBjbGllbnQpIHtcbiAgICBjb25zb2xlLmxvZyhcInN1YnNjcmliZVwiKVxufSk7XG5cbkFlZGVzLm9uKCd1bnN1YnNjcmliZScsIGZ1bmN0aW9uKHRvcGljLCBjbGllbnQpIHtcbiAgICBjb25zb2xlLmxvZyhcInVuc3Vic2NyaWJlXCIpXG59KTtcblxuQWVkZXMub24oJ3B1Ymxpc2gnLCBmdW5jdGlvbihwYWNrZXQsIGNsaWVudCkge1xuXG4gICAgaWYgKCFjbGllbnQpIHJldHVybjtcblxuICAgIHBhY2tldC5wYXlsb2FkU3RyaW5nID0gcGFja2V0LnBheWxvYWQudG9TdHJpbmcoKTtcbiAgICBwYWNrZXQucGF5bG9hZExlbmd0aCA9IHBhY2tldC5wYXlsb2FkLmxlbmd0aDtcbiAgICBwYWNrZXQucGF5bG9hZCA9IEpTT04uc3RyaW5naWZ5KHBhY2tldC5wYXlsb2FkKTtcbiAgICBwYWNrZXQudGltZXN0YW1wID0gbmV3IERhdGUoKTtcblxuICAgIGNvbnNvbGUubG9nKFwicHVibGlzaFwiKVxuXG59KTtcblxuXG5pbnRlcmZhY2UgSVNvY2tldCB7XG5cbiAgICBpZDogc3RyaW5nO1xuICAgIGVtaXQ6IEZ1bmN0aW9uO1xuICAgIG9uOiBGdW5jdGlvbjtcbiAgICBkZWNvZGVkX3Rva2VuOiB7XG4gICAgICAgIGRiOiBzdHJpbmc7XG4gICAgICAgIHVzZXI6IHN0cmluZztcbiAgICAgICAgcGFzc3dvcmQ6IHN0cmluZztcbiAgICAgICAgc2VyaWFsOiBzdHJpbmc7XG4gICAgICAgIHNlcmlhbHM6IHN0cmluZ1tdXG4gICAgfVxufVxuXG5cblxuXG5hcHAuZ2V0KCcvJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICByZXMuanNvbih7IG9ubGluZTogdHJ1ZSB9KVxufSk7XG5cblxuXG5cbmZ1bmN0aW9uIGF1dGhjb3VjaCh1c2VyOiBzdHJpbmcsIHBhc3N3b3JkOiBzdHJpbmcsIGRiOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgIHJwai5nZXQoQ09VQ0hEQi5mb3IodXNlciwgcGFzc3dvcmQsIGRiKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHJlc29sdmUoeyBzdWNjZXNzOiB0cnVlIH0pXG4gICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgcmVqZWN0KHsgZXJyb3I6ICd3cm9uZyBjcmVkZW50aWFscycgfSlcbiAgICAgICAgfSlcbiAgICB9KVxufVxuXG5mdW5jdGlvbiBhdXRob3JpemVzb2NrZXQocHJvZmlsZSk6IHt9IHtcbiAgICByZXR1cm4gand0LnNpZ24ocHJvZmlsZSwgY29uZi5zZWNyZXQsIHsgZXhwaXJlc0luTWludXRlczogNjAgKiA1IH0pO1xufVxuXG5hcHAucG9zdCgnL2xvZ2luJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBhdXRoY291Y2gocmVxLmJvZHkudXNlciwgcmVxLmJvZHkucGFzc3dvcmQsIHJlcS5ib2R5LmRiKS50aGVuKGZ1bmN0aW9uKCkge1xuXG4gICAgICAgIGxldCB0b2tlbiA9IGF1dGhvcml6ZXNvY2tldCh7IHVzZXI6IHJlcS5ib2R5LnVzZXIsIHBhc3N3b3JkOiByZXEuYm9keS5wYXNzd29yZCwgZGI6IHJlcS5ib2R5LmRiLCBzZXJpYWw6IHJlcS5ib2R5LnNlcmlhbCB9KVxuXG4gICAgICAgIHJlcy5qc29uKHsgc3VjY2VzczogdHJ1ZSwgdG9rZW46IHRva2VuIH0pXG4gICAgfSkuY2F0Y2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgIHJlcy5qc29uKGVycilcbiAgICB9KVxufSk7XG5cbmFwcC5nZXQoJy9pcCcsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgcmVzLmpzb24oeyBpcDogcmVxLmhlYWRlcnNbJ3gtZm9yd2FyZGVkLWZvciddIH0pXG59KTtcblxuYXBwLmdldCgnL3NvY2tldHMnLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIHJlcy5qc29uKE1hY2hpbmVzLnNvY2tldHMoKSlcbn0pO1xuYXBwLmdldCgnL21hY2hpbmVzLzpzZXJpYWwvc29ja2V0cycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgcmVzLmpzb24oTWFjaGluZXMuc29ja2V0cyhyZXEucGFyYW1zLnNlcmlhbCkpXG59KTtcbmFwcC5nZXQoJy9tYWNoaW5lcycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgcmVzLmpzb24oTWFjaGluZXMubGlzdCgpKVxufSk7XG5hcHAuZ2V0KCcvYXBwLzphcHAvbWFjaGluZXMnLCBmdW5jdGlvbihyZXEsIHJlcykge1xuICAgIC8vIHJlcy5qc29uKE1hY2hpbmVzLnNlcmlhbHMoKSlcbn0pO1xuXG5hcHAuZ2V0KCcvbWFjaGluZXMvOnNlcmlhbC9tZXNzYWdlLzptZXNzYWdlJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5pb3MocmVxLnBhcmFtcy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXQpIHtcbiAgICAgICAgc29ja2V0LmVtaXQoJ21lc3NhZ2UnLCByZXEucGFyYW1zLm1lc3NhZ2UpO1xuXG4gICAgfSlcbiAgICByZXMuanNvbih7fSlcblxufSk7XG5cbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC9tZXNzYWdlJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21lc3NhZ2UnLCByZXEuYm9keS5kYXRhKTtcbiAgICB9KVxuXG59KTtcbmFwcC5wb3N0KCcvbWFjaGluZXMvOnNlcmlhbC9kYXRhJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICBfLm1hcChNYWNoaW5lcy5saXN0KHJlcS5wYXJhbXMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ2RhdGEnLCByZXEuYm9keS5kYXRhKTtcbiAgICB9KVxufSk7XG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvZXhlYycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdleGVjJywgcmVxLmJvZHkuZGF0YSk7XG4gICAgfSlcbn0pO1xuYXBwLnBvc3QoJy9tYWNoaW5lcy86c2VyaWFsL25wbScsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCducG0nLCByZXEuYm9keS5kYXRhKTtcbiAgICB9KVxufSk7XG5hcHAucG9zdCgnL21hY2hpbmVzLzpzZXJpYWwvdGFzaycsIGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgXy5tYXAoTWFjaGluZXMubGlzdChyZXEucGFyYW1zLnNlcmlhbCksIGZ1bmN0aW9uKHNvY2tldGlkKSB7XG4gICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCd0YXNrJywgcmVxLmJvZHkuZGF0YSk7XG4gICAgfSlcbn0pO1xuXG5pby5vbignY29ubmVjdGlvbicsIGZ1bmN0aW9uKHNvY2tldDogSVNvY2tldCkge1xuICAgIGxldCBjID0gc29ja2V0LmRlY29kZWRfdG9rZW47XG5cbiAgICBpZiAoYy5kYikge1xuICAgICAgICBjb25zb2xlLmxvZyhjLmRiKVxuXG4gICAgICAgIE1hY2hpbmVzLmFkZChjLnVzZXIsIGMucGFzc3dvcmQsIGMuZGIsIGMuc2VyaWFsLCBzb2NrZXQpO1xuICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgY29ubmVjdGlvbicsIHsgc2VyaWFsOiBjLnNlcmlhbCB9KTtcbiAgICAgICAgfSlcblxuICAgICAgICBzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCBmdW5jdGlvbigpIHtcblxuICAgICAgICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkaXNjb25uZWN0aW9uJywgeyBzZXJpYWw6IGMuc2VyaWFsIH0pO1xuICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgTWFjaGluZXMucmVtb3ZlKGMuc2VyaWFsLCBzb2NrZXQuaWQpO1xuICAgICAgICB9KTtcbiAgICAgICAgc29ja2V0Lm9uKCdtZXNzYWdlJywgZnVuY3Rpb24obWVzc2FnZSkge1xuICAgICAgICAgICAgTWFjaGluZXMucHVzaGRhdGEoYy5zZXJpYWwsICdtZXNzYWdlJywgbWVzc2FnZSkudGhlbihmdW5jdGlvbihkb2NzKSB7XG5cbiAgICAgICAgICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBtZXNzYWdlJywgeyBzZXJpYWw6IGMuc2VyaWFsLCBkYXRhOiBtZXNzYWdlIH0pO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9KVxuICAgICAgICB9KTtcbiAgICAgICAgc29ja2V0Lm9uKCdkYXRhJywgZnVuY3Rpb24oZGF0YSkge1xuICAgICAgICAgICAgTWFjaGluZXMucHVzaGRhdGEoYy5zZXJpYWwsICdkYXRhJywgZGF0YSkudGhlbihmdW5jdGlvbihkb2NzKSB7XG5cbiAgICAgICAgICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgICAgICAgICBpby50byhzb2NrZXRpZCkuZW1pdCgnbWFjaGluZSBkYXRhJywgeyBzZXJpYWw6IGMuc2VyaWFsLCBkYXRhOiBkYXRhIH0pO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9KVxuICAgICAgICB9KTtcbiAgICAgICAgc29ja2V0Lm9uKCdkb2NzJywgZnVuY3Rpb24oZG9jcykge1xuICAgICAgICAgICAgTWFjaGluZXMucHVzaGRhdGEoYy5zZXJpYWwsICdkb2NzJywgZG9jcykudGhlbihmdW5jdGlvbihkb2NzKSB7XG4gICAgICAgICAgICAgICAgXy5tYXAoQXVkaXRvcnMuZm9yc2VyaWFsKGMuc2VyaWFsKSwgZnVuY3Rpb24oc29ja2V0aWQpIHtcbiAgICAgICAgICAgICAgICAgICAgaW8udG8oc29ja2V0aWQpLmVtaXQoJ21hY2hpbmUgZG9jcycsIHsgc2VyaWFsOiBjLnNlcmlhbCwgZGF0YTogZG9jcyB9KTtcbiAgICAgICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICB9KVxuICAgICAgICB9KTtcbiAgICAgICAgc29ja2V0Lm9uKCd1cCcsIGZ1bmN0aW9uKGRhdGFzKSB7XG4gICAgICAgICAgICBfLm1hcChBdWRpdG9ycy5mb3JzZXJpYWwoYy5zZXJpYWwpLCBmdW5jdGlvbihzb2NrZXRpZCkge1xuICAgICAgICAgICAgICAgIGlvLnRvKHNvY2tldGlkKS5lbWl0KCdtYWNoaW5lIHVwJywgeyBzZXJpYWw6IGMuc2VyaWFsIH0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgfSlcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIEF1ZGl0b3JzLmFkZChjLnNlcmlhbHMsIHNvY2tldC5pZClcbiAgICAgICAgc29ja2V0Lm9uKCdkaXNjb25uZWN0JywgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBBdWRpdG9ycy5yZW1vdmUoc29ja2V0LmlkKVxuICAgICAgICB9KTtcblxuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKCdoZWxsbyEgJywgc29ja2V0LmlkKTtcbn0pO1xuIl0sInNvdXJjZVJvb3QiOiIvc291cmNlLyJ9
