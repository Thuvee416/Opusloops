const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const looping=process.env.OPUS_AUTOMATION_LOOP==='1';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM}),results=[];
 try{for(const mode of ['touch','latch']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  try{
   await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
   await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
   const fixture=await page.evaluate(async looping=>{
    const [{Engine},{emptyProject,wav},{encode64}]=await Promise.all([import('/audio.js'),import('/model.js'),import('/input.js')]);
    const start=Engine.prototype.startAutomationRecording;Engine.prototype.startAutomationRecording=function(...args){window.testEngine=this;return start.apply(this,args);};
    const p=emptyProject();p.name='Automation Take Verification';p.sceneNames=['Intro','Lift','Breakdown','Return'];p.returns=[];p.transport.loopEnabled=looping;if(looping){p.transport.loopStart=2;p.transport.loopEnd=4;}
    const t=p.tracks[0];t.id='tone';t.volume=.8;t.devices=[];t.automation={volume:{enabled:true,points:[{beat:0,value:.8,curve:'step'},{beat:16,value:.8,curve:'step'}]}};
    const c=new OfflineAudioContext(1,88200,44100),b=c.createBuffer(1,88200,44100),pcm=b.getChannelData(0);
    for(let n=0;n<pcm.length;n++)pcm[n]=.1*Math.sin(2*Math.PI*220*n/44100);
    p.clips.source={id:'source',name:'Tone',kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(b))};t.slots[0]='source';
    p.arrangement=[{id:'region',trackId:t.id,clipId:'source',start:0,length:16,offset:0}];return p;
   },looping);
   const press=id=>page.evaluate(id=>{const b=document.getElementById(id);if(b.disabled)throw Error(id+' is disabled');return b.onclick();},id);
   const save=async()=>{const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
   const open=async p=>{await page.locator('#project-file').setInputFiles({name:'Automation.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await page.waitForFunction(()=>document.querySelector('#project-name').value==='Automation Take Verification'&&!document.querySelector('#save').disabled);};
   await open(fixture);await press('session-tab');const before=await save();assert.deepEqual(before,fixture);
   await page.evaluate(mode=>document.getElementById('auto-mode').value=mode,mode);await press('auto-record');
   await page.waitForFunction(looping=>window.testEngine?.automationTake&&testEngine.rawBeat()>(looping?3:.5),looping);
   await page.evaluate(()=>{window.probe=testEngine.context.createAnalyser();probe.fftSize=2048;testEngine.mixers.get('tone').pan.connect(probe);});
   const meter=()=>page.evaluate(async()=>{await new Promise(r=>setTimeout(r,180));const a=new Float32Array(probe.fftSize);probe.getFloatTimeDomainData(a);return {beat:testEngine.rawBeat(),rms:Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length),writing:testEngine.automationTake?.writing.size??0};});
   const initial=await meter();assert.ok(initial.rms>.02);
   const slider=page.locator('[data-channel="tone"] [data-volume]');await slider.focus();assert.equal(await slider.evaluate(el=>el===document.activeElement),true);
   const start=await page.evaluate(()=>testEngine.rawBeat());await page.keyboard.down('Home');
   if(looping)await page.waitForFunction(()=>testEngine.rawBeat()>4.25);
   const held=await meter();assert.equal(held.writing,1);assert.ok(held.rms<.00001,JSON.stringify({mode,held}));
   await page.keyboard.up('Home');const release=await page.evaluate(()=>testEngine.rawBeat()),released=await meter();
   assert.equal(released.writing,mode==='touch'?0:1);
   if(mode==='touch')assert.ok(released.rms>.02,JSON.stringify({mode,released}));else assert.ok(released.rms<.00001);
   await press('auto-record');const finish=await page.evaluate(()=>testEngine.rawBeat());await press('stop');
   const after=await save();assert.notDeepEqual(after,before);assert.equal(after.tracks[0].volume,0);
   const preserved=structuredClone(after);preserved.tracks[0].volume=before.tracks[0].volume;preserved.tracks[0].automation=before.tracks[0].automation;assert.deepEqual(preserved,before);
   await press('undo');assert.deepEqual(await save(),before);await press('redo');assert.deepEqual(await save(),after);
   await open(after);assert.deepEqual(await save(),after);
   const rendered=await page.evaluate(async({project,start,release,finish,mode,looping})=>{
    const [{Engine},{renderWavSnapshot}]=await Promise.all([import('/audio.js'),import('/wav-delivery.js')]);
    const e=new Engine(project,()=>{}),wave=await renderWavSnapshot(e,{source:'arrangement',includeTail:false,bitDepth:32,sampleRate:44100,normalize:false}),v=new DataView(wave.data);
    const rms=(from,to)=>{let sum=0,count=0;for(let n=Math.ceil(from*.5*44100);n<Math.floor(to*.5*44100);n++){sum+=v.getFloat32(44+n*8,true)**2;count++;}return Math.sqrt(sum/count);};
    return {frames:v.getUint32(40,true)/8,before:rms(.1,looping?1.9:start-.05),held:rms(start+.1,looping?3.95:release-.05),after:rms(release-(looping?2:0)+.1,finish-(looping?2:0)-.05),...(looping?{wrapped:rms(2.1,release-2-.05),outsideLoop:rms(4.1,6)}:{}),mode};
   },{project:after,start,release,finish,mode,looping});
   if(looping){assert.ok(start<3.8&&release>4&&finish<6);assert.ok(rendered.wrapped<.00001);assert.ok(rendered.outsideLoop>.02);}
   assert.equal(rendered.frames,352800);assert.ok(rendered.before>.02);assert.ok(rendered.held<.00001);
   if(mode==='touch')assert.ok(rendered.after>.02);else assert.ok(rendered.after<.00001);
   assert.deepEqual(errors,[]);results.push({mode,start,release,finish,initial,held,released,rendered,exactUndoRedoAndReopen:true,unrelatedProjectDataPreserved:true,errors});
  }finally{await page.close();}
 }
 const proof={status:'passed',looping,results,scope:'Isolated actual application Touch/Latch recording using keyboard fader gestures, real audio-clock and native analyser; optional nonzero-start Arrangement loop crossed while held, with WAV checks inside and outside the loop; exact saved project Undo/Redo and reopen; native WAV render from the reopened data. Synthetic source; no personal project, microphone, provider or physical output checks.'};
 fs.writeFileSync('tests/fixtures/'+(looping?'automation-loop':'automation-take')+'-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
