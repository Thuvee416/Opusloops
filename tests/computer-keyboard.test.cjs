const {test}=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../web-studio/computer-keyboard.js');
test('computer keyboard preserves the original note bank and changes octave without invalid MIDI pitches',async()=>{
 const {ComputerKeyboard,COMPUTER_NOTE_KEYS}=await load(),k=new ComputerKeyboard();
 assert.equal(COMPUTER_NOTE_KEYS.length,13);assert.deepEqual(k.state(),{lowestNote:60,highestNote:72,velocity:.75});
 assert.equal(k.state(true).lowestNote,36);k.adjust('octave-down');assert.equal(k.state().lowestNote,48);k.adjust('octave-up');assert.equal(k.state().lowestNote,60);
 for(const drums of [false,true]){for(let i=0;i<30;i++)k.adjust('octave-up',drums);assert.equal(k.state(drums).highestNote,120);for(let i=0;i<30;i++)k.adjust('octave-down',drums);assert.equal(k.state(drums).lowestNote,0);}
});
test('velocity controls step through musical dynamic levels, clamp and never produce silent note-ons',async()=>{
 const {ComputerKeyboard}=await load(),k=new ComputerKeyboard();k.adjust('velocity-down');assert.equal(k.velocity,80/127);k.adjust('velocity-up');assert.equal(k.velocity,100/127);k.adjust('velocity-up');assert.equal(k.velocity,1);
 for(let i=0;i<20;i++)k.adjust('velocity-up');assert.equal(k.velocity,1);
 for(let i=0;i<20;i++)k.adjust('velocity-down');assert.equal(k.velocity,20/127);
 assert.match(k.describe(),/C4–C5 · Velocity 20/);
});
test('typing, menus, dialogs, Odesa, composition and consumed shortcuts cannot play or change the keyboard',async()=>{
 const {computerKeyAction}=await load();
 for(const code of ['KeyA','KeyX','KeyC']){
  for(const flag of ['typing','menu','dialog','agent'])assert.equal(computerKeyAction({code},{enabled:true,[flag]:true}),null);
  for(const flag of ['repeat','defaultPrevented','isComposing','ctrlKey','altKey','metaKey'])assert.equal(computerKeyAction({code,[flag]:true},{enabled:true}),null);
  assert.equal(computerKeyAction({code,keyCode:229},{enabled:true}),null);
  assert.equal(computerKeyAction({code},{enabled:false}),null);
 }
 assert.deepEqual(computerKeyAction({code:'KeyX'},{enabled:true}),{control:'octave-up'});
 assert.deepEqual(computerKeyAction({code:'KeyK'},{enabled:true}),{note:12});
 assert.deepEqual(computerKeyAction({code:'KeyA',shiftKey:true},{enabled:true}),{note:0});
});
