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

# macOS checkpoint capability probe

This developer-only diagnostic checks whether its own process can create and delete a native APFS snapshot on a disposable test volume. It is **not** a production workspace authority, a checkpoint publisher, or a restore tool. It is not invoked during Host startup or CI; the pure classification tests can run without disk-image operations.

## Run

On macOS with Xcode command-line tools installed, from the repository root as an ordinary user:

```sh
node packages/runtime-host/scripts/macos-checkpoint-capability-probe.mjs
```

Do not use sudo. The runner accepts no arguments or project paths. It compiles the companion C source, reads its existing signing entitlements, creates and mounts its own 128 MiB sparse APFS image, checks snapshot capability, and attempts to create and delete one uniquely named snapshot. It does not add entitlements, request elevation, touch an existing project directory, or invoke Time Machine.

The runner prints the exact temporary directory before doing external operations. Cleanup uses a normal detach and non-recursive removal of owned files only. A busy or failed detach leaves resources for diagnosis rather than forcing unmount or deleting a mounted tree. After interruption or a cleanup error, inspect only the reported directory and its mount before manual cleanup; do not use broad unmount or recursive-delete commands.

## Interpret the result

- Exit **2**: unavailable, including non-macOS or native permission/unsupported errors.
- Exit **1**: probe or cleanup error; inspect stderr and any report.
- Exit **0**: snapshot creation and deletion succeeded **only**.

Even exit 0 reports `productionAuthorityReady: false`. It does not establish snapshot mounting, stable reads, signing/distribution eligibility, Session-state alignment, external-writer isolation, or cancellation/crash recovery. A filesystem supporting snapshots does not prove that the current process has permission to create one. Do not infer that every privileged/signed deployment is impossible from an ordinary unentitled process receiving `EPERM`.

## Tests and release scope

```sh
node --test packages/runtime-host/scripts/macos-checkpoint-capability-probe.test.mjs
node --test scripts/asf-license-headers.test.mjs scripts/asf-source-release.test.mjs
```

The probe tests exercise result classification and reject caller-supplied paths before resources are created. They do not run the native volume probe. Both the source-header audit and source-archive classifier recognize C sources; compiled binaries remain subject to the existing archive rejection policy.

Extracted from [#5605](https://github.com/apache/maka/pull/5605) following its [scope review](https://github.com/apache/maka/pull/5605#pullrequestreview-5570258061). This diagnostic is independent of that PR and does not settle the [workspace-authority alternatives](https://github.com/apache/maka/pull/5605#issuecomment-6230741834) or implement any of them for production.
