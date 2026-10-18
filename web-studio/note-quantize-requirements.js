import {editNoteGroup} from './notes.js';
import {selectionIntent} from './studio-selection.js';
import {quantizeSettings} from './note-quantize.js';
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const namedGrids={whole:4,half:2,quarter:1,eighth:.5,sixteenth:.25,'thirty-second':.125,'sixty-fourth':.0625,'one-hundred-twenty-eighth':.03125};
// A bounded guard for a single named existing clip and explicitly listed pitches.
// Unsupported/ambiguous phrasing returns null; it is never reported as checked.
export function readQuantizeRequirements(prompt,project,manual={grid:.25,gridMode:'straight',target:'starts',strength:1}){
 if(typeof prompt!=='string'||/\b(?:do not|don't|never|avoid)\s+quantiz/i.test(prompt))return null;
 const positive=prompt.replace(/\b(?:do not|don't|never|no)\b[^.!?;\n]*/gi,'');
 if(/\b(?:transpose|duplicate|delete|remove|add|create|insert|split|chop|stretch|reverse|humanize|swing|rename|save|export|mix|render|launch|play|stop|mute|unmute|deactivate|activate|record|move|restructure|import|open|close)\b/i.test(positive))return null;
 if(/\b(?:bars?|beats?|before|after|between|first|last|except|excluding|selected|active|inactive|muted|unmuted|sounding|earliest|latest)\b/i.test(positive))return null;
 if(/\b(?:set|change)\s+(?:the )?(?:tempo|bpm|name|volume|pan|instrument|effect|routing)\b/i.test(positive))return null;
 const clause=positive.match(/\bquantiz(?:e|ing)\b([^.!?;\n]{0,200}?)\bnotes?\b/i)?.[1];
 if(!clause||/\b(?:except|excluding|selected|all|chord|range|between|from|through|or|either)\b/i.test(clause))return null;
 const names=[...clause.matchAll(/(?<![\w#♯♭])([A-G])([#b♯♭]?)(-1|[0-9])(?!\w)/g)];
 if(!names.length||names.length>12||clause.replace(/([A-G])([#b♯♭]?)(-1|[0-9])/g,'P').match(/P\s*(?:-|–|—|to|through)\s*P/i))return null;
 const pitches=[...new Set(names.map(([,letter,accidental,octave])=>12*(Number(octave)+1)+{C:0,D:2,E:4,F:5,G:7,A:9,B:11}[letter]+(['#','♯'].includes(accidental)?1:['b','♭'].includes(accidental)?-1:0)))].sort((a,b)=>a-b);
 if(pitches.some(p=>p<0||p>127))return null;
 const clips=Object.values(project?.clips||{}).filter(c=>c.kind==='midi'&&typeof c.name==='string'&&c.name.length>=3&&new RegExp('(?<!\\w)'+escaped(c.name)+'(?!\\w)','i').test(prompt));
 if(clips.length!==1)return null;const clip=clips[0];
 if(clip.notesTruncated||clip.noteCount>clip.notes.length)return null;
 // End/start target must be explicit. Ranges, mixed instructions and other edits stay with the model.
 const endOnly=/\b(?:only (?:the )?(?:note )?ends?|ends? only)\b/i.test(positive),startOnly=/\b(?:only (?:the )?(?:note )?starts?|starts? only)\b/i.test(positive),both=/\b(?:both (?:note )?starts? and (?:note )?ends?|starts? and ends?)\b/i.test(positive);
 if(Number(endOnly)+Number(startOnly)+Number(both)!==1)return null;
 const target=both?'both':endOnly?'ends':'starts';
 const mentions=[...positive.matchAll(/\b(whole|half|quarter|eighth|sixteenth|thirty-second|sixty-fourth|one-hundred-twenty-eighth)(?:[- ]notes?)?\b/gi)].map(m=>namedGrids[m[1].toLowerCase()]);
 if(!mentions.length||new Set(mentions).size!==1)return null;const grid=mentions[0];
 const triplet=/\btriplets?\b/i.test(positive),mixed=triplet&&(/\b(?:combined|straight[ -]and[ -]triplet)\b/i.test(prompt)||/\b(?:whole|half|quarter|eighth|sixteenth)(?:[- ]notes?)?\s+or\s+(?:whole|half|quarter|eighth|sixteenth)/i.test(positive));
 if(triplet&&/\bstraight\b/i.test(prompt)&&!mixed)return null;
 const amounts=[...positive.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:percent|%)/gi)].map(m=>Number(m[1])/100);
 if(new Set(amounts).size>1)return null;
 const strength=amounts[0]??(/\b(?:full strength|full amount|at full|100%)\b/i.test(prompt)?1:(manual?.strength??1));
 let settings;try{settings=quantizeSettings({grid,gridMode:mixed?'both':triplet?'triplet':'straight',target,strength});}catch{return null;}
 const indices=clip.notes.flatMap((n,i)=>pitches.includes(n.pitch)?[i]:[]);if(!indices.length||pitches.some(p=>!clip.notes.some(n=>n.pitch===p)))return null;
 const show=/\b(?:show|highlight|select)\b/i.test(positive),arrangement=/\barrangement\b/i.test(positive),session=/\bsession\s+(?:clip|slot|view)\b/i.test(positive);
 if(show&&arrangement&&session)return null;
 return {clipId:clip.id,clipName:clip.name,pitches,indices,settings,...(show?{selection:arrangement?'arrangement':session?'session':'notes'}:{})};
}
export function checkQuantizeRequirements(project,plan,requirements){
 if(!requirements)return null;
 const r=requirements,clip=project.clips[r.clipId],expected=editNoteGroup(clip,'quantize',{...r.settings,indices:r.indices}).notes;
 const message='Requested quantization: '+JSON.stringify({clipId:r.clipId,pitches:r.pitches,indices:r.indices.slice(0,64),settings:r.settings,selection:r.selection})+'. Preserve every unchosen note and all note metadata. Use exact indices or separate exact-pitch filters, never a range containing other pitches. Select target notes using these indices and the actual source regionId/Session placement.';
 const mismatch=()=>Object.assign(new Error(message),{code:'note_quantization',userMessage:'Odesa’s plan did not match the requested notes or timing. No changes were applied.',validationDetails:{requestedNoteQuantization:r}});
 const wanted=structuredClone(project);wanted.clips[r.clipId].notes=expected;
 if(JSON.stringify(plan.next)!==JSON.stringify(wanted))throw mismatch();
 if(r.selection){const command=plan.after.at(-1);if(command?.name!=='select')throw mismatch();let chosen;try{chosen=selectionIntent(plan.next,command.args);}catch{throw mismatch();}
  if(chosen.target!=='notes'||chosen.clipId!==r.clipId||JSON.stringify(chosen.indices)!==JSON.stringify(r.indices)||r.selection==='arrangement'&&chosen.placement.target!=='regions'||r.selection==='session'&&chosen.placement.target!=='clip')throw mismatch();
 }
 return {type:'explicit_note_quantization',clipId:r.clipId,pitches:r.pitches,settings:r.settings,selectedIndices:r.indices,selection:r.selection??null};
}
