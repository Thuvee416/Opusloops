const {test}=require('node:test'),assert=require('node:assert/strict');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function context(){
 const nodes=[],analysers=[],splitters=[];
 const node=()=>{const param=()=>({value:0,setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}}),n={connections:[],gain:param(),pan:param(),connect(to,output=0){this.connections.push({to,output});},disconnect(to){this.connections=to?this.connections.filter(c=>c.to!==to):[];}};nodes.push(n);return n;};
 return {nodes,analysers,splitters,node,currentTime:0,state:'running',sampleRate:48000,destination:node(),resume:async()=>{},createGain:node,createStereoPanner:node,createDynamicsCompressor:node,createAnalyser(){const n=node();n.sample=0;n.getFloatTimeDomainData=data=>data.fill(n.sample);analysers.push(n);return n;},createChannelSplitter(count){assert.equal(count,2);const n=node();splitters.push(n);return n;}};
}
async function api(){return {...await import('../web-studio/level-meter.js'),...await import('../web-studio/routing.js'),...await import('../web-studio/model.js')};}

test('opposite-phase stereo and one-sided signals keep their actual channel levels',async()=>{
 const {channelLevels}=await api(),stereo=channelLevels([Float32Array.of(.5,-.5),Float32Array.of(-.5,.5)]);near(stereo.rms,.5);near(stereo.peak,.5);near(stereo.db,-6.020599913);assert.equal(stereo.clipping,false);
 const one=channelLevels([Float32Array.of(0,0),Float32Array.of(.25,-.25)]);near(one.rms,.25);near(one.channels[0].rms,0);near(one.channels[1].rms,.25);assert.equal(channelLevels([]).db,-Infinity);
});

test('stereo analysis uses separate taps, briefly holds full-scale warnings and disposes without disconnecting audible output',async()=>{
 const t=await api(),ctx=context(),source=ctx.node();source.connect(ctx.destination);const meter=t.createStereoMeter(ctx,source);assert.equal(ctx.splitters.length,1);assert.deepEqual(ctx.splitters[0].connections.map(c=>c.output),[0,1]);assert.equal(source.connections.length,2);
 ctx.analysers[0].sample=.5;ctx.analysers[1].sample=-.5;near(meter.read().rms,.5);ctx.analysers[1].sample=1.2;assert.equal(meter.read().clipping,true);ctx.analysers[1].sample=0;ctx.currentTime=.5;assert.equal(meter.read().clipping,true);ctx.currentTime=.8;assert.equal(meter.read().clipping,false);
 assert.ok(ctx.analysers.every(a=>a.connections.length===0));meter.dispose();meter.dispose();assert.deepEqual(source.connections,[{to:ctx.destination,output:0}]);assert.equal(ctx.splitters[0].connections.length,0);assert.equal(meter.read().peak,0);
});

test('tracks and returns meter after their channel processing while offline graphs omit analysis taps',async()=>{
 const t=await api(),p=t.emptyProject();p.tracks[0].devices=[];p.returns=[{...t.newReturn('Room'),id:'room',devices:[]}];p.tracks[0].sends={room:{amount:.4,pre:false}};
 const before=structuredClone(p),ctx=context(),master=ctx.node(),graph=t.createMixGraph(ctx,p,master);
 assert.equal(ctx.splitters.length,2);for(const strip of [...graph.tracks.values(),...graph.returns.values()]){assert.ok(strip.meter);assert.ok(strip.pan.connections.some(c=>ctx.splitters.includes(c.to)));assert.ok(strip.pan.connections.some(c=>c.to===strip.analyser));}
 graph.dispose();assert.ok(ctx.splitters.every(s=>s.connections.length===0));assert.deepEqual(p,before);
 const offline=context();offline.createChannelSplitter=()=>assert.fail('Offline render must not allocate UI meters');const rendered=t.createMixGraph(offline,p,offline.node(),{meters:false});assert.equal(rendered.tracks.get(p.tracks[0].id).meter,null);assert.equal(rendered.returns.get('room').meter,null);rendered.dispose();
});

test('Engine master meter observes post-master compression and initializes once',async t=>{
 const a=await api(),{Engine}=await import('../web-studio/audio.js'),p=a.emptyProject();p.tracks[0].devices=[];const ctx=context(),prior=global.AudioContext;global.AudioContext=function(){return ctx;};t.after(()=>{if(prior)global.AudioContext=prior;else delete global.AudioContext;});
 const engine=new Engine(p,()=>{});await engine.init();const meter=engine.masterMeter,count=ctx.splitters.length;assert.ok(engine.compressor.connections.some(c=>c.to===ctx.destination));assert.ok(engine.compressor.connections.some(c=>ctx.splitters.includes(c.to)));assert.ok(!engine.master.connections.some(c=>ctx.splitters.includes(c.to)));await engine.init();assert.equal(engine.masterMeter,meter);assert.equal(ctx.splitters.length,count);engine.mixGraph.dispose();meter.dispose();
});

function element(){const bar={style:{setProperty(k,v){this[k]=v;}}},attributes={},classes=new Map();return {bar,attributes,classes,querySelector:()=>bar,setAttribute:(k,v)=>attributes[k]=v,classList:{toggle:(k,v)=>classes.set(k,v)}};}
test('meter rendering supplies bounded dB values, silence, peak warnings and text-safe channel names',async()=>{
 const t=await api(),el=element();t.paintLevelMeter(el,t.channelLevels([Float32Array.of(.001)]),'Piano');near(parseFloat(el.bar.style.height),0);assert.equal(el.attributes['aria-valuenow'],'-60');
 t.paintLevelMeter(el,t.channelLevels([Float32Array.of(2)]),'<Track>');assert.equal(el.bar.style.height,'100%');assert.equal(el.classes.get('is-clipping'),true);assert.match(el.title,/Sample Peak 6.0 dBFS/);assert.equal(el.attributes['aria-label'],'<Track> Output Level');
 t.paintLevelMeter(el,null,'Master');assert.equal(el.bar.style.height,'0%');assert.equal(el.bar.style['--meter-fill'],'0%');assert.equal(el.classes.get('is-clipping'),false);assert.match(el.attributes['aria-valuetext'],/-inf/);
});

test('actual app meter dispatch updates tracks, returns and Master during stopped live monitoring and clears suspended readings',async()=>{
 const t=await api(),fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../web-studio/app.js'),'utf8'),start=source.indexOf('function animateLevelMeters(){'),end=source.indexOf('\nfunction animate(){',start),channels=[{dataset:{channel:'piano'}},{dataset:{return:'room'}},{dataset:{}}];channels.forEach(c=>{c.meter=element();c.querySelector=()=>c.meter;});let reads=0;
 const meter={read:()=>{reads++;return t.channelLevels([Float32Array.of(.5)]);}},ctx={paintLevelMeter:t.paintLevelMeter,engine:{playing:false,context:{state:'running'},mixer:()=>({meter}),masterMeter:meter},project:{tracks:[{id:'piano',name:'Piano'}],returns:[{id:'room',name:'Room'}]},document:{querySelectorAll:()=>channels}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);ctx.animateLevelMeters();assert.equal(reads,3);assert.ok(channels.every(c=>parseFloat(c.meter.bar.style.height)>0));assert.match(channels[2].meter.title,/Master/);ctx.engine.context.state='suspended';ctx.animateLevelMeters();assert.equal(reads,3);assert.ok(channels.every(c=>c.meter.bar.style.height==='0%'));
});
