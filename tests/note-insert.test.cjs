const {test}=require('node:test'),assert=require('node:assert/strict');
const clip=()=>({id:'phrase',kind:'midi',beats:8,notes:[{pitch:60,start:1,duration:2,velocity:.5,releaseVelocity:.2},{pitch:64,start:2,duration:2,velocity:.7,active:false},{pitch:67,start:4,duration:1,velocity:.9}]});
test('insert navigation snaps in either direction, bounds the clip and finds actual note boundaries',async()=>{
 const {noteInsertKey:key}=await import('../web-studio/note-insert.js'),state={at:1.1,beats:8,grid:.25,notes:clip().notes};
 assert.equal(key({key:'ArrowRight'},state),1.25);assert.equal(key({key:'ArrowLeft'},state),1);assert.equal(key({key:'ArrowLeft'},{...state,at:0}),0);assert.equal(key({key:'ArrowRight'},{...state,at:8}),8);
 assert.equal(key({key:'ArrowRight',ctrlKey:true},state),2);assert.equal(key({key:'ArrowLeft',altKey:true},{...state,at:3}),2);assert.equal(key({key:'ArrowRight',altKey:true},{...state,at:4}),5);assert.equal(key({key:'Home'},state),0);assert.equal(key({key:'End'},state),8);
 for(const mod of ['shiftKey','metaKey','isComposing'])assert.equal(key({key:'ArrowRight',[mod]:true},state),null);assert.equal(key({key:'ArrowUp'},state),null);
});
test('Add Note uses marker pitch and beat, shortens at the clip edge and rejects the end without changing source',async()=>{
 const {insertNoteAt}=await import('../web-studio/note-insert.js'),c=clip(),before=structuredClone(c),r=insertNoteAt(c,{at:7.9,pitch:62,grid:.25});assert.deepEqual(r.selection,[3]);assert.equal(r.notes[3].start,7.9);assert.equal(r.notes[3].pitch,62);assert.ok(Math.abs(r.notes[3].duration-.1)<1e-9);assert.throws(()=>insertNoteAt(c,{at:8,pitch:62,grid:.25}),/Before The End/);assert.deepEqual(c,before);
});
test('marker splitting only divides crossing notes and preserves velocity, release and inactive metadata',async()=>{
 const {notesAtInsert,splitNotesAtInsert}=await import('../web-studio/note-insert.js'),c=clip(),before=structuredClone(c);assert.deepEqual(notesAtInsert(c,2.5),[0,1]);assert.deepEqual(notesAtInsert(c,3),[1]);assert.deepEqual(notesAtInsert(c,0),[]);assert.deepEqual(notesAtInsert(c,8),[]);
 const r=splitNotesAtInsert(c,2.5);assert.deepEqual(r.selection,[0,1,2,3]);assert.deepEqual(r.notes,[{...c.notes[0],duration:1.5},{...c.notes[0],start:2.5,duration:.5},{...c.notes[1],duration:.5},{...c.notes[1],start:2.5,duration:1.5},c.notes[2]]);assert.deepEqual(c,before);assert.throws(()=>splitNotesAtInsert(c,7));
});
test('marker position rejects nonfinite input and clamps only view state after shortening a clip',async()=>{
 const {noteInsertPosition}=await import('../web-studio/note-insert.js');assert.equal(noteInsertPosition(7,4),4);assert.equal(noteInsertPosition(-1,4),0);assert.throws(()=>noteInsertPosition(NaN,4));assert.throws(()=>noteInsertPosition(2,0));
});
