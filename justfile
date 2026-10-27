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

set positional-arguments

default:
    @just --list

# Install product authoring and plugin tooling.
setup:
    npm ci --no-audit --no-fund

# Export the product using the checkout's current UI compiler.
product *args:
    npm --workspace @maka-agent/product run build -- "$@"

# Run the native CLI or TUI.
run *args:
    node scripts/rust/run-cli.mjs "$@"

# Build the native CLI and desktop shell (--release / --target).
build *args:
    node scripts/rust/build-cli.mjs "$@"

# Check all maintained code and behavior.
check: fmt-check lint typecheck test-js test test-termina licenses

fmt:
    cargo fmt --all
    node node_modules/@biomejs/biome/bin/biome format --write .

fmt-check:
    cargo fmt --all -- --check
    node node_modules/@biomejs/biome/bin/biome format .

lint:
    cargo clippy --config 'build.warnings="deny"' --locked --workspace --all-targets
    node node_modules/@biomejs/biome/bin/biome lint .

typecheck:
    npm --workspace @maka-agent/plugin-sdk run schema:check
    npm --workspace @maka-agent/plugin-sdk run typecheck
    npm --workspace @maka-agent/product run typecheck

test *args:
    cargo nextest run --locked --workspace "$@"

test-termina:
    cargo test --locked --manifest-path third-party/termina/Cargo.toml --lib --target-dir "${CARGO_TARGET_DIR:-target}"

test-js:
    node --test scripts/*.test.mjs scripts/rust/*.test.mjs packages/cli/tests/*.test.mjs
    npm --workspace @maka-agent/product test

licenses:
    node scripts/asf-license-headers.mjs check
    node scripts/rust/dependencies.mjs check
    node scripts/rust/notices.mjs check

# Build a source-bound native npm package without publishing.
package source target build_id output="native-preview":
    node scripts/rust/release-cli.mjs --source "$1" --target "$2" --build-id "$3" --output "$4"

# Assemble and verify the launcher after all native packages have been built.
release-prepare directory="native-preview":
    node scripts/rust/pack-launcher.mjs "$1"
    node scripts/rust/publish-cli.mjs "$1"

# Install and exercise the prepared release on this platform, offline.
release-check directory="native-preview":
    node scripts/rust/verify-release.mjs "$1"

# Publish the verified platform set and launcher.
publish directory="native-preview" *args:
    node scripts/rust/publish-cli.mjs "$@" --publish

source version revision="HEAD":
    node scripts/asf-source-release.mjs create --version "$1" --revision "$2"

# The website has its own manifest, lockfile and dependencies.
website-setup:
    npm --prefix website ci --no-audit --no-fund

website-dev *args:
    npm --prefix website run dev -- "$@"

website-check:
    npm --prefix website run test:dist
