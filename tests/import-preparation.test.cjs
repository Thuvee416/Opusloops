const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../web-studio/app.js'),'utf8');
function context(){const calls=[],s={project:{},sessionProjectRevision:1,busy:false,engine:{async init(resume=true){calls.push(['init',resume]);if(resume)throw Error('Playback Permission Denied');},context:{async decodeAudioData(){calls.push(['decode']);throw Error('Decode Failed');}}},stopToEdit(){},importBinding:()=>({}),renderTransport(){},setStatus(){},assertImportCurrent(){},readAudioImport:async(file,decode)=>decode(new ArrayBuffer(1)),install:()=>assert.fail('must not replace on failure')};vm.createContext(s);return {s,calls};}
test('single audio import decodes without playback permission and clears the operation lock on decode failure',async()=>{
 const {s,calls}=context(),start=source.indexOf('async function importAudio(');vm.runInContext(source.slice(start,source.indexOf("\n$('session-grid').addEventListener('click'",start)),s);
 await assert.rejects(s.importAudio({name:'Invalid.wav'}),/Decode Failed/);assert.deepEqual(calls,[['init',false],['decode']]);assert.equal(s.busy,false);
});
test('stem import decodes without playback permission and clears its operation lock without installing a partial set',async()=>{
 const {s,calls}=context();let config;Object.assign(s,{installStemImportDialog:value=>{config=value;},stemImportLocked:()=>false,stemImportRequest(){},readStemFiles:async(files,decode)=>decode(new ArrayBuffer(1))});
 const start=source.indexOf('const openStemImport=installStemImportDialog(');vm.runInContext(source.slice(start,source.indexOf('\nconst stemImportButton=',start)),s);
 await assert.rejects(config.execute([{name:'Invalid.wav'}],0,{}, {signal:new AbortController().signal,onProgress(){}}),/Decode Failed/);assert.deepEqual(calls,[['init',false],['decode']]);assert.equal(s.busy,false);
});
