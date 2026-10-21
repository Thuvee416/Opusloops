const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
function line(prefix){const start=source.indexOf(prefix);assert.ok(start>=0,prefix);return source.slice(start,source.indexOf('\n',start));}
function fixture(){
 const calls=[],target={track:{id:'lead'},key:'volume',envelope:{enabled:true,points:[{beat:1,value:.4,curve:'linear'}]}},view={start:0,span:8,end:8},project={name:'Set'};
 const ctx={project,sessionProjectRevision:3,engine:{},busy:false,inputActive:()=>false,automationTarget:()=>target,currentViewport:()=>view,automationPoint:1,automationClickSuppressed:false,renderAutomation:()=>calls.push('automation'),renderTransport:()=>calls.push('controls')};
 const graph={hasPointerCapture:()=>true,releasePointerCapture(id){assert.equal(ctx.automationGesture,null);calls.push(['release',id]);}};ctx.$=()=>graph;
 const g={project,revision:3,trackId:'lead',key:'volume',envelope:JSON.stringify(target.envelope),viewSignature:JSON.stringify(view),initial:1,pointer:7};ctx.automationGesture=g;vm.createContext(ctx);
 vm.runInContext(line('function automationDragCurrent(g)')+'\n'+line('function releaseAutomationPointPointer(pointer)'),ctx);
 const start=source.indexOf('function cancelAutomationPointDrag(){');vm.runInContext(source.slice(start,source.indexOf("\n$('auto-graph').onpointerdown",start)),ctx);return {ctx,g,target,view,graph,calls};
}
test('automation cancellation clears capture ownership, restores selection, suppresses release-click and unlocks controls',()=>{
 const {ctx,calls}=fixture();assert.equal(ctx.cancelAutomationPointDrag(),true);assert.equal(ctx.automationGesture,null);assert.equal(ctx.automationPoint,1);assert.equal(ctx.automationClickSuppressed,true);assert.deepEqual(calls,[['release',7],'automation','controls']);assert.equal(ctx.cancelAutomationPointDrag(),false);
});
test('automation previews reject changed ownership, envelope, viewport and engine state without mutating the project',()=>{
 for(const change of [(f)=>f.ctx.project={name:'Other'},f=>f.ctx.sessionProjectRevision++,f=>f.target.track.id='other',f=>f.target.key='pan',f=>f.target.envelope.points[0].value=.7,f=>f.view.start=4,f=>f.ctx.engine.playing=true,f=>f.ctx.engine.recording={},f=>f.ctx.engine.automationTake={},f=>f.ctx.engine.startPromise={},f=>f.ctx.engine.preparing=true,f=>f.ctx.busy=true,f=>f.ctx.inputActive=()=>true]){
  const f=fixture();assert.equal(f.ctx.automationDragCurrent(f.g),true);change(f);const before=JSON.stringify(f.ctx.project);assert.equal(f.ctx.automationDragCurrent(f.g),false);f.ctx.cancelAutomationPointDrag();assert.equal(f.ctx.automationPoint,-1);assert.equal(JSON.stringify(f.ctx.project),before);
 }
});
test('native capture-release failure cannot retain an automation preview or control lock',()=>{
 const {ctx,graph,calls}=fixture();graph.releasePointerCapture=()=>{throw Error('Already Lost');};assert.equal(ctx.cancelAutomationPointDrag(),true);assert.equal(ctx.automationGesture,null);assert.deepEqual(calls,['automation','controls']);
});
test('automation Escape and platform Undo cancel the preview and competing keys cannot edit or start playback',()=>{
 const handlerLine=line("window.addEventListener('keydown',e=>{if(!automationGesture)return;");
 for(const args of [{key:'Escape'},{key:'z',code:'KeyZ',ctrlKey:true},{key:'z',code:'KeyZ',metaKey:true},{key:'z',code:'KeyZ',ctrlKey:true,shiftKey:true},{key:' ',code:'Space'},{key:'Delete'},{key:'Tab'},{key:'Control'}]){
  let handler,cancelled=0,prevented=0,stopped=0,focused=0;const ctx={automationGesture:{},cancelAutomationPointDrag(){cancelled++;ctx.automationGesture=null;},$:()=>({focus(){focused++;}}),window:{addEventListener(type,fn,capture){assert.equal(type,'keydown');assert.equal(capture,true);handler=fn;}}};vm.createContext(ctx);vm.runInContext(handlerLine,ctx);handler({...args,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});assert.equal(cancelled,['Escape','z'].includes(args.key)?1:0);assert.equal(focused,cancelled);assert.equal(prevented,args.key==='Control'?0:1);assert.equal(stopped,1);ctx.automationGesture=null;handler({...args,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});assert.equal(stopped,1);
 }
});
test('shared history and structural edits reject pending automation point previews',()=>{
 const ctx={history:{},engine:{},automationGesture:{},gesture:null,warpDrag:null,busy:false,inputActive:()=>false,sessionMarquee:null};vm.createContext(ctx);vm.runInContext(line('function historyLocked(action,steps=1)')+'\n'+line('function stopToEdit(){'),ctx);assert.equal(ctx.historyLocked('undo'),true);assert.throws(()=>ctx.stopToEdit(),/Automation Point Drag/);ctx.automationGesture=null;assert.ok(!ctx.historyLocked('undo'));ctx.stopToEdit();
});
