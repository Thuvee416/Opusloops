const REVISION_KEY='current-revision';
const conflict=()=>Object.assign(new Error('Another Tab Saved This Workspace. Download This Tab’s Project To Keep Your Edits, Then Reload To Open The Latest Saved Set.'),{name:'ProjectConflictError'});

// The revision read and writes share one IndexedDB transaction. Never acknowledge
// a new revision before commit, including multi-entry replacement/recovery writes.
export class ProjectStore {
 constructor(db,{createRevision=()=>crypto.randomUUID()}={}){this.db=db;this.createRevision=createRevision;this.loaded=false;this.revision=null;}
 async read(key){
  const db=await this.db;
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('projects'),store=tx.objectStore('projects'),read=store.get(key);
   const revision=key==='current'?store.get(REVISION_KEY):null;
   tx.oncomplete=()=>{if(revision&&!this.loaded){this.revision=revision.result??null;this.loaded=true;}resolve(read.result);};
   tx.onabort=()=>reject(tx.error||new Error('Could Not Read The Saved Set.'));
   tx.onerror=()=>{};
  });
 }
 async write(entries,{signal}={}){
  const db=await this.db;signal?.throwIfAborted();
  const updatesCurrent=entries.some(([key])=>key==='current');
  const guarded=updatesCurrent||entries.some(([key])=>key==='session-start');
  if(guarded&&!this.loaded)throw new Error('The Saved Workspace Has Not Loaded. Download Your Project Before Reloading.');
  const nextRevision=updatesCurrent?this.createRevision():null;
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects');let failure=null;
   const abort=()=>{try{tx.abort();}catch{}};
   const clean=()=>signal?.removeEventListener('abort',abort);
   signal?.addEventListener('abort',abort,{once:true});
   tx.oncomplete=()=>{clean();if(updatesCurrent)this.revision=nextRevision;resolve();};
   tx.onabort=()=>{clean();reject(signal?.aborted?new DOMException('Project Operation Cancelled','AbortError'):failure||tx.error||new Error('Could not save this set.'));};
   tx.onerror=()=>{};
   const put=()=>{try{signal?.throwIfAborted();for(const [key,value]of entries)value===null?store.delete(key):store.put(value,key);if(updatesCurrent)store.put(nextRevision,REVISION_KEY);}catch(error){failure=error;abort();}};
   if(guarded){const request=store.get(REVISION_KEY);request.onsuccess=()=>{if((request.result??null)!==this.revision){failure=conflict();abort();}else put();};}
   else put();
  });
 }
}
