const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM}),results=[];
 try{
  for(const kind of ['track','clip']){
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   try{
    await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
    await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
    const fixture=await page.evaluate(async()=>{
     const [{Engine},{emptyProject,makeTrack,wav},{encode64}]=await Promise.all([import('/audio.js'),import('/model.js'),import('/input.js')]);
     const scene=Engine.prototype.scene;Engine.prototype.scene=function(...args){window.testEngine=this;return scene.apply(this,args);};
     const p=emptyProject();p.name='Metadata Mixer Verification';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];p.tracks=[makeTrack('A'),makeTrack('B')];
     for(const [i,t]of p.tracks.entries()){
      t.id=['a','b'][i];const ctx=new OfflineAudioContext(1,88200,44100),b=ctx.createBuffer(1,88200,44100),pcm=b.getChannelData(0);
      for(let n=0;n<pcm.length;n++)pcm[n]=.1*Math.sin(2*Math.PI*(220+i*220)*n/44100);
      const id='clip-'+t.id;p.clips[id]={id,name:t.name,kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(b))};t.slots[0]=id;
     }
     return p;
    });
    const press=id=>page.evaluate(id=>{const b=document.getElementById(id);if(b.disabled)throw Error(id+' is disabled');return b.onclick();},id);
    const save=async()=>{const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
    await page.locator('#project-file').setInputFiles({name:'Metadata.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
    await page.waitForFunction(()=>document.querySelector('#project-name').value==='Metadata Mixer Verification'&&!document.querySelector('#save').disabled);
    const before=await save();assert.deepEqual(before,fixture);
    await press('session-tab');await page.locator('[data-scene-launch="0"]').click();await page.waitForFunction(()=>window.testEngine?.playing);
    await press('stop');await page.evaluate(()=>{window.previousContext=testEngine.context;window.previousGraph=testEngine.mixGraph;});
    if(kind==='track'){
     await page.locator('[data-track-name="a"]').fill('Renamed Track');await page.locator('[data-track-name="a"]').press('Tab');
    }else{
     await page.locator('[data-select="clip-a"]').dblclick();await page.locator('#clip-name').fill('Renamed Clip');await page.locator('#clip-name').press('Tab');
    }
    const binding=await page.evaluate(()=>({sameContext:testEngine.context===previousContext,newGraph:testEngine.mixGraph!==previousGraph}));
    assert.equal(binding.sameContext,true);assert.equal(binding.newGraph,true);
    await page.locator('[data-scene-launch="0"]').click();await page.waitForFunction(()=>testEngine.playing);
    await page.evaluate(()=>{window.probe=testEngine.context.createAnalyser();probe.fftSize=2048;testEngine.mixers.get('b').pan.connect(probe);});
    const meter=()=>page.evaluate(async()=>{await new Promise(r=>setTimeout(r,300));const a=new Float32Array(probe.fftSize);probe.getFloatTimeDomainData(a);return {rms:Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length),gate:testEngine.mixers.get('b').gate.gain.value,playing:testEngine.playing};});
    const initial=await meter();assert.ok(initial.rms>.02);
    await page.locator('[data-channel="b"] [data-mute]').click();const muted=await meter();assert.ok(muted.rms<.00001,JSON.stringify({kind,muted}));assert.equal(muted.playing,true);
    await page.locator('[data-channel="b"] [data-mute]').click();const unmuted=await meter();assert.ok(unmuted.rms>.02);
    await press('stop');const after=await save(),expected=structuredClone(before);
    if(kind==='track')expected.tracks[0].name='Renamed Track';else expected.clips['clip-a'].name='Renamed Clip';
    assert.deepEqual(after,expected);
    for(let i=0;i<3;i++)await press('undo');assert.deepEqual(await save(),before);
    for(let i=0;i<3;i++)await press('redo');assert.deepEqual(await save(),after);
    assert.deepEqual(errors,[]);results.push({kind,binding,initial,muted,unmuted,onlyRequestedMetadataChanged:true,undoRedoExact:true,errors});
   }finally{await page.close();}
  }
  const proof={status:'passed',results,scope:'Two isolated Chromium application workflows with existing initialized audio: rename a track header or edit Clip Name, relaunch Session, measure Mute/Unmute with native analyser, download projects and verify exact three-step Undo/Redo. Original embedded audio and all unmentioned properties are preserved. Synthetic sources; no personal project, microphone, provider/model evaluation or physical-output certification.'};
  fs.writeFileSync('tests/fixtures/metadata-mix-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
