# rf-B-5793 验证记录（2026-11-12，tip=12610cf2f）

- 分支 hunt-20261111-rf-5793 @ e95106ec7dbb9805b2b0e57acccaf81d96188362（author=ggbdpq，cherry-pick 自 fix/5793-decide-blocks-first-fetch@7c347da73 干净合入）
- patch sha256 前16: a5df8f05c1ac75a6（--zero-commit）
- RED（tip 基线+测试+fixture）: TestPluginDecideFetchAsksTheListFirst / TestLeavesNoDecideRowWithoutModels / TestFetchBeforeItsFirstList 三红（"HMind's plugin lists no decision models"）
- GREEN: rf head 三测试 PASS（ok 1.771s）
- FULL: provider 全量零失败（上游 7e8214d60/1751eeaf1 已修四红；基线 12610cf2f 单跑同绿）
- gofmt/vet 净；GOOS=linux/windows build OK
- 消融×2（hunk 级）：①fetchList 两分支换序→FetchAsksTheListFirst+FetchBeforeItsFirstList 红→恢复绿 ②Test 摘 plugin 三段→TestLeavesNoDecideRowWithoutModels+FetchBeforeItsFirstList 红→恢复绿
- am 回放：/tmp/mg-50B-base reset --hard 12610cf2f（显式 sha）git am 即进，树零差异
- 兄弟面：DecideOnly() 判定未改（60+ 调用点语义不变）；fetchList/Test 顺序变化仅命中 Account.fetch 存在且 DecideOnly 的形状=plugin 首列表前（非 plugin 两标志不同时在场，patch 注释论证）；decideModels() 既有方法 decide.go:434；TestAs(test_as.go:80)/modelkind(models.go:34)/video/draw 等面不触 fetchList/Test 内部
