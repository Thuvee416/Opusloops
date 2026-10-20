const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],results=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject,wav},{encode64}]=await Promise.all([import('/model.js'),import('/input.js')]),p=emptyProject();p.name='Warp Gesture QA';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];
   const ctx=new OfflineAudioContext(1,88200,44100),buffer=ctx.createBuffer(1,88200,44100),pcm=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++)pcm[i]=.1*Math.sin(2*Math.PI*220*i/44100);
   p.clips.tone={id:'tone',name:'Tone',kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(buffer)),warp:{mode:'stretch',semitones:0,markers:[{source:.5,target:.5}]}};p.tracks[0].slots[0]='tone';return p;
  });
  const press=id=>page.evaluate(id=>{const el=document.getElementById(id);if(el.disabled)throw Error(id+' is disabled');return el.onclick?el.onclick():el.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Warp.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelector('#project-name').value==='Warp Gesture QA'&&!document.querySelector('#save').disabled);
  await press('session-tab');await page.locator('[data-select="tone"]').dblclick();
  const original=await save();assert.deepEqual(original,fixture);
  await page.locator('#project-name').fill('Keep This Edit');await page.locator('#project-name').press('Tab');const edited=await save();assert.equal(edited.name,'Keep This Edit');
  const startDrag=async()=>{
   const handle=page.locator('[data-warp-handle="0"]');await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();assert.ok(box);
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2,{steps:8});
  };
  await startDrag();await page.keyboard.press('Control+z');await page.mouse.up();assert.deepEqual(await save(),edited,'Undo during a marker preview must cancel the preview, preserving the preceding completed edit');
  results.push({cancel:'Control+Z',projectExact:true});
  for(const kind of ['Meta+Z','Escape','Blur','Resize','Capture Loss','Pointer Cancel','Hidden Document']){
   await startDrag();
   if(['Meta+Z','Escape'].includes(kind))await page.keyboard.press(kind==='Meta+Z'?'Meta+z':'Escape');
   else if(kind==='Resize')await page.setViewportSize({width:1439,height:1100});
   else await page.evaluate(kind=>{
    const handle=document.querySelector('[data-warp-handle="0"]');
    if(kind==='Blur')window.dispatchEvent(new Event('blur'));
    if(kind==='Capture Loss')handle.releasePointerCapture(1);
    if(kind==='Pointer Cancel')handle.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}));
    if(kind==='Hidden Document'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;}
   },kind);
   if(kind==='Capture Loss')await page.mouse.move(10,10);
   await page.waitForFunction(()=>!document.getElementById('undo').disabled);
   await page.mouse.up();assert.deepEqual(await save(),edited,kind+' changed the completed edit or clip');
   assert.equal(await page.locator('#undo').isDisabled(),false);results.push({cancel:kind,projectExact:true});
  }
  await startDrag();assert.equal(await page.locator('#undo').isDisabled(),true);
  for(const key of ['Space','Delete','ArrowRight','Tab'])await page.keyboard.press(key);
  assert.equal(await page.locator('#play').getAttribute('aria-pressed'),'false');
  await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await save(),edited);
  // A real drag prepares stretched audio and creates exactly one history entry.
  await startDrag();await page.mouse.up();await page.waitForFunction(()=>!document.getElementById('save').disabled);
  const warped=await save();assert.ok(warped.clips.tone.warp.markers[0].target>.5);
  const expected=structuredClone(edited);expected.clips.tone.warp.markers[0].target=warped.clips.tone.warp.markers[0].target;assert.deepEqual(warped,expected);
  await press('undo');assert.deepEqual(await save(),edited);await press('redo');assert.deepEqual(await save(),warped);await press('undo');
  // Cancelling a preview also preserves an existing Redo branch.
  await startDrag();await page.keyboard.press('Escape');await page.mouse.up();await press('redo');assert.deepEqual(await save(),warped);await press('undo');
  await page.locator('[data-warp-handle="0"]').focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>!document.getElementById('save').disabled);const nudged=await save(),nudgeExpected=structuredClone(edited);nudgeExpected.clips.tone.warp.markers[0].target+=1/16/4;assert.deepEqual(nudged,nudgeExpected);
  await press('undo');assert.deepEqual(await save(),edited);await press('undo');assert.deepEqual(await save(),original);
  await press('redo');await press('redo');assert.deepEqual(await save(),nudged);
  await page.reload();await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));assert.deepEqual(await save(),nudged);
  assert.deepEqual(errors,[]);
  const proof={status:'passed',results,keyboardShortcutsSuppressedDuringDrag:true,historyLockedDuringDrag:true,completedDragSingleUndo:true,redoBranchPreservedOnCancel:true,keyboardNudge:true,saveUndoRedoReloadExact:true,errors,scope:'Isolated Chromium with synthetic two-second PCM, actual pointer and keyboard events, native stretch preparation and real project downloads. Focus/visibility/pointer-cancel events are controlled; capture loss uses the native capture API. No personal project, provider, microphone, physical device or perceptual audio-quality check.'};
  fs.writeFileSync('tests/fixtures/warp-gesture-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
