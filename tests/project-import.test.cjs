const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return {...await import('../web-studio/project-import.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js')};}
const ab=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
async function fullSlots(){const t=await api(),p=t.emptyProject();p.clips.old={id:'old',name:'Keep',kind:'midi',sourceBpm:120,beats:4,notes:[{pitch:60,start:0,duration:1,velocity:.6}]};p.tracks[0].slots.fill('old');return {t,p};}
test('invalid audio with no free slots cannot leave an empty track or an Undo entry',async()=>{
 const {t,p}=await fullSlots(),before=structuredClone(p),h=new t.History(p);
 for(const duration of [.001,0,NaN,301])assert.throws(()=>t.prepareAudioImport(p,{name:'Bad',bytes:new ArrayBuffer(2),duration}));
 assert.deepEqual(p,before);assert.equal(h.past.length,0);
});
test('new-track audio import is one complete Undo group and preserves all existing music',async()=>{
 const {t,p}=await fullSlots(),{coreSongMedia}=await import('./fixtures/core-song-media.mjs'),media=coreSongMedia(),h=new t.History(p),before=structuredClone(p),result=t.prepareAudioImport(p,{name:'Drums',bytes:ab(media.drums),duration:8});
 assert.deepEqual(p,before);assert.equal(result.next.tracks.length,2);assert.deepEqual(result.next.tracks[0],p.tracks[0]);assert.deepEqual(result.next.clips.old,p.clips.old);assert.equal(result.clip.beats,16);assert.equal(result.clip.sourceBpm,120);assert.deepEqual(Buffer.from(result.clip.data,'base64'),media.drums);
 h.commit(result.next);assert.equal(h.past.length,1);assert.deepEqual(h.undo(),before);assert.deepEqual(h.redo(),result.next);
});
test('exact import destination rejects missing tracks, invalid scenes, occupied slots and capacity before commit',async()=>{
 const {t,p}=await fullSlots(),source={name:'Audio',bytes:new ArrayBuffer(8),duration:2},before=structuredClone(p);
 for(const target of [{trackId:'missing'},{trackId:p.tracks[0].id,scene:4},{scene:0},{trackId:p.tracks[0].id,scene:0}])assert.throws(()=>t.prepareAudioImport(p,source,target));
 const replaced=t.prepareAudioImport(p,source,{trackId:p.tracks[0].id,scene:0,replace:true});assert.equal(replaced.next.tracks[0].slots[1],'old');assert.deepEqual(replaced.next.clips.old,p.clips.old);assert.deepEqual(p,before);
 while(p.tracks.length<16){const track=t.makeTrack('Full',p.tracks.length);track.slots.fill('old');p.tracks.push(track);}assert.throws(()=>t.prepareAudioImport(p,source),/Not enough track slots/);assert.equal(p.tracks.length,16);
});
test('decode/read failures, oversized files and cancellation produce no candidate',async()=>{
 const t=await api();let reads=0,decodes=0;const file={name:'Drums.wav',size:8,arrayBuffer:async()=>{reads++;return new ArrayBuffer(8);}};
 assert.equal(await t.readAudioImport(null,()=>assert.fail()),null);
 await assert.rejects(()=>t.readAudioImport({...file,size:31*1024*1024},()=>assert.fail()),/30 MB/);assert.equal(reads,0);
 await assert.rejects(()=>t.readAudioImport(file,async()=>{decodes++;throw Error('Unreadable audio');}),/Unreadable/);assert.equal(decodes,1);
 const controller=new AbortController();await assert.rejects(()=>t.readAudioImport(file,async()=>{controller.abort();return {duration:2};},{signal:controller.signal}),e=>e.name==='AbortError');
 const source=await t.readAudioImport(file,async()=>({duration:2}));assert.equal(source.name,'Drums');assert.equal(source.duration,2);
});
test('same-byte history changes invalidate delayed imports, not just different project data',async()=>{
 const t=await api(),p=t.emptyProject(),bound=t.importBinding(p,4);t.assertImportCurrent(bound,p,4);assert.throws(()=>t.assertImportCurrent(bound,p,6),/project changed/);assert.throws(()=>t.assertImportCurrent(bound,{...p,name:'Changed'},4),/project changed/);
});
test('MIDI preparation preserves the project and exact imported notes; append/replace and tempo are explicit',async()=>{
 const {t,p}=await fullSlots(),{coreSongMedia}=await import('./fixtures/core-song-media.mjs'),media=coreSongMedia(),before=structuredClone(p);p.bpm=128;
 const source=await t.readMidiImport({name:'Bass.mid',size:media.bass.length,arrayBuffer:async()=>ab(media.bass)}),prepared=t.prepareMidiImport(p,source);
 assert.equal(prepared.next.bpm,128);assert.equal(prepared.next.tracks.length,2);assert.deepEqual(prepared.next.clips.old,p.clips.old);assert.equal(prepared.selection.scene,0);const notes=prepared.next.clips[prepared.selection.clipId].notes;assert.deepEqual(notes.map(n=>n.pitch),media.source.bass.notes.map(n=>n.pitch));assert.equal(notes.length,16);assert.equal(p.tracks.length,1);
 const replaced=t.prepareMidiImport(p,source,{replace:true,useTempo:true});assert.equal(replaced.next.bpm,120);assert.equal(replaced.next.name,'Bass');assert.equal(replaced.next.clips.old,undefined);assert.deepEqual(p.clips,before.clips);
 await assert.rejects(()=>t.readMidiImport({size:3*1024*1024,arrayBuffer:()=>assert.fail()}),/2 MB/);
});
test('New Set clones the default while explicit Empty ignores it without changing the saved preset',async()=>{
 const {t,p}=await fullSlots(),before=structuredClone(p),fromDefault=t.newProjectCandidate(p,{name:'A New Song'});assert.equal(fromDefault.name,'A New Song');assert.deepEqual(fromDefault.clips,p.clips);fromDefault.clips.old.notes[0].pitch=72;assert.deepEqual(p,before);
 const empty=t.newProjectCandidate(p,{empty:true,name:'Empty Song'});assert.equal(Object.keys(empty.clips).length,0);assert.equal(empty.tracks.length,1);assert.throws(()=>t.newProjectCandidate(p,{name:''}));
});
