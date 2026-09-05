#!/usr/bin/env python3

import datetime
import json
import os
import subprocess
from pathlib import Path


git_commit = subprocess.check_output(
    ["git", "rev-parse", "HEAD"], text=True
).strip()
amplify_commit = os.environ.get("AWS_COMMIT_ID", "").strip()

if amplify_commit not in ("", "HEAD", git_commit) and not git_commit.startswith(amplify_commit):
    raise SystemExit(
        f"Amplify commit {amplify_commit!r} does not match checkout {git_commit!r}"
    )

provenance = {
    "provider": "aws-amplify",
    "commit": git_commit,
    "repository": "Thuvee416/Opusloops",
    "branch": os.environ.get("AWS_BRANCH", "unknown"),
    "appId": os.environ.get("AWS_APP_ID", "unknown"),
    "jobId": os.environ.get("AWS_JOB_ID", "unknown"),
    "builtAt": datetime.datetime.now(datetime.timezone.utc)
    .isoformat()
    .replace("+00:00", "Z"),
}

Path("mobile/version.json").write_text(
    json.dumps(provenance, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
