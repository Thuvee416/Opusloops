const {test}=require('node:test'),assert=require('node:assert/strict');
async function setup(){return {...await import('../web-studio/project-save.js'),...await import('../web-studio/model.js'),...await import('../web-studio/history.js'),...await import('../web-studio/recent-sets.js'),...await import('../web-studio/project-lifecycle.js'),...await import('./fixtures/core-song-project.mjs')};}
test('Save As keeps a durable previous set and recent entry before adopting its name, preserving edit history',async()=>{
 const t=await setup(),{project}=t.coreSongProject(),original=structuredClone(project),h=new t.History(project),store=new Map(),order=[],file=t.projectSaveFile(project,'Night Tide Mix Two');let download;
 const result=await t.saveProjectVariant(file,'as',{write:async next=>{order.push('write');assert.deepEqual(project,original);let n=0;const recent=t.prepareRecentSwitch({index:null,current:project,createId:()=>`set-${++n}`});for(const [key,value]of [['previous',original],['current',next],...recent.writes])store.set(key,structuredClone(value));},commit:next=>{order.push('commit');assert.equal(store.get('current').name,next.name);project.name=next.name;h.commit(project);},download:(data,name,type)=>{order.push('download');download={data,name,type};}});
 assert.deepEqual(order,['write','commit','download']);assert.equal(result.projectName,'Night Tide Mix Two');assert.deepEqual(store.get('previous'),original);assert.equal(store.get(t.RECENT_INDEX).entries[0].name,original.name);
 const saved=JSON.parse(download.data);assert.deepEqual(saved,{...original,name:'Night Tide Mix Two'});assert.equal(download.name,'Night-Tide-Mix-Two.opusloop');assert.equal(download.type,'application/json');assert.deepEqual(h.undo(),original);assert.deepEqual(h.redo(),saved);
 assert.deepEqual(await t.readProjectFile({size:Buffer.byteLength(download.data),text:async()=>download.data},t.validateProject),saved);
});
test('Save A Copy preserves working project, backup and history while naming the complete downloaded snapshot',async()=>{
 const t=await setup(),{project}=t.coreSongProject(),before=structuredClone(project),h=new t.History(project),file=t.projectSaveFile(project,'Separate Copy');let data;
 await t.saveProjectVariant(file,'copy',{write:()=>assert.fail('must not write'),commit:()=>assert.fail('must not commit'),download:bytes=>data=bytes});assert.deepEqual(project,before);assert.equal(h.past.length,0);assert.deepEqual(JSON.parse(data),{...before,name:'Separate Copy'});
 file.project.clips.bass.notes[0].pitch=12;assert.deepEqual(project,before,'prepared snapshots do not alias source notes');
});
test('failed storage cannot rename or download; post-save download failure identifies the locally saved result',async()=>{
 const t=await setup(),p=t.emptyProject(),before=structuredClone(p),file=t.projectSaveFile(p,'New Version');let commits=0,downloads=0;
 await assert.rejects(()=>t.saveProjectVariant(file,'as',{write:async()=>{throw Error('Quota Exceeded');},commit:()=>commits++,download:()=>downloads++}),/Quota Exceeded/);assert.equal(commits,0);assert.equal(downloads,0);assert.deepEqual(p,before);
 await assert.rejects(()=>t.saveProjectVariant(file,'as',{write:async()=>{},commit:next=>{p.name=next.name;commits++;},download:()=>{throw Error('Download Failed');}}),/Saved In This Browser/);assert.equal(p.name,'New Version');assert.equal(commits,1);
});
test('project names and filenames are bounded; ordinary Save preserves legacy whitespace names exactly',async()=>{
 const t=await setup(),p=t.emptyProject();for(const name of ['', '  ', 'x'.repeat(121),null,3])assert.throws(()=>t.projectSaveFile(p,name));
 assert.equal(t.projectSaveName('CON'),'_CON.opusloop');assert.equal(t.projectSaveName('../Mix:Two'),'---Mix-Two.opusloop');assert.equal(t.projectSaveName('🎹'),'session.opusloop');assert.ok(t.projectSaveName('x'.repeat(120)).length<=79);
 for(const name of ['','  Legacy Name  ']){p.name=name;const file=t.projectSaveFile(p);assert.equal(JSON.parse(file.data).name,name);assert.equal(p.name,name);}
 const invalid={...p,arrangement:[{id:'bad'}]};assert.throws(()=>t.projectSaveFile(invalid,'Snapshot'));
});
test('Save shortcuts route distinctly and respect editor, modal, menu and repeat guards',async()=>{
 const {studioShortcut}=await import('../web-studio/studio-shortcuts.js');
 for(const modifier of ['metaKey','ctrlKey']){const e={code:'KeyS',[modifier]:true};assert.equal(studioShortcut(e),'save');assert.equal(studioShortcut({...e,shiftKey:true}),'save-as');assert.equal(studioShortcut({...e,altKey:true}),null);for(const state of ['typing','dialog','menu','agent'])assert.equal(studioShortcut(e,{[state]:true}),null);assert.equal(studioShortcut({...e,repeat:true}),null);}
});

test('actual named-save entry rejects a changed project or history before storage and download',async()=>{
 const t=await setup(),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../web-studio/app.js'),'utf8'),start=source.indexOf('const openProjectSave=installProjectSaveDialog('),end=source.indexOf("\nfor(const [id,mode]",start);
 for(const mode of ['owner','revision']){
  const project=t.emptyProject(),ctx={project,sessionProjectRevision:4,projectSaveName:t.projectSaveName,projectSaveFile:t.projectSaveFile,saveProjectVariant:t.saveProjectVariant,installProjectSaveDialog:options=>{ctx.options=options;return ()=>{};},clipPropertiesLocked:()=>false,withSetLock:fn=>fn(),readSet:()=>assert.fail('must not read storage'),writeSets:()=>assert.fail('must not write'),download:()=>assert.fail('must not download'),setStatus:()=>{}};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);const binding=ctx.options.bind();if(mode==='owner')ctx.project=structuredClone(project);else ctx.sessionProjectRevision++;
  await assert.rejects(()=>ctx.options.execute('as','Later Version',binding),/Project Changed/);assert.deepEqual(ctx.project,project);
 }
});
