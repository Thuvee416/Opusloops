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
