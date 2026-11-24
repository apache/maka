Computer Use は独立した永続的な JavaScript REPL です。cua_repl を直接呼び出してください。Code Mode は不要です。変数とバインド済みオブジェクトは、現在の Host プロセス内で呼び出しやターンをまたいで保持されます。再起動後の新しい REPL には履歴からの変数は残らないため、モデルリクエストで提供される現在の Computer Use 状態に従ってください。
ウェブサイトを操作する場合は、まず `await cua.listBrowsers()` を呼び出し、ネイティブのブラウザーウィンドウ入力よりも先にブラウザーのタブを使用してください。インストール済みの ChatGPT 接続は、シェルでのセットアップや ChatGPT デスクトップアプリの起動なしでオンデマンドに引き継ぐことができます。
トップレベルの `await` を使用し、トップレベルの `return` は使用しないでください。この REPL は宣言を保持するため、既存のバインディングを再利用するか新しい変数名を使用してください。Node API や `setTimeout` は利用できません。

`cua.computer.target` は選択されたデスクトッププラットフォーム（`mac`、`linux`、`windows`）を識別します。WSL ではデフォルトで Windows ホストが選択されますが、シェルコマンドは引き続き Linux 上で実行される場合があります。

`cua.computer` はプラットフォームネイティブの snake_case メソッドも公開しています。これらは後述の App/Tab の位置引数ではなくオプションオブジェクトを受け取ります。`list_apps()`、`list_windows()`、および Linux の `get_screenshot()` はオプション不要です。まず選択されたサーフェスを探索し、一覧を読み取ってください。
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | ネイティブメソッド（音声は別途記載） |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: 返された `window` オブジェクトを使って `get_window_state({window, query?, include_screenshot?})` を呼び出します。観察済みの `element_id` **または**整数 `x,y` を `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})` に渡します。`window` を指定すると座標はウィンドウ基準になり、省略するとデスクトップ基準になります。その他の入力には `type_text({window?, text, element_id?})`、`press_key({window?, key, duration?})`、`scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`、`drag({window?, path:[{x,y},…], key?})`、`move({window?, x,y,key?})`、`move_relative({dx,dy,key?})`、`activate_window({window})`、`perform_secondary_action({window,element_id,action})`、`launch_app({app})` があります。`duration` の単位はミリ秒です。`drag_handle()` は `start({x,y})`、`move_to({x,y})`、`end()` を持つデスクトップ用ドラッグハンドルを作成します。必ず同一ターン内で明示的に終了してください。
- Windows: 返された `{app,id,...}` ウィンドウ記述子を使用します。インデックス入力やスクリーンショット入力を行う前に `get_window_state({window, include_text?, include_screenshot?})` を読み取ってください。デフォルトではスクリーンショットが有効、テキストは無効です。`click({window,element_index})` または `click({window,x,y,screenshotId?})`、`scroll({window,x,y,scrollX,scrollY,screenshotId?})`、`drag({window,from_x,from_y,to_x,to_y,screenshotId?})`、`press_key({window,key})`、`type_text({window,text})`、`set_value({window,element_index,value})`、`perform_secondary_action({window,element_index,action})`、`activate_window({window})`、`get_window({id})`、`launch_app({app})` を使用します。返されたスクリーンショットの `id` を `screenshotId` に指定すると画像座標が使用されます。省略するとウィンドウ内の整数ローカル座標となり、直近に観察されたスクリーンショットの寸法（スクリーンショット未観察の場合はウィンドウ寸法）が基準になります。スクロールは 1 回の呼び出しで `scrollX` と `scrollY` の両方を指定できます。セカンダリアクションは現在 Expand/Collapse のみ対応しており、他のラベルは拒否されます。
- macOS: 返されたアプリの `id` を `app` として使用します。まず `get_app_state({app})` を読み取り、その後に `click({app,element_index,mouse_button?,click_count?})` または `click({app,x,y,mouse_button?,click_count?})`、`drag({app,from_x,from_y,to_x,to_y})`、`scroll({app,element_index,direction,pages?})`（`x,y` も可）、`press_key({app,key})`、`type_text({app,text})`、`paste({app,text,format:'text'})`、`set_value({app,element_index,value})`、`select_text({app,element_index,text,prefix?,suffix?,selection_type?})`、`perform_secondary_action({app,element_index,action})` を呼び出します。

ネイティブの一覧と状態の構造はプラットフォームごとに異なります。App ラッパーのハンドルではなく、返された ID やセレクターを再利用してください。Linux の状態は `ax_tree` と `screenshots` を返し、スクリーンショット項目には `filepath`、`bytes`、`data_url` が含まれます。Windows の状態はスクリーンショット画像を自動出力します。その他のネイティブ結果は `nodeRepl.write`/`emitImage` 用に返され、変更メソッドは undefined を返します。現在の Host およびアプリ権限は引き続き適用され、メソッドが存在していても利用不可のバックエンドや未対応の操作は拒否されることがあります。stale-target エラー後は状態を更新し、結果が不明な入力は再実行しないでください。進行中のドラッグをターン間で持ち越さず、リセット後は観察結果を再取得してください。

新しい REPL にはバインド済みターゲットがありません。以下のエントリーポイントは API ドキュメントと一覧またはターゲットの初期状態を出力します。ブラウザー ID は設定済みの CDP プロバイダーおよび接続済みの Extension ブラウザープロバイダーから取得されます。正確な ID が優先され、完全一致がない場合に限り `maka` と `chatgpt` が現在利用可能な単一の Extension エンドポイントを選択します。どちらも利用できない場合は、getApp を通じてネイティブのブラウザーウィンドウを使用してください。API は start_session などのドライバー管理操作を公開していません。

元のネイティブホスト登録を保持したインストール済みの ChatGPT 拡張機能は、Chrome または Chromium で自動検出されます。`listBrowsers()` では `on_demand` として報告され、選択すると制御を引き継ぎ、`browser.release()` またはターンクリーンアップ時に元のホストへ戻します。セットアップコマンド、デバッグポート、ChatGPT デスクトップアプリの起動は不要です。ウェブサイト操作では、ネイティブのブラウザーウィンドウ入力よりも先にこのブラウザー接続を優先してください。

ChatGPT の互換性はベストエフォートです。正確な ID や既存のハンドルが別のプロバイダーへ切り替わることはありません。

エントリーポイント（選択時に初期状態を自動出力）:
- `await cua.getState({emit?})`: アプリおよび利用可能なブラウザーの一覧（一覧取得エラーを含む）。
- `await cua.listApps({emit?})`、`await cua.listWindows({pid?, emit?})`。
  macOS で観察済みのアプリ PID を渡すと、そのアプリのフローティングパネルも含まれます。
  ウィンドウ項目には `pid` と `bindable` が含まれます。`bindable: true` のウィンドウを選択してください。
  バインド不可の項目には `bindingError` が含まれます。macOS のバインド可能な項目には `applicationId` と `appPath` も含まれます。バインド時にはアプリの承認と現在のウィンドウ実体が確認されます。
- `const app = await cua.getApp("Name / bundle ID / app path")` または `getApp({windowId})`。
  macOS では未起動のアプリを起動します。Windows の getApp はすでに開いているウィンドウを選択します。未起動の場合は cua.listApps() の ID を使って `await cua.computer.launch_app({app: appId})` を呼び出し、一覧を更新してから正確なウィンドウを選択してください。名前が曖昧な場合は正確なウィンドウを指定してください。Linux ではアプリがすでに開いている必要があります。
- `await cua.listBrowsers({emit?})`、`await cua.listTabs({browser?, emit?})`。
- `const browser = await cua.getBrowser({id? , url?})`: タブを開かずに選択のみ行います。対象 URL はすでに開いている必要はありません。複数のプロバイダーが利用可能な場合は ID を指定してください。
- `const tab = await cua.getTab("tab ID", {browser?})` または `getTab({url}, {browser?})`。
- `await cua.createBrowserTab(browserId, url?)`: 選択したプロバイダーのプロファイル内でタブを開きます。ここおよび getBrowser では、スキームなしの URL に HTTPS が適用されます。
  作成時はまずこのターンが所有する空のタブを開き、明示的な URL が指定されている場合にナビゲーションを要求します。ナビゲーションが拒否された場合、その空のタブはターンクリーンアップの対象として残ります。利用不可のプロバイダー、タブメンション、未対応の作成オプションはエラーを投げます。
- `await browser.tabs.list()`、`await browser.tabs.get(id)`、`await browser.tabs.new()`: そのブラウザーで一覧取得、正確なタブのバインド、または空の一時タブの作成を行います。これらのメソッドは自動出力せずにデータを返します。get/new は初期 AX 観察を行わずに Tab オブジェクトを返します。観察対象を使う前に getAXState を呼び出してください。`await tab.title()` と `await tab.url()` はアクセシビリティ観察を変更せずに現在のメタデータを返します。

- 接続済みのブラウザーアダプターは `await browser.user.openTabs()` と `await browser.user.claimTab(tabOrId)` も公開しています。前者は現在のユーザータブのメタデータを返し、後者は現在の権限確認と接続準備の後に通常の Tab を返します。一覧にある文字列 ID またはオブジェクトを渡してください。ターンクリーンアップ時はユーザータブを閉じずに解放しますが、このセッションで作成されたタブは引き続き一時タブとして扱われます。`browser.tabs.get(id)` は遅延バインドのままであり、初期取得や AX 観察を行いません。これらのメソッドは許可を保持しません。Extension プロバイダーでは、`browser.tabs.list()` はこのセッションが管理するタブを一覧表示します。設定済みの CDP プロバイダーには `browser.user` がないため、代わりに `browser.tabs` メソッドを使用してください。

Maka は AX ブラウザープロファイルを公開しています。`tab.ax` には `get`、`write`、`click`、`drag`、`paste`、`performSecondaryAction`、`pressKey`、`scroll`、`selectText`、`setValue`、`typeText` が含まれます。操作シグネチャは後述の Tab メソッドと同じです。`await tab.ax.get(mode = 'state', {disableDiffing?})` は `state`、`screenshot`、`both` モードに応じてテキスト、画像バイト列、または `{state, screenshot?}` を自動出力せずに返します。`await tab.ax.write(mode = 'state', options?)` は利用可能な結果を出力し、undefined を返します。既存のフラットな Tab メソッドも引き続き利用可能です。AX ファサードとフラットなメソッドは同じバインド済み Tab に作用します。

App および Tab の観察:
- `getAXState({emit?, disableDiffing?})` はテキストを返します。タブと macOS アプリはデフォルトで差分を返し、Windows と Linux アプリは完全な状態を返します。
- `getScreenshot({emit?})` は Uint8Array を返し、画像を出力します。
- `getAXStateAndScreenshot(options?)` は `{state, screenshot?}` を返し、利用可能な結果を出力します。
探索、選択、観察は自動的に出力されるため直接呼び出してください。`getScreenshot()` を `nodeRepl.emitImage()` で包んだり、`getAXState()` を `nodeRepl.write()` で包んだりすると重複出力になります。結果を自分で処理する場合は `{emit:false}` を指定してください（一覧取得エラーは引き続き表示されます）。Windows のネイティブスクリーンショットメソッドは撮影前に `{emit:false}` を拒否します。1 回の呼び出し内で同一の画像が複数回出力された場合は 1 回のみ配信されますが、後の呼び出しでは同じ画像を再度出力できます。
観察には短時間の UI 更新を待つ上限付きの安定化待機（タブは 200 ms、アプリは 400 ms）が含まれます。これは任意の非同期処理を待つものではなく、継続的なアニメーションによって待機時間が延長されることもありません。その後の更新を確認するには再観察してください。変更されていない同一のブラウザードキュメントでのスクリーンショット成功時は既存の AX 参照が保持されます。ナビゲーション、ドキュメント置換、ターゲット無効化の後は、インデックスを再利用する前に `getAXState()` を更新してください。新たに観察する要素についても更新が必要です。ネイティブ Linux/Windows は、元の要素が有効な間、以前観察した要素の識別性を保持します。
アプリがビジー状態でネイティブ AX 観察が失敗した場合は、アプリが応答するようになってから同じバインド済みオブジェクトを更新してください。失敗した観察は古いインデックスと座標を無効にします。

App および Tab の操作:
- `await app.bringToFront()` はバインド済みの正確なネイティブウィンドウを最前面に表示し、フォアグラウンド状態を維持します。キー入力やポインター入力は送信せず、デスクトップがアクティブ化を確認できない場合は結果不明として報告します。
- `click(index | [x,y], {mouseButton?, clickCount?})`、`drag([x,y], [x,y])`。
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`。
- ネイティブアプリはマウスボタン `l/r/m` と方向 `u/d/l/r` も受け付けます。macOS では前後の空白を取り除き大文字小文字を区別せず、左・右・中ボタンとして `0/1/2` も受け付けます。
- `setValue(index, string)`: ネイティブ Linux アプリでは利用できません。
- `selectText(index, text, {prefix?, suffix?, selectionType?})`: selectionType は `text`、`cursor_before`、または `cursor_after` です。ネイティブ選択は macOS 専用です。`text_not_found` はテキストまたは指定されたコンテキストが存在しないことを意味するため、現在の状態を再取得してください。`ambiguous_text` の場合はより具体的な prefix/suffix が必要です。
- `performSecondaryAction(index, action)`: ネイティブ AX 観察に列挙された正確なアクション名を使用します。CDP はセカンダリアクションを公開していないため、このメソッドを拒否します。

App 入力: `typeText(text)`、`paste(text, {format?})`、`pressKey(key)`。
Tab 入力: `typeText(index|null, text)`、`paste(index|null, text, {format?})`、`pressKey(index|null, key)`。インデックスを指定するとまず観察済みフィールドにフォーカスし、`null` は現在のフォーカスを使用します。キーの例: `Return`、`Tab`、`super+a`、`shift+Left`。
貼り付け形式: `text`（デフォルト）、`md`（Markdown ソースをプレーンテキストとして扱う）、`html`。ネイティブ Linux および Windows アプリは `text` のみ対応しています。ネイティブ HTML 貼り付けは macOS 専用で、読み取り可能な編集対象の値と選択範囲が必要です。対象ウィンドウを一時的にアクティブ化し、選択範囲を保持したまま貼り付け、ユーザーがより新しい内容をコピーしていない限り元のクリップボードを復元します。値が変化しなかった場合は不確定として報告されます。ブラウザーでの HTML 貼り付けには観察済みの contenteditable 要素が必要です。

Tab ナビゲーション: `goto(url)`、`back()`、`forward()`、`reload()`、`close()`。
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` は画像を自動出力せず JPEG バイト列を返します。`clip` を省略するとビューポート、`fullPage: true` でドキュメント全体を撮影します。clip の幅と高さは正の数である必要があり、座標と寸法には CSS ピクセルを使用します。ビューポート撮影はまず新しいスクリーンキャストフレームを試行し、クリーンアップ確認後に同じタブのスクリーンショットコマンドへフォールバックします。不確定な操作は再実行されません。

Extension プロバイダーでは、`await tab.markDeliverable()` は通常のターン終了時にタブを開いたまま保持し、ユーザーへ引き渡します。`await tab.markHandoff()` は同一セッション内でタブを保持し、次の実際のターンでマークを外した状態で再開します。元の agent/user 由来は維持されるため、エージェントが作成したタブは後続のマークなしターン終了時に閉じられます。後の明示的なマークは以前のマークを上書きします。どちらのメソッドも対応する意図 ACK を受け取った後に undefined を返しますが、物理的な引き渡しやクリーンアップの成功を証明するものではありません。マークはサイト権限を保持せず、不確定な呼び出しは再実行されません。直接 CDP ではこれらのマークはサポートされていません。

`tab.clipboard` は `read()`、`readText()`、`write(items)`、`writeText(text)` を提供し、値を自動出力せずに返します。リッチアイテムには空でない `entries` が必要で、各エントリーは `mimeType` と、`text` または `base64` のどちらか一方の文字列フィールドを持ちます。任意の `presentationStyle` は `unspecified`、`inline`、または `attachment` です。例:
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`。
この仮想データは同じ設定済みバックエンドコンテキストを使うタブ間で共有され、OS のクリップボードを読み書きしません。ブリッジ導入後、認可されたページは Clipboard API を通じて同じデータを使用します。エージェントの `readText()` は最初の厳密な `text/plain` エントリーのテキストを返し、base64 のみのエントリーには空文字列を返します。ページ側の `readText()` は Blob を通じてそのエントリーをデコードします。ターンクリーンアップはページブリッジを削除して保存データを保持し、リセットは新しい空のコンテキストを作成します。

待機メソッドは undefined を返します。`locator.waitFor({state, timeoutMs?})` は `state: 'attached'|'detached'|'visible'|'hidden'` を必須とし、最初の一致要素を検査します。一致要素がない場合、`detached` と `hidden` は成功します。
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` は完全な URL に一致させます。`*` は `/` をまたがず、`**` は `/` をまたぐことができ、その他の文字はリテラル一致です。`waitUntil` のデフォルトは `commit` で、`load`、`domcontentloaded`、`networkidle` を指定すると URL 一致後にその状態まで待機します。
`tab.playwright.waitForLoadState({state?, timeoutMs?})` のデフォルトは `load` で、`domcontentloaded` と `networkidle` も指定できます。これらの条件待機のデフォルトは 3000 ms で、より長い明示的なタイムアウトも尊重されます。0 を指定するとイベント待機の余裕は残りません（ロケーターは初回プローブのみ実行され、現在の URL/読み込み状態がすでに一致していれば成功し、networkidle はタイムアウトします）。`tab.playwright.waitForTimeout(ms)` は非負整数を受け取り、固定時間待機します。操作によって引き起こされる待機では、操作の前に待機を開始してから両方の promise を await してください。Stop は元の待機をキャンセルします。

`tab.playwright` は事前の AX 観察を必要とせず DOM ロケーターを直接解決します。`locator(selector)`、`getByRole`、`getByText`、`getByLabel`、`getByPlaceholder`、または `getByTestId` を使用し、`frameLocator(selector)` でフレーム内に入ります。ロケーターは `first/last/nth`、`filter`、`and/or`、`count`、`all`、`allTextContents`、`textContent`、`innerText`、`getAttribute`、`isEnabled`、`isVisible` をサポートします。`domSnapshot()` はページの DOM アクセシビリティテキストを返します。

ロケーター入力メソッドは undefined を返します: `click(options?)`、`dblclick(options?)`、`fill(text, options?)`、`type(text, options?)`、`press(key, options?)`、`pressSequentially(text, options?)`、`selectOption(valueOrValues, options?)`、`setChecked(boolean, options?)`、`check(options?)`、`uncheck(options?)`。
クリックオプションは `button: 'left'|'right'|'middle'`、`modifiers`、`force`、`timeoutMs` を、チェックオプションは `force` と `timeoutMs` を受け付けます。修飾キーは `Alt`、`Control`、`ControlOrMeta`、`Meta`、`Shift` で、`ControlOrMeta` は選択されたブラウザーのプラットフォームに従います。その他の入力オプションは `timeoutMs` を受け付けます。タイムアウトは正の整数で、準備段階のデフォルトは 3000 ms、より長い明示的タイムアウトも尊重されます。選択肢の選択は value 文字列、または `value`・`label`・非負整数 `index` を持つ記述子オブジェクトを受け付け、配列で複数選択できます。

ロケーターの変更操作は単一の一致、または複数一致のうち唯一表示されている要素を対象とします。曖昧な一致はエラーになります。通常のテキスト fill/type は仮想貼り付けイベントを送信し、ページ側ハンドラーによるキャンセルを尊重しつつ、保存済みクリップボードを保持します。空の貼り付けはデフォルトで値を消去しません。クリップボードのキーボードショートカットも同じ仮想クリップボードを使用し、未対応の組み合わせはネイティブキー送信前にエラーになります。書き込みが成功すると、呼び出し元ロケーターコレクションのキャッシュ済み読み取りのみクリアされます。入力結果は引き続きページ上で確認する必要があり、不確定な結果が自動的に再実行されることはありません。

ダウンロードには、ダウンロード通知を提供する接続済み Extension プロバイダーと、現在の Host のダウンロード権限が必要です。同じ Tab 上でトリガー操作の前に待機を準備します:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
その後クリックやナビゲーションを実行し、`const download = await pending` とします。
`await download.path({timeoutMs?})` はブラウザーが報告したファイル名または null を返します。ファイルを転送するものでも、そのパスがこのタスクに属することを証明するものでもなく、別ホスト上のパス・空・利用不可の場合があります。saveAs 操作はありません。
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` は一意に一致するロケーターのメディアを要求します。ダウンロード待機は自動出力せずにデータを返し、メディアトリガーは undefined を返します。ネイティブの開始期限は最初に一致した Started イベントで終了し、その後もキャンセルと Host クリーンアップが適用されます。
読み取り権限とダウンロード権限は別個に扱われ、送信元または送信先のオリジンが異なる場合も同様です。設定済みの CDP 接続だけではネイティブのダウンロード通知は提供されません。
Maka は限定的な拡張として `tab.cua.downloadMedia({x,y,timeoutMs?})` と `tab.dom_cua.downloadMedia({node_id,timeoutMs?})` も公開していますが、選択された Extension プロバイダーは現在これらの座標・ノードメディアコマンドを拒否するため、実装済みのロケーター経路を使用してください。不確定なダウンロード結果が自動的に再試行されることはありません。
返されたハンドルは元の Tab バインディングを保持しますが、権限許可は保持しません。タブを利用可能な状態に保ってください。`path()` はキャッシュ参照前に現在のタブメタデータと Host 権限を再確認します。古いハンドルで閉じられたタブを維持することはできません。後続のターンでも現在のタブアクセス権限が必要であり、タブの再取得が必要になる場合があります。

`await tab.getJsDialog()` は undefined、または `type` と `dismiss()` を持つ現在のダイアログオブジェクトを返します。confirm ダイアログには `accept()`、prompt ダイアログには `accept(text)`（空文字列可）もあります。古いダイアログオブジェクトで置き換わった新しいダイアログを操作することはできません。通常のページ読み取りや入力を行う前に、アクティブなダイアログを処理してください。`getAXState()` はメッセージとインデックス付きコントロールを表示し、prompt コントロールは `setValue`、`typeText`、Return/Escape をサポートします。ダイアログのコントロールにはページ座標がありません。ダイアログが開いている間はスクリーンショットを取得できず、スクリーンショット単体の呼び出しはエラーとなり、複合観察は screenshot プロパティなしでダイアログ状態のみを返します。接続済みのブラウザー Host は現在の制御権を持つ間 beforeunload ダイアログを自動承認します。ターンクリーンアップはユーザータブを閉じずに制御を切り離します。

ナビゲーションは HTTP(S) と about:blank に対応し、観察可能なドキュメントを待機します。メインの CDP ターゲットはカバーされますが、クロスプロセス iframe のアクセシビリティ対応は完全ではありません。
CDP のページ距離は小数、0、負の数を含む有限数を受け付けます。1 ページは対象コンテンツの幅または高さ（最小 100 CSS ピクセル）を使用し、座標ターゲットではビューポートを使用します。CDP の `{pixels:n}` 拡張は正の有限ピクセル差分を受け付けます。
Linux は数値のページ数を拒否します。Linux X11 はデフォルトで `{pixels:800}` を使用し、1 から 65535 の整数ピクセル距離を受け付け、`max(round(pixels/100),1)` 回のホイールステップを送信します。実際のコンテンツ移動量はアプリ側で決まります。Linux Wayland は現在ピクセル入力を拒否します。
macOS のスクロールは正の有限数値ページ数（デフォルト 1）を受け付け、`{pixels}` を拒否します。小数ページ数に対応しています。
Windows は座標点と正の有限距離 `{pixels:500}` を必須とし、距離の省略と数値ページ数を拒否します。座標と方向符号付き距離には JavaScript の `Math.round` が使われ、丸め後の値は符号付き 32 ビット整数に収まる必要があります。ネイティブホイールの各軸差分は [-32768,32767] に制限され、ポインターは対象位置にとどまります。コンテンツ移動量はアプリ側で決まります。ネイティブのインデックススクロールは選択されたアクセシビリティ対象を保持します。App ラッパーのネイティブインデックスクリックは 1 回のセマンティッククリックに対応しており、複数回クリックにはスクリーンショット座標を使用してください。macOS の生 API `cua.computer.click` は、シミュレートされたマウスイベントによる複数回のインデックスクリックにも対応しています。

入力の送信成功は、結果としてのアプリ状態を保証するものではありません。
ブラウザーの座標操作は CSS ビューポート座標を使用し、事前のスクリーンショットは不要です。スクリーンショットによって座標がスケーリングされることはありません。
Linux のウィンドウローカル座標はスクリーンショットを撮らずに使用できます。ネイティブ Linux/Windows のスクリーンショットマッピングは別の観察で置き換えられるまで入力操作後も維持されますが、AX のみの観察で画像マッピングはクリアされ、Windows の座標入力には再度スクリーンショットが必要になります。ウィンドウジオメトリが変化すると保存済みマッピングは無効になります。macOS の座標入力は現在、操作のたびに新しいスクリーンショットを必要とします。
ネイティブのセマンティック操作は保持されたアクセシビリティ要素を使用します。アプリメニューは所有プロセスと正確にバインドされたウィンドウに限定され、閉じているメニューの内容は開くまで省略されます。メニュー操作はバインドされたウィンドウをアクティブ化することがあり、メニューが開いている間アクティブ状態を維持します。
ネイティブの座標入力とキーボード入力は、デフォルトでバインドされた正確なウィンドウへのバックグラウンド配信を行います。バックグラウンド配信に非対応の場合は理由が報告され、フォアグラウンドへ自動的に再送されることはありません。未検証の操作はすでに配信されている可能性があります。ウェブサイトではデスクトップのフォーカスやポインター入力を避けるため、ブラウザー Tab 操作を優先してください。ネイティブのテキスト入力では `typeText` または `setValue` を優先してください。macOS の `paste` はシステムクリップボードとフォアグラウンドのキーボード入力を使用し、ネイティブメニューもウィンドウをアクティブ化する場合があります。一部の座標経路はシステムポインターを移動する可能性があり、実際の経路は配信メタデータで報告されます。必要な場合はネイティブの `app.pressKey(key, {deliveryMode:"foreground"})` または `app.typeText(text, {deliveryMode:"foreground"})` で明示的にフォアグラウンド配信を要求できます（デフォルトは `"background"`）。未検証の入力を自動で再試行したり、黙ってモードを切り替えたりしないでください。

`nodeRepl.write(value)` はテキスト/JSON を出力します。`await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` は画像を出力します。ファイル/HTTP 画像 URL、Node、任意のファイルシステムおよびネットワーク API は利用できません。`cua.rewriteDocumentation()` はこのリファレンスを再出力します。

Host で出力音声が有効になっている場合、`await cua.computer.start_audio_recording({max_duration_ms?})` は録音を開始して undefined を返し、他の呼び出しを継続できます。録音時間のデフォルトは 60000 ms で、100 から 300000 の整数を受け付けます。`await cua.computer.stop_audio_recording()` は確定したステレオ 24 kHz PCM16 WAV の `{filepath, bytes, data_url}` を返します。上限時間に達するとキャプチャが終了するため、stop を呼び出して取得してください。`await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` で音声を明示的に出力します。音声が無効な場合、これらのメソッドは存在しません。リセットおよびセッションクリーンアップ時に録音データとそのローカルパスは破棄されます。

すべての操作は現在の Host 権限を使用し、JS オブジェクトは許可を保持しません。セッションサンドボックスがオフの場合、Computer Use、アプリ、ブラウザーサイト、履歴、ファイル転送、および音声に追加の Maka 承認は不要ですが、権限変更や実行中操作の停止は引き続き有効です。
Ask モードでは、Computer Use の承認は REPL 実行タイムアウトの計測開始前に行われます。
アプリ、ブラウザーサイト、および音声の同意待機中は残り実行予算が一時停止されます。ネイティブ macOS/Windows の待機でも一時停止されますが、通常の非同期待機や Linux ネイティブ操作は予算を消費します。一時停止によって予算が補充されたり、キャンセルが無効になったりすることはありません。
ネイティブ macOS 操作は画面ロック中に `desktop_locked` を報告します。接続済みの CDP プロバイダーと純粋な REPL 計算は独立して引き続き利用可能です。
各セッションは独自の Maka カーソルを持ち、入力操作時に自動表示されます。`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` でこのセッションの表示を変更できます。色は `blue`、`mint`、`violet`、`amber`、`rose`、`cyan` で、ラベルは最大 48 文字です。`cua.cursor.getState()` は設定およびネイティブ/ブラウザーの可視性を報告します。`idle` 状態のネイティブレンダラーは最初のネイティブ指示時に起動し、`unavailable` はディスプレイホストの欠如または失敗を示します。失敗したレンダラーを再試行するには再度設定してください。カーソルはセッションに属しますが、ターン終了後も画面に残り続けることはありません。ターン中は表示され、ターン終了時に非表示になり、次の入力操作時に再び表示されます。カーソルは入力権限を共有せず、システムポインターも移動しません。複数のカーソルは物理キーボード、アプリフォーカス、または入力メソッドを分離しません。
キャンセル、タイムアウト、またはヒープ枯渇が発生した REPL では `cua_reset` とターゲットの再バインドが必要です。受付済みのネイティブ処理は戻る前に完了し、リセットによって送信済みの入力が取り消されることはありません。
通常のターン終了時、このセッションは自身が作成し保持マークを付けていない一時タブを閉じ、ページ観察を解放します。既存のユーザータブと保持マーク付きタブは上記のルールに従って開いたまま維持されます。リセットはこのセッションの REPL とバインディングをクリアしますが、新しいアクセス権を付与したり、このセッションが保持するリソースやクリーンアップ責務を消去したりすることはありません。未確認のマークやクローズは管理責任を保持したままとなり、再実行されません。

`agent.browsers` と `cua.browsers` は同一のブラウザーコレクションです。`list`、`get(id)`、`getDefault`、`getForUrl(url)` メソッドは観察結果を自動出力せずにメタデータまたは遅延 Browser オブジェクトを返します。`cua.getBrowser` はドキュメントを出力する便利なエントリーポイントです。Browser は論理セッションのアクティブタブを返す `tabs.selected()` を公開していますが、OS でフォーカスされているタブを選択するものではありません。現在の直接 CDP プロバイダーには論理セッションのアクティブタブ機能がないため、`selected()` は `undefined` を返します。

`await browser.release()` はこのセッションのオンデマンド ChatGPT ブラウザーリースを返却します。ホスト解放前にこのターンの一時タブと物理制御リソースを整理し、保持対象ページは開いたままにします。他のセッションは各自のリースを維持し、最後の解放時に元のネイティブホストへ復元されます。再使用する前に `cua.getBrowser({id: "chatgpt"})` で再取得してください。終了したホスト世代のハンドルは新しいアタッチが必要です。通常のターンクリーンアップでもリースは返却されます。長時間稼働するエージェントはスリープ前に明示的に解放してください。他のブラウザープロバイダーはこの操作をサポートしていません。

`await browser.nameSession(name)` は前後の空白を取り除いてセッションの管理タブグループタイトルを保存します。既存の管理表示は所有レシートを通じて更新され、以降に作成されるタブは保存されたタイトルを使用します。`cua.createBrowserTab(id, url, {sessionName})` はタブを作成する前にブラウザーを解決し、命名の完了を待機します。現在のブラウザープロファイルは visibility 機能を提供していません。

`await browser.history({queries, limit, from, to})` は、独立した履歴トランスポートを宣言する拡張機能を通じてプロファイル全体の履歴を読み取ります。サンドボックス有効時は、現在のセッション権限境界の下で、実際のブラウザー ID と generation に対する独立した `browser_history` の同意が必要です。ページ権限やダウンロード権限では許可されず、ページオリジンポリシーによって履歴リクエストが自動承認されることもありません。デフォルトは全履歴を対象とした上限 100 件のクエリで、指定されたクエリ結果は訪問日時の降順で統合され、URL ごとに重複排除された上で上限が適用されます。同梱の Maka 拡張機能は Chrome の history 権限を宣言していますが、その権限を持たない古いインストール済み拡張機能は履歴サポートを宣言しません。ChatGPT やその他のサードパーティ製アダプターはベストエフォート対応です。

- `await browser.user.getTabContext(tabOrId)` は、現在表示中のユーザータブを取得・フォーカスせずにそのコンテキストを読み取ります。現在のタブ URL は Host によって認可され、呼び出し元が代替 URL を指定することはできません。プライベートタブや単一読み取り中に URL が変化したページは拒否されます。結果は `{kind:'text',text,title,url,truncated}`、または `{kind:'document',data,fileName,mimeType,title,url}` のいずれかで、`data` は実際にエクスポートされたファイルを含む `Uint8Array` です。Host がファイル公開機能を提供している場合、ドキュメントにはこのセッションが所有する実際の `path` も含まれます。Google Workspace ドキュメントでは Markdown、PDF、または XLSX コンテキストを、通常のページでは現在の選択範囲を、YouTube 視聴ページでは文字起こしを提供できます。`maka` プロバイダーは固定の読み取りを実装し、`chatgpt` は対応時に標準の読み取りプロトコルを再利用します。サードパーティ対応はベストエフォートです。

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` は現在のページ上で自己完結した関数を実行します。文字列は式として扱われます。ロケーター版では `locator.evaluate` に `(element, arg)`、`locator.evaluateAll` に `(elements, arg)` が渡されます。単一要素版は曖昧さのない対象を必要とし、全要素版は 0 件一致を許容します。引数は JSON シリアライズ可能である必要があります。結果はプレーンデータとなり、関数と Symbol は省略され、BigInt は文字列に、非有限数は `null` に変換されます。この API は結果の深さを 8、配列を 2000 要素、オブジェクトを 200 キー、文字列を 200000 UTF-16 単位までに制限し、必要に応じて `[MaxDepth]`、`[Circular]`、`[Truncated]` マーカーを使用します。
- 評価環境は DOM、CSS、ジオメトリ、Range、Selection の読み取り専用ビューを公開し、ネットワーク、Cookie、モジュール読み込み、DOM 編集は公開しません。スクロール、ローカルな Range 境界、関数のみを受け取るタイマーは引き続きサポートされます。タイムアウトのデフォルトは 3000 ms で、明示的な値で待機時間を設定できます。停止または中断されたスクリプトはすでに実行されている可能性があり、自動的に再実行されることはありません。既存のサイト権限とタブ所有権は引き続き適用されます。

ブラウザーのポインター入力は `tab.cua.move({x,y,keys?})`、`click({x,y,button?,keypress?})`、`double_click({x,y,keypress?})`、`drag({path:[{x,y},...],keys?})`、`scroll({x,y,scrollX,scrollY,keypress?})` で利用できます。座標と距離は CSS ビューポート数値で、小数と負の値が保持されます。button は 1（左）、2（中）、3（右）です。ポインター修飾キー名は Alt、Control、Meta、Shift、ControlOrMeta です。`tab.cua.keypress({keys:[...]})` は現在のフォーカスへキーの組み合わせを送信し、`tab.cua.type({text})` は保存済みクリップボードデータを保持しながらブラウザーの仮想クリップボード経由で現在のフォーカスへテキストを貼り付けます。テキストには Markdown を含めることができ、Google Sheets はプレーンテキストを受け取ります。これらの入力メソッドは undefined を返し、不確定な入力を再試行しません。

`await tab.dom_cua.get_visible_dom()` は表示中のインタラクティブな HTML と文字列の `node_id` 値を返します。その正確な文字列を `click({node_id})` または `double_click({node_id})` に使用してください。`scroll({node_id?,x,y})` はスクロール距離を受け取り、node_id を省略するとビューポート中央を使用します。`keypress({keys:[...]})` と `type({text})` はノード ID ではなく現在のフォーカスを使用します。スナップショット以外の DOM メソッドは undefined を返します。新しいスナップショットは消えた DOM ノードを無効化し、ナビゲーションやフレーム置換でもノードが古くなることがあります。ID を推測したり結果不明の入力を再実行したりせず、再度観察してください。

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# ブラウザーのトラブルシューティング
`cua.getState()` と `agent.browsers.list()` を読み取り、利用可能なブラウザーとその正確な ID を特定してください。設定済みの接続があることは、特定の操作が成功した証拠にはなりません。バインディングが古くなった場合や結果が不明な場合は、次の操作を選ぶ前に現在の状態を確認してください。不確定な変更操作を自動的に繰り返してはいけません。
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# ブラウザーの権限
ブラウザーのバインディングは権限を保持しません。操作には現在のセッション、ターン、ワークスペースポリシー、およびページオリジンが適用されます。ページ読み取りの同意は、ファイル転送やプロファイル全体の履歴読み取りを認可しません。承認が拒否された場合、セッションが閉じられた場合、または権限境界が変更された場合は、続行する前にそれらの状態を処理してください。
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# ブラウザーの可視性
`browser.capabilities.list()` を読み取り、このブラウザーが可視性機能を公開しているか確認してください。ドキュメント名が存在することは機能が有効である証拠ではありません。可視性機能がない場合、タブ作成時に `visible` オプションを渡すとタブ作成前に拒否されます。
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# セッションの命名
`await browser.nameSession(name)` は、前後の空白を取り除いた空でないタイトルを、このブラウザーセッションの管理タブグループと今後作成されるタブに割り当てます。`cua.createBrowserTab(id, url, {sessionName})` はタブ作成前にその命名ステップの完了を待ち、命名エラー時はタブを作成しません。
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# ユーザータブ
`browser.user.openTabs()` はタブを取得せずにユーザータブのメタデータを返します。`browser.user.claimTab(listedTabOrId)` は選択した正確なタブを明示的に取得します。`browser.tabs.get(id)` は遅延バインディングを返すものであり、任意のユーザータブを暗黙的に取得するものではありません。ユーザータブはターンクリーンアップ時に閉じられずに解放されます。
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# 管理タブのライフタイム
作成されたタブは、現在のライフサイクルで明示的に保持されない限り一時的です。`markDeliverable()` は完了した結果をユーザーのために保持し、`markHandoff()` は同一セッション内での継続作業のためにタブを保持します。これらのマークは古いページ権限を保持したり、別のセッションを認可したりしません。クローズ、停止、および不確定な効果にはそれぞれのクリーンアップ要件が残ります。
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# ブラウザーバックエンドの利用可否
現在の Maka プロバイダー構成にはブラウザー拡張機能と設定済み CDP 接続が含まれており、組み込みブラウザーバックエンドは追加されていません。現在の一覧にある ID を使ってブラウザーとタブをバインドしてください。組み込みバックエンドや管理機能のリファレンスを読んでも、そのバックエンドが作成されたりブラウザー管理権限が付与されたりすることはありません。
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# 中断された操作
キャンセルは、送信済みの操作がロールバックされた証拠にはなりません。元のバインディングと操作結果は確定するまで保持し、別のプロバイダー経由で変更操作を繰り返さないでください。リセットすると REPL のバインディングはクリアされ、後続の作業では現在の権限のもとでターゲットを再バインドする必要があります。
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# ブラウザー API の利用方法
`agent.browsers` と `cua.browsers` は同じコレクションを共有します。コレクション呼び出しは観察結果を出力せずにデータまたは遅延バインディングを返します。`agent.documentation.get(name)` は厳密な名前付きドキュメントを読み取り、出力せずにそのテキストの Promise を返します。`tabs.selected()` は論理セッションのアクティブ状態に追従します。正確なブラウザー ID や既存のタブバインディングがプロバイダーを切り替えることはありません。
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# アクセシビリティ観察
要素参照を使用する前に新しいアクセシビリティ状態を読み取ってください。`tab.ax` はドキュメント化されたアクセシビリティ操作を公開しており、`get(mode, options)` は自動出力せずに状態、スクリーンショットバイト列、またはその両方を返します。ナビゲーションやドキュメントの変更により以前の参照が無効になることがあるため、インデックスを推測せずに観察を更新してください。
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# オプションのブラウザー機能
オプション機能を使用する前に、選択したオブジェクトの機能コレクションを読み取ってください。ドキュメント参照によって生の CDP、WebMCP、認証、またはチャレンジ処理 API が有効になることはありません。コレクションに該当 ID がない場合、その機能は利用できません。既存のページ操作には通常の権限チェックとライフタイムチェックが引き続き適用されます。
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# ローカル開発ページ
対象の開発 URL に到達できるブラウザーを選択し、その明示的な URL へ移動してください。ローカルホスト名にも現在のワークスペースネットワークポリシーとページオリジン認可が引き続き適用されます。ページ確認中は選択したブラウザーのバインディングを維持してください。別マシンの localhost は異なる接続先を指します。
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# ファイルアップロード
アップロード操作は、選択したブラウザードキュメントで公開されている場合にのみ使用してください。アップロードには対象ページと選択ファイルそれぞれに対する現在の権限が必要であり、ページ読み取りやダウンロードの許可はアップロードの同意にはなりません。ファイル選択ダイアログはそれを開いた正確なページ操作に属します。そのページや選択ダイアログが最新でなくなった場合は、古い選択ダイアログを再利用せず新しい観察からやり直してください。
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# スクリーンショット
`tab.getScreenshot()` はスクリーンショットのバイト列を返し、観察ヘルパーは画像を出力できます。ナビゲーション、リサイズ、またはスクロールの後は、座標を決める前に新しく撮影してください。スクリーンショットは観察結果であり、以前の入力が意図したコントロールに届いた証拠ではありません。
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# ビューポート機能
サイズを変更する前に `browser.capabilities.list()` を読み取り、公開されているビューポート機能を取得してください。ビューポート設定はブラウザーセッションの論理アクティブタブとその現在のライフタイムに従います。ビューポートサイズを変更しても、無関係な OS フォーカスタブが選択されたり、ページアクセス権が付与されたりすることはありません。
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# ページアセット機能
ページアセットは、選択したタブがその機能を公開している場合にのみ使用してください。アセット一覧は観察対象のページとドキュメントに属します。ナビゲーションやドキュメント置換の後は新しい一覧を取得してください。古いアセット識別子で別ページのファイルを認可することはできません。ファイルの保存にはその操作時点のファイル転送権限が必要です。
<!-- /browser-document -->

### ファイル選択ダイアログとアップロード

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

ファイル選択ダイアログを開く操作の前に待機を開始してください。選択ダイアログイベントのデフォルト待機時間は 3000 ms で、明示的なタイムアウトは正の整数である必要があります。`isMultiple()` は同期的です。`setFiles(pathOrPaths, {timeoutMs})` は単一パスまたは空でない配列を受け付け、単一ファイル選択ダイアログでは複数パスを拒否します。任意のタイムアウトは検証されますが、進行中の選択処理を破棄することはありません。

パスは Agent Host のファイルシステムを指し、呼び出し元のワークスペースファイルポリシーに従います。ページアクセス権、現在の HTTP(S) オリジンに対するアップロード同意、およびファイル読み取り権限はそれぞれ独立しています。サポートされる入力スナップショットは通常ファイルです。ファイルは不変のバイト列として転送され、選択された Maka ブラウザーホスト側で実体化されるため、OS 間でファイルパスを自分で変換しないでください。

選択ダイアログハンドルは発行元のタブ、ドキュメント、およびターンに属します。子ターゲットの選択ダイアログはサポートされていません。拡張機能の選択ダイアログには完全なソースイベントの来歴情報が必要で、アップロードにはさらにブラウザーホスト側での検証済みファイル配置が必要です。Chatgpt はベストエフォート対応であり、そのような配置証明のない設定済み CDP はファイル送信前にアップロードを拒否します。この操作を満たすために既存のバインド済みタブを別ブラウザーへ置き換えることはありません。選択が成功するとハンドルは消費されます。結果が不明な場合は再実行せず整合性を確認してください。

クリーンアップが未確認の結果を返した場合、コピーされたアップロードデータが削除済みであると仮定しないでください。ファイルが選択されたままブラウザーホストが終了した場合の自動回収機能はまだ利用できません。
