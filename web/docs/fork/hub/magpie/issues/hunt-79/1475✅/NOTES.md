# hunt79-c: #1475 分支 rebase + 自发更新帖（L3）

## 阶段 1：rebase
- 主 clone fetch 后实测：upstream/main 已从简报快照 a84d2ec80fd4 前进到 **b97e0aa2a2578ce65bd69feed4d310f9218139a8**；a84d2ec8 是 b97e0aa2 的祖先，且 a84d2ec8..b97e0aa2 **零提交触及 internal/gateway/chattidy.go**（冲突面不变）。
- 决策：按任务目标"rebase 到最新 upstream/main"，用真实最新 b97e0aa2（避免基线发布即过时）。
- worktree：/tmp/magpie-hunt79-c，分支 hunt61-a-1475-unnamed-call，旧 head fd71715096476181d00fa26f03f5da3c9696e25c（本地=fork remote 一致，ls-remote 核实）。
- 冲突复现：对 a84d2ec8 与对 b97e0aa2 各试一次，均只有 internal/gateway/chattidy.go UU（1 文件，简报一致）。

## 阶段 2：语义门
- ba4b754b（JoeyWu-tech, #3386）：chatTidy.line 的 else-if ok 分支在 ids 补全**之前**插入 `t.indexes.give(choice, calls)`（无 index 的 fragment 补其 call 的 index），新增 streamCallIndexes/openCall 类型与 indexes 字段；只写 `c["index"]`，**从不触碰 function.name** → 与我方 #1475（无 function 名 call 丢弃）两面正交，可叠加。
- #1475 前提复核：`git grep -i "nameless\|aName" b97e0aa2 -- internal/gateway/` 仅命中无关文件（transcribe_test/ollama/key_accounts_test），当前 main 仍无 nameless-call 处理 → 前提成立，照推。
- ba4b754b 触及 chattidy_test.go / gemini_compat_cut_test.go，与我方新增 chat_call_name_test.go、改动的 textcalls_test.go / whole_stream.go / chat_call_ids.go 无重叠（自动合并干净）。

## 阶段 3：解冲突（3 处，全在 chattidy.go）
1. doc 注释+struct：两段注释都保（#3386 段在前），struct 字段合并（indexes + named/seen/bad）。
2. line() else-if ok：保 HEAD 的 give 块，删其旧位置的 `if t.ids == nil`（我方已移入 `if calls != nil` 内）；顺序定为 **give → called → nameless → ids.mend/withoutEmptyNames**。give 在前使无 index 流先补 index，我方 nameless 的 (choice, idx) 键控对无 index 流也正确（否则无 index 的坏 call 后跟一个好 call 会被 bad[(c,0)] 键误杀——give 先行给了各自 index，可区分）。
3. 两函数被 git 按公共头尾行错位匹配：手工重完整组 streamCallIndexes/openCall/give + nameless 两函数。
- 零冲突标记；gofmt -l 干净；GOOS=linux go vet -tags nogui 编译门 exit 0；rebase --continue → 新 head **474f0e5fd8ec1a3574497e1168e3580f0379f26c**。
- 提交信息完整保留（Fixes #1475 + Generated-by: GLM-5.3-Flash (ZCode)）。
- `git diff fd717150 474f0e5f -- chattidy.go` = 恰好 ba4b754b 的插入（cmp import、#3386 注释段、indexes 字段、give 块、类型+方法），我方逻辑零改动。

## 阶段 4：验证（全绿）
- 定向：我方 5（TestNamelessCallStreamDropped/NameAbsent/BesideAGoodOne/WholeDropped/WholeAsStreamDropped）+ #3386 2（TestChatTidyGivesCallsAnIndex/TestGeminiCompatRelayedCallsHaveAnIndex）+ 守卫（TestChatCallsEndToolCalls、TestEmptyCallID*×3、TestStreamedCallGivenAnID、TestTextWritten*×15、TestQuietWholeReplyStreamed）全 PASS（-count=1, -tags nogui）。
- 全包 go test -tags nogui -count=1 ./internal/gateway/：**ok 369.498s，exit 0**（日志 /tmp/magpie-hunt79-c-fullpkg.log）。
- 消融回红：三产品文件（chattidy.go/chat_call_ids.go/whole_stream.go）checkout b97e0aa2 → 5 个 nameless 测试 **5/5 FAIL**（红证据到手）→ checkout HEAD 恢复，树干净（仅 NOTES.md 未跟踪）。
- gofmt -l internal/gateway：空。go vet -tags nogui（native+GOOS=linux）：exit 0。go build：darwin/arm64 与 GOOS=linux -tags nogui 均 exit 0（gui cgo enum 警告与 ld 版本提示为预存噪音）。

## 阶段 5：发布链（完成）
- push 门控：ls-remote 旧 head=fd71715096476181d00fa26f03f5da3c9696e25c 核实 → `--force-with-lease` 强推成功（fd717150...474f0e5f forced update）。
- ls-remote 回读新 head = 474f0e5fd8ec1a3574497e1168e3580f0379f26c ✓
- fetch upstream 复查：b97e0aa2..FETCH_HEAD 触及三个目标文件的新提交 = 0 ✓
- #1475 评论数发帖前后均 = 1 ✓
- 更新帖已发：**评论 ID 6387090190**（https://github.com/yetone/magpie/issues/1475#issuecomment-6387090190），body 33696 字符。
- GET 回读全中：branch link / Attribution / SHA-256(1e449618a5e300b5) / format-patch 嵌入（From 474f0e5f）/ 正文零中文（唯一中文命中在 patch 围栏内第 71 行，diff 上下文"喜欢一个人"，与原帖一致）/ GLM 命中仅 commit 尾注 1 处（jq scan|length 的 3 是字符串长度，grep -n 佐证仅第 53 行一处）。
- 稿成自检：branch_link=1、attribution=1、fences 9/527 配对、sha=1、patch_head=1。

## 遗留疑点（不影响本次交付，留给主线程定夺）
- nameless 返回 kept==nil 时 `calls` 变量未置 nil，`if calls != nil` 内 ids.mend 会用原始 calls 重新写回 delta["tool_calls"]——仅当 nameless call 同时缺 id 时 manifest（补 id 后复活，客户端仍会拒 name）。rebase 前后行为一致（fd717150 原结构如此），非本次冲突引入，测试覆盖面内不触发，不属 rebase 范围。值得单开 follow-up（修法一行：kept==nil 时 `calls = nil`，加"无 id 无 name"红转绿用例）。
- 简报基线 a84d2ec8 已过时：实际 rebase 到真实最新 b97e0aa2（a84d2ec8 是其祖先，两 sha 间零提交触及目标文件，冲突面不变）。
