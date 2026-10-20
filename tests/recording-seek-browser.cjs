const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM}),results=[];
 try{for(const mode of ['new','overdub']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  try{
   await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
   await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
   const fixture=await page.evaluate(async()=>{
    const [{Engine},{emptyProject}]=await Promise.all([import('/audio.js'),import('/model.js')]);
    const init=Engine.prototype.init;Engine.prototype.init=function(...args){window.testEngine=this;return init.apply(this,args);};
    const p=emptyProject();p.name='Recording Seek Verification';p.sceneNames=['Intro','Lift','Breakdown','Return'];p.returns=[];
    p.clips.loop={id:'loop',kind:'midi',name:'Original Loop',beats:4,sourceBpm:120,notes:[{pitch:48,start:0,duration:.5,velocity:.5}]};p.tracks[0].slots[0]='loop';return p;
   });
   const press=id=>page.evaluate(id=>{const b=document.getElementById(id);if(b.disabled)throw Error(id+' is disabled');return b.onclick();},id);
   const save=async()=>{const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
   await page.locator('#project-file').setInputFiles({name:'Recording.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
   await page.waitForFunction(()=>document.querySelector('#project-name').value==='Recording Seek Verification'&&!document.querySelector('#save').disabled);
   const original=await save();assert.deepEqual(original,fixture);
   await press('arrangement-tab');
   await page.evaluate(mode=>{for(const [id,value]of Object.entries({'input-kind':'midi','input-mode':mode,'input-count-in':'0'})){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}},mode);
   await press('input-connect');await press('input-record');await page.waitForTimeout(200);
   const note=type=>page.evaluate(type=>{document.activeElement?.blur();document.body.dispatchEvent(new KeyboardEvent(type,{code:'KeyA',key:'a',bubbles:true}));},type);
   await note('keydown');
   const state=()=>page.evaluate(()=>({origin:testEngine.origin??null,generation:testEngine.playGeneration,marker:testEngine.insertMarker,position:testEngine.position,playing:testEngine.playing,preview:testEngine.inputOverdub?.previewId??null}));
   const before=await state();
   // Use a real visible ruler target, not a programmatic Engine call.
   const destination=await page.locator('[data-seek]').evaluateAll(els=>els.map(el=>Number(el.dataset.seek)).find(n=>n>=8));
   assert.ok(Number.isFinite(destination));await page.locator(`[data-seek="${destination}"]`).first().click();
   assert.match(await page.locator('#status').textContent(),/Finish Recording.*Before Seeking/);
   assert.deepEqual(await state(),before);assert.equal(await page.locator('#input-finish').isDisabled(),false);assert.equal(await page.locator('#seek').isDisabled(),true);
   await page.waitForTimeout(150);await note('keyup');await press('input-finish');if(mode==='overdub')await press('stop');
   const saved=await save(),clip=mode==='overdub'?saved.clips.loop:Object.values(saved.clips).find(c=>c.id!=='loop');
   assert.ok(clip);const added=mode==='overdub'?clip.notes.slice(original.clips.loop.notes.length):clip.notes;
   assert.equal(added.length,1);assert.ok(added[0].duration>.1&&added[0].duration<2);assert.ok(added[0].start<4);
   if(mode==='overdub'){assert.deepEqual(clip.notes.slice(0,1),original.clips.loop.notes);const preserved=structuredClone(saved);preserved.clips.loop=original.clips.loop;assert.deepEqual(preserved,original);}
   else assert.deepEqual(saved.clips.loop,original.clips.loop);
   await press('undo');assert.deepEqual(await save(),original);await press('redo');assert.deepEqual(await save(),saved);
   assert.deepEqual(errors,[]);results.push({mode,destination,transportPreserved:before,addedNotes:added,exactUndoRedo:true,originalLoopPreserved:true,errors});
  }finally{await page.close();}
 }
 const proof={status:'passed',results,scope:'Isolated actual application standalone MIDI and Session overdub, generated original loop, computer-keyboard held note across a visible Arrangement-ruler click. Transport identity/clock origin retained, recording remains active, exact saved-project Undo/Redo. No personal project, microphone, physical controller or live model evaluation.'};
 fs.writeFileSync('tests/fixtures/recording-seek-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
