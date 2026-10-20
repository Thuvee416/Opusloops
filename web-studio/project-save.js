import {validateProject} from './model.js';
export function projectSaveName(name){
 if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw Error('Enter A Project Name Of 1–120 Characters.');
 let stem=name.trim().replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,70);
 if(!/[a-zA-Z0-9]/.test(stem))stem='session';
 if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))stem='_'+stem;
 return stem+'.opusloop';
}
export function projectSaveFile(project,name){
 validateProject(project);
 const filename=projectSaveName(name===undefined?(project.name.trim()||'Untitled'):name),next=structuredClone(project);
 if(name!==undefined)next.name=name.trim();validateProject(next);
 return {project:next,name:filename,data:JSON.stringify(next)};
}
// Saving the working set must become durable before it is renamed in memory.
// A copy never changes local storage or edit history.
export async function saveProjectVariant(file,mode,{write,commit,download}){
 if(!['as','copy'].includes(mode))throw Error('Choose Save As Or Save A Copy.');
 if(mode==='as'){await write(file.project);commit(file.project);}
 try{download(file.data,file.name,'application/json');}
 catch(error){if(mode==='as')throw Error('The Named Set Was Saved In This Browser, But Its Download Could Not Start. Use File → Save Live Set To Try Again.',{cause:error});throw error;}
 return {mode,name:file.name,projectName:file.project.name};
}

// A completed File Save must wait for browser durability before offering its file.
// A failed browser write must never prevent the user's portable recovery copy.
export async function saveProjectDownload(file,{persist,isCurrent,download,signal}){
 signal?.throwIfAborted();let localSaveError;
 try{await persist();}catch(error){localSaveError=error?.message||'Browser Storage Unavailable.';}
 signal?.throwIfAborted();const localSaved=!localSaveError&&isCurrent();
 download(file.data,file.name,'application/json');
 return {download:file.name,localSaved,...(localSaveError?{localSaveError}:{})};
}
