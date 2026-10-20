export function audioOutputChoices(devices,selected=''){
 const choices=[{id:'',label:'System Default',missing:false}],seen=new Set(['','default']);
 for(const d of devices){if(d.kind!=='audiooutput'||typeof d.deviceId!=='string'||seen.has(d.deviceId))continue;seen.add(d.deviceId);choices.push({id:d.deviceId,label:d.label||'Audio Output '+choices.length,missing:false});}
 if(selected&&!seen.has(selected))choices.push({id:selected,label:'Selected Output Unavailable',missing:true});return choices;
}
// A tab-wide hardware preference, separate from projects and offline render
// snapshots. Commit it only after the browser accepts the requested destination.
export class AudioOutputRoute {
 constructor(){this.id='';this.pending=Promise.resolve();}
 enqueue(fn){const task=this.pending.catch(()=>{}).then(fn);this.pending=task;return task;}
 async route(context,id){
  if(!context||context.state==='closed')throw Error('The Audio Engine Is Closed. Try Again.');
  if(typeof context.setSinkId!=='function'){if(id)throw Error('This Browser Uses The System Audio Output.');return;}
  if(context.sinkId===id)return;
  await context.setSinkId(id);
  if(context.state==='closed')throw Error('The Audio Engine Closed During The Output Change.');
 }
 apply(context){return this.enqueue(()=>this.route(context,this.id));}
 select(context,id){
  if(typeof id!=='string'||id.length>1024)return Promise.reject(Error('Choose An Available Audio Output.'));
  if(id==='default')id='';return this.enqueue(async()=>{await this.route(context,id);this.id=id;return id;});
 }
}
