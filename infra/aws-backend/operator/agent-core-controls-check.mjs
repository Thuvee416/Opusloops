// Bounded real-provider checks. Native authenticated execution remains separate.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';

if(!process.env.OPUS_MUSICAL_SOURCE||!process.env.OPUS_AGENT_CAPTURE)throw Error('Set source to the synthetic pre-microphone song and capture to a proof JSON path.');
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const source=JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8'));
const client=new BedrockRuntimeClient(awsOptions),proof={scope:'Operator-IAM real provider drafting/review and independent local preflight assertions. Not authenticated browser execution.',cases:[]};
const prompts=[
 ['mixer-rename','Mute Drums, solo Bass, and rename Keys to Pad Keys. Keep every other setting and all clips unchanged. Do not start playback or export.'],
 ['remove-track','Remove only the Core Lead track and its Arrangement regions. Keep all other tracks, clips, regions and settings unchanged. Do not start playback or export.'],
 ['seek-play','Show Arrangement, move the insert marker to bar 9, and play from that marker. Do not edit the song or change any mixer settings.']
];
for(const [id,prompt]of prompts){
 const entry={id,prompt};proof.cases.push(entry);
 try{
  const started=Date.now();
  entry.plan=await studioAgent({prompt,context:{...agentContext(source),studio:{view:'session',playing:false,position:0,insertMarker:0,recording:{active:false},sessionRecording:{active:false}}}},{budgetMs:110000,send:(c,o)=>client.send(c,o)});
  entry.elapsedMs=Date.now()-started;assert.equal(entry.plan.question,undefined);
  const prepared=prepareAgentPlan(source,entry.plan.actions),expected=structuredClone(source);
  if(id==='mixer-rename'){
   expected.tracks.find(t=>t.name==='Drums').mute=true;
   expected.tracks.find(t=>t.name==='Bass').solo=true;
   expected.tracks.find(t=>t.name==='Keys').name='Pad Keys';
   assert.ok(isDeepStrictEqual(prepared.next,expected),'Mixer and rename result differs from exactly requested project');assert.equal(prepared.before.length+prepared.after.length,0);
  }else if(id==='remove-track'){
   const lead=expected.tracks.find(t=>t.name==='Core Lead');
   expected.tracks=expected.tracks.filter(t=>t.id!==lead.id);
   expected.arrangement=expected.arrangement.filter(r=>r.trackId!==lead.id);
   // Only now-unreferenced sources belonging to the removed track may disappear.
   const candidates=new Set([...lead.slots,...source.arrangement.filter(r=>r.trackId===lead.id).map(r=>r.clipId)].filter(Boolean));
   const retained=new Set([...expected.tracks.flatMap(t=>t.slots),...expected.arrangement.map(r=>r.clipId)]);
   for(const clip of candidates)if(!retained.has(clip))delete expected.clips[clip];
   assert.ok(isDeepStrictEqual(prepared.next,expected),'Track removal must remove the complete track and only its owned, unreferenced content');assert.equal(prepared.before.length+prepared.after.length,0);
  }else{
   assert.ok(isDeepStrictEqual(prepared.next,expected),'Transport must not edit project contents');assert.equal(prepared.editCount,0);
   assert.deepEqual(prepared.after,[{name:'view',args:{view:'arrangement'}},{name:'seek',args:{beat:32}},{name:'play',args:{from:'marker'}}]);
  }
  entry.passed=true;console.log(JSON.stringify({id,passed:true,elapsedMs:entry.elapsedMs}));
 }catch(error){entry.passed=false;entry.error=error.message;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');throw error;}
 await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
}
proof.passed=true;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
