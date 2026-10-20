const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject,makeTrack,wav},{encode64},{Engine}]=await Promise.all([import('/model.js'),import('/input.js'),import('/audio.js')]);
   // Observe the real application Engine without replacing its clock,
   // scheduler, capture operations or native audio implementation.
   const start=Engine.prototype.startRecording,finish=Engine.prototype.finishRecords;
   Engine.prototype.startRecording=function(...args){window.captureEngine=this;return start.apply(this,args);};
   Engine.prototype.finishRecords=function(beat){if(this.recording)window.finishBeat=beat;return finish.call(this,beat);};
   const p=emptyProject();p.name='Session Delivery Verification';p.returns=[];p.sceneNames=['Opening','Theme','Break','Return'];
   p.tracks=[makeTrack('Low Tone'),makeTrack('High Tone')];p.transport.launchQuantization=4;
   for(const [i,t]of p.tracks.entries()){
    t.id='track-'+i;
    for(let s=0;s<2;s++){
     const ctx=new OfflineAudioContext(1,88200,44100),b=ctx.createBuffer(1,88200,44100),pcm=b.getChannelData(0),frequency=(i+1)*220+s*55;
     for(let n=0;n<pcm.length;n++)pcm[n]=.1*Math.sin(2*Math.PI*frequency*n/44100);
     const id='clip-'+i+'-'+s;p.clips[id]={id,name:t.name+' '+s,kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(b))};t.slots[s]=id;
    }
   }
   p.arrangement=[{id:'previous',trackId:p.tracks[0].id,clipId:p.tracks[0].slots[0],start:8,length:4,offset:0}];
   return p;
  });
  const press=id=>page.evaluate(id=>{const b=document.getElementById(id);if(b.disabled)throw Error(id+' is disabled');return b.onclick();},id);
  const download=async id=>{
   await new Promise(resolve=>setTimeout(resolve,1100));
   const pending=page.waitForEvent('download');await press(id);return fs.readFileSync(await(await pending).path());
  };
  const save=async()=>JSON.parse((await download('save')).toString());
  const open=async p=>{
   await page.locator('#project-file').setInputFiles({name:'Session.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});
   await page.waitForFunction(()=>document.querySelector('#project-name').value==='Session Delivery Verification'&&!document.querySelector('#save').disabled);
   assert.deepEqual(await save(),p);
  };
  await open(fixture);const before=await save();await press('session-tab');
  await page.locator('[data-scene-launch="0"]').click();
  await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-pressed')==='true');
  await press('record');
  await page.waitForFunction(()=>window.captureEngine.recording);
  await page.locator('[data-scene-launch="1"]').click();
  await page.waitForFunction(()=>window.captureEngine.rawBeat()>4.3);
  await page.locator('[data-scene-launch="0"]').click();
  const boundary=await page.evaluate(async()=>{
   const e=window.captureEngine,deadline=performance.now()+6000;
   while(performance.now()<deadline){
    const raw=e.rawBeat();
    if(e.recording&&raw<8&&[...e.records.values()].some(r=>r.start===8)){
     const before=structuredClone(e.project.arrangement);
     await document.querySelector('#record').onclick();
     return {finishBeat:window.finishBeat,before,playing:e.playing,recording:e.recording};
    }
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   throw Error('Did not observe the scheduled scene boundary ahead of the audio clock');
  });
  assert.equal(boundary.recording,false);assert.equal(boundary.playing,true);
  assert.ok(boundary.finishBeat>7.5&&boundary.finishBeat<8);
  assert.ok(boundary.before.some(r=>r.start===8));
  await press('stop');const captured=await save();
  assert.equal(captured.arrangement.length,4);
  for(const t of captured.tracks){
   const regions=captured.arrangement.filter(r=>r.trackId===t.id).sort((a,b)=>a.start-b.start);
   assert.equal(regions[0].clipId,t.slots[0]);assert.equal(regions[0].start,0);assert.equal(regions[0].length,4);
   assert.equal(regions[1].clipId,t.slots[1]);assert.equal(regions[1].start,4);
   assert.ok(Math.abs(regions[1].start+regions[1].length-boundary.finishBeat)<1e-9);
  }
  assert.deepEqual({...captured,arrangement:before.arrangement},before);
  await press('undo');assert.deepEqual(await save(),before);
  await press('redo');assert.deepEqual(await save(),captured);
  // Edit the captured performance through the existing whole-song time controls.
  await page.evaluate(()=>{document.querySelector('#time-start').value=1;document.querySelector('#time-length').value=4;});
  await press('time-duplicate');const edited=await save();
  assert.equal(edited.arrangement.length,6);
  await press('undo');assert.deepEqual(await save(),captured);
  await press('redo');assert.deepEqual(await save(),edited);
  const settings=()=>page.evaluate(()=>{
   for(const [id,value]of Object.entries({'export-source':'range','export-start':'1','export-length':'16','export-channel':'track:track-0','export-rate':'44100','export-depth':'32','export-dither':'none'})){
    const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));
   }
   document.querySelector('#export-tail').checked=false;document.querySelector('#export-normalize').checked=false;
  });
  await settings();const audio=await download('export');await open(edited);await settings();const reopenedAudio=await download('export');
  assert.equal(audio.equals(reopenedAudio),true,'Captured/edited track export changed after reopen');
  assert.equal(audio.readUInt16LE(20),3);assert.equal(audio.readUInt16LE(22),2);assert.equal(audio.readUInt32LE(24),44100);
  assert.equal(audio.readUInt32LE(40)/8,352800);
  const hz=(from,to)=>{let crossings=0;for(let n=Math.ceil(from*22050)+1;n<to*22050;n++)if(audio.readFloatLE(44+(n-1)*8)<=0&&audio.readFloatLE(44+n*8)>0)crossings++;return crossings/((to-from)*.5);};
  const frequencies=[hz(.5,3.5),hz(4.5,7.5),hz(8.5,10.5)];
  for(const [i,wanted]of [220,220,275].entries())assert.ok(Math.abs(frequencies[i]-wanted)<2);
  let afterFinishPeak=0;for(let n=Math.ceil((boundary.finishBeat+4.1)*22050);n<352800;n++)for(let ch=0;ch<2;ch++)afterFinishPeak=Math.max(afterFinishPeak,Math.abs(audio.readFloatLE(44+n*8+ch*4)));
  assert.equal(afterFinishPeak,0);assert.deepEqual(errors,[]);
  const proof={status:'passed',finishBeat:boundary.finishBeat,futureLaunchDiscarded:true,recordOffKeepsPlayback:true,originalSourcesPreserved:true,recordingUndoRedoExact:true,timeEditUndoRedoExact:true,projectReopenExact:true,exportReopenExact:true,exportFrames:352800,frequencies,afterFinishPeak,errors,scope:'Isolated native Chromium application: Session scene launches, Record on/off with unmodified audio clock and scheduler, Stop, downloaded projects, Undo/Redo, whole-song Duplicate Time and track WAV export/reopen. A test observer reads the actual Engine to press Record off during lookahead. Synthetic audio; no personal project, microphone, physical playback or subjective mix-quality claim.'};
  fs.writeFileSync('tests/fixtures/session-delivery-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
