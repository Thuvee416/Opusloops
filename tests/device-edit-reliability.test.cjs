const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
async function fixture({returns=false,initialized=true}={}){
 const [{Engine},{emptyProject,validateProject,makeTrack},{newDevice},{History}]=await Promise.all(['audio','model','devices','history'].map(n=>import('../web-studio/'+n+'.js')));
 const project=emptyProject(),track=returns?{...makeTrack('Room'),id:'room'}:project.tracks[0];if(returns)project.returns=[track];track.devices=[newDevice('filter'),newDevice('eq')];
 const param=()=>({value:0,setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},cancelScheduledValues(){}});
 const nodes=[],node=()=>{const n={edges:new Set(),gain:param(),pan:param(),frequency:param(),Q:param(),connect(target){this.edges.add(target);return target;},disconnect(target){if(target)this.edges.delete(target);else this.edges.clear();}};nodes.push(n);return n;};
 const audio={currentTime:0,sampleRate:48000,createGain:node,createStereoPanner:node,createAnalyser:node,createChannelSplitter:node,createBiquadFilter:node};
 const engine=new Engine(project,()=>{});if(initialized){engine.context=audio;engine.master=node();engine.resetMixers();}
 const history=new History(project),original=structuredClone(project),counts={commit:0,release:0,renders:0},controls={'add-device':{},'device-chain':{dataset:{track:track.id},addEventListener:(_,fn)=>{controls.click=fn;}},'device-type':{value:'filter'}};
 const ctx={project,engine,busy:false,structuredClone,validateProject,newDevice,deviceTrack:id=>[...ctx.project.tracks,...ctx.project.returns??[]].find(t=>t.id===id),stopToEdit(){if(ctx.recording)throw Error('Finish Recording');if(engine.playing)throw Error('Stop Playback');},releaseNotes(){counts.release++;},renderDevices(){counts.renders++;},changed(){counts.commit++;history.commit(ctx.project);},run:fn=>fn,$:id=>controls[id]};
 vm.createContext(ctx);const helper=source.indexOf('function applyDeviceChainEdit('),begin=helper<0?source.indexOf("$('add-device').onclick"):helper,end=source.indexOf("$('device-chain').addEventListener('input'",begin);vm.runInContext(source.slice(begin,end),ctx);
 const action=(type,index=0)=>controls.click({target:{closest:()=>({dataset:{device:track.devices[index]?.id||'missing'}}),hasAttribute:name=>name==='data-device-structural'||name==='data-device-'+type}});
 return {ctx,project,track,engine,audio,node,nodes,controls,counts,history,original,newDevice,validateProject,action};
}

test('the actual Add Effect handler preserves the project, old graph and Undo when rebuilding fails',async()=>{
 const f=await fixture(),graph=f.engine.mixGraph,devices=f.track.devices,input=f.engine.mixers.get(f.track.id).input,edges=[...input.edges];f.audio.createGain=()=>{throw Error('Allocation Failed');};
 assert.throws(()=>f.controls['add-device'].onclick(),/Allocation Failed/);assert.deepEqual(f.project,f.original);assert.equal(f.track.devices,devices);assert.equal(f.engine.mixGraph,graph);assert.deepEqual([...input.edges],edges);assert.equal(f.counts.commit,0);assert.equal(f.counts.release,0);
});

test('remove, bypass and reorder handlers restore track and return chains on mixer failure',async()=>{
 for(const returns of [false,true])for(const [action,index]of [['remove',0],['toggle',0],['down',0],['up',1]]){
  const f=await fixture({returns}),before=f.engine.mixGraph,devices=f.track.devices;f.audio.createGain=()=>{throw Error('Allocation Failed');};
  assert.throws(()=>f.action(action,index),/Allocation Failed/);assert.deepEqual(f.project,f.original);assert.equal(f.track.devices,devices);assert.equal(f.engine.mixGraph,before);assert.equal(f.counts.commit,0);
 }
});

test('successful add/remove/bypass/reorder controls commit exactly one Undo and install the matching chain',async()=>{
 for(const returns of [false,true])for(const [action,index]of [['add',0],['remove',0],['toggle',0],['down',0],['up',1]]){
  const f=await fixture({returns}),old=f.engine.mixGraph,oldDevices=f.track.devices;
  if(action==='add')f.controls['add-device'].onclick();else f.action(action,index);
  assert.equal(f.counts.commit,1);assert.equal(f.counts.release,1);assert.notEqual(f.engine.mixGraph,old);assert.notEqual(f.track.devices,oldDevices);assert.deepEqual(oldDevices,(returns?f.original.returns[0]:f.original.tracks[0]).devices);
  const chain=f.engine.mixer(f.track.id).chain,filter=f.track.devices.find(d=>d.type==='filter');
  assert.equal(chain.bindings(filter?.id,'frequency').length,filter?.enabled?1:0);f.validateProject(f.project);const saved=structuredClone(f.project);assert.deepEqual(f.history.undo(),f.original);assert.deepEqual(f.history.redo(),saved);
  if(action==='add')assert.equal(f.track.devices.length,3);else if(action==='remove')assert.equal(f.track.devices.length,1);else if(action==='toggle')assert.equal(f.track.devices[0].enabled,false);else assert.equal(f.track.devices[0].type,'eq');
 }
});

test('busy, pending playback, active playback and recording reject effect changes without creating nodes',async()=>{
 for(const mode of ['busy','pending','playing','recording']){
  const f=await fixture(),before=f.nodes.length;if(mode==='busy')f.ctx.busy=true;else if(mode==='pending')f.engine.startPromise=Promise.resolve();else if(mode==='playing')f.engine.playing=true;else f.ctx.recording=true;
  assert.throws(()=>f.controls['add-device'].onclick());assert.throws(()=>f.action('remove'));assert.deepEqual(f.project,f.original);assert.equal(f.counts.commit,0);assert.equal(f.nodes.length,before);
 }
});

test('stale cards, boundary moves and unchanged candidates do not rebuild, release notes or add Undo',async()=>{
 const f=await fixture(),before=f.engine.mixGraph;f.action('up',0);f.action('down',1);f.action('remove',99);f.ctx.applyDeviceChainEdit(f.track,structuredClone(f.track.devices));assert.equal(f.engine.mixGraph,before);assert.equal(f.counts.release,0);assert.equal(f.counts.commit,0);assert.deepEqual(f.project,f.original);
});

test('validation failures and effect-count limits leave the previous sound intact',async()=>{
 const f=await fixture(),before=f.engine.mixGraph,next=structuredClone(f.track.devices);next[0].params.frequency=-1;
 assert.throws(()=>f.ctx.applyDeviceChainEdit(f.track,next),/parameter/i);assert.deepEqual(f.project,f.original);assert.equal(f.engine.mixGraph,before);
 f.track.devices=Array.from({length:12},()=>f.newDevice('filter'));const full=structuredClone(f.project);assert.throws(()=>f.controls['add-device'].onclick(),/12 devices/i);assert.deepEqual(f.project,full);assert.equal(f.counts.commit,0);
});

test('effects can be edited before audio initialization without opening the audio context',async()=>{
 const f=await fixture({initialized:false});f.controls['add-device'].onclick();assert.equal(f.engine.context,null);assert.equal(f.track.devices.length,3);assert.equal(f.counts.commit,1);assert.deepEqual(f.history.undo(),f.original);
});

test('monitor reconnect failure restores both the prior sound and monitor destination',async()=>{
 const f=await fixture(),old=f.engine.mixGraph,originalInput=f.engine.mixer(f.track.id).input;let monitor=originalInput,calls=0;
 f.engine.onMixersChanged=()=>{monitor=f.engine.mixer(f.track.id).input;if(++calls===1)throw Error('Reconnect Failed');};
 assert.throws(()=>f.action('toggle'),/Reconnect Failed/);assert.deepEqual(f.project,f.original);assert.equal(f.engine.mixGraph,old);assert.equal(monitor,originalInput);assert.equal(calls,2);assert.equal(f.counts.commit,0);assert.ok(originalInput.edges.size);
});
