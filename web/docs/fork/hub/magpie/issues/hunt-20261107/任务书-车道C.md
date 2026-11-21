# 狩猎任务书 车道 C：#5573 → #5554（串行，先做完先发布，不等队友）

magpie 贡献车道 C：接单 **#5573**（catalog 能力档）→ **#5554**（模型发现）。报号：报车道先报单号。

## 环境
- 主仓 /Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie（origin=ggbdpq/magpie，upstream=yetone/magpie，commit 显式 `-c user.name=ggbdpq -c user.email=ggbdpq@gmail.com`）。
- 自建 worktree：fetch upstream --quiet 后 `worktree add /private/tmp/mg-5573 -b fix/5573-alma-functioncalling upstream/main`（第二单同理 mg-5554）。GOCACHE=/tmp/mg-车道C-gocache。只碰自己的 worktree/分支。
- patch=`git format-patch -1 --zero-commit`，sha256=产物 raw。

## 单况（主线程排雷已过：两单 OPEN、无 open PR Fixes、零收编引用）
- **#5573**「alma: Magpie 写入的模型缺少 functionCalling，Alma 退回 XML 工具模式，模型只说不做」：接管 Alma 后模型不调工具——magpie 写入的 provider 块 `capabilityOverrides` 只有 contextWindow/maxOutputTokens/reasoning/reasoningLevels/vision，缺 `functionCalling`；Alma 按 ID 查不到能力库 → 标成 `functionCallingViaXml: true` → K3.1 Pro 不按 XML 格式输出，只回一句预告就 stop。报告含写入 JSON 样例与 `alma providers <id>` 读法。族同 #5567（writer 缺档，车道 B 在做——**改前互查是否动同一 writer 族文件**）。先 `gh issue view 5573 --repo yetone/magpie --comments` 读全文列假设；**take 前重看末评防竞速**，然后评论 take。
- **#5554**「Codex 子代理模型发现不一致：ALL_TOOLS 只列出 5 个模型，但 WorkBuddy 模型可完成调用」：`multi_agent_v1__spawn_agent` 描述里 `Available model overrides` 只列 5 个内置 gpt 模型，而同聊天另一入口 tool_search 的扩展列表含 `workbuddy/hy4free` 等外部 provider 模型且可成功调用；`model` 参数无枚举限制。**关联 #5375（先读该单与自己的关系，防重复面）**。族=catalog/模型发现一致性。读全文列假设；take 前重看末评，然后 take。

## 铁律
- 让位闸：报告者自带 fork fix/维护者表态/已 landed/方案先行→出列（验证背书/判定帖出口，先报主线程再动）。
- TDD：`grep -n '^func Test'` 精确测试名；RED→最小修复→GREEN；**消融前先提交**（只回退产品文件，基线=分支父提交）；变异点放语义分叉行。
- 兄弟面 rg 全查（改/不改都写理由）——**writer 族（dsh/commandcode/alma 等）逐个 writer 对比 + spawn/tool_search 两描述生成路对比是本车道兄弟面重点**；读失败语义。
- 矩阵（按上游 code-standards Acceptance criteria 第 3 条全列，没跑的列 not run）：定向测试 + 改动包 `go test ./internal/<pkg>/ -tags nogui -timeout 25m -count=1` + 全量 `go test -tags nogui ./...`（沙盒 HOME、Go 缓存固定）+ 相称 -race（**5 车道同机并发：race 全包撞超时按 R2 判例改改动包定向 race+同机并发互证**）+ 改动文件 `gofmt -l` 无输出 + `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` + `go build`、`GOOS=linux go build -tags nogui`、`GOOS=windows go build`；命令链 `set -o pipefail`。origin/main 同样失败的项不构成基线，照实列为失败附根因。预存红仅参考：TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy/TestBrowserKeyOffClosesItsBrowser；linux wails `undefined: pointer`。
- **六要素发布门（缺一不准说完成）**：实际 rebase 到当前 main+git am 即进+分支+sha256+测试实名绿+消融回红+兄弟面+实证（报告者原始形状复现；#5573 用其 JSON 样例起 fixture 复现 XML 工具模式退化形状），全落 issue。
- 发布：push 显式 refspec→ls-remote→PATCH 帖（draft/template/PATCH帖模板.md；--body-file；REST 404 走 GraphQL）→GET 回读。POST 失败先 GET 绝不重发。
- python 融合后 `show HEAD:<file> | grep -c '<<<<<<<'` 复证再 continue，命令链 && 短路；worktree dirty 即停；provider 死亡等 2 分钟×3 落盘停止；不动 journal/；docs 不提交。

## 产物与回报
每单产物落 /Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-20261107/<单号>-<slug>/（根因/验证矩阵/消融记录/兄弟面/sha256/帖URL 全落文件）。回报：`#<N> | rebase | 测试名+绿 | 消融红→绿 | 兄弟面 | 新head+sha256前16 | 帖URL | 回读 OK/异常`。
