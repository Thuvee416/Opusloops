import {isLaunchGrid} from './launch.js';
export const defaultTransport = () => ({loopEnabled:false,loopStart:0,loopEnd:16,metronome:false});
export function validateTransport(t){if(t?.followActionsEnabled!==undefined&&typeof t.followActionsEnabled!=='boolean')throw new Error('Invalid global Follow Actions setting.');if(t?.launchQuantization!==undefined&&!isLaunchGrid(t.launchQuantization))throw new Error('Invalid global launch quantization.');if(!t||typeof t.loopEnabled!=='boolean'||typeof t.metronome!=='boolean'||!Number.isFinite(t.loopStart)||!Number.isFinite(t.loopEnd)||t.loopStart<0||t.loopEnd>16384||t.loopEnd-t.loopStart<.25||t.loopStart*4%1!==0||t.loopEnd*4%1!==0)throw new Error('Invalid transport loop.');return t;}
// The audio clock is monotonic. Only the Arrangement position wraps; Session
// phase and queued launches always use the unwrapped audio-clock beat.
export function timelineBeat(raw,t,mode='arrangement'){
  if(mode!=='arrangement'||!t.loopEnabled||raw<t.loopEnd)return raw;
  const length=t.loopEnd-t.loopStart;
  return t.loopStart+((raw-t.loopStart)%length+length)%length;
}
export function quantumLength(raw,t,mode='arrangement'){
  const pos=timelineBeat(raw,t,mode),grid=(Math.floor(raw*4+1e-7)+1)/4-raw;
  return Math.min(grid>1e-7?grid:.25,mode==='arrangement'&&t.loopEnabled?t.loopEnd-pos:Infinity);
}
