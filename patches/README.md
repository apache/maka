# patches

`scripts/apply-dependency-patches.mjs` applies everything here during the root `postinstall`, with `--error-on-fail` so a patch that no longer applies blocks the install instead of silently disappearing. It skips when `patch-package` itself is absent, which happens under `npm ci --workspace <name>` and `npm ci --omit=dev`; those trees are not what ships, and an unpatched one fails the regression test below.

After bumping a patched dependency, re-run `npx patch-package <name>` so the patch filename tracks the installed version.

Each patch needs a reason to exist and a condition under which it can be deleted.

## `@ai-sdk/provider-utils`: a streamed tool-call index is an identifier, not an array slot

Fixes [#1967](https://github.com/maka-agent/maka-agent/issues/1967): a tool call through an OpenAI-compatible gateway that labels `tool_calls[].index` with a non-zero-starting or non-contiguous number crashes the whole turn.

`StreamingToolCallTracker` stores tool calls at `this.toolCalls[index]`, so a gateway reporting `index: 1` leaves an empty slot at 0. `flush()` then walks the array with `for...of`, which does not skip holes the way `forEach` would, and dereferences `undefined.hasFinished`. The patch skips empty slots.

That is the crash, not the whole defect class. `index` says which tool call a delta belongs to, but identity really lives in `toolCallDelta.id`, and the tracker keys off neither consistently. Two cases remain broken exactly as they are upstream, unchanged by this patch:

- **A reused index across two distinct calls** (`id: a` then `id: b`, both at `index: 0`, the Ollama shape in [vercel/ai#14277](https://github.com/vercel/ai/pull/14277)) silently merges them into one call with concatenated, invalid JSON arguments and drops the second `id`.
- **A call whose deltas omit `index`** and span more than one chunk throws `Expected 'id' to be a string.`, because the `?? this.toolCalls.length` fallback picks a fresh slot each time.

The crash this patch fixes is reported upstream in [vercel/ai#18333](https://github.com/vercel/ai/issues/18333); the reused-index case is [vercel/ai#14277](https://github.com/vercel/ai/pull/14277) and the missing-index case [vercel/ai#15879](https://github.com/vercel/ai/pull/15879). Fixing those means rekeying the tracker on `id`, which is upstream's call to make, not something to widen this patch into.

Delete the patch once `@ai-sdk/provider-utils` stops crashing on sparse indices itself. The guard is `packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`, which asserts behaviour through the real provider stack and stays green either way.
