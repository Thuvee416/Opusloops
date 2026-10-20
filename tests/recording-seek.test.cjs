const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8');
test('seeking cannot move the clock or finalize any active recording mode',async()=>{
 const {Engine}=await import('../web-studio/audio.js'),{emptyProject}=await import('../web-studio/model.js');
 for(const stage of ['recording','automationTake','inputOverdub','inputArrangement']){
  const e=new Engine(emptyProject(),()=>{});e[stage]=stage==='recording'?true:{id:'take'};e.position=3;e.insertMarker=2;e.playing=true;
  e.play=async()=>{e.playing=true;};let halted=0;e.pause=()=>{halted++;e.playing=false;};e.beat=()=>3;
  await assert.rejects(()=>e.seek(12),/Finish recording/);
  assert.equal(halted,0);assert.equal(e.position,3);assert.equal(e.insertMarker,2);assert.equal(e.playing,true);assert.ok(e[stage]);
 }
});
test('ruler navigation preserves selection and never seeks during standalone input or busy operations',async()=>{
 const start=source.indexOf("$('timeline').addEventListener('click',run(async e=>");
 const handler=source.slice(start,source.indexOf('\n',start));
 for(const lock of ['input','busy']){
  let callback,seeks=0,clears=0;const ctx={busy:lock==='busy',inputActive:()=>lock==='input',engine:{seek:async()=>{seeks++;}},suppressRegionClick:false,timeSelection:{clear(){clears++;}},run:fn=>fn,$:()=>({addEventListener:(_,fn)=>callback=fn}),setStatus(){}};
  vm.createContext(ctx);
  const helperStart=source.indexOf('async function seekStudio(');
  if(helperStart>=0)vm.runInContext(source.slice(helperStart,source.indexOf('\n',helperStart)),ctx);
  vm.runInContext(handler,ctx);
  await assert.rejects(()=>callback({target:{closest:selector=>selector==='[data-seek]'?{dataset:{seek:'12'}}:null}}),/Finish.*[Ss]eeking/);
  assert.equal(seeks,0);assert.equal(clears,0);
 }
});
test('shared Studio seek admits ordinary navigation with exact options and rejects capture before dispatch',async()=>{
 const start=source.indexOf('async function seekStudio('),helper=source.slice(start,source.indexOf('\n',start)),calls=[];
 const ctx={busy:false,inputActive:()=>false,engine:{seek:async(...args)=>{calls.push(args);return {position:args[0]};}}};vm.createContext(ctx);vm.runInContext(helper,ctx);
 const options={snap:false,moveMarker:false};assert.equal((await ctx.seekStudio(3.125,options)).position,3.125);assert.deepEqual(calls,[[3.125,options]]);
 for(const stage of ['recording','automationTake']){ctx.engine[stage]=true;await assert.rejects(()=>ctx.seekStudio(12),/Before Seeking/);ctx.engine[stage]=false;}
 assert.equal(calls.length,1);
});
