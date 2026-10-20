const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM}),results=[],errors=[];
try{
 const runtimeFiles=['agent.css','app.js','workspace.js','live-layout.css','neutral-theme.css','interaction-theme.css','release.json'];
 const hashes=()=>Object.fromEntries(runtimeFiles.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync('web-studio/'+f)).digest('hex')])),runtimeHashes=hashes();
 for(const viewport of [{width:667,height:375},{width:390,height:700},{width:390,height:844}]){
  const page=await browser.newPage({viewport,hasTouch:true,isMobile:true});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());const input=await page.context().newCDPSession(page);
  await page.goto('http://127.0.0.1:4196');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject,wav},{encode64}]=await Promise.all([import('/model.js'),import('/input.js')]),p=emptyProject();p.name='Touch Editing Verification';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];
   p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch:60,start:1,duration:1,velocity:.7}]};p.tracks[0].slots[0]='phrase';
   const c=new OfflineAudioContext(1,44100,44100),b=c.createBuffer(1,44100,44100),pcm=b.getChannelData(0);for(let i=0;i<pcm.length;i++)pcm[i]=.1*Math.sin(2*Math.PI*220*i/44100);
   p.clips.tone={id:'tone',name:'Tone',kind:'audio',beats:2,sourceBpm:120,data:encode64(wav(b))};p.tracks[0].slots[1]='tone';p.arrangement=[{id:'midi-region',trackId:p.tracks[0].id,clipId:'phrase',start:0,length:2,offset:0},{id:'audio-region',trackId:p.tracks[0].id,clipId:'tone',start:4,length:2,offset:0}];
   window.touchEvents=[];document.addEventListener('pointerdown',e=>{if(e.target.closest('[data-midi-note],[data-region]'))touchEvents.push(e.pointerType);},true);return p;
  });
  const press=id=>page.evaluate(id=>{const e=document.getElementById(id);if(e.disabled)throw Error(id+' disabled');return e.onclick?e.onclick():e.click();},id);
  const save=async()=>{await page.waitForTimeout(1100);const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
  const undo=async()=>{await page.getByRole('menubar').getByRole('menuitem',{name:'Edit',exact:true}).tap();await page.getByRole('menuitem',{name:'Undo',exact:true}).tap();};
  await page.locator('#project-file').setInputFiles({name:'Touch.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForFunction(()=>document.querySelector('#project-name').value==='Touch Editing Verification');assert.deepEqual(await save(),fixture);assert.ok((await page.locator('.studio-center>main').boundingBox()).height>=320,'DAW Workspace Collapsed');
  await press('session-tab');await page.evaluate(()=>document.querySelector('[data-select="phrase"]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2})));await press('piano-fit-pitches');
  const drag=async(selector,units,{cancel=false}={})=>{
   const target=page.locator(selector);await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();assert.ok(box);const x=box.x+box.width/2,y=box.y+box.height/2;
   assert.equal(await target.evaluate((el,{x,y})=>{const hit=document.elementFromPoint(x,y);return el.contains(hit);},{x,y}),true,'Touch Target Is Obscured');
   const beforeTouches=await page.evaluate(()=>touchEvents.length);
   const width=await target.evaluate(el=>(el.closest('[data-midi-note]')||el.closest('[data-region]')).parentElement.getBoundingClientRect().width),dx=width/8*units;
   assert.ok(x>0&&x<viewport.width&&y>0&&y<viewport.height,'Touch target outside viewport');assert.ok(x+dx>0&&x+dx<viewport.width,JSON.stringify({error:'Touch Endpoint Outside Viewport',viewport,selector,x,y,dx}));
   const points=(x,y)=>[{id:1,x,y,radiusX:3,radiusY:3,force:1}];await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(x,y)});
   for(let i=1;i<=6;i++){await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(x+dx*i/6,y)});await page.waitForTimeout(20);}
   await input.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>touchEvents.length),beforeTouches+1,'Gesture Did Not Reach The Editor');
  };
  const cases=[];
  for(const [name,selector,field] of [['Note Move','[data-midi-note="0"]','start'],['Note Resize','[data-midi-note="0"] [data-note-resize]','duration']]){
   await drag(selector,1,{cancel:true});assert.deepEqual(await save(),fixture);assert.equal(await page.locator('#undo').isDisabled(),true);
   await drag(selector,1);const expected=structuredClone(fixture);expected.clips.phrase.notes[0][field]+=1;assert.deepEqual(await save(),expected);await undo();assert.deepEqual(await save(),fixture);cases.push({name,touchCancelExact:true,editExact:true,undoExact:true});
  }
  await press('arrangement-tab');await page.evaluate(()=>{const e=document.getElementById('timeline-bars');e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));});
  for(const id of ['midi-region','audio-region'])for(const [kind,suffix,field]of [['Move','','start'],['Resize',' [data-resize="end"]','length']]){
   const selector='[data-region="'+id+'"]'+suffix,delta=id==='audio-region'?-.5:.5;console.log(JSON.stringify({viewport,case:id+' '+kind}));await drag(selector,delta,{cancel:true});assert.deepEqual(await save(),fixture);assert.equal(await page.locator('#undo').isDisabled(),true);
   await drag(selector,delta);const expected=structuredClone(fixture);expected.arrangement.find(r=>r.id===id)[field]+=delta;assert.deepEqual(await save(),expected);await undo();assert.deepEqual(await save(),fixture);cases.push({name:id+' '+kind,touchCancelExact:true,editExact:true,undoExact:true});
  }
  // Odesa remains inline and reachable without covering the editor or moving chrome.
  const chromeBefore=await page.locator('.transport').boundingBox();
  const prompt=page.locator('#studio-agent textarea').first();await prompt.scrollIntoViewIfNeeded();
  assert.equal(await prompt.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el;}),true,'Odesa Prompt Is Obscured');
  await prompt.fill('Local UI Check Only');await prompt.fill('');
  const toggle=page.locator('#agent-open');await toggle.scrollIntoViewIfNeeded();await toggle.tap();assert.equal(await page.locator('.studio-center').evaluate(e=>e.classList.contains('agent-collapsed')),true);
  await toggle.tap();assert.equal(await page.locator('#studio-agent').isVisible(),true);
  await press('session-tab');await page.evaluate(()=>document.querySelector('[data-select="phrase"]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2})));await press('piano-fit-pitches');const note=page.locator('[data-midi-note="0"]');await note.scrollIntoViewIfNeeded();
  assert.equal(await note.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'Editor Lost After Odesa Toggle');
  assert.deepEqual(await page.locator('.transport').boundingBox(),chromeBefore);assert.equal(await page.evaluate(()=>scrollX===0&&scrollY===0),true);assert.equal(await page.locator('.studio-center').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Workspace Has Horizontal Bleed');
  assert.deepEqual(await save(),fixture);
  const pointerTypes=await page.evaluate(()=>touchEvents);assert.ok(pointerTypes.length>=12);assert.ok(pointerTypes.every(t=>t==='touch'));results.push({viewport,cases,pointerTypes,savedProjectExact:true,odesaReachable:true,collapseReopenEditorUsable:true,fixedChrome:true,noHorizontalBleed:true});await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(hashes(),runtimeHashes);const proof={status:'passed',runtimeHashes,runtimeUnchanged:true,results,errors,scope:'Isolated local Chromium with native CDP touch input at portrait and landscape mobile viewports; MIDI note and audio/MIDI Arrangement move/resize/cancel, menu Undo and downloaded-project comparisons. Synthetic projects/audio only. Emulation does not certify physical phone hardware, Safari or audio latency.'};fs.writeFileSync('tests/fixtures/touch-editing-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
