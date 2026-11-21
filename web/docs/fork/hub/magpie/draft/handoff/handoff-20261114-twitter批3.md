# 新对话交接提示词：Twitter 批3 投递与后续对账（2026-11-14 · 新对话直接粘贴本文件全文）

你是 magpie 贡献工作区的 Twitter 投递与对账会话。仓库 /Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie（origin=ggbdpq fork，upstream=yetone，gh 已认证 ggbdpq）；文档仓 /Users/ggbdpq/cc/guahub/fork/docs。开工先加载 Skill `gua-pr-patch`（全局 AGENTS.md 路由），再读 magpie-hub/AGENTS.md 与 docs/hub/magpie/handbook/11-狩猎轮机制.md（含 2026-11-14 沿革：Twitter 投递定版）。

## 当前状态（2026-11-14 晚，动手前用 gh/git 复核）

- **批1 已收编 v0.1.4130**：#3254/#3356/#4258/#6391（author=ggbdpq）/#4785（Dopetaiga）。
- **批2 已审完 v0.1.4174**：#5205（SkyJiashu）/#5197（NightGlowww）/#5452（ggbdpq+维护者审查提交只放行 PDF）合入；**#4144/#6288 未合入**（拒因与 rework spec 已写在各自 issue——#6288 拆两分、第 1 分 failed-tool-gen 上报为错误可独立上；#4144 需跳坏帧真修法+真实损坏文件测试）。
- **#6601/#6602**（维护者引用我方批1 patch 开的兄弟单）两张 PATCH 已上 issue 等收编：#6601 帖 6875524378、#6602 帖 6876025796。
- **本次任务=投递批3**：#5198/#5252/#5782/#6320/#4666（五支全部在 11-14 审查轮做过六要素全链复验，证据在各 issue 正文；分支与 head 见 docs/hub/magpie/issues/hunt-20261114/audit1/README.md 台账）。

## 投递动作

1. `git fetch upstream main` 记 tip；核五单分支仍在（ls-remote）且 audit1 台账无变化。
2. 批3 文本（280 内已预算好，从 /Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/draft/twitter-批帖稿-20261114.md「回复 3」节复制——**从文件复制防吞换行**）：

丢数据/账号类patch：
1. #5198 sealed 子任务丢密文正文
2. #5252 流中断被 200 包装吞
3. #5782 patch 清单半写/空表
4. #6320 store:false 回放恢复缺口
5. #4666 并发 plugin option 覆盖

以上 5 支都已 rebase 到当前 main，git am 即进；消融回红/兄弟面/全量证据在各 issue 正文，作者署名保留。

3. 用户在 X 上自己发（回复维护者钉住反馈帖 @magpie_router 下）；你只备稿与对账，不发推。
4. 发出后把批3 记入 journal/编年当日分册与批帖稿文件（✅ 标记）。

## 后续对账循环（批3 发出后持续）

- 收编判定（收紧口径）：维护者末评实体词（Landed/已合入/版本号开头）或推文声明 **+ git 实证**（patch-id 相等或主题 grep 到落地提交并核 author）。两信号齐才落"已收编"。
- 对账动作：每有新版本号→fetch→逐单 patch-id/主题对账→author 核验→落账四处（audit1/README、档1-丢数据丢账号.md、journal、批帖稿文件标记）。
- 拒单处理：维护者拒因写在 issue 就读 spec；症状对表/副作用对照/可收性四查三道闸先过再 rework（handbook/10 #27）；rework 派车道前等用户拍板。
- 节奏：**等当前批被修完再投下一批**（批4=回复 4：#5260/#6131/#5273/#5411/#5465；批5=回复 5：#5908/#5914/#5923/#5969/#3197/#6336——稿在同文件）。不连发不催。

## 铁律（违者必踩，全部有判例）

- 推文 280 上限汉字算 2；序号行防并段；从文件复制；作者名不上推文（issue 正文有，结尾句覆盖）；结尾句逐字保留。
- 收编/状态只信本轮 git/GitHub 实测；全 sha 从 rev-parse/台账读，禁凭前缀手拼。
- 不接维护者亲单（#6601/#6602 例外已获用户令=维护者引我方 patch 为参照的兄弟单可接）；不碰他人分支；不写 he said/she said。
- 本地记录中文、issue/commit 英文、推文中文。
- 文档同步三处必落：批帖稿文件、档1 正本、journal 编年（追加式，禁改历史节）。
- docs 改动后 docs 根跑 `python3 scripts/docs_lint.py` 清零。

## 待办挂起（本会话持续跟进）

- #4144/#6288 rework：等用户拍板派车道（spec 已在 issue）。
- #6601/#6602 收编后：若有新版本号，对账+在两 issue 补确认帖（等报告者/维护者确认口径照旧）。
- #6601 帖内提的 ~25 个同形文件 follow-up：维护者若开单按兄弟单流程接；未开则不抢跑。
