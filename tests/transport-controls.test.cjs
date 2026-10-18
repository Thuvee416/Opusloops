const {test}=require('node:test'),assert=require('node:assert/strict');
const api=async()=>({...await import('../web-studio/transport-controls.js'),...await import('../web-studio/audio.js'),...await import('../web-studio/model.js'),...await import('../web-studio/agent-runner.js'),...await import('../web-studio/session-keyboard.js')});
function stopped(t){const engine=new t.Engine(t.emptyProject(),()=>{});return engine;}
test('one Stop retains a running point exactly, second Stop resets position and insert marker',async()=>{
 const t=await api(),e=stopped(t);e.playing=true;e.position=2.12345;e.insertMarker=1.25;e.rawBeat=()=>e.position;e.beat=()=>e.position;
 const first=await t.stopPlayback(e);assert.equal(first.position,2.12345);assert.equal(first.reset,false);assert.equal(e.playing,false);assert.equal(e.insertMarker,1.25);
 const second=await t.stopPlayback(e);assert.equal(second.position,0);assert.equal(second.reset,true);assert.equal(e.insertMarker,0);
});
test('normal Play uses the insert marker while Continue retains unsnapped stopped phase',async()=>{
 const t=await api(),e=stopped(t);await e.seek(5);e.position=7.123456;
 await t.preparePlayback(e,{from:'continue'});assert.equal(e.position,7.123456);assert.equal(e.insertMarker,5);
 await t.preparePlayback(e);assert.equal(e.position,5);assert.equal(e.insertMarker,5);
 e.position=6;e.playing=true;const current=await t.preparePlayback(e);assert.equal(current.alreadyPlaying,true);assert.equal(e.position,6);
});
test('explicit reset and a recorder finishing before Stop preserve the requested transport result',async()=>{
 const t=await api(),e=stopped(t);e.insertMarker=4;await t.stopPlayback(e,{}, {running:true,position:3.1415926});assert.equal(e.position,3.1415926);assert.equal(e.insertMarker,4);
 const reset=await t.stopPlayback(e,{reset:true},{running:true,position:3.1415926});assert.equal(reset.position,0);assert.equal(e.insertMarker,0);
});
test('explicit seeks move the marker but internal transport positioning leaves it alone',async()=>{
 const t=await api(),e=stopped(t);await e.seek(6.13);assert.equal(e.insertMarker,6.25);await e.seek(7.1234,{moveMarker:false,snap:false});assert.equal(e.position,7.1234);assert.equal(e.insertMarker,6.25);await assert.rejects(()=>e.seek(-1));assert.equal(e.insertMarker,6.25);
});
test('agent transport contract admits only deliberate typed marker/continue/reset options and preflights the entire plan',async()=>{
 const t=await api(),p=t.emptyProject();for(const [name,args] of [['play',{}],['play',{from:'continue'}],['play',{from:'marker'}],['stop',{reset:true}],['stop',{reset:false}]])assert.doesNotThrow(()=>t.prepareAgentPlan(p,[{type:'command',args:{name,args}}]));
 const before=JSON.stringify(p);for(const [name,args] of [['play',{from:'beginning'}],['play',{from:null}],['play',{reset:true}],['stop',{reset:1}],['stop',{from:'marker'}]])assert.throws(()=>t.prepareAgentPlan(p,[{type:'project',args:{bpm:130}},{type:'command',args:{name,args}}]));assert.equal(JSON.stringify(p),before);
});
test('Session arrows navigate visible tracks, empty rows and the scene column without wrapping edges',async()=>{
 const {sessionNeighbor:n}=await api(),ids=['a','group','z'];assert.deepEqual(n(ids,4,{kind:'slot',trackId:'a',scene:0},'ArrowLeft'),{kind:'slot',trackId:'a',scene:0});assert.deepEqual(n(ids,4,{kind:'slot',trackId:'a',scene:0},'ArrowDown'),{kind:'slot',trackId:'a',scene:1});assert.deepEqual(n(ids,4,{kind:'slot',trackId:'a',scene:1},'ArrowRight'),{kind:'slot',trackId:'group',scene:1});assert.deepEqual(n(ids,4,{kind:'slot',trackId:'z',scene:2},'ArrowRight'),{kind:'scene',scene:2});assert.deepEqual(n(ids,4,{kind:'scene',scene:2},'ArrowLeft'),{kind:'slot',trackId:'z',scene:2});assert.deepEqual(n(ids,4,{kind:'scene',scene:3},'ArrowDown'),{kind:'scene',scene:3});assert.equal(n(ids,4,{kind:'slot',trackId:'folded-child',scene:1},'ArrowRight'),null);assert.equal(n(ids,4,{kind:'slot',trackId:'a',scene:4},'ArrowUp'),null);
});
test('Stop during a pending audio start cancels its generation; a second Stop still rewinds before preparation settles',async()=>{
 const t=await api(),e=stopped(t);e.position=6;e.insertMarker=4;e.startPromise=new Promise(()=>{});const generation=e.playGeneration;
 const first=await t.stopPlayback(e);assert.equal(first.reset,false);assert.equal(e.position,6);assert.ok(e.playGeneration>generation);
 const second=await t.stopPlayback(e);assert.equal(second.reset,true);assert.equal(e.position,0);assert.equal(e.insertMarker,0);
});
