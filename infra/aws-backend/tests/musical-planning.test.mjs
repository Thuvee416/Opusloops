import test from 'node:test';
import assert from 'node:assert/strict';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';
import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {emptyProject} from '../../../web-studio/model.js';
import {musicalModelInput} from '../runtime/musical-planning.mjs';
process.env.STUDIO_AGENT_MODEL_ID='test-model';
const response=plan=>({output:{message:{content:[{toolUse:{name:'submit_plan',input:plan}}]}}});
const plan={summary:'Create four bars and adjust Bass',actions:[
 {type:'add_track',args:{ref:'$lead',name:'Core Lead',kind:'original'}},
 {type:'midi',args:{ref:'$phrase',name:'Core Phrase',trackId:'$lead',sceneNumber:3,beats:{bars:4},notes:[60,64,67,71].map((pitch,i)=>({pitch,start:{bar:i+1,beat:1},duration:{beats:.5},velocity:.7}))}},
 {type:'region',args:{trackId:'$lead',clipId:'$phrase',start:{bar:9},length:{bars:4}}},
 {type:'track',args:{id:'bass',changes:{volume:{relativeDb:-3}}}},
 {type:'project',args:{bpm:128}}
]};
const project=()=>{const p=emptyProject();p.tracks[0].id='bass';p.tracks[0].name='Bass';return p;};
test('draft/review receive typed units and Original tone; returned plan produces independently expected music',async()=>{
 const p=project(),context=agentContext(p),before=structuredClone(context);let calls=0;
 const result=await studioAgent({prompt:'Create four bars with notes on bars 1 2 3 4 in scene 3 using Original tone. Place at bar 9 for four bars. Reduce Bass by 3 dB and set tempo 128.',context},{send:async c=>{
  const input=JSON.parse(c.input.messages[0].content[0].text),a=c.input.toolConfig.tools[0].toolSpec.inputSchema.json.properties.actions.items.properties.args.properties;
  assert.equal(a.beats.type,'object');assert.ok(a.beats.properties.bars);assert.equal(a.notes.items.properties.start.properties.bar.minimum,1);assert.ok(a.changes.properties.volume.properties.relativeDb);assert.ok(a.kind.enum.includes('original'));assert.equal(a.grid.type,'number');assert.equal(a.changes.properties.audioEdit.properties.fadeIn.type,'number');assert.equal(a.params.properties.start.type,'number');
  assert.deepEqual(input.session.project.tracks[0].volume,{linear:.7});assert.deepEqual(input.session.project.tracks[0].instrumentSelection,{kind:'original',name:'Original tone'});assert.match(c.input.system[0].text,/Original tone is kind:original/);assert.doesNotMatch(c.input.system[0].text,/beat positions, Arrangement time and offsets remain zero-based/);if(calls++)assert.ok(input.draft);return response(plan);
 }});
 assert.equal(calls,2);assert.deepEqual(context,before);assert.deepEqual(result.actions,plan.actions);
 const next=prepareAgentPlan(p,result.actions).next,lead=next.tracks.find(t=>t.name==='Core Lead'),clip=next.clips[lead.slots[2]],region=next.arrangement.find(r=>r.clipId===clip.id);
 assert.equal(lead.instrument,undefined);assert.equal(clip.beats,16);assert.deepEqual(clip.notes.map(n=>n.start),[0,4,8,12]);assert.deepEqual(clip.notes.map(n=>n.duration),[.5,.5,.5,.5]);assert.equal(region.start,32);assert.equal(region.length,16);assert.equal(next.tracks[0].volume,.7*10**(-3/20));assert.equal(next.bpm,128);
});
test('old clients retain numeric schema; new clients reject reviewed numeric or mixed-unit ambiguity',async()=>{
 for(const modern of [false,true]){const context=agentContext(project());if(!modern)delete context.musicalUnits;let calls=0;
  const task=()=>studioAgent({prompt:'Make a clip',context},{send:async c=>{const a=c.input.toolConfig.tools[0].toolSpec.inputSchema.json.properties.actions.items.properties.args.properties;assert.equal(a.beats.type,modern?'object':'number');calls++;return response({summary:'Make',actions:[{type:'midi',args:{trackId:'bass',sceneNumber:1,name:'Phrase',beats:4,notes:[]}}]});}});
  if(modern)await assert.rejects(task,e=>e.code==='invalid_agent_plan'&&/explicit units/.test(e.message));else assert.equal((await task()).actions[0].args.beats,4);assert.equal(calls,2);
 }
 for(const bad of [{type:'track',args:{id:'bass',changes:{volume:.7}}},{type:'region',args:{start:{bar:0}}},{type:'midi',args:{beats:{bars:1,beats:4}}}])await assert.rejects(()=>studioAgent({prompt:'Edit',context:agentContext(project())},{send:async()=>response({summary:'Edit',actions:[bad]})}),e=>e.code==='invalid_agent_plan');
});
test('presentation preserves exact metadata/effect units and binds explicit export ranges only once',async()=>{
 const p=project();p.clips.x={id:'x',kind:'midi',sourceBpm:120,name:'bar 9',beats:16,notes:[{pitch:60,start:4,duration:.5,velocity:.7}]};p.arrangement=[{id:'r',clipId:'x',trackId:'bass',start:32,length:16,offset:0}];p.tracks[0].automation={volume:{enabled:true,points:[{beat:4,value:.2,curve:'linear'}]}};
 const input={session:agentContext(p),requestedDelivery:{settings:{range:{start:32,length:16}}}},before=structuredClone(input),out=musicalModelInput(input);
 assert.deepEqual(input,before);assert.deepEqual(out.requestedDelivery.settings.range,{start:{beat:33},length:{beats:16}});assert.equal(out.session.project.clips.x.name,'bar 9');assert.deepEqual(out.session.project.clips.x.notes[0].start,{beat:5});assert.deepEqual(out.session.project.tracks[0].automation.volume.points[0].beat,{beat:5});
 let calls=0;const result=await studioAgent({prompt:'Export a WAV at range start 32 length 16 without tails.',context:agentContext(p)},{send:async c=>{const payload=JSON.parse(c.input.messages[0].content[0].text);assert.deepEqual(payload.requestedDelivery.settings.range,{start:{beat:33},length:{beats:16}});calls++;return response({summary:'Export range',actions:[{type:'command',args:{name:'export_wav',args:{...payload.requestedDelivery.settings}}}]});}});assert.equal(calls,2);
 assert.deepEqual(prepareAgentPlan(p,result.actions).after[0].args.range,{start:32,length:16});
});
test('typed note filters and patches validate through the same editor before return',async()=>{
 const p=project();p.clips.x={id:'x',kind:'midi',sourceBpm:120,name:'Phrase',beats:16,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};p.tracks[0].slots[0]='x';
 const actions=[{type:'notes',args:{clipId:'x',action:'update',where:{start:{bar:1},end:{bar:2}},patch:{start:{bar:2},duration:{beats:.5}}}}];
 const result=await studioAgent({prompt:'Move the first-bar notes to bar 2 and make them half a beat.',context:agentContext(p)},{send:async()=>response({summary:'Move notes',actions})});
 const next=prepareAgentPlan(p,result.actions).next;assert.equal(next.clips.x.notes[0].start,4);assert.equal(next.clips.x.notes[0].duration,.5);assert.deepEqual(result.actions,actions);
});
test('mixed track and clip properties have disjoint schema branches and shared scope validation',async()=>{
 for(const changes of [{volume:{relativeDb:-3}},{pan:.2}]){
  let calls=0;await assert.rejects(()=>studioAgent({prompt:'Reduce Bass by 3 dB and pan Keys 20% right.',context:agentContext(project())},{send:async c=>{const schema=c.input.toolConfig.tools[0].toolSpec.inputSchema.json,branches=schema.properties.actions.items.oneOf,clip=branches.find(b=>b.properties.type.enum.includes('clip_properties')),track=branches.find(b=>b.properties.type.enum.includes('track'));assert.equal(clip.properties.args.properties.changes.additionalProperties,false);assert.equal(clip.properties.args.properties.changes.properties.volume,undefined);assert.ok(track.properties.args.properties.changes.properties.volume.properties.relativeDb);assert.ok(track.properties.args.required.includes('id'));assert.match(c.input.system[0].text,/TRACK MIXER/);calls++;return response({summary:'Bad scope',actions:[{type:'clip_properties',args:{ids:['bass'],changes}}]});}}),e=>e.code==='invalid_agent_plan'&&/Mixer Changes Use type:track/.test(e.message));assert.equal(calls,2);
 }
});
