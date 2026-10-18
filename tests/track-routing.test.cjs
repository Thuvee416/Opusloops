const {test}=require('node:test');const assert=require('node:assert/strict');
const setup=async()=>({...await import('../web-studio/track-routing.js'),...await import('../web-studio/routing.js'),...await import('../web-studio/model.js'),...await import('../web-studio/devices.js'),...await import('../web-studio/management.js'),...await import('../web-studio/agent-runner.js')});
function project(t){const p=t.emptyProject();p.tracks=['a','b','bus','main','other'].map(id=>({...t.makeTrack(id),id,devices:[]}));p.tracks[0].output='track:bus';p.tracks[1].output='track:bus';p.tracks[2].output='track:main';return p;}
test('main outputs form an order-independent acyclic graph and reject missing/self/return destinations',async()=>{
 const t=await setup(),p=project(t),before=structuredClone(p),routes=t.trackRouting(p);assert.equal(routes.destinations.get('a'),'bus');assert.ok(routes.order.indexOf('a')<routes.order.indexOf('bus'));assert.ok(routes.order.indexOf('bus')<routes.order.indexOf('main'));
 for(const value of ['track:a','track:missing','return:room',null,'bogus'])assert.throws(()=>t.setTrackOutput(p,'a',value));assert.deepEqual(p,before);assert.throws(()=>t.setTrackOutput(p,'main','track:a'),/feedback loop/);assert.deepEqual(p,before);t.setTrackOutput(p,'a','sendsOnly');assert.equal(t.trackRouting(p).destinations.get('a'),null);t.validateProject(p);
});
test('Solo separates local sources from the downstream bus processors needed to hear them',async()=>{
 const t=await setup(),p=project(t);let state=t.routingSoloState(p);assert.equal(state.own.size,5);assert.equal(state.through.size,5);
 p.tracks[0].solo=true;state=t.routingSoloState(p);assert.deepEqual([...state.own],['a']);assert.deepEqual(new Set(state.through),new Set(['a','bus','main']));
 p.tracks[0].solo=false;p.tracks[2].solo=true;state=t.routingSoloState(p);assert.deepEqual(new Set(state.own),new Set(['a','b','bus']));assert.deepEqual(new Set(state.through),new Set(['a','b','bus','main']));
 p.tracks[4].solo=true;state=t.routingSoloState(p);assert.deepEqual(new Set(state.own),new Set(['a','b','bus','other']));
 p.tracks[2].solo=false;p.tracks[3].solo=true;state=t.routingSoloState(p);assert.equal(state.own.size,5);
});
test('output choices disable feedback paths while preserving selectable downstream buses',async()=>{
 const t=await setup(),p=project(t),choices=t.trackOutputChoices(p,'bus');assert.ok(!choices.some(c=>c.value==='track:bus'));assert.equal(choices.find(c=>c.value==='track:a').disabled,true);assert.equal(choices.find(c=>c.value==='track:main').disabled,false);assert.deepEqual(t.routingInputs(p,'bus'),['a','b']);
});
test('deleting a bus reconnects its direct inputs downstream atomically; Undo restores graph and source data',async()=>{
 const t=await setup(),p=project(t),before=structuredClone(p),next=t.editTrack(p,'bus','delete').project;assert.equal(next.tracks.find(t=>t.id==='a').output,'track:main');assert.equal(next.tracks.find(t=>t.id==='b').output,'track:main');assert.deepEqual(p,before);t.validateProject(next);
 const {History}=await import('../web-studio/history.js'),history=new History(p);history.commit(next);assert.deepEqual(history.undo(),before);const copy=t.editTrack(p,'bus','duplicate').project;assert.equal(copy.tracks[3].output,'track:main');assert.equal(copy.tracks.find(t=>t.id==='a').output,'track:bus');
});
test('routed effect tails add across bus stages and sends, including isolated Sends Only bus delivery',async()=>{
 const t=await setup(),p=project(t);for(const [id,decay]of [['a',1],['bus',2],['main',3]]){const d=t.newDevice('reverb');d.params.decay=decay;p.tracks.find(t=>t.id===id).devices=[d];}assert.equal(t.routingTail(p),6);assert.equal(t.routingTail(p,44100,'track:bus'),3);
 p.returns=[{...t.newReturn('Room'),id:'room'}];p.returns[0].devices[0].params.decay=4;p.tracks[2].sends={room:{amount:.2,pre:false}};assert.equal(t.routingTail(p),7);assert.equal(t.routingTail(p,44100,'return:room'),7);
 p.tracks[2].output='sendsOnly';delete p.tracks[2].sends;assert.equal(t.routingTail(p,44100,'track:bus'),3);assert.equal(t.routingTail(p),3,'Unrouted main still has its own three-second tail');assert.throws(()=>t.routingTail(p,44100,'track:missing'));
});
test('agent routing resolves bus aliases, reports only final output changes and rejects a late cycle before committing',async()=>{
 const t=await setup(),p=project(t),before=structuredClone(p),actions=[{type:'add_track',args:{name:'New Bus',ref:'$bus'}},{type:'track',args:{id:'a',changes:{output:'track:$bus'}}},{type:'track',args:{id:'b',changes:{output:'track:$bus'}}}],plan=t.prepareAgentPlan(p,actions),bus=plan.next.tracks.at(-1);assert.equal(plan.next.tracks[0].output,'track:'+bus.id);assert.equal(plan.editObservations.filter(o=>o.type==='track_output').length,2);assert.ok(plan.editObservations.every(o=>o.destinationName==='New Bus'));assert.deepEqual(p,before);
 assert.throws(()=>t.prepareAgentPlan(p,[...actions,{type:'track',args:{id:'$bus',changes:{output:'track:a'}}}]),/feedback loop/);assert.deepEqual(p,before);
 const rewired=t.prepareAgentPlan(p,[{type:'track',args:{id:'bus',changes:{output:'track:a'}}},{type:'track',args:{id:'a',changes:{output:'master'}}}]);t.validateProject(rewired.next);assert.equal(rewired.editObservations.length,2,'Intermediate routing cycles are never installed; only final candidate is validated');
});
test('live graph reroutes without replacing voice inputs or ever connecting a temporary feedback cycle',async()=>{
 const t=await setup(),p=project(t);p.tracks=[p.tracks[2],p.tracks[0],p.tracks[1],p.tracks[3],p.tracks[4]];
 class Node{constructor(){this.edges=new Set();const param=()=>({value:0,setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}});this.gain=param();this.pan=param();}connect(target){const reaches=(node,seen=new Set())=>node===this||(!seen.has(node)&&(seen.add(node),[...node.edges].some(next=>reaches(next,seen))));assert.equal(reaches(target),false,'No graph edit may introduce feedback, even temporarily');this.edges.add(target);return target;}disconnect(target){if(target)this.edges.delete(target);else this.edges.clear();}}
 const ctx={currentTime:0,sampleRate:44100,createGain:()=>new Node(),createStereoPanner:()=>new Node(),createAnalyser:()=>new Node()},master=new Node(),graph=t.createMixGraph(ctx,p,master),originalInput=graph.tracks.get('a').input;
 assert.ok(graph.tracks.get('a').dry.edges.has(graph.tracks.get('bus').chain.input));p.tracks.find(t=>t.id==='bus').output='track:a';p.tracks.find(t=>t.id==='a').output='master';graph.update();assert.equal(graph.tracks.get('a').input,originalInput);assert.ok(graph.tracks.get('bus').dry.edges.has(graph.tracks.get('a').chain.input));assert.ok(graph.tracks.get('a').dry.edges.has(master));
 p.tracks.find(t=>t.id==='a').solo=true;graph.update();assert.equal(graph.tracks.get('bus').input.gain.value,1,'Bus is now upstream of solo A');assert.equal(graph.tracks.get('main').input.gain.value,0);p.tracks.find(t=>t.id==='a').output='track:bus';const previous=[...graph.tracks.get('a').dry.edges];assert.throws(()=>graph.update(),/feedback loop/);assert.deepEqual([...graph.tracks.get('a').dry.edges],previous);graph.dispose();
});
test('new buses accept validated initial mix settings rather than silently ignoring them',async()=>{
 const t=await setup(),p=project(t),before=structuredClone(p),plan=t.prepareAgentPlan(p,[{type:'add_track',args:{name:'Unity Bus',ref:'$new',volume:1,pan:-.25,output:'track:main'}},{type:'track',args:{id:'a',changes:{output:'track:$new'}}}]),bus=plan.next.tracks.at(-1);assert.equal(bus.volume,1);assert.equal(bus.pan,-.25);assert.equal(bus.output,'track:main');assert.equal(plan.next.tracks[0].output,'track:'+bus.id);
 for(const args of [{name:'Bad',changes:{volume:1}},{name:'Bad',volume:2},{name:'Bad',output:'return:room'}])assert.throws(()=>t.prepareAgentPlan(p,[{type:'add_track',args}]));assert.deepEqual(p,before);
 const returned=structuredClone(p);returned.returns=[{...t.newReturn('Room'),id:'room',output:'track:a'}];assert.throws(()=>t.validateProject(returned),/Master only/);delete returned.returns[0].output;returned.returns[0].solo=true;assert.throws(()=>t.validateProject(returned),/Solo is not implemented/);
});
test('track patches use one strict implementation for direct and management command forms',async()=>{
 const t=await setup(),p=project(t),args={id:'a',changes:{output:'track:other',volume:.8,pan:.2}};
 const direct=t.prepareAgentPlan(p,[{type:'track',args}]),managed=t.prepareAgentPlan(p,[{type:'manage_track',args:{...args,action:'changes'}}]);assert.deepEqual(direct.next,managed.next);assert.deepEqual(direct.editObservations,managed.editObservations);
 assert.throws(()=>t.prepareAgentPlan(p,[{type:'manage_track',args:{...args,action:'changes',value:'1'}}]),/changes only/);assert.throws(()=>t.prepareAgentPlan(p,[{type:'track',args:{...args,output:'master'}}]),/changes only/);
});
test('captured reviewed model plans preserve sources and resolve the exact requested bus',async()=>{
 const t=await setup(),{routingProject}=await import('./fixtures/track-routing-project.mjs'),capture=require('./fixtures/agent-track-routing-plan.json');
 for(const sample of capture.cases){const p=routingProject(false),before=structuredClone(p),plan=t.prepareAgentPlan(p,sample.plan.actions);assert.equal(sample.plan.reviewed,true);assert.deepEqual(p,before);assert.deepEqual(plan.next.clips,p.clips);assert.deepEqual(plan.next.arrangement,p.arrangement);assert.deepEqual(plan.next.returns,p.returns);
  for(const original of p.tracks){const {output,...rest}=plan.next.tracks.find(next=>next.id===original.id);assert.deepEqual(rest,original);if(!['a','b'].includes(original.id)&&!(sample.kind==='route'&&original.id==='bus'))assert.equal(output,undefined);}
  if(sample.kind==='route'){assert.equal(plan.next.tracks.length,5);assert.equal(plan.next.tracks.find(t=>t.id==='bus').output,'track:main');assert.equal(plan.next.tracks[0].output,'track:bus');}
  else{const bus=plan.next.tracks.at(-1);assert.equal(bus.name,'New Bus');assert.equal(bus.volume,1);assert.equal(bus.output,'track:main');assert.equal(bus.instrument,undefined);assert.ok(bus.slots.every(c=>c===null));assert.equal(bus.devices.length,1);assert.equal(bus.devices[0].params.gain,-6);for(const id of ['a','b'])assert.equal(plan.next.tracks.find(t=>t.id===id).output,'track:'+bus.id);assert.equal(plan.after.at(-1).args.trackId,bus.id);}
 }
});
