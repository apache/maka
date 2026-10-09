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

# Check that this client, its pin, and the Maka checkout agree on the Runtime
# Host protocol. MAKA_PIN names one apache/maka commit and its compatibility
# epoch; this script fails unless
#
#   - the RUNTIME_HOST_COMPATIBILITY_EPOCH const in crates/host-protocol equals
#     the pinned epoch,
#   - the Maka checkout is at the pinned commit, and
#   - the checkout's RUNTIME_HOST_COMPATIBILITY_EPOCH equals the pinned epoch.
#
# Maka checkout: $MAKA_REPO (default: $HOME/code/maka-pin).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin_file="$repo_root/MAKA_PIN"
maka_repo="${MAKA_REPO:-$HOME/code/maka-pin}"
ts_file="$maka_repo/packages/runtime-host/src/protocol/index.ts"
crate_src="$repo_root/crates/host-protocol/src"

fail() {
  echo "protocol drift check: $*" >&2
  exit 1
}

# Strip digit separators such as 177_u32 -> 177.
extract_number() {
  sed -E 's/^[^=]*=[[:space:]]*([0-9][0-9_]*).*$/\1/' | tr -d '_'
}

# The pin.
if [ ! -f "$pin_file" ]; then
  fail "pin file not found: $pin_file"
fi
pin_value() {
  sed -n "s/^$1=//p" "$pin_file" | tr -d '[:space:]'
}
pin_commit="$(pin_value commit)"
pin_epoch="$(pin_value epoch)"
if ! printf '%s' "$pin_commit" | grep -Eq '^[0-9a-f]{40}$'; then
  fail "MAKA_PIN has no full 40-character commit=<hash> line"
fi
if ! printf '%s' "$pin_epoch" | grep -Eq '^[0-9]+$'; then
  fail "MAKA_PIN has no epoch=<number> line"
fi

# Rust side.
if [ ! -d "$crate_src" ]; then
  fail "protocol crate not found: expected $crate_src"
fi

# Prefer the exact TypeScript name; accept a bare COMPATIBILITY_EPOCH as a
# fallback. Only `const` items count, so doc comments that quote the value are
# ignored.
rust_value_for() {
  local name="$1"
  local pattern="^[[:space:]]*(pub(\([^)]*\))?[[:space:]]+)?const[[:space:]]+${name}[[:space:]]*:[^=]*=[[:space:]]*[0-9]"
  grep -rhE --include='*.rs' "$pattern" "$crate_src" | extract_number | sort -u || true
}

rust_name="RUNTIME_HOST_COMPATIBILITY_EPOCH"
rust_values="$(rust_value_for "$rust_name")"
if [ -z "$rust_values" ]; then
  rust_name="COMPATIBILITY_EPOCH"
  rust_values="$(rust_value_for "$rust_name")"
fi
if [ -z "$rust_values" ]; then
  fail "no RUNTIME_HOST_COMPATIBILITY_EPOCH (or COMPATIBILITY_EPOCH) const with a numeric value found under $crate_src"
fi
if [ "$(printf '%s\n' "$rust_values" | wc -l | tr -d ' ')" != "1" ]; then
  fail "$rust_name is defined more than once with different values under $crate_src: $(printf '%s ' $rust_values)"
fi
rust_epoch="$rust_values"

if [ "$rust_epoch" != "$pin_epoch" ]; then
  fail "crates/host-protocol has compatibility epoch $rust_epoch ($rust_name), MAKA_PIN pins $pin_epoch. Update the Rust constant and every protocol type that changed with it, or the pin."
fi

# The Maka checkout: the pinned commit, and the epoch that commit declares.
if [ ! -f "$ts_file" ]; then
  fail "Maka protocol file not found: $ts_file (set MAKA_REPO to a Maka checkout at $pin_commit)"
fi
if ! checkout_commit="$(git -C "$maka_repo" rev-parse --verify --quiet 'HEAD^{commit}')"; then
  fail "cannot read the commit of the Maka checkout at $maka_repo; it must be a git checkout at $pin_commit"
fi

ts_pattern='^[[:space:]]*export[[:space:]]+const[[:space:]]+RUNTIME_HOST_COMPATIBILITY_EPOCH[[:space:]]*(:[^=]*)?=[[:space:]]*[0-9]'
ts_lines="$(grep -E "$ts_pattern" "$ts_file" || true)"
if [ -z "$ts_lines" ]; then
  fail "RUNTIME_HOST_COMPATIBILITY_EPOCH not found in $ts_file"
fi
ts_values="$(printf '%s\n' "$ts_lines" | extract_number | sort -u)"
if [ "$(printf '%s\n' "$ts_values" | wc -l | tr -d ' ')" != "1" ]; then
  fail "RUNTIME_HOST_COMPATIBILITY_EPOCH is defined more than once with different values in $ts_file"
fi
ts_epoch="$ts_values"

if [ "$checkout_commit" != "$pin_commit" ] || [ "$ts_epoch" != "$pin_epoch" ]; then
  fail "the Maka checkout at $maka_repo is at commit $checkout_commit (compatibility epoch $ts_epoch), but MAKA_PIN pins $pin_commit (epoch $pin_epoch). Check out the pinned commit (git -C $maka_repo checkout --detach $pin_commit), or set MAKA_REPO to a checkout that is at it."
fi

echo "protocol drift check: ok (compatibility epoch $pin_epoch, Maka $pin_commit)"
