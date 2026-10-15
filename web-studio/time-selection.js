import {viewportBeat,visibleInterval,timelineViewport} from './viewport.js';
export function timeSelectionRange(anchor,focus){
 if(!Number.isFinite(anchor)||!Number.isFinite(focus))throw new Error('Choose a finite time position.');
 const snap=x=>Math.max(0,Math.min(16384,Math.round(x*4)/4));anchor=snap(anchor);focus=snap(focus);
 const start=Math.min(16383.75,Math.min(anchor,focus)),end=Math.max(start+.25,Math.max(anchor,focus));return {start,length:end-start};
}
export function timeSelectionEdge(x,y,lane,viewport){
 const left=Math.max(lane.left,viewport.left),right=Math.min(lane.right,viewport.right),margin=Math.min(24,(right-left)/4);
 if(right<=left||y<viewport.top-24||y>viewport.bottom+24)return 0;
 return x<=left+margin?-1:x>=right-margin?1:0;
}
export function scrollTimeSelection(view,direction,seconds,remainder=0){
 if(![-1,0,1].includes(direction)||!Number.isFinite(seconds)||seconds<0||!Number.isFinite(remainder))throw new Error('Invalid time-selection scroll.');
 const amount=remainder+direction*Math.max(2,view.span/2)*seconds,steps=Math.trunc(amount*4)/4,next=timelineViewport(view.start+steps,view.span);
 const atEdge=direction<0&&next.start===0||direction>0&&next.end===16384;
 return {view:next,remainder:atEdge?0:amount-steps};
}
export function installTimeSelection({timeline,startInput,lengthInput,modeButton,readout,getView,isLocked,onStart,onCommit,onPan,onChange}){
 let active=false,drag=null,suppressClick=false,frame=0,ends=null;
 const getRange=()=>{const start=Number(startInput.value)-1,length=Number(lengthInput.value);return Number.isFinite(start)&&Number.isFinite(length)&&start>=0&&length>=.25&&start+length<=16384&&start*4%1===0&&length*4%1===0?{start,length}:null;};
 function render(){onChange?.();timeline.querySelectorAll('.time-selection-range').forEach(el=>el.remove());const range=active&&getRange();readout.textContent=range?`Beats ${range.start+1}–${range.start+range.length+1} · all tracks · Shift+←/→ extends`:'Drag empty space or Shift-drag to select time';if(!range)return;const box=visibleInterval(range.start,range.length,getView());if(!box)return;for(const lane of timeline.querySelectorAll('.timeline-lane')){const el=document.createElement('div');el.className='time-selection-range';el.style.left=box.left+'%';el.style.width=box.width+'%';el.setAttribute('aria-hidden','true');lane.append(el);}}
 function set(range){startInput.value=range.start+1;lengthInput.value=range.length;active=true;render();}
 function release(pointer){if(timeline.hasPointerCapture(pointer))timeline.releasePointerCapture(pointer);}
 function stopScroll(){cancelAnimationFrame(frame);frame=0;}
 function cancel(){if(!drag)return;const old=drag;drag=null;stopScroll();startInput.value=old.start;lengthInput.value=old.length;active=old.active;ends=old.ends;onPan?.(old.view);release(old.pointer);render();}
 function laneForDrag(){return drag?.trackId===undefined?timeline.querySelector('.timeline-ruler .timeline-lane'):[...timeline.querySelectorAll('[data-lane-track]')].find(lane=>lane.dataset.laneTrack===drag.trackId);}
 function update(event){if(!drag)return;drag.x=event.clientX;drag.y=event.clientY;const lane=laneForDrag();if(!lane){cancel();return;}const rect=lane.getBoundingClientRect(),focus=viewportBeat((drag.x-rect.left)/rect.width,getView());ends={anchor:drag.anchor,focus};set(timeSelectionRange(drag.anchor,focus));}
 function scroll(now){frame=0;if(!drag)return;if(isLocked()){cancel();return;}const lane=laneForDrag();if(!lane){cancel();return;}const edge=timeSelectionEdge(drag.x,drag.y,lane.getBoundingClientRect(),timeline.getBoundingClientRect()),seconds=Math.min(.05,Math.max(0,(now-drag.lastFrame)/1000));drag.lastFrame=now;
  if(edge!==drag.edge){drag.edge=edge;drag.edgeSince=now;drag.remainder=0;}
  if(edge&&now-drag.edgeSince>=250&&onPan){const current=getView(),next=scrollTimeSelection(current,edge,seconds,drag.remainder);drag.remainder=next.remainder;if(next.view.start!==current.start){onPan(next.view);update({clientX:drag.x,clientY:drag.y});}}
  if(drag)frame=requestAnimationFrame(scroll);
 }
 timeline.addEventListener('pointerdown',event=>{
  suppressClick=false;if(event.button!==0||isLocked())return;const lane=event.target.closest('.timeline-lane');if(!lane||lane.closest('.locator-row'))return;const mode=modeButton.getAttribute('aria-pressed')==='true';if(event.pointerType==='touch'&&!mode)return;
  if(!mode&&!event.shiftKey&&(event.target.closest('[data-region]')||lane.closest('.timeline-ruler')))return;
  event.preventDefault();event.stopImmediatePropagation();timeline.focus({preventScroll:true});onStart?.();const rect=lane.getBoundingClientRect(),view=getView();drag={pointer:event.pointerId,trackId:lane.dataset.laneTrack,view,lastFrame:performance.now(),edge:0,edgeSince:0,remainder:0,anchor:viewportBeat((event.clientX-rect.left)/rect.width,view),start:startInput.value,length:lengthInput.value,active,ends};timeline.setPointerCapture(event.pointerId);update(event);frame=requestAnimationFrame(scroll);
 },true);
 timeline.addEventListener('pointermove',event=>{if(drag?.pointer!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();if(isLocked()){cancel();return;}update(event);},true);
 timeline.addEventListener('pointerup',event=>{if(drag?.pointer!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();if(isLocked()){cancel();return;}update(event);const pointer=drag.pointer;drag=null;stopScroll();release(pointer);suppressClick=true;onCommit?.(getRange());},true);
 timeline.addEventListener('click',event=>{if(suppressClick&&event.detail){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);
 timeline.addEventListener('pointercancel',event=>{if(drag?.pointer===event.pointerId){event.stopImmediatePropagation();cancel();}},true);
 timeline.addEventListener('lostpointercapture',event=>{if(drag?.pointer===event.pointerId)cancel();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){event.preventDefault();event.stopImmediatePropagation();cancel();}},true);
 window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);
 timeline.addEventListener('keydown',event=>{
  if(event.target!==timeline||!event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||!['ArrowLeft','ArrowRight'].includes(event.key)||drag||isLocked())return;
  const range=getRange();if(!active||!range)return;event.preventDefault();event.stopPropagation();onStart?.();
  if(!ends||JSON.stringify(timeSelectionRange(ends.anchor,ends.focus))!==JSON.stringify(range))ends={anchor:range.start,focus:range.start+range.length};
  ends={...ends,focus:Math.max(0,Math.min(16384,ends.focus+(event.key==='ArrowRight'?.25:-.25)))};set(timeSelectionRange(ends.anchor,ends.focus));
  const view=getView();if(ends.focus<view.start)onPan?.(timelineViewport(ends.focus,view.span));else if(ends.focus>view.end)onPan?.(timelineViewport(ends.focus-view.span,view.span));onCommit?.(getRange());
 });
 for(const input of [startInput,lengthInput])input.addEventListener('input',()=>{onStart?.();active=true;ends=null;render();});
 modeButton.onclick=()=>{const on=modeButton.getAttribute('aria-pressed')!=='true';modeButton.setAttribute('aria-pressed',String(on));timeline.classList.toggle('time-select-mode',on);};
 return {render,cancel,select(start,length){if(drag||isLocked()||!Number.isFinite(start)||!Number.isFinite(length)||length<.25)return false;const range=timeSelectionRange(start,start+length);if(range.start!==start||range.length!==length)return false;onStart?.();ends={anchor:start,focus:start+length};set(range);onCommit?.(range);timeline.focus({preventScroll:true});return true;},get range(){return active?getRange():null;},clear(){active=false;ends=null;render();},get dragging(){return !!drag;},reset(){cancel();active=false;ends=null;modeButton.setAttribute('aria-pressed','false');timeline.classList.remove('time-select-mode');startInput.value=1;lengthInput.value=4;render();}};
}
