Refresh of the two posts above — the same bump, not a redesign — now based on main `60559ee73`, cherry-picked from the branch head with zero conflicts. Main has since moved to `7e3e0fec4`; nothing between the two touches `go.mod`/`go.sum`, so the patch `git am`s cleanly there too. Also: upstream landed `7e8214d60` and `535f0dd95` in that window, fixing exactly the five baseline-red tests my run saw — verified green one by one on `7e3e0fec4`.

**One conflict resolved semantically**: upstream had already moved `golang.org/x/sys` to v0.49.0 on its own (newer than the v0.48.0 this bump carried), so the refresh keeps upstream's v0.49.0 and takes the rest of the bump as is: `go 1.26.8 → 1.26.10`, `golang.org/x/net v0.56.0 → v0.60.0`, `x/term v0.44.0 → v0.46.0`, `x/text v0.39.0 → v0.42.0`. `go mod tidy` after the resolve: clean, go.sum consistent.

**Re-verified on the bumped tree** (toolchain `go1.26.10`, all re-run today):
- `go build ./...` darwin, `GOOS=linux -tags nogui`, `GOOS=windows` — all ok.
- Whole `internal/gateway` (1400.9s): one failure, `TestKeyLimitReservationsStayInTheirWindow` — the known baseline red, fixed upstream in `535f0dd95` hours later; zero new failures from the bump.
- Whole `internal/provider` (333.4s): four failures, every one of them red on the **unbumped parent too** (`TestAddSameKeyOtherFormat`, `TestWalletCapHolds`, `TestQuotaSpanCarriesEveryWindowField`, `TestKeptQuotaReportAsksNobody`) — baseline, not the bump; all four pass on `7e3e0fec4` via `7e8214d60`.
- `-race` skipped judgmentally: a dependency version bump adds no concurrency of its own; the full-package runs above are the load-bearing check, as in the previous post.

**Ablation, same shape as before**: on a fresh checkout of the unbumped parent, the old pins build (`exit 0`) and the same tests behave identically — the old pins are not broken, they are older; the content of this patch is the bump itself plus the compatibility evidence above.

Branch with the commit: [hunt-20261111-sb5](https://github.com/ggbdpq/magpie/tree/hunt-20261111-sb5) (head `77a836228`).

**Attribution**: AI-assisted refresh of @AgentWings' fix — I've read the whole diff and can answer questions on it myself. Please keep the author (`Shengming Liang`) or add `Co-authored-by` for them, credit where due (the commit trailer names the tool that did the rebase).

**Patch**: <details><summary>patch: go: Go 1.26.10 and x/net 0.60 close the net/http, TLS and x509 advisories the gateway reaches (#3208) — git am applies it as is; SHA-256 first 16: 88408326f8731ab9</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Shengming Liang <231182611+AgentWings@users.noreply.github.com>
Date: Wed, 21 Oct 2026 12:38:58 -0700
Subject: [PATCH] go: Go 1.26.10 and x/net 0.60 close the net/http, TLS and
 x509 advisories the gateway reaches

Generated-by: GLM-5.3-Flash (ZCode)

(Carries @AgentWings's fix; original commit recovered by SHA and rebased. Rebase refresh 2026-11-11: x/sys stays at upstream v0.49.0, newer than the original bump.
)
---
 go.mod |  8 ++++----
 go.sum | 14 ++++++--------
 2 files changed, 10 insertions(+), 12 deletions(-)

diff --git a/go.mod b/go.mod
index e9eb0c147..43b37969d 100644
--- a/go.mod
+++ b/go.mod
@@ -1,6 +1,6 @@
 module github.com/yetone/magpie
 
-go 1.26.8
+go 1.26.10
 
 require (
 	github.com/MoeForge/moejs v0.1.0
@@ -22,10 +22,10 @@ require (
 	github.com/tidwall/jsonc v0.3.3
 	github.com/wailsapp/wails/v3 v3.0.0-beta.24
 	golang.org/x/image v0.43.0
-	golang.org/x/net v0.56.0
+	golang.org/x/net v0.60.0
 	golang.org/x/sys v0.49.0
-	golang.org/x/term v0.44.0
-	golang.org/x/text v0.39.0
+	golang.org/x/term v0.46.0
+	golang.org/x/text v0.42.0
 	gopkg.in/yaml.v3 v3.0.1
 	modernc.org/libc v1.79.0
 	modernc.org/sqlite v1.61.0
diff --git a/go.sum b/go.sum
index 872db144a..139e923b2 100644
--- a/go.sum
+++ b/go.sum
@@ -84,8 +84,6 @@ github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec h1:W09IVJc94
 github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec/go.mod h1:qqbHyh8v60DhA7CoWK5oRCqLrMHRGoxYCSS9EjAz6Eo=
 github.com/rivo/uniseg v0.4.7 h1:WUdvkW8uEhrYfLC4ZzdpI2ztxP1I582+49Oc5Mq64VQ=
 github.com/rivo/uniseg v0.4.7/go.mod h1:FN3SvrM+Zdj16jyLfmOkMNblXMcoc8DfTHruCPUcx88=
-github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 h1:1EYB5IzjZawrrnELUi78f9fPu57HuXjmddZPjrls/28=
-github.com/santhosh-tekuri/jsonschema/v6 v6.0.3/go.mod h1:JXeL+ps8p7/KNMjDQk3TCwPpBy0wYklyWTfbkIzdIFU=
 github.com/stretchr/testify v1.12.1 h1:EuwCh5fleGS7H32xRwO3wRGT7DxrDhLAT6FF8MpWDWE=
 github.com/stretchr/testify v1.12.1/go.mod h1:MDEgiDPPsNp5cuIrHPPCyornHKgEVbtFUmoNlxoYthg=
 github.com/tidwall/gjson v1.19.0 h1:xwxm7n691Uf3u5OFjzngavjGTh55KX5q/9w9xHW88JU=
@@ -108,18 +106,18 @@ golang.org/x/image v0.43.0 h1:FLxcP4ec2350nTfOC8ysKtqYSIFbk/QGjw1ZHNP4tsY=
 golang.org/x/image v0.43.0/go.mod h1:rrpelvGFt+kLPAjPM4HeWPgrl0FtafueU//e5N0qk/Q=
 golang.org/x/mod v0.42.0 h1:ICeL3t2L30ljSPHHxDnR4fqVcBt/zR2zJAb9juavmQg=
 golang.org/x/mod v0.42.0/go.mod h1:u5fzIrRInkL8MaO1cbRkUHT64v303YIT5KEqpNr7jRs=
-golang.org/x/net v0.56.0 h1:Rw8j/hFzGvJUZwNBXnAtf5sVDVt+65SK2C7IxCxZt5o=
-golang.org/x/net v0.56.0/go.mod h1:D3Ku6r+V6JROoZK144D2XfMHFcMq/0zSfLelVTCFKec=
+golang.org/x/net v0.60.0 h1:79p50tfZlm0J9YfoDsSi639qSXNGVwEzOPLCxM2FsYU=
+golang.org/x/net v0.60.0/go.mod h1:2DA/G1UfVbCpQPeWTmMPGY7Cs2PkBkwu743bVX5PIVg=
 golang.org/x/sync v0.24.0 h1:iqiDrGoDgyuvAKrhLQthUEzU/R378N78gXbBjxed7oA=
 golang.org/x/sync v0.24.0/go.mod h1:sUUOizhqBxiL6pEWpqNLUiaJn1ShEbZ6BBqskPbjZm0=
 golang.org/x/sys v0.0.0-20210809222454-d867a43fc93e/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
 golang.org/x/sys v0.1.0/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
 golang.org/x/sys v0.49.0 h1:XbzkgYJHdqh/8m2Uu0W/dQv8nktxx4BFHp1M0gROTXA=
 golang.org/x/sys v0.49.0/go.mod h1:hNLxWAXmnKAxqDtdwIYC4bM9oQPEecfsnNMuSxOs3og=
-golang.org/x/term v0.44.0 h1:0rLvDRCtNj0gZkyIXhCyOb2OAzEhLVqc4B+hrsBhrmc=
-golang.org/x/term v0.44.0/go.mod h1:7ze4MdzUzLXpSAoFP1H0bOI9aXDqveSvatT5vKcFh2Y=
-golang.org/x/text v0.39.0 h1:UbZz4pLOvn600D6Oh6GGEI6VAmndrEBLv8/6BEXzyus=
-golang.org/x/text v0.39.0/go.mod h1:3UwRclnC2g0TU9x8PZiyfOajCd1zaUNHF9cvqcQZ+ZM=
+golang.org/x/term v0.46.0 h1:3+OXuTbaKDgwk8jTi3aSLHRlmWqHEUDUtxnbFigO4YE=
+golang.org/x/term v0.46.0/go.mod h1:+K02xbkittuwc0Am4abfA3Fc+XRGXkvBXNO88NCXPoc=
+golang.org/x/text v0.42.0 h1:JbOZXgfeCPU9gacVtYliJqOhD+zhrEqK4LfdpmlUZqI=
+golang.org/x/text v0.42.0/go.mod h1:ojzP1Z+2QtioaF8DTtO8K5q7JWVVYwZKenzujK0Zd0E=
 golang.org/x/tools v0.52.0 h1:ryxg4U63oaUYk7uOLTF37n43f4qgtGvqV4Ioit1BaEs=
 golang.org/x/tools v0.52.0/go.mod h1:ItcP5UNaVGG+Yc4eIYmaFLNJ4soEopkx5Y2d4lcEurs=
 gopkg.in/check.v1 v0.0.0-20161208181325-20d25e280405 h1:yhCVgyC4o1eVCa2tZl7eS0r+SDo693bJlVdllGtEeKM=
-- 
2.50.1 (Apple Git-155)

```

</details>
