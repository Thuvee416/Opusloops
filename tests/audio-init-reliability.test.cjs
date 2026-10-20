const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return {...await import('../web-studio/audio.js'),...await import('../web-studio/model.js')};}
function context({failAt=Infinity,close,resume}={}){
 const ctx={nodes:[],allocations:0,closes:0,resumes:0,currentTime:0,sampleRate:48000,state:'suspended'};
 const parameter=()=>({value:0,setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},cancelScheduledValues(){}});
 const node=()=>{if(++ctx.allocations===failAt)throw Error('Graph Allocation Failed');const n={edges:new Set(),gain:parameter(),pan:parameter(),connect(target){this.edges.add(target);return target;},disconnect(target){if(target)this.edges.delete(target);else this.edges.clear();}};ctx.nodes.push(n);return n;};
 Object.assign(ctx,{destination:{},createGain:node,createDynamicsCompressor:node,createChannelSplitter:node,createAnalyser:node,createStereoPanner:node,async close(){this.closes++;this.state='closed';if(close)return close();},async resume(){this.resumes++;if(resume)await resume();this.state='running';}});
 return ctx;
}
async function installed(factory,fn){const previous=globalThis.AudioContext;globalThis.AudioContext=function(){return factory();};try{return await fn();}finally{if(previous===undefined)delete globalThis.AudioContext;else globalThis.AudioContext=previous;}}
function cleaned(ctx){assert.equal(ctx.closes,1);for(const n of ctx.nodes)assert.equal(n.edges.size,0);}

test('failed startup releases a partial graph and a subsequent Play preparation creates a fresh working engine',async()=>{
 const t=await api(),p=t.emptyProject(),before=structuredClone(p),e=new t.Engine(p,()=>{}),contexts=[context({failAt:2}),context()];let calls=0;
 await installed(()=>contexts[calls++],async()=>{
  await assert.rejects(e.init(),/Graph Allocation Failed/);assert.equal(e.context,null);cleaned(contexts[0]);assert.equal(e.mixGraph,undefined);assert.equal(contexts[0].resumes,0);
  await e.init();assert.equal(calls,2);assert.equal(e.context,contexts[1]);assert.equal(e.mixers.size,1);assert.equal(e.context.state,'running');assert.ok(e.mixers.get(p.tracks[0].id).input.edges.size);assert.deepEqual(p,before);
 });
});

test('every startup node-allocation failure closes its context and cleans master, meters and partial mixers',async()=>{
 const t=await api(),probe=context();await installed(()=>probe,async()=>{const e=new t.Engine(t.emptyProject(),()=>{});await e.init(false);});
 for(let failAt=1;failAt<=probe.allocations;failAt++){
  const ctx=context({failAt}),e=new t.Engine(t.emptyProject(),()=>{});await installed(()=>ctx,async()=>{await assert.rejects(e.init(false),/Graph Allocation Failed/);assert.equal(e.context,null);assert.equal(e.mixGraph,undefined);assert.equal(e.master,null);assert.equal(e.compressor,null);assert.equal(e.masterMeter,null);assert.equal(e.mixers.size,0);assert.equal(e.returnMixers.size,0);cleaned(ctx);});
 }
});

test('a resume permission failure retains the complete graph for a later user gesture',async()=>{
 const t=await api(),ctx=context({resume:()=>{if(ctx.resumes===1)throw Error('User Gesture Required');}}),e=new t.Engine(t.emptyProject(),()=>{});
 await installed(()=>ctx,async()=>{
  await assert.rejects(e.init(),/User Gesture Required/);const graph=e.mixGraph,nodes=ctx.nodes.length;assert.equal(e.context,ctx);assert.equal(ctx.closes,0);assert.ok(graph);
  await e.init();assert.equal(e.mixGraph,graph);assert.equal(ctx.nodes.length,nodes);assert.equal(ctx.resumes,2);assert.equal(ctx.state,'running');
 });
});

test('non-playing initialization does not resume audio and reuses an already complete graph',async()=>{
 const t=await api(),ctx=context(),e=new t.Engine(t.emptyProject(),()=>{});
 await installed(()=>ctx,async()=>{await e.init(false);const graph=e.mixGraph,count=ctx.nodes.length;await e.init(false);assert.equal(e.mixGraph,graph);assert.equal(ctx.nodes.length,count);assert.equal(ctx.resumes,0);assert.equal(ctx.state,'suspended');});
});

test('cleanup failure preserves the original startup error and a late close cannot clear a newer engine',async()=>{
 const t=await api();let finish;const old=context({failAt:2,close:()=>new Promise(resolve=>finish=resolve)}),fresh=context(),e=new t.Engine(t.emptyProject(),()=>{});let calls=0;
 await installed(()=>calls++?fresh:old,async()=>{
  const pending=e.init(false);await new Promise(r=>setImmediate(r));assert.equal(e.context,null);await e.init(false);const graph=e.mixGraph;finish();await assert.rejects(pending,/Graph Allocation Failed/);assert.equal(e.context,fresh);assert.equal(e.mixGraph,graph);assert.equal(fresh.closes,0);
 });
 const broken=context({failAt:2,close:()=>{throw Error('Close Failed');}}),retry=new t.Engine(t.emptyProject(),()=>{});await installed(()=>broken,async()=>{await assert.rejects(retry.init(),/Graph Allocation Failed/);assert.equal(retry.context,null);});
});

test('constructor and monitoring errors remain retryable without mutating project data or sample caches',async()=>{
 const t=await api(),p=t.emptyProject(),before=structuredClone(p),e=new t.Engine(p,()=>{}),cache=e.sampleBuffers;cache.set('existing',{sentinel:true});
 await installed(()=>{throw Error('Context Unavailable');},async()=>{await assert.rejects(e.init(),/Context Unavailable/);assert.equal(e.context,null);});
 const failed=context();e.onMixersChanged=()=>{throw Error('Monitor Unavailable');};
 await installed(()=>failed,async()=>{await assert.rejects(e.init(),/Monitor Unavailable/);assert.equal(e.context,null);cleaned(failed);assert.equal(e.sampleBuffers,cache);assert.equal(cache.get('existing').sentinel,true);assert.deepEqual(p,before);});
 e.onMixersChanged=null;const fresh=context();await installed(()=>fresh,async()=>{await e.init(false);assert.equal(e.mixers.size,1);assert.deepEqual(p,before);});
});
