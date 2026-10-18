// Request-local UI constraints. Values come from the real client snapshot, not
// model-supplied restoration data. This does not infer arbitrary language intent.
const fields={selection:['selection','selectedSession','sessionAnchor','selectedTracks','selectedRegion','selectedRegions','selectedScene','noteSelection','timeSelection','deviceTrackId'],view:['view'],panel:['detailPanel','detailExpanded','detailHeightPercent']};
const fail=message=>{throw Object.assign(new Error(message),{code:'navigation_preservation'});};
const decode=action=>typeof action.args==='string'?JSON.parse(action.args):action.args??{};
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>stable(a)===stable(b);
function canonical(key,value){
 if(value===undefined)return null;value=structuredClone(value);
 if(['selectedTracks','selectedRegions'].includes(key)&&Array.isArray(value))value.sort();
 if(key==='selectedSession'&&Array.isArray(value))value.sort((a,b)=>a.trackId.localeCompare(b.trackId)||a.scene-b.scene);
 if(key==='noteSelection'&&value)value.indices.sort((a,b)=>a-b);
 return value;
}
export function navigationSnapshot(studio,scopes){const out={};for(const key of new Set(scopes.flatMap(scope=>fields[scope]??[])))if(Object.hasOwn(studio??{},key))out[key]=canonical(key,studio[key]);return out;}
export function readNavigationPreservation(prompt,studio={}){
 if(typeof prompt!=='string')return null;
 // Quoted names and Info Text are data, not navigation instructions.
 const text=prompt.replace(/["“][^"”]*["”]|(?<![a-z])'[^']*'(?![a-z])/gi,' '),chosen=new Set();
 const nouns='(?:selections?|views?|panels?|focus|layout)',list='('+nouns+'(?:\\s*(?:,|/|and\\b|or\\b)\\s*(?:the\\s+|current\\s+)?'+nouns+')*)';
 const collect=phrase=>{for(const word of phrase.toLowerCase().match(/selections?|views?|panels?|focus|layout/g)??[]){if(word.startsWith('selection')||word==='focus')chosen.add('selection');if(word.startsWith('view')||word==='layout')chosen.add('view');if(word.startsWith('panel')||word==='layout')chosen.add('panel');}};
 for(const match of text.matchAll(/\b(?:do\s+not|don['’]t|never|without)\b([^.!?;\n]{1,400})/gi)){
  const clause=match[1].split(/\b(?:then|but|however|instead)\b/i)[0];for(const part of clause.matchAll(new RegExp('\\b(?:chang(?:e|ing)|alter(?:ing)?|switch(?:ing)?)\\s+(?:(?:the|my|current|any)\\s+)*'+list,'gi')))collect(part[1]);
 }
 for(const match of text.matchAll(new RegExp('\\b(?:preserve|retain|maintain|keep)\\s+(?:(?:the|my|current|same|existing)\\s+)*'+list,'gi')))collect(match[1]);
 const scopes=['selection','view','panel'].filter(s=>chosen.has(s));return scopes.length?{version:1,scopes,expected:navigationSnapshot(studio,scopes)}:null;
}
export function checkNavigationCommands(actions,requirement){
 if(!requirement)return;
 const protectedScope=scope=>requirement.scopes.includes(scope),expected=requirement.expected;
 const panel=value=>{if(protectedScope('panel')&&(expected.detailPanel!==value||expected.detailExpanded===false))fail('Keep The Requested Panel And Its Expanded State. Remove The Conflicting Navigation Command.');};
 const view=value=>{if(protectedScope('view')&&expected.view!==value)fail('Keep The Requested Session/Arrangement View. Remove The Conflicting Navigation Command.');};
 for(const action of actions){if(action.type!=='command')continue;const command=decode(action),args=command.args??{};
  if(command.name==='select'){
   if(protectedScope('selection'))fail('The Request Preserves The Current Selection. Do Not Return select Commands, Including Attempts To Restore It; The Client Preserves It With The Edit Transaction.');
   if(args.target==='session')view('session');else if(args.target==='track')panel('devices');else{view(args.target==='regions'||args.target==='notes'&&args.regionId!==undefined?'arrangement':'session');panel('clip');}
  }
  if(command.name==='view')view(args.view);
  if(command.name==='show_panel')panel(args.panel);
  if(command.name==='record_quantization'||command.name==='record_input')panel('recording');
  if(command.name==='record_input'&&args.action==='finish'&&protectedScope('selection'))fail('Finishing A Take Selects Its Saved Material. Finish The Take Without A Selection-Preservation Constraint, Or Cancel It; No Take State Has Changed.');
 }
}
export function prepareNavigationPreservation(project,next,actions,requirement){
 if(!requirement)return null;const result=structuredClone(requirement);result.beforeExpected=structuredClone(result.expected);checkNavigationCommands(actions,result);
 if(!result.scopes.includes('selection'))return result;
 const state=result.expected,tracks=[...next.tracks,...next.returns??[]],track=id=>tracks.find(t=>t.id===id),regular=id=>next.tracks.find(t=>t.id===id),region=id=>next.arrangement.find(r=>r.id===id);
 for(const id of state.selectedTracks??[])if(!track(id))fail('The Edit Removes A Selected Track. It Cannot Also Preserve That Selection.');
 if(state.deviceTrackId&&!track(state.deviceTrackId))fail('The Edit Removes The Track In Device Focus. Choose A New Focus Or Keep That Track.');
 if(state.selectedScene!==undefined&&(!Number.isInteger(state.selectedScene)||state.selectedScene<0||state.selectedScene>=next.scenes))fail('The Edit Removes The Selected Scene. Choose A New Selection Or Keep That Scene.');
 if(state.selectedSession)state.selectedSession=state.selectedSession.map(slot=>{const t=regular(slot.trackId);if(!t||t.group||slot.scene<0||slot.scene>=next.scenes)fail('The Edit Removes A Selected Session Placement. Choose A New Selection Or Keep It.');return {trackId:t.id,scene:slot.scene,...(t.slots[slot.scene]?{clipId:t.slots[slot.scene]}:{})};});
 if(state.sessionAnchor){const t=regular(state.sessionAnchor.trackId);if(!t||state.sessionAnchor.scene<0||state.sessionAnchor.scene>=next.scenes)fail('The Edit Removes The Session Selection Anchor.');}
 for(const id of state.selectedRegions??[])if(!region(id))fail('The Edit Removes A Selected Arrangement Region. Choose A New Selection Or Keep It.');
 if(state.selectedRegion){const r=region(state.selectedRegion);if(!r)fail('The Edit Removes The Primary Arrangement Region.');state.selection={trackId:r.trackId,clipId:r.clipId};}
 else if(state.selection){const selected=state.selection,t=regular(selected.trackId);if(!t)fail('The Edit Removes The Current Content Track.');if(selected.scene!==undefined){if(selected.scene<0||selected.scene>=next.scenes)fail('The Edit Removes The Current Session Row.');selected.clipId=t.slots[selected.scene]??null;}else if(selected.clipId&&!next.clips[selected.clipId])fail('The Edit Removes The Current Clip Source.');}
 if(state.noteSelection&&state.selection?.clipId!==state.noteSelection.clipId){if(state.noteSelection.indices.length)fail('The Edit Removes The Focused Placement Of Selected MIDI Notes. Choose A New Note Selection Or Keep That Placement.');const clip=next.clips[state.selection?.clipId];state.noteSelection=clip?.kind==='midi'?{clipId:clip.id,indices:[],primaryIndex:0}:null;}
 if(state.noteSelection){const notes=state.noteSelection,clip=next.clips[notes.clipId],old=project.clips[notes.clipId];if(clip?.kind!=='midi'||notes.indices.some(i=>!Number.isInteger(i)||i<0||i>=clip.notes.length))fail('The Edit Removes Selected MIDI Notes. Choose A New Note Selection Or Keep Them.');if(notes.indices.length&&old.notes.length!==clip.notes.length)fail('Changing This Clip’s Note Count Can Remap The Selected Note Indices. Choose An Explicit New Note Selection Or Keep The Note Count.');}
 if(Object.hasOwn(state,'noteSelection')&&!state.noteSelection&&next.clips[state.selection?.clipId]?.kind==='midi')state.noteSelection={clipId:state.selection.clipId,indices:[],primaryIndex:0};
 if(state.timeSelection?.trackIds)for(const id of state.timeSelection.trackIds)if(!regular(id))fail('The Edit Removes A Track In The Selected Time Range.');
 // Values are re-canonicalized because selected placements can legitimately
 // receive new content while their locations remain selected.
 result.expected=Object.fromEntries(Object.entries(state).map(([k,v])=>[k,canonical(k,v)]));return result;
}
export function checkNavigationPreserved(requirement,studio){
 if(!requirement)return null;const actual=navigationSnapshot(studio,requirement.scopes);
 for(const[key,value]of Object.entries(requirement.expected))if(!same(value,actual[key]))fail('The Actual '+key+' Did Not Match The Requested Preserved State. Inspect The Current Studio Before Continuing.');
 return {scopes:[...requirement.scopes],state:Object.fromEntries(Object.keys(requirement.expected).map(k=>[k,actual[k]]))};
}
