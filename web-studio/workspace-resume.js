import {VIEW_SPANS,timelineViewport} from './viewport.js';
export const WORKSPACE_RESUME_KEY='opus-workspace-resume-v1';
const validRevision=value=>typeof value==='string'&&value.length>0&&value.length<=100;
export function workspaceResumeState(value){
 if(!value||!['session','arrangement'].includes(value.view)||![value.position,value.marker].every(n=>Number.isFinite(n)&&n>=0&&n<=16384))return null;
 const v=value.viewport;if(!v||!Number.isFinite(v.start)||!VIEW_SPANS.includes(v.span))return null;
 const viewport=timelineViewport(v.start,v.span);if(viewport.start!==v.start)return null;
 return {view:value.view,position:value.position,marker:value.marker,viewport:{start:viewport.start,span:viewport.span}};
}
// UI only, bound to a committed workspace revision. Other tabs/replacements
// cannot borrow the wrong project's position. Keep a bounded recent cache.
export class WorkspaceResume {
 constructor(storage=()=>localStorage){this.storage=storage;}
 entries(){try{const value=JSON.parse(this.storage().getItem(WORKSPACE_RESUME_KEY));return value?.version===1&&Array.isArray(value.entries)?value.entries.slice(0,8).filter(e=>validRevision(e?.revision)&&workspaceResumeState(e.state)):[];}catch{return [];}}
 read(revision){if(!validRevision(revision))return null;return workspaceResumeState(this.entries().find(e=>e.revision===revision)?.state);}
 save(revision,value){
  const state=workspaceResumeState(value);if(!validRevision(revision)||!state)return false;
  try{const entries=this.entries(),previous=entries.find(e=>e.revision===revision);if(previous&&JSON.stringify(previous.state)===JSON.stringify(state))return true;
   this.storage().setItem(WORKSPACE_RESUME_KEY,JSON.stringify({version:1,entries:[{revision,state},...entries.filter(e=>e.revision!==revision)].slice(0,8)}));return true;
  }catch{return false;}
 }
}
