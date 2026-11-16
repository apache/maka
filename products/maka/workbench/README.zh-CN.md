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

# Maka 工作台

共享 NSH 客户端运行时与 Maka 默认 UI 包。原生 bindings（`src/bindings.rs`）将可信 UI 代码连接到公共 Host。[package.ts](package.ts) 声明普通包 `maka.workbench`，其 `root` 贡献由 `app/App.tsx` 实现。Markdown 使用 `nsh/base` 的 `TextView` 渲染。

Mermaid 围栏代码块通过 Pele 在本地绘制。Markdown 仍由 `TextView` 负责，按语言扩展显示图表。Maka 落实 SVG 主题颜色，并在阻塞工作线程上使用本机字体把标签转为矢量路径，再交给 NSH 原有的图片加载器，不修改内置 NSH。流式修改会合并处理；可查看并复制源码，语法错误时保留源码。终端显示代码块。不启用图表链接、外部图片或 JavaScript 回调。更新按显示帧调度，转换进行中只保留最新输入。Maka 显式关闭 Pele 的源码、输出和边数限额，不额外设置 SVG 字节数或变量深度上限；NSH 图片加载器原有的约束仍然适用。

`spec` 围栏代码块基于 `@json-render/core` 与 `@json-render/directives` 在对话消息流内嵌渲染交互式生成式 UI。`SpecSession` 增量编译流式 RFC 6902 JSONL 补丁，并在 `TextView` 更新期间保留用户在本地修改的状态；`SpecRenderer` 在桌面与终端两端直接挂载原生 NSH 组件与 `nsh/base/plot` 图表。状态绑定、动态指令、表单校验、监听器与内置动作全部在客户端本地执行，不会反向驱动 Agent 或发起 Host 业务变更；生成规范由内置 `maka-generative-ui` 技能提供。

crate 只打包通用加载器 `app/Bootstrap.tsx`。shell 连接 Host，用 `host::admit` 接入，为该连接创建 `bindings::Bindings`，通过 `configuration` 提供视口、环境和数据目录。bootstrap 加载部署来源通过 `ui: { path, id }` 选择的完整 UI。默认产品选择 Maka 根界面，使用其他 UI 插件共用的不可变包构建流程，将它编译为包中的 `app/App.js`。自定义根界面拥有自己的导航、布局和交互；缺少根入口时不会加载 Maka。[终端 shell](../terminal-shell/README.zh-CN.md) 和[桌面 shell](../desktop-shell/README.zh-CN.md) 使用相同的加载器与原生运行时。在图形桌面上，默认根界面使用 `app/chrome.ts` 让顶部栏充当标题栏，并设置应用菜单。

侧边会话保留各自的模型、草稿和工作区。会话级菜单操作与快捷键一样，作用于原生键盘焦点所在的会话面板。文件和图片请求携带来源会话，交给窗口共用的工作区预览区；从另一会话打开资源时，会替换预览区的标签页，不会切换任何会话。外部 URL 不改变预览区。工作区视图输入明确列出已挂载会话，不再隐式选中主会话。

已安装 UI 作为可信代码运行在共享 NSH VM 中，可使用动态 JavaScript 求值与原型扩展，以及 NSH 支持的 HTTP 方法、WebSocket、剪贴板、文件选择器、打开 URL、已注册的 Host 函数、完整 Maka 原生客户端和声明的服务。原始 TCP、进程、文件系统和环境访问遵循 NSH 原生 API 的规则。

在新目录中生成当前 NSH 和原生 Host 的声明，然后用 TypeScript 检查实际应用：

```sh
cargo run --locked -p maka-workbench --example ui_types -- /tmp/maka-workbench-types
tsc -p /tmp/maka-workbench-types/tsconfig.json --noEmit --skipLibCheck false
```

该 example 从 UI 包使用的同一份 NSH 源码和原生 registry 生成声明。生成的 TypeScript 项目包含 `Bootstrap.tsx`、`App.tsx` 和 Computer 权限组件，也检查它们实际导入的文件。它不会连接 Host 或打开桌面。请使用尚不存在的输出目录，以及与当前 `nsh check` 工具链兼容的 TypeScript 编译器。

[真实 Host 测试 fixture](../terminal-shell/tests/real_host/support.rs) 对实际的 `maka/host` registry 调用 `nsh_core::element::declarations`，将 `host.d.ts` 写入 `MAKA_NSH_EVIDENCE` 指定的目录。可在仓库根目录运行 CI 同样选取的模型搜索测试来收集它：

```sh
MAKA_NSH_EVIDENCE=/tmp/maka-nsh-evidence cargo nextest run --locked --workspace \
  -E 'package(=maka-cli) & binary(=integration) & test(=terminal::keyboard::model_and_source_search_preserves_focus_and_keyboard_selection)'
```

这会运行真实 Host 测试，不是独立的类型生成器，也不对应用做 TypeScript 类型检查。

输入框上方的目标、任务、计算机访问和队列消息共用一个可折叠详情区；桌面端贴合输入框卡片上沿向上展开，使开关保持在原位。目标详情及操作在面板内展开；`/goal` 仍可打开创建和管理对话框。收起时保留摘要，任务清单可按当前列表隐藏，直至智能体写入不同的任务清单后重新显示；数据更新不会自动展开或切换当前查看的内容，切换详情保留尚未提交的队列编辑。待处理审批和未确认操作的恢复入口保持独立。已完成的操作反馈会在四秒后消失。检查原操作只会读取其回执；仍无法确认结果时，可以忽略提示，原始记录会保留，操作不会因此被取消或重新执行。

在会话操作菜单中选择 **置顶会话**，会话会出现在列表顶部的 **已置顶** 分组；选择 **取消置顶** 可恢复普通列表位置。Host 持久化这一选择，并在不同界面和重启后保持一致的分页顺序。

**执行过程**按顺序显示会话里的执行记录，包括只发出工具调用、或输出文字前就失败的模型请求。点击记录查看详情。模型请求显示已记录的时间、首 Token 耗时、用量和上下文上限，工具详情可以查看原始参数和结果。点击时间轴可跳到对应轮次或请求，拖选可按时段过滤，也可以放大查看短时间内的活动。搜索覆盖已加载的记录，包括已收起的轮次和子调用。用“加载更早的记录”可以继续查。

在桌面端编辑一条用户消息时，编辑框直接出现在消息原来的位置，发送之前不会创建任何东西。发送时，对话在这条消息所在的轮次之前分叉，打开分叉并在其中发送编辑后的文字；原对话保持不变。按 Esc 或“取消”关闭编辑框；分叉失败时，编辑过的文字会保留。带附件或引用的消息会立即分叉，并把文字放进分叉的输入框，附件和引用可以在那里重新添加。

侧栏操作菜单中的**子会话**打开独立树形窗口，不让深层级挤占侧栏。展开箭头按需加载子会话，包括归档会话和其他工作区中的子会话；点击标题打开对应会话。分支沿用现有会话目录分页，层级较深时可横向滚动。创建关系来自 `parentSessionId`，与 fork 的历史来源独立。

**设置 → 技能**可从 GitHub `owner/repository`、Git URL、GitHub 子目录 URL，或所连接 Host 上的目录发现技能。选择技能后，可安装到全局或项目的 `.agents/skills`、`.maka/skills`。同名技能按项目 `.maka`、项目 `.agents`、全局 `.maka`、全局 `.agents` 的顺序整体覆盖；卡片保留每个位置的实例并标明是否生效。删除高优先级实例后，下一层自动生效。

只有通过 Maka 安装的技能显示更新按钮。更新从登记的来源替换整个目录及其资源，并覆盖本地修改。四个标准目录中的其他技能同样可以查看和删除。来源登记保存在 Host 数据库中，不创建 npx lockfile 或另一套私有技能副本。

**设置 → MCP 服务器**通过命令和 HTTP 表单管理上述四个目录的 `mcp.json`，保留其他条目和自定义字段。选择项目无需创建会话。下载、文件修改和来源登记均在所连接的 Host 上完成；保存项目 MCP 配置不会自动授予信任。

**设置 → 连接与模型** 将提供商登录、连接信息和模型列表放在一起。新建或修改连接后，可以一次完成保存并登录。设备登录会打开浏览器，对话框保留验证码、复制和取消操作。登录成功后，获取模型失败可以单独重试。高级连接与模型选项折叠显示；已保存的连接可以重新加载外部更改，返回时会确认是否放弃未保存的编辑。

提供商列表按账号登录、自定义接口和命名 API 服务分组，组内按名称排序。搜索支持多个词、方向键和 Enter，Esc 先清空搜索再返回。从新连接返回时保留搜索和选择；再次添加连接时，会在已加载的连接中避开重复标识。

内置订阅、兼容接口和地区标签随界面语言显示；提供商搜索同时匹配原文和译文。已保存的连接名称、品牌名、模型 ID 和推理档位保留原样。

## 图标

`app/Icon.tsx` 保留 Workbench 名称 API 和终端字符。桌面/Web 使用
`app/lucide.ts` 中的 Lucide 子集，采用 24 点网格、2 点圆端描边。
play、pause、stop 保持填充，unread 保留小实心圆点。上下文仪表、任务进度扇形、回合导航轨道和
选择控件指示器继续使用表达数据或控件状态的专用绘制。

重新生成前先安装仓库 npm 工具，在仓库外解压 npm 的 `lucide-static` 1.61.0：

```sh
python3 -I products/maka/workbench/scripts/lucide.py /path/to/package/icon-nodes.json
```

脚本校验输入摘要并用仓库 Biome 格式化输出。产品仅打包选中几何数据，没有新增
Lucide 运行时依赖。映射维护在 `Icon.tsx`，例如 refresh → refresh-cw、edit → pencil、
activity → clock、nowrap → move-right。来源见 LICENSE、NOTICE 和来源审计。

Lucide 没有对应的 Markdown 标记，因此保留 M/向下箭头，并适配同一网格。

### 终端图标

`Icon.tsx` 的每个条目在同一个 Workbench 名称下配对 Lucide 名称和终端字符。
两项都必须填写，TypeScript 会校验 Lucide 名称是否存在于打包的几何数据中。
当前所有名称都有字符；本次迁移保留原字符及终端固定的 16 × 16 布局，终端忽略
图形界面的 `size` 参数。

TUI 图标继续使用文本，按动作或状态选择字符，不从 Lucide 名称自动推导。
例如 activity、thinking、loader 都使用 `◌`，statusSuccess 使用不带 Lucide 外圈的 `✓`。
加载、回合导航和选择指示器保留各自的终端文本与布局。

不要求图标字体，也不自动检测字体并替换字符。现有文件夹、文件、图钉、回形针等 emoji
依赖用户终端的字体与字符单元宽度处理，外观可能与图形界面不同。新增图标时同时填写两项，
优先选择含义清晰且不依赖字体私用区码点的文本符号；修改已有字符前，在终端实际上下文中
检查裁切、对齐和含义。Lucide 名称没有可自动转换的 Unicode 等价字符。

## 外部 Agent

打开**设置 → 外部 Agent**，也可以从模型选择器进入。仅提供 Antigravity、Codex 和 Claude Code，默认全部关闭。列出未启用项不启动探测。每次启用都需要重新确认原生完全访问权限，并更新会话 Agent。停用会保留原生启动设置和登录状态。启用 Antigravity 后，Maka 会为每次私有运行安装命令标题 hook，运行结束就卸载。

CLI 使用 Maka 沙箱之外的原生工具、账号和完全访问权限；Maka Host 工具仍遵守已有授权与原始回执。请使用各 CLI 原生流程安装、初始化和登录，再点击**刷新**；不再提供 SDK 安装器或自动更新。Claude 使用交互式 PTY，不走 print 模式。

展开**详情**查看安装、认证和模型诊断。原生协议模型发现与单模型校验共享有界缓存；外部运行时不可用不会移除原生模型选项。Claude 无法发现模型列表时使用其已配置的原生默认模型。
