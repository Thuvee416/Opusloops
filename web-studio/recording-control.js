import {overdubDestination,applyMidiOverdub} from './midi-overdub.js';
import {validateProject} from './model.js';
import {isGroup} from './track-hierarchy.js';
import {sceneNames} from './management.js';
const signature=p=>JSON.stringify(p);
export function recordingDestination(project,trackId){
 const track=project.tracks.find(t=>t.id===trackId);
 if(!track||isGroup(track))throw new Error('Choose an existing contained audio or MIDI recording track.');
 if(Object.keys(project.clips).length>=512)throw new Error('The project has reached its 512-clip limit.');
 const empty=track.slots.indexOf(null);
 if(empty<0&&project.scenes>=32)throw new Error('Choose a track with an empty Session slot.');
 return {trackId,scene:empty<0?project.scenes:empty,newScene:empty<0};
}
export function appendRecordedClip(project,clip,trackId){
 const destination=recordingDestination(project,trackId);
 if(!clip||!['audio','midi'].includes(clip.kind)||typeof clip.id!=='string'||Object.hasOwn(project.clips,clip.id))throw new Error('A recorded take must create a new audio or MIDI clip.');
 const next=structuredClone(project);
 if(destination.newScene){next.scenes++;for(const t of next.tracks)t.slots.push(null);next.sceneFollows?.push(null);}
 next.sceneNames=sceneNames(next);next.clips[clip.id]=structuredClone(clip);next.tracks.find(t=>t.id===trackId).slots[destination.scene]=clip.id;validateProject(next);
 return {project:next,...destination};
}
export function recordInputIntent(project,args){
 if(!args||typeof args!=='object'||Array.isArray(args)||!['start','finish','cancel'].includes(args.action))throw new Error('record_input requires action start, finish or cancel.');
 const keys=args.action==='start'?['action','source','trackId','countInBars','mode',...(args.mode==='overdub'?['scene','clipId']:[])]:['action','trackId'];
 if(Object.keys(args).some(k=>!keys.includes(k)))throw new Error('record_input '+args.action+' accepts '+keys.join(', ')+'.');
 if(args.action==='start'){
  if(!['midi','audio'].includes(args.source)||![0,1,2,4].includes(args.countInBars))throw new Error('Start a take with explicit source midi/audio, trackId and countInBars 0, 1, 2 or 4.');
  if(args.mode!==undefined&&!['new','overdub'].includes(args.mode))throw new Error('Choose recording mode new or overdub.');
  if(args.mode==='overdub'){if(args.source!=='midi')throw new Error('Overdub adds MIDI notes to an existing MIDI Session clip; audio overdub is unavailable.');overdubDestination(project,args.trackId,args.scene,args.clipId);}else recordingDestination(project,args.trackId);
 }else if(args.trackId!==undefined&&!project.tracks.some(t=>t.id===args.trackId&&!isGroup(t))){
  throw new Error('Choose the track of the active input take.');
 }
 return structuredClone(args);
}
export function recordingBinding(state){return {active:!!state?.active,captureId:state?.captureId??null,...(state?.active?{source:state.source,trackId:state.trackId,...(state.mode==='overdub'?{mode:'overdub',clipId:state.clipId,scene:state.scene}:{})}:{})};}
export function assertRecordingBinding(expected,actual){
 if(expected&&signature(expected)!==signature(recordingBinding(actual)))throw new Error('The input take changed while planning or executing. Nothing further was applied; run the request again for the current take.');
}
export function prepareRecordInput(project,args,state){
 const intent=recordInputIntent(project,args);
 if(!state||typeof state.active!=='boolean')throw new Error('Refresh the studio recording state before controlling a take.');
 if(intent.action==='start'){
  if(intent.mode==='overdub'&&state.overdubReady===false)throw new Error('Let queued launches settle before overdubbing.');
  if(state.active)throw new Error('Finish or cancel the current take before starting another.');
  if(intent.source==='audio'&&!state.audioConnected)throw new Error('Enable the audio input in Recording first. Odesa does not open microphone permissions or choose devices.');
  if(intent.countInBars&&state.playing)throw new Error('Stop playback before starting a take with a count-in.');
 }else{
  if(!state.active||typeof state.captureId!=='string')throw new Error('No active input take. Start a take first.');
  if(intent.trackId!==undefined&&intent.trackId!==state.trackId)throw new Error('That track does not own the active take. Finish or cancel the current take on '+state.trackId+'.');
 }
 return {intent,binding:recordingBinding(state)};
}
export function checkRecordingReceipt(before,after,prepared,result,state){
 const intent=prepared.intent;
 if(!result?.inputRecording||result.action!==intent.action)throw new Error('The recording operation did not return its actual result.');
 if(intent.action==='start'){
  if(signature(before)!==signature(after)||!state?.active||!result.captureId||state.captureId!==result.captureId||state.source!==intent.source||state.trackId!==intent.trackId||state.countInBars!==intent.countInBars||result.source!==intent.source||result.trackId!==intent.trackId||result.countInBars!==intent.countInBars||!['count_in','queued','recording'].includes(result.status))throw new Error('The requested input take did not start as validated.');
  if(intent.mode==='overdub'&&(state.mode!=='overdub'||state.clipId!==before.tracks.find(t=>t.id===intent.trackId).slots[intent.scene]||result.mode!=='overdub'||result.scene!==intent.scene||result.clipId!==state.clipId))throw new Error('The overdub did not start on the validated Session clip.');
  return {changed:false};
 }
 if(state?.active||state?.captureId||result.captureId!==prepared.binding.captureId||result.source!==prepared.binding.source||result.trackId!==prepared.binding.trackId)throw new Error('The input take did not finish as validated.');
 if(intent.action==='cancel'||result.status!=='saved'){
  if(!(intent.action==='cancel'?result.status==='cancelled':['empty','cancelled_count_in','cancelled_pending'].includes(result.status))||signature(before)!==signature(after))throw new Error('Cancelling or finishing an empty take must preserve the project exactly.');
  return {changed:false};
 }
 const clip=after.clips[result.clipId];
 if(clip?.kind!==prepared.binding.source)throw new Error('The recorded clip source does not match the take.');
 const overdub=prepared.binding.mode==='overdub';
 if(overdub&&(result.mode!=='overdub'||result.clipId!==prepared.binding.clipId||result.scene!==prepared.binding.scene))throw new Error('The overdub result does not match its bound source.');
 const expected=overdub?applyMidiOverdub(before,clip,prepared.binding.trackId,prepared.binding.scene):appendRecordedClip(before,clip,prepared.binding.trackId);
 if(overdub&&result.addedNotes!==expected.addedNotes)throw new Error('The overdub note count does not match its receipt.');
 if(result.scene!==expected.scene||signature(expected.project)!==signature(after))throw new Error('The take changed unrelated project data. Remaining actions stopped.');
 if(clip.kind==='midi'&&result.noteCount!==clip.notes.length)throw new Error('The saved take note count does not match its receipt.');
 return {changed:true};
}
export function describeInputRecording(result){
 if(result.status==='saved'&&result.mode==='overdub')return `Added ${result.addedNotes} MIDI Notes To The Existing Loop.${result.quantized?' Undo Restores Performed Timing; Undo Again Removes This Overdub.':' Undo Removes This Overdub.'}${result.boundarySplits?' Notes Crossing Loop Boundaries Were Split.':''}${result.tailLimited?' Note Capacity Limited The Captured Tail.':''} Playback Continues.`;
 if(result.status==='saved')return `Saved ${result.source==='midi'?'MIDI':'Audio'} Take To Scene ${result.scene+1}.${result.quantized?' Undo Restores Performed Timing; Undo Again Removes The Take.':' Undo Removes The Take.'}`;
 if(result.status==='empty')return 'No MIDI Notes Were Captured. No Clip Or Undo Step Was Created.';
 if(result.status==='cancelled_pending')return 'Pending Overdub Cancelled. No Take Was Saved.';
 if(result.status==='cancelled_count_in')return 'Count-In Cancelled. No Take Was Saved.';
 if(result.status==='cancelled')return 'Take Cancelled. No Clip Or Undo Step Was Created.';
 return `${result.mode==='overdub'?'MIDI Overdub':result.source==='midi'?'MIDI':'Audio'} Take ${result.status==='count_in'?'Counting In':result.status==='queued'?'Waiting For The Loop':'Recording'}. Finish Take Saves It; Cancel Take Discards It.`;
}

// Unambiguous real-time stop requests need no model round trip. Compound or
// ambiguous requests continue through normal planning and full preflight.
export function readInputStopRequest(prompt,state){
 if(!state?.active||typeof prompt!=='string')return null;
 const text=prompt.trim().toLowerCase().replace(/[.!?]+$/,'').replace(/\s+/g,' ');
 const noun='(?:(?:the|this|my|the current|current) )?(?:(?:input|midi|audio) )?(?:take|recording)';
 const finish=new RegExp('^(?:please )?(?:finish(?: and save)?|stop|end) '+noun+'(?: now)?(?: please)?$');
 const cancel=new RegExp('^(?:please )?(?:cancel|discard|abort) '+noun+'(?: now)?(?: please)?$');
 const action=finish.test(text)?'finish':cancel.test(text)?'cancel':null;
 return action?{summary:action==='finish'?'Finished The Current Input Take.':'Cancelled The Current Input Take.',actions:[{type:'command',args:{name:'record_input',args:{action}}}],localRecordingControl:true}:null;
}
