// Chord shifts retain slot order; strum offsets use the current project tempo.
export function chordNotes(note,d,bpm=120){
 const voices=[{...note},...d.shifts.flatMap((shift,i)=>{const pitch=note.pitch+shift,velocity=Math.min(1,note.velocity*d.velocities[i]);return shift!==0&&pitch>=0&&pitch<=127&&velocity>0?[{...note,pitch,velocity}]:[];})];
 if(!d.strumMs||voices.length<2)return voices;
 if(d.strumMs<0)voices.reverse();const span=Math.abs(d.strumMs)/1000*bpm/60*(voices.length-1),power=2**(-(d.tension??0)/50);
 return voices.flatMap((n,i)=>{const progress=i/(voices.length-1),delay=span*progress**power,velocity=Math.min(1,Math.max(0,n.velocity*(1+(d.crescendo??0)/100*progress)));if(velocity<=0||Number.isFinite(n.duration)&&n.duration<=delay)return [];return [{...n,start:(n.start??0)+delay,velocity,...(Number.isFinite(n.duration)?{duration:n.duration-delay}:{})}];});
}
