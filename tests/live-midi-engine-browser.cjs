const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
  const results=await page.evaluate(async()=>{
   const [{Engine},{emptyProject,wav},{newSynth},{newSampler},{newDrumRack,padSample},{encode64},{newPitch},{renderMidiBuffers}]=await Promise.all([import('/audio.js'),import('/model.js'),import('/instruments.js'),import('/sampler.js'),import('/drums.js'),import('/input.js'),import('/midi-effects.js'),import('/live-midi-edit.js')]),results=[];
   const check=(ok,msg)=>{if(!ok)throw Error(msg);},wait=ms=>new Promise(r=>setTimeout(r,ms));
   const offline=new OfflineAudioContext(1,44100*5,44100),sample=offline.createBuffer(1,44100*5,44100);for(let i=0;i<sample.length;i++)sample.getChannelData(0)[i]=.15*Math.sin(2*Math.PI*220*i/44100);const data=encode64(wav(sample));
   for(const mode of ['session','arrangement'])for(const kind of ['synth','ensemble','sampler','drums','legacy','legacy-effects']){
    const p=emptyProject();p.returns=[];p.transport.loopEnabled=true;p.transport.loopStart=0;p.transport.loopEnd=8;const t=p.tracks[0];
    if(kind==='synth')t.instrument={...newSynth(),wave:'sine'};if(kind==='ensemble')t.instrument=newSynth('Glass Pluck');if(kind==='sampler')t.instrument={...newSampler(),name:'Five Second Tone',mode:'oneshot',data};if(kind==='drums'){t.instrument=newDrumRack();for(const pitch of [36,37]){const pad=t.instrument.pads.find(p=>p.pitch===pitch);pad.source='sample';pad.sample={...padSample(),name:'Five Second Pad',data};}}
    if(kind==='legacy-effects')t.midiEffects=[{...newPitch(),semitones:7}];const pitch=kind==='drums'?36:57,changed=kind==='drums'?37:67;
    p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:8,sourceBpm:120,notes:[{pitch,start:0,duration:8,velocity:.6},{pitch:changed,start:0,duration:8,velocity:.6}]};t.slots[0]='phrase';p.arrangement=[{id:'r',trackId:t.id,clipId:'phrase',start:0,length:8,offset:0}];
    const engine=new Engine(p,()=>{});engine.active.set(t.id,{clipId:'phrase',slot:0,start:0});
    try{
     await engine.play(mode);await wait(240);const context=engine.context,origin=engine.origin,generation=engine.playGeneration,mixer=engine.mixers.get(t.id),before=structuredClone(p.clips.phrase.notes),scheduler=engine.voiceSchedulers.get(context),voices=scheduler?[...scheduler.sounding.get(t.id)||[]]:[],unchanged=voices[0],analyser=context.createAnalyser();analyser.fftSize=2048;mixer.pan.connect(analyser);
     const next=structuredClone(before);next[1].velocity=.25;if(kind!=='drums')next[1].pitch+=4;else next[1].active=false;
     const result=await engine.editMidiNotes([{id:'phrase',notes:next}]);await wait(Math.max(0,(result.boundary-context.currentTime)*1000)+100);
     check(engine.playing&&engine.context===context&&engine.origin===origin&&engine.playGeneration===generation&&engine.mixers.get(t.id)===mixer,'Transport or mixer restarted: '+kind);
     check(JSON.stringify(p.clips.phrase.notes)===JSON.stringify(next),'Notes did not commit');
     if(unchanged)check(scheduler.sounding.get(t.id).has(unchanged),'Unchanged held note or one-shot tail was restarted: '+kind);
     const pcm=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(pcm);const rms=Math.sqrt(pcm.reduce((s,v)=>s+v*v,0)/pcm.length);if(kind!=='ensemble')check(rms>.0001,'Playback became silent: '+kind);
     const undo=await engine.editMidiNotes([{id:'phrase',notes:before}]);await wait(Math.max(0,(undo.boundary-context.currentTime)*1000)+50);check(JSON.stringify(p.clips.phrase.notes)===JSON.stringify(before),'Undo data differs');check(engine.origin===origin&&engine.playing,'Undo restarted transport');
     if(unchanged)check(scheduler.sounding.get(t.id).has(unchanged),'Undo interrupted unchanged voice: '+kind);
     // Invalid data and preparation failure must leave the original state intact.
     let rejected=false;try{await engine.editMidiNotes([{id:'phrase',notes:[{...before[0],pitch:200}]}]);}catch{rejected=true;}check(rejected&&JSON.stringify(p.clips.phrase.notes)===JSON.stringify(before),'Invalid edit mutated notes');
     if(kind==='legacy'){
      let resolve;const pending=engine.editMidiNotes([{id:'phrase',notes:next}],{render:async(jobs,sr,opts)=>{await new Promise(r=>resolve=r);return renderMidiBuffers(jobs,sr,opts);}});const current=JSON.stringify(p);engine.stop();resolve();await pending.then(()=>{throw Error('Stopped edit committed');},()=>{});check(JSON.stringify(p)===current,'Stopped worker changed notes');
     }
     results.push({mode,kind,rms,clockAndMixerRetained:true,unchangedVoiceRetained:!!unchanged,undoExact:true,invalidEditRejected:true,realWorker:kind.startsWith('legacy'),stopCancelsPreparation:kind==='legacy'});
    }finally{engine.stop();await engine.context?.close();}
   }
   // A shared source must update every track, while unrelated sustained notes
   // keep their own voices. Spectral measurements verify the audible pitch swap.
   for(const mode of ['session','arrangement']){
    const p=emptyProject();p.returns=[];p.tracks=Array.from({length:3},(_,i)=>({...structuredClone(p.tracks[0]),id:'spectral-'+i,name:'Spectral '+i}));p.transport.loopEnabled=true;p.transport.loopStart=0;p.transport.loopEnd=16;
    for(const t of p.tracks)t.instrument={...newSynth(),wave:'sine',sustain:1,release:.02};
    p.clips.shared={id:'shared',name:'Shared',kind:'midi',beats:16,sourceBpm:120,notes:[{pitch:57,start:0,duration:16,velocity:.6},{pitch:67,start:0,duration:16,velocity:.6}]};
    p.clips.other={id:'other',name:'Other',kind:'midi',beats:16,sourceBpm:120,notes:[{pitch:60,start:0,duration:16,velocity:.6}]};
    p.tracks[1].midiEffects=[{...newPitch(),semitones:7}];for(let i=0;i<3;i++){const t=p.tracks[i],id=i<2?'shared':'other';t.slots[0]=id;p.arrangement.push({id:'r'+i,trackId:t.id,clipId:id,start:0,length:16,offset:i===1?.5:0});}
    const e=new Engine(p,()=>{});for(const t of p.tracks)e.active.set(t.id,{clipId:t.slots[0],slot:0,start:0});
    try{
     await e.play(mode);await wait(500);const ctx=e.context,scheduler=e.voiceSchedulers.get(ctx),unchanged=[...scheduler.sounding.get(p.tracks[2].id)],analyzers=p.tracks.slice(0,2).map(t=>{const a=ctx.createAnalyser();a.fftSize=16384;a.smoothingTimeConstant=0;e.mixers.get(t.id).pan.connect(a);return a;});
     const level=(a,pitch)=>{const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);const bin=Math.round(440*2**((pitch-69)/12)*a.fftSize/ctx.sampleRate);return Math.max(...data.slice(bin-2,bin+3));};
     await wait(500);const old=analyzers.map((a,i)=>level(a,67+i*7));const notes=structuredClone(p.clips.shared.notes);notes[1].pitch=71;const origin=e.origin;await e.editMidiNotes([{id:'shared',notes}]);await wait(600);
     const measurements=analyzers.map((a,i)=>({oldBefore:old[i],oldAfter:level(a,67+i*7),newAfter:level(a,71+i*7)}));for(const m of measurements)check(m.oldBefore>-60&&m.newAfter>-60&&m.oldAfter<m.oldBefore-25,'Shared track pitch did not audibly change: '+JSON.stringify(m));
     check(e.origin===origin&&unchanged.every(v=>scheduler.sounding.get(p.tracks[2].id).has(v)),'Independent track interrupted');
     // Rapid changes before the next scheduler window must retain the last edit.
     const final=structuredClone(notes);final[1].pitch=74;await e.editMidiNotes([{id:'shared',notes:final}]);await e.editMidiNotes([{id:'shared',notes}]);await wait(600);for(let i=0;i<2;i++)check(level(analyzers[i],71+i*7)>level(analyzers[i],74+i*7)+25,'Rapid edit left a stale sounding note');
     results.push({mode,kind:'shared-source-spectrum',measurements,independentVoiceRetained:true,rapidEditLatestPitch:true});
    }finally{e.stop();await e.context?.close();}
   }
   return results;
  });
  assert.equal(results.length,14);assert.deepEqual(errors,[]);const proof={status:'passed',results,errors,scope:'Native isolated Chromium audio engine, Session and Arrangement loops, synth, ensemble, five-second one-shot sampler and drum pads, plus real Worker-rendered legacy MIDI with/without a pitch effect. Actual clock, mixer and unchanged voice identities, measured signal and exact data restoration. No physical-output/listening-quality, personal-project, microphone or provider claim.'};fs.writeFileSync('tests/fixtures/live-midi-engine-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
