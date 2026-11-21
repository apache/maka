Took this (take above). The route's last hop — the Claude subscription — parses the turn for the bridge that drives the real Claude Code binary, and that parse is where the advisor goes: server tools are left out of the bridge's request, and the advisor's instructions in the conversation are told to be void. The run itself is never started with an advisor, so the model it serves has none to call, the turn answers 200, and nothing anywhere said why. This patch makes the leaving be said, on the line you reported; wiring the advisor to the run itself is laid out below as the question it really is.

**Cause** (read on `542ee03b4`): the subscription line enters at `serveClaudeSubscription`, whose parse (`readAnthropic`) takes only tools with an input schema — a server tool like `advisor_20260301` hits its `continue`, and the advisor instructions Claude Code put in the conversation are rewritten to "The advisor tool is no longer available" (`anthropic.go`, the `advisor_` branch). `advisorTools` (`advisor.go`), which fits the advisor to a vendor upstream as it is forwarded, is on the wire path — the subscription never gets there. So on this line the advisor can neither run nor be named, silently. Your first hop kept it, as you found: that hop is a passthrough, the model name rewritten by magpie's ids.

**The fix** — say it, once a turn that declares the advisor is served on the subscription line:

```diff
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -6319,6 +6319,13 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, from provider.Protocol, name, model, owner string, body []byte, usage *Usage,
 	} else {
 		req, err = parse(from, body)
 	}
 	if err != nil {
 		return writeError(w, from, 400, err.Error()), err.Error()
 	}
+	// Claude Code's advisor (/advisor, advisor.go) is a server tool only the
+	// vendor runs, and the run magpie drives is not started with it: the
+	// parse left it out and told the model it is gone. Said by nobody, the
+	// user only saw a model that never calls the advisor, on a 200 (#5514).
+	if name == "Claude Code" && bytes.Contains(body, []byte(`"advisor_`)) {
+		log.Printf("%s: the turn declares Claude Code's advisor, which the run magpie drives is not started with: the tool is left out, and the model is told it is gone", name)
+	}
 	// output_config's effort is the level the CLI thinks at (--effort), which
```

`"advisor_"` is the same sniff `advisorTools` itself opens with; the note is one line a turn, in magpie's log beside the bridge's other notes ("no run waits for this turn", "a new Claude Code is told the whole conversation").

**Why not the wiring itself (your 1.)** — it is a design decision more than a gap, and each part of it is a real cost:

- the switch is the user's own: the CLI takes the advisor from its settings (`advisorModel`) and the environment you named; magpie drives the account's real Claude home, so turning the advisor on per request means writing the user's settings or pinning an env whose model may disagree with what the caller's advisor tool declares;
- a kept-alive run serves turns for callers that disagree — one turn declares an advisor, the next (another client through your Remote magpie) declares none, and the process, started once, carries the advisor for both;
- the advisor's model arrives named by magpie's own ids (`claude/claude-opus-5-5` through your hop), which the run would need mapped, and the conversation's advisor instructions — today rewritten to "gone" — would have to be kept instead, with the tool references in history matched as the bridge's own tools are.

None of that is decided in this patch; the note is the ground every wiring would start from.

**Run** (darwin/arm64, Go 1.25.5, on `542ee03b4` + this):

- `TestClaudeSubscriptionSaysWhenTheAdvisorIsLeftOut` — red before, green after; `TestClaudeSubscriptionWithoutAnAdvisorSaysNothing` — green before and after (a turn with no advisor says nothing, as before).
- Ablation: the product change alone reverted turns the first test red again, the second stayed green.
- `go test -tags nogui -timeout 25m -count=1 ./internal/gateway/`: ok 682.9s, nothing new red.
- Targeted `-race` on the two: ok. `gofmt -l`: clean. `go vet -tags nogui ./internal/gateway` on darwin and GOOS=linux: clean. `go build ./...`: ok.

Sibling faces, read not changed: the translate path (`parseTranslated`) drops the advisor the same silent way when a Claude turn goes to Chat or Gemini — same cause, different serve path, and this patch's note lives where the provider's name is known; left for its own face. The passthrough vendors keep today's behavior (`advisorTools` fits or drops the advisor by what the upstream can run — by design, and the model is told). Other agents' subscription lines are gated out — the advisor is Claude Code's tool. `count_tokens` never served the advisor and still answers an estimate; unchanged.

---
**Source**: reported in #5514 by UNIARG; every check above run locally on `542ee03b4` + this commit, none against a real Claude subscription or the live ChatGPT/Claude backends.

**Not verified**: a real Remote-magpie-to-subscription hop at run time (the note's wording read from the test's captured log); the CLI's advisor switch as an env of the run (named from your setup; untested here, and undecided in this patch); the translate face's wording.

**AI**: written with GLM-5.3-Flash (ZCode); I wrote the patch, ran the checks and can answer questions on it.

**Branch**: [`ggbdpq:fix/5514-advisor-remote`](https://github.com/ggbdpq/magpie/compare/main...ggbdpq/magpie:fix/5514-advisor-remote) — `72f0a847d` on `542ee03b4`.

**Patch**: `git format-patch -1 --zero-commit` of `72f0a847d15a02280b4a3083446796d9b9934116`; the patch as it am's hashes to `e686fda3cb339d27` (first 16 of the sha256).

*Attribution: diagnosis of the subscription parse as the drop point follows the reporter's own reading in the issue (`anthropic.go`'s `advisor_` branch); the note's wording and the wiring analysis are this patch's.*

*Generated-by: GLM-5.3-Flash (ZCode)*

