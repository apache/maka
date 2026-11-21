# #5767 独立车道 journal（2026-11-10，NEW 单）

## 结局：PATCHED

- **issue**: yetone/magpie#5767（darwesss-star：Claude 订阅、interactive mode，每个图片工具结果触发 "tool results account changed" 重启并重写 prompt cache）
- **head**: `fb6554d67d06f80d726f45582c8bb062912b7679`（fork 分支 `fix/5767-claude-image-toolresult`，基线 upstream/main `e3ab7f3bf`）
- **patch sha256[:16]**: `5974476d46768489`（zero-commit 格式，`5767-claude-image-toolresult.patch`）
- **PATCH 帖**: [6753753069](https://github.com/yetone/magpie/issues/5767#issuecomment-6753753069)（列表端点回读：author=ggbdpq，4868 字节）
- **take 帖**: 6752911753

## 根因（证据链）

1. 报告者日志 `tool results account changed` 唯一赋值点 = claude_subscription.go serveSubscription 的 owner 检查（原 6800-6803）：`run.owned() != owner && !run.takeNamedOwner(owner)` → abort + 新 run 全量重放。run 已被 match 精确匹配到，owner 却不一致 ⇒ 路由层把该请求派给了另一账号（桥的设计：不能拿 B 账号续 A 的进程，TestClaudeToolResultsKeepTheSelectedAccount 锁定此语义，非桥 bug）。
2. 为何图片请求被路由换号：`turnIn`（affinity.go，affinity/rules 共用的回合判定）对任何带 Image/File 的 user 消息判 `said=true → turn++; within=false`。pi 形状 = `role:tool` 文本工具结果 + 独立 user 消息 "Attached image(s) from tool result:"（带图）——桥内 match() 把该消息归为工具结果（captions 语义），turnIn 却把它判成用户新回合：`within=false` ⇒ affinity 不再 Kept（`a.Why="turn"` 才保留原账号）⇒ 按 rotate/spent/cold 等重选账号 ⇒ owner 漂移 ⇒ account changed。纯文本工具结果无后续 user 消息，within 保持 true，不触发——与报告者 7/7 图片触发、0 文本触发的相关性完全吻合。
3. 排除项：vision 描述路径（模型能看图则不触发）、group 图片过滤（需 group+无 seer）、body_cap（订阅桥走本地二进制无关）、`p.Account.User` 瞬变（无证据路径）。

## 修法（2 hunk + 测试）

- affinity.go `turnIn`：跟踪 `results`（assistant 处清零）；`said && results` → `within=true`（图片随工具结果携带回合，不 turn++）；用户自己的图（无结果待答）仍开新回合（`TestTurnInCountsTheUsersOwnImage` 锁定）；用户文本随结果仍按旧语义 turn++（不扩scope）。
- claude_subscription.go：owner 检查失败时日志带双方 owner 明细（`ownerSaid`：provider+账号+own sign-in+unnamed 标记）→ 报告者 ask 2（"log the real reason"）。
- 测试 `turn_in_tool_images_test.go`（3 个实名测试）。

## 验证（六要素）

| 要素 | 结果 |
| --- | --- |
| 真实路径复现（修前红） | pi Chat 形状（parse 后 turnIn）：`turn 2 within false`，期望 `1 true` —— 红（ownerSaid 部分单独先行落地，未混入 build failed） |
| 修后绿 | 3 个新测试绿；定向同族（TestTurnIn*/TestUserSays*/TestSubscription*/TestClaude*/TestRoute*/TestAffin* 等）128.4s ok |
| 全包 | internal/gateway 全量 `-tags nogui` **826.184s ok**（首次 600s 超时为 timeout 设小于历史最长 677s 的环境项，非回归；920s 权限内重跑通过） |
| 消融回红 | `case said && results:` → `case false && results:`（语义分叉行死化，git diff --stat 复证 1 行）→ 实名测试红（同签名 `turn 2 within false`）→ 还原 → 绿。整摘分支会产生 `declared and not used` build failed 假红，已按判例避开 |
| 兄弟面 rg 全查 | turnIn/turnOf 消费方全列：①affine（a.Within 守卫 mid-turn 迁移+Kept，修复目标面）；②ruleFor rules.go:195（within=true 沿用回合规则，工具循环中途不再重挑成员——行为改善）；③parse_memo factsOf（纯缓存）。`a.Within` 不落盘（sticks 持久化仅 turn/who/model/…），`a.Turn` 仅记账/展示（Routing 页）。改/不改理由齐 |
| 实名测试 | TestTurnInCarriesAnImageBesideItsToolResult、TestTurnInCountsTheUsersOwnImage、TestToolResultsNameTheChangedOwner |
| am 即进 | 干净检出树（worktree @e3ab7f3bf）`git am` 零冲突 → 4fbe4951d（zero-commit 格式致 id 异常属预期），worktree 已自清 |
| push | `fb6554d6…` 显式 sha refspec + force-with-lease（lease 实时 ls-remote，旧值为空=new branch）→ ls-remote 回读一致 |
| 回读 | 列表端点末条 6753753069 比对 author/字节通过 |

## 未验证/如实项（帖内已声明）

- 报告者真机会话（Windows + pi/OpenBot + 其路由账号布局）NOT-RUNNABLE：issue 未给出路由设置；单元层已锁住重启的输入形状（新回合误判）。帖内已告知若仍重启，新日志行会点名两个账号，追报即可定位剩余路由面。

## 本车环境注记

- gateway 全包耗时历史区间 308s-677s（journal），单机独跑口径；并行车道同跑会拉长，timeout 给 900s 起。
