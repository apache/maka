# hunt108 断点续跑清单（2026-10-31 17:5x，主线程落盘）

## 环境故障（重启解阻）
sandbox-exec profile 跨车道持久化超限（66800 > 65535），所有车道 Bash/Grep 开局即死。
**重启 WorkBuddy 会话后即恢复**（新会话新 profile）。教训：长任务车道不要并发大量
Write/Edit + 后台长测试循环写日志；发布收尾车道尽量 shell 内联组装、零 Write。

## 立即待发布（工作已完成，只差 push+发帖）

### A 单：yetone/magpie#4530（测试挂死，gateway TestThinkingStreamsWithNoOneElse）
- worktree：/private/tmp/magpie-hunt108-d，分支 `hunt108-d-4530-slow-thinker-done`，2 commit（`5b9c9c314`+`17e87bf4c`），基线 47173f593
- 草稿：docs/hub/magpie/issues/hunt108-d-4530/comment-draft.md（结构合格：全英文五段+三件套，`TODO_SHA256_16` 占位在 51 行 summary，format-patch 插入位 45–47 行，注明 2 commit：`git format-patch 47173f593..17e87bf4c`）
- 查重已核（pub-a 经 API）：08:51 Jackzigen 分支帖之后零新评论，无让位风险；我方 take 07:06 在先
- 收尾步骤：定向测试重跑 → format-patch 两个 commit 依序内嵌+sha256 前16 → 八项自检 grep → push origin → fetch upstream 防抢发 → `gh issue comment 4530 --body-file` → GET 回读

### B 单：yetone/magpie#4529（Gemini thinkingConfig effort）
- worktree：/private/tmp/magpie-hunt108-e，分支 `hunt108-e-4529-gemini-effort`，commit `3bd910a85`，消融+矩阵已完成（缺 provider 定性一步）
- STATE.md：docs/hub/magpie/issues/hunt108-e-4529/STATE.md（6 步收尾序，pub-b 已补实测小节）
- **注意**：STATE.md 提到 issue-comment.md 已失实——草稿需从零组装
- 查重已核（pub-b 经 API）：仅我们 07:09 take，无他人认领
- 收尾步骤：基线定性 provider（定向测试一次）→ 组装英文五段 body → 八项自检 → push → upstream 复查 → 发帖+GET 回读

### 本会话已发布（重启后只需记账）
- #4063 rebase：分支 hunt101-w1a-4063-host-standin，head fbe36e57，帖 15:20 ✅
- #4278 rebase：分支 hunt102-g-4278-omp-pricing，head 645e80ab，帖 15:25，patch sha16 `9f629459` ✅（已抽验质量过关）
- 待办：两帖终验 GET 回读（C 帖细读）+ journal 记账（含撞号说明：hunt108 号段另一会话用 a/b/c 接了 #4512/#4495/#4502；我方后续分支继续 hunt108-d/e 字母序）

## 下一批候选（scout-1 产出，已排雷）
按优先级（全部 0 评论、可本地确定性复现、维护者未占坑，除注明外）：
1. **#4563** Claude 登录 Keychain 写失败仍存 logins.json（yetone 亲单，测法 issue 已给，最稳）
2. **#4561** plainSchema 把 `#/properties/…` $ref 变裸 object（codeassist.go，kimi_schema.go 同病）
3. **#4562** 带 hosted web search 时文本形式 tool call 不被识别（search.go 三协议路由漏 textCallSee）
4. **#4436** 插件未声明 image 能力时 input modalities 整体丢失（plugins.go ImageSaid 绑定过宽）
5. **#4454** 官方 OpenAI preset 探针发 max_tokens 被新模型拒（test.go tinyBody）
6. **#4511** TestUnroutedTrickledBodyAnswered408 全量跑红（yetone 亲单，idle/写间隔余量翻转）
7. **#4508** 翻译请求忽略 BaseAPI（usable 排序不读 Provider.BaseAPI）
8. **#4510** TestColdTurnsTaken 竞态（yetone 亲单；接前先读其唯一评论）
9. **#4466** vision describe 3m 等 2m unrouted 上限误杀（并发 fixture 工时大）
10. **#4486** Kimi Code prompt cache 被 lift 打断（Q2：收益验证需真实账号）

已排除判例：#4457/#4473 上游已自修；#4514/#4480 他人挂分支；#4482 报告者自带完整分支；
#4478/#4479/#4501/#4551 标题即注已修/分支就绪；#4556/#4503/#4440 需真实环境。
占用总表：我方 #4530/#4529/#4063/#4278；他Session #4512/#4495/#4502/#4553/#4548/#4545/#4550/#4547。

## 目标进度
用户要求累计 ≥12 单。当前：已发布 2（C/D）+ 待发布 2（A/B）= 4。
重启后：先收尾 A/B → 再从候选表派新车道（注意：新会话各车道也须控制 Write 频度防 profile 再爆）。
