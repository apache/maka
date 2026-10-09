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

# Check that a release tag can be cut: the tag is v<workspace version>, and
# CHANGELOG.md has a dated, non-empty section for that version.
#
#   scripts/release-check.sh [--notes] [<tag>]
#
# The tag is <tag> when given; else, in GitHub Actions, the pushed tag
# (GITHUB_REF_TYPE=tag); else a tag pointing at HEAD. With no tag at all
# there is no release to check and the script exits 0, so CI can run it on
# every push. --notes prints the version's changelog section (without its
# heading) to stdout after the checks pass, for the release description.
# Exit 1 when a check fails.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
changelog="$repo_root/CHANGELOG.md"

fail() {
  echo "release check: $*" >&2
  exit 1
}

notes=false
tag=""
for arg in "$@"; do
  case "$arg" in
    --notes) notes=true ;;
    -*) fail "unknown option $arg (usage: scripts/release-check.sh [--notes] [<tag>])" ;;
    *)
      [ -z "$tag" ] || fail "more than one tag given"
      tag="$arg"
      ;;
  esac
done

if [ -z "$tag" ] && [ "${GITHUB_REF_TYPE:-}" = tag ]; then
  tag="${GITHUB_REF_NAME:-}"
fi
if [ -z "$tag" ]; then
  tag="$({ git -C "$repo_root" tag --points-at HEAD --list 'v*' 2>/dev/null || true; } | head -n 1)"
fi
if [ -z "$tag" ]; then
  echo "release check: no release tag given or on HEAD; nothing to check" >&2
  exit 0
fi

version="$("$repo_root/scripts/workspace-version.sh")"
[ "$tag" = "v$version" ] \
  || fail "tag $tag does not match the workspace version $version (expected v$version)"

[ -f "$changelog" ] || fail "$changelog not found"

# Keep a Changelog: "## [1.2.3] - 2026-09-26". Dots in the version are
# literal; any other heading level or form does not count.
escaped_version="${version//./\\.}"
heading_pattern="^## \\[$escaped_version\\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$"
if ! grep -Eq "$heading_pattern" "$changelog"; then
  if grep -Eq "^## \\[$escaped_version\\]" "$changelog"; then
    fail "the CHANGELOG.md section for $version needs a date: \"## [$version] - YYYY-MM-DD\""
  fi
  fail "CHANGELOG.md has no section \"## [$version] - YYYY-MM-DD\"; move the Unreleased entries under it"
fi

# The section runs from its heading to the next "## " heading.
heading_line="$(grep -En "$heading_pattern" "$changelog" | head -n 1 | cut -d: -f1)"
section="$(awk -v heading_line="$heading_line" '
  NR <= heading_line { next }
  /^## / { exit }
  { print }
' "$changelog")"
if ! printf '%s\n' "$section" | grep -Eq '^[[:space:]]*[-*] '; then
  fail "the CHANGELOG.md section for $version lists no changes"
fi

echo "release check: $tag matches the workspace version and CHANGELOG.md has its section" >&2
if [ "$notes" = true ]; then
  printf '%s\n' "$section" | sed -e '/./,$!d'
fi
