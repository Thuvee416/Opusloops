import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import { setTimeout } from 'node:timers/promises';
import { foundation,awsOptions,migrationCall } from './aws.mjs';

const client=new cognito.CognitoIdentityProviderClient(awsOptions);
const send=(command,input)=>client.send(new cognito[command](input));
const cell=value=>String(value??'').replaceAll('\\','\\\\').replaceAll(',','\\,').replace(/[\r\n]/g,' ');

export async function importIdentities(users,{canary=false}={}) {
  const outputs=await foundation(),UserPoolId=outputs.UserPoolId;
  if(!users.length)return {imported:0};
  for(const user of users) {
    if(!/^[0-9a-f-]{36}$/.test(user.id)||!/^\$2[abxy]\$(0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$/.test(user.encrypted_password||'')
       ||!user.email_confirmed_at||user.banned_until&&new Date(user.banned_until)>new Date())throw new Error('Identity is not eligible for password-preserving import');
    if(canary&&!user.email.endsWith('@example.invalid'))throw new Error('Canary email is invalid');
    try {await send('AdminGetUserCommand',{UserPoolId,Username:user.id});throw new Error('Target identity already exists; reconcile explicitly before import');}
    catch(error){if(error.name!=='UserNotFoundException')throw error;}
  }
  const {CSVHeader}=await send('GetCSVHeaderCommand',{UserPoolId});
  if(!CSVHeader.includes('password_hash')||!CSVHeader.includes('custom:opusloops_id'))throw new Error('Pool cannot preserve passwords and owner IDs');
  const rows=users.map(user=>({ 'cognito:username':user.id,'custom:opusloops_id':user.id,email:user.email.toLowerCase(),email_verified:'true',
    name:user.raw_user_meta_data?.display_name||'','cognito:mfa_enabled':'false',password_hash:user.encrypted_password }));
  // Password hashes exist only in memory during the TLS upload, never in files,
  // command arguments, application logs, or returned reports.
  const csv=Buffer.from([CSVHeader.join(','),...rows.map(row=>CSVHeader.map(key=>cell(row[key])).join(','))].join('\n')+'\n');
  const created=await send('CreateUserImportJobCommand',{UserPoolId,JobName:`${canary?'canary':'migration'}-${Date.now()}`,CloudWatchLogsRoleArn:outputs.UserImportRoleArn,PasswordHashingAlgorithm:'BCRYPT'});
  const job=created.UserImportJob;
  const uploaded=await fetch(job.PreSignedUrl,{method:'PUT',headers:{'x-amz-server-side-encryption':'aws:kms'},body:csv,signal:AbortSignal.timeout(60000)});
  csv.fill(0);
  if(!uploaded.ok)throw new Error(`Cognito CSV transfer failed (${uploaded.status})`);
  await send('StartUserImportJobCommand',{UserPoolId,JobId:job.JobId});
  console.log(JSON.stringify({identityImport:job.JobId,status:'started',users:users.length,canary}));
  let result;
  for(let count=0;count<60;count++) {
    result=(await send('DescribeUserImportJobCommand',{UserPoolId,JobId:job.JobId})).UserImportJob;
    if(!['Pending','InProgress','Created'].includes(result.Status))break;
    await setTimeout(3000);
  }
  if(result.Status!=='Succeeded'||result.ImportedUsers!==users.length||result.FailedUsers||result.SkippedUsers)throw new Error(`Cognito import did not verify (${result.Status}; imported ${result.ImportedUsers}; failed ${result.FailedUsers}; skipped ${result.SkippedUsers})`);
  const bindings=[];
  for(const user of users) {
    const record=await send('AdminGetUserCommand',{UserPoolId,Username:user.id});
    const attrs=Object.fromEntries(record.UserAttributes.map(row=>[row.Name,row.Value]));
    if(record.UserStatus!=='CONFIRMED'||attrs['custom:opusloops_id']!==user.id||attrs.email!==user.email.toLowerCase())throw new Error('Imported identity did not preserve its binding');
    bindings.push({id:user.id,subject:attrs.sub});
  }
  if(!canary)await migrationCall('bind-users',{bindings});
  return {imported:bindings.length,bindings,jobId:job.JobId};
}
