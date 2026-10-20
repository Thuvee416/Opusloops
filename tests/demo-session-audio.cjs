// Native Web Audio check. Serve web-studio locally; run with Playwright available.
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const out=process.env.OPUS_DEMO_OUTPUT||'/tmp';
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.OPUS_CHROMIUM?{executablePath:process.env.OPUS_CHROMIUM}:{})}),page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.OPUS_TEST_URL||'http://127.0.0.1:4196/');await page.waitForFunction(()=>document.documentElement.dataset.startup===undefined,{timeout:30000});
 const startup=await page.evaluate(()=>({name:document.querySelector('#project-name').value,arrangementVisible:!document.querySelector('#arrangement-view').classList.contains('hidden'),status:document.querySelector('#status').textContent}));
 assert.equal(startup.name,'Midnight Circuit');assert.equal(startup.arrangementVisible,true);
 const rendered=await page.evaluate(async()=>{
  const {createDemoSession}=await import('./demo-session.js'),{Engine}=await import('./audio.js');
  const project=createDemoSession(),e=new Engine(project,()=>{});
  try{const wav=await e.render({source:'arrangement',sampleRate:44100,bitDepth:32,dither:'none',normalize:false,includeTail:false}),v=new DataView(wav),frames=v.getUint32(40,true)/8;let peak=0,sum=0,mid=0,side=0,dot=0,left=0,right=0;const blocks=[];
  for(let f=0;f<frames;f++){const l=v.getFloat32(44+f*8,true),r=v.getFloat32(48+f*8,true);if(!Number.isFinite(l+r))throw Error('Non-finite sample');peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=l*l+r*r;mid+=(l+r)**2;side+=(l-r)**2;dot+=l*r;left+=l*l;right+=r*r;const b=Math.floor(f/(44100*2));blocks[b]=(blocks[b]??0)+l*l+r*r;}
  const bytes=new Uint8Array(wav);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return {base64:btoa(binary),project,metrics:{seconds:frames/44100,peakDB:20*Math.log10(peak),rmsDB:10*Math.log10(sum/(frames*2)),sideToMid:Math.sqrt(side/mid),correlation:dot/Math.sqrt(left*right),blockEnergy:blocks}};
  }finally{await e.context?.close();}
 });
 assert.ok(rendered.metrics.peakDB<0);assert.ok(rendered.metrics.sideToMid>.1);assert.ok(rendered.metrics.correlation>.6);assert.ok(rendered.metrics.seconds>18&&rendered.metrics.seconds<20);
 fs.writeFileSync(path.join(out,'opus-midnight-circuit.wav'),Buffer.from(rendered.base64,'base64'));fs.writeFileSync(path.join(out,'opus-midnight-circuit.opusloop'),JSON.stringify(rendered.project));

 const presets=await page.evaluate(async()=>{const {listSoundPresets,getSoundPreset}=await import('./sound-presets.js');const items=await listSoundPresets();for(const item of items)await getSoundPreset(item.id);return items.filter(x=>x.factory).length;});assert.equal(presets,15);
 await page.evaluate(async()=>{const {emptyProject}=await import('./model.js');const p=emptyProject();p.name='Existing Test Set';await new Promise((resolve,reject)=>{const req=indexedDB.open('looproom-studio',1);req.onsuccess=()=>{const db=req.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(p,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});});
 await page.reload();await page.waitForFunction(()=>document.querySelector('#project-name')?.value==='Existing Test Set');
 page.on('dialog',dialog=>dialog.accept());await page.evaluate(()=>document.querySelector('#open-demo').click());await page.waitForFunction(()=>document.querySelector('#project-name')?.value==='Midnight Circuit');
 const previous=await page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('looproom-studio',1);req.onsuccess=()=>{const db=req.result,r=db.transaction('projects').objectStore('projects').get('previous');r.onsuccess=()=>{db.close();resolve(r.result.name);};};}));assert.equal(previous,'Existing Test Set');assert.deepEqual(errors,[]);
 const proof={status:'passed',startup,errors,factorySounds:presets,savedProjectPreserved:true,metrics:rendered.metrics,scope:'Native headless Chromium Web Audio, fresh isolated storage, full Arrangement render and preset library. No human listening or mobile audio assessment.'};
 fs.writeFileSync(path.join(out,'opus-demo-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
