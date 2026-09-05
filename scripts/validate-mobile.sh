#!/usr/bin/env bash

set -euo pipefail

for required in index.html frame-guard.js styles.css config.js cloud-client.js app.js manifest.webmanifest service-worker.js icons/icon-192.png icons/icon-512.png icons/apple-touch-icon.png; do
  if [[ ! -s "mobile/$required" ]]; then
    echo "Required mobile asset is missing or empty: mobile/$required" >&2
    exit 1
  fi
done

python3 - <<'PY'
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.has_viewport = False
        self.has_manifest = False
        self.local_assets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "meta" and attributes.get("name", "").lower() == "viewport":
            self.has_viewport = True
        if tag == "link" and "manifest" in attributes.get("rel", "").lower().split():
            self.has_manifest = True
        for attribute in ("href", "src"):
            value = attributes.get(attribute)
            if value:
                self.local_assets.append(value)


root = Path("mobile")
root_resolved = root.resolve()
index_path = root / "index.html"
manifest_path = root / "manifest.webmanifest"
service_worker_path = root / "service-worker.js"


def local_path(reference, label):
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    if parsed.path.startswith("/"):
        raise SystemExit(
            f"{label}: production assets must use portable relative paths, got {reference!r}"
        )
    candidate = (root / unquote(parsed.path)).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise SystemExit(f"{label}: asset path escapes mobile/: {reference!r}")
    return candidate


parser = PageParser()
index_source = index_path.read_text(encoding="utf-8")
service_worker_source = service_worker_path.read_text(encoding="utf-8")
parser.feed(index_source)
if not parser.has_viewport:
    raise SystemExit(f"{index_path}: mobile viewport metadata is required")
if not parser.has_manifest:
    raise SystemExit(f"{index_path}: the PWA manifest must be linked")

for asset in ("frame-guard.js", "styles.css", "config.js", "cloud-client.js", "app.js"):
    pattern = re.compile(rf"\./{re.escape(asset)}\?v=(\d+)")
    index_match = pattern.search(index_source)
    worker_match = pattern.search(service_worker_source)
    if not index_match or not worker_match or index_match.group(1) != worker_match.group(1):
        raise SystemExit(
            f"{asset}: index and service-worker asset versions must exist and match"
        )

for reference in parser.local_assets:
    asset_path = local_path(reference, index_path)
    if asset_path is None:
        continue
    if not asset_path.is_file():
        raise SystemExit(f"{index_path}: referenced asset is missing: {asset_path}")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
for field in ("name", "short_name", "start_url", "display", "icons"):
    if not manifest.get(field):
        raise SystemExit(f"{manifest_path}: missing required PWA field {field!r}")
if manifest["name"] != "Opusloops" or manifest["short_name"] != "Opusloops":
    raise SystemExit(f"{manifest_path}: PWA name and short_name must both be Opusloops")

for field in ("id", "start_url", "scope"):
    value = manifest.get(field)
    if value != "./":
        raise SystemExit(
            f"{manifest_path}: {field} must be './' for origin-portable hosting, got {value!r}"
        )

for icon in manifest["icons"]:
    source = icon.get("src", "").split("?", 1)[0].split("#", 1)[0]
    icon_path = local_path(source, manifest_path) if source else None
    if icon_path is None:
        raise SystemExit(f"{manifest_path}: icons must use relative local paths, got {source!r}")
    if not icon_path.is_file() or icon_path.stat().st_size == 0:
        raise SystemExit(f"{manifest_path}: referenced icon is missing: {icon_path}")
PY

node --check mobile/app.js
node --check mobile/config.js
node --check mobile/cloud-client.js
node --check mobile/frame-guard.js
node --check mobile/service-worker.js

if grep -RniE 'magda|conceptual machines|anthropic' mobile; then
  echo "Production mobile files contain retired or third-party product branding." >&2
  exit 1
fi

if grep -RniE 'sb_secret_|service[_-]?role' mobile; then
  echo "Production mobile files contain a privileged Supabase credential marker." >&2
  exit 1
fi

grep -Fq 'https://heryvahetgzfalmuprbw.supabase.co' mobile/index.html
grep -Fq 'sb_publishable_' mobile/config.js

migration='supabase/migrations/20260905110000_create_user_projects.sql'
test -s "$migration"
grep -Fq 'alter table public.projects enable row level security' "$migration"
grep -Fq 'revoke all on table public.projects from anon, authenticated' "$migration"
test "$(grep -c '^create policy ' "$migration")" -eq 4

atomic_sync='supabase/migrations/20260905123000_add_atomic_project_sync.sql'
membership='supabase/migrations/20260905135000_require_opusloops_membership_for_sync.sql'
invites='supabase/migrations/20260905130000_create_single_use_signup_invites.sql'
test -s "$atomic_sync" -a -s "$membership" -a -s "$invites"
grep -Fq 'pg_advisory_xact_lock' "$atomic_sync"
grep -Fq "'app_metadata' ->> 'opusloops'" "$membership"
grep -Fq 'grant execute on function public.sync_projects(jsonb) to authenticated' "$membership"
grep -Fq 'grant execute on function public.claim_opusloops_signup_invite(text, text) to service_role' "$invites"
test "$(grep -c '^enable_signup = false$' supabase/config.toml)" -eq 2
grep -Fq 'site_url = "https://opusloops.com/"' supabase/config.toml
grep -Fq '"https://www.opusloops.com/**"' supabase/config.toml
grep -Fq 'verify_jwt = false' supabase/config.toml
grep -Fq 'OPUSLOOPS_PUBLISHABLE_KEY_HASH' supabase/functions/create-opusloops-account/index.ts
grep -Fq '"https://opusloops.com"' supabase/functions/create-opusloops-account/index.ts
grep -Fq '"https://www.opusloops.com"' supabase/functions/create-opusloops-account/index.ts
