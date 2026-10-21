const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
const api=()=>import('../web-studio/autosave.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}

test('autosave serializes and coalesces edits without reporting a newer unsaved revision as saved',async()=>{
 const {Autosave}=await api(),gates=[],writes=[],states=[];let project={name:'One',notes:[60]};
 const save=new Autosave({snapshot:()=>structuredClone(project),write:p=>{writes.push(p);const gate=deferred();gates.push(gate);return gate.promise;},onState:s=>states.push(s)});
 save.mark();const pending=save.flush();assert.equal(save.flush(),pending);project.notes[0]=62;save.mark();project.name='Three';save.mark();
 assert.deepEqual(writes,[{name:'One',notes:[60]}]);gates[0].resolve();await tick();assert.equal(writes.length,2);assert.deepEqual(writes[1],project);assert.equal(save.dirty,true);assert.ok(states.every(s=>s.dirty));
 gates[1].resolve();await pending;assert.equal(save.dirty,false);assert.equal(states.at(-1).dirty,false);assert.equal(states.at(-1).saving,false);
});

test('failed autosave retains dirty state and retries the newest independent snapshot',async()=>{
 const {Autosave}=await api();let project={name:'One'},fail=true;const writes=[];
 const save=new Autosave({snapshot:()=>structuredClone(project),write:async p=>{if(fail)throw Error('Quota Exceeded');writes.push(p);}});
 save.mark();await assert.rejects(save.flush(),/Quota Exceeded/);assert.equal(save.dirty,true);assert.match(save.error.message,/Quota/);assert.equal(save.running,null);
 project.name='Two';save.mark();fail=false;await save.flush();assert.equal(save.error,null);assert.equal(save.dirty,false);assert.deepEqual(writes,[{name:'Two'}]);
});

test('snapshot failure remains recoverable and a locked writer preserves pending changes',async()=>{
 const {Autosave}=await api();let blocked=true,fail=true,writes=0;
 const save=new Autosave({canWrite:()=>!blocked,snapshot:()=>{if(fail)throw Error('Clone Failed');return {name:'Recovered'};},write:async()=>writes++});
 save.mark();await save.flush();assert.equal(save.dirty,true);assert.equal(writes,0);blocked=false;await assert.rejects(save.flush(),/Clone Failed/);assert.equal(save.dirty,true);fail=false;await save.flush();assert.equal(writes,1);assert.equal(save.dirty,false);
});

test('actual project lock drains an older autosave before replacing the stored set',async()=>{
 const {Autosave}=await api(),gate=deferred(),writes=[];let project={name:'Original'},first=true;
 const ctx={busy:false,engine:{},stopToEdit(){},renderTransport(){},saveTimer:null,clearTimeout(){},scheduleSave(){ctx.autosave.mark();}};
 ctx.autosave=new Autosave({snapshot:()=>structuredClone(project),canWrite:()=>!ctx.busy,write:async p=>{if(first){first=false;await gate.promise;}writes.push(p.name);}});
 vm.createContext(ctx);vm.runInContext(extract('async function withSetLock(','\nconst lifecycleRun'),ctx);
 ctx.autosave.mark();const saving=ctx.autosave.flush();project.name='Last Edit';ctx.autosave.mark();let installed=false;
 const replacing=ctx.withSetLock(async()=>{assert.deepEqual(writes,['Original']);writes.push('Opened');project={name:'Opened'};installed=true;});
 await tick();assert.equal(installed,false);assert.equal(ctx.busy,true);gate.resolve();await saving;await replacing;assert.equal(ctx.busy,false);await ctx.autosave.flush();assert.deepEqual(writes,['Original','Opened','Opened']);assert.equal(ctx.autosave.dirty,false);
});

test('actual storage writer rejects an abort without an error event and leaves autosave dirty',async()=>{
 const {Autosave}=await api(),{ProjectStore}=await import('../web-studio/project-store.js');let tx,stored,request;
 const db={transaction:()=>tx={objectStore:()=>({get:()=>request={result:null},put:(p,key)=>{if(key==='current')stored=p;}}),error:null}},projectStore=new ProjectStore(Promise.resolve(db),{createRevision:()=> 'revision'}),ctx={projectStore};
 projectStore.loaded=true;
 vm.createContext(ctx);vm.runInContext(extract('async function writeSets(','\nasync function withSetLock'),ctx);
 const save=new Autosave({snapshot:()=>({name:'Song'}),write:p=>ctx.writeSets([['current',p]])});save.mark();const pending=save.flush();await tick();request.onsuccess();assert.equal(stored.name,'Song');tx.onabort();await assert.rejects(pending,/Could not save/);assert.equal(save.dirty,true);
 const retry=save.flush();await tick();request.onsuccess();tx.oncomplete();await retry;assert.equal(save.dirty,false);
});

test('actual changed handler marks Undo dirty even when history has already moved',async()=>{
 const {Autosave}=await api(),{History}=await import('../web-studio/history.js');let callback,writes=[];
 const ctx={project:{name:'One',sceneNames:[]},engine:{playing:false,recording:false,automationTake:null,automationOverrides:new Set()},historyMixerStates:new WeakMap(),sessionProjectRevision:0,view:'session',saveTimer:null,renderMixer(){},renderAutomation(){},sceneNames:()=>[],renderManagement(){},updateHistory(){},renderTransport(){},renderGrid(){},renderTimeline(){},clearTimeout(){},setTimeout:fn=>{callback=fn;return 1;},structuredClone};
 ctx.history=new History(ctx.project);ctx.project.name='Two';ctx.history.commit(ctx.project);ctx.project=ctx.history.undo();
 ctx.autosave=new Autosave({snapshot:()=>structuredClone(ctx.project),write:async p=>writes.push(p.name)});vm.createContext(ctx);
 vm.runInContext(extract('function persist()','\nfunction install(p,'),ctx);ctx.changed();assert.equal(ctx.sessionProjectRevision,0);assert.equal(ctx.autosave.dirty,true);await callback();assert.deepEqual(writes,['One']);assert.equal(ctx.autosave.dirty,false);
});

test('exit guard warns only for unsaved edits or a pending take and attempts pagehide flush',async()=>{
 const {installSaveExitGuard}=await api(),listeners=new Map();let pending=false,saves=0,prevented=0;
 const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const cleanup=installSaveExitGuard({window,pending:()=>pending,flush:async()=>{saves++;throw Error('Storage Unavailable');}}),event={preventDefault:()=>prevented++};
 listeners.get('beforeunload')(event);assert.equal(prevented,0);assert.equal(saves,0);assert.equal(event.returnValue,undefined);
 pending=true;listeners.get('beforeunload')(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');assert.equal(saves,1);listeners.get('pagehide')();assert.equal(saves,2);await tick();cleanup();assert.equal(listeners.size,0);
});

test('hidden-page handler flushes immediately and again after asynchronous capture commits',async()=>{
 const gate=deferred(),writes=[];let listener,project='Before Take',stopped=false;
 const ctx={document:{hidden:true,addEventListener:(_,fn)=>listener=fn},engine:{playing:true,stop(){stopped=true;}},releaseNotes(){},cancelMidiGesture(){},cancelWarpDrag(){},cancelRegionDrag(){},cancelAutomationPointDrag(){},inputActive:()=>true,run:fn=>fn,finishInput:async()=>{await gate.promise;project='With Take';},persist:async()=>writes.push(project),setStatus(){},clearTimeout(){},saveTimer:null,Promise};
 vm.createContext(ctx);vm.runInContext(extract("document.addEventListener('visibilitychange',()=>{","\ninstallSaveExitGuard"),ctx);
 listener();assert.equal(stopped,true);assert.deepEqual(writes,['Before Take']);gate.resolve();await tick();assert.deepEqual(writes,['Before Take','With Take']);ctx.document.hidden=false;listener();assert.equal(writes.length,2);
});

test('a mixer input marks autosave before pointer release or its change event',async()=>{
 let listener,marked=0;const track={id:'track',volume:.8},ctx={$:()=>({addEventListener:(_,fn)=>listener=fn}),run:fn=>fn,project:{tracks:[track]},engine:{overrideAutomation(){},updateMix(){}},scheduleSave:()=>marked++};
 vm.createContext(ctx);vm.runInContext(extract("$('mixer').addEventListener('input'","\n$('mixer').addEventListener('change'"),ctx);
 listener({target:{closest:()=>({dataset:{channel:'track'}}),hasAttribute:name=>name==='data-volume',dataset:{},value:'.4'}});assert.equal(track.volume,.4);assert.equal(marked,1);
});

test('a temporarily busy operation reschedules pending autosave without requiring another edit',async()=>{
 const {Autosave}=await api(),timers=new Map();let busy=true,writes=0,id=0;
 const ctx={saveTimer:null,setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)};
 ctx.autosave=new Autosave({snapshot:()=>({name:'Pending'}),canWrite:()=>!busy,write:async()=>writes++});
 vm.createContext(ctx);vm.runInContext(extract('function persist()','\nfunction changed('),ctx);
 ctx.scheduleSave();let callback=timers.get(ctx.saveTimer);await callback();assert.equal(writes,0);assert.equal(timers.size,1);assert.equal(ctx.autosave.dirty,true);
 busy=false;callback=timers.get(ctx.saveTimer);await callback();assert.equal(writes,1);assert.equal(timers.size,0);assert.equal(ctx.autosave.dirty,false);
});
