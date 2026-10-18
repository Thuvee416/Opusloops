const {test}=require('node:test');const assert=require('node:assert/strict');
const setup=async()=>({...await import('./fixtures/agent-compose-delivery.mjs'),...await import('../web-studio/agent-runner.js')});
test('composition-to-track-WAV resolves aliases after all musical edits and leaves the source unchanged',async()=>{
 const {sourceProject,compositionActions,assertComposition,prepareAgentPlan}=await setup(),p=sourceProject(),before=structuredClone(p),actions=compositionActions(),copy=structuredClone(actions);
 assertComposition(p,prepareAgentPlan(p,actions));assert.deepEqual(p,before);assert.deepEqual(actions,copy);
});
test('observed model WAV trackId error identifies its exact path and correct channel syntax; repairs remain atomic',async()=>{
 const {sourceProject,compositionActions,assertComposition,prepareAgentPlan}=await setup(),p=sourceProject(),before=structuredClone(p),actions=compositionActions(),args=actions.at(-1).args.args;
 delete args.channel;args.trackId='$bass';
 assert.throws(()=>prepareAgentPlan(p,actions),e=>{assert.match(e.message,/Unexpected fields: command.args.trackId/);assert.match(e.message,/command.args.channel="track:ID"/);assert.match(e.message,/track:\$alias/);return true;});
 assert.deepEqual(p,before);delete args.trackId;args.channel='track:$bass';assertComposition(p,prepareAgentPlan(p,actions));
});
test('runtime diagnostics separate wrapper and nested mistakes without admitting unknown or malformed options',async()=>{
 const {sourceProject,prepareAgentPlan}=await setup(),p=sourceProject();
 assert.throws(()=>prepareAgentPlan(p,[{type:'command',args:{name:'export_wav',sampleRate:44100,args:{filename:'bad.wav'}}}]),/command.sampleRate, command.args.filename/);
 for(const args of [null,[],false,'wrong'])assert.throws(()=>prepareAgentPlan(p,[{type:'command',args:{name:'save_project',args}}]),/command.args must be an object/);
 assert.throws(()=>prepareAgentPlan(p,[{type:'command',args:{name:'play',args:{trackId:'original-track'}}}]),/command.args.trackId/);
});
