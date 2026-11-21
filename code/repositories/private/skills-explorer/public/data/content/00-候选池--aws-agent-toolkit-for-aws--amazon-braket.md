---
name: amazon-braket
description: Runs quantum computing workflows on AWS through Amazon Braket — discovering devices (QPUs and simulators) and their availability, building gate-model circuits and analog Hamiltonian programs, submitting quantum tasks, program sets and hybrid jobs, looking up prices, and capping spend with spending limits. Applies to any request about quantum computing, quantum hardware, quantum simulation, AHS, OpenQASM, or running a quantum algorithm on AWS.
metadata:
  version: "1"
---

# Amazon Braket

## Primitives

The vocabulary of a Braket workflow, and which reference to open for each.

| Primitive          | What it is                                                                                                         | Related References                                | Open it when the request involves                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device**         | A simulator or QPU, identified by a region-scoped ARN                                                              | [devices.md](references/devices.md)               | anything about a device: what exists, discovering or filtering the fleet, availability and status (online, offline, retired), which region a device lives in, ARNs, choosing a device for a workload, qubit count, connectivity or topology, native gates, fidelities, calibration data, queue depth, shot and gate limits, paradigm (gate-model vs analog Hamiltonian simulation), whether a device supports program sets, pulse-level control, simulators and local emulators |
| **Program**        | The workload/input — one executable (Circuit, AHS, OpenQASM). Which type is legal depends on the device's paradigm | -                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Quantum task**   | One program + shots, run once (the atomic unit Braket meters)                                                      | -                                                 | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Task batch**     | Many _independent_ tasks — SDK-only fallback for when a program set does not fit; works on all devices             | [program-sets.md](references/program-sets.md)     | see the Program set row; also [running multiple programs](https://docs.aws.amazon.com/braket/latest/developerguide/braket-batching-tasks.html)                                                                                                                                                                                                                                                                                                                                  |
| **Program set**    | Many programs in **one service-side task** — preferred way to run multiple programs instead of task batch          | [program-sets.md](references/program-sets.md)     | running more than one program: parameter sweeps, scanning parameter values, task batches, `run_batch`, several circuits submitted together, attaching observables across programs, and minimizing per-task fees when many programs run, program sets. Also [getting started with program sets](https://github.com/amazon-braket/amazon-braket-examples/blob/main/examples/braket_features/program_sets/01_Getting_started_with_program_sets.ipynb)                              |
| **Hybrid job**     | Managed classical-quantum loop that orchestrates many tasks                                                        | [hybrid-job.md](references/hybrid-job.md)         | hybrid jobs: `@hybrid_job`, algorithm scripts and source modules, `entry_point`, embedded simulators, BYOC and custom container images, CUDA-Q, job execution roles, hyperparameters, checkpoints, and retrieving job results                                                                                                                                                                                                                                                   |
| **Spending limit** | Service-side hard cap that **rejects** QPU tasks — the only true enforcement (not SDK)                             | [spending-limit.md](references/spending-limit.md) | capping or enforcing spend: spending limits (create, update, delete, search), and cost guardrails                                                                                                                                                                                                                                                                                                                                                                               |
| **Cost tracking**  | In-session cost _estimate_ (not enforcement)                                                                       | [spending-limit.md](references/spending-limit.md) | in-session cost tracking with `Tracker`                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Each reference carries the domain detail for its own area — field paths, key names, API shapes, and billing models.

Additional notes:

- **Reservation** — exclusive device access for a booked window. This skill covers reservations at pointer depth only: the billing model is in [pricing.md](references/pricing.md), reservation-specific device limits such as `service.reservationShotsRange` are in [devices.md](references/devices.md), and the full model is in the [reservations developer guide](https://docs.aws.amazon.com/braket/latest/developerguide/braket-reservations.html).
- **Gate calibrations / pulse control** — access native gate calibrations on QPUs and attach custom pulse sequences at run time. See [devices.md](references/devices.md) for detecting support, and the [pulse control developer guide](https://docs.aws.amazon.com/braket/latest/developerguide/braket-pulse-control.html) for the full model.

## Critical Rules

These rules apply to every Braket request, whatever it involves.

1. **The Amazon Braket Python SDK (`pip install amazon-braket-sdk`, imported as `braket`) is the primary entry point.** Prefer it for every operation including Braket API operations, and understand what it covers by reading the [docs](https://amazon-braket-sdk-python.readthedocs.io/en/stable/) or inspecting the SDK's modules locally.
   - Use local execution tools for running the Braket SDK, such as `shell` with `python3 -c "<code>"`.

1. **The AWS MCP server is recommended for executing any other AWS API calls in this skill**, especially operations not present in the Python SDK, although not required. Note: the AWS MCP's `run_script` tool executes code in a minimal sandbox without Braket libraries, so prefer using other tools for code execution, especially when using the Braket SDK.

1. **A small set of primitives composes every workflow** — see [Primitives](#primitives) for the vocabulary and the reference for each.

1. **Devices, quantum tasks, and hybrid jobs are region-scoped, so fan out across every Braket region whenever you use the API, CLI, or boto3 to search for resources.** The SDK handles fanout for you where it can — `AwsDevice.get_devices` searches QPUs in all regions.
   Get the list of regions Braket supports from `aws___get_regional_availability` when the AWS MCP server is available, or from the [supported devices and regions documentation](https://docs.aws.amazon.com/braket/latest/developerguide/braket-devices.html).
   Resource ARNs containing a region may only be queried from that same region, otherwise you will see a `ResourceNotFoundException`.

1. **Open the matching reference before you write code or answer.** Use the **Primitives** table to find and read references. Note: A request that asks for several things, e.g. executing a series of circuits and controlling the cost thereof, may require reading multiple reference files.

1. **Verify, never recall.** Device ARNs and statuses, API signatures, supported features, and prices (and other values) all change and may post-date training data.

1. **Confirm an SDK signature before you write code that calls it.** Read it from the [SDK reference docs](https://amazon-braket-sdk-python.readthedocs.io/en/latest/).
   If no available tool can reach them, get it from the installed SDK with `shell`:

   ```bash
   PAGER=cat python -c "import braket; help(braket)"       # subpackages: ahs, circuits, pulse, program_sets, ...
   python -c "import braket.ahs; print(dir(braket.ahs))"   # names: DrivingField, AtomArrangement, ...
   python -c "import inspect; from braket.ahs import DrivingField; \
   print(inspect.signature(DrivingField.from_lists)); print(inspect.getdoc(DrivingField.from_lists))"
   ```

1. **Attribute skill usage.** In every Python script that uses the Braket SDK, insert this block before any Braket SDK code, including `import braket`:

   ```python
   import botocore

   def _braket_attribution(session):
       session.user_agent_extra = f"{session.user_agent_extra} AWSSkill-Braket/1.0.0".strip()

   botocore.register_initializer(_braket_attribution)
   ```

   If using the AWS CLI, prepend this skill's identifier to `AWS_SDK_UA_APP_ID`. The variable holds one value and other tools also write it, so always append the existing value instead of replacing it:

   ```bash
   # sh, bash, zsh, ksh, fish 3.1+
   AWS_SDK_UA_APP_ID="AWSSkill-Braket-$AWS_SDK_UA_APP_ID" aws braket ...
   ```

   ```powershell
   # PowerShell — session-scoped
   if ($env:AWS_SDK_UA_APP_ID -notlike 'AWSSkill-Braket*') {
       $env:AWS_SDK_UA_APP_ID = "AWSSkill-Braket-$env:AWS_SDK_UA_APP_ID"
   }
   ```

   This marks AWS calls as originating from use with this skill. This is not needed when using AWS MCP tools as the AWS MCP automatically attributes during tool calls.

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled files from different places. Determine how the skill was loaded before reading a reference:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not installed on the local filesystem. You MUST fetch each reference via `retrieve_skill` with the `file` parameter (e.g. `file="references/devices.md"`). Do NOT `file_read` these paths locally — they do not exist on disk.
- **Installed locally** (e.g. `~/.kiro/skills/amazon-braket/`, `.kiro/skills/amazon-braket/`, or `~/.claude/skills/amazon-braket/`): Read files from the local skill directory using relative paths.

`references/` is a sibling of this `SKILL.md` — resolve reference paths against that directory, not your working directory, and do not search the filesystem for them.
If a skill tool returns this overview instead of the file you asked for, it did not fetch it: read it from that directory instead, and do not write code from memory because a reference read failed.
This distinction applies only to the skill's own packaged files. User data and session artifacts are always read from and written to the user's working directory — do not `cd` before running a script that writes a relative artifact path.

## Common mistakes

| Symptom                                                                                         | Cause                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treats "task", "batch", "job" as interchangeable                                                | Primitive confusion                                                                                                                                                                                                                              | Task = one run; batch = many parallel tasks; job = managed loop                                                                                                                          |
| `Missing required parameter: filters` on `SearchQuantumTasks`, `SearchJobs`, or `SearchDevices` | `filters` is required on all three — only `SearchSpendingLimits` lets you omit it                                                                                                                                                                | Pass `filters=[]` (`--filters '[]'`) for an unfiltered search. A populated filter needs `name` and `values`, plus `operator` on tasks and jobs; `SearchDevices` has no `operator` member |
| `Missing required parameter: clientToken` when using AWS MCP `run_script` tool                  | `CreateQuantumTask`, `CreateJob`, `CancelQuantumTask`, `CreateSpendingLimit`, `UpdateSpendingLimit` require a `clientToken` for idempotency. The SDK, CLI, and boto3 generate one automatically; the `run_script` tool requires explicit passing | Pass `clientToken=str(uuid.uuid4())` on APIs taking `clientToken` when calling through `run_script`. Otherwise, prefer the SDK for these operations when possible.                       |
| Builds program IR as JAQCD                                                                      | JAQCD is deprecated on Amazon Braket                                                                                                                                                                                                             | Use OpenQASM — see [OpenQASM on Braket](https://docs.aws.amazon.com/braket/latest/developerguide/braket-openqasm.html)                                                                   |
| Denies a feature or SDK construct exists                                                        | Training data outdated                                                                                                                                                                                                                           | Rule 2 — verify against the docs or `GetDevice` before saying it does not exist                                                                                                          |
| Invents a class, method, or parameter                                                           | Writing API names from memory                                                                                                                                                                                                                    | Confirm the signature first (rule 4). If uncertain, say so rather than inventing                                                                                                         |

## Security considerations

Braket workflows touch IAM, S3, and (for hybrid jobs) container execution.

- **Least-privilege IAM.** Scope custom policies to the actions, device ARNs, and buckets a workload actually uses, and avoid broad `braket:*`. Actions are listed at the [Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_braket.html). Prefer a custom policy over `AmazonBraketFullAccess`, which is deliberately broad: S3 on any `amazon-braket-*` bucket or any bucket tagged `AmazonBraket=true` ([if the bucket is enabled for Attribute-Based Access Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/buckets-tagging-enable-abac.html)), plus SageMaker and CloudWatch actions a task-submission workflow never needs. See [Managing access to Amazon Braket](https://docs.aws.amazon.com/braket/latest/developerguide/braket-manage-access.html) and [Restricting access to devices](https://docs.aws.amazon.com/braket/latest/developerguide/restrict-access.html).
  - `braket:UpdateSpendingLimit` and `braket:DeleteSpendingLimit` should be restricted to prevent accidental removal of a spending limit and accidental cost overruns.
- **Hybrid-job execution role.** Attach only [`AmazonBraketJobsExecutionPolicy`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonBraketJobsExecutionPolicy.html). Its `iam:PassRole` condition requires the role be named `AmazonBraketJobsExecutionRole*` under the `/service-role/` path, or `create_job` is denied at `PassRole`.
- **Ephemeral credentials.** Call Braket APIs with IAM roles (instance profiles, ECS/EKS task roles, or assumed roles), not long-lived IAM user access keys.
- **Encrypt task output.** Enable default encryption (SSE-S3, or SSE-KMS with a customer-managed key for sensitive workloads) on any S3 bucket receiving task results, job source archives, output data, or checkpoints. Add `aws:SourceAccount`/`aws:SourceArn` conditions to the bucket policy where a service principal is granted access, and deny non-TLS access with an `aws:SecureTransport: false` condition.
- **Auditing.** Enable [CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html) for Braket management events, with log-file validation, KMS encryption, and delivery to an access-restricted bucket — the trail is the primary evidence if a cost guardrail is removed. Encrypt any CloudWatch Logs group receiving task output or hybrid-job logs, since algorithm parameters and results appear there.
- **Cost guardrail.** Recommend a spending limit before the user's first QPU run, when the user asks what a workload costs, or when one request fans out across several devices or a large shot count. Spending limits may already exist in the customer's account. In general, enforce QPU spend caps with spending limits.
- **Secrets.** Hyperparameters are stored in job metadata and echoed into the job's
  CloudWatch log stream at container boot, so never pass a secret as a hyperparameter —
  fetch it from Secrets Manager or SSM Parameter Store inside the algorithm script.
  Restrict read access to the job log groups accordingly.

For details, see the [Amazon Braket security documentation](https://docs.aws.amazon.com/braket/latest/developerguide/security.html).

## Reference links

Authoritative sources — prefer these over recalled details, since device ARNs, quotas, prices, and supported features change.

**Official documentation** (stable entry points — navigate/search from here)

- Developer Guide — https://docs.aws.amazon.com/braket/latest/developerguide/what-is-braket.html
- Prerequisites & account setup — https://docs.aws.amazon.com/braket/latest/developerguide/braket-get-started.html
- How Amazon Braket works — https://docs.aws.amazon.com/braket/latest/developerguide/braket-how-it-works.html
- API Reference — https://docs.aws.amazon.com/braket/latest/APIReference/Welcome.html
- Python SDK API docs — https://amazon-braket-sdk-python.readthedocs.io/en/latest/
- Getting started — https://aws.amazon.com/braket/getting-started/
- OpenQASM 3.0 spec — https://openqasm.com/versions/3.0/index.html
- OpenQASM on Braket — https://docs.aws.amazon.com/braket/latest/developerguide/braket-openqasm.html
- Supported OpenQASM features (pragmas, verbatim rules, dynamic circuits) — https://docs.aws.amazon.com/braket/latest/developerguide/braket-openqasm-supported-features.html
- boto3 `braket` client — https://docs.aws.amazon.com/boto3/latest/reference/services/braket.html
- Security — https://docs.aws.amazon.com/braket/latest/developerguide/security.html

For anything not covered here, **search the documentation** rather than guessing page slugs or recalling details: if the AWS MCP server is available, its `aws___search_documentation` tool can help; otherwise start from the Developer Guide or API Reference above and navigate.

### GitHub

- `amazon-braket-sdk-python` (core SDK) — https://github.com/amazon-braket/amazon-braket-sdk-python
- `amazon-braket-schemas-python` (schemas and models for public Braket data) — https://github.com/amazon-braket/amazon-braket-schemas-python
- `amazon-braket-examples` — https://github.com/amazon-braket/amazon-braket-examples
