# Opusloops native AWS backend

This replaces hosted Supabase database, Auth, Storage and Edge Functions. The
static PWA stays on AWS Amplify, which builds GitHub `main` automatically.
Historical SQL lives under `supabase/migrations/`; it is compiled into ordinary
PostgreSQL with an app-owned identity/object registry, not a Supabase server.

## Services and boundaries

| Responsibility | AWS service |
| --- | --- |
| Projects, stem jobs, approvals, event history | Private encrypted RDS PostgreSQL 17 |
| Passwords, sessions, verified account attributes | Amazon Cognito |
| ZIP uploads, original stems, playback/render artifacts | Three private versioned S3 buckets |
| Authenticated application endpoints | HTTP API Gateway and Lambda |
| Database access | IAM-only VPC Lambda, TLS and RDS IAM authentication |
| Audio analysis and tempo render | Existing AWS Batch queue, native job definitions |
| Object registration, failure handling and cleanup | EventBridge and Lambda |

Account `368310207026`, region `us-east-1`. App endpoint:
`https://2psb3vs3pl.execute-api.us-east-1.amazonaws.com`.
CloudFormation stacks: `opusloops-aws-backend`, `opusloops-aws-data`,
`opusloops-aws-application`. The worker queue/build stack remains
`opusloops-stem-worker`.

Cognito subjects map to the original immutable Opusloops user UUID. Existing
project IDs, file keys, manifests and approval hashes remain unchanged. Password
hash import preserves existing passwords; users sign in again because old
Supabase refresh tokens are not Cognito sessions. The PWA retains account-scoped
offline project storage and uses a separate AWS auth-session key.

The public API verifies every access token with Cognito before invoking the
private database bridge. It exposes explicit RPCs, not SQL or a generic admin
proxy. The database bridge sets transaction-local identities for RLS. Worker
credentials are temporary STS sessions restricted to one job's reads and one
attempt/stage's writes. Buckets reject non-conditional final writes. Browser
uploads never receive AWS account credentials or send auth tokens to S3.

## Verification

From the repository root:

```sh
bash scripts/validate-mobile.sh
bash infra/aws-backend/database/test.sh
```

From this directory:

```sh
npm ci
npm test
node build.mjs api database migration
```

`operator/canary.mjs` creates disposable synthetic accounts and validates bcrypt
import, sign-in/refresh/revocation, profile/project saves, account isolation and
multipart upload integrity. `operator/worker-canary.mjs` uses generated test
tones through all four processing stages and verifies signed, range-readable
audio artifacts. It grants gates only for its synthetic fixture. A failed audio
canary is retained for diagnosis, never confused with a successful cleanup.

With Playwright installed, `operator/browser-canary.mjs` tests the actual mobile
browser client, CSP/CORS, sign-in, project save, 8 MiB multipart transfer and S3
range reads. Set `PLAYWRIGHT_MODULE` to the module path. It defaults to the live
site; `OPUS_QA_URL=http://127.0.0.1:4173` selects local testing. It creates and
removes only its own synthetic account and files.

## Operator deployment

Authenticate with `aws login --region us-east-1`. All operators reject a different
AWS account. They use the signed-in session, not long-lived keys.

```sh
node operator/deploy-foundation.mjs
node build.mjs api database migration
node operator/deploy-data.mjs
node operator/deploy-api.mjs
```

The default data deployment excludes/removes the temporary migration helper.
Only during an authorized migration or synthetic canary run, deploy it with
`OPUSLOOPS_INCLUDE_MIGRATION_HELPER=true node operator/deploy-data.mjs`; run the
default deployment again afterward. Never grant the public API invoke permission
on that helper.

To build the worker, publish the tested worker commit to `main`, then run
`node operator/build-worker.mjs`. It pins CodeBuild to that exact commit without
changing the currently deployed image. After a successful build, pass its
verified ECR digest in `OPUSLOOPS_WORKER_IMAGE` to `operator/deploy-api.mjs`.
Subsequent API releases preserve the deployed digest by default.

The database migration helper is temporary and has no public endpoint or app
invoke permission. Its master password exists only in the operator's memory and
the encrypted Lambda Invoke request. No credential values, user documents, or
password hashes are printed. `.operator/`, build output, local environments and
dependency directories must never be committed.

## Migration order and recovery

1. Provision the new dedicated foundation. Bootstrap only an empty target.
2. Take an encrypted source snapshot; restore into the non-live target.
3. Copy all source objects and verify SHA-256 and exact byte sizes.
4. Test native account, storage, SQL ownership and actual worker paths.
5. Announce a short maintenance window, drain active source jobs, then run
   `node operator/fence-source.mjs freeze`. This blocks old cached clients from
   writing behind the new backend. It does not delete source data.
6. Take and restore the final consistent snapshot. Re-run file verification and
   compare normalized database contents, not just counts. Import/bind identities
   from that same frozen snapshot. Do not silently reset any password.
7. Mark the target live; publish AWS client config/CSP/cache revision to `main`.
   Verify CI, the exact live `version.json`, authenticated operations and audio.
8. Retire legacy Supabase worker hooks and remove the temporary migration Lambda.
   Retain encrypted backup manifests and the frozen Supabase source for rollback.

Before the target is live, `node operator/fence-source.mjs unfreeze` restores
source writes if cutover is aborted. **After AWS has accepted real writes, do not
simply point the app back at Supabase**: first fence AWS writes, export its changes
and reconcile them so new work is not lost. Target snapshot restore is refused
once `private.aws_migration_state.live_at` is set.

Supabase project deletion and organization billing cancellation are separate,
destructive operations. Do not delete the rollback source or cancel a shared Pro
organization as a side effect of deploying this code.

## Operational considerations

RDS is single-AZ `db.t4g.micro` initially, with 20 GiB encrypted gp3 storage,
14-day backups and deletion protection. It is not an auto-pausing free database.
Resize or enable Multi-AZ as load/recovery requirements grow. AWS account Lambda
concurrency is currently 10; the broker uses one connection per invocation and
the database role has a 10-connection ceiling. Review quota/capacity before
increasing traffic. MFA is not exposed by the current UI; source accounts had no
MFA factors during migration.

S3 incomplete multipart uploads expire after seven days. Completed object
retention follows the existing database outbox and deletes exact-key versions,
not broad prefixes. A separate registry receives S3 creation events so worker
state artifacts remain visible to retry/cleanup logic.
