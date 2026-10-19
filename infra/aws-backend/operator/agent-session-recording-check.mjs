// Operator-IAM real-provider planning proof; native execution remains separate.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {permitsArrangementReplacement} from '../../../web-studio/session-recording.js';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const project=JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8')),client=new BedrockRuntimeClient(awsOptions);
const cases=[
 {prompt:'Replace the existing Arrangement with a new Session performance recording and launch scene 1. I will perform the next scenes manually. Leave recording running.',active:false,expected:['record_session','launch_scene']},
 {prompt:'Start recording my Session performance into the Arrangement and launch scene 1.',active:false,question:true},
 {prompt:'Finish the active Session performance recording, saving the captured Arrangement. Do not export anything.',active:true,expected:['record_session']}
];
const proof={scope:'Real provider through operator IAM; not authenticated Studio execution',cases:[]};
for(const item of cases){const state={active:item.active,captureId:item.active?'provider-take':null,previousArrangement:item.active?project.arrangement:null},context={...agentContext(project),studio:{view:'session',playing:item.active,sessionRecording:{active:state.active,captureId:state.captureId},recording:{active:false}}};const start=Date.now();const result=await studioAgent({prompt:item.prompt,context},{budgetMs:110000,send:(c,o)=>client.send(c,o)});const row={...item,plan:result,elapsedMs:Date.now()-start};proof.cases.push(row);await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');if(item.question){assert.ok(result.question);assert.equal(result.actions.length,0);}else{assert.equal(result.question,undefined);const plan=prepareAgentPlan(project,result.actions,{sessionRecordingState:state,allowArrangementReplacement:permitsArrangementReplacement(item.prompt)});assert.deepEqual(plan.after.map(c=>c.name),item.expected);assert.equal(plan.after[0].args.action,item.active?'finish':'start');if(!item.active){assert.equal(plan.after[0].args.replace,true);assert.equal(plan.after[1].args.scene,0);}assert.equal(plan.editCount,0);}row.passed=true;console.log(JSON.stringify({passed:true,case:proof.cases.length,elapsedMs:row.elapsedMs}));}
proof.passed=true;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
