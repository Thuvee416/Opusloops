// Bounded operator-IAM model checks; not authenticated public-app execution.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {deliveryOptions} from '../../../web-studio/delivery-options.js';
import {deliveryProject} from '../../../tests/fixtures/delivery-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const client=new BedrockRuntimeClient(awsOptions),project=deliveryProject(),context=agentContext(project),cases=[];
for(const kind of ['wav','stems']){
 const prompt=(kind==='wav'?'Export only the Lead track as a WAV file.':'Export all tracks and returns as one aligned stem ZIP.')+' Use displayed beat 5 as the start and export exactly 4 beats of the Arrangement at 48 kHz, 24-bit PCM, no normalization, no dither, no effect tails. Do not edit the project or start playback. Use a single export command.';
 let feedback=null;
 for(let attempt=0;attempt<3;attempt++){
  let plan;
  try{
   plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});
   const compiled=prepareAgentPlan(project,plan.actions);assert.equal(compiled.editCount,0);assert.equal(compiled.before.length,0);assert.equal(compiled.after.length,1);
   assert.equal(compiled.after[0].name,kind==='wav'?'export_wav':'export_stems');
   const settings=deliveryOptions(project,compiled.after[0].args,kind);assert.equal(settings.sampleRate,48000);assert.equal(settings.bitDepth,24);assert.equal(settings.normalize,false);assert.equal(settings.dither,'none');assert.equal(settings.includeTail,false);assert.equal(settings.source,'arrangement');assert.deepEqual(settings.range,{start:4,length:4});if(kind==='wav')assert.equal(settings.channel,'track:lead');
   cases.push({kind,prompt,plan,attempt:attempt+1});console.log(JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,validated:compiled.after[0].name,attempt:attempt+1,settings}));break;
  }catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}
 }
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/delivery-project.mjs',sourceContext:context,cases},null,2)+'\n');
