<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# maka-tools

[English](README.md)

带日志结算的工具派发与 Code Mode，设计参考 [OpenAI Codex](https://github.com/openai/codex)。
工具目录、权限与执行事实的权威始终在 JavaScript 之外。

## Code Mode

在连接的模型参数中设置 Code Mode 和 `apply_patch`。自动采用 Host 的模型默认值；
明确选择从新 Run 生效，续跑和交接保留已准入的选择。
开启 `apply_patch` 时替代 `Edit`、`Write`，关闭时使用这两个结构化编辑工具。

OpenAI Responses 以 freeform `exec` 接收原始 JavaScript；Chat、Anthropic、明文
OpenResponses 用 `{code, yield_time_ms?, max_output_tokens?}` 包装相同源码。
也可通过首行 `// @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}` 设置选项，
同一选项只能在 pragma 或 JSON 包装中指定一次。

源码按 async ES module 执行，允许顶层 `await`，不允许顶层 `return` 或 imports，
用辅助函数输出。每个 cell 使用独立 V8 isolate，不开放 Node、文件系统、网络、
console 或共享内存全局对象。独立 `maka code` 命令与 Rust 函数体嵌入 API 保留原有
返回值契约；它们不是模型调用的 exec 工具。

`wait({cell_id, yield_time_ms?, max_tokens?, terminate?})` 观察运行中的 cell。
exec 默认观察 30000 ms，wait 默认 10000 ms，默认输出预算均为 10000 tokens。
wait 输入仍接受旧拼写 `max_output_tokens`，但不再向模型提供该拼写。
结果区分 `running`、`completed`、`terminated`，每次只返回新增输出。
终止表示请求取消，不表示清理已经完成。

提供 `text`、`image`、`audio`、`generatedImage`、`notify`、`yield_control`、
`store`、`load`、`setTimeout`、`clearTimeout`、`exit` 和 `ALL_TOOLS`。
图片接受 Host 图片引用、MCP 图片块或 base64 data URL。
`image` 第二参数覆盖内嵌 `detail` 或 `codex/imageDetail` 元数据，支持
auto/low/high/original，贯穿证据保存与模型投影。
音频保存为受保护的 session 证据，并作为原生输入发送：Responses 使用
`input_audio.audio_url`，Chat 把 WAV/MP3 放在完整工具结果组之后的用户内容块中。
适配器或格式不支持时提供明确提示，仍保留字节。PCM WAV 短于 25 ms 时使用与 Codex
一致的省略提示。

`notify` 独立追加与原 exec 关联的输出，不 yield、不结束 cell，也不依赖 wait。
模型推理期间到达的通知在下一步交付；即使当前答复没有工具调用，尚未观察的通知也会
触发后续推理。原生 Responses 使用额外的 custom tool output，包括 WebSocket 增量请求；
JSON-only 协议使用带来源标记的观察消息。通知事实不结算工具效果；提交失败会取消并
等待 cell 收尾。Run 关闭时拒收迟到通知。
这些辅助函数不授予文件、网络或客户端权限。

每个 Run 最多持有四个尚未收取最终结果的 cell。工具沿 cell 捕获的目录执行，
仍经过正常准入和日志结算。完整的已授权可嵌套目录在 cell 内可调用；延迟工具仅省略
提示词展开说明，`ALL_TOOLS` 包含其元数据和 TypeScript 声明，可在同一 cell 中发现并调用。
名称规范化为 JS identifier，名称碰撞会在执行任何效果前拒绝 cell；DirectOnly 工具不进入
`tools`。声明使用输入及可选输出 schema，说明本身不是校验器。
Direct 模式保留搜索后在下一模型步骤激活的行为。

每个 cell 限制源码 64 KiB、V8 堆 64 MiB、同步执行时间 30 秒、
工具调用 32 次、同时运行的工具 8 个。超出并发数的调用在总调用预算内排队。
异步 Host 等待不消耗同步执行预算。输出与 JSON 临时数据均有大小上限；
V8 堆限制不是进程隔离。
取消 timer 会释放名额并取消 sleep。模块结束后取消未 await 的工作，再等待已接受的
Host 效果结算；取消不能撤销已经发生的副作用。

JSON 临时数据属于活跃 session，不持久化，也不是权限存储。cell 读取快照，结算后发布
写入，同一键以后完成的写入为准。跨 Turn、压缩和同一 Host 的 handoff 保留临时数据，
session 退役或 Host 重启后释放。不保留 JS globals 或权限。

对齐基准：官方 `openai/codex` commit `4b1c0c30dabd08fed7d6523844f9156d982eb297`，实现独立编写。

## 生命周期

模型调用的 `exec` 是控制操作；独立记账的 `CodeCell` 拥有嵌套 `CodeMode` 操作。
控制调用可以先结束，cell 必须等待已接受的子工具结算后才能结束。

关闭 Run 或日志前须调用 `RunTools::shutdown`：取消 cell、等待已接受工作收尾，
并传递持久化或清理状态不明的错误。丢弃 `RunTools` 只发出取消，不能异步等待清理。
交接只封存 cell 已停止执行的边界。恢复不会重放中断的 cell，也不会静默重复其副作用。
