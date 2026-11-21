# limitreset 真实链路证据升级与 TDD 修复（hunt41-relay-limit-reset）

日期：2026-10-18。基线 upstream/main @ `d783df46cbac9021e26a6bd71ca0b55544552eb2`（开工 fetch 后复核未动）。原件：`review-2026-10-18/2167-finding-keylimit-header-lost-in-relay.md`。本单不发帖、不开 issue、不关单；fork 分支已推送（已授权）。

## 根因链（第一性原理重推，全部读点已核实）

1. **写点**：远端 magpie 的 `keyLimited`（`internal/gateway/key_limit.go:64`）对超限网关 key 回 429，带 `X-Magpie-Limit-Reset`（常量 `remoteKeyLimitHeader`，key_limit.go:28，RFC3339）+ `Retry-After` + `X-Should-Retry: false`。
2. **读点**：消费方 magpie 的 `remoteModelRest`（`internal/gateway/routing.go:939`）是全仓唯一读点：marker **在** → 返回 false → rest 落 `restKey()`（整个 remote，#2077 语义）；marker **缺** → 返回 true → rest 落 `restID()`（单模型）。消费处两处：rest 作用域块 `routing.go:908-909`、`rateRest` `routing.go:955-958`。marker 只影响**作用域**，不影响时长（`retryAfter` 只读 `Retry-After` 与 `ratelimit…reset`，routing.go:1067）。
3. **丢失点（共享根因）**：group fallback 主链的应答体是 `holdWriter`，其 header 是自建空 `http.Header{}`（`newHoldWriter`，fallback.go:1661-1662）；上游响应头只能经 `keepRetry`（routing.go:1020，白名单在 :1023：`retry-after` 与同时含 `ratelimit`+`reset` 的头）进入。marker 含 `reset` 不含 `ratelimit` → 被丢。`keepRetry` 四个调用点全部同白名单：group turn 的 `attempt`（gateway.go:4487，attempt 以 hw 调用于 gateway.go:2656）、中途断流（continuation.go:506）、translate 直答（gateway.go:5643）、decision group 末错透传（decide_group.go:238）。
4. **天然无病的旁路**（直收 `res.Header`，marker 可达）：count_tokens 估算（gateway.go:1316）、decision group 失败 rest（decide_group.go:80）。这解释了为何手工构造 header 的单测（TestRemoteMagpieKeyLimitRestsTheKey）与旁路路径全绿、而真实中继 429 永远模型级。
5. **产品语义**（#2077 原文 + 维护者评论核读）：v0.1.1233（caa536733/d53a51cd）定案——远端 magpie 的单模型拒答只 rest 单模型；只有「网关 key 自己的超限」才 rest 整个 remote。维护者自己的验收是「两个真实 magpie 网关通过 HTTP 对测」。#2167（ggbdpq 开的 open issue，Sink×remote magpie）的 sink 分支复用同一谓词，同受本缺陷阻断。

**结论**：丢头发生在 `keepRetry` 白名单这一个共享根因点；一行纳入 `remoteKeyLimitHeader` 即修复全部中继面。

## TDD 证据（BASELINE / GREEN 分开，同机并行负载下实测）

测试：`TestRemoteMagpieKeyLimitRestsTheRemote`（追加于 `internal/gateway/remote_magpie_key_limit_test.go`，+76 行）。夹具：假上游按 `keyLimited` 真实体裁回体（glm/glm-5 → 429+marker+`Retry-After: 60`+`rate_limit_error`；kimi/kimi-k3 → 无 marker 普通 429；其他 200），Remote magpie provider `office`，Ordered 组 [office/glm/glm-5, office/kimi/kimi-k3, other/m]。

**BASELINE（消融：`internal/gateway/routing.go` 还原到 d783df46，测试保留）**：

```
$ go test -tags nogui -count=1 -run 'TestRemoteMagpieKeyLimitRestsTheRemote' ./internal/gateway/
--- FAIL: TestRemoteMagpieKeyLimitRestsTheRemote (0.14s)
    remote_magpie_key_limit_test.go:160: the key's own limit there didn't rest the remote whole: map[office/glm/glm-5:2026-10-18 12:57:40.485732 +0800 CST m=+60.145394792 office/kimi/kimi-k3:2026-10-18 12:57:40.486268 +0800 CST m=+60.145930751]
    remote_magpie_key_limit_test.go:163: the key's own limit rested glm alone: {Why:rate Status:429 Until:2026-10-18 12:57:40.485732 +0800 CST m=+60.145394792 By:retry-after Failures:1 Key:office/glm/glm-5 Model:glm/glm-5 Link: agent: user: said: hold:{wall:0 ext:0 loc:<nil>}} map[...]
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.192s
FAIL
EXIT=1
```

`Key:office/glm/glm-5`、`By:retry-after` 逐字证实：marker 在传输层丢失 → rest 落模型级。

**GREEN（复贴一行修复）**：

```
$ go test -tags nogui -count=1 -run 'TestRemoteMagpieKeyLimit' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.047s
EXIT=0
```

**修复 diff**：`internal/gateway/routing.go` 白名单加 `strings.EqualFold(k, remoteKeyLimitHeader)`（+4 行注释，产品改动 1 行）+ 测试 +76 行，共 2 files, +81/-2。

**其余矩阵**：

| 项 | 命令 | 结果 |
| --- | --- | --- |
| -race | `go test -tags nogui -race -count=2 -run 'TestRemoteMagpieKeyLimit|TestRemoteMagpieQuotaRestsTheModel|TestRemoteMagpieRestsTheModel' ./internal/gateway/` | ok，exit 0 |
| 家族定向回归 | `go test -tags nogui -count=1 -run 'TestRemoteMagpie|TestKeyLimit|TestDecide|RetryAfter|ResetsAt|KeepRetry|Continuation' ./internal/gateway/` | ok，4.5s，exit 0 |
| gofmt | 两个改动文件 | 无输出 |
| vet | `go vet ./...`；`GOOS=linux go vet -tags nogui ./...`；`GOOS=windows go vet ./...` | exit 0 ×3 |
| 全量套件 | 未跑（纪律禁全量，同机另有 1 路并行） | UNVERIFIED |

**热路径**：`keepRetry` 只在错误响应路径跑一次（非逐 token），白名单每头多一次 `EqualFold` 常量比较，代价≈0。非 marker 响应行为不变：条件是精确名匹配；marker 不参与时长计算（`retryAfter` 不读它）；不覆盖任何用户自设值（dst 是服务端自建 header）。

## 探针设计过程中发现的一个既有语义（登记不修）

第一版夹具让 kimi 在同轮成功应答，发现 `servedCandidate` → `served` → `clearRest(restKey)`（routing.go:70-82）会把 glm 刚落下的「整 remote rest」清掉——"an answer says it's back" 是既有设计（预算按请求大小预留时，小请求被放行是真实的“回来了”）。因此在裸 main 上，「带配额的兄弟模型仍被问」与修复无关，最终探针改为 kimi 普通 429 使作用域断言存活到断言时刻；「kimi 不再被问」的用户可见效果需 #2167 的 sink（sink 不被成功清除）才能在 ask 层面呈现。这与原件发现的判断一致。

## 分支与产物

- 开发分支：worktree `/private/tmp/magpie-fix-limitreset` @ `rev/d-limitreset`，commit `f4f788baf44b11f8f75f47bc8667380f0a0eb64a`（`git show --stat HEAD` 仅含 2 个本单文件；作者 ggbdpq <ggbdpq@gmail.com>，仓库现有配置未动）。
- fork 推送：`git ls-remote origin` 前置查重（`hunt41-relay-limit-reset` 计数 0）→ `git push origin refs/heads/rev/d-limitreset:refs/heads/hunt41-relay-limit-reset` → 推后 `git ls-remote origin refs/heads/hunt41-relay-limit-reset` = `f4f788ba…`。push 成功无凭据折腾。
- patch 存档：`docs/issues/limitreset-relay-header/0001-gateway-the-other-magpie-s-key-limit-marker-rides-the-relay.patch`（154 行，format-patch 全文）。
- 英文 issue 稿：`docs/issues/limitreset-relay-header/issue.body.md`（标题 + Source/What happens/Reproduction/Root cause and fix + 嵌 patch + Verification 表 + Siblings/When the read fails/Not verified/AI 尾部；引用 #2077/#2167；模型名只在 commit 尾注）。

## 不自信清单

1. **turn-2 outcome 断言两侧相同**（修前修后都 `asked==[]`，因修前 glm/kimi 各有模型级 rest）——判别力全部在 rest 作用域断言（`restOf("office")` / `!restOf("office/glm/glm-5")`）。若维护者要求 ask 层面的行为差异证据，需叠 #2167 sink patch 另测。
2. **marker pass-through 到 agent**：最后成员失败透传与 translate 路径现在会把 marker 带给客户端（与 `X-Magpie-Resets-At` 注释明说的 "carries it, harmlessly" 同类；对下一跳 magpie 是真话，对普通 agent 不可见）。但这是行为面变化；维护者若想在客户端侧 strip 属裁决区。
3. **三跳链归属**：C→B→A 链中 B 透传 A 的 marker 时，C 会把它读作「B 的 key limit」而 rest 整个 B（实际是 A 限了 B 的 key）——over-rest、fail-safe 方向，语义归属不精确；未为此写测试。
4. **假上游非嵌套真网关**：marker 由手工 handler 按 keyLimited 体裁写入；真实两机部署未实测（读码未找到其它头传递路径）。
5. **gateway.go:5643（translate）路径**未单独覆盖测试，靠白名单单点保证。
6. **全量套件未跑**；`keepRetry` 是 gateway 包内私有函数（rg 无跨包消费），但其它包若有钉白名单行为的 guard 测试未在定向 -run 内。
7. 常量依赖：探针的 `Retry-After: 60` ≥ fallbackCooldown 才按 said 生效；已核 `said >= d` 分支（routing.go rateRest），常量若调仍稳。

## 发布建议（动作留给用户）

**建议独立新单，不并入 #2167。** 理由：

1. 缺陷归属清晰：这是 #2077 引入的传输层丢头（d53a51cd 的 header 机制没铺到中继路径），不是 #2167 的 sink 行为议题；独立单让维护者按「#2077 family 的修复」审，五段正文已按此写。
2. 修复对不用 Sink 的用户独立生效（rest 作用域 + weighted 排序把整个 remote 正确沉到池外），价值不依赖 #2167。
3. 依赖方向：#2167 的 sink patch 的 #2077 语义（key-limit 沉整 remote）在线上要先有本单才可达——本单先行合入，#2167 patch rebase 后其 `TestRemoteMagpieKeyLimitSinksTheRemote` 才能转绿；两单分离各自可 revert。
4. 若用户偏好低噪声，退路是作为 #2167 帖内补充评论（嵌 patch + Verification 表，正文已备好可直接贴），但会在一个单里混两种 review 面，且 sink 议题的结论会被传输修复的合入阻塞——不推荐。

分支 `hunt41-relay-limit-reset` @ `f4f788ba` 已在 fork 上，GitHub 已给出 PR 预建链接（未开 PR）。
