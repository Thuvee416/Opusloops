const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
(async()=>{
 const browser=await chromium.launch();const page=await browser.newPage({acceptDownloads:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>sessionStorage.setItem('opus.agent.session',JSON.stringify({access_token:'TEST_ONLY'})));
 await page.goto(process.env.OPUS_TEST_URL||'http://127.0.0.1:4178');
 await page.locator('html:not([data-startup])').waitFor();await page.getByRole('button',{name:'Enter Studio'}).click();
 const {emptyProject}=await import('../web-studio/model.js');const modelFixture=process.env.OPUS_AGENT_PLAN_FIXTURE?JSON.parse(await fs.readFile(process.env.OPUS_AGENT_PLAN_FIXTURE,'utf8')):null;const source=modelFixture?.source||emptyProject();source.name='Agent sequence';
 await page.locator('#project-file').setInputFiles({name:'sequence.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(source))});
 let mode='compose';const downloads=[];page.on('download',d=>downloads.push(d));
 await page.route('**/functions/v1/studio-agent',async route=>{
  const body=route.request().postDataJSON(),id=body.context.project.tracks[0].id;let actions;
  if(mode==='compose'&&modelFixture)actions=modelFixture.plan.actions;else if(mode==='compose')actions=[
   {type:'project',args:{bpm:128}},{type:'instrument',args:{trackId:id,preset:'Warm bass'}},
   {type:'midi',args:{trackId:id,ref:'$riff',scene:0,beats:4,notes:[{pitch:36,start:0,duration:.5,velocity:.8},{pitch:43,start:2,duration:1,velocity:.7}]}},
   {type:'region',args:{trackId:id,clipId:'$riff',start:0,length:8}},
   {type:'command',args:{name:'view',args:{view:'arrangement'}}},
   {type:'command',args:{name:'play'}},{type:'command',args:{name:'pause'}},
   {type:'command',args:{name:'export_wav'}},{type:'command',args:{name:'save_project'}}
  ];else if(mode==='stop-edit')actions=[{type:'command',args:{name:'stop'}},{type:'project',args:{bpm:126}},{type:'command',args:{name:'play'}},{type:'command',args:{name:'pause'}}];
  else actions=[{type:'project',args:{bpm:127}},{type:'command',args:{name:'export_wav'}}];
  await route.fulfill({json:{summary:'Sequence '+mode+' finished.',actions}});
 });
 const run=async text=>{await page.locator('#agent-prompt').fill(text);await page.getByRole('button',{name:'Run agent',exact:true}).click();};
 await run('Compose a bass phrase, arrange it, play and pause, export WAV and save.');
 await page.getByText('Sequence compose finished.',{exact:true}).waitFor();assert.equal(downloads.length,2);
 const wav=await fs.readFile(await downloads[0].path());assert.equal(wav.toString('ascii',0,4),'RIFF');
 let offset=12,data;while(offset+8<=wav.length){const size=wav.readUInt32LE(offset+4);if(wav.toString('ascii',offset,offset+4)==='data'){data=wav.subarray(offset+8,offset+8+size);break;}offset+=8+size+(size%2);}
 assert.ok(data?.length>44100*3);let sum=0,peak=0;for(let i=0;i+2<data.length;i+=3){const v=data.readIntLE(i,3)/8388608;sum+=v*v;peak=Math.max(peak,Math.abs(v));}
 assert.ok(Math.sqrt(sum/(data.length/3))>1e-5,'Export must contain sound');assert.ok(peak<1,'Fixture must not clip');
 const saved=JSON.parse(await fs.readFile(await downloads[1].path(),'utf8'));assert.equal(saved.bpm,128);assert.equal(saved.arrangement.length,1);assert.ok(Object.values(saved.clips)[0].notes.length>=1);
 const log=await page.locator('.agent-log').innerText();assert.ok(log.indexOf('Completed: view')<log.indexOf('Completed: play'));assert.ok(log.indexOf('Completed: pause')<log.indexOf('Export ready:'));
 await page.locator('#play').focus();await page.keyboard.press('Control+z');assert.equal(await page.locator('#bpm').inputValue(),'120');assert.equal(await page.locator('.region[data-region]').count(),0);
 await page.keyboard.press('Control+Shift+z');assert.equal(await page.locator('#bpm').inputValue(),'128');
 await page.locator('#play').click();await page.waitForFunction(()=>document.getElementById('play').classList.contains('playing'));
 mode='stop-edit';await run('Stop, set the tempo to 126, play then pause.');
 await page.getByText('Sequence stop-edit finished.',{exact:true}).waitFor();assert.equal(await page.locator('#bpm').inputValue(),'126');assert.equal(await page.locator('#play').evaluate(e=>e.classList.contains('playing')),false);
 // Force a rendering failure after an edit to verify honest progress and Undo.
 await page.evaluate(()=>{window.qaRender=OfflineAudioContext.prototype.startRendering;OfflineAudioContext.prototype.startRendering=function(){return Promise.reject(new Error('QA render failure'));};});
 mode='failed-export';await run('Set tempo to 127 and export.');await page.getByText(/QA render failure.*Project edits remain applied/).waitFor();assert.equal(await page.locator('#bpm').inputValue(),'127');assert.equal(downloads.length,2);
 await page.evaluate(()=>{OfflineAudioContext.prototype.startRendering=window.qaRender;});
 await page.locator('#play').focus();await page.keyboard.press('Control+z');assert.equal(await page.locator('#bpm').inputValue(),'126');
 await page.evaluate(()=>{OfflineAudioContext.prototype.startRendering=async function(){await new Promise(r=>setTimeout(r,1000));return window.qaRender.call(this);};});
 await run('Change tempo and export, then cancel the render.');
 await page.waitForFunction(()=>document.getElementById('bpm').value==='127');await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByText(/Cancelled.*Project edits remain applied/).waitFor();assert.equal(downloads.length,2);assert.equal(await page.locator('#bpm').inputValue(),'127');
 await page.evaluate(()=>{OfflineAudioContext.prototype.startRendering=window.qaRender;});
 await page.locator('#play').focus();await page.keyboard.press('Control+z');assert.equal(await page.locator('#bpm').inputValue(),'126');
 await page.getByRole('menuitem',{name:'File',exact:true}).click();await page.getByRole('menuitem',{name:'Export Audio/Video...',exact:true}).click();
 await page.locator('#export-dialog').waitFor({state:'visible'});await page.locator('#export-rate').selectOption('48000');await page.locator('#export-depth').selectOption('16');await page.locator('#export-source').selectOption('range');await page.locator('#export-start').fill('1');await page.locator('#export-length').fill('2');await page.locator('#export-tail').uncheck();
 const manualDownload=page.waitForEvent('download');await page.locator('#export-confirm').click();const manual=await fs.readFile(await(await manualDownload).path());assert.equal(manual.readUInt32LE(24),48000);assert.equal(manual.readUInt16LE(34),16);assert.ok(Math.abs(manual.readUInt32LE(40)/4-Math.ceil(2*60/126*48000))<=1);
 assert.deepEqual(errors,[]);await browser.close();
 console.log('PASS: composition → Arrangement → play/pause → non-silent WAV/project downloads; one Undo/Redo; stop-before-edit; failed/cancelled exports report applied edits; manual range/rate/depth export preserved.');
})().catch(e=>{console.error(e);process.exit(1)});
