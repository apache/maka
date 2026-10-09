#!/usr/bin/env bash
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

# Record golden protocol fixtures from a running dev Runtime Host into
# crates/host-protocol/fixtures. Start the Host first (docs/dev-host.md).
#
# State Root: $MAKA_GPUI_DEV_ROOT (default: <repo>/.dev-root). Extra arguments
# go to the capture tool, for example:
#
#   scripts/capture-fixtures.sh --create-session /private/tmp/maka-gpui-fixture-workspace
#
# `--create-session` adds one Session to the dev State Root so the catalog
# fixtures contain a real projection.
#
#   scripts/capture-fixtures.sh --sequences /private/tmp/maka-gpui-fixture-workspace
#
# `--sequences` also records Turn scenarios into
# crates/host-protocol/fixtures/sequences/<name>.jsonl (one frame per line,
# both directions) and the `subscription.open` fixture. The default scenarios
# (plain_text, permission_allow, stop_mid_stream) need a working model
# connection; `--only stop_after_start,failed_turn` records ones that do not.
# A scenario whose Turn ends differently than expected is not written. Every
# scenario adds a Session to the dev State Root. Never point this at live
# Maka data.
#
# `--onboarding <base-url> [--onboarding-key <key>]` records the connection
# effects (verify, save, update, set-default-target, remove) against an
# OpenAI-compatible endpoint, for example a local Ollama at
# http://127.0.0.1:11434/v1 with key `ollama`; the connection it adds is
# removed again.
#
# `--long-history <workspace-dir>` records only
# sequences/long_history.jsonl: a five-Turn Session with long prompts,
# reopened with the 16 KiB tail and paged back with small older pages. It
# needs a working model connection and leaves every other fixture as it is.
#
# `--connection-slug <slug> --model <model-id>` (must be given together)
# record Sessions against that explicit connection and model instead of the
# catalog default, for a dev Host whose default connection cannot answer.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dev_root="${MAKA_GPUI_DEV_ROOT:-$repo_root/.dev-root}"

if [ ! -f "$dev_root/.maka-storage-root.json" ]; then
  echo "capture-fixtures: $dev_root is not an initialized State Root; start the dev Host first (docs/dev-host.md)." >&2
  exit 1
fi

cd "$repo_root"
exec cargo run --quiet -p host-client --example capture_fixtures -- \
  --root "$dev_root" \
  --out crates/host-protocol/fixtures \
  "$@"
