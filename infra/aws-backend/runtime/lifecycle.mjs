import { BatchClient, DescribeJobsCommand, ListJobsCommand, TerminateJobCommand } from '@aws-sdk/client-batch';
import { createHash, randomUUID } from 'node:crypto';
import { db, rpc, uuid } from './common.mjs';
import { dispatch } from './dispatch.mjs';

const batch = new BatchClient({});
const stages = ['inspect', 'analyze', 'propose', 'render'];
export function nativeJob(job) {
  const stage = stages.find(stage => job.jobDefinition === process.env[`BATCH_${stage.toUpperCase()}_DEFINITION`]);
  if (!stage || job.jobQueue !== process.env.BATCH_JOB_QUEUE) return null;
  uuid(job.jobId);
  const encoded = job.parameters?.payload_base64;
  if (typeof encoded !== 'string' || encoded.length > 100000) throw new Error('Invalid Batch payload');
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
  if (payload.version !== 2 || payload.stage !== stage || payload.callback?.url !== `${process.env.API_URL}/worker/callback`) throw new Error('Invalid Batch binding');
  for (const key of ['jobId', 'userId', 'attemptId', 'projectId']) uuid(payload[key]);
  // Never return/log the storage credentials carried in Batch parameters.
  return { jobId: payload.jobId, userId: payload.userId, attemptId: payload.attemptId, stage };
}
async function failed(job, code = 'batch_bootstrap_failed') {
  const binding = nativeJob(job);
  if (!binding) return { ignored: true };
  const payload = { version: 1, ...binding, dispatchJobId: job.jobId,
    event: { status: 'failed', determinate: false, completed: null, total: null, unit: null,
      detail: { operation: 'batch-bootstrap-failure', source: 'aws-batch' } }, assets: [], result: null,
    error: { code, message: code === 'batch_queue_timeout' ? 'The audio job did not start within ten minutes.' : 'The isolated audio worker could not complete in AWS Batch.', retryable: true } };
  return rpc('apply_stem_worker_callback', { p_nonce: randomUUID(),
    p_request_sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), p_payload: payload });
}
export async function batchFailure(event) {
  const id = uuid(event.detail?.jobId);
  const result = await batch.send(new DescribeJobsCommand({ jobs: [id] }));
  const job = result.jobs?.[0];
  return job?.status === 'FAILED' ? failed(job) : { ignored: true };
}
export async function watchdog() {
  let expired = 0, reconciled = 0;
  for (const state of ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING']) {
    const page = await batch.send(new ListJobsCommand({ jobQueue: process.env.BATCH_JOB_QUEUE, jobStatus: state, maxResults: 100 }));
    const ids = (page.jobSummaryList || []).filter(job => job.createdAt < Date.now() - 600000).map(job => job.jobId);
    if (!ids.length) continue;
    const details = await batch.send(new DescribeJobsCommand({ jobs: ids }));
    for (const job of details.jobs || []) {
      if (!['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING'].includes(job.status) || !nativeJob(job)) continue;
      // Scope-checked against our queue and exact native job definition above.
      await batch.send(new TerminateJobCommand({ jobId: job.jobId, reason: 'Opusloops queue startup deadline exceeded' }));
      await failed(job, 'batch_queue_timeout'); expired++;
    }
  }
  for (const job of await db({ operation: 'pending-dispatches' })) {
    const result = await dispatch(job.user_id, job.job_id);
    if (result.state === 'submitted') reconciled++;
  }
  return { expired, reconciled };
}
