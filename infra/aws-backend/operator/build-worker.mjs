import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { awsCli,assertAccount } from './aws.mjs';

await assertAccount();
const {stdout}=await promisify(execFile)('git',['rev-parse','HEAD']);
const commit=stdout.trim();
const {stdout:remote}=await promisify(execFile)('git',['ls-remote','origin','refs/heads/main']);
if(!remote.startsWith(commit+'\t'))throw new Error('Worker build requires the exact published main commit');
const stack=(await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-stem-worker')).Stacks[0];
const parameters=stack.Parameters.map(row=>({ParameterKey:row.ParameterKey,...(row.ParameterKey==='RepositoryCommit'?{ParameterValue:commit}:{UsePreviousValue:true})}));
await awsCli('cloudformation','update-stack','--stack-name','opusloops-stem-worker','--use-previous-template','--capabilities','CAPABILITY_IAM','--parameters',JSON.stringify(parameters));
for(let index=0;index<120;index++) {
  const status=(await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-stem-worker')).Stacks[0].StackStatus;
  if(status==='UPDATE_COMPLETE')break;
  if(!status.endsWith('_IN_PROGRESS'))throw new Error(`Worker build configuration did not update (${status})`);
  await setTimeout(3000);
}
const result=await awsCli('codebuild','start-build','--project-name','opusloops-stem-worker-image');
console.log(JSON.stringify({buildId:result.build.id,commit}));
