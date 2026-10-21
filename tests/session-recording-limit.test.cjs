const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){
 const [{Engine},{emptyProject,makeTrack,validateProject},{History},{SESSION_RECORDING_MAX_BEATS}]=await Promise.all([import('../web-studio/audio.js'),import('../web-studio/model.js'),import('../web-studio/history.js'),import('../web-studio/session-recording.js')]);
 const p=emptyProject();p.tracks.push(makeTrack('Second'));p.sceneNames=['Intro','Lift','Breakdown','Return'];
 p.clips.c={id:'c',name:'Loop',kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};for(const t of p.tracks)t.slots[0]='c';p.tracks[1].inactiveSlots=[0];
 p.arrangement=[{id:'previous',trackId:p.tracks[0].id,clipId:'c',start:8,length:4,offset:0}];
 const before=structuredClone(p),history=new History(p),e=new Engine(p,()=>{if(!e.recording)history.commit(p);});e.context={currentTime:10};e.prepare=async()=>{};e.resetMixers=()=>{};e.updateMix=()=>{};e.tick=()=>{};for(const t of p.tracks)e.active.set(t.id,{clipId:'c',slot:0,start:0});
 await e.startRecording();return {p,e,before,history,validateProject,Engine,end:SESSION_RECORDING_MAX_BEATS};
}
test('long Session takes remain valid through Record-off, Stop and Pause even after a delayed clock callback',async()=>{
 for(const method of ['record-off','stop','pause']){const t=await setup();try{t.e.context.currentTime=t.e.origin+(t.end+5)*.5;if(method==='record-off')await t.e.startRecording();else t.e[method]();assert.equal(t.e.recording,false);assert.equal(t.e.records.size,0);assert.equal(t.p.arrangement.length,2);for(const r of t.p.arrangement)assert.equal(r.start+r.length,t.end);t.validateProject(t.p);assert.deepEqual({...t.p,arrangement:t.before.arrangement},t.before);assert.deepEqual(t.history.undo(),t.before);}finally{t.e.stop();}}
});
test('the audible boundary finalizes once, preserves inactive slots and allows Session playback to continue',async()=>{
 const t=await setup();try{
  t.e.context.currentTime=t.e.origin+(t.end-.01)*.5;t.e.advanceSessionRecording();assert.equal(t.e.recording,true);assert.equal(t.history.past.length,0);
  t.e.context.currentTime=t.e.origin+(t.end+.2)*.5;t.e.nextBeat=t.end+1;t.Engine.prototype.tick.call(t.e);
  assert.equal(t.e.playing,true);assert.equal(t.e.recording,false);assert.equal(t.e.recordingTake,null);assert.equal(t.e.records.size,0);assert.match(t.e.recordingError,/16,384/);assert.equal(t.p.arrangement[1].active,false);t.validateProject(t.p);assert.equal(t.history.past.length,1);
  const captured=structuredClone(t.p);t.e.advanceSessionRecording();t.e.stop();assert.deepEqual(t.p,captured);assert.equal(t.history.past.length,1);assert.deepEqual(t.history.undo(),t.before);assert.deepEqual(t.history.redo(),captured);
 }finally{t.e.stop();}
});
test('lookahead launches cannot create out-of-range regions or end the take early',async()=>{
 const t=await setup();try{
  const id=t.p.tracks[0].id;t.e.context.currentTime=t.e.origin+(t.end-.1)*.5;t.e.closeRecord(id,t.end+.125);t.e.activateClip(id,'c',t.end+.125,false,0);
  assert.equal(t.e.recording,true);assert.equal(t.p.arrangement.filter(r=>r.trackId===id).length,1);assert.equal(t.p.arrangement[0].length,t.end);assert.equal(t.e.active.get(id).activationBeat,t.end+.125);
  const result=t.e.finishSessionRecording({cancel:true});assert.equal(result.status,'cancelled');assert.deepEqual(t.p,t.before);assert.equal(t.history.past.length,0);
 }finally{t.e.stop();}
});
test('manual finish before a lookahead boundary trims to what was actually heard',async()=>{
 const t=await setup();try{
  const id=t.p.tracks[0].id;t.e.context.currentTime=t.e.origin+(t.end-.1)*.5;t.e.closeRecord(id,t.end+.125);t.e.openRecord(id,'c',t.end+.125);const result=t.e.finishSessionRecording();assert.equal(result.status,'saved');for(const r of t.p.arrangement)assert.ok(Math.abs(r.start+r.length-(t.end-.1))<1e-9);t.validateProject(t.p);assert.deepEqual(t.history.undo(),t.before);
 }finally{t.e.stop();}
});
test('a final short launch is dropped without losing earlier captured regions or source media',async()=>{
 const t=await setup();try{
  const id=t.p.tracks[0].id;t.e.closeRecord(id,t.end-.03);t.e.openRecord(id,'c',t.end-.03);t.e.context.currentTime=t.e.origin+(t.end+.1)*.5;t.e.advanceSessionRecording();assert.equal(t.p.arrangement.length,2);assert.equal(t.p.arrangement[0].length,t.end-.03);t.validateProject(t.p);assert.deepEqual(t.p.clips,t.before.clips);assert.deepEqual(t.history.undo(),t.before);
 }finally{t.e.stop();}
});
