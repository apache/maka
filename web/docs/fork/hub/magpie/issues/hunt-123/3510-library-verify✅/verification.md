# #3510 library 移除外部删除的项目文件夹 — R5 合并前终验（2026-11-05）

结论：**CLEAN，可入下批 Discord 帖**。终验帖已由并行车道发布（comment 6660563344，14:30:50Z），本车道独立重验与其逐项互洽，未重复发帖（防撞车）。

## 对象与拓扑

- issue：#3510（FengZhiHen1，2026-10-24，open）：文件夹在 magpie 外被删的项目移除不掉——`syncProject` 对缺失目录直接 fail("the folder is gone") 返回且不清 `Placed`，`RemoveProject` 的摘条目条件 `len(p.Placed)==0 && len(p.Wrote)==0` 永不成立；唯一出路是 keep 勾选（#514），语义不符。
- 支：origin/hunt79-g-3510。终验时权威 head **918906a6a**（parent = 326e72f4c = 真上游 tip，committer 2026-11-05 22:27 +0800，并行车道刚推）。
- 版本线：356e013b5（原单，基 e57e7856）→ d1ef262e9（评论 3 rebase，基 f193c3865，10-29 发布）→ 918906a6a（本轮 rebase，基 326e72f4c）。
- 注意：/private/tmp/mg123-r5 的本地 upstream/main 引用陈旧（8bfc551ee，是 326e72f4c 的祖先）；真 tip 以 am 树 `git fetch upstream main` 的 FETCH_HEAD = **326e72f4c** 为准。f193c3865..tip = 1479 提交；原基点 e57e7856..tip = 2210 提交。

## 上游收编排查（真 tip 326e72f4c）

- `git log f193c3865..upstream/main -- internal/library/projects.go`：仅 5957223d8（DeepSeek Harness 项目技能，不同面，不触 RemoveProject 删除逻辑）；projects_test.go 零触碰。
- `git grep TestRemoveProjectWhoseFolderIsGone upstream/main`：NOT FOUND，未收编。
- tip 上 `RemoveProject` 与 `syncProject` 的 gone 分支（L121-126 fail "the folder is gone"）与 issue 引用逐字一致，bug 链完整，修法语义仍适用 → 不转判定帖，维持 patch 路线。

## 重验矩阵（基点 326e72f4c，GOCACHE=/tmp/mg123-r5-gocache）

| 检查 | 结果 |
| --- | --- |
| format-patch 双端点导出（f193c3865..origin 分支） | 2 文件 +46 行 |
| 干净树 am -3（worktree /private/tmp/mg123-r5-am @ 326e72f4c） | EXIT=0 零冲突，head e16ea4a14；产物 hunk 落位 keep 分支后、syncProject 前，行号 389→401 漂移系 5957223d8 所致 |
| library 包全量 `go test -tags nogui -count=1 -timeout 25m ./internal/library/` | ok 76.7s（mg123-r5-lib-full.log） |
| 消融回红（revert projects.go 保测试，-run TestRemoveProjectWhoseFolderIsGone） | 红：`the removal said: [... Error:the folder is gone]`，条目带 Placed 留存（mg123-r5-ablate.log）；测试为纯追加 + 上游零触碰该测试文件，等价 test-only-on-main |
| gofmt -l（两改动文件） | clean |
| go vet -tags nogui ./internal/library/ | clean |
| go build -tags nogui ./... | EXIT=0；internal/gui cgo 警告预存（补丁 diff --stat 仅 library 两文件，`git diff 326e72f4c HEAD -- internal/gui/` 零差异） |
| 918906a6a vs 本车道 am 产物 e16ea4a14 | `git diff` 空——树逐字节一致，验证结果对该 remote head 直接有效 |

## push 决策

本车道 push --force-with-lease（期望 d1ef262e9）被拒 stale → fetch 发现 remote 已是 918906a6a（并行车道 22:27 已推同基点同内容）。树一致，**不再重复 push**，918906a6a 即权威 head。

## 帖同步

并行车道已发终验帖 6660563344（存档 posted-reverify-6660563344.md）：基点/head/parent 三处已换新（918906a6a，parent=326e72f4c），验证表含消融回红（含 project-skills 新增 agents 后仍红）、定向、同文件邻居、全量 75.2s、三平台 build、Not run 诚实标注；并声明首评论 patch（356e013b 版，SHA-256 前 16 5279ff0299710e25）在当前 main 上仍 `git am` as-is——成立（上游从未触碰两文件）。本车道已备未发出的同义 payload（6678 字节），因撞车弃发。

## 评估：可入下批帖

- 证据齐：消融回红 + 全量 + fmt/vet/build + 三次独立全绿（356e013b 65s / d1ef262e9 55.5s / 918906a6a 76.7s 与 75.2s 两次）。
- 未收编、语义未被替代（tip 上 bug 链原样）。
- 帖稿时机用户管；本车道只评估不动。

## Not run（与既有各轮一致的范围外项）

- 全量 ./... 套件、-race、GUI 实操移除轮。
- 预存红对照（TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy）不适用：本次触面仅 internal/library，未跑 gateway 侧全量。
