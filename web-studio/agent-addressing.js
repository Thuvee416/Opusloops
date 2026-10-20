import {normalizeHistoryCommand} from './history-control.js';
import {normalizeMusicalAction} from './musical-units.js';
// Odesa speaks displayed scene numbers. Only this boundary converts to engine indices.
export const SCENE_ADDRESSING_VERSION=1;
const owns=(v,k)=>!!v&&Object.hasOwn(v,k);
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw Object.assign(new Error(message),{code:'scene_addressing'});};
function placement(value,{indexKey='scene',displayOnly=false}={}){
 if(!object(value))return value;
 const v=structuredClone(value);
 if(owns(v,'sceneNumber')){
  if(owns(v,indexKey))fail('Use sceneNumber Only; Do Not Mix Displayed Numbers And Internal Indices.');
  if(!Number.isInteger(v.sceneNumber)||v.sceneNumber<1||v.sceneNumber>32)fail('sceneNumber Must Be A Displayed Scene Number From 1 To 32. Scene 1 Uses sceneNumber:1.');
  v[indexKey]=v.sceneNumber-1;delete v.sceneNumber;
 }else if(displayOnly&&owns(v,indexKey))fail('Use sceneNumber With The Number Shown In The Studio, Never An Internal scene Or index Field.');
 return v;
}
function nestedPlacements(v,options){
 v=placement(v,options);if(!object(v))return v;
 if(Array.isArray(v.slots))v.slots=v.slots.map(s=>placement(s,options));
 for(const key of ['destination','primary','fromSlot','toSlot'])if(owns(v,key))v[key]=placement(v[key],options);
 return v;
}
export function normalizeAgentAction(action,{displayOnly=false}={}){
 if(!object(action))return action;
 const out=normalizeMusicalAction(action),args=typeof out.args==='string'?JSON.parse(out.args):out.args;
 if(!object(args))return out;
 if(out.type==='midi')out.args=placement(args,{displayOnly});
 else if(out.type==='scene')out.args=placement(args,{indexKey:'index',displayOnly});
 else if(['session_clips','session_stops'].includes(out.type))out.args=nestedPlacements(args,{displayOnly});
 else if(out.type==='command'){
  out.args=normalizeHistoryCommand(args);
  if(['project_io','select','launch_scene','launch_clip','launch_group','record_input','session_clipboard'].includes(args.name))out.args.args=nestedPlacements(args.args,{displayOnly});
 }else out.args=args;
 return out;
}
export function normalizeAgentActions(actions,options){if(!Array.isArray(actions))return actions;return actions.map(a=>normalizeAgentAction(a,options));}

// Read-only planning data is a separate presentation of engine state. Do not
// convert note indices, beats, slot arrays, loop counts or relative scene moves.
export function displayedSceneData(value){
 if(Array.isArray(value))return value.map(displayedSceneData);
 if(!object(value))return value;
 const out={};for(const [key,item]of Object.entries(value)){
  if(['scene','slot','selectedScene','activeScene'].includes(key)&&(item===null||typeof item==='number')){const name=key==='selectedScene'?'selectedSceneNumber':key==='activeScene'?'activeSceneNumber':'sceneNumber';out[name]=Number.isInteger(item)&&item>=0?item+1:null;}
  else out[key]=displayedSceneData(item);
 }return out;
}

// Ground a single explicit creation destination. Other musical/compound scene
// intentions remain model planned; this is not a general semantic interpreter.
export function readCreationSceneRequirement(prompt){
 if(typeof prompt!=='string')return null;
 const text=prompt.replace(/["“][^"”]*["”]/g,''),refs=[...text.matchAll(/\bscene\s+([1-9]\d*)\b/gi)].map(m=>Number(m[1]));
 if(new Set(refs).size!==1||refs[0]>32)return null;
 if(!/\b(?:create|write|compose|make|needs?|put|place)\b[^.;\n]*\b(?:MIDI\s+clip|clip|pattern)\b[^.;\n]*\bin\s+(?:displayed\s+)?scene\s+([1-9]\d*)\b/i.test(text))return null;
 return {sceneNumber:refs[0]};
}
export function checkCreationSceneRequirement(actions,requirement){
 if(!requirement)return null;
 const creations=normalizeAgentActions(actions).filter(a=>a?.type==='midi'&&!a.args?.clipId);
 if(!creations.length||creations.some(a=>a.args?.scene!==requirement.sceneNumber-1))fail('The Original Request Creates New MIDI Clips In Displayed Scene '+requirement.sceneNumber+'. Every New MIDI Action Must Use sceneNumber:'+requirement.sceneNumber+'. Do Not Subtract One Or Omit The Session Destination.');
 return {sceneNumber:requirement.sceneNumber,count:creations.length};
}

export function displaySceneContractText(text){return text
 .replace(/"scene"\s*:\s*(\d+)/g,(_,n)=>'"sceneNumber":'+(Number(n)+1))
 .replace(/\bscene\s*[:=]\s*(\d+)/g,(_,n)=>'sceneNumber:'+(Number(n)+1))
 .replace(/\bscene(?=\??\s*[:,}(])/g,'sceneNumber')
 .replace(/\.scene\b/g,'.sceneNumber')
 .replace(/zero-based (?:Session )?scene(?: indices| index)?/gi,'displayed sceneNumber')
 .replace(/zero-based Session slot/g,'displayed sceneNumber')
 .replace(/(sceneNumber\??) \(zero-based[^)]*\)/g,'$1 (one-based, as shown in the Studio)')
 .replace(/endpoints are already zero-based/g,'endpoints already use displayed sceneNumber')
 .replace(/bound zero-based endpoints/g,'bound displayed sceneNumber endpoints');}

