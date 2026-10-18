import {validateProject} from './model.js';
import {validateClipLaunch} from './launch.js';

// Source properties are shared by every Session/Arrangement placement of a clip.
export const CLIP_COLORS=[['Coral','#ed795e'],['Amber','#e3b75b'],['Lime','#b4c775'],['Teal','#62b5a5'],['Blue','#81a8cf'],['Violet','#ae91cf'],['Rose','#ce94af'],['Graphite','#939b99']];
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const clipLaunchValues=clip=>({mode:clip.launch?.mode??'trigger',quantization:clip.launch?.quantization??'global',legato:clip.launch?.legato??false});
export const clipColor=(clip,track)=>clip?.color??track?.color??'#939b99';
export function clipPropertyIds(project,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>512||ids.some(id=>typeof id!=='string'||!own(project.clips,id)))throw new Error('Choose Existing Clip Source IDs.');
 return [...new Set(ids)];
}
export function clipPropertySummary(project,ids){
 const unique=clipPropertyIds(project,ids),clips=unique.map(id=>project.clips[id]);
 const common=read=>{const values=clips.map(read);return values.every(v=>v===values[0])?{mixed:false,value:values[0]}:{mixed:true,value:null};};
 return {ids:unique,count:unique.length,name:common(c=>c.name),color:common(c=>c.color??null),infoText:common(c=>c.infoText??''),launch:Object.fromEntries(['mode','quantization','legato'].map(key=>[key,common(c=>clipLaunchValues(c)[key])])),placements:unique.map(clipId=>({clipId,session:project.tracks.flatMap(t=>t.slots.flatMap((id,scene)=>id===clipId?[{trackId:t.id,scene}]:[])),regions:project.arrangement.filter(r=>r.clipId===clipId).map(r=>r.id)}))};
}
export function editClipProperties(project,intent){
 if(!object(intent)||Object.keys(intent).some(k=>!['ids','changes'].includes(k)))throw new Error('Clip Properties Accept ids And changes Only.');
 const ids=clipPropertyIds(project,intent.ids),changes=intent.changes;
 if(!object(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!['name','color','infoText','launch'].includes(k)))throw new Error('Choose name, color, infoText Or launch Clip Properties.');
 if(own(changes,'name')&&(typeof changes.name!=='string'||!changes.name.trim()||changes.name.length>200))throw new Error('Clip Name Must Contain 1–200 Characters.');
 if(own(changes,'color')&&changes.color!==null&&(typeof changes.color!=='string'||!/^#[0-9a-f]{6}$/i.test(changes.color)))throw new Error('Clip Color Must Be A Six-Digit Hex Color Or null To Follow Its Track.');
 if(own(changes,'infoText')&&(typeof changes.infoText!=='string'||changes.infoText.length>4000))throw new Error('Clip Info Text Must Contain At Most 4,000 Characters.');
 if(own(changes,'launch')&&(!object(changes.launch)||!Object.keys(changes.launch).length||Object.keys(changes.launch).some(k=>!['mode','quantization','legato'].includes(k))))throw new Error('Clip Launch Patch Accepts mode, quantization And legato Only.');
 const next=structuredClone(project);
 for(const id of ids){const c=next.clips[id];
  if(own(changes,'name'))c.name=changes.name.trim();
  if(own(changes,'color')){if(changes.color===null)delete c.color;else c.color=changes.color.toLowerCase();}
  if(own(changes,'infoText')){if(changes.infoText==='')delete c.infoText;else c.infoText=changes.infoText;}
  if(own(changes,'launch')){const launch={...c.launch,...clipLaunchValues(c),...changes.launch};validateClipLaunch(launch);if(Object.keys(changes.launch).some(key=>changes.launch[key]!==clipLaunchValues(c)[key]))c.launch=launch;}
 }
 validateProject(next);
 return {project:next,changed:JSON.stringify(project)!==JSON.stringify(next),observation:{type:'clip_properties',count:ids.length,ids,properties:Object.keys(changes),clips:ids.map(id=>{const c=next.clips[id];return {id,name:c.name,color:c.color??null,infoText:c.infoText??'',launch:clipLaunchValues(c)};})}};
}
