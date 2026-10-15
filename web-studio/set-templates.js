import {uid,validateProject} from './model.js';
export const TEMPLATE_MAX_BYTES=150*1024*1024;
export function templateName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new Error('Enter a template name of 1–80 characters.');return value.trim();}
export function validateTemplate(value){
 if(!value||value.format!=='opus-template'||value.version!==1)throw new Error('Choose an OPUS template file (.opustemplate).');
 templateName(value.name);validateProject(value.project);
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>TEMPLATE_MAX_BYTES)throw new Error('Templates must be smaller than 150 MB.');
 return value;
}
export function createTemplate(project,name){return validateTemplate({format:'opus-template',version:1,name:templateName(name),project:structuredClone(project)});}
export function templateSet(template){const next=structuredClone(validateTemplate(template).project);next.name='Untitled session';return next;}
let pending;
function database(){return pending??=new Promise((resolve,reject)=>{const r=indexedDB.open('opus-set-templates',1);r.onupgradeneeded=()=>{r.result.createObjectStore('sets');r.result.createObjectStore('index',{keyPath:'id'}).createIndex('nameKey','nameKey',{unique:true});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{pending=null;reject(r.error);};});}
export async function listTemplates(){const db=await database();return new Promise((resolve,reject)=>{const r=db.transaction('index').objectStore('index').getAll();r.onsuccess=()=>resolve(r.result.sort((a,b)=>a.name.localeCompare(b.name)));r.onerror=()=>reject(r.error);});}
export async function getTemplate(id){const db=await database();return new Promise((resolve,reject)=>{const r=db.transaction('sets').objectStore('sets').get(id);r.onsuccess=()=>{try{resolve(validateTemplate(r.result));}catch(error){reject(error);}};r.onerror=()=>reject(r.error);});}
export async function saveTemplate(template,id=uid()){
 template=structuredClone(validateTemplate(template));template.name=templateName(template.name);const db=await database();
 return new Promise((resolve,reject)=>{const tx=db.transaction(['sets','index'],'readwrite'),index=tx.objectStore('index');let failure;
 tx.oncomplete=()=>resolve(id);tx.onabort=()=>reject(failure||new Error(tx.error?.name==='ConstraintError'?'That template name already exists. Choose another name, or select it and use Replace.':'Template could not be saved. Browser storage may be full.'));tx.onerror=()=>{};
 const count=index.count();count.onsuccess=()=>{const existing=index.get(id);existing.onsuccess=()=>{if(!existing.result&&count.result>=64){failure=new Error('The template library supports 64 templates. Download and remove one first.');tx.abort();return;}try{tx.objectStore('sets').put(template,id);index.put({id,name:template.name,nameKey:template.name.toLocaleLowerCase('en-US'),tracks:template.project.tracks.length,clips:Object.keys(template.project.clips).length,bpm:template.project.bpm});}catch(error){failure=error;tx.abort();}};};
 });
}
export async function removeTemplate(id){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction(['sets','index'],'readwrite');tx.objectStore('sets').delete(id);tx.objectStore('index').delete(id);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Could not remove template.'));});}
