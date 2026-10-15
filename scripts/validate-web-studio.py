#!/usr/bin/env python3
"""Check the standalone browser DAW's publish root and module dependencies."""
from pathlib import Path
import json, re, subprocess
from urllib.parse import urlsplit
root = Path('web-studio')
assert json.loads((root / 'release.json').read_text())['version']
for name in ['index.html', 'app.js', 'workspace.js', 'menus.js', 'service-worker.js', 'third-party-notices.html']:
    assert (root / name).is_file(), name
for path in root.rglob('*.js'):
    subprocess.run(['node', '--input-type=module', '--check'], input=path.read_bytes(), check=True, capture_output=True)
    for ref in re.findall(r"(?:from\s*|import\s*)['\"](\.[^'\"]+)['\"]", path.read_text()):
        assert (path.parent / urlsplit(ref).path).is_file(), (path, ref)
for ref in re.findall(r'(?:src|href)="([^"#]+)"', (root / 'index.html').read_text()):
    if ref == './' or urlsplit(ref).scheme: continue
    assert (root / urlsplit(ref).path.lstrip('/')).is_file(), ref
print('Web studio artifact and module checks passed')
