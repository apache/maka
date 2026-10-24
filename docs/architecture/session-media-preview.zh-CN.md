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

# 会话媒体接入与预览

## 分层

- `core/session-media` 定义执行器无关的输入（内联字节、来源地址）与有序内容项（文本、已保存图片、diff）。图片输出只携带当前 Session 的 Artifact 引用，不把 base64 放进消息事件。
- `ChatImageDeliveryService` 同时接收已完成正文中的 Markdown 图片和执行器的 `publish` 请求，复用读取边界、联网策略、并发队列、校验、存储配额、去重和 Artifact 保存。
- `PluginExecutorContext.publishMedia` 将外部执行器的输入交给 Host；ACP 适配层处理 image、resource_link、embedded resource，按到达顺序等待发布结果。
- `SessionMediaImage` 是正文与工具结果的公共组件。用户附件沿用同一字节读取器；产物面板复用同一图片源转换器和最终图片组件。

## 消息与兼容

正文中的结构化图片转换为 `maka://runtime/attachments/<artifactId>` Markdown 引用，沿用现有文本事件和历史格式，保留文字与图片顺序。工具结果新增 `content.parts`，允许文本、图片和 diff 混排。旧的 text、file_diff、image 结果保持可读。

混合工具结果属于新的 wire 内容类型，Runtime Host 兼容性 epoch 从 228 升为 229，避免旧客户端接收无法解码的结果。合并前需对照 main 重新确认 epoch。

复制会话时收集并重写混合内容里的图片引用。CLI 将混合内容按顺序输出为文本描述。没有媒体发布能力的执行器宿主显示明确的不可用描述；发布失败不会将二进制内容倾倒进正文。

取消或 ACP 连接失败时，适配层停止等待媒体发布，并完成已收到事件的收尾。已经开始的 Host 归档由其自身生命周期管理，迟到的发布结果不会再次写入已结束的 ACP 轮次。

文件写入操作本身不等于发布图片。生成的文件仍需通过 Markdown 图片引用或结构化媒体返回，才进入正文或工具结果预览。

## SVG

本地文件、下载内容和 ACP 内嵌 SVG 共用格式校验，原始文件保存为会话 Artifact。显示时从原始内容生成静态 SVG 预览，并通过图片元素加载，不注入应用 DOM。脚本、事件处理器、外部资源、动画、foreignObject、use 等不进入预览；允许基本几何、文本、渐变、受限行内样式和静态 class 样式规则。

完整的 `svg` 代码块在流式输出结束后提供预览、源码切换及静态预览下载。代码块的原始源码由现有消息历史保存，下载按钮下载经过处理的 SVG。原文件仍保存在会话 Artifact 中，不改变现有产物列表的可见性规则。

显示支持与模型输入支持分开：SVG 不自动成为模型的视觉输入。现有 raster MIME 校验继续用于模型输入。

## 性能约束

- 普通文本不导入 SVG XML 解析器；前端解析模块使用动态 import。
- 图片和 SVG 代码块在接近视口时才加载；流式 SVG 代码块只显示源码。
- 单条正文自动预览最多 3 个 SVG，每个自动预览源码最多 64 Ki 字符，总计最多 128 Ki 字符，超出后显示显式预览按钮。
- SVG 最大 256 Ki 字符、4,000 个保留元素、64 层深度。
- 会话图片读取合并并发请求；已读取图片缓存最多 32 项、8 Mi 字符，显式重试会重新读取。
- SVG 转换缓存最多 16 项、1 Mi 字符，重复消费复用转换结果。
- Host 复用原有最多 2 个并行捕获、128 个排队任务的限制；排队内联字节最多 8 MiB，单图片最多 2 MiB。
- ACP 按唯一媒体内容限制每轮保留的数量与数据总量；重复工具快照复用同一媒体对象，不重复扣减额度。媒体发布失败或超限转成有界文本提示。

## 验证入口

核心测试覆盖输入边界、SVG 净化和模型输入隔离；Host 测试覆盖重复发布、真实 MIME、原文件删除后回放、配额和联网失败；ACP 测试覆盖异步发布与混排顺序；UI 测试覆盖组件共用和重新挂载时的缓存读取。浏览器回归位于 `packages/ui/scripts/markdown-images.browser.test.mjs`，可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本地 Chromium。

## 局部性能基准

`node packages/ui/scripts/benchmark-session-media.mjs [git-ref]` 比较改动前后的正文图表预算扫描函数。每种输入运行 7 轮、每轮 3,000 次，取中位数。2026-10-22 本机对改动前 HEAD 的结果：普通正文 14.74 → 3.70 ms、图片 Markdown 4.73 → 0.50 ms、普通代码块 17.61 → 0.27 ms、Mermaid 5.91 → 6.10 ms。普通消息通过快速路径减少了分行分配；Mermaid 的每次差异约 0.06 微秒。此结果仅覆盖该函数，不代表真实长会话滚动帧率或应用整体启动性能。
