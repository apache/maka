# 狩猎任务书 车道 E：#5579 → #5575（串行，先做完先发布，不等队友）

magpie 贡献车道 E：接单 **#5579**（订阅桥并发启动）→ **#5575**（routing/usage 速度）。报号：报车道先报单号。

## 环境
- 主仓 /Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie（origin=ggbdpq/magpie，upstream=yetone/magpie，commit 显式 `-c user.name=ggbdpq -c user.email=ggbdpq@gmail.com`）。
- 自建 worktree：fetch upstream --quiet 后 `worktree add /private/tmp/mg-5579 -b fix/5579-sub-start-storm upstream/main`（第二单同理 mg-5575）。GOCACHE=/tmp/mg-车道E-gocache。只碰自己的 worktree/分支。
- patch=`git format-patch -1 --zero-commit`，sha256=产物 raw。

## 单况（主线程排雷已过：两单 OPEN、无 open PR Fixes、零收编引用）
- **#5579**「Windows: concurrent Claude subscription starts miss the 45s prompt and replay together (502 storm)」：多个 Claude 订阅调用并发各自经 `claude-tui-helper` 起完整 Claude Code，45s 内都没出 prompt → magpie 把每个在途会话立即重放进新进程 → 启动持续堆积、调用方持续 502。同机同订阅清掉并发后恢复正常。0.1.2901/0.1.3057 双版本在案，报告附 app.log 数据。族=订阅桥进程管理（claude-tui-helper）。**实证口径（先想清楚再动手）**：Windows 面本机 mac 不可真机复现——用 stub `claude`/helper 可执行（PATH 注入慢启动假进程）复现并发堆积+重放逻辑的跨平台代码路径；Windows-only 残面如实标 Not verified（报告者环境为准）。先 `gh issue view 5579 --repo yetone/magpie --comments` 读全文列假设；**take 前重看末评防竞速**，然后评论 take。
- **#5575**「非流式请求没有首字时间 无法计算速度，在速度优先路由下总是选择第一个」：速度优先路由对"最近没回答过"的模型按列出顺序选第一个 API key；用量-请求里速度=输出token/总耗时，有的有结果有的为空（非流式没有首字时间，测不出速度）→ 路由意图退化成顺序固定。报告附用量页截图。族=routing 速度计算/usage 口径。读全文列假设；take 前重看末评，然后 take。

## 铁律
- 让位闸：报告者自带 fork fix/维护者表态/已 landed/方案先行→出列（验证背书/判定帖出口，先报主线程再动）。
- TDD：`grep -n '^func Test'` 精确测试名；RED→最小修复→GREEN；**消融前先提交**（只回退产品文件，基线=分支父提交）；变异点放语义分叉行。
- 兄弟面 rg 全查（改/不改都写理由）——45s 守卫/重放（replay）调用方逐个对比；速度计算消费方（路由排序+用量页）两面对比；读失败语义；热路径代价。
- 矩阵（按上游 code-standards Acceptance criteria 第 3 条全列，没跑的列 not run）：定向测试 + 改动包 `go test ./internal/<pkg>/ -tags nogui -timeout 25m -count=1` + 全量 `go test -tags nogui ./...`（沙盒 HOME、Go 缓存固定）+ 相称 -race（**5 车道同机并发：race 全包撞超时按 R2 判例改改动包定向 race+同机并发互证**）+ 改动文件 `gofmt -l` 无输出 + `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` + `go build`、`GOOS=linux go build -tags nogui`、`GOOS=windows go build`；命令链 `set -o pipefail`。origin/main 同样失败的项不构成基线，照实列为失败附根因。预存红仅参考：TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy/TestBrowserKeyOffClosesItsBrowser；linux wails `undefined: pointer`。
- **六要素发布门（缺一不准说完成）**：实际 rebase 到当前 main+git am 即进+分支+sha256+测试实名绿+消融回红+兄弟面+实证（报告者原始形状复现；#5579 用 stub helper 复现堆积形状，Windows-only 残面如实标 Not verified），全落 issue。
- 发布：push 显式 refspec→ls-remote→PATCH 帖（draft/template/PATCH帖模板.md；--body-file；REST 404 走 GraphQL）→GET 回读。POST 失败先 GET 绝不重发。
- python 融合后 `show HEAD:<file> | grep -c '<<<<<<<'` 复证再 continue，命令链 && 短路；worktree dirty 即停；provider 死亡等 2 分钟×3 落盘停止；不动 journal/；docs 不提交。

## 产物与回报
每单产物落 /Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-20261107/<单号>-<slug>/（根因/验证矩阵/消融记录/兄弟面/sha256/帖URL 全落文件）。回报：`#<N> | rebase | 测试名+绿 | 消融红→绿 | 兄弟面 | 新head+sha256前16 | 帖URL | 回读 OK/异常`。
