交付跟进上条 claim（会话中断后由主线程接手完成验证与发送）：修复 commit `95e1b6a8`，分支 [hunt25-gw-rotate-rule-order](https://github.com/ggbdpq/magpie/tree/hunt25-gw-rotate-rule-order)（基线 2e2c8903），patch 见文末。

## 根因

规则命中后 `ruleOver`→`ruleFirst`（`internal/gateway/rules.go`）按摊平后的成员序给候选重排。规则点名的成员是组中组时（本例 `group/rotate-inner` 在 `group/smart-outer` 的规则里），它的成员被摊开逐个参与排序——排序键是组的**列表序**，把内层 rotate 自己路由排好的轮换顺序整个抹平回列表序。于是 turn 的轮换在底下照常推进，但规则每请求都把内层首个成员放回最前：表现即报告里 routing 日志的 order 固定、经外层成员带 `via=group-rotate-inner`、18/18 全落 modelA；直接问内层不走规则重排，所以正常轮换。

## 修法

`ruleFirst` 增加 `own`（规则自有成员数）参数：点名的成员若是组中组（`Path` 长于 1），整块按它在规则自有成员里的位次参与排序，块内保持内层组自己路由的顺序；规则后续命中的成员位次不变；规则点名某个模型而组内也有它的仍排最前（#625 语义，既有 `TestRuleNamesAModelAGroupInItHasToo` 原样绿）。`ruleOver` 与 `applyRule` 两处调用同步传入 `len(ruleMembers(hit, ms))`。

## 红绿

新增 `TestRuleNamingARotateGroupKeepsItsTurns`（外层 smart 组、Tokens 规则点名 group/rot、成员含嵌套 order 组，6 个新会话经规则进入）：修前（`rules.go`+`rules_test.go` 摘回父提交 2e2c8903）失败 `the rotate group in the group never advanced: modelA modelA modelA modelA modelA modelA`；修后 `modelA modelB modelC modelA modelB modelC`。规则的种类只决定命中与否，命中后走同一条 `ruleOver`/`applyRule` 重排路径，intent 规则同样被此修法覆盖。

## 验证

| 检查 | 结果 |
|---|---|
| `TestRuleNamingARotateGroupKeepsItsTurns` @ 修复后 | PASS：`modelA modelB modelC` ×2 |
| 同测试 @ 父提交 2e2c8903（产品+测试文件一并摘回） | FAIL：`modelA` ×6，与报告 18/18 modelA 同形 |
| 定向集 `Rule|Rotate|Nested|Patience`（gateway 包，-tags nogui -p 2） | ok |
| gateway 全包 `-timeout 45m` | ok 304s（commit 的 Run 段记录） |
| `gofmt -l internal/` | 干净 |
| `go vet -tags nogui`（darwin）/ `GOOS=linux -tags nogui` / `GOOS=windows`（./...） | 干净 |
| 三平台 `go build`（linux 带 nogui） | ok（darwin 仅已知 ld 重复库警告） |

## 没跑什么

报告者的 intent+分类器链路未单独搭假分类器复测（intent 命中后与 Tokens 规则共用同一条重排路径，上表测试锁的是该机制）；真实 0.1.1251 实机未复测；`TestOffline`（本机网络红）未跑。

<details>
<summary>patch</summary>

```
From 95e1b6a88248210438b9bc3c780154fa59b64739 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:26:41 +0800
Subject: [PATCH] gateway: a rule naming a group in the group keeps the group's
 own routing's order (#2407)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
ruleFirst ranked the candidates of a rule's member by the group's flattened
member order, so a rule that names a group in the group erased whatever that
group's own routing had planned: a rotate group's turn advanced underneath,
but every request the rule put first was served by its first member again.
The rule's own member that is a group in the group is one member now — its
models rank as the group's block, in the order the group's routing planned
them; the members the rules after it name keep their own ranks, so a model
the rule names that the group has too still leads over them (#625,
TestRuleNamesAModelAGroupInItHasToo). TestRuleNamingARotateGroupKeepsItsTurns.

Run
HOME=$(mktemp -d) GOTOOLCHAIN=auto go test -tags nogui -count=1 -p 2 -run 'Rule|Rotate|Nested' ./internal/gateway/ — ok
HOME=$(mktemp -d) GOTOOLCHAIN=auto go test -tags nogui -count=1 -p 2 -timeout 45m ./internal/gateway/ — ok 304s
TestRuleNamingARotateGroupKeepsItsTurns on rules.go at 2e2c8903 (fix stashed): red, "modelA modelA modelA modelA modelA modelA"
gofmt -l clean; go vet -tags nogui (darwin), GOOS=linux -tags nogui, GOOS=windows on ./internal/gateway — clean
go build -o /dev/null . (darwin, known ld warnings only), GOOS=linux -tags nogui, GOOS=windows — ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md          |  2 +-
 internal/gateway/rule_nested_rotate_test.go | 78 +++++++++++++++++++++
 internal/gateway/rules.go                   | 28 ++++++--
 internal/gateway/rules_test.go              |  6 +-
 4 files changed, 104 insertions(+), 10 deletions(-)
 create mode 100644 internal/gateway/rule_nested_rotate_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 1c1314810..1498f325d 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -86,7 +86,7 @@ recorded as a prediction failure (`noPrediction`).
    - Every Claude Code subagent's turn, Desktop's or a terminal's, moved or not, keeps its `x-claude-code-agent-id` in `Route.SubagentID` (`subagentTurnOf` in [`desktop_subagent.go`](../../internal/gateway/desktop_subagent.go)): a request with the id that offers tools and names no kind, the turn the two settings above take. Claude Code 2.1.295 sends the id from any agent context but the main one; its `x-claude-code-request-class` and `x-claude-code-agent-type` hints go only to a first-party base URL or with `CLAUDE_CODE_GATEWAY_HINT_HEADERS`, so magpie doesn't get them. A Desktop pick or effort that found the turn is trusted, so the body isn't decoded again, and a request without the id isn't decoded at all. The Routing page tags it as Codex's subagents are (`tagKind` in [`routing.js`](../../internal/gui/assets/routing.js)): in the request list, the story, the replay and the tray panel, with the reason `kindWhy` gives Codex's. `Kind` stays empty, so its purpose stays unmarked in the Purpose filter, as in the ledger and on the Usage page. The ledger's `Subagent` keeps the same id, and also marks a subagent's tool-less helper calls, which aren't tagged. A route recorded before this has no id and no tag.
    - Rules and image inputs are handled here too.
    - A rule is decided as a user's turn begins and held for the rest of it (`ruleFor`, [`rules.go`](../../internal/gateway/rules.go)). What counts as the user's own words is one helper, `userWords`/`userSaid` in [`prompt.go`](../../internal/gateway/prompt.go), which the turn count (`turnIn`), the classifier's question (`userText`), the conversation's key (`firstWords`, in `ruleKey` and the affinity scope), Copilot's Auto (`lastUserText`) and the prompt breakdown's turns (`userSays`) all go by. It drops `<system-reminder …>` blocks (a `source=` attribute too) and any text that begins as an agent writes for the model alone: Codex's `<environment_context>`, `<user_instructions>`, `<turn_aborted>`, `<user_shell_command>`, `<subagent_notification>` and `# AGENTS.md instructions for …`; Claude Code's and ZCode's `<task-notification>`, `<subagent-notification>`, agent lists ("Available agent types …", "New agent types are now available …"), TodoWrite and task-tool nudges and rewind notices; ZCode's `<plugin_reference>`; the Codex app's `<in-app-browser-context …>`. The Codex app's context before `## My request (for Codex):` is dropped and what follows it kept (the `injected` list beside `agentsFor`). A user message with nothing of the user's in it (and no image or file) begins no turn: after an answer or a tool round it carries the turn on (`within`), so the turn's rule and stick hold and the classifier isn't asked; right after the user's words it leaves their turn as it began. The classifier is asked about the last user message that has words of the user's, only those words. `firstWords` hashes the words of the first user message that has any, so an instruction file or notice the agent changes beside them doesn't move the conversation to a new key and lose its stick mid-turn (#1826: ZCode's TodoWrite nudge classified as a new, harder turn, and three keys for one ZCode session). `TestTurnInSkipsWhatTheAgentPutIn`, `TestUserTextSkipsWhatTheAgentPutIn`, `TestFirstWordsAreWhatTheUserSaid`, `TestIntentHoldsPastWhatTheAgentPutIn`.
-   - A rule's members go first (`ruleOver`, `applyRule`): the member it names, then those the matching rules after it name (`ruleOrder`), each not resting, then the group's others to fail over to. That holds within the turn too, at the group's rule and at each nested group's (`nestedRules`): the one the turn stays on (affinity) stays first while it is of the rule's member that goes first, and the member's others follow it ahead of the group's others, so a failure fails over within the member the rule chose before going outside it. One the turn was kept on outside that member, which took over when the member failed, isn't held there: once one of the member is out of its rest, the turn's next request goes back to it (`Affinity.Why` `rule`). Before #1946 (XcodeFish) a held rule's order wasn't applied to a kept turn at all: a coding-quality member failing mid-turn failed over to coding-fast, the parent's first, and the turn stayed there. `TestHeldRuleFailsOverWithinItsMember`.
+   - A rule's members go first (`ruleOver`, `applyRule`): the member it names, then those the matching rules after it name (`ruleOrder`), each not resting, then the group's others to fail over to. A member that is a group in the group is one member here: its models keep the order the group's own routing planned them, where ranking each by the group's listed order pinned a rotate group's first member on every request the rule put it first (#2407, `TestRuleNamingARotateGroupKeepsItsTurns`). That holds within the turn too, at the group's rule and at each nested group's (`nestedRules`): the one the turn stays on (affinity) stays first while it is of the rule's member that goes first, and the member's others follow it ahead of the group's others, so a failure fails over within the member the rule chose before going outside it. One the turn was kept on outside that member, which took over when the member failed, isn't held there: once one of the member is out of its rest, the turn's next request goes back to it (`Affinity.Why` `rule`). Before #1946 (XcodeFish) a held rule's order wasn't applied to a kept turn at all: a coding-quality member failing mid-turn failed over to coding-fast, the parent's first, and the turn stayed there. `TestHeldRuleFailsOverWithinItsMember`.
    - A classifier that can't say which kind a turn is (an error, no answer within `classifyTimeout`, an answer that isn't a number, or resting `classifyRest` after a failure) leaves a turn whose conversation had an intent, still one of this turn's, with that intent (`Classified.Fallback` is `previous`, its `Error` kept), so the turn goes where the turn before went rather than to the group's first member; with no intent before, no rule with an intent matches, as before. The Routing page says the turn kept it (`classWhy`). The turn's decision itself (`turnRules`) is kept in memory only: after a restart a turn under way waits for the next one and the stick holds it meanwhile. `TestIntentClassifierFailsKeepsThePreviousIntent`, `routing-intent-fallback.test.cjs`.
    - The classifier's requests are magpie's own (#1839). Asked in words, they go out with `RouterAgent`'s User-Agent (`magpie-router/1`), so their records' agent is magpie and `callKind` marks them `routing`; a decision model's (Jev, System One) record is written with `Kind: "routing"` too. They go to the same key or account as any other request and count in its totals, while `usage.Group.Own` (`Record.ByMagpie`: agent `magpie` or one of its `magpie-` User-Agents, with search's and image description's) says how many of an account's, key's or model's calls, tokens and cost were magpie's own. A classifier set to a subscription's model (`modelRef.Sub`, or a group whose first member is one) asks that subscription as every turn begins, twice when it picks both intent and effort in words; the Routing page says so beside it (`classifierSub` in `plugins/routing/client.js`). `TestIntentRoutesATurn`, `TestJevPicksTheIntent`, `TestSummaryCountsMagpiesOwnCallsApart`, `TestByMagpie`, `TestServedRefSaysASubscription`, `own-requests.test.cjs`.
    - A rule by folder (`Rule.Folders`, `folders=~/work/acme,~/oss`; Cario0x on X: routing by the project being worked on) matches when the folder the agent works in is one of them or inside one (`provider.FolderUnder`, [`rulefolder.go`](../../internal/provider/rulefolder.go)): at a path's boundary, so `/a/b` is not under `/a/bc`; `~` is the home folder; a Windows drive is one with its WSL mount (`C:\work` is `/mnt/c/work`) and a `\\wsl$\<distro>` or `\\wsl.localhost\<distro>` share is the distro's own path; case doesn't count on macOS and Windows, nor ever for a drive. A rule outside folders (`Rule.ExceptFolders`, `except-folders=~/big-task`; #1606, Ti800) matches when the folder is in none of them, and an agent that says none isn't known to be in one, so it matches; a rule may have both (`Rule.ByFolder`, `inFolders`). The folder is read from the request only when a rule of the group has folders or except-folders (`workDir` in [`workdir.go`](../../internal/gateway/workdir.go)), in each agent's own words, taken from captured requests: Claude Code's ` - Primary working directory: <path>` (its `<`/`>` as entities; ` (was <old>)` after a change dropped), Codex's `<environment_context>` `<cwd>`, Pi's `<cwd>` in the system prompt, and OpenCode's `Working directory:` inside its `<env>` block. Only the system prompt and the user's and system messages' text count, never the model's words or a tool's result, and the last said wins. An agent that says none has no folder, and no `folders=` rule matches it (unknown, never empty). The same reading tells a plugin's fetch where its agent works ([provider-plugins](provider-plugins.md#where-the-agent-works-for-a-plugins-fetch)). A pause rule may hold by folder too (below). The trace's `RuleHit.Folder` is the folder read, and the Routing page tells it beside the rule's `folder …` condition. `TestFolderUnder`, `TestRuleMatchesByFolder`, `TestParseRuleFolders`, `TestWorkDirOfEachAgent`, `TestRuleByFolder`, `TestRuleMatchesExceptFolders`, `routing-folder.test.cjs`. Rules by folder are never in a shared group (`ShareGroup` drops every `ByFolder` rule).
diff --git a/internal/gateway/rule_nested_rotate_test.go b/internal/gateway/rule_nested_rotate_test.go
new file mode 100644
index 000000000..6fe3aa800
--- /dev/null
+++ b/internal/gateway/rule_nested_rotate_test.go
@@ -0,0 +1,78 @@
+package gateway
+
+// A rule that names a group in the group puts the group's whole plan
+// first, in the order the group's own routing planned it (#2407): ranked
+// by the group's listed members, a rotate group's own order was erased and
+// every request the rule put first was served by its first member.
+
+import (
+	"encoding/json"
+	"fmt"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// rotateModelsUp answers with the model it was asked for, so every member
+// of the nested layout is tellable apart.
+func rotateModelsUp(t *testing.T, id string, models ...string) {
+	t.Helper()
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		var q struct {
+			Model string `json:"model"`
+		}
+		json.Unmarshal(b, &q)
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{"id":"ok","choices":[{"index":0,"message":{"role":"assistant","content":"served-by-`+q.Model+`"},"finish_reason":"stop"}]}`)
+	}))
+	t.Cleanup(up.Close)
+	p := provider.Provider{ID: id, Name: strings.ToUpper(id), Key: "k", Chat: up.URL + "/v1", Models: models}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+}
+
+func servedModel(body string) string {
+	if i := strings.Index(body, "served-by-"); i >= 0 {
+		rest := body[i+len("served-by-"):]
+		if j := strings.Index(rest, `"`); j >= 0 {
+			return rest[:j] + " "
+		}
+	}
+	return ""
+}
+
+// The layout of the report: an outer smart group whose rule names
+// group/rot, whose members are a model, a group in it and another model.
+// Each fresh conversation through the rule takes the rotate group's next
+// member, as asking the group directly does.
+func TestRuleNamingARotateGroupKeepsItsTurns(t *testing.T) {
+	fresh(t)
+	rotateModelsUp(t, "pa", "modelA", "modelB", "modelC")
+	rotateModelsUp(t, "pb", "modelB")
+	rotateModelsUp(t, "pc", "modelB")
+	if err := provider.SaveGroup(provider.Group{Name: "nord", Members: []string{"pa/modelA", "pa/modelB", "pb/modelB", "pc/modelB"}, Routing: provider.Ordered}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SaveGroup(provider.Group{Name: "rot", Members: []string{"pa/modelA", "group/nord", "pa/modelC"}, Routing: provider.Rotate}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SaveGroup(provider.Group{Name: "outer", Members: []string{"group/rot"}, Routing: "",
+		Rules: []provider.Rule{{Use: "group/rot", Tokens: 1}}}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	served := ""
+	for i := range 6 {
+		_, body := postAs(t, s, fmt.Sprintf("via-%d", i), `{"model":"group/outer","messages":[{"role":"user","content":"please reply ok to this routing probe message"}]}`)
+		served += servedModel(body)
+	}
+	if want := "modelA modelB modelC modelA modelB modelC "; served != want {
+		t.Fatalf("the rotate group in the group never advanced: %s (want %s)", served, want)
+	}
+}
diff --git a/internal/gateway/rules.go b/internal/gateway/rules.go
index e14b01d51..b67dbe25b 100644
--- a/internal/gateway/rules.go
+++ b/internal/gateway/rules.go
@@ -512,14 +512,30 @@ func ruleOrder(hit *RuleHit, ms []provider.Member) []provider.Member {
 
 // ruleFirst puts first the keys or accounts of the members in ms that
 // aren't resting, a member's before the next's and each's in the order
-// they had; everyone else follows as they were, to fail over to. lead is
-// the one in ms whose goes first, -1 when none is ready.
-func ruleFirst(ms []provider.Member, cs []candidate, pl planned) (out []candidate, _ planned, lead int) {
+// they had; everyone else follows as they were, to fail over to. own is
+// how many of ms are the rule's own members, ahead of the rules after
+// it's. lead is the one in ms whose goes first, -1 when none is ready.
+func ruleFirst(ms []provider.Member, cs []candidate, pl planned, own int) (out []candidate, _ planned, lead int) {
 	rank := func(i int) int {
 		if pl.order[i].Rest != nil {
 			return -1
 		}
-		return slices.IndexFunc(ms, func(m provider.Member) bool { return ofMember(cs[i], m) })
+		at := slices.IndexFunc(ms, func(m provider.Member) bool { return ofMember(cs[i], m) })
+		if at < 0 || at >= own {
+			return at
+		}
+		// one of the rule's own members that is a group in the group is
+		// one member here: its models rank as the group's block, in the
+		// order the group's own routing planned them, not the group's
+		// listed order — ranked apart, a rotate group in the group was
+		// pinned to its first member on every request the rule put it
+		// first (#2407)
+		if len(ms[at].Path) > 1 {
+			if first := slices.IndexFunc(ms[:own], func(m provider.Member) bool { return m.ID == ms[at].ID }); first >= 0 {
+				return first
+			}
+		}
+		return at
 	}
 	idx := make([]int, len(cs))
 	for i := range idx {
@@ -589,7 +605,7 @@ func ruleOver(hit *RuleHit, ms []provider.Member, cs []candidate, pl planned, af
 			// it stays: the rule's members after it, then the group's
 			sub := pl
 			sub.order = pl.order[1:]
-			rest, sub, _ := ruleFirst(ordered, cs[1:], sub)
+			rest, sub, _ := ruleFirst(ordered, cs[1:], sub, len(ruleMembers(hit, ms)))
 			cs = append([]candidate{cs[0]}, rest...)
 			pl.order = append([]Weighed{pl.order[0]}, sub.order...)
 			if p >= 0 {
@@ -615,7 +631,7 @@ func applyRule(hit *RuleHit, ms []provider.Member, cs []candidate, pl planned) (
 	ordered := ruleOrder(hit, ms)
 	lead := -1
 	if len(ordered) > 0 && len(cs) > 0 {
-		cs, pl, lead = ruleFirst(ordered, cs, pl)
+		cs, pl, lead = ruleFirst(ordered, cs, pl, len(ruleMembers(hit, ms)))
 	}
 	// ordered has the rule's own first, then those of the rules after it
 	hit.Unready = lead < 0 || lead >= len(ruleMembers(hit, ms))
diff --git a/internal/gateway/rules_test.go b/internal/gateway/rules_test.go
index dc5cdb5c8..0701a0056 100644
--- a/internal/gateway/rules_test.go
+++ b/internal/gateway/rules_test.go
@@ -441,7 +441,7 @@ func TestRuleFirstAndOfMember(t *testing.T) {
 		pl.order = append(pl.order, Weighed{ID: c.rest, Model: c.model})
 	}
 	pl.order[3].Rest = &Rest{}
-	got, gp, lead := ruleFirst([]provider.Member{{Provider: b, Model: "m"}}, cs, pl)
+	got, gp, lead := ruleFirst([]provider.Member{{Provider: b, Model: "m"}}, cs, pl, 1)
 	ok := lead == 0
 	var ids []string
 	for i, c := range got {
@@ -454,7 +454,7 @@ func TestRuleFirstAndOfMember(t *testing.T) {
 		t.Fatalf("%v %v", ok, ids)
 	}
 	// a later rule's member follows the first's, before everyone else (#112)
-	got, _, lead = ruleFirst([]provider.Member{{Provider: provider.Provider{ID: "c"}, Model: "m"}, {Provider: a, Model: "m"}, {Provider: b, Model: "m"}}, cs, pl)
+	got, _, lead = ruleFirst([]provider.Member{{Provider: provider.Provider{ID: "c"}, Model: "m"}, {Provider: a, Model: "m"}, {Provider: b, Model: "m"}}, cs, pl, 1)
 	ids = nil
 	for _, c := range got {
 		ids = append(ids, c.rest+"/"+c.model)
@@ -462,7 +462,7 @@ func TestRuleFirstAndOfMember(t *testing.T) {
 	if lead != 1 || strings.Join(ids, " ") != "a/m ab/m ab@me/m ab#k2/x ab#k2/m" {
 		t.Fatalf("%d %v", lead, ids)
 	}
-	if _, _, lead := ruleFirst([]provider.Member{{Provider: provider.Provider{ID: "c"}, Model: "m"}}, cs, pl); lead >= 0 {
+	if _, _, lead := ruleFirst([]provider.Member{{Provider: provider.Provider{ID: "c"}, Model: "m"}}, cs, pl, 1); lead >= 0 {
 		t.Fatal("no candidates of c")
 	}
 	// "a" is not "ab"'s
-- 
2.50.1 (Apple Git-155)
```

</details>

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
