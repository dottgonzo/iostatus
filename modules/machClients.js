var _=require('lodash');
var rpj = require('request-promise-json');
var Promise = require('promise');


function mconnection(user,password,db,serial,bool){
  return new Promise(function(resolve, reject) {
    rpj.get(db+'/connection_'+serial).then(function(doc){
      doc.connected=bool;
      doc.updatedAt=new Date().getTime()
      rpj.put(db+'/connection_'+serial,doc).then(function(d){
        resolve(true)
      }).catch(function(err){
        console.log(err)

        reject(err)
      })
    }).catch(function(err){
      console.log(err)

      if (bool==true&&err.statusCode==404){  // if docnot exit e bool true bla bla bla

        var doc={
          _id:'connection_'+serial,
          connected:true,
          updatedAt:new Date().getTime()
        }

        rpj.post(db,doc).then(function(doc){
          resolve(true);
        }).catch(function(err){
          reject({error:'wrong credentials'})
        })
      } else {
        console.log(err)
        reject(err)
      }
    })
  });
}


function pushtodb(user,password,db,serial,doc){
  return new Promise(function(resolve, reject) {
    rpj.get(db+'/'+doc._id).then(function(d){
      doc._rev=d._rev
      rpj.put(db+'/'+doc._id,doc).then(function(){
        resolve(doc)
      }).catch(function(err){
        reject(err)
      });
    }).catch(function(err){
      if (err.statusCode==404){
        rpj.post(db+'/',doc).then(function(){
          resolve(doc)
        }).catch(function(err){
          reject(err)
        });
      } else{
        console.log(err)
        reject(err)
      }
    });
  });

}

function exists(all,serial,sid){
  var serialexists=false
  var socketexists=false

  _.map(all,function(client){
    if(client.serial){
      serialexists=true

      _.map(client.sockets,function(s){
        if (s.id==sid){
          socketexists=true
        }
      })
    }
  })
  return {serial:serialexists,socket:socketexists}
}

function MClients(db){
  this.all=[];
  this.couchdb=db
};

MClients.prototype.add=function(user,password,db,serial,socket){

  var exist=exists(this.all,serial,socket.id)
  if(!exist.serial){

    this.all.push({
      serial:serial,
      user:user,
      password:password,
      db:this.couchdb.protocol+'://'+user+':'+password+'@'+this.couchdb.host+'/'+db,
      sockets:[{id:socket.id,socket:socket}]
    })

    return mconnection(user,password,this.couchdb.protocol+'://'+user+':'+password+'@'+this.couchdb.host+'/'+db,serial,true)

  }else if(!exist.socket){
    _.map(this.all,function(client){
      if(client.serial){
        client.sockets.push({id:socket.id,socket:socket})
      }
    })
    console.log('new socket for '+serial)
  }


};

MClients.prototype.remove=function(serial,sid){


  for(var soc=0;soc<this.all.length;soc++){
    var client=this.all[soc]


    if(client.serial){

      if(client.sockets.length==1&&client.sockets[0].id==sid){
        mconnection(client.user,client.password,client.db,client.serial,false).then(function(){
          console.log('switched offline')
        }).catch(function(){
          console.log('switched offline error')
          console.log(err)
        })


        this.all=_.reject(this.all, function(el) {
          return el.serial === client.serial;
        })



      } else{
        console.log('todo')
        // this.all=_.reject(this.all, function(el) {
        //   return el.serial === client.serial;
        // })

      }
    }
  }
};

MClients.prototype.list=function(){

  var serials=[];
  _.map(this.all,function(client){
    serials.push(client.serial)
  })

  return serials
};
MClients.prototype.ios=function(serial){
  var sockets;

  if(serial){
    _.map(this.all,function(client){
      if(client.serial==serial){
        sockets=_.pluck(client.sockets,"socket")
      }
    })
return sockets;
  } else{
    var sockets=[];

    _.map(this.all,function(client){
      _.map(client.sockets,function(s){

        sockets.push(s.socket)


      })
    })

    return sockets
  }

};
MClients.prototype.sockets=function(serial){
  var ids;
  if(serial){
    _.map(this.all,function(client){
      if(client.serial==serial){
        ids=_.pluck(client.sockets,"id")
      }
    })
return ids
  } else{
    var ids=[];

    _.map(this.all,function(client){
      _.map(client.sockets,function(s){
        ids.push(s.id)
      })
    })

    return ids
  }

};
module.exports=MClients
