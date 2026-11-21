# 任务书 · 三场车道 B6 · #5494 rework（维护者 review 回炉）

## 0. 环境与纪律

- 主仓 `/Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie`。上游 yetone/magpie，fork ggbdpq/magpie，**patch 附 issue 禁 PR**。
- 开工 fetch 记 tip（当前 ≥`a7113d5c9`），实际 rebase 到当前 main。
- worktree 自建自清：`/private/tmp/mg1107s3-b6`（分支 `fix/5494-codex-session-fallback-r2`）；`GOCACHE=/tmp/mg-s3b6-gocache`。**严禁触碰其它 mg* worktree；只碰自己的分支。**
- 提交身份 author=`ggbdpq <ggbdpq@gmail.com>`。
- **并行会话协调**：接单前读 `/tmp/magpie-sweep/active-claims.json`（#5494 rework 已登记本车道专属——维护者末评点名 @ggbdpq）；发布前实时复核 issue 评论态。

## 1. 单情与维护者 review（唯一修法依据）

- issue: yetone/magpie#5494（报告者 MuRanSea）。**我方原 patch 已发**（帖 6701889379，head `e5cd2932c`，sha256 `b2eda47bd0cbff01`，本地分支 `fix/5494-codex-session-fallback` 落后 tip 30+ 提交）。
- **维护者末评（2026-11-07T15:08:46Z，中文）**：暂不合入。维护者探针复现：补丁在 `viaBase()` 成立时会删除 openai_base_url，并按 codex.provider 的暂存把线程搬回去——**用户自己手写了指向 magpie 的 openai_base_url（#856 的用法）+留着一份过期的 codex.provider 暂存时，同步一次就会把用户的 base URL 删掉**（打补丁后报 "sync 0 took the user's base URL away"，main 上不会）。
- **维护者两条修改方向**：①只在接管自己的标记表明是 magpie 写入的时候才删除 base URL；②在手动改离 magpie 时清除或忽略过期的 codex.provider 暂存。**"@ggbdpq 改好后欢迎再提交"。**

## 2. TDD 流程

- RED 先行：**先复现维护者探针形状**（"took the user's base URL away"）：手写 openai_base_url 指向 magpie+过期 codex.provider 暂存 → sync → 现状（原 patch 语义）删掉用户 base URL 红 → 修后绿。`grep -n '^func Test'` 找 viaBase/迁移族现有测试。
- 修法两问：①"接管自己的标记"如何表明是 magpie 写入（读暂存结构——有没有 magpie 自己的标记字段/值特征；没有则加标记）；②"手动改离 magpie"的判定（用户 base URL ≠ magpie 写入值时算改离→清除暂存或忽略）。
- 消融回红：变异点放语义分叉行，**消融写入后 git diff --stat 复证**。
- 兄弟面：viaBase 全调用方+codex.provider 暂存读写点全查+#856 语义对齐。

## 3. 矩阵与发布

- 定向+改动包 `-tags nogui -timeout 25m`+相称 `-race`+gofmt/vet/build×3（linux build 预存红 wails beta.24 照实列）。
- 发布：commit→push 显式 `<sha>:refs/heads/fix/5494-codex-session-fallback-r2`（force-with-lease 钉旧值）→format-patch -1 --zero-commit+sha256 前16+干净检出 am 树对比→**PATCH 帖 rework 变体开头**（模板=draft/template/PATCH帖模板.md 尾注变体：`Rework per @yetone's review ([the review](…#issuecomment-<维护者末评 id>)): <一句方向> — <一句本次怎么改>`，五段+三件套+报告者 MuRanSea credit+尾注 `Generated-by: GLM-5.3-Flash (ZCode)`；对外全英文）用 `gh issue comment 5494 --repo yetone/magpie --body-file`（禁 -f）→GET 回读→产物落 `…/issues/hunt-20261107/5494-codex-session-fallback-r2🚧/`。

## 4. 回报格式

`#5494 r2` / `rebase to <tip>` / 维护者探针 RED 复现 / 测试名+绿 / 消融红→绿 / 兄弟面 / 新head+sha256前16 / 帖URL / 回读。

## 5. 工程铁律

provider 死亡等 2 分钟×3 落盘停止；`set -o pipefail`；未提交树上禁 `checkout HEAD --`；PATCH 失败先 GET 绝不重发；RED 先跑（绿=面已被盖出列）；**六要素缺一不准说"完成"**。
