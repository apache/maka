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

# Records Maka Desktop's configuration export and import against a fake Host
# (scripts/config-transfer-fixtures.ts) into crates/settings/fixtures/config_transfer,
# for the Data page's round-trip tests. Needs the Maka checkout ($MAKA_REPO,
# default ~/code/maka-pin) built, and Node 24.18.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
maka="${MAKA_REPO:-$HOME/code/maka-pin}"
out="$repo/crates/settings/fixtures/config_transfer"
bundle="$(mktemp -d)/config-transfer-fixtures.cjs"

mkdir -p "$out"
# Desktop's main-process modules are bundled from the checkout's sources;
# its packages stay external and load from their built `dist` through
# NODE_PATH. Electron itself is never reached.
"$maka/node_modules/.bin/esbuild" \
  "$repo/scripts/config-transfer-fixtures.ts" \
  --bundle --platform=node --format=cjs --target=node22 \
  --alias:@desktop="$maka/apps/desktop/src" \
  --packages=external \
  --log-level=warning \
  --outfile="$bundle"
NODE_PATH="$maka/node_modules" node "$bundle" "$out"
