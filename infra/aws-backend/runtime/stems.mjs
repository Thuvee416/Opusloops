import { ApiError,rpc,uuid,textField,numberField,objectField } from './common.mjs';
import { dispatch } from './dispatch.mjs';
import { CHUNK_BYTES,multipart,verifyUpload,signedDownload } from './storage.mjs';

export function stageOperation(body,userId) {
  const params={p_user_id:userId,p_job_id:uuid(body.jobId),p_revision:numberField(body.revision,0,Number.MAX_SAFE_INTEGER,true)};
  const hash=value=>{const result=textField(value,64);if(!/^[a-f0-9]{64}$/.test(result))throw new ApiError(400,'invalid_request','Approval hash is invalid');return result;};
  switch(body.action) {
    case 'retry-proposal':return {name:'retry_stem_proposal',params};
    case 'repair-render-proposal':return {name:'repair_stem_render_proposal',params:{...params,p_proposal_manifest_sha256:hash(body.proposalManifestSha256)}};
    case 'retry-render':return {name:'retry_stem_render',params:{...params,p_proposal_manifest_sha256:hash(body.proposalManifestSha256),p_tempo_approval_sha256:hash(body.tempoApprovalSha256)}};
    case 'cancel':return {name:'cancel_stem_import',params,noDispatch:true};
    case 'approve-analysis': {
      const flags=objectField(body.confirmations);
      return {name:'approve_stem_analysis',params:{...params,p_inspection_manifest_sha256:hash(body.inspectionManifestSha256),p_selection:objectField(body.selection),
        p_confirm_files:flags.files===true,p_confirm_roles:flags.roles===true,p_confirm_reference:flags.reference===true,p_confirm_originals_unchanged:flags.originalsUnchanged===true}};
    }
    case 'request-proposal': {
      const mode=textField(body.mode,32),denominator=numberField(body.meterDenominator,1,32,true);
      if(!['musical-4bar','rigid-beat','no-conform'].includes(mode)||![1,2,4,8,16,32].includes(denominator))throw new ApiError(400,'invalid_request','Timing mode or meter is invalid');
      return {name:'request_stem_proposal',params:{...params,p_analysis_sha256:hash(body.analysisSha256),p_proposal_id:textField(body.proposalId,64),
        p_target_bpm:mode==='no-conform'?null:numberField(body.targetBpm,20,400),p_mode:mode,p_reviewed_grid:objectField(body.reviewedGrid),
        p_meter_numerator:numberField(body.meterNumerator,1,32,true),p_meter_denominator:denominator,p_first_downbeat_seconds:numberField(body.firstDownbeatSeconds,0,86400)}};
    }
    case 'approve-tempo': {
      const flags=objectField(body.confirmations);
      const names={click:'click',beat_grid:'beatGrid',meter_downbeat:'meterDownbeat',tempo_octave:'tempoOctave',flags:'flags',target:'target',shared_map:'sharedMap',originals_unchanged:'originalsUnchanged'};
      return {name:'approve_stem_tempo',params:{...params,p_proposal_manifest_sha256:hash(body.proposalManifestSha256),p_approval:objectField(body.approval),
        ...Object.fromEntries(Object.entries(names).map(([key,flag])=>[`p_confirm_${key}`,flags[flag]===true]))}};
    }
    default:throw new ApiError(400,'invalid_request','Unknown stem action');
  }
}
export async function stemAction(user,body) {
  if(['upload-status','upload-part','upload-complete'].includes(body.action))return {status:200,body:await multipart(user,body)};
  if(body.action==='create') {
    const file=objectField(body.file);
    const job=await rpc('create_stem_import',{p_user_id:user.id,p_project_id:uuid(body.projectId),p_source_name:textField(file.name,255),p_source_bytes:numberField(file.size,1,2147483648,true),p_source_content_type:typeof file.type==='string'&&file.type?file.type.slice(0,127):'application/zip'});
    return {status:201,body:{job,upload:{protocol:'s3-multipart',endpoint:`${process.env.API_URL}/functions/v1/stem-import`,bucketName:'opusloops-stem-uploads',objectName:job.source_object_path,chunkSize:CHUNK_BYTES}}};
  }
  const jobId=uuid(body.jobId);
  if(body.action==='signed-download') {
    const asset=await rpc('get_stem_asset_for_signing',{p_user_id:user.id,p_job_id:jobId,p_asset_id:uuid(body.assetId)});
    const expiresIn=Math.max(60,Math.min(3600,Number(body.expiresInSeconds)||900));
    return {status:200,body:{asset:{id:asset.asset_id,kind:asset.kind,variant:asset.variant,contentType:asset.content_type,bytes:asset.bytes,sha256:asset.sha256},signedUrl:await signedDownload(asset,Math.floor(expiresIn)),expiresAt:new Date(Date.now()+expiresIn*1000).toISOString()}};
  }
  let job,noDispatch=false;
  if(body.action==='finalize-upload'||body.action==='retry-inspection') {
    const revision=numberField(body.revision,0,Number.MAX_SAFE_INTEGER,true);
    const retry=body.action==='retry-inspection';
    const current=await rpc(retry?'get_stem_inspection_retry_source':'get_stem_job_for_finalize',{p_user_id:user.id,p_job_id:jobId,...(retry?{p_revision:revision}:{})});
    const observed=await verifyUpload(user,current);
    job=await rpc(retry?'retry_stem_inspection':'finalize_stem_upload',{p_user_id:user.id,p_job_id:jobId,p_revision:revision,p_observed_bytes:observed.bytes,p_storage_etag:observed.etag});
  } else if(body.action==='dispatch')job=await rpc('get_stem_job_for_dispatch',{p_user_id:user.id,p_job_id:jobId});
  else {const operation=stageOperation(body,user.id);job=await rpc(operation.name,operation.params);noDispatch=operation.noDispatch;}
  return {status:200,body:noDispatch?{job}:{job,dispatch:await dispatch(user.id,jobId)}};
}
