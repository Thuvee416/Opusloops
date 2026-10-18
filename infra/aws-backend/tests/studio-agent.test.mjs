import test from 'node:test';import assert from 'node:assert/strict';import {studioAgent} from '../runtime/studio-agent.mjs';
process.env.STUDIO_AGENT_MODEL_ID='test-model';
const body={prompt:'Mix my stems',context:{project:{tracks:[]}}};
test('model receives bounded tool contract and returns intentions without execution',async()=>{const p=await studioAgent(body,{send:async c=>{assert.equal(c.input.modelId,'test-model');assert.ok(c.input.toolConfig.tools[0].toolSpec.inputSchema.json);return {output:{message:{content:[{toolUse:{name:'submit_plan',input:{summary:'Need stems',question:'Please import stems first.',actions:[{type:'track',args:'{}'}]}}}]}}};}});assert.deepEqual(p.actions,[]);assert.ok(p.question);});
test('rejects oversized inputs, malformed plans and truncated model output',async()=>{await assert.rejects(()=>studioAgent({...body,prompt:'x'.repeat(3001)}));for(const response of [{output:{message:{content:[]}}},{stopReason:'max_tokens',output:{message:{content:[]}}},{output:{message:{content:[{toolUse:{name:'submit_plan',input:{summary:'x',actions:[{type:'track',args:42}]}}}]}}}])await assert.rejects(()=>studioAgent(body,{send:async()=>response}));});
const response=plan=>({output:{message:{content:[{toolUse:{name:'submit_plan',input:plan}}]}}});
test('review replaces a semantically wrong draft before any intentions reach the client',async()=>{
 const draft={summary:'Created return',actions:[{type:'add_track',args:{name:'Room'}}]},reviewed={summary:'Create Room return',actions:[{type:'add_return',args:{name:'Room'}}]};let calls=0;
 const result=await studioAgent({prompt:'Create a return named Room',context:body.context},{send:async(c,options)=>{assert.ok(options.abortSignal instanceof AbortSignal);const data=JSON.parse(c.input.messages[0].content[0].text);if(calls++===0){assert.equal(data.draft,undefined);return response(draft);}assert.deepEqual(data.draft,draft);assert.match(c.input.system[0].text,/COMPLETE replacement/);assert.equal(data.request,'Create a return named Room');return response(reviewed);}});
 assert.equal(calls,2);assert.deepEqual(result.actions,reviewed.actions);assert.equal(result.reviewed,true);
});
test('an invalid, truncated, failed or timed-out review never falls back to its draft',async()=>{
 for(const failure of ['truncated','malformed','provider','timeout']){let calls=0;await assert.rejects(()=>studioAgent(body,{send:async()=>{if(calls++===0)return response({summary:'Draft edit',actions:[{type:'project',args:{bpm:123}}]});if(failure==='truncated')return {stopReason:'max_tokens'};if(failure==='malformed')return response({summary:'Bad review',actions:42});throw Object.assign(new Error('Provider interrupted'),{name:failure==='timeout'?'AbortError':'ServiceUnavailableException'});}}),error=>failure==='timeout'?error.code==='agent_timeout':true);assert.equal(calls,2);}
});
test('a reviewed clarification removes all actions and a draft clarification needs no second model call',async()=>{
 let calls=0;const draft={summary:'Draft',actions:[{type:'project',args:{bpm:123}}]},question={summary:'Need detail',question:'Which tempo?',actions:draft.actions};
 const result=await studioAgent(body,{send:async()=>response(calls++?question:draft)});assert.deepEqual(result.actions,[]);assert.equal(result.question,'Which tempo?');assert.equal(result.reviewed,true);
 calls=0;const clarification=await studioAgent(body,{send:async()=>{calls++;return response(question);}});assert.equal(calls,1);assert.deepEqual(clarification.actions,[]);
});
test('native invalid ToolUse during review is repairable without releasing the draft',async()=>{
 let calls=0;await assert.rejects(()=>studioAgent(body,{send:async()=>{if(calls++===0)return response({summary:'Draft',actions:[{type:'project',args:{bpm:123}}]});throw Object.assign(new Error('Model produced invalid sequence as part of ToolUse.'),{name:'ValidationException'});}}),e=>e.code==='invalid_agent_plan'&&e.status===502);assert.equal(calls,2);
});
test('draft and review receive current explicit shared delivery requirements rather than stale session metadata',async()=>{
 let calls=0;const prompt='Export a WAV and a stem ZIP at 48 kHz, 24-bit, range start 6 length 4, no effect tails and no normalization for every export.';
 const result=await studioAgent({prompt,context:{...body.context,requestedDelivery:{settings:{range:{start:0,length:16}}}}},{send:async c=>{const data=JSON.parse(c.input.messages[0].content[0].text);assert.deepEqual(data.requestedDelivery.settings.range,{start:6,length:4});assert.equal(data.requestedDelivery.settings.sampleRate,48000);assert.equal(data.requestedDelivery.scope,'shared');assert.deepEqual(new Set(data.requestedDelivery.requiredFormats),new Set(['wav','stems']));assert.match(c.input.system[0].text,/EVERY audio export command/);calls++;return response({summary:'Export with checked settings',actions:[]});}});
 assert.equal(calls,2);assert.equal(result.reviewed,true);
});
test('contradictory explicit shared delivery settings fail before any provider invocation',async()=>{
 let calls=0;await assert.rejects(()=>studioAgent({prompt:'Export WAV and ZIP at 44.1 kHz and 48 kHz for every export.',context:body.context},{send:async()=>{calls++;return response({summary:'Wrong',actions:[]});}}),e=>e.code==='invalid_delivery_request'&&e.status===400);assert.equal(calls,0);
});
