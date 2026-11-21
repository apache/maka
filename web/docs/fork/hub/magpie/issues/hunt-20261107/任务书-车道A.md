# 狩猎任务书 车道 A：#5566 → #5553（串行，先做完先发布，不等队友）

magpie 贡献车道 A：接单 **#5566**（gateway 翻译）→ **#5553**（gateway hold）。报号：报车道先报单号。

## 环境
- 主仓 /Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie（origin=ggbdpq/magpie，upstream=yetone/magpie，commit 显式 `-c user.name=ggbdpq -c user.email=ggbdpq@gmail.com`）。
- 自建 worktree：fetch upstream --quiet 后 `worktree add /private/tmp/mg-5566 -b fix/5566-responses-cascade-outtok upstream/main`（第二单同理 mg-5553）。GOCACHE=/tmp/mg-车道A-gocache。只碰自己的 worktree/分支。
- patch=`git format-patch -1 --zero-commit`，sha256=产物 raw。

## 单况（主线程排雷已过：两单 OPEN、无 open PR Fixes、零收编引用）
- **#5566**「Remote Magpie cascade skips the output-token default after Responses tool conversion」：两级 magpie（A 0.1.3191 OpenAI 兼容上游 + B 0.1.3192 `preset: remote-magpie`）时 Codex 在 1024 output tokens 截断；直连远端 magpie 正常。远端目录 output=393216 已被本地缓存成功；遗漏在 Remote Magpie provider 的请求转换路（Responses 工具转换后丢 output-token 默认值）。族同 R2 #5509（OpenCode 拒答行）所在的 responses 翻译面。先 `gh issue view 5566 --repo yetone/magpie --comments` 读全文列假设；**take 前重看末评防竞速**，然后评论 take。
- **#5553**「magpie held a request before routing it, and stopped it with 408」：POST /v1/messages，body 6.4MB 读到 1.1MB 处 held 2m35s 被 408；报告附完整 goroutine profile 与 heldFor/body room/known waits 数据。族=gateway hold/body 读取边界。读全文列假设；take 前重看末评，然后 take。

## 铁律
- 让位闸：报告者自带 fork fix/维护者表态/已 landed/方案先行→出列（验证背书/判定帖出口，先报主线程再动）。
- TDD：`grep -n '^func Test'` 精确测试名；RED→最小修复→GREEN；**消融前先提交**（只回退产品文件，基线=分支父提交）；变异点放语义分叉行。
- 兄弟面 rg 全查（改/不改都写理由）；读失败语义；热路径代价。
- 矩阵（按上游 code-standards Acceptance criteria 第 3 条全列，没跑的列 not run）：定向测试 + 改动包 `go test ./internal/<pkg>/ -tags nogui -timeout 25m -count=1` + 全量 `go test -tags nogui ./...`（沙盒 HOME、Go 缓存固定）+ 相称 -race（**5 车道同机并发：race 全包撞超时按 R2 判例改改动包定向 race+同机并发互证**）+ 改动文件 `gofmt -l` 无输出 + `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` + `go build`、`GOOS=linux go build -tags nogui`、`GOOS=windows go build`；命令链 `set -o pipefail`。origin/main 同样失败的项不构成基线，照实列为失败附根因。预存红仅参考：TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy/TestBrowserKeyOffClosesItsBrowser；linux wails `undefined: pointer`。
- **六要素发布门（缺一不准说完成）**：实际 rebase 到当前 main+git am 即进+分支+sha256+测试实名绿+消融回红+兄弟面+实证（报告者原始形状复现，fake 网关/httptest 层复现其形状即可，不可复现面如实标 Not verified），全落 issue。
- 发布：push 显式 refspec→ls-remote→PATCH 帖（draft/template/PATCH帖模板.md；--body-file；REST 404 走 GraphQL）→GET 回读。POST 失败先 GET 绝不重发。
- python 融合后 `show HEAD:<file> | grep -c '<<<<<<<'` 复证再 continue，命令链 && 短路；worktree dirty 即停；provider 死亡等 2 分钟×3 落盘停止；不动 journal/；docs 不提交。

## 产物与回报
每单产物落 /Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-20261107/<单号>-<slug>/（根因/验证矩阵/消融记录/兄弟面/sha256/帖URL 全落文件）。回报：`#<N> | rebase | 测试名+绿 | 消融红→绿 | 兄弟面 | 新head+sha256前16 | 帖URL | 回读 OK/异常`。
