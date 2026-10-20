import {LiveNotes} from './input.js';
import {isNoteActive} from './note-state.js';
// Preview owns only its voices. It never arms input, records notes or changes a set.
export class NotePreview {
 constructor({Notes=LiveNotes,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){this.Notes=Notes;this.setTimer=setTimer;this.clearTimer=clearTimer;this.epoch=0;this.timers=[];this.player=null;this.current=null;}
 cancel(){this.epoch++;for(const timer of this.timers)this.clearTimer(timer);this.timers=[];this.player?.allOff();this.player=null;this.current=null;}
 check(){if(this.current&&!this.current())this.cancel();}
 async play(engine,trackId,notes,current){
  this.cancel();const epoch=this.epoch,chosen=notes.filter(n=>isNoteActive(n)&&n.velocity>0).slice(0,16).map(n=>({...n}));if(!chosen.length||!current())return false;
  this.current=current;
  try{await engine.prepareSamples();}catch(error){if(epoch!==this.epoch||!current())return false;this.cancel();throw error;}
  if(epoch!==this.epoch||!current()){if(epoch===this.epoch)this.cancel();return false;}
  const player=new this.Notes(engine);this.player=player;
  try{chosen.forEach((n,i)=>player.on('note-preview:'+i,n.pitch,n.velocity,trackId));
  this.timers.push(this.setTimer(()=>{if(epoch===this.epoch)chosen.forEach((n,i)=>player.off('note-preview:'+i,n.releaseVelocity??0));},250));
  // Also stop one-shot samples, long releases and MIDI-effect voices.
  this.timers.push(this.setTimer(()=>{if(epoch===this.epoch)this.cancel();},1250));
  return true;
  }catch(error){this.cancel();throw error;}
 }
}
