// Operator-IAM planning checks; public authenticated execution is separate.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {midiDeliveryProject} from '../../../tests/fixtures/midi-delivery-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const client=new BedrockRuntimeClient(awsOptions),project=midiDeliveryProject(),context={...agentContext(project),studio:{selection:{trackId:'lead',clipId:'riff'},view:'session'}},cases=[];
for(const [kind,prompt]of [
 ['clip','Export the selected MIDI clip as a MIDI file with its owning track MIDI effects applied. Export the whole clip loop, without changing any project data or playback. Use exactly one runtime command.'],
 ['arrangement','Export only the Lead track of the Arrangement as a MIDI file, starting at displayed beat 5 for exactly 4 beats. Bake its MIDI effects. Do not change project data or playback. Use exactly one runtime command.']
]){
 let feedback=null;
 for(let attempt=0;attempt<3;attempt++){
  let plan;try{
   plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});const compiled=prepareAgentPlan(project,plan.actions);assert.equal(compiled.editCount,0);assert.equal(compiled.after.length,1);const command=compiled.after[0],artifact=compiled.prepared.get(command);assert.equal(command.name,'export_midi');assert.equal(artifact.delivery.settings.applyEffects,true);
   if(kind==='clip'){assert.equal(artifact.delivery.source,'clip');assert.equal(artifact.delivery.settings.clipId,'riff');assert.equal(artifact.delivery.settings.trackId,'lead');assert.equal(artifact.delivery.noteCount,6);}else{assert.equal(artifact.delivery.source,'arrangement');assert.deepEqual(artifact.delivery.settings.trackIds,['lead']);assert.deepEqual(artifact.delivery.settings.range,{start:4,length:4});assert.equal(artifact.delivery.noteCount,8);}
   cases.push({kind,prompt,plan,attempt:attempt+1});console.log(JSON.stringify({kind,attempt:attempt+1,delivery:artifact.delivery}));break;
  }catch(error){feedback={error:error.message,previousPlan:plan};if(attempt===2)throw error;}
 }
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/midi-delivery-project.mjs',sourceContext:context,cases},null,2)+'\n');
