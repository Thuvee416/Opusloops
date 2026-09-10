# AWS cutover verification — 2026-09-10

Production cutover commit: `5885148561383fe4f4784f8aee1c805e1c9cc746`.
Amplify job 47 succeeded; the live `version.json` returned that exact commit.
The follow-up operator/documentation commit does not change the frontend bundle.

## Verified data preservation

- One existing user imported into Cognito with its bcrypt password preserved and
  its original Opusloops ownership UUID bound to the new subject.
- Five project rows (three active, two tombstones), two ready stem jobs, 574 assets,
  3,451 events, three invitation records and 13 attempts preserved.
- All source table contents compared after PostgreSQL type normalization; counts
  and SHA-256 digests matched, not merely table existence.
- All 601 storage objects, totaling 4,607,687,910 bytes, copied and verified.
- The source was write-fenced before the final snapshot; no source data deleted.
- The target was marked live, permanently fencing staging snapshot replacement.

The encrypted final verification record is stored in the private migration bucket:
`verification/final-cd1e6e93eb040fce7caadc1f92a38706a96d48704f9b4159d5cd9fd480849997.json`.
No passwords, hashes, tokens, email addresses or project contents are in this file.

## Tested paths

- All historical SQL isolation, concurrency, gate, retry and retention tests pass
  on native PostgreSQL; the reversible maintenance fence also passes.
- 15 native AWS contract/infrastructure tests, 34 mobile/account contract tests,
  11 mobile Create browser tests, and 315 processing/worker/infrastructure tests pass.
- Live temporary accounts verified password-hash import, sign-in, refresh,
  revocation, profile changes, saves and cross-account denial.
- A synthetic two-stem, 16-bar project completed inspect → analyze → propose →
  render through native AWS Batch. All eight generated playback segments matched
  their content hashes; the signed click preview supported range requests.
- The production site passed a 390px browser canary: native sign-in, private
  save, 8,388,735-byte multipart upload, S3 CORS/range read, no horizontal overflow,
  no browser runtime errors and zero Supabase requests.
- All synthetic accounts/files were removed. Real-user records were not edited
  by testing. Tests do not attest musical quality for every possible source file.

Worker image is pinned to
`sha256:ee68aed8bc55d3220d3837701a3220828a275a5a5e7791662f32d1d1fc40bcc4`,
built from `b4115348f2b3738769e1aa7b35a6c8512f21551b`.
Its Python ECR mirror was verified to have the same digest as the original
Docker Hub image after a shared unauthenticated pull-limit failure.

## Rollback retention

Legacy Supabase callback, watchdog and retention Lambda hooks were removed through
CloudFormation; the Batch queue, build system, images and historical logs remain.
The temporary migration helper is excluded by default from subsequent deployments.
The Supabase source remains frozen and encrypted S3 snapshots remain available.
Deleting that source or cancelling a shared Supabase organization is not part of
this release. Do not unfreeze/revert after AWS accepts writes without reconciling
the AWS-side changes first.
