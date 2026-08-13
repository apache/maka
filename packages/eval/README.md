# @maka/eval

`@maka/eval` owns experiment semantics. It does not execute Maka or construct Runtime objects.

```text
Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

An Experiment combines one benchmark, one executor, all subjects, all tasks, a repetition count, one shared budget, one verifier, and a frozen task-group concurrency limit. Cells are the Cartesian product `task × repetition × subject`. All subject arms in one task repetition start together; independent task groups run up to the declared limit. A repetition is a new experimental sample; an infrastructure retry appends a replacement attempt to the same cell; continuation remains internal to Runtime Host. Each subject declares only the credential environment names its cells receive.

Run a fully expanded spec through the public CLI:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

The built-in Harbor and Pier executors use one relay Agent. The framework prepares the task environment, the relay invokes exactly one Eval subject from `Agent.run()`, and the framework runs its native verifier and finalizer. Harbor and Pier use separate, explicitly versioned Python environments because their Agent and task contracts differ.

Maka subjects ask the Runtime Host client to run one owned execution in a dedicated Host root. Session, Turn, Goal and continuation semantics remain inside Runtime Host. External subjects declare a command and arguments, and may add non-secret environment values, target-to-source bindings for declared credentials, and an explicit result contract. Omitted credential bindings use declared names unchanged. The generic `exit-code` contract discards unstructured stdout and records null usage and cost. The structured `protocol-v1` contract is restricted to the bundled external wrapper so the shared relay can separate a bounded result frame from Harbor/Pier's merged process output; cohort-specific wrappers do not gain Runtime authority.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.

The checked-in Terminal-Bench 2.1 four-arm cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json`. It freezes provider endpoints, framework version, container paths and read-only mount policy. Set each declared machine-path environment variable to its trusted prepared directory, and set the declared API-key credentials. Machine-local paths select artifacts; they do not alter experiment semantics and are not presented as a cryptographic identity scheme.

Maka benchmark subjects freeze a versioned Session profile. `headless-coding-v1` is persisted in
the Session header, so later turns and backend rebuilds retain the same contract. It fixes the
system prompt, disables product identity/personalization/skills/workspace-memory prompt fragments,
admits only `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, and `apply_patch` as tool candidates,
and exposes a foreground-only Bash schema without `run_in_background` or `pty`. Provider-specific
routing remains authoritative: DeepSeek Responses exposes `apply_patch` instead of `Write` and
`Edit`, and Runtime-owned `ArchiveRead` remains available for archived tool results. A real
`hosted.execution.start` regression test pins SHA-256 hashes for the first main provider request's
developer prompt and complete tool schema.

Every benchmark subject removes `WebSearch`, `WebFetch`, and `FetchURL` from the provider-visible
tool list. Maka enforces that through its Hosted Execution profile; external harnesses pass through
the Eval metering proxy, which structurally removes named and provider-native web tools from JSON
requests. Shell networking remains enabled. The configured HTTPS egress proxy blocks only
benchmark and public-solution contamination URLs, including normalized or recursively wrapped
`terminal-bench` references, pinned benchmark revisions, task registries, benchmark repositories,
public trajectories, and known patch mirrors. The checked-in Compose overlay gives every cell its
own MITM proxy, CA, bounded audit log, and health gate. During `Agent.run()`, Harbor's Docker egress
sidecar applies an nftables allowlist containing only that proxy service; direct subject egress is
therefore rejected even when a command unsets proxy variables or requests `--noproxy`. Harbor task
download and verifier phases retain their native network policy. Build the pinned
`maka-eval-egress-proxy:12.2.3` image from `harbor/egress-proxy/Dockerfile` before running the
cohort. This URL policy is a blocklist for known benchmark and public-solution contamination
surfaces, not a complete defense against a deliberately invented lookup channel; the network
namespace still forces all subject traffic through the audited proxy. Collected Maka runtime files
and egress audit logs are represented in attempt artifacts with byte counts and SHA-256 digests.
The local image tag remains a machine deployment identity rather than a registry digest; digest
pinning is tracked in issue #2953.

The experiment directory contains the frozen `experiment.json` and append-only attempt records. There is no second mutable results file. A leftover `.writer.lock` means the previous writer did not complete; remove it only after proving that no writer process remains.
