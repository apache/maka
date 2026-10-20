<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Maka CLI container

This image packages an **exact, already-published** `maka-agent` npm version on
Debian Bookworm with Node.js 24 and glibc. It is a developer convenience build,
not an Apache Software Foundation release. Apache Maka is undergoing incubation;
see [DISCLAIMER-WIP](../../../DISCLAIMER-WIP).

The Dockerfile installs the selected version from the public npm registry; it
does not build the checked-out source. This guide covers local builds only.

## Build and run locally

From the repository root, resolve the current npm Nightly once and build it:

```sh
MAKA_VERSION=$(npm view maka-agent@nightly version --registry=https://registry.npmjs.org/)
docker build --build-arg "MAKA_VERSION=$MAKA_VERSION" \
  --tag maka-cli:local packages/cli/container
docker run --rm maka-cli:local --version
docker run --rm maka-cli:local --help
```

The version argument is required. Floating tags such as `latest` and `nightly`
are rejected by the Dockerfile so a build cannot silently select the early alpha
on npm's `latest` channel. The downloaded tarball, including its bundled private
packages, is checked against the public registry's SHA-512 integrity before
installation. This verifies package bytes, not the publisher's provenance identity.
Installation runs as the non-root `node` user and keeps a lockfile in `/opt/maka`.
Native dependencies need install scripts, so they are enabled after verification.

The Node base image is pinned by its multi-platform digest. Debian packages and
transitive npm dependency resolution can still change between builds, so an exact
CLI version is not a reproducible image digest.

Start the interactive TUI against a project, keeping configuration across runs:

```sh
docker run --rm -it \
  --mount type=volume,src=maka-profile,dst=/home/node/.config/Maka \
  --mount "type=bind,src=$PWD,dst=/workspace" \
  maka-cli:local
```

The image includes Tini for signal forwarding and child reaping. Pass CLI arguments
after the image, for example `--version`, `--help`, or
`run "Summarize this project"`. No model credentials are embedded. Use `/setup` and `/mcp` to manage connections and MCP servers.

The default user is `node` (UID/GID 1000), with `/workspace` as its working
directory. On Linux, give that account write access to the bind-mounted project,
or build a derivative image with an account matching the project owner. The
profile volume contains credentials and session state; keep it private. Use a
separate container profile rather than mounting an actively used desktop profile.

For preconfiguration, the default workspace is
`/home/node/.config/Maka/workspaces/default`; its `mcp.json` can be supplied through
the profile volume. MCP commands execute **inside** the container: install their
executables in a derivative image and use container paths in configuration. Node,
Python, Git, SSH and ripgrep are included; arbitrary MCP servers, browsers, Docker
and systemd are not. Host files are visible only through mounts, and `localhost`
refers to the container. The image is intended for TUI/CLI runs, not for installing
a persistent Runtime Host system service inside Docker.
