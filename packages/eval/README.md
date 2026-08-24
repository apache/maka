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

Before starting a trial, the public CLI validates the selected executor's machine paths, bundled relay files, pinned Harbor or Pier Python distribution, and Docker daemon availability for Docker environments. A missing or mismatched prerequisite is reported with the configured environment-variable name and expected framework version; the CLI does not start a trial or install external software. Subject-specific toolchain verification remains part of subject preparation and also completes before any trial starts.

The built-in Harbor and Pier executors use one relay Agent. The framework prepares the task environment, the relay invokes exactly one Eval subject from `Agent.run()`, and the framework runs its native verifier and finalizer. Harbor and Pier use separate, explicitly versioned Python environments because their Agent and task contracts differ.

Maka subjects ask the Runtime Host client to run one owned execution in a dedicated Host root. Session, Turn, Goal and continuation semantics remain inside Runtime Host. External subjects declare a command and arguments, and may add non-secret environment values, target-to-source bindings for declared credentials, and an explicit result contract. Omitted credential bindings use declared names unchanged. The generic `exit-code` contract discards unstructured stdout and records null usage and cost. The structured `protocol-v1` contract is restricted to the bundled external wrapper so the shared relay can separate a bounded result frame from Harbor/Pier's merged process output; cohort-specific wrappers do not gain Runtime authority.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.

The checked-in Terminal-Bench 2.1 four-arm cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json`. It freezes provider endpoints, framework version, container paths and read-only mount policy. Set each declared machine-path environment variable to its trusted prepared directory, and set the declared API-key credentials. Machine-local paths select artifacts; they do not alter experiment semantics and are not presented as a cryptographic identity scheme.

The single-arm DeepSeek Harness cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-deepseek-harness.json`. The harness ships no benchmark runner: its `BENCHMARK.md` names the checked-in `examples/jsonrpc-agent` minimal composition and asks for one workspace and session id per task. `harbor/deepseek-harness-profile/` is that composition, carried as a complete harness profile whose manifest declares no bundles. Because the tree is composed over an empty entry list, every entry the model can observe is named in one file, an upstream bundle gaining a plugin cannot widen this arm's tool surface, and a missing service is a boot failure rather than a silent downgrade. The composition was validated against upstream request-for-request: identical tool names, byte-identical tool schemas, byte-identical system prompt, identical message sequence. The one deviation, recorded in the file, is that reasoning is pinned to max because the adapter default resolves to `reasoning_effort=high` on the wire.

Build that arm's toolchain with `node scripts/prepare-deepseek-harness-toolchain.mjs --out <dir> --write`. It runs inside a pinned `linux/amd64` container because the composition depends on `node-pty`, which publishes no Linux prebuild, and it copies that container's Node into the toolchain so the executed path resolves inside the mounted root. Dependencies are installed with `npm ci` from the reviewed lockfile in `harbor/deepseek-harness-toolchain/`, so a harness version does not silently mean two different trees. The recorded fingerprint is the digest of `checksums.sha256`, which lists every regular file the build put in the tree, and verification recomputes that digest from the manifest on disk rather than reading the value the tree reports for itself. The constant in `src/toolchain-verification.ts` therefore pins the manifest, and the manifest pins the content of every file it names. It does not pin the tree's closure: verification walks the manifest rather than the directory, so a file added to a mounted toolchain afterwards is neither named nor refused. That is the existing behaviour of `verifyToolchainDirectory` for all eight arms and belongs to it. Native modules are compiled during the build and need not come out byte-identical on another machine, so a rebuild can still produce a new fingerprint; `--write` re-pins it and verification fails closed until the two agree. `--out` is rebuilt from scratch: it must name a directory, and one that is either empty or a previous build of this toolchain.

`experiments/terminal-bench-2.1-deepseek-v4-flash-maka-vs-deepseek-harness.json` runs Maka and the harness arm in one task group, so each task starts one container of each at the same moment rather than comparing two runs on two occasions. Two properties of that spec do not follow from the framework and belong to whoever reads its results.

Pairing is not preserved. Task groups are an execution unit: cells are grouped by `task × repetition` to schedule concurrency, but result selection is per cell, and a cell with no selectable attempt is dropped from the result map on its own. Losing one arm therefore leaves the other arm's observation in the data as an unmatched sample rather than removing the pair. Loss is also not random — an attempt is likelier to be lost the longer its container lives and the more requests it makes — so an unmatched observation is systematically biased toward the arm that finished sooner. Comparing the two arms means re-pairing by `task.id` and discarding unmatched observations, not averaging each arm's surviving cells.

Both arms meet the same policy: `egressProxy` is executor configuration, subjects cannot override it, and no subject in that spec declares one. What that proves is bounded in two ways. The URL policy is a blocklist for known contamination surfaces, so it addresses a subject that stumbles onto an answers page and not one deliberately looking for one; issues #2976 and #2977 describe channels that remain outside the audited path. And an equal policy is equal opportunity, not equal use — whether an arm reaches a residual channel depends on how that arm behaves, which is precisely this experiment's independent variable. Because those channels are by definition unaudited, a difference in use between the arms would not appear in the evidence either way.

Single-arm results are not drawn from the same run as the multi-arm cohort. Task groups hold every subject for one task, so each arm adds a container: the eight-arm cohort reaches 128 concurrent trials at its declared limit, and this spec raises its own limit so its 89 cells run under comparable machine load. They remain separate runs on separate occasions, which no setting can change.

External provider metering does not depend on the subject exiting cleanly. The wrapper's proxy writes
`agent/<profile>.provider-usage.json` at the start of every request, at its settlement, and at the
moment the provider states admission, chmodding the temporary file to `0644` and then renaming it
into place so a reader sees one whole snapshot or the previous one, already readable. Recovery
reads at most 64 KiB and only from a regular file, and accepts the snapshot only when its HMAC
matches the host-issued relay result token. A subject that replaces the path with a symlink, a
large write, or schema-valid forged JSON cannot feed the host. Admission is recorded when it is observed rather than when the request finishes,
because the model work has been done and billed whether or not this process survives to see the
stream end. When the result frame is missing — the wrapper was killed rather than asked to stop —
the executor recovers usage from that file. A run that was cut off after admitted model work is
therefore scored as a failed subject rather than retried as infrastructure.

That last rule reads the evidence, not the symptom, so it applies where the evidence supports it and
not elsewhere. A subject whose execution returned — the relay observed it exit, and only its result
frame is missing — did stop on its own terms, so admitted model work makes that a recorded failure
rather than a cell to run again at the same cost. A subject whose execution call *threw* is a
different claim: the relay, the executor or the host process failed, and it may never have started.
There, admitted work is still recorded and attributed, but it does not turn an infrastructure
failure into a zero.

The checkpoint carries only what the proxy observed: usage, whether the proxy had settled, and the
request, in-flight, admitted, and usage-request counts. Settlement is there because no arrangement of
the counts implies it — a checkpoint written between two requests has nothing in flight either — and
a stale file that claimed to be complete would report a fraction of a run's cost as a settled figure.
Whether the figure is complete, how many admitted requests are missing usage, and what the run cost
are worked out from those raw facts by one function both sides call, so the two processes cannot hold
two versions of a value neither of them owns. Cost is reported only for a
complete figure; a partial token count is kept as a lower bound, because a cost derived from it would
enter the result kernel indistinguishable from a settled one.

The wrapper's process exit code projects its semantic status: zero only when the subject completed.
The executor prefers the result frame wherever the frame is readable, and falls back to the exit code
only for a frame that carries no status of its own. Nothing else decides anything from it, but the
two must not be able to say different things.

A subject that exhausts the framework timeout is reported as `subject_failed` with its verifier reward intact. The reward is the outcome; the status records that the run was cut off rather than finishing on its own. Only a missing reward is an infrastructure failure.

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
private and publishes only `mitmproxy-ca-cert.pem` and `proxy-ipv4` into the certificate-only volume the subject
mounts read-only, so the CA private key and the audit log never enter the subject namespace. During
`Agent.run()`, Harbor's Docker egress sidecar applies an nftables allowlist containing only that
proxy service; direct subject egress is therefore rejected even when a command unsets proxy
variables or requests `--noproxy`. The namespace policy accepts TCP to that proxy and traffic to
namespace-local addresses, and rejects everything else, ICMP included. Rejecting rather than
redirecting the remainder also closes a connection the subject inherits from an earlier phase: the
redirect is a NAT rule, and NAT is evaluated only on a connection's first packet. The
namespace-local exemption keeps the loopback provider proxies reachable. Docker's
embedded resolver at `127.0.0.11` is refused, because it forwards names it does
not own to the host's upstream resolvers. The engine DNATs `:53` onto another
local port before the filter hook, so the rule matches the address rather than
only that port. The proxy publishes its IPv4 into the
certificate volume; the relay pins `maka-eval-mitmproxy` in `/etc/hosts` before the
subject starts, so `HTTPS_PROXY` still resolves after DNS is closed. The policy exempts no
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
a Docker daemon and outbound network, and skips otherwise. Official CI does not set that
variable: the live cell needs a kernel that can load the checked-in `table inet` ruleset
(`NFT_FIB_INET`), which Docker Desktop and the default runners do not provide. The rule
text — including that `127.0.0.11` is rejected before `fib daddr type local accept` — is
locked by `lifecycle-boundaries.test.ts` and the Harbor contract tests. This URL policy is a blocklist for known
benchmark and public-solution contamination surfaces, not a complete defense against a deliberately
invented lookup channel. It classifies HTTP(S) requests and `CONNECT` hosts against the blocklist, and
kills tunnels that fall back to raw TCP. Collected Maka runtime files
and egress audit logs are represented in attempt artifacts with byte counts and SHA-256 digests.

What the verifier scores is the environment the task was left in, so a subject that exits on its own
keeps whatever it started, whatever it reported. The relay does not tear the subject's process group
down at that point: nothing is waiting on those processes — the execution call has already returned —
so the teardown would not unblock anything, and it would edit the thing about to be measured for the
subjects Eval classifies as failed and not for the others. Cancellation and framework timeout still
quiesce, because there the subject has not stopped and the trial is being abandoned rather than
scored. The same rule binds the agent frameworks: the DeepSeek Harness owns a persistent PTY tree and
kills every descendant on shutdown, so the Eval-patched DSH subprocess skips that kill under
`DSH_PRESERVE_BACKGROUND_PROCESSES`, which Eval always sets.

A process group is not a reliable handle on a subject's processes in any case. `forkpty` makes the
shell a session leader, and an interactive shell puts each background job in a group of its own, so a
service started through a PTY is two removes from the group the relay records — measured, not
assumed. Any rule that depended on signalling that group would hold for some agent frameworks and
silently not for others.

The DeepSeek Harness Eval profile also extends its persistent Bash deadline beyond Terminal-Bench's
longest native subject timeout, so the benchmark remains the authoritative deadline and a local
five-minute tool timeout cannot interrupt `apt` or `dpkg` before verification. Every subject runs
with `DEBIAN_FRONTEND=noninteractive` and `TZ=Etc/UTC` in its execution environment, because an
interactive package prompt in an unattended container is indistinguishable from a hung command, and
that is a property of the container rather than of any one arm.

The local image tag remains a machine deployment identity rather than a registry digest; digest
pinning is tracked in issue #2953.

The experiment directory contains the frozen `experiment.json` and append-only attempt records. There is no second mutable results file. A leftover `.writer.lock` means the previous writer did not complete; remove it only after proving that no writer process remains.
