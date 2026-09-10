import * as s3 from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ApiError,db,rpc,uuid,numberField,physicalBucket,bucketMap } from './common.mjs';

export const client=new s3.S3Client({requestChecksumCalculation:'WHEN_REQUIRED'});
export const CHUNK_BYTES=8*1024*1024;
const send=(command,body)=>client.send(new s3[command](body));
const notFound=error=>['NotFound','NoSuchKey','NoSuchUpload'].includes(error.name)||error.$metadata?.httpStatusCode===404;

export async function head(logical,key) {
  try { return await send('HeadObjectCommand',{Bucket:physicalBucket(logical),Key:key}); }
  catch(error) {if(notFound(error))return null;throw error;}
}
export async function register(logical,key,observed) {
  const id=uuid(key.split('/')[0]);
  await db({operation:'register-object',identity:{id},bucket:logical,key,bytes:Number(observed.ContentLength),etag:observed.ETag,contentType:observed.ContentType||'application/octet-stream'});
}
export async function verifyUpload(user,job) {
  if(!job.source_object_path.startsWith(`${user.id}/`))throw new ApiError(403,'forbidden','Upload belongs to another account');
  const observed=await head(job.source_bucket,job.source_object_path);
  if(!observed||Number(observed.ContentLength)!==Number(job.source_bytes))throw new ApiError(409,'upload_incomplete','Stem upload is not complete');
  await register(job.source_bucket,job.source_object_path,observed);
  return {bytes:Number(observed.ContentLength),etag:observed.ETag};
}
async function uploadContext(user,jobId) {
  const job=await rpc('get_stem_job_for_finalize',{p_user_id:user.id,p_job_id:uuid(jobId)});
  return {job,Bucket:physicalBucket(job.source_bucket),Key:job.source_object_path};
}
async function listParts(context,uploadId) {
  const parts=[];let marker;
  do {
    const result=await send('ListPartsCommand',{Bucket:context.Bucket,Key:context.Key,UploadId:uploadId,PartNumberMarker:marker,MaxParts:1000});
    parts.push(...(result.Parts||[])); marker=result.IsTruncated?result.NextPartNumberMarker:undefined;
  } while(marker);
  return parts.sort((a,b)=>a.PartNumber-b.PartNumber);
}
export function validateParts(parts,totalBytes) {
  const count=Math.ceil(totalBytes/CHUNK_BYTES);
  if(parts.length!==count)throw new ApiError(409,'upload_incomplete','Some upload parts are missing');
  for(let index=0;index<count;index++) {
    const expected=index===count-1?totalBytes-CHUNK_BYTES*index:CHUNK_BYTES;
    if(parts[index].PartNumber!==index+1||parts[index].Size!==expected||!parts[index].ETag)throw new ApiError(409,'upload_incomplete','Upload parts could not be verified');
  }
  return parts.map(({PartNumber,ETag})=>({PartNumber,ETag}));
}
export async function multipart(user,body) {
  const jobId=uuid(body.jobId),context=await uploadContext(user,jobId);
  const {job,Bucket,Key}=context;
  let session=await db({operation:'multipart',mode:'get',identity:user,jobId});
  const observed=await head(job.source_bucket,Key);
  if(observed) {
    await verifyUpload(user,job);
    return {complete:true,confirmedBytes:Number(job.source_bytes),parts:[],chunkSize:CHUNK_BYTES};
  }
  if(session?.completed_at)throw new ApiError(409,'upload_expired','This upload is no longer available');
  if(!session) {
    const created=await send('CreateMultipartUploadCommand',{Bucket,Key,ContentType:'application/zip',Metadata:{'opusloops-user':user.id,'opusloops-job':jobId}});
    session=await db({operation:'multipart',mode:'save',identity:user,jobId,uploadId:created.UploadId});
    if(session.upload_id!==created.UploadId)await send('AbortMultipartUploadCommand',{Bucket,Key,UploadId:created.UploadId});
  }
  if(body.action==='upload-part') {
    const partNumber=numberField(body.partNumber,1,Math.ceil(Number(job.source_bytes)/CHUNK_BYTES),true);
    const url=await getSignedUrl(client,new s3.UploadPartCommand({Bucket,Key,UploadId:session.upload_id,PartNumber:partNumber}),{expiresIn:900});
    return {url,partNumber,chunkSize:CHUNK_BYTES};
  }
  const parts=await listParts(context,session.upload_id);
  if(body.action==='upload-complete') {
    const accepted=validateParts(parts,Number(job.source_bytes));
    try {await send('CompleteMultipartUploadCommand',{Bucket,Key,UploadId:session.upload_id,MultipartUpload:{Parts:accepted},IfNoneMatch:'*'});}
    catch(error){if(!notFound(error)&&error.$metadata?.httpStatusCode!==412)throw error;}
    await verifyUpload(user,job);
    await db({operation:'multipart',mode:'complete',identity:user,jobId,uploadId:session.upload_id});
    return {complete:true,confirmedBytes:Number(job.source_bytes)};
  }
  return {complete:false,chunkSize:CHUNK_BYTES,parts:parts.map(({PartNumber,Size})=>({partNumber:PartNumber,bytes:Size})),confirmedBytes:parts.reduce((total,part)=>total+Number(part.Size),0)};
}
export async function signedDownload(asset,expiresIn) {
  return getSignedUrl(client,new s3.GetObjectCommand({Bucket:physicalBucket(asset.bucket),Key:asset.object_path}),{expiresIn});
}
export async function registerEvent(event) {
  const detail=event.detail;
  const logical=Object.entries(bucketMap()).find(([,physical])=>physical===detail?.bucket?.name)?.[0];
  const key=detail?.object?.key;
  if(!logical||typeof key!=='string'||key.split('/').length<4)throw new ApiError(400,'invalid_object','Storage event is invalid');
  const observed=await head(logical,key);
  if(observed)await register(logical,key,observed);
  return {registered:Boolean(observed)};
}
export async function deleteRetainedObject(logical,key) {
  // Delete exact-key versions, not a prefix. Versioned buckets otherwise retain
  // the audio indefinitely after the app says it has been deleted.
  const Bucket=physicalBucket(logical);
  let keyMarker,versionMarker;
  do {
    const result=await send('ListObjectVersionsCommand',{Bucket,Prefix:key,KeyMarker:keyMarker,VersionIdMarker:versionMarker,MaxKeys:1000});
    const objects=[...(result.Versions||[]),...(result.DeleteMarkers||[])].filter(item=>item.Key===key).map(({Key,VersionId})=>({Key,VersionId}));
    if(objects.length){const deleted=await send('DeleteObjectsCommand',{Bucket,Delete:{Objects:objects,Quiet:true}});if(deleted.Errors?.length)throw new Error('Storage deletion incomplete');}
    keyMarker=result.IsTruncated?result.NextKeyMarker:undefined;versionMarker=result.NextVersionIdMarker;
  }while(keyMarker);
  await db({operation:'remove-object',bucket:logical,key});
}
