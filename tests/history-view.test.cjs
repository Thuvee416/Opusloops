const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){const api={...await import('../web-studio/history-view.js'),...await import('../web-studio/history.js'),...await import('../web-studio/model.js')};const project=api.emptyProject();return {...api,project,history:new api.History(project)};}
test('history rows expose metadata only and map each earlier/later state to exact shared Undo/Redo steps',async()=>{
 const t=await setup(),h=t.history,states=[structuredClone(t.project)];
 for(const bpm of [125,130,135]){const p={...structuredClone(h.current),bpm};h.commit(p);states.push(p);}
 let timeline=t.historyTimeline(h);assert.deepEqual(timeline.entries.map(e=>e.steps),[3,2,1,0]);assert.deepEqual(timeline.entries.map(e=>e.action),['undo','undo','undo',null]);
 const selection=t.historySelection(timeline,1,h);assert.deepEqual(h.move(selection.action,selection.steps),states[1]);
 timeline=t.historyTimeline(h);assert.deepEqual(timeline.entries.map(e=>e.action),['undo',null,'redo','redo']);assert.deepEqual(timeline.entries.map(e=>e.bpm),[120,125,130,135]);
 const redo=t.historySelection(timeline,3,h);assert.deepEqual(h.move(redo.action,redo.steps),states[3]);
 for(const entry of timeline.entries){assert.equal('project'in entry,false);assert.equal('data'in entry,false);assert.equal('notes'in entry,false);}
});
test('grouped changes remain one selectable state and restoring a complete audio/MIDI song is exact',async()=>{
 const t=await setup(),{coreSongProject}=await import('./fixtures/core-song-project.mjs'),p=coreSongProject().project,h=new t.History(p),original=JSON.stringify(p),group=Symbol();
 const edited=structuredClone(p);edited.bpm=128;h.commit(edited,group);edited.tracks[0].volume=.3;edited.arrangement[0].start+=1;h.commit(edited,group);
 const before=JSON.stringify(h),timeline=t.historyTimeline(h);assert.equal(JSON.stringify(h),before);assert.equal(timeline.entries.length,2);assert.match(timeline.entries[1].label,/Tempo/);assert.match(timeline.entries[1].label,/Track Mix/);assert.match(timeline.entries[1].label,/Arrangement/);
 const intent=t.historySelection(timeline,0,h);assert.equal(JSON.stringify(h.move(intent.action,intent.steps)),original);
 assert.equal(JSON.stringify(h.redo()),JSON.stringify(edited));
});
test('stale row cannot target a different edit after Undo/Redo, a new edit or reopening identical content',async()=>{
 const t=await setup(),h=t.history;h.commit({...t.project,bpm:125});const timeline=t.historyTimeline(h);h.undo();h.redo();
 assert.throws(()=>t.historySelection(timeline,0,h),/history changed/);
 const fresh=t.historyTimeline(h);h.commit({...h.current,bpm:130});assert.throws(()=>t.historySelection(fresh,0,h),/history changed/);
 const other=new t.History(t.project);other.commit({...t.project,bpm:125});assert.throws(()=>t.historySelection(timeline,0,other),/history changed/);
});
test('editing after Undo removes future rows and the 40-edit limit keeps the correct oldest available state',async()=>{
 const t=await setup(),h=t.history;for(let i=1;i<=45;i++)h.commit({...h.current,bpm:120+i});
 let timeline=t.historyTimeline(h);assert.equal(timeline.entries.length,41);assert.equal(timeline.entries[0].bpm,125);assert.equal(timeline.entries[0].label,'Oldest Available State');
 h.move('undo',2);h.commit({...h.current,name:'New Branch'});timeline=t.historyTimeline(h);assert.equal(timeline.entries.some(e=>e.action==='redo'),false);assert.equal(timeline.entries.at(-1).name,'New Branch');
});
test('empty history and current/invalid row selections never mutate the project',async()=>{
 const t=await setup(),h=t.history,timeline=t.historyTimeline(h),before=JSON.stringify(h);assert.equal(timeline.entries.length,1);
 for(const index of [0,-1,1,NaN,'0'])assert.throws(()=>t.historySelection(timeline,index,h),/different available/);
 assert.equal(JSON.stringify(h),before);
});
test('edit descriptions distinguish device, Session activation, clip content and automation changes',async()=>{
 const t=await setup(),p=t.project;
 const examples=[['Devices',q=>q.tracks[0].devices=[{id:'fx',type:'utility',params:{gain:3}}]],['Session Clips',q=>q.tracks[0].noStopSlots=[0]],['Clip Content',q=>q.clips.x={kind:'midi',notes:[]}],['Automation',q=>q.tracks[0].automation={volume:{enabled:true,points:[]}}],['Rename Set',q=>q.name='New Title']];
 for(const [label,edit]of examples){const next=structuredClone(p);edit(next);assert.equal(t.historyEditLabel(p,next),label);}
});
