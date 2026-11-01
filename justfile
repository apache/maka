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

# Show recipes grouped by workflow.
default:
    @just --list --unsorted

# Install locked JavaScript dependencies when their inputs or installation changed.
[group('Development')]
setup:
    node scripts/setup.mjs

# Build and run Maka with the local native or bridge capabilities.
[group('Development')]
run *args: setup
    node scripts/rust/run-cli.mjs "$@"

# Build Maka, the desktop shell and Python worker (--release / --target / --timings).
[group('Development')]
build *args: setup
    node scripts/rust/build-cli.mjs "$@"

# Export the selected plugins using the lightweight NSH compiler.
[group('Development')]
product *args: setup
    npm --workspace @maka-agent/product run build -- "$@"

# Check all maintained source and behavior; setup runs once for the dependency graph.
[group('Checks')]
check: setup fmt-check lint typecheck test-js test test-termina licenses

# Format Rust, JavaScript, TypeScript and project metadata.
[group('Checks')]
fmt: setup
    cargo fmt --all
    node node_modules/@biomejs/biome/bin/biome format --write .

# Verify formatting without rewriting files.
[group('Checks')]
fmt-check: setup
    node scripts/ci.mjs check format

# Run strict Rust and JavaScript lint checks.
[group('Checks')]
lint: setup
    node scripts/ci.mjs run clippy
    node scripts/ci.mjs check lint-js

# Verify generated contracts, TypeScript consumers and the workbench UI sources.
[group('Checks')]
typecheck: setup
    node scripts/ci.mjs run contracts

# Run Rust behavior tests; pass nextest filters after the recipe name.
[group('Checks')]
test *args: setup
    node scripts/ci.mjs run root "$@"

# Check the vendored terminal input library with the shared Cargo artifacts.
[group('Checks')]
test-termina:
    node scripts/ci.mjs run termina

# Check tooling and the exported product; native CLI composition is a Rust integration test.
[group('Checks')]
test-js: setup
    node scripts/ci.mjs check tooling-tests
    node scripts/ci.mjs run product

# Verify source headers and the reviewed dependency and notice snapshots.
[group('Checks')]
licenses: setup
    node scripts/ci.mjs check licenses
    node scripts/ci.mjs check notices

# Build a source-bound native npm package without publishing.
[group('Release')]
package source target build_id output="native-preview": setup
    node scripts/rust/release-cli.mjs --source "$1" --target "$2" --build-id "$3" --output "$4"

# Assemble and verify the launcher after all native packages have been built.
[group('Release')]
release-prepare directory="native-preview": setup
    node scripts/rust/pack-launcher.mjs "$1"
    node scripts/rust/publish-cli.mjs "$1"

# Install and exercise the prepared release on this platform, offline.
[group('Release')]
release-check directory="native-preview": setup
    node scripts/rust/verify-release.mjs "$1"

# Publish the verified platform set and launcher.
[group('Release')]
publish directory="native-preview" *args: setup
    node scripts/rust/publish-cli.mjs "$@" --publish

# Create a reviewed ASF source archive.
[group('Release')]
source version revision="HEAD": setup
    node scripts/asf-source-release.mjs create --version "$1" --revision "$2"

# The website has its own manifest and lockfile.
[group('Website')]
website-setup:
    npm --prefix website ci --no-audit --no-fund

[group('Website')]
website-dev *args:
    npm --prefix website run dev -- "$@"

[group('Website')]
website-check:
    npm --prefix website run test:dist
