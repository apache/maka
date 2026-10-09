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

# Capture one application window to a PNG.
#   scripts/screenshot.sh [owner-name] [out.png]
# owner-name may also be a process id, which is safer when several
# instances run.
# Defaults: owner "maka-gpui", out "target/screenshots/<owner>-<timestamp>.png".
# Needs Screen Recording permission for the terminal that runs it.
set -euo pipefail
owner="${1:-maka-gpui}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$root/target/screenshots/${owner// /-}-$(date +%H%M%S).png}"
mkdir -p "$(dirname "$out")"
info="$(swift "$root/scripts/window-id.swift" "$owner")"
id="${info%% *}"
screencapture -x -o -l "$id" "$out"
# The capture carries the display's profile (Display P3 on Macs), which shifts
# saturated colours when sampled as numbers. Convert to sRGB so a pixel sample
# reads the value the app actually drew.
sips -m "/System/Library/ColorSync/Profiles/sRGB Profile.icc" "$out" --out "$out" >/dev/null 2>&1 || true
echo "$out ($info)"
