export const SEND_AUTOMATION={amount:{min:0,max:1}};
export const sendKey=id=>JSON.stringify(['send',id]);
export const AUTOMATION={volume:{min:0,max:1},pan:{min:-1,max:1}};
export function validateAutomation(automation,specs=AUTOMATION){
  if(automation===undefined)return;if(!automation||typeof automation!=='object'||Array.isArray(automation))throw new Error('Invalid automation data.');
  for(const [key,envelope] of Object.entries(automation)){
    const spec=Object.hasOwn(specs,key)?specs[key]:null;if(!spec||!envelope||typeof envelope.enabled!=='boolean'||!Array.isArray(envelope.points)||envelope.points.length>4096)throw new Error('Invalid automation envelope.');let last=-1;
    for(const p of envelope.points){if(!p||!Number.isFinite(p.beat)||p.beat<0||p.beat>16384||p.beat<=last||!Number.isFinite(p.value)||p.value<spec.min||p.value>spec.max||!['linear','step'].includes(p.curve))throw new Error('Automation points need unique increasing beats, valid values, and linear or step segments.');last=p.beat;}
  }
}
export const hasEnvelope=envelope=>!!(envelope?.enabled&&envelope.points.length);
export function envelopeValue(envelope,beat,fallback){
  if(!hasEnvelope(envelope))return fallback;const p=envelope.points;if(beat<=p[0].beat)return p[0].value;
  let i=0;while(i+1<p.length&&p[i+1].beat<=beat)i++;const left=p[i],right=p[i+1];if(!right||left.curve==='step')return left.value;return left.value+(right.value-left.value)*(beat-left.beat)/(right.beat-left.beat);
}
function curveAt(envelope,beat){let curve='step';for(const p of envelope.points){if(p.beat>beat)break;curve=p.curve;}return curve;}
export function scheduleEnvelope(param,envelope,start,length,time,secondsPerBeat,fallback,sampleRate=48000){
  param.setValueAtTime(envelopeValue(envelope,start,fallback),time);if(!hasEnvelope(envelope)||length<=0)return;
  // Separate boundary anchors by one sample so dynamically queued loop jumps
  // cannot share an AudioParam event timestamp with the previous ramp endpoint.
  const anchor=Math.min(1/sampleRate,length*secondsPerBeat/4);param.setValueAtTime(envelopeValue(envelope,start+anchor/secondsPerBeat,fallback),time+anchor);
  const end=start+length,bounds=[...envelope.points.filter(p=>p.beat>start&&p.beat<end).map(p=>p.beat),end];let previous=start;
  for(const beat of bounds){const value=envelopeValue(envelope,beat,fallback),at=time+(beat-start)*secondsPerBeat;if(curveAt(envelope,previous)==='linear'){const epsilon=Math.min(1/sampleRate,(beat-previous)*secondsPerBeat/2);param.linearRampToValueAtTime(envelopeValue(envelope,beat-epsilon/secondsPerBeat,fallback),at-epsilon);}param.setValueAtTime(value,at);previous=beat;}
}
export function editEnvelope(track,key,action,{beat=0,value=0,curve='linear',index=-1,enabled=true}={},specs=AUTOMATION){
  if(!Object.hasOwn(specs,key))throw new Error('Choose an automatable parameter.');const automation=structuredClone(track.automation||{}),envelope=automation[key]||{enabled:true,points:[]};automation[key]=envelope;
  if(action==='set'){const point={beat,value,curve};if(index>=0){if(!envelope.points[index])throw new Error('Select a point.');envelope.points.splice(index,1);}const existing=envelope.points.findIndex(p=>p.beat===beat);if(existing>=0)envelope.points[existing]=point;else envelope.points.push(point);envelope.points.sort((a,b)=>a.beat-b.beat);}
  else if(action==='delete'){if(!envelope.points[index])throw new Error('Select a point.');envelope.points.splice(index,1);}
  else if(action==='clear')envelope.points=[];
  else if(action==='enable')envelope.enabled=enabled;
  else throw new Error('Unknown automation edit.');validateAutomation(automation,specs);return automation;
}
