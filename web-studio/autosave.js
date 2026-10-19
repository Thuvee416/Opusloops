// Serialize snapshots so an older write cannot acknowledge a newer edit.
export class Autosave {
 constructor({snapshot,write,canWrite=()=>true,onState=()=>{}}){
  Object.assign(this,{snapshot,write,canWrite,onState});
  this.revision=0;this.savedRevision=0;this.running=null;this.error=null;
 }
 get dirty(){return this.revision!==this.savedRevision;}
 publish(){this.onState({dirty:this.dirty,saving:!!this.running,error:this.error});}
 mark(){this.revision++;this.error=null;this.publish();}
 settle(){return this.running??Promise.resolve();}
 flush(){
  if(this.running)return this.running;
  if(!this.dirty||!this.canWrite())return Promise.resolve();
  this.running=(async()=>{
   try{
    while(this.dirty&&this.canWrite()){
     const revision=this.revision,snapshot=this.snapshot();
     await this.write(snapshot);
     this.savedRevision=revision;this.error=null;this.publish();
    }
   }catch(error){this.error=error;throw error;}
  })().finally(()=>{this.running=null;this.publish();});
  this.publish();return this.running;
 }
}

// Browser lifecycle events are best effort, not a guarantee against forced exit.
export function installSaveExitGuard({window,flush,pending}){
 const save=()=>{try{Promise.resolve(flush()).catch(()=>{});}catch{}};
 const beforeUnload=event=>{
  if(!pending())return;
  save();event.preventDefault();event.returnValue='';
 };
 window.addEventListener('beforeunload',beforeUnload);
 window.addEventListener('pagehide',save);
 return ()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',save);};
}
