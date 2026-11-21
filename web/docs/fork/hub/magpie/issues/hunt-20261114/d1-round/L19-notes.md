# L19 车道终笔记（2026-11-14 档1 专注轮）

4 单全处置完毕：1 PATCH-POSTED、3 出列。upstream 开工 tip a8fa771a63 → 终态 830177ae5（期间两次前移，均已过鲜度门/方向鲜度后才动）。

## #4425 Codex 账号导入未真正脱离 ~/.codex/auth.json

- **处置**：出列 + 判定说明帖 [6867882668](https://github.com/yetone/magpie/issues/4425#issuecomment-6867882668)（take 6867879113 → 发帖）。
- **根因定性**：报告者观察到的两件事各是一项**声明过的设计**，不是缺陷：
  1. import 的 "in magpie already … left as it is" no-op：`importLogins` 按 refresh token 去重且 "the agent's own included"（`internal/provider/login_import.go` 的 have map）；三重声明——起源提交 3ba6ff7d2 提交说明明文、导入前确认框文本（accounts_cli.go）、`TestImportCodexLogins` 断言 "the live account is left as it was"（login_import_test.go:68/87）。
  2. 实验二中导入后默认 ~/.codex/auth.json 重新出现：`addLogin` 的 `using = !signedIn || sameLogin(live, l)`（signin.go），agent 无账号时把导入账号写回 agent 签名文件，"so one refresh token stays in one place"——#15 起的设计。sameLogin 按 email+workspace 判同（非 token），故导入账号与本地 Codex 共享 token 是有意行为。
  3. `codex logout` 吊销共享 token → magpie 标 "sign-in has expired"：#4308 修复（fb2e11e28, v0.1.2096）后的正确检测，非缺陷。
- **不 patch 的理由**：解耦需推翻两处声明设计（本地 agent 不再被签入 / take-over 轮换已持有 token），属设计取舍（handbook/10「声明过的设计与有意豁免」家族 → 观察+假设评论交付）；报告者第三建议（文档化）是零行为变更路径，帖内背书。
- **验证**：纯代码审计（读 main a8fa771a63），机制分析标注了 "read from the code, not reproduced at runtime"。帖尾带 Attribution（AI 披露一次）。

## #5628 Codex reset 读失败覆写

- **处置**：出列零帖。双理由：①维护者亲单（author=yetone，2026-11-07，选单正典 2）；②skygunner 已交付 patch（fork 分支 fix/5628-reset-history-preservation，commit dcaea432）在等审——让位不制造同题 patch。
- **核实**：upstream main 尚无 #5628 收编（96f99b760 是其引用的 #5556 修复）。

## #4563 Claude Keychain 写失败仍存 logins.json

- **处置**：出列零帖。**已修已收编**：维护者末评 "Applied as cd0875f5a with ggbdpq as author, in v0.1.2421"（hunt108 轮我方交付）；`git show cd0875f5a` 确认在 upstream/main 且 author=ggbdpq。现行 main 的 addLogin 注释即引用 #4563。维护者亲开后续 #4592（SwitchLogin 同序问题），不追。

## #6391 spare 账号交接后 signed out

- **处置**：PATCH-POSTED [6868238528](https://github.com/yetone/magpie/issues/6391#issuecomment-6868238528)；分支 [hunt-20261114-d1-6391](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-6391) @ f05bac9954bab587e2ab4226a709b6d2a7d56f4c；patch sha256-16 = 853983c6d927ffa1（format-patch --zero-commit）；commit author=ggbdpq + Generated-by 尾注；回读四查（branch link/SHA/AI-written/patch fence）全过。
- **根因**：`takeClaudeDir`（claude_dirs.go）对 tokens 不同的目录签名无条件取入 saved login——"tokens differ ⇒ 目录更新" 只在目录是 Claude Code 正在运行的持有者时成立。#4750 场景（switch 期间目录被重建）+ switch 回只 forget 换入方目录（`forgetClaudeDir(want.User)`）⇒ 换出方陈旧目录残留 ⇒ 下一次 run 把 spent 副本覆写 fresh ⇒ 目录内刷新被拒清空 ⇒ `syncClaudeDir` 见 cleared → `refuseClaudeLogin` → 账号 signed out（502）。
- **修法**：`syncClaudeDir` 加新鲜度守卫——目录签名 expiresAt 严格早于 saved（双方 >0）时不取，返回 has=false，`claudeSavedDir` 既有 has=false 分支重写目录（新增 `clearClaudeDir(dir)` 先清，防 macOS keychain item 遮蔽新文件）；imports 的 newer-wins（claudeNewerKept，#4532）为同族先例。
- **验证**（GOCACHE=/tmp/mg-verify-l19-gocache，-tags nogui）：
  - RED：消融（claude_dirs.go 退父提交 e730a14dc，测试保留）双断言红；基线 a8fa771a63 首证同红；复绿 ok。
  - 全量 `go test ./internal/provider`：唯一红 TestResolveVia——base detached 同样红（`Get "https://gw.invalid…": EOF`，本机 7897 代理家族预存红），归因非本次改动；新测试全量中绿。
  - race（定向+目录/switch 邻族）：ok 2.958s。gofmt/vet 清。GOOS linux/windows/darwin build nogui 全过。
  - rebase 两次跟随 tip（e730a14dc 后 830177ae5 为无关域 Windows WebView2 提交，零同域漂移，方向鲜度过）。
- **兄弟面全查**：takeClaudeDir 单调用方；syncClaudeDir 三调用方逐个核（syncSavedClaude changed=false 不写、claudeSavedDir 即 heal、switchSavedLogin 丢弃 has）；codex 面无同类（codexHeldIn 拒绝式单持有者，无取入覆写路径）；NoteClaudeSignInFailure 是 version 门控拒绝（不同面，不动）。
- **Not verified（帖内已如实列）**：真实双账号 gateway 交接现场（Debian + Claude Code 2.1.322）；真实 macOS keychain 遮蔽路径（测试 keychain 关闭，clearClaudeDir 为既有函数）；expiresAt 相等但 token 不同的目录保持现行取入行为（保守未改）。

## 不自信的点

1. #4425 判定帖对报告者实验二机制的复述（auth.json 重现 = addLogin using 语义）是纯代码推演，未运行复现；帖内已标注。若维护者实际还有别的写回路径（如 ShowAccount/switch 分支），我的机理归因可能不全。
2. #6391 修法中 expiresAt 相等但 token 不同的窗口（同毫秒刷新？现实中 expiresAt 为毫秒且刷新必后移，理论可能极窄）按保守放行现行取入；若维护者希望更严，可再收紧。
3. #6391 的 clearClaudeDir 放在 has=false 分支对「目录在但签名文件缺失」场景也会跑一次 keychain delete（无 item 时为无害 no-op）——未为此场景单写测试。
4. #5628 未逐行审 skygunner 的 patch 质量（只确认存在与让位）；若其 patch 被驳回，该单仍值得做但属维护者亲单，接法需主线程裁定。

## 未跑项清单

- 全部 4 单：真实账号端到端（ChatGPT/Claude OAuth 真实刷新/吊销）。
- #4425/#5628/#4563：零代码改动，无测试跑项。
- #6391：GUI 测试未跑（改动不触 GUI 面）；-race 全量未跑（按相称只对定向+邻族跑 race）；TestResolveVia 的本机代理环境根因未深究（base 同红，预存红不追）。
