const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
 const result=await page.evaluate(async()=>{
  const select=document.querySelector('#audio-output');
  await select.onchange({target:{value:''}});
  const {AudioOutputRoute}=await import('./audio-output.js'),route=new AudioOutputRoute(),ctx=new AudioContext();await route.select(ctx,'');const native={sinkId:ctx.sinkId,state:ctx.state};await ctx.close();
  return {supported:typeof AudioContext.prototype.setSinkId==='function',value:select.value,disabled:select.disabled,monitor:document.querySelector('#input-monitor').checked,status:document.querySelector('#audio-output-status').textContent,playing:document.querySelector('#play').getAttribute('aria-pressed'),native};
 });assert.equal(result.supported,true);assert.equal(result.value,'');assert.equal(result.disabled,false);assert.equal(result.monitor,false);assert.equal(result.playing,'false');assert.equal(result.native.sinkId,'');assert.deepEqual(errors,[]);
 const proof={status:'passed',result,errors,scope:'Isolated Chromium app startup, actual default-output control and native AudioContext default routing. No microphone permission, physical output switch or user project accessed.'};fs.writeFileSync('tests/fixtures/audio-output-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
