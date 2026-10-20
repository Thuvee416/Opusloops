const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject},{Engine},{newSynth},{LiveNotes}]=await Promise.all([import('/model.js'),import('/audio.js'),import('/instruments.js'),import('/input.js')]);
   const prepare=Engine.prototype.prepareSamples;Engine.prototype.prepareSamples=async function(...args){window.previewEngine=this;if(window.delayPreview){window.delayPreview=false;await new Promise(r=>window.releasePreview=r);}await prepare.apply(this,args);if(!window.probe){window.probe=this.context.createAnalyser();probe.fftSize=2048;this.mixers.get(this.project.tracks[0].id).pan.connect(probe);}};
   window.previewEvents=[];const on=LiveNotes.prototype.on;LiveNotes.prototype.on=function(...args){if(args[0].startsWith('note-preview:'))window.previewEvents.push({pitch:args[1],velocity:args[2],trackId:args[3]});return on.apply(this,args);};
   const p=emptyProject();p.name='Note Preview Verification';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];p.tracks[0].instrument=newSynth();p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch:60,start:1,duration:1,velocity:.7},{pitch:64,start:3,duration:1,velocity:.8,active:false}]};p.tracks[0].slots[0]='phrase';return p;
  });
  const press=id=>page.evaluate(id=>{const el=document.getElementById(id);return el.onclick?el.onclick():el.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const event=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await event).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Preview.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForFunction(()=>document.getElementById('project-name').value==='Note Preview Verification');await press('session-tab');await page.locator('[data-select="phrase"]').dblclick();
  assert.equal(await page.locator('#note-preview').getAttribute('aria-pressed'),'true');const before=await save();
  await page.locator('[data-midi-note="0"]').click();await page.waitForFunction(()=>window.previewEvents.length===1);
  const rms=await page.evaluate(async()=>{await new Promise(r=>setTimeout(r,80));const a=new Float32Array(probe.fftSize);probe.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length);});assert.ok(rms>.001,'Preview did not produce native audio');
  await page.waitForFunction(()=>window.previewEngine.nodes.size===0);assert.equal(await page.locator('#undo').isDisabled(),true);assert.deepEqual(await save(),before);
  await page.locator('[data-midi-note="1"]').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>previewEvents.length),1);
  await press('note-preview');await page.locator('[data-midi-note="0"]').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>previewEvents.length),1);assert.deepEqual(await save(),before);
  await press('note-preview');await page.locator('.piano-scroll').focus();await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>previewEvents.length===2);assert.equal(await page.evaluate(()=>previewEvents.at(-1).pitch),61);
  const edited=await save(),expected=structuredClone(before);expected.clips.phrase.notes[0].pitch=61;assert.deepEqual(edited,expected);await press('undo');assert.deepEqual(await save(),before);
  await page.locator('[data-pitch="62"][data-step="0"]').click({position:{x:1,y:2}});await page.waitForFunction(()=>previewEvents.length===3);assert.equal(await page.evaluate(()=>previewEvents.at(-1).pitch),62);
  const withNew=await save();assert.equal(withNew.clips.phrase.notes.length,3);assert.equal(withNew.clips.phrase.notes[2].pitch,62);await press('undo');assert.deepEqual(await save(),before);
  await page.evaluate(()=>{window.delayPreview=true;window.releasePreview=null;});await page.locator('[data-midi-note="0"]').click();await page.waitForFunction(()=>!!window.releasePreview);await press('stop');await page.evaluate(()=>window.releasePreview());await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>previewEvents.length),3);assert.equal(await page.evaluate(()=>previewEngine.nodes.size),0);assert.deepEqual(await save(),before);
  assert.deepEqual(errors,[]);const proof={status:'passed',nativeSynthRms:rms,activeNoteAudible:true,inactiveNoteSilent:true,toggleOffSilent:true,previewNoProjectOrHistoryChange:true,keyboardPitchUsesEditedNote:true,newNoteAuditionAndUndo:true,editUndoExact:true,pendingPreviewCancelledByStop:true,voicesReleased:true,errors,scope:'Isolated native Chromium application with existing synth and mixer, actual note clicks, preview toggle, arrow pitch edit, downloads and Undo. An analyser confirms output, and delayed sample preparation confirms Stop prevents late preview. No microphone, personal project, provider call or physical-output/listening-quality claim.'};fs.writeFileSync('tests/fixtures/note-preview-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
