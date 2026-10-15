export const LAUNCH_GRIDS=[[0,'None'],[.125,'1/32'],[1/6,'1/16 triplet'],[.25,'1/16'],[1/3,'1/8 triplet'],[.5,'1/8'],[2/3,'1/4 triplet'],[1,'1/4'],[2,'1/2'],[4,'1 bar'],[8,'2 bars'],[16,'4 bars'],[32,'8 bars']];
export const isLaunchGrid=value=>LAUNCH_GRIDS.some(([grid])=>grid===value);
export function validateClipLaunch(launch){if(launch===undefined)return;if(!launch||typeof launch!=='object'||Array.isArray(launch)||typeof launch.legato!=='boolean'||(launch.quantization!=='global'&&!isLaunchGrid(launch.quantization))||(launch.mode!==undefined&&!['trigger','toggle','gate','repeat'].includes(launch.mode)))throw new Error('Invalid clip launch settings.');}
export function nextLaunchBeat(earliest,global=4,clip='global'){const grid=clip==='global'?global:clip;if(!Number.isFinite(earliest)||earliest<0||!isLaunchGrid(grid))throw new Error('Invalid launch timing.');return grid===0?earliest:Math.max(0,Math.ceil((earliest-1e-7)/grid)*grid);}
export function pendingQuantum(beat,length,pending){for(const event of pending.values())if(event.beat>beat+1e-7)length=Math.min(length,event.beat-beat);return length;}

// Repeated presses cancel an uncommitted toggle request. Committed events
// already belong to the audio scheduler and a new press queues the opposite action.
export function toggleLaunchAction(clipId,active,pending){if(pending?.clipId===clipId||pending?.toggleSource===clipId)return 'cancel';return active?.clipId===clipId?'stop':'start';}

export function repeatGrid(clip,transport){const value=clip?.launch?.quantization??'global';return value==='global'?(transport.launchQuantization??4):value;}

export const slotStops=(track,index)=>!track.noStopSlots?.includes(index);
