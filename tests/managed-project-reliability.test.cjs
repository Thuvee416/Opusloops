const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
async function fixture({initialized=true}={}){
 const api=Object.assign({},...await Promise.all(['audio','model','management','session-edit','automation-targets','history','time-edit','time-clipboard'].map(n=>import('../web-studio/'+n+'.js'))));
 const project=api.emptyProject();project.tracks.push(api.makeTrack('Second',1));
 const clip={id:'clip',name:'Pattern',kind:'midi',beats:4,sourceBpm:120,notes:[]};project.clips.clip=clip;project.tracks[0].slots[0]=clip.id;api.validateProject(project);
 const nodes=[],param=()=>({value:0,setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}}),node=()=>{const n={gain:param(),pan:param(),edges:new Set(),connect(t){this.edges.add(t);},disconnect(){this.edges.clear();}};nodes.push(n);return n;};
 const audio={currentTime:0,createGain:node,createStereoPanner:node,createAnalyser:node,createChannelSplitter:node};
 const engine=new api.Engine(project,()=>{});if(initialized){engine.context=audio;engine.master=node();engine.resetMixers();}
 engine.active.set(project.tracks[0].id,{clipId:'clip',slot:0,followSignature:'retain'});
 engine.pending.set(project.tracks[1].id,{clipId:'clip'});engine.follows.set(project.tracks[0].id,{beat:4});engine.sceneFollow={beat:8};
 engine.overrides.add(project.tracks[0].id);engine.automationOverrides.add(project.tracks[0].id+':volume');engine.buffers.set('clip',{decoded:true});
 const counts={release:0,cancel:0,reconcile:0,render:0,commit:0},history=new api.History(project),controls={'manage-track':{value:project.tracks[0].id},'manage-scene':{value:'0'},'project-name':{},bpm:{},'time-start':{value:'1'},'time-length':{value:'4'},'time-copy':{},'time-cut':{},'time-paste':{}};
 const ctx={...api,project,engine,structuredClone,busy:false,selection:{trackId:project.tracks[0].id,clipId:'clip',scene:0},sessionSelection:[],sessionAnchor:null,selectedRegion:null,deviceTarget:'old',
  inputActive:()=>false,stopToEdit(){if(engine.playing)throw Error('Stop Playback');},
  releaseNotes(){counts.release++;},cancelRegionDrag(){counts.cancel++;},reconcileContentSelection(){counts.reconcile++;},render(){counts.render++;},setStatus(){},$:id=>controls[id],
  timeScopeIds:()=>null,timeScopeLabel:()=> 'All Tracks',renderTransport(){},run:fn=>fn,
  timeClipboard:{previous:true},sessionClipboard:{previous:true},
  changed(){counts.commit++;history.commit(ctx.project);}};
 vm.createContext(ctx);
 for(const [begin,end] of [['function installManagedProject(','function renderNotes('],['function applyTrack(action','\n'],['function applySessionTransfer(','\n'],['function retainAgentSelection(','\ninstallAgent('],["for(const action of ['copy','cut','paste'])$('time-'","for(const action of ['insert','delete','duplicate'])"]]){
  const start=source.indexOf(begin);
  vm.runInContext(source.slice(start,source.indexOf(end,start+begin.length)),ctx);
 }
 const commitStart=source.indexOf(' commit:(next,observations');
 vm.runInContext('agent={'+source.slice(commitStart,source.indexOf('\n analyze:',commitStart))+'};',ctx);
 const snapshot=()=>({project:ctx.project,engineProject:engine.project,master:engine.masterVolume,graph:engine.mixGraph,active:[...engine.active],pending:[...engine.pending],follows:[...engine.follows],sceneFollow:engine.sceneFollow,overrides:[...engine.overrides],automation:[...engine.automationOverrides],buffers:[...engine.buffers],selection:ctx.selection,sessionSelection:ctx.sessionSelection,anchor:ctx.sessionAnchor,deviceTarget:ctx.deviceTarget});
 return {api,ctx,project,engine,audio,nodes,counts,history,snapshot,controls};
}

test('actual track deletion preserves project, playback caches, selection and Undo on mixer failure',async()=>{
 const f=await fixture(),before=f.snapshot();f.audio.createGain=()=>{throw Error('Allocation Failed');};
 assert.throws(()=>f.ctx.applyTrack('delete'),/Allocation Failed/);
 assert.deepEqual(f.snapshot(),before);assert.equal(f.counts.release,0);assert.equal(f.counts.cancel,0);assert.equal(f.counts.commit,0);
});

test('actual Session move preserves source activation and selection when mixer preparation fails',async()=>{
 const f=await fixture(),before=f.snapshot();f.audio.createGain=()=>{throw Error('Allocation Failed');};
 assert.throws(()=>f.ctx.applySessionTransfer({trackId:f.project.tracks[0].id,scene:0,clipId:'clip'},{trackId:f.project.tracks[1].id,scene:1},false),/Allocation Failed/);
 assert.deepEqual(f.snapshot(),before);assert.equal(f.counts.commit,0);
});

test('successful track deletion prunes only obsolete state and records one reversible edit',async()=>{
 const f=await fixture(),original=structuredClone(f.project);f.ctx.applyTrack('delete');
 assert.equal(f.ctx.project,f.engine.project);assert.equal(f.engine.active.size,0);assert.equal(f.engine.overrides.size,0);assert.equal(f.engine.automationOverrides.size,0);
 assert.equal(f.engine.pending.size,0);assert.equal(f.engine.follows.size,0);assert.equal(f.engine.sceneFollow,null);assert.equal(f.counts.release,1);assert.equal(f.counts.commit,1);
 assert.deepEqual(f.history.undo(),original);assert.deepEqual(f.history.redo(),f.ctx.project);
});

test('monitor failure restores the original master level and reconnects using the original project',async()=>{
 const f=await fixture(),before=f.snapshot(),next=structuredClone(f.project);next.master=.25;let calls=0,monitorProject;
 f.engine.onMixersChanged=()=>{monitorProject=f.engine.project;if(++calls===1)throw Error('Monitor Failed');};
 assert.throws(()=>f.ctx.installManagedProject(next),/Monitor Failed/);assert.deepEqual(f.snapshot(),before);
 assert.equal(f.engine.master.gain.value,.8);assert.equal(monitorProject,f.project);assert.equal(f.counts.release,0);
});

test('invalid candidates and pending playback reject before altering project or runtime state',async()=>{
 for(const pending of [false,true]){
  const f=await fixture(),before=f.snapshot(),next=structuredClone(f.project);if(pending)f.engine.startPromise=Promise.resolve();else next.bpm=0;
  assert.throws(()=>f.ctx.installManagedProject(next));assert.deepEqual(f.snapshot(),before);assert.equal(f.counts.release,0);
 }
});

test('uninitialized managed edits retain matching master state without creating audio resources',async()=>{
 const f=await fixture({initialized:false}),next=structuredClone(f.project);next.master=.35;f.ctx.installManagedProject(next);
 assert.equal(f.engine.context,null);assert.equal(f.nodes.length,0);assert.equal(f.engine.masterVolume,.35);assert.equal(f.ctx.project,next);
 assert.equal(f.engine.buffers.has('clip'),true);assert.equal(f.engine.active.get(f.project.tracks[0].id).followSignature,undefined);
});

test('Odesa commit does not publish its master, selection or clipboard until the candidate mixer works',async()=>{
 for(const keepSelection of [false,true]){
  const f=await fixture(),before=f.snapshot(),clipboard=f.ctx.sessionClipboard,next=structuredClone(f.project);next.master=.2;
  const chosen={trackId:next.tracks[1].id,scene:2,clipId:null},observations=[{type:'session_clips',selection:[chosen],clipboard:{new:true}}];
  const options=keepSelection?{navigationPreservation:{scopes:['selection'],expected:{selection:chosen,selectedSession:[chosen],deviceTrackId:chosen.trackId}}}:{};
  f.audio.createGain=()=>{throw Error('Allocation Failed');};
  assert.throws(()=>f.ctx.agent.commit(next,observations,options),/Allocation Failed/);
  assert.deepEqual(f.snapshot(),before);assert.equal(f.ctx.sessionClipboard,clipboard);assert.equal(f.counts.commit,0);
 }
});

test('Odesa success installs the requested level and navigation with one Undo',async()=>{
 const f=await fixture(),original=structuredClone(f.project),next=structuredClone(f.project);next.master=.3;
 const chosen={trackId:next.tracks[1].id,scene:2,clipId:null};f.ctx.agent.commit(next,[{type:'session_clips',selection:[chosen]}]);
 assert.equal(f.engine.masterVolume,.3);assert.equal(f.engine.master.gain.value,.3);assert.equal(f.ctx.selection.trackId,chosen.trackId);
 assert.equal(f.counts.commit,1);assert.deepEqual(f.history.undo(),original);assert.deepEqual(f.history.redo(),next);
});

test('actual Arrangement cut retains its previous clipboard and playhead after mixer rejection',async()=>{
 const f=await fixture(),before=f.snapshot(),clipboard=f.ctx.timeClipboard,position=f.engine.position;
 f.audio.createGain=()=>{throw Error('Allocation Failed');};
 await assert.rejects(f.controls['time-cut'].onclick(),/Allocation Failed/);
 assert.deepEqual(f.snapshot(),before);assert.equal(f.ctx.timeClipboard,clipboard);assert.equal(f.engine.position,position);assert.equal(f.counts.commit,0);
});

test('a failed edit can be retried without reloading the project',async()=>{
 const f=await fixture(),original=structuredClone(f.project),create=f.audio.createGain;
 f.audio.createGain=()=>{throw Error('Allocation Failed');};assert.throws(()=>f.ctx.applyTrack('duplicate'),/Allocation Failed/);
 f.audio.createGain=create;f.ctx.applyTrack('duplicate');assert.equal(f.ctx.project.tracks.length,3);assert.equal(f.engine.mixers.size,3);
 assert.equal(f.counts.commit,1);assert.deepEqual(f.history.undo(),original);
});
