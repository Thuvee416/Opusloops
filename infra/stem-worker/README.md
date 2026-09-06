# Opusloops stem-worker infrastructure

This CloudFormation stack creates an egress-only AWS Batch Fargate worker plane
in `us-east-1`:

- one ECR repository with immutable `git-<commit>` tags and mutable `latest` only;
- one public-source, no-OAuth CodeBuild image project;
- one serialized four-vCPU Fargate compute environment and queue;
- distinct `inspect`, `analyze`, `propose`, and `render` job definitions;
- 4 vCPU, 16 GiB RAM, 50 GiB Fargate ephemeral storage, and a 30-minute hard timeout;
- CloudWatch logs, no inbound network rules, and no AWS API permission in the runtime task role;
- an EventBridge/Lambda fallback that reports AWS Batch `FAILED` states when the worker cannot report its own failure;
- a bounded, once-per-minute queue watchdog that cancels pre-run jobs at ten minutes before user JWT freshness becomes ambiguous;
- an hourly, bounded invocation of the production `stem-retention` Edge Function.

The job definitions use an ECR **digest**, not `latest` or another mutable tag.
AWS never receives the global callback master. The Edge dispatcher derives one
attempt-scoped callback token and places it in the strict job payload. The
retention invoker reads its unrelated maintenance secret from Secrets Manager.
Neither secret is built into the image, template, log, or source file.

## Storage authentication boundary

Do not create or inject project-wide Supabase S3 access keys. Each dispatch
provides short-lived, user-scoped Supabase S3 session authentication inside the
strict job payload:

- `storage.accessKeyId`: the exact Supabase project ref;
- `storage.secretAccessKey`: the project's legacy anon JWT key;
- `storage.sessionToken`: the fresh authenticated user's JWT.

The worker uses those three values only as Supabase S3 session credentials, so
Storage RLS remains the authorization boundary. They must never be copied into
callbacks, artifacts, state files, exceptions, or logs. The dispatcher must
allow writes only to the authenticated user's allocated active-attempt prefix.

AWS Batch parameters contain both the user session and the attempt-scoped
callback token. They are visible to principals with job-inspection permissions
and are included in Batch state-change events. Limit `batch:DescribeJobs`,
`batch:ListJobs`, EventBridge archive/replay, and CloudTrail/log access to the
smallest operational group. This stack does not archive or log the event body.
The failure Lambda decodes the payload in memory and logs identifiers and a
fixed status only.

## Prerequisites

Use AWS CloudShell in the intended account and `us-east-1`. Keep the global
callback master only in the Supabase Edge environment as
`OPUSLOOPS_WORKER_CALLBACK_SECRET`; do not create an AWS copy. The separate
retention value must match `OPUSLOOPS_RETENTION_MAINTENANCE_SECRET` on the
`stem-retention` Edge Function.

Set the non-secret deployment inputs. Always use a full commit, never a branch:

```bash
export AWS_REGION=us-east-1
export STACK_NAME=opusloops-stem-worker
export REPOSITORY_COMMIT="$(git rev-parse HEAD)"
export VPC_ID=vpc-REPLACE
export SUBNET_IDS=subnet-REPLACE,subnet-REPLACE
export WORKER_CALLBACK_URL=https://PROJECT_REF.supabase.co/functions/v1/stem-worker-callback
export RETENTION_URL=https://PROJECT_REF.supabase.co/functions/v1/stem-retention
```

Create only the retention AWS secret without placing its value in shell
history:

```bash
read -r -s -p 'Retention maintenance secret (at least 32 chars): ' RETENTION_SECRET
printf '\n'

export RETENTION_SECRET_ARN="$(aws secretsmanager create-secret \
  --region "$AWS_REGION" \
  --name opusloops/stem-worker/retention-maintenance \
  --secret-string "$RETENTION_SECRET" \
  --query ARN --output text)"
unset RETENTION_SECRET
```

If the retention secret already exists, resolve its ARN instead of replacing
its value:

```bash
export RETENTION_SECRET_ARN="$(aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id opusloops/stem-worker/retention-maintenance \
  --query ARN --output text)"
```

## Create, build, then bind the digest

The first deployment creates ECR and CodeBuild. The placeholder digest is never
submitted as a job; do not connect the Supabase dispatcher until the second
deployment completes.

```bash
aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/stem-worker/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    SubnetIds="$SUBNET_IDS" \
    RepositoryCommit="$REPOSITORY_COMMIT" \
    WorkerCallbackUrl="$WORKER_CALLBACK_URL" \
    RetentionUrl="$RETENTION_URL" \
    RetentionMaintenanceSecretArn="$RETENTION_SECRET_ARN"

export BUILD_PROJECT="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`ImageBuildProject`].OutputValue' \
  --output text)"
export BUILD_ID="$(aws codebuild start-build \
  --region "$AWS_REGION" --project-name "$BUILD_PROJECT" \
  --query 'build.id' --output text)"

aws codebuild batch-get-builds \
  --region "$AWS_REGION" --ids "$BUILD_ID" \
  --query 'builds[0].{status:buildStatus,logs:logs.deepLink}'
```

CodeBuild pushes mutable `latest` first and the immutable
`git-$REPOSITORY_COMMIT` tag as its final command. If the mutable push fails,
the exact commit remains rerunnable; after the immutable push succeeds, there
is no later build command that can fail and strand a successful immutable tag
behind a failed build status. The digest lookup stays in this deployment
runbook rather than the build phase.

After CodeBuild reports `SUCCEEDED`, resolve the immutable tag to its registry
digest and update every job definition to that digest:

```bash
export IMAGE_DIGEST="$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name opusloops/stem-worker \
  --image-ids imageTag="git-$REPOSITORY_COMMIT" \
  --query 'imageDetails[0].imageDigest' --output text)"
test "${IMAGE_DIGEST#sha256:}" != "$IMAGE_DIGEST"

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/stem-worker/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    SubnetIds="$SUBNET_IDS" \
    RepositoryCommit="$REPOSITORY_COMMIT" \
    WorkerImageDigest="$IMAGE_DIGEST" \
    WorkerCallbackUrl="$WORKER_CALLBACK_URL" \
    RetentionUrl="$RETENTION_URL" \
    RetentionMaintenanceSecretArn="$RETENTION_SECRET_ARN"
```

Confirm the output `WorkerImage` contains the resolved digest and all four job
definition outputs name a current revision before enabling dispatch. The
`QueueWatchdogScheduleArn` output must resolve to the enabled one-minute rule.

The three Lambda functions intentionally have no reserved-concurrency setting.
They share the regional unreserved pool, which allows this stack to deploy in
the account's current ten-concurrent-execution quota. The watchdog caps each
scan and has a 30-second timeout; its one-minute schedule cannot fan out from
queue depth. Revisit regional concurrency and alarms if other workloads are
added to the account; do not add per-function reservations without checking
the remaining unreserved quota first.

## Dispatcher IAM policy

The dedicated AWS principal whose credentials are stored on the `stem-import`
Edge Function needs exactly two Batch actions. `SubmitJob` is restricted to this
stack's queue and the four current job-definition revisions. `ListJobs` is used
only to reconcile an ambiguous `SubmitJob` response; AWS Batch does not expose a
resource type for that action, so IAM requires `Resource: "*"`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SubmitOnlyOpusloopsStemJobs",
      "Effect": "Allow",
      "Action": "batch:SubmitJob",
      "Resource": [
        "JOB_QUEUE_ARN",
        "INSPECT_JOB_DEFINITION_ARN",
        "ANALYZE_JOB_DEFINITION_ARN",
        "PROPOSE_JOB_DEFINITION_ARN",
        "RENDER_JOB_DEFINITION_ARN"
      ]
    },
    {
      "Sid": "ReconcileAmbiguousSubmission",
      "Effect": "Allow",
      "Action": "batch:ListJobs",
      "Resource": "*"
    }
  ]
}
```

Resolve every ARN from this stack's outputs after the digest-binding deployment
and attach the policy only to the dedicated dispatcher principal. It does not
need `batch:DescribeJobs`, `batch:TerminateJob`, ECR, ECS, Secrets Manager, or
IAM mutation access. Store its access key ID, secret key, and optional AWS
session token only as Edge Function secrets; never put them in the worker
payload or browser.

## Submission contract

The dispatcher submits the strict contract as URL-safe base64. Its `storage`
object contains the user-scoped session authentication described above; it must
be generated immediately before submission, never printed, and never persisted
by the dispatcher. Object references remain immutable `{bucket,key,sha256}`
values.

Its `callback` object is exactly `{url,token}`. `token` is 64 lowercase
hexadecimal characters: HMAC-SHA256 of the canonical lowercase `attemptId`,
using the Edge-only `OPUSLOOPS_WORKER_CALLBACK_SECRET` as the HMAC key. The
worker uses the ASCII hexadecimal token itself as the callback-signing key. The
token is valid only for that attempt and must not enter callbacks, artifacts,
state, application logs, or database rows.

The job name is part of the fallback's binding and must use the first eight
characters of both IDs:

```bash
aws batch submit-job \
  --region "$AWS_REGION" \
  --job-name "opusloops-inspect-${JOB_ID:0:8}-${ATTEMPT_ID:0:8}" \
  --job-queue "$JOB_QUEUE_ARN" \
  --job-definition "$INSPECT_JOB_DEFINITION_ARN" \
  --parameters payload_base64="$PAYLOAD_BASE64"
```

The worker signs every callback with the attempt token over
`<unix-seconds>.<nonce>.<raw-body>`. A retry reuses the exact nonce, timestamp,
body, and signature so the Edge Function can respond idempotently. Progress is
reported only in measured bytes, files, frames, or artifacts; model inference
without a measurable denominator is explicitly indeterminate.

## AWS bootstrap-failure fallback

The EventBridge rule matches `FAILED` jobs only from this stack's queue and four
exact job-definition revisions. Its Lambda accepts only the original
`detail.parameters.payload_base64`; it has no `batch:DescribeJobs` permission
and no command-line or environment fallback. It fails closed unless the event,
queue, job definition, stage, UUIDs, callback URL, and exact job name all bind.

For a valid event, the Lambda sends the standard version-1 `failed` callback
with code `batch_bootstrap_failed` and top-level `dispatchJobId`. The backend
must compare that ID to the attempt's authoritative `external_job_id`, rejecting
a callback from any duplicate Batch submission. The Lambda accepts only an
exact 64-character lowercase `callback.token` from the bound original Batch
payload, signs the exact raw body with it, and retries transient HTTP failures.
It has no callback-master copy and no Secrets Manager permission. HTTP 409 is
treated as already settled, which covers a worker callback that won the race.
Logs contain only the AWS job ID, validated stage when available, fixed Batch
status, and outcome; decoded payloads, session credentials, callback tokens,
callback bodies, AWS failure reasons, and secrets are never logged.

## Decoder subprocess boundary

The trusted container entrypoint is the only process that receives the Batch
payload in its command line. Before any decoder exists, it replaces itself with
the Python worker and passes the payload through descriptor 3. The worker first
disables core dumps, makes itself non-dumpable, verifies that state, and sets
`no_new_privs`; it then reads and closes descriptor 3 before parsing or spawning
children. The long-lived process command line therefore contains no payload.
FFmpeg and the calibration harness receive explicit allow-listed environments,
and a compromised same-UID decoder child cannot read the parent's ptrace-gated
environment or file descriptors containing the user session or attempt token.

This does not sandbox the audio itself: a decoder necessarily reads the input
audio and the task security group permits outbound HTTPS to Supabase and AWS
service endpoints. Security groups cannot restrict egress by hostname. Treat
third-party decoder compromise as residual data-exfiltration risk and keep the
pinned image, dependency hashes, non-root user, denied task role, and image
scanning controls in place.

There are no public port-53 egress rules. VPC workloads can still reach the
Amazon-provided Route 53 Resolver because AWS does not filter that resolver with
security groups. A production threat model that includes DNS tunneling should
associate a Route 53 Resolver DNS Firewall allow-list with the VPC; that is a
VPC-wide policy and intentionally remains outside this stack.

## Queue-age watchdog

EventBridge invokes the watchdog on `rate(1 minute)`. The Lambda accepts only a
scheduled event bound to the stack's exact named rule ARN. This does not depend
on a `SUBMITTED` state-change event: AWS Batch does not emit a state-change
event for the initial submission. On each invocation the Lambda calls
`ListJobs` for the stack's exact queue in each pre-run state: `SUBMITTED`,
`PENDING`, `RUNNABLE`, and `STARTING`.

The scan is deliberately bounded to two 100-result pages per state and the 25
oldest eligible candidates found in those pages. Each selected AWS job ID is
then passed to `DescribeJobs`. Before termination, the authoritative record
must match the candidate AWS job ID, creation timestamp, exact stack queue,
one of the four current job-definition revision ARNs, and the canonical
`opusloops-<stage>-<job UUID prefix>-<attempt UUID prefix>` name. The name's
lowercase eight-hex UUID prefixes and stage must match the job-definition
stage. The authoritative status must still be pre-run and its authoritative
`createdAt` must be at least 600 seconds old. `RUNNING` and terminal jobs are
left untouched. A `truncated: true` summary means the next scheduled invocation
will continue draining eligible work; alert if that state persists.

`DescribeJobs` returns a complete Batch record, which includes the parameters
map. The watchdog never accesses, serializes, or logs that map, the
`payload_base64` value, status reasons, session credentials, or callback token.
It logs only bounded aggregate counts and validated job ID/stage/status/outcome
fields. There is no EventBridge archive, transformed submission event, or SQS
copy of the payload.

The resulting Batch `FAILED` event reaches the standard fallback, which emits
the signed `batch_queue_timeout` callback with `dispatchJobId` when the exact
fixed termination reason is present. That AWS reason stays out of logs and the
callback body. `batch:ListJobs` and `batch:DescribeJobs` require `Resource: "*"`
because AWS Batch exposes no resource-level IAM type for those reads. The
function always supplies the exact stack queue to `ListJobs`, and
`batch:TerminateJob` remains restricted to job ARNs in this account and region.

## Hourly retention invocation

The retention schedule invokes a dedicated Lambda once per hour. It reads only
`RetentionMaintenanceSecretArn`, then sends this fixed request to the exact
allow-listed `RetentionUrl`:

```http
POST /functions/v1/stem-retention
Content-Type: application/json
X-Opusloops-Maintenance-Secret: <value read at runtime>

{"limit":25}
```

The invoker accepts only a bounded HTTP 200 JSON object containing non-negative
integer `claimed`, `deleted`, `failed`, and `remaining` counts. It retries
network errors, HTTP 429, and HTTP 5xx responses. Logs contain only those four
aggregate counts and a fixed outcome. The maintenance secret must not reuse the
Edge-only worker callback master or a Supabase service-role key.
