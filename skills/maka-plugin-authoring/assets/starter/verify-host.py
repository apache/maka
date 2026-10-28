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

"""Public Unix Host smoke test for the generated Echo service."""
import argparse
import json
import pathlib
import select
import socket
import struct
import subprocess
import tempfile
import uuid


def write_frame(stream, value):
    data = json.dumps(value).encode()
    remaining = memoryview(struct.pack(">I", len(data)) + data)
    while remaining:
        written = stream.write(remaining)
        if not written:
            raise EOFError("Host channel closed while writing")
        remaining = remaining[written:]
    stream.flush()


def read_frame(stream):
    def exact(size):
        data = bytearray()
        while len(data) < size:
            if not select.select([stream], [], [], 15)[0]:
                raise TimeoutError("Host frame timed out")
            chunk = stream.read(size - len(data))
            if not chunk:
                raise EOFError("Host closed before completing a frame")
            data.extend(chunk)
        return data
    size = struct.unpack(">I", exact(4))[0]
    return json.loads(exact(size))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maka", default="maka")
    args = parser.parse_args()
    if not hasattr(socket, "AF_UNIX"):
        parser.error("This fixture requires Unix sockets (macOS/Linux).")
    starter = pathlib.Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="maka-echo-", dir="/tmp") as temporary:
        base = pathlib.Path(temporary)
        def run(*command):
            return json.loads(subprocess.check_output([args.maka, *map(str, command)], timeout=30))
        def save(path, value):
            path.write_text(json.dumps(value))
        subprocess.run(["node", str(starter / "create.mjs"), "--maka", args.maka,
                        "--target", "host", "--output", str(base / "example")],
                       check=True, capture_output=True, timeout=30)
        project = base / "example"
        manifest = json.loads((project / "plugin/maka.extension.json").read_text())
        contract = manifest["application"]["host"]["exports"]["Echo"]["contract"]
        consumer = base / "consumer"
        consumer.mkdir()
        (consumer / "consumer.mjs").write_text("export function activate() { return {}; }")
        save(consumer / "maka.extension.json", {
            "schemaVersion": 1, "id": "example.echo-test",
            "application": {"host": {
                "implementation": {"kind": "javascript", "module": "consumer.mjs", "realm": "dedicated"},
                "configuration": {"type": "object"}, "exports": {},
                "imports": {"echo": {"contract": contract, "cardinality": {"kind": "one"}}},
            }},
        })
        composition = json.loads((project / "composition.json").read_text())
        key = str(uuid.uuid4())
        composition["instances"]["consumer"] = {
            "key": key, "package": {"source": "pinned", "package": run("application", "inspect-package", "--package", consumer)},
            "usePackage": "host", "bindings": {"echo": [{"kind": "instance", "path": ["example"], "export": "Echo"}]},
        }
        save(project / "composition.json", composition)
        root = base / "root"
        run("host", "init", "--root", root)
        source = run("application", "commit", "--root", root, "--deployment", str(uuid.uuid4()),
                     "--expected-revision", "0", "--input", project / "composition.json",
                     "--package", project / "plugin", "--package", consumer)
        endpoints = base / "endpoints.json"
        save(endpoints, {
            "echo": {"consumer": [key], "import": "echo", "grant": {"methods": ["echo"], "recovery": False}},
        })
        # The trusted launcher publishes only this declared query. Plugin
        # business code uses its bound capability, not this public wire adapter.
        with subprocess.Popen([args.maka, "application", "serve", "--root", str(root),
                               "--deployment", source["deployment"], "--endpoints", str(endpoints)],
                              stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, bufsize=0) as host:
            try:
                if not select.select([host.stdout], [], [], 15)[0]:
                    raise TimeoutError("Host startup timed out")
                ready = json.loads(host.stdout.readline(16 * 1024))
                assert ready["kind"] == "ready", ready
                assert ready["rootId"] == source["stateDomain"], ready
                address = ready["socketPath"]

                def connect():
                    connection = socket.socket(socket.AF_UNIX)
                    connection.settimeout(15)
                    connection.connect(address)
                    return connection

                def opening(channel, request, epoch=None):
                    write_frame(channel, {"version": 1, "epoch": epoch, "request": request})
                    return read_frame(channel)

                with connect() as connection, connection.makefile("rwb", buffering=0) as control:
                    connected = opening(control, {"kind": "connect"})
                    assert connected["kind"] == "connected", connected
                    connected = connected["value"]
                    assert connected["version"] == 1 and connected["source"] == source, connected
                    assert connected["consumers"]["echo"] == [key], connected
                    epoch = connected["epoch"]
                    registration = connected["catalogue"]["endpoints"]["echo"]["registration_epoch"]
                    assert registration, connected
                    with connect() as probe, probe.makefile("rwb", buffering=0) as channel:
                        status = opening(channel, {"kind": "status"}, epoch)
                        assert status["kind"] == "status", status
                        assert status["value"]["lifecycle_mode"] == "service", status
                        assert status["value"]["source"] == source, status
                        assert not status["value"]["closing"], status
                    for value, valid in [("hello Maka", True), ("😀" * 8192, True), (42, False)]:
                        with connect() as call, call.makefile("rwb", buffering=0) as channel:
                            accepted = opening(channel, {"kind": "call", "session": connected["session"]}, epoch)
                            assert accepted == {"kind": "accepted"}, accepted
                            write_frame(channel, {
                                "endpoint": "echo", "registration_epoch": registration,
                                "method": "echo", "input": value,
                                "source": {"deployment": source, "consumer": [key], "mount": str(uuid.uuid4()), "request": str(uuid.uuid4())},
                            })
                            write_frame(channel, {})
                            reply = read_frame(channel)
                            if reply["kind"] == "ready":
                                reply = read_frame(channel)
                            assert reply["cleanup"] == {"Ok": None}, reply
                            if valid:
                                assert reply["kind"] == "finished" and reply["result"] == {"Ok": value}, reply
                            else:
                                assert reply["kind"] == "aborted", reply
                    # Closing the session confirms original call cleanup without
                    # stopping this Service-mode Host.
                    write_frame(control, {"kind": "close"})
                    assert read_frame(control) == {"kind": "closed"}
                with connect() as connection, connection.makefile("rwb", buffering=0) as channel:
                    status = opening(channel, {"kind": "status"}, epoch)
                    assert status["value"]["sessions"] == 0, status
                    assert status["value"]["active_calls"] == 0, status
                    assert not status["value"]["closing"], status
                with connect() as connection, connection.makefile("rwb", buffering=0) as channel:
                    retired = opening(channel, {"kind": "retire", "interrupt": False}, epoch)
                    assert retired == {"kind": "retired", "value": {"Ok": True}}, retired
                assert host.wait(timeout=15) == 0
                assert not pathlib.Path(address).exists(), "Host socket was not removed"
                # Reopening validates both persisted content and release of the
                # original Root lease after successful Host cleanup.
                persisted = run("application", "read", "--root", root, "--deployment", source["deployment"])
                assert persisted["reference"] == source, persisted
            finally:
                if host.poll() is None:
                    host.kill()
                    host.wait(timeout=15)
    print("Host Echo: ASCII/Unicode, invalid inputs and clean shutdown passed.")


if __name__ == "__main__":
    main()
