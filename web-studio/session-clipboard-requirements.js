import {sessionSlots,slotKey,editSessionClips,sessionClipboardSummary} from './session-batch.js';
import {isGroup} from './track-hierarchy.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'session_clipboard_intent'});};
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
// Bind only clear standalone clipboard requests; arbitrary musical language still uses normal planning.
export function readSessionClipboardRequirements(prompt,project,studio={}){
 if(typeof prompt!=='string'||!/\bSession\s+clipboard\b/i.test(prompt)||/\b(?:then|and\s+(?:play|record|save|export|delete|transpose))\b/i.test(prompt))return null;
 if(/^\s*(?:please\s+)?copy\b/i.test(prompt)&&/\bselected\b/i.test(prompt)){
  const slots=sessionSlots(project,studio.selectedSession);if(!slots.some(s=>s.clipId))fail('Select occupied Session clips before copying.');return {kind:'copy',slots};
 }
 if(/^\s*(?:please\s+)?paste\b/i.test(prompt)&&/\b(?:focused|selected|current)\b/i.test(prompt)){
  const {trackId,scene}=studio.selection??{},track=project.tracks.find(t=>t.id===trackId);if(!track||isGroup(track)||!Number.isInteger(scene)||scene<0||scene>=project.scenes)fail('Focus a regular Session slot before pasting.');return {kind:'paste',destination:{trackId,scene}};
 }return null;
}
export function checkSessionClipboardRequirements(project,plan,requirements,clipboard){
 if(!requirements)return null;
 if(requirements.kind==='copy'){
  const command=plan.after[0];if(plan.editCount||plan.before.length||plan.after.length!==1||command?.name!=='session_clipboard'||command.args?.action!=='copy')fail('Requested Session clipboard COPY requires exactly one session_clipboard command with action:copy and the selected slots. Selecting clips does not copy them. No project edits or other commands.');
  const actual=sessionSlots(project,command.args.slots);if(stable(actual.map(slotKey))!==stable(requirements.slots.map(slotKey)))fail('Copy exactly the requested selected Session slots, without changing selection.');
  return {kind:'copy',command,expected:sessionClipboardSummary(plan.prepared.get(command).clipboard)};
 }
 if(requirements.kind==='paste'){
  const edit=plan.edits?.[0],args=typeof edit?.args==='string'?JSON.parse(edit.args):edit?.args;
  if(plan.editCount!==1||edit?.type!=='session_clips'||args?.action!=='paste'||stable(args.destination)!==stable(requirements.destination)||plan.before.length||plan.after.length)fail('Paste the actual Session clipboard using session_clips action:paste at the focused destination. No other runtime commands.');
  const result=editSessionClips(project,{action:'paste',destination:requirements.destination},{clipboard}),oracle=result.project,newIds=new Set();
  for(const slot of result.selection){if(!slot.clipId)continue;const id=plan.next.tracks.find(t=>t.id===slot.trackId)?.slots[slot.scene];if(!id||Object.hasOwn(project.clips,id)||newIds.has(id))fail('Session paste must create independent clip copies at the focused destination.');newIds.add(id);const clip=oracle.clips[slot.clipId];delete oracle.clips[slot.clipId];clip.id=id;oracle.clips[id]=clip;oracle.tracks.find(t=>t.id===slot.trackId).slots[slot.scene]=id;}
  if(stable(plan.next)!==stable(oracle))fail('Paste exactly the local Session clipboard rectangle at the focused slot, preserving holes, activation, sources and every other project field. Use ONE session_clips action:paste with the bound destination; do not regenerate notes or select unrelated clips.');
  return {kind:'paste',destination:requirements.destination,clips:newIds.size};
 }fail('Unknown Session clipboard intent.');
}
export function checkSessionClipboardReceipt(check,result){if(check?.kind==='copy'&&stable(result?.clipboard)!==stable(check.expected))fail('Session clipboard copy did not return the prepared snapshot receipt. Inspect the actual clipboard before retrying.');}
