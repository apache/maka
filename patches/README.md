# patches

Applied on root `postinstall` via `scripts/apply-dependency-patches.mjs`
(`patch-package --error-on-fail`). After bumping a patched dependency, re-run
`npx patch-package <name>` so the filename tracks the installed version.

Keep this directory small. Prefer product code that uses the dependency's
published API; only patch for bugs that block shipping and cannot be worked
around at the call site.

## `@ai-sdk/provider-utils@5.0.21`

Streaming tool-call association for gateways that reuse or omit `index` / `id`
(Ollama-style, Anthropic→OpenAI translators). See #1967 / #1976 and
`packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`.

Delete when that guard passes against an unpatched package.

## `@astryxdesign/core@0.3.0`

Blank UA-CH `navigator.userAgentData.platform` must not mean "not Apple".
Electron builds with a rewritten identity ship `platform: ''`, which made every
`mod` hotkey listen for Ctrl and every `Kbd` draw Ctrl on macOS.

Touches only `Kbd` and `useHotkeys` platform probes.

Delete when Astryx treats a blank UA-CH platform as absent.
