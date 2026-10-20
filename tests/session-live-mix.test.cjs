const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const api={...await import('../web-studio/model.js'),...await import('../web-studio/audio.js'),...await import('../web-studio/session-batch.js'),...await import('../web-studio/routing.js')};
 const p=api.emptyProject();p.tracks=[api.makeTrack('A'),api.makeTrack('B')];
 for(const [i,t]of p.tracks.entries()){t.id=['a','b'][i];const id='clip-'+t.id;t.slots[0]=id;p.clips[id]={id,name:id,kind:'midi',sourceBpm:120,beats:4,notes:[]};}
 p.returns=[{id:'room',name:'Room',volume:.4,pan:0,mute:false,color:'#c5ae83',devices:[]}];p.tracks[1].sends={room:{amount:.2,pre:false}};p.tracks[1].crossfade='A';
 class Node{constructor(){const param=()=>({value:0,setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},cancelScheduledValues(){}});this.gain=param();this.pan=param();}connect(target){return target;}disconnect(){}}
 const ctx={currentTime:0,sampleRate:44100,createGain:()=>new Node(),createStereoPanner:()=>new Node(),createAnalyser:()=>new Node()};
 const e=new api.Engine(p,()=>{});e.context=ctx;e.master=new Node();e.mixGraph=api.createMixGraph(ctx,p,e.master,{meters:false});e.mixers=e.mixGraph.tracks;e.returnMixers=e.mixGraph.returns;e.playing=true;e.mode='session';e.origin=0;e.clockStart=0;e.nextBeat=.25;
 const candidate=()=>api.editSessionClips(p,{action:'active',slots:[{trackId:'a',scene:0}],active:false}).project;
 return {...api,p,e,candidate};
}
test('live activation retains graph bindings for later Mute, Solo, sends, returns, routing and crossfade',async()=>{
 const {p,e,candidate}=await fixture(),tracks=p.tracks,channels=[...tracks],clips=p.clips,returns=p.returns,graph=e.mixGraph,next=candidate();
 e.applySessionActivation(next);assert.equal(e.project,p);assert.equal(p.tracks,tracks);assert.equal(p.clips,clips);assert.equal(p.returns,returns);assert.equal(e.mixGraph,graph);channels.forEach((t,i)=>assert.equal(p.tracks[i],t));
 assert.deepEqual(p,next);next.tracks[0].inactiveSlots.push(1);assert.deepEqual(p.tracks[0].inactiveSlots,[0]);
 const b=p.tracks[1],m=e.mixers.get('b');
 b.mute=true;e.updateMix();assert.equal(m.gate.gain.value,0);assert.equal(m.preGate.gain.value,0);
 b.mute=false;p.tracks[0].solo=true;e.updateMix();assert.equal(m.input.gain.value,0);
 p.tracks[0].solo=false;b.sends.room.amount=.6;p.returns[0].mute=true;p.crossfade={position:1,curve:'blend'};b.output='sendsOnly';e.updateMix();
 assert.equal(m.input.gain.value,1);assert.equal(m.sends.get('room').post.gain.value,.6);assert.equal(e.returnMixers.get('room').gate.gain.value,0);assert.equal(m.cross.gain.value,0);assert.equal(m.dry.gain.value,0);
 graph.dispose();
});
test('live activation preserves pending preparation, queued events, clock and decoded buffers',async()=>{
 const {p,e,candidate}=await fixture();let release;e.prepare=()=>new Promise(r=>release=r);
 const pending={clipId:'clip-a',beat:4};e.pending.set('a',pending);const buffer={};e.buffers.set('clip-a',buffer);
 const generation=e.playGeneration,context=e.context,origin=e.origin,nextBeat=e.nextBeat,launch=e.launch('b','clip-b',0);
 e.applySessionActivation(candidate());release();const receipt=await launch;
 assert.equal(receipt.interrupted,undefined);assert.equal(e.pending.get('b').clipId,'clip-b');assert.equal(e.pending.get('a'),pending);
 assert.equal(e.playGeneration,generation);assert.equal(e.context,context);assert.equal(e.origin,origin);assert.equal(e.nextBeat,nextBeat);assert.equal(e.buffers.get('clip-a'),buffer);assert.equal(e.project,p);
 e.mixGraph.dispose();
});
test('invalid, mixed or recording-time activation candidates fail before mutation',async()=>{
 const {p,e,candidate}=await fixture(),before=structuredClone(p);
 for(const mutate of [n=>n.bpm++,n=>n.tracks[1].mute=true,n=>n.tracks[0].inactiveSlots=[2],n=>n.tracks[0].inactiveSlots=null]){
  const next=candidate();mutate(next);assert.throws(()=>e.applySessionActivation(next));assert.deepEqual(p,before);
 }
 for(const key of ['recording','automationTake','inputOverdub','inputArrangement']){e[key]=true;assert.throws(()=>e.applySessionActivation(candidate()),/Finish Recording/);e[key]=false;assert.deepEqual(p,before);}
 e.mixGraph.dispose();
});
test('failed live synchronization restores exact flags without replacing the bound project',async()=>{
 const {p,e,candidate}=await fixture(),before=structuredClone(p),tracks=p.tracks;let attempts=0;
 e.syncSessionActivation=()=>{attempts++;throw Error('Audio Synchronization Failed');};
 assert.throws(()=>e.applySessionActivation(candidate()),/Audio Synchronization Failed/);
 assert.equal(attempts,2);assert.deepEqual(p,before);assert.equal(e.project,p);assert.equal(p.tracks,tracks);e.mixGraph.dispose();
});
test('Odesa live activation commits through the same bound project and remains one exact Undo',async()=>{
 const {p,e}=await fixture(),{prepareAgentPlan,runAgentPlan}=await import('../web-studio/agent-runner.js'),{History}=await import('../web-studio/history.js');
 const before=structuredClone(p),history=new History(p),plan=prepareAgentPlan(p,[{type:'session_clips',args:{action:'active',slots:[{trackId:'a',scene:0}],active:false}}]);
 assert.equal(plan.liveSessionActive,true);
 const result=await runAgentPlan(plan,{getProject:()=>p,expected:JSON.stringify(p),locked:()=>false,commit:next=>{e.applySessionActivation(next);history.commit(p);},execute:()=>assert.fail('No transport command expected'),signal:new AbortController().signal});
 assert.equal(result.editsApplied,true);assert.deepEqual(p,plan.next);assert.equal(e.project,p);assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),p);e.mixGraph.dispose();
});
