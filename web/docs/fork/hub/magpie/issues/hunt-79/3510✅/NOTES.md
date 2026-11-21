# hunt79-g #3510 过程笔记

基线：upstream/main e57e785633a7976d9ad31771979a6ed5b2e8e99a（worktree /tmp/magpie-hunt79-g，分支 hunt79-g-3510）
占坑：take 评论 https://github.com/yetone/magpie/issues/3510#issuecomment-6387071320

## 代码链核对（现行 main，与 issue 报告一致，行号实测）
- `RemoveProject` internal/library/projects.go:382-399：keep=false 时 `p.Skills, p.Servers = nil, nil` → `l.syncProject(p, &Result{})`（结果被丢弃）→ 仅当 `len(p.Placed)==0 && len(p.Wrote)==0` 摘条目。
- `syncProject` projects.go:105-114：`os.Stat(p.Dir)` 失败或非目录 → 有记录则 `fail("", the folder is gone)` 进传入的 Result → return，Placed/Wrote 原样。
- 死路闭环：RemoveProject 传 `&Result{}` 丢弃 problem → Placed 清不掉 → 条目永留；`change`（library.go:249-264）f 之后 `l.sync()` → syncProjects → 该 gone 项目 problem 进返回 res → GUI toast。GUI 入口 internal/gui/library.go:553 `projects/remove`。
- `projectViews` projects.go:473 同一 os.Stat 判 Missing 徽标——「gone」的定义全库一致用 os.Stat。

## #514 设计核验
- issue #514（closed）= keep 复选框需求来源（删项目但保留 mcp/skill）。
- 实现提交 3b3f5fa7：「unchecked it removes as before」——未对 gone 文件夹做任何设计声明；keep 路径（projects.go:388-391）不看目录存在性。
- 现有测试（TestRemoveProjectKeep、TestProjectSkillsLinked、project_mcp_test.go 各 Remove 调用）全部用活目录，无测试守护「gone 移除失败」——不是有意设计。
- 家族先例：removeSkill（skills.go:1661）`case errors.Is(err, fs.ErrNotExist): // its folder is gone already: only the entry goes`；TestRemoveSkillWhoseFolderIsGone（projects_test.go:243）。修法与家族语义同构，可动手。

## 假设清单
- H1（bug 实锤）：RemoveProject(keep=false) 遇 gone 目录 → 条目卡死 + 返回 res 带 gone problem（用户看到的 toast）。
- H2：keep=true 无条件摘条目，零改动；我的 gone 早退分支必须放在 keep 检查之后。
- H3：syncProject 的 gone 早退是整库 sync 上报（Missing 徽标/problems）的承重墙，不动 syncProject，只动 RemoveProject。
- H4：最小修法 = RemoveProject 里 keep 检查后加 os.Stat gone 检查，直接摘条目（盘上无可回收物，记录随条目走）。

## 兄弟面
- syncProject 调用方：syncProjects（sync.go:119，整库 sync，行为不变）、RemoveProject（修这个）。
- GUI library.go:553 唯一产品入口。
- RemoveSkill/removeSkill：摘库条目 + `delete(p.Skills, name)`，对 gone 项目 Placed 残留属预存行为，本单不碰。
- RemoveServer/removeServer：经 sync 走 syncProjectMCP，gone 同样早退，Wrote 残留预存，不碰。
- targets_gone/gone_agents：agent 目录消失面（targets.go），未触及。
- WSL/远程：project.Dir 是本机路径，badge 与 syncProject 与修法同用 os.Stat，无分叉； stopped distro 的 UNC 路径 stat 失败 → RemoveProject 成功摘条目 = 用户显式请求 + keep 复选框提供保留选项，损失有界（只是「已不可达目录的记录」）。

## RED/GREEN 计划
- 测试 TestRemoveProjectWhoseFolderIsGone 加在 projects_test.go（TestRemoveSkillWhoseFolderIsGone 旁）：placed 非空 → RemoveAll → RemoveProject(false) → r.Problems 空 + 条目摘掉 + 库技能不动；再加 keep+gone 场景守护 H2。
- RED 预期：`the removal said: [{...the folder is gone}]` + `projects: [...]`（与用户 toast 同型）。

## 消融回红结果
- 消融操作：`git checkout e57e7856 -- internal/library/projects.go`（产品文件回父提交，测试保留）→ TestRemoveProjectWhoseFolderIsGone FAIL：`the removal said: [...Error:the folder is gone]` + `projects: [...Placed:[.agents/skills/pdf .claude/skills/pdf]...Missing:true]`——回红成立。
- 事故记录：恢复时误用 `git checkout HEAD --`（当时 HEAD=父提交，修复未入库被抹掉）；已重新应用修复并复跑定向 28 测试（ok 7.9s）+ gofmt + vet 全绿。教训：未提交状态下消融需先备份修复。
- 修复内容（最终）：projects.go RemoveProject，keep 检查之后加 gone 早退分支（os.Stat 同 badge 判据），注释引用 #3510 与 removeSkill 的 fs.ErrNotExist 家族语义。

## 验证矩阵（最终）
- 定向 28 测试（projects/project_mcp/project_targets/gone_agents/targets_gone/skill_gone 家族）：ok 7.911s
- internal/library 包全量（-tags nogui -count=1）：ok 64.964s
- gofmt -l 两文件：clean
- go vet -tags nogui ./internal/library/：clean（internal/gui/trayimage_darwin.go cgo warning 为预存，本单未触及）
- go build -tags nogui ./...：ok

## 失败读取语义回答
- 整库 sync：修前修后一致——gone 项目报 "the folder is gone" problem，条目保留（Missing 徽标承重，不动）。
- 单 skill/server 移除：gone 项目里 placed/wrote 残留为预存行为（syncProject 早退），修前修后一致；本单不扩。
- RemoveProject：修前 = 死路（problem 进丢弃 Result + toast + 条目永留）；修后 = 无 problem、条目与记录一起摘掉。
- 语义损失界定：gone 判据 os.Stat 与 UI 徽标全库同源；损失仅「已不存在目录的记录」，且 keep 复选框保留用户主动保留记录的路径。

## 发布记录
- push origin hunt79-g-3510 → ls-remote 356e013b544ad7719c156730319d442585258047 == 帖中 sha
- fetch upstream 复查：仍 e57e7856，零新提交触及目标文件
- 查重：仅自己 take，无插队
- 交付帖：https://github.com/yetone/magpie/issues/3510#issuecomment-6387171557（一次成功，无重发）
- GET 回读：8 项 grep 全过；与本地原稿 diff 仅 GitHub 追加的 1 个尾部空行
- patch sha256 前 16：5279ff0299710e25
