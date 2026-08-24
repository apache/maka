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

# Windows sandbox native evidence

This directory contains the native Rust broker/launcher and Windows evidence
tooling selected by the Windows sandbox RFC. The release build is packaged by
the Windows x64 pipeline and registered through `SandboxManager` only when the
native resource is present.

The first slice freezes the launcher request/result shapes in the shipped Rust
types and exercises them through native smoke tests. A launcher that merely
starts a process is not sufficient evidence.

Run the contract checks on Windows:

```powershell
cargo test --manifest-path experiments/windows-sandbox/launcher/Cargo.toml --locked
pwsh experiments/windows-sandbox/appcontainer-smoke.ps1
```

The smoke probes exit non-zero when an observation differs from its expectation.
Their JSON reports are evidence inputs, not claims that the parent process is
sandboxed.

`launcher/` also retains the rejected process-containment prototype. It probes a
restricted primary token, suspended process creation, post-create Job
assignment, kill-on-close descendants, and no inherited handles. The post-create
assignment is explicitly not the atomic Job guarantee and is not the production
path. It remains only as bounded negative evidence.

The current Windows 2025 evidence records an incompatibility in the
unprivileged candidate: `CreateProcessWithTokenW` creates the restricted child,
but both the native launcher self-probe and `cmd.exe /d /c exit 0` fail to finish
initialization before the 30-second safety deadline. The launcher terminates the
child and returns failure. The CI lane treats this exact bounded, fail-closed
result as evidence; any other launch error still fails the job. This candidate
does not satisfy W0 and must not be connected to the product.

`atomic-launch-capability.ps1` records whether the current Windows identity has
the privileges needed to test the separate privileged-broker prototype. A
missing privilege is an expected fail-closed capability result; it must not be
worked around by silently using the non-atomic launcher path.

`maka-windows-sandbox --broker-local <manifest>` consumes one manifest,
authorizes it in-process, launches it, restores ACLs, and exits. The lower-level
`--broker-serve-once <pipe> <account-sid> <profile-digest>` mode exposes one
bounded experimental request over a pipe. The pipe rejects remote
clients, grants access only to SYSTEM and the supplied user SID, obtains the
client PID from the kernel, enforces nonce replay and profile-digest checks,
and calls only the AppContainer atomic launch path. Authorization validates the
digest of the complete launch policy. The broker never falls back to post-create
Job assignment.

`launcher --atomic <request.json>` is the privileged-broker launch candidate.
It passes the Job handle through `PROC_THREAD_ATTRIBUTE_JOB_LIST` to
`CreateProcessAsUserW`, so successful process creation and Job membership are
one operation. The launcher verifies the restricted token and Job membership
before reporting `atomicJob:true`. The atomic candidate never falls back to the
post-create assignment path. `atomic-launch-smoke.ps1` requires complete proof
when the runner has both broker privileges and otherwise requires an explicit
non-zero, fail-closed outcome.

`launcher --appcontainer <request.json>` is the isolated-identity candidate. It
creates a fresh request-derived AppContainer identity, combines its token with
the same atomic Job attribute, and supplies no network capabilities. Before
launch, the broker persists an ACL recovery ledger, rejects reparse points, and
grants that per-launch SID only the requested roots. A short-lived global mutex
serializes ACL mutation, while a request-specific kernel lease distinguishes
live ledgers from abandoned ones without serializing child execution. The smoke
proves allowed read/write access, denial of a user-readable sibling file and
live loopback endpoint, stale-ledger recovery, concurrent launches, junction
rejection, and removal of the temporary AppContainer ACE after exit.
