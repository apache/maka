Computer Use 是独立且持久的 JavaScript REPL，直接调用 cua_repl；无需 Code Mode。变量与绑定对象在当前 Host 进程内跨调用和 Turn 保留。重启后 REPL 没有历史变量；请遵循模型请求提供的当前 Computer Use 状态。
`cua.computer.target` 标识选定的桌面平台（`mac`、`linux`、`windows`）。WSL 默认选择 Windows 主机；Shell 命令仍可能在 Linux 中运行。

全新 REPL 没有绑定目标。以下入口会输出 API 文档及清单或目标初始状态。浏览器 ID 只来自已配置的提供方；未配置时，通过 getApp 操作原生浏览器窗口。API 不提供 start_session 等驱动管理操作。

入口（选择目标时自动输出初始状态）：
- `await cua.getState({emit?})`：应用和已配置浏览器清单，包括清单错误。
- `await cua.listApps({emit?})`、`await cua.listWindows({emit?})`。
- `const app = await cua.getApp("Name / bundle ID / app path")` 或 `getApp({windowId})`。
  macOS 会启动缺失的应用。Windows getApp 选择已打开的窗口；先使用来自 cua.listApps() 的 ID 调用 `await cua.computer.launch_app({app: appId})`，再刷新清单并选择确切窗口。启动前会重新核对原生清单中的 ID，不接受任意可执行文件路径。名称有歧义时选择确切窗口。Linux 要求应用已打开。
- `await cua.listBrowsers({emit?})`、`await cua.listTabs({browser?, emit?})`。
- `const browser = await cua.getBrowser({id? , url?})`：只选择，不打开标签页。目标 URL 无需已打开；配置多个提供方时指定 ID。
- `const tab = await cua.getTab("tab ID", {browser?})` 或 `getTab({url}, {browser?})`。
- `await cua.createBrowserTab(browserId, url?)`：在已配置的配置文件中打开。这里和 getBrowser 中未带 scheme 的 URL 使用 HTTPS。不可用的提供方、标签页提及和不支持的创建选项会抛出错误。
  先创建归当前 turn 管理的空白页，再导航到明确提供的网址。拒绝导航后，空白页仍由 turn 结束时清理。
- `await browser.tabs.list()`、`await browser.tabs.get(id)`、`await browser.tabs.new()`：列出、绑定确切标签页或在该浏览器创建空白临时标签页。它们返回数据而不自动输出；get/new 返回 Tab 对象，不进行初始 AX 观察。使用观察目标前调用 getAXState。`await tab.title()` 和 `await tab.url()` 返回当前元数据，不改变无障碍观察。

App 和 Tab 观察：
- `getAXState({emit?, disableDiffing?})` 返回文本。标签页和 macOS 应用默认返回差异；Windows 和 Linux 应用返回完整状态。
- `getScreenshot({emit?})` 返回 Uint8Array 并输出图像。
- `getAXStateAndScreenshot(options?)` 返回 `{state, screenshot?}` 并输出可用结果。
发现、选择和观察会自动输出结果，直接调用即可。用 `nodeRepl.emitImage()` 包装 `getScreenshot()` 或用 `nodeRepl.write()` 包装 `getAXState()` 会重复输出。自行处理结果时使用 `{emit:false}`；清单错误仍会显示。Windows 原生截图方法在采集前拒绝 `{emit:false}`。同一次调用内相同图像只交付一次；之后的调用可以再次输出相同图像。
观察包含短暂 UI 更新的有限稳定等待（标签页 200 ms，应用 400 ms），不会等待任意异步任务，持续动画不会延长窗口。之后的更新需重新观察。仅截图后，先读取 `getAXState()` 再选择新索引。Linux/Windows 原生观察会在原元素仍有效时保留已观察元素的身份。
若应用忙碌导致原生 AX 观察失败，待应用恢复后刷新同一绑定对象。失败的观察会使旧索引和坐标失效。

App 和 Tab 操作：
- `click(index | [x,y], {mouseButton?, clickCount?})`、`drag([x,y], [x,y])`。
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`。
- 原生应用也接受鼠标按钮 `l/r/m` 和方向 `u/d/l/r`。macOS 会去除名称两端空白并忽略大小写，也接受按钮 `0/1/2` 分别表示左键、右键和中键。
- `setValue(index, string)`；Linux 原生应用不提供此操作。
- `selectText(index, text, {prefix?, suffix?, selectionType?})`，selectionType 为 `text`、`cursor_before` 或 `cursor_after`。原生选择仅支持 macOS。`text_not_found` 表示文本或给定上下文不存在，请重新读取当前状态。`ambiguous_text` 需要更具体的 prefix/suffix。
- `performSecondaryAction(index, action)`：使用原生 AX 观察中列出的确切操作。CDP 不提供次要操作，会拒绝此方法。

App 输入：`typeText(text)`、`paste(text, {format?})`、`pressKey(key)`。
Tab 输入：`typeText(index|null, text)`、`paste(index|null, text, {format?})`、`pressKey(index|null, key)`。给定索引会先聚焦已观察的字段，`null` 表示当前焦点。按键示例：`Return`、`Tab`、`super+a`、`shift+Left`。
粘贴格式：`text`（默认）、`md`（将 Markdown 源码作为纯文本）和 `html`。Linux 和 Windows 原生应用仅支持 `text`。原生 HTML 粘贴仅支持 macOS，需要可读的可编辑值和选区；它会临时激活确切窗口、保留选区，并恢复原剪贴板，除非用户已复制更新的内容。值未改变会报告为不确定。浏览器 HTML 粘贴需要已观察的 contenteditable 元素。

Tab 导航：`goto(url)`、`back()`、`forward()`、`reload()`、`close()`。导航支持 HTTP(S) 和 about:blank，并等待可观察的文档。覆盖主要 CDP 目标；跨进程 iframe 无障碍支持尚不完整。

`tab.clipboard` 提供 `read()`、`readText()`、`write(items)`、`writeText(text)`，返回数据而不自动输出。
富文本项目包含非空 `entries`；每个条目包含 `mimeType`，以及字符串字段 `text` 或 `base64` 中的一个。
可选 `presentationStyle` 为 `unspecified`、`inline` 或 `attachment`。例如：
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'你好'}]}])`。
使用同一已配置后端上下文的标签页共享这份虚拟数据，不读取或修改系统剪贴板。
安装桥接后，已授权页面通过 Clipboard API 使用同一份数据。Agent 的 `readText()` 返回首个
确切 `text/plain` 条目的文本；仅有 base64 时返回空字符串，页面的 `readText()` 则通过 Blob 解码。
Turn 清理移除页面桥接并保留数据；重置会创建新的空上下文。

`tab.playwright` 可以直接解析 DOM 定位器，不要求先读取 AX。
使用 `locator(selector)`、`getByRole`、`getByText`、`getByLabel`、
`getByPlaceholder` 或 `getByTestId`；`frameLocator(selector)` 进入 iframe。
定位器提供 `first/last/nth`、`filter`、`and/or`、`count`、`all`、
`allTextContents`、`textContent`、`innerText`、`getAttribute`、`isEnabled`
和 `isVisible`；`domSnapshot()` 返回页面的 DOM 无障碍文本。

定位器输入方法返回 undefined：`click(options?)`、`dblclick(options?)`、
`fill(text, options?)`、`type(text, options?)`、`press(key, options?)`、
`pressSequentially(text, options?)`、`selectOption(valueOrValues, options?)`、
`setChecked(boolean, options?)`、`check(options?)` 和 `uncheck(options?)`。
点击选项为 `button: 'left'|'right'|'middle'`、`modifiers`、`force`、`timeoutMs`；
勾选选项为 `force`、`timeoutMs`。修饰键为 `Alt`、`Control`、`ControlOrMeta`、
`Meta`、`Shift`；`ControlOrMeta` 按所选浏览器的平台解析。其他输入选项为
`timeoutMs`，它必须是正整数；准备阶段默认且最多 3000 毫秒，逐字符输入最多
5000 毫秒。选项选择接受 value 字符串，或带 `value`、`label`、非负整数
`index` 的描述对象；数组用于选择多个选项。

定位器选择唯一匹配，或多个匹配中唯一可见的元素；歧义会报错。
普通文本 fill/type 派发虚拟粘贴事件，尊重页面事件处理器的取消，并保留原剪贴板数据。
空粘贴默认不会清空值。剪贴板快捷键复用同一虚拟剪贴板；不支持的组合会在发送原生按键前拒绝。
成功写操作仅清除调用定位器所属集合的读取缓存。仍需在页面核对实际结果；
不确定的输入结果不会自动重放。

`await tab.getJsDialog()` 返回 undefined 或含 `type`、`dismiss()` 的当前对话框对象。
confirm 还有 `accept()`，prompt 有 `accept(text)`，允许空字符串。旧对象不能操作替换后的新对话框。
先处理对话框，再读取页面或输入。`getAXState()` 显示消息和索引控件；prompt 控件支持
`setValue`、`typeText` 和 Return/Escape。对话框控件没有页面坐标。
对话框打开时无法截图：单独截图会抛错，合并观察仅返回对话框状态，不含 screenshot 属性。
浏览器 Host 持有当前控制时会自动接受 beforeunload；turn 清理会断开控制，保留用户标签页。
CDP 页数接受有限数字，包括小数、零和负数。一页使用目标内容的宽或高，最小为 100 CSS 像素；坐标目标使用视口尺寸。CDP 的 `{pixels:n}` 扩展接受正的有限像素增量。
Linux 拒绝数字页数。Linux X11 默认使用 `{pixels:800}`，接受 1 到 65535 的整数像素距离，并发送 `max(round(pixels/100),1)` 个滚轮步进；实际内容移动量由应用决定。Linux Wayland 目前拒绝像素输入。

macOS 滚动使用正的有限数字页数，默认一页，并拒绝 `{pixels}`。当前原生适配器仅能交付 1 到 50 的整数页数；小数或更大页数仍未支持。Windows 要求坐标点和正的有限 `{pixels:500}`，拒绝省略距离及数字页数；坐标和按方向取正负后的距离使用 JavaScript `Math.round`，舍入结果须在有符号 32 位整数范围内。原生滚轮每轴增量限制在 [-32768,32767]，指针停留在目标点；内容移动量由应用决定。原生索引滚动保留选定的无障碍目标。原生索引点击支持一次语义点击；需要多次点击时使用截图坐标。

输入派发成功不代表已经确定应用的结果状态。
浏览器坐标使用最新截图，操作后需重新截图。Linux 窗口局部坐标无需先截图即可使用。Linux/Windows 原生截图映射在输入操作后继续有效，直到下一次观察替换；仅 AX 观察会清除图像映射，Windows 此后按坐标操作需要重新截图。窗口几何变化会使已保存的映射失效。macOS 当前仍要求在操作后重新截图再按坐标输入。原生语义操作使用保留的无障碍元素。应用菜单仅限所属进程和确切绑定窗口，关闭菜单的内容不会显示。菜单交互可能激活绑定窗口，并在菜单打开时保持激活。
macOS/Windows 坐标和键盘输入通过确切窗口的前台路径交付；macOS 在支持时恢复先前应用。Linux 保持后台交付。坐标输入可能移动系统指针。未验证的输入效果会在调用输出中报告。没有公开的 `delivery_mode` 选项，也不会自动重放。

`nodeRepl.write(value)` 输出文本/JSON。`await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` 输出图像。不提供文件/HTTP 图像 URL、Node、任意文件系统和网络 API。`cua.rewriteDocumentation()` 重新输出此参考文档。

Host 启用输出音频后，`await cua.computer.start_audio_recording({max_duration_ms?})` 开始录音并返回 undefined，其他调用可继续执行。时长默认 60000 ms，接受 100 到 300000 的整数。`await cua.computer.stop_audio_recording()` 返回已完成的双声道 24 kHz PCM16 WAV 的 `{filepath, bytes, data_url}`。达到时长后停止采集，再调用 stop 取回录音。`await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` 显式输出音频。未启用音频时，这些方法不存在。重置和 Session 清理会丢弃录音及其本地路径。

每次操作都使用当前 Host 权限；JS 对象不保留授权。Ask 模式下，Computer Use 批准在 REPL 执行超时计时开始前完成。macOS 原生操作在屏幕锁定时报告 `desktop_locked`；已连接 CDP 提供方和纯 REPL 计算仍可独立使用。

应用、浏览器站点和音频授权等待会暂停剩余执行预算。macOS/Windows 原生等待也会暂停预算；普通异步等待和 Linux 原生操作继续计时。暂停不会重置预算，也不会禁用取消。
每个 Session 有独立的 Maka 光标。输入操作自动显示光标。`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` 修改此 Session 的显示。颜色为 `blue`、`mint`、`violet`、`amber`、`rose`、`cyan`；标签最多 48 个字符。`cua.cursor.getState()` 报告设置及原生/浏览器可见性。处于 `idle` 的原生渲染器在首次原生指示时启动；`unavailable` 表示显示主机缺失或失败。重新配置可重试失败的渲染器。空闲光标保留至禁用或清理。光标不共享输入权限，也不移动系统指针。多个光标不能隔离物理键盘、应用焦点或输入法。
REPL 被取消、超时或耗尽堆内存后，需要 `cua_reset` 并重新绑定目标。已接纳的原生工作会在返回前结算；重置不会撤销已派发的输入。Turn 结束时，当前 Session 会关闭为该 Turn 创建的临时标签页，并释放页面观察；已有的用户标签页保持打开。重置会清除此 Session 的 REPL 和绑定并关闭其临时标签页，保留用户应用和原有标签页。关闭结果未确认时会保留所有权，不重放关闭操作。
