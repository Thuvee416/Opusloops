import { awsCli,assertAccount,sourceQuery } from './aws.mjs';

await assertAccount();
const fence=await sourceQuery('SELECT frozen FROM private.opusloops_aws_cutover WHERE singleton=true');
if(fence[0]?.frozen!==true)throw new Error('Do not retire source hooks before the source write fence');
const stack=(await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-stem-worker')).Stacks[0];
const parameters=stack.Parameters.filter(row=>row.ParameterKey!=='LegacySupabaseEnabled').map(row=>({ParameterKey:row.ParameterKey,UsePreviousValue:true}));
parameters.push({ParameterKey:'LegacySupabaseEnabled',ParameterValue:'false'});
// Only the superseded callback/watchdog/retention functions, their roles and
// rules are removed. Existing worker queue, images, logs and data are retained.
const file=new URL('../../stem-worker/template.yaml',import.meta.url);
const result=await awsCli('cloudformation','update-stack','--stack-name','opusloops-stem-worker','--template-body',`file://${file.pathname}`,
  '--parameters',JSON.stringify(parameters),'--capabilities','CAPABILITY_IAM');
console.log(JSON.stringify({legacyHooks:'retirement-started',stackId:result.StackId}));
