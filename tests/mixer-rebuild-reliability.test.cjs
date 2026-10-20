const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return {...await import('../web-studio/model.js'),...await import('../web-studio/audio.js'),...await import('../web-studio/devices.js'),...await import('../web-studio/routing.js'),...await import('../web-studio/level-meter.js')};}
function context(){
 const nodes=[],state={allocations:0,failAt:Infinity,connects:0,failConnectAt:Infinity,waves:0,failWaveAt:Infinity};
 const param=()=>({value:0,setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},cancelScheduledValues(){}});
 const node=(kind='gain')=>{
  if(++state.allocations===state.failAt)throw Error('Allocation Failed');
  const n={kind,edges:new Set(),disconnected:false,started:false,stopped:false,connect(target){if(++state.connects===state.failConnectAt)throw Error('Connection Failed');this.edges.add(target);return target;},disconnect(target){if(target)this.edges.delete(target);else{this.edges.clear();this.disconnected=true;}},start(){this.started=true;},stop(){this.stopped=true;},setPeriodicWave(){if(++state.waves===state.failWaveAt)throw Error('Wave Failed');}};
  for(const key of ['gain','pan','frequency','Q','delayTime','offset','threshold','ratio','attack','release'])n[key]=param();nodes.push(n);return n;
 };
 return {nodes,state,node,currentTime:1,sampleRate:8,createGain:()=>node(),createStereoPanner:()=>node('pan'),createAnalyser:()=>node('analyser'),createChannelSplitter:()=>node('splitter'),createChannelMerger:()=>node('merger'),createBiquadFilter:()=>node('filter'),createDelay:()=>node('delay'),createConvolver:()=>node('convolver'),createWaveShaper:()=>node('shaper'),createOscillator:()=>node('oscillator'),createConstantSource:()=>node('constant'),createDynamicsCompressor:()=>node('compressor'),createPeriodicWave:()=>({}),createBuffer:(channels,length)=>({getChannelData:()=>new Float32Array(length)})};
}
function cleaned(nodes){for(const node of nodes){assert.equal(node.edges.size,0,node.kind+' connections cleaned');assert.equal(node.disconnected,true,node.kind+' disposed');if(node.started)assert.equal(node.stopped,true,node.kind+' stopped');}}
async function fixture(){
 const t=await api(),p=t.emptyProject();p.tracks.push(t.makeTrack('Second'));p.returns=[{...t.makeTrack('Room'),id:'room',devices:[]}];p.tracks[0].devices=[t.newDevice('filter'),t.newDevice('delay')];p.tracks[0].sends={room:{amount:.3,pre:false}};p.tracks[1].output='track:'+p.tracks[0].id;
 const e=new t.Engine(p,()=>{}),ctx=context();e.context=ctx;e.master=ctx.node('master');e.resetMixers();return {t,p,e,ctx};
}

test('failed mixer allocation leaves the old graph, input connections and monitor callback intact',async()=>{
 const {e,ctx}=await fixture(),before=e.mixGraph,input=e.mixers.values().next().value.input,edges=[...input.edges],overrides=e.automationOverrides;let notifications=0;e.onMixersChanged=()=>notifications++;
 ctx.state.failAt=ctx.state.allocations+1;assert.throws(()=>e.resetMixers(),/Allocation Failed/);assert.equal(e.mixGraph,before);assert.equal(e.mixers,before.tracks);assert.equal(e.automationOverrides,overrides);assert.deepEqual([...input.edges],edges);assert.equal(notifications,0);
});

test('every allocation boundary in a multi-track/return rebuild cleans partial strips without disconnecting the old graph',async()=>{
 const baseline=await fixture(),start=baseline.ctx.state.allocations;baseline.e.resetMixers();const allocations=baseline.ctx.state.allocations-start;
 for(let fail=1;fail<=allocations;fail++){
  const {e,ctx}=await fixture(),before=e.mixGraph,oldNodes=[...ctx.nodes],first=ctx.nodes.length;ctx.state.failAt=ctx.state.allocations+fail;
  assert.throws(()=>e.resetMixers(),/Allocation Failed/);assert.equal(e.mixGraph,before);cleaned(ctx.nodes.slice(first));
  for(const n of oldNodes)assert.equal(n.disconnected,false,'old '+n.kind+' kept at allocation '+fail);
 }
});

test('failed initial mixer build is retryable with no published graph or orphaned nodes',async()=>{
 const t=await api(),p=t.emptyProject(),e=new t.Engine(p,()=>{}),ctx=context();e.context=ctx;e.master=ctx.node();const first=ctx.nodes.length;ctx.state.failAt=ctx.state.allocations+9;
 assert.throws(()=>e.resetMixers(),/Allocation Failed/);assert.equal(e.mixGraph,undefined);cleaned(ctx.nodes.slice(first));ctx.state.failAt=Infinity;e.resetMixers();assert.equal(e.mixers.size,1);assert.ok(e.mixers.get(p.tracks[0].id).input.edges.size);
});

test('initial parameter update failure rolls back graph references and automation overrides',async()=>{
 const {e,ctx,p}=await fixture(),before=e.mixGraph,oldInputs=[...e.mixers.values()].map(m=>m.input),overrides=e.automationOverrides;overrides.add('removed:volume');overrides.add(p.tracks[0].id+':volume');
 const update=e.updateMix,first=ctx.nodes.length;e.updateMix=()=>{throw Error('Parameter Failed');};
 assert.throws(()=>e.resetMixers(),/Parameter Failed/);assert.equal(e.mixGraph,before);assert.equal(e.automationOverrides,overrides);assert.equal(overrides.has('removed:volume'),true);cleaned(ctx.nodes.slice(first));oldInputs.forEach(n=>assert.ok(n.edges.size));
 e.updateMix=update;e.resetMixers();assert.equal(e.automationOverrides.has('removed:volume'),false);assert.equal(e.automationOverrides.has(p.tracks[0].id+':volume'),true);
});

test('successful rebuild installs routing and current controls before notifying monitoring exactly once',async()=>{
 const {e,p,ctx}=await fixture(),before=e.mixGraph,oldNodes=ctx.nodes.slice(1);p.tracks[0].volume=.23;p.tracks[0].pan=-.4;let notified=0;
 e.onMixersChanged=()=>{notified++;assert.notEqual(e.mixGraph,before);assert.equal(e.mixers.get(p.tracks[0].id).gain.gain.value,.23);};
 e.resetMixers();cleaned(oldNodes);assert.equal(notified,1);assert.equal(e.mixers.get(p.tracks[0].id).pan.pan.value,-.4);assert.ok(e.mixers.get(p.tracks[1].id).dry.edges.has(e.mixers.get(p.tracks[0].id).chain.input));assert.equal(e.mixers.get(p.tracks[0].id).sends.get('room').post.gain.value,.3);
});

test('each effect factory failure disposes all nodes and stops already started modulation sources',async()=>{
 const t=await api();
 for(const type of Object.keys(t.DEVICE_TYPES)){
  const probe=context(),device=t.newDevice(type),chain=t.createDeviceChain(probe,[device]),count=probe.state.allocations;chain.dispose();cleaned(probe.nodes);
  for(let fail=1;fail<=count;fail++){const ctx=context();ctx.state.failAt=fail;assert.throws(()=>t.createDeviceChain(ctx,[device]),/Allocation Failed/);cleaned(ctx.nodes);}
 }
});

test('Auto Pan wave setup failure stops both completed and partially initialized oscillators',async()=>{
 const t=await api();for(const fail of [1,2]){const ctx=context();ctx.state.failWaveAt=fail;assert.throws(()=>t.createDeviceChain(ctx,[t.newDevice('autopan')]),/Wave Failed/);cleaned(ctx.nodes);}
});

test('meter and routing connection failures clean all newly created analysis and effect nodes',async()=>{
 const t=await api(),probe=await fixture(),start=probe.ctx.state.connects;probe.e.resetMixers();const connections=probe.ctx.state.connects-start;
 for(let fail=1;fail<=connections;fail++){const {e,ctx}=await fixture(),before=e.mixGraph,first=ctx.nodes.length;ctx.state.failConnectAt=ctx.state.connects+fail;assert.throws(()=>e.resetMixers(),/Connection Failed/);assert.equal(e.mixGraph,before);cleaned(ctx.nodes.slice(first));}
 const ctx=context(),source=ctx.node();ctx.state.failAt=ctx.state.allocations+3;assert.throws(()=>t.createStereoMeter(ctx,source),/Allocation Failed/);assert.equal(source.edges.size,0);cleaned(ctx.nodes.slice(1));
});
