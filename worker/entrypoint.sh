#!/bin/sh
set -eu

worker=/opt/opusloops/venv/bin/opusloops-stem-worker

if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
  exec "$worker" "$1"
fi

if [ "$#" -ne 3 ] || [ "$2" != "--payload-base64" ]; then
  printf '%s\n' 'invalid worker invocation' >&2
  exit 64
fi

case "$1" in
  inspect|analyze|propose|render) ;;
  *)
    printf '%s\n' 'invalid worker stage' >&2
    exit 64
    ;;
esac

payload=$3
if [ "${#payload}" -gt 524288 ]; then
  printf '%s\n' 'worker payload is too large' >&2
  exit 64
fi
case "$payload" in
  *[!A-Za-z0-9_+/=-]*)
    printf '%s\n' 'worker payload encoding is invalid' >&2
    exit 64
    ;;
esac

# The trusted wrapper is the only process that receives the secret-bearing
# Batch parameter in argv. exec replaces that argv before any decoder exists;
# the worker reads and closes fd 3 before it launches an untrusted child.
exec "$worker" "$1" --payload-fd 3 3<<EOF
$payload
EOF
