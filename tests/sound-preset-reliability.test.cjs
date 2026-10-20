const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),flush=()=>new Promise(r=>setImmediate(r));
function pcm(values=[.1,.2,.3,.4],rate=4){const data=Float32Array.from(values);return {length:data.length,numberOfChannels:1,sampleRate:rate,duration:data.length/rate,getChannelData:()=>data};}
async function fixture({decode,allocate,read}={}){
 const [{emptyProject,makeTrack,validateProject},{History},{Engine},sampler,drums,sounds,{newSynth},{newDevice}]=await Promise.all(['model','history','audio','sampler','drums','sound-presets','instruments','devices'].map(n=>import('../web-studio/'+n+'.js')));
 const project=emptyProject(),track=project.tracks[0];track.instrument={...sampler.newSampler(),name:'Original',data:'AQ=='};
 const other=makeTrack('Other');project.tracks.push(other);const clip={id:'notes',name:'Keep These Notes',kind:'midi',sourceBpm:120,beats:4,notes:[{pitch:60,start:0,duration:1,velocity:.8}]};project.clips.notes=clip;track.slots[0]='notes';project.arrangement.push({id:'region',trackId:track.id,clipId:'notes',start:0,length:4,offset:0});
 const preset={format:'opus-sound',version:1,name:'Replacement',instrument:{...sampler.newSampler(),data:'Ag==',start:.25,reverse:true},devices:[newDevice('utility')],midiEffects:[]};
 const counts={decode:0,install:0,commit:0},raw=pcm(),audio={decodeAudioData:async b=>{counts.decode++;return decode?decode(b):raw;},createBuffer:(c,n,r)=>allocate?allocate(c,n,r):pcm(Array(n).fill(0),r)};
 const player=p=>{const e=new Engine(p,()=>{});e.context=audio;e.init=async()=>{};return e;},engine=player(project),cached={key:'[0,1,false]',data:'AQ==',raw,buffer:raw};engine.sampleBuffers.set(track.id,cached);
 const history=new History(project),original=structuredClone(project),controls={'device-chain':{dataset:{track:track.id}}};let handler;
 const ctx={project,engine,busy:false,deviceTarget:null,$:id=>controls[id],document:{addEventListener:(event,fn)=>{assert.equal(event,'opus-load-sound');handler=fn;}},run:fn=>fn,stopToEdit(){if(ctx.engine.playing)throw Error('Stop Playback');},renderTransport(){},renderDevices(){},setStatus(message){ctx.status=message;},getSoundPreset:async id=>read?read(id):preset,applySoundPreset:sounds.applySoundPreset,install(next,keepHistory){assert.equal(keepHistory,true);counts.install++;ctx.project=next;ctx.engine=player(next);},changed(){counts.commit++;history.commit(ctx.project);}};
 vm.createContext(ctx);const start=source.indexOf("document.addEventListener('opus-load-sound'"),end=source.indexOf('\nrefreshSoundPresets().catch',start);vm.runInContext(source.slice(start,end),ctx);
 return {ctx,load:()=>handler({detail:'preset-id'}),project,track,other,preset,engine,cached,counts,history,original,raw,controls,validateProject,...sampler,...drums,newSynth,newDevice};
}

test('a broken preset sample cannot replace the current sound or create Undo history',async()=>{
 const f=await fixture({decode:()=>{throw Error('Broken Audio');}});
 await assert.rejects(f.load(),/Broken Audio/);assert.deepEqual(f.ctx.project,f.original);assert.equal(f.ctx.engine,f.engine);assert.equal(f.engine.sampleBuffers.get(f.track.id),f.cached);assert.equal(f.counts.install,0);assert.equal(f.counts.commit,0);assert.equal(f.ctx.busy,false);
});

test('preset loading prepares PCM once and commits the sound with one Undo while preserving the song',async()=>{
 const f=await fixture();await f.load();assert.equal(f.counts.install,1);assert.equal(f.counts.commit,1);assert.equal(f.counts.decode,1);assert.equal(f.ctx.deviceTarget,f.track.id);
 const loaded=f.ctx.project.tracks[0];assert.deepEqual(loaded.instrument,f.preset.instrument);assert.deepEqual(f.ctx.project.clips,f.original.clips);assert.deepEqual(f.ctx.project.arrangement,f.original.arrangement);assert.deepEqual(f.ctx.project.tracks[1],f.original.tracks[1]);assert.deepEqual(loaded.slots,f.track.slots);
 assert.deepEqual([...f.ctx.engine.sampleBuffer(f.track.id).getChannelData(0)],[...f.raw.getChannelData(0)].slice(1).reverse());
 await f.ctx.engine.prepareSamples();assert.equal(f.counts.decode,1,'playback reuses the decoded preset');f.validateProject(f.ctx.project);const saved=structuredClone(f.ctx.project);assert.deepEqual(f.history.undo(),f.original);assert.deepEqual(f.history.redo(),saved);assert.match(f.ctx.status,/Loaded Replacement/);
});

test('a later broken drum pad cannot publish earlier decoded pads or replace effects',async()=>{
 const f=await fixture({decode:bytes=>{if(new Uint8Array(bytes)[0]===3)throw Error('Second Pad Failed');return pcm();}});f.preset.instrument=f.newDrumRack();
 for(const [i,data]of [[0,'Ag=='],[1,'Aw==']]){f.preset.instrument.pads[i].source='sample';f.preset.instrument.pads[i].sample={...f.padSample(),data};}
 const before=f.engine.sampleBuffers;await assert.rejects(f.load(),/Second Pad Failed/);assert.equal(f.counts.decode,2);assert.equal(f.engine.sampleBuffers,before);assert.deepEqual(f.ctx.project,f.original);assert.equal(f.counts.commit,0);assert.equal(f.ctx.busy,false);
});

test('failed storage reads, invalid presets and allocation failure release the lock without installing',async()=>{
 for(const mode of ['read','invalid','allocate']){
  const f=await fixture(mode==='read'?{read:()=>{throw Error('Storage Failed');}}:mode==='allocate'?{allocate:()=>{throw Error('Allocation Failed');}}:{});
  if(mode==='invalid')f.preset.instrument.start=2;
  await assert.rejects(f.load());assert.equal(f.counts.install,0);assert.equal(f.counts.commit,0);assert.deepEqual(f.ctx.project,f.original);assert.equal(f.ctx.busy,false);
 }
});

test('pending load locks competing loads and rejects changed owners, song content and transport',async()=>{
 for(const mode of ['project','engine','track','edit','stop','start']){
  let resolve;const f=await fixture({decode:()=>new Promise(r=>resolve=r)}),pending=f.load();await flush();assert.equal(f.ctx.busy,true);assert.deepEqual(f.ctx.project,f.original);assert.equal(f.counts.install,0);await assert.rejects(f.load(),/current operation/i);
  if(mode==='project')f.ctx.project=structuredClone(f.project);else if(mode==='engine')f.ctx.engine={playing:false};else if(mode==='track')f.project.tracks[0]=structuredClone(f.track);else if(mode==='edit')f.other.volume=.2;else if(mode==='stop')f.engine.playGeneration++;else f.engine.startPromise=Promise.resolve();
  const current=structuredClone(f.ctx.project);resolve(f.raw);await assert.rejects(pending,/Changed|changed/);assert.deepEqual(f.ctx.project,current);assert.equal(f.counts.install,0);assert.equal(f.counts.commit,0);assert.equal(f.engine.sampleBuffers.get(f.track.id),f.cached);assert.equal(f.ctx.busy,false);
 }
});

test('changes while the library reads reject before decoding; selection changes retain the original target',async()=>{
 let resolve;const f=await fixture({read:()=>new Promise(r=>resolve=r)}),pending=f.load();f.other.name='Edited While Loading';resolve(f.preset);await assert.rejects(pending,/Changed|changed/);assert.equal(f.counts.decode,0);assert.equal(f.counts.install,0);
 let finish;const g=await fixture({decode:()=>new Promise(r=>finish=r)}),loading=g.load();await flush();g.controls['device-chain'].dataset.track=g.other.id;finish(g.raw);await loading;assert.deepEqual(g.ctx.project.tracks[0].instrument,g.preset.instrument);assert.equal(g.ctx.project.tracks[1].instrument,undefined);assert.equal(g.ctx.deviceTarget,g.track.id);
});

test('synth and original-tone presets need no audio decode and cannot retain obsolete sampler caches',async()=>{
 for(const synth of [true,false]){
  const f=await fixture();if(synth)f.preset.instrument=f.newSynth();else delete f.preset.instrument;
  await f.load();assert.equal(f.counts.decode,0);assert.equal(f.ctx.engine.sampleBuffers.has(f.track.id),false);assert.equal(f.counts.commit,1);assert.deepEqual(f.history.undo(),f.original);
 }
});
