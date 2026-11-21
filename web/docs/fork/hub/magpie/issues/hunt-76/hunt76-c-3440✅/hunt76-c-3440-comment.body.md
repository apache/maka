<!-- Downgraded to a diagnosis: the 272K setting's delivery path (the model list
     magpie serves) never reaches the ChatGPT account's own entries by design
     (#674/#1385/#976), the reported numbers match Codex's own stock default, the
     value in play is magpie's default (a 272K pick is stored as CompactAt 0, so
     any red-line-respecting override cannot fire for it), and both remaining
     levers (rewording the setting, extending its scope) are the maintainer's
     product call. No patch. -->

Took this and traced it on `dd1e8822`. Your reading of the behavior is right, and your `codex_backend.go` pointer was the right neighborhood — the line has drifted: on current main that logic sits at `internal/gateway/codex_backend.go:1717-1728`. The short version: the setting's whole delivery path is the model list magpie serves a Codex that runs through magpie, and the ChatGPT account's own entries in that list deliberately keep the backend's window — so `gpt-6.1-sol` compacts against 475000 per Codex's own default, and 359K/373K never gets there. So the patch my take promised does not follow: every lever here is either already in place (below) or the maintainer's product call. Details.

## Where "272K" actually reaches Codex

- The stored setting is `settings.Compact()`: `CompactAt`, else `WorkingWindow` = 272000, 0 under Full window (`internal/settings/settings.go:1025,1046-1054`). You're right that the missing `compactAt` field is not a save failure: picking 272K is normalized back to 0, i.e. the default (`SetCompactAt`, `internal/provider/compact.go:227-229`; pinned by `TestSetCompactAt`, passing on `dd1e8822`).
- Delivery is the `context_window` field of the model list magpie hands Codex: for magpie's catalog models `CompactFor` (`internal/provider/compact.go:44-52`) turns the threshold — the default 272K included — into `context_window`, with the real window as `max_context_window` (`internal/codexcat/codexcat.go:694-713`; pinned by `TestCodexCatalogCompactAt`, passing). This only reaches a Codex that asks magpie for its list.
- The account's own entries in the same answer are stamped at `codex_backend.go:1717-1728`, and the only override applied there is a window the user set on the codex provider (`provider.CodexNativeWindow`, `internal/provider/codex_models.go:560-588`, #674 — "a model with none set keeps the backend's"). No compact threshold is applied to them. Two more design lines keep the official entries native: a Codex in failover-only mode "keeps to its own models" (`internal/agent/codex.go:914-929`, #1385), and compaction of Codex's own models relays as it came (#976). So the setting's scope today is the models magpie lists, consistently in four places — but the text doesn't say so: "Codex and Claude Code compact at 272K (non-Claude [1m] too) or the size typed" (`internal/gui/assets/index.html:443`, zh at `internal/gui/assets/i18n.js:1038`). Stating the scope is a fair ask; the wording is the maintainer's.

## Why that session compacted at nothing

A rollout recorded as provider `openai` was created on Codex's built-in provider (magpie's connection writes `model_provider = "magpie"`, `internal/agent/route.go:23`). Two shapes fit, and the numbers agree with both:

1. The session never asks magpie for a model list — the Codex App on its own login talks straight to the backend, and nothing in magpie's catalog path can reach it.
2. magpie's account failover is on: `openai_base_url` points at the gateway (`internal/agent/codex.go:850-913`) while the provider stays `openai` — then `/backend-api/codex/models` is magpie's (`internal/gateway/codex_backend.go:35,78-79`), but the official entries keep the backend's windows exactly as in (1). You can tell the shapes apart by `openai_base_url` in config.toml, or by magpie's models appearing in the picker.

Either way Codex runs its own default. In current codex-rs (`openai/codex` main `970111f6`, `codex-rs/protocol/src/openai_models.rs`, `auto_compact_token_limit()`), with no `model_auto_compact_token_limit` set, compaction triggers at 90% of the model's resolved context window, min the entry's own limit: 475000 × 0.9 = 427500. Your largest single-turn total (373,207) is below it — no compaction, no `compacted` event, stock behavior for that model, not a magpie fault. (Your session's CLI was an alpha; the exact constant may differ a little, but the numbers fit.)

## Why I didn't patch it

1. **Carry the threshold onto the official entries in the served list.** The value in play would be the default, and the settings can't tell "picked 272K" from "never touched" — both are `CompactAt` 0. Pushing magpie's default onto the account's own models would silently move every failover user's official models (475000 is OpenAI's own entry value for `gpt-6.1-sol`; most entries do say 272000, newer ones don't). #674's contract is explicit — "nothing else in it changes; a model with none set keeps the backend's" — and overriding it is a product decision I'd rather not make unilaterally. Explicit thresholds only (a typed size, or the provider's Compact-at — which today also reaches only magpie's models) would not fire for your 272K pick at all.
2. **Have the toggle write `model_auto_compact_token_limit` into config.toml.** That key is global — every model, every session, unrouted ones included — while the catalog path is per-model; and config.toml writes are the "Tuned for you" surface's job, with its own stash/undo (`internal/agent/tune.go:92`). Folding a global write into the Settings toggle silently is a scope change, not a missing line.

A patch taking road (1) is already up in this thread (skygunner's `fix/issue-batch-1024pm`, e9926d70): per its description, the threshold — the default 272K included — stamped onto the account's own entries when no user-set window exists, the backend's window kept as `max_context_window`, and the list tag always carried so cached lists refresh once. I have not reviewed the code; what the trace above says is what such a patch decides on everyone's behalf: the default, not a size the user typed, moves OpenAI's own entry values (475000 on `gpt-6.1-sol`) for every failover user who never touched the setting. Whether that trade is wanted is the maintainer's call.

## What works today, without a patch

- Session through magpie (connected, or failover): set the model's window on the codex provider (`codex/gpt-6.1-sol` 272000, or `codex/*`) — #674 puts it on the official entry (`context_window`, max raised to it) and Codex compacts at 90% of that (~245K).
- Session that never touches magpie: `model_auto_compact_token_limit = 272000` top-level in `~/.codex/config.toml` reaches it regardless of routing — by hand, or via the "Tuned for you" advice, which puts the key in and takes it back out.
- Or run those conversations on magpie's models, which the setting covers by default.

If the maintainer wants the scope moved — thresholds carried onto the account's own entries, or the setting's sub-text saying what it covers — I'm glad to build either behind a red test. Both are product calls, so I'm leaving them here rather than slipping a patch in.
