import { createHmac,createHash,timingSafeEqual } from 'node:crypto';
import { ApiError,rpc,uuid,workerSecret } from './common.mjs';

export function verifyCallback(headers,bytes,master,now=Math.floor(Date.now()/1000)) {
  if(bytes.length>256*1024)throw new ApiError(413,'request_too_large','Callback is too large');
  const jobId=uuid(headers['x-opusloops-job-id']),attemptId=uuid(headers['x-opusloops-attempt']),nonce=uuid(headers['x-opusloops-nonce']);
  const time=headers['x-opusloops-timestamp'],signature=headers['x-opusloops-signature'];
  if(!/^\d{1,16}$/.test(time||'')||Math.abs(now-Number(time))>300||!Number.isSafeInteger(Number(time))||!/^[a-f0-9]{64}$/.test(signature||''))throw new ApiError(401,'invalid_signature','Worker signature is invalid or expired');
  const token=createHmac('sha256',master).update(attemptId).digest('hex');
  const expected=createHmac('sha256',token).update(`${time}.${nonce}.`).update(bytes).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new ApiError(401,'invalid_signature','Worker signature is invalid');
  let payload;
  try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw new ApiError(400,'invalid_request','Callback JSON is invalid');}
  if(payload.jobId?.toLowerCase()!==jobId||payload.attemptId?.toLowerCase()!==attemptId)throw new ApiError(401,'invalid_signature','Worker identity binding is invalid');
  return {p_nonce:nonce,p_request_sha256:createHash('sha256').update(bytes).digest('hex'),p_payload:payload};
}
export async function callback(headers,bytes) {
  const request=verifyCallback(headers,bytes,await workerSecret());
  return rpc('apply_stem_worker_callback',request);
}
