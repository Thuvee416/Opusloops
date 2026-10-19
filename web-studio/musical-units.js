// The DAW currently has a fixed 4/4 meter. Keep conversions at one boundary;
// model plans can copy musical units instead of doing arithmetic themselves.
export const BEATS_PER_BAR=4;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fail=message=>{throw new Error(message);};
export function musicalPosition(value){
 if(!object(value))return value; // Legacy engine coordinates are already beats.
 if(Object.keys(value).some(k=>!['bar','beat'].includes(k))||!finite(value.beat??1))fail('Use a musical position {bar:1,beat:1}, or {beat:1} for a displayed beat.');
 if(value.bar!==undefined){
  const beat=value.beat??1;
  if(!Number.isInteger(value.bar)||value.bar<1||beat<1||beat>=BEATS_PER_BAR+1)fail('Bars start at 1; the beat within a 4/4 bar must be at least 1 and below 5.');
  return (value.bar-1)*BEATS_PER_BAR+beat-1;
 }
 if(!finite(value.beat)||value.beat<1)fail('Displayed beat positions start at 1.');
 return value.beat-1;
}
function span(value,signed=false){
 if(!object(value))return value;
 const keys=Object.keys(value);
 if(keys.length!==1||!['bars','beats'].includes(keys[0])||!finite(value[keys[0]])||!signed&&value[keys[0]]<0)fail('Use one '+(signed?'offset':'duration')+' unit: bars or beats.');
 return value[keys[0]]*(keys[0]==='bars'?BEATS_PER_BAR:1);
}
export const musicalDuration=value=>span(value);
export const musicalDelta=value=>span(value,true);
export function musicalGain(current,value){
 if(!object(value))return value;
 const keys=Object.keys(value),key=keys[0];
 if(keys.length!==1||!['linear','db','relativeDb'].includes(key)||!finite(value[key]))fail('Use one gain unit: linear, db, or relativeDb.');
 const gain=key==='linear'?value[key]:10**(value[key]/20)*(key==='relativeDb'?current:1);
 if(!finite(gain)||gain<0||gain>1)fail('The requested fader gain must stay between silence and unity.');
 return gain;
}
const convert=(v,key,fn)=>{if(v&&Object.hasOwn(v,key))v[key]=fn(v[key]);};
const note=n=>{convert(n,'start',musicalPosition);convert(n,'duration',musicalDuration);return n;};
export function normalizeMusicalAction(action){
 if(!object(action))return action;
 const out=structuredClone(action),x=typeof out.args==='string'?JSON.parse(out.args):out.args;
 if(!object(x))return out;out.args=x;
 if(out.type==='midi'){convert(x,'beats',musicalDuration);if(Array.isArray(x.notes))x.notes=x.notes.map(note);}
 if(['region','time','region_crossfade'].includes(out.type)){for(const key of ['start','boundary'])convert(x,key,musicalPosition);for(const key of ['length','offset'])convert(x,key,musicalDuration);}
 if(out.type==='region_fades')for(const key of ['fadeIn','fadeOut'])convert(x,key,musicalDuration);
 if(out.type==='region_group')convert(x,'delta',musicalDelta);
 if(out.type==='notes'){if(Array.isArray(x.notes))x.notes=x.notes.map(note);if(object(x.patch))note(x.patch);convert(x,'at',musicalPosition);convert(x,'deltaBeats',musicalDelta);if(object(x.where))for(const key of ['start','end'])convert(x.where,key,musicalPosition);}
 if(out.type==='project')for(const key of ['loopStart','loopEnd'])convert(x.transport,key,musicalPosition);
 if(out.type==='automation'){convert(x,'beat',musicalPosition);if(Array.isArray(x.points))for(const p of x.points)convert(p,'beat',musicalPosition);}
 if(out.type==='locators'&&Array.isArray(x.items))for(const item of x.items)convert(item,'beat',musicalPosition);
 if(out.type==='command'&&object(x.args)){
  if(x.name==='seek')convert(x.args,'beat',musicalPosition);
  if(['export_wav','export_stems','export_midi'].includes(x.name)&&object(x.args.range)){convert(x.args.range,'start',musicalPosition);convert(x.args.range,'length',musicalDuration);}
 }
 return out;
}
