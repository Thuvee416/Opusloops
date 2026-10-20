const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
test('shared edit guard keeps cancelled startup locked until pending resources settle',()=>{
 const ctx={engine:{playing:false},sessionMarquee:null,inputActive:()=>false};vm.createContext(ctx);const start=source.indexOf('function stopToEdit(){');vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);
 ctx.stopToEdit();ctx.engine.startPromise=Promise.resolve();assert.throws(()=>ctx.stopToEdit(),/Playback Preparation/);
 ctx.engine.playGeneration=2;ctx.engine.playRequestGeneration=null;assert.throws(()=>ctx.stopToEdit(),/Playback Preparation/);
 ctx.engine.startPromise=null;ctx.engine.preparing=true;assert.throws(()=>ctx.stopToEdit(),/Playback Preparation/);ctx.engine.preparing=false;ctx.stopToEdit();ctx.engine.playing=true;assert.throws(()=>ctx.stopToEdit(),/Stop playback/);ctx.engine.playing=false;
 ctx.inputActive=()=>true;assert.throws(()=>ctx.stopToEdit(),/input take/);ctx.inputActive=()=>false;ctx.sessionMarquee={dragging:true};assert.throws(()=>ctx.stopToEdit(),/Selection Drag/);
});
test('UI lock synchronization follows startup settlement and replacement without polling side effects',()=>{
 let renders=0;const ctx={engine:{},renderTransport:()=>renders++};vm.createContext(ctx);const start=source.indexOf('let lastPlaybackPreparation=null;'),end=source.indexOf('\nfunction animate()',start);assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),ctx);
 ctx.syncPlaybackPreparation();assert.equal(renders,0);const first=Promise.resolve();ctx.engine.startPromise=first;ctx.syncPlaybackPreparation();assert.equal(renders,1);
 for(let i=0;i<100;i++)ctx.syncPlaybackPreparation();assert.equal(renders,1);
 ctx.engine.playRequestGeneration=null;ctx.syncPlaybackPreparation();assert.equal(renders,1);
 ctx.engine.startPromise=null;ctx.syncPlaybackPreparation();assert.equal(renders,2);
 ctx.engine.startPromise=Promise.resolve();ctx.syncPlaybackPreparation();assert.equal(renders,3);
 ctx.engine={};ctx.syncPlaybackPreparation();assert.equal(renders,4);
 ctx.engine.preparing=true;ctx.syncPlaybackPreparation();assert.equal(renders,5);ctx.syncPlaybackPreparation();assert.equal(renders,5);ctx.engine.preparing=false;ctx.syncPlaybackPreparation();assert.equal(renders,6);
 // A fully cached start can settle between animation frames; unlock live MIDI anyway.
 ctx.engine.playing=true;ctx.engine.context={state:'running'};ctx.syncPlaybackPreparation();assert.equal(renders,7);ctx.syncPlaybackPreparation();assert.equal(renders,7);ctx.engine.context.state='suspended';ctx.syncPlaybackPreparation();assert.equal(renders,8);
});
