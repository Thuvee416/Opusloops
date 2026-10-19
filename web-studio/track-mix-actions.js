export const EXCLUSIVE_SOLO_KEY='opus-exclusive-solo';
export function readExclusiveSolo(storage){try{return storage.getItem(EXCLUSIVE_SOLO_KEY)==='true';}catch{return false;}}
// Selection changes and audio routing remain separate from mixer flag edits.
export function trackMixTargets(project,selected,{clickedId=null,fallbackId=null}={}){
 const available=new Set(project.tracks.map(t=>t.id)),ids=[...new Set(selected)];
 if(ids.some(id=>!available.has(id))||clickedId!==null&&!available.has(clickedId))throw Error('Track Selection Changed. Select The Tracks Again.');
 if(clickedId!==null)return ids.includes(clickedId)?ids:[clickedId];
 if(ids.length)return ids;
 if(available.has(fallbackId))return [fallbackId];
 return [];
}
export function trackMixPlan(project,{action,ids=[],clickedId=null,exclusive=false}){
 if(!['mute','solo','clear_solos'].includes(action))throw Error('Choose A Supported Track Mixer Action.');
 if(typeof exclusive!=='boolean')throw Error('Invalid Solo Mode.');
 const selected=new Set(ids),byId=new Map(project.tracks.map(t=>[t.id,t]));
 if(ids.some(id=>!byId.has(id))||clickedId!==null&&!selected.has(clickedId))throw Error('Track Selection Changed. Select The Tracks Again.');
 if(action==='clear_solos')return project.tracks.filter(t=>t.solo).map(t=>({id:t.id,key:'solo',value:false}));
 if(!selected.size)throw Error('Select At Least One Track.');
 const value=clickedId!==null?!byId.get(clickedId)[action]:![...selected].every(id=>byId.get(id)[action]);
 return project.tracks.flatMap(t=>{const next=selected.has(t.id)?value:action==='solo'&&exclusive&&value?false:t[action];return next!==t[action]?[{id:t.id,key:action,value:next}]:[];});
}
export function trackMixShortcut(e,{trackFocus=false,typing=false,dialog=false,menu=false,keyboard=false}={}){
 if(!trackFocus||typing||dialog||menu||keyboard||e.repeat||e.defaultPrevented||e.isComposing||e.metaKey||e.ctrlKey||e.altKey||e.shiftKey)return null;
 return e.code==='KeyS'?'solo':['Digit0','Numpad0'].includes(e.code)?'mute':null;
}
