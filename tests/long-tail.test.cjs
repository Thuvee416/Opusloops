const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return Object.assign({},...await Promise.all(['devices','routing','audio-tail','audio','model','instruments','sampler','drums','voice-scheduler','export-range'].map(n=>import('../web-studio/'+n+'.js'))));}
test('long echoes retain their complete calculated tail through devices, routed buses and the export engine',async()=>{
 const a=await api(),p=a.emptyProject(),source=p.tracks[0],bus=a.makeTrack('Bus'),echo=a.newDevice('echo');Object.assign(echo.params,{time:1,feedback:.8,mix:1});source.devices=[echo];p.tracks.push(bus);source.output='track:'+bus.id;const verb=a.newDevice('space');verb.params.decay=5;bus.devices=[verb];
 const expected=a.feedbackTailSeconds(2,.8)+5+verb.params.preDelay;
 assert.ok(expected>60);assert.equal(a.effectTail([source]),a.feedbackTailSeconds(2,.8));assert.ok(Math.abs(a.routingTail(p)-expected)<1e-10);
 const engine=new a.Engine(p,()=>{});engine.instrumentTail=4;assert.ok(Math.abs(engine.tailSeconds()-expected-4)<1e-10);
 const plan=a.exportRangePlan([{start:0,length:1}],120,44100,engine.tailSeconds());assert.equal(plan.frames,Math.ceil((.5+expected+4)*44100));
});
test('one-shot sample and drum tails also retain long playback durations and tuning',async()=>{
 const a=await api(),p=a.emptyProject(),t=p.tracks[0];t.instrument={...a.newSampler(),mode:'oneshot',root:60};t.slots[0]='note';p.clips.note={id:'note',kind:'midi',beats:4,notes:[{pitch:48,start:0,duration:.25,velocity:1}]};
 assert.equal(a.voiceTail(p,()=>({duration:45})),90);
 const rack=a.newDrumRack();rack.pads[0].source='sample';rack.pads[0].sample=a.newSampler();rack.pads[0].tune=-12;assert.equal(a.drumTail(rack,()=>({duration:45})),90);
});
test('disabled effects stay excluded and automated feedback determines the preserved tail',async()=>{
 const a=await api(),echo=a.newDevice('echo');echo.params.mix=0;echo.params.feedback=0;echo.params.time=.1;echo.automation={mix:{enabled:true,points:[{beat:0,value:0},{beat:4,value:1}]},time:{enabled:true,points:[{beat:0,value:.1},{beat:4,value:1}]},feedback:{enabled:true,points:[{beat:0,value:0},{beat:4,value:.8}]}};
 assert.equal(a.effectTail([{devices:[echo]}]),a.feedbackTailSeconds(2,.8));echo.enabled=false;assert.equal(a.effectTail([{devices:[echo]}]),0);
});
test('memory protection rejects excessive full tails before rendering and intentional tail-free export stays exact',async()=>{
 const {exportRangePlan}=await api(),events=[{start:0,length:4}];
 assert.throws(()=>exportRangePlan(events,120,44100,1000),/256 MB.*Effects Tail/i);
 const dry=exportRangePlan(events,120,44100,1000,undefined,false);assert.equal(dry.frames,88200);
 for(const value of [NaN,Infinity,-1])assert.throws(()=>exportRangePlan(events,120,44100,value),/tail/i);
});
