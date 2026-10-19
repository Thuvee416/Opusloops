// Real provider plans against private local history; browser execution is separate.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {History} from '../../../web-studio/history.js';
import {historyState,readHistoryRequest} from '../../../web-studio/history-control.js';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const original=JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8')),history=new History(original),first={...structuredClone(original),bpm:132},second=structuredClone(first);second.transport.metronome=true;history.commit(first);history.commit(second);
const cases=[{prompt:'Undo the last two changes then save the project.',action:'undo',steps:2,project:second,target:original},{prompt:'Restore the two edits I just undid, then save the project.',action:'redo',steps:2,project:original,target:second},{prompt:'Stop playback, undo the most recent edit, then save the project.',action:'undo',steps:1,playing:true,project:second,target:first}];
const proof={scope:'Real provider through operator IAM with exact local history target preflight; not authenticated execution',cases:[]},client=new BedrockRuntimeClient(awsOptions);
for(const item of cases){const state=historyState(history),context={...agentContext(item.project),studio:{history:state,playing:!!item.playing,view:'session',recording:{active:false},sessionRecording:{active:false}}},start=Date.now();const result=await studioAgent({prompt:item.prompt,context},{budgetMs:110000,send:async(c,o)=>{const response=await client.send(c,o);const call=response.output?.message?.content?.find(x=>x.toolUse)?.toolUse?.input;if(call){await writeFile('/tmp/opus-history-latest-provider-plan.json',JSON.stringify(call,null,2)+'\n');}return response;}});const row={prompt:item.prompt,history:state,plan:result,elapsedMs:Date.now()-start};proof.cases.push(row);await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');assert.equal(result.question,undefined);const compiled=prepareAgentPlan(item.project,result.actions,{historyState:state,historyPreview:(a,n)=>history.preview(a,n),historyRequirement:readHistoryRequest(item.prompt,{compound:true})});assert.deepEqual(compiled.next,item.target);assert.equal(compiled.editCount,0);assert.deepEqual(compiled.after.map(c=>c.name),item.playing?['stop','history','save_project']:['history','save_project']);const command=compiled.after.find(c=>c.name==='history');assert.equal(command.args.action,item.action);assert.equal(command.args.steps??1,item.steps);history.move(item.action,item.steps);row.passed=true;console.log(JSON.stringify({case:proof.cases.length,passed:true,elapsedMs:row.elapsedMs}));}
proof.passed=true;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
