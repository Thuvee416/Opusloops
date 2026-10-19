const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){
 const api=await import('../web-studio/recent-sets.js'),{replaceStoredProject}=await import('../web-studio/project-lifecycle.js'),{emptyProject,validateProject}=await import('../web-studio/model.js');
 const store=new Map();let current=emptyProject(),seq=0,fail=false;
 return {...api,store,emptyProject,get current(){return current;},set fail(value){fail=value;},async replace(next,nextId){
  const recent=api.prepareRecentSwitch({index:store.get(api.RECENT_INDEX),current,nextId,createId:()=>`set-${++seq}`,now:()=>seq});
  await replaceStoredProject({current,next,validate:validateProject,write:async entries=>{if(fail)throw Error('Quota exceeded');for(const [key,value]of [...entries,...recent.writes])value===null?store.delete(key):store.set(key,structuredClone(value));},install:p=>{current=p;}});return recent;
 }};
}
test('switching projects keeps latest media, notes, edits and independent same-name identities',async()=>{
 const s=await setup(),{coreSongProject}=await import('./fixtures/core-song-project.mjs');const song=coreSongProject().project;await s.replace(song);s.current.tracks[0].volume=.23;const expected=JSON.stringify(s.current);
 const other=s.emptyProject();other.name=song.name;await s.replace(other);const archived=s.store.get(s.RECENT_INDEX).entries[0];assert.equal(archived.name,other.name);
 await s.replace(s.store.get(s.recentKey(archived.id)),archived.id);assert.equal(JSON.stringify(s.current),expected);
 assert.equal(s.store.get(s.RECENT_INDEX).entries.length,2);assert.equal(s.store.get('previous').name,other.name);
 s.current.name='Updated Song';await s.replace(s.emptyProject());assert.equal(s.store.get(s.RECENT_INDEX).entries[0].id,archived.id);assert.equal(s.store.get(s.RECENT_INDEX).entries[0].name,'Updated Song');
 assert.equal(s.store.get(s.RECENT_INDEX).entries.filter(x=>x.id===archived.id).length,1);
});
test('only five departed sets are retained; eviction never deletes the current or previous backup',async()=>{
 const s=await setup();for(let i=0;i<9;i++){s.current.name=`Song ${i}`;await s.replace(s.emptyProject());}
 const index=s.store.get(s.RECENT_INDEX);assert.equal(index.entries.length,5);assert.deepEqual(index.entries.map(x=>x.name),['Song 8','Song 7','Song 6','Song 5','Song 4']);
 assert.equal([...s.store.keys()].filter(k=>k.startsWith('recent-set:')).length,5);assert.equal(s.store.get('previous').name,'Song 8');assert.deepEqual(s.current,s.store.get('current'));
});
test('storage failure and invalid incoming content preserve all saved sets and current content',async()=>{
 const s=await setup();await s.replace(s.emptyProject());const before=JSON.stringify([...s.store]),current=JSON.stringify(s.current);s.fail=true;
 await assert.rejects(s.replace(s.emptyProject()),/Quota/);assert.equal(JSON.stringify([...s.store]),before);assert.equal(JSON.stringify(s.current),current);s.fail=false;
 await assert.rejects(s.replace({name:'Broken'}));assert.equal(JSON.stringify([...s.store]),before);assert.equal(JSON.stringify(s.current),current);
});
test('stale or malformed recent selections fail without writes',async()=>{
 const s=await setup();await s.replace(s.emptyProject());const before=JSON.stringify([...s.store]);await assert.rejects(s.replace(s.emptyProject(),'missing'),/no longer available/);assert.equal(JSON.stringify([...s.store]),before);
 assert.throws(()=>s.recentIndex({version:1,activeId:'current',entries:[{id:'../current'}]}),/invalid/);
 const value=s.store.get(s.RECENT_INDEX);value.entries.push({...value.entries[0]});assert.throws(()=>s.recentIndex(value),/invalid/);
});
test('the 64 MB budget evicts oldest snapshots, and oversized sets retain the normal Previous Set path',async()=>{
 const s=await setup();const current=s.emptyProject();const index={version:1,activeId:'live',entries:[{id:'older',name:'Older',savedAt:1,bytes:s.RECENT_BYTE_LIMIT,tracks:1,clips:0,bpm:120}]};
 const result=s.prepareRecentSwitch({index,current,createId:()=> 'next'});assert.deepEqual(result.writes.find(([k])=>k===s.RECENT_INDEX)[1].entries.map(x=>x.id),['live']);assert.ok(result.writes.some(([k,v])=>k===s.recentKey('older')&&v===null));
 current.extra='x'.repeat(s.RECENT_BYTE_LIMIT);const large=s.prepareRecentSwitch({index:null,current,createId:(()=>{let n=0;return()=>`id-${++n}`;})()});assert.equal(large.archived,false);assert.equal(large.writes.some(([k])=>k.startsWith('recent-set:')),false);
});
