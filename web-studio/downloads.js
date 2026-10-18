// Keep generated files available for an explicit click if automatic downloads are blocked.
export function createDownloads({createURL=blob=>URL.createObjectURL(blob),revokeURL=url=>URL.revokeObjectURL(url),onChange=()=>{},maxFiles=8,maxBytes=128*1024*1024}={}){
 const files=[];let bytes=0;
 return {
  add(blob,name){
   const entry={url:createURL(blob),name,bytes:blob.size};files.push(entry);bytes+=entry.bytes;const expired=[];
   // Keep at least the newest file, including a single large embedded-media project.
   while(files.length>1&&(files.length>maxFiles||bytes>maxBytes)){const old=files.shift();bytes-=old.bytes;revokeURL(old.url);expired.push(old.url);}
   onChange({ready:{...entry},expired});return {...entry};
  },
  clear(){const expired=files.splice(0).map(f=>f.url);bytes=0;for(const url of expired)revokeURL(url);onChange({expired});},
  snapshot(){return files.map(f=>({...f}));}
 };
}
