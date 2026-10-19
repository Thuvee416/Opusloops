// Operator-IAM provider check, not authenticated Studio execution evidence.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {coreSongProject} from '../../../tests/fixtures/core-song-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const project=process.env.OPUS_MUSICAL_SOURCE?JSON.parse(await readFile(process.env.OPUS_MUSICAL_SOURCE,'utf8')):coreSongProject().project;
const prompt='Add a MIDI track named Core Lead using Original tone. Create a four-bar clip named Core Phrase in scene 3. Play C4, E4, G4 and B4 on the first beat of bars 1, 2, 3 and 4 respectively, each half a beat long at velocity 70%. Place that same clip in the Arrangement at bar 9 for four bars. Reduce Bass by 3 dB, pan Keys 20% right and set the project tempo to 128 BPM. Preserve all existing clips, instruments, effects and arrangement regions. Do not start playback or export.';
const context={...agentContext(project),studio:{view:'session',playing:false,position:0,insertMarker:0}},client=new BedrockRuntimeClient(awsOptions),started=Date.now();
const plan=await studioAgent({prompt,context},{budgetMs:110000,send:(c,o)=>client.send(c,o),onPhase:async phase=>console.log(phase)});
if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({scope:'Operator-IAM real provider, not Studio execution',prompt,plan,elapsedMs:Date.now()-started},null,2)+'\n');
assert.equal(plan.question,undefined);const compiled=prepareAgentPlan(project,plan.actions),next=compiled.next,lead=next.tracks.find(t=>t.name==='Core Lead');
assert.ok(lead);assert.equal(lead.instrument,undefined);assert.equal(next.tracks.length,project.tracks.length+1);assert.equal(next.bpm,128);assert.equal(compiled.before.length+compiled.after.length,0);
const clip=next.clips[lead.slots[2]],region=next.arrangement.find(r=>r.clipId===clip?.id);assert.ok(clip);assert.equal(clip.name,'Core Phrase');assert.equal(clip.beats,16);assert.deepEqual(clip.notes.map(n=>[n.pitch,n.start,n.duration,n.velocity]),[[60,0,.5,.7],[64,4,.5,.7],[67,8,.5,.7],[71,12,.5,.7]]);assert.ok(region);assert.equal(region.start,32);assert.equal(region.length,16);assert.equal(region.trackId,lead.id);
for(const t of project.tracks){const expected=structuredClone(t);if(t.name==='Bass')expected.volume=t.volume*10**(-3/20);if(t.name==='Keys')expected.pan=.2;assert.deepEqual(next.tracks.find(x=>x.id===t.id),expected);}
for(const [id,c]of Object.entries(project.clips))assert.deepEqual(next.clips[id],c);assert.equal(Object.keys(next.clips).length,Object.keys(project.clips).length+1);assert.equal(next.arrangement.length,project.arrangement.length+1);for(const r of project.arrangement)assert.deepEqual(next.arrangement.find(x=>x.id===r.id),r);
for(const [key,value]of Object.entries(project))if(!['tracks','clips','arrangement','bpm'].includes(key))assert.deepEqual(next[key],value);
console.log(JSON.stringify({passed:true,actions:plan.actions.length,elapsedMs:Date.now()-started,scope:'Real provider plus independent compiled-project assertions; not authenticated execution'}));
