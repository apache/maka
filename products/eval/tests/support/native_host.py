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

import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({
            "object": "list",
            "data": [{"id": "deepseek-v4-flash", "object": "model"}],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    captured_requests = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        Provider.captured_requests.append(json.loads(raw_body.decode()))
        event = {
            "id": "eval-test", "object": "chat.completion.chunk",
            "created": 1, "model": "deepseek-v4-flash",
        }
        events = [
            {**event, "choices": [{"index": 0, "delta": {
                "role": "assistant", "content": "Done.",
            }, "finish_reason": None}]},
            {**event, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {
                 "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12,
                 "prompt_tokens_details": {"cached_tokens": 0},
                 "completion_tokens_details": {"reasoning_tokens": 0},
             }},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for item in events:
            self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix="maka-native-eval-") as raw:
    root = Path(raw)
    workspace = root / "workspace"
    workspace.mkdir()
    request = {
        "makaExecutable": os.environ["MAKA_TEST_MAKA"],
        "rootPath": str(root / "host"),
        "artifactRoot": str(root / "artifacts"),
        "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
        "hostSettlementTimeoutMs": 15000,
        "hostInitSettings": {
            "connections": [{
                "slug": "eval-gateway", "name": "Eval Gateway",
                "provider": "openai-compatible",
                "configuration": {"baseUrl": "http://placeholder/v1"},
                "apiKey": "EVAL_SMOKE_KEY", "enabled": True,
                "enabledModelIds": ["deepseek-v4-flash"],
            }],
            "defaultTarget": {"slug": "eval-gateway", "modelId": "deepseek-v4-flash"},
        },
        "execution": {
            "executionId": "native-smoke",
            "workspacePath": str(workspace),
            "sessionSettings": {},
            "content": {"text": "Reply Done."}, "maxSteps": 10,
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(request).encode()).decode().rstrip("=")
    token = "a" * 32
    child = subprocess.Popen(
        [os.environ["MAKA_TEST_EVAL"], "host-subject", payload],
        env={**os.environ, "EVAL_SMOKE_KEY": "dummy-test-key", "MAKA_EVAL_RESULT_TOKEN": token},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        stdout, stderr = child.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        raise AssertionError("native Eval Host did not settle") from None
    assert child.returncode == 0, stderr
    prefix, framed_token, length, digest, encoded = stdout.strip().split(" ")
    assert prefix == "MAKA-EVAL-RESULT-V1" and framed_token == token
    body = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    assert len(body) == int(length) and hashlib.sha256(body).hexdigest() == digest
    data = json.loads(body)
    assert data["status"] == "completed", data
    assert data["usage"] == dict(
        inputTokens=10, outputTokens=2, cacheReadTokens=0,
        cacheWriteTokens=0, reasoningTokens=0, totalTokens=12,
    ), data
    assert Provider.captured_requests, "provider should observe outbound request"
    assert len(Provider.captured_requests[0].get("tools", [])) > 0, (
        f"default product tools must not be pruned: {list(Provider.captured_requests[0].keys())}"
    )
    expected_maka_sha = hashlib.sha256(Path(os.environ["MAKA_TEST_MAKA"]).read_bytes()).hexdigest()
    assert data["makaExecutableSha256"] == expected_maka_sha, data
    receipt = json.loads((root / "artifacts" / "execution-receipt.json").read_text())
    assert receipt["operationId"] == data["operationId"]
    assert receipt["runId"] == data["invocationId"]
    assert receipt["rootPath"] == str(root / "host")
    assert receipt["makaExecutable"] == os.environ["MAKA_TEST_MAKA"]
    assert receipt["makaExecutableSha256"] == expected_maka_sha
    assert receipt["sessionId"]
    transcript = json.loads((root / "artifacts" / "transcript.json").read_text())
    assert any("Done." in chunk.get("text", "") for page in transcript for chunk in page["chunks"])

server.shutdown()
