export const VIEW_SPANS=[1,2,4,8,16,32,64,128,256,512,1024,2048,4096,8192,16384];
export function timelineViewport(start=0,span=64){span=VIEW_SPANS.includes(span)?span:64;start=Number.isFinite(start)?Math.round(start*4)/4:0;start=Math.max(0,Math.min(16384-span,start));return {start,span,end:start+span};}
export function visibleInterval(start,length,view){const from=Math.max(start,view.start),to=Math.min(start+length,view.end);return to>from?{left:(from-view.start)/view.span*100,width:(to-from)/view.span*100,from,to}:null;}
export function viewportBeat(fraction,view){return Math.max(view.start,Math.min(view.end,Math.round((view.start+fraction*view.span)*4)/4));}
export function zoomViewport(view,direction,anchor=.5){anchor=Number.isFinite(anchor)?Math.max(0,Math.min(1,anchor)):.5;const index=VIEW_SPANS.indexOf(view.span),span=VIEW_SPANS[Math.max(0,Math.min(VIEW_SPANS.length-1,index+direction))];return timelineViewport(view.start+(view.span-span)*anchor,span);}
export function rulerTicks(view){const step=view.span<=2?.25:view.span<=16?1:Math.max(4,view.span/32),ticks=[];for(let beat=Math.ceil(view.start/step)*step;beat<view.end;beat+=step)ticks.push({beat,label:beat%4===0?String(beat/4+1):`${Math.floor(beat/4)+1}:${Number((beat%4+1).toFixed(2))}`,aria:beat%4===0?`Seek to bar ${beat/4+1}`:`Seek to beat ${beat+1}`});return {step,ticks};}
export const fitSpan=end=>VIEW_SPANS.find(span=>span>=end)||16384;
// Page-based follow keeps the current window stable until the playhead leaves it.
export function followViewport(view,beat){
 if(!Number.isFinite(beat)||beat<0)return null;
 if(beat>=view.start&&beat<view.end)return null;
 const next=timelineViewport(Math.floor(beat/view.span)*view.span,view.span);
 return next.start===view.start?null:next;
}

export function panViewport(view,beats,remainder=0){
 if(!Number.isFinite(beats)||!Number.isFinite(remainder))throw new Error('Choose a finite pan distance.');
 const amount=beats+remainder,steps=Math.trunc(amount*4)/4,next=timelineViewport(view.start+steps,view.span);
 return {view:next,remainder:(amount<0&&next.start===0||amount>0&&next.end===16384)?0:amount-steps};
}
