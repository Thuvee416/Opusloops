export class TapTempo{
 constructor(){this.reset();}
 reset(){this.taps=[];}
 tap(now){
  if(!Number.isFinite(now)||now<0)throw Error('Use a monotonic tap time.');
  const previous=this.taps.at(-1),gap=previous===undefined?null:now-previous;
  if(gap!==null&&gap>=0&&gap<200)return {count:this.taps.length,bpm:null,ignored:true};
  if(gap===null||gap<250||gap>1500){this.taps=[now];return {count:1,bpm:null,restarted:true};}
  this.taps.push(now);if(this.taps.length>9)this.taps.shift();
  const intervals=this.taps.slice(1).map((time,i)=>time-this.taps[i]).sort((a,b)=>a-b),middle=Math.floor(intervals.length/2),median=intervals.length%2?intervals[middle]:(intervals[middle-1]+intervals[middle])/2;
  const stable=intervals.filter(interval=>Math.abs(interval-median)<=median*.2),usable=stable.length?stable:intervals,average=usable.reduce((a,b)=>a+b,0)/usable.length;
  return {count:this.taps.length,bpm:Math.round(600000/average)/10,restarted:false};
 }
}
