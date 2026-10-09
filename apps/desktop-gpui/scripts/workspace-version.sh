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

# Print the workspace version: `version` in the [workspace.package] table of
# the root Cargo.toml, the only place the version is kept (AGENTS.md).
# Exit 1 when it cannot be found.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

version="$(awk '
  /^\[/ { in_table = ($0 == "[workspace.package]") ; next }
  in_table && /^version[[:space:]]*=/ {
    sub(/^version[[:space:]]*=[[:space:]]*"/, "")
    sub(/".*$/, "")
    print
    exit
  }
' "$repo_root/Cargo.toml")"

if [ -z "$version" ]; then
  echo "workspace-version: no version in [workspace.package] of $repo_root/Cargo.toml" >&2
  exit 1
fi
echo "$version"
