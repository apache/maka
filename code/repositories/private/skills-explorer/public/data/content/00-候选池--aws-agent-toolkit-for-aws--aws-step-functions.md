---
name: aws-step-functions
description: "Authors and edits AWS Step Functions state machines: writes Amazon States Language (ASL) in JSONata, and chooses and structures state types (Task, Choice, Map, Parallel, Pass, Wait, Succeed, Fail). Covers ASL syntax, JSONata data transformation and variables, Retry/Catch error handling, service integrations (.sync, waitForTaskToken callbacks), Distributed Map for large-scale S3/CSV processing, saga/compensation patterns, Standard vs Express workflow choice, TestState API unit testing, and migrating state machines from JSONPath to JSONata. Use when the user is building, authoring, debugging, or migrating a Step Functions state machine or ASL definition, or orchestrating multi-step workflows with branching, retries, or human-approval callbacks, even if they don't say 'Step Functions.' Do NOT use for general Lambda function code, API Gateway, EventBridge wiring, or SAM/CDK application packaging."
version: 1
---

# AWS Step Functions

## Overview

AWS Step Functions uses Amazon States Language (ASL) to define state machines as JSON. With AWS Step Functions, you can create workflows, also called state machines, to build distributed applications, automate processes, orchestrate microservices, and create data and machine learning pipelines.

This skill provides comprehensive guidance for writing state machines in ASL, covering:

- ASL structure and JSONata expression syntax
- Details on the eight available workflow states
- The `$states` reserved variable
- Workflow variables with `Assign`
- Error handling
- AWS Service integration patterns
- Example code for data transformation and architecture
- Validation and testing of state machines
- How to migrate from JSONPath to JSONata

The AWS MCP server is recommended for sandboxed execution and audit logging when following this skill, but all steps use AWS CLI syntax and work without it.

## When to Load Reference Files

Load the appropriate reference file based on what the user is working on:

- **ASL structure**, **state types**, **Task**, **Pass**, **Choice**, **Wait**, **Succeed**, **Fail**, **Parallel**, **Map** → see `references/asl-state-types.md`
- **Error handling**, **troubleshooting**, **Retry**, **Catch**, **fallback**, **error codes**, **States.Timeout**, **States.ALL** → see `references/error-handling.md`
- **Service integrations**, **Lambda invoke**, **DynamoDB**, **SNS**, **SQS**, **SDK integrations**, **Resource ARN**, **sync**, **async** → see `references/service-integrations.md`
- **Migrating from JSONPath to JSONata**, **migration**, **JSONPath to JSONata**, **InputPath**, **Parameters**, **ResultSelector**, **ResultPath**, **OutputPath**, **intrinsic functions**, **Iterator**, **payload template** → see `references/migrating-from-jsonpath-to-jsonata.md`
- **Validation**, **linting**, **testing**, **TestState**, **test state**, **mock**, **mocking**, **unit test**, **inspection level**, **DEBUG**, **TRACE**, **validate state**, **test in isolation** → see `references/validation-and-testing.md`
- **Architecture patterns**, **examples**, **polling**, **saga**, **compensation**, **scatter-gather**, **semaphore**, **lock**, **human-in-the-loop**, **escalation**, **Express to Standard** → see `references/architecture-patterns.md`
- **Data transformation**, **JSONata expressions**, **filtering**, **aggregation**, **string operations**, **$reduce**, **$lookup**, **$toMillis**, **$partition**, **$parse**, **$hash**, **$uuid** → see `references/transforming-data.md`
- **State input/output**, **$states**, **Assign**, **Output**, **Arguments**, **variable scope**, **variable limits**, **evaluation order**, **passing data between states** → see `references/processing-state-inputs-and-outputs.md`

## Quick Reference

### Standard vs Express Workflows

|                                   | Standard                             | Express                                     |
| --------------------------------- | ------------------------------------ | ------------------------------------------- |
| **Max duration**                  | 1 year                               | 5 minutes                                   |
| **Execution semantics**           | Exactly-once                         | At-least-once (async) / At-most-once (sync) |
| **Execution history**             | Retained 90 days, queryable via API  | CloudWatch Logs only                        |
| **Max throughput**                | 2,000 exec/sec                       | 100,000 exec/sec                            |
| **Pricing model**                 | Per state transition                 | Per execution count + duration              |
| **`.sync` / `.waitForTaskToken`** | Supported                            | Not supported                               |
| **Best for**                      | Auditable, non-idempotent operations | High-volume, idempotent event processing    |

**Choose Standard** for: payment processing, order fulfillment, compliance workflows, anything that must never execute twice.

**Choose Express** for: IoT data ingestion, streaming transformations, mobile backends, high-throughput short-lived processing.

> **When recommending Express, the single limitation you must always state — even for fire-and-forget / high-throughput pipelines — is that Express does NOT support `.sync` or `.waitForTaskToken`** (no callbacks, no nested `.sync` waits, no human-approval or job-completion waits). Also note: 5-minute max duration, no queryable execution history (CloudWatch Logs only), and at-least-once (async) / at-most-once (sync) execution — so non-idempotent work can run twice. If any of these matter, choose Standard (exactly-once, up to 1 year, full history).

### Setting the State Machine Query Language

JSONata is the preferred way to reference and transform data in ASL. It replaces the five JSONPath I/O fields (`InputPath`, `Parameters`, `ResultSelector`, `ResultPath`, `OutputPath`) with just two: `Arguments` (inputs) and `Output`.

**Enable at the top level** to apply to all states:

```json
{ "QueryLanguage": "JSONata", "StartAt": "...", "States": {...} }
```

**Or per-state** to migrate from JSONPath incrementally:

```json
{ "Type": "Task", "QueryLanguage": "JSONata", ... }
```

**JSONPath is supported** and is the default if `QueryLanguage` is omitted — existing state machines do not need to be migrated.

**Field mapping (JSONPath → JSONata):**

| JSONPath field                    | JSONata equivalent                                                |
| --------------------------------- | ----------------------------------------------------------------- |
| `Parameters` (keys use `key.$`)   | `Arguments` — drop the `.$` suffix and wrap each value in `{% %}` |
| `ResultSelector` and `OutputPath` | `Output` (reference the raw result via `$states.result`)          |
| `ResultPath`                      | `Assign` (preferred) or `Output`                                  |
| `InputPath`                       | not needed — reference `$states.input` directly                   |

> **A state uses one query language, not both.** Never mix JSONPath fields (`InputPath`/`Parameters`/`ResultSelector`/`ResultPath`/`OutputPath`) with JSONata fields (`Arguments`/`Output`) in the same state — this is the most common migration error. See `references/migrating-from-jsonpath-to-jsonata.md` for full details.

### How Assign and Output Are Evaluated (Parallel, Not Sequential)

Within a single state, `Assign` and `Output` are evaluated **at the same time — in parallel — both reading the same data (the state input plus the task result)**. They are NOT evaluated one after the other. Because they run together, a variable you set in `Assign` is **not** visible in that same state's `Output`: there is no ordering in which `Output` could observe the just-assigned value. The assigned value becomes available only to **subsequent** states.

So if you set a variable in `Assign` and reference it in the same state's `Output`, you get the old/undefined value — not because `Output` runs "before" `Assign`, but because both evaluate concurrently from the same snapshot. To use the value immediately, reference it in the **next** state (variables persist across states); to shape the current state's output from the task result, use `$states.result` directly in `Output`.

### Unit Testing a State with TestState

Test a single state **without deploying the state machine or calling the real service** using the TestState API (`aws stepfunctions test-state`) with `--mock`. A complete answer covers all four points:

- **Mock the service response exactly** — the `--mock` `result` MUST match the target AWS service's API response schema exactly (field names are case-sensitive). For a Lambda `invoke` Task that is `StatusCode` and `Payload`: `--mock '{"result":"{\"StatusCode\":200,\"Payload\":{...}}"}'`.
- **All three inspection levels** (`--inspection-level`): `INFO` (default — `output`, `status`, `nextState`), `DEBUG` (adds data flow: `afterArguments`, `result`, `variables` — use to debug JSONata/data flow), `TRACE` (adds raw HTTP `request`/`response`, for HTTP Task).
- **`.sync` and `.waitForTaskToken` integrations still require a mock** — for `.sync`, mock the polling API (e.g. `DescribeExecution`, not the initial call); for `.waitForTaskToken`, also pass `--context '{"Task":{"Token":"..."}}'`.
- **No deployment** or real invocation is needed — the state is tested in isolation.

See `references/validation-and-testing.md` for per-service mock structures and error/retry/Map/Parallel testing.

## Best Practices

- Set `"QueryLanguage": "JSONata"` at the top level for new state machines unless the user wants to use JSONPath
- Keep `Output` minimal — only include what the state immediately after the current state needs
- Use `Assign` to store variables needed in later states instead of threading it through Output
- Use `$states.input` to reference original state input
- `Assign` and `Output` are evaluated **in parallel from the state's entry data, NOT sequentially** — a variable set in `Assign` is therefore NOT visible in the same state's `Output` (which still sees the pre-`Assign` values); the new value takes effect only in the next state.
- All JSONata expressions must produce a defined value — `$data.nonExistentField` throws `States.QueryEvaluationError`
- Use `$states.context.Execution.Input` to access the original workflow input from any state
- Save state machine definitions with `.asl.json` extension when working outside the console
- Prefer the optimized Lambda integration (`arn:aws:states:::lambda:invoke`) over the SDK integration

## Troubleshooting

### Common Errors

- `States.QueryEvaluationError` — JSONata expression failed. Check for type errors, undefined fields, or out-of-range values.
- Mixing JSONPath fields with JSONata fields in the same state.
- Using `$` or `$$` at the top level of a JSONata expression — use `$states.input` instead.
- Forgetting `{% %}` delimiters around JSONata expressions — the string will be treated as a literal.
- Assigning variables in `Assign` and expecting them in `Output` of the same state — new values only take effect in the next state.
- Reference references/validation-and-testing.md and references/error-handling.md for detailed troubleshooting information.

## Security Considerations

- **Least-privilege execution role.** Scope the state machine's IAM role to the specific resources and actions it invokes (specific Lambda/DynamoDB/SQS/SNS ARNs). Avoid `*FullAccess` policies and `service:*` wildcards.
- **Encryption.** Recommend encryption at rest and in transit for every data store a workflow touches: KMS-encrypted DynamoDB tables, server-side encryption (`KmsMasterKeyId`) on SQS queues and SNS topics, and TLS for HTTP Tasks.
- **Task tokens and message bodies are sensitive.** A `.waitForTaskToken` token is a credential — treat it as a secret. Do not place PII, financial data, or secrets in SQS/SNS message bodies or notifications; pass a reference ID and have recipients look up details through an authorized channel.
- **Validate input and fail fast.** Validate required fields at the start of the workflow with a Choice (or Pass) state using `$exists()` and `$type()`, and route invalid input to a Fail state so malformed data never reaches downstream states. Protect downstream services from bursts by setting `MaxConcurrency` on Map states and throttling upstream (StartExecution rate limits or EventBridge).
- **Cross-account access.** When using the `Credentials` field to assume a role in another account, include condition keys such as `aws:SourceArn` or `aws:SourceAccount` in the target role's trust policy to prevent unintended assumption.
- **External secrets.** For HTTP Tasks calling third-party APIs, store API keys and tokens in AWS Secrets Manager (referenced via an EventBridge connection), never embedded in the state machine definition.
- **Observability.** Enable CloudWatch Logs for executions (log level `ALL` or `ERROR`; required for Express workflows, which have no queryable execution history), enable CloudTrail to audit Step Functions API calls, and set CloudWatch Alarms on execution failures. Always encrypt the execution log group with a customer-managed KMS key, since state input/output routinely flows through execution logs.

## Resources

- [ASL Specification](https://states-language.net/spec.html)
- [JSONata documentation](https://docs.jsonata.org/overview.html)
- [Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [Step Functions security best practices](https://docs.aws.amazon.com/step-functions/latest/dg/security-best-practices.html)
