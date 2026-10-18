const fail=message=>{throw Object.assign(new Error(message),{code:'clip_property_intent'});};
const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
// Ground explicit selected-Session source-property requests. This checks model plans;
// it never replaces planning or infers creative/compound production intentions.
export function readClipPropertyRequirements(prompt,project,studio={}){
 if(typeof prompt!=='string'||!Array.isArray(project?.tracks)||!/(?:both\s+)?selected\s+Session\s+clip(?:\s+sources|s)\b/i.test(prompt))return null;
 const changes={},name=/\brename\b[^"“\n]*["“]([^"”\n]+)["”]/i.exec(prompt),info=/\binfo\s+text\s+(?:exactly\s+)?["“]([^"”]*)["”]/i.exec(prompt);
 if(name)changes.name=name[1].trim();if(info)changes.infoText=info[1];
 const withoutQuotes=prompt.replace(/["“][^"”]*["”]/g,'');
 if(/\b(?:then|transpose|duplicate|delete|record|export|compose|move)\b/i.test(withoutQuotes))return null;
 const color=/\bcolou?r\b[^.;\n]*?(#[0-9a-f]{6})\b/i.exec(withoutQuotes);if(color)changes.color=color[1].toLowerCase();
 if(/\blaunch\s+quantization\s+to\s+global\b/i.test(withoutQuotes))changes.launch={quantization:'global'};
 else if(/\blaunch\s+quantization\s+to\s+eighth[- ]note\s+triplets\b/i.test(withoutQuotes))changes.launch={quantization:1/3};
 if(/\b(?:set|change|turn|enable|disable)\b[^.;]*\b(?:legato|launch mode|loop length|follow actions)\b/i.test(withoutQuotes))return null;
 if(/\bcolou?r\s+(?:both|all|the|these|selected|them|to|red|blue|teal|violet|green|orange)\b/i.test(withoutQuotes)&&!color)return null;
 if(!Object.keys(changes).length||/\b(?:except|excluding|only\s+(?:one|first|last)|unselected)\b/i.test(withoutQuotes))return null;
 // Do not partially ground an additional requested property that wasn't parsed.
 if(/\brename\b/i.test(withoutQuotes)&&!name||/\binfo\s+text\s+(?:to|exactly)\b/i.test(withoutQuotes)&&!info||/\blaunch\s+quantization\s+to\b/i.test(withoutQuotes)&&!changes.launch)return null;
 const ids=[...new Set((studio.selectedSession??[]).map(slot=>project.tracks.find(t=>t.id===slot.trackId)?.slots?.[slot.scene]).filter(Boolean))];if(!ids.length)fail('Select The Session Clip Sources Before Changing Their Properties.');
 return {ids,changes};
}
export function checkClipPropertyRequirements(project,plan,requirements){
 if(!requirements)return null;if(plan.before.length||plan.after.length||!plan.editCount)fail('Change Only The Requested Clip Source Properties. Do Not Add Navigation Or Playback Commands.');
 const expected=structuredClone(project),{changes}=requirements;
 for(const id of requirements.ids){const c=expected.clips[id];if(!c)fail('The Requested Clip Source No Longer Exists.');for(const key of ['name','color','infoText'])if(Object.hasOwn(changes,key)){if(changes[key]===null||key==='infoText'&&changes[key]==='')delete c[key];else c[key]=changes[key];}if(changes.launch){const launch={mode:c.launch?.mode??'trigger',quantization:c.launch?.quantization??'global',legato:c.launch?.legato??false};if(Object.keys(changes.launch).some(k=>launch[k]!==changes.launch[k]))c.launch={...c.launch,...launch,...changes.launch};}}
 if(!same(plan.next,expected))fail('The Candidate Does Not Match The Original Selected-Clip Request. Apply EXACT ids And changes From requestedClipProperties, Including Exact Info Text Punctuation And Launch Quantization (Eighth-Triplet = 1/3 Beat). Preserve Every Unmentioned Field.');
 return {ids:requirements.ids,properties:Object.keys(changes)};
}
