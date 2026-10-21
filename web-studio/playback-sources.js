// Retained clip sources remain in the project for reuse and history. Only
// placements and current runtime launch intentions need decoded audio.
export function playbackSources(engine){
 const {project}=engine,sources=new Map(project.tracks.map(t=>[t.id,new Set()]));
 const add=(trackId,clipId)=>{if(typeof clipId==='string'&&Object.hasOwn(project.clips,clipId)&&sources.has(trackId))sources.get(trackId).add(clipId);};
 for(const track of project.tracks)for(const id of track.slots)add(track.id,id);
 for(const region of project.arrangement)add(region.trackId,region.clipId);
 for(const map of [engine.active,engine.pending])for(const [id,state]of map??[])add(id,state.clipId);
 for(const [id,state]of engine.launchLoads??[])if(!state.signal?.aborted&&engine.launchCurrent(state.binding,id))add(id,state.clipId);
 return sources;
}
export function prunePlaybackBuffers(engine,sources=playbackSources(engine)){
 const clips=new Set([...sources.values()].flatMap(ids=>[...ids]));
 for(const id of engine.buffers.keys())if(!clips.has(id))engine.buffers.delete(id);
 const midi=new Set(engine.project.tracks.filter(t=>!t.instrument&&t.midiEffects?.length).flatMap(t=>[...sources.get(t.id)].filter(id=>engine.project.clips[id]?.kind==='midi').map(id=>JSON.stringify([t.id,id]))));
 for(const key of engine.midiBuffers.keys())if(!midi.has(key))engine.midiBuffers.delete(key);
 return sources;
}
