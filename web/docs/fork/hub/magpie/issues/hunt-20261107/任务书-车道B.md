# 狩猎任务书 车道 B：#5576 → #5567（串行，先做完先发布，不等队友）

magpie 贡献车道 B：接单 **#5576**（catalog 目录判定）→ **#5567**（catalog 档写盘）。报号：报车道先报单号。

## 环境
- 主仓 /Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie（origin=ggbdpq/magpie，upstream=yetone/magpie，commit 显式 `-c user.name=ggbdpq -c user.email=ggbdpq@gmail.com`）。
- 自建 worktree：fetch upstream --quiet 后 `worktree add /private/tmp/mg-5576 -b fix/5576-noapi-native-endpoints upstream/main`（第二单同理 mg-5567）。GOCACHE=/tmp/mg-车道B-gocache。只碰自己的 worktree/分支。
- patch=`git format-patch -1 --zero-commit`，sha256=产物 raw。

## 单况（主线程排雷已过：两单 OPEN、无 open PR Fixes、零收编引用）
- **#5576**「自定义 provider：模型只在列表里声明一种协议时，被目录与路由组剔除，但直连请求可用」：自定义 provider 只配 chat 地址，拉到的模型 `native_endpoints` 只声明 `/v1/messages` → 直连 provider/model 成功（中转自己做协议转换），但 NoAPI 把同一模型从 provider 目录和路由组剔除，单模型路由组 404、编辑器显示「没有暴露模型」。报告含完整真实环境复现（远端 magpie 0.1.3190 Windows + 本机 0.1.3190 网关）。族=catalog 目录可用性判定（能调用的被判不可用）。先 `gh issue view 5576 --repo yetone/magpie --comments` 读全文列假设；**take 前重看末评防竞速**，然后评论 take。
- **#5567**「commandcode: providers.json entries carry no contextWindow or maxOutput」：magpie 写给 Command Code（`~/.commandcode/providers.json`）的模型块只有 name/reasoning/reasoningEfforts，1M 窗口模型被 Command Code 当 200K 默认；同模型写给 dsh 的配置两个字段都有——数据（catalog.Model.Context/.Output）magpie 已知，只有这一个 writer 漏写。族同 #5573（writer 缺档），与车道 C 的 #5573 同型不同面（**改前查 #5573 车道是否已动同一 writer 族文件，兄弟面互查**）。读全文列假设；take 前重看末评，然后 take。

## 铁律
- 让位闸：报告者自带 fork fix/维护者表态/已 landed/方案先行→出列（验证背书/判定帖出口，先报主线程再动）。
- TDD：`grep -n '^func Test'` 精确测试名；RED→最小修复→GREEN；**消融前先提交**（只回退产品文件，基线=分支父提交）；变异点放语义分叉行。
- 兄弟面 rg 全查（改/不改都写理由）——**writer 族（dsh/commandcode/alma 等）逐个 writer 对比是本车道兄弟面重点**；读失败语义。
- 矩阵（按上游 code-standards Acceptance criteria 第 3 条全列，没跑的列 not run）：定向测试 + 改动包 `go test ./internal/<pkg>/ -tags nogui -timeout 25m -count=1` + 全量 `go test -tags nogui ./...`（沙盒 HOME、Go 缓存固定）+ 相称 -race（**5 车道同机并发：race 全包撞超时按 R2 判例改改动包定向 race+同机并发互证**）+ 改动文件 `gofmt -l` 无输出 + `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` + `go build`、`GOOS=linux go build -tags nogui`、`GOOS=windows go build`；命令链 `set -o pipefail`。origin/main 同样失败的项不构成基线，照实列为失败附根因。预存红仅参考：TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy/TestBrowserKeyOffClosesItsBrowser；linux wails `undefined: pointer`。
- **六要素发布门（缺一不准说完成）**：实际 rebase 到当前 main+git am 即进+分支+sha256+测试实名绿+消融回红+兄弟面+实证（报告者原始形状复现；#5576 可按其真实环境形状起两级 fake/httptest 复现 NoAPI 剔除→404），全落 issue。
- 发布：push 显式 refspec→ls-remote→PATCH 帖（draft/template/PATCH帖模板.md；--body-file；REST 404 走 GraphQL）→GET 回读。POST 失败先 GET 绝不重发。
- python 融合后 `show HEAD:<file> | grep -c '<<<<<<<'` 复证再 continue，命令链 && 短路；worktree dirty 即停；provider 死亡等 2 分钟×3 落盘停止；不动 journal/；docs 不提交。

## 产物与回报
每单产物落 /Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-20261107/<单号>-<slug>/（根因/验证矩阵/消融记录/兄弟面/sha256/帖URL 全落文件）。回报：`#<N> | rebase | 测试名+绿 | 消融红→绿 | 兄弟面 | 新head+sha256前16 | 帖URL | 回读 OK/异常`。
