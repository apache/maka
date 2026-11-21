# review 意见处理

PR 等了一天没动静，不一定是没看——大概率有人留了 review（甚至 CHANGES_REQUESTED）。合并门是卡在 review 上，不是 CI 上。

## 拉取 review 意见（三个端点）

```bash
# 总体 review（approve / request-changes / comment + 正文）
gh api repos/apache/maka/pulls/4518/reviews --jq '.[] | "[\(.user.login) \(.state)] \(.body)"'

# 行内评论（钉在具体代码行，带 path 和 line）
gh api repos/apache/maka/pulls/4518/comments --jq '.[] | "[\(.user.login) @ \(.path):\(.line)] \(.body)"'

# issue 类评论区（普通讨论）
gh api repos/apache/maka/issues/4518/comments --jq '.[] | "[\(.user.login)] \(.body)"'
```

注意：长 review 用 `--jq '.body'` 单独拉全文，别在批量查询里接 `head` 截断——本次 me2seeks 的 CHANGES_REQUESTED 正文就是被截断后重新拉的。

## 状态语义

| 信号 | 含义 | 动作 |
| --- | --- | --- |
| `CHANGES_REQUESTED` | reviewer 要求修改；**不会因为你在评论区回复而自动消除**，要等 TA 重审 | 按意见修 + 回复说明 |
| `mergeable_state=blocked` | CI 绿但缺批准/有未解决 review | 等 reviewer，或按意见修完请 TA 重看 |
| `mergeable_state=dirty` | 与最新 main 有冲突 | rebase 到新 main 解冲突后强推 |
| 自动化 review（署名 agent） | 意见仍是真问题，但最终需要人工 review 确认 | 一样修 |

## 修复流程（本次验证有效）

1. 逐条核实 reviewer 引用的代码行（`sed -n`、`git grep`），确认意见属实再动手——两个 reviewer 对同一 PR 的意见可能侧重不同，全量核对后按条修。
2. 修完以**第二个 commit** 叠在 PR 上（不需要 force push），commit message 写明对应哪条 review 意见。
3. 在 PR 下回复说明每条怎么修的，附 commit SHA，方便 reviewer 直接触发重审。
4. 如果 review 指出 PR **正文**与实际 diff 不符（数量、断言），同步 `gh pr edit` 修正正文。

## 更新 PR 正文

```bash
gh pr view 4518 -R apache/maka --json body --jq .body > body.md
# 编辑 body.md 后写回：
gh pr edit 4518 -R apache/maka --body-file body.md
```

`gh pr edit` 和 `gh pr comment` 都**没有 `--jq`**。正文含表格/长文时务必走 body-file。

## 实战案例

### #4518（文档审计）：两份 review 指向同一类问题

- Astro-Han 详评：ADR journal 状态串漏了 `reconcile_observed`（代码 `ToolJournalState` 是 5 成员联合，且"写入路径可达"的措辞让不全变成错误断言）；决策表缺一行；正文数量写错（4 改 5、3 改 2）。
- me2seeks CHANGES_REQUESTED：同一错误在另一份文档还残留一处（`redo_disabled_pending_cas` → `reconcile_matches_prior_state`），明说"一行修复，改完就批"。
- 教训：**同一组文档里的同类断言要全量自查**，reviewer 修一处点名一处；PR 正文也是"文档"。

### #4506（CLI 代码）：自动化 review 的 P1

原实现用 toolName 判断"后续成功=被拦调用已恢复"，reviewer 造了反例：同名 `Read` 两次、目标不同（/outside/secret.txt 被拦，/workspace/README.md 成功）仍会清掉失败并 exit 0。修复 = 用 args 序列化做语义目标比对，不一致不恢复（fail-closed），并按要求补 live/durable/exit-code 三组回归。代码修复详见 [04-CI排障与测试.md](04-CI排障与测试.md)。

## Git Bash /tmp 陷阱（本次踩过）

`gh pr view ... > /tmp/body.md`（bash 重定向）没问题，但同一文件给 **Windows 原生 Python** 读会 `FileNotFoundError: '/tmp/body4518.md'`——MSYS 只转换程序参数里的路径，转换不了脚本内部的字符串路径。给 Python 的临时文件用 Windows 路径（如 `E:/.../tmp-file.md`），别放 `/tmp`。

## 2026-09-13 追加：三条新规矩

- **评审建议先消融再执行**：#4815 里 me2seeks 要求谓词加 trim，Astro-Han 用消融+base 对照证明会阻塞存量重放（#4804 复现）——同一问题两个 reviewer 给冲突建议时，做实验查历史兼容约束，别选边站。同类：评审者自己也会在下一轮写 "that P2 is addressed"，**动手前先读前一轮评审的结论**，别重复劳动。
- **修 P1 前确认前一轮结论**：Astro-Han 复审开头就标明哪些已认可；只修他新点的条目。
- **PR 评论正文含反引号代码时**：绝对不要内联拼 JSON（bash 会把反引号做命令替换，静默吞掉一段文字，实测 `length(CAST(...))` 被吞）。用 Write 工具落盘 JSON 再 `curl -d @file`；发完拉回来复核正文完整性。
