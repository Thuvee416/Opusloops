import {isGroup} from './track-hierarchy.js';
// Monitoring is a playback-only branch; the recorder keeps the selected dry
// hardware channels. A missing track must never fall back to the raw output.
export function inputMonitorRoute(engine,trackId,mode='track'){
 if(!engine?.context)return null;
 if(mode==='raw')return {target:engine.context.destination,level:.5};
 if(mode!=='track')return null;
 const track=engine.project.tracks.find(t=>t.id===trackId);
 if(!track||isGroup(track))return null;
 const mixer=engine.mixers?.get(trackId),target=mixer?.input||mixer?.chain?.input;
 return target?{target,level:1}:null;
}
