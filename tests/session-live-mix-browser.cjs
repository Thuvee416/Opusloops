const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{Engine},{emptyProject,makeTrack,wav},{encode64}]=await Promise.all([import('/audio.js'),import('/model.js'),import('/input.js')]);
   const scene=Engine.prototype.scene;Engine.prototype.scene=function(...args){window.liveEngine=this;return scene.apply(this,args);};
   const p=emptyProject();p.name='Live Session Mixer Verification';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];p.tracks=[makeTrack('A'),makeTrack('B')];
   for(const [i,t]of p.tracks.entries()){
    t.id=['a','b'][i];const ctx=new OfflineAudioContext(1,88200,44100),buffer=ctx.createBuffer(1,88200,44100),pcm=buffer.getChannelData(0);
    for(let n=0;n<pcm.length;n++)pcm[n]=.1*Math.sin(2*Math.PI*(220+i*220)*n/44100);
    const id='clip-'+t.id;p.clips[id]={id,name:t.name,kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(buffer))};t.slots[0]=id;
   }
   return p;
  });
  const press=id=>page.evaluate(id=>{const b=document.getElementById(id);if(b.disabled)throw Error(id+' is disabled');return b.onclick();},id);
  const save=async()=>{const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Live.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelector('#project-name').value==='Live Session Mixer Verification'&&!document.querySelector('#save').disabled);
  const before=await save();assert.deepEqual(before,fixture);
  await press('session-tab');await page.locator('[data-select="clip-a"]').click();
  await page.locator('[data-scene-launch="0"]').click();await page.waitForFunction(()=>window.liveEngine?.playing);
  await page.evaluate(()=>{
   const e=window.liveEngine;window.originalProject=e.project;window.originalGraph=e.mixGraph;window.startGeneration=e.playGeneration;
   window.probe=e.context.createAnalyser();probe.fftSize=2048;e.mixers.get('b').pan.connect(probe);
  });
  const meter=async()=>page.evaluate(async()=>{
   await new Promise(r=>setTimeout(r,300));
   const data=new Float32Array(probe.fftSize);probe.getFloatTimeDomainData(data);
   return {rms:Math.sqrt(data.reduce((n,v)=>n+v*v,0)/data.length),gate:liveEngine.mixers.get('b').gate.gain.value,playing:liveEngine.playing};
  });
  const initial=await meter();assert.ok(initial.rms>.02);
  await press('session-batch-active');
  const identity=await page.evaluate(()=>({project:liveEngine.project===originalProject,graph:liveEngine.mixGraph===originalGraph,generation:liveEngine.playGeneration===startGeneration,inactive:liveEngine.project.tracks[0].inactiveSlots}));
  assert.deepEqual(identity.inactive,[0]);
  await page.locator('[data-channel="b"] [data-mute]').click();const muted=await meter();
  assert.ok(muted.rms<.00001,JSON.stringify({initial,muted,identity}));
  assert.equal(muted.playing,true);
  await page.locator('[data-channel="b"] [data-mute]').click();const unmuted=await meter();
  assert.ok(unmuted.rms>.02);
  assert.equal(identity.project,true);assert.equal(identity.graph,true);assert.equal(identity.generation,true);
  await press('stop');const after=await save();assert.deepEqual(after.tracks[0].inactiveSlots,[0]);assert.equal(after.tracks[1].mute,false);
  for(let i=0;i<3;i++)await press('undo');assert.deepEqual(await save(),before);
  for(let i=0;i<3;i++)await press('redo');assert.deepEqual(await save(),after);
  assert.deepEqual(errors,[]);
  const proof={status:'passed',identity,initial,muted,unmuted,undoRedoExact:true,originalSourcesPreserved:JSON.stringify(after.clips)===JSON.stringify(before.clips),errors,scope:'Isolated Chromium actual application project import, Session launch, clip activation and mixer Mute controls. Native analyser measures track audio while transport and graph remain running. Three edits Undo/Redo exactly in downloaded projects. Synthetic sources; no personal project, microphone, physical output or model/provider evaluation.'};
  assert.equal(proof.originalSourcesPreserved,true);
  fs.writeFileSync('tests/fixtures/session-live-mix-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
