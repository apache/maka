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

# Rust Runtime Host

[English](./rust-runtime.md)

Rust workspace 重写 Maka runtime 与 host，保留 TypeScript client 协议与交互。双方使用协议 epoch 179。
重写尚未完成；未实现的操作明确返回错误。

## 构建与运行

需要 Rust 1.98+、原生 C/C++ 工具链、Node 和仓库 npm 依赖。Provider SDK 与终端解析器
在构建时打包，运行二进制不需要 Node。

```sh
npm install
cargo build --locked -p maka-cli
cargo run --locked -p maka-cli -- --help
npm run dev
```

Desktop 默认启动 Rust host，使用 `userData/runtime-host-rust`，不迁移或接管已有
TypeScript State Root。独立运行时使用新目录：

```sh
maka host init --root /absolute/path/to/new-root
maka host serve --root /absolute/path/to/new-root
maka host status --root /absolute/path/to/new-root
maka host retire --root /absolute/path/to/new-root
```

原生 `maka` 无子命令时默认打开 TUI，`maka tui` 是显式入口。
通过 `maka --root /absolute/path/to/root` 或 `maka tui --root /absolute/path/to/root`
连接已有原生 Host。默认使用账户的原生 `runtime-host-rust` 安装目录，而非 Desktop 的
`userData` Root；启动不会创建、迁移或停止 Host。当前首个实现切片提供键鼠导航、命令面板、
配色切换、真实 Host 状态和分页会话目录。用键鼠打开会话可查看其身份、工作目录、模型与
最近预览；目录通知会刷新页面，修订变化会重启分页，不混合新旧快照。会话页已有独立内存草稿，
支持按字素编辑、软换行、鼠标选择和撤销重做。Enter 换行，Ctrl+A 全选，Ctrl+Z/Ctrl+Y
撤销/重做，Tab 离开编辑器。括号粘贴作为一次可撤销编辑，拒绝终端控制字符。
每份草稿上限 256 KiB，每个客户端最多 32 份，撤销历史有界。草稿、偏好、阅读书签和
导航历史按 Root/客户端 profile 保存，可在重启后恢复。使用 `--profile NAME` 区分独立客户端，
每个 profile 仅允许一个 writer。未确认发送保留原身份，绝不自动重发；撤销历史与正文文本选区
不跨进程恢复。`Ctrl+P` 打开命令面板，`Ctrl+Q`
退出 UI，不停止 Host。stdin/stdout 为管道时明确拒绝，不进入终端模式；显式 Host、Code Mode、
inspect、sandbox 子命令保留既有行为。这不会替换 PATH 上另行安装的旧 TypeScript CLI。

“待处理”页列出存在未解决审批、问题或表单的会话，包括此客户端尚未打开的会话。
实心菱形提示有待办，后台更新不弹窗、不抢焦点；进入会话后审阅当前请求，用 Alt+Left 返回。
会话全屏时如有待办或查询错误，顶栏仍提供入口。原生 Host 在 `session.catalog.query` 上支持
`pending_start` / `pending_continue`；旧 TypeScript Host 对这两种新查询返回 `operation_unavailable`。

在会话页或目录选中会话后，Ctrl+P 提供重命名、归档和恢复。居中弹框支持键盘与鼠标，
归档默认选中取消，历史和聊天草稿不会删除；归档会话仍可从工作区恢复。
重命名使用 Host 修订校验，冲突或结果未知时不会自动重试。成功回复只更新原会话，
不会切换当前页面；后台刷新已有列表时不插入加载提示，避免鼠标下的行位移。

设置 → 模型连接分页展示启用数量和 Host 默认模型，并跟随其他客户端的配置变更。
此子页面支持前进/后退与重开恢复，不增加常驻侧栏项。
点击页头 ⊕ 或 Ctrl+P → 添加模型连接，可配置 OpenAI-compatible、OpenAI 和 Anthropic 的 API key。
验证只发现模型、不写配置；选择模型并确认后，Host 一次性保存连接和密钥。
密钥全程掩码且不进入 TUI 状态文件；Host 尚无默认模型时，所选的第一个模型会成为默认。

选中连接后，Enter 或 ✎ 可重命名；Ctrl+P 还提供启用、停用和删除，确认框默认取消。
改名与启停保留原地址、启用模型、覆盖配置和凭证。停用会清除指向此连接的默认模型，
重新启用不会自动恢复默认。删除会永久移除连接及其保存的凭证，但聊天历史保留。
操作使用 Host 连接修订校验；结果未知时必须重新读取，不会自动重试。
连接页 ☆ 或 Ctrl+P → 默认模型可选择 Host 默认；选中模型后确认。
清除时先选“不使用默认模型”，再确认“清除默认”。只影响使用默认模型的新会话，
已有会话和草稿不变。配置变更会撤下本地选择，保存时由 Host 校验目录修订。
Ctrl+P → 修改服务地址可编辑非 OAuth 连接。确认页显示完整目标地址，默认取消；
已有凭证将用于新地址。更改会清除已发现模型、模型覆盖及测试结果，
但保留启用模型和请求覆盖。
API-key 连接可通过 Ctrl+P → API key 查看是否已配置并替换密钥，不回显旧密钥。
新输入始终掩码、不进入 TUI 状态文件，提交或断线后从表单丢弃。
保存校验连接与凭证修订，但不会测试密钥。“清除 API key”默认取消，
只移除 Host 保存的密钥，不撤销提供商处的密钥。
Ctrl+P → 获取模型，经确认后使用保存的凭证，从连接当前配置的服务查询并保存模型库存。
原启用选择保持；空连接首次发现时可能启用首个模型，但不会设置 Host 默认模型。
此操作没有客户端修订前置条件，由 Host 在提交前重查与请求相关的配置。
失败在确认框内呈现，结果未知时不会自动重试。模型配置编辑及 OAuth 界面仍待实现。

未归档 AI SDK 会话可点击 composer 下边框的模型名，或 Ctrl+P → 切换模型。
从 Host 目录选择已启用的聊天模型后确认，使用该模型的默认推理设置；
Host 默认模型、其他会话、sandbox 和草稿保持不变。并发修改使用修订校验，
结果未知的写入不会自动重试。

未归档会话的 Ctrl+P 菜单也提供“切换工作目录”。输入 Host 上已存在的绝对目录，
只改变后续执行位置，不搬动文件；项目绑定会话切到固定目录后不再跟随项目位置。
Host 会拒绝忙碌或不能迁移的会话，冲突与未知结果不会自动重试。
Ctrl+P → 切换项目可将已有会话绑定到已注册项目，由 Host 解析目录。打开时不预选，
点击项目行后用 Enter 或“使用项目”确认；归档或不可用项目不能提交。
这只修改当前会话，保留草稿，不合并项目或移动文件；同样使用会话修订校验。

侧栏或 Ctrl+P 的“项目”显示 Host 已注册的项目。鼠标或方向键选择后，Enter / +
创建绑定该项目的会话，由 Host 解析当前目录；归档或位置不可用的项目不能新建。
项目变更会刷新列表，选中项按 ID 保持，不会转到邻行。ⓘ 或 Ctrl+P → 项目位置，
可查看已注册的 Host 目录、首选目录和工作树标记；长路径换行，方向键或滚轮滚动，
PageUp/PageDown 翻目录页。位置查看是只读的，项目变化后会刷新。⊕ 或 Ctrl+P → 注册项目，
可输入 Host 上已存在的绝对目录，也可点“浏览”选择 Host 开放的目录。Enter 进入目录，
“注册此目录”或 Ctrl+Enter 才提交；Backspace 返回上一级，PageUp/PageDown 翻页，
Esc 回到路径输入并保留草稿。Ctrl+P 也提供项目重命名、归档和恢复。
归档保留已有会话与文件，但阻止新建项目会话，确认框默认取消。项目修改按 Host
事务提交顺序生效，不提供会话式修订校验；未知结果不自动重试。
Ctrl+P → 重连项目位置，先输入新的 Host 绝对目录，再确认（默认取消）。重连会替换
项目位置并更新关联会话；目标若已属于另一项目，Host 会将其并入当前项目，不移动文件。
可返回修改路径；结果未知时禁止修改和重发，须关闭并核对状态。不承诺迁移正在执行的任务。

工作区的 + / Ctrl+N 使用进程当前目录与 Host 默认模型创建会话。Ctrl+S / 发送图标提交草稿，
Enter 仍换行；明确接收后只清空未被继续编辑的草稿。结果未知时保留草稿、禁止重复发送；
发送图标变为核对入口（Ctrl+R），只查询原 message ID，不重发。确认接收后仅清空未变草稿；
确认取消后保留草稿，允许显式发送新消息。查不到不代表没收到：发送保持禁用，草稿仍可编辑，
可再次核对，也支持重连同一 Root 后核对。

会话页已消费 snapshot/ready 订阅、校验 digest 并组装字节分片，将 UTF-16 实时流与持久消息
对齐。重开会话从 Host 恢复历史；向上图标加载更早页，正文区域滚轮或编辑器外的
PageUp/PageDown 滚动。助手文本已有基础 Markdown 排版（标题、强调、列表、代码与可见链接地址）。
消息左侧三角可折叠/展开，思考和工具记录默认紧凑；编辑器外空格切换顶部消息，End 回到最新。
离开跟随时出现向下按钮，有新输出时图标变化。消息/源文本位置锚点在追加、加载旧页和改宽时保留阅读位置；
已完成消息缓存布局，流式转持久消息不丢手动折叠。折叠与锚点当前只保留于打开的页面，尚不跨路由或重启保存。
表格按内容分配列宽、保留样式、单元格自动换行并支持左/右/居中对齐；极窄屏切换为带列名的纵向字段。
实时 Markdown 缓存已结束的顶层块并重解析开放尾部；含方括号的文档仍完整解析，以免后置引用定义使缓存链接失效，
大型开放块也仍需整体重排。代码语法高亮、选择/复制、搜索及语义工具卡片仍待完成。
待处理交互通过紧凑的 ! 按钮（编辑器外 Ctrl+A）打开审阅窗口，展示 Host 原始请求与身份，
支持键鼠滚动和选择，默认“稍后”只关闭窗口、不作决定。权限请求支持拒绝、单次、本轮或本会话授权；
没有工具调用身份的生产者请求不提供单次授权。客户端能力审批明确授予所示提供者、契约和范围的会话权限。
结果不明时只能核对原请求；请求消失后撤掉授权按钮，回复绑定原会话、交互、轮次、运行及请求内容。
问答支持紧凑的题目页签、带说明的选项、自由文本（每题最多 2,048 UTF-8 字节）及显式跳过。
每题都作答或明确跳过后才启用 Ctrl+S / 提交；自由输入中的 Enter 只换行。
“稍后”及回到同一待处理请求会保留本进程内未提交回答，但不跨应用重启保存，
也不保留被另一个审阅请求替换的草稿。窗口按内容收紧，长题保留滚动。
表单仍需其他客户端作答；结构化表单编辑器、全局待办中心和更直观的工具卡片尚未完成。
单条组装上限 16 MiB，批次与已加载历史各 32 MiB，最多保留 2,048 条消息；
布局限制为 131,072 行 / 64 MiB 估算存储，超限明确报错。

布局优先留给内容：Ctrl+B 切换完整导航与窄图标栏，窄屏默认使用图标栏；F11 切换会话
专注模式，信息图标展开会话元数据。输入框随内容增长但有高度上限。F5 / 命令面板刷新
当前页，目录通知仍会自动更新。悬停图标显示用途与快捷键 tooltip，键盘焦点在状态行显示
说明；设置提供 ASCII 图标与减少动态效果选项，侧栏过渡完成后停止动画重绘。

TUI 语言优先级为 `maka --locale zh-CN`（或 `maka tui --locale zh-CN`）、
`MAKA_LOCALE`、已保存的 profile 偏好、系统自动识别。支持 `auto`、`zh-CN`、`zh-TW`、`en`，
`zh` 是 `zh-CN` 的别名。显式 `auto` 忽略 `MAKA_LOCALE`；自动识别取
`LC_ALL`、`LC_MESSAGES`、`LANG` 中首个非空值，其次使用原生系统语言，
不支持的系统语言回退英文；非法显式偏好明确报错。
设置页可用鼠标或 Tab/Enter 循环切换语言，不重连或重置导航，语言与配色偏好保存在客户端
profile 中。Host 原始诊断和业务数据不自动翻译。核心 TUI 文案集中在
`crates/tui/locales/*.ftl`；缺失或格式错误的译文回退英文，并在设置页显示去重诊断。

Desktop 在 Host 就绪前开放导航和草稿编辑。Host 不可用不会退出应用，可以重试、切换 Host、
复制诊断或退出。草稿文本由 Desktop 保存，不进入发送队列；离线发送会被拒绝并保留草稿。
启动分别记录 `mainInteractiveMs`（主界面可交互）与 `hostReadyMs`（Host 就绪）。

会话草稿的正文、附件、引用和修订意图保存在 Desktop 按 Host 权威隔离的 SQLite 存储中。
版本导航包含未发送的修订。恢复草稿不会自动发送；提交将选定版本原子移入本地发件箱，
保留后续编辑。关闭时先保存草稿再关闭 Host；保存未确认时保持窗口打开，除非用户明确放弃。

有限 CLI 命令接受 `--timeout-ms`（1–600000）：status/logs 默认 15 秒，其余操作默认 180 秒。
Desktop 每次恢复共享 45 秒预算、最多尝试五次；退出包含清理，共享 8 秒预算。子阶段使用剩余
时间。下载报告实际字节进度，重复心跳不会重置停滞检测。超时只结束观察，不取消已接受的工作
或释放其锁；一次性独立命令进程可能继续收尾，它不是常驻控制进程。结果待确认时先查询
`host status` 再决定是否重试。`operation: in_progress` 表示执行锁被持有，与 Host 正常活动
分开报告。恢复使用原有 pending update 的冻结目标，不强杀归属不明的进程，也不删锁接管。

二进制未加入 PATH 时使用 `target/debug/maka`。Linux/macOS 使用 Unix socket，
Windows 使用私有 named pipe。可选 `--websocket 127.0.0.1:0` 监听需要认证，尚不支持 TLS。
对运行中的 Host 执行 `host access prepare --root <目录> --principal <id>` 可获得配对 JSON，
其中包含秘密凭据，须私密传递。待确认凭据在 15 分钟后过期；导入客户端须先确认配对，再用相同客户端身份重连。
该 Desktop owner 策略不授予任意 Host 路径访问权。
`host access revoke --root <目录> --credential-id <id>` 撤销凭据并关闭其远程连接。
这些命令不会启动 Host 或迁移数据。
开发构建保留文件与行号回溯；`CARGO_PROFILE_DEV_DEBUG=full` 可启用完整调试信息。
Windows MSVC 构建使用与官方 V8 静态库一致的静态 CRT。
两份随仓库保存的 Deno TypeScript 须与 `deno_telemetry` 完全一致，升级依赖时须同步；
构建直接转译它们，不再加载构建期 V8。

`host connect --root-id <rootId> --framed` 激活该部署，通过 stdin/stdout 桥接客户端协议，
诊断写入 stderr。Linux/macOS 的输入 EOF 半关闭连接并排空响应；Windows 管道 EOF 表示断连，
客户端须先收完响应再关闭 stdin。WSL 传入 `--repair-root-after-remount`，显式确认重挂载后
Linux inode 未变并保留 Root ID。不要用它接管复制的根或旧版数据。

`host install --root <目录>` 固定当前可执行文件和按需策略；`--mode supervised` 选择持续运行。
只有返回的 `executable` 可以启动该托管根。`host activate --root-id <rootId> --framed`
复用就绪 Host，或启动固定版本；supervised 模式会注册并启动账户级 systemd 服务、LaunchAgent
或 Windows 计划任务。Linux 要求用户服务管理器已运行且启用 linger；macOS 要求 Aqua 登录，
Windows 要求交互式用户会话。单独安装不会启动服务或修改账户策略。
`host setup --root <目录>` 合并安装与激活；可选 `--principal <id>` 同时返回短期 Desktop
配对凭据，须将该 JSON 视为秘密。交互式启动器使用 `--framed` 并隐藏
`__MAKA_NATIVE_HOST_SETUP__` 回执行。重复 setup 保留已有代码和未显式指定的配置，变更仍须使用
`host update`。install/setup 省略 `--root` 时使用账户的原生 `runtime-host-rust` 目录，与旧 TS 状态分离。

`host fetch --target <目标> --version <精确版本> --cache <目录>` 从 npm 预备
`@maka-agent/cli-<目标>`，不安装或启动 Host。目标支持 `darwin-arm64`、`darwin-x64`、
`linux-arm64-gnu`、`linux-x64-gnu`、`win32-x64`。下载验证 SHA-512、包身份及二进制头；
缓存命中可离线使用，仍重新校验文件摘要。遵循 CLI 代理环境变量。本地包可改用
`--archive <文件.tgz> --integrity sha512-<base64>`，不访问 npm。
返回的 JSON 包含 Windows 两个入口路径。`--directory <已验证包目录> --receipt-sha256 <摘要>`
根据原验证器的回执导入传输后的包。默认缓存为账户的 `native-cli` 目录，已保存配置会引用其中的可执行文件。
现阶段原生包使用独立 npm channel `rust-preview`，不使用 `latest`。

Linux 发布支持 glibc 2.28 及以上。`node scripts/rust/build-cli.mjs --release` 使用
`cargo zigbuild`，显式指定 `x86_64-unknown-linux-gnu.2.28` 或 `aarch64-unknown-linux-gnu.2.28`；
构建机器须安装 cargo-zigbuild 和 Zig。开发构建仍使用普通 Cargo，SSH／WSL 引导在下载前拒绝旧版 glibc。

Desktop SSH／WSL 引导在本机下载并验证 `nativeRuntimeHostVersion` 固定的完整包，再传输、清理暂存目录并设置原生 Host。
该字段是独立于 Desktop 版本的精确 npm 版本，打包时可通过 `MAKA_NATIVE_CLI_VERSION` 指定。
已发布的 preview 覆盖 macOS arm64、Linux x64、Windows x64。
目标无需 Node/npm/Rust。开发构建可设置 `MAKA_NATIVE_CLI_VERSION` 和
`MAKA_NATIVE_CLI_PACKAGES`（由 `host fetch` 填充的缓存目录），正式打包的 Desktop 忽略这些覆盖。
已有配置的启动无需访问 npm。

Desktop 在加载 Host 服务前绘制主窗口。IPC 注册等待和文档加载均有时限；Host 失败不影响草稿、管理和退出。
需要用户决定的交接在主窗口内呈现，不额外创建启动窗口。

Desktop 复用原生托管 Host，需要时激活固定版本；自身版本变化和退出不控制托管 Host 的寿命。
暂停本地启动后，会等待已发出的激活收尾，再交接 Root。
Desktop 可管理本机原生部署及已有的 SSH／WSL 原生 operator 配置。远程生命周期命令使用
SSH／WSL 的操作系统权限，不扩大 WebSocket 凭据权限。停止/卸载保持连接暂停；启动/重启/更新
即使结果未确认也恢复正常重连，由激活流程检查真实部署，不自动重放变更。
部署权威保存在 State Root 之外的账户级 SQLite 中，启动时先校验再执行数据库迁移。
Windows 托管服务使用同目录的 `maka-service.exe`，它是同一 Host 的无窗口入口，须与 `maka.exe` 一起分发。
按需激活要求启动环境允许脱离 Windows Job；应直接运行已构建的程序，不要通过 `cargo run` 激活。
关闭开始后，CLI 最多等待十秒清理，超期以 70 退出；中断工作的结果由日志恢复判定，不视为已经回滚。

更新部署时，用新二进制运行
`host update --root-id <rootId> --expected-deployment-id <deploymentId> --expected-revision <revision>`。
同一次更新可设置 `--mode`、`--websocket`，以及可重复的
`--project-root-json '{"label":"Projects","path":"/absolute/path"}'`。
`--no-project-roots` 不发布目录；`--default-project-roots` 恢复账户默认目录。省略的配置保留不变。
代码和配置共用一个目标及 revision；`reconcile` 不重新选择配置。
活跃客户端或不可交接任务会推迟切换；随后用相同身份参数运行 `host reconcile` 完成已记录的更新。
目标一旦提交，即使启动失败也不自动回退。Supervised 激活仅在持有 Root 时替换服务定义。
升级以可恢复的短暂重启为目标，不保证 socket 或 PTY 连续存活，不计划增加独立控制进程。

`host upgrade` 使用相同身份参数，先下载 `rust-preview`（或 `--version` 指定的精确版本），再委派该版本完成更新。
Desktop 同样先完成下载和 SSH／WSL 传输，再暂停连接。
`host update-policy --root-id <rootId>` 查询自动更新策略；修改时附加
`--policy rust-preview|manual --expected-policy-revision <revision> --expected-deployment-id <id>`。
默认手动更新。自动更新使用独立 OS 定时任务，不增加常驻进程；成功后每小时检查，失败或工作繁忙时每十分钟重试。
空闲客户端在切换后重连，执行中的任务、PTY 和 OAuth 会推迟切换；按需 Host 不被更新任务唤醒。
关闭策略会阻止已排队的自动更新，卸载同时删除定时任务。`lastError` 报告尝试失败；
`schedulingError` 表示策略已保存但 OS 任务未就绪，可重复同一请求修复。

`host stop`、`host restart`、`host uninstall` 使用相同的身份参数。
停止和重启保留待更新目标。卸载先撤销启动资格，再注销服务；Root 数据、代码包及部署撤销记录均保留。
若 `cleanup.kind` 为 `pending`，重试相同卸载命令；显式安装会在旧服务清理完成后授予新的部署身份。

`host status --root-id <rootId>` 分别读取部署、待更新目标、OS 服务及活体 Host，不启动或修复它们；
Host 不可连接不代表进程已停止。`host logs --root-id <rootId>` 返回最多 48 KiB 的托管诊断尾部，
`byteTruncated` 标明省略的字节。Linux 选择最近 200 条 journal 记录；macOS/Windows 读取 stderr。
这些是诊断信息，不是执行历史；按需 Host 不捕获 stderr。
托管启动失败会附带观察到的服务状态、可用的 PID／结果码和有界日志尾部。
诊断读取共用启动期限，日志可能包含此前尝试的记录。

`maka` 命令还提供 Desktop 启动用的 `host candidate`、从 stdin 读取 JavaScript cell 的
`code --log <file>`，以及查看已提交执行事实的 `inspect --log <file>`。

**没有 OS 沙箱。** 代码与工具使用当前用户的系统权限。不要执行不可信代码，也不要让测试
实例接管已有用户数据。

## 设计

原生插件通过 `PluginContext.data` 使用按 package/scope 划分的私有文件目录。
文件工作持有 Fiber 至完成，退休拒绝新操作但不删除数据。Root 只校验核心文件和目录安全，
不识别业务名称；文件格式、锁与恢复属于插件。既有用户／项目内容路径与私有 journal 分开。

- **Log Is the Runtime：**模型历史、transcript 与恢复来自已提交的语义事实。上下文压缩
  改变模型投影，不改写历史。
  失败响应的片段只用于展示，不纳入模型历史；用户取消不显示为 provider 失败。
- 计量按模型物理准入统计，包含失败重试和插件辅助调用。被拒绝的回复仍保留已报告用量；
  缺失计数与未确认结果保持未知。历史复制不重复计量，Session 删除保留计量事实。
  报价支持有界、固定版本的查询与 CAS 修改；自定义报价跨重启保留，内置报价更新使旧分页失效。
  Rust／JS 插件复用同一报价与修改路径；改价需要 profile 范围的明确授权，Agent 调用本身不授予该权限。
  每次准入冻结公共提供商身份和报价，用量与估价一起提交；回复被拒绝、改价或恢复都不改写历史金额。
  公共 Rust／JS Usage 读取逐次校验作用域授权，在固定结算快照下每页最多返回 100 条／48 KiB；
  模型调用、工具执行和派发前拒绝共用筛选与活动分页。Host 重启使游标失效。
  汇总复用活动快照，保留缺失计数／报价覆盖率，并返回有界的完整提供商／模型／工具分组；待结算准入另列。
  Usage 页面尚未接入。
- 模型消息、内容块与工具结果在 provider 投影中保持类型化；路由与发现共享类型化契约。
  工具 JSON、schema 和厂商扩展保留开放结构。
- 订阅收到 `subscription.ready` 后才交付帧。重连按背压从已提交日志补发活动文本，
  不复制整份 transcript overlay。
- 每个 State Root 只有一个写入与执行 authority；Session、Turn、Run、invocation
  身份保持独立。协作续接保留对外 Run 身份；恢复凭证与清理仍绑定精确物理 Run。
  已封口的任务可直接取消，无需加载 provider，也不重做副作用。
- Host 诊断与退出共用活动工作统计，包含等待授权的 OAuth 登录。退出绑定精确 Host epoch，
  回复发送与资源清理完成前不释放 authority。协作交接在步骤结算后封口，重启按冻结组合续接；
  缺少原客户端所有者时保持暂停。封口前可撤销准备，协作许可不授予中断其它客户端连接、PTY
  或 OAuth 流程的权限。旧协议字段 `nodeVersion` 如实返回 `not applicable (Rust)`。
- 手动 resume 先只读检查已封口的源，再原子开启续跑。模型只回放选定谱系，不混入后来的旁支或
  未完成的响应片段。未知副作用阻止准入；重复已接受的请求返回原 Turn，重启后仍然如此。
- 类型化模型列表贯通发现、存储和目录投影，连接自有声明单独保存；
  主动压缩从总容量中预留最大输出和输入增长余量，详见[上下文窗口与压缩](#上下文窗口与压缩)。
- 工具先提交派发，再执行副作用，最后提交结果。结果未知不代表可以重做；取消必须等待
  已准入工作收尾。
- 执行中可单独扩大权限，新工具调用捕获已提交的边界；收紧权限须等待执行静止及原生
  资源清理完成。
- Read 用 `path` 读取文件和 Session 资源，返回有界页与校验内容的续页地址。
  事件地址只读取冻结的模型证据，不暴露模型投影省略的原始输出。大段文本结果在下次
  模型请求前持久化有界首屏；媒体和原始执行事实保持完整。
- 延迟工具在搜索成功后的下一步才可调用，已提交的上下文压缩会卸载它们。Code Mode 只暴露
  `exec`，说明中列出当前可嵌套调用的工具；已有调用保持捕获时的作用域。
  每个逻辑步骤成对捕获工具定义与执行器，物理重试及返回的工具调用共用该视图。
- `turn.start` 与 `turn.message.submit` 的显式 Skills 在准入时冻结正文和回执。排队消息保留必需工具集合；
  promote 与后继执行按实际目标 Run 校验，不重新加载技能文件。
- `SkillSearch`、`Skill` 在每逻辑模型步骤共同绑定目录、handler 和支持上下文；物理重试不变，下一步可观察变化。
  搜索只返回有界元数据，
  加载的正文保留可读的归档分页。
- Agent 模式的技能选择器按当前权限预览，不绑定 Session 或解析模型；分页绑定修订。
  内置及本地来源目录反映真实安装占用，并识别经校验的托管来源别名。治理查询展示校验、
  偏好和来源更新状态，不读取 baseline，也不冒充 Run 内已加载状态。目录视图共享版本，游标另绑定视图。
  `maka.skills` 内置插件拥有发现、输入展开、启用／固定 CAS、原始字节更新预览及可恢复的创建／安装／删除／更新。
  Client bundle 提供管理、选择器和草稿建议；Desktop 提供目标绑定的 Slot 和授权原生文件操作。
  发现目录管理复用同一份路径定义、公共 Remote 文件授权和目标绑定的原生打开能力。项目失效不隐藏
  用户／私有目录；旧路径操作被拒绝，不自动重试。用户文件管理与 Agent 调用分别授权。
  停用后新显式引用失败，普通聊天与已接受回执不受影响。Plan 模式执行属于独立领域，尚未实现。
- Rust 管理存储、网络路由、工具和原生进程／PTY。Responses 使用原生 Rust 适配器，其它协议
  保留共享惰性 V8 中的 AI SDK。两者都是普通模型适配器插件贡献，每逻辑步骤冻结注册并供重试复用。
  原生 PTY worker 直接拥有 Alacritty 终端状态，无需 JavaScript 或跨 runtime 消息。
  Code Mode 使用独立短生命周期 isolate。数量与字节限制提供背压，
  V8 heap 限制不等于进程内存隔离。
- 插件通过目录注册和有作用域的 Host 服务接入，复用日志、权限与排空机制，不替换 Engine。
- Code Mode 限制累计 VM 执行时间，不计异步工具等待或收尾时间。
- Responses reasoning 遵循声明的加密、明文正文或明文摘要契约。摘要重放保留 item 身份和
  Unicode 安全的分段边界，不重复存储正文；无效元数据不参与重放。
- 请求的代理策略同时覆盖 HTTP 与 Responses WebSocket。启用的 Host 手动代理优先；
  否则捕获 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（大写优先于小写）。
  协议专用代理优先于 `ALL_PROXY`；`NO_PROXY` 支持域名及子域、IPv4/IPv6 地址和 CIDR、`*`。
  未启用手动代理时，需要直连可在启动 Host 前清除代理变量或设置 `NO_PROXY=*`；
  已运行的 Host 需要用新环境重启；托管服务使用服务管理器提供的环境，而非后来启动 TUI 的 shell。
  OAuth、模型发现和获准工具网络
  共用该策略；沙箱 CONNECT 使用 HTTPS 路由（不按目标端口猜测），连接前仍校验目的地权限。
  代理失败不偷偷直连。支持 HTTP、HTTPS、SOCKS5（本地 DNS）、SOCKS5H（代理 DNS）地址；
  无效代理配置会拒绝，错误不回显凭证，环境凭证不落盘。CGI 环境忽略 `HTTP_PROXY`/`http_proxy`。
  WS 握手失败后指数退避重试
  5 次，再经同一网络策略降级 HTTP。主模型请求另对已识别的临时 provider 或原生网络故障最多尝试
  10 次，使用冻结输入与可取消退避。Provider 工具活动或重放元数据阻止重试；未知/本地
  错误、尚未分类的网络故障与空闲超时不重试。
  模型活动刷新 120 秒空闲预算，持续输出不受两分钟总时限限制；用户取消仍关闭请求并等待收尾。
  真实 provider finish 到达后释放流，不等待传输 EOF；残缺流合成的 finish 不算成功完成。

## 上下文窗口与压缩

模型配置中的 `contextWindow` 是**输入与输出共享的总容量**。填写完整模型窗口和希望
使用的 `maxOutputTokens` 即可；`compactionThreshold` 是可选覆盖项。默认触发线先
预留完整最大输出，再从剩余输入空间留出 5% 的增长余量：

```text
输出预留 = 请求的 maxOutputTokens，受提供商输出上限约束
           （未显式设置时使用提供商输出上限）
输入预算 = min(contextWindow − 输出预留, 提供商 inputLimit（若已知）)
自动阈值 = floor(输入预算 × 95%)
最终阈值 = 显式 compactionThreshold，否则使用自动阈值
```

例如，**总窗口 1,000,000 token，最大输出 128,000 token**，没有更小的输入上限时，
默认在 **828,400 token** 触发。它比 872,000 token 的输入预算提前 43,600 token，
用于容纳请求间增长。若提供商另有限制输入最多 800,000 token，则默认阈值为 760,000。
这里使用十进制 token 数。手动阈值替换默认触发线，不改变提供商容量，也不再次扣除输出。

内部字段区分模型配置和每次请求冻结的事实：

| 数值 | 含义 |
| --- | --- |
| `ModelInfo.context_window`／配置 `contextWindow` | 模型总容量，包含输出；显式模型覆盖替换提供商报告值。 |
| `inputLimit` | 独立的提供商输入上限（若已知），不是自动压缩必填的第三个设置。 |
| `ModelRequestContext.context_window` | 内部扣除输出前的输入上限：`contextWindow` 与 `inputLimit` 都已知时取较小值，仅一个已知时取该值。 |
| `ModelRequestContext.model_context_window` | 完整模型窗口，不能从仅有的输入上限推断；上下文诊断以 `contextWindow` 返回它。 |
| 模型／覆盖配置 `maxOutputTokens` | 提供商输出上限／请求的单步输出预算，为上述公式提供输出预留；实际请求限制仍由提供商策略决定。 |
| `ModelRequestContext.declared_window` | 解析并冻结到该请求的最终压缩阈值，可以来自手动配置或自动计算。 |

每次主模型步骤之前，runtime 比较上一已完成主请求的**实际输入 token + 实际输出 token**
与最终阈值，输入用量须为正，缺失输出用量按零计算。用量必须属于同一连接、模型和当前
checkpoint，压缩还须满足安全执行边界。
默认已有 5% 余量，不再叠加根据上一次回复大小计算的第二份余量。

总容量或输出预留未知、或者预留输出后没有足够输入空间时，不猜测默认阈值，仍可使用
显式阈值。没有可用的实际用量时也不主动触发。5% 余量是启发式保护：新消息或工具结果
可能超过它，因为 runtime 不会在本地对完整的下一次提示词做 token 计数。因此仍保留
提供商在产生可观察输出前明确报告上下文溢出时的有界压缩恢复；仅以输出长度结束不能
证明上下文溢出。界面上下文用量的估算只用于展示。

单次输出限制保留为另一层保护：已知请求预算 `M`、完整窗口 `C` 和匹配实际用量 `R`
时，按剩余窗口减去 8,000 token 的新输入余量、以及 Anthropic 固定 thinking 预算
（若有）收紧输出，并保留 `min(M, 8000)` 的输出下限。这不会改变配置容量，也不保证
下一次提示词一定放得下。压缩后第一次主请求最多输出 8,000 token，已选预算更小时取更小值。

实现见 [Host 阈值解析](../crates/runtime-host/src/execution/provider/context.rs)、
[用量与输出检查](../crates/agent/src/auto_context.rs)和
[压缩准入／恢复](../crates/agent/src/steps.rs)。

## Web

`maka.web` 插件发布 WebFetch 与 WebSearch。设置 → 联网搜索选择模型原生搜索或 Tavily，
密钥保存在插件命名空间凭据中。OpenAI／Codex 默认具备原生搜索能力，模型的显式声明优先；
协议兼容服务必须声明支持。当前支持 Responses 和 Anthropic Messages 的供应商工具，
明文 OpenResponses 适配器不支持。不自动切换搜索来源。

WebFetch 通过获准的 Host HTTP 抓取，不启动浏览器或执行网页 JavaScript；
优先 Markdown，HTML 提取保留链接和代码。响应上限 5 MiB、正文上限 50 KiB、
重定向最多十次，截断明确标记。Tavily 查询限 1–200 字符，最多返回十条结果，
标明省略结果和片段截断。隐私模式撤下两种工具。

## Session 待办

`maka.todo` 插件发布可通过工具搜索发现的 `todo_read` 和 `todo_write`。
工具与输入框中的清单共用插件命名空间存储；写入整份替换并检查修订，拒绝并发覆盖。
每个 Session 最多 200 项，每项最多 200 字符。完成状态由模型报告，不是独立验证的执行证据。
停用插件撤下工具和 UI，不删除清单；重新启用或重启后恢复。

## 会话引用

Desktop 可预览并附加同一 Host 中另一会话的已提交文本快照。
来源名称、采集时间和截断标记随引用保存并进入模型历史。
引用是不可变摘录，不是实时链接，也不授予读取来源会话的权限。

分支和修订历史冻结继承的归档引用。各会话可以裁剪尚未归档的继承工具结果并压缩自己的
上下文，不改变源会话、兄弟分支或先前的冻结读取。后续副本继承父会话当前的投影；
归档校验始终保留原始工具调用证据。

会话删除原子提交修订家族计划、准入关闭和排队消息取消。依赖会话归档而非销毁；
清理后恢复的依赖会话不会被旧删除重试再次归档。`session.remove.query` 在目录项消失后
仍可恢复已接受回执。公共 Rust／JS 执行能力提供相同的删除、预览和回执语义，
必须覆盖全部直接删除成员的权限；历史读取授权不等于删除授权。

Host 等待已接受执行和进程清理后才回收托管 worktree，共享目录保留到最后一个所有者退出。
不能确认进程清理时保留目录，不阻塞无关会话。没有存活历史所有者引用已删除会话后，
后台分批释放事件正文、工具载荷及无共享引用的请求表面，保留原始正文摘要、计量和终态证明、
身份及已接受回执。继承的归档／checkpoint 证明沿引用关系保留；回收后的正文不能重放。
增量 vacuum 分批归还空闲页面；删除不等于安全擦除数据库／WAL 的备份。

## 历史导入

历史导入使用公共 Rust／JS 执行契约及根会话创建授权。Host 暂存不可变记录，
检查当前权限后原子发布 Session；精确重试支持重启恢复，放弃则回收未发布材料。
导入参与消息展示、历史复制和压缩，不计入本机执行或用量。规范输入上限为
7,500 条／6 MiB，确保新 Session 可在运行时历史预算内继续。
Desktop 将消息标为导入历史，不推断本机执行完成或耗时。工具调用与结果保留各自
来源位置，缺失结果保持未知。
来源适配与 Desktop 导入流程尚未提供。

## 会话回忆

`maka.recall` 通过公共历史能力发布动态加载的 `Recall`、`RecallMore` 和 `RecallMaterial`。
Recall 搜索最近有消息的 200 个 Session 的完整文本（含归档），使用 Unicode
规范化字面词匹配与 BM25 排序，排除当前 Turn，明确报告无法读取的来源和片段截断。
RecallMore 扩展邻近消息，或通过 UTF-8 偏移继续读取长锚点。附件名称也可搜索。
RecallMaterial 将用户上传的附件复制到调用 Session 后读取；重试复用同一不可变副本，
来源删除不影响副本。文本沿用 Read 的有界分页与续读，图片保留视觉内容，
不支持的二进制格式明确失败。隐私模式撤下全部三种工具；
历史陈述不是经过验证的事实。

Desktop 会话搜索调用插件公开的 `search` Remote 接口，不再下载全部会话记录。
结果保留 Host 身份与规范消息位置，明确标记不完整搜索；取消或渲染进程退出会关闭所属请求。

Host 提供固定日志水位下的有界文本分页，排序和片段组装属于插件。
SQLx 管理的可重建文本投影避免反复解析大型 JSON 结果。
其它插件可以使用相同的 Rust／JS 历史 API。
`history.copyMaterial` 分别检查来源历史访问权与目标的 Host 执行能力句柄；
附件标识本身不授予任何一端的权限。

## 代码组织

所有 crate 位于 `crates/`，目录按职责命名。

| 边界 | Crate |
| --- | --- |
| 事实与持久化 | `runtime`、`event-log`、`presentation`、`config` |
| 执行 | `agent`、`model`、`js-runtime`、`tools`、`fs-tools`、`process`、`apply-patch`、`skills` |
| 插件生命周期与工具目录 | `plugins`、`tool-catalog` |
| 客户端与 Host | `protocol`、`transport`、`client-capability`、`network`、`runtime-host` |
| 可执行程序 | `cli` |

Runtime core 不依赖 V8 或 SQLite；持久 schema 由 SQLx migration 管理。
Client Capability 注册与反向调用所有权位于 `client-capability`，Host 负责组合执行。

客户端能力分为连接级发布和有数量上限的 Session 级发布。后者仅允许不访问 Host 路径的
Session-affinity 工具；冻结绑定在重连后仍保留发布作用域。归档 Session 会退休其全部
发布代次，重新打开前拒绝再次注册。MCP 准入从可信的冻结发布推导精确工具授权；
声明 MCP 准入方式不赋予提供者信任。

## 开发验证

`node scripts/rust/release-cli.mjs --source <源码.tar.gz> --keys <KEYS>
--target <目标> --validator <本机maka> --notices <已审阅许可证文档>
--build-id <构建标识> --output <目录>` 校验源码归档及相邻的校验和、签名文件，安装锁定的 npm 依赖并应用仓库补丁，
再编译、打包原生 CLI。Cargo workspace 与 `maka --version` 保持源码版本；npm 使用
`<源码版本>-rust-preview.<构建标识>`，例如 `0.2.0-rust-preview.20260916.1`。
同一构建的全部平台使用相同标识，每次发布使用新标识；CI 可使用 `<run-id>.<attempt>`。
标识遵循 SemVer 预发布规则。包内 `makaSource` 记录源码归档名、源码版本与 SHA-512，
用于溯源，不是签名构建证明。
仅本地未签名候选可省略 `--keys`。本机构建会验证版本和 V8 执行；仅跨平台打包必须指定 `--validator`，
许可证清单默认取自源码中的 Rust 依赖清单。
`Native CLI preview` workflow 用同一份冻结源码构建三个平台。
`node scripts/rust/publish-cli.mjs <产物目录>` 校验三者的共同来源；
附加 `--publish` 才会发布完整产物集到 `rust-preview`，CI 提供 npm provenance。
可用 `CARGO_TARGET_DIR` 保留构建缓存；`MAKA_JS_DEPS` 固定为解包源码自身的安装目录。

`node scripts/rust/pack-cli.mjs --target <目标> --version <精确版本>
--binary <目标平台maka> --validator <本机maka> --notices <已审阅许可证文档>
--output <目录>` 打包预构建原生程序，并用本机 CLI 校验实际 npm 归档。
不执行跨平台程序或安装脚本，不发布，也不覆盖已有输出。许可证文档须覆盖 Rust、V8
及嵌入 JavaScript；旧 Node CLI 文档不足以代替。此底层打包器本身不证明源码来源。

Rust 许可证检查沿用 [OpenDAL 的 cargo-deny 做法](https://github.com/apache/opendal/blob/main/scripts/dependencies.py)：
`deny.toml` 定义五个发布目标、许可证白名单和限定版本的 MPL 例外。
安装 cargo-deny 0.20.2 后运行 `node scripts/rust/dependencies.mjs check`；
依赖变更后将 `check` 换为 `generate`，审阅
[`DEPENDENCIES.rust.tsv`](../crates/cli/DEPENDENCIES.rust.tsv)。
清单包含构建依赖，排除仅用于测试的依赖；许可证策略检查也覆盖测试。
清单不是二进制许可证文本包。

ASF 投票制品是源码归档，许可审阅针对实际随包源码，包括根 `LICENSE` 和 `NOTICE`
记录的 Codex 补丁改编代码与 Deno telemetry 拷贝；lockfile 引用不等于打包代码。
npm 原生包是对应源码归档的便利构建，不是另一份源码发布；须保留来源版本和构建溯源。
源码验证拒绝 SQLite 数据库二进制，不因文件名或清单登记而放行。
历史数据库样本以 SQL 分发，仅在测试时还原。
当前源码审计不作二进制许可认证。

```sh
cargo fmt --all --check
cargo nextest run --locked --workspace -j 4
cargo test --locked --workspace --doc
cargo clippy --locked --workspace --all-targets -- -D warnings
node scripts/asf-license-headers.mjs check
```

模块采用 `name.rs` 与 `name/` 子目录。单元测试放源码模块末尾，集成测试放
`tests/`。业务契约使用 struct／enum，通过 schemars 派生 schema；JSON Value
只用于真正开放的载荷和动态 schema。表与索引归 SQLx migration 管理，启动只重建
派生数据。依赖 V8 的测试在各 crate 内共用一个
测试二进制，避免重复链接。普通测试使用本地 fixture；真实服务测试需要显式启用。
ignored 测试 `original_client_live_provider` 接受 `MAKA_LIVE_PROTOCOL`（`chat`、
`responses`、`messages`）、`MAKA_LIVE_BASE_URL`、`MAKA_LIVE_MODEL` 和
`MAKA_LIVE_API_KEY`，默认使用开发环境的 SGLang 端点。
独立 worktree 可将 `MAKA_JS_DEPS` 和 `NODE_PATH` 分别指向已有依赖的 checkout
及其 `node_modules`。
共享跨语言 fixture 放在根目录 `tests/fixtures`，通过 `tests/support/source.mjs` 加载当前 TypeScript 源码，不读取 workspace `dist`。

Grep 差分测试需要 PATH 中有 `rg`；runtime 本身不依赖该可执行文件。

## 当前限制

已实现项目管理、基本 Session／Turn 控制、模型配置、附件、文件工具、shell／PTY、Client Capability 工具、
模型流式交互与上下文压缩。Codex 订阅已接入执行；Copilot／xAI 推理适配和实测后置。

WorkHub 已支持受限对话、候选发现、交互式目标选择、向已有或新建会话委派、steering、停止、恢复和纠正。
“委派模型与恢复”可修复创建失败的任务，也可更换已有目标的模型；使用当前调用者授权及配置 CAS，
保留原委派、根会话身份与执行回执。遇到并发修改或任务忙碌时，可刷新后重试。
控制操作追踪精确的委派 Message，不操作无关 Run。纠正先持久化意图，再退休旧关联，
原子提交替换、附件与排队消息；协调 Run 结束后仍可恢复完成，新目标不可用时持久化中止结果，
不会取消共享 Run。结构化记录保留原始创建选项与附件归属，候选查询提供最新有效关联。
等待确认或阻塞的任务仍可发现；发现不授予委派权限，准入时仍检查待决交互与未决副作用。
待决交互驱动共用 Session 目录及变更通知，WorkHub 的“需要你”列表与候选发现保持一致，解决交互后及时清除。

剩余功能、完整领域的内置插件迁移计划及 SDK／客户端接缝统一维护在
[功能等价与内置插件清单](rust-parity.zh-CN.md)，不在此重复列举。

Recall 是会话历史检索，不属于排除的 Memory 子系统。原生部署和更新能力不代表完整产品兼容。
插件平台支持静态链接 Rust 包、共享／独立 V8 的 JavaScript 包、作用域 Host 服务、外部 Executor，
以及 Desktop Slot／Remote stream。Graph／Swarm 与定时任务是内置插件。
Graph 实现类工作使用 Host 管理的 gix worktree，发布不可变补丁，不自动合并。
`agent_list` 返回可直接用于 Graph 工作的 `target`：Agent 继承父级后端，Preset 选择配置的模型，
Executor 选择插件后端，不能叠加原生工具 Profile 限制。
单次 Turn 编排跨 yield 和 resume 保留，不改变 Session 默认值；Swarm checkpoint 提供状态和最终结果 ID，
通过历史分页取回正文。接口与限制见[插件 SDK](../packages/plugin-sdk/README.zh-CN.md)。
OS 沙箱暂缓。Memory 留待单独重做，不移植旧实现，也不纳入本次重写。内容脱敏不实现。
