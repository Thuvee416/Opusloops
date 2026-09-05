#!/usr/bin/env bash

set -euo pipefail
umask 077

project_ref="${OPUSLOOPS_SUPABASE_PROJECT_REF:-heryvahetgzfalmuprbw}"
hours="${OPUSLOOPS_INVITE_HOURS:-72}"

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s email@example.com\n' "$0" >&2
  exit 64
fi

email="$(printf '%s' "$1" | awk '{$1=$1};1' | tr '[:upper:]' '[:lower:]')"
if [[ ! "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || (( ${#email} > 254 )); then
  printf 'Enter one valid email address.\n' >&2
  exit 64
fi

if [[ ! "$hours" =~ ^[0-9]+$ ]]; then
  printf 'OPUSLOOPS_INVITE_HOURS must be an integer from 1 to 720.\n' >&2
  exit 64
fi
hours="$((10#$hours))"
if (( hours < 1 || hours > 720 )); then
  printf 'OPUSLOOPS_INVITE_HOURS must be an integer from 1 to 720.\n' >&2
  exit 64
fi

for command_name in curl jq openssl supabase; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 69
  fi
done

if date -u -v+1H '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
  expires_at="$(date -u -v+"${hours}"H '+%Y-%m-%dT%H:%M:%SZ')"
else
  expires_at="$(date -u -d "+${hours} hours" '+%Y-%m-%dT%H:%M:%SZ')"
fi

keys_json="$(supabase projects api-keys \
  --project-ref "$project_ref" \
  --reveal \
  --output json)"
service_key="$(printf '%s' "$keys_json" | jq -er \
  '[.[] | select(.type == "legacy" and .name == "service_role")][0].api_key')"
unset keys_json

invite_code="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
if command -v shasum >/dev/null 2>&1; then
  token_hash="$(printf '%s' "$invite_code" | shasum -a 256 | awk '{print $1}')"
else
  token_hash="$(printf '%s' "$invite_code" | sha256sum | awk '{print $1}')"
fi

payload="$(jq -cn \
  --arg email "$email" \
  --arg token_hash "$token_hash" \
  --arg expires_at "$expires_at" \
  '{p_email:$email,p_token_hash:$token_hash,p_expires_at:$expires_at}')"

invite_id="$(curl --fail --silent --show-error \
  --request POST \
  "https://${project_ref}.supabase.co/rest/v1/rpc/issue_opusloops_signup_invite" \
  --header "apikey: $service_key" \
  --header "Authorization: Bearer $service_key" \
  --header 'Content-Type: application/json' \
  --data "$payload" | jq -er '.')"

unset service_key payload token_hash

printf 'Invitation ID: %s\n' "$invite_id"
printf 'Assigned email: %s\n' "$email"
printf 'Expires: %s\n' "$expires_at"
printf 'Invitation code (shown once): %s\n' "$invite_code"
