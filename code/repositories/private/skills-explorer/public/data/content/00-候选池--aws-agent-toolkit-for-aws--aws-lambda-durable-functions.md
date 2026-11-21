---
name: aws-lambda-durable-functions
description: Builds resilient, long-running, multi-step applications with AWS Lambda durable functions with automatic state persistence, retry logic, and orchestration for long-running executions. Covers the critical replay model, step operations, wait/callback patterns, error handling with saga pattern, testing with LocalDurableTestRunner. Triggers on phrases like lambda durable functions, durable execution, workflow orchestration, state machines, retry/checkpoint patterns, long-running stateful Lambda functions, saga pattern, human-in-the-loop callbacks, reliable serverless applications, context.step, context.wait, context.invoke, context.runInChildContext, withDurableExecution, DurableContext, UnrecoverableInvocationError, durable-execution-sdk, qualified ARN invocation, and durable handler replay.
version: 1
---

# AWS Lambda durable functions

Build resilient multi-step applications and AI workflows that can execute for up to 1 year while maintaining reliable progress despite interruptions.

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) but is not required. All AWS interactions in this skill use standard AWS CLI commands that work in any environment with configured AWS credentials.

## Critical Rules

Read these before writing any code. Each one is a constraint that will silently break a function if violated.

1. **Durable execution must be enabled at function creation time — it cannot be retrofitted.** A new Lambda function must be created with durable execution turned on. Migrate the logic into the new function; do not attempt to install the SDK and wrap the handler of the existing function and expect it to work.
2. **Durable functions must be invoked with a qualified ARN** — a specific version, an alias, or the literal `$LATEST` suffix. An unqualified function name will fail. See the _Invocation Requirements_ section below for examples.
3. **Durable operations cannot be nested.** You cannot call `context.step()`, `context.wait()`, or `context.invoke()` from inside another step's callback. Use `context.runInChildContext()` to group operations instead.
4. **All non-deterministic code must run inside steps.** `Date.now()`, `Math.random()`, UUID generation, API calls, and database queries outside a step will produce different values on replay and corrupt execution state.
5. **Closure mutations are lost on replay** - return values from steps
6. **Side effects outside steps repeat** - use `context.logger` (replay-aware)

## When to Load Reference Files

Load the appropriate reference file based on what the user is working on:

- **Getting started**, **basic setup**, **example**, **ESLint**, or **Jest setup** -> see [getting-started.md](references/getting-started.md)
- **Understanding replay model**, **determinism**, or **non-deterministic errors** -> see [replay-model-rules.md](references/replay-model-rules.md)
- **Creating steps**, **atomic operations**, or **retry logic** -> see [step-operations.md](references/step-operations.md)
- **Waiting**, **delays**, **callbacks**, **external systems**, or **polling** -> see [wait-operations.md](references/wait-operations.md)
- **Parallel execution**, **map operations**, **batch processing**, or **concurrency** -> see [concurrent-operations.md](references/concurrent-operations.md)
- **Error handling**, **retry strategies**, **saga pattern**, or **compensating transactions** -> see [error-handling.md](references/error-handling.md)
- **Advanced error handling**, **timeout handling**, **circuit breakers**, or **conditional retries** -> see [advanced-error-handling.md](references/advanced-error-handling.md)
- **Testing**, **local testing**, **cloud testing**, **test runner**, or **flaky tests** -> see [testing-patterns.md](references/testing-patterns.md)
- **Deployment**, **CloudFormation**, **CDK**, **SAM**, **log groups**, **deploy**, or **infrastructure** -> see [deployment-iac.md](references/deployment-iac.md)
- **Advanced patterns**, **GenAI agents**, **completion policies**, **step semantics**, or **custom serialization** -> see [advanced-patterns.md](references/advanced-patterns.md)
- **troubleshooting**, **stuck execution**, **failed execution**, **debug execution ID**, **execution history**, **execution error**, **why did my execution fail**, **execution timed out**, **callback not received**, **diagnose execution**, or **root cause execution** -> see [troubleshooting-executions.md](references/troubleshooting-executions.md)

## Quick Reference

### Basic Handler Pattern

**TypeScript:**

```typescript
import { withDurableExecution, DurableContext } from "@aws/durable-execution-sdk-js";

export const handler = withDurableExecution(async (event, context: DurableContext) => {
  const result = await context.step("process", async () => processData(event));
  return result;
});
```

**Python:**

```python
from aws_durable_execution_sdk_python import durable_execution, DurableContext

@durable_execution
def handler(event: dict, context: DurableContext) -> dict:
    result = context.step(lambda _: process_data(event), name='process')
    return result
```

### Python API Differences

The Python SDK differs from TypeScript in several key areas:

- **Steps**: Use `@durable_step` decorator + `context.step(my_step(args))`, or inline `context.step(lambda _: ..., name='...')`. Prefer the decorator for automatic step naming.
- **Wait**: `context.wait(duration=Duration.from_seconds(n), name='...')`
- **Exceptions**: `ExecutionError` (permanent), `InvocationError` (transient), `CallbackError` (callback failures)
- **Testing**: Use `DurableFunctionTestRunner` class directly - instantiate with handler, use context manager, call `run(input=...)`

### Invocation Requirements

Durable functions **require qualified ARNs** (version, alias, or `$LATEST`):

```bash
# Valid
aws lambda invoke --function-name my-function:1 output.json
aws lambda invoke --function-name my-function:live output.json

# Invalid - will fail
aws lambda invoke --function-name my-function output.json
```

## IAM Permissions

Your Lambda execution role MUST have the `AWSLambdaBasicDurableExecutionRolePolicy` managed policy attached. This includes:

- `lambda:CheckpointDurableExecution` - Persist execution state
- `lambda:GetDurableExecutionState` - Retrieve execution state
- CloudWatch Logs permissions

**Additional permissions needed for:**

- **Durable invokes**: `lambda:InvokeFunction` on target function ARNs
- **External callbacks**: Systems need `lambda:SendDurableExecutionCallbackSuccess` and `lambda:SendDurableExecutionCallbackFailure`

## Validation Guidelines

When writing or reviewing durable function code, ALWAYS check for these replay model violations:

1. **Non-deterministic code outside steps**: `Date.now()`, `Math.random()`, UUID generation, API calls, database queries must all be inside steps
2. **Nested durable operations in step functions**: Cannot call `context.step()`, `context.wait()`, or `context.invoke()` inside a step function — use `context.runInChildContext()` instead
3. **Closure mutations that won't persist**: Variables mutated inside steps are NOT preserved across replays — return values from steps instead
4. **Side effects outside steps that repeat on replay**: Use `context.logger` for logging (it is replay-aware and deduplicates automatically)

When implementing or modifying tests for durable functions, ALWAYS verify:

1. All operations have descriptive names
2. Tests get operations by NAME, never by index
3. Replay behavior is tested with multiple invocations
4. Use `LocalDurableTestRunner` for local testing

## Security Considerations

- **Checkpoint data encryption**: Execution state is persisted automatically. Enable KMS encryption on associated CloudWatch Log Groups to protect checkpointed data at rest.
- **Sensitive data in step results**: Step return values are checkpointed and persisted. Do not return secrets, raw credentials, or PII from steps — store sensitive data in Secrets Manager or SSM Parameter Store and return references instead.
- **Input validation**: Validate and sanitize event payloads at the handler entry point before passing data to steps.
- **Credential management**: Retrieve secrets from AWS Secrets Manager or SSM Parameter Store within steps.
- **Callback payload validation**: Data received via `waitForCallback` originates from external systems — validate and sanitize before processing.
- **Logging**: Avoid `DEBUG` log level in non-development environments as it may expose step results and execution state. Enable CloudWatch Logs encryption with KMS.

## Resources

- [AWS Lambda durable functions Documentation](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [JavaScript SDK Repository](https://github.com/aws/aws-durable-execution-sdk-js)
- [Python SDK Repository](https://github.com/aws/aws-durable-execution-sdk-python)
- [IAM Policy Reference](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSLambdaBasicDurableExecutionRolePolicy.html)
