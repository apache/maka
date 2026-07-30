# Kimi Coding Plan protocol A/B

This experiment compares the existing `kimi-coding-plan` connection through its
Anthropic-compatible and OpenAI-compatible request protocols. It does not add a
second provider or duplicate model metadata.

## Controlled variable

The two arms use the same Maka checkout, Kimi endpoint, model, system prompt,
tools, context policy, Harbor tasks, task budget, and execution order. The
runner executes arms sequentially and changes only:

- A: `MAKA_MODEL_API_PROTOCOL=anthropic-messages`
- B: `MAKA_MODEL_API_PROTOCOL=openai-chat`

The current Anthropic-compatible default remains unchanged. A report can mark
OpenAI as a candidate only when paired correctness is unchanged, request usage
is complete, and an absolute token, aggregate provider latency, or recorded cost
metric improves by at least 1%. Aggregate latency must also improve by at least
100 ms, so timing noise cannot change the recommendation. Aggregate latency is
used for the recommendation so a protocol cannot appear faster merely by
splitting a task into more requests. The benchmark does not mutate provider
defaults.

## Contract evidence

The provider contract tests cover both protocol paths for:

- maximum reasoning effort and reasoning replay;
- multi-step tool-call IDs, arguments, and result pairing;
- normalized input, cache-read, cache-miss, cache-write, output, and reasoning
  token fields;
- request-level capture and attempt telemetry from the AgentRun trace.

The benchmark validates every provider request, in order, across the first
paired task traces before reporting results. Request counts and step sequences
must match; shared system-prompt, tool-schema, and message segments must match;
the protocol-independent request payload must match after removing
provider-owned metadata and normalizing wire-equivalent output limits; and the
`provider_options` segment must differ for each request.

## Run

Build Maka and make the selected Harbor task cache available, then set:

```sh
export MAKA_KIMI_PROTOCOL_AB_RUN_ID="kimi-protocol-ab-20260725"
export MAKA_KIMI_PROTOCOL_AB_OUT_DIR="$PWD/.artifacts/kimi-protocol-ab"
export MAKA_KIMI_PROTOCOL_AB_TASK_IDS="task-id-a,task-id-b"
export MAKA_KIMI_PROTOCOL_AB_KEY_FILE="$HOME/.maka/secrets/kimi-coding-plan.key"
```

Keep `MAKA_KIMI_PROTOCOL_AB_RUN_ID` unchanged between the dry-run and paid run;
both commands must address the same immutable manifest.

Validate the immutable run manifest without making provider requests:

```sh
MAKA_KIMI_PROTOCOL_AB_DRY_RUN=1 npm run benchmark:kimi-protocol-ab
```

Run the paid/account-plan comparison:

```sh
npm run benchmark:kimi-protocol-ab
```

Optional controls are:

- `MAKA_KIMI_PROTOCOL_AB_TASKS_ROOT`
- `MAKA_KIMI_PROTOCOL_AB_REPS` (default `3`)
- `MAKA_KIMI_PROTOCOL_AB_MAX_CONCURRENCY` (default `1`)
- `MAKA_KIMI_PROTOCOL_AB_TASK_BUDGET_SEC` (default `1800`)
- `MAKA_KIMI_PROTOCOL_AB_HARBOR_TIMEOUT_MS`
- `MAKA_KIMI_PROTOCOL_AB_NON_INFERIORITY_MARGIN` (default `0.1`)
- `MAKA_KIMI_PROTOCOL_AB_MODEL` (default `k3`)
- `MAKA_KIMI_PROTOCOL_AB_BASE_URL`

## Retained artifacts

Each run directory contains:

- `kimi-protocol-ab-manifest.json`: immutable subject, task, toolchain, arm, and
  budget fingerprints;
- `controller/results.jsonl`: append-only raw task outcomes used for resume and
  paired analysis;
- `kimi-protocol-ab-result.json`: manifest, paired outcomes, request metrics,
  smoke result, and raw trace references;
- `kimi-protocol-ab-report.md`: human-readable comparison;
- `jobs/`: Harbor attempt artifacts, including the referenced AgentRun traces.

Missing provider usage remains missing; the report does not replace absent
request-level fields with normalized zeroes.

Kimi's current protocol endpoints are documented in the
[Kimi Code documentation](https://www.kimi.com/code/docs/en/) and its
[provider configuration reference](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html).
