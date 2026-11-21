## 现象

Claude Code 经 Magpie 网关时，后台子代理（`Agent` 工具 `run_in_background: true`）完成后，客户端生成的 `<task-notification>` **模型看不到**；同一台机器、同一 Claude Code 版本直连 Anthropic 时能看到。表现为主会话“等不到子代理结果”，只能自己去读 output 文件。

## 环境

- Magpie 0.1.1290（macOS arm64，`redact` 开启）
- Claude Code 2.1.303
- 路由：`claude/claude-sonnet-5-5`（主）、`claude/claude-haiku-5-5`（子代理），served 均为 Anthropic 原生模型

## 复现（A/B，同一提示词）

探针提示词：

```text
1. Use the Agent tool with run_in_background: true and subagent_type "general-purpose". Its prompt: "Run the bash command `echo PROBE_7Q3X_DONE` and reply with only its output."
2. Immediately after launching it, run the Bash command `sleep 45` in the foreground.
3. After the sleep returns, do NOT read any output file, do NOT use TaskOutput, do NOT call any other tool.
4. Answer on one line: `SEEN <notification text>` if a completion notification for the background agent is visible to you, otherwise `NOT_SEEN`.
```

- 经 Magpie：`claude -p --setting-sources project --model claude/claude-sonnet-5-5 --output-format stream-json --verbose < probe.txt`（`ANTHROPIC_BASE_URL` 指向 Magpie）
- 直连：同一命令，`env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN ...`，`--model claude-sonnet-5-5`，走 claude.ai 订阅登录（已核对该会话不在 Magpie routing 日志中）

| 路径 | 次数 | 结果 |
|---|---|---|
| 直连 | 2 | 2/2 `SEEN <task-notification>...` |
| 经 Magpie（含用户级设置） | 1 | `NOT_SEEN` |
| 经 Magpie（仅 project 设置，排除 hooks/插件） | 2 | 2/2 `NOT_SEEN` |

两边 stream-json 中客户端都发出了 `system/task_notification` 事件，且子代理都返回了 `PROBE_7Q3X_DONE`，差异只在网关。交互式会话中也多次复现（客户端 transcript 里通知以 `queued_command` 附件随下一次请求发出，但模型回复表明未看到）。

## routing 日志中的线索

`~/.config/magpie/routing/<date>.jsonl` 的 `prompt.parts` 分段统计（经 Magpie 的一次探针，主代理请求）：

```text
13:35:39 main  system=[environment 3388, prompt 2265]                 chat=290
13:36:30 main  system=[environment 3351, prompt 2241, harness 494]    results=[Agent 416, Bash 12]  chat=388
```

通知送达后的那次请求，`system` 段里**新出现一项 `harness`（≈494 tokens，与一条 task-notification 大小相当）**。交互式会话里也一样：通知到达那次请求的 `system.harness` 从 4251 跳到 4796（+545），相邻请求只变化个位数。

推测：Magpie 在改写请求时，把 user 消息里的 `<task-notification>` 当作 harness/系统注入文本识别出来，挪进了 system 段（或改变了形态），于是模型不再把它当作“刚到达的新事件”。这与 #1826（客户端插入的提醒被误判）可能是同一类问题。由于 routing 日志不含请求体，以上只能从分段统计推断，无法直接看到改写后的正文。

## 期望

`<task-notification>`（以及同类的后台任务事件）应保持在原来的 user 消息位置原样转发，不归入 system/harness。

## 临时绕过

主会话对后台任务改用阻塞等待 output 文件，不依赖完成通知。

