How magpie's sync decides which API format ZCode gets, and where your retained anthropic endpoint can win — read from the code (main at `c86fa2a34`), with one candidate defect and what would pin it.

## What the sync writes

Two files, both from one read of the format:

- `config.json`'s `provider.magpie` — `kind` is one of `anthropic` / `openai-compatible` / `openai`, from `zcodeFormat` (`internal/agent/zcode.go:264`), `options.baseURL` is magpie's own gateway address, never a vendor URL.
- `provider_config.json`'s rule for `providerId: "magpie"` — `api.type` (anthropic-messages / openai-responses / openai-chat-completions) and the models' rules (`zcodeRules`, `internal/agent/zcode.go:443`).

## How the format is read

`zcodeFormat` (`zcode.go:264`) reads three things, in this order of precedence:

1. `config.json`'s `provider.magpie.kind`.
2. `provider_config.json`'s first rule naming magpie with a known `api.type` (`zcodeRuleFormat`, `zcode.go:292`).
3. Neither present: `anthropic-messages`.

When 1 and 2 disagree — "the user changed one of them in ZCode" — the file **written last** wins, by `ModTime` (`zcode.go:282-287`). The comments say the intent: both files are written together by a sync, so a difference means a hand edit, and the newest one carries it.

## The candidate defect: first rule wins

`zcodeRuleFormat` returns the **first** magpie rule with a known type:

```go
for _, p := range r.Config.ProviderConfigRules.ProviderRules {
    if _, ok := zcodeKinds[p.Config.API.Type]; ok && p.ProviderID == magpieID {
        return p.Config.API.Type
    }
}
```

If your "duplicate to create another API" left **two** rules naming magpie in `provider_config.json` — the old `anthropic-messages` one and your switched `openai-responses` one — the read takes whichever sits first, and a sync then writes that format into both files. The write side collapses duplicates (`zcodeRules` keeps one magpie rule, at its old position, `zcode.go:468-475`), but the **read** that decides the format happens before it, so the stale rule can win the round and be the one restored. That matches "同步后默认使用 anthropic 端点": every sync re-reads the first rule and re-tilts to it.

## What would pin it

Two things from your machine, and the fix follows from which is true:

1. `provider_config.json` (the `providerRules` entries with `providerId: "magpie"` — keys and URLs redacted): are there two? Which `api.type` does the first carry?
2. The two files' `mtime` at the moment the wrong endpoint is in use: if `config.json` is always newest (a sync rewrites it), the tie-break always lands on `config.json`'s `kind` — a pick recorded only in the rules file loses every sync, even with a single rule.

## Candidate fixes, by finding

- Two rules: read the rule the user last chose — the one whose type differs from `config.json`'s when they disagree, or simply the last magpie rule rather than the first — and collapse duplicates on the read side too.
- Single rule, mtime always tilted by the sync's own write: the tie-break compares mtimes of files one of which the sync itself refreshes; the sync should carry the user's pick instead of re-deciding it (write both files from the picked side, or record the pick once and honor it).

Both are small diffs, but which one is right depends on the file state, and I'd rather not guess: a patch aimed at the wrong half of this would "fix" the symptom by re-tilting the same tie-break the other way.

---
**Source**: reported in #4970 (huajiqaq); code read on main `c86fa2a34`.

**Not verified**: your machine's `provider_config.json` / `config.json` state — the issue's "复制创建新接口" is ZCode's own settings UI, whose writes magpie doesn't make and can't see; the duplicated-rule shape above is a candidate, not a finding about your files. ZCode's side of the retention (its "More endpoints" list keeping the old entry) is its own UI state; magpie writes one baseURL and one kind, so what ZCode keeps beside them is ZCode's.

**Attribution**: AI-written; I've read the whole diff (none yet — this is an analysis) and the read paths cited. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
