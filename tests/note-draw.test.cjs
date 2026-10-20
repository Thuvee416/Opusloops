const {test}=require('node:test'),assert=require('node:assert/strict');
const note=(pitch,start,duration=.25)=>({pitch,start,duration,velocity:.5});
const clip=notes=>({kind:'midi',beats:4,notes});
test('draw interpolates skipped cells, respects pitch rows and never mutates its source',async()=>{
 const {createNoteDrawStroke}=await import('../web-studio/note-draw.js'),c=clip([note(60,3)]),before=structuredClone(c),s=createNoteDrawStroke(c,{rows:[64,62,60]});
 s.visit(.01,0);s.visit(.76,2);s.visit(.01,0);const r=s.result();assert.deepEqual(r.added.map(n=>[n.pitch,n.start]),[[64,0],[62,.25],[62,.5],[60,.75]]);assert.deepEqual(r.selection,[1,2,3,4]);assert.deepEqual(c,before);
 r.notes[0].pitch=0;assert.equal(s.result().notes[0].pitch,60);
});
test('draw erases original notes once across their whole duration, preserving unrelated metadata',async()=>{
 const {createNoteDrawStroke}=await import('../web-studio/note-draw.js'),c=clip([{...note(60,.1,.9),active:false,releaseVelocity:.8},note(64,0)]),s=createNoteDrawStroke(c,{rows:[64,60]});
 s.visit(.15,1);s.visit(.9,1);s.visit(.15,1);assert.deepEqual(s.result().notes,[c.notes[1]]);assert.deepEqual(s.result().removed,[0]);assert.deepEqual(s.result().selection,[]);
});
test('draw clips the final grid cell and ignores invalid or out-of-bounds positions without bridging gaps',async()=>{
 const {createNoteDrawStroke}=await import('../web-studio/note-draw.js'),s=createNoteDrawStroke({...clip([]),beats:1.1},{rows:[60]});
 s.visit(0,0);s.visit(NaN,0);s.visit(1.09,0);s.visit(2,0);s.visit(.5,-1);assert.deepEqual(s.result().notes.map(n=>[n.start,n.duration]),[[0,.25],[1,.10000000000000009]]);
});
test('draw bounds validation and note limits fail without touching the project',async()=>{
 const {createNoteDrawStroke}=await import('../web-studio/note-draw.js');assert.throws(()=>createNoteDrawStroke(clip([]),{rows:[60,60]}));assert.throws(()=>createNoteDrawStroke(clip([]),{grid:0,rows:[60]}));
 const c=clip(Array.from({length:4096},()=>note(64,0))),before=structuredClone(c),s=createNoteDrawStroke(c,{rows:[60]});assert.throws(()=>s.visit(0,0),/4096/);assert.deepEqual(c,before);
});
test('B Draw Mode shortcut never consumes typing, modal, modifiers, repeats or composition',async()=>{
 const {studioShortcut}=await import('../web-studio/studio-shortcuts.js');assert.equal(studioShortcut({code:'KeyB'}),'note-draw');for(const name of ['typing','agent','dialog','menu'])assert.equal(studioShortcut({code:'KeyB'},{[name]:true}),null);for(const name of ['repeat','isComposing','defaultPrevented','ctrlKey','metaKey','altKey','shiftKey'])assert.equal(studioShortcut({code:'KeyB',[name]:true}),null);
});
