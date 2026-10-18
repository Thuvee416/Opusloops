const {test}=require('node:test'),assert=require('node:assert/strict');
const key=(code,extra={})=>({code,defaultPrevented:false,repeat:false,...extra});
test('Live transport/view shortcuts preserve consumed editor keys, typing, composition and agent input',async()=>{
 const {studioShortcut:s}=await import('../web-studio/studio-shortcuts.js');
 for(const [code,action] of [['Space','toggle_play'],['F9','record'],['F10','back'],['Tab','toggle_view']])assert.equal(s(key(code)),action);
 assert.equal(s(key('Digit1',{altKey:true})),'session');assert.equal(s(key('Digit2',{altKey:true})),'arrangement');
 assert.equal(s(key('KeyZ',{metaKey:true,shiftKey:true})),'redo');assert.equal(s(key('KeyZ',{ctrlKey:true})),'undo');
 for(const context of [{typing:true},{dialog:true},{menu:true},{agent:true}])for(const code of ['Space','Tab','F9','F10','KeyZ'])assert.equal(s(key(code,{metaKey:code==='KeyZ'}),context),null);
 for(const extra of [{defaultPrevented:true},{repeat:true},{isComposing:true},{altKey:true},{metaKey:true},{ctrlKey:true}])assert.equal(s(key('Space',extra)),null);
 assert.equal(s(key('Space',{shiftKey:true})),'continue_play');assert.equal(s(key('Home')),'return_start');
 assert.equal(s(key('Tab'),{tabNavigation:true}),null);assert.equal(s(key('Tab',{shiftKey:true})),null);
});
test('keyboard focus preference survives storage failures without blocking transport',async()=>{
 const {tabMovesFocus}=await import('../web-studio/studio-shortcuts.js');assert.equal(tabMovesFocus({getItem:()=>{throw Error('denied');}}),false);assert.equal(tabMovesFocus({getItem:()=>null}),false);assert.equal(tabMovesFocus({getItem:()=> 'true'}),true);
});
test('Session feedback follows the audible clock and preserves the old playing clip until a queued handoff',async()=>{
 const {clipFeedback:f}=await import('../web-studio/session-feedback.js');
 const base={playing:true,mode:'session',active:{clipId:'old',slot:0,start:0},pending:{clipId:'new',slot:1,beat:4},slot:0,clipId:'old',beats:4,beat:3.9};
 assert.equal(f(base).playing,true);assert.equal(f(base).queued,false);assert.ok(f(base).phase>.97);
 const next={...base,clipId:'new',slot:1};assert.equal(f(next).playing,false);assert.equal(f(next).queued,true);
 // Look-ahead scheduling has committed the next event, but it is not audible yet.
 const ahead={...next,pending:null,active:{clipId:'new',slot:1,start:4}};assert.equal(f(ahead).playing,false);assert.equal(f(ahead).queued,true);
 assert.equal(f({...ahead,beat:4}).playing,true);assert.equal(f({...ahead,beat:4}).queued,false);assert.equal(f({...ahead,beat:6}).phase,.5);assert.equal(f({...ahead,beat:8}).phase,0);
 assert.equal(f({...base,mode:'arrangement'}).playing,false);assert.equal(f({...base,mode:'arrangement',override:true}).playing,true);
 assert.equal(f({...base,playing:false}).playing,false);assert.equal(f({...base,playing:false}).queued,false);
});
test('queued stop and duplicate clip slots never masquerade as another active instance',async()=>{
 const {clipFeedback:f}=await import('../web-studio/session-feedback.js');const base={playing:true,mode:'session',active:{clipId:'loop',slot:1,start:4},pending:{clipId:null,toggleSource:'loop',beat:8},clipId:'loop',slot:1,beats:4,beat:7};
 assert.equal(f(base).playing,true);assert.equal(f(base).queued,true);assert.equal(f(base).stopping,true);assert.equal(f({...base,slot:0,pending:null}).playing,false);assert.equal(f({...base,slot:0}).queued,false);assert.equal(f({...base,slot:0,pending:{clipId:'loop',slot:1,beat:8}}).queued,false);
 assert.equal(f({...base,beat:7.25}).pulse,true);assert.equal(f({...base,beat:7.75}).pulse,false);
});
