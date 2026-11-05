<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Native CLI settings evidence

These images are cropped rasterizations of the actual NSH
`AppView::render` / Ratatui buffers captured by
`external_agents_ui_consent_native_catalog_cache_and_failure_isolation`.
They are not desktop screenshots or UI mockups. The test uses a real isolated
Host and the settings plugin with fixture CLI discovery; real CLI execution
and resume are verified separately.

The 180×160-cell captures retain their original RGB colors, symbols and layout.
The images show columns 34–145 and rows 50–110, rasterized at twice the original
8×16 cell size with Menlo. PNG metadata records each source buffer's SHA-256.

Reproduce the source captures:

```sh
MAKA_NSH_EVIDENCE=/tmp/native-cli-ui-evidence \
  cargo test -p maka-cli --test integration \
  external_agents_ui_consent_native_catalog_cache_and_failure_isolation -- --nocapture
```

## Runtime selection

![Native runtime selection](native-external-runtimes.png)

## Full-access consent

![Native full-access consent](native-external-consent.png)


## Claude interactive images and workspace trust

A real Rust Host / Claude Code 2.1.318 PTY / isolated Magpie 0.1.3005 route completed
the opt-in two-turn Host-tool test in 21.33 seconds. The workspace was a newly
created temporary directory, not pre-trusted in the private Claude profile.
Maka answered only that directory's native trust dialog; Claude persisted it.

Turn one attached two distinct PNG uploads containing `7319` and `9831`.
The expected numbers were not included in either prompt. Claude returned
`7319 9831`; turn two resumed the same native session and recalled that answer
without reattaching. Both turns called the fresh invocation's `SessionRead`
bridge and recorded the corresponding successful original Host receipts.
This is real Host/CLI verification, not the Python probe or the JS fixture.

The focused Host regressions cover multi-image send/resume with an image-bearing
JSONL row larger than the old 8 MiB cap, a long UTF-8 text attachment, and
cancellation while startup/image/text input is still pending. They use explicit
control gates rather than sleep-based ordering. Submitted text must still
correlate through native JSONL; terminal echoes never prove model completion.

## Limit audit decisions

- **8 MiB native frames / Claude rows → 256 MiB.** User JSONL embeds full
  base64 images; 20 images of 5 MiB already require roughly 134 MiB. A finite
  per-buffer guard prevents malformed native output from growing forever.
- **MCP's inherited 4 MiB POST default → 256 MiB.** The positive regression sends
  a valid >4 MiB UTF-8 `SessionSend` request through MCP, verifies queued
  admission, then verifies the next native invocation receives the full text.
  An invalid-body/HTTP-error-only test was replaced, not kept as a second test.
- **128 pre-ACK events removed.** Retention uses the same 256 MiB byte budget,
  with a 1 KiB/event floor for object overhead. A controlled stream of 257
  distinct deltas must arrive in order, exactly once, in the final answer.
  No synthetic padding frame is needed for this count regression.
- **64 KiB / 128 history fragments → 8 MiB readable / 64 MiB encoded source,
  no fragment-count cap.** A fresh backend needs prior conversation, not merely
  one turn's delta. The regression switches runtimes after a 9 MB canonical
  UTF-8 field, checks the retained >7 MiB tail and explicit omission notice,
  then checks the steady-state turn does not replay it.
- **Short setup/RPC waits → five minutes.** agy new/load and CLI cold startup
  can include authentication/network/MCP work. Large Claude text also gets a
  size-proportional allowance. These are not whole-turn deadlines.
- **Codex model discovery follows every native cursor.** The existing catalog
  test now obtains its 20 models from two real fixture pages; no separate
  pagination implementation-detail test was added.
- **Codex config/feature overrides allowed.** Generic provider and feature
  defaults do not replace the explicit full-access/never-approval turn policy.

Paging of archived Host results, immutable upload ownership/digests, the captured
Host-tool ceiling, native conversation identity, original T1/T2 receipts and
unknown/cleanup/persistence fences remain. Those preserve data/authority or
recoverable delivery; they are not small native payload/count limits.
