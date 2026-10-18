const {test}=require('node:test');const assert=require('node:assert/strict');
const prompt='Add two Init synth tracks. Each needs a four-beat MIDI clip in scene 1. No other edits or commands.';
test('fresh explicit MIDI creation binds default launch preservation independently of earlier settings',async()=>{
 const {readCreationLaunchRequirement}=await import('../web-studio/midi-creation-requirements.js');assert.deepEqual(readCreationLaunchRequirement(prompt),{kind:'fresh-midi-default-launch'});
 for(const text of [prompt.replace('No other edits or commands.','Use the same launch settings as before.'),prompt+' Launch mode Toggle.',prompt.replace('MIDI clip','audio clip'),'Add a MIDI clip like before. No other edits.','Create a MIDI clip.'])assert.equal(readCreationLaunchRequirement(text),null);
});
test('earlier constructor, shared-source and single-source launch edits reject an entire fresh composition',async()=>{
 const {readCreationLaunchRequirement}=await import('../web-studio/midi-creation-requirements.js'),{prepareAgentPlan}=await import('../web-studio/agent-runner.js'),{emptyProject}=await import('../web-studio/model.js');const p=emptyProject(),before=structuredClone(p),midi={type:'midi',args:{trackId:p.tracks[0].id,ref:'$new',sceneNumber:1,beats:4,notes:[]}},launch={mode:'toggle',quantization:4,legato:true},options={creationLaunchRequirement:readCreationLaunchRequirement(prompt)};
 for(const actions of [[{...midi,args:{...midi.args,launch}}],[midi,{type:'clip_properties',args:{ids:['$new'],changes:{launch}}}],[midi,{type:'clip',args:{id:'$new',changes:{launch}}}]])assert.throws(()=>prepareAgentPlan(p,actions,options),/Do Not Carry Settings From Earlier Conversation/);
 assert.deepEqual(p,before);const good=prepareAgentPlan(p,[midi],options);assert.equal(good.next.clips[good.next.tracks[0].slots[0]].launch,undefined);assert.equal(good.editCount,1);
});
