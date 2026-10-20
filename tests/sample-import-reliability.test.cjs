const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function buffer(channels=[[.1,.2,.3,.4]],sampleRate=4){const data=channels.map(c=>Float32Array.from(c));return {length:data[0].length,numberOfChannels:data.length,sampleRate,duration:data[0].length/sampleRate,getChannelData:c=>data[c]};}
async function fixture({pad=false,read,decode,allocate}={}){
 const [{emptyProject,validateProject},{History},{Engine},sampler,drums,{encode64},imports]=await Promise.all(['model','history','audio','sampler','drums','input','project-import'].map(n=>import('../web-studio/'+n+'.js')));
 const project=emptyProject(),track=project.tracks[0],pitch=pad?42:undefined;track.instrument=pad?drums.newDrumRack():{...sampler.newSampler(),name:'Original',data:'AQ==',reverse:true,start:.25,end:.75,root:48,loop:{enabled:true,start:.1,end:.8}};
 if(pad){track.instrument.pads[6].pan=-.3;track.instrument.pads[6].tune=3;}
 const history=new History(project),original=structuredClone(project),raw=buffer([[.1,.2,.3,.4],[-.1,-.2,-.3,-.4]]),counts={decode:0,init:0,commit:0,release:0};
 const audio={decodeAudioData:async bytes=>{counts.decode++;return decode?decode(bytes):raw;},createBuffer:(channels,length,sr)=>{if(allocate)return allocate(channels,length,sr);return buffer(Array.from({length:channels},()=>Array(length).fill(0)),sr);}};
 const engine=new Engine(project,()=>{});engine.context=audio;engine.init=async()=>{counts.init++;};const key=engine.sampleKey(track.id,pitch),cached={data:'AQ==',raw:buffer(),buffer:buffer(),key:'old'};engine.sampleBuffers.set(key,cached);
 const file={name:'New Sample.wav',size:3,arrayBuffer:read??(async()=>Uint8Array.from([2,3,4]).buffer)},controls={'sample-file':{files:[file],value:'selected'},'drum-file':{files:[file],value:'selected'}};
 const ctx={project,engine,busy:false,sessionProjectRevision:0,deviceTrack:id=>ctx.project.tracks.find(t=>t.id===id),stopToEdit(){if(ctx.engine.playing)throw Error('Stop Playback');},renderInstrument(){},renderTransport(){},renderDevices(){},setStatus(){},releaseNotes(){counts.release++;},changed(){counts.commit++;history.commit(ctx.project);ctx.sessionProjectRevision++;},...sampler,...drums,encode64,structuredClone,...imports,$:id=>controls[id],run:fn=>fn};
 vm.createContext(ctx);const start=source.indexOf('async function importInstrumentSample('),end=source.indexOf("\n$('sample-file').onchange",start);vm.runInContext(source.slice(start,end),ctx);
 return {ctx,project,track,pitch,history,original,raw,file,engine,counts,key,cached,controls,validateProject,importBinding:imports.importBinding};
}

test('sampler replacement prepares once, preserves musical settings and commits one reversible project edit',async()=>{
 const f=await fixture();await f.ctx.importInstrumentSample(f.file,f.track.id);assert.equal(f.counts.decode,1);assert.equal(f.counts.commit,1);assert.equal(f.ctx.busy,false);
 const next=f.track.instrument;assert.equal(next.name,f.file.name);assert.equal(next.data,'AgME');assert.equal(next.start,0);assert.equal(next.end,1);assert.equal(next.root,48);assert.equal(next.reverse,true);assert.deepEqual(next.loop,f.original.tracks[0].instrument.loop);
 const cached=f.engine.sampleBuffers.get(f.key);assert.equal(cached.raw,f.raw);assert.deepEqual([...cached.buffer.getChannelData(0)],[...f.raw.getChannelData(0)].reverse());
 await f.engine.prepareSamples();assert.equal(f.counts.decode,1,'normal playback reuses the prepared cache');f.validateProject(f.project);const saved=structuredClone(f.project);assert.deepEqual(f.history.undo(),f.original);assert.deepEqual(f.history.redo(),saved);
});

test('drum sample import changes only the selected pad sound, preserving pad mix, other pads and project state',async()=>{
 const f=await fixture({pad:true});await f.ctx.importInstrumentSample(f.file,f.track.id,f.pitch);const pad=f.track.instrument.pads[6];assert.equal(pad.source,'sample');assert.equal(pad.sample.mode,'oneshot');assert.equal(pad.sample.data,'AgME');assert.equal(pad.pan,-.3);assert.equal(pad.tune,3);
 assert.deepEqual(f.track.instrument.pads.filter((_,i)=>i!==6),f.original.tracks[0].instrument.pads.filter((_,i)=>i!==6));assert.deepEqual(f.engine.sampleBuffers.get(f.key).buffer.getChannelData(1),f.raw.getChannelData(1));await f.engine.prepareSamples();assert.equal(f.counts.decode,1);assert.equal(f.counts.commit,1);assert.deepEqual(f.history.undo(),f.original);
});

test('read, decode and playable-buffer allocation failures retain original sampler or pad, cache and history',async()=>{
 for(const pad of [false,true])for(const stage of ['read','decode','allocate']){
  const f=await fixture({pad,[stage]:()=>{throw Error('Preparation Failed');}});await assert.rejects(f.ctx.importInstrumentSample(f.file,f.track.id,f.pitch),/Preparation Failed/);
  assert.deepEqual(f.project,f.original);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);assert.equal(f.counts.commit,0);assert.equal(f.counts.release,0);assert.equal(f.ctx.busy,false);assert.equal(f.history.past.length,0);
 }
});

test('project stays unchanged while decoding and rejects competing import work',async()=>{
 let resolve;const f=await fixture({decode:()=>new Promise(r=>resolve=r)}),pending=f.ctx.importInstrumentSample(f.file,f.track.id);await flush();assert.equal(f.ctx.busy,true);assert.deepEqual(f.project,f.original);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);
 await assert.rejects(f.ctx.importInstrumentSample(f.file,f.track.id),/Wait For/);resolve(f.raw);await pending;assert.equal(f.counts.commit,1);
});

test('project, engine, instrument replacement and in-place destination changes invalidate pending imports',async()=>{
 for(const change of ['project','engine','instrument','settings','removed']){
  let resolve;const f=await fixture({decode:()=>new Promise(r=>resolve=r)}),pending=f.ctx.importInstrumentSample(f.file,f.track.id);await flush();
  if(change==='project')f.ctx.project=structuredClone(f.project);else if(change==='engine')f.ctx.engine={playing:false};else if(change==='instrument')f.track.instrument=structuredClone(f.track.instrument);else if(change==='settings')f.track.instrument.root=55;else f.project.tracks=[];
  const before=structuredClone(f.project);resolve(f.raw);await assert.rejects(pending,/Destination Changed/);assert.deepEqual(f.project,before);assert.equal(f.counts.commit,0);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);assert.equal(f.ctx.busy,false);
 }
});

test('stale file chooser binding rejects before audio initialization and decoding',async()=>{
 const f=await fixture(),binding=f.importBinding(f.project,0);f.ctx.sessionProjectRevision=1;
 await assert.rejects(f.ctx.importInstrumentSample(f.file,f.track.id,undefined,binding),/changed/i);assert.equal(f.counts.init,0);assert.deepEqual(f.project,f.original);
});

test('oversized files, oversized actual bytes, empty media, long audio and invalid pads reject without mutation',async()=>{
 for(const mode of ['size','bytes','empty','duration','pad']){
  const f=await fixture({pad:mode==='pad',...(mode==='duration'?{decode:async()=>({...buffer(),duration:61})}:{}),...(mode==='bytes'?{read:async()=>new ArrayBuffer(30*1024*1024+1)}:{})});
  if(mode==='size')f.file.size=30*1024*1024+1;if(mode==='empty')f.file.size=0;
  await assert.rejects(f.ctx.importInstrumentSample(f.file,f.track.id,mode==='pad'?90:undefined));assert.deepEqual(f.project,f.original);assert.equal(f.counts.commit,0);assert.equal(f.engine.sampleBuffers.get(f.key),f.cached);
 }
});

test('both actual file input handlers clear the chooser and forward its bound track and pad',async()=>{
 for(const pad of [false,true]){
  const f=await fixture({pad}),id=pad?'drum-file':'sample-file',calls=[],binding=f.importBinding(f.project,0);f.ctx.sampleImportTrack={id:f.track.id,binding};f.ctx.drumImportTarget={track:f.track.id,pitch:f.pitch,binding};f.ctx.importInstrumentSample=async(...args)=>calls.push(args);
  const start=source.indexOf("$('"+id+"').onchange=");vm.runInContext(source.slice(start,source.indexOf('\n',start)),f.ctx);await f.controls[id].onchange();assert.equal(f.controls[id].value,'');assert.deepEqual(calls[0],[f.file,f.track.id,f.pitch,binding]);f.controls[id].files=[];await f.controls[id].onchange();assert.equal(calls.length,1);
 }
});
