const {test}=require('node:test'),assert=require('node:assert/strict');
// Controlled IndexedDB transaction boundary: requests and commits are serialized,
// writes are staged, and abort discards all entries. This is not a browser test.
function database(entries=[]){
 const data=new Map(entries),queue=[];let running=false;
 const db={data,failCommit:false,failPut:null,hold:null,transaction(){
  const ops=[],tx={error:null,aborted:false,abort(){this.aborted=true;},objectStore:()=>({
   get(key){const r={};ops.push(stage=>{r.result=structuredClone(stage.get(key));r.onsuccess?.();});return r;},
   put(value,key){if(db.failPut===key)throw Error('Clone Failed');const snapshot=structuredClone(value);ops.push(stage=>stage.set(key,snapshot));},
   delete(key){ops.push(stage=>stage.delete(key));}
  })};
  queue.push({tx,ops});queueMicrotask(drain);return tx;
 }};
 async function drain(){
  if(running)return;running=true;
  while(queue.length){
   const {tx,ops}=queue.shift(),stage=structuredClone(data);
   if(db.hold){const gate=db.hold;db.hold=null;await gate;}
   while(ops.length&&!tx.aborted)ops.shift()(stage);
   if(db.failCommit){db.failCommit=false;tx.aborted=true;tx.error=Error('Quota Exceeded');}
   if(tx.aborted)tx.onabort?.();else{data.clear();for(const [k,v]of stage)data.set(k,v);tx.oncomplete?.();}
  }
  running=false;
 }
 return db;
}
async function setup(entries=[['current',{name:'Original',media:'embedded'}]]){
 const {ProjectStore}=await import('../web-studio/project-store.js'),db=database(entries);let serial=0;
 const create=()=>new ProjectStore(Promise.resolve(db),{createRevision:()=>String(++serial)});
 const a=create(),b=create();await Promise.all([a.read('current'),b.read('current')]);return {db,a,b,create};
}

test('two tabs sharing a starting revision cannot overwrite one another, including simultaneous writes',async()=>{
 const {db,a,b}=await setup();
 const results=await Promise.allSettled([a.write([['current',{name:'First',media:'audio A'}]]),b.write([['current',{name:'Second',media:'audio B'}]])]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.name,'ProjectConflictError');
 assert.deepEqual(db.data.get('current'),{name:'First',media:'audio A'});assert.equal(a.revision,'1');assert.equal(b.revision,null);
 await assert.rejects(b.write([['current',{name:'Retry'}]]),{name:'ProjectConflictError'});assert.equal(db.data.get('current').name,'First');
});

test('stale New/Open and recovery checkpoints leave every durable entry untouched',async()=>{
 const {db,a,b}=await setup();await a.write([['current',{name:'Latest'}],['previous',{name:'Previous'}],['recent-sets',{entries:['latest']}],['session-start',{project:{name:'Checkpoint'}}]]);
 const before=structuredClone(db.data);
 await assert.rejects(b.write([['previous',{name:'Stale'}],['current',{name:'New'}],['recent-sets',{entries:['wrong']}]]),{name:'ProjectConflictError'});
 await assert.rejects(b.write([['session-start',{project:{name:'Stale Checkpoint'}}]]),{name:'ProjectConflictError'});
 assert.deepEqual(db.data,before);
});

test('failed commits and synchronous cloning errors never advance the tab revision or partially replace backups',async()=>{
 for(const mode of ['quota','clone']){
  const {db,a}=await setup();const before=structuredClone(db.data);if(mode==='quota')db.failCommit=true;else db.failPut='current';
  await assert.rejects(a.write([['previous',{name:'Backup'}],['current',{name:'Next'}]]),/Quota|Clone/);assert.equal(a.revision,null);assert.deepEqual(db.data,before);
  db.failPut=null;await a.write([['previous',{name:'Backup'}],['current',{name:'Next'}]]);assert.equal(db.data.get('current').name,'Next');assert.equal(db.data.get('previous').name,'Backup');
 }
});

test('abort before or during the transaction preserves current media and the expected revision',async()=>{
 for(const during of [false,true]){
  const {db,a}=await setup(),before=structuredClone(db.data),controller=new AbortController();let resume;
  if(during)db.hold=new Promise(r=>resume=r);else controller.abort();
  const saving=a.write([['current',{name:'Replacement'}]],{signal:controller.signal});if(during){await new Promise(r=>setImmediate(r));controller.abort();resume();}
  await assert.rejects(saving,{name:'AbortError'});assert.deepEqual(db.data,before);assert.equal(a.revision,null);
 }
});

test('same-tab queued saves advance in order and a new tab can load the final project and continue',async()=>{
 const {db,a,create}=await setup();await Promise.all([a.write([['current',{name:'One'}]]),a.write([['current',{name:'Two'}]])]);
 assert.equal(db.data.get('current').name,'Two');assert.equal(a.revision,db.data.get('current-revision'));
 const fresh=create();assert.equal((await fresh.read('current')).name,'Two');await fresh.write([['current',{name:'Three'}]]);
 assert.equal(db.data.get('current').name,'Three');await assert.rejects(a.write([['current',{name:'Stale'}]]),{name:'ProjectConflictError'});
});

test('first save migrates an existing or empty store without changing project-file format',async()=>{
 for(const entries of [[],[['current',{name:'Legacy',media:'old audio'}]]]){
  const {db,a}=await setup(entries);assert.equal(a.revision,null);await a.write([['current',{name:'Saved',media:'audio'}]]);
  assert.deepEqual(db.data.get('current'),{name:'Saved',media:'audio'});assert.equal(typeof db.data.get('current-revision'),'string');
  await a.write([['default',{name:'Template'}]]);assert.equal(db.data.get('default').name,'Template');
 }
});

test('autosave conflict stays dirty and downloading the in-memory project remains possible',async()=>{
 const {a,b,db}=await setup(),{Autosave}=await import('../web-studio/autosave.js'),{emptyProject}=await import('../web-studio/model.js'),{projectSaveFile}=await import('../web-studio/project-save.js');
 const project=emptyProject();project.name='Unsaved Work';const autosave=new Autosave({snapshot:()=>structuredClone(project),write:p=>b.write([['current',p]])});
 await a.write([['current',{name:'Other Tab'}]]);autosave.mark();await assert.rejects(autosave.flush(),{name:'ProjectConflictError'});
 assert.equal(autosave.dirty,true);assert.equal(autosave.error.name,'ProjectConflictError');assert.equal(db.data.get('current').name,'Other Tab');
 const file=projectSaveFile(project);assert.equal(JSON.parse(file.data).name,'Unsaved Work');
});

test('no guarded writes are allowed before the initial current-project read completes',async()=>{
 const {create}=await setup(),tab=create();await assert.rejects(tab.write([['current',{name:'Too Early'}]]),/Has Not Loaded/);
 await tab.read('current');await tab.write([['current',{name:'Ready'}]]);
});

test('a failed initial read cannot authorize a later save, and rereading never silently accepts another tab revision',async()=>{
 const {db,a,b,create}=await setup(),unloaded=create();db.failCommit=true;
 await assert.rejects(unloaded.read('current'),/Quota/);assert.equal(unloaded.loaded,false);
 await assert.rejects(unloaded.write([['current',{name:'Too Early'}]]),/Has Not Loaded/);
 await a.write([['current',{name:'Latest'}]]);assert.equal((await b.read('current')).name,'Latest');
 await assert.rejects(b.write([['current',{name:'Old In-Memory Copy'}]]),{name:'ProjectConflictError'});
 assert.equal(db.data.get('current').name,'Latest');
});

async function brokenWorkspace(checkpoint={format:'broken',project:{notes:[60,64]}}){
 const saved={broken:true,media:{audio:'preserve these original bytes'}};
 const f=await setup([['current',saved],['session-start',checkpoint]]),api=Object.assign({},...await Promise.all(['model','session-recovery','project-lifecycle','recent-sets'].map(n=>import('../web-studio/'+n+'.js'))));
 const vm=require('node:vm'),source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8'),controls={'save-state':{},'download-recovery-data':{}};
 const ctx={...api,projectStore:f.a,readSet:k=>f.a.read(k),writeSets:(entries,options)=>f.a.write(entries,options),demo:()=>api.emptyProject(),setStatus(){},$:id=>controls[id],animate(){},changed(){},install:p=>ctx.project=p,run:fn=>fn,download:(data,name)=>{ctx.downloaded={data,name};}};
 vm.createContext(ctx);const start=source.indexOf('try{\n const saved=await loadSession('),end=source.indexOf('animate();',start)+'animate();'.length;
 await vm.runInContext('(async()=>{'+source.slice(start,end)+'})()',ctx);
 const begin=source.indexOf('async function replaceSet(');vm.runInContext(source.slice(begin,source.indexOf('\nconst historyButton',begin)),ctx);
 const handler=source.indexOf("$('download-recovery-data').onclick=");vm.runInContext(source.slice(handler,source.indexOf('\n',handler)),ctx);
 return {...f,api,ctx,controls,saved,checkpoint};
}

test('actual failed startup protects unreadable data from demo edits and checkpoint overwrites',async()=>{
 const f=await brokenWorkspace(),{Autosave}=await import('../web-studio/autosave.js');assert.equal(f.a.recoveryRequired,true);assert.match(f.controls['save-state'].textContent,/Recovery Needed/);
 const before=structuredClone(f.db.data);f.ctx.project.name='Edited Demo';
 const autosave=new Autosave({snapshot:()=>structuredClone(f.ctx.project),write:p=>f.a.write([['current',p]])});autosave.mark();
 await assert.rejects(autosave.flush(),{name:'ProjectRecoveryError'});assert.equal(autosave.dirty,true);
 await assert.rejects(f.a.write([['session-start',{project:f.ctx.project}]]),{name:'ProjectRecoveryError'});assert.deepEqual(f.db.data,before);
});

test('actual replacement preserves raw data atomically, then allows normal autosave and later recovery download',async()=>{
 const f=await brokenWorkspace(),next=f.api.emptyProject();next.name='Opened Set';await f.ctx.replaceSet(next);
 assert.equal(f.a.recoveryRequired,false);assert.equal(f.db.data.get('current').name,'Opened Set');assert.equal(f.ctx.project.name,'Opened Set');
 const archived=f.db.data.get('damaged-session');assert.deepEqual(archived.current,f.saved);assert.deepEqual(archived.sessionStart,f.checkpoint);
 next.name='Continued';await f.a.write([['current',next]]);const fresh=f.create();await fresh.read('current');assert.deepEqual(await fresh.recoveryData(),archived);
 await f.controls['download-recovery-data'].onclick();assert.equal(f.ctx.downloaded.name,'opus-recovery-data.json');assert.deepEqual(JSON.parse(f.ctx.downloaded.data),archived);
});

test('raw recovery download works before replacement without writing or validating damaged payloads',async()=>{
 const f=await brokenWorkspace(),before=structuredClone(f.db.data);await f.controls['download-recovery-data'].onclick();
 const downloaded=JSON.parse(f.ctx.downloaded.data);assert.equal(downloaded.format,'opus-recovery-data');assert.deepEqual(downloaded.current,f.saved);assert.deepEqual(downloaded.sessionStart,f.checkpoint);
 assert.deepEqual(f.db.data,before);assert.equal(f.a.recoveryRequired,true);
});

test('failed archive preparation or commit leaves unreadable data, old archive and protection intact',async()=>{
 for(const mode of ['clone','quota']){
  const f=await brokenWorkspace();f.db.data.set('damaged-session',{older:'preserve on failure'});const before=structuredClone(f.db.data);
  if(mode==='clone')f.db.failPut='damaged-session';else{const read=f.ctx.readSet;f.ctx.readSet=async key=>{const value=await read(key);f.db.failCommit=true;return value;};}
  await assert.rejects(f.ctx.replaceSet(f.api.emptyProject()),/Clone|Quota/);assert.deepEqual(f.db.data,before);assert.equal(f.a.recoveryRequired,true);
 }
});

test('recovery cannot bypass a newer tab save or download a mismatched workspace as the damaged source',async()=>{
 const f=await brokenWorkspace();await f.b.write([['current',{name:'Other Tab Saved'}]]);const before=structuredClone(f.db.data);
 await assert.rejects(f.a.recoveryData(),{name:'ProjectConflictError'});
 await assert.rejects(f.ctx.replaceSet(f.api.emptyProject()),{name:'ProjectConflictError'});assert.deepEqual(f.db.data,before);assert.equal(f.a.recoveryRequired,true);
});

test('successful checkpoint fallback archives unreadable current data on its first save without blocking normal editing',async()=>{
 const {emptyProject}=await import('../web-studio/model.js'),backup=emptyProject();backup.name='Earlier Checkpoint';
 const checkpoint={format:'opus-session-recovery',version:1,savedAt:1,project:backup},f=await brokenWorkspace(checkpoint);
 assert.equal(f.ctx.project.name,'Earlier Checkpoint');assert.equal(f.a.archivePending,true);assert.equal(!!f.a.recoveryRequired,false);
 assert.deepEqual((await f.a.recoveryData()).current,f.saved);
 const next=structuredClone(f.ctx.project);next.name='Recovered And Edited';f.db.failCommit=true;
 await assert.rejects(f.a.write([['current',next]]),/Quota/);assert.deepEqual(f.db.data.get('current'),f.saved);assert.equal(f.a.archivePending,true);
 await f.a.write([['current',next]]);assert.equal(f.a.archivePending,false);assert.equal(f.db.data.get('current').name,'Recovered And Edited');
 assert.deepEqual(f.db.data.get('damaged-session').current,f.saved);assert.deepEqual(f.db.data.get('damaged-session').sessionStart,checkpoint);
});
