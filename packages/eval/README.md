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
public trajectories, and known patch mirrors. The general `terminal-bench` match searches the host
and the path separately, so a contamination surface named only in the hostname is blocked too, and
no rule can match across the boundary between the two fields. Only Harbor applies
the namespace policy, so a pier executor spec that declares `egressProxy` is rejected when it is
decoded rather than running with the proxy set up and enforcement absent. The checked-in Compose
overlay gives every cell its own MITM proxy, CA, bounded audit log, and health gate. The proxy keeps its confdir and audit log
private and publishes only `mitmproxy-ca-cert.pem` into the certificate-only volume the subject
mounts read-only, so the CA private key and the audit log never enter the subject namespace. During
`Agent.run()`, Harbor's Docker egress sidecar applies an nftables allowlist containing only that
proxy service; direct subject egress is therefore rejected even when a command unsets proxy
variables or requests `--noproxy`. The namespace policy accepts TCP to that proxy and traffic to
namespace-local addresses, and rejects everything else, ICMP included. Rejecting rather than
redirecting the remainder also closes a connection the subject inherits from an earlier phase: the
redirect is a NAT rule, and NAT is evaluated only on a connection's first packet. The
namespace-local exemption keeps the loopback provider proxies reachable and, with them, Docker's
embedded resolver at `127.0.0.11`, which forwards names it does not own to the host's upstream
resolvers. That is an unaudited channel out of the cell and back, tracked in issue #2976; until it is
closed the audited proxy is the only path for everything except DNS. The policy exempts no
packet mark: the
sidecar shares the subject's network namespace, so a mark the sidecar can set is one the subject can
set too, and gost forwards nothing in this mode anyway. Because that shared namespace also means the
policy only constrains what the IP output hooks can see, the overlay drops `NET_RAW`, which would
otherwise grant an `AF_PACKET` socket that writes beneath them; a task's own Compose can add that
capability back, and a `cap_add` wins over an overlay's `cap_drop`, so once the policy is live the
relay reads every capability set the subject could raise or reacquire one from, the bounding set
included, and refuses to start the subject when any of them carries `NET_RAW` or `NET_ADMIN`. Both
the drop and the gate cover the subject alone, not the namespace: a sibling service a task declares
joins the same namespace with the default capability set, so a task that declares one is less
isolated than a task that does not. The
same gate refuses when the subject is not in the namespace the policy was applied to: Harbor applies
the policy inside the sidecar but respects a task's own networking on the subject service, so a task
that declares it would otherwise leave the subject unpoliced. The evidence is the namespace identity
itself: the gate reads `/proc/self/ns/net` in the subject and in the service Harbor installs the
policy in, and requires the two to name one namespace. The gate reads that
evidence through the task image's own userland, so it establishes that a task did not lose the
isolation by accident, not that a task could not lie about it; a task image that lies already
controls everything else in the cell. What it does hold against is the subject, which starts only
after the gate has passed. Harbor task
download and verifier phases retain their native network policy. Build the pinned
`maka-eval-egress-proxy:12.2.3` image from `harbor/egress-proxy/Dockerfile` before running the
cohort. `MAKA_EVAL_EGRESS_NAMESPACE_TEST=1 python3 harbor/test_cell_egress_namespace.py` brings up
the overlay and the checked-in policy and asserts that contract in a real cell namespace; it needs
a Docker daemon and outbound network, and skips otherwise. This URL policy is a blocklist for known
benchmark and public-solution contamination surfaces, not a complete defense against a deliberately
invented lookup channel. It classifies what it can read: a `CONNECT` tunnel carrying something other
than TLS or HTTP reaches no rule and no audit record, which is tracked in issue #2977. Collected Maka runtime files
and egress audit logs are represented in attempt artifacts with byte counts and SHA-256 digests.
The local image tag remains a machine deployment identity rather than a registry digest; digest
pinning is tracked in issue #2953.

The experiment directory contains the frozen `experiment.json` and append-only attempt records. There is no second mutable results file. A leftover `.writer.lock` means the previous writer did not complete; remove it only after proving that no writer process remains.
