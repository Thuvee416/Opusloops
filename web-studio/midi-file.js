import {isNoteActive} from './note-state.js';
import parseMidi from './vendor/midi-parser.js';
import writeMidi from './vendor/midi-writer.js';
import {uid,makeTrack,emptyProject,validateProject} from './model.js';
const text=s=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(s,c=>c.charCodeAt(0)));}catch{return s;}};
export function inspectMidi(bytes){
  if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);if(bytes.length>2*1024*1024)throw new Error('Choose a MIDI file smaller than 2 MB.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let cursor=0,chunks=0;while(cursor<bytes.length){if(cursor+8>bytes.length)throw new Error('Invalid MIDI file: truncated chunk.');const length=view.getUint32(cursor+4);cursor+=8+length;if(cursor>bytes.length)throw new Error('Invalid MIDI file: truncated chunk.');chunks++;}if(chunks<2)throw new Error('Invalid MIDI file: missing header or track.');
  let data;try{data=parseMidi(bytes);}catch(e){throw new Error(`Invalid MIDI file: ${e.message||e}`);}
  const h=data.header;if(![0,1].includes(h.format))throw new Error('Only Standard MIDI File formats 0 and 1 are supported.');if(!h.ticksPerBeat)throw new Error('SMPTE-timed MIDI is not supported; use a PPQN MIDI file.');if(chunks!==h.numTracks+1)throw new Error('Invalid MIDI file: extra or missing track chunks.');if(h.numTracks!==data.tracks.length||h.numTracks<1||(h.format===0&&h.numTracks!==1))throw new Error('MIDI track count does not match the header.');
  const warnings=new Map(),groups=[],tempos=[];let total=0;
  const warn=(name,count=1)=>warnings.set(name,(warnings.get(name)||0)+count);
  data.tracks.forEach((events,trackIndex)=>{
    let ticks=0,name=`MIDI ${trackIndex+1}`,ended=false;const channels=new Map(),held=new Map();
    const group=ch=>{if(!channels.has(ch))channels.set(ch,{channel:ch,notes:[]});return channels.get(ch);};
    for(const e of events){if(ended)throw new Error('MIDI data follows an end-of-track event.');if(!Number.isInteger(e.deltaTime)||e.deltaTime<0)throw new Error('Invalid MIDI event timing.');ticks+=e.deltaTime;if(ticks/h.ticksPerBeat>256)throw new Error('This MIDI file exceeds the current 256-beat clip limit.');
      if(e.type==='trackName')name=text(e.text).slice(0,150)||name;
      else if(e.type==='setTempo'){if(e.microsecondsPerBeat<=0)throw new Error('Invalid MIDI tempo.');tempos.push({beat:ticks/h.ticksPerBeat,bpm:60000000/e.microsecondsPerBeat});}
      else if(e.type==='endOfTrack')ended=true;
      else if(e.type==='noteOn'||e.type==='noteOff'){
        if(!Number.isInteger(e.noteNumber)||e.noteNumber<0||e.noteNumber>127||!Number.isInteger(e.velocity)||e.velocity<0||e.velocity>127)throw new Error('Invalid MIDI note data.');const key=`${e.channel}:${e.noteNumber}`;
        if(e.type==='noteOn'&&e.velocity){if(++total>65536)throw new Error('This MIDI file contains too many notes.');const q=held.get(key)||[];q.push({pitch:e.noteNumber,start:ticks/h.ticksPerBeat,velocity:e.velocity/127});held.set(key,q);}
        else{const q=held.get(key),note=q?.shift();if(note){const duration=ticks/h.ticksPerBeat-note.start;if(duration>0)group(e.channel).notes.push({...note,duration,...(e.velocity>0?{releaseVelocity:e.velocity/127}:{})});else warn('zero-length notes omitted');}else warn('unmatched note-off events omitted');}
      }else if(e.type==='timeSignature'){if(e.numerator!==4||e.denominator!==4)warn('non-4/4 meter events not applied');}
      else if(!['text','copyrightNotice','instrumentName','lyrics','marker','cuePoint','keySignature','sequenceNumber','channelPrefix','portPrefix'].includes(e.type))warn(`${e.type} events not applied`);
    }
    if(!ended)throw new Error('MIDI track is missing its end-of-track event.');
    for(const [key,notes] of held)for(const n of notes){const duration=ticks/h.ticksPerBeat-n.start;if(duration>0){group(Number(key.split(':')[0])).notes.push({...n,duration});warn('held notes closed at track end');}else warn('zero-length notes omitted');}
    for(const g of channels.values()){if(g.notes.length>4096)throw new Error('One MIDI track/channel exceeds the 4096-note clip limit.');g.notes.sort((a,b)=>a.start-b.start||a.pitch-b.pitch);g.name=`${name} · ch ${g.channel+1}`;g.beats=Math.max(.25,Math.ceil(ticks/h.ticksPerBeat*4)/4);if(g.channel===9)warn('channel-10 percussion played by the basic synth');groups.push(g);}
  });
  if(!groups.length)throw new Error('This MIDI file contains no playable notes.');if(groups.length>16)throw new Error('This file needs more than the current 16-track limit.');tempos.sort((a,b)=>a.beat-b.beat);if(tempos.length>1||tempos.some(t=>t.beat>0))warn('tempo-map events not applied',tempos.length);
  return {groups,tempo:tempos.find(t=>t.beat===0)?.bpm??120,format:h.format,ticksPerBeat:h.ticksPerBeat,warnings:[...warnings].map(([name,count])=>`${count} ${name}`)};
}
export function importMidiProject(project,inspection,{replace=false,useTempo=false,name='MIDI import'}={}){
  const p=replace?emptyProject():structuredClone(project);if(replace){p.tracks=[];p.name=name.slice(0,120);}
  if(p.tracks.length+inspection.groups.length>16)throw new Error('Not enough track slots. Import as a new project or remove tracks first.');
  if(useTempo){if(inspection.tempo<40||inspection.tempo>240)throw new Error('The file tempo is outside the supported 40–240 BPM range.');p.bpm=inspection.tempo;}
  for(const g of inspection.groups){const t=makeTrack(g.name.slice(0,40),p.tracks.length),clip={id:uid(),name:g.name.slice(0,200),kind:'midi',sourceBpm:p.bpm,beats:g.beats,notes:structuredClone(g.notes),midiChannel:g.channel};t.slots=Array(p.scenes).fill(null);t.slots[0]=clip.id;p.clips[clip.id]=clip;p.tracks.push(t);}
  validateProject(p);return p;
}
export function exportMidiClip(clip,bpm=120){
  if(clip.kind!=='midi')throw new Error('Select a MIDI clip to export.');const ppqn=960,channel=clip.midiChannel??0,events=[],end=Math.round(clip.beats*ppqn);
  for(const n of clip.notes){if(!isNoteActive(n)||n.velocity<=0||n.start>=clip.beats)continue;const start=Math.round(n.start*ppqn),stop=Math.min(end,Math.max(start+1,Math.round((n.start+n.duration)*ppqn)));if(stop<=start)continue;events.push({tick:start,type:'noteOn',channel,noteNumber:n.pitch,velocity:Math.max(1,Math.round(n.velocity*127))},{tick:stop,type:'noteOff',channel,noteNumber:n.pitch,velocity:Math.round((n.releaseVelocity??0)*127)});}
  events.sort((a,b)=>a.tick-b.tick||(Number(a.type==='noteOn')-Number(b.type==='noteOn')));let previous=0;const timed=events.map(({tick,...e})=>{const deltaTime=tick-previous;previous=tick;return {...e,deltaTime};});
  const track=[{deltaTime:0,meta:true,type:'trackName',text:String.fromCharCode(...new TextEncoder().encode(clip.name))},{deltaTime:0,meta:true,type:'setTempo',microsecondsPerBeat:Math.round(60000000/bpm)},{deltaTime:0,meta:true,type:'timeSignature',numerator:4,denominator:4,metronome:24,thirtyseconds:8},...timed,{deltaTime:Math.max(0,end-previous),meta:true,type:'endOfTrack'}];
  return new Uint8Array(writeMidi({header:{format:0,ticksPerBeat:ppqn},tracks:[track]}));
}
