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

# Copies Maka Desktop's app icons into assets/app-icons/ and draws the
# Settings picker's thumbnails from them (Desktop's `PREVIEW_SIZE`, 128 px)
# with macOS's `sips`. Run it when the pinned checkout's icon set changes.
#
#   MAKA_REPO=~/code/maka-pin scripts/app-icons.sh
set -euo pipefail

repo="${MAKA_REPO:-$HOME/code/maka-pin}"
source="$repo/apps/desktop/assets"
here="$(cd "$(dirname "$0")/.." && pwd)"
target="$here/assets/app-icons"

mkdir -p "$target/thumbnails"
# Desktop keeps the `default` choice (the Classic mark) at assets/icon.png.
cp "$source/icon.png" "$target/default.png"
cp "$source"/app-icons/*.png "$target/"
for icon in "$target"/*.png; do
    sips -z 128 128 "$icon" --out "$target/thumbnails/$(basename "$icon")" >/dev/null
done
echo "$(ls "$target"/*.png | wc -l | tr -d ' ') icons in $target"
