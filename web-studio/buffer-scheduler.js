// Keep contiguous windows on one source so resampling phase survives scheduler quanta.
export class BufferScheduler {
 constructor(ctx,onNode=()=>{}){this.ctx=ctx;this.onNode=onNode;this.voices=new Map();}
 schedule(target,buffer,rate,time,offset,duration,key){
  const end=time+Math.min(duration,(buffer.duration-offset)/rate);if(end<=time)return;
  const previous=this.voices.get(key);
  if(previous&&previous.buffer===buffer&&previous.target===target&&previous.rate===rate&&Math.abs(previous.end-time)<1e-7&&Math.abs(previous.sourceEnd-offset)<1e-7&&previous.end>=this.ctx.currentTime-1e-8){previous.end=end;previous.sourceEnd=offset+(end-time)*rate;previous.node.stop(end);return;}
  const node=this.ctx.createBufferSource();node.buffer=buffer;node.playbackRate.value=rate;node.connect(target);const voice={node,buffer,target,rate,end,sourceEnd:offset+(end-time)*rate};this.voices.set(key,voice);
  node.onended=()=>{if(this.voices.get(key)===voice)this.voices.delete(key);node.disconnect();};this.onNode(node);node.start(time,offset);node.stop(end);
 }
}
