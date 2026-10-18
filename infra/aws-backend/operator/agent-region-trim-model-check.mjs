// Bounded operator-IAM planning; does not create accounts or authenticate the public app.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {regionTrimProject} from '../../../tests/fixtures/region-trim-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const client=new BedrockRuntimeClient(awsOptions),project=regionTrimProject(),context=agentContext(project),cases=[];context.studio={view:'arrangement',selectedRegion:'a',selectedRegions:['a','b']};
for(const edge of ['start','end']){
 const prompt=`Trim one beat off the ${edge==='start'?'starts':'ends'} of the two currently selected Arrangement clips. Keep their original ${edge==='start'?'ends':'starts'} and source timing. Do not change source notes, the third unselected clip, tempo or automation. Use one region_group trim action.`;let feedback=null;
 for(let attempt=0;attempt<3;attempt++){let plan;try{
  plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});const compiled=prepareAgentPlan(project,plan.actions);assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].type,'region_group');assert.equal(compiled.before.length+compiled.after.length,0);
  const args=typeof plan.actions[0].args==='string'?JSON.parse(plan.actions[0].args):plan.actions[0].args;assert.equal(args.edge,edge);assert.equal(args.delta,edge==='start'?1:-1,'Removing a beat from starts means delta +1; removing a beat from ends means delta -1. The opposite sign extends instead of shortens.');
  assert.deepEqual(compiled.next.arrangement.slice(0,2).map(r=>[r.start,r.length,r.offset]),edge==='start'?[[5,3,2],[9,1,0]]:[[4,3,1],[8,1,3]]);assert.deepEqual(compiled.next.arrangement[2],project.arrangement[2]);assert.deepEqual(compiled.next.clips,project.clips);assert.equal(compiled.editObservations[0].appliedDelta,edge==='start'?1:-1);
  console.log(JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,edge,attempt:attempt+1,observed:compiled.editObservations}));cases.push({edge,prompt,plan,attempt:attempt+1});break;
 }catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}}
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/region-trim-project.mjs',sourceContext:context,plan:cases[0].plan,cases},null,2)+'\n');
