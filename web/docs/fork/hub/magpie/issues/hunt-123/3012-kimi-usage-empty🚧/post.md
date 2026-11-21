**Summary**
A Kimi Code key that Kimi takes but has no usage for comes back HTTP 200 with `{}` — two bytes, on every read-only ask (bigbitbox's key: `/usages` an empty object while `/models` lists fine, 401 without the key) — and the card could only say `no usage in the reply`, under the Usage page's generic "Allowance unavailable" heading, no different from a read that failed. Nothing said the key was taken, and nothing kept the empty reply from reading as an allowance of 0% used. The empty reply is now told apart, and no window is read out of it (#3012).

**What changed**
- `readKimiCode`'s empty branch (`internal/provider/planquota.go`) says what the reply carries, `shapeOf` as an OpenCode Go card already does: `Kimi took this key but its reply tells no usage (an empty object): the plan's allowance is unknown, not unused` for `{}`, `(fields hello)` when the reply has fields magpie reads none of. An empty reply stays an error, so the card keeps what was last read and shows no 0%/100% guess — as before, now pinned by a test that says it in words.
- A refused key is unchanged: a 401 or anything past 300 is said at the ask itself (`planBody`) and never reaches this branch, so "took this key" is said only of a reply Kimi sent.

**Section 2 of the issue — the new quota model — is already read at the current tip**
`usages` with `limit_5h`, `limit_7d`, `limit_month_total` and `limit_month_code`, a `used_ratio` of a number or a numeric string, a `reset_time` as RFC 3339 text or epoch seconds or milliseconds, the camelCase spellings too, and the shares taken over the counted windows as kimi-code reads them (managed-usage.ts at the pinned commit the issue links) — all of that has been in `readKimiCode` since cf3a2cc83 (v0.1.2032 and up), with tests (`TestReadKimiCodeMonth`, `TestReadKimiCodeMonthEveryWay`, `TestPlanQuotasKimiCodeMonthEveryRoute`). This patch adds nothing there, and nothing to `booster_wallet`/`extraUsage`, which magpie doesn't read anywhere.

**Verification**
| Check | Result |
| --- | --- |
| `TestReadKimiCodeEmptyReply` (`{}` → error naming the key taken and `an empty object`; `{"hello":"world"}` → names `fields hello`) | red before the change (bare `no usage in the reply`), green after |
| Ablation: only `planquota.go` reverted, the test kept | red again — the change is the cause |
| `TestReadKimiCode`, `TestReadKimiCodeMonth`, `TestReadKimiCodeMonthEveryWay`, `TestPlanQuotasKimiCodeMonthEveryRoute` | ok — the issue's section 2 windows keep parsing |
| `go test -tags nogui ./internal/provider -count=1` | ok 111.5s |
| `git am -3` of the patch on a clean tree at upstream/main (`f24829636`) | applies clean, targeted tests ok, author `ggbdpq <ggbdpq@gmail.com>` |
| Sibling check, `rg "no usage in the reply"` over the repo | one occurrence, this branch; Zhipu's and MiniMax's `no plan in the reply` are their own readers' wording, untouched — this patch touches the Kimi reader only |
| `gofmt -l` on the two touched files | empty |
| `go vet -tags nogui ./internal/provider` | clean |
| `go build -tags nogui .` | ok (the gui cgo warnings are pre-existing, untouched here) |

**Not tried**
- A live `/usages` ask with a real key: bigbitbox's own table in the issue is the live evidence, and the fixtures carry the shapes (an empty object, fields nothing reads). Why Kimi answers his account `{}` is upstream's to answer, as the issue itself says.
- The `booster_wallet`/`extraUsage` wallet the official reader also takes: nothing in the issue asks for it, and magpie reads no balance from Kimi today.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details><summary>patch: provider: a Kimi Code key with no usage to its name says so, not "no usage in the reply" (#3012) — git am applies it as is; SHA-256 first 16: 9bc2fc39b633aabc</summary>

```patch
From 45b47844681c05c0083b7b34199f21e61e7f6fd4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 02:20:35 +0800
Subject: [PATCH] provider: a Kimi Code key with no usage to its name says so,
 not "no usage in the reply" (#3012)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A key Kimi takes can be answered HTTP 200 with {} — bigbitbox's did, two
bytes, on every read-only ask, while /models listed fine — and the card
could only say "no usage in the reply", which the Usage page shows under
its generic "Allowance unavailable" heading, no different from a read
that failed: nothing said the key was taken, and nothing kept an empty
reply from reading as an allowance of 0% used.

The empty branch now says what the reply carries, shapeOf as an OpenCode
Go card does: "(an empty object)" for {}, "(fields …)" when something is
there that magpie reads none of — "Kimi took this key but its reply
tells no usage (an empty object): the plan's allowance is unknown, not
unused". A refused key is still said at the ask itself (401 and the
like never reach this branch).

The windows' shape the issue also asks for — usages' limit_5h, limit_7d
and the month's total and code shares, a ratio of number or text, a
reset as text or epoch — was read here already (cf3a2cc83), with the
month however Kimi tells it; this is the empty reply only.

Fixes #3012

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/planquota.go      |  6 +++++-
 internal/provider/planquota_test.go | 19 +++++++++++++++++++
 2 files changed, 24 insertions(+), 1 deletion(-)

diff --git a/internal/provider/planquota.go b/internal/provider/planquota.go
index 7459f984b..78306742e 100644
--- a/internal/provider/planquota.go
+++ b/internal/provider/planquota.go
@@ -570,7 +570,11 @@ func readKimiCode(b []byte) (string, []QuotaWindow, error) {
 		})
 	}
 	if len(out) == 0 {
-		return "", nil, fmt.Errorf("no usage in the reply")
+		// a key Kimi takes can have no usage to tell: {} (bigbitbox: HTTP
+		// 200, two bytes, on every read-only ask), so what the reply
+		// carries is said, and an empty reply reads as nothing told, not
+		// as an allowance nothing is used of
+		return "", nil, fmt.Errorf("Kimi took this key but its reply tells no usage (%s): the plan's allowance is unknown, not unused", shapeOf(b))
 	}
 	return "", out, nil
 }
diff --git a/internal/provider/planquota_test.go b/internal/provider/planquota_test.go
index 6677474d5..8dda2fe2c 100644
--- a/internal/provider/planquota_test.go
+++ b/internal/provider/planquota_test.go
@@ -527,6 +527,25 @@ func TestReadKimiCodeMonthEveryWay(t *testing.T) {
 	}
 }
 
+// A key Kimi takes can be told no usage at all: {} (bigbitbox: HTTP 200,
+// two bytes, on every read-only ask, while /models lists fine). The card
+// says the key is taken and nothing came back, with what the reply
+// carries, not a bare "no usage in the reply", and no window is guessed
+// of it — an empty reply is not an unused allowance.
+func TestReadKimiCodeEmptyReply(t *testing.T) {
+	_, ws, err := readKimiCode([]byte(`{}`))
+	if err == nil || len(ws) != 0 {
+		t.Fatalf("%+v %v", ws, err)
+	}
+	if !strings.Contains(err.Error(), "took this key") || !strings.Contains(err.Error(), "an empty object") {
+		t.Fatalf("the empty reply isn't told as Kimi having no usage for a taken key: %v", err)
+	}
+	// a reply that carries fields nothing reads names them
+	if _, _, err := readKimiCode([]byte(`{"hello":"world"}`)); err == nil || !strings.Contains(err.Error(), "fields hello") {
+		t.Fatalf("fields nothing reads aren't named: %v", err)
+	}
+}
+
 // Every way a Kimi Code key is added shows the month Kimi tells: the
 // China and global presets, a provider of its own at the Anthropic base
 // alone, and a key imported from OpenCode's auth.json. Each card is read
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/3012-kimi-usage-empty](https://github.com/ggbdpq/magpie/tree/fix/3012-kimi-usage-empty) (head `45b47844681c05c0083b7b34199f21e61e7f6fd4`).
