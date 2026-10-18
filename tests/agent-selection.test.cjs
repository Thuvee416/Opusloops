const {test}=require('node:test');const assert=require('node:assert/strict');
const setup=async()=>({...await import('../web-studio/studio-selection.js'),...await import('../web-studio/agent-runner.js'),...await import('./fixtures/agent-selection-project.mjs')});
const command=(name,args)=>({type:'command',args:{name,args}});
test('Session selection requires its owner and disambiguates repeated slots without launching them',async()=>{
 const {selectionIntent,selectionProject}=await setup(),p=selectionProject(),before=structuredClone(p);
 assert.deepEqual(selectionIntent(p,{target:'clip',trackId:'bass',scene:1}),{target:'clip',trackId:'bass',clipId:'riff',scene:1});
 assert.deepEqual(selectionIntent(p,{target:'clip',trackId:'pad',clipId:'chord'}),{target:'clip',trackId:'pad',clipId:'chord',scene:0});
 for(const options of [{target:'clip',trackId:'bass',clipId:'riff'},{target:'clip',trackId:'pad',clipId:'riff'},{target:'clip',trackId:'bass',scene:3},{target:'clip',trackId:'bass',scene:0,clipId:'chord'},{target:'clip',trackId:'room',scene:0},{target:'clip',trackId:'bass',scene:-1},{target:'clip',trackId:'bass',scene:.5}])assert.throws(()=>selectionIntent(p,options));
 assert.deepEqual(p,before);
});
test('Arrangement selection preserves an explicit primary and rejects mixed IDs, duplicates or stale references',async()=>{
 const {selectionIntent,selectionProject}=await setup(),p=selectionProject(),args={target:'regions',ids:['bass-a','pad-a','bass-b'],primaryId:'bass-b'},intent=selectionIntent(p,args);assert.deepEqual(intent,args);args.ids.pop();assert.equal(intent.ids.length,3);
 for(const options of [{target:'regions',ids:[]},{target:'regions',ids:['bass-a','bass-a']},{target:'regions',ids:['bass-a','missing']},{target:'regions',ids:['riff']},{target:'regions',ids:['bass-a'],primaryId:'pad-a'},{target:'regions',ids:['bass-a'],trackId:'bass'}])assert.throws(()=>selectionIntent(p,options));
});
test('track/return devices and all four detail panels use closed navigation arguments',async()=>{
 const {selectionIntent,detailPanelIntent,selectionProject}=await setup(),p=selectionProject();for(const trackId of ['bass','pad','room'])assert.deepEqual(selectionIntent(p,{target:'track',trackId}),{target:'track',trackId});
 for(const options of [{target:'track',trackId:'missing'},{target:'track',trackId:'bass',scene:0},{target:'play',trackId:'bass'},null,[]])assert.throws(()=>selectionIntent(p,options));
 for(const panel of ['clip','devices','recording','returns'])assert.equal(detailPanelIntent({panel}),panel);
 for(const options of [{panel:'account'},{panel:'recording',record:true},{panel:'devices',trackId:'bass'},null])assert.throws(()=>detailPanelIntent(options));
});
test('new track, clip and region aliases resolve into later selections, with invalid late selection rejecting the whole plan',async()=>{
 const {selectionProject,compositionSelection,prepareAgentPlan}=await setup(),p=selectionProject(),before=structuredClone(p),plan=prepareAgentPlan(p,compositionSelection),region=plan.next.arrangement.at(-1);
 assert.equal(plan.after[0].args.ids[0],region.id);assert.equal(plan.after[0].args.primaryId,region.id);assert.equal(plan.editCount,3);
 const clipPlan=prepareAgentPlan(p,[...compositionSelection.slice(0,3),command('select',{target:'clip',trackId:'$lead',clipId:'$notes',scene:0})]);assert.equal(clipPlan.after[0].args.trackId,clipPlan.next.tracks.at(-1).id);
 assert.throws(()=>prepareAgentPlan(p,[...compositionSelection.slice(0,3),command('select',{target:'regions',ids:['$notes']})]),/Arrangement region IDs/);
 assert.throws(()=>prepareAgentPlan(p,[{type:'project',args:{bpm:131}},command('show_panel',{panel:'unknown'})]));
 const duplicate=structuredClone(compositionSelection);duplicate[2].args.ref='$lead';assert.throws(()=>prepareAgentPlan(p,duplicate),/unique/);
 assert.throws(()=>prepareAgentPlan(p,[{type:'region',args:{id:'bass-a',ref:'$old',start:4}}]),/only when creating/);assert.deepEqual(p,before);
});
test('selection-only plans preserve prior Undo history and cannot edit after navigation',async()=>{
 const {selectionProject,prepareAgentPlan,runAgentPlan}=await setup(),{History}=await import('../web-studio/history.js');const before=selectionProject();let p=structuredClone(before);const history=new History(p);p.bpm=123;history.commit(p);let commits=0;const steps=[];
 const plan=prepareAgentPlan(p,[command('select',{target:'regions',ids:['bass-b']}),command('show_panel',{panel:'devices'})]);await runAgentPlan(plan,{getProject:()=>p,expected:JSON.stringify(p),locked:()=>false,commit:()=>commits++,execute:async command=>steps.push(command.name),signal:new AbortController().signal});assert.equal(commits,0);assert.deepEqual(steps,['select','show_panel']);assert.deepEqual(history.undo(),before);
 assert.throws(()=>prepareAgentPlan(before,[command('select',{target:'track',trackId:'bass'}),{type:'project',args:{bpm:131}}]),/Put project edits before/);
});
test('first-open pitch fitting covers every note including the previously hidden highest bass note',async()=>{
 const {selectionProject}=await setup(),{fitPianoPitches}=await import('../web-studio/piano-view.js');for(const notes of [selectionProject().clips.riff.notes,[{pitch:0},{pitch:127}],[{pitch:127}],[]]){const view=fitPianoPitches(notes);assert.ok(notes.every(n=>n.pitch>=view.base&&n.pitch<view.base+view.count));assert.ok(view.base>=0&&view.base+view.count<=128);}
});
