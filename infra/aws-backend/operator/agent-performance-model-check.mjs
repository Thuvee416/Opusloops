// Uses operator IAM for bounded model planning checks. This does not authenticate
// through the public app, create users, or exercise production account access.
import assert from 'node:assert/strict';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {emptyProject,makeTrack} from '../../../web-studio/model.js';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const client=new BedrockRuntimeClient(awsOptions),project=emptyProject(),lead=project.tracks[0],pad=makeTrack('Retained pad');
project.bpm=240;project.transport.launchQuantization=.5;lead.id='lead';pad.id='pad';lead.slots=['low','high',null,null];pad.slots=['pad',null,null,null];project.tracks.push(pad);
for(const id of ['low','high','pad'])project.clips[id]={id,kind:'audio',name:id,beats:4,sourceBpm:240,data:''};
project.arrangement=[{id:'arr',trackId:'lead',clipId:'low',start:0,length:8,offset:0}];
const cases=[
 {prompt:'Without editing the project, launch scene 0, then scene 1, wait for the clip launches, pause, and export Session clips as WAV. Use the explicit session export source despite the existing Arrangement.',names:['launch_scene','launch_scene','pause','export_wav'],verify:c=>assert.equal(c.at(-1).args.source,'session')},
 {prompt:'Without editing the project, launch the clip in scene 1 on track lead, then stop clips on track lead, then stop all Session clips. Keep transport running.',names:['launch_clip','stop_track','stop_clips'],verify:c=>{assert.equal(c[0].args.trackId,'lead');assert.equal(c[0].args.scene,1);assert.equal(c[1].args.trackId,'lead');}}
];
for(const item of cases){let feedback=null;for(let attempt=0;attempt<3;attempt++){let plan;try{plan=await studioAgent({prompt:item.prompt,context:agentContext(project),feedback},{send:c=>client.send(c)});const compiled=prepareAgentPlan(project,plan.actions),commands=compiled.after.filter(c=>c.name!=='view');assert.equal(compiled.editCount,0);assert.deepEqual(commands.map(c=>c.name),item.names);item.verify(commands);console.log(JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,validatedCommands:item.names,attempt:attempt+1}));break;}catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}}}
