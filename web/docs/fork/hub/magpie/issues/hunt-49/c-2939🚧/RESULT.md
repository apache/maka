# hunt49-c-maxconc-429 — yetone/magpie#2939

本地并发闸拒绝在 routing 路由痕迹里以独立 fail 原因记录（`fail: "local"`），不再与厂商 429 撞成不可区分。纯可观测性改动，线上行为（发给 agent 的 429 及其 Retry-After、文案）一字未动。

## 交付物

- 工作树：`/tmp/magpie-h22`（分支 `hunt49-c-maxconc-429`，基线 upstream/main `7916045591c318c84fa894022516a7ebffc9a91e`）
- 提交：`f52f6382572d396dc54b553eb2768ca0df196df4`（父提交即 `79160455…`，作者 `ggbdpq <ggbdpq@gmail.com>`，3 文件 +94 行）
- 补丁：`0001-gateway-a-local-concurrency-rejection-is-recorded-as.patch`（`git format-patch -1 -U1`，反向 `git apply --check --reverse` 通过），sha256 前 16：`e9f1bcd7533de634`
- 评论稿：`2939-comment.body.md`（英文，全文 grep 无中文字符）
- 未推送、未发帖（按任务约束）

## 改动内容

1. `internal/gateway/routing.go`：新增 fail 原因常量 `failLocal = "local"`（与 credit/quota/rate/refused/… 并列），注释说明覆盖三个本地闸：QueueLimit 队列满、QueueWait 等满、MaxRPM 分钟内无空位。
2. `internal/gateway/gateway.go`（laneErr 分支，+3 行）：写 trace try 时补 `tt.Fail = failLocal`。该分支同时覆盖 errQueueFull/errQueueWait/errRPM，三者均为本地拒绝，一并标记。
3. `internal/gateway/lane_local_fail_test.go`（新增测试）：`TestLocalTurnAwayIsMarkedInItsTry`，MaxConcurrency=1/QueueLimit=1/QueueWait=1 下三个请求（占槽/排队/被拒），断言 (a) 被拒客户端拿到与从前相同的即时 429（OpenAI 形状、error.type 非空、Retry-After），(b) 两个被拒 try（队列满 + 等满）在 trace 里 `fail == "local"`。测试用字面量 `"local"` 钉住 JSON 日志契约。

字段语义：厂商拒绝带 `fail: "quota"|"rate"|…`（rest 存在时还带 `rest`），本地拒绝带 `fail: "local"` 且无 `rest`；routing/*.jsonl 消费者一个字段即可分流。`Try.Fail` 在后端只有 vendor 失败分类路径读取（laneErr 分支在其前 continue/break），新值零行为风险；GUI `failWord` 对未知值回退通用文案，安全。

## RED / GREEN（精确）

- RED（改前 current main 代码）：`go test ./internal/gateway/ -run TestLocalTurnAwayIsMarkedInItsTry` → `try "slow" (slow: 1 requests at once is its limit, and this one waited 1.0s …) = fail "", want "local"`，FAIL。（最初引用未定义常量时为编译红，改用字面量后取得行为断言红。）
- GREEN（实现后）：同命令 ok；邻组 lane/queue/ledger 测试（TestQueueFullAndWaitedOut、TestQueueRefusalIsInTheUsageLedger、TestAccountLimitSharedAcrossGroups、TestFullMemberGivesWay、TestLaneReleasedOnFailure）全 ok。

## 消融与变异

- 消融（两产品文件回到 HEAD 原版、测试保留）：断言红，`fail ""` 复现 → 恢复后绿（shasum 与备份逐字节一致，diff 回到 +11/+94）。
- 变异 (a) 仅去掉 `tt.Fail = failLocal`：红（`fail ""`）。
- 变异 (b) 把客户端状态改为 503（模拟越权改行为）：形状断言红（`want the usual immediate 429 with Retry-After`，实得 503）。证明测试同时守住线上形状。

## 验证矩阵

| 项 | 命令 | 结果 |
| --- | --- | --- |
| targeted | `go test ./internal/gateway/ -run 'TestLocalTurnAway…\|TestQueue…' -count=1` | ok 3.4s |
| 全包（后台） | `go test ./internal/gateway/ -count=1` | **ok 318.6s，0 失败**，FULL-EXIT=0 |
| -race | targeted 三条，`-race` | ok 4.2s |
| gofmt | `gofmt -l internal/gateway/` | 空 |
| vet | `go vet` darwin/linux/windows | 三平台全 0 |
| build | `go build .` darwin / windows | 0（darwin 仅预存 ld 警告） |
| build linux 整仓 | `GOOS=linux go build .` | **失败（预存）**：第三方 `wails/v3@v3.0.0-beta.24` 自身 `menu_linux.go` 等报 `undefined: pointer`；本 diff 仅动 internal/gateway，wails 的编译输入不变，定性预存；`GOOS=linux go build ./internal/gateway/` 通过 |
| build gateway linux/windows | `go build ./internal/gateway/` | 双平台 0 |

## 覆盖了 reporter 的哪些痛点

- 痛点 1（状态码撞车）：**解决**。routing trace try 带独立 `fail: "local"`；usage.jsonl 本就带 `rejected: true`（本次核实，无需改）。
- 痛点 2（账号级计数连坐）：**未动**。per-model 粒度是行为/配置特性，维护者决策，评论稿已列为 open。
- 痛点 3（"its" 指代不明）：**未动**。改文案属线上行为变化，评论稿明确留给维护者（错误文案本身已含 "…is its limit, and its queue is full" 全句，且现在 fail 字段可机读）。

## Siblings 核实结论（已写入评论稿）

- 网关 key 限额（key_limit.go）：usage 行已带 `rejected: true` + `err_type: "gateway_key_limit"` + `X-Magpie-Limit-Reset` 头，本就可区分。
- RPM 限流：与队列同一 laneErr 分支，现在同样标 `fail: "local"`；其 Retry-After/文案已可再分，若要 SQL 级再分可加 `"rpm"`（一行，评论稿已提）。
- GUI：未知 fail 值回退通用文案，`"local"` 渲染安全；专属短语可作后续小改。

## 不确定项

1. reporter 的 22-provider 免费池负载未复现，验证基于 fixture（单慢厂商、单槽、单队列位）。
2. linux 整仓构建失败定性为预存（第三方 wails 模块 + 本机工具链），未在干净 HEAD 基线重跑同一命令验证，依据是编译输入不变（diff 不触 go.mod/go.sum/gui/wails）+ gateway 包单独构建通过。
3. `fail: "local"` 是否要再细分 queue/rpm、GUI 是否配专属文案、以及是否顺手给 usage 行加 ErrType，留维护者定夺；本次保持最小。
4. 评论稿中 patch 用 `-U1` 上下文（默认 `-U3` 的上下文行含上游既有中文注释，违反评论稿零中文约束）；`git am` 兼容性以 `git apply --check --reverse` 佐证，未实际在干净 clone 上跑 `git am`。
