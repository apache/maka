# #5916 Codex 登出后 removed 行残留显示 — 证据（NEW6 车道 9，2026-11-11）

## 结果：PATCHED

- 基线：upstream/main `d2a80b317`（2026-11-11 实时 fetch）
- 分支：`fix/5916-signout-stale` = `bc903d2d8e7e968ddd2ad38ef6d57690a22a953e`（已推 origin，ls-remote 回读一致）
- patch：`git am` 干净树（/tmp/mg-1110-95-clean @ d2a80b317）零冲突，am 后 `087650462`
- sha256[:16]：`1a9b9d5b5b1190c7`（0001-provider-Sign-out-signs-Codex-itself-out-saved-copy-.patch）
- 帖：https://github.com/yetone/magpie/issues/5916#issuecomment-6779846032（列表端点回读：author=ggbdpq，6078 字节，尾注在）
- take：#issuecomment-6779333536

## 排雷（收编三查）

1. 评论面：c=0（首查无评论；take 前末页重扫仍 0）——无维护者末评信号。
2. `git log upstream/main --grep="#5916"`：无提交。
3. issue OPEN。
4. #5963 判例（ee818e8bc，Claude bridge 图像重发域）与本研究域（Codex 登出/排除行）不相交。

## 根因

`ForgetAccount → forgetLogins(agent)` 只遍历 `Logins(agent)`＝logins.json 的 saved 副本；Codex 自己持有的活登录（auth.json/keychain）仅当恰为 saved 之一时才经 `forgetLogin` 的 live 分支 `deleteCodexLogin` 删除。活登录未被 saved 命名时：

- 移除早于任一次 due look（`loginsLookDue` 30s 窗口；GUI 每几秒读 accounts，移除时刻几乎必然未到期；且隐藏后 `accountRemoved` 永不再存 codex）；
- 或移除后用户自行 `codex login` 换号（同样不被保存）。

⇒ forget 报成功但 Codex 仍在登录 → `Accounts()` 仍含 codex → `Hidden()`/`Excluded()` 保留 quiet 行 → Add sheet「Removed from magpie — still signed in」行与永远 no-op 的 Sign out… 无限残留＝报告现象。

## 修法

`internal/provider/forget_account.go` `forgetLogins`：循环后补一段（codex-only）——活登录存在且不被 pre-loop saved 列表命名时，`ForgetLogin(agent, live.User)`（同一条 #2367 deleteCodexLogin 路径）。claude 永不登出（claudeStandIn）、其它 agent 的自身登录 ask 明言不动（"The account itself is left as it is"），故分支限 codex，与 ask 对 codex 的承诺行一致。

## 复现与消融（修前红→修后绿）

| 测试 | 形状 | 修前 | 修后 | 消融（`if false &&` 变异，grep 复证） |
| --- | --- | --- | --- | --- |
| TestForgetAccountSignsOutASignInNoSavedCopyNamed（新） | 移除早于任何保存（显式 `loginsSeenAt.Store(now)` 钉住 due 窗口） | 红：行残留+auth.json 在 | 绿 | 红 |
| TestForgetAccountSignsOutTheSignInItMovedOnTo（新） | 移除后自行换号，新活登录不被保存 | 红：同残留 | 绿 | 红 |
| TestForgetAccountSignsCodexOut（既有） | saved 流程 | 绿 | 绿 | 绿 |
| TestCodexSignOutLastAccount（既有） | 换号后删活登录 | 绿 | 绿 | — |

消融期间实证：B 测试若无 due 窗口钉住，Delete 内部 Accounts() 读取会顺手触发 rememberLogins 存下活登录而退化成 A 形——生产中 GUI 轮询使该窗口几乎恒未到期，故 B/C 形在生产持续可达（帖内已述）。

## 验证矩阵

- `./internal/provider` 全量：ok（131s，最终态重跑）
- 四个实名登出测试 `-race`：ok（2.2s）
- 全树 `go build -tags nogui ./...`：干净；gofmt：干净
- 干净树 `git am`：零冲突
- push：首推（远端无旧值），显式 `bc903d2d8:refs/heads/fix/5916-signout-stale`，ls-remote 回读一致

## 兄弟面（逐点改/不改理由，帖内同文）

1. `forgetLogins` 唯一 caller＝ForgetAccount；copilot/antigravity 直调测试不受影响（分支 codex-only）→ 不改。
2. `deleteCodexLogin` 唯一既有 caller＝forgetLogin live 分支；修法复用同一共享根处，无新删除路径 → 不改。
3. `liveLogin("codex")` 全部读取点（autoreset/access-only/resets/switch/import/export）新鲜读，forget 后读到 none 语义正确 → 不改。
4. `Excluded()/signedOut` 读取点：renderExcluded（Providers 页提醒行）、Add sheet removed 区（gone）、magpie accounts/providers CLI——同数据面自愈 → 不改。
5. `savedButSignedOut`（saved 有、live 无的另一族）与插件路径（plugin.SignOut 已自带自身登出）→ 不改。
6. `rememberLogins.accountRemoved` 与 signin_carry 的取消隐藏 → 不改。
7. 上游 d2a80b317 近期对 logins.go/account.go 的改动（access-only、parse-once、workspace）不动这些契约 → 补丁按现语义落位。

## 产物

- 分支：https://github.com/ggbdpq/magpie/tree/fix/5916-signout-stale
- patch URL：https://github.com/ggbdpq/magpie/commit/bc903d2d8e7e968ddd2ad38ef6d57690a22a953e.patch
- 本目录：patch / body.md / commit-msg.txt / evidence.md
- worktree 已清：/tmp/mg-1110-95-n6、/tmp/mg-1110-95-clean
