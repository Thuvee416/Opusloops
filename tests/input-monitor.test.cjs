const {test}=require('node:test'),assert=require('node:assert/strict');
function parameter(value=0){return {value,setTargetAtTime(n){this.value=n;},setValueAtTime(n){this.value=n;},cancelScheduledValues(){}};}
function node(){return {connections:[],gain:parameter(1),pan:parameter(),connect(to){this.connections.push(to);return to;},disconnect(){this.connections=[];}};}
function context(){return {currentTime:1,destination:node(),createGain:node,createStereoPanner:node,createAnalyser:node,createChannelSplitter:node,sampleRate:48000};}
async function api(){return {...await import('../web-studio/input-monitor.js'),...await import('../web-studio/input.js'),...await import('../web-studio/audio.js'),...await import('../web-studio/model.js')};}
test('monitor routes into the selected regular track before effects and never falls back from a missing track',async()=>{
 const t=await api(),p=t.emptyProject(),target=node(),ctx=context(),e={project:p,context:ctx,mixers:new Map([[p.tracks[0].id,{input:target,chain:{input:node()}}]])};
 assert.deepEqual(t.inputMonitorRoute(e,p.tracks[0].id),{target,level:1});assert.deepEqual(t.inputMonitorRoute(e,'missing','raw'),{target:ctx.destination,level:.5});
 assert.equal(t.inputMonitorRoute(e,'missing'),null);assert.equal(t.inputMonitorRoute(e,p.tracks[0].id,'unknown'),null);assert.equal(t.inputMonitorRoute({project:p},p.tracks[0].id),null);
 p.tracks[0].group=true;assert.equal(t.inputMonitorRoute(e,p.tracks[0].id),null);
});
test('monitor switching replaces one output connection, retains raw mode and does not touch capture data',async()=>{
 const t=await api(),ctx=context(),capture=new t.AudioCapture(ctx),target=node(),chunks=[new Float32Array([.2,.4])];capture.monitor=node();capture.connected=true;capture.chunks=chunks;capture.processor={port:{postMessage:()=>assert.fail('monitoring must not control recording')}};
 capture.setMonitor(true,target,1);assert.deepEqual(capture.monitor.connections,[target]);assert.equal(capture.monitor.gain.value,1);capture.setMonitor(true,target,1);assert.equal(capture.monitor.connections.length,1);
 capture.setMonitor(true,ctx.destination,.5);assert.deepEqual(capture.monitor.connections,[ctx.destination]);assert.equal(capture.monitor.gain.value,.5);
 capture.setMonitor(false);assert.equal(capture.monitor.gain.value,0);assert.equal(capture.chunks,chunks);
 capture.connected=false;capture.setMonitor(true,target,1);assert.equal(capture.monitor.gain.value,0);assert.deepEqual(capture.monitor.connections,[ctx.destination]);
 assert.throws(()=>capture.setMonitor(true,target,Infinity));
});
test('actual mixer rebuild reconnects monitoring and shares mute, solo, fader, pan and send controls',async()=>{
 const t=await api(),p=t.emptyProject();p.tracks.push(t.makeTrack('Other'));p.tracks.forEach(track=>track.devices=[]);p.returns=[{...t.makeTrack('Room'),devices:[],id:'room'}];p.tracks[0].sends={room:{amount:.3,pre:false}};
 const e=new t.Engine(p,()=>{});e.context=context();e.master=node();e.resetMixers();const capture=new t.AudioCapture(e.context);capture.monitor=node();capture.connected=true;
 const sync=()=>{const route=t.inputMonitorRoute(e,p.tracks[0].id);capture.setMonitor(true,route.target,route.level);};e.onMixersChanged=sync;sync();const old=e.mixers.get(p.tracks[0].id).input;e.resetMixers();const mix=e.mixers.get(p.tracks[0].id);
 assert.notEqual(mix.input,old);assert.deepEqual(capture.monitor.connections,[mix.input]);assert.equal(old.connections.length,0);
 p.tracks[0].volume=.25;p.tracks[0].pan=-.6;p.tracks[0].mute=true;e.updateMix();assert.equal(mix.gain.gain.value,.25);assert.equal(mix.pan.pan.value,-.6);assert.equal(mix.gate.gain.value,0);assert.equal(mix.sends.get('room').post.gain.value,.3);
 p.tracks[0].mute=false;p.tracks[1].solo=true;e.updateMix();assert.equal(mix.input.gain.value,0);p.tracks[1].solo=false;e.updateMix();assert.equal(mix.input.gain.value,1);assert.equal(mix.gate.gain.value,1);
});
test('application monitoring remains explicit and binds the active take rather than an unrelated selected track',async()=>{
 const t=await api(),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),p=t.emptyProject();p.tracks.push(t.makeTrack('Other'));const targets=[node(),node()],ctxAudio=context(),capture=new t.AudioCapture(ctxAudio);capture.monitor=node();capture.connected=true;
 const controls={'input-monitor':{checked:false},'input-monitor-mode':{value:'track'},'input-track':{value:p.tracks[1].id}},ctx={audioInput:capture,inputMonitorRoute:t.inputMonitorRoute,engine:{context:ctxAudio,project:p,mixers:new Map(p.tracks.map((track,i)=>[track.id,{input:targets[i]}]))},inputMeta:{trackId:p.tracks[0].id},$:id=>controls[id]};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function syncInputMonitor(){'),source.indexOf("\n$('input-monitor').onchange=")),ctx);
 ctx.syncInputMonitor();assert.equal(capture.monitor.gain.value,0);assert.equal(capture.monitor.connections.length,0);controls['input-monitor'].checked=true;ctx.syncInputMonitor();assert.deepEqual(capture.monitor.connections,[targets[0]]);
 ctx.inputMeta=null;ctx.syncInputMonitor();assert.deepEqual(capture.monitor.connections,[targets[1]]);controls['input-track'].value='missing';ctx.syncInputMonitor();assert.equal(capture.monitor.gain.value,0);
 controls['input-monitor-mode'].value='raw';ctx.syncInputMonitor();assert.deepEqual(capture.monitor.connections,[ctxAudio.destination]);assert.equal(capture.monitor.gain.value,.5);
});
test('disconnect clears the monitoring route and every capture node',async()=>{
 const t=await api(),ctx=context(),capture=new t.AudioCapture(ctx);capture.monitor=node();capture.connected=true;capture.setMonitor(true,node(),1);await capture.disconnect();assert.equal(capture.monitorTarget,null);assert.equal(capture.connected,false);assert.equal(capture.monitor.connections.length,0);
});
