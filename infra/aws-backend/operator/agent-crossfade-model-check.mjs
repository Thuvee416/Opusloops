// Direct operator-IAM model planning, not public authenticated app execution.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {editRegionCrossfade} from '../../../web-studio/region-crossfade.js';
import {regionCrossfadeProject} from '../../../tests/fixtures/region-crossfade-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';const client=new BedrockRuntimeClient(awsOptions),source=regionCrossfadeProject(),cases=[];
for(const [kind,prompt]of [['create','Make a one-beat crossfade centered at the join between the two selected Arrangement audio clips. Preserve their outer edges, source audio and mixer settings. Use one region_crossfade action.'],['remove','Remove the crossfade between the two selected Arrangement audio clips and join their edges at the current overlap midpoint. Preserve source audio and outer edges. Use one region_crossfade action.']]){
 const project=structuredClone(source);if(kind==='remove')project.arrangement=editRegionCrossfade(project,{leftId:'outgoing',rightId:'incoming',start:3.5,length:1}).arrangement;const context={...agentContext(project),studio:{view:'arrangement',selectedRegion:'outgoing',selectedRegions:['outgoing','incoming'],selection:{trackId:'lead',clipId:'source'}}};let feedback=null;
 for(let attempt=0;attempt<3;attempt++){let plan;try{plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});const result=prepareAgentPlan(project,plan.actions);assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].type,'region_crossfade');assert.equal(result.after.length,0);if(kind==='create'){assert.deepEqual(result.next.arrangement.slice(0,2).map(r=>[r.start,r.length,r.offset]),[[1,3.5,0],[3.5,3.5,.5]]);}else assert.deepEqual(result.next.arrangement,source.arrangement);assert.deepEqual(result.next.clips,project.clips);cases.push({kind,prompt,sourceContext:context,plan,attempt:attempt+1});console.log(JSON.stringify({kind,attempt:attempt+1,observation:result.editObservations[0]}));break;}catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}}
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/region-crossfade-project.mjs',cases},null,2)+'\n');
