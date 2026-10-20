const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
function fixture(kind){
 const calls=[],selection=[0,2],active={initial:selection,initialIndex:2,pointer:7,rectangle:{remove(){calls.push('rectangle');}},el:{hasPointerCapture:id=>id===7,releasePointerCapture(id){calls.push(['release',id]);assert.equal(ctx.noteGesture,null);assert.equal(ctx.velocityGesture,null);}}};
 const ctx={noteGesture:kind==='note'?active:null,velocityGesture:kind==='velocity'?active:null,noteSelection:new Set([1]),noteIndex:1,noteClickSuppressed:false,renderEditor(){calls.push('render');},focusPiano(){calls.push('piano');},focusVelocity(index){calls.push(['velocity',index]);}};
 vm.createContext(ctx);const begin=source.indexOf('function cancelMidiGesture()');vm.runInContext(source.slice(begin,source.indexOf("\nfor(const type of ['pointercancel','lostpointercapture'])",begin)),ctx);
 return {ctx,calls,active};
}
for(const kind of ['note','velocity'])test(`${kind} drag cancellation restores selection and clears ownership before releasing capture`,()=>{
 const {ctx,calls}=fixture(kind);assert.equal(ctx.cancelMidiGesture(),true);assert.deepEqual([...ctx.noteSelection],[0,2]);assert.equal(ctx.noteIndex,2);assert.equal(ctx.noteClickSuppressed,true);
 assert.deepEqual(calls,['rectangle',['release',7],'render',kind==='note'?'piano':['velocity',2]]);
 assert.equal(ctx.cancelMidiGesture(),false);assert.equal(calls.length,4);
});
test('lost native capture cannot prevent preview cleanup or restore a stale gesture',()=>{
 const {ctx,active,calls}=fixture('note');active.el.releasePointerCapture=()=>{throw Error('Pointer Is Gone');};
 assert.equal(ctx.cancelMidiGesture(),true);assert.deepEqual(calls,['rectangle','render','piano']);assert.equal(ctx.noteGesture,null);
});
test('Escape and Undo cancel the preview; other editing shortcuts are consumed until release',()=>{
 const begin=source.indexOf("window.addEventListener('keydown',e=>{if(!noteGesture&&!velocityGesture)"),line=source.slice(begin,source.indexOf('\n',begin));
 for(const args of [{key:'Escape'},{key:'z',code:'KeyZ',ctrlKey:true},{key:'z',code:'KeyZ',metaKey:true},{key:'Delete'},{key:' ',code:'Space'}]){
  let handler,prevent=0,stop=0,cancel=0;const ctx={noteGesture:{},velocityGesture:null,cancelMidiGesture(){cancel++;},window:{addEventListener(type,fn,capture){assert.equal(type,'keydown');assert.equal(capture,true);handler=fn;}}};
  vm.createContext(ctx);vm.runInContext(line,ctx);handler({...args,preventDefault(){prevent++;},stopImmediatePropagation(){stop++;}});
  assert.equal(prevent,1);assert.equal(stop,1);assert.equal(cancel,['Escape','z'].includes(args.key)?1:0);
  ctx.noteGesture=null;handler({...args,preventDefault(){prevent++;},stopImmediatePropagation(){stop++;}});assert.equal(prevent,1);assert.equal(stop,1);
 }
});
