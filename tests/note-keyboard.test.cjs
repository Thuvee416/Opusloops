const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('piano arrows map to grid movement, semitones, octaves and selected lengths',async()=>{
 const {noteKeyCommand:key}=await import('../web-studio/note-keyboard.js');
 assert.deepEqual(key({key:'ArrowLeft'},.125),{action:'move',options:{deltaBeats:-.125,grid:.125}});
 assert.deepEqual(key({key:'ArrowRight',shiftKey:true},.5),{action:'resize',options:{deltaBeats:.5,grid:.5}});
 assert.deepEqual(key({key:'ArrowUp'},.25),{action:'move',options:{deltaPitch:1,grid:.25}});
 assert.deepEqual(key({key:'ArrowDown',shiftKey:true},.25),{action:'move',options:{deltaPitch:-12,grid:.25}});
 for(const modifier of ['ctrlKey','metaKey','altKey','isComposing'])assert.equal(key({key:'ArrowUp',[modifier]:true},.25),null);
 assert.equal(key({key:'a'},.25),null);assert.throws(()=>key({key:'ArrowRight'},0));
});
async function fixture(){
 const [{noteKeyCommand},{editNoteGroup},{History}]=await Promise.all([import('../web-studio/note-keyboard.js'),import('../web-studio/notes.js'),import('../web-studio/history.js')]);
 const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8'),clip={id:'clip',kind:'midi',beats:8,notes:[{pitch:60,start:1,duration:1,velocity:.5},{pitch:64,start:3,duration:.75,velocity:.8,active:false}]},project={clips:{clip}},h=new History(project),listeners={document:{},window:{},editor:{}},on=host=>(name,fn)=>(listeners[host][name]??=[]).push(fn);
 const ctx={noteKeyCommand,editNoteGroup,project,selection:{clipId:'clip'},noteSelection:new Set([0,1]),noteGrid:.25,busy:false,engine:{playing:false},inputActive:()=>false,navigationLocked:()=>false,focusPiano(){},setStatus(){},run:fn=>fn,document:{addEventListener:on('document')},window:{addEventListener:on('window')},$:()=>({addEventListener:on('editor')}),finishGroup(result,group){clip.notes=result.notes;h.commit(project,group);}};
 vm.createContext(ctx);const begin=source.indexOf('let noteNudge=null;'),end=source.indexOf("\n$('clip-editor').addEventListener('keydown',run(e=>{if(!e.target.closest('.piano-scroll')",begin);
 assert.ok(begin>=0&&end>begin);vm.runInContext(source.slice(begin,end),ctx);
 const event=(key,patch={})=>({key,code:key,repeat:false,shiftKey:false,target:{closest:selector=>selector==='.piano-scroll'?{}:null},preventDefault(){},stopPropagation(){},...patch});
 return {ctx,project,h,listeners,event,press:e=>listeners.editor.keydown[0](e)};
}
test('held-key repeats form one Undo while a released new press forms a separate edit',async()=>{
 const f=await fixture(),before=structuredClone(f.project);for(let i=0;i<3;i++)f.press(f.event('ArrowRight',{repeat:i>0}));
 assert.equal(f.project.clips.clip.notes[0].start,1.75);assert.equal(f.h.past.length,1);
 for(const fn of f.listeners.document.keyup)fn(f.event('ArrowRight'));
 f.press(f.event('ArrowRight'));assert.equal(f.h.past.length,2);assert.equal(f.h.undo().clips.clip.notes[0].start,1.75);assert.deepEqual(f.h.undo(),before);
});
test('changing key modifiers or selected notes starts a new grouped edit',async()=>{
 const f=await fixture();f.press(f.event('ArrowUp'));f.press(f.event('ArrowUp',{repeat:true,shiftKey:true}));
 assert.equal(f.h.past.length,2);assert.equal(f.project.clips.clip.notes[0].pitch,73);
 f.ctx.noteSelection=new Set([0]);f.press(f.event('ArrowUp',{repeat:true,shiftKey:true}));assert.equal(f.h.past.length,3);assert.equal(f.project.clips.clip.notes[1].pitch,77);
});
test('playback, preparation, recording, busy operations and other controls cannot nudge notes',async()=>{
 for(const lock of ['playing','startPromise','busy','input','gesture','velocity','field']){
  const f=await fixture(),before=structuredClone(f.project);
  if(['playing','startPromise'].includes(lock))f.ctx.engine[lock]=true;if(lock==='busy')f.ctx.busy=true;if(lock==='input')f.ctx.inputActive=()=>true;if(lock==='gesture')f.ctx.navigationLocked=()=>true;
  const e=f.event('ArrowUp');if(lock==='velocity'||lock==='field')e.target.closest=selector=>selector==='.piano-scroll'||selector.includes(lock==='velocity'?'data-velocity-note':'input')?{}:null;
  f.press(e);assert.deepEqual(f.project,before);assert.equal(f.h.past.length,0);
 }
});
test('a boundary-limited key press leaves the project and Undo stack unchanged',async()=>{
 const f=await fixture();f.project.clips.clip.notes[1].pitch=127;const before=structuredClone(f.project);
 f.press(f.event('ArrowUp'));assert.deepEqual(f.project,before);assert.equal(f.h.past.length,0);
 f.project.clips.clip.notes[1].start=7.25;const edge=structuredClone(f.project);f.press(f.event('ArrowRight'));assert.deepEqual(f.project,edge);assert.equal(f.h.past.length,0);
});
