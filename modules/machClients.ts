import * as _ from "lodash";
import * as Promise from "bluebird";
let rpj = require('request-promise-json');

function mconnection(user: string, password: string, db: string, serial: string, bool?: boolean) {
    return new Promise(function(resolve, reject) {
        rpj.get(db + '/connection_' + serial).then(function(doc) {
            doc.connected = bool;
            doc.updatedAt = new Date().getTime()
            rpj.put(db + '/connection_' + serial, doc).then(function(d) {
                resolve(true)
            }).catch(function(err) {
                console.log(err)
                reject(err)
            })
        }).catch(function(err) {
            console.log(err)

            if (bool == true && err.statusCode == 404) {  // if docnot exit e bool true bla bla bla

                let doc = {
                    _id: 'connection_' + serial,
                    connected: true,
                    updatedAt: new Date().getTime()
                }

                rpj.post(db, doc).then(function(doc) {
                    resolve(true);
                }).catch(function(err) {
                    reject({ error: 'wrong credentials' })
                })
            } else {
                console.log(err)
                reject(err)
            }
        })
    });
}


function pushtodb(user: string, password: string, db: string, serial: string, doc: { _id: string, _rev?: string }) {
    return new Promise(function(resolve, reject) {
        rpj.get(db + '/' + doc._id).then(function(d) {
            doc._rev = d._rev
            rpj.put(db + '/' + doc._id, doc).then(function() {
                resolve(doc)
            }).catch(function(err) {
                reject(err)
            });
        }).catch(function(err) {
            if (err.statusCode == 404) {
                rpj.post(db + '/', doc).then(function() {
                    resolve(doc)
                }).catch(function(err) {
                    reject(err)
                });
            } else {
                console.log(err)
                reject(err)
            }
        });
    });

}

function exists(all: IClient[], serial, sid): { serial: boolean, socket: boolean } {
    let serialexists = false
    let socketexists = false

    _.map(all, function(client) {
        if (client.serial) {
            serialexists = true

            _.map(client.sockets, function(s) {
                if (s.id == sid) {
                    socketexists = true
                }
            })
        }
    })
    return { serial: serialexists, socket: socketexists }
}


interface ISocketArray {

    id: string;
    socket: ISocket
}

interface ISocket {
                on:Function;
        id: string;
        emit:Function;
    decoded_token:{
        db:string;
        user:string;
        password:string;
        serial:string;
    }
}

interface IClient {
    serial: string;
    sockets: ISocketArray[];
    user: string;
    password: string;
    db: string;
}


interface ICouchdb {
    protocol: string;
    port: number;
    host: string;
}


export =class MaClients {
    all: IClient[];
    couchdb: ICouchdb;

    constructor(db: ICouchdb) {
        this.couchdb = db
        this.all= [];
    }

    add(user: string, password: string, db: string, serial: string, socket: ISocket) {

        let exist = exists(this.all, serial, socket.id)
        if (!exist.serial) {

            this.all.push({
                serial: serial,
                user: user,
                password: password,
                db: this.couchdb.protocol + '://' + user + ':' + password + '@' + this.couchdb.host + '/' + db,
                sockets: [{ id: socket.id, socket: socket }]
            })

            return mconnection(user, password, this.couchdb.protocol + '://' + user + ':' + password + '@' + this.couchdb.host + '/' + db, serial, true)

        } else if (!exist.socket) {
            _.map(this.all, function(client) {
                if (client.serial) {
                    client.sockets.push({ id: socket.id, socket: socket })
                }
            })
            console.log('new socket for ' + serial)
        }


    };
    pushdata(serial:string,type:string,data:any) {
    
    return new Promise(function(resolve, reject) {
        
        reject('todo')
        
                   }) 
        
        
};
    remove(serial: string, sid: string) {

        let remaning: [IClient];

        for (let soc = 0; soc < this.all.length; soc++) {

            var client = this.all[soc];



            if (client.serial == serial) {

                if (client.sockets.length == 1 && client.sockets[0].id == sid) {
                    mconnection(client.user, client.password, client.db, client.serial, false).then(function() {
                        console.log('switched offline')
                    }).catch(function(err) {
                        console.log('switched offline error')
                        console.log(err)
                    })

                    _.map(this.all, function(el) {
                        if (el.serial != client.serial) {
                            remaning.push(el)
                        }

                    })
                    this.all = remaning;



                } else {
                    console.log('todo')
                    // this.all=_.reject(this.all, function(el) {
                    //   return el.serial === client.serial;
                    // })

                }
            }
        }
    };

    list(serial?: string): [string] {
        let serials: [string];
        if (serial) {

            _.map(this.all, function(client) {
                if (client.serial == serial) {
                    serials.push(client.serial)
                }
            })

        } else {

            _.map(this.all, function(client) {
                serials.push(client.serial)
            })


        }

        return serials

    };
    ios(serial?: string): [ISocket] {
        let sockets: [ISocket];

        if (serial) {
            _.map(this.all, function(client) {
                if (client.serial == serial) {

                    _.map(client.sockets, function(s) {
                        sockets.push(s.socket)
                    })
                }
            })

        } else {


            _.map(this.all, function(client) {
                _.map(client.sockets, function(s) {

                    sockets.push(s.socket)


                })
            })


        }
        return sockets
    };
    sockets(serial?: string) {
        let ids;
        if (serial) {
            _.map(this.all, function(client) {
                if (client.serial == serial) {
                    ids = _.pluck(client.sockets, "id")
                }
            })
            return ids
        } else {
            ids = [];

            _.map(this.all, function(client) {
                _.map(client.sockets, function(s) {
                    ids.push(s.id)
                })
            })

            return ids
        }

    };
    
    
    
    
};
