const {test}=require('node:test'),assert=require('node:assert/strict');
const api=()=>import('../web-studio/project-save.js'),file={name:'Song.opusloop',data:'{"name":"Song"}'};
test('Save waits for durable browser storage before delivering a downloadable project',async()=>{
 const {saveProjectDownload}=await api();let finish,downloaded=false,durable=false;const pending=saveProjectDownload(file,{persist:()=>new Promise(r=>finish=()=>{durable=true;r();}),isCurrent:()=>durable,download:(data,name,type)=>{assert.equal(durable,true);assert.equal(data,file.data);assert.equal(name,file.name);assert.equal(type,'application/json');downloaded=true;}});assert.equal(downloaded,false);finish();assert.deepEqual(await pending,{download:file.name,localSaved:true});assert.equal(downloaded,true);
});
test('quota, recovery and conflict failures still deliver the portable project without claiming a browser save',async()=>{
 const {saveProjectDownload}=await api();for(const message of ['QuotaExceededError','Recovery Required','Saved In Another Tab']){let count=0;const result=await saveProjectDownload(file,{persist:async()=>{throw Error(message);},isCurrent:()=>assert.fail('failed write is not durable'),download:()=>count++});assert.equal(result.localSaved,false);assert.equal(result.localSaveError,message);assert.equal(count,1);}
});
test('intervening edits retain the requested snapshot and do not claim it is the current browser set',async()=>{
 const {saveProjectDownload}=await api();let delivered;const result=await saveProjectDownload(file,{persist:async()=>{},isCurrent:()=>false,download:data=>delivered=data});assert.equal(delivered,file.data);assert.equal(result.localSaved,false);assert.equal(result.localSaveError,undefined);
});
test('download failure is reported after persistence instead of returning a success receipt',async()=>{
 const {saveProjectDownload}=await api();let saved=false;await assert.rejects(saveProjectDownload(file,{persist:async()=>saved=true,isCurrent:()=>saved,download:()=>{throw Error('Download Failed');}}),/Download Failed/);assert.equal(saved,true);
});
test('cancellation before or during browser persistence suppresses the subsequent file download',async()=>{
 const {saveProjectDownload}=await api();for(const early of [true,false]){const c=new AbortController();let writes=0,downloads=0;if(early)c.abort();await assert.rejects(saveProjectDownload(file,{signal:c.signal,persist:async()=>{writes++;c.abort();},isCurrent:()=>true,download:()=>downloads++}),{name:'AbortError'});assert.equal(writes,early?0:1);assert.equal(downloads,0);}
});
test('the shared manual and Odesa Save adapter reports local durability and preserves recovery downloads',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../web-studio/app.js'),'utf8'),{projectSaveFile,saveProjectDownload}=await api(),{emptyProject}=await import('../web-studio/model.js');
 for(const failure of [false,true]){const project=emptyProject(),calls=[],ctx={x:{name:'save_project'},project,engine:{},busy:false,inputActive:()=>false,projectSaveFile,saveProjectDownload,signal:undefined,autosave:{dirty:false},persist:async()=>{calls.push('persist');if(failure)throw Error('Quota Exceeded');},download:()=>calls.push('download'),setStatus:(message,error)=>calls.push({message,error})};vm.createContext(ctx);const start=source.indexOf(" if(x.name==='save_project'){");vm.runInContext('async function save(){'+source.slice(start,source.indexOf(" if(x.name==='export_midi')",start))+'}',ctx);const result=await ctx.save();assert.equal(result.localSaved,!failure);assert.deepEqual(calls.slice(0,2),['persist','download']);assert.equal(calls[2].error,failure);assert.match(calls[2].message,failure?/Browser Save Failed/:/Saved In This Browser/);for(const locked of ['busy','recording','automationTake']){if(locked==='busy')ctx.busy=true;else ctx.engine[locked]=true;await assert.rejects(ctx.save(),/Finish Recording/);ctx.busy=false;ctx.engine={};}}
});
