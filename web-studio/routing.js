import {createStereoMeter} from './level-meter.js';
import {trackRouting,routingSoloState,trackOutput} from './track-routing.js';
import {crossfadeGain,validateCrossfade} from './crossfade.js';
import {validateAutomation,hasEnvelope,SEND_AUTOMATION,sendKey} from './automation.js';
import {createDeviceChain,effectTail,newDevice,validateDevices} from './devices.js';
export function newReturn(name='Return A'){const reverb=newDevice('reverb');reverb.params.mix=1;return {id:crypto.randomUUID(),name,volume:.7,pan:0,mute:false,color:'#c5ae83',devices:[reverb]};}
export function validateRouting(project){
  const returns=project.returns??[];if(!Array.isArray(returns)||returns.length>4)throw new Error('A project supports up to four returns.');const ids=new Set(project.tracks.map(t=>t.id)),buses=new Set();
  for(const r of returns){if(!r||typeof r.id!=='string'||ids.has(r.id)||typeof r.name!=='string'||r.name.length<1||r.name.length>40||!Number.isFinite(r.volume)||r.volume<0||r.volume>1||!Number.isFinite(r.pan)||r.pan<-1||r.pan>1||typeof r.mute!=='boolean'||!/^#[0-9a-f]{6}$/i.test(r.color))throw new Error('Invalid return track.');if(r.solo!==undefined&&r.solo!==false)throw new Error('Return-track Solo is not implemented; regular-track bus Solo is supported.');if(r.output!==undefined&&r.output!=='master')throw new Error('Return main outputs currently feed Master only; use a regular-track bus for track-to-track routing.');ids.add(r.id);buses.add(r.id);validateAutomation(r.automation);validateDevices(r.devices);}
  validateCrossfade(project);trackRouting(project);
  for(const t of project.tracks){if(t.sends!==undefined){if(!t.sends||typeof t.sends!=='object'||Array.isArray(t.sends))throw new Error('Invalid sends.');for(const [id,s] of Object.entries(t.sends)){if(!buses.has(id)||!s||!Number.isFinite(s.amount)||s.amount<0||s.amount>1||typeof s.pre!=='boolean')throw new Error('Invalid send destination or level.');validateAutomation(s.automation,SEND_AUTOMATION);}}}
}
export function routingTail(project,sampleRate=44100,channel='master'){
 const routes=trackRouting(project),incoming=new Map(project.tracks.map(t=>[t.id,0])),byId=new Map(project.tracks.map(t=>[t.id,t])),trackTails=new Map(),returnTails=new Map((project.returns||[]).map(r=>[r.id,0]));let tail=0;
 for(const id of routes.order){const t=byId.get(id),source=incoming.get(id)+effectTail([t],sampleRate),destination=routes.destinations.get(id);trackTails.set(id,source);if(destination!==null)incoming.set(destination,Math.max(incoming.get(destination),source));else if(trackOutput(t)!=='sendsOnly')tail=Math.max(tail,source);
  for(const r of project.returns||[])if(t.sends?.[r.id]?.amount>0||(hasEnvelope(t.sends?.[r.id]?.automation?.amount)&&t.sends[r.id].automation.amount.points.some(p=>p.value>0)))returnTails.set(r.id,Math.max(returnTails.get(r.id),source+effectTail([r],sampleRate)));
 }
 if(channel==='master')return Math.max(tail,0,...returnTails.values());
 const value=typeof channel==='string'&&channel.startsWith('track:')?trackTails.get(channel.slice(6)):typeof channel==='string'&&channel.startsWith('return:')?returnTails.get(channel.slice(7)):undefined;if(value===undefined)throw new Error('Choose an existing audio routing channel.');return value;
}
export function createMixGraph(ctx,project,master,{meters=true}={}){
  const tracks=new Map(),returns=new Map(),nodes=[],chains=[],readers=[];const node=n=>(nodes.push(n),n);const initialRoutes=trackRouting(project),initialSolo=routingSoloState(project,initialRoutes);
  function strip(t){const chain=createDeviceChain(ctx,t.devices,{getBpm:()=>project.bpm});chains.push(chain);const gain=node(ctx.createGain()),cross=node(ctx.createGain()),gate=node(ctx.createGain()),pan=node(ctx.createStereoPanner()),analyser=node(ctx.createAnalyser());gain.gain.value=t.volume;cross.gain.value=crossfadeGain(t.crossfade,project.crossfade?.position,project.crossfade?.curve);gate.gain.value=t.mute?0:1;pan.pan.value=t.pan;analyser.fftSize=256;chain.output.connect(gain);gain.connect(cross);cross.connect(gate);gate.connect(pan);pan.connect(analyser);const meter=meters?createStereoMeter(ctx,pan):null;if(meter)readers.push(meter);return {chain,gain,cross,gate,pan,analyser,meter};}
  const dispose=()=>{for(const m of readers)try{m.dispose();}catch{}for(const n of nodes)try{n.disconnect();}catch{}for(const c of chains)try{c.dispose();}catch{}};
  try{
  for(const r of project.returns||[]){const m=strip(r);m.analyser.connect(master);returns.set(r.id,m);}
  for(const t of project.tracks){const m=strip(t);m.input=node(ctx.createGain());m.input.gain.value=initialSolo.own.has(t.id)?1:0;m.input.connect(m.chain.input);m.gate.gain.value=!t.mute&&initialSolo.through.has(t.id)?1:0;m.dry=node(ctx.createGain());m.dry.gain.value=trackOutput(t)==='sendsOnly'?0:1;m.analyser.connect(m.dry);m.preGate=node(ctx.createGain());m.preGate.gain.value=m.gate.gain.value;const prePan=node(ctx.createStereoPanner());m.chain.output.connect(prePan);prePan.connect(m.preGate);m.sends=new Map();
    for(const r of project.returns||[]){const pre=node(ctx.createGain()),post=node(ctx.createGain()),send=t.sends?.[r.id]||{amount:0,pre:false};pre.gain.value=send.pre?send.amount:0;post.gain.value=send.pre?0:send.amount;m.preGate.connect(pre);m.pan.connect(post);pre.connect(returns.get(r.id).chain.input);post.connect(returns.get(r.id).chain.input);m.sends.set(r.id,{pre,post});}tracks.set(t.id,m);
  }
  function connectOutput(id,destination){const m=tracks.get(id);m.dry.connect(destination===null?master:tracks.get(destination).chain.input);m.routeDestination=destination;}
  for(const [id,destination]of initialRoutes.destinations)connectOutput(id,destination);
  const target=(p,v)=>p.setTargetAtTime(v,ctx.currentTime,.01);
  function update({automated=()=>false}={}){const routes=trackRouting(project),solo=routingSoloState(project,routes),changed=[...routes.destinations].filter(([id,destination])=>tracks.get(id).routeDestination!==destination);for(const [id]of changed)tracks.get(id).dry.disconnect();for(const [id,destination]of changed)connectOutput(id,destination);for(const t of project.tracks){const m=tracks.get(t.id);if(!m)continue;target(m.cross.gain,crossfadeGain(t.crossfade,project.crossfade?.position,project.crossfade?.curve));target(m.input.gain,solo.own.has(t.id)?1:0);target(m.gate.gain,!t.mute&&solo.through.has(t.id)?1:0);target(m.preGate.gain,!t.mute&&solo.through.has(t.id)?1:0);target(m.dry.gain,trackOutput(t)==='sendsOnly'?0:1);for(const [id,s] of m.sends){const setting=t.sends?.[id]||{amount:0,pre:false};if(automated(t,sendKey(id)))continue;s.pre.gain.cancelScheduledValues(ctx.currentTime);s.post.gain.cancelScheduledValues(ctx.currentTime);target(s.pre.gain,setting.pre?setting.amount:0);target(s.post.gain,setting.pre?0:setting.amount);}}for(const r of project.returns||[]){const m=returns.get(r.id);target(m.cross.gain,crossfadeGain(r.crossfade,project.crossfade?.position,project.crossfade?.curve));if(!automated(r,'volume'))target(m.gain.gain,r.volume);target(m.gate.gain,r.mute?0:1);if(!automated(r,'pan'))target(m.pan.pan,r.pan);}}
  return {tracks,returns,update,dispose};
  }catch(error){dispose();throw error;}
}
