const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],results=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const {emptyProject}=await import('/model.js'),p=emptyProject();p.name='MIDI Gesture Verification';p.sceneNames=['Intro','Lift','Breakdown','Return'];p.returns=[];
   p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch:60,start:1,duration:1,velocity:.5,releaseVelocity:.2},{pitch:64,start:3,duration:.75,velocity:.6,active:false}]};p.tracks[0].slots[0]='phrase';return p;
  });
  const press=id=>page.evaluate(id=>{const el=document.getElementById(id);if(el.disabled)throw Error(id+' is disabled');return el.onclick?el.onclick():el.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Gesture.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelector('#project-name').value==='MIDI Gesture Verification'&&!document.querySelector('#save').disabled);
  await press('session-tab');await page.locator('[data-select="phrase"]').dblclick();
  const original=await save();assert.deepEqual(original,fixture);
  const selected=()=>page.locator('[data-midi-note][aria-pressed="true"]').evaluateAll(els=>els.map(el=>Number(el.dataset.midiNote)));
  const startDrag=async kind=>{
   const locator=page.locator(kind==='velocity'?'[data-velocity-note="1"]':kind==='resize'?'[data-midi-note="0"] [data-note-resize]':kind==='lasso'?'[data-pitch="60"][data-step="0"]':'[data-midi-note="0"]');
   await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box);
   const x=box.x+box.width/2,y=box.y+Math.min(5,box.height/2);
   if(kind==='lasso')await page.keyboard.down('Shift');
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(kind==='velocity'?0:90),y+(kind==='velocity'?-20:kind==='lasso'?-60:0),{steps:8});
  };
  for(const kind of ['move','resize','velocity','lasso']){
   await page.locator('[data-midi-note="0"]').click();const beforeSelection=await selected();
   await startDrag(kind);await page.keyboard.press('Escape');await page.mouse.up();if(kind==='lasso')await page.keyboard.up('Shift');
   assert.deepEqual(await save(),original,kind+' Escape changed notes');assert.deepEqual(await selected(),beforeSelection,kind+' Escape changed selection');
   assert.equal(await page.locator('#undo').isDisabled(),true);assert.equal(await page.locator('.note-marquee').count(),0);
   results.push({kind,cancelledProjectExact:true,selectionRestored:true,noUndo:true});
  }
  // Cancellation must release the editor lock and leave a subsequent real edit usable.
  await startDrag('move');await page.mouse.up();const edited=await save();assert.notDeepEqual(edited.clips.phrase.notes,original.clips.phrase.notes);
  await startDrag('resize');await page.keyboard.press('Control+z');await page.mouse.up();assert.deepEqual(await save(),edited);
  await press('undo');assert.deepEqual(await save(),original);await press('redo');assert.deepEqual(await save(),edited);
  assert.deepEqual(errors,[]);
  const proof={status:'passed',results,undoDuringDragCancelsOnlyPreview:true,nextEditAndUndoRedoExact:true,errors,scope:'Isolated actual application mouse note move, resize, velocity and Shift-marquee cancellation with Escape; exact downloaded projects, selection and Undo checks, then a successful move and Ctrl+Z cancellation of a subsequent drag without undoing that saved move. Synthetic MIDI; no personal project, input device or model calls.'};
  fs.writeFileSync('tests/fixtures/midi-gesture-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
