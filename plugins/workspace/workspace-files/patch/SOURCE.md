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


# Source and adaptation record

This crate contains code derived from OpenAI Codex's `codex-rs/apply-patch`,
licensed under Apache-2.0. Original notice: **OpenAI Codex, Copyright 2025 OpenAI**.
See the repository [NOTICE](../../../../NOTICE), the repository's Apache-2.0 [LICENSE](../../../../LICENSE),
and the pinned upstream [license](https://github.com/openai/codex/blob/624ccf794703e2d84e748fc3ef547d6191a8c0a4/LICENSE).

## Exact provenance

- `parser.rs` adapts `parse_one_hunk` and `parse_update_file_chunk` from
  [parser.rs at d45513ce5ad99d37638f355601f075d55860001e](https://github.com/openai/codex/blob/d45513ce5ad99d37638f355601f075d55860001e/codex-rs/apply-patch/src/parser.rs).
  This is the batch parser immediately before the executor filesystem migration.
  The newer streaming parser is intentionally not imported.
- `seek_sequence.rs` derives from
  [seek_sequence.rs at 624ccf794703e2d84e748fc3ef547d6191a8c0a4](https://github.com/openai/codex/blob/624ccf794703e2d84e748fc3ef547d6191a8c0a4/codex-rs/apply-patch/src/seek_sequence.rs).
- `update.rs` extracts `compute_replacements`'s PreserveLineEndings behavior from
  [file_update.rs at 624ccf794703e2d84e748fc3ef547d6191a8c0a4](https://github.com/openai/codex/blob/624ccf794703e2d84e748fc3ef547d6191a8c0a4/codex-rs/apply-patch/src/file_update.rs).
- `text_file.rs` derives from
  [text_file.rs at 624ccf794703e2d84e748fc3ef547d6191a8c0a4](https://github.com/openai/codex/blob/624ccf794703e2d84e748fc3ef547d6191a8c0a4/codex-rs/apply-patch/src/text_file.rs).
- Context-line index recording in `lib.rs` / `parser.rs` derives from
  [UpdateFileChunk at that same current revision](https://github.com/openai/codex/blob/624ccf794703e2d84e748fc3ef547d6191a8c0a4/codex-rs/apply-patch/src/parser.rs).
  Tests and public adapters are Maka additions.

## Deliberate adaptations

Filesystem access, PathUri resolution, CLI and shell invocation parsing, streaming,
networking, diff display, and upstream integration tests are excluded. No returned
path is authorized by this crate. Callers must apply their capability checks,
per-operation identity checks, pinned file operations, and durable mutation outcome recording.

The parser preserves upstream batch chunk rules, including optional first `@@`,
blank context lines, EOF markers, and fuzzy whitespace / Unicode matching.
Maka rejects Move, environment directives, shell wrappers, empty envelopes,
empty Add operations and NUL paths. Repeated paths and aliases such as `x` and
`./x` retain source order, matching Maka's sequential batch contract. Callers
must capture/prepare each operation against the state at that point, not assume
distinct spellings identify independent files or prepare every update from the
same initial snapshot.

Update preparation always uses upstream's line-ending preservation mode.
Context keeps its original bytes and endings, new lines use the first existing
ending (LF for empty sources), and an unterminated final line gains an ending.
Structured OpenAI create diffs remove the single newline forced by envelope Add
parsing, matching the SDK's join-without-forced-newline behavior.

Preparation retains complete source, patch and result strings and parsed lines
in memory. Multiple fuzzy passes and Unicode normalization retain upstream's
nonlinear worst case. Opaque chunk fields and an overlap/range check protect
reconstruction indices.

## Validation

The integration corpus covers exact and fuzzy matches, context preservation,
multiple chunks, EOF, mixed CRLF/LF/CR endings, unterminated sources, Add/Delete,
Move rejection, ordered repeated paths, malformed syntax, structured-diff operation
injection, large content and ordered operation batches. The extraction is not a full current Codex parser:
multi-environment and streaming grammar are explicitly outside the contract.

An external probe also compared eight LF/exact/fuzzy/EOF cases against the
unmodified, pinned d45513ce upstream crate and verified that upstream's preview
left its snapshot files unchanged. All eight outputs agreed; mixed line endings
are intentionally tested against the newer preservation contract instead.
