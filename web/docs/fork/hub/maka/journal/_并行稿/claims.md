# 认领轨台账

> 认领 issue → 修复/实现 → 验证 → PR。每单必记：动机/改动/验证/后果/经验。

### PR-002 ｜ #4481 fix(cli): abbreviate home-relative Windows paths in the status line
- 日期 / 链接：2026-09-01 提交 / https://github.com/apache/maka/pull/4481
- 轨道与来源：认领轨，issue #3825（bug + help wanted + good first issue；0 评论 0 认领），先评论 `take` 再动工
- 动机：statusline 的 `shortenCwd` 用 `home + '/'` 前缀匹配，Windows 的 `C:\Users\<name>\...` 永远匹配不上，子目录全部显示完整绝对路径
- 改动：`packages/cli/src/pi-transcript.ts`——`shortenCwd` 改走 `path.relative` 比较、拒绝 `..` 前缀与绝对结果、导出函数；`pi-transcript.test.ts` 新增 5 个聚焦用例（POSIX 2 个、Windows 3 个，按平台 skip 守卫）。合计 +55/-5
- 验证：目标套件 `node --test dist/__tests__/pi-transcript.test.js` → 110 pass / 0 fail / 2 skip（POSIX 用例在 win32 按设计跳过）；`format:check` 1780 文件通过；`check:asf-headers` 3146 文件通过；完整 cli 套件在这台 Windows 上有一个预存失败（`runtime-host-update-reconciliation` 的目录 fsync EPERM，即 #3898 追踪的缺口，与本次改动零导入关系），已在 PR Verification 里如实注明
- 提交后果：open，待审核
- 经验一条：这台机器的 node_modules 曾是半截安装（`.bin` 链接为 0），`npm install --ignore-scripts` 约 1 分钟补齐；cd 触发的 fnm 钩子报错会以退出码 1 截断 `&&` 命令链，git 操作全程用 `git -C` 绕开；后台跑 `npm test | tail -30` 会吞掉测试摘要，重要输出要落文件；spawn 重度的脚本测试并发跑会互相踩（单跑即绿），先分文件单跑再定性，别把环境问题当代码 bug

### PR-003 ｜ #4485 fix(desktop): show platform-correct shortcut labels on Windows and Linux
- 日期 / 链接：2026-09-01 提交 / https://github.com/apache/maka/pull/4485
- 轨道与来源：认领轨，issue #3876（bug + help wanted + good first issue；0 评论 0 认领）
- 动机：快捷键显示串硬编码 macOS 符号——sidebar 的 `⌘ N` 和命令面板 3 条 hint（⌥⌘S / ⌘, / ⇧⌘D，中英双语）在 Windows/Linux 上显示错误（行为本身是对的）
- 关键判断：读全消费链后发现 Kbd 组件**已平台感知**（`mod` 在非 Mac 渲染 Ctrl），键盘帮助面板走 Kbd 所以本来就对；真正病灶只有绕过 Kbd 的裸字符串。`keyboardHelp` 的 keys 数组**刻意不动**——它们经 ASTRYX_KEY_TOKENS 解析成 mod 注册快捷键，改了反而坏。issue 里"避免在 shell-copy 硬编码"的建议按此收窄执行
- 改动：`packages/ui/src/utils.ts` 新增 `isAppleShortcutPlatform`（与 Kbd 同款 navigator.platform 回退）；sidebar kbd 与 6 条 hint 改由它驱动；新增 `__tests__/utils.test.ts`。合计 +77/-7，4 文件
- 验证：ui 全套 278 pass / 0 fail（含新用例）；renderer typecheck exit 0；`format:check` 1780 文件通过；`check:asf-headers` 3147 文件通过
- 提交后果：open，待审核
- 经验一条：issue 的修复建议也可能以偏概全——先画完整数据流（数据→解析→渲染组件）再定改动面，本次一半的"病灶"其实是设计系统已修好的；grep 全仓 30 处 ⌘ 逐一定性（注释/逻辑/显示串）后才动手，避免了 8 文件大扩散

### PR-004 ｜ #4488 test(eval): bound fragmented-handshake recv by the handshake deadline
- 日期 / 链接：2026-09-01 提交 / https://github.com/apache/maka/pull/4488
- 轨道与来源：认领轨，issue #4240（bug；0 评论 0 认领）。原定候选 #3938 实测后放弃——报错原文在当前代码已不存在，Node fs.glob 对嵌套 junction 不再失败，剩余是需维护者拍板的安全策略问题
- 动机：live egress 代理测试间歇性超时——`sock.settimeout(10)` 与 `timeout_s=20` 两套时钟并存，CI 负载下单次 recv 超 10s 就死，哪怕 20s 总预算还剩很多；碎片越多轮次越多，"每轮各掷一次 10s 骰子"正好解释了为什么只有 fragment=2 间歇中招
- 改动：`packages/eval/harbor/test_egress_filter_live.py` +73/-1——新增 `recv_within_deadline`（每次 recv 上限绑剩余 deadline，结束后恢复调用方超时）；FakeSocket 补 gettimeout/settimeout；新增合约用例（每次 recv 上限为正值 ≤ timeout_s、逐轮递减、调用方超时被恢复）
- 验证：`python -m unittest test_egress_filter_live -v` → 8 tests OK（2 单元用例过、6 个 live 用例按门槛跳过，需 Docker+mitmproxy 由 CI 跑）；`format:check` 1780 文件、`check:asf-headers` 全过
- 提交后果：open，待审核
- 经验一条：flaky 测试先找"两套时钟并存"——单次操作的超时和整体 deadline 各自为政时，负载下必然间歇炸；修法是让每次阻塞等待的上限绑剩余总预算（合约统一），而不是盲加重试或调大数字（issue 里也明说了不许）。另外：intermittent + 只有特定子用例中招 + 各轮独立超时，三个信号凑齐就基本能锁定这类根因

### PR-010 ｜ #4566 test(runtime-host): bound test wait helpers by wall-clock deadlines
- 日期 / 链接：2026-09-03 / https://github.com/apache/maka/pull/4566
- 轨道与来源：认领轨，issue #4510（take）。#4383→#4387 的同类病在 runtime-host 重演：固定 tick/固定次数轮询在负载下提前放弃
- 动机：5 个测试文件的轮询 helper 用固定 tick 预算（100×10ms、20×10ms、10 immediates…），负载下条件还没成立预算就耗尽，失败无法与真回归区分
- 改动：按 issue 清单把 9 处循环换成 `@maka/core/test-only/async-primitives` 的共享 `waitFor`（5s 墙钟 + 小轮询间隔），保留各 helper 的失败文案（富诊断的两处用 catch 重抛）；5 文件 +187/-128，纯测试基建
- 验证：policy-coordinator 18 过 1 skip；plan-two-client-uds（真 UDS）1/1；peer-mesh 20/20；execution-model-composition 26 过 1 失败（EBUSY unlink，干净 main 同样失败=预存）——**该文件以前在本机跑到一半就挂死，换墙钟预算后能完整跑完出摘要**；peer-native 2 失败（ESM URL scheme，干净 main 同样）；format/asf 过
- 提交后果：open
- 经验一条：闭包会丢 TS 窄化——把外层 `let` 变量（composition/graphStore）收进 `const` 局部别名再用；`waitFor` 的 message 是静态字符串，要保留"失败时才算出的富诊断"就用 catch 重抛。预存失败定性这回升级成"stash 前后同跑对照"，两个套件各 3 分钟换来 PR 里零争议

<!-- 新记录追加在这里 -->

### PR-005 ｜ #4506 fix(cli): exit 1 when a denied sandbox boundary is never retried
- 日期 / 链接：2026-09-02 / https://github.com/apache/maka/pull/4506
- 轨道与来源：认领轨，issue #4388（先评论 take）
- 动机：非交互 `maka run` 里边界请求被拒后，任一其他工具在后续 Step 成功就会把唯一的 sandbox 失败清成 recovered，退出码 0 + 道歉文本上 stdout，CI 会把失败当成功
- 改动：`TurnOutcomeClassifier` 把失败调用的工具名随 Step 一起记账，恢复判定加"后续成功必须是同一工具的重试"；3 个新用例（live/durable 分类器级 + 进程级退出码），+42/-3 两文件
- 验证：目标套件 37/37（修前 2 个新用例红：exit=0、recovered）；format/asf 过；cli 全套 725 tests 41 fail 全为预存平台缺口——用 stash 前后同跑两个代表套件证明结果逐位一致（9 tests/5 pass/4 fail）
- 提交后果：open
- 经验一条：claim 前必须逐个核对评论区——本轮初筛 9 个候选 7 个已被 take；"41 个全量失败"的定性收尾靠干净树基线对比，比逐个解释失败原因省一半时间
- **第四轮 review 修复**（2026-09-04，Astro-Han P2/P3）：①activation 测试注释+PR 正文改为"guards the current contract, transition not coverable after deletion"（`recovered` 已不在类型里，无法用注入的 outcome 表达旧形态）；②`boundaryFailureInvocationIds`+`unclassifiedBoundaryFailure` 收敛为单个 `boundaryFailure` 布尔（set 的唯一读者是 `.size > 0`，死赋值配对已删分支）；③两个测试改名去掉虚假的"different target"声明（fixture 不传 args，分类器也不读 args）；④回退四处 no-op 参数添加（`toolStart`/`storedToolCall` 的 `args` 参数及显式 `'Read'` 传参全是装饰）。验证 39/39+12/12+format+asf 全绿，单提交 0796f1112 强推覆盖混合提交
- **rebase 修复轮**（2026-09-04）：main 连吃三波（RuntimeInvocation 收敛、#4722 砍 capture、#4754）把 PR 干成 dirty。本地 rebase 两跳：适配 API 的 3 行修复（graphStore→graph、runtimeInvocationOutcome）amend 进原提交保单提交；与 #4722 删 waitForCaptureArtifacts helper 的冲突取 HEAD 侧删除。教训：rebase 后必须整条依赖链重建再编译（stale core dist 报过假错误 promptComposition 不存在）；node --test 挂住不退出用 --test-force-exit。本机剩 2 类失败：waitFor 5s 预算在重负载下超时（child patch 测试，#4510 取舍内）、peer-native Windows ESM 路径要 pathToFileURL——都还没修，CI 是 Linux 不受影响

### PR-006 ｜ #4513 fix(i18n): make resume-park and connection-error copy locale-aware
- 日期 / 链接：2026-09-02 / https://github.com/apache/maka/pull/4513
- 轨道与来源：认领轨，issue #4489（take）
- 动机：`resumeParkToastCopy` 33 条中文硬编码无 locale 参数（英文用户看到中文 toast）；`connection-error-copy` 的中文 copy 表已无读者（桌面/CLI 各自本地化）且与文档声明矛盾
- 改动：ui 包新 `UiCatalog<ResumeParkCopy>`（zh 原文不动、en 全新 33 条）+ 调用点传 `uiLocale`；core 砍 copy 表留解析器，`CHAT_CONFIGURATION_REASONS` 改显式数组 + `satisfies`/`AssertNever` 双向编译期穷尽断言；runtime-host 的 fake-backend 拒绝消息改英文（消费者只解析 reason token）
- 验证：新测试 4/4（对旧实现 3 红=天然 red-green）；fake-backend 拒绝用例单跑过；cli tui-session-status 3/3；format/asf 过
- 提交后果：open
- 经验一条：上游 main 的 ui typecheck 因 #4207 依赖未发布 canary 包而红——先确认 noEmitOnError 未设置（类型红但 dist 可用），再把预存失败写进 PR 表格，比绕开验证跑道诚实且省事

### PR-007 ｜ #4514 fix(desktop): keep the Agent Graph panel visibly alive
- 日期 / 链接：2026-09-02 / https://github.com/apache/maka/pull/4514
- 轨道与来源：认领轨，issue #3878（take）
- 动机：fan-out Graph 早期只有静态 `运行中 · 0/7` 和静止蓝点，用户误判卡死按停止
- 改动：running/runnable 圆点 CSS 脉冲（reduced-motion 关闭）+ 头部 Spinner 心跳（active/waiting/closing）+ 按 graphId 的视图内秒表 `· 00:23`（aria-hidden）；零协议改动，+81 行
- 验证：desktop renderer typecheck 基线 0 错误→改后 0 错误；format/asf 过；用 Storybook story（BlockedOnUpstream/ManyOperators）实测截图确认转圈/秒表/脉冲可见
- 提交后果：open
- 经验一条：effect 依赖整个 snapshot 会把秒表每次刷新归零——依赖要收到 `snapshot?.graphId`；React 19 的 `useRef<T>()` 必须显式给 undefined 初值

### PR-008 ｜ #4517 fix(desktop): load desktop stories on Windows with a config-relative glob
- 日期 / 链接：2026-09-02 / https://github.com/apache/maka/pull/4517（自发 issue #4516 并 take）
- 轨道与来源：功能轨外的一个顺手真 bug：给 #3878 截图时发现 desktop storybook 在 Windows 只加载 53 条（全部来自 packages/ui），11 个桌面 story 文件全被吞
- 动机：`resolve(REPO_ROOT, 'apps/desktop/stories/**/*.stories.@(ts|tsx)')` 在 Windows 产出反斜杠绝对路径，glob 库把 `\` 当转义 → 模式失配且静默跳过
- 改动：main.ts 一行——桌面 stories glob 改成与 ui 条目同款的配置相对正斜杠形式 `'../stories/**/*.stories.@(ts|tsx)'`
- 验证：index.json 53 → 251 条，Product/Agent Graph story 可渲染可 play；format/asf 过；Linux 不受影响（相对 glob 本就按 configDir 解析）
- 提交后果：open
- 经验一条：Windows 上给 glob 库喂 `resolve()` 产出的绝对路径 = 静默失配；索引从 53 跳到 251 是最硬的证据。另外 npx 在 fnm 环境下可能拉到假的 `tsc@2.0.4` 包，一律用 `node_modules/.bin/tsc` 绝对路径

### PR-015 ｜ #4797 fix(runtime): history-compact 指令改为末尾 user 消息（认领 issue #4634）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4797 （分支自 22715e84f 切）
- 动机：#4634 报告 k3-256k 上 compaction 永远 failOpen（51 连败/180 调用零 checkpoint）——summarizer 把分节摘要指令放 system 位，agentic 模型不理会；且独立 system 前缀吃掉主循环缓存（单次白跑最高 88s）。issue 质量极高，附 API 级复现表
- 改动：`history-compact-summarizer.ts` 的 `generateSummary` 把指令并入请求末尾的 user 消息（复用 #4559 已有的"请求必须以指令结尾"结构），删掉 `AiSdkGenerateTextOptions.instructions` 字段，常量改名去 System；只做 issue 方向 1，缺陷 1（maxOutputTokens）已由上游 #4653 修掉，2/4 号缺陷留给报告人拆单
- 验证：红绿实测——只回退生产文件重建后 3 用例挂（新回归+两个变体捕获），恢复后 53/53；三套件 139/139；format:check 1942 过；asf 头过。过程中踩到 core dist 陈旧（缺 runtime-invocation 模块）导致 runtime 构建全红——先建 core+storage 再 runtime 即解
- 提交后果：open，等审核
- 经验一条：**workspace 级构建前先确认依赖包 dist 新鲜度**——runtime 的 tsc 解析 @maka/core 的 dist，上游新增模块后本地旧 dist 会报一片无关的 TS2307；顺序 core → storage → runtime。红绿验证用 `git stash push -- <生产文件>` 最省：测试文件留在树上，新用例直接对旧生产代码跑

### PR-R020 ｜ #4802 docs(blog)：rehydrate 中文翻译修正（认领 issue #4767）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4802 （分支 docs/blog-rehydrate-zh）
- 动机：issue 验收标准明确到词级（水合→恢复执行状态/恢复会话上下文、全英文图标签保留、只改一个文件），零风险快单
- 改动：正文 405 行 + 图 425 行两处；图对齐用 CJK 双宽模型算前导空格（新标签宽 5 列，前导 25→20 保持箭头尾部对位）
- 验证：grep 水合零残留；四条图内标签逐一对照验收标准；format 过
- 提交后果：open，等审核
- 经验一条：**ASCII 图里替换 CJK 标签必须重算前导空格**——CJK 双宽渲染下标签加宽 5 列，不减前导就把箭头尾巴顶出去；`unicodedata.east_asian_width` 一段小脚本比目测可靠

### PR-024 ｜ #5116 fix(runtime): DingTalk 1:1 回复路由（认领 issue #5111，09-10）

- **动机**：DingTalk 1:1 消息能收不能回——`pickDingTalkSendRoute` 用 `startsWith('cid')` 猜路由，而真实 1:1 和 group 的 conversationId 都以 `cid` 开头，全部错走 group 端点；且 1:1 端点按 `senderStaffId` 寻址，解析时被丢弃。issue 作者做了三方 live 实验（conversationId/senderId/senderStaffId 各发一次）把根因和验收钉死，还给了 QQ bridge 盖章先例——理想接单单。
- **改动**：+103/-41 两文件。照 QQ 惯例：`dingTalkPayloadToEvent` 按权威 `conversationType` 盖章 chatId（`group:<cid>` / `oto:<staffId>`），payload 捕获 `senderStaffId`；`pickDingTalkSendRoute` 解码前缀、未知 fail-closed 返回 null；无 staffId 的 1:1 保裸 conversationId（能收、回复拒绝而非发必败请求、不降级通道）。测试 fixture 全换真实形状（两种对话都是 `cid…=`），前缀猜测回归必挂。
- **验证**：runtime 构建 0；bots 全套 102/102（dingtalk 9/9）；biome format 触及文件干净；ASF 头在。**未验证：live DingTalk 端到端投递**（issue 作者的 live 实验已钉死 API 行为），PR 里明说。
- **提交后果**：PR [#5116](https://github.com/apache/maka/pull/5116) 开（base main），等审核。
- **经验一条**：issue 作者跑过 live 实验的单是最便宜的根因分析——三方对照实验直接排除"修 robotCode"的错误方向；测试 fixture 长得像实现假设时会"假绿"（`user-99` 永远不会撞上 `cid` 前缀分支），修路由类 bug 先把 fixture 换成真实平台的 id 形状。

### PR-025 ｜ #5118 fix(desktop,cli): edit-and-resend 保留 quotes（认领 issue #5109，09-10）

- **动机**：edit-and-resend 三处违反 canonical 合同——Desktop 永久禁编带 quote 消息（大粘贴自动变 QuoteRef 即不可编辑）、陈旧的 retained-attachment 历史扫描（Host 已能无损复制工件并重写 ref）、TUI /rewind 只回填文本静默丢结构化上下文。
- **改动**：+394/-33 八文件。Desktop：chat-turn 放开 quotes 编辑守卫（attachments/directoryReferences 保留）；revision draft 携带 `originalQuotes`/`previousQuotes`，编辑时把源 quotes 换入 composer staged set、取消时还原；unchanged 守卫升级为 `revisionContentUnchanged`（text + staged quotes 对 source 比较，堵住 issue 点名的 quote-only 误判）；删 retained-attachment 历史扫描。TUI：rewind 遇 quotes/attachments 显式 fail-closed（issue 明文允许）。**范围外**：选中消息的附件编辑（需 Host 暴露重写后 ref）和 TUI quote staging，PR 里标了 follow-up。
- **验证**：desktop revision-actions 7/7（新测试文件）、ui chat-turn 17/17、cli 新 rewind 测试 1/1 + TUI rewind 8/8；三包构建 0；biome/ASF 干净。**已知预存**：arch checker 的 vite fixture 和 51 个 cli driver 测试在 Windows 本机因 POSIX 路径 fixture（/tmp、/fixture）必挂，与本改动无关，PR 里说明。
- **提交后果**：PR [#5118](https://github.com/apache/maka/pull/5118) 开，等审核。
- **经验一条**：跨分支连续接单时工作区文件是当前分支的——编辑前必须重读（#4815 分支的修改不在新分支上）；linkedom 下 React 合成事件要用 `button.click()` 而非 `dispatchEvent(new Event('click'))`；快照语义（draft 存 `previousQuotes`）必须拷贝数组，引用别名会让"取消还原"还原成自己。

## 本日小结（2026-09-10 接单循环）

三单交付：#5116（DingTalk 1:1 路由，小单）、#5118（edit-and-resend quotes，中单 ≤400 行）、#5125（OpenCode 会话扫描，feature ≤300 行）。#4815 重审等待中。

### PR-025b ｜ #5125 feat(storage): OpenCode 会话扫描（认领 issue #5053，09-10）

- **动机**：foreign-session 目录列了 Claude Code 和 Codex 但没有 OpenCode——`FOREIGN_SESSION_SOURCES` 无 `opencode`，`~/.local/share/opencode/opencode.db` 里的会话永不出现，而 import adapter（#3403）早已会读这个库。
- **改动**：+275/-2 三文件。最大复用：scan/digest 全部走 `OpenCodeSessionAdapter`（schema 自省、parent/child 规则、transcript 转换都是现成的），store 只加 #1057 边界——`MAKA_IMPORT_OPENCODE=0` 斗篷开关、50 会话/30 天上限、`isSafeForeignId` 门；digest 走 `adapter.readSession`（只读连接）共享既有 sanitize/redact/accumulator 管道，thinking（text:''）天然不进；`foreignSourceLabel` 加 "OpenCode"。
- **验证**：foreign-session-store + opencode adapter 45/46（唯一失败是 Windows symlink EPERM 预存环境限制）；biome/ASF 干净；未对真实 OpenCode 安装跑 live 验证（fixture 是 1.18.21 采集的 schema），PR 里注明。
- **提交后果**：PR [#5125](https://github.com/apache/maka/pull/5125) 三轮评审后（09-16）**标记被替代关闭**——#5308 已合并（统一走 Host 导入、删除 foreign-session store），按维护者定调不再修补旧路径；可复用资产（adapter 单一权威、上限、synthetic parts 剔除、CJK 字节预算回归、真实 schema 证据）已在关闭评论列出供整合方取用。
- **经验一条**：复用型 feature 单的忠实标尺是 issue 的 non-goals 段——"不写 OpenCode 数据库、不加其他 source、不动 import"三条直接砍掉了一半设计冲动；node:sqlite 的 `DatabaseSync` 不会自动建父目录（seed 要先 mkdir），测试同库多次 seed 用 `CREATE TABLE IF NOT EXISTS`。

### PR-026 ｜ #5265 fix(cli): TUI rewind 恢复 quotes 进替换提交（认领 issue #5109 续，09-13）

- **动机**：#5109 的 behavior C 在 #5118 里是 fail-closed（`rewind_unsupported_quotes`），issue 明文允许但承诺"until the TUI can carry it"。本次补正向实现：协议层 `turn.message.submit` 本就收客户端 quotes（只有 session_context 附件是 Host 独占，#4804 起带 quote 的空文本也是有效内容），纯粹是 driver/TUI 没接——不用动协议。
- **改动**：+381/-64 八文件。driver：`MakaSubmitMessageOptions.quotes` 透传 submit content；`rewindToTurn` 对 quotes 不再拒绝、原样返回 QuoteRef（attachments/directoryReferences 维持 fail-closed）。TUI：暂存按分支会话键控（换会话自动失效，不用每条 switch 路径手动清）；状态行 `quotes:<n>` accent 分段；裸 `/quotes` 列出暂存、`/quotes clear` 显式丢弃；首个被收下的提交消费暂存，被拒/失败回填以便重试。删除死代码 `rewind_unsupported_quotes` 码+三语文案。core 只加目录条目 `{ id: 'quotes', session: 'none', surfaces: ['tui'] }`。
- **验证**：4 个新测试先红后绿（红证：rewind 拒 quoted 轮次、submit 缺 quotes、无暂存指示、无 /quotes 命令）。runner 全量 207/209（2 个 SIGTERM 失败经干净 worktree 基线对照=upstream 预存 Windows 信号问题）；driver 全量 25/75（50 个全是预存 POSIX /tmp fixture，名单核对无本次新增/修改项）；copy-catalog 8/8、guidance 8/8、core catalog 1/1；ASF exit 0（`.git/info/exclude` 排除 .mimosa 后）；format:check 整仓 biome 段错误（本机环境），8 个改动文件逐个 biome check 通过，PR 里注明。
- **提交后果**：PR [#5265](https://github.com/apache/maka/pull/5265) 开，等审。09-14 评审修复（6ca7ff99b，CI 绿）：P1 恢复 quotes 改为派发时捕获 originSession+代数、限同会话同代才回填（切会话/新 rewind/显式清除均不再误带）；P2 三个空文本守卫把暂存 quotes 视为有效内容（quote-only rewind 可原样重发，/quotes clear 后仍拒空）。#5125 维护者已定整合路线（走 #5053，本 PR 待标记被替代），已回复确认协调复用，不再打补丁。
- **经验一条**：TUI 测试里 `terminal.input('text\r')` 整块送入会被编辑器当 paste 缓冲、内嵌 \r 不触发提交——必须 text 和 '\r' 分两次 input（现有测试全是这么写的，对照先例最快）；biome 整仓 format:check 本机段错误 139 时可退 `biome check --formatter-enabled=true --linter-enabled=false <改动文件>` 拿相称证据；.mimosa 干扰 asf-headers/ 让 git status 变脏，写进 `.git/info/exclude`（本地不 tracked）一条解决。

### PR-027 ｜ #5274 fix(desktop,ui): 选中消息的 quotes/attachments 重上（#5109 续，09-14，**draft/被棘轮阻断**）

- **动机**：#5109 桌面侧剩余——选中消息自带 quotes/attachments 时编辑被拒、替换提交只带文本。方案：编辑时把源上下文暂存进 composer 两块盘子（quotes 直接恢复、附件以 retained refs 恢复），revision commit 后按 sourceTurnId 从分支会话 transcript 取回**已重写**的 target-owned refs 换入盘子——纯客户端、零协议改动，符合 issue 的 Host 权威边界。
- **改动**：7 文件（ui chat-turn 守卫放开 quotes/attachments、新增 revision-staged-context.ts 模块、desktop revision-actions/app-shell 接线、三语文案一删一改写）。
- **验证**：ui 新测试经 stash 对照 2 红→2 绿；desktop revision-actions 3/3；locale hygiene/biome/ASF 过；**CI strict-base 渲染器债务棘轮红**：app-shell-revision-actions.ts 冻结在 2155 nonTriviaTokens，最瘦抽取后仍 2318（+163），棘轮从不接受增长（账本历史全为递减，#5118 也是净减过闸）。
- **后果**：PR [#5274](https://github.com/apache/maka/pull/5274) ready 等维护者决策。09-15 对抗式定位最终根因：base 账本 dependencyPaths 键集里没有 `@maka/ui`，而 #5109 restage 功能**不可约地需要这一条新运行时边**（工厂导入），app-shell 的 @maka/ui 账已满（1/1）零余量、新 renderer 文件禁止入账——**这是设计性死锁，二选一需维护者拍板**（①一次性 sanctioned 账本变更 ②批准新的抽取模块），已在 PR 留言附逐指标 diff。分支最佳态已推（c24095034：506 tokens/6 spec + 13344/104，本地全绿）。09-15：CI 审批通过且 **2/2 全绿**（棘轮首次过闸）——已转 ready 并留言说明取了路线一（生命周期下沉 @maka/ui）。同日 #5258 收到评审意见（Resolver 段落无实现支撑），另一会话已推送 ce66c5c0f1（补时效注、撤回零漂移表述）并回复，本会话不重复动作。**09-15 工厂整体搬迁已执行**（c4d7065321）：revision 生命周期全部进 `@maka/ui/revision-staged-context`（env 注入桥/文案/attempt tracker），desktop 留薄装配（506 tokens/6 spec），app-shell 删冗余双门回归 13344/104——双双入预算；app-shell 顺带删掉一段引用已删字段的死守卫（.tsx 从未被本地 tsc 覆盖，潜伏类型错误）。本地验证全绿（revision-actions 3/3、ui chat-turn 26/26、biome、ASF）；**CI 对新 head 未触发**（pull_request workflow 不跑、pull_request_target 正常，疑似外部贡献者需审批），close/reopen 与空提交均未唤起，已在 PR 留言请维护者批准运行。#5125 同日维护者定调走 #5053 整合、本 PR 待标记被替代，已回复确认。
- **经验一条**：desktop 渲染器债务棘轮 = 冻结文件 token 只减不增、新 renderer 文件禁止、strict-base 只认 CI（本地 `--base` 必段错误，plain `--write` 也随机段错误需重试）——**在 legacy shell 文件加功能前先查 renderer-architecture.json 的账本余量**，功能体应直接落 packages/ui（type import 不计费、value import 计费），别写完再瘦身返工两轮 CI。


### PR-030 ｜ #5820 fix(core): sanitizeUnicodeText 负值 code-point cap 放行全串（认领 issue #5537，09-29）

- **动机**：#5537 报 `capCodePoints`（thread-search.ts:599）在 `maxCodePoints <= 0` 时负索引 slice 放行几乎全串。认领后发现**目标符号已死**：`git log -S` 钉死 8d82007c4（09-28 remove TypeScript app stack）把整个 thread-search/recall TS 面连同该函数一起删了——issue 漂移。
- **转向**：同一边界 bug 的**负值变体**在 issue 引为"正确兄弟"的 `sanitizeUnicodeText` 存活——0 值路径对（早退+slice(0,0)），负值路径三连错：循环早退永不触发（全输入展开进数组）、`slice(0, 负值)` 尾部回数（`'hello'` @-2 → `'hel…'`）、空串返回 `'…'` 违背自家 JSDoc。修法 `Math.max(0, …)` clamp 对齐 `truncateUtf16Safe` 的 `maxUnits <= 0` 守卫先例，顺带删掉 clamp 后恒真的 `>= 0` 死检查。issue 评论说明转向后照常交付。
- **验证**：`sanitizeUnicodeText` 原先**零测试覆盖**（test 文件只测了 truncateUtf16Safe）——新增 describe 块钉 0/负/正/surrogate 四类边界，两条负值用例修前红（'hel…' / '…'）修后绿；core 全套 918/918（**首跑 5 个无关文件红 = 跨分支陈旧 dist**，clean+rebuild 即愈，正是 #5641 描述的病灶本尊）；biome 触碰文件、asf 头过。
- **提交后果**：PR [#5820](https://github.com/apache/maka/pull/5820) 开，等审。
- **经验一条**：认领轨也要跑审计轨的标识符生死检查——issue 带 file:line 不代表代码还在（本单 issue 质量很高仍漂移），`git log -S <符号>` 十秒定生死，死符号先找存活同源实现再决定关单还是转向；另 node -e 里 `'/tmp/...'` 会被解析成 `E:\tmp`（MSYS 路径转换只作用于原生 exe 的参数），JSON 载荷用 heredoc 一次成型最稳。

### PR-027 进展补记二（09-30，双 blocker 清零 + 本地工具链根因链）

- 09-30 评审确认引用修复有效，但指出两个 blocker：conversation-copy.ts 尾随空行（diff --check 红）+ renderer-architecture.json 与 main 冲突。处置：空行删除；冲突按口诀对合并树跑 `check-renderer-architecture.mjs --write` 实数重定价（app-shell.tsx 自动合并无需干预）。head `15564fb06`，desktop revision 8/8 + ui revision/context 50/50 + arch/ASF/diff-check 全绿，已留言。
- **本地工具链根因链（本轮最大收获）**：合并 main 后 desktop build:test 报一片 `BrowserState.loadError` 假错，三层根因叠加——①跨分支切过后 core dist 陈旧（增量 tsc 没重编 merge 带来的新字段）；②**desktop 的 `incremental: true` tsbuildinfo 把旧的 core 类型检查结果钉死**，core dist 重建后假错依旧，删 `apps/desktop/tsconfig.*.tsbuildinfo` + dist 才愈——tsbuildinfo 对跨 workspace symlink 的 d.ts 变化追踪不可靠，"重建依赖链"之后还要清下游的 tsbuildinfo；③标准恢复命令 `npm install --ignore-scripts` **会跳过 root postinstall 的 `scripts/apply-dependency-patches.mjs`**（给 @xterm/virtua/zod 等 8+ 个依赖打补丁），node_modules 重装后必须手动补跑，否则 ui/runtime 报一片假"缺导出"。验证矩阵增补：`npm install --ignore-scripts` → `node scripts/apply-dependency-patches.mjs` → core→…→ui 重建 → 清下游 tsbuildinfo。
- 环境：asf-headers 会扫到仓库根的无头残留文件（本次是 hash 探针下载的 .astryx-probe.tgz）——探针文件用完即删，别放仓库根。

### PR-030 补记（09-30，五路并行接单轮）

- 用 maka-hub 的 5 个 clone 派 5 个后台子智能体并行接单（主选+fallback 制）：#5641(pr1)/#5811(pr2)/#5799(pr3)/#5424(pr4)/#5547(pr5)。结果 **4/5 主选与 fallback 全被占**——#5811 作者自开自占（issue 与 PR 仅隔 1 分钟）、#5799 有 assignee、#5424 有 `Fixes #N` 占坑 PR（#5427）、#5547/#5576/#5578/#5549/#5762 均有 take/assignee/PR。子智能体全部正确执行"核验先行、被占即弃、零写动作"纪律。**结论：open issue 池雷区密度极高，`0 评论`不等于无人认领（占坑 PR 和 assignee 都是无评论占用），接单前的占坑三查（评论/assignee/PR 正文 Fixes）一个不能省。**
- 多 clone 并行的准备工作：origin=fork(HTTPS)/upstream=apache(HTTPS) 双 remote 预配置、fetch 预跑；子智能体提示词必须自带全部环境坑（git -C、apply-dependency-patches、/tmp 路径、gh 完整路径、台账不归子智能体管）。
- pr1（#5641）终局：主选被占（seekskyworld take + PR #5647），fallback #5551 核验通过后 take，深度分析发现**该 issue 已被作者自己的三个已合并 PR 覆盖**（#5552/#5553/#5593——正文写 `Refs #5551` 而非 `Fixes`，issue 因此未自动关），实证 53 个测试全绿后按约定 `untake` 收场，零副作用。**流程增补：占坑排雷不能只搜 `is:open` PR——merged 关联 PR（Refs 语义）同样意味着需求已交付，`search/issues` 不带 is:open 才查得到；take 之前先查 issue 的 timeline 里有没有 merged 关联单，能省一轮"接了再放"。**

### PR-026 进展补记三（09-30，第九轮：3 P2 + 3 P3 清零）

- 微信群 ping 后 Astro-Han + hqhq1025 双复审 `bd25e82fc`：前两条 P2 确认修好，新报 **P2-A** retraction 恢复的 quotes 被切换无条件清掉（唯一副本，side open、/session、quote-only close、rewind 全中）、**P2-B** Ctrl+/ 先捕获草稿后等 retraction 再写回旧稿（三处全空无 notice）、**P2-C** close 的 driver 等待窗口不锁输入、落地 `setText(parentDraft)` 覆盖用户飞行中输入；P3×3（quote-only close、notice 措辞、rewind 测试两侧同 quote）。
- 子智能体交付（head `5e538681b`，单提交）：**staging 拆双车道**——`followDraft` 车道（retraction 恢复的 quotes 骑草稿文本，随 per-view 草稿槽停泊/还原，会话键跟文本走）+ turn 车道（#5109"切换即清"规则原样保留）——同时满足"不丢唯一副本"与"不静默复活跨会话上下文"两条约束；toggle 捕获挪到 switch 完成后；close 落地后读实时编辑器（用户输入优先、parentDraft 空行拼接在下）；close 中止计入 staged quotes；notice 改中性字面量×2（登记 tui-copy）；rewind 测试改双侧异 quote 钉死替换语义。7 测试先红后绿（红证按 reviewer 复现路径，其中一条用"临时还原 HEAD runner"取严格红）+ 全量 254 测试 252/2（SIGTERM 预存）+ 消融五组。三条行内逐条回复 + P3 汇总。
- 教训：①"staging 键控"类修复的新测试必须断言 **TUI 实际提交**（`driver.submittedQuotes`）而非 fake 返回值——reviewer 专门点名；②review 给的两选一修法可以先做设计约束对表（#5109 的清空规则是硬约束），"带 quotes 随草稿走"是两全解；③子智能体的历史记忆路径会失效（E:\guahub 旧文档路径），台账由主线程统一维护是对的。

### 人工终审 ping 轮（09-30，用户指示）

- 现状确认：11 单的全部 review 均来自自动化 agent（hqhq1025/Astro-Han/me2seeks，均自注"不构成合并批准"），**人类维护者零表态**是积压主因。合并者识别：近期 merged PR 的 merged_by 为多人组（zhiiw / likun666661 / Colafornia / Astro-Han / chihumyum / me2seeks），zhiiw 最新最活跃。
- 已发四条：#5265（17 天，@zhiiw 请人工终审）、#5274（16 天，@zhiiw）、#5709（6 天，温和 ping 未 @）、#5744（3 天，温和 ping 未 @）。每条均附当前 head、最新修复、CI test 绿、merge-tree 干净的事实清单。perf 四单（2 天）与三个新单（≤1 天）未到 3 天线，暂不 ping；#5709/#5744 若再静默 2-3 天升级为 @。
- **经验**：等待合并的积压要区分"自动化审查未过"（我方动作）与"人工终审缺位"（ping 动作）——此前误把前者当成全部状态，漏了该 ping 的时机；merged_by 的多人组识别用逐 PR API（list 端点不填 merged_by 字段）。

### PR-026 进展补记二（09-30，第八轮 P2 双修复）

- hqhq1025 对 drain head（0f26b77c7）复审确认 ordering 正确，但新报两条行内 P2：**恢复的 payload 在 side 转换中处理错误**——①side open：drain 把父会话恢复文本放进共享编辑器后，`adopt` 只把它记进 `parentDraft` 却不把编辑器切到 side 的空草稿（父消息留在 side 编辑器里，Enter 会在 side 会话里重发父消息）；②side close：Ctrl+C 守卫对空编辑器放行，drain 随后回填的 side 文本被紧随的 `setText(parentDraft)` 覆盖丢失。修复：open 后 `editor.setText(sideDraft)`（对齐 Ctrl+/ 的 per-view 草稿合同）；close 在 drain 后非空即中止 + notice（"关只能从空草稿出发"合同的对称应用，后续 Ctrl+C 清稿后再关）。
- 流程：测试先改出红（3/3 fail，actual 与 reviewer 的临时断言逐一吻合）→ 修 → 绿（4/4 drain 测试 ×3 连跑）；全套 runner 245/247（2 个 SIGTERM 预存）；tui-copy（新 notice 字面量登记）+ locale-hygiene + biome + ASF 过。head `bd25e82fc`，两条行内已回复。
- 两个新教训：①**测试断言紧跟"session id waitFor"会读旧值**——driver 重键先于 runner 的 `setText`，竞态窗口真实存在（debug 探针存在时时序变慢恰好掩盖），断言要等最终可见内容本身；②**FakeTerminal 按宽度折行，notice 断言只能用短前缀**——整句长串跨行后 `includes` 必然失配（仓内所有 notice 断言都是短前缀，先例一致）。
- 另：本机 core dist 是分支共享的——在含 core 改动的分支（如本单的 quotes 目录条目）与 main 系分支间切换后必须重建 core，否则 cli 报 TS2353 假错（`quotes` 不在目录类型里）。

### PR-026 进展补记（09-27/28，review 修复闭环）

- 09-27 三轮评审意见当日闭环：P2 retraction 丢 quotes（`MakaRetractedMessages` 携带被撤条目的 quotes，Host 本就返回完整 MessageContent）；P1 跨会话 retraction 双竞态（runner 在两个 retraction 路径的首个 await 前捕获 owning session，driver 重键后迟到的响应不再误回填）；P3 回归测试缺口同日关闭。09-28 merge main（f58f30203）解 `runtime-host-session-driver.test.ts` 冲突（fake driver 已含本单的 session.re…字段，语义取并集），head 推进 `4e61b5fe5`。
- CI 红定性：head 的 `test` job 红 = **main 预存**（`acp-goal-plan-child-process.test.js` 的 AskUserQuestion 15s 无响应、文件跑满 900s 被杀；red 从 `0fd754083`=#5434 合入开始，父提交绿），已报 [#5777](https://github.com/apache/maka/issues/5777) 并在 PR 评论引用。
- 教训：review agent 说"no checks registered"常是 CI 未跑完而非丢失；把 main 预存红钉死到具体 merge commit（父子对照）是 PR 评论里最省口舌的证据形态。

### PR-027 进展补记（09-27/28，棘轮死锁解除后修复闭环）

- 09-27：base 更新后棘轮**首次过闸**（路线一：revision 生命周期整体下沉 `@maka/ui/revision-staged-context`，desktop 留薄装配）。随后按评审收缩范围：**附件半边 fail closed**（revision copy 排除被编辑轮次 → 本单无法产出 target-owned refs，恢复源 refs 会重建跨会话拒绝；Host 侧产出 target-owned refs 留给 #5109），删除附件 Edit 拒绝路径的 plate 残留处理器；no-op 门把 model-facing `comment` 计入 quote key（annotation-only 改动不再伪装成 no-op）。architecture-gate 失败修复后 CI test 绿。
- 09-28：修复 review 尾巴——desktop contract `conversation-copy.ts` 末尾双换行（formatter 排除区所以 CI 不报，1 字节 whitespace 提交 `74308319d`）；确认 PR 正文 Scope 段已如实（评审读的是旧版正文）。head `74308319d`，对最新 main merge-tree clean。
- 教训：评审 agent 引用"PR description still claims X"要先 diff 正文时间线再动手——正文可能已在后续提交里修好，重复改反而制造噪音；formatter 排除区（apps/desktop、packages/ui）的 whitespace 约定靠 review 兜底，新文件结尾照 sibling 单 `\n` 写。

### PR-028 ｜ #5709 feat(usage): filter usage queries by model call kind（认领 issue #5691，09-24）

- **动机**：usage 行本就记录 call kind（main loop=`main`，辅助调用各记各的），但查询层无法按 kind 选择——Session Inspector 的头条数字把 agent 主循环和 session_title/recap/goal_evaluation 等辅助调用混在一起。
- **改动**：`UsageQuery.callKinds` allowlist 三层贯通：runtime-host 协议解码器按 `MODEL_CALL_KINDS` 校验；canonical ledger 的 SQL 翻译成 `call_kind IN (…)`；legacy telemetry store 行过滤同谓词。空 allowlist 寻址零行而非"全部"。Inspector 缓存率改读 main-only（preload fail-soft 双读：窄读丢了退回混合率）——辅助 prompt 不共享主循环 cached prefix，混合率会低估缓存（10k 未缓存 suggestion 可把 95% 拖到 86%）。
- **验证**：ledger/legacy store/pricing-protocol/desktop overview 四层测试全过（PR 正文表）；两位独立 reviewer 线均报 no P0–P2/P3。
- **提交后果**：PR [#5709](https://github.com/apache/maka/pull/5709) 开。09-28 与另一分支独立撞 compatibility epoch 196，按口诀 main 条目保留、我方改记 max+1 后 merge main，head `04d5f354c`，test 绿。abort-path 准确性缺口是 issue 内明确的 scoped follow-up。
- **经验一条**：epoch 撞号不是事故是常态——发现撞号后别在 PR 里长篇解释，按手册顺延 + 评论一句话引用手册即可；"legacy 记录过滤不按 kind 收窄"这类"看起来像漏了"的设计要在 PR 正文写明理由（tombstone 无该列，收窄即少报），能省一轮评审往返。

### PR-029 ｜ #5744 chore: refresh the install-scripts allowlist against the lockfile（自主维护单，09-27）

- **动机**：npm ≥11.6 的 install-scripts 审批门按精确 `name@version` 键要批准——本仓库 fresh clone 会被 7 个包绊住：2 个键落后 lockfile（esbuild 0.27.7→0.28.2、@jackwener/opencli 1.8.4→1.8.7）、5 个脚本包压根没条目。没有审批门的 npm 版本看不到警告，这正是清单漂移的原因。
- **改动**：`package.json` 的 `allowScripts` 全部对齐 lockfile 精确版本（4 个非必要脚本 deny：@astryxdesign/cli/core 的 postinstall 只打印提示、protobufjs 只查版本记法、opencli 的补全安装在本仓库不触发；必要脚本保留 approve）。后续两笔：me2seeks P2 补 `fsevents@2.3.3`（lockfile `optional+darwin` 条目——Linux 扫描天然看不见，macOS 是一等平台）；me2seeks P3 落防漂移守卫 `scripts/check-allow-scripts.mjs`（双向比对：lockfile 有脚本而 map 无键 / map 键落后 lockfile / 值非布尔，optional 不豁免）+ 挂 `dependency-audit.yml` 新步骤。
- **验证**：守卫自测 4/4（干净 map、fsevents 案例、版本落后案例=本单根因、非布尔值）；真实仓库校验 9 包全覆盖；`ci-workflow-policy` 46/46；biome/ASF 干净；新 head 的 audit job 在 CI 真实通过。
- **提交后果**：PR [#5744](https://github.com/apache/maka/pull/5744) 开。CI `test` 红=main 预存（#5777，同 #5265）。三个 head 演进：`1e899b5dc`（初版 refresh）→ `7bdbbe1e`（P3 deny 四个非必要脚本）→ `aa31461d4`（P2 fsevents）→ `c43d3b077`（P3 守卫）。
- **经验一条**：跨平台仓库扫 `hasInstallScript` 别只看本机 node_modules——optional/darwin 条目在本机根本不安装，lockfile 才是唯一权威清单；review agent 提的 P3（防复发守卫）即使正式 reviewer 未背书也值得做——这类单的根因就是漂移，守卫是 50 行换一次根因封口，比在评论里解释"暂不做"更省。
- **09-28 二轮（Astro-Han 系）Changes requested 修复**（head `3b27537b7`）：P2 三窗全堵——retract 入口 `detaching` guard（镜像 interrupt 路径既有 guard）；toggle 尊重 `interruptRequested`（Esc/Ctrl+C 竞态不再 retract-and-drop + 丢 stop，顺带从源头关死 :1325 fence 窗）；fence 触发后 push error notice（点名被撤的消息数与 quotes 数）而非静默丢——**不 restage quotes 回旧 session 键**：`applySwitchResult` 每次切换清 staging 是 #5109 review 定过的设计（静默复活会发出用户看不见的上下文），restore-or-notify 取 notify 半边。修一条误导测试注释（mid-turn switch 只 detach 不 stop）。新 driver `RetractableSideConversationDriver`（side turn 可挂起 + switch RPC 可 gate）支撑两个新测试 + 旧回归加 notice 断言，三测试先红后绿。runner 238/240（2 个 SIGTERM 预存）；driver 25/78 全 53 败为 POSIX /tmp fixture 预存类（25 pass 对齐基线，且该测试不 import 改动模块）。结构注记（driver 调用传 expected session id）与 P3 清单未动：跨 driver 接口值得独立单子，评论已表态可开 follow-up。**环境坑新增**：node_modules/@maka 的 workspace symlink 指向仓库搬家前的旧路径 `E:\guahub\gh\fork\maka`（已不存在），tsc 报一片 TS2307 缺新模块——`npm install --ignore-scripts` 重建链接后按 core→storage→runtime→runtime-host→cli 重建 dist 即愈；判别特征是 dist 明明有该文件但 node_modules 链接 `ls -la` 指向旧家。
- **09-28 二轮收尾**：首个修复提交 `3b27537b7` 撞 `check:tui-copy` 红——runner 的 notice 可见字面量是登记制（`check-tui-copy.mjs` 的 ALLOWED_VISIBLE_LITERALS 多重集合比对、不要求顺序，模板串记 `${…}`），新 notice 两条字面量漏登记；`a72756ce7` 补录后 CI test 绿，当前 head `a72756ce7` 等复审。**教训（验证矩阵增补）**：动 pi-tui-runner 及 COVERED_FILES 内 18 个文件的可见文案，本地矩阵必须加 `npm run check:tui-copy` + `check:locale-hygiene`——这两项本机秒级完成，漏跑的代价是一整轮 CI 加一条诚实评论。**文档路径变更**：maka 活文档随仓库搬家，现位于 `E:\ggbdpq\gh-fork\docs\maka\pr\`（旧 `E:\guahub\docs\gh\fork\maka` 不再存在）。
- **09-28 三轮（Astro-Han/hqhq1025 各一条）**：对抗复现出第二条丢失路径——撤回飞行中 toggle 不挡，而 driver 只在 `switchSession` 结束时 re-key，两道 session fence 全部通过、撤回文本进 editor 后被 `switchView` 的旧 draft 覆盖。修复=`retracting` 标志（toggle + mid-turn /session 分支拒绝，照 review 给的最小修法），P3 空撤回静默返回；"notice 携带全文"不做（guard 关主窗口后 notice 只是最后防线，per-session draft 归入 expected-session-id follow-up）。两个新测试先红后绿，runner 240/242。head `5cee83425`。**同日 #5709/#5274 撞 main 审计提交（d74f25311，Grok 贡献重写）双双 dirty**：#5709 protocol epoch 第三次撞号（main 196→197、我方也 197，按口诀我方顺延 198，守卫绿 197→198，storage 52+pricing 8+desktop usage 21 全绿）；#5274 renderer-architecture.json 两处数字冲突——**正确解法不是选数字**：代码 auto-merge 后跑 `check-renderer-architecture.mjs --write` 对合并树实数重定价（app-shell 12127→12115 tokens、91→79 spec，全面 ≤ main 侧，棘轮满足），arch check 绿。desktop 自测 `attests the canonical main source` 1 失败经纯净 main worktree 对照=预存（110/1 完全相同），非 merge 引入。#5744 对新 main merge-tree CLEAN 且六项 CI 全绿，无需动作。
- **09-28 CI 红追猎（诊断典范）**：#5265 新 head `5cee83425` 的 CI 红，表象 "Windows test skip inventory is stale"。排障路径：本机同树（含 CI 同款 node 24 干净 worktree）--check 全过 → 矛盾指向 CI 树不同 → **PR 的 CI 跑的是 merge preview 树**（PR+main 合并结果）→ main 新落的 d74f25311（#5747 audit）给清单条目区加了行但 **Summary 计数忘改**（条目 118 行/Summary 仍 39、117）→ 上游 main 自身 CI 同因红（8b104db12 失败步骤同名，本机 8b104db12 worktree 复现 118 vs 117）→ 上游已自行以 **#5779**（49dacdf13）修复。处置：#5265（`0313ab531`）与 #5744（`0339c3ae4`）各 merge latest main（自带 #5779 修复）后推送；#5709（`f3a3533c8`）/#5274（`cdc5cbb59`）CI 已绿**不再碰**（重推反而触发重跑暴露历史树的 stale）。**教训**：①PR 的 CI 红先查 job 的 head_sha 与失败步骤名，别默认红=自己改动；②"本机复现不了"本身是数据——它把嫌疑收敛到 CI 树与本机树的差异（merge preview）；③上游 main 自己红着时，PR 红大概率是传染，merge latest main 即愈。
- **09-28 #5744 二次红定性**：merge main 后的 test 红在 runtime `code-mode.test.js` 单条时序断言（execution budget / Promise.race，false!==true），与 allowScripts/tui-copy/inventory 三处改动零交集；本机同树三连跑 33/33 全绿 → **flaky**（CI 负载偶发）。rerun-failed-jobs 需 admin（Contributor 无权限）→ 按先例空提交 retrigger（`a5b07c507`）。**教训**：上游仓库 rerun 需要 admin，Contributor 的合法重触发方式只有树相同的空提交；时序敏感测试（名字带 race/budget/timeout 语义）单条失败 + 本机三连绿即可定性 flaky，不必深挖。
- **09-28 #5274 四 P2 大轮（Astro-Han 独立线 + hqhq1025 更正）**：①分支 re-key 用 draft 的 originalQuotes → 用户编辑中删掉的 quotes 在分支复活（send 失败 retry 同理）——修为 gate 时捕获盘子内容（**关键坑：`openSessionInChat` 之后同一 stagedContext 句柄已绑分支键，重读读到空桶**，必须在仍绑源键时快照）；②chat-turn 编辑门把 attachments 连同 quotes 一起放开 → 附件消息从"按钮禁用+解释"变"可点后 toast 拒"——恢复 disabled 语义 + 恢复被删的 `editMessageDisabledAttachments` 三语文案（git 历史里现成）+ 侧聊 quote-companion-panel 补门（只复制文本的编辑对带上下文消息拒绝）；③gate 的计数冲突（新增 quote 被拒）对齐 main（活桶直发无限制）——只保留附件/pendingContext 冲突；④拒绝 toast 用了 "ready" 标题——改 unavailable。**P2-3（Regenerate footer 复活）证伪**：#5468 从未动过 conversation-copy.ts，5d37e5aa5 对它只删了两个 disabled keys——评论附 git 证据驳回。P3 的架构签核留给架构 owner（边界迁移是棘轮解锁时商定的路线）。fake plates 升级为按 ownerKey 分桶（旧 fake 忽略 clear 目标——review 的 test gap）；附件编辑按钮测试从"可编辑"反转为"禁用"。ui 690/690、desktop 7/7、biome/locale/棘轮全绿。head `18cb3b4a1`。**教训**：review 的 P2-3 这类"引用具体 commit 的主张"也要 git show 核对——这条从修到驳回省了一轮盲改；stagedContext 句柄在生命周期中途换绑，"何时捕获"与"读什么"是两个独立决定。
- **09-28 #5265 二轮 P2 修复（idle /session + 重入）**：review 5334255733/5335… 指出两条残留路径——goToSession 的 runControl 分支不看 `retracting`；Alt+Up 无重入拒绝（第一个完成会提前清标志）。修为 idle 分支拒绝 + 入口 admission check，两个新测试先红后绿（红证：idle /session 切走、retractCalls 2）。head `78903d54d`（含 merge de4fc5ff9）。**教训**：一次 review 修复会引出下一次 review 的残留路径——fence 类修复要按"枚举全部切换入口"收敛而不是逐个堵；本单至此堵了 toggle/mid-turn/idle-session 三个入口。
- **09-28 #5744 双 flake 收官**：test 红两次同因 code-mode.test.js 时序断言（本机同树三连绿 33/33），package 红两次同因 electron-builder icons@1.2.3 icon-tool 0xC0000005（输出已生成，崩溃后打印 Done）；第三次 retrigger **6/6 全绿**（`58d09e0a8`）。rerun-failed-jobs 需 admin——Contributor 只能空提交 retrigger。CI 跑 PR 用 merge preview 树：上游 main 的坏清单（d74f25311 漏改 Summary）会传染所有未含 #5779 修复的 PR——#5744/#5265 各 merge main 即愈。
- **09-28 #5274 三轮 P2（证伪翻车）+ P3 清尾**：Astro-Han re-review 的 P2"Regenerate footer 复活"**是真的**——复活位置在 **desktop contract**（apps/desktop/.../contracts/conversation-copy.ts:75-81,358,601,835），我上轮证伪时只 grep 了 ui 包的同名文件 + 用 #5468 的 --stat tail（截断看不到 desktop contract）→ "review 幻觉"结论下早了。hqhq1025 的 correction 也承认自己查错文件——两个 agent 与我三方都栽在同一处，reviewer 用逐字对比（main 无 footer 块 vs PR 树有）才钉死。修复：footer 回到 main 精确形态（labels 去掉 regenerate、删 4 字段，zh-TW typo 随删消失），P3 全清（gate 顺序 pendingContext 提前、"Nothing changed" 误报、MixedContext 文案三语去"恢复引用"措辞、反向注释×2、app-shell restoreAttachments 死字段/死解构、side-chat 编辑 no-op 改 toast 说明）。P3-2（cancel 丢编辑中新增 quote）与 P3-5（app-shell send path 测试）**给方案未改码**：前者是语义选择（保留新增需 key 差集再 re-stage，或"取消=放弃全部"也成立），后者是 app-shell 4k 行组件无缝——请 reviewer 定。棘轮：清理后 app-shell 12111 < 基线 12115，账本按新实数更新（棘轮是精确匹配不是上限）。ui 690/690（52 项 revision/context 全绿）、desktop build 干净。head `4050f60fb`。**教训（对"证伪"的证伪）**：宣称"review 与 git 事实不符"前，必须列出该 commit 完整触面（--stat 全量不截断）+ 同名文件全仓 grep——同名文件是最大的坑；证伪结论一旦写进 PR 评论，翻车成本是"更正+道歉+信任折损"，对比多花两分钟 grep 的成本不成比例。
- **09-29 开场盘点（八单时代）**：Open 池从 4 涨到 8——另一会话并行开出 perf 系列四单（#5791 startup profile、#5800 hydration benchmark、#5804 usage tab-entry spec、#5805 retire transcript benchmark），且**并行会话同时推进了 #5265（f0b31c98e serialize switches / a16a934d7 activity lease / b48832dbf 堵住 re-key 窗口的 Alt+Up——即 19:14 inline P2 的修复）与 #5709（46e457cdb merge main，epoch 按口诀保留 main 的 198、callKinds 顺延 199）**——hqhq1025 与 Astro-Han 的新 review 均确认无遗留 P0-P3。本轮本会话的实际动作：①八单对 main（2f3220552）merge-tree 全 CLEAN；②#5805 的双红（tarball+audit）定性为 **undici@7.29.0 新公告 GHSA-3wwx-pv8p-q78v**（CLI release 树现场 npm install 漂移解析到带漏洞的新发布版本；仓库 lockfile 仍是 6.28.0 不受影响），undici 7.29.1 修复版已发布 → 空提交 retrigger（`fb00994f5`）赌解析自愈，评论已附定性；③多会话并行下的纪律修正：**任何 head/结论在下结论前必须重新拉 API**——本轮 #5274/#5265/#5709 的 head 全部被并行会话推进过，若按会话内缓存判断会重复劳动甚至互相覆盖。
- **09-29 #5805 undici 公告修复（两段式，含一次自我更正）**：audit + Build immutable tarball 双红，初判"npm 会解析到 7.29.1 修复版"→ retrigger 后仍红——**真因是根 lockfile 钉死**（undici@7.29.0×3 嵌套 + 6.28.0 root；release 树按 lock 安装不重新解析），评论已更正。修法：package.json overrides **按依赖者钉修复版**（npm 不支持范围键映射，也不作用于 peerDependencies——两个语法坑各踩一次）；@slack/socket-mode 的 undici 是 peer ^7，由宿主 packages/runtime 满足——runtime 钉 **7.30.0 精确版**（8.x 是 7 月起的已验证主线不能降，7.30.0 的 WebSocket/fetch/buildConnector 由 gateway 17/17 + plugin-client-bridge 6/6 验证）。`npm update undici --legacy-peer-deps` + overrides 组合是让 lockfile 落地的工作组合（裸 update 会 ERESOLVE，裸 install 不重解析 override 嵌套）。全部 6 个 undici 实例 ≥ 修复线，npm ls invalid=0。head `879222a02`，CI 由子代理盯。**git 身份固化**：gh-fork 下提交身份统一 `ggbdpq <ggbdpq@gmail.com>`——全局 .gitconfig `includeIf "gitdir:E:/ggbdpq/gh-fork/"` → `.gitconfig-ggbdpq`，外加 maka/CLIProxyAPI 仓库本地双保险；已写进 AGENTS.md 执行区与 commands.md。历史"关天豪"提交不改写（email 正确，贡献图已计入 ggbdpq）。
- **09-29 #5805 undici 修复三段式（两次自我更正）**：①初判"retrigger 自愈"错——真因是根 lockfile **钉死** undici@7.29.0×3 + 6.28.0（release 树按 lock 安装不重新解析）；②修 undici 又引入新红——`npm update undici --legacy-peer-deps` 重解析时**静默剪掉 6 个无关解析条目**（gpt-tokenizer/stylex 链/invariant，astryx 包的声明边还在）→ npm ci 拒装、全 npm lane 红；③终修：完整 `npm install` 找回 6 条目（版本与 CI 期望逐字一致）+ 本地 `npm ci` 自证（1047 包装通）后才推。最终形态：overrides 按依赖者钉（@ai-sdk/provider-utils、@electron/get、@slack/socket-mode → 7.30.0；@jackwener/opencli、node-gyp → 6.29.0；unifont → 8.11.2——**npm overrides 不支持范围键映射、也不作用于 peerDependencies，两个语法坑**）+ runtime 精确钉 7.30.0（@slack peer ^7 与 runtime 8.x 的矛盾由宿主钉 7.x 解，runtime 的 gateway/ws 测试验证 7.30.0 API 完好）。head `a53fceebc`。**教训**：动 lockfile 的提交，推送前必须本地 `npm ci` 自证（`npm install` 成功≠树自洽——legacy update 的静默剪枝 npm install 不报）；undici 的 @slack 嵌套是 peer，overrides 不作用，只能宿主侧满足。
- **09-29 #5805 第三段（squirrel peer）**：undici 修完仍红——`npm ls --workspace @maka/desktop --all` 报 ELSPROBLEMS：**app-builder-lib 在 devDependencies + peerDependencies 声明 electron-builder-squirrel-windows@26.16.1（精确版本）**，同一批重解析把它剪了；peer 不吃 overrides、精确版本无法"范围内最新"自动满足 → 任何 npm 路径都修不掉，audit/test/package lane 全因脚本内部 `npm ls` 崩而红（audit job 的 npm audit 也做树校验）。**终解**：desktop devDependencies 显式声明 squirrel@26.16.1（peer 得到持久满足；+1 行字母序插入）+ npm ci 自证 1070 包 + workspace 校验绿。head `bb02913ce`。**教训链**：lockfile 类红的排查半径是"全部 ELSPROBLEMS 条目"而非第一条——npm ls 的报错是逐条列的，修一条看下一条不如一次性 `npm ls` 全量收集；peer 依赖的缺失 overrides 无解，只能显式声明满足。
- **09-29 #5805 第四段（打地鼠第三层）**：squirrel 修复清掉 ELSPROBLEMS 后，audit/tarball/test 又红出**两个新审计面**——①ip-address@10.4.0 双 moderate 公告（SSRF 类，GHSA-rpw4-54j3-4h4q/GHSA-2vr4-cq9g-pvrc；依赖者 express-rate-limit ^10.2.0 与 socks ^10.1.1 都兼容 10.7.2 修复版）→ override 全局钉 10.7.2；②`@stylexjs/stylex@0.19.1` 无 LICENSE 文件 → third-party-notices 生成器的 **MIT copyright override key 是精确版本号**（`@stylexjs/stylex@0.19.0`），树升级后 key 要跟着升（本次是同源升级 0.19.0→0.19.1，copyright 行不变）。head `da6af78b5`。**模式总结**：依赖审计门的红是"洋葱"——lockfile 重解析每修一层就暴露下一层公告/校验面；每层修法都是"override 钉修复版 + 对应生成器/守卫的精确版本号同步"，推一层验一层（`npm ls` invalid 清零 + audit 脚本本地复验），不要憋大招一次全改。
- **09-29 #5805 第五段（notices 产物）+ 第六段（三处清理）**：④ip-address 公告修完暴露 **notices 产物未同步**（desktop 的 THIRD_PARTY_NOTICES.txt 与 CLI 的 production notices 都是生成产物，依赖树动了必须 `npm run generate:third-party-notices` + `generate:cli-third-party-notices` 重新生成提交——生成器内部跑 `npm ls`，本地 node_modules 半删会绊倒它，先 npm install 修复本地）；⑤notices 同步后 tarball 又红——**release-cli-package.mjs 硬编码 undici@8.10.2 两处**（拷贝 eval 闭包 + 写 CLI manifest，`findDependency` 严格版本比对），树已 8.11.2 → re-key；⑥lockfile 重解析在本地镜像（npmmirror）下进行，留下 36 个镜像 resolved URL（main 全部 npmjs.org）——sed 改回（integrity 不变安全）；⑦squirrel 的 devDependency 声明被 **knip 门禁**拦（源码不 import）→ knip.json 的 ignoreDependencies 加豁免（fontsource 先例）。head `b8fbaf00c`。**教训**：动 lockfile 的完整连锁=「override/update → notices 重生成 ×2 → release 闭包硬编码版本同步 → knip/registry 卫生」，六处缺一不可；推 lockfile 提交前把这条链当 checklist 过一遍。
- **09-29 #5805 第七段（undici 升级的真实回归）**：格式修完后 test 仍红，且**不是 flake**——undici 升级砸中两个真实消费者：①eval 的 maka-initialization 代理测试在 7.30.0 ProxyAgent 下收到意外 CONNECT provider.invalid:80；②runtime 的 scoped-fetch-transport 在 7.30.0 下挂死（755 秒）。**修法（行为保持回walk）**：@ai-sdk/provider-utils 降 7.29.1（最小安全修复版，patch 级行为不变）、runtime 回 8.10.2（8.10.2 本身就过 GHSA 修复线，且是 7 月起已验证主线——7.30.0 是我跨大版本降级引入的回归）。两个失败套件本地先红后绿（42/42、1/1）。head `a7969eff4`。**教训（对第七段自身的批判）**：①依赖修复的版本选择要"最小行为变化"——@ai-sdk 该一步到位 7.29.1 而非 7.30.0（多跨一个 minor 就多一分行为风险）；②runtime 降 7.30.0 是为 @slack peer，但 runtime 直接代码用 8.x API 已两月验证，降级才是更大风险——**两难时保"消费者已验证"的一侧**；③本地验证矩阵必须覆盖 CI 的 affected 套件（本轮 eval/runtime 两套件首红时我本地没跑过它们——受影响面枚举漏了）。
- **09-29 git 身份固化**：gh-fork 下提交身份统一 `ggbdpq <ggbdpq@gmail.com>`（全局 .gitconfig includeIf "gitdir:E:/ggbdpq/gh-fork/" → .gitconfig-ggbdpq，外加 maka/CLIProxyAPI 仓库本地双保险），AGENTS.md 执行区与 maka commands.md 已写入。历史"关天豪"提交不改写（email 正确，贡献图已计入）。
- **09-29 #5805 第八段（@slack override 自相矛盾）**：runtime 回 8.10.2 后 5 处 npm ls 仍红——invalid 判定者是**我自己加的 @slack/socket-mode 嵌套 override**（要求 7.30.0，runtime 树 dedupe 到 8.10.2 → npm 逐处标 invalid）。终解：**删 override，保 lockfile 手写的嵌套条目**（@slack/socket-mode/node_modules/undici@7.30.0——修复版满足 ^7 peer，且 npm ci 按 lockfile 忠实安装）。`npm ls --workspace maka-agent --omit=dev --all` 绿、invalid=0、runtime scoped-fetch 42/42（8.10.2 树）。head `a6df5ef02`。**教训（overrides 的完整语义）**：①overrides 不作用于 peerDependencies；②overrides 与手写 lockfile 嵌套条目**互斥**——override 要求的版本与 dedupe 实装不一致时 npm 逐处标 invalid，二者只能取一（lockfile 条目是既成事实，override 是未来引导；树已手写则删 override）；③ELSPROBLEMS 的判定者要靠 `npm ls undici` 的树形输出找（invalid 行标注 "from <override 来源>"）。
- **09-29 #5805 第九段（连锁 checklist 的最后一环复跑）**：@slack override 剔除清掉 ELSPROBLEMS 后，test/tarball/package ×2 又红——notices 过期（缺 undici@7.29.1/8.10.2：版本回walk改变了闭包，上一轮的 notices 重生成时 lockfile 还是旧状态）。重生成两份产物提交（`edd1df172`，+120 行）。**模式确认**：notices 是 lockfile 连锁清单的**每次版本集合变化都要重跑**的一环，不是"做一次就完"——回walk 也是变化。第九段无新知识，纯执行 checklist。
- **09-29 #5805 终局（九轮打地鼠收官）**：`edd1df172` **18/18 全绿**（test attempt 2 过了，attempt 1 撞的 ACP 30s 超时与 #5777 同族）。hqhq1025 两条终评确认：第七段的 undici 版本回walk正确（runtime 8.10.2 下 forward-proxy 测试 74ms 完成而非挂死）、notices 两份 `--check` 全过、benchmark 删除保留（它调用的 SessionStore API 已不存在）、"no new actionable issue"。PR 页面挂 18/18。**八单全部进入纯等审稳态**，ping 消息已交付用户发群。#5805 九轮档案：retrigger 无效→lockfile 钉死→update 剪枝→squirrel peer→ip-address 公告→stylex notices key→notices 产物→release 闭包硬编码+npmmirror+knip→undici 行为回归（CONNECT/scoped-fetch）→@slack override 自相矛盾→notices 复跑。**总教训**：依赖审计门的红是洋葱，每层修法都进台账；"最小行为变化"原则与"受影响面枚举"是少跑三轮的关键（两者当时都漏了）。

### 10-13 ｜ 盯审开场：#5265 epoch 守卫红（声明式修复）+ 三 PR 盘点
- 开场盘点（API 实测）：#6039（head `f4a28d0eb`，CI 绿，Astro-Han 10-10 三条意见全部回清，当日 04:06 已发 gentle ping cc liugddx）、#6036（head `fb90098aa`，CI 12+1 绿，P2/P3 全清，10-12 已 ping）——两单均"修完等审"零动作项；#5265 的 CI 红定性：**87fb4fcfb 全部测试套件 Linux 侧 `# fail 0`，唯一红是最后一步 protocol epoch guard**（04:24 的 9+9 quotes 修复把 `TURN_MESSAGE_QUOTE_MAX_COUNT` re-export 进 `protocol/index.ts`，epoch 未动，撞 #3313"动了 protocol 目录必须动 epoch"守卫）
- 修法（按守卫自己给出的出路）：re-export = 常量搬家 = README 明列的合法兼容变更 → 加 `protocol-compatible-changes/turn-message-quote-cap-reexport.json`（epoch 钉 220、files=[index.ts]、reason 写明 wire 不可观察）而非 bump 顺延；**先 merge 最新 main（epoch 217→220）是声明的先决条件不是可选项**——CI 跑 merge preview，声明的 epoch 必须等于 preview 实际携带的 headEpoch（220），钉 217 会被 parseDeclaration 直接拒
- 本地现场清理：`rebase-5265` 分支留着上一会话"合并进行中"的现场（暂存 = pre-split fencing 测试 + PR diff），逐文件对照远端 head 与纯 main 确认零独有内容（两个 fencing 测试已随 #6070 进 main 的 8312/8358 行）→ reset --hard 弃置，切回 `fix/tui-rewind-quote-staging` 对齐远端
- 验证：epoch guard `--base upstream/main` exit 0（"declared compatible extension at epoch 220"）；merge 后依赖链重建（node_modules/@maka symlink 全指向搬家前旧家 `/e/ggbdpq/gh-fork`，`npm install --ignore-scripts` 重建 + core→storage→mcp→runtime→acp→runtime-host→eval→maka-agent 依序 tsc 零错）后 pi-transcript 120/120、tui-copy-catalog 绿、check:tui-copy 18 文件 ok、locale/asf/biome 全绿；runner/driver 全量红全为环境类——driver ~55 条全是 `Session cwd no longer exists: /tmp`（Windows 预存 POSIX fixture 病），runner = SIGTERM 对（在案）+ drains 家族/Todo-/new/-resume-bounds 轮换（单测隔离 3/3 绿 = 负载敏感，87fb4fcfb 的 CI 日志 Linux 侧同套件全过为佐证）
- 提交后果：`87fb4fcfb..b7c01c7a4`（merge `c5c5b799f` + 声明 `b7c01c7a4`）已推，CI run 38351796958 **全绿**；[回帖已发](https://github.com/apache/maka/pull/5265#issuecomment-6139106127)向 review 说明红因与声明修法。#5265/#6039/#6036 三单均 CI 绿、零未清意见、mergeable，进入纯等审稳态
- 环境坑新增：**仓库搬家后 push 401**——GCM 里 github.com 凭据损坏（8 字节假令牌）+ 残留 macOS 路径的 gh credential helper（`/opt/homebrew/bin/gh` 不存在）串联投毒；修法 = 仓库级 `credential.https://github.com.helper` 置空链后指到本机 gh（`!"/c/Program Files/GitHub CLI/gh.exe" auth git-credential`），gh keyring 令牌（repo+workflow scope）恢复服务；另一坑：`npm --workspace @maka/cli` 报 No workspaces——**cli 包的真名是 `maka-agent`**
- 经验三条：①epoch 守卫红先问"改动是不是常量搬家/纯 re-export"——是就走声明，bump 是最后手段；②`npm xxx | tail` 吞退出码，`|| exit` 判的全是 tail 的——构建失败要 `exit=$?` 或落文件后查（本轮 cli 构建失败被 BUILD_ALL_DONE 掩盖过一次）；③CI 轮询用 workflow run 的 `conclusion`（按 branch 查 runs 列表）判终态，check-runs 的 in_progress 有滞后

> 本文件由 `E:/cc/guahub/fork/docs/maka/pr/journal/claims.md`（222bdc82 归档、b32e6de4 随 archive 删除）于 2026-10-14 恢复至 hub 化目标路径 `maka-hub/docs/pr/journal/`，历史条目全量保留。（校注 2026-11-07：`222bdc82`、`b32e6de4` 实测不可解析，见 handbook/11 §3）

### 10-14 ｜ sibling 缺陷猎捕首单：#6096 WorkHub tool-id 复用跨回合串扰（双侦察 + 当轮交付）
- 双侦察（2 只读子代理）：①池子扫描——238 个 open issues 里四道闸全过的几乎枯竭，唯一全净的 #5500 是 flake tracking 价值低、#5572 领域最好但评论区有"preparing the minimal fix"软占坑信号（动手前需再核）；②sibling 猎捕——照 #6036 评审坐实的三类缺陷模式（writeSync 短写/只读意图可写打开/会话级 Map 用可复用 id）在 upstream/main 找同病：writeSync 无真实兄弟、SQLite 读打开大多干净，但 **WorkHub 两个渲染模型命中会话级 Map 模式**
- 缺陷（代理发现 + 本线亲核，id 可复用有仓库内自证：pi-transcript 注释"a later call with that ID starts a new interval"、plugin-executor 对复用活跃 id 合成错误事件）：`workHubTurnContexts` 的 calls Map 全会话一 id 一存，跨回合复用让早回合 tasks 回执配不上对（turnId 守卫 continue）静默丢 durable handoff、同回合复用配错 args；`workHubLinkedWork` 的 results Map last-write-wins 让 stop/resume 读到晚回合 result 把 Work 链接指错目标 Session，associationCalls 同病抹掉早回合 topic 链接。desktop 导出丢 steering 那条候选已被 #6036 覆盖不另开单
- 修法（照 #6036 已获背书的 turn 限域模式）：三个查找全改 `Map<turnId, Map<id, message>>`，result 只配自己回合的 call，回合内保持 latest-preceding-call 语义；消费方零改动
- TDD：三条回归先红（steal-pairing / stop-resume 错绑 / association 抹除）后绿；中途一次**假绿教训——build exit=2 被 `;` 串联吞掉，跑的是旧 dist**：构建失败后跑测试等于跑旧产物，构建与测试必须 `&&` 串联
- 验证：typecheck 4 配置过、架构账本独立跑过（改动文件不在账本）、biome/asf 净；desktop 全套 442 文件本机跑不完——107 过 + 3 条 `app-shell-project-actions` 红在**纯 upstream/main 基线原样复现**（Windows 预存）、`app-shell-turn-actions` 只在全套争用下挂死但单跑即绿且与 workhub 零引用；`check:architecture` 的 renderer entry contract 在纯 main 上同样红（Windows 环境病，CI Linux 绿）
- 环境坑新增：①全套卡死清理时 `taskkill //F //IM node.exe` 会无差别杀光所有 node（按 PID 杀）；②arch 脚本在 `apps/desktop/scripts/` 不是根 `scripts/`；③dist 根会冒 0 字节 `.gitkeep` 残留
- 提交后果：PR [#6096](https://github.com/apache/maka/pull/6096) 开（head `69fa7aa5d`，+69/−14 三文件，无前置 issue——缺陷为猎捕发现，正文自带完整机制论证）；CI 一绿一红，红因**上游传染**——#5789（Astryx composer menu）合入后 `docs/astryx-surface-file-inventory.md` 没重生成，`upstream/main` 自身 b9cac4e3d 同步骤同因红（先例 #5779 同族，上游当日自修），[定性评论已发](https://github.com/apache/maka/pull/6096#issuecomment-6160670847)，待 main 修复后空提交 retrigger；侦察报告留档（下轮接单直接用候选名单：#5500 全净 / #5572 需核软占坑 / #4495 需先对齐设计）
- 文档迁移注记：本文件及全套 maka 文档于 2026-10-14 从 `fork/docs/maka/`（222bdc82 归档、b32e6de4 删档）按 git 历史恢复至 hub 化目标路径 `maka-hub/docs/`，结构原样（校注 2026-11-07：`222bdc82`、`b32e6de4` 实测不可解析，见 handbook/11 §3）
- 10-14 maka-hub 根目录收纳：删 make-pr1/2/3（.gitkeep 空壳、拼写错误目录）、maka-pr4/5（干净 clone，零独有提交零脏文件）、maka-baseline-5709（空目录）、maka-verify-b8b（注册 worktree，检出内容均为已推送提交；2 个未推送提交在主仓共享引用 fix/run-unrelated-success-boundary，删 worktree 不触及）、根下 40+ 个验证 .log（全部结论已记入本台账）；保留 docs/、maka/、maka-pr1/2/3
