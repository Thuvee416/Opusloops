const REVISION_KEY='current-revision';
export const DAMAGED_SESSION_KEY='damaged-session';
const conflict=()=>Object.assign(new Error('Another Tab Saved This Workspace. Download This Tab’s Project To Keep Your Edits, Then Reload To Open The Latest Saved Set.'),{name:'ProjectConflictError'});
const recoveryError=()=>Object.assign(new Error('Autosave Is Paused To Protect Unreadable Saved Data. Download Your Current Work, Then Open A Valid Project Or Create A New Set. Recovery Data Is Available In File → Open Live Set Backups.'),{name:'ProjectRecoveryError'});

// The revision read and writes share one IndexedDB transaction. Never acknowledge
// a new revision before commit, including multi-entry replacement/recovery writes.
export class ProjectStore {
 constructor(db,{createRevision=()=>crypto.randomUUID()}={}){this.db=db;this.createRevision=createRevision;this.loaded=false;this.revision=null;}
 protectUnreadable(){this.recoveryRequired=true;}
 preserveUnreadable(){this.archivePending=true;}
 async recoveryData(){
  if(!this.recoveryRequired&&!this.archivePending)return this.read(DAMAGED_SESSION_KEY);
  const db=await this.db;
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('projects'),store=tx.objectStore('projects'),current=store.get('current'),checkpoint=store.get('session-start'),revision=store.get(REVISION_KEY);
   tx.oncomplete=()=>{if((revision.result??null)!==this.revision){reject(conflict());return;}resolve({format:'opus-recovery-data',version:1,savedAt:Date.now(),current:current.result,sessionStart:checkpoint.result});};
   tx.onabort=()=>reject(tx.error||new Error('Could Not Read Recovery Data.'));tx.onerror=()=>{};
  });
 }
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
 async write(entries,{signal,recover=false}={}){
  const db=await this.db;signal?.throwIfAborted();
  const updatesCurrent=entries.some(([key])=>key==='current');
  const guarded=updatesCurrent||entries.some(([key])=>key==='session-start');
  if(guarded&&!this.loaded)throw new Error('The Saved Workspace Has Not Loaded. Download Your Project Before Reloading.');
  if(guarded&&this.recoveryRequired&&(!recover||!updatesCurrent))throw recoveryError();
  const preserveDamaged=updatesCurrent&&(this.archivePending||this.recoveryRequired&&recover);
  const nextRevision=updatesCurrent?this.createRevision():null;
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects');let failure=null;
   const abort=()=>{try{tx.abort();}catch{}};
   const clean=()=>signal?.removeEventListener('abort',abort);
   signal?.addEventListener('abort',abort,{once:true});
   tx.oncomplete=()=>{clean();if(updatesCurrent)this.revision=nextRevision;if(preserveDamaged){this.recoveryRequired=false;this.archivePending=false;}resolve();};
   tx.onabort=()=>{clean();reject(signal?.aborted?new DOMException('Project Operation Cancelled','AbortError'):failure||tx.error||new Error('Could not save this set.'));};
   tx.onerror=()=>{};
   const put=()=>{try{signal?.throwIfAborted();for(const [key,value]of entries)value===null?store.delete(key):store.put(value,key);if(updatesCurrent)store.put(nextRevision,REVISION_KEY);}catch(error){failure=error;abort();}};
   const prepare=()=>{
    if(!preserveDamaged){put();return;}
    const current=store.get('current'),checkpoint=store.get('session-start');
    checkpoint.onsuccess=()=>{try{store.put({format:'opus-recovery-data',version:1,savedAt:Date.now(),current:current.result,sessionStart:checkpoint.result},DAMAGED_SESSION_KEY);put();}catch(error){failure=error;abort();}};
   };
   if(guarded){const request=store.get(REVISION_KEY);request.onsuccess=()=>{if((request.result??null)!==this.revision){failure=conflict();abort();}else prepare();};}
   else put();
  });
 }
}
