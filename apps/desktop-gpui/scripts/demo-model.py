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

"""A scripted, OpenAI-compatible chat model for demo screenshots.

It answers /v1/models and streaming /v1/chat/completions. For each prompt it
picks a scenario by keyword, first asks the Runtime Host to run one real tool,
then answers with prepared Markdown once the tool result comes back. The Host,
the tools and the transcript are real; only the model is a script, and it says
so: its model id is `scripted-demo`.

  python3 scripts/demo-model.py            # listens on 127.0.0.1:11500
"""
import json, os, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "scripted-demo"

ANSWER_BACKOFF = """The client reconnects with **exponential backoff and ±20% jitter**, starting at 100 ms and capped at 5 s. A connection that stayed up for 10 s resets the count, and a Host that keeps dying pushes the ceiling to 60 s so it is not hammered.

| Attempt | Delay | Why |
|---|---|---|
| 1 | ~100 ms | A restart or handoff usually finishes this fast |
| 2 | ~200 ms | Still cheap; the socket path is re-read each time |
| 3 | ~400 ms | Gives a slow Host time to publish its registration |
| 4 | ~800 ms | Keeps doubling until the 5 s cap |

The policy lives in one place, so the TypeScript client and this one stay in step:

```rust
let base = self.min.saturating_mul(1 << attempt.min(16));
let capped = base.min(self.ceiling(attempt));
jitter(capped, 0.2)
```

Liveness is separate: a `host.status` probe every 2 s, and the connection counts as lost after 8 s without an answer."""

ANSWER_CRATES = """Nine crates, split by capability rather than by layer:

- **host-protocol** · wire types and the frame codec, traced to the TypeScript decoders
- **host-client** · local socket and pipe transport, liveness, reconnect, Host spawning
- **transcript-model** · folds subscription frames into a transcript; no GPUI
- **conversation** · transcript view, composer, queue and attachments
- **session** · the task list, grouping, rename and archive
- **workspace** · the Host session entity, projects and connections
- **settings** · the settings dialog and preferences
- **shared** · palette, icons, copy in three languages
- **app** · windows, menus and composition

Dependencies only point down, so `transcript-model` can be tested by replaying recorded frames without a window."""

ANSWER_TESTS = """All transcript tests pass. The replay suite feeds recorded Host frames through `Transcript::apply` and checks the final turns, so a protocol change that alters ordering shows up here first.

Two things to know before you change this crate:

1. A gap in `sequence` or a new `hostEpoch` returns `Change::NeedsReopen`; never patch over it.
2. Older pages are held back until a page ends on a turn boundary, so a turn never appears without its prompt."""

ANSWER_QUEUE = """The conflict path is already covered: `queue.rs` re-reads the revision once and keeps the typed text, and the queue tests pass. There is no `retry.rs`; the retry lives in `QueueEditor::save`.

If you want the second conflict to be louder, the smallest change is to keep the draft open and show the Host's reason under it."""

ANSWER_NOTES = """Here is a first draft for 0.1.

**Maka GPUI 0.1** is the first native client for a Maka Runtime Host. It starts a local Host on first launch, remembers where your data lives, and runs tasks with streaming replies, tool activity, reasoning and a message queue.

- Tasks grouped by day or by project, with rename, flag and archive
- Model and permission switching from the composer
- Settings for connections, projects, permissions and appearance
- English, Simplified Chinese and Traditional Chinese

Known limits: Windows is compiled but not yet tested, and remote Hosts arrive in a later release."""

ANSWER_DESIGN = """The client follows Maka's own design system, so it reads as the same product as Maka Desktop.

## Surfaces

The window floor is the canvas, and the reading plate sits on it 8 px in from each edge. The fill step between them is the only separator; a line or a shadow on the same edge would be a second one.

### Ink and status

Text uses two ink tiers, and colour is a signal rather than decoration:

- **Primary blue** marks the one action that moves a task forward, such as Send or Allow
- **Warning** means a task is waiting on you, and **destructive** means something failed
- Running, waiting, failed and done differ by shape as well as hue, so no state rests on colour alone

> Accent is signal, never a flood. One separator per edge: a fill step, a line or a shadow, never two.

The full rules live in [DESIGN.md](https://github.com/apache/maka/blob/main/DESIGN.md) in the Maka repository."""

# Reasoning streamed (as `reasoning_content`) before a scenario's final answer.
REASONING = {
    "Map the workspace crates": "The Glob result lists nine Cargo.toml files under crates/. "
    "Group them by what they own rather than alphabetically: protocol and client first, "
    "then the transcript model, then the feature crates, then shared and the app shell.",
}

# Each scenario: (keyword in the first user message, title, tool calls in order,
# final Markdown answer, seconds between streamed chunks).
SCENARIOS = [
    ("reconnect", "Explain the reconnect backoff",
     [("Read", {"path": "crates/host-client/src/backoff.rs"})], ANSWER_BACKOFF, 0.02),
    ("crates", "Map the workspace crates",
     [("Glob", {"pattern": "crates/*/Cargo.toml"})], ANSWER_CRATES, 0.02),
    ("transcript tests", "Check the transcript tests",
     [("Bash", {"command": "cargo test -p transcript-model --locked 2>&1 | tail -3"})], ANSWER_TESTS, 0.02),
    ("queue edit", "Fix the queue edit conflict",
     [("Glob", {"pattern": "crates/conversation/src/*.rs"}),
      ("Read", {"path": "crates/conversation/src/queue.rs", "limit": 60}),
      ("Read", {"path": "crates/conversation/src/retry.rs"}),
      ("Bash", {"command": "cargo test -p conversation queue --locked 2>&1 | tail -4"})], ANSWER_QUEUE, 0.02),
    ("export", "Export the changelog",
     [("Bash", {"command": "cp CHANGELOG.md ~/maka-demo-export/"}),
      ("tool_search", {"query": "request sandbox boundary", "limit": 1}),
      ("request_sandbox_boundary", {"expansion": {"filesystem": {"entries": [
          {"path": os.path.expanduser("~/maka-demo-export"), "access": "write", "scope": "subtree"}]}},
          "justification": "Copy CHANGELOG.md to ~/maka-demo-export so you can attach it to the release email."})],
     "Copied `CHANGELOG.md` to `~/maka-demo-export/`.", 0.02),
    ("release notes", "Draft release notes for 0.1", [], ANSWER_NOTES, 0.35),
    ("design rules", "Summarise the design rules", [], ANSWER_DESIGN, 0.02),
]

def pick(messages):
    first_user = next((m for m in messages if m.get("role") == "user"), {})
    text = first_user.get("content")
    if isinstance(text, list):
        text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
    text = (text or "").lower()
    for key, title, calls, answer, delay in SCENARIOS:
        if key in text:
            return title, calls, answer, delay
    return "Demo task", [], "This demo model only knows a few scripted tasks.", 0.02

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json({"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "demo"}]})
        self._json({"error": "not found"}, 404)

    def _chunk(self, delta, finish=None):
        obj = {"id": self.cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL,
               "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
        self.wfile.flush()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        messages = req.get("messages", [])
        for tool in req.get("tools") or []:
            fn = tool.get("function", {})
            if fn.get("name") == "tool_search" and os.environ.get("DEMO_MODEL_DEBUG"):
                print(json.dumps(fn)[:1500], flush=True)
        title, calls, answer, delay = pick(messages)
        done = sum(1 for m in messages if m.get("role") == "tool")
        if not req.get("tools"):
            # An auxiliary request (the Host naming the task): answer with the title.
            calls, answer, delay = [], title, 0
        self.cid = "chatcmpl-" + uuid.uuid4().hex[:12]
        if not req.get("stream"):
            msg = {"role": "assistant", "content": answer}
            return self._json({"id": self.cid, "object": "chat.completion", "model": MODEL,
                               "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self._chunk({"role": "assistant", "content": ""})
        if done < len(calls):
            name, args = calls[done]
            self._chunk({"tool_calls": [{"index": 0, "id": "call_" + uuid.uuid4().hex[:8], "type": "function",
                                         "function": {"name": name, "arguments": json.dumps(args)}}]})
            self._chunk({}, "tool_calls")
        else:
            thought = REASONING.get(title) if req.get("tools") else None
            if thought:
                pieces = thought.split(" ")
                for i in range(0, len(pieces), 4):
                    self._chunk({"reasoning_content": " ".join(pieces[i:i + 4]) + " "})
                    time.sleep(0.03)
            words = answer.split(" ")
            for i in range(0, len(words), 4):
                self._chunk({"content": " ".join(words[i:i + 4]) + (" " if i + 4 < len(words) else "")})
                time.sleep(delay)
            self._chunk({}, "stop")
        usage = {"id": self.cid, "object": "chat.completion.chunk", "model": MODEL, "choices": [],
                 "usage": {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200}}
        self.wfile.write(f"data: {json.dumps(usage)}\n\ndata: [DONE]\n\n".encode())
        self.wfile.flush()

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 11500), Handler).serve_forever()
