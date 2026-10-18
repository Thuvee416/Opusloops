const {test}=require('node:test'),assert=require('node:assert/strict');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const setup=async()=>({...await import('../web-studio/input.js'),...await import('../web-studio/input-timing.js'),...await import('../web-studio/midi-sustain.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js'),...await import('../web-studio/midi-delivery.js')});
test('queued events keep receipt-time intervals instead of dispatch-time duration',async()=>{
 const t=await setup(),context={currentTime:2.5,state:'running'},take=new t.MidiTake(120,.5);
 take.on('a',60,.8,t.inputEventTime(context,600,2500));take.off('a',t.inputEventTime(context,608,2500),.3);
 const clip=take.finish(2.5);close(clip.notes[0].start,.2);close(clip.notes[0].duration,.016);assert.equal(clip.notes[0].releaseVelocity,.3);
});
test('invalid, future and suspended-context timestamps fall back without mixing clock origins',async()=>{
 const t=await setup(),c={currentTime:7,state:'running'};
 for(const stamp of [undefined,null,NaN,Infinity,-10,0,1001,Date.now()])assert.equal(t.inputEventTime(c,stamp,1000),7);
 assert.equal(t.inputEventTime(c,900,NaN),7);assert.equal(t.inputEventTime({...c,state:'suspended'},900,1000),7);
 assert.equal(t.inputEventTime({...c,currentTime:.01},1,1000),0);close(t.inputEventTime(c,970,1000),6.97);
 assert.throws(()=>t.inputEventTime({currentTime:NaN,state:'running'},1,2));
});
test('sub-sixteenth notes retain real duration across supported tempi and sample rates',async()=>{
 const t=await setup();for(const bpm of [40,120,240])for(const sampleRate of [8000,44100,48000,96000,384000]){
  const take=new t.MidiTake(bpm,2,{sampleRate});take.on('a',60,.5,2.1);take.off('a',2.104,.2);const c=take.finish(2.2);
  close(c.notes[0].duration,.004*bpm/60);assert.ok(c.notes[0].duration<.0625);const p=t.emptyProject();p.bpm=bpm;p.clips[c.id]=c;p.tracks[0].slots[0]=c.id;t.validateProject(p);
 }
});
test('only zero/negative durations use a one-sample floor; closed takes cannot revive or mutate returned data',async()=>{
 const t=await setup(),take=new t.MidiTake(120,0,{sampleRate:96000});take.on('a',60,.6,.2);take.off('a',.1);let c=take.finish(.3);close(c.notes[0].duration,2/96000);const before=structuredClone(c);c.notes[0].pitch=20;assert.deepEqual(take.finish(.5),before);assert.equal(take.on('b',61,.8,.6),false);take.off('a',NaN);assert.equal(take.held.size,0);
 for(const options of [{bpm:0,start:0},{bpm:120,start:-1},{bpm:NaN,start:0},{bpm:120,start:0,sampleRate:0}])assert.throws(()=>new t.MidiTake(options.bpm,options.start,{sampleRate:options.sampleRate??48000}));
});
test('events received before count-in completion stay excluded even when dispatched afterward',async()=>{
 const t=await setup(),take=new t.MidiTake(120,1),c={currentTime:1.2,state:'running'};
 assert.equal(take.on('pre',48,.8,t.inputEventTime(c,990,1200)),false);take.off('pre',1.1);
 assert.equal(take.on('post',60,.7,t.inputEventTime(c,1005,1200)),true);take.off('post',t.inputEventTime(c,1010,1200));const clip=take.finish(1.2);assert.equal(clip.notes.length,1);close(clip.notes[0].start,.01);close(clip.notes[0].duration,.01);
});
test('sustain extends to pedal receipt time and keeps channel-specific release velocities',async()=>{
 const t=await setup(),take=new t.MidiTake(120,0),s=new t.MidiSustain((type,key,pitch,velocity,time)=>type==='on'?take.on(key,pitch,velocity,time):take.off(key,time,velocity));
 s.handle({type:'on',channel:0,pitch:60,velocity:.6},.1);s.handle({type:'on',channel:1,pitch:67,velocity:.7},.1);
 s.handle({type:'sustain',channel:0,down:true},.11);s.handle({type:'off',channel:0,pitch:60,velocity:.2},.115);s.handle({type:'off',channel:1,pitch:67,velocity:.4},.12);s.handle({type:'sustain',channel:0,down:false},.14);
 const c=take.finish(.2);assert.equal(c.notes.length,2);close(c.notes[0].duration,.04);close(c.notes[1].duration,.08);assert.equal(c.notes[0].releaseVelocity,.4);assert.equal(c.notes[1].releaseVelocity,.2);assert.equal(s.held.size,0);
});
test('retrigger, polyphony eviction and reset forward current event time without merging strikes',async()=>{
 const t=await setup(),out=[],s=new t.MidiSustain((...args)=>out.push(args));s.handle({type:'on',channel:0,pitch:60,velocity:.5},.1);s.handle({type:'on',channel:0,pitch:60,velocity:.8},.104);assert.equal(out[1][0],'off');assert.equal(out[1][4],.104);assert.notEqual(out[0][1],out[2][1]);s.reset();assert.equal(out.at(-1).length,4);
 const evicted=[],poly=new t.MidiSustain((...args)=>evicted.push(args));for(let i=0;i<129;i++)poly.handle({type:'on',channel:Math.floor(i/128),pitch:i%128,velocity:.5},i/100);assert.equal(evicted.at(-2)[0],'off');assert.equal(evicted.at(-2)[4],1.28);assert.equal(poly.held.size,128);
});
test('late notes within the last sixteenth are retained; only the final sample boundary rejects input',async()=>{
 const t=await setup(),take=new t.MidiTake(60,0,{sampleRate:48000});assert.equal(take.on('late',60,.5,255.99),true);take.off('late',255.994,.2);assert.equal(take.on('edge',64,.6,256-1/48000),true);assert.equal(take.on('too-late',67,.7,256),false);const c=take.finish(256);assert.equal(c.notes.length,2);close(c.notes[0].duration,.004);assert.equal(c.beats,256);for(const n of c.notes)assert.ok(n.start+n.duration<=256);
});
test('raw short-note Undo, quantized length and project reopen preserve the independent performed take',async()=>{
 const t=await setup(),p=t.emptyProject(),h=new t.History(p),take=new t.MidiTake(120,0,{quantization:{enabled:true,grid:.25,gridMode:'straight',target:'both'}});take.on('a',60,.8,.102);take.off('a',.106,.4);const c=take.finish(.5),raw=structuredClone(p);raw.clips[c.id]=take.rawClip;raw.tracks[0].slots[0]=c.id;h.commit(raw);const q=structuredClone(raw);q.clips[c.id]=c;h.commit(q);close(h.undo().clips[c.id].notes[0].duration,.008);assert.deepEqual(h.undo(),p);assert.deepEqual(h.redo(),raw);assert.deepEqual(h.redo(),q);assert.equal(c.notes[0].duration,.25);t.validateProject(JSON.parse(JSON.stringify(raw)));assert.ok(t.prepareMidiDelivery(raw,{clipId:c.id}).data.byteLength>0);
});

test('reviewed Odesa transform preserves every short-note timestamp and expression field',async()=>{const t=await setup(),{timingProject}=await import('./fixtures/input-timing-project.mjs'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),capture=require('./fixtures/agent-input-timing-plan.json'),p=timingProject(),expected=structuredClone(p);expected.clips['rapid-take'].notes.forEach(n=>{if(n.pitch===60)n.pitch=72;});const result=prepareAgentPlan(p,capture.plan.actions);assert.equal(capture.plan.reviewed,true);assert.deepEqual(result.next,expected);assert.equal(result.before.length+result.after.length,0);});
