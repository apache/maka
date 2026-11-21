# #5932 验证与消融日志（2026-11-10，车道 3，base=b96847c3d9f）

## 修前红（生产代码未动）
命令：GOCACHE=/tmp/mg-verify-34-gocache go test -tags nogui -count=1 -run 'TestAzureResourceMismatch' ./internal/gateway -timeout 5m
结果：FAIL
- stored_history=false：client 400, relay calls 1, spare calls 0（与报告者回归描述一致）
- stored_history=true：client 400, relay calls 3（首turn+原始+修复重问）, spare 0
- TestAzureResourceMismatchLeavesOtherBadRequestsAlone（负对照）通过

## 修后绿
同命令（生产含 prevForeign case）：ok  github.com/yetone/magpie/internal/gateway

## 实名测试（报告者清单，现行名）
命令：go test -tags nogui -count=1 -run 'TestAzureResourceMismatch|TestPreviousResponse|TestUnknownPreviousResponse|TestNoFallbackForOtherErrors|TestRestCapOr|TestRestCapOff|TestOneRequestDoesNotClimbTheBackoff' ./internal/gateway -timeout 10m -v
结果：14 项全 PASS（TestAzureResourceMismatch 2 项、TestOneRequestDoesNotClimbTheBackoff、TestNoFallbackForOtherErrors、TestPreviousResponse* 7 项、TestUnknownPreviousResponseRelayedAsSent、TestRestCapOr、TestRestCapOff）
-race 复跑：ok

## 消融回红
变异：git checkout -- internal/gateway/fallback.go（该文件唯一生产 hunk=prevForeign case；摘除后 build 通过，diff --stat 复证仅 docs 有 diff）
复跑 FailOverAndRests：双子用例语义红（client 400, spare 0），与修前红同形
还原（备份拷回，fallback.go +6 恢复）→ 复绿（git diff --stat 复证）

## 预存红对照（父提交=b96847c3d9f 同基线）
- TestMothX（internal/agent）：FAIL（预存红确认）
- TestProxyCheckSaysAProxyPassedBy（internal/gui）：FAIL（预存红确认）
- TestLaneLimitRoutes（internal/gui，-tags nogui）：本机此处 PASS（如实记录，非本机红项）

## am 即进
git format-patch -1 --zero-commit → 0001-gateway-a-relay-s-Azure-resource-mismatch-400-fails-.patch
干净检出树（另一 worktree @ b96847c3d9f）git am：零冲突，Applying: … 成功
shasum -a 256 前 16：fe2692fec35dfffd

## push
git push origin d5376482be5f8060799ac9f361865d86f75ae622:refs/heads/fix/5932-azure-400-rest --force-with-lease=fix/5932-azure-400-rest:<ls-remote 实时值(空=新分支)>
结果：* [new branch]  d5376482be… -> fix/5932-azure-400-rest

## 发帖与回读
gh issue comment 5932 -F body-5932.md → id 6771000093（15:10:58Z）
列表端点 --paginate 回读：len 6390、head/tail 逐字节比对一致（仅尾空行归一化差异）；单评端点复核 user.login=ggbdpq
