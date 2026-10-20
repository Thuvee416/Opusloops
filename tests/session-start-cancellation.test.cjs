const {test}=require('node:test'),assert=require('node:assert/strict');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const [{Engine},{emptyProject,makeTrack}]=await Promise.all([import('../web-studio/audio.js'),import('../web-studio/model.js')]);
 const p=emptyProject();p.tracks=[makeTrack('A'),makeTrack('B')];
 for(const [i,track]of p.tracks.entries()){track.id=['a','b'][i];const id=track.id+'0';p.clips[id]={id,name:id,kind:'midi',beats:4,sourceBpm:120,notes:[]};track.slots[0]=id;}
 const e=new Engine(p,()=>{}),gates=[],heard=[];e.context={currentTime:0};e.prepare=()=>new Promise((resolve,reject)=>gates.push({resolve,reject}));e.resetMixers=()=>{};e.updateMix=()=>{};e.tick=()=>heard.push([...e.active.values()].filter(a=>a.clipId).map(a=>a.clipId));t.after(()=>e.stop());
 return {e,p,gates,heard,original:structuredClone(p)};
}
test('cancelling a clip or scene during playback preparation prevents late audio and retains project data',async t=>{
 for(const kind of ['clip','scene']){
  const f=await fixture(t),{e,gates}=f,c=new AbortController();
  const pending=kind==='clip'?e.launch('a','a0',0,{signal:c.signal}):e.scene(0,{signal:c.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  gates[0].resolve();await flush();assert.equal(gates.length,2);
  c.abort();gates[1].resolve();await rejected;
  assert.equal(e.playing,false);assert.equal(e.active.size,0);assert.equal(e.activeScene,null);
  assert.equal(e.overrides.size,0);assert.equal(e.follows.size,0);assert.equal(e.sceneFollow,null);
  assert.deepEqual(f.heard,[]);assert.deepEqual(f.p,f.original);
 }
});
test('cancelled launch cannot silence another track sharing playback startup',async t=>{
 const f=await fixture(t),{e,gates}=f,c=new AbortController();
 const old=e.launch('a','a0',0,{signal:c.signal}),rejected=assert.rejects(old,{name:'AbortError'});
 gates[0].resolve();await flush();
 const manual=e.launch('b','b0',0);gates[2].resolve();await flush();
 c.abort();gates[1].resolve();await rejected;await manual;
 assert.equal(e.playing,true);assert.equal(e.active.has('a'),false);assert.equal(e.active.get('b').clipId,'b0');
 assert.deepEqual(f.heard,[['b0']]);assert.deepEqual(f.p,f.original);
});
test('cancelled scene restores only its unchanged selections and preserves a newer manual clip',async t=>{
 const f=await fixture(t),{e,gates}=f,c=new AbortController();
 const old=e.scene(0,{signal:c.signal}),rejected=assert.rejects(old,{name:'AbortError'});
 gates[0].resolve();await flush();
 const manual=e.launch('b','b0',0);gates[2].resolve();await flush();
 c.abort();gates[1].resolve();await rejected;await manual;
 assert.equal(e.playing,true);assert.equal(e.active.has('a'),false);assert.equal(e.active.get('b').clipId,'b0');
 assert.equal(e.activeScene,null);assert.deepEqual(f.heard,[['b0']]);
});
test('all cancelled startup callers stop transport and release every interest',async t=>{
 const {e,gates,heard}=await fixture(t),a=new AbortController(),b=new AbortController();
 const one=e.launch('a','a0',0,{signal:a.signal}),oneRejected=assert.rejects(one,{name:'AbortError'});
 gates[0].resolve();await flush();
 const two=e.launch('b','b0',0,{signal:b.signal}),twoRejected=assert.rejects(two,{name:'AbortError'});
 gates[2].resolve();await flush();a.abort();b.abort();gates[1].resolve();
 await Promise.all([oneRejected,twoRejected]);
 assert.equal(e.playing,false);assert.equal(e.active.size,0);assert.equal(e.playInterests.size,0);assert.deepEqual(heard,[]);
});
test('cancellation restores an existing stopped selection and does not restart it',async t=>{
 const {e,gates,heard}=await fixture(t),c=new AbortController(),previous={clipId:'a0',slot:0,start:3};
 e.active.set('a',previous);e.overrides.add('a');
 const request=e.launch('a','a0',0,{signal:c.signal}),rejected=assert.rejects(request,{name:'AbortError'});
 gates[0].resolve();await flush();c.abort();gates[1].resolve();await rejected;
 assert.equal(e.active.get('a'),previous);assert.equal(e.overrides.has('a'),true);assert.equal(e.playing,false);assert.deepEqual(heard,[]);
});
test('a failed newer launch cannot restore an earlier cancelled unsounded selection',async t=>{
 const {e,gates}=await fixture(t),c=new AbortController();
 const old=e.launch('a','a0',0,{signal:c.signal}),oldRejected=assert.rejects(old,{name:'AbortError'});
 gates[0].resolve();await flush();
 const newer=e.launch('a','a0',0),newRejected=assert.rejects(newer,/Output Failed/);
 gates[2].resolve();await flush();c.abort();gates[1].reject(Error('Output Failed'));
 await Promise.all([oldRejected,newRejected]);assert.equal(e.playing,false);assert.equal(e.active.size,0);assert.equal(e.overrides.size,0);
});
test('failed replacement scene skips a cancelled scene when restoring selection and follow state',async t=>{
 const {e,gates}=await fixture(t),c=new AbortController();
 const old=e.scene(0,{signal:c.signal}),oldRejected=assert.rejects(old,{name:'AbortError'});
 gates[0].resolve();await flush();
 const newer=e.scene(0),newRejected=assert.rejects(newer,/Output Failed/);
 gates[2].resolve();await flush();c.abort();gates[1].reject(Error('Output Failed'));
 await Promise.all([oldRejected,newRejected]);assert.equal(e.active.size,0);assert.equal(e.activeScene,null);assert.equal(e.sceneFollow,null);assert.equal(e.playInterests.size,0);
});
test('a later explicit Play retains startup when the initiating launch is cancelled',async t=>{
 const {e,gates,heard}=await fixture(t),c=new AbortController();
 const launch=e.launch('a','a0',0,{signal:c.signal}),rejected=assert.rejects(launch,{name:'AbortError'});
 gates[0].resolve();await flush();const play=e.play();c.abort();gates[1].resolve();
 await rejected;await play;assert.equal(e.playing,true);assert.equal(e.active.size,0);assert.deepEqual(heard,[[]]);assert.equal(e.playInterests.size,0);
});
