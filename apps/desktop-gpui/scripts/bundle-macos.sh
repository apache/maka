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

# Build the release binary and assemble "target/bundle/Maka GPUI.app", then
# print its path.
#
#   scripts/bundle-macos.sh        # `just bundle` runs this
#   MAKA_GPUI_BUNDLE_DIR=target/bundle-check scripts/bundle-macos.sh
#
# MAKA_GPUI_BUNDLE_DIR puts the bundle in another directory (relative to the
# current one), for example to check a build while a copy from the default
# directory is running.
#
# - Contents/MacOS/maka-gpui: `cargo build --release -p app`;
# - Contents/Info.plist: packaging/macos/Info.plist with the workspace version
#   (scripts/workspace-version.sh) and the minimum macOS filled in, including
#   the purpose strings macOS needs to ask before a Runtime Host the app
#   started automates another app or reaches a privacy-protected service;
# - Contents/Resources/AppIcon.icns: assets/maka-icon.png scaled into an
#   iconset with sips, then iconutil;
# - an ad-hoc signature (codesign --sign -). The bundle runs on the Mac that
#   built it; another Mac refuses it until the quarantine attribute is
#   removed. Developer ID signing and notarization are follow-ups
#   (packaging/README.md).
#
# MACOSX_DEPLOYMENT_TARGET (default 11.0, the arm64 floor) is both the
# binary's minimum macOS and LSMinimumSystemVersion. CARGO_TARGET_DIR is
# honored.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "bundle-macos: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "builds a macOS app bundle; run it on macOS"
for tool in cargo codesign iconutil plutil sips; do
  command -v "$tool" >/dev/null || fail "$tool not found"
done

version="$("$repo_root/scripts/workspace-version.sh")"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
template="$repo_root/packaging/macos/Info.plist"
source_icon="$repo_root/assets/maka-icon.png"

icon_width="$(sips -g pixelWidth "$source_icon" | awk '/pixelWidth/ { print $2 }')"
icon_height="$(sips -g pixelHeight "$source_icon" | awk '/pixelHeight/ { print $2 }')"
[ "$icon_width" = 1024 ] && [ "$icon_height" = 1024 ] \
  || fail "$source_icon must be 1024x1024, not ${icon_width}x${icon_height}"

echo "bundle-macos: building maka-gpui $version (release, macOS $MACOSX_DEPLOYMENT_TARGET or later)" >&2
cargo build --manifest-path "$repo_root/Cargo.toml" --release --locked -p app --bin maka-gpui

bundle_dir="${MAKA_GPUI_BUNDLE_DIR:-$target_dir/bundle}"
mkdir -p "$bundle_dir"
bundle_dir="$(cd "$bundle_dir" && pwd)"
app="$bundle_dir/Maka GPUI.app"
iconset="$bundle_dir/AppIcon.iconset"
rm -rf -- "$app" "$iconset"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$iconset"

cp "$target_dir/release/maka-gpui" "$app/Contents/MacOS/maka-gpui"

# The template's leading comment is for maintainers, not for the bundle.
sed -e '/<!--/,/-->/d' \
  -e "s/@VERSION@/$version/g" \
  -e "s/@MINIMUM_SYSTEM_VERSION@/$MACOSX_DEPLOYMENT_TARGET/g" \
  "$template" >"$app/Contents/Info.plist"
if grep -q '@[A-Z_]*@' "$app/Contents/Info.plist"; then
  fail "Info.plist still has a placeholder: $(grep -o '@[A-Z_]*@' "$app/Contents/Info.plist" | head -1)"
fi
plutil -lint -s "$app/Contents/Info.plist" || fail "Info.plist is not a valid property list"
# Without its purpose string macOS refuses, without asking, the Apple events
# a Host's `osascript` sends (the Host runs as this app's child).
plutil -extract NSAppleEventsUsageDescription raw "$app/Contents/Info.plist" >/dev/null \
  || fail "Info.plist has no NSAppleEventsUsageDescription"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$source_icon" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$source_icon" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output "$app/Contents/Resources/AppIcon.icns" "$iconset"
rm -rf -- "$iconset"

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app" || fail "the signature does not verify"

echo "$app"
