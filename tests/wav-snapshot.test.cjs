const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){const t={...await import('../web-studio/wav-delivery.js'),...await import('../web-studio/render-snapshot.js'),...await import('../web-studio/model.js')},p=t.emptyProject();p.name='Original Mix';p.tracks[0].name='Lead';return {...t,source:{project:p,active:new Map([[p.tracks[0].id,{clipId:'session-tone',slot:0,start:4}]]),automationOverrides:new Set([p.tracks[0].id+':volume']),masterVolume:.42}};}
test('WAV rendering captures project, Session, automation and level once and never renders the live engine',async()=>{
 const t=await fixture(),source=t.source,original=structuredClone(source),trackId=source.project.tracks[0].id;let resolve,renderEngine,closed=0;
 source.render=()=>assert.fail('must not render live engine');
 const pending=t.renderWavSnapshot(source,{channel:'track:'+trackId},{createEngine:project=>renderEngine={project,context:{close:async()=>closed++},render:()=>new Promise(r=>resolve=r)}});
 source.project.name='Later Mix';source.project.tracks[0].name='Renamed Lead';source.project.tracks[0].volume=.1;source.project.bpm=140;source.active.clear();source.automationOverrides.clear();source.masterVolume=.1;
 assert.deepEqual(renderEngine.project,original.project);assert.deepEqual(renderEngine.active,original.active);assert.deepEqual(renderEngine.automationOverrides,original.automationOverrides);assert.equal(renderEngine.masterVolume,.42);
 resolve(new ArrayBuffer(44));const result=await pending;assert.equal(result.filename,'Original-Mix-track-Lead.wav');assert.equal(result.delivery.channel,'Lead');assert.equal(result.delivery.source,'session');assert.equal(closed,1);assert.equal(source.project.name,'Later Mix');
});
test('invalid settings and pre-cancelled exports do not create an engine',async()=>{
 const t=await fixture(),createEngine=()=>assert.fail('must not initialize'),c=new AbortController();c.abort();
 await assert.rejects(()=>t.renderWavSnapshot(t.source,{}, {signal:c.signal,createEngine}),{name:'AbortError'});
 await assert.rejects(()=>t.renderWavSnapshot(t.source,{channel:'track:missing'}, {createEngine}));
});
test('cancelled or failed WAV renders close their private audio context without returning an artifact',async()=>{
 for(const mode of ['abort','failure']){const t=await fixture(),c=new AbortController();let closed=0;
 await assert.rejects(()=>t.renderWavSnapshot(t.source,{}, {signal:c.signal,createEngine:project=>({project,context:{close:async()=>closed++},render:async(settings,opts)=>{assert.equal(opts.signal,c.signal);if(mode==='abort'){c.abort();return new ArrayBuffer(44);}throw Error('Render Failed');}})}),mode==='abort'?{name:'AbortError'}:/Render Failed/);assert.equal(closed,1);}
});
test('shared WAV/stem snapshot owns independent notes, active slots and override sets',async()=>{
 const t=await fixture(),source=t.source;source.project.clips.c={id:'c',kind:'midi',name:'Notes',sourceBpm:120,beats:4,notes:[{pitch:60,start:0,duration:1,velocity:.5}]};
 const snapshot=t.createRenderSnapshot(source);snapshot.project.clips.c.notes[0].pitch=72;snapshot.active.values().next().value.slot=2;snapshot.automationOverrides.clear();assert.equal(source.project.clips.c.notes[0].pitch,60);assert.equal(source.active.values().next().value.slot,0);assert.equal(source.automationOverrides.size,1);assert.notEqual(snapshot,source);
});
test('render cancellation after preparation stops before allocating an offline audio graph',async()=>{
 const {Engine}=await import('../web-studio/audio.js'),t=await fixture(),c=new AbortController(),e=new Engine(t.source.project,()=>{});e.prepare=async()=>c.abort();
 const previous=global.OfflineAudioContext;global.OfflineAudioContext=function(){assert.fail('must not allocate');};try{await assert.rejects(()=>e.render({}, {signal:c.signal}),{name:'AbortError'});}finally{global.OfflineAudioContext=previous;}
});

test('actual WAV command shares the cancel control, suppresses cancelled downloads and always clears busy state',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),code=source.slice(source.indexOf('async function exportStudioWav('),source.indexOf('\nasync function executeStudioCommand'));
 for(const mode of ['success','button','agent','failure']){let resolve,opts,downloads=0;const controls={'cancel-stems':{disabled:true},'save-state':{}},signal=new AbortController(),ctx={busy:false,engine:{},project:{},inputActive:()=>false,deliveryOptions:(_,o)=>o,AbortController,deliveryAbort:null,$:id=>controls[id],renderTransport:()=>{},setStatus:()=>{},renderWavSnapshot:(_,o,options)=>{opts=options;return new Promise(r=>resolve=r);},download:()=>downloads++,scheduleSave:()=>{}};
 vm.createContext(ctx);vm.runInContext(code,ctx);const pending=ctx.exportStudioWav({},signal.signal);assert.equal(ctx.busy,true);assert.equal(controls['cancel-stems'].disabled,false);
 if(mode==='button')ctx.deliveryAbort.abort();if(mode==='agent')signal.abort();if(mode==='failure')ctx.download=()=>{throw Error('Download Failed');};resolve({data:new ArrayBuffer(44),filename:'Snapshot.wav',delivery:{format:'wav'},description:'Snapshot'});
 if(mode==='success'){const result=await pending;assert.equal(result.download,'Snapshot.wav');assert.equal(downloads,1);}else{await assert.rejects(()=>pending,mode==='failure'?/Download Failed/:{name:'AbortError'});assert.equal(downloads,0);if(mode!=='failure')assert.equal(opts.signal.aborted,true);}
 assert.equal(ctx.busy,false);assert.equal(ctx.deliveryAbort,null);assert.equal(controls['cancel-stems'].disabled,true);
 }
});
test('render scheduling failure disposes the offline mixer before returning an error',async()=>{
 const {Engine}=await import('../web-studio/audio.js'),t=await fixture(),p=t.source.project,trackId=p.tracks[0].id;p.tracks[0].devices=[];p.clips.c={id:'c',name:'Notes',kind:'midi',sourceBpm:120,beats:4,notes:[]};p.arrangement=[{id:'r',trackId,clipId:'c',start:0,length:4,offset:0}];
 const param=()=>({value:0,setTargetAtTime(){},setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}}),node=()=>({connections:[],gain:param(),pan:param(),connect(to){this.connections.push(to);},disconnect(){this.connections=[];}});
 class Context{constructor(channels,frames,rate){this.length=frames;this.sampleRate=rate;this.currentTime=0;this.destination=node();}createGain(){return node();}createDynamicsCompressor(){return node();}createStereoPanner(){return node();}createAnalyser(){return node();}startRendering(){assert.fail('must not render');}}
 const e=new Engine(p,()=>{});e.prepare=async()=>{};e.tailSeconds=()=>0;let input;e.schedule=(ctx,target)=>{input=target;throw Error('Scheduling Failed');};const previous=global.OfflineAudioContext;global.OfflineAudioContext=Context;
 try{await assert.rejects(()=>e.render(),/Scheduling Failed/);assert.equal(input.connections.length,0);}finally{global.OfflineAudioContext=previous;}
});
