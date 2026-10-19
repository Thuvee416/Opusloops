const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){const api={...await import('../web-studio/track-mix-actions.js'),...await import('../web-studio/model.js'),...await import('../web-studio/track-groups.js'),...await import('../web-studio/track-routing.js'),...await import('../web-studio/history.js')};const project=api.emptyProject();project.tracks=['a','b','c'].map(id=>({...api.makeTrack(id),id}));return {...api,project};}
function apply(project,plan){for(const edit of plan)project.tracks.find(t=>t.id===edit.id)[edit.key]=edit.value;}
test('selected mixer targets include a clicked member but isolate an unselected click and reject stale IDs',async()=>{
 const t=await setup(),p=t.project;assert.deepEqual(t.trackMixTargets(p,['a','b','a'],{clickedId:'b'}),['a','b']);assert.deepEqual(t.trackMixTargets(p,['a','b'],{clickedId:'c'}),['c']);assert.deepEqual(t.trackMixTargets(p,[],{fallbackId:'b'}),['b']);assert.deepEqual(t.trackMixTargets(p,[],{fallbackId:'missing'}),[]);
 for(const args of [[['missing'],{}],[[],{clickedId:'missing'}]])assert.throws(()=>t.trackMixTargets(p,...args),/Selection Changed/);
});
test('Mute applies one explicit state to the selection and leaves unrelated tracks and all solo flags intact',async()=>{
 const t=await setup(),p=t.project;p.tracks[1].mute=true;p.tracks[2].solo=true;const before=structuredClone(p),plan=t.trackMixPlan(p,{action:'mute',ids:['a','b'],clickedId:'a'});assert.deepEqual(p,before);assert.deepEqual(plan,[{id:'a',key:'mute',value:true}]);apply(p,plan);assert.deepEqual(p.tracks.map(t=>t.mute),[true,true,false]);apply(p,t.trackMixPlan(p,{action:'mute',ids:['a','b']}));assert.deepEqual(p.tracks.map(t=>t.mute),[false,false,false]);assert.deepEqual(p.tracks.map(t=>t.solo),[false,false,true]);
});
test('additive and exclusive Solo preserve selected pairs and turning off a selection does not clear other solos',async()=>{
 const t=await setup(),p=t.project;p.tracks[2].solo=true;apply(p,t.trackMixPlan(p,{action:'solo',ids:['a','b']}));assert.deepEqual(p.tracks.map(t=>t.solo),[true,true,true]);
 apply(p,t.trackMixPlan(p,{action:'solo',ids:['a','b'],exclusive:true}));assert.deepEqual(p.tracks.map(t=>t.solo),[false,false,true]);apply(p,t.trackMixPlan(p,{action:'solo',ids:['a','b'],exclusive:true}));assert.deepEqual(p.tracks.map(t=>t.solo),[true,true,false]);
 p.tracks[1].solo=false;apply(p,t.trackMixPlan(p,{action:'solo',ids:['a','b'],clickedId:'a'}));assert.deepEqual(p.tracks.map(t=>t.solo),[false,false,false]);
});
test('soloed groups retain existing routed audio semantics; Clear All Solos restores all sources without changing routing or mute',async()=>{
 const t=await setup(),p=t.editTrackGroup(t.project,{action:'create',ids:['a','b'],name:'Rhythm'}).project,g=p.tracks[0].id,before=structuredClone(p);p.tracks.find(t=>t.id==='c').mute=true;
 apply(p,t.trackMixPlan(p,{action:'solo',ids:[g],exclusive:true}));assert.deepEqual([...t.routingSoloState(p).own].sort(),['a','b',g].sort());assert.equal(p.tracks.find(t=>t.id==='a').solo,false);
 apply(p,t.trackMixPlan(p,{action:'clear_solos'}));assert.equal(p.tracks.some(t=>t.solo),false);assert.equal(p.tracks.find(t=>t.id==='c').mute,true);assert.deepEqual(p.tracks.map(t=>t.output),before.tracks.map(t=>t.output));assert.equal(t.routingSoloState(p).own.size,p.tracks.length);t.validateProject(p);
});
test('multi-track mixer plan is one history edit with exact complete song restoration and atomic validation',async()=>{
 const t=await setup(),{coreSongProject}=await import('./fixtures/core-song-project.mjs'),p=coreSongProject().project,h=new t.History(p),before=JSON.stringify(p),ids=p.tracks.slice(0,2).map(t=>t.id);apply(p,t.trackMixPlan(p,{action:'solo',ids,exclusive:true}));h.commit(p);const after=JSON.stringify(p);assert.notEqual(after,before);assert.equal(JSON.stringify(h.undo()),before);assert.equal(JSON.stringify(h.redo()),after);t.validateProject(JSON.parse(after));
 for(const intent of [{action:'mute',ids:[]},{action:'solo',ids:[ids[0],'missing']},{action:'solo',ids,clickedId:'missing'},{action:'invalid',ids},{action:'solo',ids,exclusive:'yes'}]){assert.throws(()=>t.trackMixPlan(p,intent));assert.equal(JSON.stringify(p),after);}
});
test('solo preference preserves additive behavior by default and track shortcuts do not intercept editors or MIDI keyboard',async()=>{
 const t=await setup();assert.equal(t.readExclusiveSolo({getItem:()=>null}),false);assert.equal(t.readExclusiveSolo({getItem:()=>{throw Error();}}),false);assert.equal(t.readExclusiveSolo({getItem:()=>'true'}),true);
 const event={code:'KeyS'};assert.equal(t.trackMixShortcut(event,{trackFocus:true}),'solo');assert.equal(t.trackMixShortcut({code:'Digit0'},{trackFocus:true}),'mute');assert.equal(t.trackMixShortcut(event),null);
 for(const key of ['typing','dialog','menu','keyboard'])assert.equal(t.trackMixShortcut(event,{trackFocus:true,[key]:true}),null);
 for(const key of ['repeat','defaultPrevented','isComposing','metaKey','ctrlKey','altKey','shiftKey'])assert.equal(t.trackMixShortcut({...event,[key]:true},{trackFocus:true}),null);
});
