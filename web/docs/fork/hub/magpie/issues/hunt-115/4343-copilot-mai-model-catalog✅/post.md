**Symptom**

On a Copilot Enterprise account, `mai-code-2-flash` sits in the provider's saved model selections, but magpie's fetched Copilot catalog and every effective list omit it, and using the model fails with:

> copilot has no model mai-code-2-flash (magpie provider copilot lists them)

Meanwhile magpie's own provider tests for the same model returned HTTP 200 twice on `/responses` (and 400 on `/chat/completions`, Copilot's `no model endpoints available given user constraints`, the case #754 already explains).

**Minimal repro**

`TestCopilotSignAndModels` (internal/provider/account_test.go) drives `copilotModels` over a fake `/models` answer. The fixture now carries both shapes:

- `mai-code-2-flash`: `vendor: "Experimental"` + `model_picker_enabled: true` + `policy: enabled` + `supported_endpoints: ["/chat/completions","/responses"]` — must be listed; fails on the old code.
- `kimi-k3-base`: `vendor: "Experimental"`, no `model_picker_enabled` — must stay out.

**Root cause**

`copilotModels` (internal/provider/account.go) dropped every model whose vendor is `"Experimental"` before any other check:

```go
if m.Capabilities.Type != "chat" || copilotInternal.MatchString(m.ID) || m.Vendor == "Experimental" {
    continue
}
```

`mai-code-2-flash` is served with `vendor: "Experimental"` (per the metadata captured in the report), so it never reached the catalog; `Available()`, `Exposed()` and `serves()` are all built from that fetched list, hence the error. The other two filters were not at fault: the id matches no `copilotInternal` pattern, and the picker check (`!m.Picker && m.Category == ""`) passes. The catalog's 15 other entries show the Enterprise `/models` answer itself parses fine — the discovery discrepancy is magpie's filter, not the endpoint.

**Fix**

The vendor is now only one more reason a model no picker offers stays out; an Experimental model the picker offers is listed, which is what VS Code's own picker shows:

```go
if !m.Picker && (m.Category == "" || m.Vendor == "Experimental") {
    continue
}
```

One line. Siblings checked: the `Vendor == "Experimental"` filter lived only in `copilotModels`; `copilotSeen` already records each chat model's APIs regardless of vendor, so a newly listed model is negotiated onto `/responses` when its `supported_endpoints` say so, and a Copilot-side refusal flows through the existing `copilot_refused` machinery as before. Per-request cost is unchanged — `copilotModels` runs on catalog fetch, not per request.

**Verification**

| Check | Command | Result |
| --- | --- | --- |
| RED before fix | `go test ./internal/provider/ -run TestCopilotSignAndModels -count=1` | FAIL: ids `[gpt-5.5 claude-sonnet-5 gpt-4.1 auto]`, `mai-code-2-flash` missing |
| GREEN after fix | same | ok 1.072s |
| Ablation: product file reverted to de7953e3b, test kept | same | FAIL again; restored, ok |
| Package full | `go test ./internal/provider/... -tags nogui -count=1` | ok 101.742s |
| gofmt | `gofmt -l internal/provider/` | empty |
| vet | `go vet ./...` | exit 0 |
| Cross vet+build | `GOOS=linux/windows/darwin go vet -tags nogui ./internal/provider/ && go build -tags nogui .` | all exit 0 |

**Not verified**

- Against a real Copilot Enterprise account: no Enterprise credentials here, so the upstream `/models` entry for `mai-code-2-flash` (its `vendor` value and picker flag) is taken from the metadata in this report and the reported symptom, not reproduced end to end.
- The two `internal/gui` darwin cgo warnings `go vet` prints are pre-existing, on files this change does not touch.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(copilot): list an Experimental vendor's model the picker offers (#4343) — git am applies it as is; SHA-256 first 16: c45b2055544293b7</summary>

```patch
From 67dc6530a577050a7d6a637d7e5d5454986e07d4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 02:52:54 +0800
Subject: [PATCH] fix(copilot): list an Experimental vendor's model the picker
 offers (#4343)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: copilotModels dropped every model whose vendor is
"Experimental" before looking at anything else, so mai-code-2-flash —
an Enterprise account's, vendor "Experimental", model_picker_enabled
true, served on /responses — never reached the catalog. A saved
selection of it then failed everywhere with "copilot has no model
mai-code-2-flash (magpie provider copilot lists them)" (serves() is
Available() ∪ Exposed(), both built from the fetched list).

The vendor is now only one more reason a model no picker offers stays
out: an Experimental model the picker offers (model_picker_enabled
true) is listed, as VS Code's own picker shows it. One the picker
doesn't offer (kimi-k3-base) stays out.

Run: TestCopilotSignAndModels fails on the old code (ids end
"gpt-4.1,auto"), passes now; the fixture carries both shapes.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/account.go      | 9 ++++++---
 internal/provider/account_test.go | 7 +++++--
 2 files changed, 11 insertions(+), 5 deletions(-)

diff --git a/internal/provider/account.go b/internal/provider/account.go
index 406866660..93285ca65 100644
--- a/internal/provider/account.go
+++ b/internal/provider/account.go
@@ -1784,11 +1784,14 @@ func copilotModels(ctx context.Context, app copilotApp) ([]catalog.Model, error)
 	}
 	copilotSeenMu.Unlock()
 	for _, m := range v.Data {
-		if m.Capabilities.Type != "chat" || copilotInternal.MatchString(m.ID) || m.Vendor == "Experimental" {
+		if m.Capabilities.Type != "chat" || copilotInternal.MatchString(m.ID) {
 			continue
 		}
-		// a model no picker offers is an old snapshot or Copilot's own
-		if !m.Picker && m.Category == "" {
+		// a model no picker offers is an old snapshot or Copilot's own; an
+		// Experimental vendor's is Copilot's own too, unless the picker
+		// offers it (#4343: mai-code-2-flash, an Enterprise account's,
+		// served on /responses)
+		if !m.Picker && (m.Category == "" || m.Vendor == "Experimental") {
 			continue
 		}
 		switch {
diff --git a/internal/provider/account_test.go b/internal/provider/account_test.go
index 5009ee797..0f093778b 100644
--- a/internal/provider/account_test.go
+++ b/internal/provider/account_test.go
@@ -394,6 +394,7 @@ func TestCopilotSignAndModels(t *testing.T) {
 			  {"id":"claude-opus-5","name":"Claude Opus 5","model_picker_category":"powerful","policy":{"state":"disabled"},"capabilities":{"type":"chat"}},
 			  {"id":"gpt-4.1","name":"GPT-4.1","model_picker_category":"versatile","policy":{"state":"enabled"},"capabilities":{"type":"chat"}},
 			  {"id":"gpt-4.1-2025-04-14","name":"GPT-4.1","policy":{"state":"enabled"},"capabilities":{"type":"chat"}},
+			  {"id":"mai-code-2-flash","name":"MAI-Code-2-Flash","vendor":"Experimental","model_picker_enabled":true,"model_picker_category":"lightweight","policy":{"state":"enabled"},"supported_endpoints":["/chat/completions","/responses"],"capabilities":{"type":"chat","supports":{"reasoning_effort":["high"]}}},
 			  {"id":"kimi-k3-base","name":"Kimi K3 (GitHub)","vendor":"Experimental","model_picker_category":"powerful","policy":{"state":"enabled"},"capabilities":{"type":"chat"}},
 			  {"id":"exec-agent-a","name":"Exec","model_picker_enabled":true,"capabilities":{"type":"chat"}},
 			  {"id":"text-embedding-3-small","name":"Emb","model_picker_enabled":true,"capabilities":{"type":"embeddings"}}]}`
@@ -432,11 +433,13 @@ func TestCopilotSignAndModels(t *testing.T) {
 	for _, m := range ms {
 		ids = append(ids, m.ID)
 	}
-	if strings.Join(ids, ",") != "gpt-5.5,claude-sonnet-5,gpt-4.1,auto" || len(ms[0].Efforts) != 2 {
+	// an Experimental vendor's the picker offers stays listed (#4343), one
+	// it doesn't (kimi-k3-base) stays out
+	if strings.Join(ids, ",") != "gpt-5.5,claude-sonnet-5,gpt-4.1,mai-code-2-flash,auto" || len(ms[0].Efforts) != 2 {
 		t.Fatalf("models: %v %+v", ids, ms)
 	}
 	p, _ = find(All(), "copilot")
-	if got := p.Available(); len(got) != 4 || got[0].ID != "gpt-5.5" {
+	if got := p.Available(); len(got) != 5 || got[0].ID != "gpt-5.5" {
 		t.Fatalf("available after fetch: %+v", got)
 	}
 
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4343-copilot-mai-model-catalog](https://github.com/ggbdpq/magpie/tree/fix/4343-copilot-mai-model-catalog) (head `67dc6530a577050a7d6a637d7e5d5454986e07d4`).
