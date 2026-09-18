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

# Desktop 文件聚焦预览与同一会话输入

日期：2026-09-18。关联 issue：[apache/maka#5469](https://github.com/apache/maka/issues/5469)；工作区 Markdown 引用入口另见 [#2664](https://github.com/apache/maka/issues/2664)。

## 证据边界

- 用户截图直接展示：左侧会话与右侧 Markdown 文件并列；文件聚焦时会话列消失、文件变宽；文件/网页上可出现浮动输入框。这里的“全屏”是**内容区聚焦**，不是操作系统窗口全屏。截图不能证明拖动的具体事件、持久化方式或所有文件类型的实现。
- 本机 Codex 26.908.70816 的安装包 `app.asar`（只读检查，未复制其代码）保留打包模块名：`artifact-tab-content.electron-*`、`artifact-preview-header-*`、`pdf-preview-panel-*`、`docx-preview-panel-*`、`notebook-preview-panel-*`、`right-panel-composer-overlay-*`、`cloud-browser-preview-*`。模块经过压缩，源码映射不在安装包内；这些名称及片段只能证实专用入口和浮层存在，不能推断所有交互细节。
- `library-file-preview-kind-*` 的可读分派先按图片/PDF，再按 CSV、TSV、DOCX、PPTX、XLSX 等结构化 artifact，之后是 Markdown、HTML、普通文本，最后 unsupported。分派与渲染实现不能混为一谈；例如从扩展名进入 artifact 分支，不意味着本地任意文件可预览。
- `right-panel-composer-overlay-*` 可见浮层的显示/隐藏控件、滚轮处理、焦点/指针隔离；`right-panel-composer-overlay-alignment-*` 测量目标左边界和宽度。Maka 应重建等价的**用户结果**，不复刻打包实现或私有协议。
- OpenAI 官方 [Artifact Viewer 文档](https://developers.openai.com/zh-Hans/docs/artifacts-viewer) 概述预览能力，但不能代替截图及当前安装包对 Desktop 具体行为的验证。

## Maka 当前能力与缺口

| 内容 | 现有路径 | 聚焦后应保持/补齐 | 风险边界 |
| --- | --- | --- | --- |
| Markdown | `ArtifactPreview` 的 `MarkdownBody`/源码切换 | 保持滚动、阅读行宽、源码状态；预览填满内容区 | 读取上限、Markdown 内链接策略不变 |
| 代码/文本 | 有界 `CodeBlock`、语法/行号、纯文本余量 | 长行自身横滚，不撑开窗口；顶部元信息紧凑 | 不为聚焦解除 256 KiB 展示上限 |
| Diff | `DiffCodePreview` 与行数上限 | 保持差异颜色和独立滚动 | 不改变 diff 内容/提交语义 |
| HTML | 无同源权限的沙箱 iframe | iframe 随可用区域伸展、明确外链受限 | 不放宽 `sandbox`、不开放导航/弹窗 |
| 图片 | MIME 白名单与预读/读后大小上限，`object-fit: contain` | 聚焦时居中完整展示，不裁切；可按自身尺寸滚动 | 不新增 SVG 脚本或无上限 data URL |
| PDF | 二进制读取后 `<embed>`，不可用时回退 | 使用聚焦空间，并保留不可用回退 | 不越过主进程读取/大小限制 |
| 浏览器网页 | `BrowserPanel` 的 Electron `WebContentsView` | 聚焦后页面宽度变化；输入区仍可操作 | 原生视图在 DOM 上层，不能仅用 z-index 覆盖；需从 viewport 中让出输入空间 |
| DOCX / XLSX / PPTX / CSV / notebook | 当前 artifact 类型没有相应专用渲染器；Office 现有 `kind=file` 入口明确回退，不做文本读取/复制 | 后续按类型引入受限解析器、虚拟化、分页/工作表/代码单元 UI | 不把二进制当 UTF-8；不得把外部文档交给未授权网络服务 |

依据：`packages/core/src/artifacts.ts`（五种 artifact kind、图片白名单）、`apps/desktop/src/renderer/features/workbar/tools/artifacts/artifact-preview.tsx`、`artifact-preview-registry-shell.tsx`、`tools/browser/browser-panel.tsx`。现有 Files 列宽限制 340–600px；`app-shell.tsx` 把唯一的 `ChatComposerRegion` 挂在 `.mainColumn` 的 `ChatSurfaceLayout` 内，右侧 `WorkbarHost` 是兄弟节点。`#2664` 负责“从消息打开工作区 Markdown”，本任务不绕开它直接从 renderer 读取路径。

## 交互合同

1. Files 选中可预览文件或打开 Browser 面板时，在面板顶部提供聚焦/还原图标（名称、`aria-pressed`、键盘可达）；只展开**当前内容区**。Browser 空白页也可聚焦，方便直接在浮动输入框中开始任务；Files 列表仍不提供文件聚焦。
2. 聚焦后隐藏左侧会话**内容列**，右侧原面板占可用宽度。唯一的会话输入实例保留在树中，浮于阅读区底部并与内容保持安全留白；发送、停止、附件、引用、交互请求和草稿的 owner 不变。还原后重新显示会话及其原滚动位置，不重新加载文件。
3. 输入区在文件/网页上使用稳定最大宽度；短窗口不能盖住标题/全部内容，窄窗口占满可用宽度。页面滚轮与输入区滚轮各自正确工作，鼠标滚过输入区外应继续阅读。聚焦期间原生 Browser 的 viewport 不得盖住输入区。
4. 面板关闭、返回文件列表、会话切换、选中其他 workbar 工具、窗口尺寸变化时退出聚焦或安全投影为普通布局。不能留下不可交互透明遮罩、旧会话输入框或错目标发送。
5. “把输入框拖进文件”的手势应有显式非拖动替代。拖动只改变**展示位置**，不是文件上传；禁用在消息正文上拖动文本而意外触发此模式。先做聚焦模式及可访问的输入区切换，再通过同一展示状态接入拖放手势。
6. 聚焦时输入区上方常驻共享进度卡片：运行中显示处理状态/可用时的分秒时长，展开后只读地跟随最近一次 turn 的文字与工具活动；结束后入口变为“最近一条”，展开显示该 turn 最后已落盘的助手回复。收起保留入口与草稿，展开内容独立滚动；用户向上阅读时不强制追尾。文件和网页共用这一层。
7. 四态必须保持截图中的同一锚点与宽度：运行中收起为输入卡片上沿的状态、时长和两行摘要；运行中展开为盖在文件内容之上的宽幅、有高度上限的对话流；完成后收起变为“最近一条”和回复摘要；完成后展开显示多段最终回复。上层与真实输入卡片边缘贴合，带附件时附件抽屉也是同一连续表面，不做间隔卡片；聚焦时仍使用真实 Composer 的附件、模型、权限与停止/发送控件。
8. 实际内容列足够宽且无附加上下文的聚焦 Composer 使用紧凑单行（加号、输入、模型、权限、发送/停止）；窄窗、被侧栏挤窄的内容列与附件抽屉回到原有可增长布局。长草稿不能被剪掉或让模型/发送控件越界；折叠最近回复不改变输入 DOM 与草稿。
9. 文件/网页滚到末尾时，最后一行必须高于整个浮层。浮层变高时按真实测量同步增加可滚动尾部留白；需要专心阅读时可收起输入区，只保留右下角可键盘操作的恢复入口。收起不卸载 Composer，不丢附件、草稿或最近一条的展开状态；恢复时回到原位置。不要为了减少遮挡把浮层拖出视窗下边缘。

## 实现边界

- 完整原生体验与逐步截图见 [交互验收图解](images/pr/desktop-focused-preview/native-journey/README.md)。拖动聚焦后回到原编辑器，临界位置显示松手提示；Browser 的 Escape 先撤销未提交地址，在工具栏上则还原分栏。
- 中断回合没有最终落盘助手消息时，保留已有的有界 live projection 并标记“本轮已中断”。只读观察器跟随当前 Files/Browser 面板生命周期，分栏时不渲染回复 DOM，切回聚焦仍可看到本次收到的部分内容；不另建持久化消息缓存。
- 分隔线向左拖动时，预览临时跟随鼠标突破普通工作栏的宽度上限；左侧剩余空间不超过 240px 时标记收起意图，松手进入同一个聚焦态。往回拖会撤销意图，取消或切换任务/标签会清理临时宽度；聚焦不保存这个临时宽度，还原仍使用原分栏宽度。WorkHub 和其他工具保持普通 resize 行为。
- 原生窗口聚焦后，任务标题和窗口控件保留第一行，工作栏标签放在下一行，网页/文件内容同步避让。共享卡片的状态整行可点击，次要按钮采用 28px 点击区域；最小化状态直接显示“继续输入”。
- 本地验收：以隔离资料目录启动 Electron 开发版，实际拖动空白 Browser 分隔线、收起/恢复输入区、还原分栏，确认草稿保留与标题区不重叠。Storybook 的 `BrowserDividerFocus` 覆盖拖动回退和聚焦/还原路径，使用生产布局 reducer。
- WorkHub 原生浮窗和聚焦预览共用 `@maka/ui` 的 `ProgressCard`：品牌、活动状态、两行摘要和 Astryx 操作按钮只有一份实现和样式。`WorkHubProgressCard` 保留控制状态、窗口 ready/hide 与摘要选取；`RecentTurnOverlay` 保留会话订阅、落盘读取和展开内容。原生窗口拖动区域只由 WorkHub 外层设置，聚焦预览不引入原生窗口控制。
- 复用消融：移除原来两套卡片头部与按钮样式，并删除 WorkHub 外层重复的 flex、间距、padding 和文字颜色；共享样式已足够。保留两边必要的定位与高度测量，使用已有 Storybook 交互验证输入 DOM、草稿、焦点和阅读留白。
- 布局状态由 `WorkbarHost` 负责，以当前 session + 右侧面板目标约束；不写入 Runtime/Artifact 模型，不创建第二个 Composer。它把聚焦控制传给 Files/Browser，并在布局根节点投影聚焦属性。Browser 仍由原生 viewport 同步定位，不能将其当 iframe。
- Files 保持现有 `ArtifactPane` 和各类预览实例；改变容器布局，不为每种类型造一套“全屏”分支。类型专属细节分别修补 Markdown 阅读宽度、代码横滚、图片适配、PDF 最低高度、HTML iframe 伸缩。
- Composer DOM 连续挂载；仅改变 CSS 布局和可见性。不要在两个容器间切换 `createPortal`：容器变化可能重建 contenteditable，破坏输入法组合、焦点和未提交草稿。聚焦退出要恢复到触发按钮的合理焦点。
- 外部工作区文件须先完成 `#2664` 的 Host 解析与权限校验，复用该入口；Office/Notebook 要分别有受限解析、体积上限、失败态和可访问性验收后才列为“支持”。

## 验收与消融

- 状态测试：目标 session/tab 与聚焦状态一致；关闭/切换后不可显示旧浮层。渲染测试：同一个 composer 节点在展开/还原前后相同，草稿不丢。
- Storybook/Chromium：Markdown、代码、diff、HTML、图片、PDF，以及浏览器（浏览器原生层另走 Electron 测试）在 1440×900、960×720、390×844 下无重叠；滚动、焦点、按键和深浅主题清楚可见。
- 安全回归：HTML sandbox、图片 MIME/大小限制、PDF fallback 和外链提示无退化。
- 消融：先尝试只用现有 Files/Browser 组件和一个展示态；若增设每文件类型的“全屏渲染器”或第二个输入实例也能删去且验收仍成立，就不保留。专属新格式能力须有真实样本及解析边界证明，不能因为 Codex 有同名模块就引入依赖。

## 组件与状态流

```text
AppShell 中的唯一 ChatSurfaceLayout/ChatComposerRegion（原位挂载）
  └─ 会话输入槽 ← WorkbarHost 附着把手和最近 turn 面板；不移动输入节点
WorkbarHost
  ├─ useFocusedPreview：{ sessionId, kind } 的临时展示意图
  │   ├─ 当前 session、右侧活动 tab、面板可见性、WorkHub/弹窗共同校验
  │   └─ ResizeObserver 测输入槽与最近 turn 面板高度，为页面/文档留出实际空间
  ├─ RecentTurnOverlay：当前 Files/Browser 面板观察 Host；仅聚焦时显示最近 turn
  └─ WorkbarSurface → ArtifactPane / BrowserPanel
      ├─ 聚焦/还原按钮、Esc/返回列表/关闭清理
      └─ BrowserPanel 的原生 viewport 按缩小后的 strip rect 同步
```

| 事件 | 原状态 | 后状态 | 必须不变的内容 |
| --- | --- | --- | --- |
| 选中 Files 文件并按聚焦，或将输入把手放到文件预览 | 分栏 | 文件聚焦 | 当前 session、文件 ID、文件读取结果、输入草稿 |
| Browser 打开后按聚焦或左拖分隔线 | 分栏 | 网页聚焦 | URL、历史、同一输入节点 |
| 展开/收起最近一条 | 聚焦 | 聚焦 | 文件/网页阅读位置、草稿、会话输入所有权 |
| Host 当前 turn 结束 | 运行中展开 | 最近回复展开 | 展开状态和输入草稿；流式投影由落盘回复接管 |
| 按还原，或在文件预览/浏览器工具栏上按 Esc | 聚焦 | 分栏 | 当前文件、源码/预览切换状态、会话滚动 |
| 返回文件列表/关闭网页 | 聚焦 | 普通布局 | 输入仍属原会话；不发送、不上传 |
| 切会话、切右侧 tab、折叠右栏、打开遮挡 shell 的弹窗 | 聚焦 | 普通布局 | 不把旧会话的展示意图套到新会话 |

聚焦是一个视图投影，不是持久化会话偏好。`useFocusedPreview` 在目标不再有效时清除请求。WorkbarHost 对已有的输入槽附着把手与最近 turn 面板；portal **仅承载这两层辅助 UI**，输入区本身既不 portal 也不 remount。当前布局根节点的 `data-preview-focused` 和 `--maka-focused-composer-space` 是私有 DOM/CSS 合同，离开聚焦后应清理。非文件预览页即使打开 Files tab，也不显示拖动把手。

最近 turn 面板状态与输入内容相互独立。运行中复用 `applyLiveTurnBufferEvent` 对 Host `subscribeEvents` 的有界/脱敏投影，并按 `contentOrder` 展示文字与可见工具活动；停止后使用 `listTurns` 和 `readSettledMessages` 锁定同一 turn 的最后助手回复，仅在 `settled=true` 时接管，未落盘时有限重试，不把上一 turn 的话错标成当前结果。观察不可用或刚开始尚无可显示内容时明确给出等待/回退文案。收起时保留共享状态行和两行摘要，展开高度由 ResizeObserver 计入 Browser 原生视口让位。观察器在当前 Files/Browser 面板关闭、切到其他工具或切换会话时释放；只在聚焦和分栏间切换时保留已有的有界投影。

## 各类型渲染合同

以下“支持”只指 **已有 ArtifactDescriptor 可达且通过 Host 读取策略的生成文件**，不是随便打开本机路径。`kind` 是 Host/Runtime 持有的权威分类，扩展名只决定文本文件的 Markdown 渲染/语法，不授权二进制读取。聚焦只变更空间分配，不提升读权限或上限。

| 类型 | 展示与操作 | 不可用或过大时 | 聚焦质量要点 |
| --- | --- | --- | --- |
| `.md`/`.markdown`，`kind=file` | `readText`；Markdown/源码切换，源码代码块 | 明确读取失败/截断说明 | 阅读行宽居中；切换与滚动不丢 |
| 代码/日志/普通文本，`kind=file` | 语法匹配、行号、文本复制/另存 | 256 KiB 展示上限，前 64 KiB/1000 行高亮 | 独立横滚，长 token 不撑开列 |
| `kind=diff` | `DiffCodePreview` 差异语义和行号 | 500 行后提示，底层仍有文本界限 | 差异宽表横滚而不裁剪 |
| `kind=html` | 受限 `srcdoc` iframe；提示外链禁用 | 超界回到代码视图并提示 | iframe 在剩余空间内伸展；不加 `allow-same-origin` |
| `kind=image` | 仅白名单 raster MIME、最大 2 MiB，`contain` 完整展示 | 不支持格式或过大有说明 | 宽屏居中，不拉伸或裁切 |
| `kind=pdf` | Host 二进制读取后嵌入浏览器 PDF 视图 | 插件不可用/读取失败有回退 | 独立内部滚动和底部留白 |
| Browser 网页 | Electron 原生 WebContentsView，地址/前进/后退/刷新 | 空页也可聚焦 | 实际 viewport 不覆盖浮动输入；DOM z-index 不足以保护它 |

尚不能宣称完整支持：CSV/TSV 现在只可能走 `kind=file` 的有界源码视图；DOCX/PPTX/XLSX 是压缩二进制容器，当前遇到这些扩展名会显示不可内联预览的说明和外部打开/另存操作，不调用 `readText` 或复制乱码；`.ipynb` 虽可当 JSON 文本读取，但没有单元格/输出渲染。这些不是把扩展名加到 switch 就能解决的问题。尤其 Office 需要 Host 接口、解析器、内存/页数/行数预算、图片和公式的安全策略；Notebook 还要处理不可信 HTML 输出，默认不得执行。

### 后续格式验收门槛

1. 建立可信来源与 MIME/魔数/扩展名冲突策略；Host 仅读取工作区许可范围，并对压缩包膨胀率、解压后总量和子资源数设界限。解析错误是可恢复的文件内状态，不得导致整个会话树崩溃。
2. CSV/TSV 使用成熟解析器处理引号、嵌入换行、编码/BOM；大表行列虚拟化，列宽可调整，空值与公式文本不执行。先实现安全可读视图，再考虑筛选/排序。
3. DOCX 按段落/标题/表格与图片有界呈现；XLSX 多工作表、冻结表头与列类型；PPTX 幻灯片索引/逐页阅读；PDF 维持现有二进制边界。复杂格式不得因“预览”上传至第三方服务。
4. Notebook 只解析 nbformat JSON；区分 Markdown、代码、纯文本与受限图片输出，HTML/脚本默认不执行；错误单元有定位。所有格式都有加载、过大、损坏、不支持和另存/外部打开路径。
5. 每种格式提供小样本、边界样本和长内容样本，跑分栏/聚焦、1440×900、960×720、390×844、键盘与读屏测试。实现后才将文档中的“未支持”改为“支持”。

## 初版实现与历史验收

- 本轮只改已有类型的聚焦阅读方式和 Browser 页面聚焦，不改变 artifact 的持久化 schema 或读取 IPC。按钮有可读名称和 `aria-pressed`；拖动只接受同 session 的专用 MIME，点击把手可代替拖放。
- 文件故事覆盖草稿节点不变、聚焦/还原/再聚焦；浏览器故事覆盖相同草稿和 strip 结束位置在输入框之上。Storybook 的浏览器是服务替身；本轮已在开发应用中补做 Electron 原生子视图复核，见上方交互验收图解。
- 最近 turn 故事覆盖运行中折叠/展开、停止后折叠/展开、运行中到已落盘回复的原位接管，以及真实 WorkbarHost 的输入槽 portal 和 Browser strip 动态让位；另外用真实 `Composer` 和长流/长回复做视觉故事，验证同宽、贴合、上覆、滚动与键盘焦点。带附件阅读回归检查浮层下沿与附件区上沿相接、滚动到底后最后代码行无遮挡、收起/恢复前后是同一输入 DOM 和草稿。1440×900、960×720、390×844 与宽窗口内 600px 的内容列无水平溢出或错误覆盖；紧凑单行以 Composer 容器宽度而非窗口宽度为准。
- 消融检查：原先把状态放到 AppShell 会扩大整棵树的 hook 范围并违反架构门禁，已移到 WorkbarHost；未新增独立全屏渲染器、第二个 composer 或文档解析依赖。拖动把手 portal 仍由拖动手势要求支撑。390px Browser 最终视觉故事里临时设 `--maka-focused-composer-space: 0px`，网页 strip 侵入最近流层约 502px；保留动态留白时两者间有约 24px 安全间隔，故不能删。390px 运行流加附件故事里去掉文件预览的尾部留白，最后一行被浮层覆盖约 573px；保留时高于浮层约 29px。模拟 346px 高的输入区时，最近流最大高度自动从 400px 降到 298px。去掉宽屏紧凑输入布局会回到明显更高的分行卡片，和截图中的单行底部锚点不符。
