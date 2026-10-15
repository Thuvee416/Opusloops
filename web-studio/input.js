import {LiveArpeggiator} from './live-arpeggiator.js';
import {inputChannelSelection,inputChannelsAvailable} from './input-channels.js';
import {processMidiNotes} from './midi-effects.js';
import {drumVoice} from './drums.js';
import {samplerVoice} from './sampler.js';
import {synthVoice} from './instruments.js';
import {wav,uid} from './model.js';
export function encode64(bytes){let text='';const data=new Uint8Array(bytes);for(let i=0;i<data.length;i+=32768)text+=String.fromCharCode(...data.subarray(i,i+32768));return btoa(text);}
export function decodeMidi(data){if(!data||data.length<3||!Number.isInteger(data[0])||data[0]<128||data[0]>239)return null;const type=data[0]&240,channel=data[0]&15,pitch=data[1],velocity=data[2];if(!Number.isInteger(pitch)||pitch<0||pitch>127||!Number.isInteger(velocity)||velocity<0||velocity>127)return null;if(type===176&&pitch===64)return {type:'sustain',channel,down:velocity>=64};if(type===144&&velocity)return {type:'on',channel,pitch,velocity:velocity/127};if(type===128||(type===144&&!velocity))return {type:'off',channel,pitch,velocity:type===128?velocity/127:0};return null;}
export class MidiTake {
  constructor(bpm,start){this.bpm=bpm;this.start=start;this.notes=[];this.held=new Map();}
  on(key,pitch,velocity,time){if(this.held.has(key))this.off(key,time);this.held.set(key,{pitch,velocity,start:Math.max(0,(time-this.start)*this.bpm/60)});}
  off(key,time,releaseVelocity=0){const n=this.held.get(key);if(!n)return;const end=Math.max(n.start+.0625,(time-this.start)*this.bpm/60);this.notes.push({...n,duration:end-n.start,...(releaseVelocity>0?{releaseVelocity}:{})});this.held.delete(key);}
  finish(time){for(const key of [...this.held.keys()])this.off(key,time);const notes=this.notes.slice(0,4096).filter(n=>n.start<=255.9375).map(n=>({...n,duration:Math.min(n.duration,256-n.start)}));const end=Math.max(.25,(time-this.start)*this.bpm/60,...notes.map(n=>n.start+n.duration));return {id:uid(),name:'MIDI take',kind:'midi',sourceBpm:this.bpm,beats:Math.min(256,Math.ceil(end*4)/4),notes};}
}
const loadedContexts=new WeakSet();
export class AudioCapture {
  constructor(context,onFinish){this.context=context;this.onFinish=onFinish;this.active=false;this.chunks=[];this.connected=false;this.generation=0;}
  async connect(deviceId='',channels='stereo:0'){
    const selection=inputChannelSelection(channels);
    await this.disconnect();const generation=++this.generation;
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Audio input is unavailable in this browser. Open the studio over HTTPS.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:deviceId?{exact:deviceId}:undefined,channelCount:{ideal:Math.max(2,selection.required)},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
    this.stream=stream;
    try{if(!loadedContexts.has(this.context)){await this.context.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url));loadedContexts.add(this.context);}if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      this.source=this.context.createMediaStreamSource(stream);this.processor=new AudioWorkletNode(this.context,'opus-capture',{outputChannelCount:[2],channelCountMode:'max',processorOptions:{channels}});this.silent=this.context.createGain();this.silent.gain.value=0;this.monitor=this.context.createGain();this.monitor.gain.value=0;
      this.source.connect(this.processor);this.processor.connect(this.silent);this.silent.connect(this.context.destination);this.processor.connect(this.monitor);this.monitor.connect(this.context.destination);
      let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),timer=setTimeout(()=>readyReject(new Error('Audio input did not provide channels. Reconnect the input.')),3000);
      this.processor.port.onmessage=({data})=>{if(data.type==='channels'&&data.count>0){this.inputChannels=data.count;if(inputChannelsAvailable(data.count,selection))readyResolve();else{const error=new Error('Selected input channels are unavailable; the browser provides '+data.count+' channel(s).');readyReject(error);if(this.connected){const endedGeneration=this.generation;this.connected=false;this.onDisconnected?.();this.stop().finally(()=>{if(endedGeneration===this.generation)return this.disconnect();}).catch(()=>{});}}}if(data.type==='started')this.startedFrame=data.frame;if(data.type==='cancelled'){this.active=false;this.chunks=[];this.reject?.(new DOMException('Count-in cancelled.','AbortError'));}if(data.type==='chunk')this.chunks.push(data.channels);if(data.type==='finished'){this.active=false;this.complete(data.frames);}};try{await ready;}finally{clearTimeout(timer);}if(generation!==this.generation)return;this.connected=true;
      this.processor.onprocessorerror=()=>{this.connected=false;this.onDisconnected?.();this.active=false;this.reject?.(new Error('Audio input processing stopped unexpectedly. Reconnect the input and try again.'));this.disconnect().catch(()=>{});};
      for(const track of stream.getTracks())track.onended=()=>{const endedGeneration=this.generation;this.connected=false;this.onDisconnected?.();this.stop().finally(()=>{if(endedGeneration===this.generation)return this.disconnect();}).catch(()=>{});};
    }catch(error){if(generation===this.generation)await this.disconnect();else stream.getTracks().forEach(t=>t.stop());throw error;}
  }
  setMonitor(enabled){if(this.monitor)this.monitor.gain.setTargetAtTime(enabled?.5:0,this.context.currentTime,.01);}
  start(bpm,startTime=this.context.currentTime){if(!Number.isFinite(startTime)||startTime<0)throw new Error('Invalid recording start time.');if(!this.connected)throw new Error('Connect an audio input first.');if(this.active)throw new Error('A take is already recording.');this.bpm=bpm;this.chunks=[];this.active=true;this.completion=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});this.completion.catch(()=>{});this.processor.port.postMessage({type:'start',startFrame:Math.round(startTime*this.context.sampleRate),limit:Math.floor(Math.min(300,256*60/bpm,12000000/this.context.sampleRate)*this.context.sampleRate)});}
  async cancel(){if(!this.active)return;this.processor.port.postMessage({type:'cancel'});try{await this.completion;}catch(error){if(error.name!=='AbortError')throw error;}}
  async stop(){if(!this.active)return this.completion;this.processor.port.postMessage({type:'stop'});return this.completion;}
  complete(frames){try{if(frames<128)throw new Error('The take was too short. Record a little longer.');const sr=this.context.sampleRate,beats=Math.min(256,Math.ceil(frames/sr*this.bpm/60*4)/4),length=Math.max(frames,Math.ceil(beats*60/this.bpm*sr)),buffer=this.context.createBuffer(2,length,sr);let at=0;for(const chunk of this.chunks){for(let c=0;c<2;c++)buffer.copyToChannel(chunk[c],c,at);at+=chunk[0].length;}this.chunks=[];const clip={id:uid(),name:'Audio take',kind:'audio',beats,sourceBpm:this.bpm,data:encode64(wav(buffer))};this.onFinish?.(clip,buffer);this.resolve?.({clip,buffer});}catch(error){this.reject?.(error);}finally{this.active=false;}}
  async disconnect(){this.generation++;try{if(this.active)await this.stop();}finally{this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});for(const n of [this.source,this.processor,this.silent,this.monitor])n?.disconnect();this.active=false;this.chunks=[];this.connected=false;this.stream=null;}}
}
export class LiveNotes {
  constructor(engine,onError=()=>{}){this.engine=engine;this.onError=onError;this.voices=new Map();this.sounding=new Set();this.pending=new Map();this.arps=new Map();this.arpKeys=new Map();}
  on(key,pitch,velocity,trackId){
    this.off(key);const e=this.engine,ctx=e.context,target=e.mixers?.get(trackId)?.chain.input;if(!ctx||!target)return;
    const track=e.project.tracks.find(t=>t.id===trackId),effects=structuredClone(track?.midiEffects),firstTiming=effects?.find(d=>d.enabled&&d.type==='length'),bpm=e.project.bpm??120,time=ctx.currentTime;
    const arpIndex=effects?.findIndex(d=>d.enabled&&d.type==='arpeggiator')??-1;if(arpIndex>=0){let arp=this.arps.get(trackId);if(!arp||arp.closed){arp=new LiveArpeggiator(this,trackId,effects,arpIndex);this.arps.set(trackId,arp);}this.arpKeys.set(key,trackId);arp.on(key,pitch,velocity);return;}
    if(firstTiming?.trigger==='off'){if(this.pending.size>=128)this.pending.delete(this.pending.keys().next().value);this.pending.set(key,{pitch,velocity,trackId,effects,bpm,time});return;}
    this.spawn(key,processMidiNotes({pitch,velocity,start:0},effects,bpm),trackId,time,bpm);
  }
  spawn(key,notes,trackId,time,bpm){
    const e=this.engine,ctx=e.context,target=e.mixers?.get(trackId)?.chain.input;if(!ctx||!target)return;const instrument=e.project.tracks.find(t=>t.id===trackId)?.instrument,group=new Set();
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
