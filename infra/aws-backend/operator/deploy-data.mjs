import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { foundation, awsOptions, awsCli, account, region } from './aws.mjs';

const outputs = await foundation();
const exec = promisify(execFile);
const root = new URL('../', import.meta.url);
const operatorDir = new URL('../.operator/', import.meta.url);
await mkdir(operatorDir,{recursive:true,mode:0o700});
const zip = new URL('data-functions.zip',operatorDir);
await exec('zip',['-q','-j',zip.pathname,'dist/migration.mjs','dist/database.mjs','dist/schema.sql','dist/rds-ca.pem'],{cwd:root.pathname});
const bytes = await readFile(zip);
const hash = createHash('sha256').update(bytes).digest('hex');
const key = `code/data-${hash}.zip`;
await new S3Client(awsOptions).send(new PutObjectCommand({Bucket:outputs.MigrationBucket,Key:key,Body:bytes,ContentType:'application/zip',ChecksumSHA256:createHash('sha256').update(bytes).digest('base64')}));
const resources = {};
for (const [id,name,handler] of [['Migration','opusloops-aws-migration','migration.handler'],['Database','opusloops-aws-database','database.handler']]) {
  if(id==='Migration'&&process.env.OPUSLOOPS_INCLUDE_MIGRATION_HELPER!=='true')continue;
  resources[`${id}Role`] = {
    Type:'AWS::IAM::Role', Properties:{
      AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},
      ManagedPolicyArns:['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'],
      ...(id==='Database'?{Policies:[{PolicyName:'OnlyOpusloopsDatabaseUser',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:'rds-db:connect',Resource:`arn:aws:rds-db:${region}:${account}:dbuser:${outputs.DatabaseResourceId}/opusloops_api`}]}}]}:{}),
      Tags:[{Key:'Application',Value:'Opusloops'}],
    },
  };
  resources[`${id}Logs`] = {Type:'AWS::Logs::LogGroup',Properties:{LogGroupName:`/aws/lambda/${name}`,RetentionInDays:14}};
  resources[`${id}Function`] = {
    Type:'AWS::Lambda::Function',DependsOn:`${id}Logs`,Properties:{
      FunctionName:name,Runtime:'nodejs22.x',Architectures:['arm64'],Handler:handler,
      Description: id==='Migration'?'Temporary IAM-only migration helper; remove after verified cutover':'Private IAM-only PostgreSQL bridge; no public function URL',
      Role:{'Fn::GetAtt':[`${id}Role`,'Arn']},Code:{S3Bucket:outputs.MigrationBucket,S3Key:key},
      MemorySize:id==='Migration'?1024:256,Timeout:id==='Migration'?120:30,
      VpcConfig:{SubnetIds:['subnet-0efa7366e248eea58','subnet-070d47b734dd48739'],SecurityGroupIds:[outputs.DatabaseClientSecurityGroup]},
      Environment:{Variables:{DATABASE_HOST:outputs.DatabaseHost}},Tags:[{Key:'Application',Value:'Opusloops'}],
    },
  };
}
const template = {AWSTemplateFormatVersion:'2010-09-09',Description:'Opusloops private data bridge and temporary migration helper',Resources:resources};
const templateFile = new URL('data-template.json',operatorDir);
await writeFile(templateFile,JSON.stringify(template),{mode:0o600});
await awsCli('cloudformation','deploy','--stack-name','opusloops-aws-data','--template-file',templateFile.pathname,'--capabilities','CAPABILITY_IAM','--no-fail-on-empty-changeset');
console.log(JSON.stringify({deployed:'opusloops-aws-data',codeSha256:hash}));
