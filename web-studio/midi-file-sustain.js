// SMF format 1 tracks share channel controllers. Resolve pedal events on the
// merged tick timeline, retaining original track/event order for simultaneous data.
export function midiFileSustain(data){
 const channels=new Map(),ppqn=data.header.ticksPerBeat;let end=0;
 data.tracks.forEach((events,track)=>{
  let tick=0;events.forEach((event,index)=>{
   if(!Number.isSafeInteger(event.deltaTime)||event.deltaTime<0)throw Error('Invalid MIDI event timing.');
   tick+=event.deltaTime;if(tick/ppqn>256)throw Error('This MIDI file exceeds the current 256-beat clip limit.');
   if(event.type!=='controller'||event.controllerType!==64)return;
   if(!Number.isInteger(event.channel)||event.channel<0||event.channel>15||!Number.isInteger(event.value)||event.value<0||event.value>127)throw Error('Invalid MIDI sustain pedal data.');
   const list=channels.get(event.channel)??[];list.push({tick,track,index,down:event.value>=64});channels.set(event.channel,list);
  });end=Math.max(end,tick);
 });
 for(const list of channels.values()){
  list.sort((a,b)=>a.tick-b.tick||a.track-b.track||a.index-b.index);let up=null;
  for(let i=list.length-1;i>=0;i--){if(!list[i].down)up=list[i].tick;else list[i].release=up;}
 }
 return (channel,tick,track,index)=>{
  const list=channels.get(channel)??[];let lo=0,hi=list.length;
  while(lo<hi){const mid=(lo+hi)>>1,event=list[mid],before=event.tick<tick||event.tick===tick&&(event.track<track||event.track===track&&event.index<=index);if(before)lo=mid+1;else hi=mid;}
  const pedal=list[lo-1];if(!pedal?.down)return {tick,open:false};
  return {tick:Math.max(tick,pedal.release??end),open:pedal.release===null};
 };
}
