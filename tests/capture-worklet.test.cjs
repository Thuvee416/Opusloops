const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
// Independent frame/channel oracles for the production AudioWorklet source.
// This does not simulate browser permissions or establish physical input latency.
async function capture(channels='stereo:0'){
 const helpers=await import('../web-studio/input-channels.js'),messages=[];let Processor;
 class AudioWorkletProcessor{constructor(){this.port={postMessage:m=>messages.push(structuredClone(m))};}}
 const scope={...helpers,AudioWorkletProcessor,Float32Array,currentFrame:0,registerProcessor:(name,klass)=>{assert.equal(name,'opus-capture');Processor=klass;}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../web-studio/capture-worklet.js'),'utf8').replace(/^import[^\n]+\n/,''),scope);
 const processor=new Processor({processorOptions:{channels}});
 return {messages,send:data=>processor.port.onmessage({data}),block(frame,input){scope.currentFrame=frame;const output=[new Float32Array(128),new Float32Array(128)];assert.equal(processor.process([input],[output]),true);return output;}};
}
const channel=(frame,scale=1)=>Float32Array.from({length:128},(_,i)=>(frame+i)*scale/65536);
const recorded=t=>{const chunks=t.messages.filter(m=>m.type==='chunk');return [0,1].map(c=>chunks.flatMap(m=>Array.from(m.channels[c])));};
test('count-in starts on the exact sample and finite capture excludes every later frame',async()=>{
 const t=await capture();t.send({type:'start',startFrame:65,limit:200});
 for(let frame=0;frame<512;frame+=128)t.block(frame,[channel(frame),channel(frame,-2)]);
 assert.deepEqual(t.messages.filter(m=>m.type==='started'),[{type:'started',frame:65}]);assert.deepEqual(t.messages.filter(m=>m.type==='finished'),[{type:'finished',frames:200}]);
 const [left,right]=recorded(t);assert.deepEqual(left,Array.from({length:200},(_,i)=>(i+65)/65536));assert.deepEqual(right,Array.from({length:200},(_,i)=>-(i+65)/32768));
});
test('full chunk boundaries plus a final short block retain every frame without repetition',async()=>{
 const t=await capture();t.send({type:'start',startFrame:0,limit:10000});for(let frame=0;frame<4352;frame+=128)t.block(frame,[channel(frame),channel(frame,-1)]);t.send({type:'stop'});
 assert.deepEqual(t.messages.filter(m=>m.type==='chunk').map(m=>m.channels[0].length),[4096,256]);assert.equal(t.messages.at(-1).frames,4352);
 const [left,right]=recorded(t);assert.deepEqual(left,Array.from({length:4352},(_,i)=>i/65536));assert.deepEqual(right,Array.from({length:4352},(_,i)=>-i/65536));
});
test('cancel discards a pending partial chunk and a new take cannot include old samples',async()=>{
 const t=await capture();t.send({type:'start',startFrame:0,limit:10000});t.block(0,[channel(0)]);t.send({type:'cancel'});assert.equal(t.messages.filter(m=>m.type==='chunk').length,0);assert.equal(t.messages.at(-1).type,'cancelled');
 t.send({type:'start',startFrame:128,limit:128});t.block(128,[channel(128)]);assert.deepEqual(recorded(t),[Array.from({length:128},(_,i)=>(i+128)/65536),Array.from({length:128},(_,i)=>(i+128)/65536)]);
});
test('mono selection is centered and stereo selection uses exactly the requested channel pair',async()=>{
 for(const [selection,expected]of [['mono:2',[3,3]],['stereo:2',[3,4]],['stereo:0',[1,2]]]){
  const t=await capture(selection);t.send({type:'start',startFrame:0,limit:128});const output=t.block(0,[1,2,3,4].map(v=>new Float32Array(128).fill(v/8)));const audio=recorded(t);
  for(let c=0;c<2;c++){assert.deepEqual(audio[c],Array(128).fill(expected[c]/8));assert.deepEqual(Array.from(output[c]),audio[c]);}
 }
});
test('cancel during count-in emits no audio and disconnected input reports its channel count',async()=>{
 const t=await capture();t.send({type:'start',startFrame:1024,limit:128});t.block(0,[channel(0)]);t.block(128,[]);t.send({type:'cancel'});
 assert.deepEqual(t.messages.filter(m=>m.type==='channels').map(m=>m.count),[1,0]);assert.equal(t.messages.some(m=>['started','chunk'].includes(m.type)),false);assert.deepEqual(t.messages.filter(m=>m.type==='finished'),[{type:'finished',frames:0}]);
});


test('monitor output processing cannot change the dry samples accumulated by the recorder',async()=>{
 const t=await capture('stereo:0');t.send({type:'start',startFrame:0,limit:256});
 const first=t.block(0,[new Float32Array(128).fill(.25),new Float32Array(128).fill(-.5)]);
 first[0].fill(0);first[1].fill(1); // A downstream monitor consumer has independent output arrays.
 t.block(128,[new Float32Array(128).fill(.75),new Float32Array(128).fill(-.25)]);
 assert.deepEqual(recorded(t),[Array(128).fill(.25).concat(Array(128).fill(.75)),Array(128).fill(-.5).concat(Array(128).fill(-.25))]);
});


test('loss of selected input channels finishes at the last valid frame instead of recording missing-channel silence',async()=>{
 const t=await capture('stereo:2');t.send({type:'start',startFrame:0,limit:10000});
 t.block(0,[1,2,3,4].map(v=>new Float32Array(128).fill(v/8)));
 t.block(128,[1,2].map(v=>new Float32Array(128).fill(v/8)));
 t.block(256,[]);t.send({type:'stop'});
 assert.deepEqual(t.messages.filter(m=>m.type==='finished'),[{type:'finished',frames:128}]);
 assert.deepEqual(recorded(t),[Array(128).fill(3/8),Array(128).fill(4/8)]);
});
