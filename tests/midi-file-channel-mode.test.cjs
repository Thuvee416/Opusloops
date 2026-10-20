const {test}=require('node:test'),assert=require('node:assert/strict');
async function api(){return {...await import('../web-studio/midi-file.js'),...await import('../web-studio/model.js'),write:(await import('../web-studio/vendor/midi-writer.js')).default};}
const on=(beat,pitch=60,channel=0)=>({beat,type:'noteOn',channel,noteNumber:pitch,velocity:100}),off=(beat,pitch=60,channel=0)=>({beat,type:'noteOff',channel,noteNumber:pitch,velocity:32}),cc=(beat,controllerType,value=0,channel=0)=>({beat,type:'controller',channel,controllerType,value}),end=beat=>({beat,meta:true,type:'endOfTrack'});
function file(t,tracks){return new Uint8Array(t.write({header:{format:tracks.length===1?0:1,ticksPerBeat:480},tracks:tracks.map(events=>{let previous=0;return events.map(({beat,...event})=>{const tick=Math.round(beat*480),deltaTime=tick-previous;previous=tick;return {...event,deltaTime};});})}));}
const durations=result=>result.groups.flatMap(g=>g.notes.map(n=>[g.channel,n.pitch,n.start,n.duration]));
test('All Notes Off ends every held key on its channel without inventing release velocity',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0),on(.5,64),on(0.5,67,1),cc(1,123),off(3,67,1),end(6)]]));
 assert.deepEqual(durations(result),[[0,60,0,1],[0,64,.5,.5],[1,67,.5,2.5]]);assert.equal(result.groups[0].beats,6);assert.equal(result.groups[0].notes[0].releaseVelocity,undefined);assert.ok(result.warnings.includes('2 All Notes Off converted to editable note lengths'));assert.ok(!result.warnings.some(w=>w.includes('closed at track end')));
});
test('format-1 All Notes Off spans note tracks on the same channel while preserving track ownership',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[cc(2,123),end(6)],[on(0),end(6)],[on(1,64),on(1,67,1),off(4,67,1),end(6)]]));
 assert.deepEqual(durations(result),[[0,60,0,2],[0,64,1,1],[1,67,1,3]]);const p=t.importMidiProject(t.emptyProject(),result,{replace:true});assert.equal(p.tracks.length,3);t.validateProject(p);
});
test('All Notes Off releases keys but respects sustain until pedal-up or reset; future notes remain independent',async()=>{
 const t=await api();for(const release of [cc(3,64),cc(3,121)]){
  const result=t.inspectMidi(file(t,[[cc(0,64,127),on(0),cc(1,123),on(2,64),release,off(4,64),end(6)]]));
  assert.deepEqual(durations(result),[[0,60,0,3],[0,64,2,2]]);assert.ok(result.warnings.includes('1 sustain-held notes converted to editable note lengths'));
 }
 const open=t.inspectMidi(file(t,[[cc(0,64,127),on(0),cc(1,123),end(5)]]));assert.equal(open.groups[0].notes[0].duration,5);assert.ok(open.warnings.some(w=>w.includes('sustained notes closed at file end')));
});
test('same-tick channel modes follow deterministic file order and preserve later same-pitch attacks',async()=>{
 const t=await api(),before=t.inspectMidi(file(t,[[cc(0,123),on(0),off(2),end(4)]]));assert.equal(before.groups[0].notes[0].duration,2);
 const after=t.inspectMidi(file(t,[[on(0),cc(1,123),on(1),off(2),end(4)]]));assert.deepEqual(durations(after),[[0,60,0,1],[0,60,1,1]]);
 const zero=t.inspectMidi(file(t,[[on(0),cc(0,123),on(1),off(2),end(4)]]));assert.deepEqual(durations(zero),[[0,60,1,1]]);assert.ok(zero.warnings.includes('1 zero-length notes omitted'));
});
test('redundant old note-offs and duplicate All Notes Off cannot swallow a later note',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0),cc(1,123),cc(1.5,123),off(2),off(2.5),on(3),off(4),end(6)]]));
 assert.deepEqual(durations(result),[[0,60,0,1],[0,60,3,1]]);assert.ok(result.warnings.includes('2 unmatched note-off events omitted'));
});
test('ordinary same-pitch overlaps retain FIFO note pairing and release velocities',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0),on(.5),off(1),{...off(2),velocity:64},end(4)]]));
 assert.deepEqual(result.groups[0].notes.map(n=>[n.start,n.duration,n.releaseVelocity]),[[0,1,32/127],[.5,1.5,64/127]]);
});
test('end-of-track fallback, unknown controller warnings and bounded malformed-file rejection remain intact',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0),cc(1,120),end(2)],[cc(3,123),end(4)]]));assert.equal(result.groups[0].notes[0].duration,2);assert.ok(result.warnings.includes('1 held notes closed at track end'));assert.ok(result.warnings.includes('1 controller events not applied'));
 const {midiFileReleases}=await import('../web-studio/midi-file-releases.js');for(const value of [-1,128,NaN])assert.throws(()=>midiFileReleases({header:{ticksPerBeat:480},tracks:[[{deltaTime:0,type:'controller',channel:0,controllerType:123,value}]]}),/All Notes Off data/);
 assert.throws(()=>t.inspectMidi(file(t,[[on(0),cc(257,123),end(257)]])),/256-beat/);assert.throws(()=>t.inspectMidi(file(t,[[on(0),cc(1,123)]])),/end-of-track/);
});

test('ordinary multichannel import retains its existing first-release track order',async()=>{
 const t=await api(),result=t.inspectMidi(file(t,[[on(0,60,0),on(0,67,1),off(1,67,1),off(4,60,0),end(4)]]));assert.deepEqual(result.groups.map(g=>g.channel),[1,0]);
});
