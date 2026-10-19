import {validateProject} from './model.js';
import {defaultTransport} from './transport.js';
import {sceneNames} from './management.js';
import {isGroup} from './track-hierarchy.js';
import {newProjectCandidate,readAudioImport,prepareAudioImport,readMidiImport,prepareMidiImport} from './project-import.js';
import {readProjectFile} from './project-lifecycle.js';
import {assertHistoryState} from './history-control.js';
export const PROJECT_IO_KEYS=['action','name','empty','trackId','scene','replace','useTempo'];
export function projectIOIntent(project,args){
 const allowed={new:['action','name','empty'],open:['action'],import_audio:['action','trackId','scene','replace'],import_midi:['action','replace','useTempo']}[args?.action];
 if(!allowed||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))throw new Error('Use project_io action new/open/import_audio/import_midi with only its supported options. Never supply paths, URLs or file bytes.');
 for(const k of ['empty','replace','useTempo'])if(args[k]!==undefined&&typeof args[k]!=='boolean')throw new Error(k+' must be boolean.');
 if(args.name!==undefined&&(typeof args.name!=='string'||!args.name.trim()||args.name.trim().length>120))throw new Error('Use a project name of 1–120 characters.');
 if(args.action==='import_audio'){
  if(args.scene!==undefined&&(!args.trackId||!Number.isInteger(args.scene)||args.scene<0||args.scene>=project.scenes))throw new Error('Choose a track and valid Session scene for audio import.');
  if(args.trackId!==undefined){const track=project.tracks.find(t=>t.id===args.trackId);if(!track||isGroup(track))throw new Error('Choose an existing nongroup track for audio import.');if(args.scene!==undefined&&track.slots[args.scene]&&!args.replace)throw new Error('The destination slot is occupied; explicitly replace it or choose an empty slot.');}
 }
 return structuredClone(args);
}
export function normalizeStudioProject(project){const p=structuredClone(validateProject(project));p.format='opus-loops';p.returns??=[];p.sceneNames=sceneNames(p);p.transport??=defaultTransport();for(const t of p.tracks)t.devices??=[];return validateProject(p);}
export async function runProjectIO(prepared,{getProject,getHistory,guard,chooseFile,confirmLarge,readDefault,decode,apply,signal}){
 const check=()=>{signal.throwIfAborted();guard();assertHistoryState(prepared.binding,getHistory());};check();
 const intent=projectIOIntent(getProject(),prepared.intent),original=structuredClone(getProject());
 let candidate,file,source;
 if(intent.action==='new')candidate={next:newProjectCandidate(intent.empty?null:await readDefault(),intent)};
 else {
  file=await chooseFile(intent.action,{signal,assertCurrent:check});check();
  if(!file)throw new DOMException('File selection cancelled','AbortError');
  if(intent.action==='open')candidate={next:await readProjectFile(file,validateProject,{confirmLarge:confirmLarge?async info=>{check();const approved=await confirmLarge(info);check();return approved;}:undefined,signal})};
  else if(intent.action==='import_audio'){source=await readAudioImport(file,decode,{signal});candidate=prepareAudioImport(original,source,intent);}
  else {source=await readMidiImport(file,{signal});candidate=prepareMidiImport(original,source,intent);}
 }
 check();prepared.target=normalizeStudioProject(candidate.next);prepared.replacement=['new','open'].includes(intent.action);prepared.selection=candidate.selection;
 await apply(prepared.target,{replacement:prepared.replacement,selection:candidate.selection,clip:candidate.clip,buffer:source?.buffer,signal,committed:()=>{prepared.applied=true;}});
 const result={projectIO:true,action:intent.action,projectName:getProject().name,tracks:getProject().tracks.length,clips:Object.keys(getProject().clips).length,recovery:prepared.replacement?'previous-set':'undo',...(file?{fileName:file.name}:{}),...(candidate.selection?{selection:candidate.selection}:{}),...(candidate.warnings?.length?{warnings:candidate.warnings}:{})};
 checkProjectIOReceipt(prepared,getProject(),result,getHistory());return result;
}
export function checkProjectIOReceipt(prepared,project,result,history){
 if(!prepared.applied||!result?.projectIO||result.action!==prepared.intent.action||JSON.stringify(project)!==JSON.stringify(prepared.target)||result.projectName!==project.name||result.tracks!==project.tracks.length)throw new Error('The project operation did not match its prepared result. Inspect the current set.');
 const before=prepared.binding;
 if(prepared.replacement){if(history.id===before.id||history.undoCount||history.redoCount)throw new Error('The replacement set did not start a fresh history.');}
 else {const changed=JSON.stringify(prepared.target)!==prepared.original;if(history.id!==before.id||history.revision!==before.revision+(changed?1:0)||history.undoCount!==Math.min(40,before.undoCount+(changed?1:0))||history.redoCount!==(changed?0:before.redoCount))throw new Error('The import did not create the expected single Undo group.');}
 return true;
}
export function describeProjectIO(result){const label={new:'Created',open:'Opened',import_audio:'Imported Audio Into',import_midi:'Imported MIDI Into'}[result.action];return `${label} ${result.projectName}. ${result.tracks} Tracks · ${result.clips} Clips. ${result.recovery==='previous-set'?'The Previous Set Is Available In File → Open Live Set Backups.':'Undo Restores The Previous Project.'}${result.warnings?.length?' MIDI Import Notes: '+result.warnings.join(' '):''}`;}

export function permitsImportReplacement(prompt){const text=String(prompt);return !/\b(?:do not|don't|never|without)\b[^.;\n]*\b(?:replace|replacing|overwrite|overwriting)\b/i.test(text)&&/\b(?:replace|overwrite)\b/i.test(text);}
export function permitsFileTempo(prompt){
 const text=String(prompt);
 if(/\b(?:keep|preserve|retain)\b[^.;\n]*\b(?:current|project|session)\b[^.;\n]*\b(?:tempo|bpm)\b/i.test(text)||/\b(?:do not|don't|never|without)\b[^.;\n]*\b(?:use|using|adopt|adopting|change|changing)\b[^.;\n]*\b(?:tempo|bpm)\b/i.test(text))return false;
 return /\b(?:use|adopt|match)\b[^.;\n]*\b(?:file|midi|imported)\b[^.;\n]*\b(?:tempo|bpm)\b/i.test(text)||/\b(?:use|adopt)\b[^.;\n]*\b(?:tempo|bpm)\b[^.;\n]*\b(?:from|of)\b[^.;\n]*\b(?:file|midi)\b/i.test(text);
}
