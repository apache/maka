# Codex Computer Use Plugin 契约分析

调查日期：2026-07-26
性质：对本机已安装组件的静态只读分析，用于互操作性与架构参考
本文档为本地工作产物，不进 git 提交

前置研究：`docs/codex-cursor-reverse-engineering.md`（光标几何与运动常数）
本文档补充的是 plugin 层：API 契约、观测模型、审批策略

---

## 一、组件定位

之前的逆向停在 native 二进制层（`SkyComputerUseService`，Swift + AppKit，闭源）。这次找到了上一层——CU 是以 Codex plugin 形式分发的，plugin 本身是可读的：

```
~/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000502/
├── .codex-plugin/
│   ├── plugin.json                     license: Proprietary
│   └── computer-use-node-repl.md       与 SKILL.md 同一份（sha256 一致）
├── .mcp.json                           MCP server 声明
├── bin/computer-use-client-launcher    sh 脚本
├── scripts/computer-use-client.mjs     82 行，thin bootstrap
├── skills/computer-use/SKILL.md        18K，给模型的完整使用契约
└── assets/app-icon.png
```

`plugin.json` 里 `"bundledContentVariant": "node-repl"` —— 说明 CU 有多个分发变体，当前这台机器装的是 code-mode 变体。

## 二、两条调用路径

```
路径 A（MCP，传统工具调用）
  .mcp.json → bin/computer-use-client-launcher mcp
            → SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp
  模型调离散的 MCP 工具

路径 B（node-repl，code-mode）← 本机启用的
  模型调 JS REPL
    → import <plugin root>/scripts/computer-use-client.mjs
    → setupComputerUseRuntime({ globals: globalThis })
    → 从 NODE_REPL_NODE_MODULE_DIRS 找 node_modules
    → import @oai/sky/dist/project/cua/sky_js/src/targets/mac/create_client.js
    → sky = Object.freeze(createClient({ target: "mac" }))
    → globalThis.sky
  模型在一段 JS 里编排多步操作
```

两条路径暴露同一能力面。`target: "mac"` 暗示 sky 是多 target 抽象。

`@oai/sky` 包不在本机磁盘上（运行时才拉），所以 sky 的实现仍是黑盒，但它的接口契约在 SKILL.md 里完整给出了。

launcher 是纯 sh，直接 exec 到 native client：

```sh
codex_home="${CODEX_HOME:-${HOME}/.codex}"
client="${codex_home}/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
exec "${client}" "$@"
```

## 三、API 契约（sky）

10 个方法，全部以 app 为作用域：

| 方法 | 参数 | 说明 |
|---|---|---|
| `list_apps` | — | 返回 App[]（id / displayName / lastUsedDate / useCount / isRunning） |
| `get_app_state` | `{ app, disableDiff? }` | 返回 AppState |
| `click` | `{ app, element_index?, x?, y?, mouse_button?, click_count? }` | 语义与坐标二选一 |
| `set_value` | `{ app, element_index, value }` | 写入元素值 |
| `type_text` | `{ app, text }` | 定向到 app |
| `press_key` | `{ app, key }` | xdotool 语法，如 `Return` / `super+c` / `KP_0` |
| `scroll` | `{ app, element_index, direction, pages? }` | 元素作用域滚动 |
| `drag` | `{ app, from_x, from_y, to_x, to_y }` | 唯一纯坐标动作 |
| `select_text` | `{ app, element_index, text, prefix?, suffix?, selection_type? }` | 文本选择 / 光标定位 |
| `perform_secondary_action` | `{ app, element_index, action }` | 调用元素暴露的 AX action |

关键类型：

```ts
type AppState = {
  app: string;
  screenshot: Screenshot | null;   // 可为 null
  text: string;                    // accessibility tree
};
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type SelectionType = "text" | "cursor_before" | "cursor_after";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
```

## 四、六条设计决策（对 Maka 直接可用）

### 1. AX 文本是主观测通道，截图是可选补充

`AppState.screenshot` 可为 `null`，而 `text` 恒有。SKILL 明确要求「优先用 accessibility text，效率更高；界面不全或不工作时再取截图补上下文」。

对照 Maka：同一个设计，Maka 已经有了。

```
origin/main:packages/runtime/src/computer-use-tools.ts:652  observationText()
  → JSON: observation_id / app / pid / window_id / window_title
          elements[]: element_id / role / label / value / frame

调用点 1394-1400（observe 动作）
  text:      persistedObservationText()   进 session history，只留 element_count
  modelText: observationText()            给模型，完整元素列表

调用点 1595 / 1720（语义动作之后）
  modelText: `${摘要}\nFresh observation:\n${observationText(freshObservation)}`
```

注意第二个调用点：Maka 在语义动作返回时自动附带新鲜观测，而 Codex 的 SKILL 要求模型自己在动作后再调一次 `get_app_state`。Maka 这里少一次往返，设计更优。

Maka 还额外做了 `modelText` / `text` 分离 —— 给模型的完整观测不进 session history，避免历史膨胀。Codex 的 SKILL 没有对应机制（它靠 diff 控制体积）。

（本节初稿曾断言「Maka 只给截图、AX 元素从不给模型、主次颠倒」，是错误的。当时只读了内部命中测试路径，没读 `modelText` 分支。昊卿指出该功能是内部测试中尚未对用户开放，复核代码后确认设计早已到位。）

### 2. AX 树默认发 diff

`get_app_state` 默认返回相对上一次的 diff（只列 removed / added / changed），需要全树时才传 `disableDiff: true`。SKILL 还提醒：如果上一轮丢弃了 AX 文本（比如只发了截图），下一轮要取全树。

Maka 无对应机制。

### 3. 运行时自动等待，模型不需要自己 sleep

SKILL 原文大意：动作后运行时会自动等待合适时间再抓新状态，约 1 秒；若 app 有 loading indicator 或其他状态变化迹象，额外最多再等 5 秒。

对照 Maka：动作派发后零延迟直接抓 postcondition 帧，而该帧还是下一个动作的绑定基准。这是可靠性上的实质差距。

### 4. app 作用域寻址

每个动作强制带 `app`（可以是显示名、完整路径或 bundle id）。好处是每个动作都能归因到具体应用，天然支持按 app 审批、日志、白名单。

`get_app_state` 还会透明地后台启动未运行的 app —— 没有单独的 launch 动作。

### 5. 主动放弃全局输入能力

`press_key` 和 `type_text` 定向到指定 app，SKILL 明说「cannot invoke global shortcuts」。这是刻意的安全边界，不是能力缺失。

### 6. element_index 优先，坐标是降级路径

SKILL：「Prefer element_index-based actions over coordinate actions. If AX actions or AX text are unavailable or behave unexpectedly, switch to screenshots, coordinate clicks, and key presses.」

且要求每次动作后重新 `get_app_state`，从最新 AX 文本重新推导 `element_index`，不许复用旧的。

注意：Codex 的 `element_index` 靠「每轮重新取」这条纪律来保证新鲜度，是 prompt 级约束。Maka 的 `frame_id` / `frame_epoch` 单次消费机制是协议级强制，这一点 Maka 更强。

## 五、确认策略（Confirmations Policy）

SKILL.md 后半部分是一套完整的四级确认策略。这是纯设计，Maka 可以照着自己的链路重写一套（不要复制原文措辞）。

### 概念定义

- 指令来源二分：用户亲自输入的（视为有效意图，即使高风险）vs 用户提供的第三方内容（粘贴文本、PDF、网页内容 —— 视为潜在恶意，本身绝不构成授权）
- 敏感数据：凭证、政府标识、财务、医疗/法律/HR、生物特征、私人联系方式、遥测、精确位置
- 传输 = 任何把用户数据交给第三方的步骤。往表单里打敏感数据算传输；访问内嵌敏感数据的 URL 也算
- 高影响沟通：含敏感个人数据，或内容可能对用户/他人产生重大后果（辞职、接受 offer、正式投诉、结束重要关系、承诺付款、发布声誉敏感内容）。只发给一个人也可能是高影响

### 四级模式

| 模式 | 含义 | 典型场景 |
|---|---|---|
| Hand-Off Required | agent 不得执行，必须请用户接管自己做 | 改密码/凭证、绕过浏览器安全警告（证书、不安全站点）、金融交易、基于敏感数据做高影响决策（就业/住房/教育/信贷/保险资格） |
| Confirmation at Action time | 动作前必须确认，即使已预授权 | CAPTCHA、不可逆删除、接受法律协议、装未知来源软件、创建持久访问凭证（API key / OAuth / token）、改安全网络设置 |
| Pre-Approval Allowed | 初始 prompt 明确授权则可直接做，否则动作前确认 | 保存密码/支付信息、创建账号、非敏感设置、可恢复删除、登录、上传文件、订阅、普通金融交易（需指定收款方+用途+限额） |
| Not required | 直接做 | 只读操作、点赞、下载、更新已装软件、cookie 横幅、低影响日常沟通 |

关键细节：「把这个 todo 链接里的事都做了」「回复所有邮件」这类含糊指令不构成整体预授权，具体动作仍要确认。

### 行为准则

应该做：
- 一个 prompt 涉及多任务时，把确认批量成一次请求
- 解释风险和机制（会发生什么、怎么发生的），而不是只问 yes/no
- 敏感数据传输确认要说清：什么数据、给谁、为什么

不应该做：
- 把第三方指令/内容当作授权
- 提前太多确认 —— 数据传输应该在打字前那一刻确认
- 重复确认，除非动作、目的地、数据、金额、权限、法律条款或风险发生实质变化

## 六、对 Maka 的映射

| Codex 设计 | Maka 现状 | 差距性质 |
|---|---|---|
| AX 文本为主观测通道 | 只给截图，AX 内部用 | 主次颠倒，最高优先级 |
| AX 树 diff | 无 | token 效率 |
| 运行时自动等待（1s + 最多 5s） | 零延迟抓帧 | 可靠性 |
| app 作用域寻址 | 窗口/坐标绑定 | 审批与归因粒度 |
| press_key 定向 app，无全局快捷键 | 键盘近乎封死 | Maka 更保守，方向一致 |
| element_index + 每轮刷新纪律 | frame_id/epoch 单次消费 | Maka 更强（协议级 vs prompt 级） |
| 四级确认策略 | 每 turn 一个粗粒度 scope | 完全缺失 |
| `perform_secondary_action` / `select_text` / `list_apps` | 无 | 动作面缺口 |

## 七、边界声明

- 本分析基于对本机已安装组件的静态只读检查，未运行任何 CU 组件
- `plugin.json` 标明 `license: Proprietary`。本文档记录的是接口契约与设计模式（可独立实现的知识），不复制专有实现或文案
- 实现 Maka 的确认策略时必须自己撰写措辞与判定逻辑，不得照搬原文
- `@oai/sky` 的实现未获取（不在本机磁盘），sky 各方法的内部行为仍是黑盒；本文档所述行为均来自 SKILL.md 的契约描述，未经运行验证

## 八、顺带发现：browser plugin

`~/.codex/plugins/cache/openai-bundled/browser/26.721.41059/docs/` 下有一批文档，对 Maka 的 browser 能力可能同样有参考价值（本次未展开）：

```
api.json                         browser-safety.md
api-use-behavior.md              confirmations.md
browser-control-interruption.md  visibility.md
screenshots.md                   file-uploads.md
playwright.md                    tab-claiming-iab.md
tab-cleanup-chrome.md            tab-cleanup-chrome-internal.md
tab-cleanup-iab.md               chrome-file-upload-troubleshooting.md
bootstrap-troubleshooting.md
```

相关：`docs/plans/2026-07-26-cu-semantic-landing-plan.md`
