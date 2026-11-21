## Symptom

Every custom model magpie writes into `~/.factory/settings.json` (`custom:magpie/*`) is treated by Droid as non-reasoning: its session provenance logs show `{"setting":"reasoningEffort","value":"none","reason":["reasoning_clamped"]}`, and the off/low/medium/high picker stays locked — the user's configured effort silently never reaches the model. The gateway's `/v1/models` advertises reasoning levels for those models (e.g. `devin/swe-2` → `medium,high,max`; `codex/gpt-6.1-sol` → `low,medium,high,xhigh,max,ultra`).

## Root cause

`droidEntriesAt` (internal/agent/droid.go) emits each `droidEntry` with `{model, id, displayName, baseUrl, apiKey, provider, maxContextLimit, maxOutputTokens, noImageSupport}` — never `reasoningEffort`. Per Factory's BYOK docs, `reasoningEffort` on a custom model is what a new session starts at and what unlocks the picker; without it (and without a `baseModelId` Droid recognizes) Droid clamps to `none`. Magpie rewrites its entries on every sync, so hand-editing the file doesn't survive — the original droid support commit flagged exactly this as unverified ("magpie sets no reasoningEffort/enableThinking … how it sends thinking for a custom model … unverified"), and #2773's logs fill that gap: manually adding `"reasoningEffort": "high"` to a magpie entry makes Droid send the effort (confirmed in `usage.jsonl`).

## Fix

Each magpie entry now carries `reasoningEffort`: the strongest of the model's own levels Droid can spell (its picker tops at `high`, so a model reasoning past that still starts at `high`), and a model with no levels at all goes without the key — Droid's `none` being right for it. A user's own entry is untouched, as is everything else magpie already wrote. Entries magpie already wrote get the field on their next Sync or model pick (magpie rewrites its own entries there by design — a `reasoningEffort` hand-added to a magpie entry does not survive that rewrite, the same as every other field of a magpie-managed entry).

## Verification

| Check | Result |
| --- | --- |
| `TestDroidReasoningEffort` (base `5380114d`): three reasoning models (levels `medium,high,max` / `xhigh,max` / `low`) and one without levels, applied through magpie | red before — all three written with no `reasoningEffort`; green after — `high` / `high` / `low`, and the level-less model and the user's own entry go without the key |
| `-race` on the test | green |
| Ablation: `droid.go` restored to `upstream/main`, test kept | the same three fail again |
| Mutation: the above-high fallback dropped | exactly the ceiling subtest red |
| `TestDroid*` family; full `internal/agent` suite (193.9s) | green |
| `gofmt -l`, `go vet ./...`, linux/windows vet, darwin/linux/windows builds | clean (the known `trayimage` cgo warning aside) |

## Not verified

A real Droid CLI end to end (the reporter's `usage.jsonl` confirmation of `high` is the behavioral evidence this builds on); the Droid picker's exact set beyond the docs' off/low/medium/high; Windows.

---
**Source**: reported in #2773, from the reporter's session logs and a hand-edit confirmed in `usage.jsonl`.

**Siblings**: `rg -n "droidEntry" internal/agent` → one builder (`droidEntriesAt`); Sync, Apply and Check all read through it, so one write covers every path. The user's own entries are never rewritten by magpie.

**When the read fails**: a model whose catalog facts carry no levels goes without the key (Droid's `none` is then correct for it); nothing is invented for a model magpie knows nothing about.

**Not verified**: real Droid CLI end to end, Windows.

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
