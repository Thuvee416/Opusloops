// Real provider planning checks. Executing the resulting UI controls is separate.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {playbackIntent,stopIntent} from '../../../web-studio/transport-controls.js';
import {overdubProject} from '../../../tests/fixtures/midi-overdub-project.mjs';
import {controlState} from '../../../tests/fixtures/recording-control-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const client=new BedrockRuntimeClient(awsOptions),project=overdubProject(),original=JSON.stringify(project),cases=[];
const inputs=[
 {id:'continue',playing:false,position:17.125,insertMarker:8,prompt:'Continue playback exactly from the retained stop point. Do not restart at the insert marker. Do not change my project or anything else.',name:'play',expected:{from:'continue'}},
 {id:'stop-retain',playing:true,position:21.125,insertMarker:8,prompt:'Stop playback here and retain this stop position. Do not rewind or edit the project.',name:'stop',expected:{reset:false}},
 {id:'stop-reset',playing:true,position:21.125,insertMarker:8,prompt:'Stop and return the entire transport to 1.1.1, resetting the insert marker too. Use one runtime command and make no project edits.',name:'stop',expected:{reset:true}},
 {id:'play-marker',playing:false,position:21.125,insertMarker:8,prompt:'Start playback from the insert marker, not from the last stop point. No other changes.',name:'play',expected:{from:'marker'}}
];
for(const input of inputs){let feedback=null;const failures=[];
 for(let attempt=1;attempt<=3;attempt++){let plan;try{
  const recording={...controlState(project),playing:input.playing};
  plan=await studioAgent({prompt:input.prompt,context:{...agentContext(project),studio:{recording,playing:input.playing,position:input.position,insertMarker:input.insertMarker,view:'session',performance:{mode:'session',playing:input.playing,tracks:[{trackId:'lead',clipId:'loop',slot:0,activationBeat:0}]}}},feedback},{send:(command,options)=>client.send(command,options)});
  const prepared=prepareAgentPlan(project,plan.actions,{recordingState:recording});assert.equal(prepared.editCount,0);assert.equal(prepared.before.length,0);assert.equal(prepared.after.length,1);assert.equal(prepared.after[0].name,input.name);
  const actual=input.name==='play'?playbackIntent(prepared.after[0].args):stopIntent(prepared.after[0].args);assert.deepEqual(actual,input.expected);assert.equal(JSON.stringify(project),original);
  cases.push({...input,attempt,failures,plan});await writeFile(new URL('../../../tests/fixtures/agent-transport-plans.json',import.meta.url),JSON.stringify({model:'amazon.nova-pro-v1:0',cases},null,2)+'\n');console.log(JSON.stringify({id:input.id,attempt,reviewed:plan.reviewed,validated:true}));break;
 }catch(error){failures.push({attempt,error:error.message,...(plan?{plan}:{})});console.log(JSON.stringify({id:input.id,attempt,error:error.message}));await writeFile(new URL('../../../tests/fixtures/agent-transport-failures.json',import.meta.url),JSON.stringify({id:input.id,failures},null,2)+'\n');if(attempt===3||error instanceof ReferenceError||error instanceof SyntaxError)throw error;feedback={error:error.message,previousPlan:plan};}}
}
