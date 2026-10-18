// Bounded operator-IAM planning evidence; execution is verified separately in the studio.
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {sourceProject,prompt,compositionActions,assertComposition} from '../../../tests/fixtures/agent-compose-delivery.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const project=sourceProject(),context={...agentContext(project),studio:{view:'session',playing:false,position:0},analysis:[]},client=new BedrockRuntimeClient(awsOptions),cases=[];
const rejected={summary:'Compose and export bass',actions:compositionActions()};delete rejected.actions.at(-1).args.args.channel;rejected.actions.at(-1).args.args.trackId='$bass';
let rejectedError;try{prepareAgentPlan(project,rejected.actions);}catch(error){rejectedError=error.message;}
for(const kind of ['direct','repair']){
 let feedback=kind==='repair'?{error:rejectedError,previousPlan:rejected}:null;
 for(let attempt=1;attempt<=3;attempt++){
  let plan;
  try{plan=await studioAgent({prompt,context,feedback},{send:c=>client.send(c)});const compiled=prepareAgentPlan(project,plan.actions);assertComposition(project,compiled);cases.push({kind,attempt,plan});console.log(JSON.stringify({kind,attempt,validated:'four notes + isolated ranged PCM WAV',edits:compiled.editCount}));break;}
  catch(error){feedback={error:error.message,previousPlan:plan};console.log(JSON.stringify({kind,attempt,error:error.message}));if(attempt===3)throw error;}
 }
}
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/agent-compose-delivery.mjs',prompt,sourceContext:context,cases},null,2)+'\n');
