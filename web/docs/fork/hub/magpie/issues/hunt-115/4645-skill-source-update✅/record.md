# 4645 skill lock origin update（hunt-115/e5）

- Issue: https://github.com/yetone/magpie/issues/4645（Apri1qing, 10-31, 0 评论）
- 占坑: take 评论 https://github.com/yetone/magpie/issues/4645#issuecomment-6557629025
- 发布: patch 帖 https://github.com/yetone/magpie/issues/4645#issuecomment-6557812100（2026-11-01T12:16:25Z, GET 回读一致，仅 GitHub 尾部补换行）
- 分支: https://github.com/ggbdpq/magpie/tree/fix/4645-skill-source-update head `4ceedeac90b9050fe63aa0bc0cc97f55cee9bdd5`
- 基线: upstream/main `9d08993c8bd40de5d002bc364a16be344c5d78fa`（发布门禁复验无移动、无自修、无文件碰撞）
- patch: git format-patch，SHA-256 前 16 `785c3ec782e0ba4a`

## 根因与修法

- 根因：update 只在 CC Switch 记录里为无 remote source 的 skill 找来源（`prepare`/`updatable`），skills CLI 的 lock（`~/.agents/.skill-lock.json`）只用于分组（repoOf/lockRepo），带入/hand-over 的条目只有 `from`，永远不可更新。
- 修法（update 时推导，非写入时持久化——存量 220 条直接修复）：`lockOrigin`（lockEntry 加 github 标记；要求 sourceType=github + at 非零 + madeBy）接入 `updatable`、`prepare`（ccSwitchOrigin 之后）与 sync.go 行的 Origin 显示。走现有 adopt seam，update 成功后 `apply` 自动持久化 source。
- 防错认：lock 无时间戳条目不认（TestUndatedLockStillGroups 的语义：无法区分同名 skill；分组错只错显示，update 错会覆盖文件）；madeBy 失败不认（AzheRise 场景）。

## 文件

- internal/library/skill_from.go（lockEntry.github、readSkillLock、lockOrigin）
- internal/library/skills.go（updatable、prepare）
- internal/library/sync.go（SkillView.Origin 兄弟面）
- internal/library/skill_from_test.go（TestSkillLockOriginUpdates、TestSkillLockOriginStale）

## 验证

- RED（消融：产品文件回退父提交、测试保留）：`--- FAIL: TestSkillLockOriginUpdates ... update: grill-me isn't from GitHub or a git repository; it's kept as it is`
- GREEN：2 pass；`go test ./internal/library/ -count=1 -tags nogui` ok 63.7s
- gofmt -l 空；vet darwin/linux/windows 干净；build -tags nogui 三平台 ok（darwin cgo warning 预存）

## Watched 三查

1. 手拆回红：见 RED（消融按纪律：先 commit、只回产品文件、基线=分支父提交）
2. 兄弟面：ccSwitchOrigin 5 消费点全查——updatable/prepare/view 三处已改；repoOf（分组语义）不改；CheckSkills/checkDue 不改（update 一次后 source 持久化即纳入 check，扩展 checker 为独立判面，帖内 Not verified 已披露）；MCP/instructions 无 install-from-github 语义，无同病；noteFrom bind 先例语义一致不动
3. 失败读取：lock 读不到/条目无时间戳/madeBy 失败 → 维持现状报错（不猜），帖内 When the read fails 段

## 未决

- GUI check-for-updates 对未 update 过的存量条目仍不询问（CheckSkills 只查 remote source）——帖内明说，判面独立。
