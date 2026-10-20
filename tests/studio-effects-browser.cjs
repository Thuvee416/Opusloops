const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4196/');
 const proof=await page.evaluate(async()=>{
  const {newDevice,createDeviceChain}=await import('/devices.js');
  const render=async(type,params,source='impulse',rate=44100)=>{
   const ctx=new OfflineAudioContext(2,rate*2,rate),device=newDevice(type);Object.assign(device.params,params);
   const chain=createDeviceChain(ctx,[device]);chain.output.connect(ctx.destination);
   if(source==='sine'){const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=1800;gain.gain.value=.1;osc.connect(gain);gain.connect(chain.input);osc.start();osc.stop(1);}
   else{const b=ctx.createBuffer(1,1,rate);b.getChannelData(0)[0]=1;const s=ctx.createBufferSource();s.buffer=b;s.connect(chain.input);s.start(.02);}
   try{return await ctx.startRendering();}finally{chain.dispose();}
  };
  const energy=(buffer,c,start,end)=>{const a=buffer.getChannelData(c);let sum=0;for(let i=Math.floor(start*buffer.sampleRate);i<Math.min(a.length,Math.floor(end*buffer.sampleRate));i++)sum+=a[i]*a[i];return sum;};
  const results=[];
  for(const rate of [44100,48000]){
   const flat=await render('parametric',{lowCut:20,highCut:20000,midFrequency:1800},'sine',rate),cut=await render('parametric',{lowCut:20,highCut:20000,midFrequency:1800,midGain:-12},'sine',rate);
   const eqAmplitudeRatio=Math.sqrt(energy(cut,0,.2,.8)/energy(flat,0,.2,.8));
   const echo=await render('echo',{mix:1,time:.1,feedback:.4,lowCut:20,damping:16000},'impulse',rate);
   const echoLeft=energy(echo,0,.119,.14),echoRight=energy(echo,1,.219,.24),repeat=energy(echo,0,.319,.34),prematureRight=energy(echo,1,.1,.2);
   const space=await render('space',{mix:1,preDelay:.05,decay:1,lowCut:100,damping:6500},'impulse',rate);
   const before=energy(space,0,0,.069),body=energy(space,0,.08,.3),late=energy(space,0,1.3,1.8);
   let difference=0;for(let i=0;i<space.length;i++)difference+=(space.getChannelData(0)[i]-space.getChannelData(1)[i])**2;
   for(const buffer of [flat,cut,echo,space])for(let c=0;c<2;c++)if(!buffer.getChannelData(c).every(Number.isFinite))throw Error('Non-finite audio');
   results.push({rate,eqAmplitudeRatio,echoLeft,echoRight,repeat,prematureRight,reverbBeforePredelay:before,reverbBody:body,reverbLate:late,reverbStereoDifference:difference});
  }
  return {results,scope:'Native Chromium offline DSP at 44.1 and 48 kHz. EQ response, alternating echo timing, feedback, reverb pre-delay/decay and stereo decorrelation. Not a listening-quality or third-party plug-in compatibility test.'};
 });
 for(const r of proof.results){assert.ok(r.eqAmplitudeRatio>.24&&r.eqAmplitudeRatio<.27);assert.ok(r.echoLeft>.01&&r.echoRight>.01&&r.repeat>.001);assert.ok(r.prematureRight<1e-12);assert.ok(r.reverbBeforePredelay<1e-12&&r.reverbBody>1e-6);assert.ok(r.reverbLate<r.reverbBody*.001);assert.ok(r.reverbStereoDifference>1e-6);}
 fs.writeFileSync('tests/fixtures/studio-effects-browser-proof.json',JSON.stringify({status:'passed',...proof},null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
