# rf-B-5752 验证记录（2026-11-11 深夜，tip=60559ee73）

- 分支 hunt-20261111-rf-5752 @ 457ec3067dc36fabf3f2d1595a3a528875257c32（author=ggbdpq，单提交，保 Reported-by: hanxuanliang）
- patch sha256 前16: 74ba73f6ba9ebf78（--zero-commit，5752.patch）
- 老分支 fix/5752-plugin-renewal-dedupe @ 155f83111（基 7e5cebb86）；语义合并：上游 6e2dcc4a1（11-10，empty→failedRenewal 指数退避）已盖形状1，本提交保留形状2/3（still-due），empty 分支让位上游实现
- RED（tip 纯基线+测试/fixture）: d-keep renewed 3 / d-new 2 / keep-alive {Due:true Renewed:false Waiting:false Err:} / no-new-token 落库 —— TestRenewalStillDueBacksOff FAIL 1.164s
- GREEN（修复后）: TestRenewalStillDueBacksOff PASS（0.24s/-v；ok 1.108s）
- 全量: internal/plugin ok 唯一 --- FAIL: TestHostToldTheGatewayAddress —— tip 基线 detached worktree(/tmp/mg-50B-base@60559ee73) 单跑同红（host_addr_test.go:78 port 3591/3592 时序）= 预存红新条目（不在 11 条名单，归因非我方）
- race: 同唯一红 TestHostToldTheGatewayAddress（292.3s），无新增
- gofmt -l internal/plugin 净; go vet ./internal/plugin 净; GOOS=linux/windows/darwin go build ./internal/plugin OK; node --check host.js OK
- 消融（hunk 级，28 行=3+/25-，语义分叉=still 判定与 held 逻辑）: d-keep 3 / d-new 2 原样红逐字 → 恢复复绿 ok 1.127s
- am 回放: /tmp/mg-50B-base@60559ee73 git am 5752.patch 即进（3108c07afb），树与 rf head 零差异（diff --stat 空），message 一致
- 兄弟面: renewLocked 唯一调用方 renew():3071; unrenewed 消费面 :2910/:2941(renewal 挡板)/:2989(keepSignedIn)/:3082/:3142(本提交 else delete); failedRenewal 既有 :3100(throw)/:3108(6e2dcc4a1 empty) + 本提交 :3127/:3141; changeAuth 8 调用方不受影响; 形状3 hold 挂 next secret 与 renewal() 挡板 f.secret===secretOf(stored) 匹配
- 上游推进: 7e5cebb86..60559ee73 = 543 提交；renewal 域同域提交 6e2dcc4a1/16dcfa504/9430c5309 逐笔读，仅 empty 面，方向仍成立
