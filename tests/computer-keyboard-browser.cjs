const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);
 await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
 const press=id=>page.evaluate(id=>document.getElementById(id).onclick(),id);
 const save=async()=>{const pending=page.waitForEvent('download');await press('save');return JSON.parse(fs.readFileSync(await(await pending).path(),'utf8'));};
 await press('new-set');const original=await save(),track=original.tracks.find(t=>t.instrument?.type!=='drums');
 assert.ok(track);
 await page.evaluate(async id=>{
  const {LiveNotes}=await import('/input.js'),on=LiveNotes.prototype.on,off=LiveNotes.prototype.off;
  window.keyboardEvents=[];LiveNotes.prototype.on=function(...args){window.keyboardEvents.push({type:'on',key:args[0],pitch:args[1],velocity:args[2]});return on.apply(this,args);};
  LiveNotes.prototype.off=function(...args){window.keyboardEvents.push({type:'off',key:args[0]});return off.apply(this,args);};
  const q=id=>document.getElementById(id);q('input-kind').value='midi';q('input-kind').onchange();q('input-track').value=id;await q('input-track').onchange();q('input-count-in').value='0';
 },track.id);
 await press('input-connect');assert.match(await page.locator('#computer-keyboard-state').textContent(),/C4–C5/);
 await press('input-record');await page.waitForTimeout(150);
 const key=async(code,type='keydown',extra={})=>page.evaluate(({code,type,extra})=>{document.activeElement?.blur();document.body.dispatchEvent(new KeyboardEvent(type,{code,key:code.slice(3).toLowerCase(),bubbles:true,cancelable:true,...extra}));},{code,type,extra});
 await key('KeyA');await page.waitForTimeout(90);await key('KeyX');await key('KeyA','keyup');
 await key('KeyC');await key('KeyA');await page.waitForTimeout(90);await key('KeyA','keyup');
 assert.match(await page.locator('#computer-keyboard-state').textContent(),/C5–C6 · Velocity 80/);
 // Real editable fields must keep the keystrokes, including range-control keys.
 const count=await page.evaluate(()=>window.keyboardEvents.filter(e=>e.type==='on').length);
 await page.evaluate(()=>{const el=document.querySelector('#project-name');el.focus();for(const code of ['KeyA','KeyX'])el.dispatchEvent(new KeyboardEvent('keydown',{code,key:'a',bubbles:true,cancelable:true}));});
 await key('KeyA','keydown',{isComposing:true});await key('KeyX','keydown',{isComposing:true});
 await page.evaluate(()=>{document.activeElement?.blur();document.body.addEventListener('keydown',e=>e.preventDefault(),{once:true});document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',bubbles:true,cancelable:true}));});
 assert.equal(await page.evaluate(()=>window.keyboardEvents.filter(e=>e.type==='on').length),count);
 assert.match(await page.locator('#computer-keyboard-state').textContent(),/C5–C6 · Velocity 80/);
 await press('input-finish');const result=await save(),clip=Object.values(result.clips)[0];
 assert.equal(clip.notes.length,2);assert.deepEqual(clip.notes.map(n=>n.pitch),[60,72]);
 assert.ok(Math.abs(clip.notes[0].velocity-.75)<.001);assert.ok(Math.abs(clip.notes[1].velocity-80/127)<.001);
 assert.ok(clip.notes.every(n=>n.duration>0&&n.duration<1));await press('undo');assert.deepEqual(await save(),original);
 // Undo replaces the engine and disconnects inputs; preferences remain tab-local.
 await press('input-connect');
 // Visible controls use the same performance state as the key shortcuts.
 await page.evaluate(()=>document.querySelector('[data-keyboard-control="octave-down"]').click());
 await page.evaluate(()=>document.querySelector('[data-keyboard-control="velocity-up"]').click());
 assert.match(await page.locator('#computer-keyboard-state').textContent(),/C4–C5 · Velocity 100/);
 await press('input-disconnect');assert.equal(await page.locator('[data-keyboard-control="octave-up"]').isDisabled(),true);
 assert.deepEqual(errors,[]);
 const proof={status:'passed',pitches:clip.notes.map(n=>n.pitch),velocities:clip.notes.map(n=>n.velocity),durations:clip.notes.map(n=>n.duration),heldNoteReleasedAfterOctaveChange:true,typingAndCompositionIgnored:true,controlsMatchShortcuts:true,undoExact:true,errors,scope:'Isolated Chromium actual computer-keyboard MIDI capture, UI controls, project download and Undo. No hardware MIDI, microphone or subjective audio quality claim.'};
 fs.writeFileSync('tests/fixtures/computer-keyboard-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
