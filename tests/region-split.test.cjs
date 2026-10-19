const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){const api={...await import('../web-studio/region-split.js'),...await import('../web-studio/model.js'),...await import('../web-studio/region-fades.js'),...await import('../web-studio/history.js')}, {coreSongProject}=await import('./fixtures/core-song-project.mjs');return {...api,p:coreSongProject().project};}
test('multi-track marker splits preserve all source media, phase, fades and one complete Undo',async()=>{
 const t=await setup(),{p}=t,ids=p.arrangement.filter(r=>r.start===32).map(r=>r.id),audio=p.arrangement.find(r=>r.start===32&&r.trackId==='drums');
 p.arrangement=t.editRegionFades(p,[audio.id],{fadeIn:6,fadeOut:6});p.arrangement.find(r=>r.id===audio.id).active=false;
 const before=structuredClone(p),h=new t.History(p),result=t.splitRegions(p,ids,[40]),next={...p,arrangement:result.arrangement};
 assert.equal(result.splits.length,4);assert.equal(result.selectedIds.length,8);assert.deepEqual(p,before);assert.deepEqual(next.clips,before.clips);assert.deepEqual(next.tracks,before.tracks);
 for(const old of before.arrangement){const group=result.splits.find(s=>s.originalId===old.id);if(!group){assert.deepEqual(next.arrangement.find(r=>r.id===old.id),old);continue;}
  const parts=group.ids.map(id=>next.arrangement.find(r=>r.id===id));assert.deepEqual(parts.map(r=>[r.start,r.length,r.offset]),[[32,8,old.offset],[40,8,old.offset+8]]);assert.ok(parts.every(r=>r.clipId===old.clipId&&r.active===old.active));
  for(let beat=0;beat<old.length;beat+=.125){const part=parts[beat<8?0:1];assert.equal((part.offset+old.start+beat-part.start)%p.clips[old.clipId].beats,(old.offset+beat)%p.clips[old.clipId].beats);assert.ok(Math.abs(t.regionGainAt(part,old.start+beat-part.start)-t.regionGainAt(old,beat))<1e-12);}
 }
 h.commit(next);assert.deepEqual(h.undo(),before);assert.deepEqual(h.redo(),next);
});
test('range split scopes tracks and isolates middle pieces without shifting automation or locators',async()=>{
 const t=await setup(),{p}=t,before=structuredClone(p),target=t.arrangementSplitTarget(p,{range:{start:36,length:8},trackIds:['bass','keys']});
 const result=t.splitRegions(p,target.ids,target.points);assert.equal(result.splits.length,2);
 for(const s of result.splits)assert.deepEqual(s.ids.map(id=>{const r=result.arrangement.find(r=>r.id===id);return [r.start,r.length,r.offset];}),[[32,4,0],[36,8,4],[44,4,12]]);
 assert.deepEqual(p,before);assert.equal(result.arrangement.length,p.arrangement.length+4);
 for(const old of p.arrangement.filter(r=>!target.ids.includes(r.id)))assert.deepEqual(result.arrangement.find(r=>r.id===old.id),old);
 const all=t.arrangementSplitTarget(p,{range:{start:36,length:8}});assert.equal(all.ids.length,4);
});
test('marker uses selected clips or the chosen empty-lane cursor, and leaves non-crossing selections intact',async()=>{
 const t=await setup(),{p}=t,inside=p.arrangement.find(r=>r.trackId==='bass'&&r.start===32),outside=p.arrangement.find(r=>r.trackId==='bass'&&r.start===64);
 const target=t.arrangementSplitTarget(p,{ids:[inside.id,outside.id],trackId:'keys',at:40}),result=t.splitRegions(p,target.ids,target.points);
 assert.equal(result.splits.length,1);assert.ok(result.selectedIds.includes(outside.id));assert.deepEqual(result.arrangement.find(r=>r.id===outside.id),outside);
 assert.deepEqual(t.arrangementSplitTarget(p,{trackId:'bass',at:40}),{ids:[inside.id],points:[40]});
 assert.throws(()=>t.splitRegions(p,[inside.id],[32]),/Inside A Clip/);
});
test('invalid boundaries, sliver pieces, unknown selection and timeline overflow reject atomically',async()=>{
 const t=await setup(),{p}=t,id=p.arrangement.find(r=>r.start===32).id,before=structuredClone(p);
 for(const [ids,points]of [[[id],[32.01]],[[id],[36,36.01]],[[id],[NaN]],[[id],[Infinity]],[[id],[-1]],[[id],[16385]],[[],[40]],[['missing'],[40]],[[id,id],[40]]])assert.throws(()=>t.splitRegions(p,ids,points));
 for(const opts of [{range:{start:-1,length:4}},{range:{start:0,length:0}},{range:{start:0,length:4},trackIds:[]},{range:{start:0,length:4},trackIds:['missing']}])assert.throws(()=>t.arrangementSplitTarget(p,opts));
 assert.deepEqual(p,before);
 const exact=t.splitRegions(p,[id],[32.0625,47.9375]);assert.equal(exact.splits[0].ids.length,3);
});
test('multi-clip split cannot partially exceed the Arrangement region limit',async()=>{
 const t=await setup(),p=t.emptyProject(),trackId=p.tracks[0].id;p.clips.c={id:'c',name:'Notes',kind:'midi',beats:4,sourceBpm:120,notes:[]};
 p.arrangement=Array.from({length:10000},(_,i)=>({id:'r'+i,trackId,clipId:'c',start:i,length:1,offset:0}));t.validateProject(p);const before=JSON.stringify(p);
 assert.throws(()=>t.splitRegions(p,['r0','r1'],[.5,1.5]));assert.equal(JSON.stringify(p),before);
});
test('Odesa existing batched region_split actions use identical source slices and a single history commit',async()=>{
 const t=await setup(),{p}=t,{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),ids=p.arrangement.filter(r=>r.start===32).map(r=>r.id),manual=t.splitRegions(p,ids,[40]);
 const next=prepareAgentPlan(p,ids.map(id=>({type:'region_split',args:{id,at:40}}))).next;
 const clean=rs=>rs.map(({id,...r})=>r);assert.deepEqual(clean(next.arrangement),clean(manual.arrangement));assert.deepEqual(next.clips,p.clips);
 const h=new t.History(p);h.commit(next);assert.deepEqual(h.undo(),p);assert.deepEqual(h.redo(),next);
});

test('actual manual split handler commits once, selects resulting pieces and refuses playback or active gestures',async()=>{
 const t=await setup(),fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
 const functions=source.slice(source.indexOf('function arrangementSplitLocked()'),source.indexOf('const splitSelectionButton='));
 for(const mode of ['edit','playing','starting','gesture','recording','automation','session']){
  const project=structuredClone(t.p),before=structuredClone(project),ids=project.arrangement.filter(r=>r.start===32).map(r=>r.id),history=new t.History(project);let commits=0,clears=0;
  const ctx={splitRegions:t.splitRegions,arrangementSplitTarget:t.arrangementSplitTarget,project,view:mode==='session'?'session':'arrangement',engine:{playing:mode==='playing',startPromise:mode==='starting'?{}:null,recording:mode==='recording',automationTake:mode==='automation'?{}:null},navigationLocked:()=>mode==='gesture',selectedRegion:ids[0],regionSelection:new Set(ids),selection:null,deviceTarget:'drums',timeSelection:{clear:()=>clears++},render:()=>{},changed:()=>{commits++;history.commit(project);},focusRegion:()=>{},setStatus:()=>{}};
  vm.createContext(ctx);vm.runInContext(functions,ctx);
  if(mode==='edit'){ctx.applyArrangementSplit({ids,points:[40]});assert.equal(commits,1);assert.equal(clears,1);assert.equal(ctx.regionSelection.size,8);assert.equal(ctx.selectedRegion,ids[0]);assert.equal(ctx.deviceTarget,null);assert.deepEqual(history.undo(),before);}
  else {assert.throws(()=>ctx.applyArrangementSplit({ids,points:[40]}));assert.equal(commits,0);assert.equal(clears,0);assert.deepEqual(project,before);}
 }
});
