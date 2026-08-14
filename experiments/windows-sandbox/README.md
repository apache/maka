# Windows sandbox W0 spike

This directory contains evidence tooling for the W0 feasibility phase described
by the Windows sandbox RFC. It is deliberately not connected to
`SandboxManager`, packaging, or any user-visible restricted profile.

The first slice freezes the launcher request/result shapes and provides an
untrusted Node probe that both candidate launchers must execute. The dedicated
identity and AppContainer prototypes must produce results against the same
manifest; a launcher that merely starts a process is not sufficient evidence.

Run the contract checks on Windows:

```powershell
node --test experiments/windows-sandbox/protocol.test.mjs
node experiments/windows-sandbox/probe.mjs --manifest path\to\manifest.json
```

The probe exits non-zero when an observation differs from its expectation. Its
JSON report is evidence input, not a claim that the current process is
sandboxed.

`launcher/` is the first process-containment prototype. It currently probes a
restricted primary token, suspended process creation, post-create Job
assignment, kill-on-close descendants, and no inherited handles. The post-create
assignment is explicitly not the atomic Job guarantee; the W0 privileged-broker
prototype must still prove `PROC_THREAD_ATTRIBUTE_JOB_LIST`. It intentionally
rejects restricted-network and filesystem-root requests until the identity, ACL,
and network prototypes exist.

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

`launcher --broker-serve-once <pipe> <account-sid> <profile-digest>` exposes one
bounded local request over a protected named pipe. The pipe rejects remote
clients, grants access only to SYSTEM and the supplied user SID, obtains the
client PID from the kernel, enforces nonce replay and profile-digest checks,
and calls only the atomic launch path. A runner without broker privileges
receives `atomic_launch_failed`; the broker never falls back to post-create Job
assignment.

`launcher --atomic <request.json>` is the privileged-broker launch candidate.
It passes the Job handle through `PROC_THREAD_ATTRIBUTE_JOB_LIST` to
`CreateProcessAsUserW`, so successful process creation and Job membership are
one operation. The launcher verifies the restricted token and Job membership
before reporting `atomicJob:true`. The atomic candidate never falls back to the
post-create assignment path. `atomic-launch-smoke.ps1` requires complete proof
when the runner has both broker privileges and otherwise requires an explicit
non-zero, fail-closed outcome.

`launcher --appcontainer <request.json>` is the isolated-identity candidate. It
combines an AppContainer token with the same atomic Job attribute and supplies
no network capabilities. The smoke proves the identity and process boundary,
denial of a user-readable file outside the container, and denial of a live
loopback endpoint. Requests containing filesystem roots still fail closed until
the ACL grant/restore ledger is implemented.
