@yetone Walked both reports through the code — nothing to patch here: what @C2345 asks about is already supported, and the OpenCode half needs one data set from @zero-face to say where its 272k came from.

**The two numbers in `magpie-models.json` are two different things, by design.** @C2345's own read is exactly right: `context_window` is the model's whole window; `auto_compact_token_limit` is where magpie tells Codex to compact, taken from Settings → Long conversations. Its default, 272000, is magpie's shared default (kept since #876, set for Codex's long-turn latency after a DeepSeek model's ~550K turns waited 70–90s for a first token) — it is not Claude's and not a context window. A compaction firing at 276,553 tokens is that 272,000 threshold being crossed, exactly as the log says.

| Report | Check |
| --- | --- |
| 272000 is a separate auto-compact threshold, not the context window (C2345) | Confirmed, by design: Long conversations' default is written as `auto_compact_token_limit` beside `context_window`, and only when it is below the model's window (`internal/codexcat/codexcat.go`) |
| Codex should take a top-level override, so the regenerated file never needs hand edits (C2345) | Already supported, three ways — below |
| claude's default 272k leaks into OpenCode's compaction window; no isolation (zero-face) | Not on any path magpie writes: OpenCode is told the model's full window, never the compact threshold — data requested below |

**The top-level override already works:**

- Codex itself reads `model_auto_compact_token_limit` (and `model_context_window`) in `config.toml` — at the top level or in the chosen `[profiles.<profile>]` — before anything magpie's catalog says: the first is where it compacts, whatever the catalog says (codex-rs models-manager, `with_config_overrides`). A key there pins the threshold across every regeneration of `magpie-models.json`. Both keys are top-level, so they apply to every model.
- magpie knows about such keys: Long conversations shows "Codex's config.toml sets model_auto_compact_token_limit, read before Long conversations" with a take-it-out button (`internal/agent/codex_compact_held.go`, since v0.1.2289).
- Without touching `config.toml`: Long conversations → Compact at / Full window (global), each agent's own Long conversations for Codex, Claude Code and Grok Build (since v0.1.2910), or a model's / provider's own Compact at in Model settings — each of these flows into the generated `magpie-models.json` by itself; the file is never meant to be hand-edited.

**Why that 272k cannot reach OpenCode's compaction window through magpie:** the auto-compact window is written only where Codex and Claude Code read it — Codex's catalog (`auto_compact_token_limit`) and Claude Code's own `settings.json` (`autoCompactWindow`, `modelSettings.<id>.autoCompactWindow`). magpie's provider block in `opencode.json` gives each model `limit.context` set to the model's whole window (`internal/agent/agents.go`, magpieProviderJSONAt: without it OpenCode wouldn't know when to compact), and OpenCode compacts on its own reading of that limit — for a 1M model nowhere near 272k. Pi, Crush, ZCode and MiniMax Code get the same full window. So the isolation zero-face expects is already in place at every point magpie writes.

**@zero-face — three values will pin down where your 272k came from:**

1. the model id you ran in OpenCode,
2. in your `opencode.json`, the magpie provider's `models.<id>.limit.context` for that model,
3. your magpie version.

If that `limit.context` really says 272000, something set it — a Context window typed on the provider or the model, or a routing group's context size — and those three values will say which.

**Not verified**: OpenCode's own compaction on a live session (its client-side reading of `limit.context` — not run here).

AI use: analysis and verification written by GLM-5.3-Flash (ZCode) working for ggbdpq.
