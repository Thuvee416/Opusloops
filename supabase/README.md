# Opusloops cloud data

The production project is `heryvahetgzfalmuprbw`. The browser receives only its
publishable API key. Database passwords, management tokens, and secret or
service-role keys must never be added to this repository.

`public.projects` stores the small JSON document required to rebuild a loop.
Audio is synthesized on the device and exported locally as WAV; rendered audio
is not uploaded. Browser roles cannot write the table directly. The public
`sync_projects` RPC requires both an authenticated user and the fixed
`app_metadata.opusloops` claim, then delegates to a private atomic reconciler.
Row Level Security remains enabled as defense in depth, and deletion tombstones
make offline reconciliation durable.

Direct Supabase signup is disabled. `create-opusloops-account` accepts only an
email-bound, single-use invitation hash and creates a confirmed user with the
fixed Opusloops claim. Invitation issue, reservation, completion, and revocation
functions are executable only by `service_role`. Plaintext invitation codes are
delivered once out of band and must never enter Git, URLs, analytics, or logs.

Account creation reserves an invitation and deterministic Auth user ID before
calling the Auth Admin API. Same-token/email retries reuse that identity, so
validation, network, server, and existing-account responses leave the
reservation intact for safe reconciliation. The release RPC is reserved for an
explicit service-side repair and clears both reservation fields. A 201 response
is returned only after completion transactionally verifies the reserved user ID
and normalized Auth email, grants the Opusloops membership claim, and finalizes
the invitation. A durable completion timestamp prevents a consumed invitation
from becoming reusable if its Auth user is later deleted.

An authenticated operator can issue a 72-hour invitation with:

```bash
./supabase/scripts/issue-invite.sh person@example.com
```

The command retrieves the server credential through the logged-in Supabase CLI,
stores only a SHA-256 hash, and prints the plaintext code once for secure
out-of-band delivery. Set `OPUSLOOPS_INVITE_HOURS` to an integer from 1 to 720
to choose a shorter or longer expiry.

Apply and verify migrations with the linked Supabase CLI:

```bash
supabase db push --linked --dry-run
supabase db push --linked
supabase test db --linked
supabase db lint --linked
supabase migration list --linked
```

Email confirmation is disabled until a production SMTP provider is configured;
invitation possession is the early-access ownership factor. Email verification
and password-recovery mail must be enabled together before authentication is
described as production-complete.

The official production origin is the dedicated `https://opusloops.com` domain
on AWS Amplify. Keep the Auth redirect allowlist and the
`create-opusloops-account` CORS allowlist aligned with that origin before any
additional production or preview host is exposed.

## Stem import pipeline

Stem imports use three private buckets and immutable object names rooted at
`USER_ID/PROJECT_ID/JOB_ID/`:

- `opusloops-stem-uploads` stores the original ZIP during its seven-day recovery
  window. Its per-object ceiling is 2 GiB.
- `opusloops-stem-sources` stores extracted originals and canonical 48 kHz
  float32 WAV sources until the project has remained deleted for 30 days.
- `opusloops-stem-artifacts` stores manifests, analysis, click auditions,
  conformed renders, waveforms, and mobile preview segments.

The buckets are private. An authenticated Opusloops member may upload only the
exact `source.zip` allocated to an `uploading` job. Direct object reads close as
soon as the one current processing stage ends; review and playback use the
short-lived `signed-download` path. Browser roles cannot update/delete objects
or mutate job tables directly. A worker using the user's S3 session may insert
extracted sources only at
`USER/PROJECT/JOB/sources/RELATIVE_PATH_HASH-SOURCE_SHA256.EXT`, and artifacts
only at `USER/PROJECT/JOB/attempts/ACTIVE_ATTEMPT/STAGE/...` while that exact
stage is running. There is no worker update or delete policy. Cleanup always
uses the Storage API; deleting rows from `storage.objects` would orphan files.

The browser calls the authenticated `stem-import` Edge Function with one of
these actions:

| Action | Required payload beyond `action` | Result |
| --- | --- | --- |
| `create` | `projectId`, `file: {name,size,type,lastModified}` | Job plus the direct TUS endpoint, bucket, immutable object name, and 6 MiB chunk size |
| `finalize-upload` | `jobId`, `revision` | Verified job and `inspect` dispatch |
| `approve-analysis` | `jobId`, `revision`, `inspectionManifestSha256`, `selection`, all four Gate A confirmations | Hash-bound Gate A and `analyze` dispatch |
| `request-proposal` | `jobId`, `revision`, `analysisSha256`, `proposalId`, `targetBpm` (20–400 for conforming modes; omitted for no-conform), `mode`, reviewed `reviewedGrid`, `meterNumerator`, `meterDenominator`, `firstDownbeatSeconds` | `propose` dispatch |
| `approve-tempo` | `jobId`, `revision`, `proposalManifestSha256`, `approval`, all eight Gate B confirmations | Hash-bound Gate B and `render` dispatch |
| `dispatch` | `jobId` | Idempotently retry/reconcile the current queued attempt; never creates a new attempt |
| `cancel` | `jobId`, `revision` | Cancelled non-terminal job |
| `signed-download` | `jobId`, `assetId`, optional `expiresInSeconds` | A 60–3600 second signed artifact URL |

All mutations use the current job `revision`; stale decisions fail with HTTP
409. Jobs and their events/assets are read through PostgREST under RLS. Worker
progress is determinate only when it has measured `completed`, `total`, and
`unit`. Beat-model work remains explicitly indeterminate rather than displaying
a simulated percentage.

The reviewed grid is required before proposal dispatch. It carries strictly
increasing `beats_seconds`, ordered `downbeats_seconds` that are also beat
events, `analysis_sha256`, and `reviewed: true`; meter and first downbeat are
validated separately. The database persists a canonical audit hash of those
inputs. Per-region BPM values shown after proposal generation are derived and
read-only: corrections must be made to the reviewed grid before proposal, and
the one chosen target BPM controls the uniform output.

The client uploads files larger than 6 MB through Supabase's direct resumable
endpoint:

```text
https://heryvahetgzfalmuprbw.storage.supabase.co/storage/v1/upload/resumable
```

Use exactly 6 MiB TUS chunks, the current user JWT, the public browser key,
`x-upsert: false`, and the `bucketName`, `objectName`, and `contentType`
metadata. Before release, set the project-wide Storage upload limit to at least
2 GiB; the bucket limit cannot raise a lower global limit.

### Worker boundary

`stem-import` submits one of four immutable stages (`inspect`, `analyze`,
`propose`, or `render`) to the configured AWS Batch queue. A project-wide
admission lock permits one queued/running 4-vCPU job at a time while the initial
AWS quota is six Fargate vCPUs. Upload and human-review states may overlap. A
failed or ambiguous AWS submission leaves the transitioned database job durably
queued and returns it with `dispatch.state = "pending"`. The authenticated
`dispatch` action retries the same active attempt. It first reconciles the
deterministic Batch job name, binds a discovered AWS job ID, and submits only
when no accepted job exists. A callback that wins the SubmitJob-response race
may bind the first authoritative `dispatchJobId`; every competing ID is rejected
under the job lock. A late SubmitJob recorder is idempotent and cannot regress a
running attempt.

Dispatch requires a freshly validated user JWT with at least 2,700 seconds
remaining (the browser should refresh at 3,000 seconds). The Batch payload uses
Supabase's RLS-enforcing S3 session-token contract:

```text
storage.accessKeyId     = Supabase project ref
storage.secretAccessKey = legacy JWT-shaped SUPABASE_ANON_KEY
storage.sessionToken    = current validated user JWT
```

Do not substitute generated Supabase S3 access keys: those bypass Storage RLS.
The session fields are sensitive in transit to the selected Batch task and must
never be logged, copied into callbacks, or persisted in job/event state.

The worker sends events to `stem-worker-callback`. This endpoint has no browser
CORS surface. Each request is limited to 256 KiB and includes:

```text
X-Opusloops-Job-Id: JOB_UUID
X-Opusloops-Nonce: REQUEST_UUID
X-Opusloops-Timestamp: UNIX_SECONDS
X-Opusloops-Attempt: ATTEMPT_UUID
X-Opusloops-Signature: LOWERCASE_HEX_HMAC_SHA256
```

The signed bytes are `TIMESTAMP.NONCE.RAW_BODY`. Timestamps have a five-minute
window; nonces are stored atomically. Retrying the exact signed request is
idempotent, while reusing a nonce with different bytes is rejected. Events are
validated against the active job attempt, and determinate counters must be
monotonic for the same `detail.operation` and unit. Every callback body also
contains top-level `dispatchJobId`; it must match the attempt's authoritative
AWS Batch ID. The hourly maintenance pass retains callback nonce responses for
24 hours, well beyond the signed-request retry window, then prunes them.

The global `OPUSLOOPS_WORKER_CALLBACK_SECRET` is a Supabase-only master. For
each dispatch, `stem-import` derives `callback.token` as lowercase hex
`HMAC-SHA256(master, lowercase_attempt_uuid)` and puts only that 64-character
attempt token in the Batch payload. The worker uses the ASCII token as the HMAC
key for the signed bytes above; `stem-worker-callback` derives the same token
from `X-Opusloops-Attempt`. A task or decoder compromise therefore does not
reveal the master or authorize another attempt. Neither token nor master may be
logged, returned, callbacked, or persisted in job state.

Configure these Edge Function secrets without committing their values:

```text
OPUSLOOPS_AWS_REGION
OPUSLOOPS_AWS_ACCESS_KEY_ID
OPUSLOOPS_AWS_SECRET_ACCESS_KEY
OPUSLOOPS_AWS_SESSION_TOKEN             # only for temporary credentials
OPUSLOOPS_AWS_BATCH_JOB_QUEUE
OPUSLOOPS_AWS_BATCH_INSPECT_JOB_DEFINITION
OPUSLOOPS_AWS_BATCH_ANALYZE_JOB_DEFINITION
OPUSLOOPS_AWS_BATCH_PROPOSE_JOB_DEFINITION
OPUSLOOPS_AWS_BATCH_RENDER_JOB_DEFINITION
OPUSLOOPS_STORAGE_REGION                # defaults to us-east-1
OPUSLOOPS_WORKER_CALLBACK_URL            # defaults to this project's function URL
OPUSLOOPS_WORKER_CALLBACK_SECRET
OPUSLOOPS_RETENTION_MAINTENANCE_SECRET   # random 32+ character value
```

The Edge dispatcher principal allows `batch:SubmitJob` only for the exact queue
and four versioned stage job definitions. It also needs `batch:ListJobs` with
`Resource: "*"` because AWS Batch does not expose a resource type for that
action. The callback master is set as
`OPUSLOOPS_WORKER_CALLBACK_SECRET` only in the two Supabase Edge Functions. AWS
receives the derived per-attempt `callback.token` inside the strict Batch
payload; it does not store or inject the master. AWS tasks receive no
project-wide Supabase Storage credential.

### Retention executor

`stem-retention` is an internal POST-only function. It claims at most 50 leased
objects (25 by default), deletes each through the Storage API, and marks database
rows only after Storage confirms success. Failures release the lease with
bounded backoff. The database also scans Storage's authoritative object index in
bounded pages, so files uploaded before a worker crash or rejected asset
callback are deleted. Parent-free prefix inventory survives hard project and
Auth-user cascades. A project restore is fenced while deletion is leased and is
rejected after any project-deletion object succeeds; stale completion also
rechecks eligibility. Upload finalization rejects expired or previously claimed
archives.

Production scheduler contract:

```text
POST https://heryvahetgzfalmuprbw.supabase.co/functions/v1/stem-retention
Content-Type: application/json
X-Opusloops-Maintenance-Secret: <runtime secret>

{"limit":25}
```

HTTP 200 returns only aggregate counts:
`{"claimed":N,"deleted":N,"failed":N,"remaining":N}`. The production hook is
the hourly EventBridge rule and retention-invoker Lambda in
`infra/stem-worker`; the Lambda reads `RetentionMaintenanceSecretArn` from
Secrets Manager at runtime, retries network/503 failures, and must never log the
secret, paths, response body, or user identifiers. Do not place the secret in a
schedule target, template parameter value, or repository file.

Deploy in dependency order:

```bash
supabase db push --linked --dry-run
supabase db push --linked
supabase test db --linked
supabase db lint --linked

# Keep this 0600 env file outside the repository and shell history.
supabase secrets set --project-ref heryvahetgzfalmuprbw \
  --env-file /secure/runtime/opusloops-edge.env

supabase functions deploy stem-worker-callback --project-ref heryvahetgzfalmuprbw --no-verify-jwt
supabase functions deploy stem-import --project-ref heryvahetgzfalmuprbw
supabase functions deploy stem-retention --project-ref heryvahetgzfalmuprbw --no-verify-jwt
supabase functions list --project-ref heryvahetgzfalmuprbw
```

Provision the exact Batch queue/job definition and set all secrets before
exposing the import control in Amplify. A successful function deployment is not
an end-to-end test: complete an authenticated ZIP upload, both approval gates,
render, signed playback, and retention cleanup with a private fixture.
