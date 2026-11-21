# t1-L3-5205（2026-11-12）

处置：ENDORSED（核验背书 SkyJiashu cc1cb76，报告者自带 fix ×2、yetone 零表态、打包 DLL 属维护者设计权，不制造同题 patch）。
- take: 6822399401；背书帖: 6822483034（GET 回读字节一致，仅 jq 尾换行）
- 分支: hunt-20261112-t1-5205 @ 929c479e5fb96514（基 ab98228cc，cherry-pick 后 rebase，author=SkyJiashu 保留，committer=ggbdpq）
- patch sha256[:16]=ef76ec315fb6ff55；am 回放 ab98228cc 树一致 e1dab4d948ea3075
- 验证：GOOS=windows build+vet 净；linux/darwin build 净；claudetui darwin 测试 ok 125.803s（文件 windows 专属，构造性同基线）；gofmt 净
- 同域漂移：2d5d1c1d2..ab98228cc 对 child_windows.go 零提交
- 排雷：无 open PR（5205/conpty 双查）；upstream log grep 5205 零命中；收编三查净（conpty 域仅原始引入 c59c547c5）
- 3leg0ocat 打包变体已审（tag v0.1.3357-lite：-tags liteconpty embed+版本化解包+fail-closed）；帖内给 A/B 设计决策表留 yetone 拍板
- NOT-RUNNABLE：Windows 10 真机（darwin 宿主）；RED=帖内两名 Windows 10 用户实测数据（19044/19045）
- 不自信点：HRESULT→Errno 包装的错误文案劣化未实测（值保留）；NewLazyDLL 相对路径解析依赖 DLL 搜索顺序（SetDllDirectory 未调，conpty.dll 同目录 OpenConsole.exe 启动是否稳定未真机验证——报告者真机数据覆盖了该路径）
