const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
async function fixture({enabled=true,initialized=true}={}){
 const [{Engine},{emptyProject},{newDevice},{History},devices]=await Promise.all(['audio','model','devices','history','devices'].map(n=>import('../web-studio/'+n+'.js')));
 const p=emptyProject(),track=p.tracks[0],device=newDevice('reverb');device.enabled=enabled;track.devices=[device];const e=new Engine(p,()=>{}),counts={allocations:0,fail:false,assignFail:false},convolvers=[];
 const param=()=>({value:0,setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;},cancelScheduledValues(){}});
 const node=()=>({gain:param(),pan:param(),connect(){},disconnect(){}});
 const ctx={currentTime:0,sampleRate:20,createGain:node,createStereoPanner:node,createAnalyser:node,createChannelSplitter:node,createConvolver(){let buffer;const n={...node(),get buffer(){return buffer;},set buffer(value){if(counts.assignFail)throw Error('Convolver Assignment Failed');buffer=value;}};convolvers.push(n);return n;},createBuffer(channels,length,sampleRate){counts.allocations++;if(counts.fail)throw Error('Impulse Allocation Failed');const data=Array.from({length:channels},()=>new Float32Array(length));return {length,numberOfChannels:channels,sampleRate,getChannelData:c=>data[c]};}};
 if(initialized){e.context=ctx;e.master=node();e.resetMixers();}
 return {p,track,device,e,ctx,counts,convolvers,history:new History(p),original:structuredClone(p),...devices};
}
test('failed reverb impulse allocation preserves the saved decay and currently playable buffer',async()=>{
 const f=await fixture(),buffer=f.convolvers[0].buffer;f.counts.fail=true;
 assert.throws(()=>f.e.setDeviceParameter(f.track.id,f.device.id,'decay',3),/Impulse Allocation Failed/);assert.deepEqual(f.p,f.original);assert.equal(f.convolvers[0].buffer,buffer);assert.equal(f.e.automationOverrides.size,0);
});
test('successful decay replacement installs matching PCM once and unchanged values do not allocate again',async()=>{
 const f=await fixture(),originalBuffer=f.convolvers[0].buffer,before=f.counts.allocations;f.e.setDeviceParameter(f.track.id,f.device.id,'decay',3);
 assert.equal(f.device.params.decay,3);assert.equal(f.convolvers[0].buffer.length,60);assert.notEqual(f.convolvers[0].buffer,originalBuffer);assert.equal(f.counts.allocations,before+1);f.history.commit(f.p);const saved=structuredClone(f.p);assert.deepEqual(f.history.undo(),f.original);assert.deepEqual(f.history.redo(),saved);
 f.e.setDeviceParameter(f.track.id,f.device.id,'decay',3);assert.equal(f.counts.allocations,before+1);f.e.setDeviceParameter(f.track.id,f.device.id,'mix',.5);assert.equal(f.device.params.mix,.5);assert.equal(f.counts.allocations,before+1);
});
test('convolver assignment failure preserves the old project value and remains retryable',async()=>{
 const f=await fixture(),before=f.convolvers[0].buffer;f.counts.assignFail=true;assert.throws(()=>f.e.setDeviceParameter(f.track.id,f.device.id,'decay',2),/Convolver Assignment Failed/);assert.deepEqual(f.p,f.original);assert.equal(f.convolvers[0].buffer,before);
 f.counts.assignFail=false;f.e.setDeviceParameter(f.track.id,f.device.id,'decay',2);assert.equal(f.device.params.decay,2);assert.equal(f.convolvers[0].buffer.length,40);
});
test('invalid decay values reject before allocation, including bypassed and uninitialized effects',async()=>{
 for(const options of [{},{enabled:false},{initialized:false}]){
  const f=await fixture(options),count=f.counts.allocations;for(const value of [NaN,Infinity,0,5,'2'])assert.throws(()=>f.e.setDeviceParameter(f.track.id,f.device.id,'decay',value),/parameter/i);
  assert.deepEqual(f.p,f.original);assert.equal(f.counts.allocations,count);f.e.setDeviceParameter(f.track.id,f.device.id,'decay',2);assert.equal(f.device.params.decay,2);if(options.enabled===false||options.initialized===false)assert.equal(f.counts.allocations,count);
 }
});
test('actual effect input redraws a rejected decay and the following change event creates no Undo',async()=>{
 const f=await fixture(),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),handlers={};let renders=0;
 const sandbox={engine:f.e,deviceTrack:()=>f.track,run:fn=>fn,$:()=>({dataset:{track:f.track.id},addEventListener:(event,fn)=>handlers[event]=fn}),renderDevices(){renders++;},changed(){f.history.commit(f.p);},deviceParameterText:f.deviceParameterText,deviceParameters:f.deviceParameters};
 vm.createContext(sandbox);const start=source.indexOf("$('device-chain').addEventListener('input'"),end=source.indexOf('\nconst clickSettings=',start);vm.runInContext(source.slice(start,end),sandbox);
 const event={target:{dataset:{deviceParam:'decay'},value:'3',type:'range',closest:()=>({dataset:{device:f.device.id}}),previousElementSibling:{textContent:'1.8s'}}};f.counts.fail=true;
 assert.throws(()=>handlers.input(event),/Impulse Allocation Failed/);handlers.change();assert.equal(renders,1);assert.deepEqual(f.p,f.original);assert.equal(f.history.past.length,0);
 f.counts.fail=false;handlers.input(event);handlers.change();assert.equal(event.target.previousElementSibling.textContent,'3s');assert.deepEqual(f.history.undo(),f.original);
});
