// Operator-IAM model planning only; application execution is checked separately.
import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {assertAccount,awsOptions} from './aws.mjs';import {studioAgent} from '../runtime/studio-agent.mjs';
import {agentContext} from '../../../web-studio/agent-actions.js';import {prepareAgentPlan} from '../../../web-studio/agent-runner.js';
import {selectionIntent} from '../../../web-studio/studio-selection.js';
import {sourceProject} from '../../../tests/fixtures/agent-compose-delivery.mjs';
import {selectionProject} from '../../../tests/fixtures/agent-selection-project.mjs';
await assertAccount();process.env.STUDIO_AGENT_MODEL_ID='amazon.nova-pro-v1:0';
const empty=sourceProject();empty.returns=[];
const project=selectionProject(),context={...agentContext(project),studio:{view:'arrangement',selection:{trackId:'pad',clipId:'chord'},selectedRegions:['pad-a'],selectedRegion:'pad-a',deviceTrackId:'pad',detailPanel:'devices',detailExpanded:false,playing:false,position:0}},client=new BedrockRuntimeClient(awsOptions),cases=[];
function selected(compiled,target,panel='clip'){
 let selection=null,visiblePanel=null;
 for(const command of compiled.after){
  if(command.name==='select'){selection=command;visiblePanel=command.args.target==='track'?'devices':'clip';}
  else if(command.name==='show_panel')visiblePanel=command.args.panel;
  else throw new Error('Selection must not start playback, export or perform another runtime operation.');
 }
 assert.ok(selection,'Select the requested object.');assert.equal(selection.args.target,target);
 if(visiblePanel!==panel)throw new Error('The user requested '+panel+' detail, but the final navigation would show '+visiblePanel+'. select already opens its default panel; finish with the requested panel.');
 return selection;
}
const specs=[
 ['clip','Select the Four-note bass Session clip on Bass in displayed scene 2 and open its Clip detail. Do not launch it, start playback, change notes, or edit the project.',compiled=>{assert.equal(compiled.editCount,0);assert.deepEqual(selectionIntent(project,selected(compiled,'clip').args),{target:'clip',trackId:'bass',clipId:'riff',scene:1});} ],
 ['regions','Select both Bass Arrangement clips, at zero-based beats 0 and 128, with the later clip primary. Show their Clip detail and reveal the clips. Do not select the Pad clip, start playback or edit music.',compiled=>{assert.equal(compiled.editCount,0);const selection=selected(compiled,'regions');assert.deepEqual(new Set(selection.args.ids),new Set(['bass-a','bass-b']));assert.equal(selection.args.primaryId,'bass-b');}],
 ['return','Show the Room return track devices, then open the Returns detail panel. Do not edit the project, connect inputs or start playback.',compiled=>{assert.equal(compiled.editCount,0);assert.equal(selected(compiled,'track','returns').args.trackId,'room');}],
 ['compose','Create a new Bright pluck track named New lead. Create a four-beat MIDI clip on that track in scene 1 (displayed) with pitches 72, 76, 79 at beats 0, 1, 2, each one beat at velocity 0.6. Place it in the Arrangement at zero-based beat 64 for four beats, then select that new Arrangement region and show its Clip detail. Preserve all existing material and do not start playback.',compiled=>{assert.equal(compiled.next.tracks.length,3);const track=compiled.next.tracks[2];assert.equal(track.name,'New lead');const region=compiled.next.arrangement.find(r=>r.trackId===track.id);assert.equal(region.start,64);assert.equal(region.length,4);const clip=compiled.next.clips[region.clipId];if(track.slots[0]!==clip.id)throw new Error('The user requested displayed scene 1 for the new MIDI clip; midi.args.scene must be 0, not 1.');assert.deepEqual(clip.notes,[72,76,79].map((pitch,start)=>({pitch,start,duration:1,velocity:.6})));assert.deepEqual(selected(compiled,'regions').args.ids,[region.id]);assert.deepEqual(compiled.next.tracks.slice(0,2),project.tracks);}],
 ['named_group','Create a Warm bass track named Navigation Proof and a return named Navigation Room. On Navigation Proof, create Navigation A in displayed scene 1 and Navigation B in displayed scene 2. Each MIDI clip must be four beats with pitches 36, 39, 41, 43 at zero-based starts 0, 1, 2, 3, each lasting one beat at velocity 0.8. Place Navigation A in the Arrangement at zero-based beat 0 for four beats, and Navigation B at zero-based beat 128 for four beats. Select both of these Arrangement regions with Navigation B primary, reveal both, and open Clip detail. Preserve every existing track and all other existing material. Do not start playback.',(compiled,source)=>{
  const p=compiled.next,track=p.tracks.at(-1);assert.deepEqual(p.tracks.slice(0,-1),source.tracks);assert.equal(p.tracks.length,source.tracks.length+1);assert.equal(track.name,'Navigation Proof');assert.equal(p.returns.length,source.returns.length+1);assert.equal(p.returns.at(-1).name,'Navigation Room');const regions=[];
  for(const [scene,name]of ['Navigation A','Navigation B'].entries()){const clip=p.clips[track.slots[scene]];assert.ok(clip,'Create the clip in displayed scene '+(scene+1)+' using zero-based scene '+scene);assert.equal(clip.name,name,'The named MIDI clip must include its exact display name in midi.args.name.');assert.equal(clip.beats,4);assert.deepEqual(clip.notes,[36,39,41,43].map((pitch,start)=>({pitch,start,duration:1,velocity:.8})));const region=p.arrangement.find(r=>r.clipId===clip.id);assert.equal(region.start,scene*128);assert.equal(region.length,4);regions.push(region);}
  const selection=selected(compiled,'regions');assert.deepEqual(new Set(selection.args.ids),new Set(regions.map(r=>r.id)));assert.equal(selection.args.primaryId??selection.args.ids[0],regions[1].id,'Navigation B must be primary.');
 }]
];
const capture=async()=>{if(process.env.OPUS_AGENT_CAPTURE)await writeFile(process.env.OPUS_AGENT_CAPTURE,JSON.stringify({model:process.env.STUDIO_AGENT_MODEL_ID,fixture:'tests/fixtures/agent-selection-project.mjs',sourceContext:context,cases},null,2)+'\n');};
for(const [kind,prompt,verify] of specs){
 if(process.env.OPUS_AGENT_CASE&&kind!==process.env.OPUS_AGENT_CASE)continue;
 const source=kind==='named_group'?empty:project,session=kind==='named_group'?{...agentContext(source),studio:{view:'session',selection:{trackId:source.tracks[0].id},selectedRegions:[],selectedRegion:null,deviceTrackId:source.tracks[0].id,detailPanel:'clip',detailExpanded:true,playing:false,position:0}}:context;
 let feedback=null;
 for(let attempt=1;attempt<=3;attempt++){
  let plan;
  try{plan=await studioAgent({prompt,context:session,feedback},{send:(c,options)=>client.send(c,options)});verify(prepareAgentPlan(source,plan.actions),source);cases.push({kind,prompt,attempt,plan,fixture:kind==='named_group'?'empty-project':'selection-project'});await capture();console.log(JSON.stringify({kind,attempt,validated:true}));break;}
  catch(error){
   await writeFile(new URL('../.operator/selection-'+kind+'-'+attempt+'.json',import.meta.url),JSON.stringify(plan??{error:error.message},null,2));console.log(JSON.stringify({kind,attempt,error:error.message}));
   if(plan)feedback={error:error.message,previousPlan:plan};
   if(attempt===3)throw error;
   if(!plan)await new Promise(resolve=>setTimeout(resolve,5000*attempt));
  }
 }
}
