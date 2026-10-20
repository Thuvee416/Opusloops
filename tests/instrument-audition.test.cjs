const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
async function fixture({drums=false,realNotes=false}={}){
 const [{emptyProject},{newSampler},{newDrumRack},{LiveNotes}]=await Promise.all(['model','sampler','drums','input'].map(n=>import('../web-studio/'+n+'.js')));
 const project=emptyProject(),track=project.tracks[0];track.instrument=drums?newDrumRack():{...newSampler(),name:'Loaded',data:'AQ==',mode:'oneshot'};
 const gates=[],events=[],nodes=[],param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){},cancelAndHoldAtTime(){},setTargetAtTime(){}}),node=()=>({gain:param(),playbackRate:param(),connect(){},disconnect(){},start(){},stop(time){events.push(['force-stop',time]);}});
 const engine={project,playGeneration:0,playing:false,prepareSamples:()=>new Promise((resolve,reject)=>gates.push({resolve,reject})),context:{currentTime:0,createBufferSource(){const n=node();nodes.push(n);return n;},createGain:node},mixers:new Map([[track.id,{input:node()}]]),nodes:new Set(),sampleBuffers:new Map([[track.id,{buffer:{duration:10}}]])};
 class Notes{constructor(owner){this.engine=owner;}on(...args){events.push(['on',...args]);}off(...args){events.push(['off',...args]);}allOff(){events.push(['all-off',this]);}}
 const keyboard=new Notes(engine),controls={'device-chain':{dataset:{track:track.id}}},ctx={project,engine,busy:false,instrumentAuditionEpoch:0,samplePreview:null,liveNotes:keyboard,midiTake:null,inputCaptureId:null,inputTarget:track.id,drumPad:36,LiveNotes:realNotes?LiveNotes:Notes,inputActive:()=>!!ctx.midiTake,stopToEdit(){if(ctx.engine.playing||ctx.midiTake)throw Error('Stop Editing');},renderInstrument(){},setStatus(){},$:id=>controls[id],midiSustain:{reset(){}},inputNote:(...args)=>events.push(['input',...args])};
 vm.createContext(ctx);const start=source.indexOf('function cancelInstrumentAuditions('),end=source.indexOf("\n$('instrument').addEventListener('click'",start);vm.runInContext(source.slice(start,end),ctx);
 const release=source.indexOf('function releaseNotes(){');vm.runInContext(source.slice(release,source.indexOf('\n',release)),ctx);
 return {ctx,engine,project,track,gates,events,nodes,controls,keyboard};
}

test('Stop Audition cancels a pending load and cannot be followed by a late preview',async()=>{
 const f=await fixture(),pending=f.ctx.auditionSample(f.track);f.ctx.cancelInstrumentAuditions();f.gates[0].resolve();await pending;assert.equal(f.events.filter(e=>e[0]==='on').length,0);assert.equal(f.ctx.samplePreview,null);
});

test('new sampler preview supersedes older preparation and uses a separate live-note owner',async()=>{
 const f=await fixture(),old=f.ctx.auditionSample(f.track),latest=f.ctx.auditionSample(f.track);f.gates[1].resolve();await latest;const player=f.ctx.samplePreview;f.gates[0].resolve();await old;
 assert.equal(f.events.filter(e=>e[0]==='on').length,1);assert.notEqual(player,f.keyboard);assert.equal(player.engine,f.engine);assert.equal(f.ctx.samplePreview,player);
 const keyboardStops=f.events.filter(e=>e[0]==='all-off'&&e[1]===f.keyboard).length;f.ctx.cancelInstrumentAuditions();assert.equal(f.events.filter(e=>e[0]==='all-off'&&e[1]===player).length,1);assert.equal(f.events.filter(e=>e[0]==='all-off'&&e[1]===f.keyboard).length,keyboardStops);
});

test('Stop Audition force-releases a real one-shot sampler voice instead of an ignored note-off',async()=>{
 const f=await fixture({realNotes:true}),pending=f.ctx.auditionSample(f.track);f.gates[0].resolve();await pending;assert.equal(f.nodes.length,1);assert.equal(f.events.filter(e=>e[0]==='force-stop').length,0);
 f.ctx.cancelInstrumentAuditions();assert.ok(f.events.some(e=>e[0]==='force-stop'&&e[1]===.015));assert.equal(f.ctx.samplePreview,null);
});

test('changed project, engine, instrument, selection or transport generation invalidates a delayed preview',async()=>{
 for(const mode of ['project','engine','instrument','selection','transport','playing']){
  const f=await fixture(),pending=f.ctx.auditionSample(f.track);
  if(mode==='project')f.ctx.project=structuredClone(f.project);else if(mode==='engine')f.ctx.engine={...f.engine};else if(mode==='instrument')f.track.instrument={...f.track.instrument};else if(mode==='selection')f.controls['device-chain'].dataset.track='other';else if(mode==='transport')f.engine.playGeneration++;else f.engine.playing=true;
  f.gates[0].resolve();await pending;assert.equal(f.events.filter(e=>e[0]==='on').length,0,mode);
 }
});

test('cancelled preparation errors stay quiet but a current decoder failure remains visible',async()=>{
 const f=await fixture(),old=f.ctx.auditionSample(f.track);f.ctx.cancelInstrumentAuditions();f.gates[0].reject(Error('Old Failure'));await old;
 const current=f.ctx.auditionSample(f.track),rejected=assert.rejects(current,/Current Failure/);f.gates[1].reject(Error('Current Failure'));await rejected;
});

test('rapid drum pad clicks keep each requested pitch even if preparation completes out of order',async()=>{
 const f=await fixture({drums:true}),before=structuredClone(f.project),kick=f.ctx.auditionDrumPad(f.track,36),hat=f.ctx.auditionDrumPad(f.track,42);f.gates[1].resolve();await hat;f.gates[0].resolve();await kick;
 assert.deepEqual(f.events.filter(e=>e[0]==='on').map(e=>e[2]),[42,36]);assert.equal(f.ctx.drumPad,42);assert.deepEqual(f.project,before);
});

test('delayed drum clicks cannot enter a newly started take or a finished take',async()=>{
 for(const started of [false,true]){
  const f=await fixture({drums:true});if(started){f.ctx.midiTake={held:new Map()};f.ctx.inputCaptureId='first';}const pending=f.ctx.auditionDrumPad(f.track,36);
  if(started){f.ctx.midiTake=null;f.ctx.inputCaptureId=null;}else{f.ctx.midiTake={held:new Map()};f.ctx.inputCaptureId='new';}
  f.gates[0].resolve();await pending;assert.equal(f.events.filter(e=>['on','input'].includes(e[0])).length,0);
 }
});

test('drum clicks during the same take record their captured pitches through the existing input path',async()=>{
 const f=await fixture({drums:true});f.ctx.midiTake={held:new Map()};f.ctx.inputCaptureId='take';const first=f.ctx.auditionDrumPad(f.track,36),second=f.ctx.auditionDrumPad(f.track,42);f.gates[0].resolve();await first;f.gates[1].resolve();await second;
 assert.deepEqual(f.events.filter(e=>e[0]==='input'&&e[1]==='on').map(e=>e[3]),[36,42]);assert.equal(f.events.filter(e=>e[0]==='on').length,0);
});

test('global note release cancels pending pads and previews, and invalid pads do not prepare',async()=>{
 const f=await fixture({drums:true}),pending=f.ctx.auditionDrumPad(f.track,36);f.ctx.releaseNotes();f.gates[0].resolve();await pending;assert.equal(f.events.filter(e=>e[0]==='on').length,0);await f.ctx.auditionDrumPad(f.track,99);assert.equal(f.gates.length,1);
});

test('actual Stop Audition button invokes cancellation while the loading request remains pending',async()=>{
 const f=await fixture();let click;f.ctx.$=id=>id==='instrument'?{addEventListener:(_,fn)=>click=fn}:f.controls[id];f.ctx.run=fn=>fn;
 const start=source.indexOf("$('instrument').addEventListener('click',run(async e=>{if(e.target.id==='sample-audition-stop')");vm.runInContext(source.slice(start,source.indexOf('\n',start)),f.ctx);
 const pending=f.ctx.auditionSample(f.track);await click({target:{id:'sample-audition-stop'}});f.gates[0].resolve();await pending;assert.equal(f.events.filter(e=>e[0]==='on').length,0);
});
