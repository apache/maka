# #2167 复查报告（rev/a-gw 路，2026-10-18）

审计基线：upstream/main `d783df46`。patch 来自 issue 正文 `<details>`（git am 格式，基 `4faa9313`），无独立 fork 分支（当时 L4 直接发帖+内嵌 patch）。

## ① 现状复核：缺陷仍在

- 当前 main `restAfterMarked` 的 failRate 分支（routing.go）原样：`if c.full(now).IsZero() && !(c.isOpenRouterFree() && sharedPool) { sink(c.restKey(), now) }`——remote 上一模型 429 仍按 `restKey`（整个 remote）沉底。
- `git log -E --grep '#2167' upstream/main` 零命中；无同题 PR。
- 该区域活跃：b14784c0（10-17/18，roomy 改造）动了 fallback 排序但不碰 sink；sink.go 上次实质改动仍是 caa536733/d53a51cd（10-14）。

## ② ③ 落树与消融（d783df46 全新跑）

issue 正文 patch 提取后 `git apply --check` → **APPLIES-CLEAN**（无 rebase 需求）。patch 复用 main 已有的 `remoteModelRest` 谓词（rest 作用域同款），#2077 的 key-limit 例外（`remoteKeyLimitHeader` 在场 → 沉 restKey）保持。

**BASELINE（带修复）**：
```
$ GOTOOLCHAIN=auto go test -tags nogui -count=1 -run 'TestRemoteMagpieRateLimitSinksTheModel' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.581s   # EXIT=0
$ ... -count=3 -race ...（同测试）
ok  	github.com/yetone/magpie/internal/gateway	2.245s   # EXIT=0
```
**ABLATION（只拆 routing.go + sink.go，测试保留）**：
```
--- FAIL: TestRemoteMagpieRateLimitSinksTheModel (0.91s)
    remote_magpie_rest_test.go:135: the group: 200 {...from ko...}; the remote was asked [], other [ko]
```
**家族回归**（`-run 'TestRemoteMagpie|Sink|Sunk|Test.*RestsTheKey|KeyLimit'`）：带修复 + 移除下述新发现测试后 ok（3.021s）；gofmt 三文件空。patch 已存 `2167-applies-onto-d783df46.patch`。

## ④ 对抗攻击 + 新发现（重大）

- **裁决区**：sink 随 429 沉整个 remote 是否维护者故意？不是——caa536733（维护者自己合的）已把 rest 收窄到模型且明确覆盖 failRate；sink 漏改是同一裁决的执行遗漏。patch 与 #2077（key-limit 沉整 remote 是**故意**保留）的界线用同一谓词划开，方向与维护者自己的轨迹一致。
- **5 条 P3 自评吸收评估**（档案：quality-20261017/original/编年全录 10-14 晚条目）：
  - P3-1 `From <commit>` 占位符 / P3-2 subject 缺 `(#2167)` / P3-3 正文 50929661 与 4faa9313 哈希不一致——**吸收**（重发时顺手改，零风险）。
  - P3-4 sunkAt "先 restID 后 restKey" 与全仓 rest 查找惯例相反——**保留**（可辩护的设计取舍，patch 注释已写明理由，改了会变行为）。
  - P3-5 "#2077 的 sink 整 remote 分支缺端到端钉子"——**评估中升级为新发现**，见下。
- **新发现（登记不发，详证见 `2167-finding-keylimit-header-lost-in-relay.md`）**：为 P3-5 写端到端钉子（假上游 429 带 `X-Magpie-Limit-Reset`）时实测**该头到不了 `restAfterMarked`**——attempt 失败路径只经 `keepRetry`（gateway.go:4487 → routing.go:1030）复制 `retry-after`/`ratelimit*reset` 白名单头，`hw.header` 里永远没有 `X-Magpie-Limit-Reset`。stderr 探针逐字输出：`DEBUG restAfterMarked why=rate remoteMR=true restKey="office" restID="office/glm/glm-5" chosen="office/glm/glm-5" hdr=`。**后果**：d53a51cd 的"key-limit 沉/rest 整 remote"（#2077）在 relay 线上不可达（同单元测试只钉布尔、e2e 只测模型路径的盲区）；#2167 patch 的 key-limit sink 分支同样按线不触发（行为等价于现状：全部按模型级沉——不算回归，但 patch 里那条分支在传输修复前是死支）。修法一行（keepRetry 白名单加该头）+钉子测试已存档，属 #2077 面，应另开单而非并入 #2167。

## ⑥ Verdict：IMPROVE

产品 diff 本身站得住（消融红/绿、race 绿、家族绿、方向与维护者自己的 caa53673 一致），但 4 天无回合且已发现传输层同族缺陷。**下一步最小动作**：以 d783df46 为基重发 patch（吸收 P3-1/2/3：真实 From SHA、subject 带 `(#2167)`、正文双基线说明），附下方英文稿；新发现单独成单待用户授权后另发。

## 不自信清单

1. 传输层发现基于手工假上游+读码推断，未用嵌套真网关实测（#2077 的 e2e 夹具可复用，留给新单验证）；gateway.go:1316 `s.restAfter(c, res.StatusCode, res.Header, b)` 直收原始头的路径未逐点排查其调用方是否覆盖部分场景。
2. patch 的 key-limit sink 分支按线不可达——若维护者据此问"这条分支有什么用"，需要拿传输层新单回答，本单内答不出。
3. 重发需用户在自己 fork 上重建提交（我未 commit），From SHA/分支链接由用户推送后回填。
4. 「维护者无回=不反对」是假设；该区域 10-17/18 仍在动，可能他在等 sink 附近的重构尘埃落定。

## 英文稿（重发 patch 时附）

```markdown
Refreshed onto today's `main` (`d783df46`): `git apply` clean, same
product diff — the sink keeps the scope the rest already has
(`remoteModelRest`), and the key's own limit still sinks the remote
whole. This issue's patch now says so properly: a real `From` commit,
`(#2167)` in the subject, and the prose names both bases it was
verified on (`4faa9313` and `d783df46`; the touched files are
byte-identical across them).

Re-verified on `d783df46`:
- `TestRemoteMagpieRateLimitSinksTheModel`, with `routing.go` and
  `sink.go` reverted and the test kept: red — `the remote was asked
  [], other [ko]`. With the fix: green. `-race -count=3`: ok.
- `TestRemoteMagpie*`, the Sink and Sunk tests, and #2077's
  `TestRemoteMagpieKeyLimitRestsTheKey`: ok together.
- `gofmt -l` clean.

Patch below / branch on the fork. <内嵌 format-patch>
```

可选加段（把新发现当问题抛给维护者，用户定夺是否发）：
```markdown
One thing I noticed while re-verifying: a remote's key-limit 429
carries `X-Magpie-Limit-Reset`, but that header doesn't reach
`restAfterMarked` — `keepRetry` copies only `Retry-After` and the
`ratelimit…reset` headers into the held writer's header, so
`remoteModelRest` reads no header there and a key-limit refusal rests
(and, with this patch, sinks) as the model's. #2077's unit test builds
the header by hand, so it can't see the loss. Should
`X-Magpie-Limit-Reset` ride `keepRetry`'s allowlist? Happy to file it
separately.
```
