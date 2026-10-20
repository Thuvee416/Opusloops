const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=()=>import('../web-studio/audio-output.js');
test('output choices filter inputs, deduplicate defaults and retain a missing selected device',async()=>{
 const {audioOutputChoices}=await api(),choices=audioOutputChoices([{kind:'audioinput',deviceId:'mic'},{kind:'audiooutput',deviceId:'default'},{kind:'audiooutput',deviceId:'speakers',label:'Studio'},{kind:'audiooutput',deviceId:'speakers'},{kind:'audiooutput',deviceId:'unlabelled'}],'lost');
 assert.deepEqual(choices,[{id:'',label:'System Default',missing:false},{id:'speakers',label:'Studio',missing:false},{id:'unlabelled',label:'Audio Output 2',missing:false},{id:'lost',label:'Selected Output Unavailable',missing:true}]);
});
test('failed output selection preserves preference and later requests can retry',async()=>{
 const {AudioOutputRoute}=await api(),route=new AudioOutputRoute(),calls=[],ctx={state:'suspended',sinkId:'',async setSinkId(id){calls.push(id);if(id==='denied')throw Error('NotAllowedError');this.sinkId=id;}};
 await route.select(ctx,'studio');await assert.rejects(route.select(ctx,'denied'),/NotAllowed/);assert.equal(route.id,'studio');assert.equal(ctx.sinkId,'studio');await route.select(ctx,'default');assert.equal(route.id,'');assert.deepEqual(calls,['studio','denied','']);
});
test('queued engine startup follows the most recent successful output selection',async()=>{
 const {AudioOutputRoute}=await api(),route=new AudioOutputRoute();let finish;const first={state:'running',sinkId:'',setSinkId:id=>new Promise(resolve=>finish=()=>{first.sinkId=id;resolve();})},next={state:'suspended',sinkId:'',async setSinkId(id){this.sinkId=id;}};
 const selection=route.select(first,'studio'),startup=route.apply(next);await new Promise(r=>setImmediate(r));assert.equal(next.sinkId,'');finish();await Promise.all([selection,startup]);assert.equal(next.sinkId,'studio');
});
test('unsupported, closed and malformed device choices fail without committing a preference',async()=>{
 const {AudioOutputRoute}=await api(),route=new AudioOutputRoute();await route.apply({state:'running'});await assert.rejects(route.select({state:'running'},'studio'),/System Audio Output/);await assert.rejects(route.select({state:'closed'},''),/Closed/);await assert.rejects(route.select({},null),/Available/);await assert.rejects(route.select({},'x'.repeat(1025)),/Available/);assert.equal(route.id,'');
 await assert.rejects(route.select({state:'running',async setSinkId(){this.state='closed';}},'studio'),/Closed/);assert.equal(route.id,'');
});
async function app(){
 const {AudioOutputRoute}=await api(),source=fs.readFileSync(require.resolve('../web-studio/app.js'),'utf8'),calls=[],monitor={checked:true},route=new AudioOutputRoute(),ctx={state:'suspended',sinkId:'',async setSinkId(id){calls.push(['sink',id]);if(id==='bad')throw Error('Unavailable');this.sinkId=id;}};
 const s={busy:false,engine:{context:ctx,async init(resume){calls.push(['init',resume]);}},stopToEdit(){if(s.engine.playing||s.active)throw Error('Stop First');},audioOutputSupported:()=>true,audioOutputRoute:route,$:()=>monitor,releaseNotes:()=>calls.push(['notes']),syncInputMonitor:()=>calls.push(['monitor',monitor.checked]),renderTransport:()=>calls.push(['render',s.busy]),refreshAudioOutputs:async()=>calls.push(['refresh']),setStatus:message=>calls.push(['status',message]),navigator:{mediaDevices:{selectAudioOutput:async()=>{throw Error('Cancelled');}}}};
 vm.createContext(s);vm.runInContext(source.slice(source.indexOf('async function changeAudioOutput('),source.indexOf("\n$('audio-output').onchange")),s);return {s,route,calls,monitor,ctx};
}
test('actual output action releases notes and monitoring, initializes without autoplay and clears its lock',async()=>{
 const {s,route,calls,monitor}=await app();await s.changeAudioOutput('studio');assert.equal(route.id,'studio');assert.equal(s.busy,false);assert.equal(monitor.checked,false);assert.deepEqual(calls.slice(0,5),[['notes'],['monitor',false],['render',true],['init',false],['sink','studio']]);assert.deepEqual(calls.at(-1),['refresh']);
});
test('actual output action retains previous selection and unlocks on device, picker or monitoring failure',async()=>{
 for(const failure of ['sink','picker','monitor']){const {s,route,monitor}=await app();await route.select(s.engine.context,'previous');if(failure==='monitor')s.syncInputMonitor=()=>{throw Error('Monitor Failed');};await assert.rejects(s.changeAudioOutput('bad',failure==='picker'));assert.equal(route.id,'previous');assert.equal(s.busy,false);assert.equal(monitor.checked,false);}
});
test('actual output action cannot switch during playback, input capture, pending playback or another operation',async()=>{
 for(const key of ['playing','startPromise','recording','automationTake','busy','active']){const {s,calls}=await app();if(['busy','active'].includes(key))s[key]=true;else s.engine[key]=true;await assert.rejects(s.changeAudioOutput('studio'));assert.deepEqual(calls,[]);}
});
test('offline render snapshots never inherit the physical audio output hook',async()=>{
 const {createRenderSnapshot}=await import('../web-studio/render-snapshot.js'),{emptyProject}=await import('../web-studio/model.js');const snapshot=createRenderSnapshot({project:emptyProject(),routeOutput(){throw Error('Hardware Access');}});assert.equal(snapshot.routeOutput,undefined);
});
