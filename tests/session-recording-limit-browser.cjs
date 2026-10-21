const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject},{Engine},{newSynth}]=await Promise.all([import('/model.js'),import('/audio.js'),import('/instruments.js')]);
   const play=Engine.prototype.play;Engine.prototype.play=async function(...args){window.testEngine=this;return play.apply(this,args);};
   const p=emptyProject();p.name='Session Limit QA';p.sceneNames=['Intro','Lift','Breakdown','Return'];p.returns=[];p.transport.launchQuantization=0;p.transport.followActionsEnabled=false;p.tracks[0].instrument=newSynth('Bright pluck');
   p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};p.tracks[0].slots[0]='phrase';p.arrangement=[{id:'previous',trackId:p.tracks[0].id,clipId:'phrase',start:8,length:4,offset:0}];return p;
  });
  const press=id=>page.evaluate(id=>{const el=document.getElementById(id);if(el.disabled)throw Error(id+' is disabled');return el.onclick?el.onclick():el.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Limit.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForFunction(()=>document.getElementById('project-name').value==='Session Limit QA'&&!document.getElementById('save').disabled);
  assert.deepEqual(await save(),fixture);await press('session-tab');await page.locator('[data-scene-launch="0"]').click();await page.waitForFunction(()=>window.testEngine?.playing&&!testEngine.startPromise&&!testEngine.preparing&&!testEngine.pending.size);
  await press('record');await page.waitForFunction(()=>testEngine.recording&&!testEngine.recordingStartPromise&&!testEngine.startPromise);
  const capture=await page.evaluate(()=>{
   const e=testEngine,context=e.context,mixers=e.mixers,end=16384,track=e.project.tracks[0];
   // Move the clock origin to the limit without waiting for hours or replacing
   // the native audio context, scheduler, capture or application history path.
   e.origin=context.currentTime-(end-.1)*60/e.project.bpm;e.nextBeat=end+.25;
   e.closeRecord(track.id,end+.125);e.activateClip(track.id,'phrase',end+.125,false,0);
   e.advanceSessionRecording();const lookahead={recording:e.recording,regions:e.project.arrangement.length,end:e.project.arrangement[0].length};
   e.origin=context.currentTime-(end+.1)*60/e.project.bpm;e.tick();
   return {lookahead,recording:e.recording,playing:e.playing,records:e.records.size,sameContext:e.context===context,sameMixers:e.mixers===mixers,error:e.recordingError,end:e.project.arrangement[0].start+e.project.arrangement[0].length};
  });
  assert.deepEqual(capture.lookahead,{recording:true,regions:1,end:16384});assert.equal(capture.recording,false);assert.equal(capture.playing,true);assert.equal(capture.records,0);assert.equal(capture.sameContext,true);assert.equal(capture.sameMixers,true);assert.equal(capture.end,16384);assert.match(capture.error,/16,384/);
  await press('stop');const captured=await save(),expected=structuredClone(fixture);expected.arrangement=[{id:captured.arrangement[0].id,trackId:fixture.tracks[0].id,clipId:'phrase',start:0,length:16384,offset:0}];assert.deepEqual(captured,expected);
  await press('undo');assert.deepEqual(await save(),fixture);assert.equal(await page.locator('#undo').isDisabled(),true);await press('redo');assert.deepEqual(await save(),captured);
  await page.reload();await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));assert.deepEqual(await save(),captured);
  const delivery=await page.evaluate(async p=>{
   const [{Engine},{prepareMidiDelivery}]=await Promise.all([import('/audio.js'),import('/midi-delivery.js')]);
   const boundary=prepareMidiDelivery(p,{range:{start:16380,length:4}}),options={source:'arrangement',range:{start:0,length:4},sampleRate:44100,bitDepth:32,includeTail:false,normalize:false,dither:'none'},reference=structuredClone(p);reference.arrangement[0].length=4;
   const a=new Engine(p,()=>{}),b=new Engine(reference,()=>{});try{const actual=new DataView(await a.render(options)),expected=new DataView(await b.render(options));if(actual.byteLength!==expected.byteLength)throw Error('Render Length Changed');let error=0,peak=0;for(let i=44;i<actual.byteLength;i+=4){const sample=actual.getFloat32(i,true);if(!Number.isFinite(sample))throw Error('Non-Finite Audio');error=Math.max(error,Math.abs(sample-expected.getFloat32(i,true)));peak=Math.max(peak,Math.abs(sample));}return {boundaryNotes:boundary.delivery.noteCount,audioRange:options.range,error,peak};}finally{await a.context?.close();await b.context?.close();}
  },captured);
  assert.equal(delivery.boundaryNotes,1);assert.ok(delivery.error<.00002);assert.ok(delivery.peak>.001);assert.deepEqual(errors,[]);
  const proof={status:'passed',capture,saveUndoRedoReloadExact:true,originalProjectRestoredByOneUndo:true,delivery,errors,scope:'Isolated Chromium, synthetic MIDI project, actual Session launch/Record/Stop controls and native audio engine. Clock origin accelerated to exercise the timeline boundary; not a multi-hour endurance or physical-device test. Boundary MIDI verified; native WAV compared only for the first four beats because long-timeline WAV export retains its existing limits. No personal project, microphone or model call.'};fs.writeFileSync('tests/fixtures/session-recording-limit-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
