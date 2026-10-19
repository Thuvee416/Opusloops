// Monitoring only: these events never enter an offline export graph.
export function metronomeLevel(transport){return transport.metronomeVolume??.5;}
export function metronomeAudible(transport,{recording=false,countingIn=false}={}){
 return !!transport.metronome&&!countingIn&&(!transport.metronomeRecordOnly||recording)&&metronomeLevel(transport)>0;
}
export function validateMetronome(transport){
 if(transport.metronomeRecordOnly!==undefined&&typeof transport.metronomeRecordOnly!=='boolean')throw Error('Invalid recording-only metronome setting.');
 if(transport.metronomeVolume!==undefined&&(!Number.isFinite(transport.metronomeVolume)||transport.metronomeVolume<0||transport.metronomeVolume>1))throw Error('Metronome level must be between 0 and 1.');
}
// Audio-clock lookahead. A delayed callback skips missed beats rather than bursting.
export class InputClickClock{
 constructor({start,bpm,clicks=[]}){
  if(!Number.isFinite(start)||start<0||!Number.isFinite(bpm)||bpm<40||bpm>240||clicks.some(c=>!Number.isFinite(c.time)||c.time>=start))throw Error('Invalid recording click clock.');
  this.start=start;this.spb=60/bpm;this.clicks=clicks;this.countIndex=0;this.next=0;this.stopped=false;
 }
 events(now,{playing=false,enabled=false}={}){
  if(this.stopped)return [];const horizon=now+.12,out=[];
  while(this.countIndex<this.clicks.length&&this.clicks[this.countIndex].time<horizon){const click=this.clicks[this.countIndex++];if(click.time>=now-1e-7)out.push(click);}
  this.next=Math.max(this.next,Math.ceil((now-this.start)/this.spb-1e-7),0);
  while(this.start+this.next*this.spb<horizon){const beat=this.next++,time=this.start+beat*this.spb;if(!playing&&enabled&&time>=now-1e-7)out.push({time,accent:beat%4===0});}
  return out;
 }
 stop(){this.stopped=true;}
}
