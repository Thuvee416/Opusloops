const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),flush=()=>new Promise(r=>setImmediate(r));
function pcm(data=[.1,.2,.3,.4]){const samples=Float32Array.from(data);return {length:samples.length,numberOfChannels:1,sampleRate:4,duration:samples.length/4,getChannelData:()=>samples};}
async function fixture({rack=false,decode,allocate}={}){
 const [{Engine},{emptyProject,makeTrack,validateProject},{History},sampler,drums,synth]=await Promise.all(['audio','model','history','sampler','drums','instruments'].map(n=>import('../web-studio/'+n+'.js')));
 const project=emptyProject(),track=project.tracks[0];track.instrument=rack?drums.newDrumRack():{...sampler.newSampler(),data:'AQ==',name:'Sample'};if(rack){track.instrument.pads[6].source='sample';track.instrument.pads[6].sample={...drums.padSample(),data:'AQ=='};}
 const raw=pcm(),counts={decode:0,allocate:0,commits:0,release:0},engine=new Engine(project,()=>{}),key=engine.sampleKey(track.id,rack?42:undefined),cached={data:'AQ==',key:'[0,1,false]',raw,buffer:raw};engine.sampleBuffers.set(key,cached);engine.sampleBuffers.set('unrelated',{sentinel:true});
 engine.context={decodeAudioData:async bytes=>{counts.decode++;return decode?decode(bytes):raw;},createBuffer:(channels,length,sr)=>{counts.allocate++;if(allocate)return allocate(channels,length,sr);return pcm(Array(length).fill(0));}};engine.init=async()=>{};
 const history=new History(project),original=structuredClone(project),ctx={project,engine,busy:false,validateProject,structuredClone,stopToEdit(){if(ctx.engine.playing)throw Error('Stop Playback');},renderInstrument(){},renderTransport(){},renderDevices(){},releaseNotes(){counts.release++;},changed(){counts.commits++;history.commit(ctx.project);}};
 vm.createContext(ctx);const start=source.indexOf('async function applyInstrumentEdit('),end=source.indexOf("\n$('instrument').addEventListener('change'",start);vm.runInContext(source.slice(start,end),ctx);
 return {ctx,project,track,engine,key,cached,raw,counts,history,original,...sampler,...drums,...synth,makeTrack,validateProject};
}

test('trim and reverse commit prepared PCM with one Undo and preserve other track caches',async()=>{
 const f=await fixture(),other=f.engine.sampleBuffers.get('unrelated'),next={...f.track.instrument,start:.25,reverse:true};await f.ctx.applyInstrumentEdit(f.track,next);
 assert.deepEqual([...f.engine.sampleBuffer(f.track.id).getChannelData(0)],[...f.raw.getChannelData(0)].slice(1).reverse());assert.equal(f.engine.sampleBuffers.get('unrelated'),other);assert.equal(f.counts.decode,0);assert.equal(f.counts.commits,1);assert.equal(f.ctx.busy,false);f.validateProject(f.project);
 const saved=structuredClone(f.project);assert.deepEqual(f.history.undo(),f.original);assert.deepEqual(f.history.redo(),saved);
});

test('sampler and drum trim allocation failures preserve parameters, caches and history',async()=>{
 for(const rack of [false,true]){const f=await fixture({rack,allocate:()=>{throw Error('Allocation Failed');}}),next=structuredClone(f.track.instrument),before=f.engine.sampleBuffers;if(rack)next.pads[6].sample.start=.25;else next.start=.25;
  await assert.rejects(f.ctx.applyInstrumentEdit(f.track,next),/Allocation Failed/);assert.deepEqual(f.project,f.original);assert.equal(f.engine.sampleBuffers,before);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);assert.equal(f.counts.commits,0);assert.equal(f.counts.release,0);assert.equal(f.ctx.busy,false);
 }
});

test('envelope/filter changes reuse PCM and switching instruments removes only the edited track cache',async()=>{
 const f=await fixture(),other=f.engine.sampleBuffers.get('unrelated');await f.ctx.applyInstrumentEdit(f.track,{...f.track.instrument,cutoff:2300,attack:.1});assert.equal(f.counts.allocate,0);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);
 await f.ctx.applyInstrumentEdit(f.track,f.newSynth());assert.equal(f.engine.sampleBuffers.has(f.key),false);assert.equal(f.engine.sampleBuffers.get('unrelated'),other);assert.equal(f.track.instrument.type,'poly');
 await f.ctx.applyInstrumentEdit(f.track,undefined);assert.equal(f.track.instrument,undefined);assert.equal(f.counts.commits,3);f.validateProject(f.project);
});

test('invalid and unchanged instrument candidates never prepare or create an Undo entry',async()=>{
 const f=await fixture();await assert.rejects(f.ctx.applyInstrumentEdit(f.track,{...f.track.instrument,start:.9,end:.2}),/trim/);await f.ctx.applyInstrumentEdit(f.track,structuredClone(f.track.instrument));assert.equal(f.counts.allocate,0);assert.equal(f.counts.commits,0);assert.deepEqual(f.project,f.original);
});

test('pending instrument preparation rejects competing edits and stale project, engine or instrument owners',async()=>{
 for(const mode of ['project','engine','settings','replacement']){
  let resolve;const f=await fixture({decode:()=>new Promise(r=>resolve=r)}),before=f.engine.sampleBuffers,next={...f.track.instrument,data:'Ag=='};
  const pending=f.ctx.applyInstrumentEdit(f.track,next);await flush();assert.deepEqual(f.project,f.original);assert.equal(f.ctx.busy,true);await assert.rejects(f.ctx.applyInstrumentEdit(f.track,next),/Wait For/);
  if(mode==='project')f.ctx.project=structuredClone(f.project);else if(mode==='engine')f.ctx.engine={playing:false};else if(mode==='settings')f.track.instrument.cutoff=300;else f.track.instrument=structuredClone(f.track.instrument);
  const current=structuredClone(f.project);resolve(f.raw);await assert.rejects(pending,/Instrument Changed/);assert.deepEqual(f.project,current);assert.equal(f.engine.sampleBuffers,before);assert.equal(f.counts.commits,0);assert.equal(f.ctx.busy,false);
 }
});

test('full playback preparation publishes no partial caches if a later track fails decoding',async()=>{
 const f=await fixture({decode:bytes=>{if(new Uint8Array(bytes)[0]===3)throw Error('Invalid Audio');return pcm();}}),before=f.engine.sampleBuffers;
 f.track.instrument={...f.track.instrument,data:'Ag=='};const second=f.makeTrack('Second');second.instrument={...f.newSampler(),data:'Aw=='};f.project.tracks.push(second);
 await assert.rejects(f.engine.prepareSamples(),/Invalid Audio/);assert.equal(f.engine.sampleBuffers,before);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);
});

test('an older decoding pass cannot overwrite or prune caches installed by a newer preparation',async()=>{
 let resolve;const f=await fixture({decode:bytes=>new Uint8Array(bytes)[0]===2?new Promise(r=>resolve=r):pcm([.9,.8,.7,.6])});f.track.instrument={...f.track.instrument,data:'Ag=='};
 const old=f.engine.prepareSamples();await flush();f.track.instrument={...f.track.instrument,data:'Aw=='};await f.engine.prepareSamples();const newer=f.engine.sampleBuffers,newBuffer=f.engine.sampleBuffer(f.track.id);
 resolve(f.raw);await assert.rejects(old,/Sources Changed/);assert.equal(f.engine.sampleBuffers,newer);assert.equal(f.engine.sampleBuffer(f.track.id),newBuffer);assert.equal(newer.get(f.key).data,'Aw==');
});

test('full preparation detects in-place source edits and project replacement before cache publication',async()=>{
 for(const mode of ['trim','data','id','project','removed']){
  let resolve;const f=await fixture({decode:()=>new Promise(r=>resolve=r)});f.track.instrument={...f.track.instrument,data:'Ag=='};const before=f.engine.sampleBuffers,pending=f.engine.prepareSamples();await flush();
  if(mode==='trim')f.track.instrument.start=.5;else if(mode==='data')f.track.instrument.data='Aw==';else if(mode==='id')f.track.id='renamed-id';else if(mode==='project')f.engine.project=structuredClone(f.project);else f.project.tracks=[];
  resolve(f.raw);await assert.rejects(pending,/Sources Changed/);assert.equal(f.engine.sampleBuffers,before);
 }
});

test('actual instrument controls forward changes through the staged edit path and respect its busy lock',async()=>{
 const f=await fixture(),calls=[];let handler;Object.assign(f.ctx,{$:id=>id==='instrument'?{addEventListener:(_,fn)=>handler=fn}:{dataset:{track:f.track.id}},deviceTrack:()=>f.track,run:fn=>fn,applyInstrumentEdit:async(track,next)=>calls.push({track,next})});
 const start=source.indexOf("$('instrument').addEventListener('change'");vm.runInContext(source.slice(start,source.indexOf("\n$('instrument').addEventListener('input'",start)),f.ctx);
 await handler({target:{id:'sample-start',value:'50',dataset:{}}});assert.equal(calls[0].next.start,.5);assert.deepEqual(f.project,f.original);assert.equal(f.counts.release,0);
 f.ctx.busy=true;await assert.rejects(handler({target:{id:'sample-start',value:'25',dataset:{}}}),/Wait For/);assert.equal(calls.length,1);
});
