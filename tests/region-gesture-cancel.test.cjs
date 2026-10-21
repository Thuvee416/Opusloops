const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
function fixture(){
 const calls=[],controls={'timeline-start':{value:21},'timeline-bars':{value:'16'},timeline:{hasPointerCapture:()=>true,releasePointerCapture(id){assert.equal(ctx.gesture,null);calls.push(['release',id]);}}},active={pointer:7,view:{start:4,span:8}};
 const ctx={gesture:active,regionFrame:15,$:id=>controls[id],cancelAnimationFrame:id=>calls.push(['frame',id]),renderTimeline:()=>calls.push('timeline'),renderAutomation:()=>calls.push('automation'),renderTransport:()=>calls.push('transport')};vm.createContext(ctx);
 for(const prefix of ['function stopRegionScroll()','function releaseRegionPointer(id)','function cancelRegionDrag()']){const start=source.indexOf(prefix);vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);}
 return {ctx,calls,controls,active};
}
test('Arrangement cancellation clears ownership and autoscroll before restoring the viewport and controls',()=>{
 const {ctx,calls,controls}=fixture();assert.equal(ctx.cancelRegionDrag(),true);assert.equal(ctx.gesture,null);assert.equal(ctx.regionFrame,0);assert.deepEqual(calls,[['frame',15],['release',7],'timeline','automation','transport']);assert.equal(controls['timeline-start'].value,5);assert.equal(controls['timeline-bars'].value,'2');assert.equal(ctx.cancelRegionDrag(),false);assert.equal(calls.length,5);
});
test('lost native pointer capture cannot leave the Arrangement preview or history lock stuck',()=>{
 const {ctx,calls,controls}=fixture();controls.timeline.releasePointerCapture=()=>{throw Error('Capture Gone');};assert.equal(ctx.cancelRegionDrag(),true);assert.deepEqual(calls,[['frame',15],'timeline','automation','transport']);assert.equal(ctx.gesture,null);
});
test('Escape and platform Undo shortcuts cancel Arrangement previews while other edit/transport shortcuts wait',()=>{
 const start=source.indexOf("window.addEventListener('keydown',e=>{if(!gesture)return;"),line=source.slice(start,source.indexOf('\n',start));assert.ok(start>=0);
 for(const args of [{key:'Escape'},{key:'z',code:'KeyZ',ctrlKey:true},{key:'z',code:'KeyZ',metaKey:true},{key:'z',code:'KeyZ',ctrlKey:true,shiftKey:true},{key:' ',code:'Space'},{key:'Delete'},{key:'ArrowRight'},{key:'Tab'},{key:'a',code:'KeyA',ctrlKey:true},{key:'d',code:'KeyD',ctrlKey:true},{key:'Control',code:'ControlLeft',ctrlKey:true}]){
  let handler,prevented=0,stopped=0,cancelled=0,focused=0;const ctx={gesture:{},cancelRegionDrag(){cancelled++;ctx.gesture=null;},focusRegion(){focused++;},window:{addEventListener(type,fn,capture){assert.equal(type,'keydown');assert.equal(capture,true);handler=fn;}}};vm.createContext(ctx);vm.runInContext(line,ctx);handler({...args,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});
  assert.equal(cancelled,['Escape','z'].includes(args.key)?1:0);assert.equal(focused,cancelled);assert.equal(prevented,args.key==='Control'?0:1);assert.equal(stopped,1);ctx.gesture=null;handler({...args,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});assert.equal(stopped,1);
 }
});
test('direct history commands are locked until the Arrangement drag ends',()=>{
 const start=source.indexOf('function historyLocked(action,steps=1)'),line=source.slice(start,source.indexOf('\n',start)),ctx={history:{},engine:{playing:false},warpDrag:null,gesture:{},busy:false,inputActive:()=>false};vm.createContext(ctx);vm.runInContext(line,ctx);assert.equal(ctx.historyLocked('undo'),true);assert.equal(ctx.historyLocked('redo'),true);ctx.gesture=null;assert.ok(!ctx.historyLocked('undo'));
});
