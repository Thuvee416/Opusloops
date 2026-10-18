import {Engine} from '/audio.js';import {applyAgentActions} from '/agent-actions.js';import {renderStemArchive} from '/stem-export.js';
const assert=(ok,message)=>{if(!ok)throw new Error(message);},rate=48000,opts={sampleRate:rate,bitDepth:32,normalize:false,dither:'none',includeTail:false,source:'arrangement'};
function samples(buffer){const v=new DataView(buffer.buffer??buffer,buffer.byteOffset??0,buffer.byteLength);assert(v.getUint16(20,true)===3&&v.getUint32(24,true)===rate,'Expected float stereo WAV');return Float32Array.from({length:v.getUint32(40,true)/8},(_,i)=>v.getFloat32(44+i*8,true));}
async function render(p,channel,range){const e=new Engine(structuredClone(p),()=>{});try{return samples(await e.render({...opts,channel,...(range?{range}:{})}));}finally{await e.context?.close();}}
function difference(actual,expected,label){assert(actual.length===expected.length,label+' frame count');let max=0;for(let i=0;i<actual.length;i++){assert(Number.isFinite(actual[i]),label+' nonfinite');max=Math.max(max,Math.abs(actual[i]-expected[i]));}assert(max<2e-6,label+' max error '+max);return max;}
const envelope=(trackId,key,points,extra={})=>({type:'automation',args:{trackId,key,points,...extra}});
async function checks(){
 const p=await(await fetch('/qa-project.json')).json(),before=JSON.stringify(p),base=await render(p,'track:lead');
 const gain=applyAgentActions(p,[envelope('lead','gain',[{beat:0,value:-12},{beat:4,value:0}],{deviceId:'gain'})]),dry=await render(gain,'track:lead');
 const metrics={deviceGainMaxError:difference(dry,Float32Array.from(base,(v,i)=>v*10**((-12+3*Math.min(4,i/rate*2))/20)),'Linear dB automation')};
 const send=applyAgentActions(p,[envelope('lead','amount',[{beat:0,value:0},{beat:4,value:1}],{returnId:'echo'})]),wet=await render(send,'return:echo'),delayFrames=rate*.125;
 metrics.sendMaxError=difference(wet,Float32Array.from(wet,(_,i)=>i<delayFrames?0:base[i-delayFrames]*Math.min(1,(i-delayFrames)/rate*2/4)*.8),'Send into wet delay');
 const returnFx=applyAgentActions(send,[envelope('echo','mix',[{beat:0,value:0},{beat:4,value:1}],{deviceId:'echo-delay'})]);
 const actual=await render(returnFx,'return:echo'),input=Float32Array.from(base,(v,i)=>v*Math.min(1,i/rate*2/4)*.8);
 metrics.returnEffectMaxError=difference(actual,Float32Array.from(input,(v,i)=>{const mix=Math.min(1,i/rate*2/4);return v*(1-mix)+(i<delayFrames?0:input[i-delayFrames])*mix;}),'Return dry/wet automation');
 const ranged=await render(returnFx,'return:echo',{start:2,length:4});metrics.rangeMaxError=difference(ranged,actual.slice(rate,rate*3),'History-preserving range');
 const reopened=JSON.parse(JSON.stringify(returnFx));metrics.saveReopenMaxError=difference(await render(reopened,'return:echo'),actual,'Saved automation');
 const e=new Engine(reopened,()=>{});try{const bytes=await renderStemArchive(e,opts),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=new Map();let at=0;while(v.getUint32(at,true)===0x04034b50){const length=v.getUint32(at+18,true),n=v.getUint16(at+26,true),extra=v.getUint16(at+28,true),name=new TextDecoder().decode(bytes.subarray(at+30,at+30+n)),start=at+30+n+extra;files.set(name,bytes.slice(start,start+length));at=start+length;}const manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json'))),file=manifest.channels.find(c=>c.id==='echo').file;metrics.stemMaxError=difference(samples(files.get(file)),actual,'Automated return stem');}finally{await e.context?.close();}
 assert(JSON.stringify(p)===before,'Source project mutated');assert(metrics.sendMaxError>=0&&wet.some(v=>Math.abs(v)>.001),'Missing wet output');
 return {status:'passed',sampleRate:rate,frames:base.length,metrics,scope:'Native Chromium OfflineAudioContext. Independent per-sample dB-gain and delay/send/dry-wet predictions; WAV, stem and range audio plus JSON reopen. No physical-output or perceptual quality claim.'};
}
document.querySelector('button').onclick=async event=>{event.target.disabled=true;try{document.querySelector('pre').textContent=JSON.stringify(await checks(),null,2);}catch(error){document.querySelector('pre').textContent=JSON.stringify({status:'failed',error:error.message,stack:error.stack},null,2);}finally{event.target.disabled=false;}};
