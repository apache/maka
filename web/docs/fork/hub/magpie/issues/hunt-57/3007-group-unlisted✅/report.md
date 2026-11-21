# #3007 取消勾选后 routing group 仍调用该模型 — 判定报告

- issue: yetone/magpie#3007（hheei，2026-10-20，v0.1.1295）
- base: `f5b01574`（upstream/main），worktree `/tmp/magpie-h87`，分支 `hunt57-f-group-unlisted`
- 结论：**放弃路（有意设计）**。未改任何代码，未提交，未发帖。

## 结论与依据

「取消模型勾选」在 magpie 里只控制**对 agent 的曝光**（`Exposed`），不是路由关断；能真正拦掉 group 显式成员的开关另有其位（Select none #1818、Disabled models #1867）。报告者的期望行为与代码、测试、文档、GUI 文案四层证据相悖，判为有意设计，不凑 patch。

### 证据链（全部在 base `f5b01574` 核对）

1. **字段注释（代码契约）**
   - `internal/provider/provider.go:359` — `Models`："the models the user chose to expose"。
   - `internal/provider/provider.go:362` — `NoModels`（Select none, #1818）："none of its models are served — **not to agents, not to any routing group, not by a 'provider/model' id**"。对 Select none 单独列出这三条被切断的路径，反证部分勾选不做此切断。
   - `internal/provider/provider.go:389` — `Unlisted`："serves only through the routing groups it is in, and by its 'provider/model' ids"。
   - `internal/provider/models.go:2585` — `Resolve` 文档："`provider/model` for **any model (exposed or not)**"；`resolveIn`（models.go:2606）的 `pid/model` fallback 只查 `p.On() && !p.ServesNone()`，不查勾选。
2. **owner 决策（提交 10d60b18，#1818）**
   - 提交正文原文："Decision (owner delegated): Select none means none, whether or not unlisted is on; **unlisted keeps meaning 'hide from the list, still usable by groups that name it'**"。
   - 该提交只把 Select none 扩到拒绝显式 `pid/model` 与 group 成员（"resolveIn refuses an explicit pid/model to it"），部分勾选刻意保留为曝光语义。
3. **测试契约**
   - `internal/provider/no_models_test.go:16` `TestSelectNoneServesNone`（含 `unlisted=true` 用例）：Select none 时 `Resolve("watched/m0")` 被拒、group 成员消失；一旦有 picks（哪怕只勾一个），其余未勾模型回到「on 且非 ServesNone → 可经 `provider/model` 解析」状态。测试套件没有任何「取消勾选会切断 group 成员」的断言。
   - `internal/provider/group.go:868` `membersOff` 对 group 成员做的唯一用户关断检查是 `off(p.ID, m)`，注释："the user turned it off (**#1867**): a group never reaches it"（group.go:899）——若勾选本该拦 group 成员，#1867 机制就是冗余的。
4. **文档**
   - `docs/subsystems/providers-accounts.md` "Model picks" 行："`Models` are the models the user picked **for agents**; … unless the user chose Select none …: then none of its models is served, not to agents, not to any routing group (auto groups included), not by a `provider/model` id, not as a classifier"。
5. **GUI 文案**
   - `internal/gui/assets/app.js:11668` — unlisted 勾选框标签就叫 **"Only through routing groups"**。
   - `internal/gui/assets/app.js:11110` — unlisted provider 的模型卡提示："Agents don't see them: only the routing groups they are in use them."。

### 报告者场景的机制复述（为何 usage 仍 200）

配置 `models:["gpt-6-luna"]`、`pickedFrom:[7 个]`、`unlisted:true`、无 `noModels` → `ServesNone()==false`。group 显式成员 `codex/gpt-6.1-sol` 在 `membersOff`（group.go:885）走 `resolveIn`：不在 exposed entries → `pid/model` fallback（models.go:2606 起）只查 provider on 且非 ServesNone → 通过；`disabledNow()` 无 DisabledModels 模式 → 保留为候选。affinity（`kept:true, why:"turn"`）按设计保留有效候选，请求到达 ChatGPT 账号，200。裸 id `gpt-6.1-sol` 同样可达（`listedBy` 用 `Available()` 而非 `Exposed()`，models.go:2636 附近）。`unlisted` 与否不影响此判定，决定因素只有 Select none 和 Disabled models。

## 给报告者的操作（已在英文评论草稿中给出）

- 真正禁用该模型的所有路由（含 group 成员、直接 `codex/gpt-6.1-sol`、裸 id），保留 group 成员配置不动：
  - GUI：Names & levels 的 disabled-models 列表（`POST /api/settings/disabled-models`，internal/gui/api.go:1591）；
  - CLI：`magpie model disable codex/gpt-6.1-sol`（internal/cli/model_cli.go:1297，支持 glob）；恢复用 `magpie model enable`。
- 或把该成员从 group 里移除。
- 剩余合理缺口：取消勾选时 UI 不提示哪些已有 group 仍会调用它——属 UX 增强，建议另开 issue，不是路由 bug。

## 英文诊断评论草稿（按禁令未发帖）

> **Diagnosed as by design — the model picks are an exposure control, and the switch that reaches group members is Disabled models (#1867)**
>
> Thank you for the careful report — the config, the usage log and the affinity evidence pin the path down exactly. I walked it against current main, and what you saw is what the code intends rather than a switch that stopped working.
>
> **What the picks do.** `Provider.Models` are "the models the user chose to expose" ([provider.go](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/provider.go#L359)): they decide what agents are offered in their lists (`Exposed`). Unticking a model removes it from that list but it stays a model of an on provider — `Resolve` "accepts catalog ids, `provider/model` for any model (exposed or not)" ([models.go](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/models.go#L2585)), and the `provider/model` fallback checks only that the provider is on and not Select-none (`resolveIn`, models.go:2606). A group's explicit member resolves through the same path ([group.go:885](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/group.go#L885)), so `codex/gpt-6.1-sol` stays a candidate, and your affinity line (`kept: true, why: "turn"`) then favors it as designed. A bare `gpt-6.1-sol` reaches it too (`listedBy` reads the vendor's list, not the picks).
>
> **The cut-off you were reaching for exists one level down.** Select none (#1818) is the pick action that does cut everything: "none of its models are served — not to agents, not to any routing group, not by a `provider/model` id" ([provider.go:362](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/provider.go#L362)); `TestSelectNoneServesNone` asserts `Resolve("watched/m0")` is refused and groups drop the member, with `unlisted=true` as well. The decision recorded on that issue is explicit: "Select none means none, whether or not unlisted is on; unlisted keeps meaning 'hide from the list, still usable by groups that name it'" (10d60b18). Partial picks were deliberately left exposure-only.
>
> **Per-model off, group members included.** To stop exactly `codex/gpt-6.1-sol` on every route — group members, direct and bare ids — while keeping the group entry and the rest of the provider, disable the model: GUI → Names & levels → the disabled-models list, or `magpie model disable codex/gpt-6.1-sol` (globs work; `magpie model enable` takes it back). Disabled models are "refused on every route, before any upstream call: a request that names it, a group member, a fallback…" ([disabled.go](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/disabled.go#L13)), and membership honors them: "the user turned it off (#1867): a group never reaches it" ([group.go:899](https://github.com/yetone/magpie/blob/f5b01574/internal/provider/group.go#L899)). Your usage log should then show magpie refusing the request before any ChatGPT account is touched. Removing the member from the group works too.
>
> **The gap that remains is fair.** What today's UI doesn't tell you, when you untick a model, is which existing groups still name it (the unlisted card does say "Agents don't see them: only the routing groups they are in use them", but nothing per-untick, and nothing for a fully listed provider). That reads as a UX enhancement rather than a routing bug — worth its own issue if you'd like to file one.

## 不确定项

- 「取消勾选时提示受影响 group」若将来被接受为特性，实现面在 GUI 勾选交互处（app.js 模型卡保存路径），不在路由侧；本单未评估其工作量。
- `magpie model disable` 对已由 affinity 记住的会话是否立即生效未实测（代码路径 `disabledNow()` 在每次成员展开时读取，理论上立即；未跑网关级验证，因本单不改代码，不需要）。

## 验证

- 只读调查：所有引用行号在 `/tmp/magpie-h87`（`f5b01574`）以 grep/sed 直接核对；`TestSelectNoneServesNone`、10d60b18、841af36b（#1867 引入提交）、66f920e3（PickedFrom 引入）全文已读。
- issue 下 0 评论、无 label、无 assignee，无撞车。
- `git -C /tmp/magpie-h87 status` 干净：未改代码、未提交、未 push、未发帖；主 clone 与其他 /tmp/magpie-h* 未触碰。
