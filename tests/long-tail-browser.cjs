const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4196/');
 const proof=await page.evaluate(async()=>{
  const [{Engine},{emptyProject,validateProject},{newSynth},{newDevice,createDeviceChain}]=await Promise.all(['audio','model','instruments','devices'].map(n=>import('/'+n+'.js')));
  // Stay below master compression so the decay ratio measures the echo itself.
  const p=emptyProject(),track=p.tracks[0];track.instrument={...newSynth(),attack:.001,decay:.001,sustain:.8,release:.01,level:.03};
  const echo=newDevice('echo');Object.assign(echo.params,{time:1,feedback:.8,mix:1,damping:16000,lowCut:20});track.devices=[echo];
  p.clips.note={id:'note',name:'Tail Test',kind:'midi',beats:1,sourceBpm:120,notes:[{pitch:60,start:0,duration:.05,velocity:1}]};track.slots[0]='note';p.arrangement=[{id:'region',trackId:track.id,clipId:'note',start:0,length:1,offset:0}];validateProject(p);
  const before=JSON.stringify(p),e=new Engine(p,()=>{}),results=[];
  try{
   for(const rate of [44100,48000]){
    const options={source:'arrangement',sampleRate:rate,bitDepth:32,normalize:false,dither:'none'};
    const wet=await e.render({...options,includeTail:true}),dry=await e.render({...options,includeTail:false}),reference=await e.render({...options,range:{start:0,length:160},includeTail:false}),frames=new DataView(wet).getUint32(40,true)/8;
    const peak=(wav,start,end)=>{const v=new DataView(wav),count=v.getUint32(40,true)/8;let max=0;for(let f=Math.floor(start*rate);f<Math.min(count,Math.floor(end*rate));f++)for(let c=0;c<2;c++){const n=v.getFloat32(44+(f*2+c)*4,true);if(!Number.isFinite(n))throw Error('Non-finite Export');max=Math.max(max,Math.abs(n));}return max;};
    // Measure the actual filters, across all exposed cutoff ranges, for unintended boost.
    const ctx=new OfflineAudioContext(2,1,rate),filters=[],original=ctx.createBiquadFilter.bind(ctx);ctx.createBiquadFilter=()=>{const f=original();filters.push(f);return f;};
    const chain=createDeviceChain(ctx,[echo]),freq=Float32Array.from({length:2000},(_,i)=>10*Math.pow(rate/20,i/1999)),mag=new Float32Array(freq.length),phase=new Float32Array(freq.length);let maxFilterGain=0;
    for(const f of filters)for(const cutoff of f.type==='highpass'?[20,180,1000]:[500,5500,16000]){f.frequency.value=cutoff;f.getFrequencyResponse(freq,mag,phase);maxFilterGain=Math.max(maxFilterGain,...mag);}
    chain.dispose();
    results.push({rate,seconds:frames/rate,calculatedTail:e.tailSeconds(rate),afterOldLimitPeak:peak(wet,33,34.1),finalPeak:peak(wet,frames/rate-.1,frames/rate),omittedTailRatio:peak(reference,frames/rate,80)/peak(reference,1,2),maxFilterGain,tailFreeFrames:new DataView(dry).getUint32(40,true)/8});
   }
   return {results,projectUnchanged:before===JSON.stringify(p),scope:'Isolated native Chromium Engine.render at 44.1 and 48 kHz with a short note, one-second alternating echo at 80% feedback, actual WAV PCM, an 80-second reference, and native filter-response measurements. No physical playback or listening-quality claim.'};
  }finally{await e.context?.close();}
 });
 for(const r of proof.results){assert.ok(r.seconds>62&&r.seconds<64);assert.ok(r.afterOldLimitPeak>.0001);assert.ok(r.finalPeak<.0001);assert.ok(r.omittedTailRatio<.001);assert.ok(r.maxFilterGain<=1.000001);assert.equal(r.tailFreeFrames,r.rate/2);}
 assert.equal(proof.projectUnchanged,true);
 fs.writeFileSync('tests/fixtures/long-tail-browser-proof.json',JSON.stringify({status:'passed',...proof},null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
