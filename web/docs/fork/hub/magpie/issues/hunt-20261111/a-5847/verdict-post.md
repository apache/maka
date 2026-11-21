I tried to reproduce this against the contract the issue's own A/B established, and could not: on current `main`, a relayed request carries both features the relay's preflight asks for.

**The probe.** A fake upstream enforcing exactly the table from the issue — 200 only when `anthropic-beta` contains `claude-code-20250219` **and** the body's `metadata.user_id` is non-empty, else the issue's 400 — behind a key+URL provider (`p.Anthropic`), with a client request to `/v1/messages` that carries both features:

- with a plain `curl/8.4.0` User-Agent: **PASS** — the fake received `anthropic-beta: claude-code-20250219` and `metadata.user_id` intact, answered 200;
- with `claude-cli/2.1.321` and an `x-stainless-package-version` header (the real Claude Code shape): **PASS** the same way.

The probe test is at the bottom of this comment; it runs green against `upstream/main` (`90f9f01a2`) with no changes of mine.

**Where the two features are handled, for the record.** The outgoing `anthropic-beta` is assembled at `forwardOnce` (gateway.go:5982-6003): the client's own header is copied first, then overwritten with `betas` — and `betas` is `serverReview(p, askedBetas(in), body)`, the client's asked betas (minus `oauth-` ones, which this beta is not) fitted through what the provider has refused. A provider learns a refused beta only from an error naming it (`unexpectedBetas`, `unsupportedBetas`); "A preflight check failed for this request. Please upgrade your Claude Code version." matches neither, so nothing strips `claude-code-20250219` on the way out. `metadata` survives the relay as sent: the request built again for an Anthropic upstream carries it (`ir.go`'s Metadata, kept for exactly this reason — #359), the passthrough edits are gjson ones that leave it alone, and the only strip is Bedrock's (`p.IsBedrock()`, gateway.go:6500 — a different check than this relay's), which a plain key+URL anthropic provider isn't.

**What that means.** Either the relay's preflight checks something your A/B didn't isolate — the two features pass through magpie, so a 400 through magpie with both present would have to be a third condition (a `metadata.user_id` shape it validates, a header coherence check across `user-agent`/`x-stainless-*`/`x-app`, something at the TLS layer) — or the request that failed through magpie differed from the one you tested directly in a way neither of us has captured (a different path suffix, the provider's stored base URL, the client not actually sending the header). The direct-request table proves the relay wants beta+metadata; it doesn't yet prove that's all magpie changes.

**The one capture that settles it.** Point the provider's base URL at a local echo (any `nc`/httptest that dumps headers and body) and send the failing request through magpie once, then diff that dump against your working direct curl. If the dump shows magpie dropping or rewriting something, reopen with it and the fix is straightforward at the seam named above; if the dump carries both features byte-identical, the relay's third condition is the thing to chase with the relay's operator (request ids included, as you offered).

**Verification.**

| Check | Result |
| --- | --- |
| Probe (curl UA) on `upstream/main` `90f9f01a2` | PASS — relay kept both features |
| Probe (claude-cli UA + x-stainless) on the same | PASS |
| `metadata` strip sites in `main` | one: Bedrock only (`gateway.go:6500`) |
| `anthropic-beta` learn/strip sites | refused-beta memory (regex-named errors only; the preflight message matches neither pattern) |

**Source**: probe run at `upstream/main` `90f9f01a2`, clean worktree; the contract enforced is the issue's own A/B table (beta+metadata → 200, either missing → 400).
**Siblings**: `askedBetas` strips only `oauth-`-prefixed betas; `claudeCodeHeader` (gateway.go:6227) copies every `anthropic-*` header when a Claude Code UA reaches a key provider; `bodyBetas` fits only the body's `anthropic_beta` list, which this request doesn't use.
**When the read fails**: if the client sends no beta at all, magpie sends none (the join of an empty list deletes the header) — the preflight 400 is then correct and is the relay talking, not magpie.
**Not verified**: the reporter's actual relay (`model.api.yinlihupo.cn`) — no account here; the third condition, if there is one, is theirs to capture.
**Attribution**: AI-written; I've read the paths cited and can answer questions on them myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>probe test (goes in internal/gateway/, runs green on main)</summary>

```go
package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/tidwall/gjson"

	"github.com/yetone/magpie/internal/provider"
)

// The relay's preflight as the issue's A/B established it (#5847,
// Haihangyuan): 200 only when the request carries both the beta header
// claude-code-20250219 and a body metadata.user_id — the two features a
// request sent directly needs, whatever the client's own headers are.
func TestAnthropicRelayKeepsThePreflightFingerprint(t *testing.T) {
	fresh(t)
	var mu sync.Mutex
	var gotBeta, gotMetadata string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotBeta = r.Header.Get("anthropic-beta")
		gotMetadata = gjson.GetBytes(b, "metadata.user_id").String()
		mu.Unlock()
		if !strings.Contains(gotBeta, "claude-code-20250219") || gotMetadata == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"type":"<nil>","message":"A preflight check failed for this request. Please upgrade your Claude Code version."}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer up.Close()
	p := provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"m"}}
	p.Anthropic = up.URL
	if err := provider.Save(p); err != nil {
		t.Fatal(err)
	}
	body := `{"model":"m","max_tokens":16,"metadata":{"user_id":"user_abc_account_def_session_xyz"},"messages":[{"role":"user","content":"hi"}]}`
	r := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+Token)
	r.Header.Set("User-Agent", "curl/8.4.0")
	r.Header.Set("anthropic-beta", "claude-code-20250219")
	w := httptest.NewRecorder()
	New().Handler().ServeHTTP(w, r)
	mu.Lock()
	defer mu.Unlock()
	if w.Code != 200 {
		t.Fatalf("%d %s (the beta magpie sent: %q; the metadata magpie sent: %q)", w.Code, w.Body.String(), gotBeta, gotMetadata)
	}
}
```

</details>
