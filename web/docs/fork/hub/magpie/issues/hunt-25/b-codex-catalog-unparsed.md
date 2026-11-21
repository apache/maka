## 现象

`~/.codex/magpie-models.json`（magpie 为 Codex 维护的模型清单，**含用户手填的键**——#1450 的 `supports_reasoning_summaries` 等）在这个文件不能解析时会被整体覆盖或直接删除，不留任何副本：

- 下一次模型清单同步（加 provider 后 `SyncCatalog`）、模型切换、或重新接回 magpie 时，写入覆盖它；
- magpie 退出作为 Codex 的 provider 时（`Set("")`），`dropList` 把它当成「没有用户内容的清单」**直接删除**。

#1450 的保留机制（`codexcat.Keep`）对读不了的文件无能为力：`internal/codexcat/codexcat.go:310`（2e2c8903 行号，下同）`if len(cur) == 0 || read(cur, &was) != nil { return b }`——解析失败 = 什么都不保留，随后 `edit.WriteAtomic` 用新清单整体覆盖。这正是 #2263 修复的那类形状（读不了≠空、写前留副本），但 #2263 的清扫清单里没有这个文件，豁免清单（可重建缓存）里也没有它——它是漏网，不是声明豁免。

破坏来源与 #2263 各文件相同：编辑器半截保存、同步工具冲突写入、（历史上的）崩溃零字节。文件一旦损坏，用户手填的键在没有任何副本的情况下消失。

## 最小复现

`internal/agent/codex_catalog_unparsed_test.go`（沙盒 HOME）：

1. `codexHome` 起家，接上 magpie 写出清单；
2. 把 `magpie-models.json` 手工破坏（去掉末尾两个字节，不再是合法 JSON）；
3. 加一个 provider，`SyncCatalog` → 清单被新清单覆盖，`magpie-models.json.bad-*` 副本不存在（修复前）；
4. 再次破坏文件，`Set("")` 退出 → 文件被删除，同样没有副本（修复前）。

## 根因

`internal/agent/codex.go`（2e2c8903）：

- `codexcat.Keep`（`internal/codexcat/codexcat.go:310`）：解析失败的现文件按「没有用户内容」处理；
- 写入点三处（`codex.go` relist ≈:326、Set ≈:983、legacy setup ≈:1180）：`edit.WriteAtomic(catalogPath, ownList())` 前无任何留副本守卫；
- `dropList`（`codex.go:253`）：`codexcat.Keep(cur, b) == b` 对解析失败的文件恒真 → `os.Remove(catalogPath)` 无副本删除。

对比 #2263 的规则（`docs/subsystems/providers-accounts.md`）：读不了的状态文件在覆盖前以 `lastgood.KeepUnparsed` 留 `.<name>.bad-<time>` 副本，副本失败则停止写入。

## 修法

`internal/agent/codex.go`：

- 新增 `writeOwnList(path, b)`：写入前 `lastgood.KeepUnparsed(path, catalogParses)`（`catalogParses` = 能否解析成 `{"models":[…]}`，即 Keep 读的形状），三个写入点全部走它；
- `dropList` 在 `os.Remove` 前同样留副本，副本失败则不删。

magpie 自己的写入仍走 `edit.WriteAtomic`（本就原子），不新增格式或路径；Pi 的 `models.json` 不在范围内（其 `syncJSON` 对解析失败的文件本来就是 no-op，不覆盖）。

patch 同步更新 `docs/subsystems/providers-accounts.md` 的 #2263 文件清单。

## 验证

| 检查 | 结果 |
|---|---|
| TestUnparsedCodexCatalogKeptAside @ 2e2c8903（修复前） | FAIL：`the unparsed list was written over with no copy kept` |
| 同测 @ 24a08751（修复后） | PASS（两个面：覆盖留副本、删除留副本） |
| TestCodexCatalogKeepsWhatTheUserAdded / TestCodexCatalogRemovedWhenNothingAdded（#1450 回归） | PASS |
| go test -tags nogui -p 2 -count=1 -timeout 25m ./internal/agent 全包 @ 24a08751 | ok 183s |
| 消融：`git checkout 24a08751~1 -- internal/agent/codex.go` 后重放 | 复红，失败信息与修复前同形 |
| gofmt -l internal/agent | 空 |
| go vet -tags nogui / GOOS=linux go vet -tags nogui / GOOS=windows go vet | 过 |
| go build 三平台（linux 带 nogui） | 过（仅已知 trayimage cgo `-Wenum-conversion` 与 ld 重复库警告） |

没跑什么：

- 真实损坏文件（崩溃零字节、编辑器半截保存）未逐一构造——测试用截断破坏，`lastgood.KeepUnparsed` 的语义由 #2263 的套件覆盖；
- Pi/OmO 等 `models.json` 未动（`syncJSON` 对坏文件 no-op，无同病证据）；
- Windows 实机未跑（本机 macOS；`internal/agent` 的 Windows CI 只编译测试）；
- TestOffline（本机网络环境红）未跑。

同族先例：#2263（applied.json / wsl.json / sessions-wsl.json 等十四个文件的同一规则，已合入 58651568）、#1505 家族规则。

分支：[ggbdpq/magpie `hunt25-sib-codex-catalog-unparsed`](https://github.com/ggbdpq/magpie/tree/hunt25-sib-codex-catalog-unparsed)，head `24a08751`。

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>patch</summary>

```
From 24a08751beb5184f9aea1fe2d8aa27b4a91bedc7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:22:08 +0800
Subject: [PATCH] agent: a magpie-models.json that doesn't parse is kept aside,
 not written over or removed whole

What changed: #2263 gave magpie's state files whose reader takes an
unparseable file as empty the lastgood.KeepUnparsed copy-aside, and its
sweep named the files it covered. Codex's magpie-models.json was in
neither its covered list nor its cache exemption, and its reader has the
exact missed shape: codexcat.Keep (#1450) returns the new list for a
file it can't parse, and the next sync, model switch or stepping back in
wrote that over the file, ending the keys the user added by hand
(supports_reasoning_summaries and friends) with no copy. Stepping out
was worse: dropList took an unparseable file for one holding nothing of
the user's and removed it outright.

Now the three writers of the list go through writeOwnList, which keeps
an unparsed file aside (magpie-models.json.bad-<time>) before the write
and stops when the copy can't be made, and dropList keeps one aside
before it removes the file.

Run:
- gofmt -l internal/agent: clean.
- go test -tags nogui -p 2 -count=1 -timeout 25m ./internal/agent: ok
  (183s).
- TestUnparsedCodexCatalogKeptAside fails on the code before this ("the
  unparsed list was written over with no copy kept"); the ablation
  replays it against this commit's parent.
- go vet -tags nogui, GOOS=linux go vet -tags nogui, GOOS=windows go
  vet, three go builds: see the push's checks.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md         |  2 +-
 internal/agent/codex.go                       | 35 ++++++++++--
 internal/agent/codex_catalog_unparsed_test.go | 53 +++++++++++++++++++
 3 files changed, 86 insertions(+), 4 deletions(-)
 create mode 100644 internal/agent/codex_catalog_unparsed_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index 0501ff55..478a72e7 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -176,7 +176,7 @@ readings on both sides of detected boundaries.
 - An unreadable `providers.json` is an error, never an empty list. Saving over an empty list would lose every provider.
 - When `logins.json` cannot be decoded as saved accounts, reads keep the accounts read before. Before saving a change, `lastgood.Keep` ([lastgood.go](../../internal/lastgood/lastgood.go)) keeps the file there now: as `logins.json.bak`, its last good generation, when it reads, or copied aside as `logins.json.bad-<time>` (`-2`, `-3`… for another within one second) when it doesn't, including valid JSON with invalid account field types, so its credentials can be recovered. If the existing file cannot be read or the copy fails, saving returns the error and leaves the original file unchanged. A missing file can be created normally.
 - A Windows machine that went down mid-write left `logins.json` and `plugin-auth.json` at their full length, every byte zero (#1505): the rename reached the disk before the data. Every write of magpie's own state goes through `steady.WriteFile` (or `edit.WriteAtomic`), which flushes the temp file before renaming it in, and the plugin host's `writeDurable` does the same. So does every write of an agent's own sign-in (#2239): `codexToken`'s rotated tokens into Codex's `auth.json` (`~/.codex`, or `$CODEX_HOME` when set) and `writeClaudeCredential`'s `.credentials.json` go through `writePrivate`, never a truncating `os.WriteFile`, so a machine going down mid-write leaves the old sign-in whole, and on Windows a file another program holds for a moment is waited out (`steady.Rename`) instead of the rotation being dropped while the refresh token on the disk is spent. A file that is there but doesn't read on a cold start is read from its `.bak` (`lastgood.Read`/`Fallback`): `logins.json`, `providers.json`, `migrations.json`, `settings.json`, `profiles.json`, `plugins.json`, `plugin-auth.json` and `mcp-signins.json`. `caller-keys.json` is flushed the same way but never read from a `.bak`: a key revoked in the last write would come back, so a store that doesn't read still refuses every key. The recovery is logged and listed in `/api/state`'s `recovered`, which the window tells once (`recoveredOnce`). The `.bak` lags one write behind on purpose: a crash zeroes the latest write, so a copy made with it could be zeroed too. With no good `.bak` the file is unknown, never empty: a sign-out leaves `plugin-auth.json` or `mcp-signins.json` as it is (magpie's own returns the error), and a sign-in added copies the file aside before it writes.
-- A state file whose reader takes one that doesn't unmarshal into its type as empty is copied aside before it is written over (`lastgood.KeepUnparsed` with `lastgood.Into[T]`, #2263): valid JSON of another shape, `[]` for a map, counts as not parsing. A copy that can't be made stops the write. These are `stash.json`, `applied.json` and `wsl.json` ([agent](../../internal/agent/)), `sessions-wsl.json` and `gateway-sessions-hidden.json` ([sessions](../../internal/sessions/)), `stepfun-auth.json`, `login-returns.json`, `quota-history.json`, `balance-history.json` and `credits-daily.json` ([provider](../../internal/provider/)), `claude-desktop.tiers.json`, `plugin-updates.json`, `usage-computer.json` and `sync-state.json`. Caches magpie fills again by itself (last quota readings, check-in and warm-up marks, plugin icons, npm and GitHub lookups, client shapes, seats, alert marks, `served.json`, `bun/state.json`) are still written over: losing one costs a refetch or a repeated notice.
+- A state file whose reader takes one that doesn't unmarshal into its type as empty is copied aside before it is written over (`lastgood.KeepUnparsed` with `lastgood.Into[T]`, #2263): valid JSON of another shape, `[]` for a map, counts as not parsing. A copy that can't be made stops the write. These are `stash.json`, `applied.json`, `wsl.json` and Codex's `magpie-models.json` ([agent](../../internal/agent/), whose hand-added model keys `codexcat.Keep` can't hold when the file doesn't parse), `sessions-wsl.json` and `gateway-sessions-hidden.json` ([sessions](../../internal/sessions/)), `stepfun-auth.json`, `login-returns.json`, `quota-history.json`, `balance-history.json` and `credits-daily.json` ([provider](../../internal/provider/)), `claude-desktop.tiers.json`, `plugin-updates.json`, `usage-computer.json` and `sync-state.json`. Caches magpie fills again by itself (last quota readings, check-in and warm-up marks, plugin icons, npm and GitHub lookups, client shapes, seats, alert marks, `served.json`, `bun/state.json`) are still written over: losing one costs a refetch or a repeated notice.
 - The gateway and a magpie run from a terminal change the same files (#1674). `loginsMu` is a [`filelock.Mutex`](../../internal/filelock/filelock.go): besides the mutex it holds an OS lock on `logins.json.lock` (flock, `LockFileEx` on Windows), and taking it has `logins.json` read afresh (`filememo.Look`), so every read a change is made from sees what another magpie wrote, and a refresh the gateway wrote is never written back over. `savedTokenMu` holds `logins.json.renew.lock` the same way, so two magpies never spend one refresh token. `caller-keys.json` (`access`) and `mcp-signins.json` (`mcpauth`, with `mcp-signins.json.renew.lock` around a renewal) are changed under such locks too; `plugin-auth.json` already was, under `plugin-auth.json.lock`, which `host.js` takes too. A lock another magpie holds is waited for up to `filelock.Wait` (10s), then gone on without, as before there was one. `rememberLogins` writes nothing when only `Seen` would move on and the saved one is less than `seenEvery` (10 minutes) old, so a run that only lists accounts (`magpie ls`, `providers`, `sessions`, `usage`) leaves `logins.json` as it is. [`logins_lock_test.go`](../../internal/provider/logins_lock_test.go) covers both, the second with another test process writing between this one's read and write.
 - The account Codex or Claude Code is signed in to can be paused (`SetLoginOn` off, #263) only while another of its accounts is on. The gateway then sends it nothing: Codex's own-model turns go through routing, which passes over it (`OwnPaused`), and a native compaction (`/responses/compact`) goes to the first account on that isn't resting, signed as that account (`compactOn` in [codex_backend.go](../../internal/gateway/codex_backend.go)). The last other account off, the paused one is used again. A switched-off Codex provider is not a pause: Codex's own-model requests still relay on its sign-in as they came.
 - A switched-off provider (`Off`, #163) stays saved. The gateway says it is off instead of saying the model is unknown.
diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index b36cb058..82abb85a 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -21,6 +21,7 @@ import (
 	"github.com/yetone/magpie/internal/codexcat"
 	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/gateway"
+	"github.com/yetone/magpie/internal/lastgood"
 	"github.com/yetone/magpie/internal/provider"
 	"github.com/yetone/magpie/internal/sessions"
 	"github.com/yetone/magpie/internal/settings"
@@ -204,6 +205,28 @@ func codexEfforts(ms []catalog.Model, model string) []Option {
 	return append([]Option{d}, static(e...)...)
 }
 
+// catalogParses is whether b is a model list magpie writes for Codex, the
+// shape Keep reads of the file there.
+func catalogParses(b []byte) bool {
+	var v struct {
+		Models []map[string]any `json:"models"`
+	}
+	return json.Unmarshal(b, &v) == nil
+}
+
+// writeOwnList writes the model list magpie keeps for Codex at path. A file
+// there that doesn't parse is copied aside first: Keep (#1450) holds
+// nothing of a file it can't read, so writing the new list over one would
+// end the keys the user added by hand with no copy (#2263's rule for
+// magpie's state files, which this file had missed). An error stops the
+// write.
+func writeOwnList(path string, b []byte) error {
+	if err := lastgood.KeepUnparsed(path, catalogParses); err != nil {
+		return err
+	}
+	return edit.WriteAtomic(path, b)
+}
+
 func codexIn(at place) *Agent {
 	dir := at.codexHome()
 	path := filepath.Join(dir, "config.toml")
@@ -257,6 +280,12 @@ func codexIn(at place) *Agent {
 		}
 		b := list()
 		if string(codexcat.Keep(cur, b)) == string(b) {
+			// one that doesn't parse is copied aside before it goes: Keep
+			// held nothing of it, so removing it outright would end the
+			// user's own keys with no copy
+			if err := lastgood.KeepUnparsed(catalogPath, catalogParses); err != nil {
+				return
+			}
 			os.Remove(catalogPath)
 		}
 	}
@@ -323,7 +352,7 @@ func codexIn(at place) *Agent {
 		case asProvider() && ownCatalog(get("model_catalog_json")):
 			b := ownList()
 			if cur, _ := edit.Read(catalogPath); string(cur) != string(b) {
-				return edit.WriteAtomic(catalogPath, b)
+				return writeOwnList(catalogPath, b)
 			}
 		case viaBase():
 			return codexStaleCache(filepath.Join(dir, "models_cache.json"), provider.CodexListTag())
@@ -980,7 +1009,7 @@ func codexIn(at place) *Agent {
 			if err := putProvider(); err != nil {
 				return err
 			}
-			if err := edit.WriteAtomic(catalogPath, ownList()); err != nil {
+			if err := writeOwnList(catalogPath, ownList()); err != nil {
 				return err
 			}
 			// a thread started on Codex's built-in provider stays on it when
@@ -1177,7 +1206,7 @@ func codexIn(at place) *Agent {
 				}
 				b := ownList()
 				if cur, _ := edit.Read(catalogPath); string(cur) != string(b) {
-					if err := edit.WriteAtomic(catalogPath, b); err != nil {
+					if err := writeOwnList(catalogPath, b); err != nil {
 						return err
 					}
 				}
diff --git a/internal/agent/codex_catalog_unparsed_test.go b/internal/agent/codex_catalog_unparsed_test.go
new file mode 100644
index 00000000..a8387140
--- /dev/null
+++ b/internal/agent/codex_catalog_unparsed_test.go
@@ -0,0 +1,53 @@
+package agent
+
+import (
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A magpie-models.json that doesn't parse is kept aside before magpie
+// writes its list over the file or takes the file away: Keep (#1450) can
+// hold nothing of a file it can't read, so the keys the user added by hand
+// would end with no copy — the rule the other state files were given
+// (#2263), which this file missed.
+func TestUnparsedCodexCatalogKeptAside(t *testing.T) {
+	home, _ := codexHome(t, "", "")
+	list := filepath.Join(home, ".codex", "magpie-models.json")
+	cx := codex(home)
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	// the file as it stands, broken the way a half-save or a sync conflict
+	// leaves one: a cut before the last brace, no longer a catalog
+	b := readFile(list)
+	writeFile(t, list, b[:len(b)-2])
+
+	// a provider added: the sync writes the list again
+	if err := provider.Save(provider.Provider{ID: "added", Name: "Added", Key: "k", Chat: "http://127.0.0.1:1/v1", Models: []string{"m2"}}); err != nil {
+		t.Fatal(err)
+	}
+	SyncCatalog()
+	if !strings.Contains(readFile(list), `"added/m2"`) {
+		t.Fatal("sync didn't write the new model")
+	}
+	if bad, _ := filepath.Glob(list + ".bad-*"); len(bad) == 0 {
+		t.Fatalf("the unparsed list was written over with no copy kept")
+	}
+
+	// the list broken again, and magpie steps out: the file goes, but a
+	// copy of what it held stays
+	writeFile(t, list, b[:len(b)-2])
+	if err := cx.Fields[0].Set(""); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := os.Stat(list); err == nil {
+		t.Error("a list magpie steps out of stayed")
+	}
+	if bad, _ := filepath.Glob(list + ".bad-*"); len(bad) == 0 {
+		t.Fatalf("the unparsed list was removed with no copy kept")
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
