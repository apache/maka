---
name: aws-lambda-microvms
description: Builds, runs, debugs, and operates applications on AWS Lambda MicroVMs — Firecracker-isolated, snapshot-resumable serverless compute environments running inside a container with up to 8 hr lifetimes. Applicable when workloads need strong isolation between tenants, isolated serverless compute, sandbox compute, or secure multi-tenant execution. Also suited for AI/agent code-execution sandboxes, interactive code playgrounds and notebooks (Jupyter, REPLs, dev environments running user-supplied code), reinforcement-learning environments, multi-tenant CI executors and build runners, sessionful game or simulation servers, or isolated security scanners. Also applicable when the workload needs long-lived sessions, a real port-listening server (gRPC, WebSocket, custom TCP protocols), state preserved across periods of inactivity (suspend/resume), container-level access (FUSE, eBPF, custom syscalls), or session-affine routing.
version: 1
---

# AWS Lambda MicroVMs

> The AWS MCP server is recommended for sandboxed execution and audit logging.

AWS Lambda MicroVMs are serverless compute environments that combine Firecracker VM isolation with container-like efficiency. Each MicroVM:

- Runs your application as a **container inside a Firecracker microVM** — you can reproduce the environment locally.
- Runs Amazon Linux 2023 as the base OS inside the MicroVM.
- Boots from a **memory + disk snapshot** captured at image build time, so application init is skipped on run.
- Has a dedicated, TLS-terminated HTTPS endpoint reachable with an auth token.
- Can be **suspended and resumed** with state preserved; lives up to 8 hours.

**Two-resource model:**

- `MicrovmImage` — a versioned artifact built from `{S3 zip with Dockerfile} + baseImageArn`. Each version has per-architecture/chipset `Build`s.
- `Microvm` — a running instance created (`RunMicrovm`) from an image version.

**Two roles:**

- `buildRoleArn` — used during image build (S3 read, CloudWatch logs, optional ECR).
- `executionRoleArn` — assumed at runtime by the running MicroVM.

## When to use

### Choose Lambda MicroVMs when

- **Analytics workloads** — isolated compute for data processing, ETL jobs, or query execution with strong tenant separation.
- **AI / agent code execution sandboxes** — fresh, isolated environment per session, fast resume between turns.
- **Interactive code playgrounds & notebooks** — Jupyter, REPLs, dev environments executing user code.
- **Reinforcement-learning environments** — clean per-episode envs with tool access.
- **Multi-tenant CI executors / build runners** — strong tenant isolation.
- **Game / simulation servers** — sessionful, long-lived (up to 8 hr) workloads.
- **Security scanning** — running untrusted analyzers in isolation.

In general, Lambda MicroVMs are suited for long-lived sessions, real port-listening servers (gRPC, WebSocket, custom TCP protocols), state preserved across periods of inactivity (suspend/resume), container-level access (FUSE, eBPF, custom syscalls), or session-affine routing to a specific compute environment.

### Choose AWS Lambda (functions) when

- The workload fits in 15 minutes.
- Per-invocation isolation is fine; no need for session state held in memory.
- Fully automatic scaling is preferred (no `RunMicrovm` to manage).
- Event-source integrations (S3, SQS, EventBridge, etc.) drive the function.

### Choose something else when

- Continuous compute beyond 8 hr → ECS / EKS / EC2.
- Lift-and-shift workloads needing kernel modifications or a non-Linux OS → EC2.

## Typical workflow

0. **Check regional availability** — confirm Lambda MicroVMs is available in your target region (run `aws lambda-microvms list-managed-microvm-images`). Your S3 artifact bucket and any network connectors must be in the same region as the image.
1. **Package** an app: zip with a `Dockerfile` at the root, upload to S3 (same region as the image).
2. **Implement lifecycle hooks** (optional but recommended) — HTTP endpoints on a port you specify (commonly `9000`) for `/run`, `/resume`, `/suspend`, `/terminate`, `/ready`, `/validate`.
3. **CreateMicrovmImage** — pointing at the S3 artifact, a managed base image, and a build role. Lambda compiles the Dockerfile into an OCI image, starts your app, calls `/ready`, snapshots disk + memory, optionally validates with `/validate`. Lambda will periodically release new managed image versions, and customers should re-build using the latest version to ensure they have up to date images.
4. **RunMicrovm** — pick an image version, attach `executionRoleArn`, set `idlePolicy`, ingress/egress connectors, and (optionally) a `runHookPayload`. Receive an `endpoint` URL and `microvmId`.
5. **CreateMicrovmAuthToken** — get an auth token (max 60 min) with `allowedPorts` specifying which ports the token grants access to. Send traffic to the endpoint with `X-aws-proxy-auth: <token>`.
6. **Suspend / Resume / Terminate** — explicit APIs, or let the `idlePolicy` drive it (`maxIdleDurationSeconds`, `suspendedDurationSeconds`, `autoResumeEnabled`).

### Core CLI commands

```bash
# Create an image (zip with Dockerfile at root in S3, plus a managed base image)
aws lambda-microvms create-microvm-image \
  --name my-image \
  --base-image-arn arn:aws:lambda:<region>:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::<acct>:role/MicroVMBuildRole \
  --code-artifact '{"uri":"s3://<bucket>/<key>.zip"}'

# Run a MicroVM (returns endpoint + microvmId). --image-identifier takes the
# image ARN (the bare name is rejected); --image-version is the full major.minor string.
aws lambda-microvms run-microvm \
  --image-identifier arn:aws:lambda:<region>:<acct>:microvm-image:my-image \
  --image-version 1.0 \
  --execution-role-arn arn:aws:iam::<acct>:role/MicroVMExecutionRole \
  --idle-policy '{"maxIdleDurationSeconds":900,"suspendedDurationSeconds":300,"autoResumeEnabled":true}'

# Mint an auth token and call the endpoint
TOKEN=$(aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier microvm-... --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
curl "<endpoint>/" -H "X-aws-proxy-auth: $TOKEN"

# Lifecycle
aws lambda-microvms suspend-microvm   --microvm-identifier microvm-...
aws lambda-microvms resume-microvm    --microvm-identifier microvm-...
aws lambda-microvms terminate-microvm --microvm-identifier microvm-...
```

See [`references/getting-started.md`](references/getting-started.md) for the full walkthrough including `--hooks` config and lifecycle hooks.

## Hook configuration

Hooks are organized into two groups under the `--hooks` parameter:

### `microvmImageHooks` (build-time)

> **Recommendation:** Implement the image build hooks (`/ready` and `/validate`) for best performance. They enable the platform to capture a complete snapshot and prefetch the portions accessed at run time.

| Hook       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Timeout range         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `ready`    | Called during application boot. When this hook returns a 200 status code, it signals to the platform that the application is ready to be snapshotted. Use this to ensure your application is fully booted before a snapshot is taken. If your application is not yet ready, return a 503 status code until it is ready for snapshotting.                                                                                                                                                                                                                                                                                 | 1–3600s (default 30s) |
| `validate` | Called after running your application from the microVM snapshot. Use this hook to validate the application is ready to serve traffic. This hook additionally allows the platform to sample the portions of the snapshot that are used when your application is ran, allowing Lambda to prefetch those portions of the snapshot to reduce latency. To get the best performance, run mock payloads through the application during validate. When this hook returns a 200, it signals to the Lambda the MicroVM image is valid. If your application needs more time to run its validate workflow, return a 503 status code. | 1–3600s (default 30s) |

> **Why implement `/ready`?** It signals the platform that your application has fully booted. Without it, the snapshot may be taken mid-initialization, meaning the cached state is incomplete and every run repeats part of the boot sequence.
>
> **Why implement `/validate`?** It lets the platform verify the snapshot is correct, and also samples which portions of the snapshot are accessed during `RunMicrovm`. This allows the platform to **prefetch** those portions on future launches, reducing cold-start times.

### `microvmHooks` (runtime)

| Hook        | Purpose                            | Timeout range      |
| ----------- | ---------------------------------- | ------------------ |
| `run`       | Fires once after run from snapshot | 1–60s (default 1s) |
| `resume`    | Fires after SUSPENDED → RUNNING    | 1–60s (default 1s) |
| `suspend`   | Fires before RUNNING → SUSPENDED   | 1–60s (default 1s) |
| `terminate` | Fires before termination           | 1–60s (default 1s) |

See [`references/getting-started.md`](references/getting-started.md) for a full example enabling all hooks.

## Per-MicroVM size limits

| Resource                   | Limit |
| -------------------------- | ----- |
| Maximum vCPUs per MicroVM  | 16    |
| Maximum memory per MicroVM | 32 GB |

> For all other quotas — concurrent MicroVMs per account, launch rate, image count, max execution duration, auth token TTL, Lambda Network Connector (LNC) limits, per-ENI bandwidth, etc. — **check the AWS docs / Service Quotas console.** Most are soft quotas, raisable through Service Quotas / Support.

## Additional capabilities

By default, the container runs with a restricted set of Linux capabilities. Set `--additional-os-capabilities '["ALL"]'` at image creation time only when required by your use case:

- **Filesystem mounts** — EFS, FUSE-based filesystems.
- **Nested containers** — running additional containers with containerd inside the MicroVM.
- **eBPF programs** — tracing, profiling, or custom network policies.

```bash
aws lambda-microvms create-microvm-image \
  --name my-image \
  --base-image-arn arn:aws:lambda:<region>:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::<acct>:role/MicroVMBuildRole \
  --code-artifact '{"uri":"s3://<bucket>/<key>.zip"}' \
  --additional-os-capabilities '["ALL"]'
```

### Shell ingress for agent use cases

For programmatic shell access (agent workflows, remote command execution), use the `SHELL_INGRESS` network connector:

```bash
# 1. Run with SHELL_INGRESS enabled
aws lambda-microvms run-microvm \
  --image-identifier arn:aws:lambda:<region>:<acct>:microvm-image:my-image \
  --execution-role-arn arn:aws:iam::<acct>:role/MicroVMExecutionRole \
  --ingress-network-connectors '["arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:SHELL_INGRESS"]' \
  --idle-policy '{"maxIdleDurationSeconds":900,"suspendedDurationSeconds":300,"autoResumeEnabled":true}'
# Response includes microvmId and endpoint

# 2. Mint a shell auth token (max 60 min; use shortest duration needed)
# Treat the token as a secret — avoid logging, storing in files, or shell history.
TOKEN=$(aws lambda-microvms create-microvm-shell-auth-token \
  --microvm-identifier microvm-... \
  --expiration-in-minutes 15 \
  --query 'authToken."X-aws-proxy-auth"' --output text)

# 3. Connect via WebSocket (port 8022)
# CLI args are visible in process listings (ps aux). For shared hosts,
# pipe the header via a file descriptor or use a wrapper script.
websocat "wss://<endpoint>/shell" \
  -H "Sec-WebSocket-Protocol: lambda-microvms.authentication.${TOKEN}, lambda-microvms, lambda-microvms.port.8022"
```

The shell drops into the same container as the running application — same network namespace, filesystem, and process tree. This provides an interactive PTY over a WebSocket-based shell channel accessible from any client (terminal or browser), suitable for agent-driven workflows that need to execute commands inside the MicroVM.

Prerequisites: MicroVM must be run with SHELL_INGRESS attached, and caller also needs `lambda:CreateMicrovmShellAuthToken`.

## Known constraints

- **Image is single-size** — you can't ship multiple instance sizes from one image. Plan one image per size.
- **Image versions incur storage cost** even when no MicroVMs are running on them. Use `delete-microvm-image-version` to clean up.
- **Suspend → resume can't switch network connectors.** LNC is bound at run time.
- **No self-suspend from inside the MicroVM.** Call `SuspendMicrovm` from outside (via the public API).
- **Auth token max TTL is 60 min.** Refresh ahead of expiry for long-running clients.
- **Runtime hooks (`/run`, `/resume`, `/suspend`, `/terminate`) are fast-notification only** (1–60s timeout). Don't use them for slow init.

## Reference index

Pick the reference that matches your task:

- [`references/getting-started.md`](references/getting-started.md) — prerequisites (S3 bucket, build role trust policy), packaging, end-to-end CLI walkthrough, first run + token + curl.
- [`references/lifecycle-model.md`](references/lifecycle-model.md) — image vs. MicroVM state machines, the six lifecycle hooks (paths, timeouts, what to do in each), idle/suspend/resume semantics, hook payloads.
- [`references/snapshots-and-uniqueness.md`](references/snapshots-and-uniqueness.md) — what gets snapshotted, the uniqueness pitfall, CSPRNGs by language, env vars vs. run configuration, snapshot size inspection.
- [`references/networking.md`](references/networking.md) — ingress vs. egress connectors, port routing, `X-aws-proxy-*` headers, WebSocket subprotocols, HTTP/2 / gRPC, VPC egress.
- [`references/iam-and-security.md`](references/iam-and-security.md) — build role vs. execution role, trust policies, auth tokens (regular vs. shell), `lambda:PassNetworkConnector`.
- [`references/troubleshooting.md`](references/troubleshooting.md) — image build error codes, run/connect failures, hook timeouts, network connector issues, debugging via shell access.

## Conventions used in references

- The runtime-side default proxy port is `8080`. Override per-request with `X-aws-proxy-port` or per-WebSocket with subprotocol `lambda-microvms.port.<n>`.

## Security considerations

- **Confused deputy prevention** — add `aws:SourceAccount` (or `aws:SourceArn`) condition keys to trust policies. See `references/iam-and-security.md`.
- **Snapshot uniqueness** — snapshots share memory state. Reseed CSPRNGs and rotate secrets on resume. See `references/snapshots-and-uniqueness.md`.
- **Network isolation** — use VPC egress connectors to restrict outbound traffic.
- **Least-privilege execution roles** — scope IAM policies to specific regions, accounts, and resource prefixes.
- **Logging** — enable CloudTrail for MicroVM lifecycle events.
