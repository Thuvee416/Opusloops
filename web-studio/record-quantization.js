import {quantizeSettings,describeQuantization} from './note-quantize.js';
import {editNoteGroup} from './notes.js';
export const RECORD_QUANTIZATION_KEY='opus.record-quantization';
export const DEFAULT_RECORD_QUANTIZATION=Object.freeze({enabled:false,grid:.25,gridMode:'straight',target:'starts'});
export const RECORD_QUANTIZATION_PRESETS=[
 {label:'No Quantization',settings:{enabled:false}},
 {label:'Quarter-Note Quantization',settings:{enabled:true,grid:1,gridMode:'straight'}},
 {label:'Eighth-Note Quantization',settings:{enabled:true,grid:.5,gridMode:'straight'}},
 {label:'Eighth-Note Triplets Quantization',settings:{enabled:true,grid:.5,gridMode:'triplet'}},
 {label:'Eighth-Note And Triplets Quantization',settings:{enabled:true,grid:.5,gridMode:'both'}},
 {label:'Sixteenth-Note Quantization',settings:{enabled:true,grid:.25,gridMode:'straight'}},
 {label:'Sixteenth-Note Triplets Quantization',settings:{enabled:true,grid:.25,gridMode:'triplet'}},
 {label:'Sixteenth-Note And Triplets Quantization',settings:{enabled:true,grid:.25,gridMode:'both'}},
 {label:'Thirty-Second Note Quantization',settings:{enabled:true,grid:.125,gridMode:'straight'}}
];
export function patchRecordQuantization(current,patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!['enabled','grid','gridMode','target'].includes(k)))throw new Error('Record Quantization accepts enabled, grid, gridMode and target only.');
 const next={...DEFAULT_RECORD_QUANTIZATION,...current,...patch};
 if(patch.enabled===undefined&&Object.keys(patch).some(k=>k!=='enabled'))next.enabled=true;
 if(typeof next.enabled!=='boolean')throw new Error('Choose Record Quantization enabled true or false.');
 const {grid,gridMode,target}=quantizeSettings({...next,strength:1});
 if(!RECORD_QUANTIZATION_PRESETS.slice(1).some(p=>p.settings.grid===grid&&p.settings.gridMode===gridMode))throw new Error('Choose a supported Record Quantization preset: quarter, eighth/sixteenth Straight/Triplet/Both, or straight thirty-second notes.');
 return {enabled:next.enabled,grid,gridMode,target};
}
export function loadRecordQuantization(storage){try{return patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,JSON.parse(storage.getItem(RECORD_QUANTIZATION_KEY)));}catch{return {...DEFAULT_RECORD_QUANTIZATION};}}
export function recordQuantizationDescription(value){return value.enabled?describeQuantization({...value,strength:1}):'Off';}
export function quantizeRecordedClip(rawClip,settings){
 const options=patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,settings);
 if(!options.enabled||!rawClip.notes.length)return {clip:structuredClone(rawClip),report:{...options,changed:false,noteCount:rawClip.notes.length,boundaryAdjusted:0}};
 const result=editNoteGroup(rawClip,'quantize',{...options,strength:1,indices:rawClip.notes.map((_,i)=>i)});
 // New takes may grow to contain shifted/extended ends, unlike existing clip loops.
 const notes=result.notes.map(n=>({...n,duration:Math.min(n.duration,256-n.start)}));
 const beats=Math.min(256,Math.ceil(Math.max(rawClip.beats,...notes.map(n=>n.start+n.duration))*4-1e-9)/4);
 const clip={...structuredClone(rawClip),beats,notes};
 return {clip,report:{...options,changed:JSON.stringify(clip)!==JSON.stringify(rawClip),noteCount:notes.length,boundaryAdjusted:result.quantization.boundaryAdjusted,tailLimited:result.notes.filter((n,i)=>n.duration!==notes[i].duration).length,beatsBefore:rawClip.beats,beatsAfter:beats}};
}

export function recordQuantizationPreset(settings){return settings.enabled?RECORD_QUANTIZATION_PRESETS.findIndex((p,i)=>i>0&&p.settings.grid===settings.grid&&p.settings.gridMode===settings.gridMode):0;}

export function recordQuantizationCommand(args){if(args?.enabled!==false&&(!args||args.enabled!==true||['grid','gridMode','target'].some(k=>!Object.hasOwn(args,k))))throw new Error('Enable Record Quantization with complete enabled:true, grid, gridMode and target settings; copy unchanged values from studio.recording.recordQuantization. To disable use enabled:false only.');if(args?.enabled===false&&Object.keys(args).length!==1)throw new Error('To disable Record Quantization use enabled:false only; saved timing preferences are preserved.');patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,args);return structuredClone(args);}

export function recordQuantizationTransition(current,args,prepared={}){recordQuantizationCommand(args);if(prepared.recordQuantizationBefore&&JSON.stringify(current)!==JSON.stringify(prepared.recordQuantizationBefore))throw new Error('Recording settings changed while planning. Your updated settings were kept; run the request again.');const after=patchRecordQuantization(current,args);if(prepared.recordQuantizationAfter&&JSON.stringify(after)!==JSON.stringify(prepared.recordQuantizationAfter))throw new Error('The recording settings do not match the validated plan.');return after;}
