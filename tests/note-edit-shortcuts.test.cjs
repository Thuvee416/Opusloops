const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function fixture(){
 const [{editNoteGroup},{History}]=await Promise.all([import('../web-studio/notes.js'),import('../web-studio/history.js')]);
 const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
 const begin=source.indexOf("$('clip-editor').addEventListener('keydown',run(e=>{if(!e.target.closest('.piano-scroll')"),end=source.indexOf("\n\n$('import-midi')",begin);assert.ok(begin>=0&&end>begin);
 const clip={kind:'midi',beats:8,notes:[{pitch:60,start:1,duration:1,velocity:.5,releaseVelocity:.2},{pitch:64,start:3,duration:.75,velocity:.6,active:false},{pitch:67,start:5,duration:.5,velocity:.7}]},project={clips:{clip}},history=new History(project),clipboardActions=[];let handler;
 const ctx={noteTimeSelection:null,noteSelection:new Set([0,1]),noteClipboard:null,engine:{},navigationLocked:()=>false,focusPiano(){},noteClipboardAction:action=>clipboardActions.push(action),applyGroup(action){const result=editNoteGroup(clip,action,{indices:[...ctx.noteSelection]});clip.notes=result.notes;ctx.noteSelection=new Set(result.selection);history.commit(project);},run:fn=>fn,$:()=>({addEventListener:(event,fn)=>handler=fn})};
 vm.createContext(ctx);vm.runInContext(source.slice(begin,end),ctx);
 const event=(patch={})=>({key:'d',code:'KeyD',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false,repeat:false,target:{closest:selector=>selector==='.piano-scroll'?{}:null},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...patch});
 return {ctx,clip,project,history,clipboardActions,event,press:e=>handler(e)};
}
test('Control and Command duplicate selected notes with metadata and one exact Undo',async()=>{
 for(const modifier of ['ctrlKey','metaKey']){
  const f=await fixture(),before=structuredClone(f.project),e=f.event({ctrlKey:false,[modifier]:true});f.press(e);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);assert.equal(f.clip.notes.length,5);
  assert.deepEqual(f.clip.notes.slice(3),[{...before.clips.clip.notes[0],start:3.75},{...before.clips.clip.notes[1],start:5.75}]);assert.deepEqual([...f.ctx.noteSelection],[3,4]);
  assert.equal(f.history.past.length,1);assert.deepEqual(f.history.undo(),before);
 }
});
test('repeats, modified chords, fields, composition, locks and empty selections do not duplicate',async()=>{
 for(const mode of ['repeat','shift','alt','composition','field','outside','locked','preparing','empty']){
  const f=await fixture(),before=structuredClone(f.project),e=f.event();
  if(mode==='repeat')e.repeat=true;if(mode==='shift')e.shiftKey=true;if(mode==='alt')e.altKey=true;if(mode==='composition')e.isComposing=true;
  if(mode==='field')e.target.closest=()=>({});if(mode==='outside')e.target.closest=()=>null;
  if(mode==='locked')f.ctx.navigationLocked=()=>true;if(mode==='preparing')f.ctx.engine.startPromise={};if(mode==='empty')f.ctx.noteSelection.clear();
  f.press(e);assert.deepEqual(f.project,before,mode);assert.equal(f.history.past.length,0,mode);
 }
});
test('duplicate that cannot fit rejects atomically and held paste does not repeat',async()=>{
 const f=await fixture();f.press(f.event());const before=structuredClone(f.project);assert.throws(()=>f.press(f.event()),/does not fit/);assert.deepEqual(f.project,before);assert.equal(f.history.past.length,1);
 f.ctx.noteClipboard={notes:[{}]};f.press(f.event({code:'KeyV',key:'v'}));f.press(f.event({code:'KeyV',key:'v',repeat:true}));assert.deepEqual(f.clipboardActions,['paste']);
});
