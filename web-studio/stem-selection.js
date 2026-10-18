// File selection never changes mute/solo, routing, sends or project selection.
export function availableStemChannels(project){return [...project.tracks.map(t=>({value:'track:'+t.id,type:'track',id:t.id,name:t.name})),...(project.returns||[]).map(t=>({value:'return:'+t.id,type:'return',id:t.id,name:t.name}))];}
export function selectedStemChannels(project,selection){
 const available=availableStemChannels(project);
 if(selection===undefined)return available;
 if(!Array.isArray(selection)||!selection.length||selection.length>available.length||selection.some(v=>typeof v!=='string')||new Set(selection).size!==selection.length)throw new Error('Choose One Or More Distinct Stem Tracks Or Returns.');
 const wanted=new Set(selection);if(selection.some(value=>!available.some(c=>c.value===value)))throw new Error('A Chosen Stem Track Or Return No Longer Exists.');
 return available.filter(c=>wanted.has(c.value));
}
export function stemSelectionMetadata(project,selection){const all=availableStemChannels(project),included=selectedStemChannels(project,selection).map(c=>c.value);return {mode:selection===undefined?'all':'chosen',included,excluded:all.filter(c=>!included.includes(c.value)).map(c=>c.value)};}
const failure=message=>Object.assign(new Error(message),{code:'stem_selection',userMessage:'The Stem Export Does Not Match Your Chosen Channels. Nothing Was Changed.'});
export function readStemSelectionRequirements(prompt,project,studio={}){
 if(typeof prompt!=='string')return null;const text=prompt.replace(/"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g,' ');
 if(!/\b(?:export|render|bounce|download)\b/i.test(text)||!/\b(?:stems?|zip)\b/i.test(text)||/\b(?:do not|don't|never)\s+(?:export|render|bounce|download)\b/i.test(text))return null;
 const verbs=[...text.matchAll(/\b(?:export|render|bounce|download)\b/gi)],target=verbs.map((m,i)=>text.slice(m.index,i+1<verbs.length?verbs[i+1].index:undefined).split(/[.!?;](?:\s|$)/)[0].split(/\b(?:and|then)\s+(?:keep|preserve|leave|select|mute|unmute|play|change)\b/i)[0]).filter(s=>/\b(?:stems?|zip)\b/i.test(s)).join(' ');
 const exclusions=target.replace(/\bwithout\s+(?:(?:effect\s+)?tails?|normali[sz]ation|dither)\b/gi,' ');
 const selected=/\bselected\s+tracks\b/i.test(target),chosen=/\b(?:chosen|selected)\s+(?:stem|export)\s+(?:tracks|channels)\b/i.test(target),all=/\b(?:all|every)\s+(?:individual\s+)?(?:stems|channels|tracks\s+and\s+returns)\b/i.test(target)&&!/\b(?:except|excluding|without)\b/i.test(exclusions);
 // Different scopes across multiple bundles stay with the model rather than
 // being flattened into one requirement for every ZIP.
 if([selected,chosen,all].filter(Boolean).length>1)return null;
 if(all)return {mode:'all'};
 if(!selected&&!chosen)return null;
 const channels=chosen?studio.delivery?.stems?.channels:availableStemChannels(project).filter(c=>studio.selectedTracks?.includes(c.id)).map(c=>c.value);
 if(!channels?.length)throw failure(chosen?'Choose Stem Export Channels First.':'Select Tracks Before Requesting Selected Stem Exports.');
 return {mode:'chosen',channels:selectedStemChannels(project,channels).map(c=>c.value)};
}
export function checkStemSelectionRequirements(project,commands,requirement){
 if(!requirement)return;const stems=commands.filter(c=>c.name==='export_stems');if(!stems.length)throw failure('The Request Requires A Stem ZIP; Include export_stems After Any Edits.');
 const expected=selectedStemChannels(project,requirement.mode==='all'?undefined:requirement.channels).map(c=>c.value);
 for(const command of stems){const actual=selectedStemChannels(project,command.args?.channels).map(c=>c.value);if(JSON.stringify(actual)!==JSON.stringify(expected))throw failure('export_stems Must Include Exactly The Requested Channels: '+JSON.stringify(expected)+'.');}
}
