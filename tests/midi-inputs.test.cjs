const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){
 const api={...await import('../web-studio/midi-inputs.js'),...await import('../web-studio/midi-sustain.js'),...await import('../web-studio/input.js'),...await import('../web-studio/input-timing.js')};
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8');
 const a={id:'keys',name:'Stage Keyboard',state:'connected'},b={id:'pads',name:'Pads',state:'connected'},select={value:'keys',innerHTML:''},status={textContent:''},clock={currentTime:0,state:'running'},take=new api.MidiTake(120,0),emitted=[];
 const sustain=new api.MidiSustain((type,key,pitch,velocity,time)=>{time??=clock.currentTime;emitted.push({type,key,pitch,time});if(type==='on')take.on(key,pitch,velocity,time);else take.off(key,time,velocity);});
 let resets=0;const reset=sustain.reset.bind(sustain);sustain.reset=()=>{resets++;reset();};
 const ctx={midiInputChoices:api.midiInputChoices,midiAccess:{inputs:new Map([[a.id,a],[b.id,b]])},midiPort:null,midiInputName:'MIDI Input',midiSustain:sustain,engine:{context:clock},decodeMidi:api.decodeMidi,inputEventTime:api.inputEventTime,inputActive:()=>true,$:id=>id==='midi-device'?select:status,esc:s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function bindMidi(){'),source.indexOf('\nasync function refreshAudioDevices()')),ctx);ctx.refreshMidi();
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
