#!/usr/bin/env python3
"""Measure packaged Wasm bytes and optionally enforce independent size budgets.

Requires the brotli CLI. Pass the final nsh.<digest>.wasm written by
`nsh package --target web`, not a development or symbol-bearing build.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wasm", type=Path)
    for encoding in ("raw", "gzip", "brotli"):
        parser.add_argument(f"--max-{encoding}", type=int, help="maximum bytes (inclusive)")
    args = parser.parse_args()
    data = args.wasm.read_bytes()
    if not data.startswith(b"\0asm\x01\0\0\0"):
        parser.error("expected a WebAssembly version 1 module")
    compressed = subprocess.run(
        ["brotli", "--quality=11", "--stdout", str(args.wasm)],
        check=True, capture_output=True,
    ).stdout
    sizes = {
        "raw": len(data),
        "gzip": len(gzip.compress(data, compresslevel=9, mtime=0)),
        "brotli": len(compressed),
    }
    print(json.dumps({
        "file": str(args.wasm),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": sizes,
    }, indent=2))
    failed = False
    for encoding, size in sizes.items():
        limit = getattr(args, f"max_{encoding}")
        if limit is not None and size > limit:
            print(f"{encoding}: {size} bytes exceeds budget {limit}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
