# gateway: 组中组的 Sink 不参与排序——只有 agent 点名的那一层会沉底

## 现象

嵌套路由（组里套组）时，把 Sink 开在**内层组**上没有任何效果：内层席位上「还剩额度却被 429 限速」的 key/account 不会沉到自己层级的队尾，休息一结束就又被打到最前面——这正是 Sink 要防的模式（sink.go 开头 01huadalang 的场景：vendor 风控盯上的就是这种账号）。同一个开关开在**外层组**上则正常工作（外层是对拍平后的全体做 sinkPlanned）。

也就是说：Sink 和嵌套组的 routing（#576 按自己的 routing 排）、rules（nestedRules 逐层生效）、effort（取最外层判定的那套机制）待遇不一致——内层的 routing/rules 都被尊重，唯独内层的 Sink 无人消费，开关是惰性的。

## 最小复现

`TestNestedGroupSinksItsOwnTier`（补丁新增）在 `c20bb76c4` 上失败，失败点就是根因本身——内层 a 被限速并睡完一觉后，下一轮计划仍然把它排第一：

```
--- FAIL: TestNestedGroupSinksItsOwnTier (0.00s)
    sink_test.go:166: "order": the tier's own Sink: order [a b], want [b a]
FAIL
```

测试形状：外层 `group/outer`（Ordered 或 Smart 各跑一遍）只含 `group/inner` 一个成员，inner 有自己的 Sink、两个各带一把 key 的 provider（a、b）。对 a 做一次 429（rate 词、额度未满 → failRate → `sink()` 已记录），`rested()` 把它的休息拨到已结束，再 plan 一次：期望 `[b a]`（a 沉底），实际 `[a b]`。对照分支：inner 关掉 Sink 时 a 第一（现状保留），外层开 Sink 时 b 第一（既有行为保留）。

## 根因

`internal/gateway/fallback.go`：

- `planGroup`（:380）只对 **agent 点名的组** 应用一次 `sinks(g.Sink, g.Routing)` → `sinkPlanned(out, pl.order)`。
- `planLevel` 递归进嵌套组的两个位置——加权 units 路径（:446）和 ordered 路径（:533）——拿到子层候选后**都不再看子层自己的 Sink**。递归时子组的 `Group` 就在手上（`m.Via[depth]`），信息在需要它的地方旁边，然后被丢掉。
- 沉底状态本身是无条件记录的：`restAfter` 的 failRate 分支（routing.go:694）不管任何组的 Sink 开关都会 `sink(c.restKey(), now)`。所以缺的只是应用，不是状态。

`internal/provider/group.go` 顶部对嵌套组的承诺是「its models are its own group's, ordered by its own routing and rules」——用户在内层组卡片上看到的 Sink 开关也在「自己的」那一份里。

## 修法

两处递归点在 `planLevel` 返回后按子层自己的 `sinks(m.Via[depth].Sink, m.Via[depth].Routing)` 应用一次 `sinkPlanned`（units 路径作用于 `cs`+`sub.order`；ordered 路径作用于返回切片和 `pl.order` 的对应尾段）。外层组的 Sink 照旧在 `planGroup` 对全体再排一次，两层互不干扰；`sinks()` 已排除 rotate/weighted/manual，语义不动。同步了 `planGroup` 的注释、`provider/group.go` 的嵌套组注释和 `docs/subsystems/gateway-routing.md` 的 Candidates 行。

一层说明：如果维护者认为「只有被点名的组的 Sink 生效」是有意的，那这个单的正确修法是一行文档而不是代码——请裁定。另观察到一个同形状的兄弟面（不在本单范围内）：嵌套组的 `Affinity` 同样只在外层被读（gateway.go:1832 的 scope/mode 取 `g.Affinity`），是否也是惰性开关，请维护者一并定夺。

## 验证

| 步骤 | 结果 |
| --- | --- |
| `TestNestedGroupSinksItsOwnTier` 在 `c20bb76c4`（stash 修复文件回红） | FAIL：`order [a b], want [b a]` |
| 打补丁后同测试（Ordered 与 Smart 两条外层路径） | PASS |
| 既有 `TestGroupRateLimitedSinks` / `TestRateLimitedSinksToTheBack` | PASS |
| `go test -tags nogui ./internal/gateway/` 全包（补丁后共跑三次：仅 Sink、Sink+CORS、rebase 到 `1ad60446f` 后） | ok（303s / 317s / 281s） |
| `-race -count=2`（两个新测试 + 两个 sink 测试） | ok |
| `gofmt -l internal/` | 空 |
| `go vet -tags nogui ./internal/gateway/`；`GOOS=linux go vet -tags nogui ./...`；`GOOS=windows go vet ./...` | 干净 |
| `go build -tags nogui`；`GOOS=linux go build -tags nogui`；`GOOS=windows go build` | ok |
| patch 独立可上：`git apply --check`（worktree 于 `c20bb76c4`） | ok |

分支：`hunt22-x2-nested-group-sink`（`2e93fe3c`，基于 `1ad60446f`；红测试最初在 `c20bb76c4` 上复现，rebase 只动了基座，被修函数未变）——https://github.com/ggbdpq/magpie/tree/hunt22-x2-nested-group-sink

同族：#2246（嵌套组的 firstToken 只读外层，同一函数家族的另一面）。

<details>
<summary>patch（git format-patch -1 --stdout，-U1 上下文）</summary>

```text
From 2e93fe3cb1035f8e83cebd3f652a3e040583b7e2 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 03:31:23 +0800
Subject: [PATCH] gateway: a group in the group sinks by its own Sink, as it
 routes by its own routing

What changed: planLevel applies a nested group's own Sink to its own
candidates at both places it plans one (the weighed units and the ordered
walk), the way it plans the tier by its own routing (#576) and its rules
(nestedRules): a tier with Sink on sends its rate-limited-with-quota-left
key to the back of its own order even when the agent asked for the outer
group. The outer group's Sink still orders the whole after. Docs and the
provider comment say so.

Run: TestNestedGroupSinksItsOwnTier fails on c20bb76c4 (order [a b], want
[b a], the tier's key rate limited first again) and passes with it;
TestGroupRateLimitedSinks, TestRateLimitedSinksToTheBack and the rest of
go test -tags nogui ./internal/gateway/ stay green; gofmt -l clean; go vet
-tags nogui, GOOS=linux go vet -tags nogui and GOOS=windows go vet clean;
go build, GOOS=linux go build -tags nogui and GOOS=windows build ok.
---
 docs/subsystems/gateway-routing.md |  2 +-
 internal/gateway/fallback.go       | 22 ++++++++++++--
 internal/gateway/sink_test.go      | 46 ++++++++++++++++++++++++++++++
 internal/provider/group.go         |  6 ++--
 4 files changed, 69 insertions(+), 7 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 6dcfbd21..bb2c2edf 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -32,3 +32,3 @@ backfilled; see [Gateway Session Aggregation](gateway-sessions.md).
 | Model resolution | `serve` resolves the model the agent asked for: Claude tier stand-ins, a routing group (`provider.GroupFor`: its id, the model's id however a vendor spells it, else the one group whose name it is, unless a provider serves a model by that id), auto stand-ins, the agent's own stand-in (`StandIn`: Codex's config.toml `model` when magpie is its provider, for a name it sends that magpie doesn't serve, such as its auto-review's `codex-auto-review`), itself taken through `GroupFor` and auto stand-ins so a config naming a group bare reaches it, then `provider.Resolve`. A Codex memory call or auto-review (`x-openai-subagent: guardian`, or `codex-auto-review`) that still names no served model goes to the model Codex's last turn was answered on (`codexMemoryStandIn`, per agent and gateway key), so a Codex on magpie through another provider table, a profile or another computer isn't answered 404 (Adam on Discord, `TestCodexAutoReviewReachesItsTurnsModel`). A bare model id several providers serve (MOMO on Discord: `glm-5.3` under opencode-go and a6api) is never refused: with found groups on (the default) `GroupFor` takes it to the group magpie found for it (`auto-<slug>`), its members in the Providers order, routed and failed over as any group, a conversation staying with the member that answered it while its cache is worth it (affinity); with them off, `Resolve` takes the first provider in the Providers order that exposes it, with no fallback. magpie writes only `provider/model` ids into agents' configs (`magpieModels`), so a bare id is one the user wrote. `/v1/models` lists bare ids only when the user asks for them ([Model ids without the provider](#model-ids-without-the-provider)). Every reply says who answered in `X-Magpie-Provider` and `X-Magpie-Model` (`noteMember`), and the usage log and the Routing page keep it. A model id with `~` and no slash that resolves as nothing else is the one served id (a provider's model or a group) whose slashes it spells as `~` (`unflat`, `provider.Unflat`; MiniMax Code's spelling, #1387), taken back in `validateModel` before key limits, middleware and usage see it; two ids spelled alike are neither. A Claude model id whose version is dashed (`relay/claude-opus-4-6-us`, with or without `:level` and `[1m]`) that is not served as spelled is the one served id it dashes (`provider.ClaudeUndashed`; the spelling magpie gives Claude Code, which reads a dotted version as Claude Opus 4), taken back in `validateModel` and `unprefixed` the same way. An unknown model gets a 404 naming why: a switched-off provider, a disabled group or an empty group. Otherwise it names up to three ids nearest to what was asked (`provider.Closest`: words of a model's display name count before words of its id, and a provider's id or name only alongside them, so "Zen-Space-Bunny" is told `opencode-zen-free/space-bunny-free`, MOMO on Discord), then the ways a model can be named, then every id (`unknownModel`; chat and embeddings). | [`gateway.go`](../../internal/gateway/gateway.go), [`internal/provider/group.go`](../../internal/provider/group.go), [`internal/provider/flat.go`](../../internal/provider/flat.go), [`internal/provider/claudedash.go`](../../internal/provider/claudedash.go) |
-| Candidates | `plan` lists one provider's candidates: one per key or account on, then each `Fallback` model, with resting ones last (`restLast`). `planGroup` and `planLevel` weigh a group's members together. A nested group plans by its own routing (#576). So does a member whose provider routes other than Smart (`ownRouting`): weighed as one by its first not resting (`firstAwake`), tried whole in its own order; `leastHeld` leaves such a group's order alone too. A provider on Smart, or routed as the group is, is pooled with the group's other keys and accounts. `group_own_routing_test.go`. A member's own fallbacks are not the group's. | [`fallback.go`](../../internal/gateway/fallback.go) |
+| Candidates | `plan` lists one provider's candidates: one per key or account on, then each `Fallback` model, with resting ones last (`restLast`). `planGroup` and `planLevel` weigh a group's members together. A nested group plans by its own routing (#576), and its own Sink orders its own keys and accounts before the group's Sink orders the whole. So does a member whose provider routes other than Smart (`ownRouting`): weighed as one by its first not resting (`firstAwake`), tried whole in its own order; `leastHeld` leaves such a group's order alone too. A provider on Smart, or routed as the group is, is pooled with the group's other keys and accounts. `group_own_routing_test.go`. A member's own fallbacks are not the group's. | [`fallback.go`](../../internal/gateway/fallback.go) |
 | Order of keys and accounts | `Routing`: smart (""), `order`, `rotate`, `usage` (least used, with an `usageHalfLife` of 1h), `pace` or `weight` (`weightedFirst`). Smart, `usage` and `pace` weigh a subscription by its allowance (`allowances`), and a key by its own usage windows when magpie reads them (`keyAllowance`: a sub2api key given a 5-hour, day or 7-day limit, or a key bought as a plan, such as Kimi Code's or a GLM Coding Plan's); any other key has none. A group routed `weight` (#1910) takes its members, not their keys, by smooth weighted round robin: `planLevel` makes each model member (its keys ordered by its own provider's routing) and each nested group one unit, and `weightedUnits` puts the round's pick (`group/<id>`, keyed by the member's spelling, `Group.Weights`, 1 if unset) first and the rest in member order for failover; a unit whose head rests leaves the round, and a kept conversation moves the round's charge to the member that kept it (`wrrSeat`, `wrrMove`). A lone key or account is weighed against nobody, but what it has left is still read into the trace (`weighRouted`), so the Routing page shows it as it does for several (#1016); all but used up, it keeps its conversation rather than being said to move (`affine`). A failure rests a candidate (`failure`, `failureOf`). A lone key or account is weighed against nobody, but what it has left is still read into the trace (`weighRouted`), so the Routing page shows it as it does for several (#1016); all but used up, it keeps its conversation rather than being said to move (`affine`). A failure rests a candidate (`failure`, `failureOf`). | [`routing.go`](../../internal/gateway/routing.go), [`weighted.go`](../../internal/gateway/weighted.go), [`internal/provider/routing.go`](../../internal/provider/routing.go) |
diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 46848bf5..af982a9f 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -373,3 +373,5 @@ func (s *Server) plan(p provider.Provider, model string, from provider.Protocol)
 // whole where that one goes — the group's routing picks between its
-// groups, never within them. A member's fallbacks are not the group's.
+// groups, never within them. Its own Sink orders its own keys and accounts
+// there the same way, before the group's orders the whole. A member's
+// fallbacks are not the group's.
 func (s *Server) planGroup(g provider.Group, ms []provider.Member, from provider.Protocol) ([]candidate, planned) {
@@ -446,2 +448,8 @@ func planLevel(g provider.Group, ms []provider.Member, depth int, from provider.
 				cs := planLevel(m.Via[depth], ms[i:j], depth+1, from, &sub, asides, wAsides)
+				// the tier's own Sink orders its own keys and accounts,
+				// as its routing orders them (#576): the group's still
+				// orders the whole after
+				if sinks(m.Via[depth].Sink, m.Via[depth].Routing) {
+					cs, sub.order = sinkPlanned(cs, sub.order)
+				}
 				pl.left = append(pl.left, sub.left...)
@@ -527,3 +535,4 @@ func planLevel(g provider.Group, ms []provider.Member, depth int, from provider.
 		if len(m.Path) > depth+1 {
-			// a group in g: its models, planned by its routing
+			// a group in g: its models, planned by its routing, its own
+			// Sink ordering its own keys
 			j := i + 1
@@ -532,3 +541,10 @@ func planLevel(g provider.Group, ms []provider.Member, depth int, from provider.
 			}
-			out = append(out, planLevel(m.Via[depth], ms[i:j], depth+1, from, pl, asides, wAsides)...)
+			sub := planLevel(m.Via[depth], ms[i:j], depth+1, from, pl, asides, wAsides)
+			if sinks(m.Via[depth].Sink, m.Via[depth].Routing) {
+				at := len(pl.order) - len(sub)
+				var ordered []Weighed
+				sub, ordered = sinkPlanned(sub, pl.order[at:])
+				copy(pl.order[at:], ordered)
+			}
+			out = append(out, sub...)
 			i = j
diff --git a/internal/gateway/sink_test.go b/internal/gateway/sink_test.go
index d0ff7bdc..e032c27c 100644
--- a/internal/gateway/sink_test.go
+++ b/internal/gateway/sink_test.go
@@ -135,2 +135,48 @@ func TestRateLimitedSinksToTheBack(t *testing.T) {
 
+// A group in the group with its own Sink: its rate-limited-with-quota-left
+// key goes to the back of the tier's own order, as it would were the tier
+// the group the agent named — a nested group plans by its own routing
+// (#576), rules and Sink alike, at any depth.
+func TestNestedGroupSinksItsOwnTier(t *testing.T) {
+	forgetSinks(t)
+	s := &Server{}
+	tier := func(sink bool) provider.Group {
+		return provider.Group{ID: "inner", Routing: provider.Ordered, Sink: sink}
+	}
+	mem := func(tier provider.Group, id string) provider.Member {
+		return provider.Member{ID: "group/inner", Path: []string{"group/inner", id + "/m"}, Via: []provider.Group{tier}, Provider: provider.Provider{ID: id, Chat: "http://127.0.0.1:1/v1", Key: "k-" + id}, Model: "m"}
+	}
+	ids := func(cs []candidate) []string {
+		var out []string
+		for _, c := range cs {
+			out = append(out, c.p.ID)
+		}
+		return out
+	}
+	rate := []byte(`{"error":{"message":"Too many requests"}}`)
+	on := tier(true)
+	for _, routing := range []string{provider.Ordered, ""} {
+		forgetSinks(t) // each routing starts with nothing sunk
+		outer := provider.Group{ID: "outer", Members: []string{"group/inner"}, Routing: routing}
+		cs, _ := s.planGroup(outer, []provider.Member{mem(on, "a"), mem(on, "b")}, provider.Chat)
+		s.restAfter(cs[0], 429, http.Header{}, rate) // a: rate limited with quota left, it sank
+		rested(cs[0].restKey())                      // its minute is up
+		out, pl := s.planGroup(outer, []provider.Member{mem(on, "a"), mem(on, "b")}, provider.Chat)
+		if got := ids(out); !slices.Equal(got, []string{"b", "a"}) {
+			t.Fatalf("%q: the tier's own Sink: order %v, want [b a]", routing, got)
+		}
+		if pl.order[0].Sunk != nil || pl.order[1].Sunk == nil {
+			t.Fatalf("%q: trace %+v", routing, pl.order)
+		}
+	}
+	off := tier(false)
+	if out, _ := s.planGroup(provider.Group{ID: "outer"}, []provider.Member{mem(off, "a"), mem(off, "b")}, provider.Chat); ids(out)[0] != "a" {
+		t.Fatalf("Sink off: order %v, want a first", ids(out))
+	}
+	// the group's own Sink still orders the whole, tier members included
+	if out, _ := s.planGroup(provider.Group{ID: "outer", Sink: true}, []provider.Member{mem(off, "a"), mem(off, "b")}, provider.Chat); ids(out)[0] != "b" {
+		t.Fatalf("the group's Sink: order %v, want b first", ids(out))
+	}
+}
+
 // A routing group with Sink: a member's key rate limited with quota left
diff --git a/internal/provider/group.go b/internal/provider/group.go
index 786e0cfe..f9065e3f 100644
--- a/internal/provider/group.go
+++ b/internal/provider/group.go
@@ -18,5 +18,5 @@ package provider
 // one member, which a rule can put first like a model; its models are its
-// own group's, ordered by its own routing and rules. A group can't be in
-// itself, however deep: SaveGroup refuses the loop, and one written into
-// providers.json by hand is cut where it closes.
+// own group's, ordered by its own routing, rules and Sink. A group can't
+// be in itself, however deep: SaveGroup refuses the loop, and one written
+// into providers.json by hand is cut where it closes.
 
-- 
2.50.1 (Apple Git-155)
```

</details>

合入请保留作者署名（`git am` 即可）。Generated-by: GLM-5.3-Flash (ZCode)
