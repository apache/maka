# #5876 验证记录（车道 9 / NEW4，2026-11-11）

## base / head
- base: db0f2f20d4dd（2026-11-10 实时 fetch 的 upstream/main，v0.1.3434+）
- head: 0d3b52d2387b26fc01075c1520f9224118fcfb22（作者 ggbdpq <ggbdpq@gmail.com>）
- patch: 0001-gateway-...-400-.patch，sha256[:16]=b0fac19b0d319051，git am 干净树（45-2 detach @db0f2f20d）零冲突成功

## 修前红（TDD）
- TestKimiSpentEmpty400FailsOverAndRests @base：`400 {"error":{"message":"Kimi Code (China): text content is empty"}}; tried [k-spent]`——与报告者形状一致，无 failover 无 rest

## 修后绿
- TestKimiSpentEmpty400FailsOverAndRests：200 failover，`tried [k-spent,k-good]`，rest Why=quota Status=400，次请求 `tried [k-good]`
- 族集 11：TestCreditRefusalIsRetryableAtAnyStatus / TestCredit400MovesToTheNextAccount / TestSub2APIKeyLimitIsQuota / TestKeyOutOfItsWindowRestsUntilReset / TestKeyPoolErrorDoesNotRestForWindow / TestRestingKeyReadAgainInAnOrderedGroup / TestAllRestingAnswersFromRest / TestQuotaHeldOnlyForKeysOutOfAllowance / TestShorterRestDoesNotReplaceLongerOne / TestNamedQuotaTimeReplacesAGuess / TestKimiSpentEmpty400FailsOverAndRests — ok
- 同域大族（Credit|Key|Group|Rest|Quota|Rate|Affinity|Weighted|Fallback|Overflow|Shape|Region|Retired|Model|Kimi|Allowance|Spent|Window|Restricted|Proxy|Refus|Policy|Decision|Cooldown|Backoff|Held|StandIn|Kept）：ok 100.5s
- go vet -tags nogui ./internal/gateway/ 干净

## 消融回红（变异点=语义分叉行）
1. 摘 failure() 新 case → diff --stat 复证（routing.go 无改动）→ 测试红：rest 退化 `Why:other` backoff（failover 仍在）
2. 摘 retryable() 新 case → diff --stat 复证（fallback.go 仅剩词表）→ 测试红：400 直达客户端 `tried [k-spent]`（与修前同形）
3. 还原 → diff --stat 复证全改动（+15/+8/+90 测试）→ 复绿

## 兄弟面 rg 全查
- emptyContentWords 引用点：定义 + failure case + retryable case，无其他读者
- retryable 7 调用点逐一核对：holdWriter.failed（主链）、decideFailed、决策组 replan、codex backend named、draw/video 自身重试（改善向）、refusal_handover（refused 域无交集）
- failure 读点：tooLongUnsaid 提前排除（正向）；failOther+modelRefused 路径修前词也不匹配（不变）；quotaHeld/spentModel/spentAfter/restAfterMarked 走 failQuota 既有链（rest 到窗口重读）
- 200 空回复族（#1221 emptyReply/emptyRetries）不同状态不同路径，无交集；#5692 failWords（200 整条 opt-in，未合入 main，仅 fork 分支 fix/5692-provider-failwords）不越界

## 全包与预存红
- 全包（带修法，-timeout 30m）928.4s：唯二失败 TestClientPathCoversHandler（oneport_test.go:29 /magpie-ca.crt ClientPath false）与 TestReadOnlyKeyEveryRoute（readonly_test.go:115 /magpie-ca.crt 路由表）——**父提交 db0f2f20d 无改动同样红**（已实测），预存环境项，与本修无关域
- 600s 超时对照：父提交同参数同样 600.6s 超时（首跑），包级大是本机现状

## 帖
- https://github.com/yetone/magpie/issues/5876#issuecomment-6773458617（ggbdpq，14447 字节，列表端点回读一致）
