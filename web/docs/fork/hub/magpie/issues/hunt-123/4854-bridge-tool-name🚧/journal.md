# hunt-123 / 4854-bridge-tool-name — Lane C 作业日志

日期：2026-11-04。结局：**让位出列（他人 fork 交付，未 take，未产 patch，零评论）**。

## 单
- Issue：yetone/magpie#4854（Claude subscription bridge: a deferred client MCP tool fails on its own name, works as mcp__magpie__<name>）。c=1，报告者 jsk644102-art（setup-token 桥接）。
- 状态：OPEN，无 assignee，无维护者表态。

## 报告内容定性
- 形状：deferred 客户端自有 MCP 工具（`mcp__yfinance__get_stock_info`）经 ToolSearch 加载后，run 内以 `mcp__magpie__mcp__yfinance__get_stock_info` 提供（单前缀工具被再加 magpie 前缀），客户端文本/ToolSearch 结果以裸名调用 → 首调 "No such tool available"，模型重试带前缀名才成功。6/6 会话复现（opus/sonnet 各 3）。
- 报告者已读 `bridgeToolName`（当前 main 未变），给了 Expected 期望态（"either the run offers the tool under the client's name, or the run's model is told the mapping"）但无实现设计——按证据非方案先例。
- #2649/#4610 相邻单报告者已自行排查非同因。

## 让位闸判定（命中）
- **skygunner 11-02 评论 = fork 交付**（非纯分析）：分支 `skygunner/magpie@fix/4956-4854-bridge-deferred-tool-names`，commit `3086a49605503c910bccd848cbe190549764ba37`（2026-11-02T21:12:38Z，基线 main `8abdf53a8`）。核验属实：
  - diff 面：`internal/gateway/claude_subscription.go` +84、`internal/gateway/claude_deferred_names_test.go` +136（新测试文件）、`docs/subsystems/claude-subscription-bridge.md` +16 -2。
  - 修法：toolStart 对无前缀调用，当该名字是客户端"说过的"（subscriptionRun.tools 发出的 + clientMCPTools/announced 收集的 conversation `mcp__…` 名 + ToolSearch 结果加载的工具，#4956 的 unloaded 半同 commit 修）→ 以模型调用的名字（客户端自己的裸名）交还客户端；run 自己的 claude.ai connectors 的 `mcp__…` 名不交还。覆盖 #4854 报告形状（首调即成功，无隐藏失败轮）。
  - 验证表完整（新测试 base 上红/分支上绿、邻居面、gofmt/vet/build 干净）；末尾明示 "This is a fork branch, offered for review; not a claim on the issue."
- 共享规范 §1：「已被认领、已被上游自修、报告者自带 patch 的单都不接」；handbook 05 §41：「已有实现或协作者交付时先让位，不制造同题 patch」；handbook 06 §36：「撞车即让位」。他人完整 fork 交付在前，本车道让位出列。

## 独立核验
- skygunner commit 真实存在（gh api commits/3086a4960 两查均回，未 fetch 到本地——fork 未配 remote，分支不在我方各 remote 的引用里，`git branch -r --contains` 报 no such commit 属预期）。
- 上游 landed 状态（@tip 667317159）：**#4854 形状仍未修**。维护者 yetone 11-03 落了 `1490045f5`（unloaded deferred magpie MCP tool 交还，packinggoods #feedback 的 `magpie-web-search__web_search` 形状），但其 commit message 明写 "Not changed: a deferred tool of another client MCP server (mcp__linear__…) is still answered by the run (#4956, related #4854)"——即客户端自有 `mcp__yfinance__x` 裸名首调失败这一半仍在。当前 main `claude_subscription.go` 的 `bridgeToolName`（:3681）仍只处理 `mcp__magpie__` 前缀剥除，`mcp__magpieToolName`（:3671）仍无条件加前缀。
- skygunner 分支覆盖的恰是这个残余面（+ #4956 unloaded 半已被上游 1490045f5 独立覆盖）。

## 零评论判定
- handbook 07 §17：「分析不超出现有内容时零评论」。skygunner 的根因分析与报告者一致（其评论已 credit 报告者 "your diagnosis was exactly right"），我方独立核验无信息增量；上游 1490045f5 的边界声明已自证 #4854 残余面存在，无需我方重复指路。发让位帖只会是第三份同语分析 → 按先例零评论出列。

## 产物
- 无 patch、无分支、无 push、无 issue 评论（让位单零产物面）。
- 本 journal 即唯一落盘。

## 教训
- c=1 的单评论定性是第一闸：skygunner 评论首句 "Reproduced and fixed on a branch" 即判 fork 交付，不必进入技术面。任务书"读其评论定性：纯分析还是 fork 交付？fork 交付→让位出列"两步走省了全部 RED/GREEN 成本。
- 上游 landed 核验要读 commit message 全文：1490045f5 表面像修了 #4854 相邻面，实际 "Not changed" 段明写 #4854 残余——单看 --stat 或 subject 会误判"已修→出列"或"未修→可接"，读全文才定得了残余归属。
