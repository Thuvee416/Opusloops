const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4196/');
  const results=await page.evaluate(async()=>{
   const [{Engine},{emptyProject,makeTrack},{newSynth},{performSessionCommand}]=await Promise.all([import('/audio.js'),import('/model.js'),import('/instruments.js'),import('/agent-performance.js')]);
   const results=[];
   for(const kind of ['clip','scene'])for(const manual of [false,true]){
    const p=emptyProject();p.tracks=[makeTrack('A'),makeTrack('B')];
    for(const [i,t]of p.tracks.entries()){
     t.id=['a','b'][i];t.instrument=newSynth('Bright pluck');t.slots[0]=t.id;
     p.clips[t.id]={id:t.id,name:t.name,kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60+i*7,start:0,duration:1,velocity:.7}]};
    }
    const before=JSON.stringify(p),e=new Engine(p,()=>{}),c=new AbortController(),scheduled=[];
    let release,entered,calls=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
    const prepare=e.prepare.bind(e),schedule=e.schedule.bind(e);
    e.prepare=async options=>{if(++calls===2){entered();await gate;}return prepare(options);};
    e.schedule=(context,target,clip,...args)=>{scheduled.push(clip.id);return schedule(context,target,clip,...args);};
    try{
     const command=kind==='clip'?{name:'launch_clip',args:{trackId:'a',scene:0}}:{name:'launch_scene',args:{scene:0}};
     const request=performSessionCommand(e,command,{signal:c.signal}).then(value=>({value}),error=>({error:error.name,state:error.performanceState}));
     await ready;let other;
     if(manual){
      other=e.launch('b','b',0);
      const deadline=performance.now()+3000;
      while(e.playInterests.get(e.playGeneration)?.size!==2){if(performance.now()>deadline)throw Error('Manual launch did not join startup');await new Promise(r=>setTimeout(r,5));}
     }
     c.abort();release();const cancelled=await request;if(other)await other;
     const deadline=performance.now()+3000;
     while(manual&&!scheduled.includes('b')){if(performance.now()>deadline)throw Error('Manual track was not scheduled');await new Promise(r=>setTimeout(r,5));}
     results.push({kind,manual,cancelled:cancelled.error,reportedPlaying:cancelled.state?.playing??null,playing:e.playing,selected:[...e.active.values()].filter(a=>a.clipId).map(a=>a.clipId),scheduled:[...new Set(scheduled)],activeScene:e.activeScene,interests:e.playInterests.size,projectUnchanged:JSON.stringify(p)===before,contextState:e.context.state});
    }finally{release();e.stop();await e.context?.close();}
   }
   return results;
  });
  for(const r of results){
   assert.equal(r.cancelled,'AbortError');assert.equal(r.playing,r.manual);assert.equal(r.projectUnchanged,true);assert.equal(r.interests,0);
   assert.deepEqual(r.selected,r.manual?['b']:[]);assert.deepEqual(r.scheduled,r.manual?['b']:[]);assert.equal(r.activeScene,null);
  }
  assert.deepEqual(errors,[]);
  const proof={status:'passed',results,errors,scope:'Isolated Chromium native AudioContext, instrument preparation, playback scheduler and Odesa performSessionCommand bridge. A controlled promise delays the second preparation boundary; native preparation then completes normally. No model/API calls, signed-in session, microphone or personal project. Verifies cancellation schedules no withdrawn clip and preserves independent manual startup; not physical-output or conversational-model proof.'};
  fs.writeFileSync('tests/fixtures/session-start-cancellation-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
