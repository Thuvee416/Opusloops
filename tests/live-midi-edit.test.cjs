const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const [{emptyProject},{newSynth},{applyLiveMidiNotes}]=await Promise.all([import('../web-studio/model.js'),import('../web-studio/instruments.js'),import('../web-studio/live-midi-edit.js')]);
 const p=emptyProject();p.tracks[0].instrument=newSynth();p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60,start:0,duration:4,velocity:.7}]};p.tracks[0].slots[0]='phrase';const revisions=[],ctx={state:'running',sampleRate:44100,currentTime:0,createBuffer(_ch,length){return {length,copyToChannel(){}};}},scheduler={reviseClip(...args){revisions.push(args);}};
 const engine={project:p,context:ctx,playGeneration:1,playing:true,origin:0,nextBeat:.5,buffers:new Map(),midiBuffers:new Map(),voiceSchedulers:new WeakMap([[ctx,scheduler]]),sampleBuffer:()=>null,tick(){throw Error('Unexpected Tick');}};
 return {p,engine,revisions,apply:changes=>applyLiveMidiNotes(engine,changes),notes:[{pitch:64,start:0,duration:4,velocity:.7}]};
}
test('live note transaction preserves project/context/clock identity and validates before scheduling',async()=>{
 const f=await fixture(),owner=f.p,ctx=f.engine.context;await f.apply([{id:'phrase',notes:f.notes}]);assert.equal(f.engine.project,owner);assert.equal(f.engine.context,ctx);assert.equal(f.engine.origin,0);assert.equal(f.engine.nextBeat,.5);assert.deepEqual(f.p.clips.phrase.notes,f.notes);assert.equal(f.revisions.length,1);assert.equal(f.revisions[0].at(-1),.25);assert.equal(f.engine.midiEditPending,false);
 await assert.rejects(f.apply([{id:'phrase',notes:[{...f.notes[0],pitch:200}]}]));assert.deepEqual(f.p.clips.phrase.notes,f.notes);assert.equal(f.revisions.length,1);
});
test('delayed legacy preparation rejects stale playback without changing notes or buffers',async()=>{
 const f=await fixture(),{applyLiveMidiNotes}=await import('../web-studio/live-midi-edit.js');delete f.p.tracks[0].instrument;const before=structuredClone(f.p);let resolve;const pending=applyLiveMidiNotes(f.engine,[{id:'phrase',notes:f.notes}],{render:()=>new Promise(r=>resolve=r)});assert.equal(f.engine.midiEditPending,true);assert.deepEqual(f.p,before);f.engine.playGeneration++;resolve([{key:'base:phrase',pcm:new Float32Array(10)}]);await assert.rejects(pending,/Changed/);assert.deepEqual(f.p,before);assert.equal(f.engine.buffers.size,0);assert.equal(f.engine.midiEditPending,false);
});
test('note-only history classification rejects mixed structural, timing, clip and mixer mutations',async()=>{
 const f=await fixture(),{midiNoteChanges}=await import('../web-studio/live-midi-edit.js'),next=structuredClone(f.p);next.clips.phrase.notes=f.notes;assert.deepEqual(midiNoteChanges(f.p,next),[{id:'phrase',notes:f.notes}]);
 for(const change of [p=>p.bpm++,p=>p.tracks[0].volume=.2,p=>p.clips.phrase.beats++,p=>p.clips.phrase.name='Renamed',p=>delete p.clips.phrase]){const n=structuredClone(next);change(n);assert.equal(midiNoteChanges(f.p,n),null);}assert.equal(midiNoteChanges(f.p,null),null);
});
test('voice revision preserves unchanged voices and other instances while forcing changed one-shot tails off at the boundary',async()=>{
 const {VoiceScheduler,keyedWindowNotes}=await import('../web-studio/voice-scheduler.js'),s=new VoiceScheduler({},120),a={pitch:60,start:0,duration:4,velocity:.7},b={...a,pitch:64},before=keyedWindowNotes([{index:0,note:a},{index:1,note:b}]),after=keyedWindowNotes([{index:0,note:a}]),calls=[];
 for(const [clip,key]of [['phrase',before[0].voiceKey],['phrase',before[1].voiceKey],['other',before[1].voiceKey]]){const v={release:(...args)=>calls.push([clip,key,...args])};s.voiceInfo.set(v,{clipId:clip,voiceKey:key});const set=s.sounding.get('track')||new Set();set.add(v);s.sounding.set('track',set);}
 s.reviseClip('track','phrase',before,after,2);assert.deepEqual(calls,[['phrase',before[1].voiceKey,2,true]]);
 s.reviseClip('track','phrase',after,before,2);assert.deepEqual([...s.revisions.get(JSON.stringify(['track','phrase'])).keys],[before[1].voiceKey]);
});
test('duplicate musical identities remain distinct while array insertion leaves unchanged keys stable',async()=>{
 const {keyedWindowNotes}=await import('../web-studio/voice-scheduler.js'),n={pitch:60,start:0,duration:4,velocity:.7};const a=keyedWindowNotes([{index:0,note:n},{index:1,note:n}]),b=keyedWindowNotes([{index:0,note:{...n,pitch:64}},{index:1,note:n},{index:2,note:n}]);assert.notEqual(a[0].voiceKey,a[1].voiceKey);assert.equal(a[0].voiceKey,b[1].voiceKey);assert.equal(a[1].voiceKey,b[2].voiceKey);
});
