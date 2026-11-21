# hunt108-D #4278 rebase 记录（2026-10-31）

- 起点 54738a1b → rebase origin/main 7b09d2c95 → 8bd9396d1 → amend（尾注 FlashX+清理 # Conflicts 块）→ 645e80ab
- 冲突文件：internal/usage/ledger.go（session_price_test.go 自动合并）
- 判定：fddd7ff08(#2278) gatewayMatchesDetails 位集=正交；9e73f69af(#2463) Pricer 内 BasePriceIn/windows/atWindow=收窄（未实现 SessionProvider 兜底）；7b09d2c95 ledgerMatched Wires()=正交
- 解法：保我方 4 元 memo 键+UnknownProvider 兜底+pr==nil 才 Missing()；叠上游 windows/atWindow；fallback 命中时 ws=nil（BasePriceIn !ok 仍返回我方 provider 的 RateWindows，防串窗）
- 矩阵：定向 7 绿；整包除 2 个基线同红（TestCodexModelEffortLetsUnrelatedCallsGo / TestDesktopSessionAccountMetadata，纯 7b09d2c95 复现，本机 Windows 既有）；gofmt 净；vet×3 绿；build×3 绿；消融回红（fallback 破坏→红；回退 ledger.go→红 "the named route stayed unpriced"）
- 推送：force-with-lease 两段（54738a1b→8bd9396d1→645e80ab），ls-remote 终验 645e80ab
- 帖：issuecomment-6540594982，回读核验通过；patch SHA-256 前16=9f6294598938d87d
- 备注：上游 main 在作业期间两次前进（841326709→7b09d2c95→cae01311c）；7b09d2c95..cae01311c 零触及 ledger.go（sessions 解析/agent 文案），按门槛未追新 main
