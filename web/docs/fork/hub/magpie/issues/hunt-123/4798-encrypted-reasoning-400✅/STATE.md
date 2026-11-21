# 4798 出列记录（Lane B, 2026-11-04）

## 结局
出列（yield）——发英文分析帖计完成，未 take、未改代码、无 patch。
帖：https://github.com/yetone/magpie/issues/4798#issuecomment-6611290390（post.md 逐字节回读一致，Attribution `written with GLM-5.3-Flash (ZCode)` 单行在帖）。

## 让位闸判定（双项命中）
1. 维护者表态：yetone 2026-11-02 评论给出修复 c875e66c2 (v0.1.2667) 并声明 "Leaving this open until then"。
2. 已 landed：c875e66c2 在 upstream/main 内（本分支基线 7785c4278 含它，`git branch --contains` 实测）；commit 标题直接引 #4798。
3. 报告者自带修复：无。方案先行：zane668 的根因分析被维护者采纳实现（代码注释内已 credit zane668/ZanderH-code）。
4. fewensa 2026-11-03 实测 v0.1.2850：88/88 全恢复，34 次 400/foreign 均为首次接触后同账号重试成功；确认单只剩"中间 400"残留，双方均按已定设计表述。

## 代码验证（base 7785c4278，只读）
- 两道闸：gateway.go serve 循环 ~L3825（非 Responses 客户端，c875e66c2 新增，refuseCarried + failForeign）与 ~L3840（Responses 客户端原闸，#3887 b59e4b747 10-27 落地，withoutSeals/withoutCompaction + refused 记哈希）。
- 前置剥离：~L3242 withoutRefused（Responses 客户端逐 try 前置）、~L7870 withoutRefusedCarry（翻译层，withSealScope 按 try 供应商限定）。
- 记忆：affinity.go ~L1039 foreignReasoning 正则；~L1040 refusedSeals（会话键 stickKey|vendor，SHA-256 of encrypted_content，TTL stickKeep）。
- 测试：foreign_carry_test.go TestForeignCarriedReasoningAskedAgainWithout；foreign_seal_test.go TestForeignSealAcrossGroupMembers 等 8 个。
- 文档：docs/subsystems/gateway-routing.md 新增一行（c875e66c2）。
- SealedBy 只记 API 不记 key/账号（ir.go L76-79）→ 事前规避需逐 item 记封印者，无人提出，残留=首次接触一次浪费尝试。

## 场景映射（五假设）
1. fewensa A/B（Responses 客户端，400 foreign→200 同账号）= #3887 原闸，修复前后不变。
2. fewensa C（同账号 affinity.kept 仍 400）= 历史携带更早他号 seal，该 (会话,账号) 对首次接触；refusedSeals 学习解释。
3. zane668 Pi/Chat + ZanderH-code Messages（连续 400 other 不恢复）= 闸只对 Responses 开 + 9da9bfabd 起 __rk16__ 载体逐轮回放；c875e66c2 已修。
4. `other` 分类 = 判定文本一直匹配 foreignReasoning，仅客户端条件挡路；闸放宽后消失（fewensa 表 8 行 API 全部 400/foreign 恢复佐证）。
5. 残留中间 400 = learn-on-refusal 设计；事前规避需 sealer attribution（签名缓存/中继响应均过 magpie 手，可行但更大改动，无人索求）。

## 未验证
- 未跑任何测试/构建（只读出列，无改动）；worktree 净（分支=7785c4278 未动）。
