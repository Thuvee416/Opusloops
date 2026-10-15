import {trimSample,validateSampler} from './sampler.js';
import {floatWav,CONSOLIDATE_BYTES} from './consolidate.js';
// Crop unprocessed PCM; reverse and loop fractions remain editable on the new source.
export function cropSample(ctx,raw,s){
 validateSampler(s);
 if(!s.data)throw new Error('Load a sample before cropping.');
 if(s.start===0&&s.end===1)throw new Error('Set sample start or end before cropping.');
 const frames=Math.ceil(s.end*raw.length)-Math.floor(s.start*raw.length);
 if(frames*Math.min(2,raw.numberOfChannels)*4+44>CONSOLIDATE_BYTES)throw new Error('Cropped WAV must fit within 30 MB. Shorten the sample range.');
 const buffer=trimSample(ctx,raw,{...s,reverse:false});
 return {buffer,wav:floatWav(buffer)};
}
