// Provider adapters return one common tool envelope. No browser keys, arbitrary URLs,
// automatic provider fallback or automatic paid retries.
import {ApiError} from './common.mjs';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
const secrets=new SecretsManagerClient({maxAttempts:1});
let cached=null;
async function readProviderSecret(arn,signal){
 if(cached?.arn===arn&&cached.expires>Date.now())return cached.value;
 try{const result=await secrets.send(new GetSecretValueCommand({SecretId:arn}),{abortSignal:signal});const value=JSON.parse(result.SecretString);cached={arn,value,expires:Date.now()+300000};return value;}
 catch(error){if(signal?.aborted)throw signal.reason;throw new ApiError(503,'agent_not_configured','The planning provider credential could not be loaded.');}
}
export async function sendPlanningRequest(command,options={}, {bedrock,fetcher=fetch,env=process.env,getSecret=readProviderSecret}={}){
 const provider=env.STUDIO_AGENT_PROVIDER||'bedrock',input=command.input;
 if(provider==='bedrock')return bedrock(command,options);
 if(!['openai','gemini'].includes(provider))throw new ApiError(503,'agent_not_configured','Unknown planning provider.');
 const model=env.STUDIO_AGENT_MODEL_ID,credentials=env.STUDIO_AGENT_API_SECRET_ARN?await getSecret(env.STUDIO_AGENT_API_SECRET_ARN,options.abortSignal):env,key=provider==='openai'?credentials.OPENAI_API_KEY:(credentials.GEMINI_API_KEY||credentials.GOOGLE_API_KEY);
 if(!key)throw new ApiError(503,'agent_not_configured','The selected planning provider is not configured.');
 const tool=input.toolConfig.tools[0].toolSpec,system=input.system.map(x=>x.text).join('\n'),prompt=input.messages[0].content[0].text;
 let url,headers,body;
 if(provider==='openai'){
  url='https://api.openai.com/v1/responses';headers={Authorization:'Bearer '+key};
  body={model,store:false,instructions:system,input:prompt,reasoning:{effort:'medium'},max_output_tokens:16000,tools:[{type:'function',name:tool.name,description:tool.description,parameters:tool.inputSchema.json,strict:false}],tool_choice:{type:'function',name:tool.name},parallel_tool_calls:false};
 }else{
  if(!/^[a-zA-Z0-9._-]+$/.test(model))throw new ApiError(503,'agent_not_configured','Invalid model identifier.');
  url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent';headers={'x-goog-api-key':key};
  body={systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:prompt}]}],tools:[{functionDeclarations:[{name:tool.name,description:tool.description,parametersJsonSchema:tool.inputSchema.json}]}],toolConfig:{functionCallingConfig:{mode:'ANY',allowedFunctionNames:[tool.name]}},generationConfig:{maxOutputTokens:16000}};
 }
 const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:options.abortSignal,redirect:'error'});
 if(!response.ok)throw new ApiError(response.status===429?429:502,'agent_provider_error','Planning provider returned HTTP '+response.status+'. No plan was applied.');
 const data=await response.json();let calls,limited=false;
 if(provider==='openai'){
  limited=data.status!=='completed';calls=(data.output||[]).filter(x=>x.type==='function_call').map(x=>{let args;try{args=JSON.parse(x.arguments);}catch{throw new ApiError(502,'invalid_agent_plan','Provider returned invalid tool JSON.');}return {toolUse:{name:x.name,input:args}};});
 }else{
  const candidate=data.candidates?.[0];limited=data.candidates?.length!==1||candidate?.finishReason!=='STOP';calls=(candidate?.content?.parts||[]).filter(x=>x.functionCall).map(x=>({toolUse:{name:x.functionCall.name,input:x.functionCall.args}}));
 }
 if(calls.length!==1||calls[0].toolUse.name!=='submit_plan')throw new ApiError(502,'invalid_agent_plan','Provider must return exactly one complete plan.');
 return {stopReason:limited?'max_tokens':'tool_use',output:{message:{content:calls}}};
}
