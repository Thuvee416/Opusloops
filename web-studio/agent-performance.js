// Observe the engine, never infer performance completion from a button click.
export function sessionPerformanceState(engine) {
  return {
    mode:engine.mode, playing:engine.playing, position:engine.beat(), clockBeat:engine.rawBeat(), activeScene:engine.activeScene, sceneActivationBeat:engine.sceneActivationBeat??null, sceneScheduledAhead:engine.playing&&engine.sceneActivationBeat>engine.rawBeat(),
    queuedScene:engine.pendingScene ? {scene:engine.pendingScene.index,beat:engine.pendingScene.beat} : null,
    tracks:engine.project.tracks.map(t=>({trackId:t.id,name:t.name,clipId:engine.active.get(t.id)?.clipId??null,clipName:engine.project.clips?.[engine.active.get(t.id)?.clipId]?.name??null,slot:engine.active.get(t.id)?.slot??null,activationBeat:engine.active.get(t.id)?.activationBeat??null,scheduledAhead:engine.playing&&(engine.active.get(t.id)?.activationBeat??-Infinity)>engine.rawBeat(),overridesArrangement:engine.overrides.has(t.id),pending:engine.pending.has(t.id)?{clipId:engine.pending.get(t.id).clipId??null,beat:engine.pending.get(t.id).beat}:null}))
  };
}
const delay=()=>new Promise(resolve=>setTimeout(resolve,20));
export async function settlePerformance(engine, receipt, {signal,sleep=delay}={}) {
  if(receipt.interrupted)throw new Error('Playback changed while preparing the launch.');
  const generation=engine.playGeneration;
  const items=[...(receipt.events||[]).map(v=>({event:v.event,current:()=>engine.pending.get(v.trackId)})),...(receipt.scene?[{event:receipt.scene,current:()=>engine.pendingScene}]:[])];
  const lastBeat=Math.max(engine.rawBeat(),...items.map(v=>v.event.beat));
  // Quantization can legitimately take 32 beats at the lowest supported tempo.
  const expires=Date.now()+Math.max(15000,(lastBeat-engine.rawBeat())*60/engine.project.bpm*1000+10000);
  try{
    for(;;){
      signal?.throwIfAborted();
      if(generation!==engine.playGeneration)throw new Error('Playback stopped or restarted before the launch completed.');
      if(!engine.playing&&items.every(v=>v.event.appliedBeat!==undefined&&engine.rawBeat()+1e-7>=v.event.appliedBeat))return {sessionPerformance:true,...sessionPerformanceState(engine)};
      if(!engine.playing)throw new Error('Playback stopped or restarted before the launch completed.');
      for(const item of items)if(item.event.appliedBeat===undefined&&item.current()!==item.event)throw new Error('A newer performance action replaced this launch.');
      const done=items.every(v=>v.event.appliedBeat!==undefined&&engine.rawBeat()+1e-7>=v.event.appliedBeat);
      if(done)return {sessionPerformance:true,cancelledToggle:receipt.cancelled===true,...sessionPerformanceState(engine)};
      if(Date.now()>expires)throw new Error('The audio clock did not reach the launch boundary. Check the audio output and try again.');
      await sleep();
    }
  }catch(error){
    // Cancel only our own unscheduled events. Already scheduled audio, another
    // action's events, and previously playing clips are not silently rolled back.
    let removed=false;
    for(const {trackId,event} of receipt.events||[])if(event.appliedBeat===undefined&&engine.pending.get(trackId)===event){engine.pending.delete(trackId);removed=true;}
    if(receipt.scene?.appliedBeat===undefined&&engine.pendingScene===receipt.scene){engine.pendingScene=null;removed=true;}
    if(removed)engine.changed();
    error.performanceState=sessionPerformanceState(engine);throw error;
  }
}
export async function performSessionCommand(engine, command, {signal}={}){
  signal?.throwIfAborted();const a=command.args||{};let receipt;
  try{
  if(command.name==='launch_scene')receipt=await engine.scene(a.scene,{signal});
  else if(command.name==='launch_clip')receipt=await engine.launch(a.trackId,engine.project.tracks.find(t=>t.id===a.trackId).slots[a.scene],a.scene,{signal});
  else if(command.name==='stop_track')receipt=await engine.launch(a.trackId,null,undefined,{signal});
  else if(command.name==='stop_clips'){
    receipt=await engine.stopAll();if(!engine.playing)return {sessionPerformance:true,...sessionPerformanceState(engine)};
  }else throw new Error('Unsupported Session performance command.');
  return await settlePerformance(engine,receipt,{signal});
  }catch(error){error.performanceState??=sessionPerformanceState(engine);throw error;}
}
export function describePerformance(state){
  const parts=[state.playing?'Transport running':'Transport stopped'];
  if(state.activeScene!==null&&state.activeScene!==undefined)parts.push('Scene '+(state.activeScene+1)+(state.sceneScheduledAhead?' scheduled':' selected'));
  if(state.queuedScene)parts.push('Scene '+(state.queuedScene.scene+1)+' queued');
  for(const t of state.tracks||[]){let text=t.name+': '+(t.clipId?(t.clipName||'clip')+(t.scheduledAhead?' (scheduled)':!state.playing?' (ready)':''):'stopped');if(t.pending)text+=t.pending.clipId?' → launch queued':' → stop queued';parts.push(text);}
  return parts.join(' · ')+'.';
}
