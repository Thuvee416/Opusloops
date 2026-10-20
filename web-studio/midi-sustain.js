// Channel-scoped sustain routing. Each strike gets an independent voice identity.
export class MidiSustain {
  constructor(emit){this.emit=emit;this.pedals=new Set();this.keys=new Map();this.held=new Map();this.serial=0;}
  emitAt(type,id,pitch,velocity,time){const args=[type,id,pitch,velocity];if(Number.isFinite(time))args.push(time);this.emit(...args);}
  release(id,time){const note=this.held.get(id);if(!note)return;this.held.delete(id);for(const [key,value]of this.keys)if(value===id)this.keys.delete(key);this.emitAt('off',id,note.pitch,note.releaseVelocity??0,time);}
  handle(note,time){const {type,channel,pitch,velocity}=note;
    if(type==='all-notes-off'){
      for(const [key,id]of this.keys){const n=this.held.get(id);if(n?.channel!==channel)continue;this.keys.delete(key);n.pressed=false;n.releaseVelocity=0;if(!this.pedals.has(channel))this.release(id,time);}
      return;
    }
    if(type==='sustain'||type==='reset-controllers'){if(type==='sustain'&&note.down)this.pedals.add(channel);else{this.pedals.delete(channel);for(const [id,n]of this.held)if(n.channel===channel&&!n.pressed)this.release(id,time);}return;}
    const key=channel+':'+pitch;if(type==='on'){if(this.keys.has(key))this.release(this.keys.get(key),time);if(this.held.size>=128)this.release(this.held.keys().next().value,time);const id='midi:'+channel+':'+pitch+':'+(++this.serial);this.keys.set(key,id);this.held.set(id,{channel,pitch,pressed:true});this.emitAt('on',id,pitch,velocity,time);}
    else if(type==='off'){const id=this.keys.get(key),n=this.held.get(id);if(!n)return;this.keys.delete(key);n.pressed=false;n.releaseVelocity=velocity??0;if(!this.pedals.has(channel))this.release(id,time);}
  }
  reset(){for(const id of [...this.held.keys()])this.release(id);this.keys.clear();this.pedals.clear();}
}
