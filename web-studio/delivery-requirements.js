import {deliveryOptions,DELIVERY_KEYS,STEM_DELIVERY_KEYS} from './delivery-options.js';

// This is an execution guard for explicit encoding/range settings, not a planner.
// Musical intent, named sections and settings that differ per artifact stay with
// the model. Only unambiguous single-export or explicitly shared settings apply.
const number='(-?\\d+(?:\\.\\d+)?)';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function failure(message,userMessage,details){return Object.assign(new Error(message),{code:'delivery_requirements',userMessage,validationDetails:details});}
function requiredFormats(text){
 const formats=new Set(),verbs=[...text.matchAll(/\b(?:export|render|bounce|download)\b/gi)];
 for(let i=0;i<verbs.length;i++){
  const start=verbs[i].index,span=text.slice(start,i+1<verbs.length?verbs[i+1].index:undefined).split(/[.!?;](?:\s|$)/)[0],as=span.search(/\b(?:as|to)\b/i),target=(as<0?span:span.slice(as)).split(/\b(?:from|using)\b|\band\s+(?:keep|preserve|leave)\b/i)[0],zip=/\bzip\b/i.test(target),wav=/\bwavs?\b/i.test(target),stemScope=/\bstems?\b/i.test(span.slice(0,as<0?span.length:as));
  if(/\bor\b/i.test(target))continue;
  if(zip)formats.add('stems');
  // WAV-encoded stems may legitimately arrive inside one ZIP. Explicit separate
  // WAVs, or WAV plus ZIP targets, require the direct WAV operation as well.
  if(wav&&(!stemScope||zip||/\bseparat(?:e|ely)\b/i.test(span)))formats.add('wav');
 }
 return [...formats];
}
export function readDeliveryRequirements(prompt){
 if(typeof prompt!=='string')return null;
 const text=prompt.replace(/"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g,' ');
 if(!/\b(?:export|render|bounce|download)\b/i.test(text)||/\b(?:do not|don't|never)\s+(?:export|render|bounce|download)\b/i.test(text))return null;
 const formats=[...(/\bwavs?\b/i.test(text)?['wav']:[]),...(/\b(?:stems?|zip)\b/i.test(text)?['stems']:[])];if(!formats.length)return null;
 if(/\bmidi\b/i.test(text)&&!/\b(?:wavs?|zip|audio)\b/i.test(text))return null;
 const shared=/\b(?:every|each|all)\s+(?:(?:audio|requested|two|three)\s+)?(?:exports?|downloads?|files?)\b|\b(?:same|identical)\s+(?:export\s+)?(?:settings|options)\b|\bfor\s+both\s+(?:exports?|files?|downloads?|formats?)\b|\bfor\s+both\s*(?:[.!?;]|$)/i.test(text);
 const sharedFields=new Set();for(const [key,phrase]of [['range','range'],['sampleRate','sample rate'],['bitDepth','bit depth'],['normalize','normalization'],['dither','dither'],['includeTail','effect tails?']])if(new RegExp('\\b(?:same|identical)\\s+'+phrase+'\\b','i').test(text))sharedFields.add(key);
 const values=new Map(),unresolved=[];const add=(key,value)=>{const list=values.get(key)||[];if(!list.some(v=>equal(v,value)))list.push(value);values.set(key,list);};
 for(const m of text.matchAll(new RegExp('\\b'+number+'\\s*(kHz|Hz)\\b','gi'))){const rate=Number(m[1])*(m[2].toLowerCase()==='khz'?1000:1),prefix=text.slice(Math.max(0,m.index-40),m.index);if(/\b(?:filter|cutoff|frequency|tone|oscillator|lfo|crossover)\s*(?:to|at|of|[:=])?\s*$/i.test(prefix))continue;if(rate>=8000||/\b(?:sample\s*rate|export\s*(?:at)?|render\s*(?:at)?|rate)\s*[:=]?\s*$/i.test(prefix))add('sampleRate',rate);}
 for(const m of text.matchAll(/\b(16|24|32)\s*[- ]?bit\b/gi))add('bitDepth',Number(m[1]));
 if(/\b(?:16|24)\s*[- ]?bit\s+float\b|\b32\s*[- ]?bit\s+PCM\b/i.test(text))throw new Error('The supported WAV encodings are 16/24-bit PCM and 32-bit float.');
 if(/\b(?:no|without)\s+normali[sz]ation\b|\b(?:do not|don't|never)\s+normali[sz]e\b|\bnormali[sz]e\s*[:=]?\s*false\b|\bnormali[sz]ation\s+off\b/i.test(text))add('normalize',false);
 if(/\bwith\s+normali[sz]ation\b|\bnormali[sz]e\s*[:=]?\s*true\b|\bnormali[sz]ation\s+on\b/i.test(text))add('normalize',true);
 if(/\b(?:no|without)\s+dither\b|\bdither\s*[:=]?\s*none\b/i.test(text))add('dither','none');
 if(/\btriangular\s+dither\b|\bdither\s*[:=]?\s*triangular\b/i.test(text))add('dither','triangular');
 if(/\b(?:no|without)\s+(?:effect\s+)?tails?\b|\b(?:do not|don't|never)\s+include\s+(?:effect\s+)?tails?\b|\b(?:effect\s+)?tails?\s+excluded\b|\bincludeTail\s*[:=]?\s*false\b/i.test(text))add('includeTail',false);
 if([...text.matchAll(/\b(?:with|include)\s+(?:effect\s+)?tails?\b/gi)].some(m=>!/\b(?:not|don't|never)\s*$/i.test(text.slice(Math.max(0,m.index-12),m.index)))||/\bincludeTail\s*[:=]?\s*true\b/i.test(text))add('includeTail',true);
 if(/\bsource\s*[:=]?\s*session\b|\bsession\s+snapshot\b/i.test(text))add('source','session');
 if(/\bsource\s*[:=]?\s*arrangement\b/i.test(text))add('source','arrangement');
 const rangePattern=new RegExp('\\brange\\s+start\\s*[:=]?\\s*'+number+'\\s*(?:,\\s*|\\s+)(?:and\\s+)?length\\s*[:=]?\\s*'+number,'gi');
 for(const m of text.matchAll(rangePattern))add('range',{start:Number(m[1]),length:Number(m[2])});
 for(const m of prompt.matchAll(/\brange["']?\s*[:=]?\s*(\{[^{}]{1,160}\})/gi)){
  const keys=[...m[1].matchAll(/["']?(\w+)["']?\s*:/g)],parts=[...m[1].matchAll(new RegExp('["\x27]?(\\w+)["\x27]?\\s*:\\s*'+number+'(?=\\s*[,}])','g'))],range={};
  if(keys.length!==2||parts.length!==2||parts.some(p=>!['start','length'].includes(p[1]))||new Set(parts.map(p=>p[1])).size!==2)throw new Error('An explicit export range needs numeric start and length only.');
  for(const part of parts)range[part[1]]=Number(part[2]);add('range',{start:range.start,length:range.length});
 }
 const settings={};for(const [key,list]of values){if(list.length===1&&(shared||!sharedFields.size||sharedFields.has(key)))settings[key]=list[0];else if(list.length>1&&(shared||sharedFields.has(key)))throw new Error('Conflicting shared export '+key+' values. Specify one value for every export, or request separately configured files.');else unresolved.push(key);}
 if(settings.range){if(settings.source==='session')throw new Error('An Arrangement export range cannot be combined with a Session snapshot.');settings.source='arrangement';}
 const outputs=requiredFormats(text);if(!Object.keys(settings).length&&!outputs.length)return null;
 return {scope:shared||sharedFields.size?'shared':'single',formats,requiredFormats:outputs,settings,unresolved};
}
const effectiveSource=(project,settings)=>settings.source==='auto'?(project.arrangement.length?'arrangement':'session'):settings.source;
function differences(settings,expected){return Object.keys(expected).filter(key=>!equal(settings[key],expected[key]));}
export function checkDeliveryRequirements(project,commands,requirements){
 const checks=new Map();if(!requirements)return checks;
 const exports=commands.filter(c=>['export_wav','export_stems'].includes(c.name));
 if(!exports.length)throw failure('The request includes explicit audio export settings; include its audio export runtime command after all edits, or ask a question without applying edits.','The plan is missing your requested export. Nothing was changed.',{requested:requirements.settings});
 const missingFormats=(requirements.requiredFormats??[]).filter(format=>!exports.some(c=>c.name==='export_'+format));
 if(missingFormats.length)throw failure('The request explicitly requires '+missingFormats.map(f=>f==='stems'?'a stem ZIP (export_stems)':'a direct WAV (export_wav)').join(' and ')+'. Add the missing export commands after edits. A summary or selection command does not generate the requested file. No edits or runtime actions have run.','The plan is missing a requested file type. Nothing was changed.',{requiredFormats:requirements.requiredFormats,plannedFormats:exports.map(c=>c.name==='export_stems'?'stems':'wav')});
 // Do not impose one artifact's settings on a differently configured artifact.
 const requested=requirements.scope==='shared'||exports.length===1?requirements.settings:{};
 for(const command of exports){
  const kind=command.name==='export_wav'?'wav':'stems',settings=deliveryOptions(project,command.args??{},kind),actual={...settings,source:effectiveSource(project,settings)},missing=differences(actual,requested),requiredFormat=(requirements.requiredFormats??[]).includes(kind)?kind:null;
  if(missing.length)throw failure(command.name+' does not match the explicit requested export settings: '+missing.join(', ')+'. Required settings '+JSON.stringify(requirements.settings)+'. Put these inside EVERY applicable command.args, including export_stems. An omitted range is whole Arrangement, even when the duration happens to match. No edits or runtime actions have run.','The export plan did not match your requested settings. Nothing was changed.',{command:command.name,fields:missing,requested:requirements.settings,planned:actual});
  if(Object.keys(requested).length||requiredFormat)checks.set(command,{kind,settings,source:actual.source,requested:structuredClone(requested),requiredFormat});
 }
 return checks;
}
export function checkDeliveryReceipt(project,result,expected){
 if(!expected)return;
 if(!result?.delivery||result.delivery.format!==expected.kind||!result.delivery.settings)throw failure('The export did not report its actual settings. Remaining actions stopped.','The generated export settings could not be verified. Remaining actions stopped.',{expected:expected.settings,reported:result?.delivery??null});
 const settings=deliveryOptions(project,result.delivery.settings,expected.kind),keys=[...DELIVERY_KEYS.filter(k=>k!=='source'),...(expected.kind==='wav'?['channel']:STEM_DELIVERY_KEYS)],mismatch=keys.filter(k=>!equal(settings[k],expected.settings[k])),source=effectiveSource(project,settings),sourceMismatch=source!==expected.source||result.delivery.source!==source;
 if(expected.selection&&!equal(result.delivery.selection,expected.selection))mismatch.push('stem channels');
 if(mismatch.length||sourceMismatch)throw failure('An export was generated with unexpected '+[...mismatch,...(sourceMismatch?['source']:[])].join(', ')+'. Its ready receipt is not verification of the requested file; remaining actions stopped.','A generated export did not match the checked settings. Remaining actions stopped.',{expected:expected.settings,reported:result.delivery});
}
