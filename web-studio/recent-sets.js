// Recent sets are local snapshots, kept separately from current/previous recovery.
export const RECENT_LIMIT=5;
export const RECENT_BYTE_LIMIT=64*1024*1024;
export const RECENT_INDEX='recent-sets';
export const recentKey=id=>'recent-set:'+id;
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(id);
export function recentIndex(value){
 if(value==null)return {version:1,activeId:null,entries:[]};
 if(value.version!==1||!validId(value.activeId)||!Array.isArray(value.entries)||value.entries.length>RECENT_LIMIT)throw Error('The recent-set list could not be read. Download your current set before clearing browser data.');
 const ids=new Set();let bytes=0;
 for(const item of value.entries){
  if(!item||!validId(item.id)||ids.has(item.id)||item.id===value.activeId||typeof item.name!=='string'||!Number.isFinite(item.savedAt)||!Number.isSafeInteger(item.bytes)||item.bytes<0||!Number.isInteger(item.tracks)||!Number.isInteger(item.clips)||!Number.isFinite(item.bpm))throw Error('The recent-set list is invalid. Your current set is unchanged.');
  ids.add(item.id);bytes+=item.bytes;
 }
 if(bytes>RECENT_BYTE_LIMIT)throw Error('The recent-set list exceeds its storage limit.');
 return structuredClone(value);
}
export function prepareRecentSwitch({index,current,nextId,createId,now=Date.now}){
 const previous=recentIndex(index),currentId=previous.activeId||createId(),activeId=nextId||createId();
 if(!validId(currentId)||!validId(activeId)||activeId===currentId)throw Error('Choose a different recent set.');
 if(nextId&&!previous.entries.some(item=>item.id===nextId))throw Error('That recent set is no longer available. Reopen the list.');
 const snapshot=structuredClone(current),bytes=new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
 const archived=bytes<=RECENT_BYTE_LIMIT;
 const entry={id:currentId,name:current.name,savedAt:now(),bytes,tracks:current.tracks.length,clips:Object.keys(current.clips).length,bpm:current.bpm};
 const candidates=[...(archived?[entry]:[]),...previous.entries.filter(item=>item.id!==activeId&&item.id!==currentId)];
 let total=0;const entries=[];
 for(const item of candidates){if(entries.length>=RECENT_LIMIT||total+item.bytes>RECENT_BYTE_LIMIT)break;entries.push(item);total+=item.bytes;}
 const retained=new Set(entries.map(item=>item.id));
 const writes=previous.entries.filter(item=>!retained.has(item.id)).map(item=>[recentKey(item.id),null]);
 if(archived)writes.push([recentKey(currentId),snapshot]);
 writes.push([RECENT_INDEX,{version:1,activeId,entries}]);
 return {writes,archived};
}
