# rf-B-4056 验证记录（2026-11-12，基=e6bf4adf1）

- 分支 hunt-20261111-rf-4056 @ 125977b65d9d632fa（author=ggbdpq，cherry-pick 自 fix/4056-key-protocol-fallback@957287335 干净合入）
- patch sha256 前16: ae54205f78b0c944
- RED（tip 基线+测试）: TestTestAsksOnTheURLsItHas/Test+TestModels 两子红（"no key is on for this endpoint"/"no key that's on sees this model"）+ cli TestProviderKeyProtocolPair/TestProviderShowsKeyProtocol 两红
- GREEN: 四测试全 PASS（provider ok 1.07s/cli ok 1.3s）
- FULL: provider ok 137.8s；cli 4 红（TestHealthcheckFinds.../TestUpdateRestarts.../TestEveryRouteHas.../TestUpdateFindsAMagpie...）——基线单跑同 4 红=预存（环境/时序类）
- RACE: 3 红（PluginCheckin/SignInDone/ModelTest）=已归因互踩型/预存，零新增
- gofmt/vet 净；GOOS=linux(nogui) build OK
- 消融×2：①provider test.go 三尾块（keySeeing/testWith/keyFor 的 ask-whole 循环+return）退基线 return→TestTestAsksOnTheURLsItHas 两子红→恢复绿（注意取反条件消融无效：循环后仍有 return p,true 会把行为变松，必须删循环恢复基线尾）②cli 摘 key.protocol case→两测试红→恢复绿
- am 回放：/tmp/mg-50B-base reset --hard e6bf4adf1（分支实际父基，显式 sha）git am 即进，树零差异
- 兄弟面：ask-whole 形状三函数（keySeeing/testWith/keyFor）同形改（同 #1702 gateway 行为对齐）；detect.go:179 的 "no key is on" 另一处为 detection 面不触
- 教训：am 回放基点必须用分支实际父基显式 sha（upstream 在 cherry-pick 后又推 4 提交，6f3e7662 已过期）
