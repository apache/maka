接单交付（补 #2642 的报错可区分面；行为面修复已在[上一条评论](https://github.com/yetone/magpie/issues/2642#issuecomment-6228464180)交付，本帖补其声明「未处理」的 OwnPaused 合并文案面——两个 patch 互补，合入顺序不限，同文件不同函数无冲突）。

交付跟进（#2642 行为面由同账号并行车道在[上一条评论](https://github.com/yetone/magpie/issues/2642#issuecomment-6228464180)交付）：修复 commit `4e5b0c93`，分支 [hunt36-b-gw-checkpoint-gone](https://github.com/ggbdpq/magpie/tree/hunt36-b-gw-checkpoint-gone)（基线 138188a3），patch 见文末。

## 根因

`checkpointReaders` 收窄为空时，`native_compaction.go:371` 回 `checkpointError`——三个消失原因（账号模型清单不再列出 / 账号被暂停换其它账号 / 登出移除）压成一句「switched off, removed, or no longer serves」，其中「switch it on again」的建议对前两种原因是假的（账号还在，只是被持走或暂停了）。

## 修法

新增 `checkpointGoneError`（`internal/gateway/native_compaction.go`）：在 provider 列表里找到 sealer，按消失方式分四态各给一句带恢复指引的报错——①模型被账号清单持到其它账号（Providers → 该账号的 models 里还给它）、②账号被暂停换其它账号服务（取消暂停）、③登出移除（重新登录）、④provider 整个被删（重新添加并登录）。接线点：gateway.go 里 codex 压实 400 的唯一调用处换用新函数。带 tool_calls / 非空 content 的轮与回答 tool result 的轮不受影响。

## 最小复现与红绿

`TestNativeCompactionWriterGoneSaysWhichWay` 三个子测试（被持走 / 暂停 / 登出移除，全链路走 Codex 压实请求）：

| 检查 | 结果 |
| --- | --- |
| 接线后三子测试 | PASS：报错各自点名账号与恢复位置，无三因合并句 |
| 接线前（仅函数未接线） | FAIL：三态合一旧文案 |
| `Checkpoint/Compaction/NativeCompaction` 定向族 | ok |
| `gofmt -l internal/gateway/`、三平台 vet、三平台 build | 干净 / ok（已知 trayimage cgo 与 ld 警告） |

## 与上一条评论（行为面）的关系

上一条 patch 让 `checkpointReaders` 从 left 池找回被压实的账号——找回成功时请求直接恢复；**找回失败**（暂停/登出移除/provider 删除）时才走到本帖的分状态报错。两 patch 同文件不同函数，互补无冲突。另：`checkpointCarriers`（native_compaction.go:308 一带）对 carriers 有同形缺口，本帖未扩修，若维护者接受本帖修法可顺手核。

## 没跑什么

真实 ChatGPT 账号的 paused/登出现场未复现（测试以 provider fixtures 构造三态）；GUI 未跑。

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)

<details>
<summary>patch</summary>

```
From 4e5b0c937a8bfcacf6e6cee5db989c72d6e1d101 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 17 Oct 2026 10:33:54 +0800
Subject: [PATCH] gateway: the compaction-sealer 400 says which way it is gone
 and where to bring it back (#2642)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
- checkpointReaders coming up empty answered the plain checkpointError:
  "it is switched off, removed, or no longer serves X" — one sentence for
  three different ways the sealer can be gone, and the recovery advice
  ("switch it on again") is wrong for two of them (the account is still
  there, paused or kept to the other accounts). checkpointGoneError now
  finds the sealer among the providers and says which way it is gone —
  the account's models keep the model to the others, it is paused while
  the others serve, or it is signed out of magpie and removed — each
  with where to bring the conversation back. A provider that is removed
  entirely keeps its own line. A turn that answers a tool result still
  stays right behind its tool message.

Run
- TestNativeCompactionWriterGoneSaysWhichWay (three subtests: kept to
  the other accounts, paused, signed out or removed): red before the
  wiring (the body was the three-states-as-one sentence), green after,
  each naming the account and the recovery place.
- go test -tags nogui -p 2 -count=1 -run 'Checkpoint|Compaction|
  NativeCompaction' ./internal/gateway/: ok. gofmt -l internal/gateway/
  clean. go vet -tags nogui darwin / linux / windows: clean. go build
  darwin / linux nogui / windows: ok, with the known trayimage cgo
  warning and ld duplicate-library warnings.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                |  2 +-
 internal/gateway/native_compaction.go      | 49 ++++++++++++++
 internal/gateway/native_compaction_test.go | 78 ++++++++++++++++++++++
 3 files changed, 128 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 7da9c376..d6eded80 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -1965,7 +1965,7 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			var left bool
 			if cands, pl, left = checkpointReaders(cands, pl, cp.Who); !left {
 				call.Status, call.Error = 400, "native compaction sealed elsewhere"
-				writeError(w, from, 400, checkpointError(call.Model, cp))
+				writeError(w, from, 400, checkpointGoneError(call.Model, cp))
 				turnedAway()
 				return
 			}
diff --git a/internal/gateway/native_compaction.go b/internal/gateway/native_compaction.go
index f753646e..366a80af 100644
--- a/internal/gateway/native_compaction.go
+++ b/internal/gateway/native_compaction.go
@@ -333,6 +333,55 @@ func checkpointError(model string, cp checkpointWriter) string {
 		cp.Who, model, model, cp.Who, model)
 }
 
+// checkpointGoneError is checkpointError with the way the sealer is gone
+// now said alone, each with where to bring it back (#2642): the model kept
+// to the provider's other accounts or keys (the account's models), the
+// account paused for the others on, or the account or key signed out of
+// magpie and removed. The states as one sentence, as checkpointError says
+// them, when magpie finds the sealer serving and can't tell.
+func checkpointGoneError(model string, cp checkpointWriter) string {
+	who := strings.ToLower(cp.Who)
+	for _, p := range provider.All() {
+		ref := ""
+		if p.Account != nil && p.Account.User != "" && strings.ToLower(p.ID+"@"+p.Account.User) == who {
+			ref = p.Account.User
+		} else if p.Account == nil {
+			for _, k := range p.KeysOn() {
+				if strings.ToLower(p.ID+"#"+provider.KeyID(k.Key)) == who {
+					ref = provider.KeyID(k.Key)
+					break
+				}
+			}
+		}
+		if ref == "" {
+			continue
+		}
+		name := p.Name
+		if name == "" {
+			name = p.ID
+		}
+		if p.OwnPaused() {
+			return fmt.Sprintf("This conversation was compacted natively by %s, and only that key or account can read the compaction it sealed. The request for %s can't go to it now: %s is paused in magpie, kept for the accounts on beside it. Let it serve again in Providers → %s to go on with this conversation, or start a new one. magpie doesn't send the compaction to another, which would refuse it, nor drop it or summarise it in its place, which would lose the conversation's earlier context.",
+				cp.Who, model, cp.Who, name)
+		}
+		if !p.AccountServes(ref, model) {
+			return fmt.Sprintf("This conversation was compacted natively by %s, and only that key or account can read the compaction it sealed. The request for %s can't go to it now: magpie keeps %s to the other accounts or keys of %s. Give it to this account again, in Providers → %s, in the account's models, to go on with this conversation, or start a new one. magpie doesn't send the compaction to another, which would refuse it, nor drop it or summarise it in its place, which would lose the conversation's earlier context.",
+				cp.Who, model, model, name, name)
+		}
+		return checkpointError(model, cp)
+	}
+	if p, err := provider.Find(cp.Provider); err == nil {
+		name := p.Name
+		if name == "" {
+			name = p.ID
+		}
+		return fmt.Sprintf("This conversation was compacted natively by %s, and only that key or account can read the compaction it sealed. The request for %s can't go to it now: the account or key that sealed it is signed out of magpie or removed. Sign in to %s again in Providers → %s to go on with this conversation, or start a new one. magpie doesn't send the compaction to another, which would refuse it, nor drop it or summarise it in its place, which would lose the conversation's earlier context.",
+			cp.Who, model, cp.Who, name)
+	}
+	return fmt.Sprintf("This conversation was compacted natively by %s, and only that key or account can read the compaction it sealed. The request for %s can't go to it now: %s, the provider it was sealed at, is removed from magpie. Add it again and sign in to the same account to go on with this conversation, or start a new one. magpie doesn't send the compaction to another, which would refuse it, nor drop it or summarise it in its place, which would lose the conversation's earlier context.",
+		cp.Who, model, cp.Provider)
+}
+
 // carrierError is what Codex is told when its compaction_trigger, asked
 // of a provider set to compact natively, has nowhere left that carries it.
 func carrierError(model string) string {
diff --git a/internal/gateway/native_compaction_test.go b/internal/gateway/native_compaction_test.go
index da828064..7fd10b06 100644
--- a/internal/gateway/native_compaction_test.go
+++ b/internal/gateway/native_compaction_test.go
@@ -265,6 +265,84 @@ func TestNativeCompactionFallbackSealStaysWithItsWriter(t *testing.T) {
 	}
 }
 
+// askGone posts a Codex turn carrying the sealed compaction enc, and
+// gives the 400 body the gateway answers when the key or account that
+// sealed it can't be asked now.
+func askGone(t *testing.T, enc string) string {
+	t.Helper()
+	srv := New()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(`{"model":"gpt-5.5","stream":true,"input":[{"type":"compaction","encrypted_content":"`+enc+`"},{"type":"message","role":"user","content":[{"type":"input_text","text":"go on"}]}]}`))
+	req.Header.Set("Authorization", "Bearer chatgpt-token")
+	req.Header.Set("chatgpt-account-id", "acct-1")
+	srv.Handler().ServeHTTP(rec, req)
+	if rec.Code != 400 {
+		t.Fatalf("%d: %s", rec.Code, rec.Body)
+	}
+	return rec.Body.String()
+}
+
+// #2642: the one key or account a request's native compaction was sealed
+// by, which the request can't go to now, is told which way it is gone and
+// where to bring it back — the account's models keeping the model to the
+// others, it paused for the others on, or it signed out of magpie and
+// removed — not the three states as one sentence.
+func TestNativeCompactionWriterGoneSaysWhichWay(t *testing.T) {
+	t.Run("the model kept to the other accounts", func(t *testing.T) {
+		codexSignedIn(t, "spare@example.com")
+		newResetBackend(t, "me@example.com", "spare@example.com")
+		if err := provider.SetAccountModels("codex", "me@example.com", []string{"gpt-5.2"}); err != nil {
+			t.Fatal(err)
+		}
+		wroteCheckpoint("gAAAAB-gone-to-models", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{User: "me@example.com"}}})
+		body := askGone(t, "gAAAAB-gone-to-models")
+		for _, want := range []string{"me@example.com", "other accounts", "Providers"} {
+			if !strings.Contains(body, want) {
+				t.Errorf("no %q in %s", want, body)
+			}
+		}
+		for _, not := range []string{"switched off, removed, or no longer serves"} {
+			if strings.Contains(body, not) {
+				t.Errorf("the three states as one sentence in %s", body)
+			}
+		}
+	})
+
+	t.Run("paused for the others on", func(t *testing.T) {
+		codexSignedIn(t, "spare@example.com")
+		newResetBackend(t, "me@example.com", "spare@example.com")
+		// the account the agent is signed in to, paused while another is on
+		if err := provider.SetLoginOn("codex", "me@example.com", false); err != nil {
+			t.Fatal(err)
+		}
+		wroteCheckpoint("gAAAAB-gone-paused", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{User: "me@example.com"}}})
+		body := askGone(t, "gAAAAB-gone-paused")
+		for _, want := range []string{"me@example.com", "paused"} {
+			if !strings.Contains(body, want) {
+				t.Errorf("no %q in %s", want, body)
+			}
+		}
+		if strings.Contains(body, "switched off, removed, or no longer serves") {
+			t.Errorf("the three states as one sentence in %s", body)
+		}
+	})
+
+	t.Run("signed out or removed", func(t *testing.T) {
+		codexSignedIn(t, "spare@example.com")
+		newResetBackend(t, "spare@example.com")
+		wroteCheckpoint("gAAAAB-gone-signed-out", candidate{p: provider.Provider{ID: "codex", Account: &provider.Account{User: "gone@example.com"}}})
+		body := askGone(t, "gAAAAB-gone-signed-out")
+		for _, want := range []string{"gone@example.com", "signed out of magpie or removed"} {
+			if !strings.Contains(body, want) {
+				t.Errorf("no %q in %s", want, body)
+			}
+		}
+		if strings.Contains(body, "switched off, removed, or no longer serves") {
+			t.Errorf("the three states as one sentence in %s", body)
+		}
+	})
+}
+
 // #2517: a conversation compacted natively by an account goes only to it,
 // so when that account is held at its usage cap the request is refused
 // saying so, not as if every account that serves the model were held: the
-- 
2.50.1 (Apple Git-155)
```

</details>
