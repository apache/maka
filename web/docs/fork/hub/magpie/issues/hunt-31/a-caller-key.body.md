核实了，已修，patch 在本评论末尾（分支 [hunt31-a-audit-caller-key](https://github.com/ggbdpq/magpie/tree/hunt31-a-audit-caller-key)，commit `0bced626`，基于 main `ea3dee96`）。

## 根因（对照 main `ea3dee96`）

- `writeTiers`（`internal/agent/claude.go` 的 `env.ANTHROPIC_AUTH_TOKEN` 写入处）：每次模型/tier 写入无条件写 `wiredKey()`，既不问 `gatewayTakes` 也不 stash——用户 caller key 被直接覆盖，且无任何记录可找回。
- `putProvider` 与线程 provider 表写入（`internal/agent/codex.go` 两处 `experimental_bearer_token`）：同样无条件写 `at.gwKey()`，本单点名的 Codex 兄弟面。
- #2510（`d9b94355`）修好了 Check 误报（`wiringOff` 走 `keyHolds`）和 sync/install 侧的覆盖（`mergeKept`、Reasonix install），但没动这三处直写——本单复现里的第 4 步仍丢 key。本帖红测试也证实：Check 对 caller key 已静默，模型写入仍覆盖。

## 修法

- 三个写入点都在写前问一次 `keyHolds(现值, 将写值)`：现值是网关会认证的 caller key（`access.Authenticate` 通过）就保留用户值不写；网关会拒绝的值（外来 key、已停用的 key）仍自愈回 magpie 的 key。与 sync 侧 `mergeKept` 的 #2510 语义一致。
- 登录字段自己的 Set（`claudeai` 开关）照单内建议不动。
- `docs/subsystems/agent-wiring.md` 同步一句：原文"a key put there by hand is reported by Check, not taken for magpie's"自 #2510 起已不准确。

## 验证（ea3dee96 + 本 patch，t.TempDir 沙盒 HOME）

| 检查 | 结果 |
| --- | --- |
| 修前红（显式摘 `claude.go`+`codex.go` 两产品文件跑新测试） | 两测试断言红：`a model pick wrote over the user's caller key`，形状与本单第 5 步一致（claude：`ANTHROPIC_AUTH_TOKEN: "magpie"`；codex：`experimental_bearer_token = "magpie"`） |
| 新增 `TestClaudePickKeepsAGatewayKeyOfTheUsers` / `TestCodexPickKeepsAGatewayKeyOfTheUsers` | caller key 拾取后存活、外来 key 仍被自愈，绿 |
| 定向族 `TestClaude|TestCodex|TestKeyHolds|TestHermes|TestDsh|TestQwen`（`go test -tags nogui -p 2`） | ok（83.8s） |
| `gofmt -l internal/` | clean |
| `go vet` darwin / linux(nogui) / windows | clean |
| `go build` darwin / linux(nogui) / windows | ok（`trayimage_darwin.go` cgo `-Wenum-conversion` 与 ld 重复库警告，已知环境噪声） |

## 没跑什么

- 真 Claude Code / Codex 对着改后配置实跑（测试用沙盒 HOME 与假 provider，走与产品同一代码路径的 `Field("model").Set`）。
- internal/agent 全包套件（本机负载下 45 分钟起，只跑了上列定向族）。
- 线程 provider 表写入点的守卫对真实 Codex 会话文件的行为（该点只写 config 里尚不存在的表，`keptBearerToken` 在那里是空操作；保留守卫是为兄弟面一致）。

另外 `http_headers` 里的 `x-openai-actor-authorization: "magpie"` 保持原样——它是 provider 身份标记不是凭据；若这处也要守卫请说一声，我再补。

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)

<details>
<summary>patch（commit 0bced626，git format-patch -1 --stdout 全文）</summary>

```patch
From 0bced626cd8de8825a9b49187847969b7ca4665c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 20:36:09 +0800
Subject: [PATCH] agent: a caller key of the gateway's own in Claude Code's and
 Codex's config survives a model pick (#2545)

What changed:
- writeTiers (claude.go) wrote env.ANTHROPIC_AUTH_TOKEN = wiredKey() on
  every model and tier pick, and putProvider beside the thread-provider
  tables (codex.go) wrote experimental_bearer_token = at.gwKey() the
  same way: a caller key of the gateway's own the user put in their
  place was written over, and it was never stashed, so no Disconnect
  brought it back. Both keep such a token now, as a sync keeps one
  (mergeKept, keyHolds of #2510): only a value the gateway would refuse
  is wired over. The sign-in field's own Set is unchanged, as that
  switch is the user's own.
- docs/subsystems/agent-wiring.md's sentence about a hand-set key said
  Check reports it; Check has taken one since #2510, and a pick keeps
  it now too.

Run, at ea3dee96 in the worktree /tmp/magpie-hunt31-a (tests in their
own t.TempDir homes):
- New TestClaudePickKeepsAGatewayKeyOfTheUsers and
  TestCodexPickKeepsAGatewayKeyOfTheUsers: red on ea3dee96 with both
  product files stashed ("a model pick wrote over the user's caller
  key", the shapes #2545 names), green with the fix. The ablation is
  this tree minus internal/agent/claude.go and internal/agent/codex.go.
- go test -tags nogui -p 2 -count=1 -run
  'TestClaude|TestCodex|TestKeyHolds|TestHermes|TestDsh|TestQwen'
  ./internal/agent/: ok (83.8s).
- gofmt -l internal/: clean. go vet ./internal/agent/, GOOS=linux
  go vet -tags nogui ./internal/agent/ and GOOS=windows go vet
  ./internal/agent/: clean. go build, GOOS=linux go build -tags nogui
  and GOOS=windows go build: ok, with trayimage_darwin.go's cgo
  -Wenum-conversion warning and ld's duplicate-library warnings, known.
Not tried: a real Claude Code or Codex run against the picked config.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/agent-wiring.md    |  2 +-
 internal/agent/claude.go           | 10 +++++-
 internal/agent/claude_test.go      | 57 ++++++++++++++++++++++++++++++
 internal/agent/codex.go            | 18 ++++++++--
 internal/agent/codex_route_test.go | 41 +++++++++++++++++++++
 5 files changed, 124 insertions(+), 4 deletions(-)

diff --git a/docs/subsystems/agent-wiring.md b/docs/subsystems/agent-wiring.md
index 82cf2e54..80567d44 100644
--- a/docs/subsystems/agent-wiring.md
+++ b/docs/subsystems/agent-wiring.md
@@ -72,7 +72,7 @@ something else shows up as drift.
 - While this machine's Claude Desktop is on magpie, Claude Code's shared settings get `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP="1"` (`writeExplore` in `claudeIn`, [`claude.go`](../../internal/agent/claude.go)). Claude Code 2.1.295's Explore inherit cap can otherwise replace Desktop's `mythos-magpie` compatibility alias with Opus. This disables that cap, not the model choices of all subagents. It applies with Desktop alone or beside a connected Claude Code, including model picks and Sync; WSL twins do not get it. A user's existing value, including an empty string, stays. The stash (`claude.explore_inherit_cap`) marks only magpie's value: taking Claude Code off magpie leaves it while Desktop is on, and taking Desktop off removes it only if the user has not changed it. Since the settings file is shared, other Claude Code sessions reading it see the flag while Desktop is connected too.
 - Claude Code's tier and subagent models the user had set for their own endpoint (`claudeOwnEnv`) are stashed with that endpoint and token when magpie is wired in, and come back with them when magpie steps out, by Disconnect or by Claude Code's own model (#1050). So does their main model in the env (`ANTHROPIC_MODEL`, a Bedrock model id beside `CLAUDE_CODE_USE_BEDROCK` for one), which magpie takes out while wired in because it outranks a pick in `/model`.
 - Claude Code's provider switches (`agentenv.ClaudeProviders`: `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, `_ANTHROPIC_GOOGLE_CLOUD`, `_MANTLE`, Claude Code 2.1.300) send it to that cloud's own endpoint and pass `ANTHROPIC_BASE_URL` over, so with one on it never reaches magpie (jw1dev on X: Bedrock refused magpie's model, and magpie showed nothing). Claude Code reads 1, true, yes and on as on (`claudeSwitchOn`). One that is on in the settings magpie writes is taken out on every route that writes the wiring (`dropClouds` in `writeTiers` and `Sync`), its raw value stashed (`claude.cloud.<var>`, under the distro's id for a WSL twin), and put back as written when magpie steps out (`putClouds` in `unroute`), unless the user set it again since. The cloud's own variables (`AWS_*`, `ANTHROPIC_VERTEX_PROJECT_ID`, …) and a switch that is off stay. Where magpie doesn't write it, Check says so, naming the variable, the cloud and where (`claudeCloud`): the managed settings, which win over the user's; `~/.claude.json`'s env, under the user's settings; and, for this machine's Claude Code, the login shell's environment (`proc.LoginEnv`, read but never set in magpie's), under every settings file. A project's `.claude/settings.json` isn't read: magpie doesn't know which folders Claude Code runs in. T3 Code's Check says the same of the user's `~/.claude` settings, which are put over its magpie instance's environment, and a switch put on that instance goes at its next write; that Check first says when the instance's `ANTHROPIC_BASE_URL` no longer reaches the gateway (`t3EnvOf`), as every agent's Check does, so a port move rewrites it too. The drift's detail is shown in the row's line and its pill through `tNotice` (`claude-cloud-drift.test.cjs`). Claude Desktop's Code tab runs with `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, under which Claude Code ignores a switch in settings files, so Desktop needs neither.
-- Claude Code's sign-in (`login`) is magpie's key (`""`, the default) or claude.ai (`claudeai`). claude.ai writes `ANTHROPIC_AUTH_TOKEN` empty, which Claude Code reads as no key: it keeps its claude.ai login and sends that to magpie, which never passes it on (`claudeSignIn` in the gateway). Every later write keeps the token empty (`wiredKey`), and a key put there by hand is reported by Check, not taken for magpie's. It's offered only where the gateway takes any key (`gwKey() == gateway.Token`: loopback, a WSL distro mirrored), not from a distro under NAT while magpie is shared on the network, where only the sharing key gets in. The choice is stashed, so it survives Disconnect and a port move. An empty token counts as magpie's only beside the address magpie last wrote (`claude.wired_at` in the stash, which Rewire carries to the new port, `keyOurs`): an endpoint of the user's own with an empty token stays theirs when the model goes back to Claude Code's own.
+- Claude Code's sign-in (`login`) is magpie's key (`""`, the default) or claude.ai (`claudeai`). claude.ai writes `ANTHROPIC_AUTH_TOKEN` empty, which Claude Code reads as no key: it keeps its claude.ai login and sends that to magpie, which never passes it on (`claudeSignIn` in the gateway). Every later write keeps the token empty (`wiredKey`), and a caller key of the gateway's own put there by hand is taken for magpie's, by Check and a model pick alike, kept as the user left it (`keyHolds`, #2545); a key the gateway would refuse is reported by Check and wired over. It's offered only where the gateway takes any key (`gwKey() == gateway.Token`: loopback, a WSL distro mirrored), not from a distro under NAT while magpie is shared on the network, where only the sharing key gets in. The choice is stashed, so it survives Disconnect and a port move. An empty token counts as magpie's only beside the address magpie last wrote (`claude.wired_at` in the stash, which Rewire carries to the new port, `keyOurs`): an endpoint of the user's own with an empty token stays theirs when the model goes back to Claude Code's own.
 - Claude Code's auto mode review (`CLAUDE_CODE_AUTO_MODE_SERVER`, `claudeReviewEnv` in [`claude.go`](../../internal/agent/claude.go)) is written `"0"` while Claude Code is routed through magpie and none of the models it can reach there is one Anthropic reviews (`claudeReviewed`, by `gateway.AutoModeReviewed`): those it is shown (and Claude Desktop's while Desktop is on magpie), a shown group's members, those providers' fallbacks, and the models it is set to. Off, it classifies locally from the start, as it does anyway behind a gateway that doesn't answer, without the "isn't eligible because your requests go through 127.0.0.1:3425" notice (1EFLOPS on X). Any reviewed model leaves it unset, since `/model` can take the session there; a model hidden from Claude Code doesn't count. It is rewritten on every model set and `Sync`, so adding a Claude provider turns the review back on. magpie's value is kept apart in the stash (`claude.auto_mode_server`), a user's own is left alone, and it goes when Claude Code is taken off magpie (`desktopOnly`, `unroute`). T3 Code's magpie instance, which runs Claude Code on the gateway through its own environment, carries the same `"0"` there by the models it lists (`t3InstanceJSON` in [`t3code.go`](../../internal/agent/t3code.go)); a value in the user's `~/.claude` settings comes after it.
 - Claude Code takes one window (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `claudeContextEnv` in [`claude.go`](../../internal/agent/claude.go)) for every model it doesn't know. Claude Code alone on magpie is told its main model's (`claudeWindow`). While Claude Desktop is on magpie too, its Code tab runs Claude Code on the same `~/.claude/settings.json` with every model Desktop lists, so magpie tells it the largest window of those and of Claude Code's own models, and holds each model below it to its own with `modelSettings.<id>.autoCompactWindow` (`claudePlan` in [`claude_budget.go`](../../internal/agent/claude_budget.go), #2025: the least held a 1M model to 131K). Claude Code 2.1.296 matches that key by the id it was handed, lowercased and without `[1m]`; it comes before the top-level `autoCompactWindow`, which serves a model without one. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` would take precedence over both, so in this mode magpie's working window goes in the top-level `autoCompactWindow` instead, and an entry is written only where a model's window or its own threshold differs from what it would run at without one. magpie's entries and top-level value are stashed (`claude.model_budgets`, `claude.compact_default`) and go when Desktop leaves magpie; the user's own entries, top-level value and variables stay, a user's entry past its model's window (or `auto`) holds the largest to that window, and with a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` of the user's the least window is told as before.
 - Claude Code is told what each of magpie's models can do in `CLAUDE_CODE_MODEL_CAPABILITIES` (`claudeCapsEnv`, `claudeCapabilities` in [`claude.go`](../../internal/agent/claude.go)): `<model>=effort[,xhigh_effort][,max_effort]` for those it is shown, and, while Claude Desktop is on magpie, for Desktop's `mythos-magpie-<number>` ids its Code tab hands it. A Claude model Claude Code knows gets no more than Claude Code gives it (Opus and Sonnet 4.6: no xhigh), and one with no known levels isn't named. A model that reaches max without xhigh (GLM-5.3 at low/high/max, DeepSeek V4 at high/max) is said to have xhigh too: the gateway runs xhigh at max for it (`fitEffort`), and Claude Code 2.1.299 turns Ultracode down without `xhigh_effort` ("Ultracode isn't available on …"), which in Desktop is the Ultracode level and dynamic workflows (leesunrise2364 on Discord; `TestClaudeModelCapabilities`). A value of the user's is left alone.
diff --git a/internal/agent/claude.go b/internal/agent/claude.go
index 3538b39f..d25db7f0 100644
--- a/internal/agent/claude.go
+++ b/internal/agent/claude.go
@@ -1479,9 +1479,17 @@ func claudeIn(at place) *Agent {
 			}
 		}
 		gw := gwAt()
+		tok := wiredKey()
+		// a caller key of the gateway's own where magpie's token goes goes
+		// through magpie all the same: theirs stays, as a sync keeps one
+		// (mergeKept, keyHolds); only a value the gateway would refuse is
+		// wired over (#2545)
+		if v, _ := edit.GetJSON(path, "env.ANTHROPIC_AUTH_TOKEN"); v != tok && keyHolds(v, tok) {
+			tok = v
+		}
 		kvs := []edit.KV{
 			{Path: "env.ANTHROPIC_BASE_URL", Value: gw},
-			{Path: "env.ANTHROPIC_AUTH_TOKEN", Value: wiredKey()},
+			{Path: "env.ANTHROPIC_AUTH_TOKEN", Value: tok},
 			{Path: "env.ANTHROPIC_SMALL_FAST_MODEL", Value: spell(tiers["haiku"])},
 			{Path: "model", Value: spell(main)},
 		}
diff --git a/internal/agent/claude_test.go b/internal/agent/claude_test.go
index 0d653a3f..24718c24 100644
--- a/internal/agent/claude_test.go
+++ b/internal/agent/claude_test.go
@@ -5,6 +5,7 @@ import (
 	"path/filepath"
 	"testing"
 
+	"github.com/yetone/magpie/internal/access"
 	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/provider"
 )
@@ -177,3 +178,59 @@ func TestClaudeEffortMax(t *testing.T) {
 		t.Fatal("ultra taken")
 	}
 }
+
+// #2545: a key made under Gateway keys, put in Claude Code's
+// ANTHROPIC_AUTH_TOKEN in place of magpie's, goes through magpie all the
+// same, so a model pick keeps it, as a sync keeps one. A key the gateway
+// doesn't take is still wired over.
+func TestClaudePickKeepsAGatewayKeyOfTheUsers(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro"}}); err != nil {
+		t.Fatal(err)
+	}
+	path := filepath.Join(home, ".claude", "settings.json")
+	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(path, []byte(`{"theme": "dark"}`), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	a := claude(home)
+	if err := a.Field("model").Set("deepseek/pro"); err != nil {
+		t.Fatal(err)
+	}
+	if tok, _ := edit.GetJSON(path, "env.ANTHROPIC_AUTH_TOKEN"); tok == "" {
+		b, _ := os.ReadFile(path)
+		t.Fatalf("not wired:\n%s", b)
+	}
+	secret, err := access.Update("add-key", access.Change{Name: "claude"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	if err := edit.SetJSON(path, edit.KV{Path: "env.ANTHROPIC_AUTH_TOKEN", Value: secret}); err != nil {
+		t.Fatal(err)
+	}
+	if d := a.Check(); d != "" {
+		t.Fatalf("a key the gateway issued is drift: %s", d)
+	}
+	if err := a.Field("model").Set("deepseek/pro"); err != nil {
+		t.Fatal(err)
+	}
+	if v, _ := edit.GetJSON(path, "env.ANTHROPIC_AUTH_TOKEN"); v != secret {
+		b, _ := os.ReadFile(path)
+		t.Fatalf("a model pick wrote over the user's caller key:\n%s", b)
+	}
+	if err := edit.SetJSON(path, edit.KV{Path: "env.ANTHROPIC_AUTH_TOKEN", Value: "sk-not-this-gateways"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Field("model").Set("deepseek/pro"); err != nil {
+		t.Fatal(err)
+	}
+	if v, _ := edit.GetJSON(path, "env.ANTHROPIC_AUTH_TOKEN"); v == "sk-not-this-gateways" {
+		t.Fatalf("a key the gateway doesn't take is kept: %q", v)
+	}
+}
diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 96d01905..b9d6eccf 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -386,12 +386,26 @@ func codexIn(at place) *Agent {
 		return dropSubEffort()
 	}
 	// magpie as a provider Codex can name; its threads started on magpie do
+	// keptBearerToken is the table's bearer token when it is one the
+	// gateway takes: a caller key of the gateway's own the user put in
+	// magpie's token's place goes through magpie all the same, so theirs
+	// stays, as a sync keeps one (keyHolds); only a value the gateway would
+	// refuse is wired over (#2545)
+	keptBearerToken := func(table string) string {
+		tok := at.gwKey()
+		if t, err := edit.GetTOMLTable(path, table); err == nil {
+			if v := t["experimental_bearer_token"]; v != tok && keyHolds(v, tok) {
+				return v
+			}
+		}
+		return tok
+	}
 	putProvider := func() error {
 		return edit.SetTOMLTable(path, "model_providers."+magpieID,
 			edit.KV{Path: "name", Value: "magpie"},
 			edit.KV{Path: "base_url", Value: at.v1()},
 			edit.KV{Path: "wire_api", Value: "responses"},
-			edit.KV{Path: "experimental_bearer_token", Value: at.gwKey()},
+			edit.KV{Path: "experimental_bearer_token", Value: keptBearerToken("model_providers." + magpieID)},
 			// Codex offers its built-in image tool (image_gen.imagegen) and
 			// the other OpenAI-provider tools only to a provider it reads as
 			// the OpenAI actor: one that does not require OpenAI auth but
@@ -533,7 +547,7 @@ func codexIn(at place) *Agent {
 				edit.KV{Path: "name", Value: id},
 				edit.KV{Path: "base_url", Value: at.v1()},
 				edit.KV{Path: "wire_api", Value: "responses"},
-				edit.KV{Path: "experimental_bearer_token", Value: at.gwKey()},
+				edit.KV{Path: "experimental_bearer_token", Value: keptBearerToken("model_providers." + id)},
 			); err != nil {
 				return err
 			}
diff --git a/internal/agent/codex_route_test.go b/internal/agent/codex_route_test.go
index cdd8d2b9..af4d84dc 100644
--- a/internal/agent/codex_route_test.go
+++ b/internal/agent/codex_route_test.go
@@ -6,6 +6,8 @@ import (
 	"strings"
 	"testing"
 
+	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/edit"
 	"github.com/yetone/magpie/internal/provider"
 )
 
@@ -416,3 +418,42 @@ func TestCodexSyncPutsProviderTableBack(t *testing.T) {
 		t.Fatalf("own model:\n%s", cfg)
 	}
 }
+
+// #2545: a key made under Gateway keys, put in the provider table's
+// experimental_bearer_token in place of magpie's, goes through magpie all
+// the same, so a model pick keeps it, as a sync keeps one. A key the
+// gateway doesn't take is still wired over.
+func TestCodexPickKeepsAGatewayKeyOfTheUsers(t *testing.T) {
+	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`,
+		"model = \"gpt-5.5\"\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n")
+	cx := codex(home)
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	if cfg := read(); !strings.Contains(cfg, `experimental_bearer_token = "magpie"`) {
+		t.Fatalf("not wired:\n%s", cfg)
+	}
+	secret, err := access.Update("add-key", access.Change{Name: "codex"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	path := filepath.Join(home, ".codex", "config.toml")
+	if err := edit.SetTOMLKey(path, "model_providers.magpie", "experimental_bearer_token", secret); err != nil {
+		t.Fatal(err)
+	}
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	if cfg := read(); !strings.Contains(cfg, `experimental_bearer_token = "`+secret+`"`) {
+		t.Fatalf("a model pick wrote over the user's caller key:\n%s", cfg)
+	}
+	if err := edit.SetTOMLKey(path, "model_providers.magpie", "experimental_bearer_token", "sk-not-this-gateways"); err != nil {
+		t.Fatal(err)
+	}
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	if cfg := read(); strings.Contains(cfg, `experimental_bearer_token = "sk-not-this-gateways"`) {
+		t.Fatalf("a key the gateway doesn't take is kept:\n%s", cfg)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

