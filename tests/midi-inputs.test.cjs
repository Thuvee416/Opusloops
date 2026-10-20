const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){
 const api={...await import('../web-studio/midi-inputs.js'),...await import('../web-studio/midi-sustain.js'),...await import('../web-studio/input.js'),...await import('../web-studio/input-timing.js')};
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
 const a={id:'keys',name:'Stage Keyboard',state:'connected'},b={id:'pads',name:'Pads',state:'connected'},select={value:'keys',innerHTML:''},status={textContent:''},clock={currentTime:0,state:'running'},take=new api.MidiTake(120,0),emitted=[];
 const sustain=new api.MidiSustain((type,key,pitch,velocity,time)=>{time??=clock.currentTime;emitted.push({type,key,pitch,time});if(type==='on')take.on(key,pitch,velocity,time);else take.off(key,time,velocity);});
 let resets=0;const reset=sustain.reset.bind(sustain);sustain.reset=()=>{resets++;reset();};
 const ctx={midiInputChoices:api.midiInputChoices,midiAccess:{inputs:new Map([[a.id,a],[b.id,b]])},midiPort:null,midiInputName:'MIDI Input',midiSustain:sustain,engine:{context:clock},decodeMidi:api.decodeMidi,inputEventTime:api.inputEventTime,inputActive:()=>true,$:id=>id==='midi-device'?select:status,esc:s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function bindMidi(){'),source.indexOf('\nfunction audioOutputSupported()')),ctx);ctx.refreshMidi();
 const send=(port,bytes,time)=>{clock.currentTime=time;port.onmidimessage?.({data:bytes,timeStamp:0});};
 return {...api,ctx,a,b,select,status,clock,take,sustain,send,emitted,resets:()=>resets};
}
test('unrelated hot-plug events preserve selected port, event handler, sustain and held take notes',async()=>{
 const t=await setup(),handler=t.a.onmidimessage,resets=t.resets();t.send(t.a,[144,60,100],.1);t.send(t.a,[176,64,127],.2);t.send(t.a,[128,60,50],.3);
 for(const change of [()=>t.ctx.midiAccess.inputs.set('new',{id:'new',name:'Other',state:'connected'}),()=>t.b.state='disconnected',()=>{}]){change();t.ctx.refreshMidi();assert.equal(t.a.onmidimessage,handler);assert.equal(t.ctx.midiPort,t.a);assert.equal(t.resets(),resets);assert.equal(t.take.notes.length,0);assert.equal(t.sustain.held.size,1);}
 t.send(t.a,[176,64,0],1);const clip=t.take.finish(1.5);assert.equal(clip.notes.length,1);assert.equal(clip.notes[0].duration,1.8);assert.equal(clip.notes[0].releaseVelocity,50/127);
});
test('selected-device loss releases only MIDI notes and retains a visible missing selection',async()=>{
 const t=await setup();t.send(t.a,[144,60,100],.1);t.take.on('KeyA',72,.7,.2);t.send(t.a,[176,64,127],.3);t.send(t.a,[128,60,20],.4);
 t.clock.currentTime=1;t.a.state='disconnected';t.ctx.midiAccess.inputs.delete(t.a.id);t.ctx.refreshMidi();
 assert.equal(t.ctx.midiPort,null);assert.equal(t.a.onmidimessage,null);assert.equal(t.b.onmidimessage,undefined);assert.equal(t.select.value,'keys');assert.match(t.select.innerHTML,/Stage Keyboard \(Disconnected\)/);assert.match(t.select.innerHTML,/disabled/);assert.match(t.status.textContent,/Finish The Take/);
 assert.equal(t.take.held.has('KeyA'),true);assert.equal(t.sustain.held.size,0);assert.equal(t.sustain.pedals.size,0);assert.equal(t.take.notes[0].duration,1.8);
 t.take.off('KeyA',1.5);assert.equal(t.take.finish(2).notes.find(n=>n.pitch===72).duration,2.6);
});
test('same-device reconnect resumes with a fresh handler and ignores queued events from the old port',async()=>{
 const t=await setup(),oldHandler=t.a.onmidimessage;t.a.state='disconnected';t.ctx.refreshMidi();
 const replacement={id:'keys',name:'Stage Keyboard',state:'connected'};t.ctx.midiAccess.inputs.set('keys',replacement);t.ctx.refreshMidi();assert.equal(t.ctx.midiPort,replacement);assert.doesNotMatch(t.select.innerHTML,/Disconnected/);
 oldHandler({data:[144,60,100],timeStamp:0});assert.equal(t.take.held.size,0);
 t.send(replacement,[144,64,100],1);t.send(replacement,[128,64,0],1.5);assert.equal(t.take.finish(2).notes.length,1);assert.equal(t.take.clip.notes[0].pitch,64);
});
test('explicit input switch closes MIDI-held notes and routes only the selected device',async()=>{
 const t=await setup();t.send(t.a,[144,60,100],.1);const stale=t.a.onmidimessage;t.clock.currentTime=.5;t.select.value='pads';t.ctx.bindMidi();assert.equal(t.a.onmidimessage,null);assert.equal(t.ctx.midiPort,t.b);assert.equal(t.ctx.midiInputName,'Pads');assert.equal(t.take.notes[0].duration,.8);
 stale({data:[144,70,100],timeStamp:0});t.send(t.b,[144,67,100],.6);t.send(t.b,[128,67,0],1);assert.deepEqual(t.take.finish(1.5).notes.map(n=>n.pitch),[60,67]);
});
test('first connection selects an available input but a missing remembered input never falls back silently',async()=>{
 const {midiInputChoices}=await import('../web-studio/midi-inputs.js'),a={id:'a',name:'Keys',state:'connected'},inputs=new Map([['a',a]]);
 assert.equal(midiInputChoices(inputs).selectedId,'a');assert.equal(midiInputChoices(inputs,'missing','Previous Keys').port,null);assert.equal(midiInputChoices(inputs,'missing','Previous Keys').selectedId,'missing');
 assert.deepEqual(midiInputChoices(new Map()).options,[{id:'',label:'No MIDI Input Available',missing:true}]);
 assert.equal(midiInputChoices(new Map([['a',{...a,state:'disconnected'}]])).port,null);
});

test('selected-port All Notes Off closes only the addressed MIDI channel at receipt time',async()=>{
 const t=await setup();t.send(t.a,[144,60,100],.1);t.send(t.a,[145,67,90],.2);t.take.on('KeyA',72,.7,.3);
 t.send(t.a,[176,123,0],1);
 assert.equal(t.take.notes.length,1);assert.equal(t.take.notes[0].pitch,60);assert.equal(t.take.notes[0].duration,1.8);
 assert.equal(t.take.held.size,2);assert.equal(t.take.held.has('KeyA'),true);assert.equal(t.sustain.held.size,1);
 t.send(t.a,[128,60,0],1.1);assert.equal(t.take.notes.length,1);
 t.send(t.a,[144,60,80],1.2);t.send(t.a,[176,123,0],1.5);assert.equal(t.take.notes.length,2);assert.ok(Math.abs(t.take.notes[1].duration-.6)<1e-12);
});

test('All Notes Off respects sustain while controller reset releases only pedal-held notes',async()=>{
 const t=await setup();t.send(t.a,[144,60,100],.1);t.send(t.a,[176,64,127],.2);t.send(t.a,[128,60,50],.3);
 t.send(t.a,[144,64,100],.4);t.send(t.a,[176,123,0],.5);assert.equal(t.take.notes.length,0);
 t.send(t.a,[144,67,100],.6);t.send(t.a,[177,64,127],.7);t.send(t.a,[145,72,100],.8);t.send(t.a,[129,72,30],.9);
 t.send(t.a,[176,121,0],1);
 assert.deepEqual(t.take.notes.map(n=>n.pitch),[60,64]);assert.equal(t.take.notes[0].releaseVelocity,50/127);
 assert.equal(t.take.notes[0].duration,1.8);assert.equal(t.take.notes[1].duration,1.2);
 assert.equal(t.sustain.pedals.has(0),false);assert.equal(t.sustain.pedals.has(1),true);
 assert.equal(t.take.held.size,2);t.send(t.a,[128,67,0],1.5);assert.ok(Math.abs(t.take.notes[2].duration-1.8)<1e-12);
 t.send(t.a,[177,121,0],2);assert.equal(t.take.notes[3].pitch,72);assert.equal(t.take.notes[3].duration,2.4);
});

test('channel release and reset controls decode only valid channel messages and never fall through as notes',async()=>{
 const {decodeMidi,MidiSustain}=await setup();
 for(let channel=0;channel<16;channel++){
  assert.deepEqual(decodeMidi([176+channel,123,0]),{type:'all-notes-off',channel});
  assert.deepEqual(decodeMidi([176+channel,121,0]),{type:'reset-controllers',channel});
 }
 for(const bytes of [[176,123,128],[176,121,-1],[176,123],[176,123,1],[176,121,1],[240,123,0]])assert.equal(decodeMidi(bytes),null);
 const events=[],sustain=new MidiSustain((...args)=>events.push(args));sustain.handle(decodeMidi([176,123,0]),1);sustain.handle(decodeMidi([176,121,0]),2);
 assert.deepEqual(events,[]);assert.equal(sustain.held.size,0);
});

test('the actual input-note bridge releases monitoring and updates both new takes and overdub at controller time',async()=>{
 const t=await setup(),{MidiOverdub}=await import('../web-studio/midi-overdub.js'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
 for(const overdub of [false,true]){
  const original={id:'loop',kind:'midi',name:'Existing',beats:4,sourceBpm:120,notes:[{pitch:48,start:0,duration:.5,velocity:.7}]},take=overdub?new MidiOverdub(original,120,0):new t.MidiTake(120,0),monitor=new Map(),released=[],clock={currentTime:0};
  const ctx={MidiOverdub,midiTake:take,busy:false,inputConnecting:false,inputFinishing:false,inputStarted:0,inputTarget:'track',armedInputTrack:'track',inputActive:()=>true,engine:{context:clock},updateOverdubPlayback(){},renderOverdubPreview(){},liveNotes:{on(key,pitch){monitor.set(key,pitch);},off(key,velocity){released.push({pitch:monitor.get(key),velocity});monitor.delete(key);}}};
  vm.createContext(ctx);const start=source.indexOf('function inputNote(');vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);
  const sustain=new t.MidiSustain((...args)=>ctx.inputNote(...args)),send=(data,time)=>{clock.currentTime=time;sustain.handle(t.decodeMidi(data),time);};
  send([144,60,100],.1);send([145,67,90],.2);send([176,64,127],.3);send([176,123,0],.4);
  assert.equal(monitor.size,2);send([176,121,0],.6);assert.equal(monitor.size,1);assert.equal(released[0].pitch,60);
  send([177,123,0],.7);assert.equal(monitor.size,0);
  const clip=take.finish(1),added=overdub?clip.notes.slice(original.notes.length):clip.notes;
  assert.deepEqual(added.map(n=>n.pitch),[60,67]);for(let i=0;i<2;i++){assert.ok(Math.abs(added[i].start-(i+1)*.2)<1e-12);assert.ok(Math.abs(added[i].duration-1)<1e-12);}
  if(overdub)assert.deepEqual(clip.notes[0],original.notes[0]);
 }
});
