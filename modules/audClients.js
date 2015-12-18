var _=require('lodash');
var rpj = require('request-promise-json');
var Promise = require('promise');


function AClients(){
  this.all=[]

};

AClients.prototype.add = function (sid,serials) {
  this.all.push({id:sid,serials:serials})

};
AClients.prototype.remove = function (sid) {
  _.map(this.all,function(s){
    if (s.id==sid){
      delete s
    }
  })

};

AClients.prototype.forserial = function (serial) {
var a=[];
  _.map(this.all,function(s){
    _.map(s.serials,function(ss){
      if(ss==serial){
        a.push(s.id)
      }
    })
  })
  return a
};
module.exports=AClients
