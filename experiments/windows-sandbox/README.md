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

`launcher/` is the first process-containment prototype. It currently proves a
restricted primary token, suspended process creation, Job assignment before
resume, kill-on-close descendants, and no inherited handles. It intentionally
rejects restricted-network and filesystem-root requests until the identity,
ACL, and network prototypes exist.
