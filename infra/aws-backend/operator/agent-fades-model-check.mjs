// Operator-IAM planning, distinct from authenticated public application inference.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {regionFadesProject} from '../../../tests/fixtures/region-fades-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';const client=new BedrockRuntimeClient(awsOptions),project=regionFadesProject(),context={...agentContext(project),studio:{view:'arrangement',selectedRegion:'audio-a',selectedRegions:['audio-a','audio-b'],selection:{trackId:'lead',clipId:'source'}}},cases=[];
for(const [kind,prompt,fadeIn,fadeOut]of [['fade','Add a one-beat fade in and quarter-beat fade out to both selected Arrangement audio clips. Keep the source clips, their offset, placement and mixer automation unchanged.',1,.25],['short','Give both selected Arrangement audio clips a 4 millisecond fade in and 4 millisecond fade out. Keep all other project data unchanged.',.008,.008]]){
 let feedback=null;for(let attempt=0;attempt<3;attempt++){let plan;try{plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});const result=prepareAgentPlan(project,plan.actions);assert.equal(result.after.length,0);assert.equal(result.before.length,0);assert.ok(plan.actions.every(a=>a.type==='region_fades'));for(const r of result.next.arrangement){assert.equal(r.fades.in.end,fadeIn);assert.ok(Math.abs(r.length-r.fades.out.start-fadeOut)<1e-8);}assert.deepEqual(result.next.clips,project.clips);cases.push({kind,prompt,plan,attempt:attempt+1});console.log(JSON.stringify({kind,attempt:attempt+1,fadeIn,fadeOut}));break;}catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}}
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/region-fades-project.mjs',sourceContext:context,cases},null,2)+'\n');
