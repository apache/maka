Computer Use 是獨立且持久的 JavaScript REPL，直接呼叫 cua_repl；無需 Code Mode。變數與綁定物件在目前 Host 程序內跨呼叫和 Turn 保留。重新啟動後 REPL 沒有歷史變數；請遵循模型請求提供的目前 Computer Use 狀態。
`cua.computer.target` 識別選定的桌面平台（`mac`、`linux`、`windows`）。WSL 預設選擇 Windows 主機；Shell 命令仍可能在 Linux 中執行。

`cua.computer` 另提供平台原生 snake_case 方法，參數為選項物件，與下文 App/Tab 的位置參數不同。`list_apps()`、`list_windows()` 和 Linux `get_screenshot()` 無需選項。先探索目前介面並讀取清單：
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | 原生方法（音訊另述） |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11：使用傳回的 `window` 物件呼叫 `get_window_state({window, query?, include_screenshot?})`。點擊傳觀察到的 `element_id` **或**整數 `x,y`：`click({window,element_id})` / `click({window,x,y,mouse_button?,click_count?,duration?,key?})`。有 `window` 時座標相對視窗，省略則操作桌面。其他輸入為 `type_text({window?,text,element_id?})`、`press_key({window?,key,duration?})`、`scroll({window?,direction,pixels?,x?,y?,element_id?,key?})`、`drag({window?,path:[{x,y},…],key?})`、`move({window?,x,y,key?})`、`move_relative({dx,dy,key?})`、`activate_window({window})`、`perform_secondary_action({window,element_id,action})`、`launch_app({app})`。`duration` 單位為毫秒。`drag_handle()` 建立桌面拖曳控制物件，提供 `start({x,y})`、`move_to({x,y})`、`end()`；請在本 turn 內明確結束。
- Windows：使用傳回的 `{app,id,...}` 視窗描述。索引或擷取畫面輸入前先讀 `get_window_state({window,include_text?,include_screenshot?})`；預設含擷取畫面、不含文字。輸入為 `click({window,element_index})` 或 `click({window,x,y,screenshotId?})`、`scroll({window,x,y,scrollX,scrollY,screenshotId?})`、`drag({window,from_x,from_y,to_x,to_y,screenshotId?})`、`press_key({window,key})`、`type_text({window,text})`、`set_value({window,element_index,value})`、`perform_secondary_action({window,element_index,action})`、`activate_window({window})`、`get_window({id})`、`launch_app({app})`。將 `screenshotId` 設為傳回擷取畫面的 `id` 時使用影像座標。省略時使用視窗局部整數座標，範圍依最近觀察到的擷取畫面尺寸計算；尚未觀察過擷取畫面時使用視窗尺寸。一次捲動可同時指定 `scrollX` 和 `scrollY`。次要操作目前支援 Expand/Collapse，其他標籤會被拒絕。
- macOS：將傳回的應用程式 `id` 用作 `app`。先讀 `get_app_state({app})`，再用 `click({app,element_index})` 或 `click({app,x,y,mouse_button?,click_count?})`、`drag({app,from_x,from_y,to_x,to_y})`、`scroll({app,element_index,direction,pages?})`（也可用 `x,y`）、`press_key({app,key})`、`type_text({app,text})`、`paste({app,text,format:'text'})`、`set_value({app,element_index,value})`、`select_text({app,element_index,text,prefix?,suffix?,selection_type?})`、`perform_secondary_action({app,element_index,action})`。

原生清單和狀態形狀依平台而異；重用傳回的 ID 和選擇器，不傳 App 包裝物件的控制代碼。Linux 狀態含 `ax_tree`、`screenshots`，擷取畫面項目含 `filepath`、`bytes`、`data_url`。Windows 狀態會輸出擷取畫面；其他原生結果由呼叫者用 `nodeRepl.write`/`emitImage` 輸出，變更方法傳回 undefined。目前 Host/應用程式權限仍然生效；方法存在不保證後端可用或操作已支援。目標失效後重新觀察，不重播結果未知的輸入；不要將未結束的拖曳跨 turn 使用；重設後重新觀察。


全新 REPL 沒有綁定目標。以下入口會輸出 API 文件及清單或目標初始狀態。瀏覽器 ID 來自已設定的 CDP 提供者和已連線的 Extension 瀏覽器提供方；精確 ID 優先；沒有精確匹配時，`maka` 和 `chatgpt` 才選擇唯一的目前 Extension 端點。兩者都無法使用時，透過 getApp 操作原生瀏覽器視窗。API 不提供 start_session 等驅動程式管理操作。

ChatGPT 和原版 OpenCLI 依實際能力盡力相容。原版 OpenCLI 目前無法滿足瀏覽器工作階段介面；沒有精確 ID 或擴充功能執行個體選擇時，`getBrowser({id: "opencli"})` 會在建立或認領分頁前選擇唯一可用的既有提供者；沒有候選或有多個候選時拒絕選擇。精確 ID 和既有控制代碼不會切換提供者。

入口（選擇目標時自動輸出初始狀態）：
- `await cua.getState({emit?})`：應用程式和可用瀏覽器清單，包括清單錯誤。
- `await cua.listApps({emit?})`、`await cua.listWindows({emit?})`。
- `const app = await cua.getApp("Name / bundle ID / app path")` 或 `getApp({windowId})`。
  macOS 會啟動缺少的應用程式。Windows getApp 選擇已開啟的視窗；先使用來自 cua.listApps() 的 ID 呼叫 `await cua.computer.launch_app({app: appId})`，再重新整理清單並選擇確切視窗。名稱有歧義時選擇確切視窗。Linux 要求應用程式已開啟。
- `await cua.listBrowsers({emit?})`、`await cua.listTabs({browser?, emit?})`。
- `const browser = await cua.getBrowser({id? , url?})`：只選擇，不開啟分頁。目標 URL 無需已開啟；有多個可用提供者時指定 ID。
- `const tab = await cua.getTab("tab ID", {browser?})` 或 `getTab({url}, {browser?})`。
- `await cua.createBrowserTab(browserId, url?)`：在所選提供者的設定檔中開啟。這裡和 getBrowser 中未帶 scheme 的 URL 使用 HTTPS。無法使用的提供者、分頁提及和不支援的建立選項會擲出錯誤。
  先建立歸目前 turn 管理的空白頁，再導覽至明確提供的網址。拒絕導覽後，空白頁仍由 turn 結束時清理。
- `await browser.tabs.list()`、`await browser.tabs.get(id)`、`await browser.tabs.new()`：列出、綁定確切分頁或在該瀏覽器建立空白暫時分頁。它們傳回資料而不自動輸出；get/new 傳回 Tab 物件，不進行初始 AX 觀察。使用觀察目標前呼叫 getAXState。`await tab.title()` 和 `await tab.url()` 傳回目前中繼資料，不改變輔助使用觀察。

- 已連線的瀏覽器配接器還提供 `await browser.user.openTabs()` 和 `await browser.user.claimTab(tabOrId)`。前者傳回目前使用者分頁中繼資料；後者在核對目前權限並準備連線後傳回普通 Tab。可傳入清單中的字串 ID 或物件。Turn 清理會釋放使用者分頁而不關閉它；本 Session 建立的分頁仍為暫時頁。`browser.tabs.get(id)` 保持延遲綁定，不進行初始認領或 AX 觀察。這些方法不保留授權。對 Extension 提供方，`browser.tabs.list()` 列出本 Session 管理的分頁。設定的 CDP 提供者沒有 `browser.user`，使用其 `browser.tabs` 方法。

Maka 提供 AX 瀏覽器模式：`tab.ax` 包含 `get`、`write`、`click`、`drag`、`paste`、
`performSecondaryAction`、`pressKey`、`scroll`、`selectText`、`setValue` 和 `typeText`；
操作參數與下述 Tab 方法相同。`await tab.ax.get(mode = 'state', {disableDiffing?})`
在 `state`、`screenshot`、`both` 模式下分別傳回文字、影像位元組或 `{state, screenshot?}`，不自動輸出。
`await tab.ax.write(mode = 'state', options?)` 輸出可用結果並傳回 undefined。既有 Tab 平鋪方法繼續可用。
AX 門面與平鋪方法操作同一綁定的 Tab。

App 和 Tab 觀察：
- `getAXState({emit?, disableDiffing?})` 傳回文字。分頁和 macOS 應用程式預設傳回差異；Windows 和 Linux 應用程式傳回完整狀態。
- `getScreenshot({emit?})` 傳回 Uint8Array 並輸出影像。
- `getAXStateAndScreenshot(options?)` 傳回 `{state, screenshot?}` 並輸出可用結果。
探索、選擇和觀察會自動輸出結果，直接呼叫即可。用 `nodeRepl.emitImage()` 包裝 `getScreenshot()` 或用 `nodeRepl.write()` 包裝 `getAXState()` 會重複輸出。自行處理結果時使用 `{emit:false}`；清單錯誤仍會顯示。Windows 原生擷取畫面方法在擷取前拒絕 `{emit:false}`。同一次呼叫內相同影像只交付一次；之後的呼叫可以再次輸出相同影像。
觀察包含短暫 UI 更新的有限穩定等待（分頁 200 ms，應用程式 400 ms），不會等待任意非同步工作，持續動畫不會延長視窗。之後的更新需重新觀察。同一未變瀏覽器文件的成功擷取畫面會保留既有 AX 引用；導覽、文件替換或目標失效後，先重新整理 `getAXState()` 再使用索引；新觀察元素的索引也需要重新整理取得。Linux/Windows 原生觀察會在原元素仍有效時保留已觀察元素的身分。
若應用程式忙碌導致原生 AX 觀察失敗，待應用程式恢復後重新整理同一綁定物件。失敗的觀察會使舊索引和座標失效。

App 和 Tab 操作：
- `click(index | [x,y], {mouseButton?, clickCount?})`、`drag([x,y], [x,y])`。
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`。
- 原生應用程式也接受滑鼠按鈕 `l/r/m` 和方向 `u/d/l/r`。macOS 會移除名稱兩端空白並忽略大小寫，也接受按鈕 `0/1/2` 分別表示左鍵、右鍵和中鍵。
- `setValue(index, string)`；Linux 原生應用程式不提供此操作。
- `selectText(index, text, {prefix?, suffix?, selectionType?})`，selectionType 為 `text`、`cursor_before` 或 `cursor_after`。原生選取僅支援 macOS。`text_not_found` 表示文字或指定上下文不存在，請重新讀取目前狀態。`ambiguous_text` 需要更具體的 prefix/suffix。
- `performSecondaryAction(index, action)`：使用原生 AX 觀察中列出的確切操作。CDP 不提供次要操作，會拒絕此方法。

App 輸入：`typeText(text)`、`paste(text, {format?})`、`pressKey(key)`。
Tab 輸入：`typeText(index|null, text)`、`paste(index|null, text, {format?})`、`pressKey(index|null, key)`。指定索引會先聚焦已觀察的欄位，`null` 表示目前焦點。按鍵範例：`Return`、`Tab`、`super+a`、`shift+Left`。
貼上格式：`text`（預設）、`md`（將 Markdown 原始碼作為純文字）和 `html`。Linux 和 Windows 原生應用程式僅支援 `text`。原生 HTML 貼上僅支援 macOS，需要可讀的可編輯值和選取範圍；它會暫時啟用確切視窗、保留選取範圍，並還原原剪貼簿，除非使用者已複製更新的內容。值未改變會回報為不確定。瀏覽器 HTML 貼上需要已觀察的 contenteditable 元素。

Tab 導覽：`goto(url)`、`back()`、`forward()`、`reload()`、`close()`。
Extension 提供者支援 `await tab.markDeliverable()`：在正常 Turn 結束時保留分頁並歸還使用者；`await tab.markHandoff()` 則為同一個 Session 保留分頁，下一次實際 Turn 啟用時恢復並清除標記。原本的 agent/user 來源不變，因此 agent 建立的分頁會在之後未重新標記的 Turn 結束時關閉。後一次明確標記覆蓋前一次。兩者在收到相符的意圖 ACK 後傳回 undefined；這不證明實體交付或清理成功，不保留網站權限，也不自動重播不確定的請求。直接 CDP 不支援這些標記。
導覽支援 HTTP(S) 和 about:blank，並等待可觀察的文件。涵蓋主要 CDP 目標；跨程序 iframe 輔助使用支援尚不完整。

`tab.clipboard` 提供 `read()`、`readText()`、`write(items)`、`writeText(text)`，傳回資料而不自動輸出。
富文字項目包含非空 `entries`；每個項目包含 `mimeType`，以及字串欄位 `text` 或 `base64` 中的一個。
可選 `presentationStyle` 為 `unspecified`、`inline` 或 `attachment`。例如：
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'你好'}]}])`。
使用同一已設定後端上下文的分頁共用這份虛擬資料，不讀取或修改系統剪貼簿。
安裝橋接後，已授權頁面透過 Clipboard API 使用同一份資料。Agent 的 `readText()` 傳回首個
確切 `text/plain` 項目的文字；只有 base64 時傳回空字串，頁面的 `readText()` 則透過 Blob 解碼。
Turn 清理移除頁面橋接並保留資料；重設會建立新的空上下文。

等待方法回傳 undefined。`locator.waitFor({state, timeoutMs?})` 必須指定
`state: 'attached'|'detached'|'visible'|'hidden'`，只檢查第一個相符元素；
沒有相符元素時，`detached` 和 `hidden` 成功。
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` 比對完整 URL：
`*` 不跨越 `/`，`**` 可以跨越 `/`，其餘字元依字面值比對。`waitUntil` 預設為
`commit`；可指定 `load`、`domcontentloaded` 或 `networkidle`，在 URL 相符後繼續等待。
`tab.playwright.waitForLoadState({state?, timeoutMs?})` 預設等待 `load`，亦支援
`domcontentloaded` 和 `networkidle`。條件等待預設 3000 ms，數值逾時上限為
3000 ms。零不提供事件等待時間：定位器仍檢查一次，目前 URL/載入狀態可能已符合，
networkidle 則逾時。
`tab.playwright.waitForTimeout(ms)` 接受非負整數並等待固定時長。等待某個動作觸發的
變化時，先啟動等待，再執行動作，最後等待兩個 promise。Stop 會取消原來的等待。

`tab.playwright` 可直接解析 DOM 定位器，不要求先讀取 AX。
使用 `locator(selector)`、`getByRole`、`getByText`、`getByLabel`、
`getByPlaceholder` 或 `getByTestId`；`frameLocator(selector)` 進入 iframe。
定位器提供 `first/last/nth`、`filter`、`and/or`、`count`、`all`、
`allTextContents`、`textContent`、`innerText`、`getAttribute`、`isEnabled`
與 `isVisible`；`domSnapshot()` 傳回頁面的 DOM 無障礙文字。

定位器輸入方法傳回 undefined：`click(options?)`、`dblclick(options?)`、
`fill(text, options?)`、`type(text, options?)`、`press(key, options?)`、
`pressSequentially(text, options?)`、`selectOption(valueOrValues, options?)`、
`setChecked(boolean, options?)`、`check(options?)` 與 `uncheck(options?)`。
點擊選項為 `button: 'left'|'right'|'middle'`、`modifiers`、`force`、`timeoutMs`；
勾選選項為 `force`、`timeoutMs`。修飾鍵為 `Alt`、`Control`、`ControlOrMeta`、
`Meta`、`Shift`；`ControlOrMeta` 按所選瀏覽器的平台解析。其他輸入選項為
`timeoutMs`，必須是正整數；準備階段預設且最多 3000 毫秒，逐字元輸入最多
5000 毫秒。選項選擇接受 value 字串，或帶 `value`、`label`、非負整數
`index` 的描述物件；陣列用來選擇多個選項。

定位器選擇唯一匹配，或多個匹配中唯一可見的元素；有歧義時會報錯。
一般文字 fill/type 派發虛擬貼上事件，尊重頁面事件處理器的取消，並保留原剪貼簿資料。
空貼上預設不會清空值。剪貼簿快捷鍵共用同一虛擬剪貼簿；不支援的組合會在傳送原生按鍵前拒絕。
成功寫入僅清除呼叫定位器所屬集合的讀取快取。仍須在頁面核對實際結果；
不確定的輸入結果不會自動重播。

下載需要已連線且提供下載通知的 Extension 提供方，以及目前 Host 的下載權限。先在同一 Tab 上準備等待：
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
再執行點擊或導覽，隨後 `const download = await pending`。
`await download.path({timeoutMs?})` 傳回瀏覽器回報的檔名或 null；不會傳輸檔案，也不證明路徑歸本任務所有。
路徑可能位於另一主機、為空或無法使用，沒有 saveAs 操作。
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` 請求唯一匹配定位器的媒體。
下載等待傳回資料而不自動輸出，媒體觸發方法傳回 undefined。首個匹配的 Started 事件結束原生啟動期限，之後仍受取消和 Host 清理約束。
讀取權限與下載權限分開檢查，來源網站或目標網站不同時亦如此。只有 CDP 連線無法提供原生下載通知。
Maka 另提供兩個窄擴充：`tab.cua.downloadMedia({x,y,timeoutMs?})` 和
`tab.dom_cua.downloadMedia({node_id,timeoutMs?})`。所選 Extension 提供方目前拒絕這些座標或節點媒體命令，
使用已實作的定位器路徑。
下載結果不確定時不會自動重試。
傳回的物件保留原 Tab 綁定，不保留授權。請保持該分頁可用：`path()` 在查快取前重新核對目前分頁中繼資料和 Host 權限。
舊物件無法讓已關閉的分頁繼續存活。之後的 Turn 仍需要目前分頁存取權限，可能需要再次認領分頁。

`await tab.getJsDialog()` 傳回 undefined 或含 `type`、`dismiss()` 的目前對話框物件。
confirm 還有 `accept()`，prompt 有 `accept(text)`，允許空字串。舊物件不能操作替換後的新對話框。
先處理對話框，再讀取頁面或輸入。`getAXState()` 顯示訊息和索引控制項；prompt 控制項支援
`setValue`、`typeText` 和 Return/Escape。對話框控制項沒有頁面座標。
對話框開啟時無法擷取畫面：單獨擷取會擲錯，合併觀察僅傳回對話框狀態，不含 screenshot 屬性。
瀏覽器 Host 持有目前控制時會自動接受 beforeunload；turn 清理會斷開控制，保留使用者分頁。
CDP 頁數接受有限數字，包括小數、零和負數。一頁使用目標內容的寬或高，最小為 100 CSS 像素；座標目標使用視口尺寸。CDP 的 `{pixels:n}` 擴充接受正的有限像素增量。
Linux 拒絕數字頁數。Linux X11 預設使用 `{pixels:800}`，接受 1 到 65535 的整數像素距離，並傳送 `max(round(pixels/100),1)` 個滾輪步進；實際內容移動量由應用程式決定。Linux Wayland 目前拒絕像素輸入。

macOS 捲動使用正的有限數字頁數，預設一頁，並拒絕 `{pixels}`。目前原生配接器僅能交付 1 到 50 的整數頁數；小數或更大頁數仍未支援。Windows 要求座標點和正的有限 `{pixels:500}`，拒絕省略距離及數字頁數；座標和依方向取正負後的距離使用 JavaScript `Math.round`，捨入結果須在有符號 32 位元整數範圍內。原生滾輪每軸增量限制在 [-32768,32767]，指標停留在目標點；內容移動量由應用程式決定。原生索引捲動保留選定的輔助使用目標。原生索引點擊支援一次語義點擊；需要多次點擊時使用擷取畫面座標。

輸入派發成功不代表已經確定應用程式的結果狀態。
瀏覽器座標操作使用 CSS 視口座標，無需先擷取畫面；擷取畫面不縮放座標。Linux 視窗區域座標不需先擷取畫面即可使用。Linux/Windows 原生擷取畫面映射在輸入操作後繼續有效，直到下一次觀察取代；僅 AX 觀察會清除影像映射，Windows 此後按座標操作需要重新擷取畫面。視窗幾何變化會使已儲存的映射失效。macOS 目前仍要求在操作後重新擷取畫面再按座標輸入。原生語義操作使用保留的輔助使用元素。應用程式選單僅限所屬程序和確切綁定視窗，關閉選單的內容不會顯示。選單互動可能啟用綁定視窗，並在選單開啟時保持啟用。
macOS/Windows 座標和鍵盤輸入透過確切視窗的前景路徑交付；macOS 在支援時還原先前應用程式。Linux 保持背景交付。座標輸入可能移動系統指標。未驗證的輸入效果會在呼叫輸出中回報。沒有公開的 `delivery_mode` 選項，也不會自動重播。

`nodeRepl.write(value)` 輸出文字/JSON。`await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` 輸出影像。不提供檔案/HTTP 影像 URL、Node、任意檔案系統和網路 API。`cua.rewriteDocumentation()` 重新輸出此參考文件。

Host 啟用輸出音訊後，`await cua.computer.start_audio_recording({max_duration_ms?})` 開始錄音並傳回 undefined，其他呼叫可繼續執行。時長預設 60000 ms，接受 100 到 300000 的整數。`await cua.computer.stop_audio_recording()` 傳回已完成的雙聲道 24 kHz PCM16 WAV 的 `{filepath, bytes, data_url}`。達到時長後停止擷取，再呼叫 stop 取回錄音。`await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` 明確輸出音訊。未啟用音訊時，這些方法不存在。重設和 Session 清理會丟棄錄音及其本機路徑。

每次操作都使用目前 Host 權限；JS 物件不保留授權。Ask 模式下，Computer Use 核准在 REPL 執行逾時計時開始前完成。macOS 原生操作在螢幕鎖定時回報 `desktop_locked`；已連線 CDP 提供者和純 REPL 計算仍可獨立使用。

應用程式、瀏覽器網站和音訊授權等待會暫停剩餘執行預算。macOS/Windows 原生等待也會暫停預算；一般非同步等待和 Linux 原生操作繼續計時。暫停不會重設預算，也不會停用取消。
每個 Session 有獨立的 Maka 游標。輸入操作自動顯示游標。`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` 修改此 Session 的顯示。顏色為 `blue`、`mint`、`violet`、`amber`、`rose`、`cyan`；標籤最多 48 個字元。`cua.cursor.getState()` 回報設定及原生/瀏覽器可見性。處於 `idle` 的原生繪製器在首次原生指示時啟動；`unavailable` 表示顯示主機缺少或失敗。重新設定可重試失敗的繪製器。閒置游標保留至停用或清理。游標不共享輸入權限，也不移動系統指標。多個游標不能隔離實體鍵盤、應用程式焦點或輸入法。
REPL 被取消、逾時或耗盡堆積記憶體後，需要 `cua_reset` 並重新綁定目標。已接納的原生工作會在傳回前結算；重設不會撤銷已派發的輸入。正常 Turn 結束時，目前 Session 會關閉未標記保留的暫時分頁，並釋放頁面觀察；既有的使用者分頁和明確保留的分頁依上述規則保持開啟。重設清除本 Session 的 REPL 和綁定，不授予新權限，也不丟棄該 Session 保留的資源及清理責任。標記或關閉結果未確認時會保留責任，不重播操作。

`agent.browsers` 與 `cua.browsers` 是同一瀏覽器集合；`list`、`get(id)`、`getDefault` 和 `getForUrl(url)` 回傳中繼資料或惰性 Browser，不輸出觀察。`cua.getBrowser` 是輸出說明的便捷入口。`browser.tabs.selected()` 回傳邏輯工作階段選取的分頁；它不選擇作業系統焦點分頁。直接 CDP 尚無邏輯選取服務，回傳 `undefined`。

`await browser.nameSession(name)` 移除兩端空白並保存受管分頁群組名稱；`cua.createBrowserTab(id, url, {sessionName})` 先解析瀏覽器、等待命名成功，再建立分頁。目前公開 profile 不提供 visibility 能力。

`await browser.history({queries, limit, from, to})` 透過實際宣告歷史傳輸能力的擴充功能讀取目前瀏覽器 profile 的歷史。它要求目前權限邊界下針對實際瀏覽器 ID 和 generation 的獨立 `browser_history` 核准；網頁或下載核准不能授權歷史讀取，來源原則亦不會自動核准。預設查詢全部歷史並限制為 100 筆；多查詢結果依造訪時間倒序合併、依 URL 去重後再套用總筆數限制。Maka 擴充功能宣告 Chrome history 權限，舊擴充功能未具備權限時不宣告支援。ChatGPT 與其他第三方介接器仍為盡力支援。

- `await browser.user.getTabContext(tabOrId)` 讀取目前可見使用者分頁的內容，不認領或啟用分頁。Host 對目前實際 URL 授權，呼叫者不能指定替代 URL。隱私分頁和單次讀取前後發生 URL 變更的頁面會被拒絕。結果為 `{kind:'text',text,title,url,truncated}`，或 `{kind:'document',data,fileName,mimeType,title,url}`；`data` 為實際匯出檔案的 `Uint8Array`。Host 提供檔案發布服務時，文件還包含本 Session 持有的真實 `path`。Google Workspace 可提供 Markdown、PDF 或 XLSX，一般頁面可包含目前選取內容，YouTube 影片頁可包含字幕。`maka` 實作固定讀取，`chatgpt` 在支援時重用原版讀取協定；第三方擴充功能依實際能力盡力支援。

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` 在目前頁面執行自包含函式；字串按運算式處理。`locator.evaluate` 向函式傳入 `(element, arg)`，`locator.evaluateAll` 傳入 `(elements, arg)`；單元素形式要求目標明確，集合形式允許零匹配。參數須可 JSON 序列化。結果為一般資料：略過函式和 Symbol，BigInt 轉為字串，非有限數字轉為 `null`。本 API 的結果上限為深度 8、陣列 2000 項、物件 200 個鍵、字串 200000 個 UTF-16 單元，視需要使用 `[MaxDepth]`、`[Circular]` 和 `[Truncated]` 標記。
- 執行環境提供 DOM、CSS、幾何、Range 和 Selection 的唯讀檢視，不開放網路、Cookie、模組載入或 DOM 修改。捲動、局部 Range 邊界和僅接收函式的計時器仍受支援。逾時預設為 3000 ms，數字值限制在 0–3000 ms。停止或中斷時，指令碼可能已經執行；系統不會自動重播。現有網站授權和分頁歸屬繼續生效。

瀏覽器指標方法包括 `tab.cua.move({x,y,keys?})`、
`click({x,y,button?,keypress?})`、`double_click({x,y,keypress?})`、
`drag({path:[{x,y},...],keys?})` 及
`scroll({x,y,scrollX,scrollY,keypress?})`。座標與捲動距離採用 CSS 視埠單位，
保留小數和負數；button 為 1（左鍵）、2（中鍵）或 3（右鍵）。指標修飾鍵為
Alt、Control、Meta、Shift、ControlOrMeta。`keypress({keys:[...]})` 向目前焦點
傳送組合鍵；`type({text})` 使用瀏覽器虛擬剪貼簿貼上，保留已存資料。
文字可含 Markdown，Google Sheets 使用純文字。輸入方法傳回 undefined，不會自動重試結果不明的輸入。

`await tab.dom_cua.get_visible_dom()` 傳回可見互動節點的 HTML 與字串
`node_id`。將原樣 ID 傳給 `click({node_id})`、`double_click({node_id})`。
`scroll({node_id?,x,y})` 的 x/y 為捲動距離，省略 ID 時使用視埠中心。
`keypress({keys:[...]})`、`type({text})` 操作目前焦點。除快照外皆傳回 undefined。
新快照會移除消失的節點綁定；導覽或框架替換會使舊節點失效。應重新觀察，不要猜測 ID
或重播結果不明的輸入。

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# 瀏覽器疑難排解
透過 `cua.getState()` 和 `agent.browsers.list()` 確認可用瀏覽器及其精確 ID。存在連線並不證明某個操作已經成功。繫結失效或結果不確定時，先查看目前狀態再決定下一步；不要自動重複結果不確定的變更操作。
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# 瀏覽器授權
瀏覽器繫結不會保留授權。操作受目前 Session、turn、工作區策略和頁面來源約束。頁面讀取許可不包含檔案傳輸或整個瀏覽器設定檔的歷程記錄。核准被拒絕、Session 關閉或權限邊界改變後，先處理這些狀態再繼續操作。
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# 瀏覽器可見性
透過 `browser.capabilities.list()` 確認所選瀏覽器是否提供可見性能力。可以讀取此名稱的文件，並不表示能力已經啟用。缺少可見性能力時，建立分頁時傳入 `visible` 會在建立前被拒絕。
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Session 命名
`await browser.nameSession(name)` 將去掉首尾空白後的非空名稱用於目前瀏覽器 Session 的群組及後續建立的分頁。`cua.createBrowserTab(id, url, {sessionName})` 會先等待命名完成，再建立分頁；命名失敗時不會建立分頁。
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# 使用者分頁
`browser.user.openTabs()` 傳回使用者分頁的中繼資料，不會認領它們。`browser.user.claimTab(listedTabOrId)` 明確取得選定的精確分頁。`browser.tabs.get(id)` 傳回延遲繫結，不會隱含認領任意使用者分頁。Turn 清理時釋放使用者分頁，不關閉它們。
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# 受管理分頁的生命週期
建立的分頁預設為暫時頁，除非目前生命週期明確保留它們。`markDeliverable()` 為使用者保留完成的結果；`markHandoff()` 為同一 Session 後續繼續操作保留分頁。這些標記不會保留舊頁面權限，也不會授權另一個 Session。關閉、停止和結果不確定的操作仍須完成各自的清理。
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# 瀏覽器後端是否可用
目前 Maka 的提供者包括瀏覽器擴充功能和設定的 CDP 連線，沒有新增內嵌瀏覽器後端。使用目前清單中的 ID 繫結瀏覽器和分頁。讀取內嵌後端或管理能力的參考文件，不會建立該後端，也不提供瀏覽器管理授權。
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# 操作中斷
取消操作並不證明已經派發的操作被復原。原操作結算前，保留其繫結及結果狀態；不要換一個提供者重複變更。重設會清除 REPL 中的繫結，後續操作需要在目前權限下重新繫結目標。
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# 瀏覽器 API 用法
`agent.browsers` 和 `cua.browsers` 是同一個集合。集合呼叫傳回資料或延遲繫結，不自動輸出觀察。`agent.documentation.get(name)` 按精確名稱讀取文件，傳回其文字的 Promise，不自動輸出文字。`tabs.selected()` 跟隨 Session 的邏輯活動分頁。精確瀏覽器 ID 和既有分頁繫結不會切換提供者。
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# 輔助使用觀察
使用元素參照前讀取新的輔助使用狀態。`tab.ax` 提供文件中列出的輔助使用操作，`get(mode, options)` 傳回狀態、螢幕擷取位元組或兩者，不自動輸出。導覽或文件變化可能讓舊參照失效；重新觀察，不猜測元素索引。
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# 選用瀏覽器能力
使用選用能力前，先讀取選定物件的能力集合。文件名稱不會啟用原始 CDP、WebMCP、身分驗證或驗證挑戰處理 API。集合中沒有對應 ID 時，該能力無法使用；既有頁面操作仍受正常權限和生命週期檢查約束。
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# 本機開發頁面
選擇能夠存取目標開發網址的瀏覽器，並導覽至明確的網址。本機主機名稱仍受目前工作區網路策略和頁面來源授權約束。檢查頁面時保留選定瀏覽器的繫結；另一台機器的 localhost 指向不同的目標。
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# 檔案上傳
僅在所選瀏覽器文件提供上傳操作時使用它們。上傳需要目前頁面和所選檔案的獨立許可；頁面讀取或下載許可不等於上傳許可。檔案選擇器歸屬於開啟它的精確頁面互動。頁面或選擇器失效後，重新觀察，不重用舊選擇器。
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# 螢幕擷取
`tab.getScreenshot()` 傳回螢幕擷取位元組；觀察輔助方法可以輸出影像。導覽、調整尺寸或捲動後，重新擷取畫面再決定座標。螢幕擷取只是觀察，不證明先前輸入已送達目標控制項。
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# 檢視區能力
先讀取 `browser.capabilities.list()`，再取得已發布的檢視區能力來調整尺寸。檢視區設定跟隨瀏覽器 Session 的邏輯活動分頁及其目前生命週期。調整檢視區不會選擇無關的系統焦點分頁，也不會授與頁面存取權限。
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# 頁面資源能力
僅在所選分頁發布該能力時使用頁面資源介面。資源清單歸屬於已觀察的頁面和文件。導覽或文件替換後取得新清單；舊資源 ID 不能授權另一頁面的檔案。儲存檔案需要該操作目前的檔案傳輸許可。
<!-- /browser-document -->

### 檔案選擇與上傳

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

先開始等待，再執行開啟檔案選擇器的操作。預設及最長事件等待時間為 3000 毫秒；明確指定的 timeout 必須是正整數。`isMultiple()` 同步回傳。`setFiles(pathOrPaths, {timeoutMs})` 接受單一路徑或非空陣列；單選選擇器拒絕多個路徑。可選 timeout 會驗證，但不會丟棄已派發的檔案選擇請求。

路徑屬於 Agent Host 的檔案系統，仍受呼叫者的工作區檔案原則約束。網頁存取、目前 HTTP(S) 來源的上傳批准、檔案讀取權限彼此獨立。目前輸入快照支援一般檔案。檔案以不可變位元組傳輸，由所選 Maka 瀏覽器宿主實體化；不要自行換算作業系統之間的檔案路徑。

選擇器控制代碼綁定簽發它的分頁、文件及 turn。子 target 的選擇器不受支援。擴充功能選擇器要求完整的事件來源資訊，上傳還要求證實瀏覽器宿主的檔案可見位置。Chatgpt 盡力相容；沒有該位置證明的設定 CDP 會在傳送檔案前拒絕上傳。不會為此把已綁定分頁替換到另一瀏覽器。成功選擇會消耗控制代碼；結果未知時應先處理原請求，不能重播。

若清理回報結果未確認，請勿假定上傳副本已刪除。瀏覽器宿主結束時仍被選取的檔案，目前沒有後續自動回收能力。
