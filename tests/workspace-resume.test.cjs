const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const state={view:'arrangement',position:12.5,marker:4,viewport:{start:16,span:32}};
function storage(){const values=new Map();return {values,writes:0,getItem:k=>values.get(k)??null,setItem(k,v){this.writes++;values.set(k,v);}};}

test('workspace navigation is bound to committed revisions and stores no playback or project payload',async()=>{
 const {WorkspaceResume,WORKSPACE_RESUME_KEY}=await import('../web-studio/workspace-resume.js'),local=storage(),cache=new WorkspaceResume(()=>local);
 assert.equal(cache.save('set-a',{...state,playing:true,project:{secret:'music'}}),true);assert.deepEqual(cache.read('set-a'),state);assert.equal(cache.read('set-b'),null);assert.equal(cache.read(null),null);
 const parsed=JSON.parse(local.getItem(WORKSPACE_RESUME_KEY));assert.deepEqual(Object.keys(parsed.entries[0].state),['view','position','marker','viewport']);
 cache.save('set-b',{...state,view:'session',position:0});cache.save('set-a',{...state,marker:8});assert.equal(cache.read('set-b').view,'session');assert.equal(cache.read('set-a').marker,8);
});

test('workspace cache is bounded and unchanged navigation avoids repeated storage writes',async()=>{
 const {WorkspaceResume,WORKSPACE_RESUME_KEY}=await import('../web-studio/workspace-resume.js'),local=storage(),cache=new WorkspaceResume(()=>local);
 for(let i=0;i<12;i++)cache.save('revision-'+i,state);assert.equal(JSON.parse(local.getItem(WORKSPACE_RESUME_KEY)).entries.length,8);assert.equal(cache.read('revision-0'),null);assert.deepEqual(cache.read('revision-11'),state);
 const count=local.writes;cache.save('revision-11',state);assert.equal(local.writes,count);const copy=cache.read('revision-11');copy.viewport.start=99;assert.equal(cache.read('revision-11').viewport.start,16);
});

test('malformed, out-of-range and unavailable UI storage never blocks the project',async()=>{
 const {WorkspaceResume,WORKSPACE_RESUME_KEY,workspaceResumeState}=await import('../web-studio/workspace-resume.js'),local=storage(),cache=new WorkspaceResume(()=>local);
 for(const value of [null,{}, {...state,position:Infinity},{...state,marker:-1},{...state,view:'playing'},{...state,viewport:{start:999999,span:32}},{...state,viewport:{start:0,span:3}}])assert.equal(workspaceResumeState(value),null);
 local.setItem(WORKSPACE_RESUME_KEY,'{broken');assert.equal(cache.read('set'),null);assert.equal(cache.save(null,state),false);assert.equal(cache.save('set',state),true);
 const blocked=new WorkspaceResume(()=>{throw Error('Storage Disabled');});assert.equal(blocked.read('set'),null);assert.equal(blocked.save('set',state),false);
 local.setItem=()=>{throw Error('Quota');};assert.equal(cache.save('other',state),false);assert.deepEqual(cache.read('set'),state);
});

test('actual restore and remember adapters preserve musical state and keep recording/preparation locked',async()=>{
 const {WorkspaceResume}=await import('../web-studio/workspace-resume.js'),local=storage(),cache=new WorkspaceResume(()=>local),source=fs.readFileSync(__dirname+'/../web-studio/app.js','utf8'),controls={'timeline-start':{},'timeline-bars':{}};
 const project={notes:[60,64],name:'Keep My Song'},history={past:['existing']},before=structuredClone({project,history});
 const ctx={workspaceResume:cache,workspaceResumeReady:true,workspaceRememberedAt:0,projectStore:{revision:'committed'},project,history,busy:false,inputActive:()=>false,view:'session',currentViewport:()=>state.viewport,Date:{now:()=>10000},engine:{playing:false,position:0,insertMarker:0,beat(){return this.position;}},$:id=>controls[id],switchView:v=>ctx.view=v,renderTransport(){}};
 vm.createContext(ctx);const begin=source.indexOf('function rememberWorkspace('),end=source.indexOf("window.addEventListener('pagehide'",begin);vm.runInContext(source.slice(begin,end),ctx);
 ctx.restoreWorkspace(state);assert.equal(ctx.view,'arrangement');assert.equal(ctx.engine.position,12.5);assert.equal(ctx.engine.insertMarker,4);assert.equal(ctx.engine.playing,false);assert.equal(controls['timeline-start'].value,17);assert.equal(controls['timeline-bars'].value,'8');ctx.rememberWorkspace();assert.deepEqual(cache.read('committed'),state);assert.deepEqual({project,history},before);
 for(const mode of ['busy','input','pending','recovery','playing']){ctx.projectStore.revision=mode;if(mode==='busy')ctx.busy=true;if(mode==='input')ctx.inputActive=()=>true;if(mode==='pending')ctx.engine.startPromise=Promise.resolve();if(mode==='recovery')ctx.projectStore.recoveryRequired=true;if(mode==='playing')ctx.engine.playing=true;ctx.workspaceRememberedAt=0;ctx.rememberWorkspace();assert.equal(cache.read(mode),null);ctx.busy=false;ctx.inputActive=()=>false;ctx.engine.startPromise=null;ctx.projectStore.recoveryRequired=false;ctx.engine.playing=false;}
 ctx.projectStore.revision='pagehide';ctx.engine.playing=true;ctx.rememberWorkspace(true);assert.deepEqual(cache.read('pagehide'),state);assert.deepEqual({project,history},before);
});
