const {test}=require('node:test'),assert=require('node:assert/strict');
const api=()=>import('../web-studio/mixer-values.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
test('manual mixer levels use dB consistently with the existing natural-language gain contract',async()=>{
 const {parseMixerValue,mixerValueText}=await api(),{musicalGain}=await import('../web-studio/musical-units.js');
 for(const db of [0,-.1,-3,-6,-12.345,-60,-96,-300])near(parseMixerValue('volume',String(db)+' dB'),musicalGain(1,{db}));
 assert.equal(mixerValueText('volume',0),'−∞');assert.equal(mixerValueText('volume',1),'0 dB');assert.equal(mixerValueText('volume',.5),'-6.02 dB');
 for(const value of ['-inf','−∞','silence','-infinity dB'])assert.equal(parseMixerValue('volume',value),0);
 for(const value of ['', 'NaN', 'Infinity', '1', '5 db','-6001','-3 please','0x10','1e-2'])assert.throws(()=>parseMixerValue('volume',value));
});
test('precise pan parsing retains direction and rejects ambiguous or out-of-range edits',async()=>{
 const {parseMixerValue,mixerValueText}=await api();for(const [value,expected]of [['C',0],['center',0],['-25',-.25],['25L',-.25],['25.125R',.25125],['100 L',-1],['+100',1]])near(parseMixerValue('pan',value),expected);
 assert.equal(mixerValueText('pan',-.25125),'25.12L');assert.equal(mixerValueText('pan',0),'C');
 for(const value of ['-25L','101','100.01R','', '25%', 'Left','NaN'])assert.throws(()=>parseMixerValue('pan',value));
});
test('keyboard fader steps operate in dB with fine adjustment, finite silence and bounded pan',async()=>{
 const {nudgeMixerValue}=await api();near(nudgeMixerValue('volume',.5,1),.5*10**(1/20));near(nudgeMixerValue('volume',.5,-1,{fine:true}),.5*10**(-.1/20));near(nudgeMixerValue('volume',.5,-1,{large:true}),.5*10**(-6/20));
 near(nudgeMixerValue('volume',1e-6,1),10**(-119/20));assert.equal(nudgeMixerValue('volume',1,1),1);assert.equal(nudgeMixerValue('volume',0,-1),0);near(nudgeMixerValue('volume',0,1),.001);assert.equal(nudgeMixerValue('volume',10**(-96/20),-1),0);
 near(nudgeMixerValue('pan',.25,-1,{fine:true}),.249);assert.equal(nudgeMixerValue('pan',1,1),1);assert.equal(nudgeMixerValue('pan',-1,-1),-1);
});
function harness(kind='volume',initial=.56789123){
 const listeners=new Map(),events=[],errors=[],owner={activeElement:null};let locked=false,current;
 const host={addEventListener(type,fn,capture=false){const list=listeners.get(type)||[];list.push({fn,capture});listeners.set(type,list);},querySelectorAll(){return [current.slider];},emit(type,target,extra={}){let stopped=false;const event={type,target,...extra,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){stopped=true;}};for(const item of [...listeners.get(type)||[]].sort((a,b)=>Number(b.capture)-Number(a.capture))){item.fn(event);if(stopped)break;}return event;}};
 function pair(value){const field={dataset:{mixValue:kind},value:'',matches:s=>s==='[data-mix-value]',select(){},blur(){owner.activeElement=null;},dispatchEvent:e=>host.emit(e.type,field)},slider={dataset:{mixRange:kind},value:String(value),matches:s=>s==='[data-mix-range]',disabled:false,isConnected:true,ownerDocument:owner,setAttribute(){},focus(){owner.activeElement=slider;},dispatchEvent:e=>host.emit(e.type,slider)};const parent={querySelector:s=>s==='[data-mix-range]'?slider:field};field.parentElement=parent;slider.parentElement=parent;return {field,slider};}
 current=pair(initial);return {host,events,errors,owner,get current(){return current;},locked:()=>locked,setLocked:v=>locked=v,pair,replace(value){current.slider.isConnected=false;current=pair(value);}};
}
test('inline values commit through existing input/change paths, preserving untouched precision and rejecting invalid edits',async()=>{
 const {installMixerValueEditors,mixerValueText}=await api(),h=harness();installMixerValueEditors(h.host,{locked:h.locked,error:message=>h.errors.push(message)});h.host.addEventListener('input',e=>h.events.push(['input',Number(e.target.value)]));h.host.addEventListener('change',e=>h.events.push(['change',Number(e.target.value)]));
 const {field,slider}=h.current;field.value=mixerValueText('volume',Number(slider.value));h.host.emit('focusin',field);h.host.emit('change',field);assert.equal(slider.value,'.56789123'.replace(/^\./,'0.'));assert.deepEqual(h.events,[]);
 field.value='-3';h.host.emit('input',field);assert.deepEqual(h.events,[]);h.host.emit('change',field);near(Number(slider.value),10**(-3/20));assert.deepEqual(h.events.map(e=>e[0]),['input','change']);
 const saved=slider.value;field.value='6';h.host.emit('change',field);assert.equal(slider.value,saved);assert.equal(h.errors.length,1);assert.equal(field.value,mixerValueText('volume',Number(saved)));
 h.setLocked(true);field.value='-12';h.host.emit('change',field);assert.equal(slider.value,saved);assert.equal(h.events.length,2);assert.equal(h.errors.length,2);
});
test('Escape cancels text edits; Enter commits once; reset and keyboard nudges retain focus after mixer rebuild',async()=>{
 const {installMixerValueEditors}=await api(),h=harness('pan',.2512345);installMixerValueEditors(h.host,{error:message=>h.errors.push(message)});h.host.addEventListener('change',e=>{h.events.push(Number(e.target.value));h.replace(Number(e.target.value));});
 let {field,slider}=h.current;h.host.emit('focusin',field);field.value='100L';h.host.emit('keydown',field,{key:'Escape'});assert.equal(Number(slider.value),.2512345);assert.deepEqual(h.events,[]);
 field.value='25L';h.host.emit('keydown',field,{key:'Enter'});assert.deepEqual(h.events,[-.25]);
 slider=h.current.slider;slider.focus();h.host.emit('keydown',slider,{key:'ArrowRight',shiftKey:true});near(Number(h.current.slider.value),-.249);assert.equal(h.owner.activeElement,h.current.slider);
 h.host.emit('dblclick',h.current.slider);assert.equal(Number(h.current.slider.value),0);assert.deepEqual(h.errors,[]);
});
test('an exact mixer commit preserves embedded song content through project validation and one Undo/Redo',async()=>{
 const {installMixerValueEditors}=await api(),{coreSongProject}=await import('./fixtures/core-song-project.mjs'),{History}=await import('../web-studio/history.js'),{validateProject}=await import('../web-studio/model.js');
 const project=coreSongProject().project,before=JSON.stringify(project),history=new History(project),h=harness('volume',project.tracks[0].volume);
 installMixerValueEditors(h.host);h.host.addEventListener('input',e=>{project.tracks[0].volume=Number(e.target.value);});h.host.addEventListener('change',()=>history.commit(project));
 h.host.emit('focusin',h.current.field);h.current.field.value='-32.125';h.host.emit('change',h.current.field);const expected=JSON.parse(before);expected.tracks[0].volume=10**(-32.125/20);assert.deepEqual(project,expected);
 const saved=JSON.parse(JSON.stringify(project));validateProject(saved);assert.deepEqual(saved,expected);assert.equal(JSON.stringify(history.undo()),before);assert.deepEqual(history.redo(),expected);
});
test('automation readouts follow the fader without replacing text the user is currently entering',async()=>{
 const {syncMixerReadout,mixerValueText}=await api(),h=harness(),{field,slider}=h.current;syncMixerReadout(slider);assert.equal(field.value,mixerValueText('volume',Number(slider.value)));
 h.owner.activeElement=field;field.value='-12.';slider.value='.25';syncMixerReadout(slider);assert.equal(field.value,'-12.');h.owner.activeElement=null;syncMixerReadout(slider);assert.equal(field.value,'-12.04 dB');
});
