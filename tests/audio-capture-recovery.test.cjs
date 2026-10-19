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
 const ctx={audioInput:f.capture,inputCompletion:null,inputPending:true,inputCaptureId:'take',inputMeta:meta,meta,clearCountIn(){},clearInterval(){},inputTimer:null,releaseNotes(){},engine:{playing:false},endArrangementInput(){},commitNewInput(clip){const result=control.appendRecordedClip(project,clip,meta.trackId,0);Object.assign(project,result.project);history.commit(project);return {clipId:clip.id,scene:0};},$:id=>controls[id],setStatus:(text,error)=>messages.push({text,error}),renderTransport(){},renderTimeline(){},inputAbort:null,inputOutcome:null};
 f.capture.start(120);const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8'),start=source.indexOf('inputCompletion=audioInput.completion.then('),end=source.indexOf('inputCompletion.catch(()=>{});',start)+'inputCompletion.catch(()=>{});'.length;
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);f.send({type:'chunk',channels:f.chunk()});f.capture.processor.onprocessorerror();const result=await ctx.inputCompletion;
 assert.equal(result.interrupted,true);assert.equal(result.status,'saved');assert.equal(ctx.inputPending,false);assert.equal(ctx.inputCaptureId,null);assert.match(controls['input-status'].textContent,/May Be Missing/);assert.equal(messages.at(-1).error,true);assert.equal(history.past.length,1);assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),project);
 const prepared={intent:{action:'finish'},binding:{...meta,active:true}};assert.deepEqual(control.checkRecordingReceipt(before,project,prepared,result,{active:false,captureId:null}),{changed:true});assert.match(control.describeInputRecording(result),/Partial Audio Take/);assert.match(control.describeInputRecording({...result,mode:'arrangement',start:8}),/Beat 9/);
});
