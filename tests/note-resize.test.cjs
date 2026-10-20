const {test}=require('node:test'),assert=require('node:assert/strict');
const clip=()=>({id:'phrase',kind:'midi',beats:8,notes:[
 {pitch:60,start:1,duration:1,velocity:.5,releaseVelocity:.3},
 {pitch:64,start:3,duration:.75,velocity:.8,active:false},
 {pitch:67,start:6,duration:.5,velocity:.6}
]});
test('selected resize applies one snapped delta and preserves notes, selection and metadata',async()=>{
 const {editNoteGroup}=await import('../web-studio/notes.js'),c=clip(),before=structuredClone(c),r=editNoteGroup(c,'resize',{indices:[1,0],deltaBeats:1.13,grid:.25});
 assert.deepEqual(r.selection,[0,1]);assert.deepEqual(r.notes,[{...c.notes[0],duration:2.25},{...c.notes[1],duration:2},c.notes[2]]);assert.deepEqual(c,before);
});
test('group bounds constrain every length equally at the shortest note or nearest clip edge',async()=>{
 const {editNoteGroup}=await import('../web-studio/notes.js'),c=clip();
 const short=editNoteGroup(c,'resize',{indices:[0,1],deltaBeats:-20});assert.equal(short.notes[0].duration,.3125);assert.equal(short.notes[1].duration,.0625);
 c.notes[1].start=7;const long=editNoteGroup(c,'resize',{indices:[0,1],deltaBeats:20});assert.equal(long.notes[0].duration,1.25);assert.equal(long.notes[1].duration,1);assert.deepEqual(long.notes[2],c.notes[2]);
});
test('short recorded notes and existing tails are not silently changed by a zero or constrained drag',async()=>{
 const {editNoteGroup}=await import('../web-studio/notes.js'),c=clip();c.notes[0].duration=.001;c.notes[1].duration=10;
 assert.deepEqual(editNoteGroup(c,'resize',{indices:[0,1],deltaBeats:0}).notes,c.notes);
 assert.deepEqual(editNoteGroup(c,'resize',{indices:[0,1],deltaBeats:-1}).notes,c.notes);
 assert.deepEqual(editNoteGroup(c,'resize',{indices:[0,1],deltaBeats:1}).notes,c.notes);
 const tail=editNoteGroup(c,'resize',{indices:[1],deltaBeats:-1});assert.equal(tail.notes[1].duration,9);
});
test('invalid resize inputs fail without a partial clip edit',async()=>{
 const {editNoteGroup}=await import('../web-studio/notes.js'),c=clip(),before=structuredClone(c);
 for(const args of [{deltaBeats:NaN},{deltaBeats:Infinity},{deltaBeats:1,grid:0},{deltaBeats:1,grid:2},{indices:[99],deltaBeats:1}])assert.throws(()=>editNoteGroup(c,'resize',{indices:[0,1],...args}));
 assert.deepEqual(c,before);
});
