const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
function fixture(){
 const handlers={},calls=[],clip={id:'tone',warp:{mode:'stretch',semitones:0,markers:[{source:.5,target:.5}]}},handle={hasPointerCapture:()=>true,releasePointerCapture(pointer){assert.equal(ctx.warpDrag,null);calls.push(['release',pointer]);handlers.lostpointercapture?.({pointerId:pointer});},focus(){calls.push('focus');}};
 const ctx={warpDrag:null,project:{clips:{tone:clip}},selection:{clipId:'tone'},structuredClone,renderEditor(){calls.push('editor');},renderTransport(){calls.push('transport');},run:fn=>fn,$:()=>({addEventListener(){}}),window:{addEventListener(type,fn){handlers[type]=fn;}},document:{querySelector:()=>handle},async applyMarkers(c,markers){calls.push(['apply',markers[0].target]);c.warp.markers=markers;}};
 vm.createContext(ctx);const begin=source.indexOf('function releaseWarpCapture(d)'),end=source.indexOf("$('clip-editor').addEventListener('keydown',run(async e=>{const handle=e.target.closest('[data-warp-handle]')",begin);vm.runInContext(source.slice(begin,end),ctx);
 const drag={clip,index:0,signature:JSON.stringify(clip),handle,pointer:7,target:.7};ctx.warpDrag=drag;return {ctx,handlers,calls,drag,clip};
}
test('Warp cancellation clears ownership before capture release and leaves source/history untouched',()=>{
 const {ctx,calls,clip}=fixture(),before=JSON.stringify(clip);assert.equal(ctx.cancelWarpDrag(true),true);assert.deepEqual(calls,[['release',7],'editor','transport','focus']);assert.equal(JSON.stringify(clip),before);assert.equal(ctx.cancelWarpDrag(),false);assert.equal(calls.length,4);
});
test('Warp cancellation survives missing native capture and ignores unrelated pointers',()=>{
 const {ctx,handlers,drag,calls}=fixture();handlers.pointercancel({pointerId:8});assert.equal(ctx.warpDrag,drag);drag.handle.releasePointerCapture=()=>{throw Error('Capture Already Gone');};handlers.lostpointercapture({pointerId:7});assert.equal(ctx.warpDrag,null);assert.deepEqual(calls,['editor','transport']);
});
test('Warp preview consumes competing keys and cancels both platform Undo shortcuts',()=>{
 for(const key of [{key:'Escape'},{key:'z',code:'KeyZ',ctrlKey:true},{key:'z',code:'KeyZ',metaKey:true},{key:'z',code:'KeyZ',ctrlKey:true,shiftKey:true},{key:'Delete'},{key:' ',code:'Space'},{key:'ArrowRight'},{key:'Tab'}]){
  const {ctx,handlers,clip}=fixture();let prevented=0,stopped=0;handlers.keydown({...key,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(ctx.warpDrag===null,['Escape','z'].includes(key.key));assert.equal(clip.warp.markers[0].target,.5);
 }
});
test('Warp release commits once, ignores stale targets and unlocks after failed preparation',async()=>{
 for(const kind of ['success','same','stale-source','stale-selection','changed-source','failure']){
  const {ctx,handlers,drag,calls,clip}=fixture();if(kind==='same')drag.target=.5;if(kind==='stale-source')ctx.project.clips.tone=structuredClone(clip);if(kind==='stale-selection')ctx.selection.clipId='other';if(kind==='changed-source')clip.name='Changed';if(kind==='failure')ctx.applyMarkers=async()=>{throw Error('Preparation Failed');};
  const request=handlers.pointerup({pointerId:7});if(kind==='failure')await assert.rejects(request,/Preparation Failed/);else await request;assert.equal(ctx.warpDrag,null);assert.equal(calls.at(-1),'transport');assert.equal(calls.filter(c=>Array.isArray(c)&&c[0]==='apply').length,kind==='success'?1:0);assert.equal(clip.warp.markers[0].target,kind==='success'?.7:.5);
  await handlers.pointerup({pointerId:7});assert.equal(calls.filter(c=>Array.isArray(c)&&c[0]==='apply').length,kind==='success'?1:0);
 }
});
test('Warp preview locks navigation, direct editing and non-keyboard history',()=>{
 const ctx={warpDrag:{},sessionMarquee:null,busy:false,inputActive:()=>false,gesture:null,fadeGesture:null,noteGesture:null,velocityGesture:null,automationGesture:null,timeSelection:null,clipMarquee:null,engine:{},history:{}};vm.createContext(ctx);
 for(const prefix of ['function navigationLocked()','function stopToEdit()','function historyLocked(action,steps=1)']){const start=source.indexOf(prefix);vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);}
 assert.equal(ctx.navigationLocked(),true);assert.equal(ctx.historyLocked('undo'),true);assert.throws(()=>ctx.stopToEdit(),/Warp Marker Drag/);ctx.warpDrag=null;assert.equal(ctx.navigationLocked(),false);ctx.stopToEdit();assert.ok(!ctx.historyLocked('undo'));
});
