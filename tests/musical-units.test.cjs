const {test}=require('node:test');
const assert=require('node:assert/strict');
const units=()=>import('../web-studio/musical-units.js');

test('musical positions, durations and relative gain have independent explicit units',async()=>{
 const {musicalPosition:position,musicalDuration:duration,musicalDelta:delta,musicalGain:gain}=await units();
 assert.equal(position({bar:9}),32);assert.equal(position({bar:2,beat:3.5}),6.5);assert.equal(position({beat:1}),0);
 assert.equal(duration({bars:4}),16);assert.equal(duration({beats:.5}),.5);assert.equal(delta({bars:-.5}),-2);
 assert.equal(gain(.7,{relativeDb:-3}),.7*10**(-3/20));assert.equal(gain(.7,{db:-6}),10**(-6/20));assert.equal(gain(.7,{linear:0}),0);
 assert.equal(position(9),9);assert.equal(duration(4),4);assert.equal(gain(.7,.4),.4); // Legacy values never change meaning.
 for(const bad of [{bar:0},{bar:1.5},{bar:1,beat:5},{beat:0},{bar:2,seconds:1},{}])assert.throws(()=>position(bad));
 for(const bad of [{bars:4,beats:1},{bars:-1},{seconds:1},{beats:Infinity},{}])assert.throws(()=>duration(bad));
 for(const bad of [{db:-3,linear:.7},{relativeDb:6},{relativeDb:NaN},{value:.5}])assert.throws(()=>gain(.7,bad));
});

test('a compound four-bar production request compiles without model conversion arithmetic and keeps one Undo',async()=>{
 const {coreSongProject}=await import('./fixtures/core-song-project.mjs'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),{History}=await import('../web-studio/history.js');
 const {project}=coreSongProject(),before=structuredClone(project),history=new History(project);
 const actions=[
  {type:'add_track',args:{name:'Core Lead',kind:'original',ref:'$lead'}},
  {type:'midi',args:{trackId:'$lead',ref:'$phrase',name:'Core Phrase',sceneNumber:3,beats:{bars:4},notes:[60,64,67,71].map((pitch,i)=>({pitch,start:{bar:i+1,beat:1},duration:{beats:.5},velocity:.7}))}},
  {type:'region',args:{trackId:'$lead',clipId:'$phrase',start:{bar:9},length:{bars:4},offset:{beats:0}}},
  {type:'track',args:{id:'bass',changes:{volume:{relativeDb:-3}}}},
  {type:'track',args:{id:'keys',changes:{pan:.2}}},
  {type:'project',args:{bpm:128}}
 ];
 const originalActions=structuredClone(actions),plan=prepareAgentPlan(project,actions),lead=plan.next.tracks.at(-1),clip=plan.next.clips[lead.slots[2]],region=plan.next.arrangement.at(-1);
 assert.equal(lead.name,'Core Lead');assert.equal(lead.instrument,undefined);assert.equal(clip.name,'Core Phrase');assert.equal(clip.beats,16);
 assert.deepEqual(clip.notes.map(n=>[n.pitch,n.start,n.duration,n.velocity]),[[60,0,.5,.7],[64,4,.5,.7],[67,8,.5,.7],[71,12,.5,.7]]);
 assert.equal(region.clipId,clip.id);assert.equal(region.start,32);assert.equal(region.length,16);assert.equal(region.offset,0);
 assert.equal(plan.next.tracks.find(t=>t.id==='bass').volume,before.tracks.find(t=>t.id==='bass').volume*10**(-3/20));
 assert.equal(plan.next.tracks.find(t=>t.id==='keys').pan,.2);assert.equal(plan.next.bpm,128);
 assert.deepEqual(plan.next.clips.drums,before.clips.drums);assert.deepEqual(plan.next.arrangement.slice(0,-1),before.arrangement);
 for(const t of before.tracks){const expected=structuredClone(t);if(t.id==='bass')expected.volume*=10**(-3/20);if(t.id==='keys')expected.pan=.2;assert.deepEqual(plan.next.tracks.find(n=>n.id===t.id),expected);}
 assert.deepEqual(project,before);assert.deepEqual(actions,originalActions);history.commit(plan.next);assert.deepEqual(history.undo(),before);assert.equal(history.undo(),null);assert.deepEqual(history.redo(),plan.next);
});

test('ambiguous musical units and impossible gain reject the complete candidate without changing the project',async()=>{
 const {emptyProject}=await import('../web-studio/model.js'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js');const p=emptyProject(),before=structuredClone(p),id=p.tracks[0].id;
 for(const tail of [
  {type:'track',args:{id,changes:{volume:{relativeDb:12}}}},
  {type:'project',args:{transport:{loopStart:{bar:0}}}},
  {type:'time',args:{operation:'insert',start:{bar:2},length:{bars:1,beats:4}}},
  {type:'add_track',args:{name:'Wrong Voice',kind:'original',preset:'Init'}},
  {type:'instrument',args:{trackId:id,kind:'imaginary'}}
 ]){assert.throws(()=>prepareAgentPlan(p,[{type:'project',args:{bpm:128}},tail]));assert.deepEqual(p,before);}
});

test('Original tone selection resets an existing synth through the same manual/agent constructor',async()=>{
 const {instrumentChoice}=await import('../web-studio/instrument-choice.js'),{applyAgentActions}=await import('../web-studio/agent-actions.js'),{emptyProject}=await import('../web-studio/model.js');
 const p=emptyProject(),id=p.tracks[0].id;p.tracks[0].instrument=instrumentChoice('poly','Warm bass');
 const next=applyAgentActions(p,[{type:'instrument',args:{trackId:id,kind:'original'}}]);assert.equal(next.tracks[0].instrument,instrumentChoice('original'));assert.equal(p.tracks[0].instrument.cutoff,700);
 assert.throws(()=>applyAgentActions(p,[{type:'instrument',args:{trackId:id,kind:'original',params:{wave:'sine'}}}]));
});

test('loop, automation, markers, seek and export ranges share musical coordinates without changing scene addressing',async()=>{
 const {normalizeAgentActions}=await import('../web-studio/agent-addressing.js');
 const actions=normalizeAgentActions([
  {type:'project',args:{transport:{loopStart:{bar:9},loopEnd:{bar:13}}}},
  {type:'automation',args:{trackId:'a',key:'volume',points:[{beat:{bar:2,beat:1},value:.3}]}},
  {type:'locators',args:{items:[{name:'Verse',beat:{bar:5}}]}},
  {type:'command',args:{name:'seek',args:{beat:{beat:17}}}},
  {type:'command',args:{name:'export_wav',args:{range:{start:{bar:9},length:{bars:4}}}}},
  {type:'command',args:{name:'launch_scene',args:{sceneNumber:3}}}
 ]);
 assert.deepEqual(actions[0].args.transport,{loopStart:32,loopEnd:48});assert.equal(actions[1].args.points[0].beat,4);assert.equal(actions[2].args.items[0].beat,16);assert.equal(actions[3].args.args.beat,16);assert.deepEqual(actions[4].args.args.range,{start:32,length:16});assert.equal(actions[5].args.args.scene,2);
 assert.deepEqual(normalizeAgentActions(actions),actions); // Multiple validation passes cannot convert twice.
});

test('Arrangement split keeps source timing and fades, is atomic and shares one Undo with mix edits',async()=>{
 const {coreSongProject}=await import('./fixtures/core-song-project.mjs'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),{History}=await import('../web-studio/history.js'),{editRegionFades,regionGainAt}=await import('../web-studio/region-fades.js');
 const {project:p}=coreSongProject(),r=p.arrangement.find(r=>r.trackId==='drums'&&r.start===32);
 p.arrangement=editRegionFades(p,[r.id],{fadeIn:6,fadeOut:6});const source=structuredClone(p),old=p.arrangement.find(x=>x.id===r.id),h=new History(p);
 const actions=[{type:'region_split',args:{id:r.id,at:{bar:11}}},{type:'device',args:{trackId:'drums',type:'utility',params:{gain:-3}}},{type:'project',args:{transport:{loopEnabled:true,loopStart:{bar:9},loopEnd:{bar:13},metronome:true}}}];
 const next=prepareAgentPlan(p,actions).next,parts=next.arrangement.filter(x=>x.trackId==='drums'&&x.start>=32&&x.start<48);
 assert.equal(parts.length,2);assert.deepEqual(parts.map(x=>[x.start,x.length,x.offset]),[[32,8,0],[40,8,8]]);assert.equal(parts[0].id,r.id);assert.notEqual(parts[1].id,r.id);assert.ok(parts.every(x=>x.clipId===r.clipId));
 for(let t=0;t<16;t+=.125){const piece=t<8?parts[0]:parts[1];assert.ok(Math.abs(regionGainAt(piece,t%8)-regionGainAt(old,t))<1e-12);}
 assert.deepEqual(next.clips,p.clips);assert.equal(next.tracks[0].devices.at(-1).params.gain,-3);assert.equal(next.transport.loopStart,32);assert.equal(next.transport.loopEnd,48);
 h.commit(next);assert.deepEqual(h.undo(),source);assert.deepEqual(h.redo(),next);
 for(const bad of [{id:r.id,at:{bar:9}},{id:r.id,at:{bar:13}},{id:'missing',at:{bar:11}},{id:r.id,at:{bar:11},length:{bars:2}}])assert.throws(()=>prepareAgentPlan(p,[{type:'project',args:{bpm:130}},{type:'region_split',args:bad}]));
 assert.deepEqual(p,source);
});
