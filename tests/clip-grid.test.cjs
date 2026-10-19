const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){const api={...await import('../web-studio/clip-grid.js'),...await import('../web-studio/arrangement.js'),...await import('../web-studio/region-clipboard.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js')};const p=api.emptyProject();p.tracks.push(api.makeTrack('Second'));p.clips.a={id:'a',kind:'audio',name:'Take',beats:8,sourceBpm:120,data:'test-local-pcm'};p.clips.m={id:'m',kind:'midi',name:'Phrase',beats:8,sourceBpm:120,notes:[{pitch:60,start:.13,duration:.3,velocity:.7}]};p.arrangement=[{id:'a',trackId:p.tracks[0].id,clipId:'a',start:4.03125,length:4.0625,offset:.125},{id:'m',trackId:p.tracks[1].id,clipId:'m',start:8.03125,length:4.0625,offset:.25}];return {...api,p};}
test('fine and triplet moves retain original fractional alignment, offsets and relative track/timing spacing',async()=>{
 const t=await setup(),before=structuredClone(t.p);
 for(const grid of [.125,.0625,1/3,1/6,1/12,0]){
  const delta=grid||.0137,result=t.editRegionGroup(t.p,['a','m'],'move',{delta,grid});
  for(let i=0;i<2;i++){assert.ok(Math.abs(result.arrangement[i].start-before.arrangement[i].start-delta)<1e-12);assert.equal(result.arrangement[i].offset,before.arrangement[i].offset);assert.equal(result.arrangement[i].length,before.arrangement[i].length);}
  assert.ok(Math.abs(result.arrangement[1].start-result.arrangement[0].start-4)<1e-12);t.validateProject({...t.p,...result});
 }
 assert.deepEqual(t.p,before);
});
test('fine start trim preserves rendered source phase and fixed ends; boundary clamps stay one common delta',async()=>{
 const t=await setup();for(const grid of [.0625,1/3,0]){
  const delta=grid||.0123,result=t.editRegionGroup(t.p,['a','m'],'trim',{edge:'start',delta,grid});
  for(let i=0;i<2;i++){const original=t.p.arrangement[i],next=result.arrangement[i],beat=next.start+.2;
   assert.ok(Math.abs(next.start+next.length-original.start-original.length)<1e-12);
   assert.ok(Math.abs((next.offset+beat-next.start)-(original.offset+beat-original.start))<1e-12);
  }
  assert.equal(result.trim.clamped,false);
 }
 const clamp=t.editRegionGroup(t.p,['a','m'],'trim',{edge:'start',delta:100,grid:1/3});assert.equal(clamp.trim.clamped,true);assert.ok(clamp.arrangement.every(r=>r.length>=t.REGION_MIN_BEATS));
});
test('free and fine duplication and paste preserve independent media, content and exact fractional tails',async()=>{
 const t=await setup(),region=t.p.arrangement[0],copy=t.copyRegion(t.p,'a',region.start+region.length,region.trackId,0);
 assert.equal(copy.region.start,8.09375);assert.equal(copy.clip.data,t.p.clips.a.data);assert.notEqual(copy.clip.id,'a');
 const clipboard=t.copyRegionSelection(t.p,['a','m']),pasted=t.pasteRegionSelection(t.p,clipboard,20.0137,t.p.tracks[0].id,0);
 assert.equal(pasted.arrangement.at(-2).start,20.0137);assert.equal(pasted.end,28.0762);assert.equal(pasted.clips[pasted.arrangement.at(-1).clipId].notes[0].start,.13);
 const grouped=t.editRegionGroup(t.p,['a','m'],'duplicate',{grid:.0625});assert.equal(grouped.arrangement[2].start,12.09375);assert.equal(grouped.arrangement[3].start,16.09375);
});
test('collision and timeline/track limits still reject an entire fine-grid edit, preserving project and history',async()=>{
 const t=await setup(),h=new t.History(t.p);t.p.arrangement.push({...t.p.arrangement[0],id:'block',start:9,length:1});const before=JSON.stringify(t.p);
 for(const action of [()=>t.editRegionGroup(t.p,['a','m'],'move',{delta:1,grid:.0625}),()=>t.editRegionGroup(t.p,['a','m'],'move',{delta:16384,grid:0}),()=>t.editRegionGroup(t.p,['a','m'],'move',{trackOffset:1,grid:1/3}),()=>t.copyRegion(t.p,'a',4.04,t.p.tracks[0].id,0)])assert.throws(action);
 assert.equal(JSON.stringify(t.p),before);assert.equal(h.past.length,0);
 const result=t.editRegionGroup(t.p,['a','m'],'move',{delta:-100,grid:0});assert.equal(result.arrangement[0].start,0);assert.equal(result.arrangement[1].start,4);
});
test('exact numeric clip fields retain sub-grid values; invalid edits cannot mutate content',async()=>{
 const t=await setup(),before=structuredClone(t.p),r=t.editRegionFields(t.p,'a',{start:4.0137,offset:.0137,length:3.987654321});
 assert.equal(r.start,4.0137);assert.equal(r.offset,.0137);assert.equal(r.length,3.987654321);assert.deepEqual(t.p,before);
 for(const patch of [{start:NaN},{offset:-.01},{length:.01},{start:16384},{unknown:1}])assert.throws(()=>t.editRegionFields(t.p,'a',patch));
 const h=new t.History(t.p),next={...t.p,arrangement:t.p.arrangement.map(x=>x.id===r.id?r:x)};h.commit(next);assert.deepEqual(h.undo(),before);assert.deepEqual(h.redo(),next);
});
test('legacy default grid and agent-style edits stay unchanged; unsupported grids and nonfinite deltas reject',async()=>{
 const t=await setup();assert.equal(t.editRegion(t.p.arrangement[0],'move',.13).start,t.p.arrangement[0].start+.25);
 assert.equal(t.editRegionGroup(t.p,['a'],'move',{delta:.13}).arrangement[0].start,t.p.arrangement[0].start+.25);
 assert.throws(()=>t.pasteRegionSelection(t.p,t.copyRegionSelection(t.p,['a']),20.1,t.p.tracks[0].id));
 for(const grid of [-1,NaN,Infinity,.01,'0'])assert.throws(()=>t.snapClipBeat(1,grid));for(const delta of [NaN,Infinity])assert.throws(()=>t.editRegion(t.p.arrangement[0],'move',delta));
});
test('grid preference safely defaults and visual divisions stay bounded without changing musical snap resolution',async()=>{
 const t=await setup();assert.equal(t.readClipGrid({getItem:()=>null}),.25);assert.equal(t.readClipGrid({getItem:()=>{throw Error('storage');}}),.25);assert.equal(t.readClipGrid({getItem:()=> 'garbage'}),.25);assert.equal(t.readClipGrid({getItem:()=> '0'}),0);
 for(const grid of t.CLIP_GRIDS){const ticks=t.clipGridTicks({start:2.25,span:16384,end:16386.25},grid.value);assert.ok(ticks.length<=97);assert.ok(ticks.every(x=>x>=-1e-7&&x<100));}
 assert.equal(t.clipGridTicks({start:0,span:8,end:8},0).length,0);assert.equal(t.clipNudge(0),.0625);assert.equal(t.snapClipBeat(.13,.0625),.125);assert.equal(t.snapClipBeat(.13,0),.13);
});
