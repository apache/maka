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

# Maka Computer Use Foundation Contract

状态：Accepted
适用范围：Desktop foundation；CLI 仅实验性 opt-in；Eval subject 通过 Runtime Host 继承同一边界
目的：定义 stacked PR 不可破坏的合同与验证门。

外部证据参考（不属于本仓库）：

- `codex-computer-use-lab/docs/08-wrapper-policy-and-toctou.md`：canonical app approval、pre-await snapshot、approval 与 action freshness 分离；
- `codex-computer-use-lab/docs/13-policy-error-state-machine.md`：policy → approval → fresh observation → action，以及 intervention/lock/blocked URL 状态；
- `codex-computer-use-lab/docs/16-service-process-lifecycle-and-retention.md`：exact executable ownership、client/idle lifecycle、connection-loss cleanup；
- `codex-computer-use-lab/docs/19-electron-presentation-and-mcp-event-contract.md`：presentation 与 native action transport 分离。
- `codex-computer-use-lab/docs/22-native-ax-diff-refetch-and-instance-isolation.md`：stable AX revision ids、ordered difference、no-change 与 full fallback。

上述文件位于独立逆向实验仓库。本文只记录由 Maka 测试锁定的合同，
不把外部路径声明为本仓库内链接。

## Contract

1. Observation authority
   - 每个可执行 observation 具有唯一 `frameId + epoch`、截图尺寸、`pid + windowId`、capture-local 坐标信息，以及适用时的 Electron page identity。
   - 同一窗口跨 revision 的模型 element id 可以稳定，但它只是 presentation identity；每次 dispatch 仍必须解析到 fresh snapshot 的 opaque token。
   - WebContent/renderer 元素同时绑定 host process generation 与 actual input-owner generation；唯一真实 WebContent 元素会遮蔽同框叶子 mirror，歧义 mirror 不删除。
   - 坐标只能在产生它的截图/窗口 frame 内解释。dispatch 禁止重新选择当前全局坐标下的最高 z-order 窗口。
   - 新 observation、turn/session 结束、abort、user stop、service loss 和明确 intervention 使旧 action claim 与 keyboard ownership 失效。

2. Action binding
   - mutation 在第一次异步边界前完成参数快照、规范化、fingerprint、claim，并绑定 active observation。
   - 有顺序依赖的动作按 Computer Use session 串行；不同 session 不全局串行。
   - stale、replay、unclaimed、malformed、targetless action 均 fail closed，不得回退到裸 pixel、foreground activation 或当前系统焦点。

3. Exact target validation
   - coordinate action 在 dispatch 前验证同一 window identity、geometry、screenshot scale、page identity 和 occlusion。
   - semantic action 优先按稳定 token refetch；否则仅允许唯一且 identity-preserving 的匹配。缺失、歧义、越界、遮挡或 page 变化必须失败。
   - 无关 AX/DOM 内容变化不能合成 `user_intervened`。物理介入和 terminal host state 必须来自明确事件。
   - drag/zoom 两端必须属于同一个 bound window。
   - WebContent click 只有在 host/window 与 renderer generation 都验证后才能走 `skylight_pid`；失败不得退回 AX mirror 或 JavaScript click。

4. Execution ownership
   - maka-cu 是唯一 native executor；window/page discovery、semantic preparation、input dispatch 和 effect readback 均留在该边界内。
   - agent 不得移动真实鼠标、抢前台焦点、临时 activate 窗口或执行 windowless desktop input。
   - keyboard ownership 绑定 `session + turn + generation + pid + windowId + page/frame`，并在失败、stale、新 observation、intervention、service generation 变化、turn/session 结束时撤销。
   - child process 在未知 action outcome 下退出时必须 re-observe，禁止自动重放。

5. Postcondition
   - mutation 成功后旧 observation 被消费并返回 fresh authoritative observation；完整当前元素树保留在 observation 内，可获得视觉状态时向模型返回新截图。
   - immediate post-action model text 可以使用 executor 声明的 no-change/difference/full presentation；显式 observe 仍显示完整树，差分不得成为重建当前状态的唯一来源。
   - transport success 不等于 business success。`verified:true` 必须由 action-specific effect/readback 支撑。
   - `supported:true, ok:false` 为本次 terminal failure；仅 side-effect-free 的 `supported:false` 可进行一次显式允许的 fallback。
   - retry 基于 fresh observation 和新 claim，禁止重试旧 coordinate/fingerprint。

6. Service lifecycle
   - executable、version、hash、role 和 generation 必须 runtime-observable；dead/mismatched child 不得复用。
   - startup、request、shutdown、restart 均有界；成功恢复后重置连续失败预算。
   - process exit 清理 pending request、observation、keyboard ownership、presentation 和受影响 session lease。
   - capability 反映实时 `healthy / degraded / unavailable`，不能只检查 binary path。

7. Approval and privacy
   - approval 是 app capability gate，不是 active observation 或 action freshness 证明。
   - Maka 采用分级短 lease：metadata read、screenshot read、pointer mutation、keyboard mutation、semantic mutation 分离；目标、action class、observation 或 session generation 变化时重新授权。
   - approval 至少标明 action class 与目标 app/window；敏感应用、secure/password field 和不支持的目的地 fail closed。
   - screenshot、typed text、coordinate、raw AX label/value、window title、secret 和 raw page content 默认不进入持久 session log、telemetry 或 evaluation report。
   - 上传截图前验证 model vision capability，并满足对应用户/provider consent policy。

8. Presentation isolation
   - cursor/PiP 位于 targeting 下游，不能选择、转换、授权或改变执行坐标。
   - `readyForInteraction` 只能通过有界 fail-open 策略影响 dispatch 时机；`finished` 不阻塞 native dispatch 或 postcondition。
   - completion 使用 executor-resolved point；失败、abort、teardown、supersede 或缺少 completion point 时必须 cancel。
   - acknowledgement 按 session + action identity 绑定，stale ack 必须忽略。

## Renderer semantic source contract

Maka 自己的 Electron renderer 也是 Computer Use 的目标。它不能依赖截图或运行时注入
来弥补页面语义；角色、名称、状态和 landmark 必须由页面本身提供。

- 一个可见窗口只暴露一个 `main` landmark。`AppShell` 已拥有主 landmark，聊天页、
  Skills、MCP、定时任务和每日回顾必须作为有名称的 `region` 出现在其内部，不能再嵌套
  第二个 `main`。
- 每个可操作 AX node 必须有非空 accessible name。选中导航使用 `aria-current`，标签页
  使用 `aria-selected`，展开态、禁用态、忙碌态和表单状态由原生元素或对应 ARIA 状态
  暴露。
- 同一层级的 region 不使用相同名称表示不同语义。例如新任务页面 region 与内部空态
  hero 分别命名为“新任务对话”和“开始对话”。
- Astryx 自带文案进入中文 accessibility tree 前必须经过
  `packages/ui/src/astryx-i18n.tsx`。新增 Astryx surface 时，不能让英文 fallback
  静默进入中文 Computer Use observation。
- 不添加生产环境 DOM walker、MutationObserver、定时轮询或额外 a11y 依赖来修补以上
  问题。语义随现有 JSX 渲染，运行时开销只限原生 DOM/ARIA 属性。

验证分四层：

1. TypeScript 与 Storybook 构建保证语义属性、文案契约和非默认状态 fixture 能随产品 API
   一起演进。不要重新引入基于正则的 JSX 源码扫描器；它无法可靠理解组件语义，主干已用
   真实 AX 验证取代这类检查。
2. `scripts/ax-tree-audit.mjs` 是 Storybook 与 Electron E2E 共用的测试侧 AX 规则源，
   拒绝无名或同一语义作用域内歧义的可操作 node、多 `main`、无名 dialog，以及缺少
   checked/selected/expanded/value 的状态控件。
3. `apps/desktop/e2e/accessibility-coverage.spec.ts` 读取真实 Electron Chromium AX tree，
   从运行时设置导航枚举所有设置页，并覆盖模块页、全局弹窗、会话页和 7 个工作栏面板。
4. `scripts/storybook-visual-smoke.mjs` 对 Storybook 全目录读取 AX tree，执行 `play`
   函数到最终态，并验证 modal 焦点、隐藏/惰性 surface 和关键 Computer Use story
   inventory；名字含 `narrow` 的故事必须在窄视口运行。独立 WebContentsView 由
   `apps/desktop/scripts/browser-observe-act-smoke.mjs` 走真实 observe → semantic ref →
   act → effect 闭环，不能伪装成 renderer tree 的一部分。

完整页面、状态、动作与性能边界清单见 `docs/computer-use-ui-coverage.md`。

## Validation Matrix

`PASS`：当前证据直接覆盖；`PARTIAL`：组件证据存在但 production 闭环不足；`FAIL`：当前实现违反合同；`UNKNOWN`：缺少足够证据。

本矩阵记录 #857 拆分链建立时的基线状态，用于界定各 stacked PR 的验证责任。拆分链合入后，各领域当前状态以源码与合同测试为准。

| Contract area | 状态 | 当前证据 | 拆分链需要的证据 |
|---|---|---|---|
| Frame/window binding、duplicate rejection | PASS | frame state、bound-action、stale/duplicate tests | 在 Runtime slice 保留 focused tests |
| Capture-local coordinate authority | PASS | window-local transform、scale/geometry、Retina/negative-origin tests | decoy window 下的 cumulative Desktop E2E |
| WebContent / renderer target | PASS | actual PID + start time、coalition readiness、mirror 去重；精确 pin 的 5 轮 OOP 全部 `skylight_pid`、`isTrusted=true`、单 down-up，30 个 sentinel span 零前台样本 | 扩到真实 Electron/Chromium app matrix |
| Semantic identity refetch | PASS | renderer frame-only reflow 仅允许同进程世代 unique replacement；missing/ambiguous fail closed；native frame change 继续拒绝；真机全部零误点 | 保留跨 toolkit 录制回归 |
| Stable AX revision / post-action diff | PASS | DFS stable ID、跨 fresh token 继承、ordered changes、removed ranges、no-change/full fallback；host 显式 observe 保持 full | 增加真实长树 token-saving trajectory 样本 |
| Modal / multi-window routing | PARTIAL | app→sheet、exact secondary、button/scroll/close 功能矩阵 5/5；精确 pin 的高频 sentinel 捕获 1,738 个 target-frontmost 样本，后台安全未通过 | 修复原生 AX press 的瞬时前台抢占，再重跑同一聚合矩阵 |
| Occlusion、no foreground/pixel fallback | PASS | coordinate/semantic occlusion 与 fail-closed tests | real-window safety sentinel |
| Fresh postcondition、effect verification | PARTIAL | mutation 后 fresh observation；5 轮 primary oracle=1、slider 业务值/readback=42、scroll tree delta + oracle=76 | 继续补 secondary action 与跨窗口业务 oracle |
| Per-session queue、generation lease | PARTIAL | session queue/frame claim；lease 修复尚在本地 | concurrent-session 与 intervention-before-dispatch tests |
| Physical intervention、lock、stop | FAIL | 有状态机原型，无 Desktop production event producer | 真实 host wiring 与 transition tests |
| Service recovery、unknown outcome | PARTIAL | 本地 service abstraction 与 unit tests | restart reset、attestation、child-crash、cleanup E2E |
| Approval semantics | FAIL | 旧实现是整 turn scope | 分级 lease、脱敏 permission event、sensitive-target tests |
| Privacy、telemetry | FAIL | 旧 observation/tool args 可含敏感内容 | persistence/redaction tests；allowlist report schema |
| Presentation lifecycle | PARTIAL | 本地 candidate 存在；远端 #777 与 #699 相同 | 重建 presentation-only PR 与 cumulative E2E |
| Provider/model compatibility | PARTIAL | Desktop 默认走统一 function harness | vision gate；每个准入 model 的 real-runtime evidence |
| Binary provenance | PASS | source/archive/binary/license pinning | 独立 supply-chain verifier |
| Signed packaged app | UNKNOWN | 无 `.app` signing/notarization/Gatekeeper 证据 | nested helper、TCC chain、cold-start package smoke |

## Split Gate

每个 stacked PR 必须写清：负责的 contract 条款、non-goals、exported interface、focused verifier 和 cumulative verifier。重建从最终已验证 tree 按目标文件/hunk 提取，不机械重放旧 73-commit 历史。

## 两个执行器留下的教训

Maka 在两个 native executor 上做过真机实测：cua-driver（trycua，Rust，MCP）和一个
自有的 Swift executor（协议 `maka.cu/2`）。下面每一条都由真机实测得出，写在这里是
因为它们是设计层面的，换执行器不会自动消失。

### 协议要封闭，而不是宽容

cua-driver 的 MCP 面是开放字符串：dispatch tier 要从 path 字符串猜，猜错的每一次
都落到 `coordinate-background`；错误消息可能带应用文本，于是宿主必须整体脱敏，
结果是**模型永远只看到错误码**，看不到那句可操作的话。`maka.cu/2` 把这些收成闭
集（§1.1 的双错误层、§1.2 的固定句子、§6.3 的 tier/path 配对），宿主才敢把执行器
的句子直接给模型看。

教训：能让模型自救的信息，往往正是"看起来可能不安全所以被丢掉"的那部分。解法是
让它在协议层就不可能不安全，而不是在宿主层一刀切。

### 两端各写一份的东西，一定会分叉

坐标动作 100% 不可用，藏了整个开发期。根因：快照侧 `hostWalkTree` 与校验侧
`HostAXBindingProbe` 各自实现了同一份"摘要输入"字段表，根节点的 `ancestors` 一个
读活链、一个硬编码空数组。65 个元素差 1 个，窗口摘要就不符，而窗口摘要是坐标动作
**唯一**的锚。元素动作因为只校验自身，24/24 一直是绿的，完全遮住了它。

修法不是让两份拷贝再对齐一次（那已经试过一次并且正是这次分叉的来源），而是收敛成
一条代码路径、规则放在里面。

教训：凡是"记录时算一遍、校验时再算一遍"的结构，必须共用一个函数。绿灯不覆盖的
那条路，就是它会坏掉的地方。

### 缓存不是查询

`NSWorkspace.shared.runningApplications` 和 `frontmostApplication` 在没有 AppKit
run loop 的进程里**永不刷新**。执行器因此看不见任何在它之后启动的应用，而
`foregroundTaken` 恒为启动时刻的那个值——一个抢了用户前台的启动会如实报告"没抢"。
所有真机测试之所以一直是绿的，只是因为目标应用碰巧早就在跑。

教训：在无 run loop 的进程里，AppKit 的任何"当前状态"访问器都要按缓存对待，改用
`proc_listpids` / 窗口服务这类每次真查的接口。

### WebContent 不是把事件 PID 改掉

WKWebView 的 AX 树和 XPC process 不是同时出现的。只按进程名找 WebContent 会撞到别的
应用，只把 `CGEvent.postToPid` 改投 renderer 又完全没有事件。当前闭环分三层：

- XNU resource + jetsam coalition 只负责证明 host 到 WebContent 的唯一归属，并触发
  一次 250ms bounded re-observe；
- observation 只删除同框、同语义、唯一且为叶子的 host mirror；
- event 仍绑定 host `CGWindowID`，通过单通道 private SkyLight 交给 WindowServer 做
  renderer hop；actual PID/start time 是元素身份和 restart fence。

教训：OOP targeting 是 process identity、window identity 和 event routing 的联合
问题，不是一个 PID 字段。

### 上限要有时钟，截断要说出来

`maxElements` 挡不住慢：由另一个进程托管的 open/save 面板走 1500 个元素花了 35 秒，
撞穿宿主 20 秒死线被杀，而宿主报的是"执行器已退出"——把排查引向了错的一侧。而且
截断只进了 trace，模型读到一棵残树会得出"这个控件不存在"。

教训：任何遍历都要同时有数量上限和时间上限；任何截断都必须出现在**模型读得到的
地方**，并且要说出它的含义（"可能存在但没列出"），而不只是一个 `truncated=true`。

### 不变量要请求，而不是假设

`apps.launch` 的类型注释写着"启动的应用不得抢焦点"，而实现用的是
`NSWorkspace.OpenConfiguration()` 默认值——`activates` 默认为 `true`，从来没有请求
过后台启动。诚实上报那一半是对的（应用自激活时如实报 `foregroundTaken: true`），
缺的是先去请求。

教训：一条不变量如果只写在注释里、没有对应的一行代码去请求它，它就不是不变量。

### 剪枝要有回退路径才付得起

Codex 剪得很狠（13 层深的通用容器全收），因为它有 `click{x,y}` 兜底：藏错了元素，
模型还能按坐标点。Maka 的坐标路径默认关闭，藏掉的元素就是**够不到**的元素。跨 10
个应用 9129 个元素实测，朴素的"无 label 就剪"会藏掉 3428 个，其中 1023 个
（占全树 17%）是可操作的。

教训：能不能剪，取决于剪错了有没有第二条路。没有回退的实现必须比有回退的保守。

### 省 token 的地方常常不在编码上

JSON/YAML 不比"一元素一行 + 缩进"省：实测分别是它的 3.5 倍和 2.1 倍，因为后者把
包含关系编码成缩进、把默认状态编码成"不写"。真正的浪费在别处——`list_apps` 无条件
返回 133 个应用（12,933 字节，约 3,600 token，占一个三步回合的 85%），而其中 118
个根本没有窗口、模型碰都碰不到。

教训：先量一次真实回合的 token 分布再动手。最大的一笔开销往往不在你正在优化的那
个字段上。

### 措辞补不上不存在的能力

一条真实任务上的三轮迭代，每轮都把拒绝语句写得更准，模型的调用次数是 32 → 46 → 57。

任务是「把窗口挪到左边」。移动窗口只能拖标题栏，拖标题栏只能用坐标动作，而坐标动作
要求目标像素属于目标窗口——Computer Use 驱动的是用户没在看的窗口，后台启动的窗口
必然压在 z-order 底部，于是必然被遮挡。**这个任务没有解**：协议里没有窗口管理动词，
而「移动窗口」也不是任何控件的 AX 动作。

把拒绝语句写清楚之后，模型确实读懂了「这条路不通」，于是去试别的路——而别的路也不
通，所以试得更多。同一批改动对「导出 PDF」是有效的：那里存在一个正确答案（「做不
到，因为菜单快捷键到不了后台应用」），模型说出这句话就停了。

分界线：

- 存在正确答案（包括「做不到」本身就是正确答案）→ 措辞能把模型引到那里，值得改。
- 不存在正确答案 → 措辞只会让模型更快地把所有错路试一遍。要补的是能力，不是句子。

判断方法：先问「一个熟练的人拿着同样这套动作面，能不能做成」。答不上来就先别改文案。
