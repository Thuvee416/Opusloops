const {test}=require('node:test'),assert=require('node:assert/strict');
const api=async()=>({...await import('../web-studio/stem-import.js'),...await import('../web-studio/project-import.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js'),...await import('../web-studio/audio.js')});
const source=(name,duration)=>({name,duration,bytes:new Uint8Array([82,73,70,70,1,2,3,4]).buffer,buffer:{duration,length:Math.round(duration*44100),numberOfChannels:2,sampleRate:44100}});
test('stems create independent new tracks at an identical start without rounding their durations or changing existing music',async()=>{
 const t=await api(),p=t.emptyProject(),before=structuredClone(p),sources=[source('Drums',8.12345),source('Bass',7.98765)],r=t.prepareStemImport(p,sources,{start:12.125});assert.deepEqual(p,before);assert.deepEqual(r.next.tracks[0],p.tracks[0]);assert.equal(r.next.tracks.length,3);assert.equal(r.imports.length,2);
 for(const [i,item]of r.imports.entries()){const region=r.next.arrangement.find(x=>x.id===item.regionId),track=r.next.tracks.find(x=>x.id===item.trackId);assert.equal(region.start,12.125);assert.equal(region.length,sources[i].duration*2);assert.equal(item.clip.sourceBpm,120);assert.equal(item.clip.beats,region.length);assert.equal(track.name,sources[i].name);assert.ok(track.slots.every(x=>x===null));assert.equal(Buffer.from(item.clip.data,'base64').compare(Buffer.from(sources[i].bytes)),0);assert.equal(track.instrument,undefined);}
 t.validateProject(JSON.parse(JSON.stringify(r.next)));
});
test('long audio uses its full duration while MIDI and generated clip limits remain unchanged',async()=>{
 const t=await api(),p=t.emptyProject();p.bpm=240;const r=t.prepareStemImport(p,[source('Five Minutes',300)],{start:100});assert.equal(r.imports[0].clip.beats,t.AUDIO_MAX_BEATS);assert.equal(r.next.arrangement[0].length,1200);t.validateProject(r.next);
 const invalid=structuredClone(r.next),id=r.imports[0].clip.id;invalid.clips[id]={...invalid.clips[id],kind:'midi',notes:[]};assert.throws(()=>t.validateProject(invalid));
 for(const seconds of [.001,0,301,NaN])assert.throws(()=>t.prepareStemImport(p,[source('Invalid',seconds)]));assert.throws(()=>t.prepareStemImport(p,[source('Too Late',300)],{start:16000}));
});
test('real engine scheduling starts every imported stem together at rate one and keeps its exact end',async()=>{
 const t=await api(),p=t.emptyProject();p.bpm=127;const sources=[source('A',137.12345),source('B',122.98765)],r=t.prepareStemImport(p,sources,{start:16}),e=new t.Engine(r.next,()=>{}),nodes=[],ctx={currentTime:0,createBufferSource(){const node={playbackRate:{},connect(){},disconnect(){},start(...args){this.started=args;},stop(at){this.stopped=at;}};nodes.push(node);return node;}},target={};
 for(const item of r.imports){e.buffers.set(item.clip.id,{buffer:item.buffer});const region=r.next.arrangement.find(x=>x.id===item.regionId);e.schedule(ctx,target,item.clip,region.start*60/p.bpm,0,region.length,item.trackId,region.id);}
 assert.equal(nodes.length,2);for(let i=0;i<2;i++){assert.equal(nodes[i].playbackRate.value,1);assert.deepEqual(nodes[i].started,[16*60/127,0]);assert.ok(Math.abs(nodes[i].stopped-nodes[i].started[0]-sources[i].duration)<1e-10);}
});
test('capacity, raw-byte and portable-project limits reject before any reads or project mutations',async()=>{
 const t=await api(),p=t.emptyProject(),before=JSON.stringify(p),file={size:1024};assert.equal(t.stemImportRequest(p,[file],0).count,1);
 for(const files of [[],Array(16).fill(file),[{size:0}],[{size:t.STEM_FILE_BYTES+1}],Array(2).fill({size:60*1024*1024})])assert.throws(()=>t.stemImportRequest(p,files,0));assert.throws(()=>t.stemImportRequest(p,[file],NaN));assert.equal(JSON.stringify(p),before);
 // UTF-8 project size is checked, not only the sum of the newly selected file sizes.
 const oversized={...p,name:'x'.repeat(20*1024*1024)};assert.throws(()=>t.stemImportRequest(oversized,[{size:50*1024*1024},{size:50*1024*1024}],0),/Stem Import Project Budget/);
});
test('batch decode is sequential, reports progress and stops on cancellation, stale context or a later unreadable file',async()=>{
 const t=await api(),file=n=>({name:n+'.wav',size:8,arrayBuffer:async()=>new ArrayBuffer(8)}),files=[file('A'),file('B')],progress=[];let reads=0,checks=0;const decoded=await t.readStemFiles(files,async()=>{reads++;return source('',2).buffer;},{check:()=>checks++,onProgress:p=>progress.push(p.name)});assert.equal(decoded.length,2);assert.equal(reads,2);assert.equal(checks,4);assert.deepEqual(progress,['A.wav','B.wav']);
 const controller=new AbortController();reads=0;await assert.rejects(()=>t.readStemFiles(files,async()=>{reads++;controller.abort();return source('',2).buffer;},{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(reads,1);
 reads=0;await assert.rejects(()=>t.readStemFiles(files,async()=>{reads++;if(reads===2)throw Error('Unreadable');return source('',2).buffer;}),/Unreadable/);assert.equal(reads,2);
 reads=0;await assert.rejects(()=>t.readStemFiles(files,async()=>{reads++;return source('',2).buffer;},{check:()=>{throw Error('Changed');}}),/Changed/);assert.equal(reads,0);
});
test('decoded audio memory is bounded and ordinary single-file import retains its existing size policy',async()=>{
 const t=await api(),file={name:'Large.wav',size:31*1024*1024,arrayBuffer:async()=>new ArrayBuffer(8)};await assert.rejects(()=>t.readAudioImport(file,()=>assert.fail()),/30 MB/);
 await assert.rejects(()=>t.readStemFiles([file],async()=>({duration:1,length:t.STEM_DECODED_BYTES,numberOfChannels:2})),/512 MB/);
 const r=await t.readStemFiles([file],async()=>source('',1).buffer);assert.equal(r.length,1);
});
test('a complete stem batch is one Undo and Redo and stale same-byte history changes reject before commit',async()=>{
 const t=await api(),{coreSongProject}=await import('./fixtures/core-song-project.mjs'),p=coreSongProject().project,h=new t.History(p),before=JSON.stringify(p),binding=t.importBinding(p,3),r=t.prepareStemImport(p,[source('Drums',130.123),source('Bass',130.456)],{start:4});t.assertImportCurrent(binding,p,3);assert.throws(()=>t.assertImportCurrent(binding,p,5));h.commit(r.next);assert.equal(h.past.length,1);assert.equal(JSON.stringify(h.undo()),before);assert.deepEqual(h.redo(),r.next);t.validateProject(JSON.parse(JSON.stringify(r.next)));
});
test('ordinary and Odesa single-file imports also preserve original speed and long-file duration',async()=>{
 const t=await api(),p=t.emptyProject();p.bpm=127;for(const seconds of [8.12345,137.12345,300]){const r=t.prepareAudioImport(p,source('Natural',seconds));assert.equal(r.clip.sourceBpm,127);assert.equal(r.clip.beats,seconds*127/60);assert.equal(r.clip.beats*60/127,seconds);t.validateProject(r.next);}
 const short=t.prepareAudioImport(p,source('Short',.1));assert.equal(short.clip.sourceBpm,127);assert.equal(short.clip.beats,.25);assert.equal(Buffer.from(short.clip.data,'base64').compare(Buffer.from(source('Short',.1).bytes)),0);
});
