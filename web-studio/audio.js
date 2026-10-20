import {DEVICE_TYPES,validateDevices} from './devices.js';
import {sampleKey,instrumentSamples,prepareInstrumentSamples,samplePreparationBinding,samplesStillCurrent,installInstrumentSamples} from './sample-preparation.js';
import {createStereoMeter} from './level-meter.js';
import {InputClickClock,metronomeAudible,metronomeLevel} from './metronome.js';
import {slotActive} from './slot-metadata.js';
import {isGroup,groupLeaves} from './track-hierarchy.js';
import {setTrackOutput} from './track-routing.js';
import {captureScene} from './capture-scene.js';
import {stretchAudio,stretchPlan} from './warp.js';
import {followDelay,followTarget} from './follow-actions.js';
import {BufferScheduler} from './buffer-scheduler.js';
import {isNoteActive} from './note-state.js';
import {exportChannel} from './export-channel.js';
import {exportRangePlan} from './export-range.js';
import {exportOptions,encodeWave} from './wav-export.js';
import {processMidiClip} from './midi-effects.js';
import {consolidationSource,CONSOLIDATE_BYTES} from './consolidate.js';
import {audioEditKey,editedAudioBuffer} from './audio-edit.js';
import {nextLaunchBeat,pendingQuantum,toggleLaunchAction,repeatGrid,slotStops} from './launch.js';
import {AutomationTake} from './automation-recording.js';
import {automationChannels,automationTargets,automationTargetFor,deviceKey,scheduleTarget} from './automation-targets.js';
import {VoiceScheduler,voiceTail} from './voice-scheduler.js';
import {hasEnvelope,sendKey} from './automation.js';
import {defaultTransport,timelineBeat,quantumLength} from './transport.js';
import {createMixGraph,routingTail} from './routing.js';
import {mod,arrangementSlices,segmentAt,uid,wav,isRegionActive} from './model.js';
export function synthesize(context,clip,bpm){
  const sr=context.sampleRate,spb=60/bpm,len=Math.ceil(clip.beats*spb*sr),buffer=context.createBuffer(1,len,sr),out=buffer.getChannelData(0);
  let seed=237;const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2147483648-1;};
  if(clip.kind==='drums'){
    for(let step=0;step<clip.beats*4;step++){
      const start=Math.round(step*.25*spb*sr);
      if(clip.pattern!=='hats'&&step%4===0&&(clip.pattern!=='sparse'||step%8===0))for(let i=0;i<sr*.32&&start+i<len;i++){const t=i/sr;out[start+i]+=Math.sin(2*Math.PI*(48*t+4*(1-Math.exp(-t*30))))*Math.exp(-t*15)*.65;}
      if(clip.pattern==='full'&&step%8===4)for(let i=0;i<sr*.15&&start+i<len;i++){const t=i/sr;out[start+i]+=(noise()*.5+Math.sin(2*Math.PI*180*t)*.25)*Math.exp(-t*28);}
      if(step%2===0)for(let i=0;i<sr*.035&&start+i<len;i++)out[start+i]+=noise()*.12*Math.exp(-i/sr*100);
    }
  } else for(const n of clip.notes){
    if(!isNoteActive(n))continue;
    const start=Math.round(n.start*spb*sr),duration=n.duration*spb,freq=440*2**((n.pitch-69)/12);
    for(let i=0;i<(duration+.08)*sr&&start+i<len;i++){const t=i/sr,envelope=Math.min(1,t/.008)*Math.max(0,Math.min(1,(duration+.08-t)/.09));out[start+i]+=(Math.sin(2*Math.PI*freq*t)+Math.sin(2*Math.PI*freq*2*t)*.18)*envelope*n.velocity*.23;}
  }
  return buffer;
}
export class Engine {
  constructor(project,changed){this.project=project;this.project.transport??=defaultTransport();this.changed=changed;this.context=null;this.buffers=new Map();this.midiBuffers=new Map();this.voiceSchedulers=new WeakMap();this.bufferSchedulers=new WeakMap();this.sampleBuffers=new Map();this.active=new Map();this.pending=new Map();this.follows=new Map();this.activeScene=null;this.pendingScene=null;this.sceneFollow=null;this.gateHolds=new Map();this.overrides=new Set();this.automationOverrides=new Set();this.nodes=new Set();this.clickNodes=new Set();this.records=new Map();this.playing=false;this.recording=false;this.mode='session';this.nextBeat=0;this.position=0;this.insertMarker=0;this.playGeneration=0;this.masterVolume=project.master??.8;}
  async init(resume=true){
    if(this.context?.state==='closed'){
      this.mixGraph?.dispose();this.masterMeter?.dispose();this.context=null;this.master=null;this.compressor=null;this.masterMeter=null;delete this.mixGraph;this.mixers=new Map();this.returnMixers=new Map();this.voiceSchedulers=new WeakMap();this.bufferSchedulers=new WeakMap();
    }
    if(!this.context){
      const context=new AudioContext();this.context=context;context.addEventListener?.('statechange',()=>{if(this.context===context)this.onContextStateChange?.(context.state);});
      try{
        this.master=context.createGain();this.master.gain.value=this.masterVolume;this.compressor=context.createDynamicsCompressor();
        this.master.connect(this.compressor);this.compressor.connect(context.destination);this.masterMeter=createStereoMeter(context,this.compressor);this.mixers=new Map();this.resetMixers();
      }catch(error){
        try{this.mixGraph?.dispose();}catch{}try{this.masterMeter?.dispose();}catch{}
        for(const node of [this.master,this.compressor])try{node?.disconnect();}catch{}
        // Clear ownership before awaiting close so a retry cannot be erased by late cleanup.
        this.context=null;this.master=null;this.compressor=null;this.masterMeter=null;delete this.mixGraph;this.mixers=new Map();this.returnMixers=new Map();
        try{await context.close();}catch{}throw error;
      }
    }
    // A denied resume keeps the complete graph available for the next user gesture.
    if(resume){const context=this.context;await this.routeOutput?.(context);if(context!==this.context||context.state==='closed')throw Error('Audio Startup Was Cancelled.');await context.resume();}
  }
  channels(){return automationChannels(this.project);}
  mixer(id){return this.mixers?.get(id)||this.returnMixers?.get(id);}
  resetMixers(){
    const previous={mixGraph:this.mixGraph,mixers:this.mixers,returnMixers:this.returnMixers,automationOverrides:this.automationOverrides};
    const keys=new Set(this.channels().flatMap(t=>automationTargets(t,this.project.returns).map(a=>t.id+':'+a.key)));
    const next=createMixGraph(this.context,this.project,this.master);
    this.mixGraph=next;this.mixers=next.tracks;this.returnMixers=next.returns;this.automationOverrides=new Set([...previous.automationOverrides].filter(key=>keys.has(key)));
    let notifying=false;
    try{this.updateMix();notifying=true;this.onMixersChanged?.();}catch(error){Object.assign(this,previous);next.dispose();if(notifying)try{this.onMixersChanged?.();}catch{}throw error;}
    previous.mixGraph?.dispose();
  }
  targetActive(track,target){return this.mode==='arrangement'&&target?.enabled&&hasEnvelope(target.envelope)&&!this.automationOverrides.has(track.id+':'+target.key);}
  automationActive(track,key){return !!track&&this.targetActive(track,automationTargetFor(track,key,this.project.returns));}
  updateMix(){if(!this.context)return;this.mixGraph.update({automated:(t,k)=>this.playing&&this.automationActive(t,k)});const now=this.context.currentTime;for(const t of this.channels()){const m=this.mixer(t.id);if(!m)continue;for(const target of automationTargets(t,this.project.returns))if(!this.playing||!this.targetActive(t,target)){if(target.sendId)continue;else if(target.device)m.chain.update(target.device.id,target.paramKey,target.fallback);else{const param=target.key==='volume'?m.gain.gain:m.pan.pan;param.cancelScheduledValues(now);param.setTargetAtTime(target.fallback,now,.01);}}}this.master.gain.setTargetAtTime(this.masterVolume,now,.01);}
  overrideAutomation(trackId,key){if(this.automationTake){const t=this.channels().find(t=>t.id===trackId),a=t&&automationTargetFor(t,key,this.project.returns);try{if(a&&this.automationTake.write(trackId,key,a.fallback,this.rawBeat())){this.automationOverrides.add(trackId+':'+key);this.updateMix();return;}}catch(error){this.automationError='Automation recording stopped: '+error.message;this.finishAutomationRecording(false);throw error;}}const track=this.channels().find(t=>t.id===trackId),target=track&&automationTargetFor(track,key,this.project.returns);if(this.mode==='arrangement'&&hasEnvelope(target?.envelope))this.automationOverrides.add(trackId+':'+key);this.updateMix();}
  setTrackOutput(trackId,output){setTrackOutput(this.project,trackId,output);}
  setSendLevel(trackId,returnId,value){const t=this.project.tracks.find(t=>t.id===trackId);if(!t||!this.project.returns?.some(r=>r.id===returnId)||!Number.isFinite(value)||value<0||value>1)throw new Error('Invalid send.');t.sends??={};t.sends[returnId]??={amount:0,pre:false};t.sends[returnId].amount=value;this.overrideAutomation(trackId,sendKey(returnId));}
  setSendPre(trackId,returnId,pre){const t=this.project.tracks.find(t=>t.id===trackId);if(!t||!this.project.returns?.some(r=>r.id===returnId)||typeof pre!=='boolean')throw new Error('Invalid send.');t.sends??={};t.sends[returnId]??={amount:0,pre:false};t.sends[returnId].pre=pre;this.restoreAutomation(false);}
  setDeviceParameter(trackId,deviceId,key,value){const t=this.channels().find(t=>t.id===trackId),d=t?.devices.find(d=>d.id===deviceId);if(!d)return;
    if(DEVICE_TYPES[d.type]?.preparedParams?.includes(key)){
      validateDevices([{...d,params:{...d.params,[key]:value}}]);if(value===d.params[key])return;
      // Allocating parameters have no automation lane: install first, then commit.
      this.mixer(trackId)?.chain.update(deviceId,key,value);d.params[key]=value;return;
    }
    d.params[key]=value;this.overrideAutomation(trackId,deviceKey(deviceId,key));this.mixer(trackId)?.chain.update(deviceId,key,value);if(d.type==='autopan'&&['mode','division'].includes(key))this.restoreAutomation(false);}
  scheduleAutomation(track,start,length,time){const m=this.mixer(track.id);if(!m)return;m.chain.sync(start,length,time,60/this.project.bpm);for(const target of automationTargets(track,this.project.returns))if(this.targetActive(track,target))scheduleTarget(m,target,start,length,time,60/this.project.bpm,this.context.sampleRate);}
  restoreAutomation(clear=true){if(clear)this.automationOverrides.clear();if(this.playing){const raw=this.rawBeat(),spb=60/this.project.bpm,now=this.context.currentTime;for(const t of this.channels()){const m=this.mixer(t.id);m.gain.gain.cancelScheduledValues(now);m.pan.pan.cancelScheduledValues(now);m.chain.cancelAutomation(now);for(const send of m.sends?.values()||[])for(const name of ['pre','post'])send[name].gain.cancelScheduledValues(now);}let beat=raw;while(beat<this.nextBeat-1e-7){const step=Math.min(this.nextBeat-beat,quantumLength(beat,this.playbackTransport(),this.mode));for(const t of this.channels())this.scheduleAutomation(t,timelineBeat(beat,this.playbackTransport(),this.mode),step,Math.max(now,this.origin+raw*spb)+(beat-raw)*spb);beat+=step;}}this.updateMix();this.changed();}
  startAutomationRecording(mode='latch'){if(!this.playing||this.mode!=='arrangement'||this.recording)throw new Error('Play Arrangement before recording automation.');if(this.automationTake)return;this.changed();this.automationError='';this.automationTake=new AutomationTake(this.project,this.rawBeat(),mode);this.changed();}
  releaseAutomationControl(trackId,key){if(!this.automationTake)return;try{if(this.automationTake.release(trackId,key,this.rawBeat())){this.automationOverrides.delete(trackId+':'+key);this.restoreAutomation(false);}}catch(error){this.automationError='Automation recording stopped: '+error.message;this.finishAutomationRecording(false);}}
  advanceAutomationRecording(){if(!this.automationTake)return;try{this.automationTake.advance(this.rawBeat());if(this.rawBeat()>=16384)this.finishAutomationRecording();}catch(error){this.automationError='Automation recording stopped: '+error.message;this.finishAutomationRecording(false);}}
  finishAutomationRecording(advance=true){const take=this.automationTake;if(!take)return;if(advance)try{take.advance(this.rawBeat());}catch(error){this.automationError='Automation recording stopped: '+error.message;}this.automationTake=null;for(const key of take.writing.keys())this.automationOverrides.delete(key);this.restoreAutomation(false);}
  sampleKey(trackId,pitch){return sampleKey(trackId,pitch);}
  sampleBuffer(trackId,pitch){return this.sampleBuffers.get(this.sampleKey(trackId,pitch))?.buffer;}
  async prepareInstrument(trackId,instrument){if(instrumentSamples(instrument).some(([,s])=>s?.data))await this.init(false);return prepareInstrumentSamples(this.context,trackId,instrument,this.sampleBuffers);}
  installInstrumentSamples(trackId,prepared){this.sampleBuffers=installInstrumentSamples(this.sampleBuffers,trackId,prepared);}
  async prepareSamples({resume=true}={}){
    await this.init(resume);const binding=samplePreparationBinding(this.project),prepared=new Map();
    for(const {track,instrument}of binding.tracks)for(const [id,sample]of await prepareInstrumentSamples(this.context,track.id,instrument,this.sampleBuffers))prepared.set(id,sample);
    if(!samplesStillCurrent(binding,this.project))throw new Error('Sample Sources Changed During Preparation. Try Again.');
    this.sampleBuffers=prepared;
  }
  checkWarpBudget(id,bytes,reused){const counted=new Set(reused?[reused]:[]);for(const [key,b]of this.buffers)if(key!==id&&b.warped&&!counted.has(b.warped)){counted.add(b.warped);bytes+=b.warped.length*b.warped.numberOfChannels*4;}if(bytes>128*1024*1024)throw new Error('Prepared Stretch audio exceeds 128 MB. Use fewer or shorter stretched clips.');}
  audioKey(clip){return JSON.stringify([audioEditKey(clip),clip.sourceBpm,this.project.bpm,clip.warp]);}
  cacheAudio(clip,raw){const buffer=editedAudioBuffer(this.context,raw,clip);this.buffers.set(clip.id,{key:clip.warp?.mode==='stretch'?null:this.audioKey(clip),data:clip.data,raw,buffer});return buffer;}
  async prepareAudioClip(clip){
    await this.init(false);const key=this.audioKey(clip),old=this.buffers.get(clip.id),data=clip.data;if(old?.data===data&&old.key===key)return old.buffer;
    let raw=old?.data===data?old.raw:null;
    if(!raw){this.audioDecodes??=new Map();let entry=this.audioDecodes.get(clip.id);if(entry?.data!==data){entry={data,promise:this.context.decodeAudioData(Uint8Array.from(atob(data),c=>c.charCodeAt(0)).buffer)};this.audioDecodes.set(clip.id,entry);}try{raw=await entry.promise;}finally{if(this.audioDecodes.get(clip.id)===entry)this.audioDecodes.delete(clip.id);}}
    if(clip.data!==data||this.audioKey(clip)!==key)return this.prepareAudioClip(clip);
    const warpKey=JSON.stringify([this.project.bpm,clip.sourceBpm,clip.warp]);let warped;
    if(clip.warp?.mode==='stretch'){
      this.checkWarpBudget(clip.id,stretchPlan(raw,this.project.bpm/clip.sourceBpm).frames*raw.numberOfChannels*4,old?.data===data&&old.warpKey===warpKey?old.warped:undefined);
      if(old?.data===data&&old.warpKey===warpKey&&old.warped)warped=old.warped;
      else{this.audioWarps??=new Map();let entry=this.audioWarps.get(clip.id);if(entry?.data!==data||entry?.key!==warpKey){entry={data,key:warpKey,promise:stretchAudio(raw,this.project.bpm/clip.sourceBpm,clip.warp.semitones,clip.warp)};this.audioWarps.set(clip.id,entry);}try{warped=await entry.promise;}finally{if(this.audioWarps.get(clip.id)===entry)this.audioWarps.delete(clip.id);}}
    }
    if(clip.data!==data||this.audioKey(clip)!==key)return this.prepareAudioClip(clip);
    if(warped)this.checkWarpBudget(clip.id,warped.length*warped.numberOfChannels*4,warped);const buffer=editedAudioBuffer(this.context,warped??raw,clip);this.buffers.set(clip.id,{key,data,raw,warped,warpKey,buffer});return buffer;
  }
  async prepareClip(clip){if(clip.kind==='audio')return this.prepareAudioClip(clip);const key=`${clip.id}:${this.project.bpm}:${JSON.stringify(clip.notes||clip.pattern)}`,old=this.buffers.get(clip.id);if(old?.key===key)return old.buffer;const buffer=synthesize(this.context,clip,this.project.bpm);this.buffers.set(clip.id,{key,buffer});return buffer;}
  async prepare({resume=true}={}){await this.prepareSamples({resume});this.instrumentTail=voiceTail(this.project,(id,pitch)=>this.sampleBuffer(id,pitch));const legacyMidi=new Set(this.project.tracks.filter(t=>!t.instrument).flatMap(t=>[...t.slots,...this.project.arrangement.filter(r=>r.trackId===t.id).map(r=>r.clipId)]));for(const clip of Object.values(this.project.clips)){if(clip.kind==='midi'&&!legacyMidi.has(clip.id)){this.buffers.delete(clip.id);continue;}await this.prepareClip(clip);}const used=new Set();for(const t of this.project.tracks){if(!t.midiEffects?.length)continue;const ids=new Set([...t.slots,...this.project.arrangement.filter(r=>r.trackId===t.id).map(r=>r.clipId)]);for(const id of ids){const clip=this.project.clips[id];if(clip?.kind!=='midi')continue;const effective=processMidiClip(clip,t.midiEffects,this.project.bpm);if(t.instrument)continue;const key=JSON.stringify([t.id,id]),version=JSON.stringify([this.project.bpm,effective]);used.add(key);if(this.midiBuffers.get(key)?.version!==version)this.midiBuffers.set(key,{version,buffer:synthesize(this.context,effective,this.project.bpm)});}}for(const key of this.midiBuffers.keys())if(!used.has(key))this.midiBuffers.delete(key);}
  rawBeat(){if(!this.playing)return this.position;const raw=Math.max(this.clockStart,(this.context.currentTime-this.origin)/(60/this.project.bpm));return this.inputArrangement?Math.min(raw,this.inputArrangement.start+this.inputArrangement.maxBeats):raw;}
  playbackTransport(){return this.inputArrangement?{...this.project.transport,loopEnabled:false}:this.project.transport;}
  beat(){return this.playing?timelineBeat(this.rawBeat(),this.playbackTransport(),this.mode):this.position;}
  async play(mode=this.mode,{onReady,delayBeats=0}={}){
    if(!Number.isFinite(delayBeats)||delayBeats<0||delayBeats>16)throw Error('Invalid Playback Count-In.');
    if(this.playing)return;
    const generation=this.playGeneration;this.playRequestGeneration=generation;
    // A cancelled preparation still owns its audio resources until it settles.
    // Queue a fresh request behind it, but never let a later Stop revive playback.
    while(this.startPromise){
      if(this.startGeneration===generation)return this.startPromise;
      try{await this.startPromise;}catch{}
      if(generation!==this.playGeneration)return;
    }
    this.startGeneration=generation;
    const pending=(async()=>{await this.prepare();if(generation!==this.playGeneration)return;onReady?.();if(generation!==this.playGeneration)return;
      this.mode=mode;if(mode==='arrangement'&&!this.overrides.size)this.cancelSceneFollow();this.clockStart=this.position;this.nextBeat=this.position;
      for(const [id,a] of this.active){a.activationBeat=this.position;const track=this.project.tracks.find(t=>t.id===id);if(track?.slots[a.slot]!==a.clipId)a.slot=track?.slots.indexOf(a.clipId);if(this.position===0){a.start=0;this.armFollow(id,a,0,0);}else if(a.followSignature!==this.followSignature(a))this.armFollow(id,a,this.position);}
      if(this.activeScene!==null)this.sceneActivationBeat=this.position;
      if(this.activeScene!==null&&(this.position===0||this.sceneFollowSignature!==JSON.stringify(this.project.sceneFollows?.[this.activeScene])))this.armSceneFollow(this.activeScene,this.position);
      this.origin=this.context.currentTime+(this.inputArrangement?.15:.08)+(delayBeats-this.position)*60/this.project.bpm;
      this.playing=true;this.updateMix();this.timer=setInterval(()=>this.tick(),25);this.tick();this.changed();
    })();this.startPromise=pending;
    try{await pending;}catch(error){
      if(generation===this.playGeneration&&this.playing){
        clearInterval(this.timer);for(const node of this.nodes){try{node.stop();}catch{}}this.nodes.clear();
        this.playing=false;this.position=this.clockStart;this.voiceSchedulers=new WeakMap();this.bufferSchedulers=new WeakMap();
        // Recording startup owns its rollback and history; do not finalize a take here.
        try{if(this.context)this.resetMixers();}catch{}
      }
      throw error;
    }finally{if(this.startPromise===pending)this.startPromise=null;if(this.playRequestGeneration===generation)this.playRequestGeneration=null;}
  }
  halt(reset){
    for(const h of this.gateHolds.values())if(!h.repeat&&this.active.get(h.trackId)?.clipId===h.clipId)this.active.set(h.trackId,{clipId:null,start:this.position});this.gateHolds.clear();this.playGeneration++;const raw=this.rawBeat(),position=this.beat();
    this.finishAutomationRecording();this.finishRecords(raw);
    if(this.recording){for(const s of this.project.arrangement)s.length=Math.min(s.length,Math.max(0,raw-s.start));this.project.arrangement=this.project.arrangement.filter(s=>s.length>=.0625);}
    this.recording=false;this.recordingTake=null;this.playing=false;this.position=reset?0:position;
    // Preserve clip phase when the displayed timeline wrapped before pausing.
    if(!reset){for(const a of this.active.values())a.start-=raw-position;for(const f of this.follows.values())f.beat-=raw-position;if(this.sceneFollow)this.sceneFollow.beat-=raw-position;}else{this.follows.clear();this.sceneFollow=null;}this.pendingScene=null;
    clearInterval(this.timer);for(const n of this.nodes){try{n.stop();}catch{}}this.nodes.clear();this.pending.clear();this.voiceSchedulers=new WeakMap();this.bufferSchedulers=new WeakMap();
    if(this.context&&this.context.state!=='closed')this.resetMixers();this.changed();
  }
  stop(){this.halt(true);}
  pause(){this.halt(false);}
  async seek(position,{moveMarker=true,snap=true}={}){
    if(this.recording||this.inputArrangement)throw new Error('Finish recording before seeking.');
    if(!Number.isFinite(position)||position<0||position>16384)throw new Error('Choose a position within the timeline.');
    const resume=this.playing||!!this.startPromise&&this.playRequestGeneration===this.playGeneration;this.pause();
    const next=snap?Math.round(position*4)/4:position;if(moveMarker)this.insertMarker=next;
    for(const a of this.active.values())a.start+=next-this.position;
    for(const f of this.follows.values())f.beat+=next-this.position;if(this.sceneFollow)this.sceneFollow.beat+=next-this.position;this.position=next;this.changed();if(resume)await this.play(this.mode);
  }
  click(time,accent=false){
    const osc=this.context.createOscillator(),gain=this.context.createGain();osc.frequency.value=accent?1500:1000;
    gain.gain.setValueAtTime(Math.max(.0001,.128*metronomeLevel(this.project.transport)),time);gain.gain.exponentialRampToValueAtTime(.0001,time+.035);
    osc.connect(gain);gain.connect(this.context.destination);osc.start(time);osc.stop(time+.04);
    this.nodes.add(osc);this.clickNodes.add(osc);osc.onended=()=>{this.nodes.delete(osc);this.clickNodes.delete(osc);osc.disconnect();gain.disconnect();};return osc;
  }
  clearMetronomeClicks(preserveCountIn=false){for(const node of this.clickNodes){if(preserveCountIn&&this.inputCountInNodes?.has(node))continue;try{node.stop();}catch{}this.clickNodes.delete(node);}}
  startInputMetronome(plan){
    this.stopInputMetronome();this.inputClickClock=new InputClickClock({...plan,bpm:this.project.bpm});this.inputClickNodes=new Set();this.inputCountInNodes=new Set();
    const tick=()=>{const clock=this.inputClickClock;if(!clock)return;const now=this.context.currentTime;for(const event of clock.events(now,{playing:this.playing,enabled:metronomeAudible(this.project.transport,{recording:true})})){if(metronomeLevel(this.project.transport)===0)continue;const node=this.click(event.time,event.accent);this.inputClickNodes.add(node);if(event.time<clock.start)this.inputCountInNodes.add(node);const end=node.onended;node.onended=()=>{this.inputClickNodes?.delete(node);this.inputCountInNodes?.delete(node);end?.();};}};
    tick();this.inputClickTimer=setInterval(tick,25);
  }
  stopInputMetronome(){
    const hadClock=!!this.inputClickClock;this.inputClickClock?.stop();this.inputClickClock=null;clearInterval(this.inputClickTimer);
    for(const node of this.inputClickNodes||[]){try{node.stop();}catch{}}this.inputClickNodes?.clear();this.inputCountInNodes?.clear();
    if(hadClock&&this.project.transport.metronomeRecordOnly&&!this.recording&&!this.automationTake)this.clearMetronomeClicks();
  }
  launchBoundary(clipId,earliest=Math.max(this.rawBeat()+.02,this.nextBeat)){return nextLaunchBeat(earliest,this.project.transport.launchQuantization??4,this.project.clips[clipId]?.launch?.quantization??'global');}
  sourcePhase(trackId,beat){
    if(this.mode==='session'||this.overrides.has(trackId)){const old=this.active.get(trackId),clip=this.project.clips[old?.clipId];return clip?mod(beat-old.start,clip.beats):0;}
    const pos=timelineBeat(beat,this.playbackTransport(),this.mode),region=segmentAt(this.project,trackId,pos),clip=this.project.clips[region?.clipId];return clip?mod(region.offset+pos-region.start,clip.beats):0;
  }
  activateClip(trackId,clipId,beat,legato=false,slot){const clip=this.project.clips[clipId],offset=clip&&legato?mod(this.sourcePhase(trackId,beat),clip.beats):0;const a={clipId,start:beat-offset,activationBeat:beat,slot:slot??this.project.tracks.find(t=>t.id===trackId)?.slots.indexOf(clipId)};this.active.set(trackId,a);this.armFollow(trackId,a,beat,offset);this.overrides.add(trackId);if(this.recording&&clipId)this.openRecord(trackId,clipId,beat,offset);}
  // Every new Session intent owns its affected tracks before audio preparation.
  // Other tracks and already scheduled audio keep their current performance.
  cancelLaunchPreparation(ids){this.launchEpochs??=new Map();for(const id of ids)this.launchEpochs.set(id,(this.launchEpochs.get(id)??0)+1);}
  replaceLaunchPreparation(ids){this.cancelLaunchPreparation(ids);for(const id of ids){this.pending.delete(id);this.gateHolds.delete(id);}}
  launchBinding(ids){return {project:this.project,generation:this.playGeneration,epochs:new Map(ids.map(id=>[id,this.launchEpochs?.get(id)??0]))};}
  launchCurrent(binding,id){return binding.project===this.project&&binding.generation===this.playGeneration&&binding.epochs.get(id)===(this.launchEpochs?.get(id)??0);}
  async launch(trackId,clipId,slot,{signal}={}){
    signal?.throwIfAborted();if(isGroup(this.project.tracks.find(t=>t.id===trackId))){if(!clipId)return this.stopGroup(trackId);throw new Error('Group tracks launch their contained clips with a group scene, not an owned clip.');}
    const clip=this.project.clips[clipId],toggle=clip?.launch?.mode==='toggle',loading=this.launchLoads?.get(trackId);
    const pending=loading&&!loading.signal?.aborted&&this.launchCurrent(loading.binding,trackId)?{clipId:loading.clipId}:this.pending.get(trackId);
    const active=(this.playing||this.startPromise)&&(this.mode==='session'||this.overrides.has(trackId))?this.active.get(trackId):null;
    const action=toggle?toggleLaunchAction(clipId,active,pending):'start';
    this.replaceLaunchPreparation([trackId]);
    if(action==='cancel'){this.changed();return {events:[],cancelled:true};}
    if(!clipId||action==='stop')return this.launchPrepared(trackId,clipId,slot,{action});
    const binding=this.launchBinding([trackId]),loadingRequest={binding,clipId,signal};this.launchLoads??=new Map();this.launchLoads.set(trackId,loadingRequest);
    try{
      await this.prepare();signal?.throwIfAborted();if(!this.launchCurrent(binding,trackId))return {events:[],interrupted:true};
      if(this.launchLoads.get(trackId)===loadingRequest)this.launchLoads.delete(trackId);
      const receipt=await this.launchPrepared(trackId,clipId,slot,{action});if(!this.launchCurrent(binding,trackId))receipt.interrupted=true;return receipt;
    }finally{if(this.launchLoads.get(trackId)===loadingRequest)this.launchLoads.delete(trackId);}
  }
  async launchPrepared(trackId,clipId,slot,{action:requestedAction}={}){
    const clip=this.project.clips[clipId],toggle=clip?.launch?.mode==='toggle',action=requestedAction??(this.playing&&toggle?toggleLaunchAction(clipId,this.mode==='session'||this.overrides.has(trackId)?this.active.get(trackId):null,this.pending.get(trackId)):'start');
    if(action==='cancel'){this.pending.delete(trackId);this.changed();return {events:[],cancelled:true};}
    const selected=action==='stop'?null:clipId;
    if(!this.playing){const beat=this.position;this.activateClip(trackId,selected,beat,clip?.launch?.legato,slot);if(selected)await this.play(this.mode);else this.changed();return {events:[{trackId,event:{clipId:selected,beat,appliedBeat:beat}}]};}
    const event={clipId:selected,beat:this.launchBoundary(clipId),legato:clip?.launch?.legato??false,...(toggle?{toggleSource:clipId}:{}),...(slot===undefined?{}:{slot})};
    this.pending.set(trackId,event);this.changed();return {events:[{trackId,event}]};
  }

  pressGate(trackId,clipId,slot){
    this.replaceLaunchPreparation([trackId]);const binding=this.launchBinding([trackId]);
    const h={trackId,clipId,started:false,repeat:this.project.clips[clipId]?.launch?.mode==='repeat',interval:repeatGrid(this.project.clips[clipId],this.project.transport)};this.gateHolds.set(trackId,h);
    h.ready=(async()=>{await this.prepare();if(this.gateHolds.get(trackId)!==h||!this.launchCurrent(binding,trackId))return;h.started=true;const clip=this.project.clips[clipId];if(!this.playing){this.activateClip(trackId,clipId,this.position,clip?.launch?.legato,slot);if(h.repeat&&h.interval>0)this.pending.set(trackId,{clipId,beat:nextLaunchBeat(this.position+1e-6,h.interval),legato:clip?.launch?.legato??false,...(slot===undefined?{}:{slot}),gate:h,gateSource:clipId});await this.play(this.mode);}else{this.pending.set(trackId,{clipId,beat:this.launchBoundary(clipId),legato:clip?.launch?.legato??false,...(slot===undefined?{}:{slot}),gate:h,gateSource:clipId});this.changed();}})().catch(error=>{if(this.gateHolds.get(trackId)!==h)return;this.gateHolds.delete(trackId);throw error;});return h;
  }
  releaseGate(h){if(this.gateHolds.get(h.trackId)!==h)return;this.gateHolds.delete(h.trackId);if(this.pending.get(h.trackId)?.gate===h)this.pending.delete(h.trackId);const active=(this.mode==='session'||this.overrides.has(h.trackId))&&this.active.get(h.trackId)?.clipId===h.clipId;if(h.started&&active&&!h.repeat){if(this.playing)this.pending.set(h.trackId,{clipId:null,beat:this.launchBoundary(h.clipId),gateSource:h.clipId});else this.active.set(h.trackId,{clipId:null,start:this.position});}this.changed();}
  async scene(index,{signal,groupId}={}){
    signal?.throwIfAborted();
    if(!Number.isInteger(index)||index<0||index>=this.project.scenes)throw new Error('Choose a scene.');
    const members=groupId?groupLeaves(this.project,groupId):this.project.tracks.filter(t=>!isGroup(t));if(groupId&&!members.some(t=>t.slots[index]))throw new Error('This group has no clips in the requested scene.');const requested=members.filter(t=>t.slots[index]||slotStops(t,index));this.replaceLaunchPreparation(requested.map(t=>t.id));const binding=this.launchBinding(members.map(t=>t.id)),sceneRequest=Symbol('scene');if(groupId)this.cancelSceneFollow();else{this.pendingScene=null;this.sceneLaunchRequest=sceneRequest;}await this.prepare();signal?.throwIfAborted();
    const targets=requested.filter(t=>this.launchCurrent(binding,t.id)),interrupted=targets.length!==requested.length;
    if(!members.some(t=>this.launchCurrent(binding,t.id))||requested.length&&!targets.length)return {events:[],interrupted:true};
    const ownsScene=!groupId&&this.sceneLaunchRequest===sceneRequest;const receipt={events:[],...(interrupted||!groupId&&!ownsScene?{interrupted:true}:{})};
    if(!this.playing){
      const beat=this.position;if(ownsScene){this.activeScene=index;this.sceneActivationBeat=beat;this.armSceneFollow(index,beat);receipt.scene={index,beat,appliedBeat:beat};}
      for(const t of targets){const clipId=t.slots[index];this.activateClip(t.id,clipId,beat,this.project.clips[clipId]?.launch?.legato,index);receipt.events.push({trackId:t.id,event:{clipId,beat,appliedBeat:beat}});}
      await this.play(this.mode);
    }else{
      const earliest=Math.max(this.rawBeat()+.02,this.nextBeat);if(ownsScene)receipt.scene=this.pendingScene={index,beat:this.launchBoundary(null,earliest)};
      for(const t of targets){const clipId=t.slots[index],event={clipId,beat:this.launchBoundary(clipId,earliest),legato:this.project.clips[clipId]?.launch?.legato??false,slot:index};this.pending.set(t.id,event);receipt.events.push({trackId:t.id,event});}
    }if(requested.some(t=>!this.launchCurrent(binding,t.id))||!groupId&&this.sceneLaunchRequest!==sceneRequest)receipt.interrupted=true;this.changed();return receipt;
  }
  captureScene(after){
    if(!this.playing||this.mode!=='session'||this.automationTake)throw new Error('Capture a scene during Session playback, outside an automation take.');
    // Open recording regions are intentionally incomplete (often zero length).
    // Validate the closed Arrangement without changing live region objects. Capture
    // does not change their sound, so retain those regions and their original clips.
    const open=new Set(this.recording?this.records.values():[]);
    const source=open.size?{...this.project,arrangement:this.project.arrangement.filter(region=>!open.has(region))}:this.project;
    const result=captureScene(source,this.active,after),{index,copies}=result,next=result.project;
    // Preserve the project, mixer and track identities; no audio graph or clock is restarted.
    this.project.scenes=next.scenes;this.project.sceneNames=next.sceneNames;if(next.sceneFollows)this.project.sceneFollows=next.sceneFollows;
    for(let i=0;i<this.project.tracks.length;i++){const t=this.project.tracks[i];t.slots=next.tracks[i].slots;for(const key of ['noStopSlots','inactiveSlots']){if(next.tracks[i][key])t[key]=next.tracks[i][key];else delete t[key];}}
    for(const copy of copies)this.project.clips[copy.id]=next.clips[copy.id];
    const shifted=slot=>Number.isInteger(slot)&&slot>=index?slot+1:slot;
    for(const active of this.active.values())active.slot=shifted(active.slot);
    for(const pending of this.pending.values())pending.slot=shifted(pending.slot);
    for(const follow of this.follows.values())if(follow.event)follow.event.slot=shifted(follow.event.slot);
    if(this.pendingScene)this.pendingScene.index=shifted(this.pendingScene.index);
    for(const {trackId,source,id} of copies){const a=this.active.get(trackId);a.bufferIdentity??=source;a.clipId=id;a.slot=index;a.followSignature=this.followSignature(a);
      const buffer=this.buffers.get(source);if(buffer)this.buffers.set(id,buffer);
      const midi=this.midiBuffers.get(JSON.stringify([trackId,source]));if(midi)this.midiBuffers.set(JSON.stringify([trackId,id]),midi);
      const hold=this.gateHolds.get(trackId);if(hold?.clipId===source){hold.clipId=id;const pending=this.pending.get(trackId);if(pending?.gate===hold){pending.clipId=id;pending.slot=index;}if(pending?.gateSource===source)pending.gateSource=id;}
    }
    this.activeScene=index;this.sceneFollow=null;this.sceneFollowSignature=JSON.stringify(this.project.sceneFollows?.[index]);
    return {...result,project:this.project};
  }
  async stopGroup(id){
    const targets=groupLeaves(this.project,id),receipt={events:[]};this.cancelLaunchPreparation(targets.map(t=>t.id));for(const t of targets)this.gateHolds.delete(t.id);if(!this.playing){for(const t of targets){this.active.delete(t.id);this.pending.delete(t.id);this.follows.delete(t.id);}this.changed();return receipt;}
    const beat=this.launchBoundary(null);for(const t of targets){const event={clipId:null,beat};this.pending.set(t.id,event);receipt.events.push({trackId:t.id,event});}this.changed();return receipt;
  }
  async stopAll(){
    this.cancelLaunchPreparation(this.project.tracks.map(t=>t.id));this.cancelSceneFollow();this.gateHolds.clear();const receipt={events:[]};
    if(!this.playing){this.active.clear();this.pending.clear();this.follows.clear();this.changed();return receipt;}
    const beat=this.launchBoundary(null);for(const t of this.project.tracks){const event={clipId:null,beat};this.pending.set(t.id,event);receipt.events.push({trackId:t.id,event});}this.changed();return receipt;
  }
  async startRecording({signal}={}){
    signal?.throwIfAborted();
    if(this.recordingStartPromise)return this.recordingStartPromise;
    this.recordingError=null;
    if(this.recording){this.finishRecords(this.rawBeat());this.recording=false;this.recordingTake=null;this.changed();return;}
    if(this.startPromise)throw new Error('Wait for playback preparation to finish before recording.');
    this.stop();
    const project=this.project,previous=project.arrangement,signature=JSON.stringify(project);let installed=false;
    // Do not replace the Arrangement until decoding/resume succeeds and the
    // playback generation is still current. Stop during preparation cancels it.
    const pending=this.play('session',{onReady:()=>{
      if(this.project!==project||JSON.stringify(project)!==signature)throw new Error('The project changed while preparing recording. Start again with the current set.');
      installed=true;this.recordingTake={id:uid(),previous:structuredClone(previous)};project.arrangement=[];this.recording=true;
      for(const [id,a]of this.active)if(a.clipId){a.start=0;this.openRecord(id,a.clipId,0);}
    }});
    this.recordingStartPromise=pending;
    const abort=()=>{if(this.recording)this.finishSessionRecording({cancel:true});else this.stop();};signal?.addEventListener('abort',abort,{once:true});
    try{await pending;signal?.throwIfAborted();this.changed();}
    catch(error){
      // A graph/scheduler error after preparation must not leave a partial take
      // or add an empty replacement to Undo/autosave history.
      if(installed&&this.project===project){this.recording=false;this.recordingTake=null;this.records.clear();project.arrangement=previous;this.stop();}
      this.recordingError=error.message;throw error;
    }finally{signal?.removeEventListener('abort',abort);this.recordingStartPromise=null;}
  }
  finishSessionRecording({cancel=false}={}){
    const take=this.recordingTake;if(!this.recording||!take)throw new Error('No active Session recording.');
    if(cancel){this.records.clear();this.project.arrangement=take.previous;this.recording=false;this.recordingTake=null;}
    this.stop();return {sessionRecording:true,action:cancel?'cancel':'finish',captureId:take.id,status:cancel?'cancelled':this.project.arrangement.length?'saved':'empty',regionCount:this.project.arrangement.length};
  }
  openRecord(trackId,clipId,beat,offset=0){if(this.project.arrangement.length>=10000){this.finishRecords(beat);this.recording=false;this.recordingTake=null;this.recordingError='Session recording stopped at the 10,000-region limit. Save or edit this take before recording again.';return;}const track=this.project.tracks.find(t=>t.id===trackId),slot=this.active.get(trackId)?.slot??track.slots.indexOf(clipId),s={id:uid(),trackId,clipId,start:beat,length:0,offset,...(!slotActive(track,slot)?{active:false}:{})};this.records.set(trackId,s);this.project.arrangement.push(s);}
  closeRecord(trackId,beat){const s=this.records.get(trackId);if(s){s.length=Math.max(0,beat-s.start);if(s.length<.0625)this.project.arrangement=this.project.arrangement.filter(x=>x!==s);this.records.delete(trackId);}}
  finishRecords(beat){for(const id of [...this.records.keys()])this.closeRecord(id,beat);}
  back(){this.cancelLaunchPreparation(this.project.tracks.map(t=>t.id));this.cancelSceneFollow();this.gateHolds.clear();if(!this.playing){this.overrides.clear();this.active.clear();this.follows.clear();this.changed();return;}const beat=this.launchBoundary(null);for(const t of this.project.tracks)this.pending.set(t.id,{back:true,beat});this.changed();}
  cancelSceneFollow(){this.sceneLaunchRequest=null;this.activeScene=null;this.sceneActivationBeat=null;this.pendingScene=null;this.sceneFollow=null;this.sceneFollowSignature=undefined;}
  armSceneFollow(index,beat){
    const f=this.project.sceneFollows?.[index];this.sceneFollowSignature=JSON.stringify(f);this.sceneFollow=null;
    if(this.project.transport.followActionsEnabled!==false&&f?.enabled)this.sceneFollow={index,beat:beat+f.beats};
  }
  processSceneFollow(beat){
    if(this.inputOverdub)return false;
    if(this.pendingScene){if(this.pendingScene.beat>beat+1e-7)return false;this.pendingScene.appliedBeat=beat;this.activeScene=this.pendingScene.index;this.sceneActivationBeat=beat;this.pendingScene=null;this.armSceneFollow(this.activeScene,beat);return true;}
    const event=this.sceneFollow;if(!event||event.beat>beat+1e-7||this.project.transport.followActionsEnabled===false)return false;
    this.sceneFollow=null;const f=this.project.sceneFollows?.[event.index];if(!f?.enabled)return false;
    const target=followTarget(Array(this.project.scenes).fill(true),event.index,f);
    if(target===undefined)return false;
    if(target===null){this.cancelSceneFollow();for(const t of this.project.tracks){this.gateHolds.delete(t.id);this.pending.set(t.id,{clipId:null,beat});}return true;}
    this.activeScene=target;this.sceneActivationBeat=beat;this.armSceneFollow(target,beat);
    for(const t of this.project.tracks){const clipId=t.slots[target];if(!clipId&&!slotStops(t,target))continue;
      this.gateHolds.delete(t.id);this.follows.delete(t.id);const clip=this.project.clips[clipId],grid=clip?.launch?.quantization??'global';
      this.pending.set(t.id,{clipId,slot:target,beat:nextLaunchBeat(beat,0,grid==='global'?0:grid),legato:clip?.launch?.legato??false});
    }return true;
  }
  followSignature(a){const c=this.project.clips[a.clipId];return JSON.stringify([a.slot,c?.beats,c?.follow]);}
  armFollow(id,a,beat,offset=0){
    a.followSignature=this.followSignature(a);
    this.follows.delete(id);const clip=this.project.clips[a.clipId],delay=clip&&followDelay(clip,offset);
    if(this.project.transport.followActionsEnabled!==false&&delay!==null&&delay!==undefined&&a.slot>=0)this.follows.set(id,{beat:beat+delay,owner:a});
  }
  setFollowEnabled(enabled){
    this.project.transport.followActionsEnabled=enabled;this.follows.clear();this.sceneFollow=null;
    if(enabled){for(const [id,a]of this.active)this.armFollow(id,a,this.playing?this.nextBeat:this.position);if(this.activeScene!==null)this.armSceneFollow(this.activeScene,this.playing?this.nextBeat:this.position);}
    this.changed();
  }
  processFollows(beat){
    if(this.project.transport.followActionsEnabled===false)return;
    for(const [id,f]of this.follows){
      if(this.inputOverdub?.trackId===id||this.pending.has(id)||f.beat>beat+1e-7)continue;
      const a=this.active.get(id),track=this.project.tracks.find(t=>t.id===id);
      if(a!==f.owner||!track||(this.mode!=='session'&&!this.overrides.has(id))){this.follows.delete(id);continue;}
      if(!f.event){
        const clip=this.project.clips[a.clipId];if(!clip?.follow?.enabled){this.follows.delete(id);continue;}const slot=followTarget(track.slots,a.slot,clip.follow);
        if(slot===undefined){this.follows.delete(id);continue;}
        const clipId=slot===null?null:track.slots[slot],target=this.project.clips[clipId],grid=target?.launch?.quantization??'global';
        f.beat=nextLaunchBeat(Math.max(beat,f.beat),0,grid==='global'?0:grid);f.event={clipId,slot,legato:target?.launch?.legato??false};
      }
      if(f.beat<=beat+1e-7){this.gateHolds.delete(id);this.pending.set(id,{...f.event,beat});this.follows.delete(id);}
    }
  }
  tick(){this.advanceAutomationRecording();let launchChanged=false;const spb=60/this.project.bpm,horizon=this.context.currentTime+.12,captureEnd=this.inputArrangement?this.inputArrangement.start+this.inputArrangement.maxBeats:Infinity;
    // Audio-clock scheduling; UI animation never determines playback time.
    while(this.origin+this.nextBeat*spb<horizon&&this.nextBeat<captureEnd-1e-9){const beat=this.nextBeat,time=this.origin+beat*spb,pos=timelineBeat(beat,this.playbackTransport(),this.mode);let step=Math.min(captureEnd-beat,pendingQuantum(beat,quantumLength(beat,this.playbackTransport(),this.mode),this.pending));
      if(metronomeAudible(this.project.transport,{recording:!!(this.recording||this.automationTake||this.inputOverdub&&beat>=(this.inputOverdub.countInEndBeat??-Infinity)||this.inputClickClock&&time>=this.inputClickClock.start),countingIn:!!(this.inputClickClock&&time<this.inputClickClock.start||this.inputOverdub?.countInEndBeat!==undefined&&beat<this.inputOverdub.countInEndBeat)})&&Math.abs(pos-Math.round(pos))<1e-6&&time>=this.context.currentTime)this.click(time,Math.round(pos)%4===0);
      if(this.processSceneFollow(beat))launchChanged=true;
      this.processFollows(beat);
      for(const [id,p]of this.pending)if(p.beat<=beat+1e-7){p.appliedBeat=beat;this.voiceSchedulers.get(this.context)?.release(id,time);this.closeRecord(id,beat);if(p.back){this.overrides.delete(id);this.active.delete(id);this.follows.delete(id);}else this.activateClip(id,p.clipId,beat,p.legato,p.slot);if(p.gate?.repeat&&p.gate.interval>0&&this.gateHolds.get(id)===p.gate)this.pending.set(id,{...p,appliedBeat:undefined,beat:beat+p.gate.interval});else this.pending.delete(id);launchChanged=true;}
      step=pendingQuantum(beat,step,this.pending);const sceneEvent=this.pendingScene??this.sceneFollow;if(sceneEvent?.beat>beat+1e-7)step=Math.min(step,sceneEvent.beat-beat);for(const [id,f]of this.follows)if(!this.pending.has(id)&&f.beat>beat+1e-7)step=Math.min(step,f.beat-beat);
      const automationTime=Math.max(time,this.context.currentTime),skipped=(automationTime-time)/spb;if(skipped<step)for(const track of this.channels())this.scheduleAutomation(track,pos+skipped,step-skipped,automationTime);
      for(const track of this.project.tracks){
        const mixer=this.mixers.get(track.id),target=mixer.input||mixer.chain.input;
        if(time<this.context.currentTime-.02)continue;
        if(this.mode==='session'||this.overrides.has(track.id)){
          const a=this.active.get(track.id);if(a?.clipId&&slotActive(track,a.slot??track.slots.indexOf(a.clipId)))this.schedule(this.context,target,this.inputOverdub?.trackId===track.id&&this.inputOverdub.clipId===a.clipId?this.inputOverdub.clip:this.project.clips[a.clipId],time,beat-a.start,step,track.id,`session:${a.start}`,Infinity,a.bufferIdentity);
        }else for(const slice of arrangementSlices(this.project,track.id,pos,step)){
          const region=this.project.arrangement.find(r=>r.id===slice.regionId),limit=Math.min(time+(region.start+region.length-pos)*spb,this.origin+captureEnd*spb);
          this.schedule(this.context,target,this.project.clips[slice.clipId],time+slice.delay*spb,slice.offset,slice.length,track.id,region.id,limit,undefined,{region,beat:pos+slice.delay-region.start});
        }
      }this.nextBeat+=step;
    }
    if(launchChanged)this.changed();
    if(this.inputArrangement&&this.context.currentTime>=this.origin+captureEnd*spb){this.stopInputMetronome();this.pause();return;}
    if(this.mode==='arrangement'&&!this.project.transport.loopEnabled&&!this.recording&&!this.automationTake&&!this.inputOverdub&&!this.inputArrangement&&this.overrides.size===0&&this.project.arrangement.length&&this.beat()>Math.max(...this.project.arrangement.map(s=>s.start+s.length))+this.tailSeconds()/spb)this.pause();
  }
  syncSessionActivation(previous){
    if(!this.context||!this.playing)return;
    const beat=this.rawBeat(),time=this.context.currentTime;
    for(const [id,a] of this.active){const old=previous.tracks.find(t=>t.id===id),track=this.project.tracks.find(t=>t.id===id);if(!old||!track||!a.clipId||this.mode!=='session'&&!this.overrides.has(id))continue;const slot=a.slot??track.slots.indexOf(a.clipId);if(slotActive(old,slot)===slotActive(track,slot))continue;
      this.voiceSchedulers.get(this.context)?.release(id,time);this.bufferSchedulers.get(this.context)?.release(id,time);
      if(slotActive(track,slot)&&this.nextBeat>beat){const mixer=this.mixers.get(id);this.schedule(this.context,mixer.input||mixer.chain.input,this.project.clips[a.clipId],time,beat-a.start,this.nextBeat-beat,id,`session:${a.start}`,Infinity,a.bufferIdentity);}
    }
  }
  tailSeconds(sampleRate=this.context?.sampleRate??44100,channel='master'){return routingTail(this.project,sampleRate,channel)+(this.instrumentTail??0);}
  schedule(ctx,target,clip,time,offset,beats,trackId,instance=clip.id,limit=Infinity,bufferIdentity=clip.id,fade){
    const track=this.project.tracks.find(t=>t.id===trackId);
    if(clip.kind==='midi'&&track?.instrument){let scheduler=this.voiceSchedulers.get(ctx);if(!scheduler){scheduler=new VoiceScheduler(ctx,this.project.bpm,(id,pitch)=>this.sampleBuffer(id,pitch),node=>{if(ctx!==this.context)return;this.nodes.add(node);const cleanup=node.onended;node.onended=()=>{this.nodes.delete(node);cleanup?.();};});this.voiceSchedulers.set(ctx,scheduler);}scheduler.schedule(target,track,clip,time,offset,beats,instance,limit);return;}
    const buffer=(clip.kind==='midi'&&track?.midiEffects?.length?this.midiBuffers.get(JSON.stringify([trackId,clip.id]))??this.buffers.get(clip.id):this.buffers.get(clip.id))?.buffer;if(!buffer)return;const spb=60/this.project.bpm;
    // Stretch mode has already prepared tempo/pitch independently; Repitch uses source rate.
    const rate=clip.kind==='audio'&&clip.warp?.mode!=='stretch'?this.project.bpm/clip.sourceBpm:1;
    let remaining=beats,phase=mod(offset,clip.beats),when=time;
    while(remaining>1e-7){const chunk=Math.min(remaining,clip.beats-phase),sourceOffset=phase*spb*rate,dur=chunk*spb;
      if(sourceOffset<buffer.duration){let scheduler=this.bufferSchedulers.get(ctx);if(!scheduler){scheduler=new BufferScheduler(ctx,node=>{if(ctx!==this.context)return;this.nodes.add(node);const cleanup=node.onended;node.onended=()=>{this.nodes.delete(node);cleanup?.();};});this.bufferSchedulers.set(ctx,scheduler);}scheduler.schedule(target,buffer,rate,when,sourceOffset,dur,JSON.stringify([trackId,instance,bufferIdentity]),fade&&clip.kind!=='midi'&&fade.region.fades?{region:fade.region,origin:time-fade.beat*spb,spb}:undefined);}
      remaining-=chunk;phase=0;when+=dur;
    }
  }
  overdubEffectiveClip(clip,track){return track.midiEffects?.length?processMidiClip(clip,track.midiEffects,this.project.bpm):clip;}
  async consolidate(regionId){
    if(this.playing)throw new Error('Stop playback before consolidating.');const passage=consolidationSource(this.project,regionId),regions=structuredClone(passage.regions);await this.init(false);
    const buffers=[];for(const region of regions){const buffer=await this.prepareClip(this.project.clips[region.clipId]);if(!buffer)throw new Error('The source audio is unavailable.');buffers.push(buffer);}
    const channels=Math.max(...buffers.map(b=>b.numberOfChannels)),sampleRate=this.context.sampleRate,frames=Math.ceil(passage.length*60/this.project.bpm*sampleRate);if(channels>2)throw new Error('Consolidation currently supports mono and stereo clips.');if(frames*channels*4+44>CONSOLIDATE_BYTES)throw new Error('Consolidated audio must fit within 30 MB. Shorten the passage.');
    const ctx=new OfflineAudioContext(channels,frames,sampleRate),spb=60/this.project.bpm;for(const region of regions.filter(isRegionActive))this.schedule(ctx,ctx.destination,this.project.clips[region.clipId],(region.start-passage.start)*spb,region.offset,region.length,region.trackId,region.id,(region.start+region.length-passage.start)*spb,undefined,{region,beat:0});return ctx.startRendering();
  }
  async render(options={}, {signal}={}){signal?.throwIfAborted();const settings=exportOptions(options),output=exportChannel(this.project,settings.channel),sessionSource=settings.source==='session'||settings.source!=='arrangement'&&!this.project.arrangement.length;if(settings.source==='arrangement'&&!this.project.arrangement.length)throw new Error('Add Arrangement clips before exporting the Arrangement.');if(settings.range!==undefined&&(sessionSource||!this.project.arrangement.length))throw new Error('Record an Arrangement before exporting a range.');await this.prepare({resume:false});signal?.throwIfAborted();const events=!sessionSource?this.project.arrangement:[...this.active].filter(([,a])=>a.clipId).map(([id,a])=>({trackId:id,clipId:a.clipId,start:0,length:16,offset:0,...(!slotActive(this.project.tracks.find(t=>t.id===id),a.slot??this.project.tracks.find(t=>t.id===id).slots.indexOf(a.clipId))?{active:false}:{})}));
    if(!events.length)throw new Error('Launch a scene or record an arrangement before exporting.');
    const plan=exportRangePlan(events,this.project.bpm,settings.sampleRate,Math.max(this.tailSeconds(settings.sampleRate),this.tailSeconds(settings.sampleRate,settings.channel||'master')),settings.range,settings.includeTail===undefined?true:settings.includeTail);const ctx=new OfflineAudioContext(2,plan.frames,settings.sampleRate),master=ctx.createGain(),compressor=ctx.createDynamicsCompressor();master.gain.value=this.masterVolume;master.connect(compressor);compressor.connect(ctx.destination);
    const graph=createMixGraph(ctx,this.project,master,{meters:false});let rendered;try{for(const m of [...graph.tracks.values(),...graph.returns.values()])m.chain.sync(0,ctx.length/ctx.sampleRate*this.project.bpm/60,0,60/this.project.bpm);if(output.type!=='master'){compressor.disconnect();const channel=output.type==='track'?graph.tracks.get(output.id):graph.returns.get(output.id);channel.pan.connect(ctx.destination);}if(!sessionSource)for(const t of this.channels()){const m=graph.tracks.get(t.id)||graph.returns.get(t.id);for(const target of automationTargets(t,this.project.returns))if(target.enabled&&!this.automationOverrides.has(t.id+':'+target.key))scheduleTarget(m,target,0,ctx.length/ctx.sampleRate*this.project.bpm/60,0,60/this.project.bpm,ctx.sampleRate);}
    const regionMap=new Map(this.project.arrangement.map(r=>[r.id,r]));for(const t of this.project.tracks){const {input}=graph.tracks.get(t.id);for(const s of plan.events.filter(e=>isRegionActive(e)&&e.trackId===t.id).sort((a,b)=>a.start-b.start))this.schedule(ctx,input,this.project.clips[s.clipId],s.start*60/this.project.bpm,s.offset,s.length,t.id,s.id||s.clipId,(s.start+s.length)*60/this.project.bpm,undefined,!sessionSource?{region:regionMap.get(s.id)||s,beat:0}:undefined);}
    signal?.throwIfAborted();rendered=await ctx.startRendering();signal?.throwIfAborted();}finally{graph.dispose();}if(!plan.startFrame)return encodeWave(rendered,settings);const crop=ctx.createBuffer(2,plan.outputFrames,settings.sampleRate);for(let c=0;c<2;c++)crop.copyToChannel(rendered.getChannelData(c).subarray(plan.startFrame,plan.startFrame+plan.outputFrames),c);return encodeWave(crop,settings);
  }
}
