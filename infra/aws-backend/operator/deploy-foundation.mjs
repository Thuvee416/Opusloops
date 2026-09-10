import { mkdir,writeFile } from 'node:fs/promises';
import { template } from '../foundation.mjs';
import { assertAccount,awsCli } from './aws.mjs';

await assertAccount();
const directory=new URL('../.operator/',import.meta.url);
await mkdir(directory,{recursive:true,mode:0o700});
const file=new URL('foundation-template.json',directory);
await writeFile(file,JSON.stringify(template),{mode:0o600});
// Updates retain existing parameters. Initial provisioning pins the project VPC.
await awsCli('cloudformation','deploy','--stack-name','opusloops-aws-backend','--template-file',file.pathname,
  '--capabilities','CAPABILITY_IAM','--parameter-overrides','VpcId=vpc-0267456d0067e4a3a','SubnetIds=subnet-0efa7366e248eea58,subnet-070d47b734dd48739','VpcCidr=172.31.0.0/16',
  '--no-fail-on-empty-changeset');
console.log(JSON.stringify({deployed:'opusloops-aws-backend'}));
