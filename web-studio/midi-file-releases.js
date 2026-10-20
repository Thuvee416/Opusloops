// Resolve key releases before sustain conversion. Channel-mode commands can
// appear in a different SMF track; matching ordinary note-offs stays track-local.
export function midiFileReleases(data){
 const timeline=[],releases=new Map(),matched=new Set();let total=0;
 data.tracks.forEach((events,track)=>{
  let tick=0;events.forEach((event,index)=>{
   if(!Number.isSafeInteger(event.deltaTime)||event.deltaTime<0)throw Error('Invalid MIDI event timing.');
   tick+=event.deltaTime;if(tick/data.header.ticksPerBeat>256)throw Error('This MIDI file exceeds the current 256-beat clip limit.');
   const note=event.type==='noteOn'||event.type==='noteOff',allOff=event.type==='controller'&&event.controllerType===123;
   if(note){if(!Number.isInteger(event.channel)||event.channel<0||event.channel>15||!Number.isInteger(event.noteNumber)||event.noteNumber<0||event.noteNumber>127||!Number.isInteger(event.velocity)||event.velocity<0||event.velocity>127)throw Error('Invalid MIDI note data.');if(event.type==='noteOn'&&event.velocity&&++total>65536)throw Error('This MIDI file contains too many notes.');}
   if(allOff&&(!Number.isInteger(event.channel)||event.channel<0||event.channel>15||!Number.isInteger(event.value)||event.value<0||event.value>127))throw Error('Invalid MIDI All Notes Off data.');
   if(note||allOff||event.type==='endOfTrack')timeline.push({tick,track,index,event});
  });
 });
 timeline.sort((a,b)=>a.tick-b.tick||a.track-b.track||a.index-b.index);
 const queues=new Map(),byChannel=new Map(),byTrack=new Map();
 const set=(map,key)=>{if(!map.has(key))map.set(key,new Set());return map.get(key);};
 const close=(held,at,reason,velocity=0)=>{
  releases.set(held.id,{tick:at.tick,track:at.track,index:at.index,reason,velocity});held.closed=true;
  byChannel.get(held.channel).delete(held);byTrack.get(held.track).delete(held);
 };
 for(const at of timeline){const {event:e,track,index}=at,id=track+':'+index;
  if(e.type==='endOfTrack'){for(const held of byTrack.get(track)??[])close(held,at,'track-end');continue;}
  if(e.type==='controller'){for(const held of byChannel.get(e.channel)??[])close(held,at,'all-notes-off');continue;}
  const key=track+':'+e.channel+':'+e.noteNumber;
  if(e.type==='noteOn'&&e.velocity){const held={id,track,channel:e.channel,closed:false},queue=queues.get(key)??{items:[],cursor:0};queue.items.push(held);queues.set(key,queue);set(byChannel,e.channel).add(held);set(byTrack,track).add(held);}
  else{const queue=queues.get(key);if(!queue)continue;while(queue.cursor<queue.items.length&&queue.items[queue.cursor].closed)queue.cursor++;const held=queue.items[queue.cursor];if(held){queue.cursor++;close(held,at,'note-off',e.velocity);matched.add(id);}}
 }
 return {release:(track,index)=>releases.get(track+':'+index),matched:(track,index)=>matched.has(track+':'+index)};
}
