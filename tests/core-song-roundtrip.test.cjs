const {test}=require('node:test'),assert=require('node:assert/strict');
const source=()=>import('./fixtures/core-song-project.mjs');
test('a 32-bar imported-audio/MIDI study preserves all sections, media, voices, automation and returns through project serialization/recovery',async()=>{
 const {coreSongProject,songSections}=await source(),{validateProject}=await import('../web-studio/model.js'),{loadSession}=await import('../web-studio/session-recovery.js');
 const {project:p,media}=coreSongProject(),bytes=JSON.stringify(p),saved=JSON.parse(bytes),writes=[];assert.equal(JSON.stringify(validateProject(saved)),bytes);
 const loaded=await loadSession({read:async key=>key==='current'?JSON.parse(bytes):null,write:async rows=>writes.push(rows),validate:validateProject,now:()=>42});assert.equal(JSON.stringify(loaded.project),bytes);assert.equal(loaded.recovered,false);assert.equal(JSON.stringify(writes[0][0][1].project),bytes);
 assert.deepEqual(p.tracks.map(t=>t.name),['Drums','Bass','Keys','Guide Melody']);assert.equal(p.bpm,120);assert.equal(p.arrangement.length,25);assert.equal(Math.max(...p.arrangement.map(r=>r.start+r.length)),128);assert.equal(Buffer.compare(Buffer.from(p.clips.drums.data,'base64'),media.drums),0);assert.deepEqual(p.locators.map(({name,beat})=>({name,start:beat})),songSections.map(({name,start})=>({name,start})));
 const audible=(id,beat)=>p.arrangement.some(r=>r.trackId===id&&r.start<=beat&&r.start+r.length>beat);
 assert.equal(audible('bass',0),false);assert.equal(audible('drums',48),false);assert.equal(audible('keys',48),true);assert.equal(audible('guide',48),false);assert.ok(p.tracks.every(t=>audible(t.id,80)));assert.equal(audible('guide',112),false);
 assert.equal(p.tracks[1].instrument.cutoff,700);assert.equal(p.tracks[2].instrument.attack,.6);assert.equal(p.tracks[3].instrument.sustain,0);assert.equal(p.tracks[2].devices[0].type,'chorus');assert.equal(p.tracks[3].devices[0].type,'delay');assert.equal(p.tracks[2].automation.volume.points.at(-1).value,0);assert.equal(p.returns[0].name,'Room');assert.equal(p.tracks[2].sends[p.returns[0].id].amount,.18);
});
test('actual 32-bar SMF delivery preserves independently expanded note starts/pitches/durations, and the break range excludes absent voices',async()=>{
 const {project:p}= (await source()).coreSongProject(),{prepareMidiDelivery}=await import('../web-studio/midi-delivery.js'),{inspectMidi}=await import('../web-studio/midi-file.js');
 const actual=prepareMidiDelivery(p,{source:'arrangement',applyEffects:false}),inspection=inspectMidi(actual.data);assert.equal(actual.delivery.noteCount,224);assert.equal(actual.delivery.noteTracks,3);assert.equal(actual.delivery.durationTicks/actual.delivery.ticksPerBeat,128);assert.equal(inspection.tempo,120);
 const row=n=>[n.pitch,Math.round(n.start*960),Math.round(n.duration*960),Math.round(n.velocity*127)].join(':');
 for(const track of p.tracks.slice(1)){
  const expected=[];for(const region of p.arrangement.filter(r=>r.trackId===track.id)){const clip=p.clips[region.clipId];for(let loop=0;loop<region.length;loop+=16)for(const n of clip.notes)expected.push(row({...n,start:region.start+loop+n.start}));}
  const group=inspection.groups.find(g=>g.name.startsWith(track.name+' ·'));assert.ok(group,track.name);assert.deepEqual(group.notes.map(row).sort(),expected.sort());
 }
 const excerpt=prepareMidiDelivery(p,{source:'arrangement',range:{start:48,length:16},applyEffects:false}),breakNotes=inspectMidi(excerpt.data);assert.equal(excerpt.delivery.noteTracks,1);assert.equal(excerpt.delivery.noteCount,12);assert.match(breakNotes.groups[0].name,/Keys/);assert.equal(breakNotes.groups[0].notes[0].start,.25);
});
