// Original, reproducible audit media. No project/auth seeding or third-party samples.
import {mkdir,writeFile} from 'node:fs/promises';
import {exportMidiClip} from '../../web-studio/midi-file.js';
export function coreSongMedia(){
const rate=44100,seconds=8,frames=rate*seconds,data=Buffer.alloc(44+frames*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*2,40);
let seed=731;
for(let i=0;i<frames;i++){const t=i/rate,beat=t*2,b=beat%1,h=beat%.5,s=beat%2,noise=((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32)*2-1;const kick=.48*Math.exp(-b*19)*Math.sin(2*Math.PI*(48*t-8/38*Math.exp(-b*38)));const hat=.045*noise*Math.exp(-h*70);const snare=s>=1?.12*noise*Math.exp(-(s-1)*28):0;const fade=Math.min(1,t/.002,(seconds-t)/.004);const value=(kick+hat+snare)*fade;data.writeInt16LE(Math.round(Math.max(-1,Math.min(1,value))*32767),44+i*2);}

const bass={kind:'midi',name:'Night Tide Bass',beats:16,notes:[]},keys={kind:'midi',name:'Night Tide Keys',beats:16,notes:[]};
for(let bar=0;bar<4;bar++){const root=[45,41,48,43][bar];for(let n=0;n<4;n++)bass.notes.push({pitch:root+(n===3?12:0),start:bar*4+n,duration:n===3?.45:.7,velocity:n%2?.63:.78});for(const pitch of [root+12,root+15,root+19])keys.notes.push({pitch,start:bar*4+.25,duration:3.5,velocity:.54});}
return {drums:data,bass:exportMidiClip(bass,120),keys:exportMidiClip(keys,120),source:{bass,keys},rate,frames,beats:16};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){const out=process.argv[2]||'/tmp/opus-core-song-media';await mkdir(out,{recursive:true});const media=coreSongMedia();for(const [name,bytes]of [['Drums-120-4bars.wav',media.drums],['Bass-4bars.mid',media.bass],['Keys-4bars.mid',media.keys]])await writeFile(out+'/'+name,bytes);console.log(JSON.stringify({directory:out,audioFrames:media.frames,audioRate:media.rate,beats:16,bassNotes:16,keysNotes:12}));}
