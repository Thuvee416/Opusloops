import {trackOutput,routingInputs} from './track-routing.js';
import {Engine} from './audio.js';
import {exportOptions} from './wav-export.js';
import {deliveryOptions} from './delivery-options.js';
import {selectedStemChannels,stemSelectionMetadata} from './stem-selection.js';
import {storeZip} from './zip.js';
export const STEM_BYTES=128*1024*1024;
export function stemChannels(project,selection){const wanted=new Set(selectedStemChannels(project,selection).map(c=>c.value));return selectedStemChannels(project).map((c,i)=>({...c,file:String(i+1).padStart(2,'0')+'-'+c.type+'-'+(c.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,60)||'channel')+'.wav'})).filter(c=>wanted.has(c.value));}
export function alignStemWaves(files){const maximum=Math.max(...files.map(f=>new DataView(f.data.buffer,f.data.byteOffset,f.data.byteLength).getUint32(40,true)));if(files.length*(maximum+44)>STEM_BYTES)throw new Error('Stem files exceed 128 MiB. Choose a shorter range or lower sample rate/bit depth.');return files.map(file=>{if(file.data.length===maximum+44)return file;const data=new Uint8Array(maximum+44);data.set(file.data);const v=new DataView(data.buffer);v.setUint32(4,data.length-8,true);v.setUint32(40,maximum,true);return {...file,data};});}
export function buildStemArchive(project,options,files,automationOverrides=[]){
 const settings=deliveryOptions(project,exportOptions(options),'stems'),channels=stemChannels(project,settings.channels);
 if(files.length!==channels.length||files.some((f,i)=>f.name!==channels[i].file||!(f.data instanceof Uint8Array)))throw new Error('Rendered Stem Files Do Not Match The Chosen Channels.');
 const aligned=alignStemWaves(files),manifest={format:'opus-loops-stems',version:1,project:project.name,bpm:project.bpm,settings,selection:stemSelectionMetadata(project,settings.channels),automationOverrides:[...automationOverrides],notes:'Post-channel audio before master gain/compression. Track files exclude return audio but include incoming routed tracks. Bus files overlap their source files; do not sum both. To reconstruct the pre-master signal, use only tracks whose mainOutput is master, plus returns, without independent normalization/dither. Return files contain all active sends. Current mute/solo and crossfade apply. Shorter tails are padded with zero samples. Normalization/dither apply independently to each channel. Channel selection chooses files only: buses and returns retain all routed inputs and sends. A subset may not reconstruct the complete mix.',channels:channels.map(c=>({...c,state:structuredClone(c.type==='track'?project.tracks.find(t=>t.id===c.id):project.returns.find(t=>t.id===c.id))})).map(c=>({file:c.file,type:c.type,id:c.id,name:c.name,mute:c.state.mute,solo:c.state.solo??false,...(c.type==='track'?{group:c.state.group===true,parentId:c.state.parentId??null}:{}),crossfade:c.state.crossfade??'none',mainOutput:c.type==='track'?trackOutput(c.state):'master',...(c.type==='track'?{receivesTrackOutputs:routingInputs(project,c.id)}:{})}))};
 return {data:storeZip([...aligned,{name:'manifest.json',data:new TextEncoder().encode(JSON.stringify(manifest,null,2))}]),manifest};
}
export async function renderStemArchive(source,options={}, {signal,onProgress=()=>{},onManifest=()=>{}}={}){
 const check=()=>{if(signal?.aborted)throw new DOMException('Stem export canceled.','AbortError');};check();
 const project=structuredClone(source.project),settings=deliveryOptions(project,exportOptions(options),'stems'),channels=stemChannels(project,settings.channels),engine=new Engine(project,()=>{});engine.active=structuredClone(source.active);engine.automationOverrides=new Set(source.automationOverrides);engine.masterVolume=source.masterVolume;
 const files=[];let bytes=0;const {channels:ignored,...renderSettings}=settings;
 try{for(let i=0;i<channels.length;i++){check();onProgress({index:i,total:channels.length,name:channels[i].name});check();const data=new Uint8Array(await engine.render({...renderSettings,channel:channels[i].value}));check();bytes+=data.length;if(bytes>STEM_BYTES)throw new Error('Stem files exceed 128 MiB. Choose a shorter range or lower sample rate/bit depth.');files.push({name:channels[i].file,data});}
 const archive=buildStemArchive(project,settings,files,engine.automationOverrides);check();onManifest(structuredClone(archive.manifest));return archive.data;
 }finally{if(engine.context)await engine.context.close().catch(()=>{});}
}
