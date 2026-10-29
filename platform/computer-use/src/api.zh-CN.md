Computer Use 是独立且持久的 JavaScript REPL，直接调用 cua_repl；无需 Code Mode。变量与绑定对象在当前 Host 进程内跨调用和 Turn 保留。重启后 REPL 没有历史变量；请遵循模型请求提供的当前 Computer Use 状态。
`cua.computer.target` 标识选定的桌面平台（`mac`、`linux`、`windows`）。WSL 默认选择 Windows 主机；Shell 命令仍可能在 Linux 中运行。

`cua.computer` 另提供平台原生 snake_case 方法，参数为选项对象，与下文 App/Tab 的位置参数不同。`list_apps()`、`list_windows()` 和 Linux `get_screenshot()` 无需选项。先发现当前接口并读取清单：
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | 原生方法（音频另述） |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11：使用返回的 `window` 对象调用 `get_window_state({window, query?, include_screenshot?})`。点击传观察到的 `element_id` **或**整数 `x,y`：`click({window,element_id})` / `click({window,x,y,mouse_button?,click_count?,duration?,key?})`。有 `window` 时坐标相对窗口，省略则操作桌面。其他输入为 `type_text({window?,text,element_id?})`、`press_key({window?,key,duration?})`、`scroll({window?,direction,pixels?,x?,y?,element_id?,key?})`、`drag({window?,path:[{x,y},…],key?})`、`move({window?,x,y,key?})`、`move_relative({dx,dy,key?})`、`activate_window({window})`、`perform_secondary_action({window,element_id,action})`、`launch_app({app})`。`duration` 单位为毫秒。`drag_handle()` 创建桌面拖动句柄，提供 `start({x,y})`、`move_to({x,y})`、`end()`；请在本 turn 内显式结束。
- Windows：使用返回的 `{app,id,...}` 窗口描述。索引或截图输入前先读 `get_window_state({window,include_text?,include_screenshot?})`；默认含截图、不含文本。输入为 `click({window,element_index})` 或 `click({window,x,y,screenshotId?})`、`scroll({window,x,y,scrollX,scrollY,screenshotId?})`、`drag({window,from_x,from_y,to_x,to_y,screenshotId?})`、`press_key({window,key})`、`type_text({window,text})`、`set_value({window,element_index,value})`、`perform_secondary_action({window,element_index,action})`、`activate_window({window})`、`get_window({id})`、`launch_app({app})`。将 `screenshotId` 设为返回截图的 `id` 时使用图像坐标。省略时使用窗口局部整数坐标，范围按最近观察到的截图尺寸计算；未观察过截图时使用窗口尺寸。一次滚动可同时指定 `scrollX` 和 `scrollY`。次要操作目前支持 Expand/Collapse，其他标签会被拒绝。
- macOS：将返回的应用 `id` 用作 `app`。先读 `get_app_state({app})`，再用 `click({app,element_index})` 或 `click({app,x,y,mouse_button?,click_count?})`、`drag({app,from_x,from_y,to_x,to_y})`、`scroll({app,element_index,direction,pages?})`（也可用 `x,y`）、`press_key({app,key})`、`type_text({app,text})`、`paste({app,text,format:'text'})`、`set_value({app,element_index,value})`、`select_text({app,element_index,text,prefix?,suffix?,selection_type?})`、`perform_secondary_action({app,element_index,action})`。

原生清单和状态形状依平台而异；复用返回的 ID 和选择器，不传 App 包装对象的句柄。Linux 状态含 `ax_tree`、`screenshots`，截图项含 `filepath`、`bytes`、`data_url`。Windows 状态会输出截图；其他原生结果由调用者用 `nodeRepl.write`/`emitImage` 输出，变更方法返回 undefined。当前 Host/应用权限仍然生效；方法存在不保证后端可用或操作已支持。目标失效后重新观察，不重播结果未知的输入；不要把未结束的拖动跨 turn 使用；重置后重新观察。


全新 REPL 没有绑定目标。以下入口会输出 API 文档及清单或目标初始状态。浏览器 ID 来自已配置的 CDP 提供方和已连接的 Extension 浏览器提供方；精确 ID 优先；没有精确匹配时，`maka` 和 `chatgpt` 才选择唯一的当前 Extension 端点。两者都不可用时，通过 getApp 操作原生浏览器窗口。API 不提供 start_session 等驱动管理操作。

ChatGPT 和原版 OpenCLI 按实际能力尽力兼容。原版 OpenCLI 当前无法满足浏览器会话接口；没有精确 ID 或扩展实例选择时，`getBrowser({id: "opencli"})` 会在创建或认领标签页前选择唯一可用的已有提供方；没有候选或候选多个时拒绝选择。精确 ID 和已有句柄不会切换提供方。

入口（选择目标时自动输出初始状态）：
- `await cua.getState({emit?})`：应用和可用浏览器清单，包括清单错误。
- `await cua.listApps({emit?})`、`await cua.listWindows({emit?})`。
- `const app = await cua.getApp("Name / bundle ID / app path")` 或 `getApp({windowId})`。
  macOS 会启动缺失的应用。Windows getApp 选择已打开的窗口；先使用来自 cua.listApps() 的 ID 调用 `await cua.computer.launch_app({app: appId})`，再刷新清单并选择确切窗口。名称有歧义时选择确切窗口。Linux 要求应用已打开。
- `await cua.listBrowsers({emit?})`、`await cua.listTabs({browser?, emit?})`。
- `const browser = await cua.getBrowser({id? , url?})`：只选择，不打开标签页。目标 URL 无需已打开；存在多个可用提供方时指定 ID。
- `const tab = await cua.getTab("tab ID", {browser?})` 或 `getTab({url}, {browser?})`。
- `await cua.createBrowserTab(browserId, url?)`：在所选提供方的配置文件中打开。这里和 getBrowser 中未带 scheme 的 URL 使用 HTTPS。不可用的提供方、标签页提及和不支持的创建选项会抛出错误。
  先创建归当前 turn 管理的空白页，再导航到明确提供的网址。拒绝导航后，空白页仍由 turn 结束时清理。
- `await browser.tabs.list()`、`await browser.tabs.get(id)`、`await browser.tabs.new()`：列出、绑定确切标签页或在该浏览器创建空白临时标签页。它们返回数据而不自动输出；get/new 返回 Tab 对象，不进行初始 AX 观察。使用观察目标前调用 getAXState。`await tab.title()` 和 `await tab.url()` 返回当前元数据，不改变无障碍观察。

- 已连接的浏览器适配器还提供 `await browser.user.openTabs()` 和 `await browser.user.claimTab(tabOrId)`。前者返回当前用户标签页元数据；后者在核对当前权限并准备连接后返回普通 Tab。可传入清单中的字符串 ID 或对象。Turn 清理会释放用户标签页而不关闭它；本 Session 创建的标签页仍为临时页。`browser.tabs.get(id)` 保持延迟绑定，不进行初始认领或 AX 观察。这些方法不保留授权。对 Extension 提供方，`browser.tabs.list()` 列出本 Session 管理的标签页。配置的 CDP 提供方没有 `browser.user`，使用其 `browser.tabs` 方法。

Maka 提供 AX 浏览器模式：`tab.ax` 包含 `get`、`write`、`click`、`drag`、`paste`、
`performSecondaryAction`、`pressKey`、`scroll`、`selectText`、`setValue` 和 `typeText`；
操作参数与下述 Tab 方法相同。`await tab.ax.get(mode = 'state', {disableDiffing?})`
在 `state`、`screenshot`、`both` 模式下分别返回文本、图像字节或 `{state, screenshot?}`，不自动输出。
`await tab.ax.write(mode = 'state', options?)` 输出可用结果并返回 undefined。现有 Tab 平铺方法继续可用。
AX 门面与平铺方法操作同一绑定的 Tab。

App 和 Tab 观察：
- `getAXState({emit?, disableDiffing?})` 返回文本。标签页和 macOS 应用默认返回差异；Windows 和 Linux 应用返回完整状态。
- `getScreenshot({emit?})` 返回 Uint8Array 并输出图像。
- `getAXStateAndScreenshot(options?)` 返回 `{state, screenshot?}` 并输出可用结果。
发现、选择和观察会自动输出结果，直接调用即可。用 `nodeRepl.emitImage()` 包装 `getScreenshot()` 或用 `nodeRepl.write()` 包装 `getAXState()` 会重复输出。自行处理结果时使用 `{emit:false}`；清单错误仍会显示。Windows 原生截图方法在采集前拒绝 `{emit:false}`。同一次调用内相同图像只交付一次；之后的调用可以再次输出相同图像。
观察包含短暂 UI 更新的有限稳定等待（标签页 200 ms，应用 400 ms），不会等待任意异步任务，持续动画不会延长窗口。之后的更新需重新观察。同一未变浏览器文档的成功截图会保留已有 AX 引用；导航、文档替换或目标失效后，先刷新 `getAXState()` 再使用索引；新观察元素的索引也需要刷新获取。Linux/Windows 原生观察会在原元素仍有效时保留已观察元素的身份。
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

Tab 导航：`goto(url)`、`back()`、`forward()`、`reload()`、`close()`。
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` 返回 JPEG 字节，不自动输出图片。不传 `clip` 时截取视口；`fullPage: true` 截取整个文档。裁剪宽高必须为正数，坐标与尺寸使用 CSS 像素。视口截图先等待新帧，确认清理后才回退到同一标签页的截图命令；不重放结果不确定的操作。

Extension 提供方支持 `await tab.markDeliverable()`：在正常 Turn 结束时保留标签页并归还用户；`await tab.markHandoff()` 则为同一个 Session 保留标签页，下一次实际 Turn 激活时恢复并清除标记。原来的 agent/user 来源不变，因此 agent 创建的页面在之后未重新标记的 Turn 结束时关闭。后一次明确标记覆盖前一次。两者在收到匹配的意图 ACK 后返回 undefined；这不证明物理交付或清理成功，不保留站点权限，也不自动重放不确定的请求。直接 CDP 不支持这些标记。
导航支持 HTTP(S) 和 about:blank，并等待可观察的文档。覆盖主要 CDP 目标；跨进程 iframe 无障碍支持尚不完整。

`tab.clipboard` 提供 `read()`、`readText()`、`write(items)`、`writeText(text)`，返回数据而不自动输出。
富文本项目包含非空 `entries`；每个条目包含 `mimeType`，以及字符串字段 `text` 或 `base64` 中的一个。
可选 `presentationStyle` 为 `unspecified`、`inline` 或 `attachment`。例如：
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'你好'}]}])`。
使用同一已配置后端上下文的标签页共享这份虚拟数据，不读取或修改系统剪贴板。
安装桥接后，已授权页面通过 Clipboard API 使用同一份数据。Agent 的 `readText()` 返回首个
确切 `text/plain` 条目的文本；仅有 base64 时返回空字符串，页面的 `readText()` 则通过 Blob 解码。
Turn 清理移除页面桥接并保留数据；重置会创建新的空上下文。

等待方法返回 undefined。`locator.waitFor({state, timeoutMs?})` 必须指定
`state: 'attached'|'detached'|'visible'|'hidden'`，只检查第一个匹配元素；
没有匹配元素时，`detached` 和 `hidden` 成功。
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` 匹配完整 URL：
`*` 不跨越 `/`，`**` 可以跨越 `/`，其余字符按字面值匹配。`waitUntil` 默认为
`commit`；可指定 `load`、`domcontentloaded` 或 `networkidle`，在 URL 匹配后继续等待。
`tab.playwright.waitForLoadState({state?, timeoutMs?})` 默认等待 `load`，也支持
`domcontentloaded` 和 `networkidle`。条件等待默认 3000 ms，数值超时上限为
3000 ms。零不提供事件等待时间：定位器仍检查一次，当前 URL/加载状态可能已匹配，
networkidle 则超时。
`tab.playwright.waitForTimeout(ms)` 接受非负整数并等待固定时长。等待某个动作触发的
变化时，先启动等待，再执行动作，最后等待两个 promise。Stop 会取消原来的等待。

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

下载需要已连接且提供下载通知的 Extension 提供方，以及当前 Host 的下载权限。先在同一 Tab 上准备等待：
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
再执行点击或导航，随后 `const download = await pending`。
`await download.path({timeoutMs?})` 返回浏览器报告的文件名或 null；不会传输文件，也不证明路径归本任务所有。
路径可能位于另一主机、为空或不可用，没有 saveAs 操作。
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` 请求唯一匹配定位器的媒体。
下载等待返回数据而不自动输出，媒体触发方法返回 undefined。首个匹配的 Started 事件结束原生启动期限，之后仍受取消和 Host 清理约束。
读取权限与下载权限分开检查，源站点或目标站点不同时亦如此。只有 CDP 连接不能提供原生下载通知。
Maka 还提供两个窄扩展：`tab.cua.downloadMedia({x,y,timeoutMs?})` 和
`tab.dom_cua.downloadMedia({node_id,timeoutMs?})`。所选 Extension 提供方目前拒绝这些坐标或节点媒体命令，
使用已实现的定位器路径。
下载结果不确定时不会自动重试。
返回的对象保留原 Tab 绑定，不保留授权。请保持该标签页可用：`path()` 在查缓存前重新核对当前标签页元数据和 Host 权限。
旧对象不能让已关闭的标签页继续存活。之后的 Turn 仍需要当前标签页访问权限，可能需要再次认领标签页。

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
浏览器坐标操作使用 CSS 视口坐标，无需先截图；截图不缩放坐标。Linux 窗口局部坐标无需先截图即可使用。Linux/Windows 原生截图映射在输入操作后继续有效，直到下一次观察替换；仅 AX 观察会清除图像映射，Windows 此后按坐标操作需要重新截图。窗口几何变化会使已保存的映射失效。macOS 当前仍要求在操作后重新截图再按坐标输入。原生语义操作使用保留的无障碍元素。应用菜单仅限所属进程和确切绑定窗口，关闭菜单的内容不会显示。菜单交互可能激活绑定窗口，并在菜单打开时保持激活。
macOS/Windows 坐标和键盘输入通过确切窗口的前台路径交付；macOS 在支持时恢复先前应用。Linux 保持后台交付。坐标输入可能移动系统指针。未验证的输入效果会在调用输出中报告。没有公开的 `delivery_mode` 选项，也不会自动重放。

`nodeRepl.write(value)` 输出文本/JSON。`await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` 输出图像。不提供文件/HTTP 图像 URL、Node、任意文件系统和网络 API。`cua.rewriteDocumentation()` 重新输出此参考文档。

Host 启用输出音频后，`await cua.computer.start_audio_recording({max_duration_ms?})` 开始录音并返回 undefined，其他调用可继续执行。时长默认 60000 ms，接受 100 到 300000 的整数。`await cua.computer.stop_audio_recording()` 返回已完成的双声道 24 kHz PCM16 WAV 的 `{filepath, bytes, data_url}`。达到时长后停止采集，再调用 stop 取回录音。`await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` 显式输出音频。未启用音频时，这些方法不存在。重置和 Session 清理会丢弃录音及其本地路径。

每次操作都使用当前 Host 权限；JS 对象不保留授权。Ask 模式下，Computer Use 批准在 REPL 执行超时计时开始前完成。macOS 原生操作在屏幕锁定时报告 `desktop_locked`；已连接 CDP 提供方和纯 REPL 计算仍可独立使用。

应用、浏览器站点和音频授权等待会暂停剩余执行预算。macOS/Windows 原生等待也会暂停预算；普通异步等待和 Linux 原生操作继续计时。暂停不会重置预算，也不会禁用取消。
每个 Session 有独立的 Maka 光标。输入操作自动显示光标。`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` 修改此 Session 的显示。颜色为 `blue`、`mint`、`violet`、`amber`、`rose`、`cyan`；标签最多 48 个字符。`cua.cursor.getState()` 报告设置及原生/浏览器可见性。处于 `idle` 的原生渲染器在首次原生指示时启动；`unavailable` 表示显示主机缺失或失败。重新配置可重试失败的渲染器。空闲光标保留至禁用或清理。光标不共享输入权限，也不移动系统指针。多个光标不能隔离物理键盘、应用焦点或输入法。
REPL 被取消、超时或耗尽堆内存后，需要 `cua_reset` 并重新绑定目标。已接纳的原生工作会在返回前结算；重置不会撤销已派发的输入。正常 Turn 结束时，当前 Session 会关闭未标记保留的临时标签页，并释放页面观察；已有的用户标签页和明确保留的标签页按上述规则保持打开。重置清除本 Session 的 REPL 和绑定，不授予新权限，也不丢弃该 Session 保留的资源及清理责任。标记或关闭结果未确认时会保留责任，不重放操作。

`agent.browsers` 与 `cua.browsers` 是同一个浏览器集合；`list`、`get(id)`、`getDefault` 和 `getForUrl(url)` 返回元数据或惰性 Browser，不输出观察。`cua.getBrowser` 是输出说明的便捷入口。`browser.tabs.selected()` 返回逻辑会话选中的标签页；它不选择操作系统焦点标签页。直接 CDP 尚无逻辑选中服务，返回 `undefined`。

`await browser.nameSession(name)` 去除两端空白并保存托管标签组名称；`cua.createBrowserTab(id, url, {sessionName})` 先解析浏览器、等待命名成功，再创建标签页。当前公开 profile 不提供 visibility 能力。

`await browser.history({queries, limit, from, to})` 通过真实声明历史传输能力的扩展读取当前浏览器 profile 的历史。它要求当前权限边界下针对实际浏览器 ID 和 generation 的独立 `browser_history` 批准；网页或下载批准不能授权历史读取，来源策略也不会自动批准。默认查询全部历史并限制为 100 条；多查询结果按访问时间倒序合并、按 URL 去重后再应用总条数限制。Maka 扩展声明 Chrome history 权限，旧扩展未具备权限时不声明支持。ChatGPT 和其他第三方适配器仍为尽力支持。

- `await browser.user.getTabContext(tabOrId)` 读取当前可见用户标签页的内容，不认领或激活标签页。Host 对当前实际 URL 授权，调用者不能指定替代 URL。隐私标签页和单次读取前后发生 URL 变化的页面会被拒绝。结果为 `{kind:'text',text,title,url,truncated}`，或 `{kind:'document',data,fileName,mimeType,title,url}`；`data` 为实际导出文件的 `Uint8Array`。Host 提供文件发布服务时，文档还包含本 Session 持有的真实 `path`。Google Workspace 可提供 Markdown、PDF 或 XLSX，普通页面可包含当前选择，YouTube 视频页可包含字幕。`maka` 实现固定读取，`chatgpt` 在支持时复用原版读取协议；第三方插件按实际能力尽力支持。

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` 在当前页面执行自包含函数；字符串按表达式处理。`locator.evaluate` 向函数传入 `(element, arg)`，`locator.evaluateAll` 传入 `(elements, arg)`；单元素形式要求目标明确，集合形式允许零匹配。参数须可 JSON 序列化。结果为普通数据：忽略函数和 Symbol，BigInt 转为字符串，非有限数字转为 `null`。本 API 的结果上限为深度 8、数组 2000 项、对象 200 个键、字符串 200000 个 UTF-16 单元，按需使用 `[MaxDepth]`、`[Circular]` 和 `[Truncated]` 标记。
- 执行环境提供 DOM、CSS、几何、Range 和 Selection 的只读视图，不开放网络、Cookie、模块加载或 DOM 修改。滚动、局部 Range 边界和仅接收函数的定时器仍受支持。超时默认为 3000 ms，数字值限制在 0–3000 ms。停止或中断时，脚本可能已经执行；系统不会自动重放。现有站点授权和标签页归属继续生效。

浏览器指针方法包括 `tab.cua.move({x,y,keys?})`、
`click({x,y,button?,keypress?})`、`double_click({x,y,keypress?})`、
`drag({path:[{x,y},...],keys?})` 和
`scroll({x,y,scrollX,scrollY,keypress?})`。坐标与滚动距离采用 CSS 视口单位，
保留小数和负数；button 为 1（左键）、2（中键）或 3（右键）。指针修饰键为
Alt、Control、Meta、Shift、ControlOrMeta。`keypress({keys:[...]})` 向当前焦点
发送组合键；`type({text})` 使用浏览器虚拟剪贴板向当前焦点粘贴，保留已存剪贴板。
文本可含 Markdown，Google Sheets 使用纯文本。输入方法返回 undefined，结果未知时不自动重试。

`await tab.dom_cua.get_visible_dom()` 返回可见交互节点的 HTML 和字符串
`node_id`。把原样 ID 传给 `click({node_id})`、`double_click({node_id})`。
`scroll({node_id?,x,y})` 的 x/y 是滚动距离，省略 ID 时使用视口中心。
`keypress({keys:[...]})`、`type({text})` 操作当前焦点。除快照外均返回 undefined。
新快照会移除消失的节点绑定；导航或框架替换会使旧节点失效。应重新观察，不要猜测 ID
或重放结果未知的输入。

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# 浏览器排查
通过 `cua.getState()` 和 `agent.browsers.list()` 确认可用浏览器及其精确 ID。存在连接并不证明某个操作已经成功。绑定失效或结果不确定时，先查看当前状态再决定下一步；不要自动重复结果不确定的变更操作。
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# 浏览器授权
浏览器绑定不会保留授权。操作受当前 Session、turn、工作区策略和页面来源约束。页面读取许可不包含文件传输或整个浏览器配置文件的历史记录。审批被拒绝、Session 关闭或权限边界改变后，先处理这些状态再继续操作。
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# 浏览器可见性
通过 `browser.capabilities.list()` 确认所选浏览器是否提供可见性能力。可以读取此名称的文档，并不表示能力已经启用。缺少可见性能力时，创建标签页时传入 `visible` 会在创建前被拒绝。
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Session 命名
`await browser.nameSession(name)` 将去掉首尾空白后的非空名称用于当前浏览器 Session 的分组及后续创建的标签页。`cua.createBrowserTab(id, url, {sessionName})` 会先等待命名完成，再创建标签页；命名失败时不会创建标签页。
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# 用户标签页
`browser.user.openTabs()` 返回用户标签页的元信息，不会认领它们。`browser.user.claimTab(listedTabOrId)` 显式获取选定的精确标签页。`browser.tabs.get(id)` 返回延迟绑定，不会隐式认领任意用户标签页。Turn 清理时释放用户标签页，不关闭它们。
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# 受管理标签页的生命周期
创建的标签页默认为临时页，除非当前生命周期显式保留它们。`markDeliverable()` 为用户保留完成的结果；`markHandoff()` 为同一 Session 后续继续操作保留标签页。这些标记不会保留旧页面权限，也不会授权另一个 Session。关闭、停止和结果不确定的操作仍须完成各自的清理。
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# 浏览器后端是否可用
目前 Maka 的提供者包括浏览器扩展和配置的 CDP 连接，没有新增嵌入式浏览器后端。使用当前清单中的 ID 绑定浏览器和标签页。读取嵌入式后端或管理能力的参考文档，不会创建该后端，也不提供浏览器管理授权。
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# 操作中断
取消操作并不证明已经派发的操作被撤销。原操作结算前，保留其绑定及结果状态；不要换一个提供者重复变更。重置会清除 REPL 中的绑定，后续操作需要在当前权限下重新绑定目标。
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# 浏览器 API 用法
`agent.browsers` 和 `cua.browsers` 是同一个集合。集合调用返回数据或延迟绑定，不自动输出观察。`agent.documentation.get(name)` 按精确名称读取文档，返回其文本的 Promise，不自动输出文本。`tabs.selected()` 跟随 Session 的逻辑活动标签页。精确浏览器 ID 和既有标签页绑定不会切换提供者。
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# 无障碍观察
使用元素引用前读取新的无障碍状态。`tab.ax` 提供文档中列出的无障碍操作，`get(mode, options)` 返回状态、截图字节或两者，不自动输出。导航或文档变化可能让旧引用失效；重新观察，不猜测元素索引。
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# 可选浏览器能力
使用可选能力前，先读取选定对象的能力集合。文档名称不会启用原始 CDP、WebMCP、身份认证或验证挑战处理 API。集合中没有对应 ID 时，该能力不可用；已有页面操作仍受正常权限和生命周期检查约束。
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# 本地开发页面
选择能够访问目标开发网址的浏览器，并导航到明确的网址。本地主机名仍受当前工作区网络策略和页面来源授权约束。检查页面时保留选定浏览器的绑定；另一台机器的 localhost 指向不同的目标。
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# 文件上传
仅在所选浏览器文档提供上传操作时使用它们。上传需要当前页面和所选文件的独立许可；页面读取或下载许可不等于上传许可。文件选择器归属于打开它的精确页面交互。页面或选择器失效后，重新观察，不复用旧选择器。
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# 截图
`tab.getScreenshot()` 返回截图字节；观察辅助方法可以输出图像。导航、调整尺寸或滚动后，重新截图再决定坐标。截图只是观察，不证明先前输入已送达目标控件。
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# 视口能力
先读取 `browser.capabilities.list()`，再获取已发布的视口能力来调整尺寸。视口设置跟随浏览器 Session 的逻辑活动标签页及其当前生命周期。调整视口不会选择无关的系统焦点标签页，也不会授予页面访问权限。
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# 页面资源能力
仅在所选标签页发布该能力时使用页面资源接口。资源清单归属于已观察的页面和文档。导航或文档替换后获取新清单；旧资源 ID 不能授权另一页面的文件。保存文件需要该操作当前的文件传输许可。
<!-- /browser-document -->

### 文件选择与上传

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

先开始等待，再执行打开文件选择器的操作。默认及最长事件等待时间为 3000 毫秒；显式 timeout 必须是正整数。`isMultiple()` 同步返回。`setFiles(pathOrPaths, {timeoutMs})` 接受单一路径或非空数组；单选选择器拒绝多个路径。可选 timeout 会校验，但不会丢弃已经派发的文件选择请求。

路径属于 Agent Host 的文件系统，仍受调用者的工作区文件策略约束。网页访问、当前 HTTP(S) 来源的上传批准、文件读取权限互相独立。当前输入快照支持普通文件。文件作为不可变字节传输，由所选 Maka 浏览器宿主物化；不要自行换算操作系统之间的文件路径。

选择器句柄绑定签发它的标签页、文档及 turn。子 target 的选择器不受支持。扩展选择器要求完整的事件来源信息，上传还要求证实浏览器宿主的文件可见位置。Chatgpt 尽力兼容；没有该位置证明的配置 CDP 会在发送文件前拒绝上传。不会为此把已绑定标签页替换到另一浏览器。成功选择会消耗句柄；结果未知时应先处理原请求，不能重放。

若清理报告结果未确认，不要假定上传副本已经删除。浏览器宿主退出时仍被选择的文件，目前没有后续自动回收能力。
