import * as _ from "lodash";
import * as Promise from "bluebird";
let rpj = require('request-promise-json');

interface IClients{
    id:string;
    serials:string[];
}

export=class AuClients {
    
    all:IClients[]=[];
    

add(serials:string[],sid:string):void {
  this.all.push({id:sid,serials:serials})

};
remove(sid):void {
    let all=this.all;
  _.map(this.all,function(s:IClients){
    if (s.id==sid){
      _.pull(all,s)
    }
  })

};

forserial = function (serial):string[] {
let a:string[]=[];
  _.map(this.all,function(s:IClients){
    _.map(s.serials,function(ss){
      if(ss==serial){
        a.push(s.id)
      }
    })
  })
  return a
};
}

