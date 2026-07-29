# CU 复刻路线图

制定日期：2026-07-26
本文档为本地工作产物，不进 git 提交

依据三份调研：
- Maka 复刻进度精确盘点（workflow waav7gtdj，6 agent / 78 万 token，逐条核实 origin/main 代码）
- trycua 上游对齐研究（workflow wbtrj0npa，5 agent / 46 万 token）
- Codex CU plugin 契约分析（`docs/plans/2026-07-26-codex-cu-plugin-contract.md`）

配套文档：`docs/plans/2026-07-26-cu-semantic-landing-plan.md`（PR 落地计划）

---

## 一、当前位置

一句话：形状已经追平 Codex，能力还差一大截。

Maka 在 main 上已经是和 Codex 同构的语义 agent（单窗口截图 + AX 元素表 + element_id 寻址，模型可见 24 个动作），但对着一个原生 macOS App，模型今天真正能改变屏幕的动作只有两个：`click_element` 和 `set_value`。其余要么被一个从未接线的开关 fail-closed 关死，要么是 schema 摆设，要么没实现。

且打包版整条 CU 是关的（`bundled-tools.json` → `distributionReady: false`，`computer-use-host.ts:82` 在 isPackaged 时禁用），所以对装正式包的用户当前可用能力为零。这是内部测试阶段的有意状态，不是缺陷。

```
观测面   ██████░░░░ 60%   结构对齐，经济性和坐标契约缺席
动作面   ███░░░░░░░ 30%   声明 24 个，原生 App 上真能用 2 个
执行机制 ██████░░░░ 60%   红线比 Codex 更狠，能力面比 Codex 更窄
安全共处 ████░░░░░░ 40%   派发侧硬，共处侧空（叫停/锁屏都够不到）
工程面   ███████░░░ 70%   可靠性工程领先，分发和信封成熟度落后
```

## 二、已经优于 Codex 的地方（要守住，不要在重构中丢掉）

| 项 | Maka | Codex |
|---|---|---|
| 帧/元素新鲜度 | `frame_id` + `frame_epoch` 一次性消费，协议级强制 | SKILL.md 里叮嘱模型每轮重取 element_index，prompt 级纪律 |
| 动作后观测 | 语义动作返回时自动附带 fresh observation | 要求模型自己再调一次 `get_app_state` |
| 观测与历史分离 | `modelText`（完整）/ `text`（只留 element_count）双通道 | 无，靠 diff 控体积 |
| 审批 | 5 类 approval class 运行时能力门禁 | 四级确认策略只写在 SKILL.md，运行时零拦截 |
| 光标红线 | 三层封死 cursor warp + 空桌面点击拒绝 | 有虚拟光标但未见等价强制 |
| 供应链 | 二进制 sha256 四重 pin | 无对应机制 |
| 测试基建 | 七层（单测→协议测→fixture→真模型 e2e） | 不可见 |
| Electron CDP 语义指针 | 独有 | 无 |

## 三、真正的差距（按对 agent 实际能力的影响排序）

### G1 — 22 个动作是空壳（最高优先级）

```
allowCompatibilityInputDispatch  ← 4 个 fail-closed 门共用这一个开关
    └─ select-backend.ts 构造 backend 时从不传（非测试代码零传入）
       → 桌面运行时恒为 undefined
       → 坐标五种点击 / scroll / drag / press_key 在原生 App 上 100% 拒绝
```

代码路径全都写好躺在那里，缺的是一条「可验证前提下有条件放开」的策略。

其余空壳：
- `select_text` / `secondary_action`：backend 进 runSemantic 就硬拒「not exposed by the pinned cua-driver registry」，两个在飞 PR 都没解
- `hold_key` / `left_mouse_down` / `left_mouse_up`：backend switch 里零 case，落 default 拒
- `key`（cmd+A/C/S）：无条件拒
- 元素级 scroll：完全没有；坐标 scroll 被开关关死 → 长列表滚动这个最基础的操作做不了
- 打开未运行的 App：整条能力不存在（Codex 的 `get_app_state` 会透明后台启动）

### G2 — 观测的经济性与坐标契约

1. AX 树跨步 diff 完全不存在（全仓 grep 零命中），每个成功动作全量重发最多 500 个元素。而工具描述里却写着「AX diffs are navigation hints...」—— prompt 与实现直接矛盾，这条本身就是 bug。
2. 截图无像素降采样，只有 >1.5MB 才 PNG→JPEG(82)，同分辨率无 resize。Retina 单窗口几百万像素的 token 成本原封不动付。
3. display 描述符缺位导致坐标空间断裂：模型看到的 `element.frame` 是屏幕逻辑坐标，要提交的 coordinate 是窗口截图像素坐标，而 `observationText` 里既没有 window bounds 也没有截图尺寸 —— 模型没有任何换算依据，也没被告知这件事。

### G3 — 人机共处侧是空的

- 用户无法立刻叫停：Esc 绑在 composer 输入框上，零全局热键，`overlay.abort` 是死代码
- 锁屏保护：状态机齐备，零探测器 → 锁屏状态下照发动作
- 敏感字段识别：只有 `EDITABLE_ROLES` 白名单的副作用，无密码框/secure field 判定
- URL / bundle 黑名单：错误码定义好了，零生产者
- 组织策略：`policy_forbidden` 全仓零引用

Codex 在这一层有独立的 `CUALockScreenGuardian` 进程和四级确认策略。这是唯一需要新设计的一块。

### G4 — main 上的具体 bug

- zoom 拿到 cua-driver 放大裁图后，只用它算 byteLength 做 8MB 检查，随后整个丢弃改回传整窗截图，evidence 里还写着 `path='screenshot-detail'`（`cua-driver-backend.ts:2556-2578`）。模型请求放大拿回原图。两个在飞 PR 都没修。
- `wait` 静默截断且不响应 abort（`:2630`），模型请求 wait(30s) 实际睡 10s 并汇报 ok。
- `middle_click` / `triple_click` advertised but unreachable。
- `cu-real-ax-model-e2e-launcher.mjs:12-14` 把含个人用户名的绝对路径硬编码进上游仓库，且该路径已失效。

### G5 — 分发与工程

- 打包版 CU 关闭（`distributionReady: false`）
- 无 macOS CI lane，真机层零保护
- 绝对 deadline 未下发（只有本地 20s + SIGKILL）
- session/turn 元数据不过线（Codex 的信封带 `codexTurnMetadata` 侧信道）
- 跨平台：一道 darwin 硬门禁，零实现

---

## 四、路线图

### 第一优先级：解锁已有能力（不需要新设计，收益最大）

| 编号 | 动作 | 说明 |
|---|---|---|
| R1 | 给 `allowCompatibilityInputDispatch` 设计并接线一条有条件放开策略 | 一次性解锁 6+ 个动作。前提是想清楚「什么前提下坐标派发是可验证的」——这正是 Maka 已有的帧绑定能擅长的事 |
| R2 | 元素级 scroll | 长列表滚动是 CU 最基础操作，现在完全做不了 |
| R3 | 修 zoom 丢弃裁图的 bug | 单点修复，模型请求放大就该拿到放大 |
| R4 | 修 wait 静默截断 + 不响应 abort | 保留 10s 上限，改 abort-aware |
| R5 | middle/triple click 打通 | 抢救源 `codex/cu-full-matrix @ 9298bddc`（已备份到 fork） |

### 第二优先级：观测经济性

| 编号 | 动作 | 说明 |
|---|---|---|
| R6 | AX 树跨步 diff | Codex 的默认行为。同时修掉工具描述里那句与实现矛盾的宣称 |
| R7 | 截图像素降采样 | 配合 R8，scale 用实际 PNG 尺寸 ÷ window bounds 反推，不信 backingScaleFactor |
| R8 | observationText 补 display 描述符 | 补 window bounds + 截图尺寸，修复坐标空间断裂 |

### 第二优先级补充：把给模型的 a11y 做得比 Codex 更好

这一组的判断依据：Codex 的 AX 表示有明确短板，Maka 有机会一次做对而不是照抄。

| 编号 | 动作 | 为什么能超越 Codex |
|---|---|---|
| R17 | 元素带上可用 AX action 列表 | Codex SKILL 对 `perform_secondary_action` 的要求是「action 必须是该元素在 accessibility text 里实际暴露的，不要猜」——说明它的 AX 文本带 action 列表。而 Maka 的 `observationText` 只吐 element_id/role/label/value/frame，不含 actions，模型只能猜 action 名。这也正是 Maka 的 `secondary_action` 至今是空壳的根因之一 |
| R18 | 保留层级结构 | Maka 的 `elements` 是扁平数组，父子关系丢失，模型不知道某个按钮属于哪个面板/分组。Codex 给缩进树天然保留层级。界面一复杂（模态框叠加、二级窗口、lab 的 Hierarchy Container）扁平表就不够用 |
| R19 | 补状态位 | 现在只有 role/label/value，缺 enabled/disabled、focused、selected、expanded。模型分不清「按钮不可点」和「按钮可点但我没点对」，长流程里会反复重试失效元素。Codex 的状态位也不全，这里可以直接做得更好 |
| R20 | 紧凑行格式替代 JSON 数组 | JSON 每个元素重复一遍 key 名，500 元素时纯冗余。参考形态：`#12 button "Primary Button" [enabled,focused] @100,200 80x30 {press,showMenu}` —— 比现在更省 token 且信息量更大（多了状态与可用动作） |
| R21 | 语义 diff 而非结构 diff | Codex 的 diff 是 `~/+/-` 三态结构变更。更好的是语义化描述：`Primary Button: disabled → enabled`。长流程中这比重发全表有用得多，也比纯结构 diff 更容易让模型判断「我上一步是否生效」 |

R17 和 R19 是可直接超越 Codex 的点；R8（坐标空间断裂）是 bug 不是优化，优先级高于本组其余各项。

### 第三优先级：人机共处（唯一需要新设计的一块）

| 编号 | 动作 | 说明 |
|---|---|---|
| R9 | 全局叫停 | 全局热键 + 打通 `overlay.abort` 死代码 |
| R10 | 锁屏探测器 | 状态机已齐备，只缺探测器接线。注意 lab monitor 的 `screenIsLocked()` 存在边缘漏判（loginwindow 在前台时仍返回 false），不要照抄 |
| R11 | 语义确认分级 | 在已有 5 类 approval class（技术维度）之上叠加社会后果维度：改密码/绕过证书警告/金融交易 → 交还人操作；CAPTCHA/不可逆删除/接受法律协议 → 动作前确认。措辞和判定逻辑自己写，不照搬 Codex 原文 |
| R12 | 敏感字段识别 + URL/bundle 黑名单接线 | 错误码已定义，缺生产者 |

### 第四优先级：上游与分发

| 编号 | 动作 | 说明 |
|---|---|---|
| R13 | 切回上游官方 cua-driver release，升到 0.12.x/0.13.x | fork 净 delta 已归零，继续维护纯亏。同时解除构建链路对 #2210 的依赖。要还的债见下 |
| R14 | 拆分重提 #2210 | 见第五节 |
| R15 | macOS CI lane | 上游也没有，Maka 自建是相对优势 |
| R16 | 修真机 e2e 的前台假设（断言方向反了） | 见下 |

R16 详述。`cu-real-ax-model-e2e-launcher.mjs` 用 `CUA_LAB_BACKGROUND=1`（`open -n -g`）把 fixture 启动到后台，转头 `validateMonitorBaseline` 又要求 `NSWorkspace.frontmostApplication` 必须是 `com.openai.codex.cualab`。这两条在任何有其他 app 占据前台的桌面上都不可能同时成立（2026-07-26 实测：前台是 iTerm2 时直接 `fixture bundle identity mismatch`）。

问题不只是脆弱，是断言方向反了：

```
被测能力     后台执行、不抢焦点、对前台是谁不敏感
现有校验     前台必须是 fixture 自己
             → 用「前台是特定 app」的前提去测「不依赖前台」的能力，自相矛盾
             → 且真实运行时前台可能是任何 app，测试环境与真实环境不是一回事
             → 最该断言的那条（焦点没被抢）反而无法验证，因为一开始就要求它在前台
```

正确的设计：

```
前提   前台是一个无关的第三方 app，fixture 在后台（可被遮挡）
执行   对 fixture 的后台窗口做 AX 语义动作
断言   ① 动作成功且 evidence.path == 'ax'
       ② 动作后 frontmostApplication 仍是那个第三方 app（焦点未被抢走）
       ③ 鼠标指针位置未变（cursor 未被 warp）
```

这样测试环境反而更接近真实场景，且把「后台执行」这个核心承诺变成可断言的。

同批还有两个真机 e2e 的环境假设问题：
- `launcher.mjs:12-14` 把含个人用户名的绝对路径硬编码为默认值，且该路径已失效（应改为必须由 `MAKA_CU_AX_MODEL_LAB_ROOT` 提供，缺失时给明确报错）
- harness 要求 `MAKA_CU_AX_MODEL_TEMP_DIR` 必须位于 `os.tmpdir()` 之下（macOS 上是 `/var/folders/.../T` 而非 `/tmp`），这个约束合理但未文档化，手工调用时会撞上 `requires launcher-owned inputs` 这条信息量不足的报错

### R16b — harness 的 observe 校验与工具契约自相矛盾（已实测确认，优先级高）

`scripts/cu-real-ax-model-e2e.mjs:402-409`：

```js
if (action === 'observe' && (args.app !== fixture.appId || args.window_id !== fixtureWindowId)) {
  rejectAttempt('target_mismatch', 'model observe target does not match the exact fixture identity');
}
```

要求模型同时给对 `app` 和 `window_id`。而 Maka 自己的工具描述写的是：

> Required fields by action: observe/screenshot require app **or** window_id

模型按契约只传 `app`（实测 `{"action":"observe","app":"Codex CUA Lab"}`，app 精确匹配），因为没传 window_id 就被判 `target_mismatch`。于是 `ax-click` / `ax-multi-step` 这类需要 dispatch 断言的场景，在模型完全合规的前提下必然失败——与模型能力、与 CU 链路都无关。

2026-07-26 实测证据链：

```
1. 手工直接调 backend（绕过模型）
   observe → 67 个元素，目标 {id:"4", role:"AXButton", label:"CUA Lab Primary Button"} 在列
   click_element → {"ok":true,"tier":"ax","evidence":{"path":"ax"}}
   buttonClickCount 0 → 1，前台仍是 Chrome（焦点未被抢）
   → 链路完全正常

2. 走模型（sonnet-5 / opus-5 各一次）
   两次都是 0 dispatch，失败方式完全一致
   注入 args 记录后看到：模型传 {"action":"observe","app":"Codex CUA Lab"}
   → 模型合规，被 harness 拒

3. 把校验改成契约语义（app 匹配且 window_id 未传或匹配，或 window_id 匹配）
   claude-sonnet-5 完整跑通：list_apps → observe → click_element
   dispatch traces: 1，path=ax，buttonClickCount 0 → 1，EXIT=0
   → 唯一变量就是这条校验
```

修法二选一：把校验改成契约语义（推荐），或者在给模型的任务指令里明确要求带上 window_id。不要保留现状——它会让任何合规模型都跑不过这条 e2e。



R13 的债（必须一次性还）：`--no-daemon-relaunch` 上游已不存在；embedded 改为两段式 `cua-driver serve --embedded --socket <path>` + `cua-driver mcp --embedded --socket <path>`，不给 socket 会 fail-closed；0.9.0 的 #2338 要求 daemon-backed calls。

---

## 五、trycua 上游策略

### 三分清单

A 类 — 该提上游（对所有 cua 用户有普适价值）

| 项 | 理由 |
|---|---|
| A1 开 issue 报告 macOS 后台 scroll/drag/press_key 的 CGEvent 兼容后端污染物理鼠标按键状态 | Maka 因此禁用了三个动作，缺陷目前只写在私有注释里。且 hqhq1025 在 trycua 开过的 issue 数是 0，先建立「会报问题」的信誉比再推大 PR 有用 |
| A2 snapshot generation 16→32 位 | 上游 rustdoc 自己承认 4 hex 前缀只有 16 位、LRU 上限 8。单次碰撞 1.2e-4，跑 1 万次 get_window_state 的会话期望撞 1.2 次 |
| A3 `token_for` 从 expect panic 改成 Option | 维护者 P1 #1 的根因，现在只在调用点绕过了 |
| A4 macOS 元素动作绑定到已验证 AX 节点 | 维护者自己点名的 TOCTOU 修复，justification 他已替你写好 |
| A5 `set_value` 写后回读 + changed/verified 结构化输出 | 上游 0.7.0 的 release 主题就是 honest verification，单文件纯可观测性 |
| A6 element token 类型化拒绝码 | 今天所有 MCP client 得字符串匹配 STALE_TOKEN_ERROR。但改公开契约，必须走 RFC（上游 07-22 才引入 RFC 流程） |

B 类 — 留在 Maka 侧（不要尝试上游）

键盘 target-bound 所有权模型 / CuaBoundAction 帧绑定 / target_occluded 复检与空桌面拒绝 / COMPUTER_USE_ERROR_CODES 分类 / TS cursor overlay / zero pixel dispatch 硬要求。

这些都是 Maka 的产品安全模型与 agent 循环语义，不是自动化原语。其中 zero pixel dispatch 在 Maka 适配器里客户端强制即可 —— driver 的 structuredContent 本来就返回 `path` 字段，Maka 拒绝 `path != "ax"` 就够了，不需要改 driver。

C 类 — 换设计再提

| 项 | 换成什么 |
|---|---|
| C1 `allow_pixel_fallback(via_token) = !via_token` | 改成显式参数 `dispatch="ax_only"`，默认行为不变，且必须单独提（否则同时改两条契约，任一有异议整个 PR 卡住） |
| C2 token 换 UUID | 改成 per-process nonce 保留可读可 grep 格式，如 `s{nonce4hex}-{gen8hex}:{idx}`。上游 rustdoc 把「8-16 char budget」「debug-grep-able」写成明确设计目标，且 issue #2207 有用户直接手打 token |
| C3 `node_identity = element_ptr as u64` | 要么删掉并改标题为 fail closed on superseded snapshots；要么基于 CFEqual/AXIdentifier 重做成能跨 re-snapshot 存活的真 stable identity。仓库里本来就有正确原语（`tree.rs:14` 已 import CFEqual） |
| C5 物理输入围栏 | 上游全库无 HIDIdleTime，是真空白且有普适价值；但必须做成 driver 侧 opt-in 的 idle-gate（默认关闭） |

### #2210 的推进顺序

```
P0  rebase 到当前 main（不需要说任何话）
    一步解三件事：CONFLICTING→MERGEABLE、拿到第一个绿 check、base 推进 99 commits
    冲突源已定位：
      element_token.rs / tool_schema.rs   吸收 #2327 rustfmt baseline（机械冲突）
      ax/cache.rs + ax/tree.rs            真语义冲突，来自 #2459（与 cache identity 改动重叠）
      click.rs / type_text.rs             吸收 #2341 breaking + #2461/#2468 SDK 化
      set_value.rs                        吸收 #2441 telemetry
    force-push 用 --force-with-lease

P1  补生成产物
    ci-cua-driver-contract-clients.yml 的 paths 包含本 PR 改的两个目录
    而 PR 改了 tool_schema.rs 却没带 libs/cua-driver/contract/ 下的生成产物
    不补这块，即便拿到 approve，CI 大概率也是红的

P2  补 macOS harness 证据（唯一能替代缺失 CI 的东西）
    跑 libs/cua-driver/tests/runners/macos-lume/run-all.sh
    把 harness_appkit_test.rs 的 typed case rows 贴进 PR，而不是只贴 cargo test 计数
    依据 TESTING.md:63-65「Unit and protocol tests do not prove that desktop input
    reached a real application」—— 这正是维护者最在意的第三件事
    Maka 已有 AppKit fixture 工程能力（commit 46ff3a8d），边际成本低

P3  拆 PR（最大单一杠杆）
    按 A 类拆成 3-4 个各自 <400 行。原 #2210 转 draft 保留为 tracking
    拆分后 PR-A 是跨平台的，能被 ci-rust-linux/windows 真正验证拿到绿灯
    ——这是 macOS 部分永远拿不到的
    标题 release 语义：碰 libs/cua-driver/ 下非 docs/python/tests 必须是
    feat/fix/perf/revert，否则打 no-release 标签（ci-release-metadata.yml 强制）

P4  重写 PR 正文
    叙事从「Maka #984 的阻塞依赖」改成「关闭上游自己记录的 element-level TOCTOU 缺口」
    首段引用 element_token.rs 模块文档原话 + issue #2200 + #2262
    Maka 实测数据降级为 supporting evidence 放末尾
    抄 #2459 的结构（348 行/41 分钟/零评论直接合）：
      Summary（讲清 stale element index 机理）/ Repro（一条可复现命令）/
      Change / Before-After（structuredContent JSON 片段）/ Test
    纠正 body 里「No Windows, Linux, CLI files are changed」这句不实陈述

P5  ping（等前面都做完再发）
    纠正：整条 PR 只有 07-14 一次 @，07-20 那两条关键更新都没带 @
    在维护者手压 327 个 open PR 的地方，不带 @ 的更新极易被漏掉
    复制 #2166 的成功序列（15.2 小时合入）：
      技术请求和 CI 门禁请求拆成两条独立评论，各自单一诉求
      另发 @codex review 触发机器人评审（GitHub App，不受 Actions 批准门禁）
```

### 维护者画像（决定沟通方式）

f-trycua（Francesco Bonacci）一人主力，200 个 merged PR 中占 160，CODEOWNERS 里 `/libs/cua-driver/` 唯他一人。r33drichards 排第二但只碰 Fleet/sandbox/docs，不碰 platform-macos —— macOS AX 是单点 review 瓶颈，「换个人 review」不存在。

他在意三件事（从 review 措辞和 issue 模板直接可读）：
1. 跨平台一致性 > 单平台完美
2. fail-closed，但绝不能 panic、绝不能悄悄降级
3. 行为必须被 harness 观察到（CONTRIBUTING 原文：A successful tool response alone is not evidence that an action reached the application）

合并经济学：中位 churn 111 行，中位 lead time 0.5 小时。#2166（+580/-30，6 文件）15.2 小时合入；#2210（+1267/-766，19 文件）12 天。

唯一社区渠道是 Discord（约 1428 成员），CONTRIBUTING 指定为设计讨论渠道。

---

## 六、验证与测试

### 真机测试的前提（2026-07-26 实测踩坑）

`scripts/cu-real-ax-model-e2e-launcher.mjs` 可用，但有两个硬前提：

1. lab 路径。脚本默认值 `/Users/haoqing/Documents/Learning/codex-computer-use-lab` 已失效，实际在 `/Users/haoqing/Documents/Learning/computer-use-research/codex-computer-use-lab`。用 `MAKA_CU_AX_MODEL_LAB_ROOT` 覆盖。
2. 活跃桌面会话。monitor 取 `NSWorkspace.shared.frontmostApplication`，launcher 要求它必须是 `com.openai.codex.cualab` 且 PID 不等于 fixture 的 OOP host PID —— 即「CUA Lab UI 进程在前台，操作它的后台 OOP 进程」。屏幕锁定或前台是别的 app 都会报 `fixture bundle identity mismatch`。

模型凭据（本机 coproxy，已实测可用）：
```
MAKA_CU_MODEL_PROVIDER=anthropic
MAKA_CU_MODEL_BASE_URL=http://127.0.0.1:8537     # e2e 的 anthropic 默认端口，通
MAKA_CU_MODEL_API_KEY=coproxy
MAKA_CU_MODEL_ID=claude-sonnet-5                  # 或 claude-opus-5
```
8538（openai 默认端口）不通。

driver 指纹已核对一致：`683dad5cccb47dd0a8bb5d534d62fbb9e6edfb1cded232509cf4c2b190066040`。

场景：`observe-only` / `ax-click` / `ax-multi-step` / `ambiguity` / `restart-recovery` / `intervention-recovery`

### TCC 风险

launcher 用 `spawn(process.execPath, ...)` 起裸 node，cua-driver 作为 embedded 子进程继承 TCC 归属。给这个 node 授权会永久毒化它对 `~/Documents` 的访问（撤销无效、重启 UI 无效、只能重启进程）。建议在独立终端跑，不要在长期会话里跑。

### lab 的 fixture 已漂移

`~/Documents/Learning/computer-use-research/codex-computer-use-lab` 跑 `npm test`：180 tests / 152 pass / 28 fail。失败项全部是 live probe 与 fixture 比对类。

原因：lab README 记录 "Status as of July 14, 2026"，而本机 Codex CU plugin 是 1.0.1000502、native 二进制签名 2026-07-16。Codex 升级导致 fixture 集体过期。

含义：之前逆向结论里凡是钉在二进制 SHA、调用序列、wire 格式上的部分，都需要重新采集才能确认对当前版本仍成立。lab 有 `collect:*` 系列脚本可重采。

---

## 七、贯穿约束

- docs/plans 类文档不进 git 提交（见 memory `maka-docs-not-committed`）
- 代码 push 到 `fork`（hqhq1025），PR base 上游 main
- 真机 CU 测试走 desktop `.app` 身份，CLI/headless 都是裸 node 会中毒
- 小步提 PR，不攒大分支（上一轮 95% 白做的直接教训）
- 涉及「Maka 有没有 X」的判断，一律先 `git show origin/main:<path>` 核实，不要拿调研摘要当结论
