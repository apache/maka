# patches

`scripts/apply-dependency-patches.mjs` applies these during the root `postinstall` with `--error-on-fail`, so a patch that stops applying blocks the install instead of vanishing. It skips when `patch-package` is unresolvable (`npm ci --workspace <name>`, `npm ci --omit=dev`); those trees are not what ships, and each section's guard test is what catches an unpatched one.

After bumping a patched dependency, re-run `npx patch-package <name>` so the filename tracks the installed version.

Every patch needs a reason and a deletion condition, and that is all this file carries — the derivation belongs in the guard test, and the measurements in the upstream issue.

Patch every runtime entrypoint the repository actually resolves. Node, TypeScript, and the desktop currently use `dist/`; the desktop includes the patch contents in Vite's dependency-cache key so a lockfile-stable patch update forces fresh optimization without splitting package entrypoints into separate module instances. When a patch also changes the matching vendored source, keep that behavior aligned with JavaScript and declarations. This does not make Astryx's separate `source` export a supported Maka build mode: older dist-only patches remain. The `.map` files stay stale.

## `@ai-sdk/provider-utils`: a tool-call delta must agree with the call it continues

Fixes [#1967](https://github.com/maka-agent/maka-agent/issues/1967) and [#1976](https://github.com/maka-agent/maka-agent/issues/1976). `StreamingToolCallTracker` used `tool_calls[].index` — an association label a gateway may omit, repeat, or number freely — as storage slot, identity and ordering at once. 5.0.21 ([vercel/ai#18382](https://github.com/vercel/ai/pull/18382)) fixed the crash and promoted `id` to sole authority, which reproduces the defect with the fields swapped: gateways repeat `id` too, and `function.name` is still never consulted, so the Ollama shape — three calls at `index: 0`, no id, one repeating name — cannot be separated.

The patched tracker keys on nothing. Records live in creation order, each learning the aliases the wire uses for it; a delta resolves to the newest call one of its aliases claims and none contradicts; the emitted id is minted separately, because the wire's id space is not injective and three layers downstream assume ours is. The remaining behaviour and the shapes it cannot decide are stated as measured output in [vercel/ai#18440](https://github.com/vercel/ai/issues/18440) and pinned case by case in the guard — read those rather than re-deriving either here.

**Delete it when the guard holds without it.** Remove the patch, reinstall, run `packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`, and read the result by property rather than by count: `assertInputsSelfContained`, `assertToolCallIdsUsable`, `assertEventLifecycle`. Cases marked `Known boundary, deliberately locked in` assert that an undecidable shape fails loudly; an upstream that genuinely fixed the layers below would turn those red for a better implementation, so treat a red run there as a signal to re-read, not a verdict.

## `@astryxdesign/core`: "New messages" must clear at the bottom and on a fresh transcript

Fixes [#2205](https://github.com/maka-agent/maka-agent/issues/2205). `ChatLayout` never resets two pieces of per-conversation state: `hasNewMessages` clears only through the button's `dismiss()`, so scrolling back down leaves the label up; and a conversation switch reuses the transcript container, so the previous conversation's last message stays the baseline and the new one's first message reads as unread.

The patch clears the flag whenever the scroll lock re-engages, so "at bottom" owns the badge; adds a `conversationKey` prop that re-locks and resets the baseline when it changes; and exposes `reset()` on `useChatNewMessages`. A prop rather than a remount — remounting drops an in-progress composer draft, since Astryx's composer holds its content in internal state.

**Delete it when** Astryx clears the badge at the bottom and offers a baseline reset on a conversation switch without a remount. Repro: scroll up, receive a message, scroll back down; then switch conversations with the badge active — the new conversation must start clean and the composer draft must survive.

## `@astryxdesign/core`: `List` must render the accessible name its interface accepts

Fixes [#2189](https://github.com/maka-agent/maka-agent/issues/2189). `ListProps` extends `BaseProps`, which includes `aria-label`, but `List` destructures a fixed prop set and drops it, so six Maka lists pass localized names that disappear at runtime. The patch forwards `aria-label` to the root list — narrower than spreading the rest of `BaseProps` through a vendored component, and it leaves the `header` / `aria-labelledby` path alone.

**Delete it when `packages/ui/src/__tests__/astryx-list-accessible-name.test.tsx` passes without the patch.**

## `@astryxdesign/core`: a collapsed tool group must still say what it changed

A contiguous run of tool calls is one group, and a group collapses by default. The collapsed header projects the latest call's status icon, name and `target` alone — `additions`, `deletions`, `duration` and `stats` are all dropped — so the commonest shape, several edits in one turn, is the one that shows no counts. Nothing reaches that header from the product side; the `label` prop it accepts is destructured and never used.

The patch adds group-level `additions` / `deletions` and renders them beside the wrench count on the collapsed header. `ToolTrow` passes the run's total; the per-call counts stay on the rows inside.

**Delete it when `packages/ui/src/__tests__/tool-trow-stability.test.tsx` passes without the patch** — its grouped-diff case asserts the summed `+N` / `-N` on a collapsed run.

## `@astryxdesign/core`: a tool row may activate a linked surface

Some tool calls produce a durable surface rather than inline detail. A linked subagent session is the first consumer: its transcript is the detail, and Maka opens it in the main chat column. `ChatToolCalls` only supported disclosure, so the product had to nest a custom card and Open button inside `resultDetail`.

The patch adds generic per-call `onActivate` and `activateLabel` fields plus a stable row slot. An activatable row uses the existing hover and keyboard treatment and includes the action in its accessible name without replacing the visible status and error text. It adds no trailing icon: activation may switch a surface in place, so the component must not imply external navigation. Activation takes precedence over inline detail. The row slot lets product typography stay consistent without pretending that an unlinked row is interactive. Maka keeps activation and inline detail mutually exclusive.

Patch-package does not change `package-lock.json`, so the desktop app and Storybook hash the patch contents into a Vite plugin name. Vite includes plugin names in its dependency-cache key; a changed patch therefore invalidates the old `ChatToolCalls` while every Astryx entry remains in the same optimized module graph.

**Delete it when `packages/ui/src/__tests__/subagent-open-session.test.tsx` and the desktop CU path pass without the patch** — linked subagent rows must be directly activatable without a Maka-owned nested card in both Node and Vite resolution modes.

## `@astryxdesign/core`: a blank UA-CH platform must not decide "not Apple"

`Kbd`'s ⌘/Ctrl display and `useHotkeys`' `mod` binding share one platform
probe that prefers `navigator.userAgentData.platform` over the deprecated
`navigator.platform`. Electron bundles whose identity was rewritten after
copy (the ad-hoc-signed `Maka Dev.app` the TCC workflow builds) ship UA-CH
**empty** — `platform: ''`, `brands: []` — and the probe read the blank as
"not Apple": on macOS every `mod` hotkey listened for Ctrl (⌘+/ stopped
opening the keyboard help) and every keycap drew Ctrl. The patch treats a
blank `uaData.platform` as absent and falls through to `navigator.platform`;
a non-blank value keeps deciding exactly as before.

**Delete it when** the guard in `apps/desktop/e2e/keyboard-help.spec.ts`
(the "blank UA-CH" test, which fakes `platform: ''` + `MacIntel` via an init
script) passes without the patch — that means Astryx's own probe learned to
distrust the blank.
