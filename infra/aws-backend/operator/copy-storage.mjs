import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,unlink,rmdir } from 'node:fs/promises';
import { createWriteStream,createReadStream } from 'node:fs';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client,HeadObjectCommand,PutObjectCommand } from '@aws-sdk/client-s3';
import { foundation,sourceProject,sourceRequest,awsOptions } from './aws.mjs';
import { snapshot } from './snapshot.mjs';

const outputs=await foundation();
const {data,key:backupKey}=await snapshot();
const objects=data.tables['storage.objects'];
const bucketMap={'opusloops-stem-uploads':outputs.UploadsBucket,'opusloops-stem-sources':outputs.SourcesBucket,'opusloops-stem-artifacts':outputs.ArtifactsBucket};
if(objects.some(row=>!bucketMap[row.bucket_id]||!Number.isSafeInteger(Number(row.metadata?.size))||Number(row.metadata.size)<0))throw new Error('Unexpected source storage metadata');
const apiKeys=await sourceRequest(`/v1/projects/${sourceProject}/api-keys`);
const serviceKey=apiKeys.find(row=>row.name==='service_role')?.api_key;
if(!serviceKey)throw new Error('Source storage credential unavailable');
const expectedHashes=new Map(data.tables['public.stem_import_assets'].map(row=>[`${row.bucket}/${row.object_path}`,row.sha256]));
for(const job of data.tables['public.stem_import_jobs'])if(job.source_sha256)expectedHashes.set(`${job.source_bucket}/${job.source_object_path}`,job.source_sha256);
const operatorDir=new URL('../.operator/',import.meta.url);
await mkdir(operatorDir,{recursive:true,mode:0o700});
const directory=await mkdtemp(`${operatorDir.pathname}copy-`);
const client=new S3Client({...awsOptions,requestChecksumCalculation:'WHEN_REQUIRED'});
let cursor=0,verified=0,verifiedBytes=0;
const totalBytes=objects.reduce((total,row)=>total+Number(row.metadata.size),0);
const manifest=[];

async function destinationHead(Bucket,Key) {
  try{return await client.send(new HeadObjectCommand({Bucket,Key,ChecksumMode:'ENABLED'}));}
  catch(error){if(error.name==='NotFound'||error.$metadata?.httpStatusCode===404)return null;throw error;}
}
async function copy(row,index) {
  const Bucket=bucketMap[row.bucket_id],Key=row.name,bytes=Number(row.metadata.size);
  const expected=expectedHashes.get(`${row.bucket_id}/${Key}`);
  const prior=await destinationHead(Bucket,Key);
  if(prior) {
    const sha256=prior.Metadata?.['migration-sha256'];
    if(!/^[a-f0-9]{64}$/.test(sha256||'')||prior.ContentLength!==bytes||prior.ChecksumSHA256!==Buffer.from(sha256,'hex').toString('base64')||(expected&&expected!==sha256))throw new Error('Existing target object is not a verified copy');
    return sha256;
  }
  const path=`${directory}/${index}.part`;
  try {
    const response=await fetch(`https://${sourceProject}.supabase.co/storage/v1/object/authenticated/${row.bucket_id}/${Key.split('/').map(encodeURIComponent).join('/')}`,{
      headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`},signal:AbortSignal.timeout(300_000),
    });
    if(!response.ok||!response.body)throw new Error('Source object unavailable');
    const hash=createHash('sha256');let received=0;
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,done){received+=chunk.length;if(received>bytes)return done(new Error('Source size changed'));hash.update(chunk);done(null,chunk);}}),createWriteStream(path,{flags:'wx',mode:0o600}));
    const sha256=hash.digest('hex');
    if(received!==bytes||(expected&&expected!==sha256))throw new Error('Source object failed integrity check');
    await client.send(new PutObjectCommand({Bucket,Key,Body:createReadStream(path),ContentLength:bytes,ContentType:row.metadata.mimetype||'application/octet-stream',
      IfNoneMatch:'*',ChecksumSHA256:Buffer.from(sha256,'hex').toString('base64'),Metadata:{'migration-sha256':sha256,sha256,'source-project':sourceProject}}));
    const confirmed=await destinationHead(Bucket,Key);
    if(confirmed?.ContentLength!==bytes||confirmed.ChecksumSHA256!==Buffer.from(sha256,'hex').toString('base64'))throw new Error('Destination failed integrity check');
    return sha256;
  } finally {await unlink(path).catch(()=>{});}
}
await Promise.all(Array.from({length:3},async()=>{
  while(cursor<objects.length) {
    const index=cursor++,row=objects[index];
    try {
      const sha256=await copy(row,index);
      manifest.push({bucket:row.bucket_id,key:row.name,sha256,bytes:Number(row.metadata.size)});
      verified++;verifiedBytes+=Number(row.metadata.size);
      if(verified%20===0||verified===objects.length)console.log(JSON.stringify({verified,total:objects.length,verifiedBytes,totalBytes}));
    } catch(error){throw new Error(`Storage object ${index} failed verification (${error.name}); no source objects were changed`);}
  }
}));
const bytes=Buffer.from(JSON.stringify({sourceProject,backupKey,verifiedAt:new Date().toISOString(),objects:manifest}));
const digest=createHash('sha256').update(bytes).digest('hex');
await client.send(new PutObjectCommand({Bucket:outputs.MigrationBucket,Key:`verification/storage-${digest}.json`,Body:bytes,ContentType:'application/json',IfNoneMatch:'*',ChecksumSHA256:createHash('sha256').update(bytes).digest('base64')}));
await rmdir(directory);
console.log(JSON.stringify({complete:true,verified,verifiedBytes,manifestSha256:digest}));
