# limitreset 中继丢 marker 单：发布前 Watched 审计与发布记录

日期：2026-10-18。执行者：P5（GLM-5.3-Flash via ZCode）。对象：新 issue 发布（#2077/#2167 家族的传输层修复单）。
环境：worktree `/private/tmp/magpie-fix-limitreset` @ `rev/d-limitreset` = fork `hunt41-relay-limit-reset` @ `f4f788ba`（开工与 push 前各经 `ls-remote` 确认一致，干净）。

## 结论先行

**三查全过（第 2 查经两处补齐），已发布 [yetone/magpie#2791](https://github.com/yetone/magpie/issues/2791)**。补齐均为稿件校正与补测，**产品代码零改动、零追加 commit**（fork 分支仍是 `f4f788ba`）。

## 第一步：Watched 三查审计

### 查 1：Red before green —— 过

亲自复跑消融（非引用报告旧数）：`git checkout d783df46 -- internal/gateway/routing.go`（产品行还原 main，测试保留），跑定向测试：

```
$ go test -tags nogui -count=1 -run TestRemoteMagpieKeyLimitRestsTheRemote ./internal/gateway/
--- FAIL: TestRemoteMagpieKeyLimitRestsTheRemote (0.14s)
    remote_magpie_key_limit_test.go:160: the key's own limit there didn't rest the remote whole: map[office/glm/glm-5:2026-10-18 13:09:35.793495 +0800 CST m=+60.142980626 office/kimi/kimi-k3:2026-10-18 13:09:35.794074 +0800 CST m=+60.143560335]
    remote_magpie_key_limit_test.go:163: the key's own limit rested glm alone: {Why:rate Status:429 Until:2026-10-18 13:09:35.793495 +0800 CST m=+60.142980626 By:retry-after Failures:1 Key:office/glm/glm-5 Model:glm/glm-5 Link: agent: user: said: hold:{wall:0 ext:0 loc:<nil>}} map[office/glm/glm-5:… office/kimi/kimi-k3:…]
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.176s
FAIL
EXIT=1
```

失败即本缺陷症状（rest 落 `office/glm/glm-5`+`office/kimi/kimi-k3` 模型级；`By:retry-after` 证明 marker 传输层丢失），非编译错、非其它失败。恢复修复（`git checkout HEAD --`）后：

```
$ go test -tags nogui -count=1 -run TestRemoteMagpieKeyLimitRestsTheRemote ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.045s
EXIT=0
```

（输出头部的 `_encode/_decode: command not found` 为本机 shell profile 噪声，与测试无关。消融前后 worktree 均经 `status --porcelain` 确认干净。）

### 查 2：Siblings —— 过（经两处补齐，均为稿件/补测，非代码）

**补齐 A（计数错误）**：稿件原写 `keepRetry` 四个调用点；`rg keepRetry` 实为 **六个**：`gateway.go:4487`（group turn attempt，经 `gateway.go:2656` 以 holdWriter 调用）、`continuation.go:506`（断流）、`search.go:1072`（askTranslated，translate 轮）、`gateway.go:5643`（translate 非流错误）、`gateway.go:1321`（count_tokens 错误分支）、`decide_group.go:238`（decision group 末错）。六个点全走同一白名单（`routing.go:1023`），单行修复全覆盖——**无需补码**；稿件四→六已校正（What happens 与 Siblings 两段）。

**无第五漏网点的实证链**：
- rest 作用域读点：`restAfterMarked`/`restAfter` 读 `hw.header` 的仅 `gateway.go:3148, 3258, 3273, 3353, 3386`；`newHoldWriter`（`fallback.go:1661-1662`）起始空 `http.Header{}`，其上游头**唯一来源是 `keepRetry`**（其余写入均为 magpie 自有注记 `note`：resetsHeader/refusedHeader 等）。
- 直收上游头的 rest 点全部无病：count_tokens 429（`gateway.go:1316`）、decision group 失败 rest（`decide_group.go:80`，实参来自 `postDecide` 返回的 `res.Header`，`decide.go:480`，调用点 `decide_group.go:213/308`）；forward 错误与不可达分支传 nil 头（`gateway.go:1301`、`decide_group.go:182/312`），marker 不可能存在。
- 整头拷贝旁路四处定性：`asBadGateway`（`notapi.go:91`）与 codex 掉线 503（`codex_dropped.go:78`）是克隆上游头进合成响应再走正常管线（头保留，不丢）；`codex_search.go:175` 与 `codex_backend.go:1074` 是非 rest 通路（后者仅成功响应走拷贝，错误分支提前 return）。
- `rg 'restAfter\(|restAfterMarked\('` 全仓：无 `internal/gateway` 之外的调用。
- `rg 'remoteKeyLimitHeader'`：一写（`key_limit.go:64`）一存在性读（`routing.go:940`）。

**补齐 B（验证矩阵缺口）**：直钉 `keepRetry` 的既有测试（`quota_rest_test.go`、`written_reset_test.go`、`rate_backoff_test.go` 共 7 个：TestQuotaRestsUntilItsReset、TestResetsWritten、TestWrittenResetRestsUntilThen、TestRateLimitBelievesItsReset、TestRateLimitBacksOffWhenItComesBack、TestPluginWrittenResetRests、TestFailureReadsEscapedWords）**无一落在原 family -run 模式内**（`KeepRetry`/`ResetsAt` 等子串匹配不到这些名字）。已补跑：

```
$ go test -tags nogui -count=1 -run 'TestQuotaRestsUntilItsReset|TestResetsWritten|TestWrittenResetRestsUntilThen|TestRateLimitBelievesItsReset|TestRateLimitBacksOffWhenItComesBack|TestPluginWrittenResetRests|TestFailureReadsEscapedWords' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.071s
EXIT=0
```

随后按加宽模式整体复跑：`-run 'TestRemoteMagpie|TestKeyLimit|TestDecide|RetryAfter|ResetsAt|KeepRetry|Continuation|TestQuotaRests|WrittenReset|TestRateLimit|TestFailureReads'` → ok（136 tests/subtests，EXIT=0）。稿件的 Family 行已改为加宽模式并写明结果。

另：commit message 内的 Run 列表保留提交当时的历史记录不动（改它需 force-push，纪律禁止）；issue 的 Verification 表是现行完整矩阵。

### 查 3：Failed read 语义 —— 过（登记进稿件，无 unsafe，不扩修）

消费端**只查 marker 存在性、从不解析其值**：`remoteModelRest`（`routing.go:939-940`）唯一判据 `header.Get(remoteKeyLimitHeader) != ""`。逐一：
- 值为空 → `Get` 返回 `""` → 视同无 marker → 单模型 rest（与今日行为一致，fail-narrow）。
- 值为乱码/非法时间戳 → 仍算 present → rest 作用域落整 remote；**无 panic 路径**（全仓无对该值的 `time.Parse`），且**不影响时长**：`retryAfter`（routing.go:1067 起）只读 `Retry-After` 与同时含 `ratelimit`+`reset` 的头名（marker 名不含 ratelimit，不匹配）；`resetsNoted` 只读 `X-Magpie-Resets-At` 且解析失败返 0。
- 伪造 marker 使 rest 变宽 = #2077 规则本来就有的「信对端 magpie 自述」信任面，本修复未扩大它。

已写进稿件 **When the read fails** 段（空值/乱码值语义、scope-vs-duration、无 panic），未顺手加任何代码。

### 查 4：五个曾犯错误逐条规避对照

1. **①测试在旧代码上也过** → 对立面成立：今日独立消融，还原产品行后新测试 exit 1 且断言输出逐字是本缺陷症状（`By:retry-after`、rest 落模型级），恢复后 exit 0（证据见查 1）。
2. **②只改四处、兄弟点漏网且无测试** → 全集 grep 到六个中继点并逐一读点定性（不是只改的那一处）；全部由共享白名单单点覆盖；rest 读点唯一上游来源实证；四个整头拷贝旁路排除；并抓出并补上「钉 keepRetry 的 7 个既有测试不在 family 模式内」这个验证缺口（补跑全绿后才发布）。
3. **③只修 StepCode、兄弟后来才跟** → 修复落在共享根因（白名单单点）而非某一个站点；六个中继点 + 直收旁路 + nil 头路径在本次交付内一次性核清，不存在「其它 decider/route 后来才跟」的尾巴。
4. **④读不了的输入旁置但仍当有效读** → 对立面成立：failed read 语义（空值/乱码值）已定位（presence-only、无 panic、不影响时长）并明写进稿件边界段，不是静默忽略。
5. **⑤来自 wip and unverified 分支** → 对立面成立：分支已推 fork（`hunt41-relay-limit-reset` @ `f4f788ba`，审计开工与全程 `ls-remote` 核对），commit message 带完整 Run 清单与尾注，无任何 wip/unverified 标记；本次消融为第三方可复现的红绿证据。

## 第二步：发布前三查

1. **upstream 变更**：`git fetch upstream main` 后 `git log --oneline d783df46..upstream/main` **零输出**——上游未动，`keepRetry` 白名单与 X-Magpie-Limit-Reset 处理均未被自修。稿件内 "Patch (against d783df46, current upstream/main)" 仍为真。
2. **查重**：`gh api "search/issues?q=repo:yetone/magpie+X-Magpie-Limit-Reset"`（28 命中均为家族/相邻议题正文提及）与 `gh issue list -R yetone/magpie --state all --search "limit reset"`、`--search "remote magpie rest"`：无同题在案。相关的只有 #2077（open，家族父）与 #2167（open，本账号 Sink 单）——稿件已按家族引用。
3. **#2167 现状**：comments 共 2 条，均为本账号（10-17T04:17Z finding、10-18T04:25Z 报告），维护者零回合、零 label/timeline 事件；依赖前提未变。（注：10-18 那条是此前已授权发的 finding 报告评论，非本次新增。）

## 第三步：发布与回读

- 稿件校正四处：①四→六个 keepRetry 调用点（What happens + Siblings）；②Family 行加宽至含钉点测试并写明 136 tests/subtests（Race/Family 行内 `\|` 转义保证表格渲染）；③When the read fails 补 marker 空值/乱码值语义；④"beside the rest" 的 pass-through 面补 count_tokens 错误分支。
- 发布：正文临时文件 `/tmp/limitreset-issue-body.md`（稿件去 H1 标题行，16099 字节），`gh issue create -R yetone/magpie --title "gateway: a remote magpie's key-limit marker never reaches the rest on the group fallback path" --body-file …` → **https://github.com/yetone/magpie/issues/2791**（2026-10-18T05:15:28Z）。
- 回读核验：`gh api repos/yetone/magpie/issues/2791` → `state=open`、title 逐字一致、body 16050 字符、`<details>` 第 37/200 行配对、`\|` 转义在位（表格完整）、首尾无乱码、AI 尾部为承诺句（模型名只在 commit 尾注）、comments=0。回读副本 `/tmp/limitreset-issue-readback.md`。
- 本次新增临时文件仅上述两个 `/tmp` 文件，未清理（不在授权清单内，留待自然过期）。

## 纪律核对

未 force-push、未追加 commit（fork 分支仍是 `f4f788ba`）、未编辑/删除既有评论、未评论/关闭既有 issue、未开第二个 issue、未跑全量套件（定向为主）、令牌未落盘未回显。中间发现的接口报错一次（`gh api --paginate -q '.[-2][].created_at'` 解析错）改用非 paginate 精确查询解决，不影响结论。
