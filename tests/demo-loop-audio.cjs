// Compare the actual rolling scheduler across a loop wrap against two explicit
// copies of the same song and automation, rendered by the offline export path.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.OPUS_CHROMIUM?{executablePath:process.env.OPUS_CHROMIUM}:{})});
 try{
  const page=await browser.newPage();await page.goto(process.env.OPUS_TEST_URL||'http://127.0.0.1:4196/audio.js');
  const proof=await page.evaluate(async()=>{
   const [{createDemoSession,DEMO_BEATS},{Engine},{validateProject}]=await Promise.all([import('./demo-session.js'),import('./audio.js'),import('./model.js')]);
   const p=createDemoSession(),rate=44100,spb=60/p.bpm,frames=Math.ceil(DEMO_BEATS*2*spb*rate),ctx=new OfflineAudioContext(2,frames,rate),live=new Engine(p,()=>{});
   let clock=0;Object.defineProperty(ctx,'currentTime',{configurable:true,get:()=>clock});live.context=ctx;live.master=ctx.createGain();live.master.gain.value=p.master;const compressor=ctx.createDynamicsCompressor();live.master.connect(compressor);compressor.connect(ctx.destination);live.resetMixers();live.mode='arrangement';live.playing=true;live.origin=0;
   for(clock=0;clock<DEMO_BEATS*2*spb-.12;clock+=.05)live.tick();clock=DEMO_BEATS*2*spb-.12;live.tick();
   delete ctx.currentTime;const actual=await ctx.startRendering();live.playing=false;live.mixGraph.dispose();
   const copied=structuredClone(p);copied.transport.loopEnabled=false;copied.arrangement.push(...p.arrangement.map(r=>({...r,id:r.id+'-second',start:r.start+DEMO_BEATS})));
   for(const t of copied.tracks)for(const owner of [t,...t.devices])for(const envelope of Object.values(owner.automation??{})){
    const points=envelope.points;envelope.points=[...new Map([...points,...points.map(point=>({...point,beat:point.beat+DEMO_BEATS}))].map(point=>[point.beat,point])).values()].sort((a,b)=>a.beat-b.beat);
   }
   validateProject(copied);const offline=new Engine(copied,()=>{});let bytes;try{bytes=await offline.render({source:'arrangement',sampleRate:rate,bitDepth:32,normalize:false,dither:'none',includeTail:false});}finally{await offline.context?.close();}
   const v=new DataView(bytes);let max=0,wrapMax=0,energy=0,wrapEnergy=0,wrapCount=0,peak=0;const boundary=Math.round(DEMO_BEATS*spb*rate);
   for(let c=0;c<2;c++){const channel=actual.getChannelData(c);for(let f=0;f<frames;f++){const value=channel[f],expected=v.getFloat32(44+(f*2+c)*4,true),error=Math.abs(value-expected);if(!Number.isFinite(value+expected))throw Error('Non-finite rendered sample.');max=Math.max(max,error);peak=Math.max(peak,Math.abs(value));energy+=value*value;if(Math.abs(f-boundary)<rate*.1){wrapMax=Math.max(wrapMax,error);wrapEnergy+=value*value;wrapCount++;}}}
   return {sampleRate:rate,frames,seconds:frames/rate,maxSampleError:max,wrapMaxSampleError:wrapMax,wrapRMS:Math.sqrt(wrapEnergy/wrapCount),rms:Math.sqrt(energy/(frames*2)),peak,noteCount:Object.values(p.clips).reduce((sum,c)=>sum+c.notes.length,0),scope:'Actual Engine.tick scheduling and automation across two demo laps versus an explicitly repeated Arrangement export in native Chromium. No physical output, real-time CPU or human listening assessment.'};
  });
  assert.ok(proof.maxSampleError<2e-5,JSON.stringify(proof));assert.ok(proof.wrapRMS>.01);assert.ok(proof.peak<1);
  fs.writeFileSync(process.env.OPUS_LOOP_PROOF||'/tmp/opus-demo-loop-proof.json',JSON.stringify({status:'passed',...proof},null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
