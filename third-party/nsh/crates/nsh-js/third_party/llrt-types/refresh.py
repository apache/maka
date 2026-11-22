#!/usr/bin/env python3
"""Restore byte-identical upstream type assets at the reviewed pinned revision.

Changing the revision requires reviewing upstream API changes and updating the
recorded hashes explicitly. This script never runs in an application build.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent
lock = json.loads((root / 'SOURCE.json').read_text())
for source, expected in lock['files'].items():
    url = f"https://raw.githubusercontent.com/awslabs/llrt/{lock['revision']}/{source}"
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read()
    if hashlib.sha256(content).hexdigest() != expected:
        raise SystemExit(f'Upstream checksum mismatch: {source}')
    destination = Path(source).name + ('.txt' if source.endswith('.d.ts') else '')
    (root / destination).write_bytes(content)
    print(f'Restored {source}')
