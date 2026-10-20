const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const [{Engine},{emptyProject}]=await Promise.all([import('../web-studio/audio.js'),import('../web-studio/model.js')]);
 const engine=new Engine(emptyProject(),()=>{}),gates=[];engine.prepareSamples=()=>new Promise((resolve,reject)=>gates.push({resolve,reject}));return {engine,gates};
}
test('audio preparation stays owned until every concurrent load settles',async()=>{
 const {engine:e,gates}=await fixture();assert.equal(e.preparing,false);const first=e.prepare(),second=e.prepare({resume:false});assert.equal(e.preparing,true);assert.equal(e.preparationCount,2);
 gates[0].resolve();await first;assert.equal(e.preparing,true);assert.equal(e.preparationCount,1);gates[1].resolve();await second;assert.equal(e.preparing,false);assert.equal(e.preparationCount,0);
});
test('a failed load releases only its own preparation ownership and retry works',async()=>{
 const {engine:e,gates}=await fixture(),first=e.prepare(),second=e.prepare(),failure=assert.rejects(first,/Decode Failed/);
 gates[0].reject(Error('Decode Failed'));await failure;assert.equal(e.preparing,true);gates[1].resolve();await second;assert.equal(e.preparing,false);
 const retry=e.prepare();assert.equal(e.preparing,true);gates[2].resolve();await retry;assert.equal(e.preparing,false);
});
test('Stop cancels launch intent without prematurely releasing pending resource preparation',async()=>{
 const {engine:e,gates}=await fixture(),track=e.project.tracks[0];track.slots[0]='note';e.project.clips.note={id:'note',name:'Note',kind:'midi',beats:4,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};e.prepareClip=async()=>{};
 const launch=e.launch(track.id,'note',0);assert.equal(e.preparing,true);assert.equal(e.startPromise,undefined);e.stop();assert.equal(e.preparing,true);
 gates[0].resolve();const receipt=await launch;assert.equal(receipt.interrupted,true);assert.equal(e.preparing,false);assert.equal(e.playing,false);assert.equal(e.active.size,0);
});
test('errors after sample preparation also release ownership',async()=>{
 const {engine:e,gates}=await fixture();e.project.clips.bad={id:'bad',kind:'audio'};e.prepareClip=async()=>{throw Error('Clip Failed');};
 const pending=e.prepare(),rejected=assert.rejects(pending,/Clip Failed/);gates[0].resolve();await rejected;assert.equal(e.preparing,false);assert.equal(e.preparationCount,0);
});
