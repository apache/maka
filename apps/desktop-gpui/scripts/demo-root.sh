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

# Build a clean demo State Root for review screenshots.
#
#   scripts/demo-root.sh            # creates target/demo-root and leaves its Host running
#   scripts/demo-root.sh --serve    # only starts a Host for the existing target/demo-root
#
# --serve is for after the Host stopped or the Maka checkout moved to a new pin:
# it refuses while a Host still runs for the root, starts one in the background
# (log: target/demo-host.log), and prints its pid.
#
# Needs: a Maka checkout in $MAKA_REPO (default ~/code/maka-pin, at the commit
# MAKA_PIN names) built for the CLI, Node >= 22.19 via nvm, and, to create the
# root, scripts/demo-model.py listening on 127.0.0.1:11500.
# The demo tasks run against this repository, read-only. Nothing touches .dev-root
# or live Maka data.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
maka="${MAKA_REPO:-$HOME/code/maka-pin}"
root="$here/target/demo-root"
log="$here/target/demo-host.log"
mode="${1:-create}"
case "$mode" in
  create | --serve) ;;
  *) echo "usage: scripts/demo-root.sh [--serve]" >&2; exit 2 ;;
esac

# The pid in the root's registration when that Host is alive, else nothing.
running_host() {
  local marker="$root/.maka-storage-root.json" root_id registration pid
  [ -f "$marker" ] || return 0
  root_id="$(sed -n 's/.*"rootId": *"\([0-9a-f]\{64\}\)".*/\1/p' "$marker")"
  case "$(uname -s)" in
    Darwin) registration="$HOME/Library/Caches/Maka/runtime-hosts/$root_id/registration.json" ;;
    *) registration="$HOME/.cache/maka/runtime-hosts/$root_id/registration.json" ;;
  esac
  [ -f "$registration" ] || return 0
  pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$registration")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

start_host() {
  : > "$log"
  ( cd "$maka" && env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
      nohup node packages/cli/dist/dev-cli.js runtime-host serve --root "$root" --json > "$log" 2>&1 & )
  for _ in $(seq 1 60); do grep -q runtime_host_ready "$log" 2>/dev/null && return 0; sleep 1; done
  echo "the Host did not report ready; see $log" >&2
  exit 1
}

# shellcheck disable=SC1090
source "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 24.18 >/dev/null

if [ "$mode" = --serve ]; then
  [ -f "$root/.maka-storage-root.json" ] || { echo "$root is not a State Root; run scripts/demo-root.sh to create it" >&2; exit 1; }
  pid="$(running_host)"
  [ -z "$pid" ] || { echo "a Runtime Host (pid $pid) already serves $root; stop it first" >&2; exit 1; }
  start_host
  echo "demo root served: $root (Host pid $(running_host); see $log)"
  exit 0
fi

curl -sf http://127.0.0.1:11500/v1/models >/dev/null || { echo "start scripts/demo-model.py first" >&2; exit 1; }
[ -e "$root" ] && { echo "$root exists; remove it first" >&2; exit 1; }
mkdir -p "$root"
# The "export" scenario asks for write access to this empty folder, which must
# exist for a subtree boundary. Remove it with: rm -rf ~/maka-demo-export
mkdir -p "$HOME/maka-demo-export"
start_host
setup="$maka/packages/cli/.demo-setup-$$.mjs"
trap 'rm -f "$setup"' EXIT
cat > "$setup" <<'JS'
import { connectExistingRuntimeHost, readRuntimeHostConnectionCatalog } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION, INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID } from '@maka/runtime-host/protocol';
import { randomUUID } from 'node:crypto';
const [rootPath, ws] = process.argv.slice(2);
const r = await connectExistingRuntimeHost({ rootPath, protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION }, compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID });
if (r.kind !== 'connected') throw new Error(JSON.stringify(r));
const c = r.connection;
const target = { kind: 'create', providerType: 'custom', defaultApiProtocol: 'openai-chat', slug: 'demo', name: 'Scripted demo' };
const baseUrl = 'http://127.0.0.1:11500/v1';
await c.request('connection.onboarding.verify', { target, apiKey: 'demo', baseUrl });
await c.request('connection.onboarding.save', { target, apiKey: 'demo', baseUrl, enabledModelIds: ['scripted-demo'] });
const cat = await readRuntimeHostConnectionCatalog(c);
const demo = cat.connections.find((x) => x.slug === 'demo');
await c.request('connection.catalog.set-default-target', { expectedCatalogRevision: cat.revision, target: { connectionId: demo.connectionId, modelId: 'scripted-demo' } });
await c.request('project.catalog.mutate', { kind: 'register', path: ws, prefer: true });
// New tasks start in Auto (ask), as most people run Maka; it is also what makes
// the export scenario meet the sandbox and raise a real permission request.
const policy = await c.request('runtime.policy.query', {});
await c.request('runtime.policy.mutate', { expectedRevision: policy.revision ?? policy.snapshot?.revision, operation: { kind: 'set_chat_defaults', value: { ...(policy.policy?.chatDefaults ?? policy.snapshot?.policy?.chatDefaults ?? {}), permissionMode: 'ask' } } });
for (const name of ['Audit contrast in dark mode', 'Plan the Agent Graph panel', 'Why does paging jump on Home?', 'Review the Windows pipe transport', 'Draft release notes for 0.1']) {
  await c.request('session.create', { sessionId: randomUUID(), workspace: { kind: 'host_path', path: ws }, name, modelTarget: { kind: 'default' }, permissionMode: 'ask' });
}
await c.close?.();
process.exit(0);
JS
( cd "$maka" && node "$setup" "$root" "$here" )
cd "$here"
for prompt in "Check that the transcript tests pass" "Map the crates in this workspace" "Fix the queue edit conflict in the conversation crate" "Explain the reconnect backoff in host-client"; do
  cargo run -q -p conversation --example live_turn -- --root "$root" --workspace "$here" --prompt "$prompt" 2>&1 | grep -E "ended" || true
done
# Last, a task left waiting on a real permission request (never answered here).
( cargo run -q -p conversation --example live_turn -- --root "$root" --workspace "$here" \
    --prompt "Export the changelog to a folder in my home directory" > "$here/target/demo-export.log" 2>&1 & )
sleep 20
# The Host titles a task from the model's first reply; give the three demo
# transcripts the titles a person would write.
rename="$maka/packages/cli/.demo-rename-$$.mjs"
trap 'rm -f "$setup" "$rename"' EXIT
cat > "$rename" <<'JS'
import { connectExistingRuntimeHost, readRuntimeHostSessions } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION, INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID } from '@maka/runtime-host/protocol';
const [rootPath] = process.argv.slice(2);
const r = await connectExistingRuntimeHost({ rootPath, protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION }, compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID });
const c = r.connection;
const titles = [['The client reconnects', 'Explain the reconnect backoff'], ['Eleven crates', 'Map the workspace crates'], ['All transcript tests pass', 'Check the transcript tests']];
for (const s of await readRuntimeHostSessions(c)) {
  const hit = titles.find(([prefix]) => (s.name ?? '').startsWith(prefix));
  if (!hit) continue;
  const res = await c.request('session.metadata.update', { sessionId: s.id ?? s.sessionId, expectedRevision: s.revision, patch: { name: hit[1] } });
  console.log(hit[1], res.kind);
}
await c.close?.(); process.exit(0);
JS
( cd "$maka" && node "$rename" "$root" )
echo "demo root ready: $root (its Host keeps running; see target/demo-host.log)"
