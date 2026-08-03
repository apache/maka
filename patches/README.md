# patches

`patch-package` applies everything here during the root `postinstall`, with `--error-on-fail` so a patch that no longer applies blocks the install instead of silently disappearing.

Each patch needs a reason to exist and a condition under which it can be deleted.

## `@ai-sdk/provider-utils` — streamed tool-call index is an identifier, not an array slot

Fixes [#1967](https://github.com/maka-agent/maka-agent/issues/1967): any tool call through an OpenAI-compatible gateway that labels `tool_calls[].index` with a non-zero-starting or non-contiguous number crashes the whole turn.

`StreamingToolCallTracker` stores tool calls at `this.toolCalls[index]`, so a gateway reporting `index: 1` leaves an empty slot at 0. `flush()` then walks the array with `for...of`, which — unlike `forEach` — does not skip holes, and dereferences `undefined.hasFinished`. The patch skips empty slots.

This treats the symptom, not the cause: `index` identifies which tool call a delta belongs to, so the tracker wants a `Map<number, ToolCall>` rather than an array. Upstream has no issue for this and its neighbouring tool-call fixes sit unmerged for months, so the patch is maintained here rather than waited on.

Delete it once `@ai-sdk/provider-utils` handles sparse or non-zero-based indices itself. The guard for that is `packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`, which asserts the behaviour through the real provider stack and stays green either way.
