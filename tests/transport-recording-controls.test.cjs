const {test}=require('node:test'),assert=require('node:assert/strict');
const api=async()=>({...await import('../web-studio/metronome.js'),...await import('../web-studio/tap-tempo.js'),...await import('../web-studio/transport.js'),...await import('../web-studio/audio.js')});
test('tap tempo follows quarter notes, bounds its sample window, ignores double clicks and restarts after a pause',async()=>{
 const {TapTempo}=await api(),tap=new TapTempo();assert.equal(tap.tap(0).bpm,null);assert.equal(tap.tap(500).bpm,120);assert.equal(tap.tap(550).ignored,true);assert.equal(tap.tap(1000).bpm,120);
 for(let n=3;n<20;n++)assert.equal(tap.tap(n*500).bpm,120);assert.equal(tap.taps.length,9);assert.equal(tap.tap(12000).restarted,true);assert.equal(tap.tap(13500).bpm,40);tap.reset();tap.tap(0);assert.equal(tap.tap(250).bpm,240);assert.equal(tap.tap(1740).bpm>40,true);
 for(const value of [NaN,Infinity,-1])assert.throws(()=>tap.tap(value));
});
test('standalone recording gets continuing, accented clicks after its count-in without late bursts',async()=>{
 const {InputClickClock}=await api(),clock=new InputClickClock({start:2,bpm:120,clicks:[0,.5,1,1.5].map((time,i)=>({time,accent:i===0}))});let events=[];
 for(let time=0;time<4;time+=.05)events.push(...clock.events(time,{enabled:true}));
 assert.deepEqual(events.map(c=>c.time),[0,.5,1,1.5,2,2.5,3,3.5,4]);assert.equal(events.filter(c=>c.accent).length,3);
 const delayed=clock.events(10,{enabled:true});assert.deepEqual(delayed.map(c=>c.time),[10]);clock.stop();assert.deepEqual(clock.events(10.5,{enabled:true}),[]);
});
test('count-in is independent of Click enablement; running transport owns post-count-in clicks exactly once',async()=>{
 const {InputClickClock}=await api(),clock=new InputClickClock({start:1,bpm:120,clicks:[{time:0,accent:true},{time:.5,accent:false}]});
 assert.equal(clock.events(0,{playing:true,enabled:false}).length,1);assert.equal(clock.events(.5,{playing:true,enabled:false}).length,1);
 assert.deepEqual(clock.events(1,{playing:true,enabled:true}),[]);assert.deepEqual(clock.events(1,{playing:false,enabled:true}),[]);
 assert.equal(clock.events(1.5,{playing:false,enabled:true}).length,1);assert.deepEqual(clock.events(2,{enabled:false}),[]);assert.equal(clock.events(2.5,{enabled:true}).length,1);
});
test('engine suppresses ordinary-playback recording-only clicks and overdub count-in duplicates',async()=>{
 const {Engine}=await api();
 function clicks(settings,stage={}){const e=new Engine({bpm:120,transport:{loopEnabled:false,metronome:true,...settings},tracks:[],arrangement:[]},()=>{});Object.assign(e,{context:{currentTime:10},origin:10,nextBeat:0,mixers:new Map(),...stage});const calls=[];e.click=(...args)=>calls.push(args);e.tick();return calls;}
 assert.equal(clicks({}).length,1);assert.equal(clicks({metronomeRecordOnly:true}).length,0);assert.equal(clicks({metronomeRecordOnly:true},{recording:true}).length,1);assert.equal(clicks({metronomeRecordOnly:true},{automationTake:{advance(){},start:0},advanceAutomationRecording(){}}).length,1);
 assert.equal(clicks({},{inputOverdub:{countInEndBeat:4}}).length,0);assert.equal(clicks({metronomeRecordOnly:true},{inputOverdub:{countInEndBeat:0}}).length,1);
 assert.equal(clicks({},{inputClickClock:{start:12}}).length,0);assert.equal(clicks({metronomeRecordOnly:true},{inputClickClock:{start:10}}).length,1);assert.equal(clicks({metronomeVolume:0}).length,0);
});
test('click audio connects only to monitor output and owned nodes are released',async()=>{
 const {Engine}=await api(),connections=[],levels=[],osc={frequency:{},connect:node=>connections.push(node),start(){},stop(){},disconnect(){}},gain={gain:{setValueAtTime:v=>levels.push(v),exponentialRampToValueAtTime(){}},connect:node=>connections.push(node),disconnect(){}},destination={},e=new Engine({transport:{metronome:true,metronomeVolume:.5}},()=>{});
 e.context={createOscillator:()=>osc,createGain:()=>gain,destination};e.master={};assert.equal(e.click(2,true),osc);assert.equal(osc.frequency.value,1500);assert.equal(levels[0],.064);assert.deepEqual(connections,[gain,destination]);assert.equal(connections.includes(e.master),false);assert.equal(e.clickNodes.size,1);osc.onended();assert.equal(e.clickNodes.size,0);assert.equal(e.nodes.size,0);
});
test('new click preferences survive validation while legacy projects retain defaults',async()=>{
 const {validateTransport,defaultTransport,metronomeLevel}=await api(),transport=defaultTransport();assert.equal(metronomeLevel(transport),.5);assert.deepEqual(validateTransport(transport),transport);assert.equal(validateTransport({...transport,metronomeVolume:0,metronomeRecordOnly:true}).metronomeVolume,0);
 for(const patch of [{metronomeVolume:NaN},{metronomeVolume:1.1},{metronomeVolume:-1},{metronomeRecordOnly:'true'}])assert.throws(()=>validateTransport({...transport,...patch}));
});
test('starting the input clock preserves an already-scheduled first overdub click; finishing clears owned clicks',async()=>{
 const {Engine}=await api(),e=new Engine({bpm:120,transport:{metronome:true,metronomeRecordOnly:true}},()=>{});let stopped=0;const node={stop:()=>stopped++};e.clickNodes.add(node);e.context={currentTime:10};e.playing=true;
 try{e.startInputMetronome({start:10,clicks:[]});assert.equal(stopped,0);e.stopInputMetronome();assert.equal(stopped,1);assert.equal(e.inputClickClock,null);assert.equal(e.clickNodes.size,0);}finally{e.stopInputMetronome();}
});
test('turning off ordinary Click preserves pending count-in clicks but cancels transport clicks',async()=>{
 const {Engine}=await api(),e=new Engine({transport:{}},()=>{});let countStops=0,playStops=0;const count={stop:()=>countStops++},play={stop:()=>playStops++};e.clickNodes=new Set([count,play]);e.inputCountInNodes=new Set([count]);e.clearMetronomeClicks(true);assert.equal(countStops,0);assert.equal(playStops,1);assert.equal(e.clickNodes.size,1);e.clearMetronomeClicks();assert.equal(countStops,1);
});
