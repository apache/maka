Computer Use 是獨立且持久的 JavaScript REPL，直接呼叫 cua_repl；無需 Code Mode。變數與綁定物件在目前 Host 程序內跨呼叫和 Turn 保留。重新啟動後 REPL 沒有歷史變數；請遵循模型請求提供的目前 Computer Use 狀態。
`cua.computer.target` 識別選定的桌面平台（`mac`、`linux`、`windows`）。WSL 預設選擇 Windows 主機；Shell 命令仍可能在 Linux 中執行。

全新 REPL 沒有綁定目標。以下入口會輸出 API 文件及清單或目標初始狀態。瀏覽器 ID 只來自已設定的提供者；未設定時，透過 getApp 操作原生瀏覽器視窗。API 不提供 start_session 等驅動程式管理操作。

入口（選擇目標時自動輸出初始狀態）：
- `await cua.getState({emit?})`：應用程式和已設定瀏覽器清單，包括清單錯誤。
- `await cua.listApps({emit?})`、`await cua.listWindows({emit?})`。
- `const app = await cua.getApp("Name / bundle ID / app path")` 或 `getApp({windowId})`。
  macOS 會啟動缺少的應用程式。Windows getApp 選擇已開啟的視窗；先使用來自 cua.listApps() 的 ID 呼叫 `await cua.computer.launch_app({app: appId})`，再重新整理清單並選擇確切視窗。啟動前會重新核對原生清單中的 ID，不接受任意可執行檔路徑。名稱有歧義時選擇確切視窗。Linux 要求應用程式已開啟。
- `await cua.listBrowsers({emit?})`、`await cua.listTabs({browser?, emit?})`。
- `const browser = await cua.getBrowser({id? , url?})`：只選擇，不開啟分頁。目標 URL 無需已開啟；設定多個提供者時指定 ID。
- `const tab = await cua.getTab("tab ID", {browser?})` 或 `getTab({url}, {browser?})`。
- `await cua.createBrowserTab(browserId, url?)`：在已設定的設定檔中開啟。這裡和 getBrowser 中未帶 scheme 的 URL 使用 HTTPS。無法使用的提供者、分頁提及和不支援的建立選項會擲出錯誤。
  先建立歸目前 turn 管理的空白頁，再導覽至明確提供的網址。拒絕導覽後，空白頁仍由 turn 結束時清理。
- `await browser.tabs.list()`、`await browser.tabs.get(id)`、`await browser.tabs.new()`：列出、綁定確切分頁或在該瀏覽器建立空白暫時分頁。它們傳回資料而不自動輸出；get/new 傳回 Tab 物件，不進行初始 AX 觀察。使用觀察目標前呼叫 getAXState。`await tab.title()` 和 `await tab.url()` 傳回目前中繼資料，不改變輔助使用觀察。

App 和 Tab 觀察：
- `getAXState({emit?, disableDiffing?})` 傳回文字。分頁和 macOS 應用程式預設傳回差異；Windows 和 Linux 應用程式傳回完整狀態。
- `getScreenshot({emit?})` 傳回 Uint8Array 並輸出影像。
- `getAXStateAndScreenshot(options?)` 傳回 `{state, screenshot?}` 並輸出可用結果。
探索、選擇和觀察會自動輸出結果，直接呼叫即可。用 `nodeRepl.emitImage()` 包裝 `getScreenshot()` 或用 `nodeRepl.write()` 包裝 `getAXState()` 會重複輸出。自行處理結果時使用 `{emit:false}`；清單錯誤仍會顯示。Windows 原生擷取畫面方法在擷取前拒絕 `{emit:false}`。同一次呼叫內相同影像只交付一次；之後的呼叫可以再次輸出相同影像。
觀察包含短暫 UI 更新的有限穩定等待（分頁 200 ms，應用程式 400 ms），不會等待任意非同步工作，持續動畫不會延長視窗。之後的更新需重新觀察。僅擷取畫面後，先讀取 `getAXState()` 再選擇新索引。Linux/Windows 原生觀察會在原元素仍有效時保留已觀察元素的身分。
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

Tab 導覽：`goto(url)`、`back()`、`forward()`、`reload()`、`close()`。導覽支援 HTTP(S) 和 about:blank，並等待可觀察的文件。涵蓋主要 CDP 目標；跨程序 iframe 輔助使用支援尚不完整。

`tab.clipboard` 提供 `read()`、`readText()`、`write(items)`、`writeText(text)`，傳回資料而不自動輸出。
富文字項目包含非空 `entries`；每個項目包含 `mimeType`，以及字串欄位 `text` 或 `base64` 中的一個。
可選 `presentationStyle` 為 `unspecified`、`inline` 或 `attachment`。例如：
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'你好'}]}])`。
使用同一已設定後端上下文的分頁共用這份虛擬資料，不讀取或修改系統剪貼簿。
安裝橋接後，已授權頁面透過 Clipboard API 使用同一份資料。Agent 的 `readText()` 傳回首個
確切 `text/plain` 項目的文字；只有 base64 時傳回空字串，頁面的 `readText()` 則透過 Blob 解碼。
Turn 清理移除頁面橋接並保留資料；重設會建立新的空上下文。

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
瀏覽器座標使用最新擷取畫面，操作後需重新擷取。Linux 視窗區域座標不需先擷取畫面即可使用。Linux/Windows 原生擷取畫面映射在輸入操作後繼續有效，直到下一次觀察取代；僅 AX 觀察會清除影像映射，Windows 此後按座標操作需要重新擷取畫面。視窗幾何變化會使已儲存的映射失效。macOS 目前仍要求在操作後重新擷取畫面再按座標輸入。原生語義操作使用保留的輔助使用元素。應用程式選單僅限所屬程序和確切綁定視窗，關閉選單的內容不會顯示。選單互動可能啟用綁定視窗，並在選單開啟時保持啟用。
macOS/Windows 座標和鍵盤輸入透過確切視窗的前景路徑交付；macOS 在支援時還原先前應用程式。Linux 保持背景交付。座標輸入可能移動系統指標。未驗證的輸入效果會在呼叫輸出中回報。沒有公開的 `delivery_mode` 選項，也不會自動重播。

`nodeRepl.write(value)` 輸出文字/JSON。`await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` 輸出影像。不提供檔案/HTTP 影像 URL、Node、任意檔案系統和網路 API。`cua.rewriteDocumentation()` 重新輸出此參考文件。

Host 啟用輸出音訊後，`await cua.computer.start_audio_recording({max_duration_ms?})` 開始錄音並傳回 undefined，其他呼叫可繼續執行。時長預設 60000 ms，接受 100 到 300000 的整數。`await cua.computer.stop_audio_recording()` 傳回已完成的雙聲道 24 kHz PCM16 WAV 的 `{filepath, bytes, data_url}`。達到時長後停止擷取，再呼叫 stop 取回錄音。`await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` 明確輸出音訊。未啟用音訊時，這些方法不存在。重設和 Session 清理會丟棄錄音及其本機路徑。

每次操作都使用目前 Host 權限；JS 物件不保留授權。Ask 模式下，Computer Use 核准在 REPL 執行逾時計時開始前完成。macOS 原生操作在螢幕鎖定時回報 `desktop_locked`；已連線 CDP 提供者和純 REPL 計算仍可獨立使用。

應用程式、瀏覽器網站和音訊授權等待會暫停剩餘執行預算。macOS/Windows 原生等待也會暫停預算；一般非同步等待和 Linux 原生操作繼續計時。暫停不會重設預算，也不會停用取消。
每個 Session 有獨立的 Maka 游標。輸入操作自動顯示游標。`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` 修改此 Session 的顯示。顏色為 `blue`、`mint`、`violet`、`amber`、`rose`、`cyan`；標籤最多 48 個字元。`cua.cursor.getState()` 回報設定及原生/瀏覽器可見性。處於 `idle` 的原生繪製器在首次原生指示時啟動；`unavailable` 表示顯示主機缺少或失敗。重新設定可重試失敗的繪製器。閒置游標保留至停用或清理。游標不共享輸入權限，也不移動系統指標。多個游標不能隔離實體鍵盤、應用程式焦點或輸入法。
REPL 被取消、逾時或耗盡堆積記憶體後，需要 `cua_reset` 並重新綁定目標。已接納的原生工作會在傳回前結算；重設不會撤銷已派發的輸入。Turn 結束時，目前 Session 會關閉為該 Turn 建立的暫時分頁，並釋放頁面觀察；既有的使用者分頁保持開啟。重設會清除此 Session 的 REPL 和綁定並關閉其暫時分頁，保留使用者應用程式和原有分頁。關閉結果未確認時會保留所有權，不重播關閉操作。
