# 4379 Kimi Code skills 作用域泄露（hunt-115/c）

- Issue: https://github.com/yetone/magpie/issues/4379（cinvymoe, OPEN, 0 评论）
- 判定: da8039368（hand-over）未解决——kimi 2.x 的 target 仍是 shared，untick 其他 agent 摘不掉 shared 里为 kimi 写的 ours 链接，广播继续（详见 decision.md）
- 占坑: take 评论 https://github.com/yetone/magpie/issues/4379#issuecomment-6562405432
- 发布: patch 帖 https://github.com/yetone/magpie/issues/4379#issuecomment-6562552659（GET 回读与本地逐字一致）
- 分支: https://github.com/ggbdpq/magpie/tree/fix/4379-kimi-skill-scope head `02d804a5246d2947ef8198a118cd69d922e6f993`（ls-remote 核对一致）
- 基线: upstream/main `de7953e3b8af5800e2a505d7fc5c76d23c66d560`（发布门禁复验无移动、无 (#4379) 提交、无 internal/library 新提交）
- patch: 0001-fix-library-give-Kimi-Code-its-own-skills-folder-437.patch，SHA-256 first 16 `845bbb17490ba573`

## 改动面（4 文件，+131/-4）

1. targets.go：kimi 2.x 分支 `t.Skills = a.Dir/skills`（$KIMI_CODE_HOME/skills 或 ~/.kimi-code/skills，官方 docs "Skill Locations" 核实）；`readsShared` += "kimi"；legacy kimi-cli 分支不动（first-of 列表会藏 Claude 的）
2. sync.go：syncSteps 在 shared pass 前加 sweepShared 步
3. skills.go：`sweepShared`——shared 里 ours 条目，无任何 shared-target agent gives（含 skill 已删 dangling）即 unlink+dropOld；blockedSkills 命中保留；ReadDir 失败整体跳过
4. kimi_skills_test.go（新）：TestKimiCodeSkillsOwnFolder / TestKimiOldSharedEntrySwept

## 验证

- RED（基线 de7953e3b 产品文件回退）：red.txt，两条症状断言逐字命中
- 矩阵：定向邻居 10 条绿（含 TestSharedUnderAnotherName/全部 HandOver）；包全量 nogui ok 67.4s（最终代码）；gofmt -l 空；vet darwin/linux/windows 清；build ×3 ok（darwin cgo 警告预存）
- 消融：A 产品文件全回退→双红（症状行）；B 仅回 sweep（skills.go+sync.go）→仅 Test2 挂 sweep 断言；C 仅回 readsShared 一行→仅 Test1 挂第二条链接断言（orca 需同时 tick goose+kimi 才能打到 inShared 面——第一版测试只给 goose 是盲点，已修并 amend）
- 兄弟面：`rg sharedSkillsDir` 11 消费点全核（goose/cindy/legacy 分支、readsWith、Always、readsSharedHere、inShared、sharedEntry ours 保护、found/places 扫描、skill_from、projects.go 项目级刻意不动、sessions/gateway 无关）
- 失败语义：ReadDir 失败跳过、unlink 失败上报保留、blockedSkills 保留

## 残余（帖内已注明）

- 项目级 projectSkillsDirs["kimi"]=".agents/skills" 同病但属仓库级共享约定，未动（kimi 2.x 项目级也读 .kimi-code/skills，维护者若要项目隔离可另开面）
- 未验证真实 Kimi Code 2.x 端到端（测试用同一套 folder 探测 + sandbox HOME，与既有 kimi 测试同法）

## 不自信项

- sweep 归属 agent 记为 "agents"（handOver partly 先例），Changed 列表不含 sweep 摘除——Result 语义上 shared 目录不属于单 agent，未强行归属
- Kimi Code 2.x 对 `$KIMI_CODE_HOME/skills` 的读取以官方文档为准，未实测二进制
