import {ArpSequencer} from './arpeggiator.js';
import {processMidiNotes} from './midi-effects.js';
export class LiveArpeggiator {
 constructor(owner,trackId,effects,index){this.owner=owner;this.trackId=trackId;this.effects=structuredClone(effects);this.before=this.effects.slice(0,index);this.after=this.effects.slice(index+1);this.bpm=owner.engine.project.bpm??120;this.origin=owner.engine.context.currentTime;this.state=new ArpSequencer(this.effects[index],this.bpm);this.records=new Map();this.scheduled=new Map();this.id='arp:'+crypto.randomUUID()+':';this.serial=0;this.timer=null;this.closed=false;}
 now(){return (this.owner.engine.context.currentTime-this.origin)*this.bpm/60;}
 on(key,pitch,velocity){if(this.records.size>=128)this.off(this.records.keys().next().value);const start=this.now(),pending=this.before.find(d=>d.enabled&&d.type==='length')?.trigger==='off',record={pitch,velocity,start,pending,open:[]};this.records.set(key,record);if(!pending)this.enqueue(processMidiNotes({pitch,velocity,start,duration:Infinity},this.before,this.bpm),record);this.wake();}
 enqueue(notes,record){const events=[];for(const note of notes){const id=++this.serial;events.push({type:'on',id,at:note.start,note});if(Number.isFinite(note.duration))events.push({type:'off',id,at:note.start+note.duration});else record.open.push(id);}this.state.enqueue(events);}
 off(key,releaseVelocity=0){const record=this.records.get(key);if(!record)return;this.records.delete(key);const at=this.now();if(record.pending)this.enqueue(processMidiNotes({pitch:record.pitch,velocity:record.velocity,start:record.start,duration:at-record.start,releaseVelocity},this.before,this.bpm),record);else{const open=new Set(record.open),cancelled=new Set(this.state.queue.filter(e=>e.type==='on'&&e.at>at+1e-9&&open.has(e.id)).map(e=>e.id));this.state.queue=this.state.queue.filter(e=>!cancelled.has(e.id));this.state.enqueue(record.open.filter(id=>!cancelled.has(id)).map(id=>({type:'off',id,at})));}this.wake();}
 key(note){return this.id+note.start.toFixed(9)+':'+note.pitch;}
 schedule(note){const key=this.key(note);this.owner.spawn(key,processMidiNotes(note,this.after,this.bpm),this.trackId,this.origin,this.bpm);this.scheduled.set(key,{note,signature:JSON.stringify(note)});}
 pump(){if(this.closed)return;const now=this.now(),horizon=now+.08*this.bpm/60;
  this.state.advance(now,n=>{if(!this.scheduled.has(this.key(n))&&n.start>=now-.025*this.bpm/60)this.schedule(n);});
  const future=new Map(),preview=this.state.clone();preview.advance(horizon,n=>future.set(this.key(n),n));
  for(const [key,entry]of this.scheduled){if(entry.note.start<now-1e-9){this.scheduled.delete(key);continue;}const next=future.get(key);if(!next||JSON.stringify(next)!==entry.signature){this.owner.cancelGroup(key);this.scheduled.delete(key);}}
  for(const [key,note]of future)if(!this.scheduled.has(key))this.schedule(note);
  if(this.state.next===null&&this.state.nextRestart===null&&!this.state.queue.length&&!future.size){clearInterval(this.timer);this.timer=null;}
 }
 wake(){this.pump();if(!this.timer&&(this.state.next!==null||this.state.nextRestart!==null||this.state.queue.length))this.timer=setInterval(()=>{try{this.pump();}catch(error){this.owner.error=error.message;this.dispose();this.owner.onError?.("Arpeggiator stopped: "+error.message);}},20);}
 dispose(){this.closed=true;clearInterval(this.timer);this.timer=null;this.records.clear();this.scheduled.clear();this.state.held.clear();this.state.down.clear();this.state.queue=[];for(const key of [...this.owner.voices.keys()])if(key.startsWith(this.id))this.owner.cancelGroup(key);}
}
