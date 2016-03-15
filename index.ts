import * as net from "net";
import * as _ from "lodash";
import * as Promise from "bluebird";
import * as bodyParser from "body-parser";
import * as pathExists from "path-exists";
import * as IO from "socket.io";
import * as express from "express";
import * as jwt from "jsonwebtoken";
import * as redis from "redis";

let moment = require("moment-timezone");


import couchjsonconf = require("couchjsonconf");

import machClients = require("./modules/machClients");
import audClients = require("./modules/audClients");

let socketioJwt = require("socketio-jwt");
let rpj = require("request-promise-json");
let aedes = require("aedes");


let app = express();
let server = require("http").Server(app);
let io = IO(server);





if (!pathExists.sync("./conf.json")) {
    throw Error("no configuration founded");
}
let conf = require("./conf.json");

let COUCHDB = new couchjsonconf(conf.couchdb);

let Machines = new machClients(COUCHDB);
let Auditors = new audClients();

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());



io.use(socketioJwt.authorize({
    secret: conf.secret,
    handshake: true
}));

server.listen(conf.port);


let Aedes = aedes();
let Aserver = net.createServer(Aedes.handle);

Aserver.listen(1883, function() {
    console.log("MQTT server listening on port", 1883);
});


Aedes.authenticate = function(client, username, token, callback) {


    if (conf.admin.username === username) {

        if (token === conf.admin.password) {
            callback(null, true);
        } else {
            console.log("unauthorized " + username);
            callback(null);
        }


    } else {

        try {



            let decoded: any = jwt.verify(JSON.parse(token + ""), conf.secret, { ignoreExpiration: true }); // to be changed in verify
            let db = decoded.db;
            let password = decoded.password;
            console.log("auth");


            // 
            authcouch(username, password, db).then(function() {
                console.log("authorized " + username);
                client.serial = decoded.serial;
                client.couch = { username: username, password: password, db: db };
                callback(null, true);
            }).catch(function() {
                console.log("unauthorized " + username);
                callback(null);
            });


        } catch (err) {
            console.log("unauthorized " + username);
            callback(null);
        }

    }

};

Aedes.on("client", function(client) {


    console.log("new client" + client.id);



});

Aedes.on("clientDisconnect", function(client) {
    console.log("clientDisconnect");
});

Aedes.on("subscribe", function(topic, client) {
    console.log("subscribe");
});

Aedes.on("unsubscribe", function(topic, client) {
    console.log("unsubscribe");
});

Aedes.on("publish", function(packet, client) {

    if (!client) return;

    let obj = JSON.parse(packet.payload.toString());
    console.log("publish");



    if (packet.topic.split("/").length > 1 && packet.topic.split("/")[0] === "data" && client.couch && client.couch && client.couch.username) {
        //    rpj.post()


        // PATCH TO BE REMOVEDDDD
        if (client.couch.db === "mach_pctt3v_energytrack" || client.couch.db === "mach_sxcm0q_energytrack") { // PATCH TO BE REMOVEDDDD
            obj.updatedAt = obj.updatedAt + 3600000;
            obj.date = moment.tz(obj.updatedAt, "Europe/Rome").format("YYYYMMDD-HH:mm:ss");
        }
        console.log("save");
        rpj.get("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + "/" + obj._id).then(function(d) {
            obj._rev = d._rev;
            rpj.put("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + "/" + obj._id, obj).then(function() {
                console.log("backup");


                rpj.get("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + "/hooks").then(function(data) {


                    try {

                        let hookurl = data[packet.topic.split("/")[0]];

                        console.log(hookurl);

                        if (data[packet.topic.split("/")[0]]) {

                            rpj.post(hookurl + "/" + client.serial + "/" + client.couch.db + "/" + client.couch.username + "/" + client.couch.password, { data: obj }).then(function(bro) {
                                console.log("send to applicantion manager");

                            }).catch(function(err) {
                                console.log(err);
                            });



                        }


                    } catch (err) {

                        console.log(err);

                    }


                }).catch(function(err) {
                    console.log(err);
                });




            }).catch(function(err) {
                console.log("save error " + err);
            });

        }).catch(function(err) {
            if (err.statusCode === 404) {
                rpj.put("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + "/" + obj._id, obj).then(function() {
                    console.log("backup");


                    rpj.get("http://" + client.couch.username + ":" + client.couch.password + "@192.168.122.44:5984/" + client.couch.db + "/hooks").then(function(data) {


                        try {

                            let hookurl = data[packet.topic.split("/")[0]];

                            console.log(hookurl);

                            if (data[packet.topic.split("/")[0]]) {

                                rpj.post(hookurl + "/" + client.serial + "/" + client.couch.db + "/" + client.couch.username + "/" + client.couch.password, { data: obj }).then(function(bro) {
                                    console.log("send to applicantion manager");

                                }).catch(function(err) {
                                    console.log(err);
                                });



                            }


                        } catch (err) {

                            console.log(err);

                        }


                    }).catch(function(err) {
                        console.log(err);
                    });



                }).catch(function(err) {
                    console.log("save error " + err);
                });

            } else {
                console.log(err);
            }

        });


    }




});


interface ISocket {

    id: string;
    emit: Function;
    on: Function;
    decoded_token: {
        db: string;
        user: string;
        password: string;
        serial: string;
        serials: string[]
    };
}




app.get("/", function(req, res) {
    res.json({ online: true });
});




function authcouch(user: string, password: string, db: string) {
    return new Promise(function(resolve, reject) {
        rpj.get(COUCHDB.for(user, password, db)).then(function() {
            resolve({ success: true });
        }).catch(function(err) {
            reject({ error: "wrong credentials" });
        });
    });
}

function authorizesocket(profile): {} {
    return jwt.sign(profile, conf.secret, { expiresInMinutes: 60 * 5 });
}

app.post("/login", function(req, res) {
    authcouch(req.body.user, req.body.password, req.body.db).then(function() {

        let token = authorizesocket({ user: req.body.user, password: req.body.password, db: req.body.db, serial: req.body.serial });

        res.json({ success: true, token: token });
    }).catch(function(err) {
        res.json(err);
    });
});

app.get("/ip", function(req, res) {
    res.json({ ip: req.headers["x-forwarded-for"] });
});

app.get("/sockets", function(req, res) {
    res.json(Machines.sockets());
});
app.get("/machines/:serial/sockets", function(req, res) {
    res.json(Machines.sockets(req.params.serial));
});
app.get("/machines", function(req, res) {
    res.json(Machines.list());
});
app.get("/app/:app/machines", function(req, res) {
    // res.json(Machines.serials())
});

app.get("/machines/:serial/message/:message", function(req, res) {
    _.map(Machines.ios(req.params.serial), function(socket) {
        socket.emit("message", req.params.message);

    });
    res.json({});

});

app.post("/machines/:serial/message", function(req, res) {
    _.map(Machines.list(req.params.serial), function(socketid) {
        io.to(socketid).emit("message", req.body.data);
    });

});
app.post("/machines/:serial/data", function(req, res) {
    _.map(Machines.list(req.params.serial), function(socketid) {
        io.to(socketid).emit("data", req.body.data);
    });
});
app.post("/machines/:serial/exec", function(req, res) {
    _.map(Machines.list(req.params.serial), function(socketid) {
        io.to(socketid).emit("exec", req.body.data);
    });
});
app.post("/machines/:serial/npm", function(req, res) {
    _.map(Machines.list(req.params.serial), function(socketid) {
        io.to(socketid).emit("npm", req.body.data);
    });
});
app.post("/machines/:serial/task", function(req, res) {
    _.map(Machines.list(req.params.serial), function(socketid) {
        io.to(socketid).emit("task", req.body.data);
    });
});

io.on("connection", function(socket: ISocket) {
    let c = socket.decoded_token;

    if (c.db) {
        console.log(c.db);

        Machines.add(c.user, c.password, c.db, c.serial, socket);
        _.map(Auditors.forserial(c.serial), function(socketid) {
            io.to(socketid).emit("machine connection", { serial: c.serial });
        });

        socket.on("disconnect", function() {

            _.map(Auditors.forserial(c.serial), function(socketid) {
                io.to(socketid).emit("machine disconnection", { serial: c.serial });
            });

            Machines.remove(c.serial, socket.id);
        });
        socket.on("message", function(message) {
            Machines.pushdata(c.serial, "message", message).then(function(docs) {

                _.map(Auditors.forserial(c.serial), function(socketid) {
                    io.to(socketid).emit("machine message", { serial: c.serial, data: message });
                });
            });
        });
        socket.on("data", function(data) {
            Machines.pushdata(c.serial, "data", data).then(function(docs) {

                _.map(Auditors.forserial(c.serial), function(socketid) {
                    io.to(socketid).emit("machine data", { serial: c.serial, data: data });
                });
            });
        });
        socket.on("docs", function(docs) {
            Machines.pushdata(c.serial, "docs", docs).then(function(docs) {
                _.map(Auditors.forserial(c.serial), function(socketid) {
                    io.to(socketid).emit("machine docs", { serial: c.serial, data: docs });
                });

            });
        });
        socket.on("up", function(datas) {
            _.map(Auditors.forserial(c.serial), function(socketid) {
                io.to(socketid).emit("machine up", { serial: c.serial });
            });
        });

    } else {
        Auditors.add(c.serials, socket.id);
        socket.on("disconnect", function() {
            Auditors.remove(socket.id);
        });

    }

    console.log("hello! ", socket.id);
});
