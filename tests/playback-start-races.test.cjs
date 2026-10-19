const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t){
 const {Engine}=await import('../web-studio/audio.js'),{emptyProject}=await import('../web-studio/model.js'),transport=await import('../web-studio/transport-controls.js');
 const project=emptyProject(),original=structuredClone(project),engine=new Engine(project,()=>{}),gates=[];let ticks=0;
 engine.context={currentTime:6};engine.updateMix=()=>{};engine.resetMixers=()=>{};engine.tick=()=>ticks++;
 engine.prepare=()=>new Promise((resolve,reject)=>gates.push({resolve,reject}));
 t.after(()=>clearInterval(engine.timer));return {engine,project,original,gates,ticks:()=>ticks,...transport};
}

test('Play Stop Play serializes preparation and starts the fresh request after the cancelled one settles',async t=>{
 const f=await fixture(t),e=f.engine;e.position=4;const old=e.play('arrangement');await f.stopPlayback(e);const retry=e.play('arrangement');
 assert.equal(f.gates.length,1);assert.equal(f.transportSnapshot(e).running,true);f.gates[0].resolve();await old;await tick();assert.equal(f.gates.length,2);assert.equal(e.playing,false);
 f.gates[1].resolve();await retry;assert.equal(e.playing,true);assert.equal(e.position,4);assert.equal(e.startPromise,null);assert.deepEqual(f.project,f.original);
});

test('a later Stop cancels a queued restart without a second prepare or unexpected rewind',async t=>{
 const f=await fixture(t),e=f.engine;e.position=7;const old=e.play();await f.stopPlayback(e);const retry=e.play();const stop=await f.stopPlayback(e);assert.equal(stop.reset,false);assert.equal(e.position,7);
 f.gates[0].resolve();await Promise.all([old,retry]);assert.equal(e.playing,false);assert.equal(f.gates.length,1);assert.equal(f.transportSnapshot(e).running,false);
});

test('rapid successive seeks resume only the latest position while preserving Session clip phase and the project',async t=>{
 const f=await fixture(t),e=f.engine;e.playing=true;e.clockStart=0;e.origin=0;e.active.set('track',{clipId:'clip',start:3});
 const first=e.seek(8),second=e.seek(16),third=e.seek(20);assert.equal(e.position,20);assert.equal(f.gates.length,1);
 f.gates[0].resolve();await tick();assert.equal(f.gates.length,2);f.gates[1].resolve();await Promise.all([first,second,third]);
 assert.equal(e.playing,true);assert.equal(e.position,20);assert.equal(e.insertMarker,20);assert.equal(e.rawBeat()-e.active.get('track').start,9);assert.deepEqual(f.project,f.original);
});

test('seeking after Stop during preparation updates the marker without reviving playback',async t=>{
 const f=await fixture(t),e=f.engine,old=e.play();e.stop();await e.seek(9.125);f.gates[0].resolve();await old;assert.equal(e.playing,false);assert.equal(e.insertMarker,9.25);assert.equal(f.gates.length,1);
});

test('duplicate Play joins one preparation and an explicit retry can outlive an older preparation failure',async t=>{
 const f=await fixture(t),e=f.engine,one=e.play(),two=e.play();assert.equal(f.gates.length,1);f.gates[0].resolve();await Promise.all([one,two]);assert.equal(f.ticks(),1);e.stop();
 const failed=e.play(),observed=assert.rejects(failed,/Decode Failed/);e.stop();const retry=e.play();f.gates[1].reject(Error('Decode Failed'));await observed;await tick();assert.equal(f.gates.length,3);f.gates[2].resolve();await retry;assert.equal(e.playing,true);
});

test('scheduler startup failure stops nodes and its timer, preserves position and permits a retry',async t=>{
 const f=await fixture(t),e=f.engine;let stops=0;e.position=5;e.tick=()=>{e.nodes.add({stop:()=>stops++});throw Error('Scheduler Failed');};
 const failed=e.play('arrangement'),observed=assert.rejects(failed,/Scheduler Failed/);f.gates[0].resolve();await observed;assert.equal(e.playing,false);assert.equal(e.position,5);assert.equal(e.nodes.size,0);assert.equal(stops,1);assert.equal(e.timer._destroyed,true);assert.equal(e.startPromise,null);assert.deepEqual(f.project,f.original);
 e.tick=()=>{};const retry=e.play('arrangement');f.gates[1].resolve();await retry;assert.equal(e.playing,true);
});

function commands(f){
 const ctx={engine:f.engine,preparePlayback:f.preparePlayback,view:'arrangement',drawWave(){},Error},start=source.indexOf('async function executeStudioCommand('),end=source.indexOf("\n if(x.name==='pause')",start);
 vm.createContext(ctx);vm.runInContext(source.slice(start,end)+'\n}',ctx);
 const manual=source.indexOf('async function playFromControls(');vm.runInContext(source.slice(manual,source.indexOf("\n$('play').onclick",manual)),ctx);return ctx;
}
test('actual manual Play suppresses only superseded-start errors and leaves the latest request running',async t=>{
 const f=await fixture(t),ctx=commands(f),old=ctx.playFromControls();await tick();f.engine.stop();const retry=ctx.playFromControls();await tick();f.gates[0].resolve();await old;await tick();assert.equal(f.gates.length,2);f.gates[1].resolve();const result=await retry;assert.equal(result.playing,true);
 f.engine.stop();const bad=ctx.playFromControls(),observed=assert.rejects(bad,/Decode Failed/);await tick();f.gates[2].reject(Error('Decode Failed'));await observed;
});

test('actual Odesa Play cancellation cannot start audio or stop a newer manual request',async t=>{
 const f=await fixture(t),ctx=commands(f),controller=new AbortController(),first=ctx.executeStudioCommand({name:'play'},controller.signal),rejected=assert.rejects(first,{name:'AbortError'});await tick();controller.abort();f.gates[0].resolve();await rejected;assert.equal(f.engine.playing,false);
 const later=new AbortController(),old=ctx.executeStudioCommand({name:'play'},later.signal),interrupted=assert.rejects(old,{name:'AbortError'});await tick();f.engine.stop();const retry=ctx.playFromControls();await tick();later.abort();f.gates[1].resolve();await interrupted;await tick();f.gates[2].resolve();await retry;assert.equal(f.engine.playing,true);
});

test('Space and Shift Space stop a current pending start but play after it has been cancelled',async t=>{
 const f=await fixture(t),clicks=[],ctx={engine:f.engine,transportSnapshot:f.transportSnapshot,sessionMarquee:null,localStorage:{},tabMovesFocus:()=>false,command:'toggle_play',studioShortcut:()=>ctx.command,$:id=>({click:()=>clicks.push(id)}),document:{addEventListener:(_,fn)=>ctx.keydown=fn,querySelector:()=>null,body:{classList:{contains:()=>false}}}};
 const start=source.indexOf("document.addEventListener('keydown',e=>{\n if(sessionMarquee");vm.createContext(ctx);vm.runInContext(source.slice(start,source.indexOf("\ndocument.addEventListener('visibilitychange'",start)),ctx);
 const pending=f.engine.play(),event={target:{closest:()=>null},preventDefault(){}};ctx.keydown(event);ctx.command='continue_play';ctx.keydown(event);f.engine.stop();ctx.keydown(event);assert.deepEqual(clicks,['stop','stop','continue-play']);f.gates[0].resolve();await pending;
});


test('Stop during the marker-positioning await cancels the application Play before audio preparation',async t=>{
 const f=await fixture(t),ctx=commands(f);f.engine.position=8;f.engine.insertMarker=4;
 const pending=ctx.executeStudioCommand({name:'play'});f.engine.stop();await assert.rejects(pending,{code:'PLAYBACK_CANCELLED'});assert.equal(f.gates.length,0);assert.equal(f.engine.playing,false);
});
