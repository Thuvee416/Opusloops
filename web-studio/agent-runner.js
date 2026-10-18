import {copySessionClips,sessionActivationOnly,sessionClipboardSummary} from './session-batch.js';
import {DEFAULT_RECORD_QUANTIZATION,patchRecordQuantization} from './record-quantization.js';
import {recordingBinding,assertRecordingBinding,prepareRecordInput,checkRecordingReceipt} from './recording-control.js';
import {checkQuantizeRequirements} from './note-quantize-requirements.js';
import {prepareMidiDelivery} from './midi-delivery.js';
import {applyAgentActions} from './agent-actions.js';
import {checkDeliveryRequirements,checkDeliveryReceipt} from './delivery-requirements.js';

const decode = action => typeof action.args === 'string' ? JSON.parse(action.args) : structuredClone(action.args);
const signature = project => JSON.stringify(project);

// Preflight the whole plan before changing either transport or project state.
// All musical edits share one candidate and preserve aliases across actions.
export function prepareAgentPlan(project, actions, {deliveryRequirements=null,quantizeRequirements=null,recordQuantizationState=null,recordingState=null,sessionClipboard=null}={}) {
  if (!Array.isArray(actions) || actions.length > 80) throw new Error('Use at most 80 actions per request.');
  const edits = [], before = [], after = [];
  const hasEdits = actions.some(a => a?.type !== 'command');
  let runtimeStarted = false;
  for (const action of actions) {
    if (action?.type === 'command') {
      const command = decode(action);
      if (hasEdits && !edits.length && !runtimeStarted && ['stop', 'pause'].includes(command?.name)) before.push(command);
      else { runtimeStarted = true; after.push(command); }
    } else {
      if (runtimeStarted) throw new Error('Put project edits before playback, navigation, save or export commands. Stop/pause may precede edits.');
      edits.push(action);
    }
  }
  if (before.length + after.length > 8) throw new Error('Use at most eight runtime commands per request.');
  const recording=after.filter(c=>c.name==='record_input');
  if(recording.length>1||recording.length&&after.at(-1)!==recording[0])throw new Error('Use one record_input command as the final action. Start and finish are separate requests around your performance.');
  if(recording.length&&recording[0].args?.action!=='start'&&actions.length!==1)throw new Error('Finish or cancel a take in its own request, then request edits or exports against the saved recording.');
  if(recordingState?.active&&!(actions.length===1&&recording.length===1&&['finish','cancel'].includes(recording[0].args?.action)))throw new Error('An input take is active. Use only record_input finish or cancel; finish it before editing, navigating or exporting.');
  const aliases=new Map(),editObservations=[];
  const next = applyAgentActions(project, edits,{aliases,observations:editObservations,sessionClipboard});
  for(const command of [...before,...after]){
  for(const key of ['trackId','clipId','primaryId','regionId'])if(command.args?.[key])command.args[key]=aliases.get(command.args[key])||command.args[key];
  if(Array.isArray(command.args?.ids))command.args.ids=command.args.ids.map(id=>aliases.get(id)||id);
  if(Array.isArray(command.args?.trackIds))command.args.trackIds=command.args.trackIds.map(id=>aliases.get(id)||id);
  if(Array.isArray(command.args?.slots))command.args.slots=command.args.slots.map(s=>({...s,trackId:aliases.get(s.trackId)||s.trackId,...(s.clipId?{clipId:aliases.get(s.clipId)||s.clipId}:{})}));if(command.args?.primary){for(const key of ['trackId','clipId'])if(command.args.primary[key])command.args.primary[key]=aliases.get(command.args.primary[key])||command.args.primary[key];}
  const channel=command.args?.channel;if(typeof channel==='string'&&/^(track|return):/.test(channel)){const split=channel.indexOf(':')+1;command.args.channel=channel.slice(0,split)+(aliases.get(channel.slice(split))||channel.slice(split));}
 }
  const prepared=new Map();let recordingPrefs=recordQuantizationState?patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,recordQuantizationState):null;
  const recordingRuntimeState=recordingState?{...recordingState}:null;
  for (const command of [...before, ...after]) {
    applyAgentActions(next, [{type:'command', args:command}]);
    if(command.name==='record_quantization'&&recordingPrefs){const after=patchRecordQuantization(recordingPrefs,command.args);prepared.set(command,{recordQuantizationBefore:recordingPrefs,recordQuantizationAfter:after});recordingPrefs=after;}
    if(recordingRuntimeState){if(['stop','pause'].includes(command.name)){recordingRuntimeState.playing=false;recordingRuntimeState.overdubReady=true;}else if(['play','launch_scene','launch_clip','launch_group'].includes(command.name))recordingRuntimeState.playing=true;}
    if(command.name==='session_clipboard')prepared.set(command,{clipboard:copySessionClips(next,command.args.slots)});
    if(command.name==='record_input')prepared.set(command,prepareRecordInput(next,command.args,recordingRuntimeState));
    if(command.name==='export_midi')prepared.set(command,prepareMidiDelivery(next,command.args));
  }
  const deliveryChecks=checkDeliveryRequirements(next,after,deliveryRequirements);
  const quantizeCheck=checkQuantizeRequirements(project,{next,after},quantizeRequirements);
  let internalClipboard=false,clipboardUsed=false;for(const action of edits){const args=decode(action);if(action.type==='session_clips'&&args.action==='paste'&&!internalClipboard)clipboardUsed=true;if(action.type==='session_clips'&&args.action==='cut')internalClipboard=true;}
  const liveSessionActive=edits.length>0&&edits.every(a=>a.type==='session_clips'&&decode(a).action==='active')&&sessionActivationOnly(project,next);
  return {next, prepared,liveSessionActive,clipboardUsed,clipboardRevision:clipboardUsed?sessionClipboard?.revision:null, deliveryChecks, quantizeCheck,recordingBinding:recordingState?recordingBinding(recordingState):null,recording:recording.length>0, editCount:edits.length,changesProject:signature(project)!==signature(next), before, after,editObservations};
}

export async function runAgentPlan(plan, {getProject,getRecording,getClipboard, expected, locked, commit, execute, signal, onStep = () => {}}) {
  let fingerprint = expected, editsApplied = false;
  let captureBinding=plan.recordingBinding,recordingApplied=false;
  if(plan.recording&&!getRecording)throw new Error('Recording control requires a current take-state adapter.');
  const completedCommands = [], observations = [];
  const publicEdits=(plan.editObservations??[]).map(({clipboard,...observation})=>({...observation,...(clipboard?{clipboard:sessionClipboardSummary(clipboard)}:{})}));
  let commitStarted = false;
  if(plan.clipboardUsed&&!getClipboard)throw new Error('Session paste requires a current clipboard adapter.');
  const check = () => {
    signal.throwIfAborted();
    if(plan.clipboardUsed&&!commitStarted&&getClipboard()?.revision!==plan.clipboardRevision)throw new Error('Session clipboard changed. Remaining actions stopped.');
    if (signature(getProject()) !== fingerprint || locked('request')) throw new Error('The session changed while executing. Remaining actions stopped.');
    if(getRecording)assertRecordingBinding(captureBinding,getRecording());
  };
  const run = async command => {
    check();
    const beforeRecording=command.name==='record_input'?structuredClone(getProject()):null;
    let result;try{result=await execute(command,signal,plan.prepared?.get(command));
      if(command.name==='record_input'){
        const observed=checkRecordingReceipt(beforeRecording,getProject(),plan.prepared.get(command),result,getRecording());
        recordingApplied||=observed.changed;fingerprint=signature(getProject());captureBinding=recordingBinding(getRecording());
      }
    }catch(error){if(command.name==='record_input'&&signature(getProject())!==fingerprint)error.agentRecordingApplied=true;error.agentInterruptedCommand={name:command.name,state:error.performanceState??null};throw error;}
    observations.push({name:command.name, result:result ?? null});
    completedCommands.push(command.name);
    const deliveryCheck=plan.deliveryChecks?.get(command);
    checkDeliveryReceipt(plan.next,result,deliveryCheck);
    if(deliveryCheck)result={...result,...(Object.keys(deliveryCheck.requested).length?{requestedSettingsVerified:deliveryCheck.requested}:{}),...(deliveryCheck.requiredFormat?{requestedFileTypeVerified:deliveryCheck.requiredFormat}:{})};
    observations.at(-1).result=result??null;
    // Runtime operations cannot silently replace/edit the project.
    check();
    onStep({type:'command', name:command.name, result:result ?? null});
  };
  try {
    check();
    for (const command of plan.before) await run(command);
    if (plan.editCount) {
      check();
      const intended = signature(plan.next);
      if(intended!==fingerprint){
        if (locked(plan.liveSessionActive?'session-live':'edit')) throw new Error('Stop playback before editing. Put a stop command before the project edits.');
        commitStarted = true;
        commit(plan.next,plan.editObservations??[]);
        editsApplied = true;
        fingerprint = signature(getProject());
        if (fingerprint !== intended) throw new Error('The applied project does not match the validated plan.');
      }
      onStep({type:'edits', count:editsApplied?plan.editCount:0,unchanged:!editsApplied,observations:publicEdits});
    }
    for (const command of plan.after) await run(command);
    if(plan.quantizeCheck)onStep({type:'verified_notes',check:plan.quantizeCheck});
    return {editsApplied,recordingApplied,...(plan.quantizeCheck?{quantizeVerified:plan.quantizeCheck}:{}),projectUnchanged:plan.editCount>0&&!editsApplied, completedCommands, observations,editObservations:publicEdits};
  } catch (error) {
    // Preserve what actually happened: downloads/transport cannot be undone by
    // restoring a project, and a failed export must not hide committed edits.
    error.agentEditsApplied = editsApplied || (commitStarted && signature(getProject()) !== expected);
    error.agentRecordingApplied ||= recordingApplied;
    error.agentCompletedCommands = completedCommands;
    throw error;
  }
}
