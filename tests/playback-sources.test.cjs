const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){
 const [{Engine},{emptyProject,makeTrack},{playbackSources,prunePlaybackBuffers}]=await Promise.all([import('../web-studio/audio.js'),import('../web-studio/model.js'),import('../web-studio/playback-sources.js')]);
 const p=emptyProject();p.tracks[0].id='a';p.tracks.push({...makeTrack('Second'),id:'b'});
 for(const id of ['slot','region','active','pending','loading','unused'])p.clips[id]={id,name:id,kind:'audio',beats:4,sourceBpm:120,data:'AA=='};
 p.tracks[0].slots[0]='slot';p.tracks[1].slots[1]='slot';p.arrangement=[{id:'r',trackId:'b',clipId:'region',start:0,length:4,offset:0,active:false}];
 const e=new Engine(p,()=>{});e.prepareSamples=async()=>{};e.prepareClip=async clip=>{e.buffers.set(clip.id,{buffer:{id:clip.id}});};
 return {p,e,playbackSources,prunePlaybackBuffers};
}
test('playback sources include shared and inactive placements plus current runtime intentions only',async()=>{
 const {e,playbackSources}=await setup();e.active.set('a',{clipId:'active'});e.pending.set('b',{clipId:'pending'});e.launchLoads=new Map([['a',{clipId:'loading',binding:e.launchBinding(['a'])}]]);
 let sources=playbackSources(e);assert.deepEqual([...sources.get('a')],['slot','active','loading']);assert.deepEqual([...sources.get('b')],['slot','region','pending']);
 e.cancelLaunchPreparation(['a']);sources=playbackSources(e);assert.ok(!sources.get('a').has('loading'));e.launchLoads.get('a').binding=e.launchBinding(['a']);e.launchLoads.get('a').signal={aborted:true};assert.ok(!playbackSources(e).get('a').has('loading'));
 e.active.set('missing-track',{clipId:'unused'});e.pending.set('a',{clipId:'missing-source'});assert.ok(![...playbackSources(e).values()].some(ids=>ids.has('unused')||ids.has('missing-source')));
});
test('unused retained sources neither decode nor consume cached stretch budget during preparation',async()=>{
 const {e,p}=await setup(),before=JSON.stringify(p),prepared=[];e.buffers.set('unused',{warped:{length:40000000,numberOfChannels:1}});
 e.prepareClip=async clip=>{prepared.push(clip.id);assert.notEqual(clip.id,'unused');e.checkWarpBudget(clip.id,4000);e.buffers.set(clip.id,{buffer:{}});};
 await e.prepare();assert.deepEqual(prepared,['slot','region']);assert.equal(e.buffers.has('unused'),false);assert.equal(JSON.stringify(p),before);assert.equal(e.preparing,false);
});
test('reusing a retained source prepares it again and still rejects decoding failures',async()=>{
 const {e,p}=await setup();let calls=0;e.prepareClip=async clip=>{if(clip.id==='unused'){calls++;throw Error('Decode Failed');}};
 await e.prepare();assert.equal(calls,0);p.tracks[0].slots[2]='unused';await assert.rejects(e.prepare(),/Decode Failed/);assert.equal(calls,1);assert.equal(e.preparing,false);
 delete p.tracks[0].slots[2];p.tracks[0].slots[2]=null;e.prepareClip=async clip=>{calls++;e.buffers.set(clip.id,{buffer:{}});};await e.prepare();assert.equal(e.buffers.has('unused'),false);assert.ok(p.clips.unused);
});
test('cleanup retains instrument and MIDI-effect ownership without retaining stale legacy caches',async()=>{
 const {e,p,prunePlaybackBuffers}=await setup();p.clips.slot.kind='midi';p.clips.slot.notes=[];p.tracks[0].midiEffects=[{type:'pitch',enabled:true}];p.tracks[1].midiEffects=[{type:'pitch',enabled:true}];p.tracks[1].instrument={type:'synth'};
 const good=JSON.stringify(['a','slot']),instrument=JSON.stringify(['b','slot']),unused=JSON.stringify(['a','unused']);for(const key of [good,instrument,unused])e.midiBuffers.set(key,{buffer:{}});
 prunePlaybackBuffers(e);assert.deepEqual([...e.midiBuffers.keys()],[good]);p.tracks[0].midiEffects=[];prunePlaybackBuffers(e);assert.equal(e.midiBuffers.size,0);
});
test('late completion after placement removal drops stale buffers while preserving a newer concurrent acquisition',async()=>{
 const {e,p}=await setup();let resolve,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>resolve=r);let first=true;
 e.prepareClip=async clip=>{if(first){first=false;entered();await gate;}e.buffers.set(clip.id,{buffer:{id:clip.id}});};
 const old=e.prepare();await ready;p.tracks.forEach(t=>t.slots.fill(null));p.arrangement=[];p.tracks[0].slots[0]='unused';await e.prepare();assert.equal(e.preparing,true);resolve();await old;
 assert.deepEqual([...e.buffers.keys()],['unused']);assert.equal(e.preparing,false);assert.ok(p.clips.slot&&p.clips.region);
});
test('a failed irrelevant in-flight load cannot retain stale cache ownership',async()=>{
 const {e,p}=await setup();let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 e.prepareClip=async clip=>{entered();await gate;e.buffers.set(clip.id,{buffer:{}});throw Error('Old Decode Failed');};const pending=e.prepare();const failed=assert.rejects(pending,/Old Decode Failed/);await ready;p.tracks.forEach(t=>t.slots.fill(null));p.arrangement=[];release();await failed;assert.equal(e.buffers.size,0);assert.equal(e.preparing,false);
});

test('empty slots and stop intentions never become string-like source references',async()=>{
 const {e,p,playbackSources}=await setup();for(const id of ['null','undefined','constructor'])p.clips[id]={id,kind:'audio'};
 e.active.set('a',{clipId:null});e.pending.set('b',{back:true});let sources=playbackSources(e);assert.deepEqual([...sources.get('a')],['slot']);assert.deepEqual([...sources.get('b')],['slot','region']);
 p.tracks[0].slots[2]='null';sources=playbackSources(e);assert.ok(sources.get('a').has('null'));assert.ok(!sources.get('a').has(null));
});
