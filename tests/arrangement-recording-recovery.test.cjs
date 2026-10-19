const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){const {Engine}=await import('../web-studio/audio.js'),{emptyProject}=await import('../web-studio/model.js');const p=emptyProject();p.clips.a={id:'a',kind:'midi',name:'Saved Phrase',sourceBpm:120,beats:4,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};p.tracks[0].slots[0]='a';p.arrangement=[{id:'saved',trackId:p.tracks[0].id,clipId:'a',start:8,length:4,offset:0}];const e=new Engine(p,()=>{});return {e,p};}
test('failed audio preparation leaves the complete previous Arrangement intact',async()=>{const {e,p}=await setup(),before=structuredClone(p);e.prepare=async()=>{throw new Error('Audio output unavailable');};await assert.rejects(()=>e.startRecording(),/Audio output unavailable/);assert.deepEqual(p,before);assert.equal(e.recording,false);assert.equal(e.playing,false);assert.equal(e.records.size,0);});
function clock(e){e.context={currentTime:10};e.prepare=async()=>{};e.resetMixers=()=>{};e.updateMix=()=>{};e.tick=()=>{};}
test('Stop while recording prepares cancels without clearing or committing the saved Arrangement',async()=>{
 const {e,p}=await setup(),before=structuredClone(p);let release;const ready=new Promise(r=>release=r);e.prepare=()=>ready;const start=e.startRecording();assert.deepEqual(p,before);assert.equal(e.recording,false);e.stop();release();await start;assert.deepEqual(p,before);assert.equal(e.playing,false);assert.equal(e.recording,false);assert.equal(e.records.size,0);assert.equal(e.startPromise,null);assert.equal(e.recordingStartPromise,null);
});
test('scheduler failure after installing a take restores all source data and does not poison Undo',async()=>{
 const {e,p}=await setup(),before=structuredClone(p),{History}=await import('../web-studio/history.js'),history=new History(p);clock(e);e.active.set(p.tracks[0].id,{clipId:'a',slot:0,start:0});e.changed=()=>{if(!e.recording)history.commit(p);};e.tick=()=>{throw new Error('Scheduler unavailable');};
 await assert.rejects(()=>e.startRecording(),/Scheduler unavailable/);assert.deepEqual(p,before);assert.equal(history.undo(),null);assert.equal(e.recording,false);assert.equal(e.playing,false);assert.equal(e.records.size,0);
});
test('successful capture replaces only Arrangement, has one Undo, and permits another take after finish',async()=>{
 const {e,p}=await setup(),before=structuredClone(p),{History}=await import('../web-studio/history.js'),history=new History(p);clock(e);e.active.set(p.tracks[0].id,{clipId:'a',slot:0,start:0});e.changed=()=>{if(!e.recording)history.commit(p);};
 await e.startRecording();assert.equal(e.recording,true);assert.equal(e.playing,true);assert.equal(p.arrangement.length,1);e.context.currentTime=12.08;e.stop();assert.equal(p.arrangement[0].start,0);assert.ok(Math.abs(p.arrangement[0].length-4)<1e-9);assert.equal(p.arrangement[0].clipId,'a');const expected={...before,arrangement:p.arrangement};assert.deepEqual(p,expected);assert.deepEqual(history.undo(),before);
 await e.startRecording();assert.equal(e.recording,true);e.context.currentTime+=1;await e.startRecording();assert.equal(e.recording,false);assert.equal(e.playing,true);e.stop();
});
test('a pending start cannot overwrite a changed project or start twice',async()=>{
 const {e,p}=await setup();let release;const ready=new Promise(r=>release=r);let prepares=0;e.prepare=()=>{prepares++;return ready;};const first=e.startRecording(),again=e.startRecording();p.name='Edited While Preparing';const changed=structuredClone(p);release();await assert.rejects(()=>first,/project changed/);await assert.rejects(()=>again,/project changed/);assert.equal(prepares,1);assert.deepEqual(p,changed);assert.equal(e.recording,false);assert.equal(e.records.size,0);
});
test('recording cannot reuse an unrelated pending playback start',async()=>{
 const {e,p}=await setup(),before=structuredClone(p);e.startPromise=new Promise(()=>{});await assert.rejects(()=>e.startRecording(),/playback preparation/);assert.deepEqual(p,before);assert.equal(e.recording,false);
});
