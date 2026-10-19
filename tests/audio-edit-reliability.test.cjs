const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
async function setup(prepare=async()=>{}){
 const {coreSongProject}=await import('./fixtures/core-song-project.mjs'),{History}=await import('../web-studio/history.js'),audio=await import('../web-studio/audio-edit.js'),{validateProject}=await import('../web-studio/model.js');
 const project=coreSongProject().project,history=new History(project),before=structuredClone(project);let commits=0;
 const ctx={project,engine:{prepareAudioClip:prepare},selection:{clipId:'drums'},sessionProjectRevision:1,busy:false,stopToEdit:()=>{},clipPropertiesLocked:()=>ctx.busy,editAudio:audio.editAudio,validateProject,renderEditor:()=>{},renderTransport:()=>{},setStatus:()=>{},changed:()=>{commits++;ctx.sessionProjectRevision++;history.commit(ctx.project);}};
 const source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),start=source.indexOf('async function applyAudioEdit('),end=source.indexOf("\n$('clip-editor').addEventListener('change'",start);vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 return {ctx,before,history,commits:()=>commits};
}
test('audio settings remain unchanged while preparation is pending and commit once after success',async()=>{
 let resolve,prepared;const t=await setup(candidate=>{prepared=candidate;return new Promise(r=>resolve=r);});
 const pending=t.ctx.applyAudioEdit({reverse:true,gainDb:-3,fadeIn:2});assert.equal(t.ctx.busy,true);assert.deepEqual(t.ctx.project,t.before);assert.equal(t.commits(),0);assert.notEqual(prepared,t.ctx.project.clips.drums);assert.equal(prepared.audioEdit.reverse,true);
 resolve();await pending;assert.equal(t.ctx.busy,false);assert.equal(t.commits(),1);assert.equal(t.ctx.project.clips.drums.audioEdit.gainDb,-3);assert.deepEqual(t.ctx.project.tracks,t.before.tracks);assert.equal(t.ctx.project.clips.drums.data,t.before.clips.drums.data);
 const saved=structuredClone(t.ctx.project);assert.deepEqual(t.history.undo(),t.before);assert.deepEqual(t.history.redo(),saved);
});
test('decoder or stretch failure retains project and history and releases the edit lock',async()=>{
 for(const reset of [false,true]){
  const t=await setup(async()=>{throw Error('Preparation Failed');});t.ctx.project.clips.drums.audioEdit={reverse:true,gainDb:-2,fadeIn:1,fadeOut:0};const before=structuredClone(t.ctx.project);
  await assert.rejects(()=>t.ctx.applyAudioEdit({gainDb:-8},{reset}),/Preparation Failed/);assert.deepEqual(t.ctx.project,before);assert.equal(t.commits(),0);assert.equal(t.ctx.busy,false);
 }
});
test('stale project, engine, source replacement and revision reject the prepared candidate',async()=>{
 for(const mode of ['project','engine','clip','revision']){
  let resolve;const t=await setup(()=>new Promise(r=>resolve=r)),pending=t.ctx.applyAudioEdit({reverse:true});
  if(mode==='project')t.ctx.project=structuredClone(t.ctx.project);if(mode==='engine')t.ctx.engine={};if(mode==='clip')t.ctx.project.clips.drums=structuredClone(t.ctx.project.clips.drums);if(mode==='revision')t.ctx.sessionProjectRevision++;
  const before=structuredClone(t.ctx.project);resolve();await assert.rejects(()=>pending,/Project Changed/);assert.deepEqual(t.ctx.project,before);assert.equal(t.commits(),0);assert.equal(t.ctx.busy,false);
 }
});
test('reset prepares the default candidate before deleting settings; invalid, locked and no-op edits do not prepare',async()=>{
 let preparations=0,candidate;const t=await setup(async c=>{preparations++;candidate=c;});
 await t.ctx.applyAudioEdit(null,{reset:true});assert.equal(preparations,0);
 await assert.rejects(()=>t.ctx.applyAudioEdit({gainDb:Infinity}));assert.equal(preparations,0);assert.deepEqual(t.ctx.project,t.before);
 t.ctx.busy=true;await assert.rejects(()=>t.ctx.applyAudioEdit({reverse:true}));t.ctx.busy=false;assert.equal(preparations,0);
 t.ctx.project.clips.drums.audioEdit={reverse:true,gainDb:-4,fadeIn:0,fadeOut:2};await t.ctx.applyAudioEdit(null,{reset:true});assert.equal(preparations,1);assert.equal(candidate.audioEdit,undefined);assert.equal(t.ctx.project.clips.drums.audioEdit,undefined);assert.equal(t.commits(),1);
});
test('five-minute audio stays editable after splits beyond beat 1024 and survives save/reopen',async()=>{
 const {emptyProject,validateProject,REGION_MAX_OFFSET}=await import('../web-studio/model.js'),{prepareAudioImport}=await import('../web-studio/project-import.js'),{splitRegions}=await import('../web-studio/region-split.js'),{editRegionFields}=await import('../web-studio/arrangement.js'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),{readProjectFile}=await import('../web-studio/project-lifecycle.js');
 const source=emptyProject();source.bpm=240;const imported=prepareAudioImport(source,{name:'Long Recording.wav',bytes:new ArrayBuffer(8),duration:300}),p=imported.next,clip=imported.clip;
 assert.equal(clip.beats,1200);p.arrangement=[{id:'long',clipId:clip.id,trackId:p.tracks[0].id,start:0,length:1200,offset:0}];p.arrangement=splitRegions(p,['long'],[1100]).arrangement;
 const tail=p.arrangement[1];assert.equal(tail.offset,1100);const moved=editRegionFields(p,tail.id,{start:1250});assert.equal(moved.offset,1100);assert.equal(moved.length,100);
 const field=editRegionFields(p,tail.id,{offset:1150}),agent=prepareAgentPlan(p,[{type:'region',args:{id:tail.id,offset:1150}}]).next;assert.deepEqual(field,agent.arrangement.find(r=>r.id===tail.id));
 p.arrangement[1]=moved;validateProject(p);const bytes=JSON.stringify(p);assert.deepEqual(await readProjectFile({size:Buffer.byteLength(bytes),text:async()=>bytes},validateProject),p);
 for(const offset of [-1,REGION_MAX_OFFSET+1,Infinity])assert.throws(()=>editRegionFields(p,tail.id,{offset}));assert.equal(editRegionFields(p,tail.id,{offset:REGION_MAX_OFFSET}).offset,REGION_MAX_OFFSET);
});
