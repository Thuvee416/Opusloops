import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { foundation, awsOptions, awsCli, account, region } from './aws.mjs';
import { applicationTemplate } from '../application.mjs';

const outputs = await foundation();
const root = new URL('../', import.meta.url);
const dir = new URL('../.operator/', import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
const zip = new URL('api-function.zip', dir);
await promisify(execFile)('zip', ['-q', '-j', zip.pathname, 'dist/api.mjs'], { cwd: root.pathname });
const bytes = await readFile(zip);
const hash = createHash('sha256').update(bytes).digest('hex');
const codeKey = `code/api-${hash}.zip`;
await new S3Client(awsOptions).send(new PutObjectCommand({ Bucket: outputs.MigrationBucket, Key: codeKey, Body: bytes, ContentType: 'application/zip', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64') }));
const definitions = await awsCli('batch', 'describe-job-definitions', '--job-definition-name', 'opusloops-stem-inspect', '--status', 'ACTIVE');
const source = definitions.jobDefinitions.sort((a, b) => b.revision - a.revision)[0].ecsProperties.taskProperties[0];
// A digest override is explicit and validated. Initial staging may deploy the old
// compatible infrastructure before a new worker image is built; do not run jobs yet.
let deployedImage;
try {
  const prior=await awsCli('cloudformation','describe-stacks','--stack-name','opusloops-aws-application');
  deployedImage=prior.Stacks[0].Outputs.find(row=>row.OutputKey==='WorkerImage')?.OutputValue;
} catch(error) {
  if(!String(error.stderr||'').includes('does not exist'))throw error;
}
const image = process.env.OPUSLOOPS_WORKER_IMAGE || deployedImage || source.containers[0].image;
const template = applicationTemplate({ outputs, account, region, codeKey, image, executionRole: source.executionRoleArn, taskRole: source.taskRoleArn });
const file = new URL('application-template.json', dir);
await writeFile(file, JSON.stringify(template), { mode: 0o600 });
await awsCli('cloudformation', 'deploy', '--stack-name', 'opusloops-aws-application', '--template-file', file.pathname, '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset');
const stack = await awsCli('cloudformation', 'describe-stacks', '--stack-name', 'opusloops-aws-application');
console.log(JSON.stringify({ deployed: 'opusloops-aws-application', codeSha256: hash, outputs: stack.Stacks[0].Outputs }));
