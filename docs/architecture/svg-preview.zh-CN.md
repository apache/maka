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

# SVG 静态预览

本变更补齐已有图片归档链路的 SVG 格式，以及 Markdown 中 SVG 代码块的显示，不修改 ACP 执行器或工具结果协议。原始文件保存为会话 Artifact，预览和下载使用处理后的静态 SVG。

## 显示策略

本地文件和下载内容共用 SVG 格式校验，原始文件保存为会话 Artifact。显示时从原始内容生成静态 SVG 预览，并通过图片元素加载，不注入应用 DOM。脚本、事件处理器、外部资源、动画、foreignObject、use 等不进入预览；允许基本几何、文本、渐变、受限行内样式和静态 class 样式规则。

完整的 `svg` 代码块，以及文档根元素为 `<svg>` 的 `xml` 代码块，在流式输出结束后提供预览、源码切换及静态预览下载。`xml` 的根元素候选检测不会加载解析器；真正显示前仍由共享 SVG 校验器验证完整文档。普通 XML 继续显示源码。代码块的原始源码由现有消息历史保存，下载按钮下载经过处理的 SVG。原文件仍保存在会话 Artifact 中，不改变现有产物列表的可见性规则。

显示支持与模型输入支持分开：SVG 不自动成为模型的视觉输入。现有 raster MIME 校验继续用于模型输入。

## 性能约束

- 普通文本不导入 SVG XML 解析器；前端解析模块使用动态 import。
- 图片和 SVG 代码块在接近视口时才加载；流式 SVG 代码块只显示源码。
- 单条正文自动预览最多 3 个 SVG，每个自动预览源码最多 64 Ki 字符，总计最多 128 Ki 字符，超出后显示显式预览按钮。预算在 Markdown 解析后的代码节点上按文档顺序计算，覆盖引用块和列表，`svg` 与 SVG 内容的 `xml` 共用预算；不改写消息源码。
- SVG 源码超过 20,000 字符时保留完整文本和复制，但不生成语法高亮节点；该限制同时覆盖惰性模块加载占位、手动源码与复杂度拒绝后的降级显示，避免虚拟滚动重复挂载大量 token 节点。
- SVG 最大 256 Ki 字符；在净化修改 DOM 之前，检查整棵输入树最多 4,000 个元素、8,000 个总节点、64 层元素深度，包括之后会被删除的元素、子树、注释和处理指令，避免逐个删除大量兄弟节点造成二次复杂度。总节点预算保留正常缩进空白的空间。静态 CSS 的注释和规则提取使用线性扫描，未闭合注释之后的内容不进入预览。
- 会话图片读取合并并发请求；已读取图片缓存最多 32 项、8 Mi 字符，显式重试会重新读取。
- SVG 转换缓存最多 16 项、1 Mi 字符，重复消费复用转换结果。
## 局部性能基准

`node packages/ui/scripts/benchmark-session-media.mjs` 对比 Markdown 解析不带/带图表预算插件的成本。每种输入运行 7 轮、每轮 3,000 次，取中位数，覆盖普通正文、图片、代码、Mermaid、引用块 SVG 和 XML SVG。此基准不加载 XML 解析器、不生成图片，不代表真实长会话滚动帧率或应用整体启动性能。此前的源码预算扫描器已由 AST 插件替代，旧扫描器的性能数据不再代表当前实现。
