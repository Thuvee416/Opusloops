const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject},{Engine}]=await Promise.all([import('/model.js'),import('/audio.js')]);
   const prepare=Engine.prototype.prepare;Engine.prototype.prepare=async function(...args){if(window.delayNext){window.delayNext=false;window.testEngine=this;await new Promise((resolve,reject)=>{window.releasePreparation=resolve;window.failPreparation=()=>reject(Error('Test Preparation Failure'));});}return prepare.apply(this,args);};
   const p=emptyProject();p.name='Playback Edit Lock';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch:60,start:1,duration:1,velocity:.6}]};p.tracks[0].slots[0]='phrase';p.arrangement=[{id:'region',clipId:'phrase',trackId:p.tracks[0].id,start:0,length:8,offset:0}];return p;
  });
  const press=id=>page.evaluate(id=>{const b=document.getElementById(id);return b.onclick?b.onclick():b.click();},id);
  await page.locator('#project-file').setInputFiles({name:'Lock.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelector('#project-name').value==='Playback Edit Lock');await press('session-tab');await page.locator('[data-select="phrase"]').dblclick();await page.locator('[data-midi-note="0"]').click();await press('arrangement-tab');
  for(const outcome of ['cancel','failure','success']){
   await page.evaluate(()=>{window.releasePreparation=null;window.delayNext=true;window.playRequest=document.getElementById('play').onclick();});
   await page.waitForFunction(()=>!!window.releasePreparation&&!!window.testEngine.startPromise);
   const before=await page.evaluate(()=>JSON.stringify(window.testEngine.project));
   const attempted=await page.evaluate(async()=>{
    const field=document.getElementById('note-pitch');field.value='62';field.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('note-duplicate').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await Promise.resolve();return JSON.stringify(window.testEngine.project);
   });
   assert.equal(attempted,before,'Editing changed notes during playback preparation');
   await page.waitForFunction(()=>document.getElementById('note-pitch').disabled&&document.getElementById('bpm').disabled);
   if(outcome==='cancel'){await press('stop');assert.equal(await page.locator('#note-pitch').isDisabled(),true);await page.evaluate(()=>window.releasePreparation());}
   else await page.evaluate(fail=>fail?window.failPreparation():window.releasePreparation(),outcome==='failure');
   await page.evaluate(()=>window.playRequest);await page.waitForFunction(()=>!window.testEngine.startPromise);
   if(outcome==='success'){assert.equal(await page.evaluate(()=>window.testEngine.playing),true);assert.equal(await page.locator('#note-pitch').isDisabled(),true);await press('stop');}
   await page.waitForFunction(()=>!document.getElementById('note-pitch').disabled&&!document.getElementById('bpm').disabled);
   assert.equal(await page.evaluate(()=>JSON.stringify(window.testEngine.project)),before);assert.equal(await page.locator('#undo').isDisabled(),true);
   results.push({outcome,projectUnchanged:true,controlsLockedDuringPreparation:true,controlsRestored:true,noUndo:true});
  }
  await page.locator('#note-pitch').fill('62');await page.locator('#note-pitch').dispatchEvent('change');assert.equal(await page.evaluate(()=>window.testEngine.project.clips.phrase.notes[0].pitch),62);await press('undo');
  assert.equal(await page.evaluate(()=>document.getElementById('note-pitch').value),'60');assert.deepEqual(errors,[]);
  const proof={status:'passed',results,editingAfterStopAndUndo:true,errors,scope:'Isolated actual app with controlled delay/failure around native Engine.prepare. Real note-property and duplicate event paths cannot mutate the project during startup. Stop cancels startup, failure and successful playback release controls at the correct boundary. No personal project, microphone, provider calls or physical output check.'};
  fs.writeFileSync('tests/fixtures/playback-edit-lock-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
