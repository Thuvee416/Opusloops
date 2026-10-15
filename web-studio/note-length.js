// Independent timing/decay rules; source notes are never changed.
export function lengthNote(note,device,bpm){
 let duration=(device.mode==='sync'?device.beats:device.milliseconds/1000*bpm/60)*device.gate/100;
 if(duration<=0)return [];
 const {releaseVelocity,...generated}=note;
 if(device.trigger!=='off')return [{...generated,duration}];
 if(!Number.isFinite(note.duration)||note.duration<0)return [];
 const mix=(device.releaseBlend??0)/100,decay=device.decayMs??0,heldSeconds=note.duration*60/bpm;
 const velocity=(note.velocity*(1-mix)+(releaseVelocity??0)*mix)*(decay>0?Math.max(0,1-heldSeconds/(decay/1000)):1);
 duration=Math.min(120*bpm/60,duration*2**(-(note.pitch-60)/12*(device.keyScale??0)/100));
 return velocity>0?[{...generated,velocity,start:(note.start??0)+note.duration,duration}]:[];
}
