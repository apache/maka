#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Opt-in macOS/Linux smoke using a connected official ChatGPT extension.

Build the desktop-host example and the ignored workspace-computer native test.
See platform/computer-use/README.md. The script changes native-host registration,
restores its exact contents/mode, and the test touches only blank pages it creates.
"""

import argparse
import json
import os
import pathlib
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--test-binary", required=True)
p.add_argument("--host", required=True)
p.add_argument("--extension-id", required=True)
p.add_argument("--browser", choices=["chrome", "chromium"], default="chrome")
args = p.parse_args()
host = pathlib.Path(args.host).resolve()
test = pathlib.Path(args.test_binary).resolve()
adapter = "com.openai.codexextension"
entry = host.with_suffix(".browser-connectors") / (adapter + ".json")
testentry = test.with_suffix(".browser-connectors") / (adapter + ".json")
if sys.platform == "darwin":
    directory = pathlib.Path.home() / (
        "Library/Application Support/Google/Chrome"
        if args.browser == "chrome"
        else "Library/Application Support/Chromium"
    )
elif sys.platform.startswith("linux"):
    directory = pathlib.Path(
        os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config")
    ) / ("google-chrome" if args.browser == "chrome" else "chromium")
else:
    p.error("This hardware runner requires macOS or Linux")
manifest = directory / "NativeMessagingHosts" / f"{adapter}.json"
before = manifest.read_bytes() if manifest.exists() else None
mode = manifest.stat().st_mode if before is not None else None
if entry.exists() or testentry.exists():
    raise RuntimeError("Refusing to replace preexisting connector test selections")
guards = []
sockets = []
child = None
owned = None
with tempfile.TemporaryFile(mode="w+") as log:

    def send(sock, value):
        b = json.dumps(value).encode()
        sock.sendall(struct.pack("=I", len(b)) + b)

    def receive(sock):
        def exact(n):
            b = b""
            while len(b) < n:
                c = sock.recv(n - len(b))
                if not c:
                    raise EOFError("guardian closed")
                b += c
            return b

        return json.loads(exact(struct.unpack("=I", exact(4))[0]))

    def original():
        assert (manifest.read_bytes() if manifest.exists() else None) == before, (
            "original registration changed"
        )
        if before is not None:
            assert manifest.stat().st_mode == mode, "original permissions changed"

    def acquire():
        guard = subprocess.Popen(
            [str(host), "__maka-browser-handoff"],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        guards.append(guard)
        deadline = time.monotonic() + 25
        while True:
            if guard.poll() is not None:
                raise RuntimeError("guardian exited early")
            try:
                d = json.loads((state / "supervisor.json").read_text())
                if d["pid"] != guard.pid:
                    raise ConnectionRefusedError()
                sock = socket.socket(socket.AF_UNIX)
                sock.settimeout(25)
                sock.connect(d["address"]["address"])
                sockets.append(sock)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.025)
        send(
            sock,
            {
                "kind": "acquire",
                "owner": str(uuid.uuid4()),
                "extension_id": args.extension_id,
            },
        )
        assert receive(sock) == {"kind": "ready"}
        with socket.socket(socket.AF_UNIX) as mismatch:
            mismatch.settimeout(25)
            mismatch.connect(d["address"]["address"])
            different = "a" * 32 if args.extension_id != "a" * 32 else "b" * 32
            send(
                mismatch,
                {
                    "kind": "acquire",
                    "owner": str(uuid.uuid4()),
                    "extension_id": different,
                },
            )
            assert receive(mismatch) == {
                "kind": "failed",
                "message": "another extension is using this browser host; release it before selecting a different extension",
            }
        return guard, sock

    def release(guard, sock):
        send(sock, {"kind": "release"})
        reply = receive(sock)
        assert reply == {"kind": "released", "users": 0}, reply
        sock.close()
        sockets.remove(sock)
        guard.wait(timeout=25)
        assert guard.returncode == 0
        original()

    try:
        state = pathlib.Path.home() / ".maka-browser" / (
            "chatgpt-handoff" if args.browser == "chrome" else "chatgpt-handoff-chromium"
        )
        if (state / "registration.json").exists():
            raise RuntimeError("Another handoff is active")
        guard, sock = acquire()
        env = os.environ.copy()
        env["MAKA_BROWSER_HANDOFF_SMOKE"] = "1"
        env["RUST_MIN_STACK"] = "16777216"
        child = subprocess.Popen(
            [
                str(test),
                "--ignored",
                "--exact",
                "evaluate::browser_handoff_test::real_host_retained_browser_pages_survive_handoff",
                "--nocapture",
                "--test-threads=1",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,
        )
        for line in child.stdout:
            print(line, end="", flush=True)
            if "MAKA_HANDOFF_SMOKE:OWNED=" in line:
                owned = json.loads(line.split("MAKA_HANDOFF_SMOKE:OWNED=", 1)[1])
            if "MAKA_HANDOFF_SMOKE:RETURN" in line:
                release(guard, sock)
                print(
                    "runner: exact original registration returned between native generations",
                    flush=True,
                )
                guard, sock = acquire()
                child.stdin.write("READY\n")
                child.stdin.flush()
        child.wait(timeout=10)
        assert child.returncode == 0, (
            f"actual Host smoke failed; test-owned IDs: {owned}"
        )
        release(guard, sock)
        print(
            "runner: all native leases returned and original registration restored",
            flush=True,
        )
    finally:
        if child is not None and child.poll() is None:
            child.stdin.close()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass
        for guard in guards:
            if guard.poll() is None:
                try:
                    guard.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    guard.terminate()
                    guard.wait(timeout=5)
        subprocess.run([str(host), "browser", "restore"], check=True)
        original()
        assert not entry.exists() and not testentry.exists(), "automatic handoff wrote connector setup"
        log.seek(0)
        if child is None or child.returncode != 0:
            sys.stderr.write(log.read())
