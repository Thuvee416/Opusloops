const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {Engine}=await import('../web-studio/audio.js'),{emptyProject,makeTrack}=await import('../web-studio/model.js');
 const project=emptyProject(),a=project.tracks[0];a.id='a';const b=makeTrack('B',1);b.id='b';project.tracks=[a,b];
 for(const track of project.tracks){const id=track.id+'-clip';track.slots[0]=id;project.clips[id]={id,name:id,kind:'midi',sourceBpm:project.bpm,beats:4,notes:[]};}
 const engine=new Engine(project,()=>{}),gates=[];engine.context={currentTime:0};engine.origin=0;engine.nextBeat=0;engine.clockStart=0;
 engine.prepare=()=>new Promise((resolve,reject)=>gates.push({resolve,reject}));engine.play=async()=>{engine.playing=true;};engine.resetMixers=()=>{};
 const group=()=>{const g=makeTrack('Group');g.id='group';g.group=true;a.parentId=g.id;project.tracks.unshift(g);return g;};
 return {engine,project,gates,group,original:structuredClone(project)};
}

test('Stop All Clips during clip preparation prevents a late activation and leaves the project unchanged',async()=>{
 const f=await fixture(),e=f.engine,pending=e.launch('a','a-clip',0);await e.stopAll();f.gates[0].resolve();const result=await pending;
 assert.equal(result.interrupted,true);assert.equal(e.active.size,0);assert.equal(e.pending.size,0);assert.equal(e.playing,false);assert.deepEqual(f.project,f.original);
});

test('Stop All Clips cancels a loading scene and its scene-follow activation',async()=>{
 const f=await fixture(),e=f.engine,pending=e.scene(0);await e.stopAll();f.gates[0].resolve();const result=await pending;
 assert.equal(result.interrupted,true);assert.equal(e.active.size,0);assert.equal(e.activeScene,null);assert.equal(e.pendingScene,null);assert.equal(e.sceneFollow,null);assert.equal(e.playing,false);
});

test('individual track Stop bypasses audio preparation and supersedes only that pending clip launch',async()=>{
 const f=await fixture(),e=f.engine,a=e.launch('a','a-clip',0),b=e.launch('b','b-clip',0);
 const stopped=await e.launch('a',null);assert.equal(f.gates.length,2);assert.equal(stopped.events[0].event.clipId,null);assert.equal(e.playing,false);
 f.gates[1].resolve();await b;f.gates[0].resolve();assert.equal((await a).interrupted,true);
 assert.equal(e.active.get('a').clipId,null);assert.equal(e.active.get('b').clipId,'b-clip');assert.equal(e.playing,true);
});

test('group Stop cancels loading group members but preserves another track in the same loading scene',async()=>{
 const f=await fixture();f.group();const e=f.engine,pending=e.scene(0);await e.stopGroup('group');f.gates[0].resolve();const receipt=await pending;
 assert.equal(receipt.interrupted,true);assert.deepEqual(receipt.events.map(v=>v.trackId),['b']);assert.equal(e.active.has('a'),false);assert.equal(e.active.get('b').clipId,'b-clip');
});

test('running track Stop retains launch quantization and cannot be overwritten by the old preparation',async()=>{
 const f=await fixture(),e=f.engine;e.playing=true;e.context.currentTime=1;e.nextBeat=2.5;
 e.active.set('a',{clipId:'a-clip',start:0,slot:0});const old=e.launch('a','a-clip',0),stop=await e.launch('a',null);
 assert.equal(stop.events[0].event.beat,4);assert.equal(e.active.get('a').clipId,'a-clip');assert.equal(e.pending.get('a').clipId,null);
 f.gates[0].resolve();assert.equal((await old).interrupted,true);assert.equal(e.pending.get('a'),stop.events[0].event);
});

test('a new explicit launch after Stop is allowed while the older preparation stays cancelled',async()=>{
 const f=await fixture(),e=f.engine,old=e.launch('a','a-clip',0);await e.stopAll();const fresh=e.launch('a','a-clip',0);
 f.gates[1].resolve();await fresh;f.gates[0].resolve();assert.equal((await old).interrupted,true);assert.equal(e.active.get('a').clipId,'a-clip');assert.equal(e.pending.size,0);
});

test('Stop All and individual Stop also cancel loading Gate/Repeat presses without restarting audio',async()=>{
 for(const mode of ['gate','repeat'])for(const stop of ['all','track']){
  const f=await fixture(),e=f.engine;f.project.clips['a-clip'].launch={mode,legato:false,quantization:'global'};
  const held=e.pressGate('a','a-clip',0);if(stop==='all')await e.stopAll();else await e.launch('a',null);
  f.gates[0].resolve();await held.ready;assert.equal(e.active.get('a')?.clipId??null,null);assert.equal(e.pending.size,0);assert.equal(e.playing,false);assert.equal(e.gateHolds.size,0);
 }
});

test('Odesa uses the same stop path and reports interrupted launch rather than success',async()=>{
 const {performSessionCommand}=await import('../web-studio/agent-performance.js'),f=await fixture(),e=f.engine;
 const launch=performSessionCommand(e,{name:'launch_clip',args:{trackId:'a',scene:0}}),rejected=assert.rejects(launch,/Playback changed/);
 const result=await performSessionCommand(e,{name:'stop_track',args:{trackId:'a'}});assert.equal(result.sessionPerformance,true);assert.equal(result.playing,false);
 f.gates[0].resolve();await rejected;assert.equal(e.active.get('a').clipId,null);
});

test('aborted Stop does not cancel an authorized launch and transport Stop still cancels preparations',async()=>{
 const f=await fixture(),e=f.engine,old=e.launch('a','a-clip',0),controller=new AbortController();controller.abort();
 await assert.rejects(e.launch('a',null,undefined,{signal:controller.signal}),{name:'AbortError'});f.gates[0].resolve();await old;assert.equal(e.active.get('a').clipId,'a-clip');
 const next=e.launch('b','b-clip',0);e.stop();f.gates[1].resolve();assert.equal((await next).interrupted,true);assert.equal(e.active.has('b'),false);
});

test('cancelling every actionable scene slot does not start a scene through untouched no-stop slots',async()=>{
 const f=await fixture(),e=f.engine;f.project.tracks[1].slots[0]=null;f.project.tracks[1].noStopSlots=[0];
 const pending=e.scene(0);await e.launch('a',null);f.gates[0].resolve();assert.equal((await pending).interrupted,true);assert.equal(e.playing,false);assert.equal(e.activeScene,null);
});

test('real playback startup cannot restore clips cleared during its second preparation',async t=>{
 const f=await fixture(),{Engine}=await import('../web-studio/audio.js'),e=f.engine;e.play=Engine.prototype.play;e.updateMix=()=>{};let scheduled=[];e.tick=()=>scheduled.push([...e.active.values()].filter(a=>a.clipId));t.after(()=>clearInterval(e.timer));
 const pending=e.launch('a','a-clip',0);f.gates[0].resolve();await new Promise(r=>setImmediate(r));assert.equal(f.gates.length,2);assert.equal(e.active.get('a').clipId,'a-clip');
 await e.stopAll();f.gates[1].resolve();assert.equal((await pending).interrupted,true);assert.equal(e.active.size,0);assert.ok(scheduled.every(events=>events.length===0));
});

test('manual clip and scene click handlers do not replace Stop feedback with a stale Playing message',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
 const start=source.indexOf("$('session-grid').addEventListener('click',run(async e=>"),end=source.indexOf('\n',start),statuses=[],ctx={busy:false,project:{clips:{}},engine:{launch:async()=>({interrupted:true}),scene:async()=>({interrupted:true})},run:fn=>fn,$:()=>({addEventListener:(_,fn)=>ctx.click=fn}),setStatus:v=>statuses.push(v),drawWave:()=>statuses.push('draw'),selectedSessionScene:0};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const slot={dataset:{track:'a',scene:'0'}},launch={dataset:{launch:'a-clip'}},scene={dataset:{sceneLaunch:'0'}};
 for(const kind of ['clip','scene'])await ctx.click({target:{closest:selector=>selector==='.slot'?slot:selector==='[data-launch]'&&kind==='clip'?launch:selector==='[data-scene-launch]'&&kind==='scene'?scene:null}});
 assert.deepEqual(statuses,[]);
});
