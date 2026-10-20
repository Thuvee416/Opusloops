const {test}=require('node:test'),assert=require('node:assert/strict');
const fixture=()=>({id:'phrase',kind:'midi',beats:8,notes:[
 {pitch:60,start:0,duration:4,velocity:.5,releaseVelocity:.2,active:false},
 {pitch:64,start:1.5,duration:.25,velocity:.7},
 {pitch:67,start:4,duration:1,velocity:.9},
 {pitch:60,start:7,duration:2,velocity:.6}
]});
const api=()=>import('../web-studio/note-time-selection.js');
test('time range keyboard selection crosses its anchor, snaps and retains pitch bounds',async()=>{
 const {noteTimeRange:r,noteTimeKey:key}=await api(),c=fixture(),state={at:2,beats:8,grid:.25,notes:c.notes};
 const a=key({key:'ArrowRight',shiftKey:true},state);assert.deepEqual(a.range,r(2,2.25,8));
 assert.equal(key({key:'ArrowLeft',shiftKey:true},{...state,range:a.range}).range,null);
 assert.deepEqual(key({key:'ArrowLeft',shiftKey:true},{...state,range:r(2,1,8,60,64)}).range,r(2,.75,8,60,64));
 assert.equal(key({key:'ArrowRight',shiftKey:true,altKey:true},state).at,4);
 for(const e of [{key:'ArrowRight'},{key:'ArrowRight',shiftKey:true,metaKey:true},{key:'ArrowRight',shiftKey:true,isComposing:true}])assert.equal(key(e,state),null);
 assert.equal(r(8,10,8),null);assert.throws(()=>r(NaN,1,8));assert.throws(()=>r(1,2,8,70,60));
});
test('time clipboard keeps silence, clips intersections and preserves note metadata without mutating source',async()=>{
 const {noteTimeRange:r,copyNoteTime:copy}=await api(),c=fixture(),before=structuredClone(c),all=copy(c,r(1,3,8));
 assert.equal(all.span,2);assert.deepEqual(all.notes,[{...c.notes[0],start:0,duration:2},{...c.notes[1],start:.5}]);
 const rest=copy(c,r(1,3,8,64,64));assert.equal(rest.notes[0].start,.5);assert.equal(rest.span,2);
 assert.deepEqual(copy(c,r(5,6,8)).notes,[]);assert.deepEqual(c,before);
});
test('range deletion preserves both outside note fragments and unrelated pitches, including tails',async()=>{
 const {noteTimeRange:r,editNoteTime:edit}=await api(),c=fixture(),before=structuredClone(c),out=edit(c,'delete',{range:r(1,3,8,60,60)});
 assert.deepEqual(out.notes,[{...c.notes[0],duration:1},{...c.notes[0],start:3,duration:1},...c.notes.slice(1)]);assert.deepEqual(out.selection,[]);assert.deepEqual(c,before);
 assert.deepEqual(edit(c,'delete',{range:r(7.5,8,8)}).notes.at(-1),{...c.notes[3],duration:.5});
});
test('range paste and duplicate preserve full rhythmic span, overwrite only its pitch/time rectangle and reject overflow atomically',async()=>{
 const {noteTimeRange:r,copyNoteTime:copy,editNoteTime:edit}=await api(),c=fixture(),before=structuredClone(c),range=r(1,3,8,64,64),cb=copy(c,range),pasted=edit(c,'paste',{clipboard:cb,at:5});
 assert.deepEqual(pasted.notes.slice(0,4),c.notes);assert.deepEqual(pasted.notes[4],{...c.notes[1],start:5.5});assert.deepEqual(pasted.timeRange,r(5,7,8,64,64));
 assert.deepEqual(edit(c,'duplicate',{range}).notes.at(-1),{...c.notes[1],start:3.5});
 const silence=copy(c,r(5,6,8,64,64)),erased=edit(c,'paste',{clipboard:silence,at:1});assert.deepEqual(erased.notes,[c.notes[0],c.notes[2],c.notes[3]]);
 assert.throws(()=>edit(c,'paste',{clipboard:cb,at:7}),/Does Not Fit/);assert.throws(()=>edit(c,'paste',{clipboard:{...cb,notes:[{...cb.notes[0],start:2}]},at:1}),/Invalid/);assert.deepEqual(c,before);
});
test('time-boundary splitting preserves all outside material and note metadata and can split both sides in one transaction',async()=>{
 const {noteTimeRange:r,editNoteTime:edit}=await api(),c=fixture(),range=r(1,3,8,60,60),out=edit(c,'split',{range});
 assert.deepEqual(out.notes,[{...c.notes[0],duration:1},{...c.notes[0],start:1,duration:2},{...c.notes[0],start:3,duration:1},...c.notes.slice(1)]);assert.deepEqual(out.selection,[1]);
 assert.deepEqual(edit(c,'split',{range:r(7.5,8,8)}).notes.slice(-2),[{...c.notes[3],duration:.5},{...c.notes[3],start:7.5,duration:1.5}]);
});
test('time operations enforce note capacity before any mutation',async()=>{
 const {noteTimeRange:r,editNoteTime:edit}=await api(),c=fixture();c.notes=Array.from({length:4096},()=>({...c.notes[0]}));const before=structuredClone(c);
 assert.throws(()=>edit(c,'split',{range:r(1,3,8)}),/4096/);assert.throws(()=>edit(c,'delete',{range:r(1,3,8)}),/4096/);assert.deepEqual(c,before);
});
test('Odesa selection preservation protects time range bounds and membership before commit',async()=>{
 const {prepareNavigationPreservation,readNavigationPreservation,checkNavigationPreserved}=await import('../web-studio/navigation-preservation.js'),{noteTimeRange:r}=await api(),p={tracks:[{id:'t',slots:['phrase']}],scenes:1,clips:{phrase:fixture()},arrangement:[]};
 const studio={selection:{trackId:'t',clipId:'phrase',scene:0},noteSelection:{clipId:'phrase',indices:[1],primaryIndex:1,timeRange:r(1,3,8,64,64)}};
 const required=readNavigationPreservation('Keep my selection.',studio),next=structuredClone(p);next.clips.phrase.notes[1].velocity=.3;
 assert.deepEqual(prepareNavigationPreservation(p,next,[],required).expected.noteSelection.timeRange,studio.noteSelection.timeRange);
 next.clips.phrase.notes[1].start=4;assert.throws(()=>prepareNavigationPreservation(p,next,[],required),/Inside The Preserved/);
 const shorter=structuredClone(p);shorter.clips.phrase.beats=2;assert.throws(()=>prepareNavigationPreservation(p,shorter,[],required),/Preserve This MIDI Time Range/);
 assert.throws(()=>checkNavigationPreserved(required,{...studio,noteSelection:{...studio.noteSelection,timeRange:r(1,4,8,64,64)}}),/Did Not Match/);
});
