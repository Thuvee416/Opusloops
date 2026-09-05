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
fixed Opusloops claim. Invitation issue, claim, completion, and revocation
functions are executable only by `service_role`. Plaintext invitation codes are
delivered once out of band and must never enter Git, URLs, analytics, or logs.

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

The current GitHub Pages URL shares its browser origin with sibling project
sites. Treat every sibling site as trusted during controlled early access, and
move the PWA to a dedicated custom domain before broad account rollout.
