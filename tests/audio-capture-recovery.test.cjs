const {test}=require('node:test'),assert=require('node:assert/strict');
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(t){
 const {AudioCapture}=await import('../web-studio/input.js'),processors=[],tracks=[],timers=new Map();let next=0;
 const node=()=>({connections:[],gain:{setTargetAtTime(){},setValueAtTime(){},cancelScheduledValues(){}},connect(n){this.connections.push(n);},disconnect(){this.connections=[];}});
 const context={currentTime:0,sampleRate:48000,destination:node(),audioWorklet:{addModule:async()=>{}},createMediaStreamSource:node,createGain:node,createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {length,sampleRate,numberOfChannels:channels,getChannelData:c=>data[c],copyToChannel:(samples,c,offset)=>data[c].set(samples,offset)};}};
 const previous=Object.getOwnPropertyDescriptor(global,'navigator'),worklet=global.AudioWorkletNode;
 Object.defineProperty(global,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{const track={stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track]};}}}});
 global.AudioWorkletNode=class{constructor(){Object.assign(this,node());this.port={sent:[],postMessage:m=>this.port.sent.push(m)};processors.push(this);queueMicrotask(()=>this.port.onmessage?.({data:{type:'channels',count:2}}));}};
 t.after(()=>{if(previous)Object.defineProperty(global,'navigator',previous);else delete global.navigator;if(worklet)global.AudioWorkletNode=worklet;else delete global.AudioWorkletNode;});
 const capture=new AudioCapture(context,null,{setTimer:(fn,ms)=>{assert.equal(ms,5000);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});let disconnects=0;capture.onDisconnected=()=>disconnects++;
 await capture.connect();const send=data=>capture.processor.port.onmessage({data}),chunk=(n=4096)=>[new Float32Array(n).fill(.25),new Float32Array(n).fill(-.5)];
 return {capture,context,processors,tracks,timers,send,chunk,disconnects:()=>disconnects,expire(){assert.equal(timers.size,1);timers.values().next().value();}};
}

test('normal Finish retains every received sample, sends one stop and clears its deadline',async t=>{
 const f=await setup(t);f.capture.start(120);f.send({type:'chunk',channels:f.chunk(128)});const first=f.capture.stop(),second=f.capture.stop();assert.equal(f.processors[0].port.sent.filter(m=>m.type==='stop').length,1);
 f.send({type:'finished',frames:128});const result=await first;await second;assert.equal(result.interrupted,undefined);assert.equal(result.clip.name,'Audio take');assert.equal(result.buffer.getChannelData(0)[127],.25);assert.equal(result.buffer.getChannelData(0)[128],0);assert.equal(f.timers.size,0);
 f.send({type:'chunk',channels:f.chunk()});assert.equal(f.capture.chunks.length,0);await f.capture.disconnect();
});

test('unresponsive Finish recovers received PCM, reports truncation and releases the microphone',async t=>{
 const f=await setup(t);f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});const finishing=f.capture.stop();f.expire();const result=await finishing;
 assert.equal(result.interrupted,true);assert.match(result.warning,/End Of The Take May Be Missing/);assert.equal(result.clip.name,'Recovered Audio Take');assert.equal(result.buffer.getChannelData(1)[4095],-.5);assert.equal(f.capture.connected,false);assert.equal(f.capture.active,false);assert.equal(f.tracks[0].stopped,true);assert.equal(f.processors[0].port.onmessage,null);assert.equal(f.disconnects(),1);assert.equal(f.timers.size,0);
 const bytes=Buffer.from(result.clip.data.split(',').at(-1),'base64');assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.readInt16LE(44),8191);assert.equal(bytes.readInt16LE(46),-16384);
});

test('processor failure recovers received audio without waiting for a Finish click',async t=>{
 const f=await setup(t);f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});const pending=f.capture.completion;f.capture.processor.onprocessorerror();const result=await pending;assert.equal(result.interrupted,true);assert.match(result.warning,/Processing Stopped/);assert.equal(f.capture.active,false);assert.equal(f.timers.size,0);
});

test('a timed out take with no received audio rejects instead of hanging or creating an empty clip',async t=>{
 const f=await setup(t);f.capture.start(120,10);const stopped=f.capture.stop();f.expire();await assert.rejects(stopped,/No Recoverable Audio/);assert.equal(f.capture.active,false);assert.equal(f.capture.connected,false);assert.equal(f.capture.chunks.length,0);
});

test('Cancel overrides pending Finish and discards even a late finished response or timeout',async t=>{
 const f=await setup(t);
 for(const outcome of ['finished','timeout']){
  if(!f.capture.connected)await f.capture.connect();f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});const stopped=f.capture.stop(),rejected=assert.rejects(stopped,{name:'AbortError'}),cancelled=f.capture.cancel();assert.equal(f.timers.size,1);
  if(outcome==='finished')f.send({type:'finished',frames:4096});else f.expire();await cancelled;await rejected;assert.equal(f.capture.chunks.length,0);assert.equal(f.capture.active,false);
 }
});

test('channel disappearance stops capture and labels the saved fragment as interrupted',async t=>{
 const f=await setup(t);f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});const completion=f.capture.completion;f.send({type:'channels',count:0});assert.equal(f.capture.connected,false);assert.equal(f.processors[0].port.sent.at(-1).type,'stop');f.send({type:'finished',frames:4096});const result=await completion;assert.equal(result.interrupted,true);assert.match(result.warning,/Disconnection/);await tick();assert.equal(f.tracks[0].stopped,true);
});

test('late message, processor error and ended callbacks cannot affect a reconnected input',async t=>{
 const f=await setup(t),old=f.processors[0],message=old.port.onmessage,error=old.onprocessorerror,ended=f.tracks[0].onended;await f.capture.disconnect();await f.capture.connect();f.capture.start(120);
 message({data:{type:'chunk',channels:f.chunk()}});message({data:{type:'finished',frames:4096}});error();ended();assert.equal(f.capture.active,true);assert.equal(f.capture.connected,true);assert.equal(f.capture.chunks.length,0);
 f.send({type:'chunk',channels:f.chunk(128)});f.send({type:'finished',frames:128});const result=await f.capture.completion;assert.equal(result.interrupted,undefined);await f.capture.disconnect();
});

test('disconnect cannot hang forever waiting for a silent processor',async t=>{
 const f=await setup(t);f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});const disconnected=f.capture.disconnect();f.expire();await disconnected;const result=await f.capture.completion;assert.equal(result.interrupted,true);assert.equal(f.capture.processor,null);assert.equal(f.tracks[0].stopped,true);
});

test('application saves a recovered take once with Undo and preserves its warning in Odesa receipts',async t=>{
 const f=await setup(t),model=await import('../web-studio/model.js'),{History}=await import('../web-studio/history.js'),control=await import('../web-studio/recording-control.js'),vm=require('node:vm'),fs=require('node:fs');
 const project=model.emptyProject(),before=structuredClone(project),history=new History(project),meta={inputRecording:true,captureId:'take',source:'audio',mode:'new',trackId:project.tracks[0].id,scene:0},messages=[],controls={'input-status':{}};
 const ctx={newInputCandidate:()=>({}),audioInput:f.capture,inputCompletion:null,inputPending:true,inputCaptureId:'take',inputMeta:meta,meta,clearCountIn(){},clearInterval(){},inputTimer:null,releaseNotes(){},engine:{playing:false},endArrangementInput(){},commitNewInput(clip){const result=control.appendRecordedClip(project,clip,meta.trackId,0);Object.assign(project,result.project);history.commit(project);return {clipId:clip.id,scene:0};},$:id=>controls[id],setStatus:(text,error)=>messages.push({text,error}),renderTransport(){},renderTimeline(){},inputAbort:null,inputOutcome:null};
 f.capture.start(120);const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8'),start=source.indexOf('inputCompletion=audioInput.completion.then('),end=source.indexOf('inputCompletion.catch(()=>{});',start)+'inputCompletion.catch(()=>{});'.length;
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);f.send({type:'chunk',channels:f.chunk()});f.capture.processor.onprocessorerror();const result=await ctx.inputCompletion;
 assert.equal(result.interrupted,true);assert.equal(result.status,'saved');assert.equal(ctx.inputPending,false);assert.equal(ctx.inputCaptureId,null);assert.match(controls['input-status'].textContent,/May Be Missing/);assert.equal(messages.at(-1).error,true);assert.equal(history.past.length,1);assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),project);
 const prepared={intent:{action:'finish'},binding:{...meta,active:true}};assert.deepEqual(control.checkRecordingReceipt(before,project,prepared,result,{active:false,captureId:null}),{changed:true});assert.match(control.describeInputRecording(result),/Partial Audio Take/);assert.match(control.describeInputRecording({...result,mode:'arrangement',start:8}),/Beat 9/);
});

test('failed audio preparation retains exact PCM for repeated retries without restarting capture',async t=>{
 const f=await setup(t),create=f.context.createBuffer;f.capture.start(120);const raw=f.chunk();f.send({type:'chunk',channels:raw});
 f.context.createBuffer=()=>{throw Error('Allocation Failed');};f.send({type:'finished',frames:4096});
 await assert.rejects(f.capture.completion,/Retry Saving Take/);assert.equal(f.capture.active,false);assert.equal(f.capture.chunks[0],raw);
 assert.equal(f.capture.recoverable.frames,4096);assert.throws(()=>f.capture.start(120),/Retry Saving/);await assert.rejects(f.capture.connect(),/Retry Saving/);
 await assert.rejects(f.capture.retry(),/Allocation Failed/);assert.equal(f.capture.chunks[0],raw);
 f.context.createBuffer=create;const result=await f.capture.retry();assert.equal(result.buffer.getChannelData(0)[4095],.25);assert.equal(result.buffer.getChannelData(1)[4095],-.5);
 assert.equal(f.capture.recoverable,null);assert.equal(f.capture.chunks.length,0);assert.equal(f.processors[0].port.sent.filter(m=>m.type==='start').length,1);
 await f.capture.disconnect();
});

test('copy/encoding failure retains received audio, while explicit Cancel discards it',async t=>{
 const f=await setup(t),create=f.context.createBuffer;
 for(const phase of ['copy','encode']){
  f.capture.start(120);const raw=f.chunk(128);f.send({type:'chunk',channels:raw});
  f.context.createBuffer=(...args)=>{const b=create(...args);b[phase==='copy'?'copyToChannel':'getChannelData']=()=>{throw Error('Preparation Failed');};return b;};
  f.send({type:'finished',frames:128});await assert.rejects(f.capture.completion,/Preparation Failed/);assert.equal(f.capture.chunks[0],raw);
  await f.capture.cancel();assert.equal(f.capture.recoverable,null);assert.equal(f.capture.chunks.length,0);assert.throws(()=>f.capture.retry(),/No Captured Take/);f.context.createBuffer=create;
 }
 await f.capture.disconnect();
});

test('disconnected partial audio survives a preparation failure and retains its warning when retried',async t=>{
 const f=await setup(t),create=f.context.createBuffer;f.capture.start(120);f.send({type:'chunk',channels:f.chunk()});
 f.context.createBuffer=()=>{throw Error('Allocation Failed');};const finishing=f.capture.stop();f.expire();await assert.rejects(finishing,/Retry Saving Take/);
 assert.equal(f.capture.connected,false);assert.equal(f.tracks[0].stopped,true);await f.capture.disconnect();assert.equal(f.capture.chunks.length,1);
 f.context.createBuffer=create;const result=await f.capture.retry();assert.equal(result.interrupted,true);assert.match(result.warning,/End Of The Take May Be Missing/);assert.equal(result.buffer.getChannelData(1)[4095],-.5);
});

async function recoveryApplication(t,mode='new'){
 const f=await setup(t),model=await import('../web-studio/model.js'),{History}=await import('../web-studio/history.js'),control=await import('../web-studio/recording-control.js'),arrangement=await import('../web-studio/arrangement-input.js'),vm=require('node:vm'),fs=require('node:fs');
 const project=model.emptyProject(),before=structuredClone(project),history=new History(project),meta={inputRecording:true,captureId:'take',source:'audio',mode,trackId:project.tracks[0].id,...(mode==='arrangement'?{start:8,maxBeats:256,regionId:'recorded'}:{scene:0})},controls={'input-status':{}};
 const ctx={newInputCandidate:(clip,meta)=>mode==='arrangement'?arrangement.appendArrangementTake(project,clip,meta,meta.regionId):control.appendRecordedClip(project,clip,meta.trackId,0),audioInput:f.capture,inputCompletion:null,inputPending:false,inputCaptureId:'take',inputMeta:meta,inputFinishing:false,inputStarted:0,midiTake:null,inputAbort:null,inputOutcome:null,
  clearCountIn(){},clearInterval(){},inputTimer:null,releaseNotes(){},engine:{context:f.context,playing:false},endArrangementInput(){},endOverdubPlayback(){},renderOverdubPreview(){},
  commitNewInput(clip,buffer,meta,candidate){const result=candidate??ctx.newInputCandidate(clip,meta);Object.assign(project,result.project);history.commit(project);return {clipId:clip.id,...(mode==='arrangement'?{regionId:result.regionId,start:result.start,length:result.length}:{scene:0})};},
  $:id=>controls[id],setStatus(){},renderInput(){},renderTransport(){},renderTimeline(){}};
 const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');vm.createContext(ctx);
 for(const [start,end]of [['function observeAudioInput(','async function startInput('],['async function cancelInput(','function commitOverdub(']])vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),ctx);
 f.capture.start(120);ctx.observeAudioInput(meta);f.send({type:'chunk',channels:f.chunk()});const create=f.context.createBuffer;f.context.createBuffer=()=>{throw Error('Allocation Failed');};
 f.send({type:'finished',frames:4096});await assert.rejects(ctx.inputCompletion,/Retry Saving Take/);
 return {...f,ctx,project,before,history,meta,controls,create,control};
}

test('actual Finish retries a retained take once, preserves capture identity and returns a valid Odesa receipt',async t=>{
 const f=await recoveryApplication(t);assert.equal(f.ctx.inputCaptureId,'take');assert.equal(f.ctx.inputMeta,f.meta);assert.deepEqual(f.project,f.before);assert.equal(f.history.past.length,0);
 await assert.rejects(f.ctx.finishInput(),/Allocation Failed/);assert.equal(f.ctx.inputFinishing,false);assert.equal(f.ctx.inputCaptureId,'take');
 f.context.createBuffer=f.create;const result=await f.ctx.finishInput();assert.equal(result.status,'saved');assert.equal(result.captureId,'take');assert.equal(f.ctx.inputCaptureId,null);assert.equal(f.ctx.inputMeta,null);assert.equal(f.capture.recoverable,null);
 assert.equal(f.history.past.length,1);assert.deepEqual(f.history.undo(),f.before);assert.deepEqual(f.history.redo(),f.project);
 assert.deepEqual(f.control.checkRecordingReceipt(f.before,f.project,{intent:{action:'finish'},binding:{...f.meta,active:true}},result,{active:false,captureId:null}),{changed:true});
 assert.equal(await f.ctx.finishInput(),null);await f.capture.disconnect();
});

test('actual Cancel discards a retained take without editing the project or adding Undo',async t=>{
 const f=await recoveryApplication(t),result=await f.ctx.cancelInput();assert.equal(result.status,'cancelled');assert.equal(f.ctx.inputCaptureId,null);assert.equal(f.ctx.inputMeta,null);
 assert.equal(f.capture.recoverable,null);assert.equal(f.capture.chunks.length,0);assert.deepEqual(f.project,f.before);assert.equal(f.history.past.length,0);await f.capture.disconnect();
});


test('failed destination preparation retains completed PCM for retry with the same take identity and one Undo',async t=>{
 const f=await recoveryApplication(t);f.context.createBuffer=f.create;
 const prepare=f.ctx.newInputCandidate;f.ctx.newInputCandidate=()=>{throw Error('Project Allocation Failed');};
 await assert.rejects(f.ctx.finishInput(),/Project Allocation Failed/);
 assert.ok(f.capture.recoverable,'Completed take must remain retryable');assert.equal(f.ctx.inputCaptureId,'take');assert.deepEqual(f.project,f.before);assert.equal(f.history.past.length,0);
 const held=f.capture.recoverable.prepared;assert.equal(held.buffer.getChannelData(1)[4095],-.5);
 // Retry placement without allocating/encoding the completed audio again.
 f.context.createBuffer=()=>{throw Error('Audio Must Not Be Rebuilt');};
 await assert.rejects(f.ctx.finishInput(),/Project Allocation Failed/);assert.equal(f.capture.recoverable.prepared.buffer,held.buffer);assert.equal(f.capture.recoverable.prepared.clip,held.clip);
 f.ctx.newInputCandidate=prepare;const result=await f.ctx.finishInput();assert.equal(result.status,'saved');assert.equal(result.clipId,held.clip.id);assert.equal(result.captureId,'take');
 assert.equal(f.capture.recoverable,null);assert.equal(f.ctx.inputCaptureId,null);assert.equal(f.history.past.length,1);assert.deepEqual(f.history.undo(),f.before);assert.deepEqual(f.history.redo(),f.project);await f.capture.disconnect();
});

test('Cancel releases a prepared take after destination failure without changing the saved project',async t=>{
 const f=await recoveryApplication(t);f.context.createBuffer=f.create;f.ctx.newInputCandidate=()=>{throw Error('Destination Rejected');};await assert.rejects(f.ctx.finishInput(),/Destination Rejected/);
 assert.ok(f.capture.recoverable);assert.throws(()=>f.capture.start(120),/Retry Saving/);await assert.rejects(f.capture.connect(),/Retry Saving/);
 const result=await f.ctx.cancelInput();assert.equal(result.status,'cancelled');assert.equal(f.capture.recoverable,null);assert.equal(f.ctx.inputCaptureId,null);assert.deepEqual(f.project,f.before);assert.equal(f.history.past.length,0);await f.capture.disconnect();
});


test('Arrangement destination failure keeps its bound position and interruption warning through retry',async t=>{
 const f=await recoveryApplication(t,'arrangement');f.context.createBuffer=f.create;
 const prepare=f.ctx.newInputCandidate;f.capture.recoverable.recovery={interrupted:true,warning:'Partial Take Recovered.'};f.ctx.newInputCandidate=()=>{throw Error('Arrangement Preparation Failed');};await assert.rejects(f.ctx.finishInput(),/Arrangement Preparation Failed/);
 assert.equal(f.capture.recoverable.prepared.warning,'Partial Take Recovered.');assert.deepEqual(f.project,f.before);f.ctx.newInputCandidate=prepare;
 const result=await f.ctx.finishInput();assert.equal(result.start,8);assert.equal(result.regionId,'recorded');assert.equal(result.interrupted,true);assert.equal(result.warning,'Partial Take Recovered.');assert.equal(f.project.arrangement[0].start,8);assert.equal(f.history.past.length,1);assert.deepEqual(f.history.undo(),f.before);await f.capture.disconnect();
});
