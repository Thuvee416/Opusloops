// One validated session-start checkpoint, separate from the New/Open previous set.
export function recoveryProject(value,validate){
 if(!value||value.format!=='opus-session-recovery'||value.version!==1||!Number.isFinite(value.savedAt))throw new Error('No valid session-start backup is available.');
 return validate(structuredClone(value.project));
}
export async function loadSession({read,write,validate,now=Date.now}){
 const saved=await read('current');
 if(saved===undefined||saved===null)return {project:null,recovered:false,checkpointError:null};
 let current;
 try{current=validate(structuredClone(saved));}
 catch(error){
  try{return {project:recoveryProject(await read('session-start'),validate),recovered:true,checkpointError:null};}
  catch{throw Object.assign(new Error('The saved session and session-start backup could not be opened. Autosave Is Paused To Protect Them. Download Recovery Data From File → Open Live Set Backups, Then Open A Valid Project Or Create A New Set.',{cause:error}),{name:'ProjectRecoveryError'});}
 }
 let checkpointError=null;
 try{await write([['session-start',{format:'opus-session-recovery',version:1,savedAt:now(),project:current}]]);}
 catch(error){checkpointError=error;}
 return {project:current,recovered:false,checkpointError};
}
