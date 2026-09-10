import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { CognitoIdentityProviderClient,AdminCreateUserCommand,AdminSetUserPasswordCommand,AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { foundation,awsOptions,migrationCall } from './aws.mjs';

if(!process.env.PLAYWRIGHT_MODULE)throw new Error('Set PLAYWRIGHT_MODULE to the installed Playwright module');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const baseURL=process.env.OPUS_QA_URL||'https://opusloops.com';
if(!['https://opusloops.com','http://127.0.0.1:4173'].includes(baseURL))throw new Error('Unexpected browser canary origin');
const outputs=await foundation();
const id=randomUUID(),email=`migration-${id}@example.invalid`,password=randomBytes(24).toString('base64url');
const cognito=new CognitoIdentityProviderClient(awsOptions),s3=new S3Client(awsOptions);
let browser,seeded=false;
try {
  const created=await cognito.send(new AdminCreateUserCommand({UserPoolId:outputs.UserPoolId,Username:id,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'},{Name:'custom:opusloops_id',Value:id}]}));
  const subject=created.User.Attributes.find(row=>row.Name==='sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({UserPoolId:outputs.UserPoolId,Username:id,Password:password,Permanent:true}));
  await migrationCall('canary-user',{id,subject});seeded=true;
  browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage(),errors=[],providers=new Set();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.hostname.includes('supabase')||url.hostname.endsWith('amazonaws.com'))providers.add(url.hostname);});
  await page.goto(baseURL,{waitUntil:'networkidle'});
  assert.equal(await page.evaluate(()=>window.OPUSLOOPS_CONFIG.provider),'aws');
  assert.equal(await page.evaluate(async({email,password})=>{
    await window.OpusloopsCloud.signIn(email,password);return window.OpusloopsCloud.getSession().user.id;
  },{email,password}),id);
  const projectId=randomUUID();
  const uploaded=await page.evaluate(async projectId=>{
    const cloud=window.OpusloopsCloud;
    await cloud.syncProjects([{id:projectId,name:'Browser storage test',schema_version:2,document:{id:projectId,schemaVersion:2,tempo:120},client_updated_at:new Date().toISOString(),deleted_at:null}]);
    const file=new File([new Uint8Array(8*1024*1024+127)],'browser-canary.zip',{type:'application/zip'});
    const created=await cloud.createStemImport({projectId,file});
    const progress=[];
    const result=await cloud.uploadStemArchive({file,upload:created.upload,jobId:created.job.id,onProgress:value=>progress.push(value)});
    return {bytes:result.bytesUploaded,progress,key:created.upload.objectName};
  },projectId);
  assert.equal(uploaded.bytes,8*1024*1024+127);
  assert.equal(uploaded.progress[0],0);assert.equal(uploaded.progress.at(-1),uploaded.bytes);
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:outputs.UploadsBucket,Key:uploaded.key}),{expiresIn:60});
  const ranged=await page.evaluate(async url=>{const response=await fetch(url,{headers:{Range:'bytes=0-1023'}});return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};},url);
  assert.deepEqual(ranged,{status:206,bytes:1024});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);assert.ok([...providers].every(host=>!host.includes('supabase')));
  await page.evaluate(()=>window.OpusloopsCloud.signOut());
  console.log(JSON.stringify({browserCanary:'passed',origin:baseURL,viewport:390,signIn:true,privateProjectSave:true,multipartUploadBytes:uploaded.bytes,s3CorsAndRange:true,consoleErrors:0,supabaseRequests:0}));
} finally {
  await browser?.close();
  for(const Bucket of [outputs.UploadsBucket,outputs.SourcesBucket,outputs.ArtifactsBucket]) {
    const versions=await s3.send(new ListObjectVersionsCommand({Bucket,Prefix:`${id}/`}));
    if(versions.IsTruncated)throw new Error('Canary cleanup requires paginated review');
    const objects=[...(versions.Versions||[]),...(versions.DeleteMarkers||[])].map(({Key,VersionId})=>({Key,VersionId}));
    if(objects.some(row=>!row.Key.startsWith(`${id}/`)))throw new Error('Canary cleanup scope mismatch');
    if(objects.length)await s3.send(new DeleteObjectsCommand({Bucket,Delete:{Objects:objects}}));
  }
  if(seeded)await migrationCall('remove-canary',{id});
  await cognito.send(new AdminDeleteUserCommand({UserPoolId:outputs.UserPoolId,Username:id})).catch(error=>{if(error.name!=='UserNotFoundException')throw error;});
  console.log(JSON.stringify({browserCanaryCleanup:'complete',realUsersChanged:false}));
}
