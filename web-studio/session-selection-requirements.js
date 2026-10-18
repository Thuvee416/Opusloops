import {selectionIntent} from './studio-selection.js';import {slotKey} from './session-batch.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'session_selection_intent'});},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Ground clear standalone selection language only; broader production requests stay model-planned.
export function readSessionSelectionRequirements(prompt,project,studio={}){
 if(typeof prompt!=='string'||!Array.isArray(project?.tracks)||/\b(?:then|and\s+(?:play|record|save|export|delete|transpose|quantize))\b/i.test(prompt)||/\b(?:except|excluding|apart from|only occupied|skip empty)\b/i.test(prompt))return null;
 const clear=/^\s*(?:please\s+)?(?:deselect\s+all\s+Session\s+(?:clip\s+slots|clips|slots|selection)|clear\s+(?:the\s+)?(?:current\s+)?Session(?:\s+clip)?\s+selection)(?=[.!?,;:]|\s+(?:without|while|keeping|keep|leave)\b|$)/i.test(prompt);
 if(clear){const preserve={};for(const key of ['view','detailPanel','playing','performanceMode','deviceTrackId','selectedRegion','selectedRegions','selectedTracks','foldedGroups','selectedScene'])if(studio[key]!==undefined)preserve[key]=structuredClone(studio[key]);return {kind:'clear',slots:[],preserve};}
 if(!/^\s*(?:please\s+)?select\b[\s\S]*\bSession\s+(?:rectangle|range)\b/i.test(prompt))return null;
 const match=/\bfrom\s+(.+?)\s+scene\s+([1-9]\d*)\s+(?:through|to)\s+(.+?)\s+scene\s+([1-9]\d*)/i.exec(prompt);if(!match)return null;
 const endpoint=(name,scene)=>{name=name.trim().replace(/^["“'`]|["”'`]$/g,'');const tracks=project.tracks.filter(t=>t.name.toLowerCase()===name.toLowerCase());if(tracks.length!==1)fail('Choose an unambiguous current track name for the Session rectangle: '+name+'.');return {trackId:tracks[0].id,scene:Number(scene)-1};},fromSlot=endpoint(match[1],match[2]),toSlot=endpoint(match[3],match[4]),intent=selectionIntent(project,{target:'session',fromSlot,toSlot});
 return {kind:'rectangle',fromSlot,toSlot,slots:intent.slots,preserve:{view:'session',...(studio.detailPanel?{detailPanel:studio.detailPanel}:{}),...(typeof studio.playing==='boolean'?{playing:studio.playing}:{}),...(studio.performanceMode?{performanceMode:studio.performanceMode}:{})}};
}
export function checkSessionSelectionRequirements(project,plan,requirements){
 if(!requirements)return null;const command=plan.after[0];if(plan.editCount||plan.before.length||plan.after.length!==1||command?.name!=='select'||command.args?.target!=='session')fail('Requested Session selection requires exactly ONE select command with target:session. Opening Devices or changing view does not select slots. Do not edit the project or add show_panel/playback commands.');
 const intent=selectionIntent(project,command.args);if(!same(intent.slots.map(slotKey),requirements.slots.map(slotKey)))fail(requirements.kind==='clear'?'Clear Session selection with slots:[] and OMIT primary/fromSlot/toSlot. No other action.':'Select EXACTLY the bound inclusive rectangle with fromSlot and toSlot, including empty/group-contained placements. Copy the bound zero-based endpoints; do not substitute a panel/view command.');
 return {command,slots:requirements.slots,preserve:requirements.preserve};
}
export function checkSessionSelectionReceipt(check,result){
 if(!check)return;if(!result?.navigation||result.target!=='session'||!Array.isArray(result.selectedSession)||!same(result.selectedSession.map(slotKey),check.slots.map(slotKey)))fail('The actual Session selection does not match the requested slots. Inspect the visible selection before continuing.');for(const [key,value]of Object.entries(check.preserve))if(!same(result[key],value))fail('Session selection changed the requested '+key+'. Inspect the current view before continuing.');
}
