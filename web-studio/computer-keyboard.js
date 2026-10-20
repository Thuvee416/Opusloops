export const COMPUTER_NOTE_KEYS=['KeyA','KeyW','KeyS','KeyE','KeyD','KeyF','KeyT','KeyG','KeyY','KeyH','KeyU','KeyJ','KeyK'];
const controls={KeyZ:'octave-down',KeyX:'octave-up',KeyC:'velocity-down',KeyV:'velocity-up'};
const velocities=[20,40,60,80,100,127];
export function computerKeyAction(event,{enabled,typing=false,dialog=false,menu=false,agent=false}={}){
 if(!enabled||typing||dialog||menu||agent||event.repeat||event.defaultPrevented||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return null;
 if(controls[event.code])return {control:controls[event.code]};
 const index=COMPUTER_NOTE_KEYS.indexOf(event.code);
 return index<0?null:{note:index};
}
// Performance preferences belong to this tab, never to project or Undo state.
export class ComputerKeyboard {
 constructor(){this.octaves=0;this.velocity=.75;}
 base(drums=false){return Math.max(0,Math.min(108,(drums?36:60)+12*this.octaves));}
 adjust(action,drums=false){
  if(action==='octave-down'||action==='octave-up'){
   const base=Math.max(0,Math.min(108,this.base(drums)+(action==='octave-up'?12:-12)));
   this.octaves=(base-(drums?36:60))/12;
  }else if(action==='velocity-down'||action==='velocity-up'){
   const value=this.velocity*127;
   this.velocity=(action==='velocity-up'?(velocities.find(v=>v>value)??127):([...velocities].reverse().find(v=>v<value)??20))/127;
  }
  return this.state(drums);
 }
 state(drums=false){const base=this.base(drums);return {lowestNote:base,highestNote:base+12,velocity:this.velocity};}
 describe(drums=false){const base=this.base(drums);return `C${base/12-1}–C${base/12} · Velocity ${Math.round(this.velocity*127)}`;}
}
