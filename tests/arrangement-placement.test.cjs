const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function setup(){const api={...await import('../web-studio/arrangement-placement.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js'),...await import('../web-studio/agent-actions.js')};const p=api.emptyProject(),t=p.tracks[0];p.clips.c={id:'c',name:'Phrase',kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60,start:0,duration:1,velocity:.5}]};t.slots[0]='c';return {...api,p,selection:{trackId:t.id,clipId:'c',scene:0}};}
test('append builds a validated candidate at the next quarter beat and preserves media, placement and history',async()=>{
 const t=await setup(),{p,selection}=t;p.arrangement=[{id:'old',trackId:selection.trackId,clipId:'c',start:0,length:4.1,offset:0}];const before=structuredClone(p),result=t.appendArrangementClip(p,selection),h=new t.History(p);assert.deepEqual(result.region,{id:result.region.id,trackId:selection.trackId,clipId:'c',start:4.25,length:4,offset:0});assert.equal(result.project.clips,p.clips);assert.deepEqual(p,before);h.commit(result.project);assert.deepEqual(h.undo(),before);assert.deepEqual(h.redo(),result.project);t.validateProject(JSON.parse(JSON.stringify(result.project)));
});
test('exact timeline end succeeds and overflow rejects before changing the project',async()=>{
 const t=await setup(),{p,selection}=t;p.arrangement=[{id:'old',trackId:selection.trackId,clipId:'c',start:16376,length:4,offset:0}];const first=t.appendArrangementClip(p,selection);assert.equal(first.region.start+first.region.length,16384);const before=structuredClone(first.project);assert.throws(()=>t.appendArrangementClip(first.project,selection),/16,384/);assert.deepEqual(first.project,before);
});
test('region-cap rejection preserves a valid full project and does not discard sources',async()=>{
 const t=await setup(),{p,selection}=t;p.arrangement=Array.from({length:10000},(_,i)=>({id:'r'+i,trackId:selection.trackId,clipId:'c',start:i,length:1,offset:0}));t.validateProject(p);const before=JSON.stringify(p);assert.throws(()=>t.appendArrangementClip(p,selection),/10,000/);assert.equal(JSON.stringify(p),before);
});
test('shared Session sources retain the selected placement activation and stale slots reject',async()=>{
 const t=await setup(),{p,selection}=t;p.tracks[0].slots[1]='c';p.tracks[0].inactiveSlots=[1];assert.equal(t.appendArrangementClip(p,selection).region.active,undefined);assert.equal(t.appendArrangementClip(p,{...selection,scene:1}).region.active,false);
 for(const patch of [{scene:2},{scene:-1},{scene:NaN},{clipId:'missing'},{trackId:'missing'}])assert.throws(()=>t.appendArrangementClip(p,{...selection,...patch}));
 p.tracks[0].slots.fill(null);delete p.tracks[0].inactiveSlots;assert.throws(()=>t.appendArrangementClip(p,{trackId:selection.trackId,clipId:'c'}),/Belongs/);p.arrangement=[{id:'r',trackId:selection.trackId,clipId:'c',start:0,length:4,offset:1}];assert.equal(t.appendArrangementClip(p,{trackId:selection.trackId,clipId:'c'}).region.start,4);
});
test('Odesa new and resized regions reject overflow atomically while exact-boundary regions export',async()=>{
 const t=await setup(),{p,selection}=t,before=structuredClone(p),region={trackId:selection.trackId,clipId:'c',start:16380,length:4};
 const good=t.applyAgentActions(p,[{type:'region',args:region}]);assert.equal(good.arrangement.length,1);for(const args of [{...region,start:16384},{...region,length:5},{...region,start:-1},{...region,length:0}])assert.throws(()=>t.applyAgentActions(p,[{type:'project',args:{bpm:130}},{type:'region',args}]),/timeline limit|valid OPUS LOOPS/);assert.deepEqual(p,before);
 for(const args of [{id:good.arrangement[0].id,start:16381},{id:good.arrangement[0].id,length:5}])assert.throws(()=>t.applyAgentActions(good,[{type:'region',args}]),/timeline limit|valid OPUS LOOPS/);
 const {prepareMidiDelivery}=await import('../web-studio/midi-delivery.js');assert.equal(prepareMidiDelivery(good,{range:{start:16380,length:4}}).delivery.noteCount,1);
});
test('legacy out-of-range content remains readable, removable and repairable without losing the saved source',async()=>{
 const t=await setup(),{p,selection}=t;p.arrangement=[{id:'legacy',trackId:selection.trackId,clipId:'c',start:16384,length:4,offset:0}];t.validateProject(p);
 assert.deepEqual(t.validateProject(JSON.parse(JSON.stringify(p))),p);assert.equal(t.applyAgentActions(p,[{type:'region',args:{id:'legacy',start:16380}}]).arrangement[0].start,16380);assert.equal(t.applyAgentActions(p,[{type:'region',args:{id:'legacy',remove:true}}]).arrangement.length,0);assert.deepEqual(t.applyAgentActions(p,[{type:'region',args:{id:'legacy',start:16380}}]).clips,p.clips);
});
test('actual Add Selected Clip handler installs once only after validation and retains history/selection on failure',async()=>{
 const t=await setup(),source=fs.readFileSync('web-studio/app.js','utf8'),line=source.split('\n').find(l=>l.startsWith("$('add-to-arrangement').onclick="));
 for(const mode of ['success','limit','busy','install-failure']){const p=structuredClone(t.p);if(mode==='limit')p.arrangement=[{id:'full',trackId:t.selection.trackId,clipId:'c',start:16380,length:4,offset:0}];const before=structuredClone(p),history=new t.History(p),button={};let installs=0,commits=0;const ctx={project:p,selection:t.selection,selectedRegion:'original',regionSelection:new Set(),timeSelection:{clear(){}},appendArrangementClip:t.appendArrangementClip,stopToEdit(){},navigationLocked:()=>mode==='busy',installManagedProject(next){if(mode==='install-failure')throw Error('Graph Failure');installs++;ctx.project=next;},render(){},changed(){commits++;history.commit(ctx.project);},setStatus(){},run:f=>f,$:()=>button};vm.createContext(ctx);vm.runInContext(line,ctx);
  if(mode==='success'){button.onclick();assert.equal(installs,1);assert.equal(commits,1);assert.equal(ctx.regionSelection.size,1);assert.deepEqual(history.undo(),before);}
  else{assert.throws(()=>button.onclick());assert.equal(commits,0);assert.equal(ctx.selectedRegion,'original');assert.deepEqual(ctx.project,before);assert.equal(history.past.length,0);}
 }
});
