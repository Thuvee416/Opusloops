// Explicit, bounded paid evaluation on synthetic projects only. No user audio.
// Usage: node operator/evaluate-production.mjs bedrock amazon.nova-pro-v1:0
// External providers read environment keys or OPUS_PROVIDER_KEYS_FILE (mode 0600).
import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {sendPlanningRequest} from '../runtime/planning-provider.mjs';
import {emptyProject} from '../../../web-studio/model.js';
import {agentContext,applyAgentActions} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
const [provider,model]=process.argv.slice(2);
if(!['bedrock','openai','gemini'].includes(provider)||!model)throw Error('Specify bedrock, openai or gemini and an explicit model ID.');
if(process.env.OPUS_PROVIDER_KEYS_FILE){const file=process.env.OPUS_PROVIDER_KEYS_FILE;if((await stat(file)).mode&0o077)throw Error('Key file must be private (0600).');const keys=JSON.parse(await readFile(file,'utf8'));for(const name of ['OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY'])if(keys[name])process.env[name]=keys[name];}
process.env.STUDIO_AGENT_PROVIDER=provider;process.env.STUDIO_AGENT_MODEL_ID=model;
const client=new BedrockRuntimeClient({...awsOptions,maxAttempts:1});
let p=emptyProject();p.tracks[0].id='existing-vocal';p.tracks[0].name='Vocal';
p=applyAgentActions(p,[{type:'add_track',args:{name:'Bass',preset:'Warm bass',ref:'$bass'}},{type:'midi',args:{trackId:'$bass',name:'Synthetic Bass',ref:'$clip',beats:4,notes:[{pitch:36,start:0,duration:1,velocity:.7}]}},{type:'region',args:{trackId:'$bass',clipId:'$clip',start:0,length:16}}]);
const cases=[
 {id:'engineer-reference',prompt:'Make this mix sound like a Dave Pensado mix.',question:true},
 {id:'song-reference',prompt:'Create a house song with the same structure as Don’t You Worry Child by Swedish House Mafia.',question:true},
 {id:'described-mix',prompt:'Make the bass warmer and less bright with gentle EQ. Keep the vocal, tempo, notes and arrangement unchanged. I want a subtle starting point, not a mastering claim.',edits:true},
 {id:'original-composition',prompt:'Add an original four-bar house bass idea on a new track with the Warm bass preset in Arrangement. Use C minor, leave existing tracks and tempo unchanged. Keep it sparse and editable.',edits:true}
];
const results=[];
for(const c of cases){if(process.env.OPUS_EVAL_CASE&&c.id!==process.env.OPUS_EVAL_CASE)continue;const started=Date.now(),providerOutputs=[];try{
 const context={...agentContext(p),productionBrief:{version:1,previous:null},processedAnalysis:{version:1,status:'unavailable',reason:'Synthetic text-only benchmark; no rendered audio evidence.'},studio:{view:'arrangement',history:{undoCount:0,redoCount:0}}};
 const result=await studioAgent({prompt:c.prompt,context},{budgetMs:100000,send:async(cmd,opt)=>{const response=await sendPlanningRequest(cmd,opt,{bedrock:(a,b)=>client.send(a,b)});providerOutputs.push(response);return response;}});
 const compiled=prepareAgentPlan(p,result.actions);const issues=[];
 if(c.question&&(!result.question||result.actions.length||result.brief.referenceState!=='requested'))issues.push('Unheard reference requires clarification with no edits');
 if(c.edits&&(!result.actions.length||result.question))issues.push('Did not produce requested supported edits');
 if(c.edits&&(JSON.stringify(compiled.next.tracks[0])!==JSON.stringify(p.tracks[0])||compiled.next.bpm!==p.bpm))issues.push('Changed protected vocal or tempo');
 if(c.id==='described-mix'&&(JSON.stringify(compiled.next.clips)!==JSON.stringify(p.clips)||JSON.stringify(compiled.next.arrangement)!==JSON.stringify(p.arrangement)))issues.push('Changed protected notes or arrangement');
 results.push({id:c.id,milliseconds:Date.now()-started,passed:!issues.length,issues,result});
 }catch(error){results.push({id:c.id,milliseconds:Date.now()-started,passed:false,error:error.code||error.name,message:error.message,providerOutputs});}
 console.log(JSON.stringify({provider,model,...results.at(-1),result:undefined,providerOutputs:undefined}));
}
const report={at:new Date().toISOString(),provider,model,scope:'Four synthetic text/tool cases, one sample each; not perceptual music quality or a latency percentile.',results};
await mkdir(new URL('../.operator/',import.meta.url),{recursive:true});
await writeFile(new URL('../.operator/production-eval-'+provider+'.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length}));
