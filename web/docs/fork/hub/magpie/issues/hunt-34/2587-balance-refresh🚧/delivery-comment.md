补丁在案：充值后最长 30 分钟里，magpie 一直在替厂商回答那条旧的「余额不足」——自动额度刷新明明读到了恢复，却解除不了这道拦截。本帖给一个最小修复，分支已推 fork。

## 现象与最小复现

任意 key 型供应商（有 Balance URL 或套餐窗口的都算）：

1. key 被厂商以 429/402 拒以「余额不足/请充值」→ magpie 把它 rest 30 分钟（`creditRest`，`internal/gateway/routing.go`，常量注释写的是 "until someone tops it up"）；
2. 此时充值；
3. 之后每个请求不再发往厂商：当所有候选 key 都在 rest 且拒绝带 429/402 原文时，网关把存下的拒绝原文直接答给客户端（`quotaHeld`，`internal/gateway/fallback.go`，#1772 机制），附 "not asked again before HH:MM"。

所以报错文字与充值前一模一样，最长持续 30 分钟，直到 rest 自然到期、在 Routing 页手动 Unrest、或换 key。

## 根因

自动额度刷新的读数（余额卡片 `KeyBalances`、套餐窗口 `PlanQuotas`、路由背后 key 自己的窗口 `readKeyAllowance`）确实照常发出、也读得回「钱回来了」，但这些读数只更新 Usage 卡片与窗口缓存。唯一能把 rest 自动解除的 `renewed`（routing.go）只抬 `failQuota`/"window" 两类，注释明说 "one for a rate limit, its credit or a verification stays"。于是形成不对称：**quota rest 会在读数发现窗口恢复时自动解除，credit rest 永远不会——尽管两者的「好了」信号来自同一批读数**。报告者配置的是自动刷新，读数一直在走，拦截却纹丝不动。

## 修法

新增一条与 `OnRenewed` 同构的钩子 `OnCreditBack`（5 文件，+185 行）：

- provider 侧两处成功读数点触发：`noteKeyAllowance`（余额卡片与套餐窗口的卡片读，纯 Balance URL 型 key 也覆盖）与 `readKeyAllowance`（路由背后的窗口读），带 `(providerID, KeyID)`；
- gateway 侧 `creditBack` 只抬该 key 的 `failCredit` rest：单 key 的裸 `id` 形态、多 key 的 `id#指纹` 形态、以及各自的 `restID` 模型级形态都盖到；quota rest 不动（仍是 renewed 的领地），restricted/verify 不碰；
- 厂商若仍拒绝，rest 照旧重设——代价上界是「每次成功读数最多换来一次被拒请求」。充值后下一次读数（自动模式下通常 ≤1 分钟）即恢复，不必再等 30 分钟或手动 Unrest。

## 验证

| 验证 | 结果 |
| --- | --- |
| TestCreditBackLiftsACreditRest（修前红：undefined 编译失败；修后绿，含 quota rest 不被误抬、它 key 不被误抬两面） | PASS |
| TestCardReadsTellCreditBack（钩子触发与指纹） | PASS |
| internal/gateway 全量 `-tags nogui -p 2` | ok 299s |
| internal/provider 全量 `-tags nogui -p 2` | ok 86s |
| 两个新测试 `-race` | ok |
| gofmt -l 触达文件 | 干净 |
| vet linux/amd64 · windows/amd64 · darwin/arm64 | 通过 |
| go build -tags nogui（darwin） | 通过 |

没跑：真实厂商端到端（本机没有欠费/充值的真实环境）；报告者的「update」按钮具体指向未考证——设置页的保存/开关/Fetch models/Check balance 都不清 rest，若能补充是哪家供应商、当时错误原文里有没有 "not asked again before HH:MM" 字样，可以进一步钉死 quotaHeld 在场。

分支：[hunt/2587-balance-refresh](https://github.com/ggbdpq/magpie/tree/hunt/2587-balance-refresh)（基 upstream/main @ `1d6f461a`）

<details>
<summary>format-patch 全文</summary>

```text
From 6ab5c8d392d5a80c74305ea75d42c05f23db1eb9 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 23:28:23 +0800
Subject: [PATCH] gateway: a key's credit rest is lifted when a read of its
 balance or windows goes through
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A refusal of no balance rested its key for half an hour, and while it
rested, every request was answered the refusal it gave, without asking
(quotaHeld, #1772) — so topping the account up changed nothing for up
to half an hour, and only the Routing page's Unrest, replacing the key,
or the rest running out brought it back (#2587). The readings the
automatic quota refresh asks anyway — a key's balance card, a plan's
windows, the key's own behind routing — now tell OnCreditBack's hooks,
and the gateway lifts the credit rests of the key they asked for: the
vendor answering a read says its refusal may be stale. The next request
asks it again; one that still refuses rests the key as before, so a
key out of pocket costs a refused request per reading, at most. Quota
rests stay renewed's to lift, and a restriction or a verification
isn't touched.

Fixes #2587
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/credit_back_test.go  | 71 +++++++++++++++++++++++++++
 internal/gateway/routing.go           | 41 +++++++++++++++-
 internal/provider/credit_back_test.go | 39 +++++++++++++++
 internal/provider/key_allowance.go    |  9 ++++
 internal/provider/routing.go          | 26 ++++++++++
 5 files changed, 185 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/credit_back_test.go
 create mode 100644 internal/provider/credit_back_test.go

diff --git a/internal/gateway/credit_back_test.go b/internal/gateway/credit_back_test.go
new file mode 100644
index 00000000..7a3169b3
--- /dev/null
+++ b/internal/gateway/credit_back_test.go
@@ -0,0 +1,71 @@
+package gateway
+
+import (
+	"net/http"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A key refused for no balance rests half an hour, and every request in
+// that time is answered the refusal it gave, without asking (quotaHeld,
+// #1772) — so topping the account up changes nothing for up to half an
+// hour (#2587). The readings the automatic quota refresh asks anyway — a
+// key's windows, its balance card — going through fine say the refusal may
+// be stale, so the credit rest is lifted and the next request asks the
+// vendor: one that still refuses rests the key as before. A quota rest is
+// renewed's to lift, not this.
+func TestCreditBackLiftsACreditRest(t *testing.T) {
+	forgetRouting()
+	s := &Server{}
+	fp := provider.KeyID("k1")
+	key := candidate{p: provider.Provider{ID: "glm", Key: "k1"}, model: "glm-5.3", rest: "glm"}
+	r := s.restAfter(key, 429, http.Header{}, []byte(`{"error":{"code":"1113","message":"余额不足或无可用资源包，请充值"}}`))
+	if r.Why != failCredit {
+		t.Fatalf("a refusal of no balance failed as %s", r.Why)
+	}
+	if d := time.Until(r.Until); d <= creditRest-2*time.Minute || d > creditRest {
+		t.Fatalf("out of credit rests %v, want about %v", d, creditRest)
+	}
+	creditBack("glm", fp)
+	if r, ok := restOf(key.restKey()); ok {
+		t.Fatalf("still resting after its balance was read again: %+v", r)
+	}
+
+	// the model's own credit rest is lifted with the key's
+	seed := func(k string) {
+		restingUntil.Lock()
+		restingUntil.m[k] = time.Now().Add(creditRest)
+		restingUntil.note[k] = Rest{Why: failCredit, Status: 402, Until: restingUntil.m[k], By: "credit", Key: k}
+		restingUntil.Unlock()
+	}
+	seed("glm/glm-5.3-paid") // one model of the key rests alone
+	seed("glm#" + fp + "/glm-5.3-paid")
+	creditBack("glm", fp)
+	for _, k := range []string{"glm/glm-5.3-paid", "glm#" + fp + "/glm-5.3-paid"} {
+		if _, ok := restOf(k); ok {
+			t.Fatalf("%s still rests out of credit after the key's balance was read again", k)
+		}
+	}
+
+	// another key of the provider, and another provider's key, keep theirs
+	seed("glm#" + provider.KeyID("k2"))
+	seed("other")
+	creditBack("glm", fp)
+	for _, k := range []string{"glm#" + provider.KeyID("k2"), "other"} {
+		if _, ok := restOf(k); !ok {
+			t.Fatalf("%s: another key's credit rest was lifted", k)
+		}
+	}
+
+	// a quota rest is renewed's to lift, and creditBack leaves it
+	restingUntil.Lock()
+	restingUntil.m["glm"] = time.Now().Add(quotaRest)
+	restingUntil.note["glm"] = Rest{Why: failQuota, Status: 429, Until: restingUntil.m["glm"], By: "quota", Key: "glm"}
+	restingUntil.Unlock()
+	creditBack("glm", fp)
+	if _, ok := restOf("glm"); !ok {
+		t.Fatal("a quota rest was lifted by a balance read")
+	}
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 1d81d570..0ee5c099 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -439,7 +439,46 @@ func renewed(agent, user string) {
 	}
 }
 
-func init() { provider.OnRenewed(renewed) }
+// creditBack lifts what rests out of credit of a key whose balance or
+// windows a reading just asked for fine (KeyBalances, a plan's, the key's
+// own behind routing): out of credit was why it sat out, and the vendor
+// answering a read says its refusal may be stale — topped up, perhaps —
+// so the next request asks it again, instead of the refusal it gave being
+// answered for it till the rest runs out (#2587). One that still refuses
+// rests as before: a refused request per reading, at most. Quota rests
+// are renewed's, and a restriction or a verification isn't touched.
+func creditBack(providerID, fingerprint string) {
+	restingUntil.Lock()
+	defer restingUntil.Unlock()
+	roots := []string{providerID}
+	if fingerprint != "" {
+		roots = append(roots, providerID+"#"+fingerprint)
+	}
+	for k, r := range restingUntil.note {
+		if r.Why != failCredit || !restsBy(k, roots) {
+			continue
+		}
+		delete(restingUntil.m, k)
+		delete(restingUntil.note, k)
+	}
+}
+
+// restsBy is whether k is one of the roots, or one model of one (restID):
+// a key rests by its provider's id while it is the one key on, else by
+// the id and the key's fingerprint.
+func restsBy(k string, roots []string) bool {
+	for _, root := range roots {
+		if k == root || strings.HasPrefix(k, root+"/") {
+			return true
+		}
+	}
+	return false
+}
+
+func init() {
+	provider.OnRenewed(renewed)
+	provider.OnCreditBack(creditBack)
+}
 
 // staleAllowance is provider.StaleAllowance, swapped in tests.
 var staleAllowance = provider.StaleAllowance
diff --git a/internal/provider/credit_back_test.go b/internal/provider/credit_back_test.go
new file mode 100644
index 00000000..07be3062
--- /dev/null
+++ b/internal/provider/credit_back_test.go
@@ -0,0 +1,39 @@
+package provider
+
+import (
+	"testing"
+	"time"
+)
+
+// A card read of a key — its balance, or a plan's windows — that went
+// through tells OnCreditBack's hooks, so the gateway can lift the credit
+// rest the key was left resting under when it had none (#2587): the vendor
+// answering a read says its old refusal may be stale.
+func TestCardReadsTellCreditBack(t *testing.T) {
+	creditBackHooks.Lock()
+	old := creditBackHooks.fs
+	creditBackHooks.fs = nil
+	creditBackHooks.Unlock()
+	defer func() {
+		creditBackHooks.Lock()
+		creditBackHooks.fs = old
+		creditBackHooks.Unlock()
+	}()
+
+	got := make(chan [2]string, 4)
+	OnCreditBack(func(providerID, fingerprint string) {
+		got <- [2]string{providerID, fingerprint}
+	})
+
+	p := Provider{ID: "glm", Key: "k1"}
+	noteKeyAllowance(p, nil, time.Now())
+
+	select {
+	case id := <-got:
+		if id[0] != "glm" || id[1] != KeyID("k1") {
+			t.Fatalf("told %q %q, want glm %q", id[0], id[1], KeyID("k1"))
+		}
+	case <-time.After(time.Second):
+		t.Fatal("a card read of a key told nobody")
+	}
+}
diff --git a/internal/provider/key_allowance.go b/internal/provider/key_allowance.go
index 4b3a956f..360d8b8f 100644
--- a/internal/provider/key_allowance.go
+++ b/internal/provider/key_allowance.go
@@ -146,6 +146,9 @@ func readKeyAllowance(p Provider, id string, gen int) {
 	if err == nil {
 		r.at, r.seq = now, seq
 		e.read = r
+		// the vendor answered a read of this key: a refusal of no balance
+		// it gave before may be stale (#2587)
+		tellCreditBack(p.ID, KeyID(p.Key))
 	}
 	if e.stale {
 		e.stale, e.loading, e.at = false, true, time.Time{}
@@ -215,6 +218,12 @@ func lastKeyAllowance(p Provider) Allowance {
 // noteKeyAllowance keeps the windows the key's card just read, for
 // routing to go by at once.
 func noteKeyAllowance(p Provider, ws []QuotaWindow, now time.Time) {
+	// the card read went through, so a refusal of no balance the vendor
+	// gave this key may be stale: topped up, perhaps (#2587). Plain
+	// balance keys have no windows to keep, and are told all the same.
+	if p.Key != "" {
+		tellCreditBack(p.ID, KeyID(p.Key))
+	}
 	if !readsKeyWindows(p) {
 		return
 	}
diff --git a/internal/provider/routing.go b/internal/provider/routing.go
index 203b2a4d..4ebd6eca 100644
--- a/internal/provider/routing.go
+++ b/internal/provider/routing.go
@@ -597,6 +597,32 @@ func tellRenewed(agent, user string) {
 	}
 }
 
+// OnCreditBack has f told when a reading of a key — its balance card, or
+// its plan's windows — went through: the vendor answered it, so a refusal
+// of no balance it gave before may be stale (the account was topped up),
+// and what sat out for it can be asked again. fingerprint is the read
+// key's own (KeyID).
+func OnCreditBack(f func(providerID, fingerprint string)) {
+	creditBackHooks.Lock()
+	creditBackHooks.fs = append(creditBackHooks.fs, f)
+	creditBackHooks.Unlock()
+}
+
+var creditBackHooks struct {
+	sync.Mutex
+	fs []func(providerID, fingerprint string)
+}
+
+// tellCreditBack tells those OnCreditBack asked.
+func tellCreditBack(providerID, fingerprint string) {
+	creditBackHooks.Lock()
+	fs := creditBackHooks.fs
+	creditBackHooks.Unlock()
+	for _, f := range fs {
+		f(providerID, fingerprint)
+	}
+}
+
 // AwaitAllowance has agent's accounts read again unless a reading is out,
 // and waits, till ctx ends, for one that knows user: after a reset is
 // spent, routing then counts the account's windows started again, rather
-- 
2.50.1 (Apple Git-155)

```

</details>

若采纳，请保留 author（`ggbdpq <ggbdpq@gmail.com>`）或加 `Co-authored-by: ggbdpq`。

Generated-by: GLM-5.3-Flash (ZCode)
