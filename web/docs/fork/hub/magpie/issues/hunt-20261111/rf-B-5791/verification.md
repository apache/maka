# rf-B-5791 验证记录（2026-11-12 凌晨，tip=fe20e4dbd）

- 分支 hunt-20261111-rf-5791 @ f48769f39728c470725f04691c5562a49fab490e（author=ggbdpq，单提交 cherry-pick 自 fix/5791-partial-expiry-window@1365dc813，基 7e5cebb86）
- patch sha256 前16: b0ba8f7b7b4e3728（--zero-commit；af3334533→fe20e4dbd 两次 rebase patch 字节一致=零同域自证）
- 上游 routing.go 同域 2 提交（72e804d2b Never fallback / e4197144a regexp perf）均不触及 renewing() RunsOut 覆写行；收编 grep 5791/部分过期关键词零命中
- RED: /tmp/mg-50B-base@fe20e4dbd + 测试文件 → TestPartialExpiryKeepsTheReset FAIL（got 2026-11-12T14:08 want 2026-12-10T00:08——部分过期 14h 拉早月窗）
- GREEN: rf head 定向 TestPartialExpiryKeepsTheReset+TestWorkBuddyCreditsRunOutForRouting ok 1.175s
- FULL: 3 失败 TestAddSameKeyOtherFormat/TestQuotaSpanCarriesEveryWindowField/TestKeptQuotaReportAsksNobody —— fe20e4dbd 基线同红（后两个=预存红名单第9-10条；AddSameKeyOtherFormat 新形态预存）；race 另 3 失败中 TestSignInDoneOnceTheAccountIsBack 基线 race 单跑同红，TestPluginCheckinAsksAgainAtUntil/TestModelTestAsksTheAccountThatServesIt 单跑绿=race 全量互踩时序红（域无关）
- gofmt/vet 净；GOOS=linux/windows build OK
- 消融（hunk 级）：routing.go:597 摘 && l.lapsingAll() → RED → 恢复 → ok 1.193s
- am 回放：/tmp/mg-50B-base reset --hard fe20e4dbd（显式 sha）git am 即进（author=ggbdpq），树与 rf head 零差异
- 兄弟面：renewing() 两消费面 Renewal(:572 Smart 排序=本单面)/Unreached(:629 预算窗套层比较，共享改动同受益)；Lapse(:670)/expiring pace(:764) 读 RunsOut 原始值=展示语义有意不改；Full/Left 不涉 RunsOut
- 流程教训（本单实证）：am 回放基点必须显式 sha 锚定——checkout --detach upstream/main 期间他车道 fetch 把 ref 移到 fe20e4dbd 致第一次回放基点错位（sessions 域 11 文件差异暴露）
