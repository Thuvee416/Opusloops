const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),source=fs.readFileSync(require.resolve('../web-studio/app.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){const calls=[],monitor={checked:true},player={playing:true,position:12,pause(){calls.push('pause');this.playing=false;this.recording=false;this.automationTake=null;}},s={engine:player,inputActive:()=>false,keyboardEnabled:false,audioInput:null,inputPending:false,inputCompletion:null,midiTake:null,releaseNotes:()=>calls.push('release'),$:()=>monitor,syncInputMonitor:()=>calls.push('monitor-off'),finishInput:async()=>{calls.push('finish');s.midiTake=null;return {status:'saved'};},setStatus:(message,error)=>calls.push({message,error}),renderTransport:()=>calls.push('render')};vm.createContext(s);vm.runInContext(source.slice(source.indexOf('function bindAudioContextState('),source.indexOf('function audioOutputSupported(')),s);s.bindAudioContextState(player);return {s,player,calls,monitor};}
test('interruption pauses ordinary playback, preserves the position and requires explicit user restart',async()=>{
 const {player,calls,monitor}=setup();player.onContextStateChange('suspended');await tick();assert.equal(player.playing,false);assert.equal(player.position,12);assert.equal(monitor.checked,false);assert.deepEqual(calls.slice(0,3),['release','monitor-off','pause']);assert.match(calls[3].message,/Press Continue/);player.onContextStateChange('running');assert.equal(player.playing,false);
});
test('obsolete and idle engines ignore state changes and repeated notices do not duplicate take completion',async()=>{
 const a=setup();a.s.engine={};a.player.onContextStateChange('closed');await tick();assert.deepEqual(a.calls,[]);
 const b=setup();b.player.playing=false;b.player.onContextStateChange('suspended');assert.deepEqual(b.calls,[]);
 const c=setup();let finish;c.s.midiTake={};c.s.inputActive=()=>true;c.s.finishInput=()=>new Promise(r=>{c.calls.push('finish');finish=r;});c.player.onContextStateChange('interrupted');c.player.onContextStateChange('closed');assert.equal(c.calls.filter(c=>c==='finish').length,1);finish({status:'saved'});await tick();assert.match(c.calls.find(c=>c.message)?.message,/Take Was Saved/);
});
test('active MIDI and recovered audio use existing take completion and retain the recovery warning',async()=>{
 const m=setup();m.s.midiTake={};m.s.inputActive=()=>true;m.player.onContextStateChange('suspended');await tick();assert.equal(m.s.midiTake,null);assert.match(m.calls.find(c=>c.message)?.message,/Take Was Saved/);
 const a=setup();let complete;a.s.inputActive=()=>true;a.s.inputPending=true;a.s.inputCompletion=new Promise(r=>complete=r);a.s.audioInput={active:true,interrupted(message){a.calls.push(message);this.active=false;complete({status:'saved',warning:'The End Of The Take May Be Missing.'});}};a.player.onContextStateChange('closed');await tick();assert.match(a.calls.find(c=>c.message)?.message,/End Of The Take May Be Missing/);
});
test('failed recovery remains visible and Session/automation captures are finalized through pause',async()=>{
 const a=setup();a.s.midiTake={};a.s.finishInput=async()=>{throw Error('Keep This Tab Open To Retry');};a.player.onContextStateChange('suspended');await tick();assert.equal(a.calls.find(c=>c.message)?.message,'Keep This Tab Open To Retry');assert.equal(a.calls.at(-1),'render');
 for(const mode of ['recording','automationTake']){const b=setup();b.player[mode]=true;b.player.onContextStateChange('suspended');await tick();assert.equal(!!b.player[mode],false);assert.match(b.calls.find(c=>c.message)?.message,/Saved At The Interrupted Position/);}
});
test('MIDI note-ons cannot accumulate on a suspended or closed engine, while note-offs still release',()=>{
 const start=source.indexOf('function inputNote('),calls=[],s={liveNotes:{on:()=>calls.push('on'),off:()=>calls.push('off')},engine:{context:{state:'suspended',currentTime:1}},busy:false,inputConnecting:false,inputFinishing:false,inputActive:()=>false,armedInputTrack:'track',midiTake:null,inputStarted:0,MidiOverdub:class{}};vm.createContext(s);vm.runInContext(source.slice(start,source.indexOf('\n',start)),s);
 for(const state of ['suspended','interrupted','closed']){s.engine.context.state=state;s.inputNote('on','key',60);s.inputNote('off','key',60);}assert.deepEqual(calls,['off','off','off']);s.engine.context.state='running';s.inputNote('on','key',60);assert.equal(calls.at(-1),'on');
});
test('input reconnection rebuilds only a stale idle capture and never discards a pending recovered take',async()=>{
 const {captureForContext}=await import('../web-studio/input.js'),old={},fresh={},calls=[],capture={context:old,disconnect:async()=>calls.push('disconnect')},create=context=>{calls.push('create');return {context};};assert.equal(await captureForContext(capture,old,create),capture);assert.deepEqual(calls,[]);assert.equal((await captureForContext(capture,fresh,create)).context,fresh);assert.deepEqual(calls,['disconnect','create']);
 for(const state of ['active','recoverable']){calls.length=0;await assert.rejects(captureForContext({...capture,[state]:true},fresh,create),/Recover/);assert.deepEqual(calls,[]);}
});
test('an interrupted idle microphone connection is disconnected instead of looking ready on a stopped context',async()=>{
 const {s,player,calls}=setup();player.playing=false;s.audioInput={connected:true,interrupted(){this.connected=false;calls.push('disconnect-input');}};player.onContextStateChange('closed');await tick();assert.equal(s.audioInput.connected,false);assert.ok(calls.includes('disconnect-input'));
});
