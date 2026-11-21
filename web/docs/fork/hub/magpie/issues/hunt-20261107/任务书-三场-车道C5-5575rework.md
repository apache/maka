# 任务书 · 三场车道 C5 · #5575 rework（维护者 review 回炉，两处修改）

## 0. 环境与纪律

- 主仓 `/Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie`。上游 yetone/magpie，fork ggbdpq/magpie，**patch 附 issue 禁 PR**。
- 开工 fetch 记 tip（当前 ≥`a7113d5c9`），实际 rebase 到当前 main。
- worktree 自建自清：`/private/tmp/mg1107s3-c5`（分支 `fix/5575-unstreamed-speed-r2`）；`GOCACHE=/tmp/mg-s3c5-gocache`。**严禁触碰其它 mg* worktree；只碰自己的分支。**
- 提交身份 author=`ggbdpq <ggbdpq@gmail.com>`。
- **并行会话协调**：接单前读 `/tmp/magpie-sweep/active-claims.json`（#5575 rework 已登记本车道专属——维护者末评点名 @ggbdpq）；发布前实时复核 issue 评论态。

## 1. 单情与维护者 review（唯一修法依据）

- issue: yetone/magpie#5575（报告者 Buffnada：非流式请求无首字时间，速度优先路由总选第一个）。**我方原 patch 已发**（帖 6701960470，head `9080daf08`+`59085560a`，本地分支 `fix/5575-unstreamed-speed` 落后 tip 30+）。
- **维护者末评（2026-11-07T15:08:48Z，中文）**：暂不合入。方向认可（新测试 main 红→补丁绿）但两处问题：
  1. **漏了同类的地方**：Routing 页面的说明文字（`internal/gui/assets/plugins/routing/client.js` 的 "fast" 分支）仍然只看 `lateTtft`——一个只靠吞吐排在前面的账户，界面上还会说"最近都没回答过，所以按列表顺序选了第一个"，而这正是报告者看到的地方。
  2. **非流式回复用整段耗时折算的速度（含首字等待）和流式解码速度混在同一个平均值里**，排序会偏向流式账户——需要分开记录或至少分开比较。
- **"@ggbdpq 改好后欢迎再提交"。**

## 2. TDD 流程

- RED 先行两测试：①client.js "fast" 分支形状（只靠吞吐排前的账户→现状说明文字仍是"按列表顺序"→修后说吞吐）；②混算形状（非流式折算速度与流式速度同均值→现状排序偏向流式→分开记录/比较后不偏）。`grep -n '^func Test'`+同族 test.cjs（routing-*）找现有形状。
- 修法注意：#5575 原修=非流式按报告者口径记 tps+Fastest 以 TPS>0 计 measured——r2 在其上补 client.js 同族+速度分记。**分开记录 or 分开比较选语义更稳的**（五问；动 Usage/排序两侧数据结构的最小面）。
- 消融回红：变异点放语义分叉行，**消融写入后 git diff --stat 复证**。
- 兄弟面：lateTtft 全消费方（client.js/Go 侧）、TPS 记录点全查（非流式/流式两路）、routing 排序比较点全查。

## 3. 矩阵与发布

- GUI 测试按 repo 口径（**NODE_PATH=/Users/ggbdpq/cc/guahub/fork/maka-hub/maka-pr2/node_modules**；跑不了的引擎标 NOT-RUNNABLE）+改动包 `-tags nogui`+定向 race+gofmt/vet/build×3（linux build 预存红照实列）。
- 发布：commit→push 显式 `<sha>:refs/heads/fix/5575-unstreamed-speed-r2`（force-with-lease 钉旧值）→format-patch -1 --zero-commit+sha256 前16+干净检出 am 树对比→**PATCH 帖 rework 变体开头**（`Rework per @yetone's review ([the review](…#issuecomment-<维护者末评 id>)): <方向> — <本次怎么改>`，五段+三件套+报告者 Buffnada credit+尾注 `Generated-by: GLM-5.3-Flash (ZCode)`；对外全英文）`gh issue comment 5575 --repo yetone/magpie --body-file`（禁 -f）→GET 回读→产物落 `…/issues/hunt-20261107/5575-unstreamed-speed-r2🚧/`。

## 4. 回报格式

`#5575 r2` / `rebase to <tip>` / 两 RED 形状 / 测试名+绿 / 消融红→绿 / 兄弟面 / 新head+sha256前16 / 帖URL / 回读。

## 5. 工程铁律

provider 死亡等 2 分钟×3 落盘停止；`set -o pipefail`；未提交树上禁 `checkout HEAD --`；PATCH 失败先 GET 绝不重发；RED 先跑（绿=面已被盖出列）；**六要素缺一不准说"完成"**。
