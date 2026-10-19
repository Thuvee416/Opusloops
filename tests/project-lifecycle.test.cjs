const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=()=>import('../web-studio/project-lifecycle.js');
const validate=p=>{if(!p||typeof p.name!=='string'||!p.media)throw new Error('Invalid project');return p;};
const original=()=>({name:'Unsaved performance',media:{take:'embedded-audio'},notes:[{pitch:60,start:0}],volume:.7});
const incoming=()=>({name:'Downloaded song',media:{take:'different-audio'},notes:[{pitch:67,start:4}],volume:.4});

test('opening commits the complete displaced project and incoming set together before installation',async()=>{
 const {readProjectFile,replaceStoredProject}=await api(),current=original(),source=incoming(),before=structuredClone(current),store=new Map(),order=[];
 const next=await readProjectFile({size:100,text:async()=>JSON.stringify(source)},validate);
 const installed=await replaceStoredProject({current,next,validate,write:async entries=>{
  order.push('write');assert.deepEqual(current,before);assert.deepEqual(entries.map(([key])=>key),['previous','current']);
  for(const [key,value] of entries)store.set(key,structuredClone(value));
 },install:p=>{order.push('install');assert.deepEqual(store.get('current'),p);assert.deepEqual(store.get('previous'),before);}});
 assert.deepEqual(order,['write','install']);assert.deepEqual(installed,source);
 installed.notes[0].pitch=72;current.media.take='later edit';
 assert.deepEqual(store.get('previous'),before);assert.deepEqual(store.get('current'),source);assert.deepEqual(next,source);
});

test('storage failure prevents installation and retains the prior current and recovery sets',async()=>{
 const {replaceStoredProject}=await api(),current=original(),store=new Map([['current',structuredClone(current)],['previous',{name:'Earlier backup'}]]),before=structuredClone(store);let installed=false;
 await assert.rejects(()=>replaceStoredProject({current,next:incoming(),validate,write:async()=>{throw Error('Quota exceeded');},install:()=>{installed=true;}}),/Quota exceeded/);
 assert.equal(installed,false);assert.deepEqual(store,before);assert.deepEqual(current,original());
});

test('invalid incoming content never reaches the storage or installation boundary',async()=>{
 const {readProjectFile,replaceStoredProject}=await api();let writes=0,installs=0;
 await assert.rejects(()=>readProjectFile({size:10,text:async()=>'{broken'},validate),SyntaxError);
 await assert.rejects(()=>readProjectFile({size:10,text:async()=>'{"name":"Incomplete"}'},validate),/Invalid project/);
 await assert.rejects(()=>replaceStoredProject({current:original(),next:{name:'Incomplete'},validate,write:async()=>writes++,install:()=>installs++}),/Invalid project/);
 assert.equal(writes,0);assert.equal(installs,0);
});

test('cancelled selection does nothing; oversized and unreadable files fail before replacement',async()=>{
 const {readProjectFile}=await api();assert.equal(await readProjectFile(undefined,validate),null);let reads=0;
 await assert.rejects(()=>readProjectFile({size:150*1024*1024+1,text:async()=>{reads++;return '{}';}},validate),/150 MB/);assert.equal(reads,0);
 await assert.rejects(()=>readProjectFile({size:10,text:async()=>{throw Error('Read failed');}},validate),/Read failed/);
});

test('restoring the previous set swaps whole projects without losing embedded media or notes',async()=>{
 const {replaceStoredProject}=await api(),store=new Map();let current=original();const originalBytes=JSON.stringify(current),newBytes=JSON.stringify(incoming());
 const replace=next=>replaceStoredProject({current,next,validate,write:async rows=>rows.forEach(([key,value])=>store.set(key,structuredClone(value))),install:p=>{current=p;}});
 await replace(incoming());assert.equal(JSON.stringify(current),newBytes);
 await replace(store.get('previous'));assert.equal(JSON.stringify(current),originalBytes);assert.equal(JSON.stringify(store.get('previous')),newBytes);
});

test('a real embedded-audio/MIDI project survives opening, restore and another portable save',async()=>{
 const {readProjectFile,replaceStoredProject}=await api(),{validateProject,emptyProject}=await import('../web-studio/model.js'),{coreSongProject}=await import('./fixtures/core-song-project.mjs');
 const {project:song,media}=coreSongProject(),bytes=JSON.stringify(song),store=new Map();let current=emptyProject();
 current.name='Displaced empty set';const displaced=JSON.stringify(current);
 const replace=next=>replaceStoredProject({current,next,validate:validateProject,write:async rows=>rows.forEach(([key,value])=>store.set(key,structuredClone(value))),install:p=>{current=p;}});
 await replace(await readProjectFile({size:Buffer.byteLength(bytes),text:async()=>bytes},validateProject));
 assert.equal(JSON.stringify(current),bytes);assert.equal(JSON.stringify(store.get('previous')),displaced);
 assert.equal(Buffer.compare(Buffer.from(current.clips.drums.data,'base64'),media.drums),0);
 assert.equal(current.arrangement.length,25);assert.equal(current.tracks.length,4);
 await replace(store.get('previous'));assert.equal(JSON.stringify(current),displaced);
 await replace(store.get('previous'));assert.equal(JSON.stringify(current),bytes);
 const invalid=structuredClone(song);invalid.arrangement[0].clipId='missing-audio';const before=JSON.stringify([...store]);
 await assert.rejects(()=>replace(invalid));assert.equal(JSON.stringify([...store]),before);assert.equal(JSON.stringify(current),bytes);
});


test('large project approval precedes reading and preserves the complete parsed set',async()=>{
 const {readProjectFile,LARGE_PROJECT_BYTES,largeProjectMessage}=await api(),{coreSongProject}=await import('./fixtures/core-song-project.mjs'),{validateProject}=await import('../web-studio/model.js');
 const {project:song}=coreSongProject(),bytes=JSON.stringify(song),order=[];
 // A file double exercises the former size gate without allocating 150 MB in each test.
 const file={size:LARGE_PROJECT_BYTES+1,text:async()=>{order.push('read');return bytes;}};
 const next=await readProjectFile(file,validateProject,{confirmLarge:async info=>{order.push('confirm');assert.equal(info.size,file.size);return true;}});
 assert.deepEqual(order,['confirm','read']);assert.equal(JSON.stringify(next),bytes);assert.match(largeProjectMessage({size:file.size}),/151 MB/);
});

test('large file decline, missing approval and abort do not read or validate content',async()=>{
 const {readProjectFile,LARGE_PROJECT_BYTES}=await api();let reads=0,validations=0;
 const file={size:LARGE_PROJECT_BYTES+1,text:async()=>{reads++;return '{}';}},validator=p=>{validations++;return p;};
 for(const value of [false,undefined,'yes'])await assert.rejects(()=>readProjectFile(file,validator,{confirmLarge:async()=>value}),{name:'AbortError'});
 const controller=new AbortController();await assert.rejects(()=>readProjectFile(file,validator,{signal:controller.signal,confirmLarge:async()=>{controller.abort();return true;}}),{name:'AbortError'});
 assert.equal(reads,0);assert.equal(validations,0);
});

test('ordinary file threshold needs no confirmation; approved large input still requires valid content',async()=>{
 const {readProjectFile,LARGE_PROJECT_BYTES}=await api();let prompts=0;
 const options={confirmLarge:async()=>{prompts++;return true;}};
 await readProjectFile({size:LARGE_PROJECT_BYTES,text:async()=>JSON.stringify(incoming())},validate,options);assert.equal(prompts,0);
 await assert.rejects(()=>readProjectFile({size:LARGE_PROJECT_BYTES+1,text:async()=>'{broken'},validate,options),SyntaxError);
 await assert.rejects(()=>readProjectFile({size:LARGE_PROJECT_BYTES+1,text:async()=>'{"name":"Invalid"}'},validate,options),/Invalid project/);
 assert.equal(prompts,2);
 for(const size of [-1,NaN,Infinity,undefined])await assert.rejects(()=>readProjectFile({size,text:()=>assert.fail('must not read')},validate,options),/Invalid Project File Size/);
});

test('aborting while file content is loading never validates or replaces a project',async()=>{
 const {readProjectFile}=await api(),controller=new AbortController();let validations=0;
 await assert.rejects(()=>readProjectFile({size:10,text:async()=>{controller.abort();return '{}';}},()=>validations++,{signal:controller.signal}),{name:'AbortError'});assert.equal(validations,0);
});
