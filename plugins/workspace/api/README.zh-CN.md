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

# maka-workspace-api

[English](README.md)

定义工作区文件、进程、终端、协议进程和 Decisions API 的共用契约。原生提供方与开发工具使用相同声明。请求路径和工作区标识用于描述选择；提供方仍需检查实际绑定目录和调用权限。

`Files.readText` 在调用方原始 invocation 权限内读取工作区文本、Session 附件及归档工具结果，接受返回的完整 `next` 对象续读；地址不授予跨 Session 访问权限。Agent 工具描述使用选定工具的实际名称说明这项能力。`readImage` 不读取工具结果归档。

Terminal 契约提供 `readOutput` 和 `watchOutput`，完整保留原 live resource 的有序 PTY 字节（Base64）及原生尺寸变化。相邻 Data 在 64 KiB 编码后订阅 Item 预算内合并（扣除封装及 Base64 开销后约 48 KiB 原始字节），资源持有期间保留全部事件。Data 的序号是最后一个已消费原始记录的游标，因此可跳号；每个 Resize 仍单独交付。`after` 必须与原始目标一起保留；已交付批次内部的原始游标也仍指向准确的后续字节。新 parser 直接订阅 `watchOutput(after: 0)`，按首个保留事件的 `initialSize` 初始化一次，再依序处理全部 Data/Resize；状态完整的 parser 可从已知序号继续。已取得的 reader 可在 worker 退休后排完数据，但退休或 Host 重启后的新接入返回 `Unavailable`；先前的 `readOutput` 不为后续请求保活。真实 replay I/O 错误使调用失败。保留的显示画面和纯文本屏幕都不是 parser checkpoint。`Closed` 只表示字节源关闭，不代表进程清理已确认。输出观察需要显式方法权限，不需要控制器。


对于已结束的 PTY，`readDisplay` 是传输单个持久化 revision 的有限订阅：`begin` 提供尺寸、光标、调色板和输入模式元数据，按序的 `rows` 提供带样式的物理单元格，`end` 表示画面传输完成。`begin` 和 `rows` 作为流条目发送，唯一的 `end` 作为订阅的最终成功结果返回。接收方应暂存分片，仅在 `end` 后整体替换画面；未完成或已取消的传输直接丢弃。Desktop 在 `watchOutput` 返回 `Unavailable` 后使用它，保留退休及 Host 重启后的颜色和彩色空格，且不会从这些单元格继续原始 parser。`read`/`watch` 仍提供有界的纯文本模型预览，与显示保留量独立。

原生历史按 800,000 个单元格保留（80 列时为 10,000 行），在缩放重排前调整额度。尺寸允许 2–1,024 列、1–1,024 行，可见单元格总数不超过 65,536。编码后的显示数据优先保留当前和上次备用屏幕，再在 64 MiB 内保留最新的完整历史行；省略历史时标记 truncated。这替代了旧的 500 行及整条记录 4 MiB 限制。已有纯文本终端记录执行一次性迁移，保留已知文字并使用默认样式；过去已丢失的颜色无法恢复。资源策略见[显示类型](../../agent/facts/src/terminal/display.rs)和[原生尺寸](../../agent/facts/src/terminal.rs)。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
