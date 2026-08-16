# Windows sandbox backend RFC v1

- Status: implementation baseline selected; product integration under release validation
- Tracking: Windows Phase 4 in [issue #2142](https://github.com/maka-agent/maka-agent/issues/2142)
- Updated: 2026-08-14
- Owners: `@maka/runtime` sandbox boundary and Runtime Host execution composition
- Chinese version: [windows-sandbox-rfc-v1.zh-CN.md](./windows-sandbox-rfc-v1.zh-CN.md)

## 1. Scope and design status

This RFC defines the threat model, selected native architecture, alternatives, delivery slices, and
release evidence for the Windows sandbox. It is the complete Phase 4 security baseline. The first
product implementation is in #2961; the broader Windows support declaration remains governed by
#2142 and the release gates below.

W0 selected a Maka-owned Rust implementation rather than importing another product's setup and
protocol model. Windows 2025 evidence rejected the current-user restricted-token candidate because
real `cmd.exe` and launcher children could not initialize reliably. It selected AppContainer because
the same runner proved default denial, admitted-root access, network denial, and atomic Job
membership without elevation.

The selected first slice uses a fresh request-derived AppContainer SID, per-launch ACL grants
recorded in a durable one-shot ledger, and an AppContainer token with no network capabilities.
Stale grants are reconciled before the next launch, but their identities are never reused. It does
not claim resistance to an administrator, a compromised same-user
host process, arbitrary power loss, or every adversarial path form listed in section 10.

## 2. Research basis

The design was checked against primary sources on 2026-08-13. Repository observations are pinned
to the reviewed commits so later upstream changes cannot silently rewrite this rationale.

This is a representative, not exhaustive, survey. Projects were selected because they either ship
an agent-oriented native Windows sandbox (Codex and Gemini CLI), define a mature Windows process
sandbox (Chromium), or document a widely used agent's Windows isolation boundary (Claude Code and
OpenCode). Projects without a public implementation or an explicit Windows contract are not treated
as evidence. W0 must repeat the comparison if a materially stronger maintained implementation is
identified before the architecture freezes.

| Source | Reviewed evidence | What Maka takes from it | What Maka does not assume |
| --- | --- | --- | --- |
| Microsoft Windows APIs | AppContainer isolation, restricted tokens, process attribute lists, Job Objects, Windows Sandbox, WSL2 | Kernel primitives and their documented boundaries | An API existing is not capability proof |
| OpenAI Codex `902bd9e06b3e` | `windows-sandbox-rs`, setup, ACL state, private desktop, restricted token, Job Object, firewall/WFP, smoke tests | Closest agent-specific reference: dedicated offline/online identities, persistent state reconciliation, explicit handle/job assignment, fail-closed policy checks | Direct source reuse, full contract equivalence, or correctness of unreviewed code |
| Gemini CLI `1ac337739586` | `WindowsSandboxManager.ts`, `GeminiSandbox.cs`, sandbox docs | Environment scrubbing, restricted-token launch, suspended Job assignment, explicit documentation of persistent low-integrity labels | Its network throttle or best-effort ACL behavior is sufficient for Maka |
| Chromium `024a2d21125b` | Windows broker/target design, restricted token, Job, alternate desktop, integrity levels, mitigations, AppContainer support | Layered defense, explicit broker boundary, private desktop, handle allowlist, process mitigations | Browser renderer policy can be copied unchanged to arbitrary developer tools |
| Claude Code public docs and `992381936817` examples | filesystem/network sandbox contract, proxy controls, escalation flow; Windows uses WSL2 | Separate filesystem and network guarantees; never infer native support from a generic sandbox setting | Closed-source implementation details |
| OpenCode `cc4b45612974` | official Windows documentation recommends WSL | WSL is a viable explicit external environment | WSL provides Maka's native Windows backend |

Codex, Gemini, and Chromium materially informed the layered broker, Job, ACL recovery, and
fail-closed contracts. Maka did not copy their product protocols. Executable evidence overruled the
initial dedicated-account recommendation: AppContainer is the selected identity for the first
native backend, while the dedicated restricted-token candidate remains documented negative evidence.

## 3. Decision

Maka packages a small native Rust broker/client. Runtime Host compiles `PermissionProfile` into a
closed launch manifest and invokes a one-shot broker lifecycle. The trusted native process binds the
request to its kernel-reported pipe client PID, a single-use nonce, and a SHA-256 digest of the exact
launch policy, then launches the target with layered Windows controls:

- an AppContainer primary token with no network capabilities;
- a Job Object attached atomically through `PROC_THREAD_ATTRIBUTE_JOB_LIST` and configured to kill
  the tree on close;
- handle inheritance disabled;
- AppContainer ACEs for only the compiled read/write roots, with a persisted recovery ledger;
- recursive reparse-point rejection before ACL mutation;
- a closed, sorted environment from the normalized command;
- bounded local named-pipe framing protected to SYSTEM and the current user.

The packaged x64 backend is registered only when the native resource exists. Missing binaries,
invalid paths, unsupported profiles, malformed manifests, failed ACL recovery, or launch failures
remain typed fail-closed outcomes; there is no unsandboxed retry. The same backend is available to
the filesystem worker and Agent command execution through the existing `SandboxManager` path.

Windows Sandbox and WSL2 may later be exposed as explicit external profiles. They are not substitutes
for the native per-command backend. AppContainer alone is insufficient; the Job, ACL policy,
recovery ledger, broker authorization, and fail-closed Runtime integration are part of the boundary.

## 4. Existing Maka contract

The platform-neutral authorities remain `PermissionProfile` and the active session
`ExecutionBoundary`. Windows consumes the same normalized command and path context as macOS Seatbelt
and Linux bubblewrap; it must not introduce a second permission language.

- `SandboxManager` selects a backend and transforms a command; it never retries unsandboxed.
- The caller owns canonical cwd, workspace roots, runtime roots, and boundary expansion approval.
- The backend owns profile compilation, enforceability checks, and a typed launch request.
- The process runner owns launch, cancellation, output collection, and lifecycle settlement.
- Runtime Host owns composition and refuses managed I/O when the backend is unavailable.

Windows cannot be represented honestly as an argv wrapper. Token creation, logon identity selection,
handle filtering, private desktop selection, and atomic Job assignment require a typed native launch
request in `SandboxExecRequest`.

## 5. Threat model

The attacker controls command arguments, scripts, child processes, filesystem contents inside
approved roots, and data parsed by sandboxed helpers. Protected assets include:

- files outside approved roots and protected metadata inside writable roots;
- host credentials, environment secrets, registry data, DPAPI material, and user profiles;
- host network access, loopback services, SMB/UNC channels, and inherited sockets;
- processes, windows, handles, devices, and IPC objects outside the sandbox boundary;
- Maka's sandbox setup records, ACL ownership ledger, executable, and broker protocol.

The Windows kernel, signed Maka binaries, Runtime Host, and the parent user session are trusted. The
boundary does not defend against an administrator, kernel compromise, or an already-compromised
same-user process outside Maka. Sandboxed code is treated as malicious after its first instruction.

Paths are hostile. Reparse points, junctions, symlinks, hard links, alternate data streams, device
paths, UNC paths, case aliases, 8.3 names, mount points, and replacement races must not widen access.
Lexical prefix checks are never authorization evidence.

## 6. Required guarantees

### 6.1 Filesystem

- Default deny: no read or write outside roots admitted by the exact profile.
- Read and write grants remain distinct.
- `.git`, `.agents`, and `.codex` deny-write applies at every nested occurrence unless an exact
  platform-neutral grant overrides it.
- Runtime and executable roots are minimal and read-only.
- Per-invocation temporary storage is removed only after the process tree drains.
- NTFS/ReFS are capability-probed; filesystems that cannot enforce the required descriptors fail
  closed. FAT-family volumes are not supported for restricted profiles.
- Maka-owned ACL changes are attributed to a unique per-launch principal, record their actual
  recursive/exact grant mode in a versioned state file, and are reconciled at startup.
- Setup, upgrade, uninstall, or a changed profile cannot leave an unknown usable grant. Corrupt or
  missing ownership state fails readiness rather than guessing which ACE is safe to remove.
- Canonical target and lexical alias are both considered when a reparse point exists.

### 6.2 Network

- `network.restricted` cannot create outbound or inbound network channels.
- Denial covers TCP, UDP, DNS, loopback, listeners, SMB/UNC, and inherited sockets.
- Named pipes are denied by default. The packaged one-shot path performs authorization in-process;
  the standalone experimental broker pipe has a DACL that admits only the
  selected sandbox principal and broker.
- If Windows reports that local firewall policy is ineffective, partially applied, or overridden by
  group policy, the offline backend is unavailable.
- Future domain allowlists must use a Maka-owned proxy; they must not compile DNS answers into a
  durable direct-address allowlist.

### 6.3 Process, desktop, handles, and environment

- The child is placed in the Job Object through `PROC_THREAD_ATTRIBUTE_JOB_LIST` at creation time;
  there is no runnable pre-assignment window.
- The Job kills all descendants when its owner closes and does not permit breakaway.
- Only declared stdio/protocol handles are inherited through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
- Non-interactive workers use a private desktop and cannot read the clipboard, broadcast window
  messages, install global hooks, or interact with the user's desktop.
- The token removes privileges and uses restricting SIDs; low integrity is defense in depth, not the
  filesystem policy by itself.
- The child receives an allowlisted environment. Credentials, tokens, proxy variables, shell startup
  hooks, user-specific executable search paths, and loader injection variables are not inherited.
- Elevation, service creation, scheduled tasks, COM activation outside an explicit allowlist, shell
  association launch, debugger attach, and parent-token/process-handle access are denied.
- Supported process mitigations are selected explicitly and compatibility-tested with Node,
  PowerShell, cmd, Git, and packaged Electron resources before W2.

### 6.4 Capability and failure

- Readiness launches a real probe under the production identity, token, Job, desktop, handles,
  filesystem policy, and offline network policy. OS version checks alone are insufficient.
- Launcher signature, version, and digest are verified against packaged metadata.
- Missing setup, identity drift, ACL-state corruption, ineffective network policy, unsupported
  filesystem, helper mismatch, or a failed probe returns a stable typed unavailable reason.
- `auto` and `require` never fall back to host execution for a restricted managed profile.
- Diagnostics expose the backend, setup version, and failure stage without paths, SIDs, credentials,
  environment values, or firewall details.

## 7. Selected architecture

```mermaid
sequenceDiagram
  participant H as Runtime Host
  participant M as SandboxManager
  participant B as one-shot native broker
  participant J as Job Object
  participant C as AppContainer worker

  H->>M: transform(profile, canonical path context)
  M->>M: compile roots, environment, and network policy
  M-->>H: native path + one-shot manifest
  H->>B: --broker-local manifest
  B->>B: delete manifest; bind PID, nonce, and launch digest
  B->>B: recover ledger; reject reparse trees; grant SID ACEs
  B->>J: create kill-on-close Job
  B->>C: create AppContainer process with atomic Job attribute
  C-->>B: bounded exit result
  B->>B: remove owned ACEs and completed ledger
  B-->>H: exit code or fail-closed error
```

### 7.1 Setup and durable state

The first implementation needs no elevated setup. Windows creates a request-derived Maka
AppContainer profile, and the packaged native binary grants its unique SID only the roots admitted
for the current launch. Before mutation it recursively rejects `FILE_ATTRIBUTE_REPARSE_POINT`, persists a
versioned ledger with `create_new` and `sync_all`, and reconciles every stale ledger before accepting
a new request. A global kernel mutex covers only ledger/ACL mutation; each launch holds a separate
request-specific kernel lease through child settlement, so recovery skips live ledgers while disjoint
launches execute concurrently. Normal settlement removes the SID ACE and then deletes the ledger.

The ledger filename is a SHA-256 of the request identity, so request-controlled path characters
cannot escape its directory. `icacls.exe` is resolved from absolute `%SystemRoot%\System32`, invoked
without a shell, and uses `/L` so link objects are operated on rather than followed. The Windows CI
smoke proves normal cleanup, stale-ledger recovery, and rejection of a junction in an admitted tree.
Crash/power-loss and concurrent replacement hardening remain release evidence, not assumptions.

### 7.2 Broker and protocol

The native component is not a resident privileged service. The packaged `--broker-local` path
consumes and deletes one manifest, binds it to its kernel process PID, authorizes it in-process, and
exits after the AppContainer process settles and ACLs are restored. The standalone named-pipe modes
remain transport evidence and are not traversed by the packaged path.

Authorization recomputes the digest
from the complete canonical launch object, so changing executable, arguments, cwd, roots, network,
or environment invalidates approval. Unknown fields, versions, outcomes, or oversized frames fail
closed. The authorized path can call only the AppContainer atomic launcher.

## 8. Alternatives and project comparison

| Option | Evidence | Decision |
| --- | --- | --- |
| Dedicated sandbox identities + restricted token + Job + private desktop + ACL ledger + WFP/firewall | Codex demonstrates this agent-oriented shape, including setup and adversarial tests | Reference for future stronger tiers; runner evidence showed the Maka candidate could not reliably initialize real children |
| AppContainer + atomic Job + one-shot broker + ACL ledger | Microsoft and Chromium document the primitives; Maka Windows 2025 CI proves the composed boundary | Selected for the native backend |
| Current-user restricted token + Job | Useful process hardening | Rejected: existing user ACLs remain readable and the prototype did not initialize reliably |
| Low integrity ACL + Job | Gemini implements this lightweight path | Rejected for Maka's strong tier: persistent labels, best-effort ACL failures, and network throttling do not meet fail-closed policy |
| Chromium sandbox library | Mature broker/target, hooks, mitigations, AppContainer support | Reference only: large C++ integration and renderer assumptions do not match one-shot arbitrary tools |
| Windows Sandbox | Strong VM boundary | Future external profile: optional feature and coarse per-command lifecycle |
| WSL2 | Used/recommended by Claude Code and OpenCode for Windows workflows | Future external profile; not native Windows semantics |
| Docker/Hyper-V container | Stronger environment boundary when available | Optional external profile, not a universal native prerequisite |

## 9. Delivery plan and gates

### W0: feasibility and frozen implementation spec

- [x] build a Maka-owned Rust launcher with reproducible MSVC CI;
- [x] compare restricted-token and AppContainer identities with real child evidence;
- [x] prove atomic Job assignment, no inherited handles, and live loopback denial;
- [x] define closed broker, launch, and ACL-ledger schemas;
- [x] select the AppContainer implementation and document the rejected candidate;
- [x] update this RFC with the selected sequence and failure boundary.

### W1: managed read-only filesystem worker

- [x] compile admitted roots and runtime/executable roots from `PermissionProfile`;
- [x] deny ambient filesystem and network access under AppContainer;
- [x] compose capability detection into Runtime Host managed execution;
- [x] package and verify the x64 native resource;
- [x] fail closed when the resource or capability is unavailable;
- [ ] finish cancellation, parent-death, concurrency, and residual-state release tests.

This is the first user-visible sandbox milestone. Remaining unchecked evidence limits the support
claim; it does not permit an unsandboxed fallback.

### W2: workspace-write and general commands

- enforce write roots and nested protected metadata;
- support exact executable discovery without ambient PATH/startup scripts;
- prove PowerShell, cmd, Git, native executables, ConPTY, and descendants;
- integrate setup, upgrade, rollback, uninstall, and signed packaging;
- preserve path-free run-trace enforcement evidence.

### W3: adversarial review and support declaration

- run the release-blocking matrix on all supported Windows versions/filesystems;
- complete independent security review and resolve every high/critical finding;
- document unsupported environments and recovery;
- only then mark Phase 4 complete or advertise restricted profiles as supported.

## 10. Required release evidence

The Windows sandbox job must execute positive and negative child-process tests for:

- allowed-root read/write and denied outside/read-only/protected-metadata access;
- junction, symlink, mount point, hard link, 8.3 alias, case alias, ADS, UNC, device-path, and
  replacement-race escape;
- TCP/UDP/DNS/loopback/listener/SMB/named-pipe/inherited-socket escape;
- child/grandchild, detached process, breakaway, shell association, COM, scheduled task, and service;
- environment, registry, credential store, DPAPI, parent process/token, clipboard, and user profile;
- normal exit, timeout, cancellation, launcher crash, Runtime Host crash, desktop crash, and reboot;
- concurrent sandboxes with disjoint identities and roots;
- every durable setup, ACL, firewall/WFP, and marker publication failpoint;
- installer/upgrade/uninstall verification of the exact signed launcher and complete state cleanup.

Generated flags and unit tests are necessary but are not security evidence. A passing test must show
that the denied operation fails in a real child and that no process or unknown durable authorization
remains.

## 11. Estimate and completion criteria

For one experienced engineer, after RFC review:

- W0: 1-2 weeks;
- W1: 2-3 weeks;
- W2: 3-5 weeks;
- W3 and remediation: 1-2 weeks.

The realistic Phase 4 range is 7-12 weeks, not including external review scheduling. Two engineers
can overlap native setup/launcher work with Runtime integration and test harnesses, but the security
review and architecture gates remain sequential. The read-only W1 milestone can land in roughly
3-5 weeks if W0 confirms the Codex-shaped approach and packaging toolchain.

Phase 4 is complete only when W0-W3 evidence is release-blocking, setup and uninstall recover cleanly,
restricted profiles never silently degrade, and the security review has no unresolved high or
critical findings.

## 12. Primary references

- [Microsoft AppContainer isolation](https://learn.microsoft.com/windows/win32/secauthz/appcontainer-isolation)
- [Microsoft UpdateProcThreadAttribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft SetInformationJobObject](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject)
- [Microsoft CreateRestrictedToken](https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
- [OpenAI Codex Windows sandbox crate](https://github.com/openai/codex/tree/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/windows-sandbox-rs)
- [Gemini CLI Windows sandbox](https://github.com/google-gemini/gemini-cli/tree/1ac3377395868295e128b96726d605a900b5946b/packages/core/src/sandbox/windows)
- [Chromium sandbox design](https://github.com/chromium/chromium/blob/024a2d21125b57ffbb41f6e635294966b0d5eba4/docs/design/sandbox.md)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [OpenCode Windows/WSL guidance](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/web/src/content/docs/windows-wsl.mdx)
