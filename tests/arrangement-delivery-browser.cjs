const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');

function unzip(bytes){
 const files=new Map();let offset=0;
 while(bytes.readUInt32LE(offset)===0x04034b50){
  assert.equal(bytes.readUInt16LE(offset+8),0,'Expected stored ZIP entries');
  const size=bytes.readUInt32LE(offset+18),names=bytes.readUInt16LE(offset+26),
   extra=bytes.readUInt16LE(offset+28),name=bytes.toString('utf8',offset+30,offset+30+names),
   start=offset+30+names+extra;
  files.set(name,bytes.subarray(start,start+size));offset=start+size;
 }
 return files;
}
function wave(bytes){
 assert.equal(bytes.readUInt16LE(20),3);assert.equal(bytes.readUInt16LE(22),2);
 assert.equal(bytes.readUInt32LE(24),44100);assert.equal(bytes.readUInt16LE(34),32);
 return {frames:bytes.readUInt32LE(40)/8,sample:(frame,ch)=>bytes.readFloatLE(44+frame*8+ch*4)};
}
function difference(a,b,from,to,shift=0){
 let max=0,energy=0,error=0,count=0;
 for(let frame=Math.ceil(from*22050);frame<Math.floor(to*22050);frame++)for(let ch=0;ch<2;ch++){
  const x=a.sample(frame-Math.round(shift*22050),ch),y=b.sample(frame,ch);
  max=Math.max(max,Math.abs(x-y));energy+=y*y;error+=(x-y)**2;count++;
 }
 return {max,rms:Math.sqrt(energy/count),rmsDifference:Math.sqrt(error/count)};
}

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:4196/');
  await page.waitForFunction(()=>!document.documentElement.dataset.startup);
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const fixture=await page.evaluate(async()=>{
   const [{emptyProject,makeTrack,wav},{encode64}]=await Promise.all([import('/model.js'),import('/input.js')]);
   const p=emptyProject();p.name='Arrangement Delivery Verification';p.tracks=[makeTrack('Pulse'),makeTrack('Texture'),makeTrack('Untouched')];
   p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];
   p.locators=[{id:'a',name:'Opening',beat:0},{id:'b',name:'Theme',beat:8}];
   p.transport.loopStart=0;p.transport.loopEnd=16;
   for(const [i,t]of p.tracks.entries()){
    t.id=['pulse','texture','untouched'][i];
    const ctx=new OfflineAudioContext(1,88200,44100),buffer=ctx.createBuffer(1,88200,44100),pcm=buffer.getChannelData(0);
    for(let n=0;n<pcm.length;n++)pcm[n]=.08*Math.sin(2*Math.PI*(220+i*110)*n/44100);
    const id='source-'+i;p.clips[id]={id,name:t.name,kind:'audio',beats:4,sourceBpm:120,data:encode64(wav(buffer))};t.slots[0]=id;
    p.arrangement.push({id:'region-'+i,trackId:t.id,clipId:id,start:0,length:16,offset:0});
    if(i===0)p.arrangement.at(-1).fades={in:{start:0,end:2,from:0,to:1},out:{start:14,end:16,from:1,to:0}};
    t.automation={volume:{enabled:true,points:[{beat:0,value:.2,curve:'linear'},{beat:8,value:.8,curve:'linear'},{beat:16,value:.35,curve:'step'}]}};
    if(i===1)t.automation.pan={enabled:true,points:[{beat:0,value:-.7,curve:'linear'},{beat:16,value:.7,curve:'step'}]};
   }
   return p;
  });
  const press=id=>page.evaluate(id=>document.getElementById(id).onclick(),id);
  const download=async id=>{
   // Pace repeated artifacts below Chromium's automatic-download burst limit.
   await new Promise(resolve=>setTimeout(resolve,1100));
   const pending=page.waitForEvent('download').catch(async e=>{throw new Error(`${id}: ${await page.locator('#status').textContent()} (${e.message})`);});
   // Exercise the real Save shortcut as well as the command-control paths.
   if(id==='save'){await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Control+s');}
   else await press(id);
   return fs.readFileSync(await(await pending).path());
  };
  const save=async()=>JSON.parse((await download('save')).toString());
  const open=async p=>{
   await page.locator('#project-file').setInputFiles({name:'Arrangement.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});
   await page.waitForFunction(()=>document.querySelector('#project-name').value==='Arrangement Delivery Verification'&&!document.querySelector('#save').disabled);
   assert.deepEqual(await save(),p);
  };
  await open(fixture);const before=await save();
  const exportSettings=()=>page.evaluate(()=>{
   for(const [id,value]of Object.entries({'export-source':'range','export-start':'1','export-length':'20','export-rate':'44100','export-depth':'32','export-dither':'none','export-stem-scope':'all'})){
    const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));
   }
   document.querySelector('#export-tail').checked=false;document.querySelector('#export-normalize').checked=false;
  });
  await exportSettings();
  const baseline=unzip(await download('export-stems'));
  const edit=async(action,start,length)=>{
   await page.evaluate(({start,length})=>{document.querySelector('#time-start').value=start+1;document.querySelector('#time-length').value=length;},{start,length});
   await press('time-'+action);
  };
  await page.evaluate(()=>{
   const scope=document.querySelector('#time-scope');scope.value='tracks';scope.dispatchEvent(new Event('change',{bubbles:true}));
   const tracks=document.querySelector('#time-tracks');for(const o of tracks.options)o.selected=['pulse','texture'].includes(o.value);tracks.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert.equal(await page.locator('#time-scope').inputValue(),'tracks');
  await edit('insert',4,2);const inserted=await save();
  assert.equal(inserted.arrangement.filter(r=>r.trackId==='pulse').length,2);
  assert.deepEqual(inserted.tracks[2],before.tracks[2]);
  assert.deepEqual(inserted.arrangement.filter(r=>r.trackId==='untouched'),before.arrangement.filter(r=>r.trackId==='untouched'));
  assert.deepEqual(inserted.transport,before.transport);assert.deepEqual(inserted.locators,before.locators);
  await edit('cut',8,2);const cut=await save();
  await edit('paste',16,2);const final=await save();
  assert.deepEqual(final.tracks[2],before.tracks[2]);assert.deepEqual(final.locators,before.locators);
  assert.deepEqual(final.transport,before.transport);
  for(const [id,c]of Object.entries(before.clips))assert.deepEqual(final.clips[id],c);
  for(const id of ['pulse','texture']){
   const placement=final.arrangement.find(r=>r.trackId===id&&r.start===16);
   assert.equal(placement.length,2);assert.equal(placement.offset,6);
   assert.equal(final.clips[placement.clipId].data,before.clips['source-'+(id==='pulse'?0:1)].data);
  }
  for(const expected of [cut,inserted,before]){await press('undo');assert.deepEqual(await save(),expected);}
  for(const expected of [inserted,cut,final]){await press('redo');assert.deepEqual(await save(),expected);}
  const delivered=unzip(await download('export-stems')),mix=await download('export'),repeatMix=await download('export');
  await open(final);await exportSettings();
  const reopened=unzip(await download('export-stems')),reopenedMix=await download('export');
  const masterDifference=difference(wave(mix),wave(reopenedMix),0,20),
   repeatedMasterDifference=difference(wave(mix),wave(repeatMix),0,20);
  assert.equal(mix.length,reopenedMix.length);assert.equal(mix.length,repeatMix.length);
  const manifest=JSON.parse(delivered.get('manifest.json').toString()),metrics=[];
  assert.equal(manifest.channels.length,3);assert.deepEqual(manifest.settings.range,{start:0,length:20});
  for(const c of manifest.channels){
   const bytes=delivered.get(c.file),reopenDifference=difference(wave(bytes),wave(reopened.get(c.file)),0,20);
   assert.equal(reopenDifference.max,0,'Stem changed after reopen: '+c.id);
   const a=wave(baseline.get(c.file)),b=wave(bytes);assert.equal(b.frames,441000);
   if(c.id==='untouched'){
    const result=difference(a,b,0,20);assert.equal(result.max,0);assert.ok(result.rms>.01);metrics.push({channel:c.id,unchanged:result});
   }else{
    const opening=difference(a,b,.1,3.9),shifted=difference(a,b,6.1,7.9,2),
     rejoined=difference(a,b,8.1,15.9),moved=difference(a,b,16.1,17.9,10);
    for(const result of [opening,shifted,rejoined,moved])assert.ok(result.max<1e-4,JSON.stringify({channel:c.id,result}));
    let gap=0;for(let f=4.1*22050;f<5.9*22050;f++)for(let ch=0;ch<2;ch++)gap=Math.max(gap,Math.abs(b.sample(Math.floor(f),ch)));
    assert.ok(gap<1e-6);metrics.push({channel:c.id,opening,shifted,rejoined,moved,gapPeak:gap});
   }
  }
  // Compare the processed master with an explicit sub-16-bit PCM tolerance.
  // Stems bypass master processing and must remain sample-for-sample exact.
  assert.ok(repeatedMasterDifference.max<1e-5,JSON.stringify(repeatedMasterDifference));
  assert.ok(masterDifference.max<1e-5,JSON.stringify(masterDifference));
  assert.deepEqual(errors,[]);
  const proof={status:'passed',multiTrackInsertCutPaste:true,globalMarkersAndUntouchedTrackPreserved:true,sourceAudioPreserved:true,threeUndoRedoExact:true,downloadedProjectReopenedExactly:true,stemsIdenticalAfterReopen:true,masterDifference,repeatedMasterDifference,masterTolerance:1e-5,alignedStemFrames:441000,metrics,errors,scope:'Isolated Chromium real project import and application time-edit, Save shortcut, Undo/Redo, WAV and ZIP export controls. Two selected tracks with volume/pan automation and Arrangement fades, one untouched track. Master PCM tolerance 0.00001; stems must match exactly after reopen. Synthetic source audio; no personal project, physical playback or subjective quality check.'};
  fs.writeFileSync('tests/fixtures/arrangement-delivery-browser-proof.json',JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
