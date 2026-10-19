import {validateProject} from './model.js';
import {validateClipLaunch} from './launch.js';

// Source properties are shared by every Session/Arrangement placement of a clip.
export const CLIP_PROPERTY_FIELDS=['name','color','infoText','launch'];
export const CLIP_COLORS=[['Coral','#ed795e'],['Amber','#e3b75b'],['Lime','#b4c775'],['Teal','#62b5a5'],['Blue','#81a8cf'],['Violet','#ae91cf'],['Rose','#ce94af'],['Graphite','#939b99']];
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function assertClipSourceScope(ids,trackIds,regionIds){
 if(!Array.isArray(ids))return;
 if(ids.some(id=>trackIds.has(id)))throw new Error('Track Name Changes Use type:track With args:{id:TRACK_ID,changes:{name:NEW_NAME}}. clip_properties Requires Clip Source IDs, Never Track Or Return IDs.');
 if(ids.some(id=>regionIds.has(id)))throw new Error('clip_properties Requires Clip Source IDs, Never Arrangement Region IDs. Use The Region clipId Only When A Source Clip Edit Was Requested.');
}
// The provider sees a media-free project; check identity scope without executing edits.
// New aliases retain their declared entity type and are never silently reinterpreted.
export function checkClipPropertyPlanScopes(project,actions){
 const trackIds=new Set([...(project.tracks??[]),...(project.returns??[])].map(t=>t.id)),regionIds=new Set((project.arrangement??[]).map(r=>r.id));
 for(const action of actions){const args=typeof action.args==='string'?JSON.parse(action.args):action.args;
  if(['add_track','add_return','track_group'].includes(action.type)&&args?.ref)trackIds.add(args.ref);
  if(action.type==='region'&&args?.ref)regionIds.add(args.ref);
  if(action.type==='clip_properties'){validateClipPropertyPatch(args?.changes);assertClipSourceScope(args?.ids,trackIds,regionIds);}
 }
}
export const clipLaunchValues=clip=>({mode:clip.launch?.mode??'trigger',quantization:clip.launch?.quantization??'global',legato:clip.launch?.legato??false});
export const clipColor=(clip,track)=>clip?.color??track?.color??'#939b99';
export function clipPropertyIds(project,ids){
 assertClipSourceScope(ids,new Set([...(project.tracks??[]),...(project.returns??[])].map(t=>t.id)),new Set((project.arrangement??[]).map(r=>r.id)));
 if(!Array.isArray(ids)||!ids.length||ids.length>512||ids.some(id=>typeof id!=='string'||!own(project.clips,id)))throw new Error('Choose Existing Clip Source IDs.');
 return [...new Set(ids)];
}
export function clipPropertySummary(project,ids){
 const unique=clipPropertyIds(project,ids),clips=unique.map(id=>project.clips[id]);
 const common=read=>{const values=clips.map(read);return values.every(v=>v===values[0])?{mixed:false,value:values[0]}:{mixed:true,value:null};};
 return {ids:unique,count:unique.length,name:common(c=>c.name),color:common(c=>c.color??null),infoText:common(c=>c.infoText??''),launch:Object.fromEntries(['mode','quantization','legato'].map(key=>[key,common(c=>clipLaunchValues(c)[key])])),placements:unique.map(clipId=>({clipId,session:project.tracks.flatMap(t=>t.slots.flatMap((id,scene)=>id===clipId?[{trackId:t.id,scene}]:[])),regions:project.arrangement.filter(r=>r.clipId===clipId).map(r=>r.id)}))};
}
export function validateClipPropertyPatch(changes){
 if(object(changes)&&['volume','pan','mute','solo','output'].some(k=>own(changes,k)))throw new Error('Mixer Changes Use type:track With args:{id:TRACK_ID,changes:{volume,pan,...}}. clip_properties Only Edits Clip Source name, color, infoText And launch; Never Pass Track IDs Or Mixer Fields.');
 if(!object(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!CLIP_PROPERTY_FIELDS.includes(k)))throw new Error('Choose name, color, infoText Or launch Clip Properties.');
 if(own(changes,'name')&&(typeof changes.name!=='string'||!changes.name.trim()||changes.name.length>200))throw new Error('Clip Name Must Contain 1–200 Characters.');
 if(own(changes,'color')&&changes.color!==null&&(typeof changes.color!=='string'||!/^#[0-9a-f]{6}$/i.test(changes.color)))throw new Error('Clip Color Must Be A Six-Digit Hex Color Or null To Follow Its Track.');
 if(own(changes,'infoText')&&(typeof changes.infoText!=='string'||changes.infoText.length>4000))throw new Error('Clip Info Text Must Contain At Most 4,000 Characters.');
 if(own(changes,'launch')&&(!object(changes.launch)||!Object.keys(changes.launch).length||Object.keys(changes.launch).some(k=>!['mode','quantization','legato'].includes(k))))throw new Error('Clip Launch Patch Accepts mode, quantization And legato Only.');
}
export function editClipProperties(project,intent){
 if(!object(intent)||Object.keys(intent).some(k=>!['ids','changes'].includes(k)))throw new Error('Clip Properties Accept ids And changes Only.');
 const changes=intent.changes;
 validateClipPropertyPatch(changes);
 const ids=clipPropertyIds(project,intent.ids);
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
