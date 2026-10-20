const {test}=require('node:test'),assert=require('node:assert/strict');
function buffers(rate=44100){return {sampleRate:rate,createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {length,sampleRate,getChannelData:i=>data[i]};}};}
test('studio percussion is deterministic, bounded and distinct without changing legacy drum synthesis',async()=>{
 const {newDrumRack,drumBuffer,validateDrums}=await import('../web-studio/drums.js');
 const rack=newDrumRack();validateDrums(rack);
 for(const rate of [44100,48000]){
  const ctx=buffers(rate);
  for(const pad of rack.pads){
   const old=drumBuffer(ctx,pad),studio=drumBuffer(ctx,{...pad,character:'studio'});
   assert.notEqual(studio,old);assert.equal(drumBuffer(ctx,pad),old);
   assert.deepEqual(studio.getChannelData(0),drumBuffer(buffers(rate),{...pad,character:'studio'}).getChannelData(0));
   const samples=studio.getChannelData(0);assert.ok(samples.some(n=>Math.abs(n)>.01));assert.ok(samples.every(n=>Number.isFinite(n)&&Math.abs(n)<1));
   assert.equal(samples[0],0);assert.ok(Math.abs(samples.at(-1))<.001);
  }
 }
 rack.pads[0].character='unknown';assert.throws(()=>validateDrums(rack),/Character/);
});
test('new synth parameters remain optional in old projects and reject unsafe values',async()=>{
 const {newSynth,validateInstrument}=await import('../web-studio/instruments.js');
 const old=newSynth();for(const key of ['color','phaseSpread','fm','fmRatio','fmDecay'])delete old[key];validateInstrument(old);
 for(const name of ['Analog Bass','Velvet Ensemble','Glass Pluck','Prismatic Arp','Air Pad'])validateInstrument(newSynth(name));
 for(const [key,value] of [['color',2],['phaseSpread',-1],['fm',NaN],['fmRatio',9],['fmDecay',0]])assert.throws(()=>validateInstrument({...newSynth(),[key]:value}));
});
test('stereo space impulses decay and remain decorrelated at different sample rates',async()=>{
 const {spaceImpulse}=await import('../web-studio/studio-effects.js');
 for(const rate of [44100,48000]){
  const b=spaceImpulse(buffers(rate),2),l=b.getChannelData(0),r=b.getChannelData(1);
  assert.equal(l.length,rate*2);assert.ok(l.every(Number.isFinite));assert.notDeepEqual(l,r);
  const energy=a=>a.reduce((sum,n)=>sum+n*n,0);
  assert.ok(energy(l.slice(-rate/4))<energy(l.slice(rate/4,rate/2))*.001);
 }
});
test('Studio devices have validated automatable settings and bounded export tails',async()=>{
 const {newDevice,validateDevices,deviceAutomationSpecs,effectTail}=await import('../web-studio/devices.js');
 const devices=['parametric','space','echo'].map(newDevice);validateDevices(devices);
 assert.equal(deviceAutomationSpecs('space').decay,undefined);assert.ok(deviceAutomationSpecs('space').preDelay);assert.ok(deviceAutomationSpecs('echo').feedback);assert.ok(deviceAutomationSpecs('parametric').midQ);
 for(const d of devices){const invalid=structuredClone(d),key=Object.keys(d.params)[0];invalid.params[key]=NaN;assert.throws(()=>validateDevices([invalid]));}
 assert.ok(effectTail([{devices}])>2.4);assert.ok(effectTail([{devices}])<=30);
});
test('Odesa shared actions can select the new sounds and effects without a separate mutation path',async()=>{
 const {applyAgentActions}=await import('../web-studio/agent-actions.js'),{emptyProject,validateProject}=await import('../web-studio/model.js');
 const p=emptyProject(),before=structuredClone(p),trackId=p.tracks[0].id;
 const result=applyAgentActions(p,[{type:'instrument',args:{trackId,kind:'poly',preset:'Glass Pluck'}},{type:'device',args:{trackId,type:'space',params:{mix:.22}}}]);
 const next=result.project??result;validateProject(next);assert.deepEqual(p,before);assert.equal(next.tracks[0].instrument.fm,1.6);assert.equal(next.tracks[0].devices.at(-1).type,'space');
});
