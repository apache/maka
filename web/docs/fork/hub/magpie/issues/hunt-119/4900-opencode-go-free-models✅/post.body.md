## Summary

With an expired or wrong key, OpenCode Go's `/models` refuses the provider's key, and magpie listed the models.dev catalog in its place — free rows Go doesn't serve beside the paid ones, and none of the free rows it does. The vendor's list is public: this asks it again without credentials and keeps what the vendor answers, so the picker says what OpenCode serves instead of what models.dev remembers.

One fact beside the issue's list: on the current main, the catalog fallback already leaves ids containing `preview` out, so of the four free rows named there, the picker listed `cat-jam-free` and `minimax-m3.1-flash-free` (and `iceman-contributor-free`, which Go does serve); `step-5-preview-free` and `longcat-2.5-preview-free` were already dropped. The fix below covers all of them at once, because it stops offering the catalog's guess altogether.

## Reproduce

The issue's: add OpenCode Go with an expired or wrong key, open the provider's model list — it shows the models.dev catalog's `opencode-go` rows, and picking a free one runs into the Zen retry and ends at `Model is unavailable`. At the wire level the new test reproduces the shape the issue describes: a keyed ask of `https://opencode.ai/zen/go/v1/models` answered 401 `Invalid API key`, the same URL bare answered the list. (Checked against the real gateway today: `GET https://opencode.ai/zen/go/v1/models` without credentials answers 200 — 28 models, `beam-free` and `iceman-contributor-free` among them.)

## Root cause

`Provider.fetch` asks the list with the key, is refused, and keeps nothing; `available()` then falls back to the models.dev catalog (`internal/provider/models.go`). The catalog lags: on 2026-11-02 it files free rows under `opencode-go` that Go doesn't serve, and lacks `beam-free`, which Go does. Nothing in that fallback can know what Go serves — and it doesn't need to: the vendor answers the same list without a key.

## Fix

`fetch` (`internal/provider/models.go`): when a keyed ask of the list fails on an OpenCode host (`IsOpenCode`) and the provider carries a key, the same list is asked once more bare (the key cleared; the user's own headers kept). What answers is saved as the provider's list (`SaveLiveSides`, as any fetch's is), so the picker lists the vendor's rows and the catalog fallback never fires. The retry is kept to OpenCode's hosts: no other vendor's list is known to answer bare, and a partial public list must not stand in for the keyed one. If the bare ask fails too, the original refusal error stands, unchanged.

## Verification

| Check | Result |
| --- | --- |
| `TestOpenCodeListAskedBareWhenTheKeyIsRefused` on base `173b7e274` | FAIL: the keyed ask is refused (`Invalid API key`) and the fetch fails — "type its model ids in by hand" |
| the same with the change | green: the bare ask answers, `beam-free`, `iceman-contributor-free`, `glm-5.3` are fetched and listed, and the catalog's `cat-jam-free` is not |
| `TestOpenCodeListNotAskedBareAtAnotherHost` | green — a refused list at another host fails as before, nothing asked bare |
| ablation: product change reverted to base, tests kept | RED again; restored: green |
| `go test -tags nogui -count=1 ./internal/provider` | ok |
| the two tests with `-count=3 -race` | ok |
| `gofmt -l`, `go vet -tags nogui` (darwin, GOOS=linux, GOOS=windows), `go build -tags nogui` (darwin, linux, windows) | clean |

**Not verified**: a provider with an expired key against the live gateway, end to end — no such key here; the fix is exercised at the wire seam the issue describes. The Zen preset's list answers bare too (checked, 200) and gets the same retry, but only Go was asked with a wrong key, as the issue does. Multi-key providers, sign-in (account) lists and the add form's `List` are not covered — a multi-key provider's per-key asks are keyed by design, and an account's list comes from its sign-in, not `/models`.

**Left**: `fetchPerKey` (multi-key) and `List` (add form) keep their current shape; if a multi-key OpenCode provider shows the same catalog fallback, that is a separate change.

---
**Source**: reported in #4900 (51bit.eth's gateway observations, via yetone); the bare-list read is my own probe of the live gateway today.

**Red without the fix** (base `173b7e274`): with `internal/provider/models.go` reverted and the new tests kept, `go test ./internal/provider -run TestOpenCodeListAskedBareWhenTheKeyIsRefused` fails:
```
--- FAIL: TestOpenCodeListAskedBareWhenTheKeyIsRefused
    opencode_bare_list_test.go:82: the bare ask should have answered where the key was refused: no model list: https://opencode.ai/zen/go/v1/models:  (Invalid API key) — type its model ids in by hand, or give the URL its list is at
```
With the fix: `ok`.

**Siblings**: `rg -n "FetchAtListed|FetchURL" internal/provider/` — the keyed ask sites are `fetchOne` (changed), `fetchPerKey` (left: one vendor, one list; per-key bare asks would answer alike), `List` (left: the add form, one change one goal), and the account fetch paths (their lists come from sign-ins, not `/models` — not applicable). The catalog fallback itself is unchanged for every other vendor.

**When the read fails**: a bare ask that fails too returns the original keyed refusal; an empty bare answer reads as no answer (`FetchAtListed`), nothing is saved, and the catalog fallback stands as before (TestOpenCodeListNotAskedBareAtAnotherHost pins the non-OpenCode shape).

**Not verified**: real expired-key provider against the live gateway; Windows GUI.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/4900-opencode-go-free-models](https://github.com/ggbdpq/magpie/tree/fix/4900-opencode-go-free-models) (head `62c280a29`).

**Patch**: <details><summary>patch: provider: a model list OpenCode's key is refused is asked again bare, so the picker says what the vendor serves (#4900) — git am applies it as is; SHA-256 first 16: 20231d2a0051d0d3</summary>

```patch
From 62c280a2931fb0b71156b4102aa82cc7d551216d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 06:29:42 +0800
Subject: [PATCH] provider: a model list OpenCode's key is refused is asked
 again bare, so the picker says what the vendor serves (#4900)

What changed: OpenCode's model lists are public - the vendor answers its
/models without a key. When a provider's keyed ask of the list is
refused (an expired or wrong key), the same list is asked once more
without credentials, and what the vendor serves is saved as the
provider's list. The picker then shows the vendor's word instead of
falling back to the models.dev catalog, which files free rows under
opencode-go that Go doesn't serve (cat-jam-free, minimax-m3.1-flash-free,
step-5-preview-free, longcat-2.5-preview-free) while missing the free
rows it does (beam-free). The retry is kept to OpenCode's own hosts
(IsOpenCode): no other vendor's list is known to answer bare, and a
partial public list would stand in for the keyed one. Multi-key
providers, account (sign-in) lists and the add form's List are not
covered.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/models.go                  |  11 ++
 internal/provider/opencode_bare_list_test.go | 131 +++++++++++++++++++
 2 files changed, 142 insertions(+)
 create mode 100644 internal/provider/opencode_bare_list_test.go

diff --git a/internal/provider/models.go b/internal/provider/models.go
index e29d7b382..3e1c401fe 100644
--- a/internal/provider/models.go
+++ b/internal/provider/models.go
@@ -458,6 +458,17 @@ func (p Provider) fetch(ctx context.Context) ([]catalog.Model, error) {
 		return p.fetchPerKey(ctx, keys)
 	}
 	l, err := p.fetchOne(ctx)
+	if err != nil && p.IsOpenCode() && p.Key != "" {
+		// OpenCode's lists are public: the vendor answers its /models
+		// without a key, so a list the key is refused is asked again
+		// bare, and the picker says what OpenCode serves, not what
+		// models.dev remembers of it (#4900)
+		bare := p
+		bare.Key = ""
+		if b, berr := bare.fetchOne(ctx); berr == nil {
+			l, err = b, nil
+		}
+	}
 	if err != nil {
 		return nil, err
 	}
diff --git a/internal/provider/opencode_bare_list_test.go b/internal/provider/opencode_bare_list_test.go
new file mode 100644
index 000000000..5f896bcd0
--- /dev/null
+++ b/internal/provider/opencode_bare_list_test.go
@@ -0,0 +1,131 @@
+package provider
+
+import (
+	"context"
+	"io"
+	"net/http"
+	"os"
+	"path/filepath"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// refusedOpenCode answers OpenCode's gateway as it answers a model list:
+// an ask that carries the provider's key is refused (#4900, an expired or
+// wrong key), and the same list asked bare is answered, as the vendor
+// serves its /models to whoever asks.
+type refusedOpenCode struct {
+	mu    sync.Mutex
+	keyed []string // the list URLs asked with a key
+	bare  []string // the list URLs asked without one
+}
+
+func (f *refusedOpenCode) RoundTrip(r *http.Request) (*http.Response, error) {
+	if r.Body != nil {
+		io.Copy(io.Discard, r.Body)
+		r.Body.Close()
+	}
+	h := http.Header{"Content-Type": {"application/json"}}
+	u := r.URL.String()
+	keyed := r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != ""
+	f.mu.Lock()
+	if keyed {
+		f.keyed = append(f.keyed, u)
+	} else {
+		f.bare = append(f.bare, u)
+	}
+	f.mu.Unlock()
+	if keyed {
+		return &http.Response{
+			StatusCode: 401, Header: h, Request: r,
+			Body: io.NopCloser(strings.NewReader(`{"error":{"message":"Invalid API key"}}`)),
+		}, nil
+	}
+	return &http.Response{
+		StatusCode: 200, Header: h, Request: r,
+		Body: io.NopCloser(strings.NewReader(`{"data":[` +
+			`{"id":"beam-free","name":"Beam Free"},` +
+			`{"id":"iceman-contributor-free","name":"Iceman Contributor"},` +
+			`{"id":"glm-5.3","name":"GLM 5.3"}]}`)),
+	}, nil
+}
+
+// #4900 (51bit.eth, via yetone): OpenCode Go's /models refuses an expired
+// key, and magpie lists the models.dev catalog in its place — free rows Go
+// doesn't serve among them. The vendor's list is public: a list the key is
+// refused is asked again bare, so the picker says what OpenCode serves,
+// not what models.dev remembers of it.
+func TestOpenCodeListAskedBareWhenTheKeyIsRefused(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	// what models.dev files under opencode-go on 2026-11-02: a free row
+	// Go doesn't serve, beside none of the free rows it does
+	body := `{"opencode-go":{"models":{"cat-jam-free":{"id":"cat-jam-free","name":"Cat Jam","cost":{"input":0,"output":0}}}}}`
+	if err := os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(catalog.CachePath(), []byte(body), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	f := &refusedOpenCode{}
+	oldT := http.DefaultClient.Transport
+	http.DefaultClient.Transport = f
+	t.Cleanup(func() { http.DefaultClient.Transport = oldT })
+
+	p := Provider{ID: "opencode-go", Name: "OpenCode Go", Key: "expired", Chat: "https://opencode.ai/zen/go/v1"}
+	ms, err := p.fetch(context.Background())
+	if err != nil {
+		t.Fatalf("the bare ask should have answered where the key was refused: %v", err)
+	}
+	var ids []string
+	for _, m := range ms {
+		ids = append(ids, m.ID)
+	}
+	for _, want := range []string{"beam-free", "iceman-contributor-free", "glm-5.3"} {
+		if !slices.Contains(ids, want) {
+			t.Fatalf("the vendor's list is missing %s: %v", want, ids)
+		}
+	}
+	// the vendor's word is kept: the picker lists it, not the catalog's guess
+	var listed []string
+	for _, m := range p.Available() {
+		listed = append(listed, m.ID)
+	}
+	if slices.Contains(listed, "cat-jam-free") {
+		t.Fatalf("the catalog's free row Go doesn't serve is still listed: %v", listed)
+	}
+	if !slices.Contains(listed, "beam-free") {
+		t.Fatalf("the vendor's free model is not listed: %v", listed)
+	}
+	f.mu.Lock()
+	defer f.mu.Unlock()
+	if len(f.keyed) == 0 || len(f.bare) == 0 {
+		t.Fatalf("keyed asks %v, bare asks %v", f.keyed, f.bare)
+	}
+}
+
+// A list refused at another vendor's host is not asked bare: no other
+// vendor's list is known to answer without a key, and a partial public
+// list would stand in for the keyed one.
+func TestOpenCodeListNotAskedBareAtAnotherHost(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	f := &refusedOpenCode{}
+	oldT := http.DefaultClient.Transport
+	http.DefaultClient.Transport = f
+	t.Cleanup(func() { http.DefaultClient.Transport = oldT })
+
+	p := Provider{ID: "relay", Name: "Relay", Key: "expired", Chat: "https://relay.test/v1"}
+	if _, err := p.fetch(context.Background()); err == nil {
+		t.Fatal("a refused list at another host should fail as before")
+	}
+	f.mu.Lock()
+	defer f.mu.Unlock()
+	if len(f.bare) != 0 {
+		t.Fatalf("asked bare at another host: %v", f.bare)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
