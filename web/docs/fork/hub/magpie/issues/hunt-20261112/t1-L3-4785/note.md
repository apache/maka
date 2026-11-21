# t1-L3-4785（2026-11-12）

处置：ENDORSED（核验背书 Dopetaiga 7648493c8 = laweit-lxy 正文修法的实现；报告者自带 fix 形态，不制造同题 patch）。
- take: 6822606473；背书帖: 6824126485（GET 回读一致，仅 jq 尾换行）
- 分支: hunt-20261112-t1-4785 @ d349bc957ab14aaa（基 d0a4e0be6，author=Dopetaiga 保留）
- patch sha256[:16]=371fc9c249e9f450；am 回放 d0a4e0be6 树一致 e72a9d76d52fc286
- 验证：GOOS=windows build+vet 净；GOOS=linux nogui build 净；定向 catalog 族 darwin ok 3.416s；agent 包全量 239.706s 唯一红 TestMothX=预存红（父 7199afbb6 detached 单跑同红实证）；gofmt 净
- 排雷：grep 4785 唯一命中 2b22425b4=测试失败归因非收编（维护者自己的 Win11 测试机也见 #4785 失败=活证据）；ownCatalog 现状与 8f804396fd 逐字一致未修
- 兄弟面：deskCatalog 同形状但 10-27 出生即 base-name 约定、无存量 /-拼写桌面配置=非活缺口，帖内写明不改理由；mark.go Contains("magpie") 拼写无关；7 个 ownCatalog 调用点单点覆盖
- NOT-RUNNABLE：Windows 真机（RED=thread 双机实测 ARM64 8f804396fd + x64 3e319622）；darwin 构造性无法见红（ToSlash==native）
- 不自信点：非 Windows 面绝对路径分支的等价性论证是读码推断（读不到匹配路径的论据依赖 native==原文），未跑非 Windows 矩阵对照；deskCatalog「无存量」论据基于提交时序推断，未穷举 git 历史里所有桌面路径写入点
