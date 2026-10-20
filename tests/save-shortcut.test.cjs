const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {saveFromShortcut}=await import('../web-studio/save-shortcut.js'),calls=[],controls={},state={name:'Before',errors:0};
 const field={id:'name',value:'After',checked:false,selectionStart:2,selectionEnd:4,selectionDirection:'forward',isConnected:true,disabled:false,closest:selector=>selector==='#studio-agent'?null:field,checkValidity:()=>true,reportValidity:()=>calls.push('invalid'),blur:()=>{state.name=field.value;calls.push('commit');},focus:()=>calls.push('focus'),setSelectionRange:(...range)=>calls.push(range)};
 controls.name=field;controls.save={disabled:false,click:()=>calls.push({saved:state.name})};controls['save-as']={disabled:false,click:()=>calls.push({dialogName:state.name})};
 const options={document:{activeElement:field,getElementById:id=>controls[id]},getErrorRevision:()=>state.errors,setStatus:(message,error)=>calls.push({message,error})};return {saveFromShortcut,field,calls,controls,state,options};
}
test('Save crosses the field change boundary before snapshot and restores field selection',async()=>{
 for(const command of ['save','save-as']){const f=await fixture();assert.equal(await f.saveFromShortcut(command,f.options),true);assert.deepEqual(f.calls,['commit','focus',[2,4,'forward'],command==='save'?{saved:'After'}:{dialogName:'After'}]);}
});
test('invalid native fields and newly reported field errors prevent save; unchanged retries stay blocked',async()=>{
 const f=await fixture();f.field.checkValidity=()=>false;assert.equal(await f.saveFromShortcut('save',f.options),false);assert.equal(f.state.name,'Before');assert.equal(f.calls[0],'invalid');
 f.field.checkValidity=()=>true;f.field.blur=()=>{f.state.errors++;};assert.equal(await f.saveFromShortcut('save',f.options),false);assert.equal(await f.saveFromShortcut('save',f.options),false);assert.equal(f.state.errors,1);assert.ok(!f.calls.some(c=>c.saved));
 f.field.value='Corrected';f.field.blur=()=>f.state.name=f.field.value;assert.equal(await f.saveFromShortcut('save',f.options),true);assert.deepEqual(f.calls.at(-1),{saved:'Corrected'});
});
test('busy operations block before commit or after a field starts work, and Odesa drafts are not committed',async()=>{
 const f=await fixture();f.controls.save.disabled=true;assert.equal(await f.saveFromShortcut('save-as',f.options),false);assert.equal(f.state.name,'Before');
 f.controls.save.disabled=false;f.field.blur=()=>{f.controls.save.disabled=true;};assert.equal(await f.saveFromShortcut('save',f.options),false);assert.ok(!f.calls.some(c=>c.saved));
 const g=await fixture();g.field.closest=selector=>selector==='#studio-agent'?{}:g.field;g.field.blur=()=>assert.fail('Do not commit the agent draft');g.field.checkValidity=()=>assert.fail('Do not validate the agent form');assert.equal(await g.saveFromShortcut('save',g.options),true);assert.deepEqual(g.calls,[{saved:'Before'}]);
});
