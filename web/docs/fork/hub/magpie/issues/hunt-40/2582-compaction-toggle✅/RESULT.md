# #2582 排查与修复记录（2026-10-17）

状态：**ump45nose 已先发 patch（`d6a68918`，10-16）——撞单让位，不重复交付**。10-17 已发 review 评论（[6232118372](https://github.com/yetone/magpie/issues/2582#issuecomment-6232118372)）：根因独立确认 + 五测碰撞矩阵 + compact 端点 502 形状缺陷实证 + canary 前提冲击。我方等价实现留档 `fix.diff` 作备份。pr1 树已回干净基线（cb05dc2d）。

## 背景（与 #2642 的关系）

- #2642 报告者的最新数据点（v0.1.1279 仍报错）：**预期内**——两个在途修复（行为面 `e1646488`、诊断面 `4e5b0c93`）都未合入 main，1279 不含。其"切换路由到 B"若经 Names & levels 硬排除或停用账号，属设计内 400（诊断面 patch 会点名具体原因）；若属清单过期，行为面 patch 会修。
- Dony2050 在 #2642 评论区指出互补单 **#2582：开关关着也走原生压缩并生成 checkpoint → 意外绑定**——"长对话无法自由切账号"的根因面，无人认领（0 评论、无 PR，已查重）。本轮接的就是这一单。

## 根因（cb05dc2d 实读）

`internal/gateway/codex_backend.go` 的 `codexBackend`：带 `/` 的 magpie 模型走 `codexInputAs(body, true, s.nativeCompactionFor(model))`（开关关→`codexCompact` 便携摘要）；**裸模型**（ChatGPT 后端模型在 Codex picker 即裸名）走 `codexInput(body, false)` 一律保留 trigger，经 `codexAccounts` 进池后 trigger 原样到 serveAgent → 后端原生压实 → `wroteCheckpoint` 记写者（gateway.go:2294 只挂 `compactionTriggerIn` watch）→ 绑定。`/responses/compact` 裸模型在 held 门后 `break` → raw relay，同样从不问策略。

## 修复内容（参考实现，fix.diff）

1. `/responses` 池分支：`codexAccounts` ok 且 `provider.Resolve(id)` 成功且 `!s.nativeCompactionFor(id)` 时 trigger→compact 转 `codexCompact`（magpie1 便携摘要、不写 checkpoint、会话可随任意账号续）；否则原路径不变。
2. `/responses/compact` 池分支：held 门后同判定，开关关按 magpie 模型先例 400 拒绝指引。
3. 文档句 + 两个新测试（`TestCodexOwnModelCompactionThroughThePoolFollowsTheToggle`、`TestCodexOwnModelCompactEndpointFollowsTheToggle`）。
4. 边界保持：无池（`codexAccounts` false）raw relay 不动；第一遍 `codexInput(body,false)` 照旧（reasoning 丢弃语义、toggle-ON 字节级直通都保持）。

## 验证（本轮实测，pr1，go1.26.8，`-tags nogui`）

- **红绿**：修正后的新测试在基线红（池路径原生 seal 直通 + compact 端点照问后端）、加修复绿（200 + magpie1 便携摘要、后端摘要请求无 trigger、**写者 429 时续轮 failover 到 spare@example.com 且以文本恢复摘要**）。消融=单产品文件回退/恢复，同轮完成。
- 哨兵族 `TestCodexOwnModel*|TestCodexCompactsMagpieModel|TestCodexNativeModelStaysNative|TestCodexThirdPartyCompactEndpointRejected|TestNativeCompaction*|TestCheckpoint*|TestCodexCompact*`：绿（11.4s）。
- gofmt（CRLF 判定法）clean；三平台 vet/build exit 0。
- **gateway 全包**（两轮，936s 量级）：8 失败，对照矩阵钉死——
  - 4 个环境类（`TestClaudeAsRootEnv`/`TestSweepBridgeProjectsTakesOnlyTheBridgesFolders`/`TestCommandCodeGoSaysTheAgentsFolder`/`TestPluginToldWhereTheAgentWorks`）：**基线同样红**，Windows 预存（symlink 特权 EPERM、root env 顺序、盘符 git 检测、测试网拒绝 models.dev），与本改动无关。
  - 4 个压缩类：**基线全绿、加修复全红**——见下节，这是收手的根据。

## 碰撞面（收手的根据）

`TestProtectionRefusalAskedOnceNobodyRests`（裸模型 gpt-5.5 + 池两 spare + 开关默认关的 `/responses` trigger：**原生直通、protection refusal 原样回传、只问一次**——文档 "A refusal of the trigger reaches Codex as the upstream sent it" 的裸模型版）；`TestCodexPausedOwnAccountNotCompactedOn`（#263：`/responses/compact` 裸模型在暂停/未暂停两态都原生直通、换账号签名）；`TestGatewayKeyAccountsHoldCodexCompact`（#905/#967 held 门 + 直通）；`TestRevokedSignInNotCompactedOnAgain`（#1793 吊销排序）。

即：**现状是设计而非疏漏**——Codex 自有模型的压缩无论开关、无论是否经池，一律原生直通（带一整套签名/排序/门禁机器）。#2582 提议的"让开关管池路径"要整体翻掉这套机器，属于设计裁决，只有维护者能拍板（§3.1 六问 #5 边界不过 → 不发 patch）。

参考实现的价值：证明提议的行为可落地且能通过全部压缩哨兵（除 4 个钉旧设计的），并精确给出碰撞面清单——若维护者同意改，这 4 个测试要随行为一起改写（暂停面改走 codexCompact 便携摘要、held 门措辞、refusal 语义从"原样回传"变为"转文字重问"等）。

## 排查中途的弯路（如实记）

- 第一轮红测试用了 `chatgpt()` helper，其 `setHome` 擦掉 `codexSignedIn` 登录态导致请求走 raw relay——假红（red-for-wrong-reason），定性后改写 `poolBackend`（不动 HOME，同 `usedUp`/`newResetBackend`）重取证。
- 第一轮全包 `| tail -5` 吞掉失败测试名（已知坑又踩），重跑全量落盘后 grep 定位。

## 未验证 / 待决策

- 真实 ChatGPT 账号现场未复现（#2582 报告者已自证旧行为）。
- 交付去向待用户/维护者定：①#2582 发分析评论（`comment.md` 草稿）附参考实现；②不发，仅留档；③维护者同意改后再交 patch。
- `checkpointCarriers` 同形缺口未扩修。

## 交付物

- `fix.diff` — 基线 `cb05dc2d` 上的完整 unified diff（3 文件，+148/-1），无对应提交，pr1 树已回干净。
- `comment.md` — #2582 英文讨论稿草稿（等授权，不自动发）。
- `full-gateway.log` — 全包第二轮完整输出（8 FAIL 名单与矩阵来源）。
