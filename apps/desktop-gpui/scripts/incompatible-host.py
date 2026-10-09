#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""A stand-in Runtime Host that refuses every client as a Host of another
protocol epoch does, so the window's epoch screen can be seen (and
screenshotted) without building another Maka commit.

    scripts/incompatible-host.py --root target/epoch-root --epoch 196
    scripts/incompatible-host.py --root target/epoch-root --epoch 198 --replacement blocked_by_residency

It prepares the State Root the way `resolveStorageRoot` does (the directory
and `.maka-storage-root.json`, unless they exist), writes a `service`
registration for it in the control namespace
(`~/Library/Caches/Maka/runtime-hosts/<rootId>/registration.json` on macOS,
`~/.cache/maka/runtime-hosts/...` elsewhere), and answers each `hello` on its
socket with `incompatible` in the shape `HostKernel#handshake`
(packages/runtime-host/src/server/host-kernel.ts) sends, then closes the
connection. It runs until Ctrl-C or SIGTERM and removes its registration on
the way out. Point the app at the same root:

    target/debug/maka-gpui --root "$PWD/target/epoch-root"

Use a fresh root under target/: never one a real Host serves, and never
live Maka data.
"""

import argparse
import json
import os
import secrets
import signal
import socket
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


def control_namespace() -> Path:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library/Caches/Maka/runtime-hosts"
    return home / ".cache/maka/runtime-hosts"


def prepare_root(root: Path) -> str:
    """Creates the State Root and its marker if needed; returns its rootId."""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = root / ".maka-storage-root.json"
    if marker.exists():
        return json.loads(marker.read_text())["rootId"]
    stat = root.stat()
    root_id = secrets.token_hex(32)
    contents = {
        "schemaVersion": 1,
        "kind": "interactive",
        "rootId": root_id,
        "rootIdentity": {"dev": str(stat.st_dev), "ino": str(stat.st_ino)},
    }
    fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(json.dumps(contents, separators=(",", ":")) + "\n")
    return root_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", required=True, type=Path, help="the State Root to serve")
    parser.add_argument("--epoch", required=True, type=int, help="the epoch to claim")
    parser.add_argument(
        "--replacement",
        choices=["wait_for_idle_exit", "blocked_by_residency"],
        default="wait_for_idle_exit",
        help="what the answer says about replacing this Host",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    root_id = prepare_root(root)
    root = root.resolve()
    control = control_namespace() / root_id
    control.mkdir(mode=0o700, parents=True, exist_ok=True)
    registration_path = control / "registration.json"
    if registration_path.exists():
        print(f"{registration_path} exists: another Host serves {root}", file=sys.stderr)
        return 1

    # Socket paths must stay under the 104-byte limit.
    endpoint = Path(tempfile.gettempdir()) / f"maka-incompatible-{uuid.uuid4().hex[:8]}.sock"
    host_epoch = str(uuid.uuid4())
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(endpoint))
    os.chmod(endpoint, 0o600)
    server.listen()

    registration = {
        "kind": "maka-runtime-host",
        "schemaVersion": 1,
        "rootId": root_id,
        "hostEpoch": host_epoch,
        "endpoint": str(endpoint),
        "protocolMin": 0,
        "protocolMax": 0,
        "compatibilityEpoch": args.epoch,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "lifecycleMode": "service",
        "state": "ready",
        "pid": os.getpid(),
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    temporary = control / f"registration.json.{os.getpid()}"
    temporary.write_text(json.dumps(registration))
    temporary.replace(registration_path)

    answer = {
        "kind": "incompatible",
        "hostEpoch": host_epoch,
        "protocolMin": 0,
        "protocolMax": 0,
        "compatibilityEpoch": args.epoch,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready",
        "replacement": args.replacement,
    }
    line = (json.dumps(answer) + "\n").encode()

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    print(f"refusing clients as a Host of epoch {args.epoch} for {root} (pid {os.getpid()})", flush=True)
    try:
        while True:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(5)
                try:
                    connection.recv(65536)  # the hello
                    connection.sendall(line)
                except OSError:
                    pass
    except KeyboardInterrupt:
        pass
    finally:
        registration_path.unlink(missing_ok=True)
        server.close()
        endpoint.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
