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

# GPUI Kit local presentation projection

The `gpui-base` crate is copied from [GPUI Kit](https://github.com/longbridge/gpui-kit/tree/c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2), revision `c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2`, under Apache-2.0. The `gpui-shell` crate is copied from the same revision; see the section below. Other Kit crates remain dependencies from that exact revision. `upstream.json` records the finite imported file inventory and original SHA-256 hashes before modifications; licenses are retained byte-for-byte. The root README is retained because upstream library tests include it. Examples, benchmarks and website sources are omitted. Benchmark-only dependencies and GPUI profiler features are omitted; library tests keep their original test support. The crate manifest is normalized to explicit upstream dependencies/lints and disables automatic example targets; this repository includes the adapted Base crate as a workspace member so its actual unit tests can run with the same source patches as the application.

The bounded changes preserve the single native editing engine:

- `InputBaseState` distinguishes inherited editor styles from complete projections. Complete styles preserve explicit transparent colours without evaluating an App Global.
- `Scrollbar` accepts an immutable local `Rc<Theme>` and reads that same snapshot for its cascade, default foreground, mode, geometry, motion and radius. `EditorScrollbar` forwards its state owner's selected snapshot to the actual internal scrollbar. System reduced-motion policy still wins.
- Existing scrollbar interaction state re-arms its idle deadline after timing changes; obsolete timer generations cannot clear a newer deadline or notify its view. Hover, drag and scroll offset remain owned by the original state.

Idle waits are owned tasks; replacement or state release cancels the old wait, and the future retains only Weak state. The shared native scheduler and async-io removal wake are adapted separately so cancellation also drains backend timer custody. Added tests cover local projection, retained draws, built-in editor scrollbars and actual cancellation. Two imported tests explicitly settle the initial geometry frame or await the existing 120 Hz drag notification before checking retained painting. Their original forms fail identically with the pinned Kit source under this repository's Fast backend; the idle cache and painted grab-point assertions remain intact, and painting must not change the already updated drag offset.

Imported dock JSON fixtures are formatted to the repository's existing formatter policy. Their data, string values and numeric tokens are preserved; provenance hashes still identify their original upstream bytes.

The theme snapshot is a derived presentation cache, not an application registry or a writable source of plugin configuration. Application adapters must build it from their selected declarative values without entities, resource leases or custom animation closures, project body text colour/font/size/line-height explicitly, and preserve the existing EditorState identity. This patch alone does not implement Maka's public theme contract, live reconciliation, product UI, accessibility or OS IME acceptance.


InputBaseState can update tab index/stop metadata on its existing FocusId, notifying only when that metadata changes. This does not recreate its focus or editing identity. Maka's plain multiline adapter uses TextareaState; the source-code EditorState remains a separate upstream mode, with no extra code-editor protocol implied by this seam.

Two imported dock renderer-contract tests explicitly request a fresh draw before checking the original hook-order assertions. Their helper already settles and then clears the call record; a normal retained draw can legally skip those hooks. This adjustment does not change production retention or weaken the composition assertions, and no original-HEAD baseline is claimed for that discovery.

VirtualList invalidates its original base scroll handle when queuing its existing deferred scroll request. The offset changes only when prepaint consumes the request. Axis tests keep their original range/offset assertions and additionally verify that admission does not move the offset, and that idle drawing still reuses retained rendering. No second scroll state or invalidation registry is introduced.

Seven imported animation/deferred-layout tests explicitly deliver GPUI's existing next-frame callbacks before drawing, matching the platform's callback-before-draw sequence. Merely advancing the test clock or drawing does not deliver those callbacks. The TextView selection fixture includes the actual TextSelectionLayer, which installs its selection listeners; its double/triple-click and clipping assertions remain intact. These test corrections and the VirtualList fix address failures reproduced at the pre-slice local HEAD, and do not claim OS accessibility, IME or product acceptance.

InputBaseState exposes conservative user undo/redo availability from its original UndoManager, current editability and absence of active composition. Pending effective transactions count for undo and invalidate redo; empty or canceled transactions preserve redo. These are read-only projections of the same history, with no copied counter or separate history owner. Native regression exercises actual focused actions, editability changes and composition finalization while read-only. This seam prepares the local edit menu; it does not itself deliver that menu or OS acceptance.

Native right-click consumption checks the current menu-enabled, disabled and marked-text facts before moving selection. Disabling menus or input discards an existing pending request. Menu presentation callbacks use Window.defer, leaving the original State update borrow before a local presentation owner reads that same State. Positioner exposes available_size using its original decoration-inset calculation, so a caller can constrain a scrollable surface to the same bounds used for origin clamping. No new popup registry, buffer or focus authority is introduced.

Plain-text accessibility reads an immutable snapshot produced by the original TextElement's current prepaint, only while accessibility is active. It derives the document revision, native anchor/focus and soft-wrap affinity, complete visual-line byte ranges, bounded selectable units, Unicode keyboard word starts and actual measured visible-row geometry. LF/CRLF use one native newline selection cell. Masked text, atomic inline tokens and folded modes do not claim this plain-text projection; non-left alignment omits geometry. A read-only handle cannot publish snapshots or mutate the document. The same InputBaseState accepts exact anchor/focus selections, preserves direction and visual-line affinity, updates its original preferred column/reveal request, and implements UTF-16 platform selection/length without accepting surrogate or CRLF midpoints. No second buffer, history, selection, shaper or viewport owner is introduced. These seams enable platform tree/actions; headless tests are not OS screen-reader, IME or complete product acceptance.

InputBaseState can delegate plain Tab and Shift-Tab to a containing window while retaining the original focus, selection and history. The common typed action boundary includes single-line and read-only inputs, and consumes navigation during active composition or while disabled. Code-editor modes keep the original indentation behavior unless their owner explicitly selects navigation. The existing Base Root (already installed by Kit open_window) executes Tab and selection-copy defaults through the existing native post-dispatch keystroke notification, after native bindings and raw plugin decisions. Its owned subscription captures only a weak Root and the original WindowId, checks current root entity identity, unhandled input, original propagation and preventDefault, and works even with no focused descendant. Blur itself never starts navigation. Its original focus-trap navigation remains intact. Maka withdraws the original tab stop when an input retires. This does not add another window Root, clipboard owner, guest focus registry or separate editing state.

InputBaseState 可以让普通 Tab/Shift-Tab 交给所在窗口导航，焦点、选区和历史仍由原生输入持有。共同的类型化 action 边界覆盖单行和只读输入，并在组合输入或禁用时阻止导航；代码编辑器默认保留缩进。Kit open_window 已安装的原 Base Root 通过现有原生按键分发完成通知处理 Tab 与选区复制的默认行为，先经过原生绑定和 raw 插件决定。Root 持有的订阅只捕获弱 Root 和原 WindowId，核对当前 root entity 身份、未消费的输入、原传播状态和 preventDefault；无焦点时也能按键导航，blur 本身不会抢焦点，原 focus trap 逻辑保留。Maka 在输入退休时撤销原 tab stop；不增加第二个窗口 Root、剪贴板 owner、插件焦点注册表或第二份编辑状态。

Added native scheduled-frame focus-reveal tests at `crates/base/src/root/focus_reveal.rs`: normal nested scroll, oversized controls, exact caret requests, sibling and same-list request competition, pointer click stability, AccessKit device bounds and failed prepaint recovery. They pause automatic drawing and deliver actual scheduled test-platform frames.

新增 `crates/base/src/root/focus_reveal.rs` 原生 scheduled-frame 测试，覆盖嵌套滚动、超大控件、精确 caret、兄弟及同 List 请求竞争、pointer 点击稳定、AccessKit device bounds 与失败 prepaint 恢复；暂停自动绘制并实际交付 test-platform 已安排的帧。


TextViewStyle projects local code font family, fenced-code base size and table background, preserving explicit transparency and using lazy native theme fallbacks only when omitted. Inline code shaping, paragraph cache keys and table width measurement use the same local family. Explicit TextView styles do not inherit an App Global code highlighter; inherited neutral styles retain the original default, while inverted surfaces retain their original suppression.

The original TextSelectionHandle synchronously withdraws a disabled participant from the existing native window selection state, stops its gesture and scrolling, and invalidates weak admission held by painted callbacks and deferred focus/wheel requests. A later enable does not revive old geometry or listeners. The original TextViewState clears inline selection immediately; root pointer/default focus, native SelectAll/Copy actions and both text/object multi-click listeners reject revoked admission. Deferred clearing cannot erase a newer local selection. Fresh paint registers the same owner again; trusted programmatic selection remains available. No second document, selection owner or registry is introduced. Native tests cover withdrawal, queued focus, original old-frame action/clipboard and pointer dispatch, fresh-paint recovery, and actual local code/table glyph measurement. Keyboard dispatch refreshes a dirty frame in Fast and is tested as the positive current-frame path. These prerequisites do not deliver product Markdown integration, decision-aware links, link keyboard/accessibility, or OS acceptance.

TextViewStyle 投影局部代码字体、fenced-code 字号和表格底色，保留显式透明，仅在未提供值时延迟读取原生主题。inline shaping、段落缓存和表格测量使用同一局部字体；显式样式不继承 App Global 高亮器，普通继承和反色表面的既有行为保留。原 TextSelectionHandle 同步从既有窗口选区撤销禁用参与者、停止手势与滚动，并使已绘制回调和延迟焦点/wheel 的弱准入失效；重新启用不会恢复旧几何和监听器。原 TextViewState 同步清除 inline 选择，pointer 默认焦点、SelectAll/Copy 和文字/对象多击均核准入。延迟清除不覆盖更新的局部选择，fresh paint 重新注册同一 owner，可信程序选择保留。不新增文档、选区 owner 或 registry；本片不是产品 Markdown、链接决定/键盘/可访问性或 OS 验收。


The imported inline-flow width-change test now notifies its original Answer after changing width, requesting the new root layout rather than depending on incidental dirty state. Its layout-count growth assertion is unchanged. The unmodified local baseline passed this test; the new selection lifecycle exposed its missing notification, so this is a fixture correction, not a claim of a pre-existing failing test.

导入的 inline-flow 宽度测试在修改原 Answer.width 后显式 notify，请求该 root 的新布局，不依赖偶然残留的 dirty 状态；布局计数增长断言保留。未修改的本地基线实际通过此测试，新选区生命周期暴露缺失的通知，因此只记录为测试修正，不声称基线原本失败。


TextView replaces the void link observer with a synchronous `LinkDecision`. The shared activation helper applies independent `prevent_default` and `stop_propagation` decisions before native selection-end and URL defaults. Text, inline objects and linked images use that helper; no compatibility alias remains. Native pointer tests cover the independent decisions and the original event/propagation observations. This is a decision boundary prerequisite: occurrence-owned real press pairing, keyboard navigation and AccessKit link actions still require integration and are not delivered by this change.

Maka disables Kit's default Component/assets features in both production and test dependencies. The native client-frame mechanics are imported from `crates/component/src/window_border.rs` at the same pinned Kit revision into Base; `upstream.json` records the finite local destination, original hash and source mapping. The original Base Root owns the wrapper and an appearance subscription retaining only a Weak Root. Immutable per-root frame values replace Component Global theme reads; omitted border colour follows that window's native appearance. Original client inset, tiling, edge resize and Server pass-through behavior are preserved. Tests deliver real pointer events to the original test platform and check its actual resize/inset observations and content identity; they do not claim Wayland OS acceptance.

TextView 删除 void 链接 observer，改用同步 `LinkDecision`。同一 activation helper 在原生结束选区及打开 URL 的默认效果前，独立执行 `prevent_default` 和 `stop_propagation`；文字、inline object 与链接图片共同使用，不保留旧 API 别名。原生 pointer 测试覆盖两个决定的独立组合及原 event/传播观察。该变更只完成 decision 边界前置；按 occurrence 持有的真实 press 配对、键盘导航和 AccessKit 链接 action 仍须接入，不宣称已经交付。

Maka 的生产和测试依赖均关闭 Kit 默认 Component/assets features。同一 pinned Kit revision 的 `crates/component/src/window_border.rs` 原生客户端 frame 机械行为有限移入 Base；`upstream.json` 记录本地 destination、原始 hash 和 source 映射。原 Base Root 单一持有 wrapper，appearance 订阅仅捕获 Weak Root。不可变局部 frame 值替代 Component Global theme 读取；省略边框色时读取所在窗口的原生 appearance。原 client inset、tiling、边缘 resize 和 Server 透传保留。测试向原 test platform 实际交付 pointer 并观察其 resize/inset 与原 content identity，不宣称 Wayland OS 验收。


Base Root native click-target regressions exercise the original fragmented Hitbox, single focus/Tab/AccessKit node, exact masks and scrolling, real cross-fragment pointer pairs, cancellation after native capture, window inactivity, consumed release, nested dispatch, dirty redraw, direct AX activation and custom AX precedence. Existing fabricated Hitbox fixtures explicitly select rectangle geometry. TextView's shared LinkDecision helper recognizes direct Accessibility activation, preparing occurrence-owned integration without a compatibility API. This prerequisite does not yet replace the old TextView MouseUp-derived fake down or deliver product Markdown/link navigation.

Base Root 的原生 click-target 测试覆盖原分片 Hitbox、单一 focus/Tab/AccessKit 节点、精确 mask/scroll、跨片段真实 pointer 配对、capture 后取消、窗口失活、被消费 release、嵌套派发、dirty 重绘、直接 AX 激活及显式 AX 优先；既有 Hitbox fixture 明确使用矩形几何。TextView 共同 LinkDecision helper 识别直接 Accessibility 激活，为 occurrence owner 接入准备，不保留兼容 API。本前置尚未替换旧 TextView 由 MouseUp 伪造 down 的实现，也不宣称已交付产品 Markdown/链接导航。


Parsed link marks carry source occurrence identity before flattening and slicing: Markdown uses the original start offset; HTML numbers anchors in the fragment DOM, with embedded Markdown fragments anchored at their original source start. Reference resolution retains occurrence identity and follows the original parser's first-definition-wins rule. TextView commits its parse context; reference-bearing Markdown uses complete-source syntax, while ordinary prose keeps the original incremental path. HTML append parses the complete DOM so chunk history cannot change the final document or link identity. Input append and complete syntax parsing are distinct facts: native list offsets survive append while complete parsing remeasures content. Structurally incompatible commits cancel settled and active selection. Original plain-image rendering respects declared height. Native/state tests cover reference updates, late and duplicate definitions, actual image buttons, scrolled append, canonical HTML repair and active pointer selection cancellation.

The unused inherited TextView `max_lines`/`is_clamped` API, LineSpan reporting and late paint-only snap are removed. They supplied a body-line-height budget for mixed documents, rather than a document line contract; Maka's products and SDK do not consume them. Ordinary components own summaries and structural expansion. Original overflow masks, scrolling, selection and focus reveal remain; GPUI's ordinary text line clamp is unaffected. Occurrence-owned native focus, admission and targets consume this parse identity as described below.

链接 mark 在扁平化与切片之前携带源 occurrence 身份：Markdown 使用原始起始 offset，HTML 使用 fragment DOM 中 anchor 的遍历序号，嵌入 Markdown 的 HTML fragment 另以原 source start 定位。引用解析保留身份，遵循原 parser 的首定义优先规则。TextView 提交解析 context；有引用的 Markdown 解析完整 source，普通 prose 保留原增量路径；HTML 追加解析完整 DOM，同 source 的结果和链接身份不依赖 chunk 历史。输入追加与全语法解析分别表达，原生 List 追加保留 offset，全解析重新测量；结构不兼容的 commit 撤销已完成及活动选择。原纯图片呈现遵循声明 height。实际原生/State 测试覆盖引用更新、晚到及重复定义、图片按钮、已滚动追加、HTML 修复及原 pointer selection 撤销。

删除没有 Maka 产品或 SDK 使用的继承 TextView `max_lines`/`is_clamped` API、LineSpan 报告和 late paint-only snap；它提供正文行高预算，而非混合文档的行数契约。普通组件负责摘要和结构展开；原 overflow mask、滚动、选择、focus reveal 保留，GPUI 普通文本的 line clamp 不变。解析身份用于下述 occurrence-owned 原生链接 focus、准入与 target。


Selection compatibility is decided by the original foreground TextView owner against its actually committed document, full-update baseline and reference facts before advancing the committed revision. Background parse order cannot authorize retaining a stale drag. Native regressions run only the original background dispatcher between a large replacement and append, keeping both parsed results uncommitted, then deliver the foreground commits; unchanged and changed references cancel the old drag, while an ordinary committed Markdown append preserves it.

原前台 TextView owner 在更新 committed revision 前，按实际已提交文档、full-update 基准及引用事实裁定选择兼容性；后台解析次序不能授权保留旧拖选。原生回归在大文本替换与追加之间仅推进原 background dispatcher，保持两个结果尚未前台提交，再交付前台 commit；引用相同和不同都取消旧拖选，已提交基准上的普通 Markdown 追加保留选择。


The existing background parse worker retains its consumed update message until parsing succeeds. Real append input merges with that message; replacement input supersedes it, and errors never schedule retries without new input. The last successful document remains a derived parse result, not a substitute for failed source input. Markdown `set_text` source extensions and `push_str` share this path regardless of error delivery order. Synchronous parse failure also withdraws the original selection and adapter immediately. Real MDX recovery tests compare complete source and fresh document structure, including delayed foreground commits and small/large replacements; a paused-draw native pointer test covers failed replacement during an active drag.

原后台解析 worker 在成功前保管已消费的输入消息；真实 append 与它合并，replacement 覆盖它，错误不在没有新输入时自动重试。最后成功文档仍是派生解析结果，不代替失败 source 输入。Markdown 的 `set_text` 源扩展与 `push_str` 共用此路径，不依赖错误是否已前台交付；同步解析失败立即撤销原选区与 adapter。真实 MDX 恢复测试比对完整 source 与 fresh 文档结构，覆盖延迟前台提交、大小 replacement；暂停绘制的原生 pointer 测试覆盖活动拖选时 replacement 失败。


TextView now owns one native focus, weak original press locator and admission lease per parsed source anchor. Local Inline/Flow prepaint groups the original text, code, object and image fragments into one ordinary native Div with exact hit regions, Tab/Enter/Space, direct AccessKit Click/Focus and a visible keyboard focus outline. It removes the MouseUp-derived fake-down paths and the implicit application-wide current-document stack; every original Inline, including fenced code and objects, receives the same explicit Weak document owner. Selection listeners upgrade only during actual events. Successful parse commits reconcile link facts and original List row focus metadata atomically. Target changes, parse errors and explicit interaction retirement synchronously cancel native presses and withdraw Tab/AX/default activation admission; fresh prepaint restores admission. Unchanged streamed anchors retain native focus and a valid press. Synchronous decisions run outside owner borrows and defaults recheck admission after handler reentry.

Complete fragment geometry follows original native masks, scrolling and retained rows. Materialized offscreen fragments remain logical native links; the original virtual List does not promise an initial Tab/AX tree for never-prepainted distant rows. Explicit retirement withdraws input before original native retained AnyView frame custody drains; dropping an external Entity alone does not claim immediate native resource release. Tests exercise actual native keyboard, pointer, image fragments, selection/clipboard, AX focus/reveal, List retry, retained scroll and retirement. This is a native prerequisite, not Maka product Markdown, complete timeline keyboard traversal, OS screen-reader/IME or finished product acceptance.

TextView 为每个解析源 anchor 持有一个原生 focus、原 press 的弱 locator 和准入 lease。同一 Inline/Flow prepaint 将原文字、代码、对象与图片片段汇入一个普通 native Div，使用精确 hit regions、Tab/Enter/Space、直接 AccessKit Click/Focus 和可见键盘焦点。删除由 MouseUp 伪造 down 的路径及应用级隐式当前文档栈，所有原 Inline（包括 fenced code、对象）显式接收同一 Weak 文档 owner；选区监听仅在真实事件时升级。成功 parse commit 原子对齐链接事实与原 List row focus metadata。目标变化、解析失败及显式 interaction retirement 同步取消原 press 并撤销 Tab/AX/default 准入，fresh prepaint 才恢复；不变的流式 anchor 保留原 focus 与有效 press。同步决定在 owner 借用之外调用，handler 重入后默认动作再次核准入。

完整片段几何随原 mask、scroll 和 retained row 处理；已 materialized 的离屏片段仍为原生逻辑链接，原虚拟 List 不承诺从未 prepaint 远端行的初始 Tab/AX 树。显式退休先撤输入，再等待原 retained AnyView frame custody 释放，不宣称仅删除外部 Entity 就即时释放原生资源。原生测试覆盖真实键盘、pointer、图片片段、选区/剪贴板、AX focus/reveal、List retry、retained scroll 和退休。本片是原生前置，不宣称产品 Markdown、完整 timeline 键盘遍历、OS screen-reader/IME 或成品验收。


The original TextView State's document element publishes selection after its actual content paint, including State-only retained gaps. Each original Inline/Object reports unclipped geometry against its own native HitboxId; the adapter keeps a report exactly while that hitbox survives native prepaint, projects its original glyph layout with a read-only translation and current mask, and publishes through the same selection participant. It never reshapes or mutates the shared TextLayout. The outer element captures the exact selection scope and holds reveal callback custody in its original native element state; weak State locators do not infer those facts from a skipped wrapper. Document order is resolved from the completed native focus tree for fresh and retained peers.

Derived bounds, selection runs and frame reports use the original native query classification. No-op snapshot leases, empty multi-click scroll-offset reads, baseline-ACK updates and inactive selection wheel/move updates are removed. Actual source, enabled, selection and interaction changes retain their original update/notification paths. The existing scope stack is temporary native traversal context, held in its original Global with interior borrowing instead of reactive writes. Touch handle/menu IDs are deduplicated and kept by completed native hitbox survival, replacing raw rectangles and two-generation rotation. Regressions assert actual internal List row reuse and translated glyphs, cross-document selection/copy across a State-only reflow, explicit scope isolation and a menu retained across consecutive peer publications.

原 TextView State 的 document element 在实际内容 paint 后发布选区，覆盖 State-only retained gap。每个原 Inline/Object 将未裁剪几何关联原 HitboxId；adapter 只在原 prepaint 仍保留 hitbox 时保报告，通过只读 translation 与当前 mask 投影原 glyph layout，再由同一 selection participant 发布，不重新塑形或改共享 TextLayout。外层元素捕获准确 scope，并在原 native element state 保持 reveal callback custody，弱 State locator 不从被跳过的 wrapper 推断事实。fresh 与 retained peer 的文档顺序按完成的原 native focus tree 解析。

派生 bounds、selection runs 与 frame reports 使用原 native query 分类；删除无变化的 snapshot mutable lease、空多击选区对 scroll offset 的读取、baseline ACK update、无活动选区的 wheel/move update。真正 source、enabled、selection 与 interaction 变化保留原 update/通知。既有 scope stack 是临时 native traversal context，在原 Global 内借用，不作为 reactive 写入。触控 handle/menu IDs 去重并按完成帧 hitbox 存活维护，删除 raw rectangle 与双代轮转。回归强断言真实内部 List row 复用及 glyph 平移、State-only reflow 后跨文档拖选/复制、显式 scope 隔离和连续 peer 发布时实际 retained menu 操作。


## Official Fast backend update

The workspace selects Kit's `gpui-fast` feature explicitly. Upstream's new parser
commit helper accepts queued append prefixes newer than the last committed parse,
preventing streaming starvation. Native selection compatibility still compares the
actually committed document; original link/row-focus ownership and structural-reset
selection retirement remain. Menu handlers execute outside the input Entity lease,
then update that original weak input with the upstream menu-focus result. Document
flow positioning and local row-focus wrappers coexist; typography remains locally
projected. These are native presentation patches, without new plugin/kernel state.

本次显式启用 Kit 官方 Fast 后端。采纳上游对有效流式前缀的提交规则，避免解析期间
持续追加使显示饥饿；选区兼容仍根据真实已提交文档，保留原链接/行焦点 owner 与
结构替换后的选区撤回。菜单回调在原 Input Entity 借用之外执行，再经其弱引用
应用上游菜单焦点结果。文档流位置与原行焦点 wrapper 合并，排版继续由局部值投影。
此处没有新增插件状态或内核权威。

Custom Markdown blocks carry their original TextView WeakEntity and native hitbox. Full bounds enter the existing selection contribution adapter, which owns current clipping and retained translation. A native test checks actual kept-row scrolling and SelectAll/Copy; its old paint-mask clipping mutation is equivalent on that opaque Fast layer path and does not demonstrate a clipping regression. Marker tests exclude single-character wrapping measurements while preserving all ordinal assertions.

自定义 Markdown 区块携带原 TextView WeakEntity 和原生 hitbox，将完整 bounds 交给既有选择贡献适配器，由它统一处理当前裁剪与保留行平移。原生测试检查真实旧行滚动及全选/复制；在该不透明 Fast layer 路径上，旧绘制 mask 裁剪变异等价，不构成已证裁剪回归。序号测试排除包装测量的单字符标点，保留所有起始与嵌套序号断言。

InputBaseState consumes Escape when it actually unmarks composition. A subsequent unmarked Escape can propagate to an enclosing application scope. This preserves native innermost dismissal ownership and prevents a single key from both cancelling composition and closing a product page.

Plain Up/Down in a single-line InputBaseState propagates to the containing native scope after the original context-menu action has had priority. Single-line PageUp/PageDown also propagates instead of consuming a no-op movement. These keys leave the original text and selection unchanged, allowing an ordinary plugin search input to navigate its surrounding list. Multiline vertical movement retains its native path. The Maka input test dispatches actual focused native keys and checks propagation and the original editor snapshot; it is not OS IME acceptance.

单行 InputBaseState 的普通 Up/Down 在原 context-menu action 优先处理后向外层原生 scope 传播；单行 PageUp/PageDown 也向外传播，不再消费无效果的移动。这些按键保留原文本与选区，让普通插件搜索框可控制外层列表。多行垂直移动仍走原生路径。Maka input 测试发送真实聚焦原生按键，检查传播及原编辑器 snapshot，不宣称 OS IME 验收。


Original InputBaseState and WindowSelectionState own one native InputGesture per active pointer/long-press/edge drag. Their completed text selections remain in the existing owners; scope interruption and editor disable retire transient drag state. AutoScroll observes the exact gesture weakly, carries that identity through original participant events and deferred synthetic wheels, and ends its original task on invalidation. An old stop/completion cannot affect a new gesture. Its local UI task now shares Rc<Cell<delta>>, removing the unnecessary mutex and Send bound. Public cleanup hooks capture input before user code and check interruption after it; original deferred participant focus also refuses an interrupted input before invoking user code. Native tests exercise both original self-scroll and ancestor-wheel paths, completed selection preservation, fresh pointer recovery and deferred focus. Bounds-only geometry tests use a real native window for gesture custody. This does not implement foreground/background reading-owner separation or the product Dialog.

原 InputBaseState 与 WindowSelectionState 每次拖选、长按或端点拖动只拥有一个原生 InputGesture；完成选区仍由原对象保存。作用域中断与编辑器禁用结束临时拖动。AutoScroll 弱观察同一手势，身份沿原 participant event 和 deferred wheel 转发；旧停止或任务完成不能干扰新手势。本地 UI task 使用 Rc<Cell<delta>>，去除不必要的锁和 Send。公开清理回调前捕获输入、返回后核验，原 deferred focus 在调用用户代码前拒绝过时输入。真实原生测试覆盖两种滚动路径、保留选区及新拖选恢复；尚未实现前后台阅读 owner 分离或产品 Dialog。

TextSelectionLayer now owns the original selection Entity per native window/focus group in its paint-accessed element state; the global registry remains weak. Per-group original element namespaces separate sibling layers and repeated layers share that owner. Locator and plain-text participant publication occur only in actual paint. Participants weakly attach to their actual painted group, withdraw and clear their old projection when moved, and target that owner for copy, scope activation, clearing and touch projection. A retiring group's pruning compares the original owner EntityId so a queued release cannot clear a participant already painted in another group. Rich layout reconciliation also runs only on actual document paint, preserving completed geometry selection across discarded prepaint transactions. The pending document-scope manager and unused WindowId-only clear entry have been removed. Foreground products must mount their Layer under their actual InputScope; this does not yet provide the full product Dialog or its local touch-menu composition.

TextSelectionLayer 在实际绘制访问的原 element state 中持有每个窗口/焦点组选区 Entity，全局定位表仍为弱引用。原每组 namespace 区分同级 Layer，同组重复 Layer 共享 owner。定位与普通文本 participant 注册仅在实际 paint 发布。participant 弱附着实际绘制组，移组撤回旧注册和投影，复制、scope 激活、清理及触摸投影均寻址原 owner。旧组 pruning 比较原 owner EntityId，迟到释放不能清除已挂入新组的 participant。富文本布局协调也仅在实际文档 paint 执行，失败 prepaint 不清除完成的几何选区。删除 pending scope manager 与无调用的仅 WindowId 清理入口。前景产品必须在实际 InputScope 内挂载 Layer；完整产品 Dialog 及其本地触摸菜单组合仍待完成。

Plain-text paint compares its own attached document's copy projection, rather than resolving the physically current group's callbacks. Native runs and copy projection updates are derived cache queries; snapshot, local selection and source changes retain their original model updates and notifications.

普通文本 paint 只比较原附着文档的复制投影，不解析物理当前组的回调。原生 runs 与复制投影使用派生缓存 query；snapshot、本地选择及源文本改变仍走原 model update 与通知。

## Upstream synchronization (2026-10-14)

Kit is pinned to `c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2` (0.7.3). The input-menu callback and parser acknowledgement now use upstream's implementations, replacing the equivalent local patches. Upstream's immutable run/copy projections and quiet participant registration replace the corresponding mutable query paths. Its reflow selection preservation, table rendering and native controls are retained.

The local physical input groups, exact byte selections, per-hitbox retained geometry and locally projected theme values remain: the upstream global traversal stack and paint-order counter do not provide those behaviors. Quiet registration still passes a participant's first or changed group through original custody reconciliation; completed-frame pruning remains tied to the native focus tree and hitboxes. This update does not merge the separate UI performance branch or migrate Maka to gpui-shell.

同步上游后，菜单回调、解析确认和部分只读选区投影直接采用上游实现。仍保留上游尚未覆盖的物理输入隔离、精确字节选区、保留帧几何与局部主题投影；本次不合并独立性能分支，也不代表完成 gpui-shell 迁移。

Participant enablement checks the current value before acquiring a write lease. Repeating the same admission state during layout must not invalidate retained rows under upstream's finer-grained entity-write tracking; real enablement changes retain the original revocation and group withdrawal path.

Plain input modes can install an exact whitespace-delimited literal-token registry. The existing inline-token store derives annotations synchronously after native edits, initialization and history replay; active IME text remains provisional until commit. This reuses upstream chip geometry and atomic range expansion without replacing the native buffer, selection or undo owner. An absent registry preserves the existing explicit token API; an explicitly empty registry removes literal annotations, including during later undo. Tests cover Unicode surroundings, repeated references, partial selections, interior carets, both deletion directions, cut, completion, history and composition.

## gpui-shell runtime (2026-10-16)

`crates/shell` (`gpui-shell`) is copied from revision `c5f8eca4a0759f8c0c7ed624eddfd03f1c93a5f2` with its `rquickjs-compat` facade, README and component inventory; `upstream.json` records each original file. Its integration tests are omitted because most of them need `gpui-component`. The facade's manifest declares MIT to match the `rquickjs` crate it replaces; its source comes from the GPUI Kit repository. The workspace includes both crates as members and patches crates.io `rquickjs` to the vendored facade, so LLRT and the shell share one QuickJS VM as in GPUI Kit.

The manifest is normalized to explicit upstream dependencies and lints. `gpui-fast` and `quickjs` are default features. The `components` feature and its `gpui-component` dependency are removed: `gpui-component` at this revision does not build against the adapted Base above, so an embedding host registers its own component catalog. Check-cfg declares the removed feature name, so the code it guards compiles out without warnings.

The bounded source changes adapt the runtime to the adapted Base, add two development switches, and backport four upstream pull requests that are not merged yet:

- `TextView` link handling uses Base's `on_link_activation`. Both handlers return a decision that prevents Base's default URL opening: the script callback receives the URL, or, without one, the shell opens only URLs its own rules admit. Accessibility activation counts as keyboard activation.
- Two element helpers that call `ElementExt::on_prepaint` add the `IntoElement` bound the adapted trait requires.
- `GPUI_SHELL_PASSIVE` opens the window without activating the application or taking focus. `GPUI_SHELL_METRICS_LOG` prints the runtime's script counters to stderr once a second. Both are off unless the variable is set.
- From longbridge/gpui-kit #3547, #3548, #3549 and #3550: a `list` keeps the reader on the item at the top of the view when its item count changes; `with_follow_mode("tail")` makes a `list` follow its end; `on_visible_range_change` reports which items a `list` shows after a frame in which that changed; and `TextareaState.set_submit_on_enter` makes Enter submit without inserting a line break. The next sync replaces them with the upstream versions.

`gpui-shell` 及其 `rquickjs-compat` 兼容层自同一上游版本复制，`upstream.json` 记录每个原始文件；集成测试大多依赖 `gpui-component`，因此未导入。兼容层清单声明 MIT 以对应其替代的 `rquickjs`，源码来自 GPUI Kit 仓库。工作区将两者作为成员，并把 crates.io 的 `rquickjs` 指向本地兼容层，使 LLRT 与 shell 共用同一 QuickJS VM。清单改为显式上游依赖与 lints，默认启用 `gpui-fast` 与 `quickjs`；该版本的 `gpui-component` 无法基于上面改过的 Base 编译，因此移除 `components` 特性及其依赖，由嵌入方注册自己的组件目录。源码改动仅限：链接处理改用 Base 的 `on_link_activation` 并阻止 Base 默认打开 URL，由脚本回调或 shell 自身的 URL 规则决定；两个调用 `on_prepaint` 的辅助函数补上 `IntoElement` 约束；新增仅在设置环境变量时生效的开发开关 `GPUI_SHELL_PASSIVE`（不激活、不抢焦点）与 `GPUI_SHELL_METRICS_LOG`（每秒输出脚本计数）；回移四个尚未合入上游的 PR（longbridge/gpui-kit #3547、#3548、#3549、#3550）：`list` 在条目数变化时让读者停在视口顶部的条目上，`with_follow_mode("tail")` 让 `list` 跟随末尾，`on_visible_range_change` 在可见范围变化的帧之后报告，`TextareaState.set_submit_on_enter` 让 Enter 直接提交、不插入换行。下次同步时以上游版本替换。

## Desktop theme fixes (2026-10-16)

Two fixes found while giving the Maka desktop its own palette, both candidates for upstream pull requests:

- Base's input editor falls back to the palette's `selection` role for its selection, at most 40% opaque, instead of `accent` at 40%. A product that sets `accent` to an opaque fill (Maka uses it for code blocks) otherwise draws a selection that cannot be seen; text views already paint `selection`.
- The shell's `cx.theme()` writes a translucent color as `#rrggbbaa`. It used to drop the alpha, so a script that drew a border in the `input` or `border` token got it opaque.

为 Maka 桌面端配色时修了两处，均可提交上游 PR：Base 输入框的默认选区改用调色板的 `selection` 角色（不透明度至多 40%），不再用 40% 的 `accent`；产品把 `accent` 设为不透明填充（Maka 用于代码块）时，原选区看不见，而文本视图本来就用 `selection`。shell 的 `cx.theme()` 对半透明颜色输出 `#rrggbbaa`；此前丢弃 alpha，脚本用 `input` 或 `border` 画的边框会变成不透明。

## Script spinner and TextView style (2026-10-16)

Two additions to the script API of `gpui-shell`, both candidates for upstream pull requests:

- `svg(path).spin(period_ms)` turns an icon about its center, one full turn every `period_ms` milliseconds. `svg(...)` now returns `SvgElement`, which declares the method. On any other element the call is recorded, does nothing, and is logged as not honoured, as `tooltip` is. The angle is computed when the icon is painted, from the time elapsed since one epoch shared by the process, so a script render that rebuilds the icon does not restart the turn. It moves in steps of 33 ms, 30 a second, as the native Maka client's spinner does: each paint schedules a notification of its view for when the next step is due, one timer per view. The view then materializes its retained snapshot again without calling the script's `render`; a `list` in the same view still calls its item renderer for the rows on screen, as on any redraw. Stepping rather than asking for every display frame keeps that to 30 redraws a second instead of 60 or 120. The notification makes a scroll container's content count as changed, so GPUI-fast does not show a spinner at an old angle from its scroll layer. With reduced motion on, the icon is drawn upright and schedules nothing.
- `TextView.text_style({...})` replaces parts of the `TextViewStyle` the shell builds from the theme: `headings` (a `default` entry and the levels 1 to 6), `paragraph_gap`, `foreground`, `muted_foreground`, `link`, `selection`, `border`, `code_background`, `inline_code_background`, `code_font_family`, `code_font_size`, `code_block`, `table_head` and `table_cell`. Keys left out keep the theme's value, and later calls fold onto earlier ones. The nested objects use the names and value formats of the element style methods (`text_size`, `line_height`, `font_weight`, `text_color`, `bg`, `border_color`, `rounded`, `px`, `py`), limited to those that apply to each part. An unknown key, a `null`, or a value of the wrong type throws where `text_style` is called. A method argument crosses into Rust only as a primitive value, so the prelude sends the object as one `path, value` pair per leaf; `style::absolute_length` is now `pub(crate)` for the parser.

为脚本 API 新增两项，均可提交上游 PR。`svg(path).spin(period_ms)` 让图标绕中心旋转，每 `period_ms` 毫秒转一整圈；`svg(...)` 改为返回声明了该方法的 `SvgElement`，在其他元素上调用会被记录但不生效，并像 `tooltip` 一样记录日志。角度在绘制时按当前时间相对进程内统一起点的差值计算，脚本重新 render 重建图标时不会从头开始转。角度按 33 毫秒一步（每秒 30 步）前进，与原生 Maka 客户端的转圈一致：每次绘制为下一步到期时安排一次对所在视图的通知，每个视图只用一个定时器。视图随后用保留的快照重新 materialize，不调用脚本的 `render`；同一视图里的 `list` 仍会像任何重绘一样为可见行调用条目渲染函数。按步前进而非每个显示帧都请求重绘，使重绘次数为每秒 30 次，而不是 60 或 120 次。该通知让滚动容器的内容算作已变化，GPUI-fast 因此不会从滚动层显示旧角度的图标。开启减少动态效果时，图标保持不转，也不安排任何步进。`TextView.text_style({...})` 替换 shell 按主题生成的 `TextViewStyle` 中的指定部分：`headings`（`default` 与 1 至 6 级）、`paragraph_gap`、`foreground`、`muted_foreground`、`link`、`selection`、`border`、`code_background`、`inline_code_background`、`code_font_family`、`code_font_size`、`code_block`、`table_head`、`table_cell`；未给出的键保留主题值，多次调用按顺序叠加。嵌套对象沿用元素样式方法的名称与取值格式（`text_size`、`line_height`、`font_weight`、`text_color`、`bg`、`border_color`、`rounded`、`px`、`py`），且每个部分只接受对它有效的方法。未知键、`null` 或类型错误的值在调用 `text_style` 处抛出异常。方法参数只能以基本类型值进入 Rust，因此 prelude 把对象展开为每个叶子一对 `路径, 值`；解析时用到的 `style::absolute_length` 因此改为 `pub(crate)`。

## Focus kept when its element goes away (2026-10-16)

One fix to `ShellRoot`, a candidate for an upstream pull request:

- A pressed control takes focus, and the press can remove it, as a button that closes the panel it is in does, or one that turns disabled. GPUI was then focused on nothing it rendered and sent every key to the window root alone, so actions bound further in stopped answering until the next press. The root now registers `Window::on_focus_lost` and moves focus to `Window::focus_lost_restore_target`, the nearest tab stop left on the path focus was on. It does so only when the focused element went away: a blur, such as the root's own blur on a background press, is left alone. The root remembers what was focused when it last rendered; a blur before the frame leaves nothing there, and a blur during the frame leaves the blurred element as its own target.

为 `ShellRoot` 修了一处，可提交上游 PR：按下的控件会拿到焦点，而按下的动作可能让它消失（如关闭所在面板的按钮，或变为禁用的按钮）。此前 GPUI 此时聚焦在一个已不渲染的元素上，所有按键只到窗口根节点，更内层绑定的 action 在下次点击前都不响应。现在根节点注册 `Window::on_focus_lost`，把焦点移到 `Window::focus_lost_restore_target`，即原焦点路径上仍存在的最近 tab stop。只有持有焦点的元素消失时才这样做；主动 blur（如根节点在点击背景时的 blur）保持不动。根节点记录自己上次渲染时的焦点：帧前的 blur 让该记录为空，帧内的 blur 则让被 blur 的元素本身成为目标，两种情况都不恢复。

## Placeholders replaced while a field lives (2026-10-17)

One addition to the script API of `gpui-shell`, a candidate for an upstream pull request:

- `InputState` and `TextareaState` gain `set_placeholder(text)`, which calls gpui-base's `set_placeholder` on the live state. A placeholder could be set only by `new({ placeholder })`, so an application that changes its language while running had to rebuild every field, with its listeners, to translate the text an empty field shows.

为 `gpui-shell` 的脚本 API 新增一项，可提交上游 PR：`InputState` 与 `TextareaState` 新增 `set_placeholder(text)`，在存活的状态上调用 gpui-base 的 `set_placeholder`。此前占位文字只能在 `new({ placeholder })` 时设定，应用在运行中切换语言时，必须连同监听器重建每个输入框，才能翻译空输入框显示的文字。
