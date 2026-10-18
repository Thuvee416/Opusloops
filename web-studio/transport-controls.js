const stoppedStarts=new WeakMap();
export function transportSnapshot(engine){return {running:engine.playing||!!engine.startPromise&&stoppedStarts.get(engine)!==engine.startPromise,position:engine.beat()};}
export function playbackIntent(args={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='from')||args.from!==undefined&&!['marker','continue'].includes(args.from))throw new Error('Play accepts from: marker or continue.');
 return {from:args.from??'marker'};
}
export function stopIntent(args={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='reset')||args.reset!==undefined&&typeof args.reset!=='boolean')throw new Error('Stop accepts reset: true or false.');
 return {reset:args.reset??false};
}
export async function preparePlayback(engine,args={}){
 const intent=playbackIntent(args);if(engine.playing)return {alreadyPlaying:true,...intent};
 if(intent.from==='marker'&&engine.position!==(engine.insertMarker??0))await engine.seek(engine.insertMarker??0,{moveMarker:false,snap:false});
 return {alreadyPlaying:false,...intent};
}
export async function stopPlayback(engine,args={},snapshot=transportSnapshot(engine)){
 const {reset}=stopIntent(args),rewind=reset||!snapshot.running;if(engine.startPromise)stoppedStarts.set(engine,engine.startPromise);
 if(rewind){engine.insertMarker=0;engine.stop();}
 else if(engine.playing||engine.startPromise)engine.pause();
 // Finishing a new input take may have halted/reset the engine before this step.
 else if(engine.position!==snapshot.position)await engine.seek(snapshot.position,{moveMarker:false,snap:false});
 return {playing:!!engine.playing,position:engine.beat(),insertMarker:engine.insertMarker??0,reset:rewind};
}
