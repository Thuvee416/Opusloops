import {prepareHistory,assertHistoryState,checkHistoryReceipt,historyIntent} from './history-control.js';
import {SESSION_CAPTURE_COMMANDS,prepareSessionRecording,sessionRecordingBinding,assertSessionRecordingBinding,sessionRecordingSignature,checkSessionRecordingReceipt} from './session-recording.js';
import {checkStemSelectionRequirements,stemSelectionMetadata} from './stem-selection.js';
import {deliveryOptions} from './delivery-options.js';
import {prepareNavigationPreservation,checkNavigationPreserved} from './navigation-preservation.js';
import {checkCreationLaunchRequirement} from './midi-creation-requirements.js';
import {normalizeAgentActions,checkCreationSceneRequirement} from './agent-addressing.js';
import {checkClipPropertyRequirements} from './clip-property-requirements.js';
import {checkSessionSelectionRequirements,checkSessionSelectionReceipt} from './session-selection-requirements.js';
import {checkSessionClipboardRequirements,checkSessionClipboardReceipt} from './session-clipboard-requirements.js';
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
export function prepareAgentPlan(project, actions, {stemSelectionRequirements=null,deliveryRequirements=null,quantizeRequirements=null,recordQuantizationState=null,recordingState=null,sessionRecordingState=null,historyState=null,historyPreview=null,historyRequirement=null,allowArrangementReplacement=false,sessionClipboard=null,sessionClipboardRequirements=null,sessionSelectionRequirements=null,clipPropertyRequirements=null,creationSceneRequirement=null,creationLaunchRequirement=null,navigationPreservation=null}={}) {
  if (!Array.isArray(actions) || actions.length > 80) throw new Error('Use at most 80 actions per request.');
  if(sessionRecordingState?.active)project={...project,arrangement:structuredClone(sessionRecordingState.previousArrangement)};
  actions=normalizeAgentActions(actions);
  checkCreationLaunchRequirement(actions,creationLaunchRequirement);
  const creationSceneIntent=checkCreationSceneRequirement(actions,creationSceneRequirement);
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
  const histories=after.filter(c=>c.name==='history');
  if(histories.length>1||histories.length&&(hasEdits||before.length||after.slice(0,after.indexOf(histories[0])).some(c=>!['stop','pause'].includes(c.name))))throw new Error('Use one history command before other runtime actions, with only optional Stop/Pause before it and no new project edits. Request new edits separately after Undo/Redo.');
  if(historyRequirement&&(!histories.length||JSON.stringify(historyIntent(histories[0].args))!==JSON.stringify(historyRequirement)))throw new Error('Use the requested Undo/Redo direction and complete step count.');
  const historyPrepared=histories.length?prepareHistory(project,histories[0].args,historyState,historyPreview):null;
  const captures=after.filter(c=>c.name==='record_session');
  const captureActive=!!sessionRecordingState?.active;
  if(captures.length>1)throw new Error('Use one Session recording control per request.');
  if(captures.length&&(hasEdits||before.length))throw new Error('Start, finish or cancel Session recording separately from project edits.');
  if(captures.length&&captures[0].args?.action!=='start'&&actions.length!==1)throw new Error('Finish or cancel Session recording in its own request.');
  if(captureActive||captures.length){
    if(edits.length||after.some(c=>c.name!=='record_session'&&!SESSION_CAPTURE_COMMANDS.includes(c.name)))throw new Error('During Session recording use only Session launches/clip stops or standalone record_session finish/cancel. Finish before editing or exporting.');
    if(captures[0]?.args?.action==='start'&&after[0]!==captures[0])throw new Error('Start Session recording before the requested clip or scene launches.');
  }
  const recording=after.filter(c=>c.name==='record_input');
  if(recording.length>1||recording.length&&after.at(-1)!==recording[0])throw new Error('Use one record_input command as the final action. Start and finish are separate requests around your performance.');
  if(recording.length&&recording[0].args?.action!=='start'&&actions.length!==1)throw new Error('Finish or cancel a take in its own request, then request edits or exports against the saved recording.');
  if(recordingState?.active&&!(actions.length===1&&recording.length===1&&['finish','cancel'].includes(recording[0].args?.action)))throw new Error('An input take is active. Use only record_input finish or cancel; finish it before editing, navigating or exporting.');
  const aliases=new Map(),editObservations=[];
  const next = applyAgentActions(historyPrepared?.target??project, edits,{aliases,observations:editObservations,sessionClipboard});
  for(const command of [...before,...after]){
  for(const key of ['trackId','clipId','primaryId','regionId'])if(command.args?.[key])command.args[key]=aliases.get(command.args[key])||command.args[key];
  if(Array.isArray(command.args?.ids))command.args.ids=command.args.ids.map(id=>aliases.get(id)||id);
  if(Array.isArray(command.args?.trackIds))command.args.trackIds=command.args.trackIds.map(id=>aliases.get(id)||id);
  if(Array.isArray(command.args?.slots))command.args.slots=command.args.slots.map(s=>({...s,trackId:aliases.get(s.trackId)||s.trackId,...(s.clipId?{clipId:aliases.get(s.clipId)||s.clipId}:{})}));for(const name of ['primary','fromSlot','toSlot'])if(command.args?.[name]){for(const key of ['trackId','clipId'])if(command.args[name][key])command.args[name][key]=aliases.get(command.args[name][key])||command.args[name][key];}
  const resolveChannel=channel=>{if(typeof channel!=='string'||!/^(track|return):/.test(channel))return channel;const split=channel.indexOf(':')+1;return channel.slice(0,split)+(aliases.get(channel.slice(split))||channel.slice(split));};if(command.args?.channel!==undefined)command.args.channel=resolveChannel(command.args.channel);if(Array.isArray(command.args?.channels))command.args.channels=command.args.channels.map(resolveChannel);
 }
  const prepared=new Map();if(historyPrepared)prepared.set(histories[0],historyPrepared);let recordingPrefs=recordQuantizationState?patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,recordQuantizationState):null;
  const recordingRuntimeState=recordingState?{...recordingState}:null;
  for (const command of [...before, ...after]) {
    applyAgentActions(next, [{type:'command', args:command}]);
    if(command.name==='record_quantization'&&recordingPrefs){const after=patchRecordQuantization(recordingPrefs,command.args);prepared.set(command,{recordQuantizationBefore:recordingPrefs,recordQuantizationAfter:after});recordingPrefs=after;}
    if(recordingRuntimeState){if(['stop','pause'].includes(command.name)){recordingRuntimeState.playing=false;recordingRuntimeState.overdubReady=true;}else if(['play','launch_scene','launch_clip','launch_group'].includes(command.name))recordingRuntimeState.playing=true;}
    if(command.name==='session_clipboard')prepared.set(command,{clipboard:copySessionClips(next,command.args.slots)});
    if(command.name==='record_session')prepared.set(command,prepareSessionRecording(next,command.args,sessionRecordingState,{allowReplace:allowArrangementReplacement,inputActive:recordingState?.active}));
    if(command.name==='record_input')prepared.set(command,prepareRecordInput(next,command.args,recordingRuntimeState));
    if(command.name==='export_midi')prepared.set(command,prepareMidiDelivery(next,command.args));
  }
  checkStemSelectionRequirements(next,after,stemSelectionRequirements);
  const deliveryChecks=checkDeliveryRequirements(next,after,deliveryRequirements);
  for(const command of after)if(command.name==='export_stems'&&(command.args?.channels!==undefined||stemSelectionRequirements)){const settings=deliveryOptions(next,command.args??{},'stems');if(!deliveryChecks.has(command))deliveryChecks.set(command,{kind:'stems',settings,source:settings.source==='auto'?(next.arrangement.length?'arrangement':'session'):settings.source,requested:{},requiredFormat:null});deliveryChecks.get(command).selection=stemSelectionMetadata(next,settings.channels);}
  const quantizeCheck=checkQuantizeRequirements(project,{next,after},quantizeRequirements);
  let internalClipboard=false,clipboardUsed=false;for(const action of edits){const args=decode(action);if(action.type==='session_clips'&&args.action==='paste'&&!internalClipboard)clipboardUsed=true;if(action.type==='session_clips'&&args.action==='cut')internalClipboard=true;}
  const liveSessionActive=edits.length>0&&edits.every(a=>a.type==='session_clips'&&decode(a).action==='active')&&sessionActivationOnly(project,next);
  const clipPropertyIntent=checkClipPropertyRequirements(project,{next,before,after,editCount:edits.length},clipPropertyRequirements);
  const clipboardIntent=checkSessionClipboardRequirements(project,{next,prepared,before,after,edits,editCount:edits.length},sessionClipboardRequirements,sessionClipboard);
  const preservation=prepareNavigationPreservation(project,next,actions,navigationPreservation);
  const selectionIntent=checkSessionSelectionRequirements(project,{next,before,after,editCount:edits.length},sessionSelectionRequirements);
  return {history:!!historyPrepared,historyBinding:historyPrepared?.binding??null,sessionRecordingBinding:sessionRecordingState?sessionRecordingBinding(sessionRecordingState):null,sessionRecording:captures.length>0||captureActive,next, prepared,navigationPreservation:preservation,creationSceneIntent,selectionIntent,clipboardIntent,clipPropertyIntent,liveSessionActive,clipboardUsed,clipboardRevision:clipboardUsed?sessionClipboard?.revision:null, deliveryChecks, quantizeCheck,recordingBinding:recordingState?recordingBinding(recordingState):null,recording:recording.length>0, editCount:edits.length,changesProject:signature(project)!==signature(next), before, after,editObservations};
}

export async function runAgentPlan(plan, {getProject,getHistory,getRecording,getSessionRecording,getClipboard,getNavigation, expected, locked, commit, execute, signal, onStep = () => {}}) {
  let fingerprint = expected, editsApplied = false, historyApplied=false,historyBinding=plan.historyBinding;
  if(plan.history&&!getHistory)throw new Error('History control requires a current history-state adapter.');
  let captureBinding=plan.recordingBinding,sessionCaptureBinding=plan.sessionRecordingBinding,recordingApplied=false;
  const projectSignature=()=>sessionRecordingSignature(getProject(),getSessionRecording?.());
  if(plan.sessionRecording&&!getSessionRecording)throw new Error('Session recording requires a current take-state adapter.');
  if(plan.recording&&!getRecording)throw new Error('Recording control requires a current take-state adapter.');
  const completedCommands = [], observations = [];
  const publicEdits=(plan.editObservations??[]).map(({clipboard,...observation})=>({...observation,...(clipboard?{clipboard:sessionClipboardSummary(clipboard)}:{})}));
  let commitStarted = false;
  if(plan.navigationPreservation&&!getNavigation)throw new Error('Navigation Preservation Requires A Current Studio-State Adapter.');
  let navigationEdited=false;
  const verifyNavigation=()=>checkNavigationPreserved(plan.navigationPreservation?{...plan.navigationPreservation,expected:navigationEdited?plan.navigationPreservation.expected:plan.navigationPreservation.beforeExpected??plan.navigationPreservation.expected}:null,getNavigation?.());
  if(plan.clipboardUsed&&!getClipboard)throw new Error('Session paste requires a current clipboard adapter.');
  const check = () => {
    signal.throwIfAborted();
    verifyNavigation();
    if(plan.clipboardUsed&&!commitStarted&&getClipboard()?.revision!==plan.clipboardRevision)throw new Error('Session clipboard changed. Remaining actions stopped.');
    if (projectSignature() !== fingerprint || locked('request')) throw new Error('The session changed while executing. Remaining actions stopped.');
    if(plan.history)assertHistoryState(historyBinding,getHistory());
    if(getRecording)assertRecordingBinding(captureBinding,getRecording());
    if(getSessionRecording)assertSessionRecordingBinding(sessionCaptureBinding,getSessionRecording());
  };
  const run = async command => {
    check();
    const beforeRecording=['record_input','record_session'].includes(command.name)?structuredClone(getProject()):null;
    let result;try{if(command.name==='history'&&locked('edit'))throw new Error('Stop playback and finish recording before Undo/Redo.');result=await execute(command,signal,plan.prepared?.get(command));
      if(command.name==='history'){historyApplied=true;checkHistoryReceipt(plan.prepared.get(command),getProject(),result,getHistory());fingerprint=signature(getProject());historyBinding=getHistory();}
      if(command.name==='record_session'){const observed=checkSessionRecordingReceipt(beforeRecording,getProject(),plan.prepared.get(command),result,getSessionRecording());recordingApplied||=observed.changed;sessionCaptureBinding=sessionRecordingBinding(getSessionRecording());fingerprint=projectSignature();}
      if(command.name==='record_input'){
        const observed=checkRecordingReceipt(beforeRecording,getProject(),plan.prepared.get(command),result,getRecording());
        recordingApplied||=observed.changed;fingerprint=signature(getProject());captureBinding=recordingBinding(getRecording());
      }
    }catch(error){if(command.name==='history'&&(historyApplied||projectSignature()!==fingerprint))error.agentHistoryApplied=true;if(['record_input','record_session'].includes(command.name)&&projectSignature()!==fingerprint)error.agentRecordingApplied=true;error.agentInterruptedCommand={name:command.name,state:error.performanceState??null};throw error;}
    if(plan.selectionIntent?.command===command)checkSessionSelectionReceipt(plan.selectionIntent,result);
    if(plan.clipboardIntent?.command===command)checkSessionClipboardReceipt(plan.clipboardIntent,result);
    observations.push({name:command.name, result:result ?? null});
    completedCommands.push(command.name);
    verifyNavigation();
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
        commit(plan.next,plan.editObservations??[],{navigationPreservation:plan.navigationPreservation});
        editsApplied = true;navigationEdited=true;
        fingerprint = signature(getProject());
        if (fingerprint !== intended) throw new Error('The applied project does not match the validated plan.');
      }
      onStep({type:'edits', count:editsApplied?plan.editCount:0,unchanged:!editsApplied,observations:publicEdits});
    }
    verifyNavigation();
    for (const command of plan.after) await run(command);
    const preservedNavigation=verifyNavigation();if(preservedNavigation)onStep({type:'verified_navigation',check:preservedNavigation});
    if(plan.quantizeCheck)onStep({type:'verified_notes',check:plan.quantizeCheck});
    return {historyApplied,editsApplied,recordingApplied,...(preservedNavigation?{preservedNavigation}:{}),...(plan.quantizeCheck?{quantizeVerified:plan.quantizeCheck}:{}),projectUnchanged:plan.editCount>0&&!editsApplied, completedCommands, observations,editObservations:publicEdits};
  } catch (error) {
    // Preserve what actually happened: downloads/transport cannot be undone by
    // restoring a project, and a failed export must not hide committed edits.
    error.agentEditsApplied = editsApplied || (commitStarted && signature(getProject()) !== expected);
    error.agentRecordingApplied ||= recordingApplied;error.agentHistoryApplied ||= historyApplied;
    error.agentCompletedCommands = completedCommands;
    throw error;
  }
}
