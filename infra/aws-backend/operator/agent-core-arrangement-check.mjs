// Real provider planning with independent complete-project assertions.
// This does not replace authenticated native execution or listening checks.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
if(!process.env.OPUS_MUSICAL_SOURCE||!process.env.OPUS_AGENT_CAPTURE)throw Error('Set the synthetic pre-microphone source and proof output paths.');
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const source=JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8'));
const lead=source.tracks.find(t=>t.name==='Core Lead'),original=source.arrangement.find(r=>r.trackId===lead.id);
const client=new BedrockRuntimeClient(awsOptions),proof={scope:'Operator-IAM real provider and local preflight; not native authenticated production execution.',cases:[]};
const cases=[
 ['move-trim','Move the Core Phrase Arrangement clip two bars later, then trim one bar off its end. Keep its source notes and Session clip unchanged, and preserve all other tracks, clips and settings. Do not play or export.'],
 ['duplicate-delete','Duplicate the Core Phrase Arrangement clip immediately after itself, then delete only the original Arrangement region. Keep the Session clip and every other track and setting unchanged. Do not play or export.'],
 ['select','Select the Core Phrase Arrangement clip and show its Clip editor. Do not change any music, track settings or start playback.']
];
for(const [id,prompt]of cases){const entry={id,prompt};proof.cases.push(entry);
 try{
  const start=Date.now();entry.plan=await studioAgent({prompt,context:{...agentContext(source),studio:{view:'session',playing:false,position:0,insertMarker:0,recording:{active:false},sessionRecording:{active:false}}}},{budgetMs:110000,send:(c,o)=>client.send(c,o)});entry.elapsedMs=Date.now()-start;assert.equal(entry.plan.question,undefined);
  const compiled=prepareAgentPlan(source,entry.plan.actions),expected=structuredClone(source);
  if(id==='move-trim'){
   const region=expected.arrangement.find(r=>r.id===original.id);region.start=40;region.length=12;
   assert.ok(isDeepStrictEqual(compiled.next,expected),'Only Core Phrase should move by 8 beats and shorten by 4 beats, preserving its offset and source.');assert.equal(compiled.before.length+compiled.after.length,0);
  }else if(id==='duplicate-delete'){
   const next=compiled.next,newRegions=next.arrangement.filter(r=>!source.arrangement.some(o=>o.id===r.id));assert.equal(newRegions.length,1);const copy=newRegions[0],clip=next.clips[copy.clipId];
   assert.equal(copy.start,48);assert.equal(copy.length,16);assert.equal(copy.offset,original.offset);assert.equal(copy.trackId,lead.id);assert.notEqual(copy.clipId,original.clipId);
   assert.ok(isDeepStrictEqual({...clip,id:original.clipId,name:source.clips[original.clipId].name},source.clips[original.clipId]),'Copied MIDI content should be independent but identical.');
   expected.arrangement=expected.arrangement.filter(r=>r.id!==original.id);expected.arrangement.push(copy);expected.clips[clip.id]=clip;
   assert.ok(isDeepStrictEqual(next,expected),'Duplicate/delete must preserve every unmentioned project field.');assert.equal(compiled.before.length+compiled.after.length,0);
  }else{
   assert.ok(isDeepStrictEqual(compiled.next,source),'Selection must not change music.');assert.equal(compiled.editCount,0);
   assert.ok(compiled.after.some(c=>c.name==='select'&&c.args.target==='regions'&&isDeepStrictEqual(c.args.ids,[original.id])),'Select the exact Arrangement region.');
   assert.ok(compiled.after.some(c=>c.name==='show_panel'&&c.args.panel==='clip'),'Show the Clip editor.');
   assert.ok(compiled.after.every(c=>['select','show_panel','view'].includes(c.name)),'Selection must not start transport or other runtime operations.');
  }
  entry.passed=true;console.log(JSON.stringify({id,passed:true,elapsedMs:entry.elapsedMs}));
 }catch(error){entry.passed=false;entry.error=error.message;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');throw error;}
 await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
}
proof.passed=true;await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify(proof,null,2)+'\n');
