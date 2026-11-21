I dug into this end to end at magpie `647323409` (current `main`) and could not find a magpie-side path that raises one model's compaction threshold because another model was switched to. magpie's context-window and threshold surfaces are all keyed per model, and switching the active model changes none of them. What I verified, and what would pin the real cause down:

**1. The catalog magpie hands Codex is rendered per model, never from the active model**

`codexcat.entriesAt` (`internal/codexcat/codexcat.go:302-318`) takes each model's window from its own `m.Context` and the threshold from `min(m.Compact, work.Working(c))` — `work` is the global Long-conversations setting, `c` the model's own window. The active model appears nowhere in the rendering input. Two tests lock this per-model behaviour at `main`: `TestCodexCatalogCompactAt` and `TestCodexWindowShownCompactApart` (`internal/codexcat/compact_test.go`) both pass at `647323409`. The same holds for the models.json file magpie writes for a routed Codex (`internal/agent/codex.go:304-310`, `ownList` → `codexcat.CatalogUsed(magpieModels("codex"), …)`) and for the `/v1/codex/models` answer (`internal/gateway/codex_backend.go:2137-2149`, `codexMerged` covers each entry by its own slug).

**2. Switching the active model writes no window anywhere**

What a switch writes is `model` in `~/.codex/config.toml` (`internal/agent/codex.go:1422-1431`), plus, when the new model doesn't take the current effort, `model_reasoning_effort` and a re-render of the same per-model list (`settle`/`relist`, `internal/agent/codex.go:524-570`). magpie never writes `model_context_window` — that key appears in magpie only as a read (agent.CodexCompactHeld, which the Settings page surfaces as a "your config holds" row) and in session files Codex itself wrote. `model_auto_compact_token_limit` is likewise only read or removed, never written (tune migrated its own old writes away — `internal/agent/tune.go:129-160`). So the config-global override the report suspects (window 1M applying to every model, compaction at 900K) would have to come from a key in the config that magpie does not write.

**3. Where a cross-session effect can come from: Codex's own daemon**

`internal/agent/codex_daemon.go:16-26` documents the relevant Codex behaviour: the background app-server the codex sessions attach to **builds its model list once, as it starts, per CODEX_HOME, across terminals**. A change to what Codex reads reaches no session until that daemon restarts, and magpie restarts it itself only when no session is attached. Two consequences worth separating in this report: (a) with concurrent sessions attached, a switch should change nothing for the running sessions — the old list, with the old per-model windows, stays in force; (b) after a daemon restart (manual, or magpie's when it saw no attached session), every session's model info is rebuilt from the config and the list as they read then — that is the one moment a session's effective window can move. Which of these happened is exactly what the evidence below can tell.

**4. One real gap nearby, already on file**

For a ChatGPT subscription's own models reached beside the sign-in, magpie overwrites only `context_window` and never writes an `auto_compact_token_limit` (#3440, still open): those sessions compact at Codex's own 90%-of-window rule or at a `model_auto_compact_token_limit`/`model_context_window` in the config. If either session in this report is a subscription model on the `openai` provider, its threshold was never magpie's number to begin with — but that still doesn't cross sessions.

To pin it down, from the machine where this happened:

1. The rollout JSONL of the 500K session: the `token_count.info.model_context_window` field before and after the switch. 500000 before and after means Codex's own threshold logic moved; 1000000 after means the model info was rebuilt from somewhere — and the source it rebuilt from is then the next thing to read.
2. `~/.codex/config.toml` before and after the switch (secrets redacted): whether `model_context_window`, `model_auto_compact_token_limit` or a `[profiles.*]` with either appears, and what `model` says. The Settings page's Codex row lists these keys live (agent.CodexCompactHeld), so a glance there after the switch works too.
3. magpie's version, Codex's version, and how Codex is wired: magpie as its provider (`model_provider = "magpie"`), or beside a ChatGPT sign-in.
4. Settings → Long conversations: is Full window on, and is Compact at set?

A workaround meanwhile: set the window and Compact at for the small-window model explicitly in magpie (its provider's Names & levels, or Long conversations) — an explicit `auto_compact_token_limit` in its catalog entry pins the threshold for that model regardless of what the 1M session does.

Not verified: no reproduction here — the report's setup (two concurrent sessions, one per model, threshold read off the UI) needs the live daemon and subscriptions, and the issue has no versions or config dump yet. Everything above is code reading at `647323409` plus the two tests named, both green there; which layer owns the failure is open pending the evidence above.

**Attribution**: written with GLM-5.3-Flash (ZCode); the files, lines and test names above were read and run at magpie `647323409`.
