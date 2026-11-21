# 4379 Kimi skill 作用域泄露 — 同域覆盖判定（hunt-115/c）

- Issue: https://github.com/yetone/magpie/issues/4379（cinvymoe, OPEN, 0 评论, 无 take）
- 基线: upstream/main `de7953e3b8af5800e2a505d7fc5c76d23c66d560`（2026-11-02）
- worktree: /tmp/mg115-c（fix/4379-kimi-skill-scope）

## 判定结论：da8039368 未解决本缺陷 → patch 路线

## 痛点机理（代码核实，基线内行号）

1. `internal/library/targets.go` case "kimi"：2.x（非 legacy）分支 `t.Skills = sharedSkillsDir()`（~/.agents/skills），与 goose/cindy 同。kimi 由此没有任何"自己的"skills 去处。
2. `readsShared`（targets.go:932）14 个 agent（codex/gemini/opencode/deveco/crush/dsh/commandcode/devin/droid/cline/grok/grok-app/fx/alma）原生读 ~/.agents/skills。
3. `sync.go` readView：`sv.Shared = sharedEntry(s.Name)` 非空 → 这 14 个 + shared 目标 agent 全进 `sv.Always`（锁死亮灯 chip）。
4. 结果：给 kimi 的 skill 唯一落点是 shared 目录 → 全部读者可见且 UI 不可关。报告标题即机理，属实。

## da8039368（hand-over，10-29）为何不算解决

- hand-over 把 skill 移进 library、摘掉 shared 里的用户条目 → `sharedEntry` 变空 → `Always` 清空、chips 解锁，"turn off per agent" 在 UI 层成立。
- 但 kimi 的 `t.Skills` 仍是 shared：sync 给每个 ticked agent 写链接时，kimi 的链接（`ours`：symlink→skillDir，skills.go `ours()`）唯一去处还是 ~/.agents/skills。
- 14 个 readsShared agent 原生读该目录 → 广播继续。untick codex 等只摘各自文件夹里的链接（syncSkills 移除循环只走 `t.Skills`），shared 里为 kimi 留的 ours 链接无人清理（goose/cindy 的移除循环只管自己的 a.Skills）→ untick 无效。
- 即：da8039368 承诺的 "until the user unticks it" 在 kimi 面失效。报告者实测描述（"replaces its shared entry with a link, so the broadcast continues"）与代码一致。
- accb951ab 是 sessions 统计，与本缺陷无关。

## 修法（= 报告者方案，与代码自身注释一致）

官方文档核实（MoonshotAI/kimi-code docs/en/customization/skills.md "Skill Locations"，gh api 原文）：
- 用户级：`$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`）**和** `~/.agents/skills/`。
- 项目级：`.kimi-code/skills/` 和 `.agents/skills/`（本单不动，项目 .agents/skills 是刻意的仓库级共享约定）。

targets.go 既有注释早已写明 "The new Kimi Code (2.x) reads its own and ~/.agents/skills only"，但代码没照做——这是行为与自身注释/官方文档相悖的缺陷，不是设计拍板。

改动面：
1. targets.go：kimi 2.x 分支 `t.Skills = filepath.Join(a.Dir, "skills")`（a.Dir=kimiDir 已解析 $KIMI_CODE_HOME/~/.kimi-code）；legacy 分支不动（first-of 列表，自己的文件夹会藏 Claude 的——既有注释）。
2. targets.go：`readsShared` += "kimi"（2.x/legacy 都读 shared 作第二目录；对 legacy-with-config-dir 与现状语义相容：SkillsAlso/inShared/Always 的 kimi 分支原本就靠 realDir==shared 命中，不受影响）。
3. skills.go：存量迁移 sweep——shared 里 `ours` 条目，若无任何 shared-target agent（realDir(t.Skills)==shared）gives 该 skill（含 skill 已删的 dangling），unlink+dropOld；blockedSkills 命中保留（失败读取语义）。放 syncSteps 的 shared pass 之前。没有这一步，报告者存量 94 条链接永久残留，修复对新装有效、对存量无效。

## 让位闸核对

- 报告者无分支/patch（"If so I'll send the PR" 是附维护者确认的条件句，未发）。
- 维护者 0 评论无表态；上游无 (#4379) 提交命中（主线程 2026-11-02 核）。
- 非纯 feature：痛点是"勾选了 A 的 skill 泄露给 B 且 UI 禁止关闭"，修法与代码注释意图一致。
→ 不让位。

## 兄弟面

- #4645（hunt-115/e5，已发布）：动 lockOrigin/ccSwitchOrigin 面（skills.go updatable/prepare、sync.go 行 origin），与本单不同 hunk，无碰撞。
- 项目级 projectSkillsDirs["kimi"]="​.agents/skills" 同病但属刻意共享约定，本单不动，帖内注明。
