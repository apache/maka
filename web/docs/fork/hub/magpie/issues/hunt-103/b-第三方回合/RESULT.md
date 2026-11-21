# hunt103/b · 第三方新回合巡检（2026-10-30）

基线 origin/main=`3bebc3839`（当轮 fetch 起点实测；收口时上游走到 `eadeb89c4`，sessions/dirent 面，零触及本轮涉及文件）。worktree=`magpie-hunt103-b`（用毕已删）。5 单处置：2 帖（#3121 续验、#2589 收尾），3 单零帖。

## 逐单

### #3173 skygunner 6347698356（10-22 18:03）→ 零帖（实测定性，衍生帖落 #3121）

- **定性**：补充说明非提问。内容=其 `fix/union-items` 分支（#3121 载体）与本单的关系 + 对旧上游 `ca4a1cde`（10-23 提交）的复核：称当时上游 codeassist.go 仍让嵌套 type-list 漏 `items on non-array`。
- **实测**（探针 `zz_hunt103b_probe_test.go`，走查全部输出找 items/minItems/maxItems 落非 array）：
  - 时间线钉死：出口 delete 规则与 type-list"选 items/properties 指向的那支"均为 `d71362afc`（10-27，ferock/Discord 致谢）一笔引入；skygunner 评论时上游确无此规则，其声称与历史一致。
  - 当前 main `3bebc383`：三探针全绿——①嵌套 `items.items`（#3173 的 400 路径）内层折成 array；②#3121 一级形状保 array 半边+bounds；③无 array 半边+裸 minItems/maxItems 全删净。
  - 消融（只回退 codeassist.go 到 `d71362afc^`）：三探针全红，红形 `items.items on type string` 与 #3173 的 400 签名逐字同构；还原后绿；包内 4 个 plain-schema 既有测试双向绿。
- **修正台账口径**：hunt95-G 记"语义与中方相反（keep-on-array vs delete-on-non-array）"不全——d71362afc **同时含**我方 delete-on-non-array 语义（出口 ：1026）与 keep-on-array（type-list 折叠 ：951），两个第三方补丁的面都被接管。
- **处置**：#3173 已关（报告者关单），skygunner 帖无提问→零帖。衍生事实（main 已接管、#3121 在途分支冗余）→ **#3121 续验帖 [6515052354](https://github.com/yetone/magpie/issues/3121#issuecomment-6515052354)**（英文、表格三形状红/绿、回读逐字一致）。#3121 线程原 3 评论（我方 10-21/10-22 两帖+skygunner 分支帖），发帖前核验评论数不变+上游零触及 codeassist.go。

### #3022 Shane-Meng 6366225666（10-23 13:39）→ 零帖

- 与 10-28 巡检补记同一帖（台账已有）：0.1.1336 masker 层复核成立+两侧观察仍成立（unredacted-provider 盖不住 Ollama Cloud；该 400 不在 retryable）。我方末位 6364989991 之后无新评论（n=3 均为 10-23 当天已处置的回合）。其承诺的 Ollama 真回环（限额 10-26 08:00 重置后）至今未落地，等其自补验。零动作维持。

### #2589 ID404 6218312213（10-16 15:01）→ 收尾帖 [6515070015](https://github.com/yetone/magpie/issues/2589#issuecomment-6515070015)

- **定性**：接受我方解释并致谢（"逐个重新登录"），未答征询第二问（自定义 key 形态）=即账号均为订阅登录，征询闭环、无新诉求。issue 仍 open 两周。
- **处置**：轻量收尾帖（英文）：面向后来者复述一句设计口径（引用导出对话框文案，已实测 app.js:20449+四语言在基线仍在）+ 请报告者酌情关单。发帖前核验：评论数 2 不变、app.js 零触及。回读逐字一致。

### #2578 jerrychoi 6235833331（10-17 15:33）→ 零帖

- 末位评论=报告者确认修复生效（"没问题了"），issue 已 closed。不推翻我方定性（Desktop 端限制+编号 chip 缓解面已合入 `7660399a`）。无需回应。

### #3588 wang1078564969 6395935607（10-25 09:26）→ 零帖

- 唯一评论=OP 本人的 UI 功能建议（路由页请求体展示完整参数含思考强度），hunt85-S1 已按"兄弟面核查零动作"在案。不触及我方 #3399 交付与 zcode 链定性。残余缺口候选（refusesThinkingOff 四正则不匹配 Kimi 报错措辞）维持"待可证再动"。零动作维持。

## 没跑什么

- 未对真实 Antigravity/Gemini 账号端到端复放（与原交付一致，schema 级验证）。
- skygunner 分支 c638203 本身未再重放（其价值判断基于当前 main 探针，非分支复测）。
- #3022 两侧 follow-up（unredacted-provider/retryable）未开新单，维持"在案候选"。

## 产物

- `3121-comment.md` / `2589-comment.md`：发帖正文（与线上回读 diff 为空）。
- `zz_hunt103b_probe_test.go`：临时探针原件（未提交，worktree 已删）。
- `magpie-*.json`：五单 issue+评论全量抓取（2026-10-30 12:18）。
