import test from 'node:test';
import assert from 'node:assert/strict';
import {sendPlanningRequest} from '../runtime/planning-provider.mjs';
import {studioAgent} from '../runtime/studio-agent.mjs';
import {validateProductionBrief,createBriefSession} from '../../../web-studio/production-brief.js';
import {measureProductionPCM,analysisRange,readRenderedFloatWave} from '../../../web-studio/production-analysis.js';
import {encodeWave} from '../../../web-studio/wav-export.js';
import {applicationTemplate} from '../application.mjs';
const brief={intent:'mix',goal:'Punchy drums; intimate vocal',reference:'Dave Pensado',referenceState:'requested',constraints:['Preserve vocal level'],assumptions:[],nextStep:'Ask which reference and qualities matter.'};
const plan={summary:'Clarify the reference',question:'Which recording and what qualities matter to you?',actions:[],brief};
const envelope=p=>({output:{message:{content:[{toolUse:{name:'submit_plan',input:p}}]}}});
const command={input:{system:[{text:'Plan only'}],messages:[{content:[{text:'Synthetic session'}]}],toolConfig:{tools:[{toolSpec:{name:'submit_plan',description:'Plan',inputSchema:{json:{type:'object'}}}}]}}};
test('brief validates evidence, survives follow-ups, and cannot leak to a different set',()=>{
 assert.throws(()=>validateProductionBrief({...brief,referenceState:'analyzed'}));
 assert.throws(()=>validateProductionBrief({...brief,referenceState:'none'}));
 assert.throws(()=>validateProductionBrief({...brief,execute:'code'}));
 const m=createBriefSession(),p={tracks:[{id:'a'}]};m.remember(p,brief);m.remember(p,{...brief,intent:'edit'});assert.deepEqual(m.read(p),brief);
 const copy=m.read(p);copy.constraints.push('different');assert.equal(m.read(p).constraints.length,1);
 assert.equal(m.read({tracks:[{id:'b'}]}),null);m.remember(p,brief);m.clear();assert.equal(m.read(p),null);
});
test('focused brief interpretation precedes planning, grounds first references, and leaves legacy clients compatible',async()=>{
 process.env.STUDIO_AGENT_MODEL_ID='test-model';
 const body={prompt:'Make this mix sound like a Dave Pensado mix',context:{project:{tracks:[]},productionBrief:{version:1,previous:null}}};
 let calls=0;const result=await studioAgent(body,{send:async c=>{calls++;assert.ok(c.input.toolConfig.tools[0].toolSpec.inputSchema.json.required.includes('brief'));return envelope({brief:{...brief,referenceState:'described'},question:''});}});
 assert.equal(calls,1);assert.equal(result.brief.referenceState,'requested');assert.match(result.question,/recording/);assert.equal(result.actions.length,0);
 await assert.rejects(()=>studioAgent(body,{send:async()=>envelope({...plan,brief:undefined})}),e=>e.code==='invalid_agent_plan');
 calls=0;const generic={...body,prompt:'Warm the bass',context:{...body.context,productionBrief:{version:1,previous:brief}}};
 const retained={...brief,reference:'',referenceState:'none'};
 const reviewed=await studioAgent(generic,{send:async c=>{if(calls++===0)return envelope({brief:retained,question:''});assert.deepEqual(JSON.parse(c.input.messages[0].content[0].text).session.productionIntent,retained);return envelope({summary:'No changes',actions:[]});}});
 assert.equal(calls,3);assert.deepEqual(reviewed.brief,retained);assert.equal(reviewed.reviewed,true);
 const legacy=await studioAgent({...body,context:{project:{tracks:[]}}},{send:async()=>envelope({summary:'Need detail',question:'Which recording?',actions:[]})});assert.equal(legacy.brief,undefined);
});
test('OpenAI and Gemini enforce one tool, fixed endpoints, cancellation and server-only credentials',async()=>{
 for(const provider of ['openai','gemini']){
  const signal=new AbortController().signal;let calls=0;
  const output=await sendPlanningRequest(command,{abortSignal:signal},{env:{STUDIO_AGENT_PROVIDER:provider,STUDIO_AGENT_MODEL_ID:'test-model',OPENAI_API_KEY:'unit-secret',GEMINI_API_KEY:'unit-secret'},fetcher:async(url,options)=>{
   calls++;assert.equal(options.signal,signal);assert.equal(options.redirect,'error');assert.ok(!url.includes('unit-secret'));assert.ok(!options.body.includes('unit-secret'));
   const body=JSON.parse(options.body);if(provider==='openai'){assert.equal(body.store,false);assert.equal(body.parallel_tool_calls,false);assert.equal(options.headers.Authorization,'Bearer unit-secret');}else{assert.equal(body.toolConfig.functionCallingConfig.mode,'ANY');assert.equal(options.headers['x-goog-api-key'],'unit-secret');}
   return {ok:true,json:async()=>provider==='openai'?{status:'completed',output:[{type:'function_call',name:'submit_plan',arguments:JSON.stringify(plan)}]}:{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'submit_plan',args:plan}}]}}]}};
  }});assert.equal(calls,1);assert.deepEqual(output.output.message.content[0].toolUse.input,plan);
 }
});
test('provider failures do not retry, fallback, expose error bodies, or accept partial plans',async()=>{
 const env={STUDIO_AGENT_PROVIDER:'openai',STUDIO_AGENT_MODEL_ID:'test',OPENAI_API_KEY:'unit-secret'};let calls=0;
 await assert.rejects(()=>sendPlanningRequest(command,{}, {env,fetcher:async()=>{calls++;return {ok:false,status:401,text:()=>{throw Error('must not read private error');}};}}),e=>e.code==='agent_provider_error'&&!e.message.includes('unit-secret'));assert.equal(calls,1);
 for(const output of [[],[{type:'function_call',name:'wrong',arguments:'{}'}],[{type:'function_call',name:'submit_plan',arguments:'bad-json'}],Array(2).fill({type:'function_call',name:'submit_plan',arguments:'{}'})])await assert.rejects(()=>sendPlanningRequest(command,{}, {env,fetcher:async()=>({ok:true,json:async()=>({status:'completed',output})})}),e=>e.code==='invalid_agent_plan');
 await assert.rejects(()=>sendPlanningRequest(command,{}, {env:{STUDIO_AGENT_PROVIDER:'anthropic'}}),e=>e.code==='agent_not_configured');
 const partial=await sendPlanningRequest(command,{}, {env,fetcher:async()=>({ok:true,json:async()=>({status:'incomplete',output:[{type:'function_call',name:'submit_plan',arguments:JSON.stringify(plan)}]})})});assert.equal(partial.stopReason,'max_tokens');
});
test('external deployment scopes credential access and never places a key in its environment',async()=>{
 const args={outputs:{},account:'368310207026',region:'us-east-1',codeKey:'test',image:`368310207026.dkr.ecr.us-east-1.amazonaws.com/opusloops/stem-worker@sha256:${'a'.repeat(64)}`},secretArn='arn:aws:secretsmanager:us-east-1:368310207026:secret:opusloops/ai/openai-ABC123';
 const t=applicationTemplate({...args,planner:{provider:'openai',model:'test-model',secretArn}}),env=t.Resources.ApiFunction.Properties.Environment.Variables,policy=t.Resources.ApiRole.Properties.Policies[0].PolicyDocument.Statement;
 assert.equal(env.STUDIO_AGENT_API_SECRET_ARN,secretArn);assert.equal(env.OPENAI_API_KEY,undefined);assert.ok(!policy.some(p=>p.Action==='bedrock:InvokeModel'));assert.ok(policy.some(p=>p.Action==='secretsmanager:GetSecretValue'&&p.Resource===secretArn));
 assert.throws(()=>applicationTemplate({...args,planner:{provider:'gemini',model:'test',secretArn:'arn:unrelated'}}));
 let read=false;await sendPlanningRequest(command,{}, {env,getSecret:async arn=>{assert.equal(arn,secretArn);read=true;return {OPENAI_API_KEY:'private-test'};},fetcher:async(_,options)=>{assert.equal(options.headers.Authorization,'Bearer private-test');return {ok:true,json:async()=>({status:'completed',output:[{type:'function_call',name:'submit_plan',arguments:JSON.stringify(plan)}]})};}});assert.equal(read,true);
});
const tone=(hz,amp=0.5)=>Float32Array.from({length:44100},(_,i)=>amp*Math.sin(2*Math.PI*hz*i/44100));
test('PCM measurements match independent sine and stereo oracles',()=>{
 const wave=tone(1000),m=measureProductionPCM([wave,wave],44100);assert.ok(Math.abs(m.rmsDB-20*Math.log10(.5/Math.sqrt(2)))<.001);assert.ok(Math.abs(m.crestDB-3.0103)<.001);assert.equal(m.stereoCorrelation,1);assert.equal(m.sideEnergyRatio,0);assert.equal(m.clippedSamples,0);
 const inverted=measureProductionPCM([wave,wave.map(x=>-x)],44100);assert.equal(inverted.stereoCorrelation,-1);assert.equal(inverted.sideEnergyRatio,1);
 const low=measureProductionPCM([tone(50)],44100),high=measureProductionPCM([tone(12000)],44100);assert.ok(low.bandEnergyFractions[0]>high.bandEnergyFractions[0]);assert.ok(high.bandEnergyFractions[4]>low.bandEnergyFractions[4]);
 const silence=measureProductionPCM([new Float32Array(8000)],8000);assert.equal(silence.rmsDB,-120);assert.equal(silence.stereoCorrelation,null);assert.equal(silence.crestDB,null);
 assert.throws(()=>measureProductionPCM([Float32Array.of(NaN)],44100));assert.throws(()=>measureProductionPCM([new Float32Array(44100*62)],44100));
});
test('internal float WAV round trip is exact and analysis never substitutes Session audio',()=>{
 const data=tone(440),bytes=encodeWave({sampleRate:44100,length:data.length,numberOfChannels:1,getChannelData:()=>data},{bitDepth:32});const decoded=readRenderedFloatWave(bytes);assert.deepEqual(decoded.channels[0],data);assert.equal(decoded.sampleRate,44100);assert.throws(()=>readRenderedFloatWave(new ArrayBuffer(10)));
 assert.equal(analysisRange({bpm:120,arrangement:[]}),null);assert.equal(analysisRange({bpm:120,arrangement:[{active:false,start:0,length:500}]}),null);
 assert.deepEqual(analysisRange({bpm:120,arrangement:[{start:0,length:500}]}),{start:0,length:32});assert.deepEqual(analysisRange({bpm:20,arrangement:[{start:0,length:500}]}),{start:0,length:20});
});
