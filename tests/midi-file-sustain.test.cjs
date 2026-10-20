const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return {...await import('../web-studio/midi-file.js'),...await import('../web-studio/project-import.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js'),write:(await import('../web-studio/vendor/midi-writer.js')).default,parse:(await import('../web-studio/vendor/midi-parser.js')).default};}
const on=(beat,pitch=60,channel=0)=>({beat,type:'noteOn',channel,noteNumber:pitch,velocity:100});
const off=(beat,pitch=60,channel=0,velocity=32)=>({beat,type:'noteOff',channel,noteNumber:pitch,velocity});
const pedal=(beat,value,channel=0)=>({beat,type:'controller',channel,controllerType:64,value});
const end=beat=>({beat,meta:true,type:'endOfTrack'});
function file(t,tracks){return new Uint8Array(t.write({header:{format:tracks.length===1?0:1,ticksPerBeat:480},tracks:tracks.map(events=>{let previous=0;return events.map(({beat,...event})=>{const tick=Math.round(beat*480),deltaTime=tick-previous;previous=tick;return {...event,deltaTime};});})}));}

test('MIDI pedal import preserves four-beat sustain with standard 63/64 switch boundaries and release velocity',async()=>{
 const t=await api();for(const value of [0,63,64,127]){
  const result=t.inspectMidi(file(t,[[pedal(0,value),on(0),off(1),pedal(4,63),end(4)]])),note=result.groups[0].notes[0];
  assert.equal(note.duration,value>=64?4:1);assert.equal(note.velocity,100/127);assert.equal(note.releaseVelocity,32/127);assert.equal(result.warnings.some(w=>w.includes('controller events not applied')),false);
  assert.equal(result.warnings.some(w=>w.includes('editable note lengths')),value>=64);
 }
});

test('sustained repeated strikes keep independent onsets and velocities instead of swallowing or prematurely ending notes',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127),on(0),off(1,60,0,20),on(1.5),off(2,60,0,45),pedal(4,0),end(4)]]));
 assert.deepEqual(result.groups[0].notes.map(n=>[n.start,n.duration,n.releaseVelocity]),[[0,4,20/127],[1.5,2.5,45/127]]);
});

test('pedal state is channel-scoped even when notes share a MIDI file track',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127,0),on(0,60,0),on(0,60,1),off(1,60,0),off(1,60,1),pedal(3,0,1),pedal(4,0,0),end(4)]]));
 assert.equal(result.groups.find(g=>g.channel===0).notes[0].duration,4);assert.equal(result.groups.find(g=>g.channel===1).notes[0].duration,1);
});

test('format-1 pedal events on another track extend notes beyond the note-track end and preserve clip length',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127),pedal(4,0),end(4)],[on(0),off(1),end(1)]]));
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].beats,4);assert.equal(result.groups[0].notes[0].duration,4);
 const project=t.importMidiProject(t.emptyProject(),result,{replace:true});t.validateProject(project);assert.equal(project.clips[project.tracks[0].slots[0]].beats,4);
});

test('the first pedal-up ends a held note; later pedal changes cannot lengthen it again',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127),on(0),off(1),pedal(2,100),pedal(3,0),pedal(4,127),pedal(5,0),end(6)]]));assert.equal(result.groups[0].notes[0].duration,3);
});

test('a missing pedal-up closes sustained notes at file end with an explicit import warning',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127),end(6)],[on(0),off(1),end(1)]]));assert.equal(result.groups[0].notes[0].duration,6);assert.equal(result.groups[0].beats,6);assert.ok(result.warnings.some(w=>w.includes('sustained notes closed at file end')));
});

test('simultaneous events preserve file order and zero-velocity Note On behaves as key release',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0),pedal(0,127),{...on(0),velocity:0},pedal(1,0),on(1,62),off(1,62),on(2,64),off(3,64),pedal(3,127),pedal(4,0),end(4)]]));
 assert.deepEqual(result.groups[0].notes.map(n=>[n.pitch,n.start,n.duration]),[[60,0,1],[64,2,1]]);assert.ok(result.warnings.some(w=>w.includes('zero-length notes omitted')));
});

test('shared native/Odesa MIDI preparation preserves the song, creates one Undo and exports the sustained duration',async()=>{
 const t=await api(),{midiDeliveryProject}=await import('./fixtures/midi-delivery-project.mjs'),project=midiDeliveryProject(),original=structuredClone(project),history=new t.History(project),bytes=file(t,[[pedal(0,127,2),on(0,67,2),off(1,67,2,45),pedal(4,0,2),end(4)]]);
 const source=await t.readMidiImport({name:'Pedal Performance.mid',size:bytes.length,arrayBuffer:async()=>bytes.buffer}),prepared=t.prepareMidiImport(project,source);assert.deepEqual(project,original);assert.equal(prepared.next.bpm,original.bpm);assert.deepEqual(prepared.next.arrangement,original.arrangement);assert.deepEqual(prepared.next.tracks.slice(0,original.tracks.length),original.tracks);for(const id of Object.keys(original.clips))assert.deepEqual(prepared.next.clips[id],original.clips[id]);
 history.commit(prepared.next);assert.deepEqual(history.undo(),original);assert.deepEqual(history.redo(),prepared.next);const reopened=t.validateProject(JSON.parse(JSON.stringify(prepared.next))),clip=reopened.clips[prepared.selection.clipId];assert.equal(clip.notes[0].duration,4);assert.ok(prepared.warnings.some(w=>w.includes('editable note lengths')));
 const exported=t.exportMidiClip(clip,reopened.bpm),events=t.parse(exported).tracks[0];let ticks=0;const observed=[];for(const event of events){ticks+=event.deltaTime;if(event.type==='noteOn'||event.type==='noteOff')observed.push([event.type,ticks,event.channel,event.noteNumber,event.velocity]);}
 assert.deepEqual(observed,[['noteOn',0,2,67,100],['noteOff',3840,2,67,45]]);assert.equal(events.some(e=>e.type==='controller'),false);
});

test('unsupported controllers remain reported and long or malformed imports retain existing rejection boundaries',async()=>{
 const t=await api(),bytes=file(t,[[{...pedal(0,80),controllerType:1},on(0),off(1),end(1)]]),result=t.inspectMidi(bytes);assert.equal(result.groups[0].notes[0].duration,1);assert.ok(result.warnings.some(w=>w.includes('controller events not applied')));
 assert.throws(()=>t.inspectMidi(file(t,[[pedal(0,127),on(0),off(1),pedal(257,0),end(257)]])),/256-beat/);
 const {midiFileSustain}=await import('../web-studio/midi-file-sustain.js');for(const value of [-1,128,NaN])assert.throws(()=>midiFileSustain({header:{ticksPerBeat:480},tracks:[[{deltaTime:0,type:'controller',controllerType:64,channel:0,value}]]}),/pedal data/);
});

const reset=(beat,channel=0,value=0)=>({beat,type:'controller',channel,controllerType:121,value});
test('Reset All Controllers ends pedal-held notes at the reset, while held keys wait for note-off',async()=>{
 const t=await api();for(const value of [0,127]){
  const result=t.inspectMidi(file(t,[[pedal(0,127),on(0),on(0,64),off(1),reset(2,0,value),off(3,64),end(6)]]));
  assert.deepEqual(result.groups[0].notes.map(n=>[n.pitch,n.start,n.duration,n.releaseVelocity]),[[60,0,2,32/127],[64,0,3,32/127]]);
  assert.equal(result.groups[0].beats,6);assert.ok(result.warnings.includes('1 controller resets applied to sustain only'));
  assert.equal(result.warnings.some(w=>w.includes('closed at file end')||w.includes('controller events not applied')),false);
 }
});
test('reset is channel-scoped across format-1 tracks and later pedal use remains independent',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[pedal(0,127),pedal(0,127,1),reset(2),pedal(3,127),pedal(5,0),end(6)],[on(0),on(0,67,1),off(1),off(1,67,1),on(3,64),off(4,64),end(6)]]));
 assert.deepEqual(result.groups.find(g=>g.channel===0).notes.map(n=>[n.pitch,n.start,n.duration]),[[60,0,2],[64,3,2]]);
 assert.equal(result.groups.find(g=>g.channel===1).notes[0].duration,6);
});
test('same-tick reset and pedal presses retain file ordering without truncating held notes',async()=>{
 const t=await api();
 for(const [controls,expected] of [[[reset(1),pedal(1,127)],4],[[pedal(1,127),reset(1)],1]]){
  const result=t.inspectMidi(file(t,[[on(0),...controls,off(1),end(4)]]));assert.equal(result.groups[0].notes[0].duration,expected);
 }
 // A pedal-up/reset followed by pedal-down at the same tick still releases
 // notes whose keys were already released before that tick.
 const result=t.inspectMidi(file(t,[[pedal(0,127),on(0),off(.5),reset(1),pedal(1,127),end(4)]]));assert.equal(result.groups[0].notes[0].duration,1);
});
test('manual and Odesa shared import preserve reset note endings through project history and MIDI delivery',async()=>{
 const t=await api(),{prepareMidiDelivery}=await import('../web-studio/midi-delivery.js'),project=t.emptyProject(),before=structuredClone(project),bytes=file(t,[[pedal(0,127),on(0),off(1),reset(2),end(6)]]);
 const source=await t.readMidiImport({name:'Reset Performance.mid',size:bytes.length,arrayBuffer:async()=>bytes.buffer}),prepared=t.prepareMidiImport(project,source),history=new t.History(project);assert.deepEqual(project,before);
 history.commit(prepared.next);assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),prepared.next);
 const reopened=t.validateProject(JSON.parse(JSON.stringify(prepared.next))),clip=reopened.clips[prepared.selection.clipId],result=prepareMidiDelivery(reopened,{clipId:clip.id});
 assert.equal(clip.notes[0].duration,2);assert.equal(t.inspectMidi(result.data).groups[0].notes[0].duration,2);
});
