import {uid,validateProject} from './model.js';
import {validateInstrument} from './instruments.js';
import {validateDevices} from './devices.js';
import {validateMidiEffects} from './midi-effects.js';
export const PRESET_MAX_BYTES=90_000_000;
export function validateSoundPreset(p){
 if(!p||p.format!=='opus-sound'||p.version!==1||typeof p.name!=='string'||!p.name.trim()||p.name.length>80)throw new Error('Invalid OPUS sound preset.');
 if(!Array.isArray(p.midiEffects))throw new Error('Invalid preset MIDI effects.');validateInstrument(p.instrument);validateDevices(p.devices);validateMidiEffects(p.midiEffects);
 if(p.devices.some(d=>d.automation!==undefined))throw new Error('Sound presets cannot contain Arrangement automation.');
 if(JSON.stringify(p).length>PRESET_MAX_BYTES)throw new Error('Sound preset exceeds 90 MB.');return p;
}
export function createSoundPreset(track,name){
 const p={format:'opus-sound',version:1,name:name.trim(),devices:structuredClone(track.devices||[]),midiEffects:structuredClone(track.midiEffects||[])};
 if(track.instrument)p.instrument=structuredClone(track.instrument);
 for(const d of p.devices)delete d.automation;
 return validateSoundPreset(p);
}
export function applySoundPreset(project,trackId,preset){
 validateSoundPreset(preset);const next=structuredClone(project),track=next.tracks.find(t=>t.id===trackId);if(!track)throw new Error('Choose a regular track for a sound preset.');
 if(preset.instrument)track.instrument=structuredClone(preset.instrument);else delete track.instrument;
 track.devices=preset.devices.map(d=>({...structuredClone(d),id:uid()}));track.midiEffects=preset.midiEffects.map(d=>({...structuredClone(d),id:uid()}));
 return validateProject(next);
}
let dbPromise;
function database(){return dbPromise??=new Promise((resolve,reject)=>{const request=indexedDB.open('opus-sound-library',1);request.onupgradeneeded=()=>request.result.createObjectStore('presets');request.onsuccess=()=>resolve(request.result);request.onerror=()=>{dbPromise=null;reject(request.error);};});}
export async function listSoundPresets(){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('presets'),request=tx.objectStore('presets').openCursor(),items=[];request.onsuccess=()=>{const cursor=request.result;if(cursor){items.push({id:cursor.key,name:cursor.value.name,instrument:cursor.value.instrument?.type||'legacy',effects:cursor.value.devices.length,midiEffects:cursor.value.midiEffects.length});cursor.continue();}};tx.oncomplete=()=>resolve(items.sort((a,b)=>a.name.localeCompare(b.name)));tx.onerror=()=>reject(tx.error);});}
export async function getSoundPreset(id){const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction('presets').objectStore('presets').get(id);request.onsuccess=()=>{try{resolve(validateSoundPreset(request.result));}catch(error){reject(error);}};request.onerror=()=>reject(request.error);});}
export async function saveSoundPreset(preset,id=uid()){validateSoundPreset(preset);const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('presets','readwrite'),store=tx.objectStore('presets');const count=store.count();count.onsuccess=()=>{if(count.result>=64){tx.abort();return;}store.put(structuredClone(preset),id);};tx.oncomplete=()=>resolve(id);tx.onabort=()=>reject(new Error('Preset library could not be saved. It supports up to 64 presets; remove one or download this sound as a file.'));tx.onerror=()=>reject(tx.error);});}
export async function removeSoundPreset(id){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('presets','readwrite');tx.objectStore('presets').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
