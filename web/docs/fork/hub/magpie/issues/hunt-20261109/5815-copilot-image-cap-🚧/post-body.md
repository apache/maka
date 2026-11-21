@yetone — thank you @ghjkllasdf-fake for the sharp diagnosis: the report already names the exact seam, `summaryTooLarge` in `internal/gateway/codex_backend.go`, and the local mock regression reproduces what we saw on real traffic down to the wording Codex is told.

**Root cause**: Copilot answers the summary request 400 `Exceeded maximum number of images (50) allowed in the request` — a budget of its own. `codexCompact`'s one-ask-again-as-text chain (`codex_backend.go:3666`) fires on `lacksEndpoint || itemNotFound || inputKindRefused || upstreamFailed || protectionRefused || summaryTooLarge || protectionWords`; of these, `summaryTooLarge` (`codex_backend.go:3897`) is the one for "the request was refused for how much it carries": a 413 past the vendor's byte cap, or `overflowed` — a 400/413/422 whose words name the model's token window. The image count matches neither: a request under the window and the byte cap still exceeds the 50-image cap, and the words of neither say so. So the refusal fell through every recovery branch to the plain failure path (`codex_backend.go:3721`), went back to Codex as `compaction: copilot (...) answered the summary request 400 Bad Request: …`, and was counted by `compactFails` — the session could neither compact nor go on until its own history shrank below the cap by luck. That is exactly the reporter's read; the fix lands at the same seam rather than beside it.

**The fix**: `summaryTooLarge` now also reads an image-count refusal — a 400 or 422 whose body says `maximum number of images` or `too many images` (matched decoded, `wordsOf`, as the other refusals are, so a relay's `\uXXXX`-escaped body reads the same; #1669). Asking again with the conversation as text is precisely what the existing channel does about it: `plainCompact` keeps only text parts, its images left out, so what was over the count is under it. Two boundaries held on purpose:

- Nothing provider-specific is matched: no vendor's name, no vendor's number — "50" appears nowhere, "Copilot" appears nowhere, so another provider's cap at another count is read the same. And it is not a rate limit: a per-minute/pacing cap ("images per minute") matches neither phrase, and a refusal that counts how *fast* is no reason to ask again as text.
- Ordinary turns keep their images. The classification lives in `summaryTooLarge`, whose only caller is the compaction summary's ask-again chain; the generic `overflowed`/`tooLongRe` pair is untouched, so `retryable`, the routing loop's member-picking and the window estimates keep their token-and-bytes reading for task turns — a task turn refused over images is still allowed to fail over to another member rather than be told "compacting won't help", and its images are never dropped behind its back.

Sibling-face scan of the same family, each point left or changed with its reason:

- `overflowed` (`gateway.go:10593`) and `tooLongRe` (`gateway.go:10585`): the token-window family, four callers — `failure`'s class (`routing.go:593`), `retryable` (`fallback.go:1863`, "the conversation is as long on every account, the agent is told, and compacts"), the routing loop's pick of a member with a bigger window (`gateway.go:4493`) and the window-margin estimate (`fallback.go:1985`). Left: an image-count cap is none of those — a model with a bigger window can hold the same 50-image cap, so folding the count into `overflowed` would wrongly tell the routing loop "no member of this provider helps" for task turns, and the reporter's ask to preserve visual inputs for ordinary turns rules the fold out. The compaction summary is the one request whose images may go — that is what a summary is.
- `inputKindRefused` (`codex_backend.go:3920`): the summary ask-again chain's refusal of an *item kind* (`unsupported_input_item`, #5181/#5259). Left: a separate shape and word list; an image-count refusal matches neither `unsupported_input_item` nor `unknown item type`.
- `itemNotFound` (`codex_backend.go:3904`), `lacksEndpoint`, `upstreamFailed`, `protectionRefused`: the chain's other members, each its own shape (a lost item id, a missing endpoint, a relay's own word, the ChatGPT backend's 502). Left: none reads an image count.
- `zhipuImageRefusal` (`webp.go:35`): GLM's refusal of a picture *format* it cannot read (webp), routed to per-image transcoding. Left: format, not count; its remedy (re-encode each image) is the opposite of a summary's (drop the images).
- `imageRefusedWords` (`vision.go:837`): a model without vision refusing any image at all, served by the Vision description chain. Left: capability, not count.

Failure semantics: if the error body is empty, undecodable or says none of the phrases, `imageCountWords.Match` is simply false and `summaryTooLarge` answers exactly as before — the refusal keeps its old path (terminal, or whichever other class reads it); no new failure mode is introduced. `plainCompact`'s own failure semantics are unchanged (an unparsable body returns the original request, as it did).

Test: `TestCodexCompactImageLimitAsksSmaller` (in `codex_compact_too_large_test.go`, beside its 413 and overflow siblings) drives a mock Responses/Chat upstream that answers the summary request with Copilot's exact 400 body and then a summary: before the fix it fails in both protocols with the exact error from this report (`compaction: fake (…) answered the summary request 400 Bad Request: … Exceeded maximum number of images (50) allowed in the request.`), after the fix Codex gets 200 with the model's summary, and the last ask is asserted to carry the conversation as text — no image bytes in it, the textual findings preserved. Ablation check: reverting only `codex_backend.go` to the branch's parent commit with the test kept turns the test red again (both protocols), restoring it turns it green.

<details><summary>patch: gateway: an image-count cap is a summary too large, asked again as text — git am applies it as is; SHA-256 first 16: 11b6d298e973a135</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:09:09 +0800
Subject: [PATCH] gateway: an image-count cap is a summary too large, asked
 again as text

Copilot answers a summary request carrying a session's screenshots
400 "Exceeded maximum number of images (50) allowed in the request"
(#5815). The count is a budget of its own: a request under the model's
window and the vendor's byte cap still exceeds it, and neither the 413
nor the window's words match it, so the refusal went back to Codex as
the compaction's failure and the session could neither compact nor go
on until its own history shrank below the cap by luck.

summaryTooLarge now reads an image-count refusal too: asked again with
the conversation as text, its images left out (plainCompact), what was
over the count is under it. No vendor's number and no provider's name
is matched, and a rate limit's "images per minute" matches nothing.
Ordinary turns keep their images: only the summary's refusal is asked
again, and overflowed's callers (retryable, the members a window is
worth) keep their token-and-bytes reading.

Fixes #5815
---
 internal/gateway/codex_backend.go             | 36 +++++++++++++---
 .../gateway/codex_compact_too_large_test.go   | 43 +++++++++++++++++++
 2 files changed, 72 insertions(+), 7 deletions(-)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index e260c0669..6a0c1d865 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3886,18 +3886,40 @@ var upstreamFailedWords = regexp.MustCompile(`(?i)upstream request failed`)
 
 // summaryTooLarge is a summary request refused for its size: past the
 // vendor's byte cap (413; DeepSeek's "Failed to buffer the request body:
-// length limit exceeded", celestial_eagle_99230 on Discord) or past the
-// model's window. Codex's remote compaction asks nothing smaller after
-// either (it trims only by its token estimate against the catalog's
-// window, and a 1M window holds more bytes than the cap takes), so told
-// of it, Codex could neither compact nor go on. The summary is asked
-// again as text, its images left out and long outputs cut
+// length limit exceeded", celestial_eagle_99230 on Discord), past the
+// model's window, or carrying more images than the vendor takes in one
+// request (Copilot's 400 "Exceeded maximum number of images (50) allowed
+// in the request", #5815). The image count is a budget of its own: a
+// request under the window and the byte cap still exceeds it, and the
+// words of neither say so. Codex's remote compaction asks nothing smaller
+// after any of them (it trims only by its token estimate against the
+// catalog's window, and a 1M window holds more bytes than the cap takes),
+// so told of it, Codex could neither compact nor go on. The summary is
+// asked again as text, its images left out and long outputs cut
 // (plainCompact), and compacted without a model when that is refused
 // too.
 func summaryTooLarge(rec *recorder) bool {
-	return rec.status == http.StatusRequestEntityTooLarge || overflowed(rec.status, rec.body.Bytes())
+	if rec.status == http.StatusRequestEntityTooLarge || overflowed(rec.status, rec.body.Bytes()) {
+		return true
+	}
+	// an image-count refusal comes as a request error whose words say so:
+	// it is not a rate limit's ("images per minute"), which counts how
+	// fast, so asking again as text is no answer to that
+	switch rec.status {
+	case http.StatusBadRequest, http.StatusUnprocessableEntity:
+		return imageCountWords.Match(wordsOf(rec.body.Bytes()))
+	}
+	return false
 }
 
+// imageCountWords say a request was turned away over how many images it
+// carries, not over its bytes or its tokens: Copilot's "Exceeded maximum
+// number of images (50) allowed in the request" (#5815). No vendor's
+// number is matched, and no provider is named, so another's cap and
+// another's count are read the same. Matched decoded, as the other
+// refusals are.
+var imageCountWords = regexp.MustCompile(`(?i)maximum number of images|too many images`)
+
 // itemNotFound is a 400 refusing an item of the input by its id, as Azure
 // OpenAI's and OpenAI's API answer one they never stored ("Item with id
 // 'rs_…' not found", #1008), which a relay in front of them passes on.
diff --git a/internal/gateway/codex_compact_too_large_test.go b/internal/gateway/codex_compact_too_large_test.go
index f523ea162..8cce20a48 100644
--- a/internal/gateway/codex_compact_too_large_test.go
+++ b/internal/gateway/codex_compact_too_large_test.go
@@ -24,6 +24,13 @@ const deepseekBodyCap = "Failed to buffer the request body: length limit exceede
 // window, OpenAI's words.
 const deepseekOverflow = `{"error":{"message":"This model's maximum context length is 1048576 tokens. However, you requested 1100000 tokens (1100000 in the messages, 0 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`
 
+// copilotImageCap is what Copilot answered a summary request carrying a
+// session's screenshots with (ghjkllasdf-fake, #5815): its cap on how
+// many images one request takes, an HTTP 400. The count is its own
+// budget: a request under the model's window and its byte cap still
+// exceeds it, and neither the words of the one nor of the other say so.
+const copilotImageCap = `{"error":{"message":"Copilot: Exceeded maximum number of images (50) allowed in the request.","type":"invalid_request_error"}}`
+
 // capped is an upstream that refuses a body of more than most bytes with
 // status and body (as ctype), and answers any other with a summary in its
 // protocol's stream. Every body it is sent is kept.
@@ -160,6 +167,42 @@ func TestCodexCompactTooLargeAsksSmaller(t *testing.T) {
 	}
 }
 
+// A summary request refused for carrying more images than the vendor
+// takes in one — Copilot's 400 "Exceeded maximum number of images (50)
+// allowed in the request" (#5815) — went back to Codex as that failure:
+// the count is a budget of its own, matched by neither the 413 nor the
+// model's window's words, and Codex's remote compaction asks nothing
+// smaller on it. magpie asks again with the conversation as text, its
+// images left out, and Codex installs the model's summary.
+func TestCodexCompactImageLimitAsksSmaller(t *testing.T) {
+	for _, proto := range []provider.Protocol{provider.Chat, provider.Responses} {
+		t.Run(string(proto), func(t *testing.T) {
+			up := &capped{proto: proto, most: cappedMost, status: http.StatusBadRequest, ctype: "application/json", body: copilotImageCap}
+			cappedOn(t, up)
+			code, body := codexPost(t, bigCompaction())
+			if code != 200 {
+				t.Fatalf("Codex's compaction failed: %d %s", code, body)
+			}
+			if got := compactedText(t, body); got != "SUMMARY" {
+				t.Fatalf("summary %q", got)
+			}
+			calls := up.calls()
+			if len(calls) < 2 || len(calls[0]) <= cappedMost {
+				t.Fatalf("asked %d times", len(calls))
+			}
+			small := string(calls[len(calls)-1])
+			if len(small) > cappedMost || strings.Contains(small, "iVBORw0KGgo") {
+				t.Fatalf("asked again as large (%d bytes) or with the image", len(small))
+			}
+			for _, want := range []string{"fix the login bug", "now add a test", "I fixed main.go"} {
+				if !strings.Contains(small, want) {
+					t.Errorf("the smaller ask lacks %q", want)
+				}
+			}
+		})
+	}
+}
+
 // When the conversation as text is refused too, magpie compacts without a
 // model, so Codex still goes on.
 func TestCodexCompactTooLargeCompactsLocally(t *testing.T) {
-- 
2.50.1 (Apple Git-155)
```

Branch: [`fix/5815-copilot-image-limit-retry`](https://github.com/ggbdpq/magpie/tree/fix/5815-copilot-image-limit-retry) at `a8b58ac01a034fd9155c2acaf8c611479c57ab81` (on `07a06617e`, current `upstream/main`).

Generated-by: GLM-5.3-Flash (ZCode)
</details>
