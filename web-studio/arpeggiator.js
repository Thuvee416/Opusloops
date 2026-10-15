export const ARP_STYLES={up:'Up',down:'Down',updown:'Up & Down',downup:'Down & Up',converge:'Converge',diverge:'Diverge',order:'Play Order',chord:'Chord Trigger',random:'Random','random-other':'Random Other','random-once':'Random Once'};
export function newArpeggiator(id=crypto.randomUUID()){return {id,type:'arpeggiator',enabled:true,style:'up',mode:'sync',beats:.25,milliseconds:125,gate:50,steps:0,distance:12,offset:0,retrigger:'phrase',seed:1,hold:false,interval:4,repeats:0,velocityEnabled:false,velocityDecayMs:1000,velocityTarget:0,velocityRetrigger:true};}
export function validateArpeggiator(d){if((d.velocityEnabled!==undefined&&typeof d.velocityEnabled!=='boolean')||(d.velocityRetrigger!==undefined&&typeof d.velocityRetrigger!=='boolean')||(d.velocityDecayMs!==undefined&&(!Number.isFinite(d.velocityDecayMs)||d.velocityDecayMs<0||d.velocityDecayMs>60000))||(d.velocityTarget!==undefined&&(!Number.isInteger(d.velocityTarget)||d.velocityTarget<0||d.velocityTarget>127))||(d.interval!==undefined&&(!Number.isFinite(d.interval)||d.interval<1/64||d.interval>64))||(d.repeats!==undefined&&(!Number.isInteger(d.repeats)||d.repeats<0||d.repeats>64))||(d.hold!==undefined&&typeof d.hold!=='boolean')||(d.seed!==undefined&&(!Number.isInteger(d.seed)||d.seed<1||d.seed>4294967295))||!Object.hasOwn(ARP_STYLES,d.style)||!['sync','time'].includes(d.mode)||!['phrase','note','beat'].includes(d.retrigger)||!Number.isFinite(d.beats)||d.beats<1/64||d.beats>4||!Number.isFinite(d.milliseconds)||d.milliseconds<10||d.milliseconds>2000||!Number.isFinite(d.gate)||d.gate<0||d.gate>200||!Number.isInteger(d.steps)||d.steps<0||d.steps>3||!Number.isInteger(d.distance)||Math.abs(d.distance)>24||!Number.isInteger(d.offset)||d.offset<0||d.offset>127)throw new Error('Invalid MIDI Arpeggiator device.');}
export function arpVelocity(velocity,d,seconds){if(!d.velocityEnabled)return velocity;const decay=(d.velocityDecayMs??1000)/1000,target=(d.velocityTarget??0)/127,progress=decay===0?1:Math.min(1,Math.max(0,seconds)/decay);return progress===1?target:velocity+(target-velocity)*progress;}
export function arpRate(d,bpm){return d.mode==='sync'?d.beats:d.milliseconds/1000*bpm/60;}
export function arpPattern(held,d){
 const unique=new Map();for(const n of held.values())if(!unique.has(n.pitch))unique.set(n.pitch,n);
 const base=[...unique.values()];if(d.style!=='order')base.sort((a,b)=>a.pitch-b.pitch);
 let order=[...base];if(['down','downup'].includes(d.style))order.reverse();
 if(['updown','downup'].includes(d.style)&&order.length>2)order.push(...order.slice(1,-1).reverse());
 if(d.style==='converge'){order=[];for(let a=0,b=base.length-1;a<=b;a++,b--){order.push(base[a]);if(a!==b)order.push(base[b]);}}
 if(d.style==='diverge'){order=[];let left=Math.floor((base.length-1)/2),right=left+1;while(left>=0||right<base.length){if(left>=0)order.push(base[left--]);if(right<base.length)order.push(base[right++]);}}
 const groups=[];for(let step=0;step<=d.steps;step++){const shifted=order.map(n=>({...n,pitch:n.pitch+step*d.distance,transposeStep:step})).filter(n=>n.pitch>=0&&n.pitch<=127);if(d.style==='chord'){if(shifted.length)groups.push(shifted);}else for(const n of shifted)groups.push([n]);}return groups;
}
// Absolute beat clock, shared by offline rendering and speculative live scheduling.
export class ArpSequencer {
 constructor(device,bpm=120){validateArpeggiator(device);if(!Number.isFinite(bpm)||bpm<=0)throw new Error('Invalid arpeggiator tempo.');this.device=structuredClone(device);this.bpm=bpm;this.held=new Map();this.down=new Set();this.queue=[];this.next=null;this.nextRestart=null;this.cycles=0;this.cycleSteps=0;this.step=0;this.velocityStart=0;this.time=0;this.pattern=null;this.randomState=(device.seed??1)>>>0;this.randomPools=null;this.bags=new Map();this.once=new Map();this.last=new Map();}
 enqueue(events){for(const event of events)if(!Number.isFinite(event.at)||event.at<this.time-1e-8||!['on','off'].includes(event.type))throw new Error('Invalid arpeggiator input time.');if(this.queue.length+events.length>131072)throw new Error('Arpeggiator input exceeds the event limit.');for(const event of events)this.queue.push(event);this.queue.sort((a,b)=>a.at-b.at||Number(a.type==='on')-Number(b.type==='on'));}
 clone(){const copy=new ArpSequencer(this.device,this.bpm);copy.held=new Map(this.held);copy.down=new Set(this.down);copy.queue=[...this.queue];copy.next=this.next;copy.nextRestart=this.nextRestart;copy.cycles=this.cycles;copy.cycleSteps=this.cycleSteps;copy.step=this.step;copy.velocityStart=this.velocityStart;copy.time=this.time;copy.pattern=this.pattern;copy.randomState=this.randomState;copy.randomPools=this.randomPools;copy.bags=new Map([...this.bags].map(([k,v])=>[k,[...v]]));copy.once=new Map([...this.once].map(([k,v])=>[k,[...v]]));copy.last=new Map(this.last);return copy;}
 random(){let x=this.randomState;x^=x<<13;x^=x>>>17;x^=x<<5;this.randomState=x>>>0;return this.randomState/4294967296;}
 shuffle(values){const result=[...values];for(let i=result.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
 choose(pattern){
  if(!pattern.length)return [];const index=(this.step+this.device.offset)%pattern.length,style=this.device.style;if(!style.startsWith('random'))return pattern[index];
  if(!this.randomPools){this.randomPools=new Map();pattern.forEach((group,i)=>{const segment=group[0].transposeStep,pool=this.randomPools.get(segment)||[];pool.push(i);this.randomPools.set(segment,pool);});if(style==='random-once'){const base=i=>pattern[i][0].pitch-pattern[i][0].transposeStep*this.device.distance,rank=new Map(this.shuffle([...new Set(pattern.map((_,i)=>base(i)))]).map((pitch,i)=>[pitch,i]));for(const [segment,pool]of this.randomPools)this.once.set(segment,[...pool].sort((a,b)=>rank.get(base(a))-rank.get(base(b))));}}
  const segment=pattern[index][0].transposeStep,pool=this.randomPools.get(segment);let selected;
  if(style==='random')selected=pool[Math.floor(this.random()*pool.length)];
  else if(style==='random-once')selected=this.once.get(segment)[(index-pool[0])%pool.length];
  else{let bag=this.bags.get(segment);if(!bag?.length){bag=this.shuffle(pool);if(bag.length>1&&bag[0]===this.last.get(segment))[bag[0],bag[1]]=[bag[1],bag[0]];this.bags.set(segment,bag);}selected=bag.shift();this.last.set(segment,selected);}
  return pattern[selected];
 }
 advance(until,emit=()=>{}){
  if(!Number.isFinite(until)||until<this.time-1e-8)throw new Error('Arpeggiator clock must move forward.');let cursor=0,outputs=0,iterations=0;const rate=arpRate(this.device,this.bpm);
  while(true){const eventTime=this.queue[cursor]?.at??Infinity,pulseTime=this.next??Infinity,restartTime=this.nextRestart??Infinity,at=Math.min(eventTime,pulseTime,restartTime);if(at>=until-1e-9)break;if(++iterations>262144)throw new Error('Arpeggiator scheduling limit exceeded.');
   if(eventTime<=Math.min(pulseTime,restartTime)+1e-9){
    const group=[];while(this.queue[cursor]&&Math.abs(this.queue[cursor].at-eventTime)<1e-9)group.push(this.queue[cursor++]);
    const ons=group.filter(e=>e.type==='on');let changed=false;
    for(const e of group)if(e.type==='off'){this.down.delete(e.id);if(!this.device.hold)changed=this.held.delete(e.id)||changed;}
    // A new gesture replaces a latched phrase; overlapping keys edit its pitch pool.
    if(this.device.hold&&ons.length&&!this.down.size){this.held.clear();changed=true;}
    const empty=this.held.size===0,seen=new Set();
    for(const e of ons){this.down.add(e.id);if(this.device.hold){if(seen.has(e.note.pitch))continue;seen.add(e.note.pitch);if(this.held.has(e.note.pitch))this.held.delete(e.note.pitch);else this.held.set(e.note.pitch,e.note);}else this.held.set(e.id,e.note);changed=true;}
    if(changed){this.pattern=null;this.randomPools=null;this.bags.clear();this.once.clear();this.last.clear();}
    if(!this.held.size){this.next=null;this.nextRestart=null;this.step=0;this.cycles=0;this.cycleSteps=0;}else if(ons.length&&(empty||this.device.retrigger==='note')){if(empty||this.device.velocityRetrigger!==false)this.velocityStart=eventTime;this.next=eventTime;this.step=0;this.cycles=0;this.cycleSteps=0;if(this.device.retrigger==='beat'){const interval=this.device.interval??4;this.nextRestart=(Math.floor((eventTime+1e-9)/interval)+1)*interval;}}
    continue;
   }
   if(restartTime<=pulseTime+1e-9){if(this.device.velocityRetrigger!==false)this.velocityStart=restartTime;this.step=0;this.cycles=0;this.cycleSteps=0;this.next=restartTime;this.nextRestart=restartTime+(this.device.interval??4);continue;}
   const pattern=this.pattern??=arpPattern(this.held,this.device),group=this.choose(pattern);
   if(this.device.gate>0)for(const n of group){const velocity=arpVelocity(n.velocity,this.device,(at-this.velocityStart)*60/this.bpm);if(velocity<=0)continue;if(++outputs>65536)throw new Error('Arpeggiator output exceeds 65,536 notes.');emit({pitch:n.pitch,velocity,start:at,duration:rate*this.device.gate/100});}
   this.step++;this.cycleSteps++;if(this.cycleSteps>=pattern.length){this.cycles++;this.cycleSteps=0;}this.next=this.device.repeats&&this.cycles>=this.device.repeats?null:at+rate;
  }
  this.queue.splice(0,cursor);this.time=until;
 }
}
export function arpeggiateNotes(notes,beats,device,bpm=120){
 const seq=new ArpSequencer(device,bpm),events=[];for(let i=0;i<notes.length;i++){const n=notes[i];if(n.active===false||n.velocity<=0||n.start>=beats||n.duration<=0)continue;events.push({type:'on',id:i,at:Math.max(0,n.start),note:n},{type:'off',id:i,at:Math.min(beats,n.start+n.duration)});}seq.enqueue(events);const result=[];seq.advance(beats,n=>result.push({...n,duration:Math.min(n.duration,beats-n.start)}));return result;
}
