import {validateClipPropertyPatch} from '../../../web-studio/clip-properties.js';
import {MUSICAL_UNITS_VERSION,BEATS_PER_BAR,normalizeMusicalAction} from '../../../web-studio/musical-units.js';

export const musicalUnitsContract=context=>context?.sceneAddressing?.version===1&&context?.musicalUnits?.version===MUSICAL_UNITS_VERSION&&context?.musicalUnits?.beatsPerBar===BEATS_PER_BAR;
const position=n=>({beat:n+1}),duration=n=>({beats:n}),gain=n=>({linear:n});
const map=(obj,key,fn)=>{if(obj&&typeof obj[key]==='number')obj[key]=fn(obj[key]);};
function range(r){map(r,'start',position);map(r,'end',position);map(r,'length',duration);}
function envelope(e){for(const p of e?.points??[])map(p,'beat',position);}
function channel(t,instrument=false){map(t,'volume',gain);for(const e of Object.values(t.automation??{}))envelope(e);for(const d of t.devices??[])for(const e of Object.values(d.automation??{}))envelope(e);if(instrument&&!t.group)t.instrumentSelection=t.instrument?{kind:t.instrument.type,name:({poly:'Poly Synth',sampler:'Sampler',drums:'Drum Rack'})[t.instrument.type]}:{kind:'original',name:'Original tone'};}

// Presentation only. Engine/session inputs and independently derived guards
// retain their original numeric coordinates and exact user text.
export function musicalModelInput(input){
 const out=structuredClone(input),s=out.session,p=s.project;
 s.musicalUnits={version:MUSICAL_UNITS_VERSION,beatsPerBar:BEATS_PER_BAR,positions:'Displayed beat objects start at 1. bar/beat objects also start at 1.',durations:'bars or beats, never a position',gain:'linear, db (absolute), or relativeDb (change)'};
 map(p,'master',gain);
 for(const channel of s.automationTargets??[])for(const target of channel.targets??[])envelope(target.envelope);
 for(const t of p.tracks??[])channel(t,true);for(const t of p.returns??[])channel(t);
 for(const c of Object.values(p.clips??{})){map(c,'beats',duration);if(c.kind==='midi')for(const n of c.notes??[]){map(n,'start',position);map(n,'duration',duration);}}
 for(const r of p.arrangement??[]){range(r);for(const k of ['offset','fadeIn','fadeOut'])map(r,k,duration);}
 for(const k of ['loopStart','loopEnd'])map(p.transport,k,position);
 for(const l of p.locators??[])map(l,'beat',position);
 const studio=s.studio;
 if(studio){
  for(const k of ['position','insertMarker'])map(studio,k,position);range(studio.timeSelection);
  const perf=studio.performance;
  if(perf){for(const k of ['position','clockBeat','sceneActivationBeat'])map(perf,k,position);map(perf.queuedScene,'beat',position);for(const t of perf.tracks??[]){map(t,'activationBeat',position);map(t.pending,'beat',position);}}
  for(const value of Object.values(studio.delivery??{})){range(value?.range);range(value?.arrangement?.settings?.range);}
 }
 range(out.requestedDelivery?.settings?.range);
 // Keep operation detail, but make the typed schema authoritative for units.
 s.capabilityUnits='Capability prose describes engine operations; all time/fader action fields use the musical-unit schema. Raw quantize grids, launch grids, velocity, pan, effect parameters, indices and countInBars keep their existing native units.';
 return out;
}
const example=JSON.stringify({summary:'Create a phrase',actions:[{type:'add_track',args:{name:'Lead',kind:'original',ref:'$lead'}},{type:'midi',args:{trackId:'$lead',ref:'$phrase',name:'Lead Phrase',sceneNumber:1,beats:{bars:2},notes:[{pitch:60,start:{bar:1,beat:1},duration:{beats:.5},velocity:.7},{pitch:67,start:{bar:2,beat:1},duration:{beats:.5},velocity:.7}]}},{type:'region',args:{trackId:'$lead',clipId:'$phrase',start:{bar:5},length:{bars:2}}}]});
export const musicalPlanningGuide=`
MUSICAL UNIT CONTRACT: For time and fader fields use ONLY the typed objects in the schema. Preserve the user's units, do not perform bar/beat or dB arithmetic. Positions use {bar:N,beat:M} (both displayed starting at 1; beat defaults to 1), or {beat:N} for an absolute displayed beat. Note starts are positions within their clip; Arrangement starts are song positions. Durations, clip beats, region lengths and source offsets use exactly one of {bars:N} or {beats:N}. Movement deltas use signed bars/beats. A four-bar clip uses beats:{bars:4}, NOT beats:4 or beats:{beats:4}. On the first beat of successive bars means start:{bar:1}, then {bar:2}, etc., not successive beats. Use the same requested duration on BOTH the clip and its Arrangement placement. Read current project positions/durations from their typed objects. Quantize grids and launch quantization remain numeric beats, velocity remains 0..1, pan remains -1..1, count-in remains bars and indices stay zero-based. Never unit-wrap effect parameters or sampler start/end fractions.
For fader changes, "reduce BY 3 dB" means volume:{relativeDb:-3}; "set TO -3 dB" means volume:{db:-3}. Never substitute an unchanged fader, a guessed linear value, or omit a requested reduction. Linear percentages use {linear:0.7}; unity {linear:1}. Application resolves relative gain against the current candidate including prior actions. Do not modify automation unless requested; if it prevents the intended audible result, ask or clearly account for it.
Arrangement split: when session.regionSplit.version is 1, use {type:"region_split",args:{id:"EXISTING_REGION_ID",at:{bar:N}}}. A split preserves both resulting pieces, source offset, notes and original coverage; NEVER substitute a region move/resize. Older clients must reload for this operation.
Loop boundaries are SONG POSITIONS, not durations. A loop from bar 5 to bar 9 is transport:{loopEnabled:true,loopStart:{bar:5},loopEnd:{bar:9}}. Copy the word bar into the bar key; {beat:5} is a completely different location. Check loop bounds as carefully as note timing.
Audio device settings: include every requested parameter inside params at creation/update, in the native units advertised by session.effects. For example Utility gain -6 dB requires type:utility,params:{gain:-6}; simply adding a default Utility silently drops the request. Do not translate a device gain into a track fader change.
Track versus clip scope: Volume, pan, mute, solo and output are TRACK MIXER changes. Use {type:"track",args:{id:"CURRENT_TRACK_ID",changes:{volume:{relativeDb:-3}}}}. clip_properties only changes source name/color/infoText/launch and accepts CLIP SOURCE IDs; never use it for mixer changes or pass track IDs there. A request to preserve clips does not make unrelated mixer edits clip properties.
Instrument identity: Original tone is kind:original with NO preset, params or sampleClipId. It is different from Poly Synth's Init sine preset. add_track supports kind:original; instrument kind:original resets an existing instrument. Keep exact requested preset names for kind:poly. Omitted instrument choices preserve existing instruments.
Explicit requestedDelivery ranges have already been converted to the same typed units; copy them without conversion. Older numeric capability examples describe the engine, not this planning wire format. ${example}
Review every requested musical clause against the original request: clip duration, each note's bar/beat and duration, region position AND length, gain direction/unit, instrument identity, exact names and all preserved material. Return a COMPLETE corrected plan. Do not approve a plan simply because its numbers are valid.`;
export function musicalPlanningSystem(base){
 return base.replace(/Complete composition example: .*?(?=\. Use CLIP)/s,'Complete composition example: '+example)
 .replace('beat positions, Arrangement time and offsets remain zero-based','beat positions, Arrangement time and offsets use the musical-unit schema')
 +musicalPlanningGuide;
}
export function validateMusicalPlan(actions){for(const action of actions){const normalized=normalizeMusicalAction(action,{requireUnits:true});if(action.type==='clip_properties')validateClipPropertyPatch(normalized.args.changes);}}
