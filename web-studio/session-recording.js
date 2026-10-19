import {validateProject} from './model.js';
// Session performance capture is distinct from microphone/keyboard input takes.
const json=value=>JSON.stringify(value);
export const SESSION_CAPTURE_COMMANDS=['launch_scene','launch_clip','stop_track','stop_clips','launch_group','stop_group'];
export function sessionRecordingState(engine){const take=engine.recordingTake;return {active:!!engine.recording,captureId:take?.id??null,previousArrangement:take?.previous??null,regions:engine.recording?engine.project.arrangement.length:0};}
export function sessionRecordingBinding(state){return {active:!!state?.active,captureId:state?.captureId??null};}
export function assertSessionRecordingBinding(expected,state){if(expected&&json(expected)!==json(sessionRecordingBinding(state)))throw new Error('The Session recording changed. Run the request again for the current take.');}
// Only the engine-owned Arrangement evolves during an identified active take.
// All other project data, and the original Arrangement, stay fingerprinted.
export function sessionRecordingSignature(project,state){return json(state?.active?{...project,arrangement:state.previousArrangement}:project);}
export function sessionRecordingIntent(args){
 if(!args||!['start','finish','cancel'].includes(args.action)||Object.keys(args).some(k=>!['action',...(args.action==='start'?['replace']:[])].includes(k))||args.replace!==undefined&&typeof args.replace!=='boolean')throw new Error('record_session accepts action start with optional replace boolean, or action finish/cancel alone.');
 return {...args};
}
export function permitsArrangementReplacement(prompt){const target='(?:(?:the|my|our)\\s+)?(?:(?:existing|current|old)\\s+)?arrangement\\b';return !new RegExp('\\b(?:(?:do\\s+not|don[’\']?t|never|not)\\s+replace|keep|preserve|without\\s+(?:replacing|changing))\\s+'+target,'i').test(prompt)&&new RegExp('\\breplace\\s+'+target,'i').test(prompt);}
export function prepareSessionRecording(project,args,state,{allowReplace=false,inputActive=false}={}){
 const intent=sessionRecordingIntent(args);
 if(!state||typeof state.active!=='boolean'||inputActive)throw new Error('Finish the input take and refresh the Session recording state first.');
 if(intent.action==='start'){
  if(state.active)throw new Error('Finish or cancel the current Session recording first.');
  if(project.arrangement.length&&!(intent.replace===true&&allowReplace))throw new Error('Starting Session recording replaces the existing Arrangement. Ask whether to replace it; only an explicit request to replace the Arrangement permits this.');
 }else if(!state.active||!state.captureId||!Array.isArray(state.previousArrangement))throw new Error('No active Session recording.');
 return {intent,binding:sessionRecordingBinding(state),previousArrangement:structuredClone(state.active?state.previousArrangement:project.arrangement)};
}
export function checkSessionRecordingReceipt(before,after,prepared,result,state){
 const {intent,binding,previousArrangement}=prepared;
 if(!result?.sessionRecording||result.action!==intent.action)throw new Error('Session recording did not return its actual outcome.');
 if(json({...before,arrangement:[]})!==json({...after,arrangement:[]}))throw new Error('Session recording changed unrelated project content.');
 if(intent.action==='start'){
  if(!state.active||!state.captureId||state.captureId!==result.captureId||result.status!=='recording'||json(state.previousArrangement)!==json(previousArrangement))throw new Error('The Session recording did not start as validated.');
  return {changed:false};
 }
 if(state.active||state.captureId||result.captureId!==binding.captureId||!['saved','empty','cancelled'].includes(result.status)||result.regionCount!==after.arrangement.length)throw new Error('The Session recording did not finish as validated.');
 if(intent.action==='cancel'&&(result.status!=='cancelled'||json(after.arrangement)!==json(previousArrangement)))throw new Error('Cancelling must restore the previous Arrangement exactly.');
 if(intent.action==='finish'&&(result.status!==(after.arrangement.length?'saved':'empty')||after.arrangement.some(r=>!after.tracks.some(t=>t.id===r.trackId)||!after.clips[r.clipId]||!(r.length>=.0625)||!Number.isFinite(r.start)||r.start<0)))throw new Error('The saved Session recording is invalid.');
 validateProject(after);return {changed:json(previousArrangement)!==json(after.arrangement)};
}
export function readSessionRecordingStopRequest(prompt,state){
 if(!state?.active)return null;
 const text=String(prompt).trim().replace(/[.!?]+$/,'');
 const match=/^(?:please\s+)?(finish|stop|end|cancel|discard|abort)\s+(?:(?:the|this|my|current)\s+)*(?:(?:session|performance|arrangement)\s+)?(?:recording|take)(?:\s+now)?$/i.exec(text);
 if(!match)return null;const action=/^(cancel|discard|abort)$/i.test(match[1])?'cancel':'finish';
 return {summary:'Session Recording '+(action==='finish'?'Finished':'Cancelled'),actions:[{type:'command',args:{name:'record_session',args:{action}}}]};
}
export function describeSessionRecording(result){return result.status==='recording'?'Recording Session Performance. Launch Clips Or Scenes, Then Finish Or Cancel This Recording.':result.status==='cancelled'?'Session Recording Cancelled. The Previous Arrangement Is Restored.':`Session Recording Finished: ${result.regionCount} Arrangement Clips. ${result.status==='empty'?'No Clips Were Captured. ':''}Undo Restores The Previous Arrangement.`;}
