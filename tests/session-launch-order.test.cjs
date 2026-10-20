const {test}=require('node:test'),assert=require('node:assert/strict');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture({playing=true}={}){
 const {Engine}=await import('../web-studio/audio.js'),{emptyProject,makeTrack}=await import('../web-studio/model.js');
 const project=emptyProject();project.tracks=[makeTrack('A'),makeTrack('B')];
 for(const [i,track]of project.tracks.entries()){track.id=['a','b'][i];for(let slot=0;slot<2;slot++){const id=track.id+slot;track.slots[slot]=id;project.clips[id]={id,name:id,kind:'midi',sourceBpm:project.bpm,beats:4,notes:[]};}}
 const engine=new Engine(project,()=>{}),gates=[];engine.context={currentTime:0};engine.origin=0;engine.clockStart=0;engine.playing=playing;engine.prepare=()=>new Promise((resolve,reject)=>gates.push({resolve,reject}));engine.play=async()=>{engine.playing=true;};engine.resetMixers=()=>{};
 return {engine,project,gates,original:structuredClone(project),Engine,makeTrack};
}
const selected=(e,id)=>e.pending.get(id)?.clipId??e.active.get(id)?.clipId;

test('latest clip choice wins both preparation orders, from stopped and running playback',async()=>{
 for(const playing of [false,true])for(const order of [[0,1],[1,0]]){
  const f=await fixture({playing}),e=f.engine,requests=[e.launch('a','a0',0),e.launch('a','a1',1)];
  for(const i of order){f.gates[i].resolve();await requests[i];}
  assert.equal((await requests[0]).interrupted,true);assert.equal(selected(e,'a'),'a1');assert.equal(e.launchLoads.size,0);assert.deepEqual(f.project,f.original);
 }
});

test('a newer choice immediately replaces unscheduled events but leaves sounding clips intact during loading',async()=>{
 const f=await fixture(),e=f.engine;e.active.set('a',{clipId:'a0',start:0,slot:0});e.pending.set('a',{clipId:'a0',beat:4});
 const pending=e.launch('a','a1',1);assert.equal(e.pending.has('a'),false);assert.equal(e.active.get('a').clipId,'a0');f.gates[0].resolve();await pending;assert.equal(e.pending.get('a').clipId,'a1');assert.equal(e.pending.get('a').beat,4);
});

test('independent track preparations both survive out-of-order completion',async()=>{
 const f=await fixture(),e=f.engine,a=e.launch('a','a0',0),b=e.launch('b','b1',1);f.gates[1].resolve();await b;f.gates[0].resolve();await a;assert.equal(selected(e,'a'),'a0');assert.equal(selected(e,'b'),'b1');
});

test('a later scene replaces older clip and scene requests, including the global scene boundary',async()=>{
 const f=await fixture(),e=f.engine,clip=e.launch('a','a0',0),old=e.scene(0),latest=e.scene(1);
 f.gates[2].resolve();await latest;const marker=e.pendingScene;f.gates[1].resolve();assert.equal((await old).interrupted,true);f.gates[0].resolve();assert.equal((await clip).interrupted,true);
 assert.equal(selected(e,'a'),'a1');assert.equal(selected(e,'b'),'b1');assert.equal(e.pendingScene,marker);assert.equal(marker.index,1);
});

test('a later individual launch overrides its scene member while unrelated scene tracks continue',async()=>{
 const f=await fixture(),e=f.engine,scene=e.scene(0),clip=e.launch('a','a1',1);f.gates[1].resolve();await clip;f.gates[0].resolve();const receipt=await scene;
 assert.equal(receipt.interrupted,true);assert.deepEqual(receipt.events.map(v=>v.trackId),['b']);assert.equal(selected(e,'a'),'a1');assert.equal(selected(e,'b'),'b0');
});

test('no-stop scene slots preserve a pending clip while the newer global scene keeps its identity',async()=>{
 const f=await fixture(),e=f.engine;f.project.tracks[0].slots[1]=null;f.project.tracks[0].noStopSlots=[1];
 const old=e.scene(0),latest=e.scene(1);f.gates[1].resolve();await latest;const marker=e.pendingScene;f.gates[0].resolve();const receipt=await old;
 assert.equal(receipt.interrupted,true);assert.equal(selected(e,'a'),'a0');assert.equal(selected(e,'b'),'b1');assert.equal(e.pendingScene,marker);assert.equal(marker.index,1);
});

test('group scene supersedes only group tracks and cannot restore an older global scene-follow owner',async()=>{
 const f=await fixture(),e=f.engine,g=f.makeTrack('Group');g.id='group';g.group=true;f.project.tracks[0].parentId=g.id;f.project.tracks.unshift(g);
 const old=e.scene(0),latest=e.scene(1,{groupId:g.id});f.gates[1].resolve();await latest;f.gates[0].resolve();assert.equal((await old).interrupted,true);
 assert.equal(selected(e,'a'),'a1');assert.equal(selected(e,'b'),'b0');assert.equal(e.pendingScene,null);assert.equal(e.sceneFollow,null);
});

test('double Toggle cancels an unprepared launch; a third press starts a fresh request',async()=>{
 const f=await fixture(),e=f.engine;f.project.clips.a0.launch={mode:'toggle',legato:false,quantization:'global'};
 const old=e.launch('a','a0',0);assert.equal((await e.launch('a','a0',0)).cancelled,true);assert.equal(f.gates.length,1);const latest=e.launch('a','a0',0);f.gates[0].resolve();assert.equal((await old).interrupted,true);assert.equal(e.launchLoads.size,1,'old cleanup cannot erase the fresh request');f.gates[1].resolve();await latest;assert.equal(selected(e,'a'),'a0');
});

test('Toggle preserves queued cancellation and active stop semantics without re-decoding',async()=>{
 const f=await fixture(),e=f.engine;f.project.clips.a0.launch={mode:'toggle',legato:false,quantization:.5};e.pending.set('a',{clipId:'a0',beat:4});
 assert.equal((await e.launch('a','a0',0)).cancelled,true);assert.equal(e.pending.size,0);assert.equal(f.gates.length,0);
 e.active.set('a',{clipId:'a0',start:0,slot:0});const stop=await e.launch('a','a0',0);assert.equal(stop.events[0].event.clipId,null);assert.equal(stop.events[0].event.beat,.5);assert.equal(f.gates.length,0);
 assert.equal((await e.launch('a','a0',0)).cancelled,true);assert.equal(e.pending.size,0);assert.equal(e.active.get('a').clipId,'a0');
});

test('Toggle during real playback startup cancels the selected clip before the scheduler can sound it',async t=>{
 const f=await fixture({playing:false}),e=f.engine;e.play=f.Engine.prototype.play;e.updateMix=()=>{};const heard=[];e.tick=()=>heard.push([...e.active.values()].filter(a=>a.clipId));t.after(()=>clearInterval(e.timer));f.project.clips.a0.launch={mode:'toggle',legato:false,quantization:'global'};
 const old=e.launch('a','a0',0);f.gates[0].resolve();await flush();assert.equal(f.gates.length,2);await e.launch('a','a0',0);f.gates[1].resolve();assert.equal((await old).interrupted,true);assert.ok(heard.every(a=>a.length===0));
});

test('Gate and Repeat presses supersede older trigger preparation and newer triggers supersede held preparation',async()=>{
 for(const mode of ['gate','repeat']){
  const f=await fixture(),e=f.engine;f.project.clips.a1.launch={mode,legato:false,quantization:'global'};
  const old=e.launch('a','a0',0),held=e.pressGate('a','a1',1);f.gates[1].resolve();await held.ready;f.gates[0].resolve();assert.equal((await old).interrupted,true);assert.equal(selected(e,'a'),'a1');
  const second=e.pressGate('a','a1',1),latest=e.launch('a','a0',0);f.gates[3].resolve();await latest;f.gates[2].resolve();await second.ready;assert.equal(selected(e,'a'),'a0');e.releaseGate(second);assert.equal(selected(e,'a'),'a0');
 }
});

test('a failed newer launch does not resurrect an older request or alter the project',async()=>{
 const f=await fixture(),e=f.engine,old=e.launch('a','a0',0),latest=e.launch('a','a1',1),failure=assert.rejects(latest,/Decode Failed/);f.gates[1].reject(Error('Decode Failed'));await failure;f.gates[0].resolve();assert.equal((await old).interrupted,true);assert.equal(e.pending.size,0);assert.equal(e.launchLoads.size,0);assert.deepEqual(f.project,f.original);
});

test('Back To Arrangement invalidates loading Session clips and scenes',async()=>{
 for(const playing of [false,true]){
  const f=await fixture({playing}),e=f.engine,clip=e.launch('a','a0',0),scene=e.scene(1);e.back();const pending=new Map(e.pending);for(const gate of f.gates)gate.resolve();assert.equal((await clip).interrupted,true);assert.equal((await scene).interrupted,true);assert.deepEqual(e.pending,pending);assert.equal(e.active.size,0);assert.equal(e.pendingScene,null);
 }
});

test('a superseded Odesa launch rejects without deleting the newer manual event',async()=>{
 const {performSessionCommand}=await import('../web-studio/agent-performance.js'),f=await fixture(),e=f.engine;
 const old=performSessionCommand(e,{name:'launch_clip',args:{trackId:'a',scene:0}}),rejected=assert.rejects(old,/Playback changed/),latest=e.launch('a','a1',1);
 f.gates[1].resolve();const receipt=await latest;f.gates[0].resolve();await rejected;assert.equal(e.pending.get('a'),receipt.events[0].event);assert.equal(selected(e,'a'),'a1');
});

test('an aborted loading Toggle does not consume the next intentional press as a cancellation',async()=>{
 const f=await fixture(),e=f.engine,c=new AbortController();f.project.clips.a0.launch={mode:'toggle',legato:false,quantization:'global'};
 const old=e.launch('a','a0',0,{signal:c.signal}),rejected=assert.rejects(old,{name:'AbortError'});c.abort();const fresh=e.launch('a','a0',0);assert.equal(f.gates.length,2);
 f.gates[1].resolve();await fresh;f.gates[0].resolve();await rejected;assert.equal(selected(e,'a'),'a0');
});

test('manual Toggle cancellation reports cancellation instead of claiming that playback began',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),statuses=[];
 const ctx={busy:false,project:{clips:{}},engine:{launch:async()=>({cancelled:true})},run:fn=>fn,$:()=>({addEventListener:(_,fn)=>ctx.click=fn}),setStatus:v=>statuses.push(v),drawWave:()=>statuses.push('draw'),selectedSessionScene:0},start=source.indexOf("$('session-grid').addEventListener('click',run(async e=>");vm.createContext(ctx);vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);
 await ctx.click({target:{closest:selector=>selector==='.slot'?{dataset:{track:'a',scene:'0'}}:selector==='[data-launch]'?{dataset:{launch:'a0'}}:null}});assert.deepEqual(statuses,['Pending Clip Action Cancelled.']);
});
