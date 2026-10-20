const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {NotePreview}=await import('../web-studio/note-preview.js'),events=[],gates=[],timers=new Map();let serial=0,valid=true;
 class Notes{on(...a){events.push(['on',...a]);}off(...a){events.push(['off',...a]);}allOff(){events.push(['stop']);}}
 const preview=new NotePreview({Notes,setTimer:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimer:id=>timers.delete(id)}),engine={prepareSamples:()=>new Promise((resolve,reject)=>gates.push({resolve,reject}))};
 const notes=[{pitch:60,velocity:.7,releaseVelocity:.2},{pitch:64,velocity:.8,active:false},{pitch:67,velocity:0}];
 return {preview,engine,notes,events,gates,timers,current:()=>valid,invalidate:()=>valid=false};
}
test('preview uses active pitches and velocities, releases briefly and force-cleans one-shots',async()=>{
 const f=await fixture(),before=structuredClone(f.notes),p=f.preview.play(f.engine,'track',f.notes,f.current);f.gates[0].resolve();assert.equal(await p,true);
 assert.deepEqual(f.events,[['on','note-preview:0',60,.7,'track']]);assert.deepEqual(f.notes,before);
 [...f.timers.values()].find(t=>t.ms===250).fn();assert.deepEqual(f.events[1],['off','note-preview:0',.2]);[...f.timers.values()].find(t=>t.ms===1250).fn();assert.equal(f.events.at(-1)[0],'stop');assert.equal(f.timers.size,0);
});
test('latest click owns preview and cancelled or stale loads never sound',async()=>{
 const f=await fixture(),old=f.preview.play(f.engine,'old',f.notes,f.current),next=f.preview.play(f.engine,'new',f.notes,f.current);f.gates[1].resolve();await next;f.gates[0].resolve();assert.equal(await old,false);assert.equal(f.events.filter(e=>e[0]==='on').length,1);assert.equal(f.events[0].at(-1),'new');
 f.invalidate();f.preview.check();assert.equal(f.events.at(-1)[0],'stop');assert.equal(f.preview.player,null);
 const g=await fixture(),pending=g.preview.play(g.engine,'track',g.notes,g.current);g.preview.cancel();g.gates[0].resolve();assert.equal(await pending,false);assert.deepEqual(g.events,[]);
});
test('cancelled decode failures stay quiet; current failures reject and allow retry',async()=>{
 const f=await fixture(),old=f.preview.play(f.engine,'track',f.notes,f.current);f.preview.cancel();f.gates[0].reject(Error('Old'));assert.equal(await old,false);
 const next=f.preview.play(f.engine,'track',f.notes,f.current),rejected=assert.rejects(next,/Decode/);f.gates[1].reject(Error('Decode'));await rejected;assert.equal(f.preview.current,null);
 const retry=f.preview.play(f.engine,'track',f.notes,f.current);f.gates[2].resolve();assert.equal(await retry,true);f.preview.cancel();
});
test('inactive/zero-velocity notes do not initialize audio and large selections stay bounded',async()=>{
 const f=await fixture();assert.equal(await f.preview.play(f.engine,'track',f.notes.slice(1),f.current),false);assert.equal(f.gates.length,0);
 const p=f.preview.play(f.engine,'track',Array(32).fill(f.notes[0]),f.current);f.gates[0].resolve();await p;assert.equal(f.events.filter(e=>e[0]==='on').length,16);f.preview.cancel();
});

test('timer scheduling failure releases a started voice instead of leaving it sounding',async()=>{
 const f=await fixture();f.preview.setTimer=()=>{throw Error('Timer Failed');};const pending=f.preview.play(f.engine,'track',f.notes,f.current),rejected=assert.rejects(pending,/Timer Failed/);f.gates[0].resolve();await rejected;assert.deepEqual(f.events.map(e=>e[0]),['on','stop']);assert.equal(f.preview.player,null);
});
