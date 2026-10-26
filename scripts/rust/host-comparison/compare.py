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
"""Offline production Host measurement. No model credentials or external URLs."""
# Supervision boundaries record every failure and still clean up owned processes.
# Small synchronous telemetry writes are counted in provider/controller CPU; file
# handles for child stderr span start/close instead of a lexical context manager.
# ruff: noqa: BLE001, ASYNC230, SIM115

import argparse
import asyncio
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import time
import uuid
from contextlib import suppress
from pathlib import Path

from telemetry import snapshot

BASE = Path(__file__).resolve().parent
TS = None
RUST = None


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def clean_env():
    # Preserve OS account identity for real Root authority; never copy API/proxy keys.
    return {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "XDG_RUNTIME_DIR",
        )
        if key in os.environ
    } | {"NODE_ENV": "production"}


async def request_body(reader, fields):
    headers = {key.lower(): value.strip() for key, value in fields.items()}
    transfer = headers.get("transfer-encoding")
    if transfer is None:
        return await reader.readexactly(int(headers.get("content-length", "0")))
    if transfer.lower() != "chunked" or "content-length" in headers:
        raise ValueError("unsupported or ambiguous request framing")
    body = bytearray()
    while True:
        line = await reader.readuntil(b"\r\n")
        size = int(line.split(b";", 1)[0].strip(), 16)
        if size == 0:
            while await reader.readuntil(b"\r\n") != b"\r\n":
                pass
            return bytes(body)
        body.extend(await reader.readexactly(size))
        if await reader.readexactly(2) != b"\r\n":
            raise ValueError("invalid request chunk terminator")


class Provider:
    def __init__(self, text, chunks=20, interval=0.05):
        self.text, self.chunks, self.interval = text, chunks, interval
        self.requests, self.errors, self.active, self.peak = [], [], 0, 0
        self.gate = asyncio.Event()
        self.gate.set()
        self.changed = asyncio.Event()
        self.expected_prompts = set()
        self.seen_prompts = set()

    async def start(self):
        self.server = await asyncio.start_server(
            self.handle, "127.0.0.1", 0, backlog=32768, limit=16 * 1024 * 1024
        )
        self.url = f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/v1"

    async def handle(self, reader, writer):
        record = {"arrived": time.monotonic(), "finished": None}
        counted = False
        headers_sent = False
        gate = disconnected = None
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            lines = headers.decode("latin1").split("\r\n")
            verb, path, _ = lines[0].split()
            fields = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
            record["requestTransferEncoding"] = next(
                (
                    v.strip()
                    for k, v in fields.items()
                    if k.lower() == "transfer-encoding"
                ),
                None,
            )
            body = await request_body(reader, fields)
            record.update(method=verb, path=path, requestBytes=len(body))
            if verb == "GET" and path == "/v1/models":
                data = json.dumps(
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": "comparison-model",
                                "object": "model",
                                "owned_by": "offline",
                            }
                        ],
                    }
                ).encode()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + str(len(data)).encode()
                    + b"\r\n\r\n"
                    + data
                )
                await writer.drain()
                return
            if verb != "POST" or path != "/v1/chat/completions":
                raise RuntimeError(f"unexpected provider route {verb} {path}")
            request = json.loads(body)
            users = [m for m in request["messages"] if m["role"] == "user"]
            user_texts = [
                m["content"]
                if isinstance(m["content"], str)
                else "".join(p.get("text", "") for p in m["content"])
                for m in users
            ]
            matching = [text for text in user_texts if text in self.expected_prompts]
            record.update(
                userTexts=user_texts,
                model=request.get("model"),
                stream=request.get("stream"),
            )
            if not matching:
                raise RuntimeError(
                    "unexpected prompt (helper/title call or wrong workload)"
                )
            prompt = matching[-1]
            if prompt in self.seen_prompts:
                raise RuntimeError(
                    "duplicate provider request or latest original prompt missing"
                )
            context_prefix = "Runtime context (runtime.environment; host metadata, not a user request; later updates supersede earlier values):\n"
            if any(
                value not in self.expected_prompts
                and not value.startswith(context_prefix)
                for value in user_texts
            ):
                raise RuntimeError("unrecognized extra user message")
            if (
                request.get("model") != "comparison-model"
                or request.get("stream") is not True
            ):
                raise RuntimeError("unexpected model or non-stream request")
            record.update(
                prompt=prompt,
                requestSha256=hashlib.sha256(body).hexdigest(),
                model=request["model"],
            )
            self.requests.append(record)
            self.seen_prompts.add(prompt)
            self.active += 1
            self.peak = max(self.peak, self.active)
            counted = True
            self.changed.set()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
            )
            headers_sent = True
            prefix_chars = 0
            gate = asyncio.create_task(self.gate.wait())
            disconnected = asyncio.create_task(reader.read(1))
            # Slow real text during ramp keeps production stream watchdogs active.
            # These are a prefix of the SAME fixed response, not extra heartbeat text.
            # The exact prefix/chunk work is recorded because ramp durations differ.
            while not self.gate.is_set():
                if prefix_chars >= len(self.text):
                    raise RuntimeError("fixed response exhausted during admission ramp")
                chunk = {
                    "id": "offline-response",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "comparison-model",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": self.text[prefix_chars : prefix_chars + 1],
                            },
                            "finish_reason": None,
                        }
                    ],
                }
                writer.write(
                    ("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode()
                )
                await writer.drain()
                record.setdefault("firstWritten", time.monotonic())
                prefix_chars += 1
                done, _ = await asyncio.wait(
                    (gate, disconnected), timeout=5, return_when=asyncio.FIRST_COMPLETED
                )
                if disconnected in done:
                    raise RuntimeError(
                        "Host closed the provider connection during admission ramp"
                    )
            for task in (gate, disconnected):
                task.cancel()
            await asyncio.gather(gate, disconnected, return_exceptions=True)
            record["rampPrefixChars"] = prefix_chars
            record["outputChunks"] = prefix_chars + self.chunks
            remaining_text = self.text[prefix_chars:]
            started = time.monotonic()
            record["released"] = started
            record["maxScheduleLatenessMs"] = 0.0
            record["maxWakeLatenessMs"] = 0.0
            for index in range(self.chunks):
                await asyncio.sleep(
                    max(0, started + index * self.interval - time.monotonic())
                )
                record["maxWakeLatenessMs"] = max(
                    record["maxWakeLatenessMs"],
                    1000 * (time.monotonic() - started - index * self.interval),
                )
                piece = remaining_text[
                    len(remaining_text) * index // self.chunks : len(remaining_text)
                    * (index + 1)
                    // self.chunks
                ]
                chunk = {
                    "id": "offline-response",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "comparison-model",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": piece},
                            "finish_reason": None,
                        }
                    ],
                }
                writer.write(
                    ("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode()
                )
                await writer.drain()
                record["maxScheduleLatenessMs"] = max(
                    record["maxScheduleLatenessMs"],
                    1000 * (time.monotonic() - started - index * self.interval),
                )
                if index == 0:
                    record.setdefault("firstWritten", time.monotonic())
            final = {
                "id": "offline-response",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "comparison-model",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": 32,
                    "completion_tokens": 64,
                    "total_tokens": 96,
                },
            }
            writer.write(
                ("data: " + json.dumps(final) + "\n\ndata: [DONE]\n\n").encode()
            )
            await writer.drain()
            record.update(
                finished=time.monotonic(),
                outputBytes=len(self.text.encode()),
                outputSha256=digest(self.text),
            )
        except Exception as error:
            record["error"] = repr(error)
            self.errors.append(record)
            with suppress(ConnectionError, OSError):
                if not headers_sent:
                    writer.write(
                        b"HTTP/1.1 422 Unprocessable Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
        finally:
            for task in (gate, disconnected):
                if task is not None:
                    task.cancel()
            if counted:
                self.active -= 1
                self.changed.set()
            writer.close()
            with suppress(ConnectionError, OSError):
                await writer.wait_closed()

    async def close(self):
        self.gate.set()
        self.server.close()
        await self.server.wait_closed()


class Adapter:
    def __init__(self, kind, output):
        self.kind, self.output, self.pending, self.sequence = kind, output, {}, 0
        self.events = []
        self.workload_tasks = set()

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.workload_tasks.add(task)
        task.add_done_callback(self.workload_tasks.discard)
        return task

    async def start(self, argv, cwd):
        self.err = open(self.output / "adapter.stderr", "wb")
        self.process = await asyncio.create_subprocess_exec(
            *map(str, argv),
            cwd=cwd,
            env=clean_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=self.err,
            limit=32 * 1024 * 1024,
        )
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                obj = json.loads(line)
                if "id" not in obj:
                    # Keep timing and identity; text payload is not copied into event logs.
                    self.events.append(obj)
                    continue
                future = self.pending.pop(str(obj["id"]), None)
                if future and not future.done():
                    if "error" in obj:
                        future.set_exception(RuntimeError(str(obj["error"])))
                    else:
                        future.set_result(obj["result"])
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(
                        RuntimeError("adapter EOF; inspect adapter.stderr")
                    )

    async def call(self, command, timeout=180, **args):
        self.sequence += 1
        ident = str(self.sequence)
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        data = (
            {"id": ident, "command": command, **args}
            if self.kind == "ts"
            else {"id": ident, "op": command, "args": args}
        )
        self.process.stdin.write((json.dumps(data) + "\n").encode())
        await self.process.stdin.drain()
        return await asyncio.wait_for(future, timeout)

    async def close(self):
        if self.process.returncode is None:
            try:
                await self.call("close", timeout=40)
            except Exception as error:
                self.events.append({"cleanupError": repr(error)})
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 10)
            except TimeoutError:
                self.process.terminate()
                await self.process.wait()
        await self.reader
        self.err.close()


def process_sample(pid):
    path = Path("/proc") / str(pid)
    try:
        raw = (path / "stat").read_text().rsplit(")", 1)[1].split()
        status = dict(
            line.split(":", 1)
            for line in (path / "status").read_text().splitlines()
            if ":" in line
        )
        return {
            "pid": pid,
            "startTicks": int(raw[19]),
            "utime": int(raw[11]),
            "stime": int(raw[12]),
            "minorFaults": int(raw[7]),
            "majorFaults": int(raw[9]),
            "rssKiB": int(status.get("VmRSS", "0 kB").split()[0]),
            "swapKiB": int(status.get("VmSwap", "0 kB").split()[0]),
            "threads": int(status["Threads"]),
            "fds": len(list((path / "fd").iterdir())),
        }
    except (OSError, ValueError, KeyError):
        return {"pid": pid, "gone": True}


async def sample_loop(pids, samples, stop, output, result, provider):
    tick = 0
    with open(output / "metrics.jsonl", "x", buffering=1) as stream:
        while not stop.is_set():
            try:
                value = snapshot(pids, tick % 5 == 0)
                info = result.get("scale", result.get("baseline", {}))
                value["progress"] = {
                    key: info.get(key)
                    for key in (
                        "requested",
                        "created",
                        "admitted",
                        "completed",
                        "verified",
                    )
                }
                value["progress"].update(
                    providerActive=provider.active,
                    providerPeak=provider.peak,
                    providerArrived=len(provider.requests),
                    providerFinished=sum(
                        row.get("finished") is not None for row in provider.requests
                    ),
                    providerErrors=len(provider.errors),
                    phase=info.get("phases", [{}])[-1].get("phase")
                    if info.get("phases")
                    else "setup",
                    errors={
                        key: len(rows)
                        for key, rows in info.items()
                        if key.endswith("Errors")
                    },
                )
                samples.append(value)
                stream.write(json.dumps(value, separators=(",", ":")) + "\n")
            except Exception as error:
                result.setdefault("telemetryErrors", []).append(repr(error))
            tick += 1
            try:
                await asyncio.wait_for(stop.wait(), 0.2)
            except TimeoutError:
                pass


def manifest(options):
    def command(*args):
        return subprocess.check_output(
            args, text=True, stderr=subprocess.STDOUT
        ).strip()

    def sha(path):
        h = hashlib.sha256()
        with open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
        return h.hexdigest()

    source = RUST if options.kind == "rust" else TS
    files = [
        Path(__file__),
        BASE / "telemetry.py",
        BASE / "ts-adapter.mjs",
        BASE / "diagnostics.mjs",
    ]
    if options.kind == "ts":
        files += [
            TS / "package-lock.json",
            TS / "packages/runtime-host/dist/execution-candidate-main.js",
        ]
    if options.kind == "rust":
        files += [
            RUST / "target/release/maka",
            RUST / "target/release/examples/host_benchmark_client",
            RUST / "products/maka/cli/examples/host_benchmark_client.rs",
        ]
    return {
        "options": vars(options),
        "argv": sys.argv,
        "python": sys.version,
        "node": command("node", "--version"),
        "platform": platform.platform(),
        "cpuCount": os.cpu_count(),
        "gitCommit": command("git", "-C", str(source), "rev-parse", "HEAD"),
        "gitStatus": command("git", "-C", str(source), "status", "--short"),
        "fileSha256": {str(path): sha(path) for path in files},
        "clockTicksPerSecond": os.sysconf("SC_CLK_TCK"),
        "sampling": {
            "resourceIntervalSeconds": 0.2,
            "heavyEverySamples": 5,
            "cpuMeaning": "raw ticks; deltas / clock ticks / elapsed seconds; 100 percent means one core",
            "coverage": "post setup through workload; cleanup excluded",
            "systemCounters": "whole machine, not exclusive Host attribution",
            "processIo": "rchar/wchar logical bytes; read_bytes/write_bytes storage bytes",
            "memoryUnits": "KiB",
            "clock": "monotonic seconds plus Unix wallTime",
            "networkFields": "Linux /proc/net/dev field order",
            "diskFields": "Linux /proc/diskstats field order",
        },
    }


def memory_available_kib():
    return int(
        next(
            line.split()[1]
            for line in Path("/proc/meminfo").read_text().splitlines()
            if line.startswith("MemAvailable:")
        )
    )


async def create_session(adapter, result, index, client=0):
    if adapter.kind == "ts":
        session = str(uuid.uuid4())
        value = await adapter.call(
            "create",
            timeout=300,
            sessionId=session,
            name=f"offline-comparison-{index:06d}",
            client=client,
        )
        if value["sessionId"] != session:
            raise RuntimeError("TS create returned a different session")
        return session
    value = await adapter.call(
        "create",
        timeout=300,
        name=f"offline-comparison-{index:06d}",
        workspace=result["configuration"]["workspace"],
        client=client,
    )
    if value["kind"] != "created":
        raise RuntimeError(f"Rust create rejected: {value}")
    return value["session"]["id"]


async def send_turn(adapter, result, session, prompt, client=0):
    if adapter.kind == "ts":
        value = await adapter.call(
            "send",
            timeout=310,
            timeoutMs=300000,
            sessionId=session,
            text=prompt,
            client=client,
        )
        if value["terminal"]["status"] != "completed":
            raise RuntimeError(f"TS turn did not complete: {value['terminal']}")
    else:
        value = await adapter.call(
            "send",
            timeout=310,
            timeoutSec=300,
            sessionId=session,
            message=prompt,
            model=result["configuration"]["model"],
            client=client,
        )
        if value["failed"]:
            raise RuntimeError(f"Rust invocation failed: {value}")
    return value


async def read_session(adapter, session, client=0, observer=False):
    started = time.monotonic()
    value = await adapter.call(
        "read" if adapter.kind == "ts" else "history",
        timeout=300,
        sessionId=session,
        client=client,
        observer=observer,
    )
    value["controllerReadMs"] = (time.monotonic() - started) * 1000
    return value


async def scale(adapter, provider, result, options):
    result["scale"] = info = {
        "requested": options.agents,
        "scopes": options.scopes,
        "phases": [],
        "createErrors": [],
        "turnErrors": [],
        "integrityErrors": [],
        "readErrors": [],
    }

    def phase(name):
        info["phases"].append({"phase": name, "time": time.monotonic()})
        print(
            json.dumps({"phase": name, "kind": options.kind, "agents": options.agents}),
            flush=True,
        )

    async def guarded(tasks, timeout):
        pending = set(tasks)
        deadline = time.monotonic() + timeout
        while pending:
            if memory_available_kib() < options.reserve_mib * 1024:
                info["resourceStop"] = {
                    "reason": "available_memory_reserve",
                    "reserveMiB": options.reserve_mib,
                    "time": time.monotonic(),
                }
                raise RuntimeError("lab available-memory reserve reached")
            if time.monotonic() > deadline:
                raise TimeoutError("measurement observation deadline")
            _, pending = await asyncio.wait(
                pending, timeout=0.2, return_when=asyncio.FIRST_COMPLETED
            )
        return [task.result() for task in tasks]

    async def create_one(index):
        try:
            return await create_session(adapter, result, index, index % options.scopes)
        except Exception as error:
            info["createErrors"].append({"index": index, "error": repr(error)})
            return None

    phase("create_start")
    tasks = [adapter.task(create_one(index)) for index in range(options.agents)]
    sessions = await guarded(tasks, 330)
    info["created"] = sum(session is not None for session in sessions)
    phase("resident_idle_start")
    await asyncio.sleep(options.idle)
    phase("active_ramp_start")
    provider.gate.clear()

    async def send_one(index, session):
        if session is None:
            return None
        prompt = f"offline benchmark agent {index:06d}"
        provider.expected_prompts.add(prompt)
        begin = time.monotonic()
        try:
            value = await send_turn(
                adapter, result, session, prompt, index % options.scopes
            )
            if value["text"] != provider.text:
                info["integrityErrors"].append(
                    {
                        "index": index,
                        "phase": "live",
                        "bytes": len(value["text"].encode()),
                        "sha256": digest(value["text"]),
                    }
                )
            return {
                "index": index,
                "sessionId": session,
                "begin": begin,
                "finished": time.monotonic(),
                "textSha256": digest(value["text"]),
                "textBytes": len(value["text"].encode()),
                **{
                    key: value[key]
                    for key in (
                        "acceptedMs",
                        "firstVisibleMs",
                        "completedMs",
                        "startedMs",
                        "admittedMs",
                        "firstTextMs",
                        "terminalMs",
                        "eventCount",
                    )
                    if key in value
                },
            }
        except Exception as error:
            info["turnErrors"].append(
                {
                    "index": index,
                    "error": repr(error),
                    "begin": begin,
                    "finished": time.monotonic(),
                }
            )
            return None

    tasks = [
        adapter.task(send_one(index, session)) for index, session in enumerate(sessions)
    ]
    ramp_start = time.monotonic()
    while (
        provider.active < info["created"]
        and time.monotonic() - ramp_start < options.ramp_seconds
        and not all(task.done() for task in tasks)
    ):
        if memory_available_kib() < options.reserve_mib * 1024:
            info["resourceStop"] = {
                "reason": "available_memory_reserve",
                "reserveMiB": options.reserve_mib,
                "time": time.monotonic(),
            }
            raise RuntimeError("lab available-memory reserve reached")
        provider.changed.clear()
        try:
            await asyncio.wait_for(provider.changed.wait(), 0.2)
        except TimeoutError:
            pass
    info["activeAtBarrier"] = provider.active
    info["barrierReachedAll"] = provider.active == options.agents
    phase("active_hold_start")
    await asyncio.sleep(options.hold_seconds)
    phase("stream_release")
    provider.gate.set()
    info["turns"] = await guarded(tasks, 330)
    info["completed"] = sum(turn is not None for turn in info["turns"])
    info["providerPeak"] = provider.peak
    phase("stream_drained")

    async def verify(index, session):
        if session is None or info["turns"][index] is None:
            return
        expected = [
            {"role": "user", "text": f"offline benchmark agent {index:06d}"},
            {"role": "assistant", "text": provider.text},
        ]
        try:
            value = await read_session(adapter, session, index % options.scopes)
            if value["messages"] != expected:
                info["integrityErrors"].append(
                    {
                        "index": index,
                        "phase": "canonical",
                        "messages": value["messages"],
                    }
                )
        except Exception as error:
            info["readErrors"].append({"index": index, "error": repr(error)})

    # Verify every completed session in groups, outside active-throughput timing.
    for base in range(0, len(sessions), options.scopes * 16):
        await guarded(
            [
                adapter.task(verify(index, sessions[index]))
                for index in range(base, min(base + options.scopes * 16, len(sessions)))
            ],
            330,
        )
    phase("canonical_verified")
    result["passed"] = (
        info["created"] == options.agents
        and info["completed"] == options.agents
        and info["barrierReachedAll"]
        and not any(
            info[key]
            for key in ("createErrors", "turnErrors", "integrityErrors", "readErrors")
        )
        and not provider.errors
        and len(provider.requests) == options.agents
    )


async def background_scale(adapter, provider, result, options):
    """Bounded admission pipeline; actual active executions accumulate at the provider.

    Controller-queued jobs never count as active. There is no session subscription
    during execution. Terminal states and every canonical result are read afterwards.
    """
    info = result["scale"] = {
        "requested": options.agents,
        "created": 0,
        "admitted": 0,
        "completed": 0,
        "verified": 0,
        "unknownAdmissionCanonicalVerified": 0,
        "unconfirmedTerminalCanonicalVerified": 0,
        "scopes": options.scopes,
        "admissionConcurrency": options.admission_concurrency,
        "observation": "background_public_turn_queries",
        "phases": [],
        "createErrors": [],
        "admissionErrors": [],
        "terminalErrors": [],
        "integrityErrors": [],
        "readErrors": [],
    }
    sessions, admissions = [None] * options.agents, [None] * options.agents
    info["sessions"] = sessions

    def phase(name):
        info["phases"].append({"phase": name, "time": time.monotonic()})
        print(
            json.dumps({"phase": name, "kind": options.kind, "agents": options.agents}),
            flush=True,
        )

    def check_reserve():
        available = memory_available_kib()
        if available < options.reserve_mib * 1024:
            info["resourceStop"] = {
                "reason": "available_memory_reserve",
                "reserveMiB": options.reserve_mib,
                "availableKiB": available,
                "time": time.monotonic(),
            }
            raise RuntimeError("lab available-memory reserve reached")

    def workers(operation):
        next_index = 0

        async def work():
            nonlocal next_index
            while next_index < options.agents:
                index = next_index
                next_index += 1
                await operation(index)

        return [adapter.task(work()) for _ in range(options.admission_concurrency)]

    async def guarded(tasks, seconds):
        deadline = time.monotonic() + seconds
        pending = set(tasks)
        while pending:
            check_reserve()
            if time.monotonic() >= deadline:
                raise TimeoutError("measurement observation deadline")
            done, pending = await asyncio.wait(
                pending, timeout=0.2, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                task.result()

    async def create(index):
        try:
            sessions[index] = await create_session(
                adapter, result, index, index % options.scopes
            )
            info["created"] += 1
        except Exception as error:
            info["createErrors"].append({"index": index, "error": repr(error)})

    phase("create_start")
    await guarded(workers(create), options.setup_seconds)
    info["created"] = sum(session is not None for session in sessions)
    phase("resident_idle_start")
    await asyncio.sleep(options.idle)
    phase("active_ramp_start")
    provider.gate.clear()
    stop_admitting = False

    async def admit(index):
        if stop_admitting or sessions[index] is None:
            return
        prompt = f"offline benchmark agent {index:06d}"
        provider.expected_prompts.add(prompt)
        started = time.monotonic()
        try:
            common = {"sessionId": sessions[index], "client": index % options.scopes}
            if adapter.kind == "ts":
                value = await adapter.call(
                    "admit", timeout=130, timeoutMs=120000, text=prompt, **common
                )
                if value["admission"]["kind"] != "started":
                    raise RuntimeError(
                        f"TS distinct-session admission rejected/queued: {value['admission']}"
                    )
            else:
                value = await adapter.call(
                    "admit",
                    timeout=130,
                    timeoutSec=120,
                    message=prompt,
                    model=result["configuration"]["model"],
                    **common,
                )
            admissions[index] = {
                "index": index,
                "sessionId": sessions[index],
                "started": started,
                "admitted": time.monotonic(),
                "result": value,
            }
            info["admitted"] += 1
        except Exception as error:
            info["admissionErrors"].append(
                {
                    "index": index,
                    "sessionId": sessions[index],
                    "error": repr(error),
                    "started": started,
                    "finished": time.monotonic(),
                }
            )

    tasks = workers(admit)
    ramp_start = time.monotonic()
    while (
        provider.active < info["created"]
        and time.monotonic() - ramp_start < options.ramp_seconds
    ):
        check_reserve()
        if all(task.done() for task in tasks):
            for task in tasks:
                task.result()
            if provider.active == sum(value is not None for value in admissions):
                break
        provider.changed.clear()
        try:
            await asyncio.wait_for(provider.changed.wait(), 0.2)
        except TimeoutError:
            pass
    stop_admitting = True
    info["admittedAtBarrier"] = sum(value is not None for value in admissions)
    info["activeAtBarrier"] = provider.active
    info["barrierReachedAll"] = provider.active == options.agents
    info["rampLimitSeconds"] = options.ramp_seconds
    phase("active_hold_start")
    for _ in range(max(1, int(options.hold_seconds * 5))):
        check_reserve()
        await asyncio.sleep(0.2)
    phase("stream_release")
    provider.gate.set()
    await guarded(tasks, 330)
    info["admissions"] = admissions
    info["admitted"] = sum(value is not None for value in admissions)
    info["notSubmittedOrAdmitted"] = options.agents - info["admitted"]
    deadline = time.monotonic() + 330
    while provider.active:
        check_reserve()
        if time.monotonic() >= deadline:
            raise TimeoutError("provider stream drain deadline")
        provider.changed.clear()
        try:
            await asyncio.wait_for(provider.changed.wait(), 0.2)
        except TimeoutError:
            pass
    phase("provider_drained")
    # Preserve sender custody after ambiguous admission errors. Both implementations
    # attach new read-only scopes to the original Host, without retrying mutations.
    if adapter.kind == "ts":
        info["observer"] = await adapter.call("observe", timeout=130 * options.scopes)
    else:
        info["observer"] = await adapter.call(
            "observe",
            timeout=130 * options.scopes,
            timeoutSec=120 * options.scopes,
            root=str(result["outputPath"] / "root"),
            hostEpoch=result["setup"]["hostEpoch"],
            scopes=options.scopes,
        )
    info["observer"]["controllerDeadlineSeconds"] = 130 * options.scopes
    info["observer"]["rustCommandDeadlineSeconds"] = (
        120 * options.scopes if adapter.kind == "rust" else None
    )
    phase("observer_ready")
    completions = [None] * options.agents

    async def completion(index):
        admission = admissions[index]
        if admission is None:
            return
        deadline = time.monotonic() + 300
        polls = 0
        try:
            while True:
                polls += 1
                if adapter.kind == "ts":
                    value = await adapter.call(
                        "completion",
                        observer=True,
                        sessionId=sessions[index],
                        turnId=admission["result"]["turnId"],
                        client=index % options.scopes,
                    )
                    terminal, status = value["terminal"], value["status"]
                else:
                    value = await adapter.call(
                        "query",
                        endpoint="agent",
                        method="execution",
                        observer=True,
                        input={
                            "sessionId": sessions[index],
                            "invocationId": admission["result"]["invocationId"],
                        },
                        client=index % options.scopes,
                    )
                    if value["kind"] != "found":
                        raise RuntimeError(f"Original execution missing: {value}")
                    status = value["execution"]["state"]
                    terminal = status in ("completed", "failed", "cancelled")
                if terminal:
                    if status != "completed":
                        raise RuntimeError(f"Execution failed: {value}")
                    completions[index] = {
                        "index": index,
                        "observed": time.monotonic(),
                        "polls": polls,
                        "status": status,
                    }
                    info["completed"] += 1
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("terminal observation deadline")
                await asyncio.sleep(0.1)
        except Exception as error:
            info["terminalErrors"].append({"index": index, "error": repr(error)})

    await guarded(workers(completion), options.setup_seconds)
    info["completions"] = completions
    info["completed"] = sum(value is not None for value in completions)
    info["providerPeak"] = provider.peak
    info["providerRequestsWithoutAdmissionReply"] = [
        row["prompt"]
        for row in provider.requests
        if admissions[int(row["prompt"].rsplit(" ", 1)[1])] is None
    ]
    phase("terminal_observed")
    verified = 0

    async def verify(index):
        nonlocal verified
        unknown_admission = admissions[index] is None
        unconfirmed_terminal = completions[index] is None
        if (
            unconfirmed_terminal
            and f"offline benchmark agent {index:06d}" not in provider.seen_prompts
        ):
            return
        expected = [
            {"role": "user", "text": f"offline benchmark agent {index:06d}"},
            {"role": "assistant", "text": provider.text},
        ]
        try:
            value = await read_session(
                adapter, sessions[index], index % options.scopes, observer=True
            )
            if value["messages"] != expected:
                info["integrityErrors"].append(
                    {"index": index, "messages": value["messages"]}
                )
            elif unknown_admission:
                info["unknownAdmissionCanonicalVerified"] += 1
            elif unconfirmed_terminal:
                info["unconfirmedTerminalCanonicalVerified"] += 1
            else:
                verified += 1
                info["verified"] = verified
        except Exception as error:
            info["readErrors"].append({"index": index, "error": repr(error)})

    await guarded(workers(verify), options.setup_seconds)
    info["verified"] = verified
    phase("canonical_verified")
    result["passed"] = (
        info["created"] == options.agents
        and info["completed"] == options.agents
        and info["verified"] == options.agents
        and info["barrierReachedAll"]
        and not any(
            info[key]
            for key in (
                "createErrors",
                "admissionErrors",
                "terminalErrors",
                "integrityErrors",
                "readErrors",
            )
        )
        and not provider.errors
        and len(provider.requests) == options.agents
    )


async def baseline(adapter, provider, result, options, rust_host, pids, own_host):
    info = result["baseline"] = {"phases": [], "historyTurns": options.history_turns}

    def phase(name):
        info["phases"].append({"phase": name, "time": time.monotonic()})
        print(json.dumps({"phase": name, "kind": options.kind}), flush=True)

    async def checked_read(session, expected):
        value = await read_session(adapter, session)
        if value["messages"] != expected:
            raise AssertionError(
                "canonical history does not match exact original prompts and responses"
            )
        return {
            key: value[key]
            for key in (
                "controllerReadMs",
                "pages",
                "startedMs",
                "openedMs",
                "tailDecodedMs",
                "finishedMs",
                "tailRawBytes",
                "tailMessages",
                "canonicalRows",
            )
            if key in value
        } | {
            "messages": len(value["messages"]),
            "textUtf8Bytes": sum(len(message["text"].encode()) for message in expected),
            "canonicalSha256": digest(
                json.dumps(expected, ensure_ascii=False, separators=(",", ":"))
            ),
        }

    phase("warmup")
    await asyncio.sleep(2)
    phase("idle_start")
    await asyncio.sleep(options.idle)
    phase("idle_end")
    stream_session = await create_session(adapter, result, 0)
    unit = "Offline comparison 中文🙂 — exact UTF-8.\n"
    provider.text, provider.chunks, provider.interval = unit * 22310, 128, 0.01
    prompt = "offline benchmark single large response"
    provider.expected_prompts.add(prompt)
    phase("large_stream_start")
    value = await send_turn(adapter, result, stream_session, prompt)
    phase("large_stream_end")
    if value["text"] != provider.text:
        raise AssertionError("large live stream differs from exact expected response")
    info["largeStream"] = {
        key: value[key]
        for key in (
            "acceptedMs",
            "firstVisibleMs",
            "completedMs",
            "startedMs",
            "admittedMs",
            "firstTextMs",
            "terminalMs",
            "eventCount",
        )
        if key in value
    }
    info["largeStream"].update(
        utf8Bytes=len(provider.text.encode()),
        sha256=digest(provider.text),
        chunks=provider.chunks,
        chunkIntervalSeconds=provider.interval,
    )
    info["largeStream"]["canonical"] = await checked_read(
        stream_session,
        [
            {"role": "user", "text": prompt},
            {"role": "assistant", "text": provider.text},
        ],
    )
    history_session = await create_session(adapter, result, 1)
    provider.text, provider.chunks, provider.interval = unit * 350, 4, 0
    info["historyAssistantBytesPerTurn"] = len(provider.text.encode())
    expected = []
    phase("history_seed_start")
    for index in range(options.history_turns):
        prompt = f"offline benchmark history turn {index:06d}"
        provider.expected_prompts.add(prompt)
        value = await send_turn(adapter, result, history_session, prompt)
        if value["text"] != provider.text:
            raise AssertionError(f"history seed live response {index} differs")
        expected.extend(
            [
                {"role": "user", "text": prompt},
                {"role": "assistant", "text": provider.text},
            ]
        )
    phase("history_seed_end")
    phase("history_read_start")
    info["historyRead"] = await checked_read(history_session, expected)
    phase("history_read_end")
    # Warm OS page cache, new Host process: this is process reopen, not cold disk.
    phase("shutdown_start")
    await adapter.call("close")
    if rust_host:
        await rust_host.close()
    phase("reopen_start")
    started = time.monotonic()
    if adapter.kind == "ts":
        ready = await adapter.call("restart")
        own_host(ready["pid"])
    else:
        ready = await rust_host.start()
        own_host(rust_host.process.pid)
        await adapter.call(
            "connect",
            root=str(rust_host.root),
            journal=str(result["outputPath"] / "client.sqlite"),
            scopes=options.scopes,
        )
    info["reopenHostReadyMs"] = (time.monotonic() - started) * 1000
    info["reopenRead"] = await checked_read(history_session, expected)
    info["reopenAndReadMs"] = (time.monotonic() - started) * 1000
    phase("reopen_end")
    if len(provider.requests) != options.history_turns + 1 or provider.errors:
        raise AssertionError("unexpected provider work during baseline/reopen")
    result["passed"] = True


class RustHost:
    def __init__(self, output, workspace):
        self.output, self.workspace, self.root = output, workspace, output / "root"
        self.process = None

    async def initialize(self):
        # Exercise the public initializer, including its input and observation boundary.
        proc = await asyncio.create_subprocess_exec(
            str(RUST / "target/release/maka"),
            "host",
            "init",
            "--root",
            str(self.root),
            "--settings-stdin",
            cwd=self.workspace,
            env=clean_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(b'{"privacy":{"incognitoActive":true}}')
        (self.output / "init.stdout").write_bytes(out)
        (self.output / "init.stderr").write_bytes(err)
        if proc.returncode:
            raise RuntimeError(f"Rust root init failed: {err.decode()}")

    async def start(self):
        self.err = open(self.output / "host.stderr", "ab")
        self.process = await asyncio.create_subprocess_exec(
            str(RUST / "target/release/maka"),
            "host",
            "serve",
            "--root",
            str(self.root),
            cwd=self.workspace,
            env=clean_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=self.err,
        )
        line = await asyncio.wait_for(self.process.stdout.readline(), 120)
        (self.output / "host.ready").write_bytes(line)
        if not line:
            raise RuntimeError(
                "Rust Host exited before ready; inspect host.stderr and root logs"
            )
        ready = json.loads(line)
        if ready.get("kind") != "ready":
            raise RuntimeError(f"Unexpected Host readiness: {ready}")
        return ready

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(self.process.wait(), 30)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
                raise RuntimeError("Rust Host required SIGKILL after shutdown timeout")
        if hasattr(self, "err"):
            self.err.close()


async def rust_setup(adapter, provider_url, workspace):
    catalog = await adapter.call(
        "query", endpoint="settings", method="connections", input={"kind": "start"}
    )
    identity = {
        "packageId": "maka.providers",
        "entryId": "maka.providers",
        "scope": "profile",
        "name": "openai-compatible",
    }
    created = await adapter.call(
        "settings_mutation",
        endpoint="settings",
        method="create",
        input={
            "expectedCatalogRevision": catalog["revision"],
            "connection": {
                "slug": "offline-comparison",
                "name": "Offline comparison",
                "provider": identity,
                "configuration": {"baseUrl": provider_url},
                "enabled": True,
                "enabledModelIds": ["comparison-model"],
                "modelOverrides": {"comparison-model": {"contextWindow": 2000000}},
            },
        },
    )
    if created["kind"] != "committed":
        raise RuntimeError(f"Rust provider create rejected: {created}")
    basis = created["connection"]
    detail = await adapter.call(
        "query", endpoint="settings", method="connection", input=basis
    )
    saved = await adapter.call(
        "settings_mutation",
        endpoint="settings",
        method="saveCredential",
        input={"expected": detail["target"], "expectedCredential": None},
        secret="offline-comparison-dummy",
    )
    if saved["kind"] != "saved":
        raise RuntimeError(f"Rust dummy credential rejected: {saved}")
    refreshed = await adapter.call(
        "query", endpoint="settings", method="connections", input={"kind": "start"}
    )
    basis = next(
        item["basis"]
        for item in refreshed["connections"]
        if item["slug"] == "offline-comparison"
    )
    # Traverse only public directory grants to obtain the exact scratch-workspace selection.
    roots = await adapter.call(
        "query", endpoint="agent", method="directories", input={"kind": "roots"}
    )
    root = next(
        root for root in roots["roots"] if workspace.is_relative_to(Path(root["path"]))
    )
    directory = root
    for segment in workspace.relative_to(Path(root["path"])).parts:
        after = None
        while True:
            children = await adapter.call(
                "query",
                endpoint="agent",
                method="directories",
                input={
                    "kind": "children",
                    "selection": directory["selection"],
                    "after": after,
                },
            )
            selected = next(
                (child for child in children["children"] if child["name"] == segment),
                None,
            )
            if selected:
                directory = selected
                break
            after = children["after"]
            if after is None:
                raise RuntimeError(
                    f"Public directory grant lacks workspace segment {segment}"
                )
    return {
        "model": {**basis, "modelId": "comparison-model"},
        "workspace": {"kind": "directory", "selection": directory["selection"]},
    }


async def run(options):
    output = Path(options.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    workspace = output / "workspace"
    workspace.mkdir()
    text = "Offline comparison 中文🙂 — exact UTF-8.\n" * options.lines
    metadata = manifest(options)
    (output / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    provider = Provider(text, options.chunks, options.interval)
    await provider.start()
    adapter = Adapter(options.kind, output)
    result = {
        "kind": options.kind,
        "outputPath": output,
        "providerUrl": provider.url,
        "expectedTextBytes": len(text.encode()),
        "expectedSha256": digest(text),
        "started": time.time(),
        "samples": [],
    }
    stop = asyncio.Event()
    sampler = None
    rust_host = None
    owned_host = None
    host_pidfd = None
    pids = {"providerController": os.getpid()}

    def own_host(pid):
        nonlocal owned_host, host_pidfd
        identity = process_sample(pid)
        descriptor = os.pidfd_open(pid)
        if process_sample(pid).get("startTicks") != identity.get("startTicks"):
            os.close(descriptor)
            raise RuntimeError("Host identity changed while acquiring pidfd")
        if host_pidfd is not None:
            os.close(host_pidfd)
        owned_host, host_pidfd = identity, descriptor
        pids["host"] = pid
        result.setdefault("hostIdentities", []).append(
            {"time": time.monotonic(), "pid": pid, "startTicks": identity["startTicks"]}
        )

    try:
        if options.kind == "ts":
            await adapter.start(
                [
                    "node",
                    BASE / "ts-adapter.mjs",
                    "--checkout",
                    TS,
                    "--root",
                    output / "root",
                    "--workspace",
                    workspace,
                    "--provider-url",
                    provider.url,
                ],
                TS,
            )
            result["setup"] = await adapter.call("setup", scopes=options.scopes)
            own_host(result["setup"]["pid"])
            pids["adapter"] = adapter.process.pid
        else:
            rust_host = RustHost(output, workspace)
            await rust_host.initialize()
            result["hostReady"] = await rust_host.start()
            own_host(rust_host.process.pid)
            await adapter.start(
                [RUST / "target/release/examples/host_benchmark_client"], workspace
            )
            result["setup"] = await adapter.call(
                "connect",
                root=str(rust_host.root),
                journal=str(output / "client.sqlite"),
                scopes=options.scopes,
            )
            result["configuration"] = await rust_setup(adapter, provider.url, workspace)
            pids["adapter"] = adapter.process.pid
        result["clockTicksPerSecond"] = os.sysconf("SC_CLK_TCK")
        result["processIds"] = dict(pids)
        sampler = asyncio.create_task(
            sample_loop(pids, result["samples"], stop, output, result, provider)
        )
        if options.mode == "scale":
            await scale(adapter, provider, result, options)
            return
        if options.mode == "background":
            await background_scale(adapter, provider, result, options)
            return
        if options.mode == "baseline":
            await baseline(
                adapter, provider, result, options, rust_host, pids, own_host
            )
            return
        await asyncio.sleep(options.idle)
        session = str(uuid.uuid4())
        if options.kind == "ts":
            result["create"] = await adapter.call(
                "create", sessionId=session, name="offline-comparison"
            )
        else:
            result["create"] = await adapter.call(
                "create",
                name="offline-comparison",
                workspace=result["configuration"]["workspace"],
            )
            if result["create"]["kind"] != "created":
                raise RuntimeError(f"Rust session create rejected: {result['create']}")
            session = result["create"]["session"]["id"]
        prompt = "offline benchmark " + str(uuid.uuid4())
        provider.expected_prompts.add(prompt)
        if options.kind == "ts":
            result["send"] = await adapter.call("send", sessionId=session, text=prompt)
            result["read"] = await adapter.call(
                "read", sessionId=session, includeRaw=True
            )
        else:
            result["send"] = await adapter.call(
                "send",
                sessionId=session,
                message=prompt,
                model=result["configuration"]["model"],
                includeEvents=True,
            )
            result["read"] = await adapter.call("history", sessionId=session)
        if result["send"]["text"] != text:
            raise AssertionError("live output differs from exact expected UTF-8")
        expected = [
            {"role": "user", "text": prompt},
            {"role": "assistant", "text": text},
        ]
        if result["read"]["messages"] != expected:
            raise AssertionError(
                "persisted messages differ from exact expected original text"
            )
        if options.kind == "ts":
            result["restart"] = await adapter.call("restart")
            own_host(result["restart"]["pid"])
            result["reopened"] = await adapter.call("read", sessionId=session)
        else:
            await adapter.call("close")
            await rust_host.close()
            result["restart"] = await rust_host.start()
            own_host(rust_host.process.pid)
            await adapter.call(
                "connect",
                root=str(rust_host.root),
                journal=str(output / "client.sqlite"),
                scopes=options.scopes,
            )
            result["reopened"] = await adapter.call("history", sessionId=session)
        if result["reopened"]["messages"] != expected:
            raise AssertionError("reopened messages differ")
        if len(provider.requests) != 1 or provider.errors:
            raise AssertionError("unexpected provider requests/errors")
        result["passed"] = True
    except Exception as error:
        result["error"] = repr(error)
        raise
    finally:
        stop.set()
        if sampler:
            try:
                await sampler
            except Exception as error:
                result.setdefault("telemetryErrors", []).append(repr(error))
        result["cleanupErrors"] = []
        if result.get("error") and host_pidfd is not None:
            # Stop admission/execution BEFORE releasing a barrier or draining load.
            # pidfd refers to the original process even after its PID is reused.
            try:
                signal.pidfd_send_signal(host_pidfd, signal.SIGTERM)
            except ProcessLookupError:
                pass
        outstanding = list(adapter.workload_tasks)
        for task in outstanding:
            task.cancel()
        await asyncio.gather(*outstanding, return_exceptions=True)
        if result.get("error"):
            for _ in range(150):
                if not provider.active:
                    break
                await asyncio.sleep(0.1)
            else:
                if host_pidfd is not None:
                    try:
                        signal.pidfd_send_signal(host_pidfd, signal.SIGKILL)
                        result["cleanupErrors"].append(
                            "Owned Host required SIGKILL during failed workload drain"
                        )
                    except ProcessLookupError:
                        pass
        provider.gate.set()
        if hasattr(adapter, "process"):
            try:
                await adapter.close()
            except Exception as error:
                result["cleanupErrors"].append(repr(error))
        if rust_host:
            try:
                await rust_host.close()
            except Exception as error:
                result["cleanupErrors"].append(repr(error))
        if owned_host and not process_sample(owned_host["pid"]).get("gone"):
            current = process_sample(owned_host["pid"])
            if current.get("startTicks") == owned_host["startTicks"]:
                result["cleanupErrors"].append(
                    "Owned Host remained after adapter cleanup; sent SIGTERM"
                )
                os.kill(owned_host["pid"], signal.SIGTERM)
                for _ in range(150):
                    if process_sample(owned_host["pid"]).get("gone"):
                        break
                    await asyncio.sleep(0.1)
                else:
                    if (
                        process_sample(owned_host["pid"]).get("startTicks")
                        == owned_host["startTicks"]
                    ):
                        result["cleanupErrors"].append(
                            "Owned Host did not exit within cleanup grace; sent SIGKILL"
                        )
                        os.kill(owned_host["pid"], signal.SIGKILL)
        await provider.close()
        if host_pidfd is not None:
            os.close(host_pidfd)
        if result["cleanupErrors"] or result.get("telemetryErrors"):
            result["passed"] = False
        result.update(
            providerRequests=provider.requests,
            providerErrors=provider.errors,
            providerPeak=provider.peak,
            events=adapter.events,
            finished=time.time(),
        )
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n"
        )
        print(
            json.dumps(
                {
                    "output": str(output),
                    "passed": result.get("passed", False),
                    "error": result.get("error"),
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["ts", "rust"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--ts-checkout",
        help="Built production TypeScript checkout; required for --kind ts",
    )
    parser.add_argument(
        "--rust-checkout", help="Built release Rust checkout; required for --kind rust"
    )
    parser.add_argument("--lines", type=int, default=20)
    parser.add_argument("--chunks", type=int, default=20)
    parser.add_argument("--interval", type=float, default=0.05)
    parser.add_argument("--idle", type=float, default=2)
    parser.add_argument("--scopes", type=int, default=1)
    parser.add_argument(
        "--mode", choices=["smoke", "scale", "background", "baseline"], default="smoke"
    )
    parser.add_argument("--agents", type=int, default=100)
    parser.add_argument("--ramp-seconds", type=float, default=90)
    parser.add_argument("--hold-seconds", type=float, default=3)
    parser.add_argument("--reserve-mib", type=int, default=4096)
    parser.add_argument("--admission-concurrency", type=int, default=16)
    parser.add_argument("--setup-seconds", type=float, default=1800)
    parser.add_argument("--history-turns", type=int, default=100)
    options = parser.parse_args()
    if options.kind == "ts" and not options.ts_checkout:
        parser.error("--kind ts requires --ts-checkout")
    if options.kind == "rust" and not options.rust_checkout:
        parser.error("--kind rust requires --rust-checkout")
    TS = Path(options.ts_checkout).resolve() if options.ts_checkout else None
    RUST = Path(options.rust_checkout).resolve() if options.rust_checkout else None
    asyncio.run(run(options))
