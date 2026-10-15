export const defaultAudioEdit=()=>({reverse:false,gainDb:0,fadeIn:0,fadeOut:0});
export function validateAudioEdit(edit,beats){if(edit===undefined)return;if(!edit||typeof edit!=='object'||Array.isArray(edit)||typeof edit.reverse!=='boolean'||!Number.isFinite(edit.gainDb)||edit.gainDb<-60||edit.gainDb>24)throw new Error('Audio gain must be −60 to +24 dB, with a valid reverse setting.');for(const key of ['fadeIn','fadeOut'])if(!Number.isFinite(edit[key])||edit[key]<0||edit[key]>beats)throw new Error('Audio fades must be between zero and the clip loop length.');}
export const audioEditKey=clip=>JSON.stringify([clip.beats,clip.audioEdit??defaultAudioEdit()]);
export function editAudio(clip,patch){if(clip.kind!=='audio')throw new Error('Choose an audio clip.');const next={...defaultAudioEdit(),...clip.audioEdit,...patch};validateAudioEdit(next,clip.beats);return next;}
export function editedAudioBuffer(ctx,raw,clip){
 const edit=clip.audioEdit??defaultAudioEdit();validateAudioEdit(edit,clip.beats);
 if(!edit.reverse&&edit.gainDb===0&&edit.fadeIn===0&&edit.fadeOut===0)return raw;
 const buffer=ctx.createBuffer(raw.numberOfChannels,raw.length,raw.sampleRate),gain=10**(edit.gainDb/20);
 // Apply fades to output time after reversal. Beat fractions preserve fades
 // through repitch tempo changes and keep channels sample-aligned.
 for(let c=0;c<raw.numberOfChannels;c++){const source=raw.getChannelData(c),out=buffer.getChannelData(c);for(let i=0;i<raw.length;i++){const beat=raw.length>1?i/(raw.length-1)*clip.beats:0,fadeIn=edit.fadeIn?Math.min(1,beat/edit.fadeIn):1,fadeOut=edit.fadeOut?Math.min(1,(clip.beats-beat)/edit.fadeOut):1;out[i]=source[edit.reverse?raw.length-1-i:i]*gain*fadeIn*fadeOut;}}
 return buffer;
}
