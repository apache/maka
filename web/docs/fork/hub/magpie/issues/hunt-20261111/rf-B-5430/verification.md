# rf-B-5430 验证记录（2026-11-12，基 4b29709e→补追平 6a3f162f0）

- 分支 hunt-20261111-rf-5430 @ f46c7380dfc1527e（author=ggbdpq；cherry-pick 自 fix/5430-desktop-picked-lock-scope@05c4b7e0b 干净合入，patch 字节 rebase 前后一致 62cdbf38db23be33）
- RED（tip 基线+测试）: TestDesktopPickedLockKeepsCatalogWorkOut 红（10 并发 titles 634ms=catalog 工作仍持 desktopPicked 锁）；TestClaudeScienceTurn 保护性绿（protective-only）
- GREEN: 两测试 ok 1.2s
- FULL: gateway 全量 -timeout 25m ok 936.8s 零失败零 panic
- RACE: 域内测试×2 ok 14.7s
- gofmt/vet 净；am 回放（新基 6a3f162f0^）树零差异 author=ggbdpq
- 消融：反向 apply 产品 hunks（desktop.go+science.go 锁收窄退父，保测试）→TestDesktopPickedLock 红→恢复绿
- 兄弟面：desktopPicked 消费=desktop.go:551-557(loadPicked 锁内)/:632(desktopMoveTo)；sciencePicked=science.go:110-136 全在 patch 内；调用方各唯一（gateway.go:2537/desktop.go:603）
