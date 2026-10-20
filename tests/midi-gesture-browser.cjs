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
   p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch:60,start:1,duration:1,velocity:.5,releaseVelocity:.2},{pitch:64,start:3,duration:.75,velocity:.6,active:false},{pitch:67,start:5,duration:.5,velocity:.7}]};p.tracks[0].slots[0]='phrase';return p;
  });
  const press=id=>page.evaluate(id=>{const el=document.getElementById(id);if(el.disabled)throw Error(id+' is disabled');return el.onclick?el.onclick():el.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  await page.locator('#project-file').setInputFiles({name:'Gesture.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelector('#project-name').value==='MIDI Gesture Verification'&&!document.querySelector('#save').disabled);
  await press('session-tab');await page.locator('[data-select="phrase"]').dblclick();
  const original=await save();assert.deepEqual(original,fixture);
  const selected=()=>page.locator('[data-midi-note][aria-pressed="true"]').evaluateAll(els=>els.map(el=>Number(el.dataset.midiNote)).sort((a,b)=>a-b));
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
  await press('undo');
  await page.locator('[data-midi-note="0"]').click();await page.locator('[data-midi-note="1"]').click({modifiers:['Shift']});assert.deepEqual(await selected(),[0,1]);
  const handle=page.locator('[data-midi-note="0"] [data-note-resize]');await handle.scrollIntoViewIfNeeded();
  const box=await handle.boundingBox(),width=await page.locator('[data-midi-note="0"]').evaluate(el=>el.parentElement.getBoundingClientRect().width);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+width/8,box.y+box.height/2,{steps:8});await page.mouse.up();
  const resized=await save(),expected=structuredClone(original);expected.clips.phrase.notes[0].duration+=1;expected.clips.phrase.notes[1].duration+=1;
  assert.deepEqual(resized,expected);assert.deepEqual(await selected(),[0,1]);
  await press('undo');assert.deepEqual(await save(),original);await press('redo');assert.deepEqual(await save(),resized);
  await press('undo');
  await page.locator('[data-midi-note="0"]').click();await page.locator('[data-midi-note="1"]').click({modifiers:['Shift']});
  await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');
  const nudged=await save(),nudgeExpected=structuredClone(original);for(const i of [0,1])nudgeExpected.clips.phrase.notes[i].start+=.75;assert.deepEqual(nudged,nudgeExpected);
  await page.keyboard.press('ArrowRight');const nextNudge=await save();for(const i of [0,1])nudgeExpected.clips.phrase.notes[i].start+=.25;assert.deepEqual(nextNudge,nudgeExpected);
  await press('undo');assert.deepEqual(await save(),nudged);await press('undo');assert.deepEqual(await save(),original);
  await page.locator('.piano-scroll').focus();await page.keyboard.press('Shift+ArrowUp');
  const octave=await save(),octaveExpected=structuredClone(original);for(const i of [0,1])octaveExpected.clips.phrase.notes[i].pitch+=12;assert.deepEqual(octave,octaveExpected);
  await press('undo');await page.locator('.piano-scroll').focus();await page.keyboard.press('Shift+ArrowRight');
  const length=await save(),lengthExpected=structuredClone(original);for(const i of [0,1])lengthExpected.clips.phrase.notes[i].duration+=.25;assert.deepEqual(length,lengthExpected);
  await press('undo');assert.deepEqual(await save(),original);
  assert.deepEqual(errors,[]);
  const proof={status:'passed',results,undoDuringDragCancelsOnlyPreview:true,nextEditAndUndoRedoExact:true,selectedResize:{indices:[0,1],addedBeats:1,unselectedNotePreserved:true,exactUndoRedo:true},keyboard:{repeatedNudgeOneUndo:true,newPressSeparateUndo:true,octaveShiftExact:true,lengthShiftExact:true,unselectedNotePreserved:true},errors,scope:'Isolated actual application mouse note move, resize, velocity and Shift-marquee cancellation with Escape; exact project/history checks. Selected-note resize, repeated arrow nudge, separate key press, octave shift and length adjustment preserve the unselected note and support exact Undo. Synthetic MIDI; no personal project, input device or model calls.'};
  fs.writeFileSync('tests/fixtures/midi-gesture-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
