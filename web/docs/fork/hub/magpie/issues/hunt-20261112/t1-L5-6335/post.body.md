Verified against current main (`873b4987e`): the mechanism you describe is real, and the timing attribution is right — magpie's side did not change on Nov 11; what changed is how Claude Code 2.1.317 presents what it is given. Where this should go next is a maintainer design call, and the channel your fix would ride already exists and is proven in flight (#5445), so I've written up the facts and the constraints rather than a patch.

**What magpie does today**

- A managed interactive run's `append.md` is written from `leanSystem(req)` (internal/gateway/claude_subscription.go:5115), which is exactly `withoutBillingHeader(req.System) + envNote(req) + toolChoiceAsk(req)` — the caller's system prompt, nothing of the first user turn. Your `append.md` finding matches the code.
- Everything in the caller's first message — including its `<system-reminder>` blocks (CLAUDE.md, MEMORY.md, output style, MCP instructions, UserPromptSubmit hook output) — is rendered into the pasted first text by `renderClaudePrompt` (:4893). The interactive mode pastes that one text; that shape is long-standing (its cache mechanics are the ones tuned in #2432), and `appendsPrompt` (:5094) only ever moves the *system* side out of the paste.
- So the paste content magpie sends did not change on Nov 11; what changed is Claude Code 2.1.317's harness, which now wraps a typed-in block as `<pasted_content>` and tells the model that instructions inside pastes are followed only where the user's own message asks. Your transcript evidence (26 bridge runs from 2026-11-11 04:06 UTC, none before) is consistent with a winget-side client update, not a magpie commit — none of the bridge changes around that date touch `leanSystem`, `renderClaudePrompt` or `appendsPrompt`.

**The fix channel you suggest exists**

`--append-system-prompt-file` already carries caller-level context past the paste, and #5445 (in flight, rebased onto 2026-11-10 main with its tests green) uses exactly that file to carry the Library's instructions text. Standing user-level context riding the same file is the natural extension.

**Why I'm not patching it here**

Three constraints make "lift the reminder blocks" a design decision rather than a mechanical fix, and this area is under active rework right now (the bridge has several fresh commits, including work-in-progress ones):

1. Not every reminder block is standing instruction. `CLAUDE.md`/`MEMORY.md`/output style are; a `UserPromptSubmit` hook's output is turn-scoped data that may be meant to be read *in* the turn — lifting it into the system prompt changes its lifetime and precedence, and it also makes the appended block differ per conversation.
2. Cache marks. The appended block is one of the cache-stable parts of a run; a per-conversation-varying `append.md` re-creates exactly the churn the #2432 move (paste → append file) was made to avoid, and resumed/replayed runs (`replaySession`, `savedSession.appended`) must keep the marks the run was started with.
3. #6280. Where the caller's CLAUDE.md is the same file as Claude Code's own user memory, lifting the caller's copy into `append.md` while the client also injects its own risks the double injection that issue tracks.

**Meanwhile**

Until a direction lands, restating a standing rule in the turn's own words is the reliable path — that is the one case the pasted-content rule itself carves out.

**Checked**: `leanSystem`/`appendsPrompt`/`renderClaudePrompt` at `873b4987e`; the bridge commits from 2026-11-10 to today, none of which touch those three functions' treatment of message content. **Not verified**: a live Claude subscription bridge from here (no subscription); your local transcripts are your own evidence, quoted as such.

**Attribution**: written with GLM-5.3-Flash (ZCode).
