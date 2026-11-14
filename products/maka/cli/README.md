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

# maka-cli

[简体中文](README.zh-CN.md)

Builds the `maka` executable. It starts the terminal product, serves Hosts, exposes ACP and provides application inspection, composition and installation commands. Product startup wires native factories and JavaScript execution adapters into the platform owners.

From the repository root, run `just run` or `just run --help`. Cargo builds and embeds the current plugin selection and workbench in both debug and release binaries. Desktop runs in a separate sibling executable.

[Source](src/main.rs) · [Cargo manifest](Cargo.toml)

Run `maka` or `maka terminal-shell` for the [NSH terminal workbench](../terminal-shell/README.md). Both use `~/.maka/application/host` by default and accept `--root DIRECTORY` and `--session SESSION_ID`. Host discovery, startup, the interface and terminal cleanup run inside the same `maka` executable. Startup connects to an existing Host or starts one automatically; terminal and desktop clients can share that Host. Select a workspace and model in the interface. Terminals without image support use the Unicode renderer.

`maka --help` lists the CLI commands and default terminal options; `maka terminal-shell --help` shows the terminal options alone. The interactive entry requires terminal stdin and stdout. When either is redirected it exits with an error before opening or creating a Host; use explicit Host, application, Code or ACP commands for automation.

`host init --settings-stdin` initializes a new State Root and applies optional proxy settings, chat defaults (`chatDefaults.sandboxMode`), project directory roots (`projectDirectoryRoots`), model connections, credentials and default target JSON from stdin before returning `rootId`. For example:

```json
{
  "connections": [{
    "slug": "gateway",
    "provider": "openai-compatible",
    "configuration": { "baseUrl": "http://127.0.0.1:8080/v1" },
    "apiKey": "<API_KEY>",
    "enabledModelIds": ["my-model"]
  }],
  "defaultTarget": { "slug": "gateway", "modelId": "my-model" }
}
```

Connections also accept `name`, `enabled`, `requestHeaders`, `modelOverrides` and `requestBodyOverlay`. Input and default model preparation are validated before creating the Root. An existing Root cannot be reconfigured through this command; secrets stay in stdin.

`host serve` and `application serve` emit a JSON `ready` line with `rootId`, `hostEpoch` and `socketPath`. Use that epoch when connecting and verify the live Host identity. On Unix, sockets live in a private temporary child directory selected by the system; set `TMPDIR` for a different parent. The canonical socket path must fit the portable 100-byte limit; choose a shorter parent if startup reports that limit.

Headless commands (`host`, `application serve`, `code` and `acp`) install process logging before runtime initialization. Warnings and errors, including SQLx slow-query warnings, go to stderr without ANSI styling; stdout remains available for command results and protocol frames. Ordinary DEBUG query logs are disabled. Interactive products keep control of their terminal output.

Dedicated Host processes capture stderr in their Root's private control-cache file `host.stderr.log`: on-demand capture starts before spawning, while foreground serving starts after Root selection. Read it with `maka host logs --root-id ID`, or add `--follow` for live NDJSON and `--after CURSOR` to resume. Pages preserve raw bytes as Base64 and report missing capture, replacement or truncation; clearing the control cache removes these logs. This works without an installed service.

Inspect a committed session log with `maka inspect --root DIRECTORY --session SESSION_ID`.

## Portable Session checkpoints

Export a checkpoint that has already been published. Supply the Session ID and
the exact retained revision from its publication receipt. If the Head advances,
export fails and leaves the destination available for a retry with the new revision.

```sh
maka checkpoint export --root /path/to/host --session "$SESSION_ID" --revision "$REVISION" --output session.tar.gz
```

Copy the archive to another machine with Maka and choose a new inspection directory.
Opening works offline, including when the original Host, project and database are unavailable.

```sh
maka checkpoint open session.tar.gz --output inspection
```

- `checkpoint.json` records the source identity, revision, manifest and original Workspace consistency declaration.
- `history.jsonl` is the readable conversation and tool history. `history.snapshot` preserves the canonical history.
- `artifacts.jsonl` maps historical attachment records to files in `artifacts/`, named by their SHA-256 hex digest.
- `workspace/` contains the captured files when the checkpoint includes a Workspace.

Opening verifies the manifest, digests, archive completeness and canonical history
before publishing the inspection directory. Existing destinations are preserved.
A forced process exit can leave a hidden `.maka-inspection-*` staging directory
beside the destination, which can be removed once that process has exited. The
default limit for the total size of files in the inspection directory is
8 GiB; use `--max-bytes` to change it. Allow additional disk space for the
temporary validation database and staged objects. Digests check content integrity;
sender authentication requires a trusted channel. Export preserves the original
capture's consistency level. Opening only produces inspection files and grants
no authority to resume the source Session.

## Product updates, recovery and URL installation

Composition commands read complete JSON source and remote-export files. The Plugins composition editor loads an exact source revision in UTF-8 pages of at most 64 KiB and saves the confirmed native editor snapshot against that revision. Whole documents have no separate byte ceiling; typed validation, package checks, Host permissions, revision conflicts and actual resource admission still apply. Committed revisions retain the complete source for subsequent reads and reopening the Root.

Before a Host starts, it automatically updates selected bundled plugins using the same validation and recovery as `update-defaults --apply`. When opening the interface, a running product Host is checked through its management endpoint. An available code or bundled plugin update restarts a launcher-owned ephemeral Host: existing connections close, background tasks and terminals stop, and startup waits for cleanup before opening the new Host. Installed services and explicitly selected application Hosts retain their idle-only update policy. A startup with current packages does not create another source revision. If an update is incompatible with saved configuration, startup reports the error and leaves the source intact so it can be corrected and retried.

To preview or explicitly apply an update while a standalone Host is stopped, use its State Root:

```sh
maka application update-defaults --root /path/to/host
maka application update-defaults --root /path/to/host --apply
```

Review the exact package revisions in the preview. Apply replaces explicitly selected packages whose IDs match this executable's bundle, including locally modified packages with those IDs. Other packages, composition settings, permissions and business data stay intact; new default components are not added. Invalid combinations are rejected before updating. After an interruption, rerun `--apply` to finish the same update, then start the Host. This updates application packages; `host upgrade` updates the native executable.

`update-defaults` requires stored package records that the current executable can decode. A Root containing a removed internal format, such as the old `desktop` surface, fails before preview; preserve that Root and initialize a new one.

Direct package installation requires the selected Host Root to be inactive. `update-defaults` and `install-url` default to `~/.maka/application/host`; select another Host with `--root DIRECTORY`.

```sh
maka application install-url --url https://example.com/plugin.maka-plugin
```

`install-url` accepts a direct HTTP(S) `.maka-plugin` bundle URL. It validates the package digest and bounded downloads, stores an immutable revision, and leaves activation to the Plugins composition editor. Add `--sha256 HEX` to verify a publisher-provided bundle digest, `--expected-revision N` for an explicit source comparison, or `--deployment UUID` for an independently committed deployment. Downloads use the process proxy environment. The live Plugins install page also exposes URL installation through the bound Host deployment manager.
