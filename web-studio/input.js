import {DEFAULT_RECORD_QUANTIZATION,patchRecordQuantization,quantizeRecordedClip} from './record-quantization.js';
import {LiveArpeggiator} from './live-arpeggiator.js';
import {inputChannelSelection,inputChannelsAvailable} from './input-channels.js';
import {processMidiNotes} from './midi-effects.js';
import {drumVoice} from './drums.js';
import {samplerVoice} from './sampler.js';
import {synthVoice} from './instruments.js';
import {wav,uid} from './model.js';
export function encode64(bytes){let text='';const data=new Uint8Array(bytes);for(let i=0;i<data.length;i+=32768)text+=String.fromCharCode(...data.subarray(i,i+32768));return btoa(text);}
export function decodeMidi(data){if(!data||data.length<3||!Number.isInteger(data[0])||data[0]<128||data[0]>239)return null;const type=data[0]&240,channel=data[0]&15,pitch=data[1],velocity=data[2];if(!Number.isInteger(pitch)||pitch<0||pitch>127||!Number.isInteger(velocity)||velocity<0||velocity>127)return null;if(type===176&&pitch===64)return {type:'sustain',channel,down:velocity>=64};if(type===176&&velocity===0&&[121,123].includes(pitch))return {type:pitch===121?'reset-controllers':'all-notes-off',channel};if(type===144&&velocity)return {type:'on',channel,pitch,velocity:velocity/127};if(type===128||(type===144&&!velocity))return {type:'off',channel,pitch,velocity:type===128?velocity/127:0};return null;}
export class MidiTake {
  constructor(bpm,start,{quantization=DEFAULT_RECORD_QUANTIZATION,sampleRate=48000,maxBeats=256}={}){
    if(!Number.isFinite(bpm)||bpm<40||bpm>240||!Number.isFinite(start)||start<0||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>384000)throw new Error('Invalid MIDI recording clock.');
    if(!Number.isFinite(maxBeats)||maxBeats<.25||maxBeats>256)throw Error('Invalid Recording Length Limit.');this.maxBeats=maxBeats;
    this.bpm=bpm;this.start=start;this.minDuration=bpm/(60*sampleRate);this.notes=[];this.held=new Map();this.quantization=Object.freeze(patchRecordQuantization(DEFAULT_RECORD_QUANTIZATION,quantization));
  }
  on(key,pitch,velocity,time){
    if(this.closed||!Number.isFinite(time)||time<this.start)return false;
    const start=(time-this.start)*this.bpm/60;
    if(start>this.maxBeats-this.minDuration){this.timeLimitReached=true;return false;}
    if(this.held.has(key))this.off(key,time);
    if(this.notes.length+this.held.size>=4096){this.limitReached=true;return false;}
    this.held.set(key,{pitch,velocity,start});return true;
  }
  off(key,time,releaseVelocity=0){
    const n=this.held.get(key);if(this.closed||!n||!Number.isFinite(time))return;
    const duration=Math.min(this.maxBeats-n.start,Math.max(this.minDuration,(time-this.start)*this.bpm/60-n.start));
    this.notes.push({...n,duration,...(releaseVelocity>0?{releaseVelocity}:{})});this.held.delete(key);
  }
  finish(time){
    if(this.closed)return structuredClone(this.clip);
    if(!Number.isFinite(time))throw new Error('Invalid MIDI recording finish time.');
    for(const key of [...this.held.keys()])this.off(key,time);
    const notes=structuredClone(this.notes),end=Math.max(.25,Math.min(this.maxBeats,(time-this.start)*this.bpm/60),...notes.map(n=>n.start+n.duration));
    const raw={id:uid(),name:'MIDI take',kind:'midi',sourceBpm:this.bpm,beats:Math.min(256,Math.ceil(end*4)/4),notes};
    this.rawClip=structuredClone(raw);const result=quantizeRecordedClip(raw,this.quantization);
    if(this.maxBeats<256){let bounded=0;result.clip.notes=result.clip.notes.map(n=>{const start=Math.min(n.start,this.maxBeats-this.minDuration),duration=Math.min(n.duration,this.maxBeats-start);if(start!==n.start||duration!==n.duration)bounded++;return {...n,start,duration};});result.report.tailLimited=(result.report.tailLimited??0)+bounded;result.report.changed=JSON.stringify(result.clip)!==JSON.stringify(raw);}
    this.quantizationReport=result.report;this.clip=result.clip;this.closed=true;return structuredClone(this.clip);
  }
}
const loadedContexts=new WeakSet();
export class AudioCapture {
  // Wrap browser timers so they are never invoked with AudioCapture as their receiver.
  constructor(context,onFinish,{setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){this.context=context;this.onFinish=onFinish;this.active=false;this.chunks=[];this.connected=false;this.generation=0;this.setTimer=setTimer;this.clearTimer=clearTimer;}
  async connect(deviceId='',channels='stereo:0'){
    if(this.recoverable)throw Error('Retry Saving The Captured Take Or Cancel It Before Reconnecting.');
    const selection=inputChannelSelection(channels);
    await this.disconnect();const generation=++this.generation;
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Audio input is unavailable in this browser. Open the studio over HTTPS.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId?{exact:deviceId}:undefined,channelCount:{ideal:Math.max(2,selection.required)},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
    this.stream=stream;
    try{if(!loadedContexts.has(this.context)){await this.context.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url));loadedContexts.add(this.context);}if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      this.source=this.context.createMediaStreamSource(stream);this.processor=new AudioWorkletNode(this.context,'opus-capture',{outputChannelCount:[2],channelCountMode:'max',processorOptions:{channels}});this.silent=this.context.createGain();this.silent.gain.value=0;this.monitor=this.context.createGain();this.monitor.gain.value=0;
      this.source.connect(this.processor);this.processor.connect(this.silent);this.silent.connect(this.context.destination);this.processor.connect(this.monitor);this.monitorTarget=null;
      let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),timer=setTimeout(()=>readyReject(new Error('Audio input did not provide channels. Reconnect the input.')),3000);
      const processor=this.processor;
      this.processor.port.onmessage=({data})=>{
       if(this.processor!==processor)return;
       if(data.type==='channels'){
        this.inputChannels=data.count;
        if(data.count>0&&inputChannelsAvailable(data.count,selection))readyResolve();
        else if(data.count>0||this.connected){const error=new Error('Selected input channels are unavailable; the browser provides '+data.count+' channel(s).');readyReject(error);if(this.connected)this.inputEnded();}
       }
       if(!this.active)return;
       if(data.type==='started')this.startedFrame=data.frame;
       if(data.type==='cancelled')this.cancelled();
       if(data.type==='chunk'&&this.finishRequest!=='cancel')this.chunks.push(data.channels);
       if(data.type==='finished'){if(this.finishRequest==='cancel')this.cancelled();else this.complete(data.frames);}
      };
      try{await ready;}finally{clearTimeout(timer);}if(generation!==this.generation)return;this.connected=true;
      this.processor.onprocessorerror=()=>{if(this.processor===processor)this.interrupted('Audio Input Processing Stopped Unexpectedly.');};
      for(const track of stream.getTracks())track.onended=()=>{if(this.processor===processor)this.inputEnded();};
    }catch(error){if(generation===this.generation)await this.disconnect();else stream.getTracks().forEach(t=>t.stop());throw error;}
  }
  setMonitor(enabled,target=this.context.destination,level=.5){
    if(!this.monitor)return;
    if(!Number.isFinite(level)||level<0||level>1)throw Error('Invalid Input Monitor Level.');
    const now=this.context.currentTime,active=!!enabled&&!!target&&this.connected;
    if(active&&target!==this.monitorTarget){this.monitor.gain.cancelScheduledValues(now);this.monitor.gain.setValueAtTime(0,now);this.monitor.disconnect();this.monitorTarget=null;this.monitor.connect(target);this.monitorTarget=target;}
    this.monitor.gain.setTargetAtTime(active?level:0,now,.01);
  }
  start(bpm,startTime=this.context.currentTime,{maxBeats=256}={}){
    if(this.recoverable)throw Error('Retry Saving The Captured Take Or Cancel It Before Recording Again.');
    if(!Number.isFinite(bpm)||bpm<=0)throw Error('Invalid Recording Tempo.');
    if(!Number.isFinite(maxBeats)||maxBeats<.25||maxBeats>256)throw Error('Invalid Recording Length Limit.');if(!Number.isFinite(startTime)||startTime<0)throw new Error('Invalid recording start time.');if(!this.connected)throw new Error('Connect an audio input first.');if(this.active)throw new Error('A take is already recording.');
    this.clearFinishTimer();this.finishRequest=null;this.interruption=null;this.bpm=bpm;this.chunks=[];this.active=true;this.completion=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});this.completion.catch(()=>{});
    try{this.processor.port.postMessage({type:'start',startFrame:Math.round(startTime*this.context.sampleRate),limit:Math.floor(Math.min(300,maxBeats*60/bpm,12000000/this.context.sampleRate)*this.context.sampleRate)});}catch(error){this.interrupted('Audio Input Could Not Start.');throw error;}
  }
  clearFinishTimer(){if(this.finishTimer!==undefined)this.clearTimer(this.finishTimer);this.finishTimer=undefined;}
  requestFinish(type){
    if(!this.active)return;
    if(this.finishRequest==='cancel'||this.finishRequest===type)return;
    this.finishRequest=type;this.clearFinishTimer();
    this.finishTimer=this.setTimer(()=>this.interrupted('Audio Input Did Not Finish Responding.'),5000);
    try{this.processor.port.postMessage({type});}catch{this.interrupted('Audio Input Connection Was Lost.');}
  }
  async cancel(){if(this.recoverable){this.recoverable=null;this.chunks=[];this.completion=null;this.resolve=null;this.reject=null;return;}if(!this.active)return;this.requestFinish('cancel');try{await this.completion;}catch(error){if(error.name!=='AbortError')throw error;}}
  retainPrepared(result){this.recoverable={prepared:result};}
  retry(){
    if(!this.recoverable)throw Error('No Captured Take Is Waiting To Be Saved.');
    if(this.recoverable.prepared){const result=this.recoverable.prepared;this.recoverable=null;this.completion=Promise.resolve(result);return this.completion;}
    const {frames,recovery}=this.recoverable;
    this.completion=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});this.completion.catch(()=>{});
    this.complete(frames,recovery);return this.completion;
  }
  async stop(){if(this.active)this.requestFinish('stop');return this.completion;}
  cancelled(){this.clearFinishTimer();this.active=false;this.chunks=[];this.reject?.(new DOMException('Recording Cancelled.','AbortError'));}
  inputEnded(){
    const processor=this.processor;this.interruption='Audio Input Disconnected.';this.connected=false;this.setMonitor(false);this.onDisconnected?.();
    this.stop().finally(()=>{if(this.processor===processor)this.teardown();}).catch(()=>{});
  }
  interrupted(message){
    const wasActive=this.active;this.connected=false;this.clearFinishTimer();
    if(wasActive){
      if(this.finishRequest==='cancel')this.cancelled();
      else{const frames=this.chunks.reduce((sum,chunk)=>sum+chunk[0].length,0);
        if(frames>=128)this.complete(frames,{interrupted:true,warning:message+' Only Audio Already Received Was Recovered. The End Of The Take May Be Missing. Reconnect The Input.'});
        else{this.active=false;this.chunks=[];this.reject?.(new Error(message+' No Recoverable Audio Was Received. Reconnect The Input.'));}
      }
    }
    this.teardown();this.onDisconnected?.();
  }
  complete(frames,recovery={}){
    this.clearFinishTimer();this.active=false;
    try{
      if(this.interruption&&!recovery.interrupted)recovery={interrupted:true,warning:this.interruption+' Audio Received Before Disconnection Was Recovered. Reconnect The Input.'};
      const received=this.chunks.reduce((sum,chunk)=>sum+chunk[0].length,0);
      if(!Number.isSafeInteger(frames)||frames!==received)throw new Error('Recorded Audio Is Incomplete. Reconnect The Input.');
      if(frames<128)throw new Error('The take was too short. Record a little longer.');
      this.recoverable={frames,recovery};
      const sr=this.context.sampleRate,beats=Math.min(256,Math.ceil(frames/sr*this.bpm/60*4)/4),length=Math.max(frames,Math.ceil(beats*60/this.bpm*sr)),buffer=this.context.createBuffer(2,length,sr);let at=0;
      for(const chunk of this.chunks){for(let c=0;c<2;c++)buffer.copyToChannel(chunk[c],c,at);at+=chunk[0].length;}
      const clip={id:uid(),name:recovery.interrupted?'Recovered Audio Take':'Audio take',kind:'audio',beats,sourceBpm:this.bpm,data:encode64(wav(buffer))};this.chunks=[];this.recoverable=null;this.onFinish?.(clip,buffer);this.resolve?.({clip,buffer,...recovery});
    }catch(error){if(this.recoverable)this.reject?.(new Error('The Captured Take Could Not Be Prepared. Audio Is Kept In This Tab; Choose Retry Saving Take Or Cancel. '+error.message,{cause:error}));else{this.chunks=[];this.reject?.(error);}}
  }
  teardown(){
    this.clearFinishTimer();this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});
    if(this.processor){this.processor.port.onmessage=null;this.processor.onprocessorerror=null;}
    for(const n of [this.source,this.processor,this.silent,this.monitor])n?.disconnect();
    this.active=false;this.connected=false;this.stream=null;this.processor=null;this.monitorTarget=null;
  }
  async disconnect(){this.generation++;try{if(this.active)await this.stop();}finally{this.teardown();if(!this.recoverable)this.chunks=[];}}

}
export class LiveNotes {
  constructor(engine,onError=()=>{}){this.engine=engine;this.onError=onError;this.voices=new Map();this.sounding=new Set();this.pending=new Map();this.arps=new Map();this.arpKeys=new Map();}
  on(key,pitch,velocity,trackId){
    this.off(key);const e=this.engine,ctx=e.context,mixer=e.mixers?.get(trackId),target=mixer?.input||mixer?.chain.input;if(!ctx||!target)return;
    const track=e.project.tracks.find(t=>t.id===trackId),effects=structuredClone(track?.midiEffects),firstTiming=effects?.find(d=>d.enabled&&d.type==='length'),bpm=e.project.bpm??120,time=ctx.currentTime;
    const arpIndex=effects?.findIndex(d=>d.enabled&&d.type==='arpeggiator')??-1;if(arpIndex>=0){let arp=this.arps.get(trackId);if(!arp||arp.closed){arp=new LiveArpeggiator(this,trackId,effects,arpIndex);this.arps.set(trackId,arp);}this.arpKeys.set(key,trackId);arp.on(key,pitch,velocity);return;}
    if(firstTiming?.trigger==='off'){if(this.pending.size>=128)this.pending.delete(this.pending.keys().next().value);this.pending.set(key,{pitch,velocity,trackId,effects,bpm,time});return;}
    this.spawn(key,processMidiNotes({pitch,velocity,start:0},effects,bpm),trackId,time,bpm);
  }
  spawn(key,notes,trackId,time,bpm){
    const e=this.engine,ctx=e.context,mixer=e.mixers?.get(trackId),target=mixer?.input||mixer?.chain.input;if(!ctx||!target)return;const instrument=e.project.tracks.find(t=>t.id===trackId)?.instrument,group=new Set();
    for(const note of notes){
      const at=Math.max(ctx.currentTime,time+(note.start??0)*60/bpm);
      if(this.sounding.size>=128){const oldest=this.sounding.values().next().value;oldest.release(ctx.currentTime,true);this.sounding.delete(oldest);for(const [held,g]of this.voices){g.delete(oldest);if(!g.size)this.voices.delete(held);}}
      let voice;
      if(instrument)voice=instrument.type==='drums'?drumVoice(ctx,target,instrument,note.pitch,note.velocity,e.sampleBuffer(trackId,note.pitch),at,0,trackId):instrument.type==='sampler'?samplerVoice(ctx,target,instrument,e.sampleBuffers.get(trackId)?.buffer,note.pitch,note.velocity,at):synthVoice(ctx,target,instrument,note.pitch,note.velocity,at);
      else{const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.value=440*2**((note.pitch-69)/12);gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(note.velocity*.23,at+.008);osc.connect(gain);gain.connect(target);osc.start(at);let releaseAt=Infinity;voice={osc,release(time=ctx.currentTime,force=false){if(!force&&time>=releaseAt)return;releaseAt=Math.min(releaseAt,time);gain.gain.cancelScheduledValues(time);gain.gain.setTargetAtTime(0,time,force?.005:.025);osc.stop(time+(force?.03:.15));}};osc.onended=()=>{osc.disconnect();gain.disconnect();};}
      if(!voice)continue;voice.startTime=at;if(Number.isFinite(note.duration)){voice.timed=true;voice.release(at+note.duration*60/bpm);}group.add(voice);this.sounding.add(voice);e.nodes.add(voice.osc);const cleanup=voice.osc.onended;
      voice.osc.onended=()=>{e.nodes.delete(voice.osc);this.sounding.delete(voice);group.delete(voice);if(!group.size&&this.voices.get(key)===group)this.voices.delete(key);cleanup?.();};
    }
    if(group.size)this.voices.set(key,group);
  }
  cancelGroup(key){const group=this.voices.get(key);this.voices.delete(key);for(const voice of group||[])voice.release(this.engine.context.currentTime,true);}
  off(key,releaseVelocity=0){if(this.arpKeys.has(key)){const id=this.arpKeys.get(key);this.arpKeys.delete(key);this.arps.get(id)?.off(key,releaseVelocity);return;}const pending=this.pending.get(key);if(pending){this.pending.delete(key);const duration=Math.max(0,(this.engine.context.currentTime-pending.time)*pending.bpm/60);this.spawn(key,processMidiNotes({pitch:pending.pitch,velocity:pending.velocity,start:0,duration,releaseVelocity},pending.effects,pending.bpm),pending.trackId,pending.time,pending.bpm);}const group=this.voices.get(key);if(!group)return;this.voices.delete(key);for(const voice of group)if(!voice.timed){const now=this.engine.context.currentTime;voice.release(now,now<voice.startTime);}}
  allOff(){for(const arp of this.arps.values())arp.dispose();this.arps.clear();this.arpKeys.clear();this.pending.clear();for(const key of [...this.voices.keys()])this.off(key);for(const voice of this.sounding)voice.release(this.engine.context.currentTime,true);}
}

// A re-created engine cannot reuse a microphone graph owned by a closed context.
export async function captureForContext(current,context,create=ctx=>new AudioCapture(ctx)){
 if(current?.context===context)return current;
 if(current?.active||current?.recoverable)throw Error('Finish Or Recover The Current Audio Take Before Reconnecting.');
 if(current)await current.disconnect();
 return create(context);
}
