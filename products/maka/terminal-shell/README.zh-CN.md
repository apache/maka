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

# Maka NSH 终端界面

在终端中运行实验性的 [Maka 工作台](../workbench/README.zh-CN.md)（使用 NSH 构建的 Agent 工作台），支持鼠标与键盘操作，连接或启动 Maka Host Root。

NSH 源码位于 [`third-party/nsh`](../../../third-party/nsh/SOURCE.md)。Cargo 从这里构建运行时、TSX 打包器、`nsh-base` 组件和 UI 类型声明生成器，无需单独检出 NSH。相关的 NSH 与 Maka 修改在同一源码树中完成，并通过终端的[真实 Host 测试](tests/real_host.rs)一起验证：`cargo test -p maka-cli --no-default-features --test terminal_real_host`。

## 启动

在仓库根目录构建产品包，再通过 Maka CLI 启动终端界面：

```sh
npm run build --workspace @maka-agent/product
cargo run -p maka-cli
```

终端先发现并验证指定 Root 的在线 Host；没有在线 Host 时，使用当前 `maka` 可执行文件按既有部署配置启动。无需另开终端运行 `host serve`。默认业务 Host Root 为 `~/.maka/application/host`，可用 `--root /path/to/root` 指定其他路径。

安装后直接运行 `maka` 或 `maka terminal-shell`，终端界面与 CLI 使用同一个可执行文件。`--root` 指定 Root，`--session` 打开已有会话，`--help` 查看参数；相对 Root 路径按调用时的工作目录解析。

启动时会协商图片协议和显示尺寸。在 Linux（含 WSL）、macOS 和 Windows 上，终端提供所需能力时，整个界面通过 Kitty、Sixel 或 iTerm2 显示 GPU 渲染的像素帧；否则，同一个应用自动使用 Unicode 呈现。两种呈现方式都支持鼠标和键盘操作。像素界面自动跟随终端字体密度：每行对应 16 个逻辑像素，图像仍使用终端报告的完整物理分辨率。窗口或终端字号变化时，布局与指针坐标同步更新。

省略 `--session` 时，居中的输入区域会显示 **Choose workspace**，选择工作区后即可开始对话。添加 `--session SESSION_ID` 可直接打开已有会话。Host 必须提供 `agent`、`settings` 和 `receipts`。退出终端只关闭自己的连接，Host 按既有生命周期和空闲策略退出。

从首页 **Connections & models** 或侧栏 **Settings** 可添加连接和 API key、获取模型目录或手动添加模型 ID，并配置模型支持的推理档位及连接默认档位；全新 Host 也能直接在这里完成这些配置。点击 **Choose workspace** 或按 Ctrl+N，选择 Host 发布的目录。在已有会话中新建时，复用该会话已获授权的工作区。创建完成后打开 **Models**，选择连接、模型和推理档位，再发送消息。

**Sessions** 在宽终端中显示为可收起的侧栏，窗口较小时改为对话框；点击顶部的浏览按钮或按 Ctrl+O 打开。**New conversation** 位于紧凑的工作区范围、标题搜索和筛选区域上方，**Settings** 位于列表下方。拖动分隔线，或使用 **‹** / **›** 调整侧栏宽度。可浏览全部工作区、当前会话的精确工作区或项目。项目旁的 **+** 在其获授权目录中新建会话。独立 worktree 不一定属于父项目。快捷键仍然可用，界面不再常驻多行按键说明。

在会话标题栏或 **Commands** 中打开 **Files**，即可浏览该会话获准访问的工作区。文件和当前 Git 变更在会话自己的预览标签页中打开；空间充足时显示在右侧，否则使用对话框。目录更新会保留已请求的范围，滚动会自动加载后续页。切换会话会关闭其预览和监听，并保留会话草稿。

文件预览显示捕获的内容，**Refresh** 会重新读取当前文件。文本和图片捕获保留完整原始字节；二进制文件、链接及文件消失会明确提示。**Changes** 和每个 diff 都有独立的 **Refresh**，表示当前工作区的变更，不代表某一轮的交付物。diff 标签解析完整返回的补丁，并把长行分成显示行。工具结果中的图片标签仍读取 Host 保留的原始图片。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| Ctrl+P | 打开命令面板 **Commands** |
| Ctrl+O | 打开会话列表 **Sessions** |
| Ctrl+G | 打开 **Models**，选择模型和推理档位 |
| Ctrl+N | 新建会话 |
| Ctrl+L | 跳到最新消息 |
| Alt+↑ | 聚焦会话，滚动整个对话 |
| Alt+↓ | 展开并聚焦最新的过程组 |
| Tab | 切换控件 |
| Enter | 在消息输入框中发送、选择搜索结果，或激活已聚焦的控件 |
| Shift+Enter | 在输入框中换行 |
| Esc | 在 **Models** 内先返回上一级，再关闭；其他位置关闭浮层或已聚焦的侧栏，聚焦对话时请求停止 |
| Ctrl+C | 通过终端的 OSC 52 支持复制选中文本 |
| Ctrl+Q | 退出 |

模型选择使用 **Ctrl+G**，因为传统终端将 Ctrl+M 与 Enter 编码为同一个回车字符。粘贴请使用终端自身的粘贴命令。

在搜索框中输入关键词，使用 ↑/↓ 选择，Enter 激活。Sessions 在所选范围内按标题使用完整输入进行区分大小写的字面子串搜索；Host 在分页前应用搜索条件，不搜索消息正文、路径或 ID。模型搜索使用 Host 的模型目录。滚动或向下选择时会自动加载更多结果。

点击输入区域的模型名称或按 Ctrl+G 打开 **Models**，再选择 **Model** 或 **Effort**。推理档位来自所选模型公布的策略，仅在支持时显示 **Off**。**Default · Use connection default** 清除显式档位，跟随连接的默认策略；重新选择同一连接下的同一个模型会保留显式档位。在模型或档位列表中按 Escape 或点击 **Back** 返回菜单，再按 Escape 或点击 **Close** 关闭，焦点返回原控件，草稿和光标位置保持不变。

## 对话与交互请求

向上滚动时自动加载更早消息并保留阅读位置。每轮有独立的原生活动面板，高度受当前视口约束，可单独滚动。接近底部时跟随新增活动；向上滚动后保留阅读位置。已完成的轮次默认折叠，最终回答显示在面板外。激活轮次标题可展开或折叠。完成状态和最终回答的位置依据 Host 记录的轮次元数据，单次模型响应结束不会提前关闭仍在继续的轮次。重开轮次后，思考正文保留展开状态。工具详情按需读取；重开包含已展开工具详情的面板时，会从顶部重新读取。

**Todo** 位于输入区域上方，显示 Agent 的真实清单，包括当前事项和完成数量。Token 速度显示**上一次请求**的数据；上下文数据标明估算或最后已知值。没有可用数据时不显示相应指标。

助手回复支持标题、强调、列表、引用、表格和代码格式，每个代码块提供独立的 **Copy code**。**Show message source** 切换到可选择的原文，**Show formatted message** 恢复格式。历史片段在开头加载完整前保持原文显示。

Markdown 图片支持工作区相对路径和 HTTP(S) URL，并在正文中显示。工作区图片仍通过现有 Host 文件服务读取；网络图片由客户端的 NSH 原生加载器和缓存处理，应用只授予 HTTP(S) GET，每次重定向也检查权限。激活未带链接的图片可全屏查看，关闭或按 Escape 返回原图片并保留草稿；带链接的图片仍打开原链接目标。加载和失败都有明确提示，未带链接的失败图片可重试。原文模式和消息复制保留完整原始 Markdown。

用户消息经 Host 记录后提供 **Copy user message**；已完成的回复提供 **Copy message**、**Fork from this turn** 和 **View this turn's model usage**，并显示原文切换、已记录的模型与耗时。紧凑的图标操作始终可用，配有完整的悬浮提示和无障碍名称。两种消息复制即使在历史窗口只显示末尾时也会读取完整原始消息。Fork 将历史复制到该回复所在轮次的完成边界，打开独立会话，原草稿仍留在原会话；后续轮次正在运行时，也可以从更早的已完成轮次分叉。Usage 读取原始记录中的本轮主模型请求，分别显示输入、输出、推理、缓存 token 与已记录的费用；缺失的计数或价格明确显示不可用。复制或导入的历史不会产生新的实体模型费用记录。

展开包含图片的工具结果可查看缩略图，激活 **Open image** 可打开较大的预览。Escape 或 **Close** 返回对话并恢复焦点，不会停止当前运行。两处都使用 Host 保留的原始图片，即使工作区文件后来改变也不受影响。在 Unicode 呈现中，内嵌图片在 Sixel 支持和字符单元像素尺寸均可用时使用 Sixel，否则使用彩色 Unicode 半块和象限块。调整窗口大小后，旧测量失效，图片暂时使用 Unicode，等待原查询的回复全部消费后再重新测量；新查询完成后恢复 Sixel。等待终端回复不会阻塞 Unicode 呈现或输入。不支持的图片格式会在结果中显示错误。

打开待处理请求可查看其原始详情：

- 工具审批支持针对该次调用 **Allow** 或 **Deny**；允许前需读完全部原始参数。
- 附加权限支持 **Allow** 或 **Deny**，可选择请求提供的单次调用、当前轮次或当前会话范围。
- 问题支持已有选项、**Other answer** 和显式 **Skip**。
- 表单可填写并提交请求的字段，提供校验与敏感值遮蔽，也可显式 **Decline** 或 **Cancel request**。
- 计算机访问请求会先显示原始目标和权限边界，再由你明确允许或拒绝。

使用 Tab 切换请求控件、Enter 激活。审批、权限和问题可用 Ctrl+Enter 允许或提交答案；Ctrl+R 刷新已记录状态。Escape 只关闭请求视图，未回答的请求仍保持待处理。其他客户端先作答时，以显示的已记录结果为准。

## 保存状态与运行边界

草稿和操作回执保存在 `<root>/clients/terminal.sqlite`。每个会话保留自己的草稿，恢复使用原始 Host 与操作。切换会话前先保存当前草稿。恢复从最近一次确认保存的 revision 开始，之后未保存的输入可能在关闭时丢失。发送使用该已保存 revision；结果不明确时，请使用原操作恢复入口，避免重复提交。

可执行文件验证所选 Root 和在线 Host epoch。Ctrl+Q，以及 Unix 上的 SIGTERM，可独立于 JavaScript 和终端输出请求退出。退出时尝试恢复终端并关闭所拥有的 Host 请求和任务；清理未完成会返回错误。
