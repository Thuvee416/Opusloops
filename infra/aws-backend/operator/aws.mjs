import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const exec = promisify(execFile);
export const region = 'us-east-1';
export const account = '368310207026';
export const sourceProject = 'heryvahetgzfalmuprbw';

export async function awsCli(...args) {
  const result = await exec('aws', [...args, '--region', region, '--output', 'json', '--no-cli-pager'], { maxBuffer: 16 * 1024 * 1024 });
  if (args[0] === 'cloudformation' && args[1] === 'deploy') return result.stdout;
  return result.stdout ? JSON.parse(result.stdout) : null;
}
export async function credentials() {
  const result = await awsCli('configure', 'export-credentials', '--format', 'process');
  return { accessKeyId: result.AccessKeyId, secretAccessKey: result.SecretAccessKey, sessionToken: result.SessionToken, expiration: new Date(result.Expiration) };
}
export const awsOptions = { region, credentials };

export async function assertAccount() {
  const identity = await awsCli('sts', 'get-caller-identity');
  if (identity.Account !== account) throw new Error('Refusing migration in an unexpected AWS account');
}
export async function foundation() {
  await assertAccount();
  const result = await awsCli('cloudformation', 'describe-stacks', '--stack-name', 'opusloops-aws-backend');
  if (!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(result.Stacks?.[0]?.StackStatus)) throw new Error('AWS foundation is not ready');
  return Object.fromEntries(result.Stacks[0].Outputs.map(row => [row.OutputKey, row.OutputValue]));
}
export async function sourceRequest(path, options = {}) {
  if (!path.startsWith(`/v1/projects/${sourceProject}`)) throw new Error('Unexpected source project');
  const token = process.env.SUPABASE_ACCESS_TOKEN || (await readFile('/Users/thuveem4/.supabase/access-token','utf8')).trim();
  const response = await fetch(`https://api.supabase.com${path}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json', ...options.headers }, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Supabase management request failed (${response.status})`);
  return response.json();
}
export async function sourceQuery(query) {
  return sourceRequest(`/v1/projects/${sourceProject}/database/query`, { method:'POST', body: JSON.stringify({query, read_only:true}) });
}
export async function migrationCall(action, fields = {}) {
  const outputs = await foundation();
  const secret = await new SecretsManagerClient(awsOptions).send(new GetSecretValueCommand({SecretId:outputs.DatabaseSecretArn}));
  const password = JSON.parse(secret.SecretString).password;
  const response = await new LambdaClient(awsOptions).send(new InvokeCommand({FunctionName:'opusloops-aws-migration',
    Payload:Buffer.from(JSON.stringify({action,...fields,password})), InvocationType:'RequestResponse'}));
  if (response.FunctionError) throw new Error('Migration Lambda failed');
  const result = JSON.parse(Buffer.from(response.Payload).toString());
  if (!result.ok) {
    if(action==='verify'&&result.tables)console.log(JSON.stringify({verification:result.tables}));
    throw new Error(`Migration operation failed (${result.code})`);
  }
  return result;
}
