#!/usr/bin/env python3
"""Run isolated core workflows against the Studio served at 127.0.0.1:4196.

Requires Node/Playwright; set NODE_PATH and OPUS_CHROMIUM when using a custom
runtime. Tests create separate browser profiles and never use a signed-in tab.
An optional --audio fixture must be stereo and longer than 180 seconds. It stays
local. The runner emits logs, exact proof snapshots and a source-bound report.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CASES = ['workspace-resume', 'import-permission', 'audio-interruption',
         'computer-keyboard', 'capture-placement', 'midi-placement', 'clip-loop',
         'offline-export', 'studio-effects', 'long-tail', 'arrangement-delivery',
         'session-delivery', 'session-start-cancellation', 'session-live-mix',
         'metadata-mix', 'automation-take', 'automation-loop', 'recording-seek',
         'midi-gesture', 'playback-edit-lock', 'note-preview', 'menu-navigation', 'touch-editing', 'save-shortcut', 'note-draw', 'note-insert', 'live-midi-engine', 'live-midi-editor', 'agent-live-midi', 'note-time-selection', 'live-mixer', 'midi-loop-preservation']

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--jobs', type=int, choices=range(1, 5), default=2)
    args = parser.parse_args()
    if args.audio and not args.audio.is_file():
        parser.error('--audio must name an existing local fixture')
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, OPUS_HISTORY_STRESS='1',
               OPUS_RESUME_PROOF=str(out / 'workspace-resume-proof.json'),
               OPUS_LONG_PROOF=str(out / 'long-audio-roundtrip-proof.json'))
    if args.audio:
        env['OPUS_TEST_AUDIO'] = str(args.audio.resolve())
    cases = CASES + (['long-audio-roundtrip'] if args.audio else [])
    runtime = {str(p.relative_to(ROOT)): digest(p)
               for p in sorted((ROOT / 'web-studio').rglob('*')) if p.is_file()}
    report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'release': json.loads((ROOT / 'web-studio/release.json').read_text()),
              'runtimeHashes': runtime, 'runnerHash': digest(Path(__file__)),
              'audioFixtureHash': digest(args.audio) if args.audio else None,
              'scope': 'Isolated local Chromium workflows. No personal browser session, microphone or live model evaluation. Tests retain their own narrower verification boundaries.'}

    def run(name):
        script = ROOT / 'tests' / (name + '-browser.cjs')
        started = time.monotonic()
        try:
            result = subprocess.run(['node', str(script)], cwd=ROOT, env=env,
                                    text=True, capture_output=True, timeout=180)
            code, log = result.returncode, result.stdout + result.stderr
        except subprocess.TimeoutExpired:
            code, log = 124, 'The isolated test exceeded its 180-second deadline.\n'
        except OSError as error:
            code, log = 127, str(error) + '\n'
        (out / (name + '.log')).write_text(log)
        item = {'case': name, 'exit': code, 'seconds': round(time.monotonic()-started, 2),
                'testHash': digest(script)}
        proof = (out / ('workspace-resume-proof.json' if name == 'workspace-resume' else 'long-audio-roundtrip-proof.json')) if name in ['workspace-resume', 'long-audio-roundtrip'] else ROOT / 'tests/fixtures' / (name + '-browser-proof.json')
        if code == 0:
            try:
                data = json.loads(proof.read_text())
                if data.get('status') != 'passed':
                    raise ValueError('Test proof does not report passed')
                snapshot = out / (name + '-proof.json')
                snapshot.write_text(json.dumps(data, indent=2)+'\n')
                item['proofHash'] = digest(snapshot)
            except (OSError, ValueError) as error:
                item['exit'], item['error'] = 1, str(error)
        print(json.dumps(item), flush=True)
        return item

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        report['cases'] = list(pool.map(run, cases))
    report['runtimeUnchanged'] = all(p.is_file() and digest(p) == value for key, value in runtime.items() for p in [ROOT / key])
    report['status'] = 'passed' if report['runtimeUnchanged'] and all(r['exit'] == 0 for r in report['cases']) else 'failed'
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (out / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
    return 0 if report['status'] == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
