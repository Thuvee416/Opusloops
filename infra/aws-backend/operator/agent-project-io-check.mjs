import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {History} from '../../../web-studio/history.js';
import {historyState} from '../../../web-studio/history-control.js';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const project=JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8')),history=new History(project),client=new BedrockRuntimeClient(awsOptions),proof={scope:'Real provider drafting/review and local preflight; not browser file choice or authenticated production execution',cases:[]};
const cases=[['Start a new empty set called Night Tide and save it.','new'],['Open a saved OPUS project from my computer.','open'],['Import an audio file into Drums in displayed scene 2, without replacing any clips.','import_audio'],['Import a MIDI file as additional tracks and keep the current tempo.','import_midi']];
for(const [prompt,action]of cases){const context={...agentContext(project),studio:{history:historyState(history),playing:false,recording:{active:false},sessionRecording:{active:false}}},start=Date.now(),plan=await studioAgent({prompt,context},{budgetMs:110000,send:(c,o)=>client.send(c,o)});assert.equal(plan.question,undefined);const compiled=prepareAgentPlan(project,plan.actions,{historyState:historyState(history)}),io=compiled.after.find(c=>c.name==='project_io');assert.equal(io?.args.action,action);assert.equal(compiled.editCount,0);if(action==='new'){assert.equal(io.args.name,'Night Tide');assert.equal(io.args.empty,true);assert.equal(compiled.after.at(-1).name,'save_project');}if(action==='import_audio'){assert.equal(io.args.trackId,project.tracks.find(t=>t.name==='Drums').id);assert.equal(io.args.scene,1);assert.notEqual(io.args.replace,true);}if(action==='import_midi'){assert.notEqual(io.args.replace,true);assert.notEqual(io.args.useTempo,true);}proof.cases.push({prompt,plan,passed:true,elapsedMs:Date.now()-start});await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({action,passed:true}));}
proof.passed=true;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
