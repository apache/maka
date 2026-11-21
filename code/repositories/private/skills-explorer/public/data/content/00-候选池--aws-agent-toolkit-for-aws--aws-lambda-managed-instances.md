---
name: aws-lambda-managed-instances
description: "Evaluates, configures, and migrates workloads to AWS Lambda Managed Instances (LMI). Runs Lambda functions on EC2 instances in the user's account while AWS manages provisioning, patching, scaling, routing, and load balancing. Triggers when queries mention Lambda Managed Instances, LMI, capacity providers, multi-concurrent execution environments, EC2-backed Lambda, persistent Lambda instances, PerExecutionEnvironmentMaxConcurrency, CapacityProviderConfig, cold start elimination via dedicated instances, migrating standard Lambda to managed instances, or cost comparison between standard Lambda and LMI with Savings Plans or Reserved Instances. Also covers long-running and asynchronous workloads and the 90-minute (5400s) function timeout for asynchronous and event-source-mapping (SQS, Kinesis, DynamoDB Streams / ESM) invocations, including how to raise the function timeout up to 90 minutes / 5400s and the related duration limits."
version: 2
---

# AWS Lambda Managed Instances (LMI)

Runs Lambda functions on EC2 instances in the user's account while AWS manages provisioning, patching, scaling, routing, and load balancing. Combines Lambda's developer experience with EC2's pricing and hardware options.

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) for sandboxed CLI execution and audit logging. All guidance also works with standard AWS CLI or SAM CLI.

**Note:** Confirm regional availability, quotas, and instance type offerings against current AWS documentation before production deployment.

## Quick Decision: Is LMI Right for This Workload?

| Signal         | LMI is a strong fit                                                                                                                                             | Standard Lambda is better                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Traffic        | Steady, predictable, 50M+ req/mo                                                                                                                                | Bursty, unpredictable, long periods of no traffic                                 |
| Duration       | Long-running asynchronous/ESM jobs that exceed 15 min (up to 90 min on LMI): ETL/data processing, media transcoding, ML inference, financial calc, web scraping | Short invocations; synchronous work needing >15 min (not supported on any Lambda) |
| Cost           | Duration-heavy spend at scale                                                                                                                                   | Low or sporadic invocations                                                       |
| Cold starts    | Unacceptable (LMI eliminates for provisioned capacity)                                                                                                          | Tolerable                                                                         |
| Compute        | Latest CPUs, specific families, high network bandwidth, GPU requirements                                                                                        | Standard Lambda memory/CPU sufficient                                             |
| Isolation      | Dedicated EC2 instances in your account, full VPC control                                                                                                       | Shared Firecracker micro-VMs acceptable                                           |
| Scale-to-zero  | Does not scale to zero but can create custom schedules with AWS provided solutions                                                                              | Required (pay nothing when idle)                                                  |
| Code readiness | Thread-safe (Node.js/Java/.NET) or any Python code                                                                                                              | Non-thread-safe code, expensive to change                                         |

## Routing

Read ONLY the single reference file that matches the user's task. Do not preload multiple references.

| User need                                                                            | Action                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Cost comparison, pricing analysis, Savings Plans, Reserved Instances                 | Read [cost-comparison.md](references/cost-comparison.md)           |
| Instance types, memory sizing, vCPU ratios, scaling tuning, capacity provider config | Read [configuration-guide.md](references/configuration-guide.md)   |
| Thread safety, concurrency model, code review checklist, multi-concurrency readiness | Read [thread-safety.md](references/thread-safety.md)               |
| Before/after code examples, runtime-specific migration, connection pooling           | Read [migration-patterns.md](references/migration-patterns.md)     |
| IAM roles, VPC setup, CLI commands, SAM template, CDK example                        | Read [infrastructure-setup.md](references/infrastructure-setup.md) |
| Errors, throttling, debugging, stuck deployments                                     | Read [troubleshooting.md](references/troubleshooting.md)           |

**Troubleshooting quick facts** (always mention when diagnosing issues):

- Capacity provider stuck in CREATING → most common cause is **private subnets missing a NAT gateway route** (instances need outbound internet for image pull and Lambda service communication)
- Function not scaling → check that a **version is published** (PublishToLatestPublished: true)
- Memory errors → LMI minimum is **2048 MB**

## Workflow

### Step 1: Assess the Workload

Gather these signals before recommending:

1. **Traffic pattern**: Steady vs bursty? Requests per second?
2. **Current costs**: Monthly Lambda spend? Existing Savings Plans?
3. **Runtime**: Node.js, Java, .NET, or Python?
4. **Memory/CPU**: How much memory? CPU-bound or I/O-bound?
5. **Execution duration**: Average and P99?
6. **Concurrency readiness**: Thread safety? Shared `/tmp` paths? Per-invocation DB connections?
7. **VPC**: Already in a VPC? Private resource access needed?

**Long-running asynchronous/ESM jobs that exceed 15 min are a positive fit** — LMI supports a function timeout up to 90 min (5400s) for asynchronous and event-source-mapping invocations (ETL/data processing, media transcoding, ML inference, financial calc, web scraping). Duration is the key differentiator here, not just cost.

When recommending LMI, ALWAYS mention: minimum 3 execution environments for AZ resiliency (cannot go below 3 in production).

### Step 2: Build the Cost Comparison

REQUIRED: Present a cost comparison before recommending LMI.

Rule of thumb: LMI becomes cost-competitive at 50-100M+ req/month with steady traffic. Use the [LMI Pricing Calculator](https://aws-samples.github.io/sample-aws-lambda-managed-instances/) for accurate comparisons.

### Step 3: Configure the Deployment

- **Instance families** (400+ types, .large and up): C-series (compute), M-series (general), R-series (memory). ARM (Graviton) for best price-performance.
- **When using Graviton instances, MUST set `Architectures: [arm64]`** in the function configuration to match.
- **Memory-to-vCPU ratios**: 2:1 (compute), 4:1 (general, default), 8:1 (memory). Min 2 GB, max 32 GB.
- **Multi-concurrency per-vCPU maximums**: Node.js 64, Java 32, .NET 32, Python 16. These are system caps — the actual setting is PerExecutionEnvironmentMaxConcurrency (per execution environment, not per vCPU).
- **For I/O-bound workloads**: use the runtime default or higher PerExecutionEnvironmentMaxConcurrency (e.g., 10 for Node.js) since each request uses minimal CPU while waiting on network.
- **For CPU-bound workloads**: set PerExecutionEnvironmentMaxConcurrency to 1-2 per vCPU since each request saturates CPU.
- **Scaling**: MinExecutionEnvironments (default 3), MaxVCpuCount (optional, default 400 — set explicitly as best practice), TargetResourceUtilization.
- **Function timeout up to 5400s (90 min)** — set via the existing `Timeout` field (CLI `update-function-configuration --timeout 5400`, SAM/CFN `Timeout: 5400`, or console). Uses the existing `Timeout` field — no separate API, property, tag, or code change is required. Applies to **asynchronous and ESM invocations only**; synchronous and On-Demand invocations stay capped at 15 min (even if `Timeout` is higher; `GetFunctionConfiguration` still reports the configured value). The Init phase is still capped at 15 min. Durable Functions: each step can run up to 90 min; a multi-step workflow up to 1 year.

### Step 4: Migrate the Code

Review code for concurrency safety. LMI runs multiple invocations concurrently per execution environment:

- **Python**: Process-based isolation — globals are NOT shared. No thread-safety changes needed. Focus on `/tmp` conflicts and memory sizing.
- **Node.js**: Worker threads — globals shared within a worker. Requires async safety.
- **Java/.NET**: OS threads/Tasks — handler shared across threads. Requires full thread safety.

### Step 5: Set Up Infrastructure

1. Create two IAM roles: execution role (for the function) and operator role (for capacity provider EC2 management)
2. Configure VPC with subnets across 3+ AZs
3. Create capacity provider with VPC config and scaling limits
4. Create or update function with capacity provider attachment
5. Publish a version (triggers instance provisioning)

### Step 6: Validate and Cut Over

1. Deploy to a non-production environment first
2. Monitor CloudWatch: CPU utilization, memory, concurrency, throttle rate
3. Gradual traffic shift with weighted aliases (10% → 50% → 100%)
4. Compare costs after 1-2 weeks of production data
5. Decommission standard Lambda once stable

## Best Practices

### Pricing (always mention when discussing costs)

- **Three components**: EC2 instance hours + 15% management fee + $0.20/1M requests
- **Savings Plans**: Compute Savings Plans apply to the EC2 portion (up to 60-72% discount)
- **The 15% fee** is charged on top of EC2 cost for AWS managing provisioning, patching, scaling, lifecycle

### Scaling (always mention when discussing scaling or traffic)

- LMI absorbs a 50% traffic spike immediately and **doubles capacity within 5 minutes** — if traffic more than doubles faster, requests throttle
- Standard Lambda bursts to 3000 instantly — LMI cannot match this
- **Pre-warm** with MinExecutionEnvironments before known spikes
- **MaxVCpuCount** (default 400) — set explicitly as a cost ceiling
- **Shape**: Reduce MinExecutionEnvironments to lower capacity during off-hours (minimum 3 for AZ resiliency)

### Instance Sizing

- **1 vCPU + 1 GB reserved per instance** for OS overhead (not available to your function)
- Usable capacity = total - overhead

### Configuration

- Start with 4:1 ratio and runtime default concurrency
- Use ARM (Graviton) unless x86 dependencies exist
- Let Lambda choose instance types unless specific hardware needed
- Set MaxVCpuCount to control cost ceiling
- Never set MinExecutionEnvironments below 3 (breaks AZ resiliency)

### Migration

- Start with I/O-heavy functions (benefit most from multi-concurrency)
- Review code for concurrency safety before attaching to capacity provider
- Use weighted aliases for gradual traffic shift
- Include request IDs in all log statements
- Initialize DB pools and SDK clients outside the handler

### Operations

- Set CloudWatch alarms on throttle rate > 1% and CPU > 80%
- Plan for 14-day instance rotation (automatic)
- Never manually terminate LMI EC2 instances (delete the capacity provider instead)
- Always publish a version — unpublished functions cannot run on LMI

### Long-duration invocations (asynchronous/ESM up to 90 min)

- **SQS**: the queue visibility timeout MUST be ≥ the function timeout (≥ 5400s for a 90-min function). The ESM validates this on create and update — but once the ESM exists, the SQS visibility timeout and the function timeout can each be changed independently (outside the ESM API), which bypasses the check and can reintroduce a mismatch, causing messages to reappear and duplicate invokes.
- **Kinesis / DynamoDB Streams**: enable **partial batch failure reporting** (`ReportBatchItemFailures`) and tune the max batching window and parallelization factor — otherwise one failed record retries the whole batch, re-running up to ~80 min of already-completed work.
- **Asynchronous invocations**: failed or timed-out invocations follow the retry policy (up to 2 retries by default), then route to the DLQ / on-failure destination.
- **Not all ESM sources qualify**: Amazon MQ and Amazon DocumentDB ESM remain limited to 15 min; only SQS, Kinesis, and DynamoDB Streams ESM (and asynchronous invocations) get 90 min.
- **Observability is unchanged**: CloudWatch, CloudTrail (one Invoke event on completion/timeout), and X-Ray (single trace) behave identically. Use X-Ray sub-segments to find slow phases near the 90-min limit.

### Long-running networking (functions now run for tens of minutes)

- **NAT Gateway idle timeout** — send periodic keep-alive packets on long-lived TCP connections through a NAT Gateway.
- **Idle connection timeouts** (RDS, ElastiCache, external APIs) — add connection health checks / reconnection logic for connections that may go idle mid-computation.
- **DNS TTL** — re-resolve external hostnames periodically; the AWS SDK does this, but custom HTTP clients may cache beyond TTL.
- **Credentials** — rely on the execution role's ephemeral credentials (automatically refreshed by the runtime). For non-IAM secrets (DB passwords, API keys), retrieve them from AWS Secrets Manager or SSM Parameter Store with SDK caching and periodic refresh; never embed long-lived credentials in code or environment variables.

## Limits Quick Reference

| Resource                        | Limit                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Memory                          | 2 GB min, 32 GB max                                                                                       |
| Asynchronous/ESM invoke timeout | 90 min (5400s), via the existing Timeout field                                                            |
| Sync + On-Demand invoke timeout | 15 min                                                                                                    |
| Init phase                      | 15 min                                                                                                    |
| ESM sources capped at 15 min    | Amazon MQ, Amazon DocumentDB (SQS/Kinesis/DynamoDB Streams get 90 min)                                    |
| Execution environments          | 3 minimum (MinExecutionEnvironments, AZ resiliency)                                                       |
| Instance lifespan               | 14 days (auto-replaced)                                                                                   |
| Concurrency/vCPU                | 64 (Node.js), 32 (Java/.NET), 16 (Python)                                                                 |
| Runtimes                        | Node.js 22+, Java 21+, .NET 8+, Python 3.13+, Rust (provided.al2023)                                      |
| Instance families               | C, M, R (.large and up)                                                                                   |
| Scaling                         | Burst headroom equals unused capacity from TargetResourceUtilization; new instances launch within minutes |

## Security Considerations

- **Operator role scoping**: Add `aws:SourceAccount` and `aws:SourceArn` conditions to trust policies to prevent confused deputy attacks.
- **VPC egress**: Scope security group egress to VPC endpoint security groups or AWS prefix lists rather than 0.0.0.0/0.
- **Credentials**: Use AWS Secrets Manager or Parameter Store for database credentials — never environment variables for secrets.
- **Encryption**: Enable SQS SSE, CloudWatch Logs encryption (KMS), and S3 default encryption for any data at rest.
- **Logging**: Set CloudWatch Log group retention policies. Avoid logging PII or credentials. Enable CloudTrail data events for Lambda.
- **Instance rotation**: The 14-day automatic rotation ensures security patches are applied without manual intervention.
- **References**: [Lambda Security Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/lambda-security.html), [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

## Files

| File                                                          | Content                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [cost-comparison.md](references/cost-comparison.md)           | Pricing analysis, break-even calculations, Savings Plans/RI impact             |
| [configuration-guide.md](references/configuration-guide.md)   | Instance selection, memory ratios, scaling tuning, capacity provider config    |
| [thread-safety.md](references/thread-safety.md)               | Concurrency model per runtime, code review checklist, Powertools compatibility |
| [migration-patterns.md](references/migration-patterns.md)     | Before/after code by runtime, connection pooling, gradual cutover              |
| [infrastructure-setup.md](references/infrastructure-setup.md) | IAM roles, VPC setup, SAM templates, CLI commands                              |
| [troubleshooting.md](references/troubleshooting.md)           | Common errors, throttling, debugging, stuck deployments                        |
