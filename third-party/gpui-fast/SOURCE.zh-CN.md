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

# GPUI Fast 平台清理补丁

从 [GPUI Fast](https://github.com/longbridge/gpui-fast/tree/371769f1ff378bc0bd886440e0f97fc94aaeae5d) `main` 固定 revision（manifest 采用正式 `0.1.7` 发布依赖规则） 保留 core、macOS、Windows、Linux 和 scheduler 五个 crate。按上游发布规则使用 `gpui-fast*` 包名，保持原 Rust library 名；修改过的 scheduler 对应 `gpui-pre-scheduler` 0.3.9。未修改 helper 使用同一正式发布及其 0.3.9 支持快照。Kit 选择官方 `gpui-fast` feature，根 registry source patch 提供修改过的实现；移除旧 gpui-pre Git 兼容 facade。

`upstream.json` 列出改动前的有限原始文件清单与 SHA-256。保留上游许可和署名；Maka 新文件不进入该清单。隔离 workspace 仅规范化 helper 依赖和显式许可文件路径。

补丁增加一次性平台清理回执：只有原生销毁被确认，且后端持有的 renderer、输入与回调资源都已释放，才报告成功。macOS 的末字段 guard 跨越 NSWindow/NSView 的 superclass dealloc；Windows 在 WM_DESTROY 撤销 OLE 拖放所有权，等待 WM_NCDESTROY/DestroyWindow 完成；X11 使用 checked DestroyWindow，并释放窗口映射与回调 owner；Wayland 在 destroy requests 后使用独立 display-sync callback，不依赖已移除的 surface map；测试后端等待真实 state 析构。其它不支持的后端显式失败。未改动帧调度或编辑器刷新。

回执不承诺 GPU driver 已回收物理内存，也不保活窗口。应用 closing owner 等待该回执及真实资源 lease 共同结算。保持补丁范围有限，改变固定版本前重新评估上游。

省略无关的上游 example 程序和资源，仅保留 core 测试使用的 JPEG，并关闭 example target 自动发现。

macOS 还必须从 State 取出 AccessKit adapter，在 foreground teardown task 中、native close 之前释放。adapter 强持 content view，其 GPUI 子 view 又持有 State Arc；等到 State 最终析构才释放 adapter 会形成引用环，无法收到真实完成回执。

App 提供原当前事件传播标记的只读查询。原生分发完成观察者能据此排除已消费的输入及此前已停止的观察，不复制事件状态、不新增键盘注册表。Kit 的既有 Root 默认行为可覆盖有焦点和无焦点的窗口，原生绑定及 raw 插件决定仍先执行。

原生焦点显露派生自原 Window focus generation 与已提交的 prepaint 几何。焦点子树只给原 autoscroll request 标注 generation，精确 child caret 优先于整个控件的 fallback，无关兄弟请求不能覆盖焦点目标。滚动容器计划最小且被原 native limits 钳制的 offset，仅按自身 viewport 裁剪目标向祖先传递；正常后续 frame 一起重建 paint、hitbox 与 accessibility。一次 generation 完成后不抢回用户手动滚动；pointer 移焦保持 down/up 与拖选几何。List 完整 prepaint 可见 pass 后才选 retry 请求；失败事务撤回显露几何事实，保留已经写入的 offset 计划以安排重绘。pending 时绕过 retained/layer replay。

原 TestWindow 记录 platform decoration facts、resize requests 和 client insets；TestAppContext 可改变原平台事实并请求原生重画，再观察实际平台调用。该有限 harness 接缝验证 Base Root 客户端 frame 行为，不增加第二窗口或 frame owner，不宣称 Linux OS 验收。


原生 Hitbox 支持相对原 bounds 的精确片段：同一原生交互 id 和 dispatch scope 覆盖不连续 glyph 区域，retained layer 只平移 bounds/mask，片段保持相对坐标；空片段不命中。tooltip prepaint 读取同一裁剪几何，不冒称 occlusion。弱 ClickHandle 取消原元素 pending press 与 active 样式，不创建第二个手势 owner。真实 mouse/key press 记录按钮/按键、焦点代数、原 Window 输入序号与取消标记；实际 down/up 在 capture/binding 之前推进序号，replay 屏蔽 scope 且不能 arm。可选 current 区分派发外与 replay，RAII 恢复嵌套上下文，但嵌套输入仍打断外层 clean press。原 Window 失活回调在 observer 之前常数时间撤销准入，原 refresh 后正常 layout 清理视觉状态；不增加每控件 activation 订阅。移动在 drag/hover 前清理旧 press，dirty layout 不消费在途 release；嵌套派发保持外层已提交监听器帧，由既有调度重绘处理 dirty。原生 AX 请求进入同一因果输入 scope，打断其他目标的 pending 或 captured press，并初始化新的传播/default flags；默认 Div 直接经原 click listeners 发出 Accessibility 激活，不伪造中心鼠标事件，显式 AX Click 优先。它们只是通用前置，TextView occurrence 身份、原 glyph 精确片段及产品 Markdown 链接仍须接入；headless 测试不代表 OS 可访问性验收。

仅恢复 pinned 上游 core 单元测试所需的 IBM Plex Sans 与 Lilex Regular 两份字体及相邻原始 OFL 1.1 许可；upstream.json 记录有限原始哈希。它们只由 cfg(test) 嵌入，不作为产品字体；演示程序及其他资产继续省略。

自定义 canvas 可以安装原 focused IME handler 而不提供 tracked reveal 几何。提交帧在 handler 确实存在、其 focus 没有 dispatch-tree 几何时完成该 focus generation，允许 retained reuse 恢复；原 focus/generation 与滚动 guard 保留，未挂载且没有 input handler 的 focus 继续 pending。dispatcher 取消测试改为实际 `dispatch_after` runnable 持有 completion sender，并保留等待 sender 取消的 executor。owned async-io timer 仍由既有 Drop 契约管理。


原 ScrollHandle 唯一拥有实时 offset 与最后实际绘制的直接子元素几何。Tracked Div 可选择 Anchor 或 FollowEnd；未绘制的自动调整保留相对于 immutable painted geometry 的阅读原点，每次 retry 重选原 element IDs 中仍存在的元素。真实 wheel、set_offset 和 focus reveal 转为绝对目标；plain clamp 同样参与重试处理。原 Window 的继承式 prepaint visibility 作用域阻止隐藏后代的自动 retention、显式请求解析与焦点显露，不 blur 或替换 owner；隔离外部显露请求并在 unwind 时恢复。DeferredDraw 捕获同一 eligibility，延迟 prepaint 恢复它；retained context 比较它再决定复用，隐藏几何不确认 focus generation。实际 Deferred::paint 通过原 Frame paint stream 准入子树，普通 retained 与 splice 重放同一事实；priority 只排序当前已准入记录，低 priority 的嵌套子树也须先经过祖先实际 paint，hover-hidden 祖先不能独立绘制 ghost 子树。只有实际 Div 内容 paint 才提交 baseline，覆盖 retained children；不增加第二棵树、全局滚动注册或插件像素镜像。

Bottom 与 item 合为一个带 tag 的 pending target，按当前 overflow、bounds 和 child geometry 解析，仅匹配的实际 paint 确认；hidden、discarded 和新 hover-hidden 的跳过绘制不能消费。新请求覆盖旧请求，真实原生移动取消请求。invalidate() 只推进原 dependency version，不冒充输入或安排 frame，Kit VirtualList 继续使用同一机械 owner。原 retained splice 检查纳入 rebuilt gap root 的 location/size；外框变化重建父元素，外框相同的内部内容改变仍可 splice。原生回归使用实际 wheel、focus、layout retry、显式请求与 partial child 更新，不作为 OS 或成品验收。

独立原生测试工作区选择与应用相同的五个适配 crate 和 async-io owner，使用行表调试信息及运行时 Metal shader。上游一处属性测试改为直接调用 proptest，原因是 GPUI 宏转发了不受支持的 proptest_path 参数；配置与 dispatcher 种子、四个 case、随机收缩、原上下文清理和渲染等价断言全部保留。这是测试入口适配，不替换运行时。

Window 的 marked-text 查询直接使用当前 Window/App 转发给原 focused PlatformInputHandler，读取后归还同一 handler，避免键盘派发期间再次异步借用 App/Window；不维护 composition 镜像。

Window 支持每个实际绘制帧一次原生显露聚焦机会。输入框在实际 paint、注册同一原生编辑器处理器之前提供原 FocusHandle；隐藏或丢弃 prepaint 不能取焦点。原 Window 与完成帧焦点保持一致。Retained 处理器记录保留原 FocusId，Frame 记住实际交给平台的精确槽位，覆盖没有 tracked geometry 的 focused canvas。Draw 归还原槽位；marked-text 查询读取并归还同一处理器，无论仍在 stash 或已随 retained paint 移动。不增加第二焦点 authority、输入 owner 或 composition 镜像。

原 Window 提供绑定窗口、可撤销的 InputScope，包裹原生焦点组。不可 clone 的 owner 对应一次 opening；原祖先及 retained 绘制记录只持 weak custody。原 DispatchNode 按需分配不可变 origin，mouse、AX 和平台编辑器槽根据已发布原树的当前 parent ancestry 准入；prepaint 回滚恢复 AX provenance 并移除临时 origin lookup。AnyElement 在子 paint 返回后恢复 enclosing node，避免父监听器借用子元素身份。Frame、retained splice 及 layer carry/shift 保留原 scope 声明，不增加产品 open 状态、焦点树或领域权限。

物理输入使用已发布帧；首次焦点及编辑器槽发布使用即将提交的原帧，因此独立容器里的真实编辑器能收到首次输入。原 TabStopMap 将遍历限制在 live scope。scope 变化中断原 press/drag、pending chord、pointer capture 和 touch momentum；callback 内循环及 chord replay 依原 interruption 停止，并归还原 listener/subscription 集合。TestAppContext 只公开实际平台生命周期记录及原输入槽测试入口。此为原生前置能力，尚不包含产品 Dialog。


Window 可根据原 ClickInputState interruption 创建不可 clone 的 InputGesture，仅拥有不可变机械身份并弱观察原窗口。WeakInputGesture 不延长任一 owner 的生命；结束后，即使新手势使用同一 interruption epoch，旧观察也立即失效。Kit 据此结束原选区拖动和自动滚动；Window 不增加选区、定时器注册表或产品状态。

原继承选择上下文同时携带文档 scope 与 InputScope 的稳定焦点组身份，沿布局、retained/splice/layer 与 deferred 绘制传递及比较。组改变使复用失效，已失效 opening 不会把保留前景误归后台。这只证明原生放置来源；物理输入仍由原弱 opening 与 gesture 准入控制。

图层准入读取原实际绘制的输入 owner，而不把未聚焦 handler 当作活动输入。只有原完成帧对应的范围才可读取；已有原生 input 决策重绘失效的未聚焦记录。回归保留失焦后有界恢复合成、短暂隐藏再出现的 fresh 可见场景 oracle 和真实恢复 handler 查询。手工通知帧与 held callback 测试仅暂停 test 自动绘制，匹配平台 callback 归还原 handler 后再绘制下一帧的顺序。

## 同步上游（2026-10-14）

固定到 `371769f1ff378bc0bd886440e0f97fc94aaeae5d`，使用 0.1.7 平台包与 0.3.9 支持快照；旧 macOS 文本实现副本按上游移除，改由 Apple 包提供。引入上游保留帧可访问性日志、列表/图层优化、CJK 换行及平台修复，新增原始文件均记录 provenance。

可访问性日志接入既有 prepaint 回滚，action listener 的所有权不被复制；保留的 action 继续携带原物理输入来源的弱引用。上游静默 scroll-to-bottom 优化只用于无回执的旧接口，显式滚动命令仍以真实绘制结算。上游未提供等价行为的输入隔离、焦点揭示、滚动观察和资源清理继续保留。

程序设置 List offset 时仍推进原依赖版本，使未显式 notify 的保留祖先也能看到偏移变化；图层单独将该版本识别为滚动，避免把它算作内容变化。未修补上游也可复现旧偏移残留。保留上游 deferred-view 拼接保护：重建 gap 外存在延迟绘制时重建祖先，防止复用过时视图；本地测试相应断言重建，并继续验证绘制因果顺序、缓存重放及与全量绘制的一致性。

## 列表行保留布局期的元素状态（2026-10-16）

在上游合并前，回移上游拉取请求 [#73](https://github.com/longbridge/gpui-fast/pull/73)（提交 `97bff7005ef4e5971237fcf890262947cff21b46`）。某帧沿用列表滚动图层里的行时，该行在渲染和 `request_layout` 中取得的元素状态现在随行保存，并随其 prepaint 记录一起带入新帧；此前它们在第一次沿用该行的帧结束时被丢弃。gpui-kit 的 `TextView` 把超过 4 KB 的已解析文档存为这种状态，状态新建时在后台重新解析，所以在高于视口的 markdown 行内滚动时，该行会有一帧按空文档的高度布局。在另一列表的行布局期间布局的行（内层 `ListSizingBehavior::Infer` 列表的行）属于那一行，不再记成外层列表的行。改动在 `crates/gpui/src/fast/layers/lists.rs`，另有 `crates/gpui/src/fast/layout.rs` 中的一个访问函数，以及 `crates/gpui/src/fast/tests/layers_lists.rs` 中的六个 `layout_states` 测试。固定版本越过上游合并后，删除本节及改动。

## 一次滚轮手势只滚动一个容器（2026-10-20）

Maka 自己的改动。滚动容器嵌在另一个滚动容器里时（例如对话列表里的工具输出框），在它上面的一次滚轮或触控板手势（或一次触摸拖动）会让两者一起滚动，因为指针下每个 `Div` 和 `List` 的滚动监听器都会处理每个滚轮事件。现在 `Window` 持有一个 `ScrollLatch`（`crates/gpui/src/gestures.rs`）：指针下沿手势方向（增量较大的那一轴）真正滚动了的最内层容器取得这次手势，直到手势结束，滚到尽头也不放手。它外层的容器（监听器在它之后运行）把这次手势的事件留给它，滚动中移到指针下的容器也不接手。滚不动的容器让事件继续向外传，所以框已在尽头时，下一次手势交给页面，与浏览器的滚动链一致；vendored GPUI Kit 的 `ScrollableMask` 在边缘把事件交给外层容器的行为也保持不变。手势在以下情况结束：收到 `TouchPhase::Started` 事件、滚轮事件位置改变、或取得手势的容器 300 毫秒内没有处理它的事件。以 `TouchPhase::Started` 开始的手势，要在收到 `TouchPhase::Ended` 之后才会因停顿而结束，因为手指可能停在触控板上。事件仍会继续传播，滚动条等其他滚轮监听器照常收到。用滚轮另一轴滚动单轴容器的情况不参与，行为不变。`Div` 的滚轮监听器现在按本帧布局的范围钳制偏移（prepaint 原本就会这样钳制）。改动在 `gestures.rs`、`window.rs`、`elements/div.rs` 和 `elements/list.rs`，测试为 `elements/div.rs` 中九个、`elements/list.rs` 中两个。GPUI Kit 0.8.0（[#3500](https://github.com/longbridge/gpui-kit/pull/3500)）给自身滚动区域定的规则不同：指针下最内层的区域在捕获阶段取得每个事件（到尽头也是）并停止传播。固定版本升到 0.8.0 或更新时重新评估这项改动。
