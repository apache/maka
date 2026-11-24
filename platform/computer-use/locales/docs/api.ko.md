Computer Use는 독립적인 영구 JavaScript REPL입니다. `cua_repl`을 직접 사용하며 Code Mode는 필요하지 않습니다. 변수와 바인딩된 객체는 현재 Host 프로세스 내에서 여러 호출과 턴(Turn)에 걸쳐 유지됩니다. 재시작 후 새로 생성된 REPL에는 이전 기록의 변수가 없으므로 모델 요청과 함께 제공되는 현재 Computer Use 상태를 따르세요.
웹사이트 작업은 먼저 `await cua.listBrowsers()`로 시작하고, 네이티브 브라우저 창 입력보다 브라우저 Tab을 우선 사용하세요. 설치된 ChatGPT 연결은 별도의 셸 설정이나 ChatGPT 데스크톱 실행 없이 필요 시 바로 제어권을 가져올 수 있습니다.
최상위 `return`이 아닌 최상위 `await`를 사용하세요. 이 REPL은 선언을 유지하므로 기존 바인딩을 재사용하거나 새 변수 이름을 선택하세요. Node API나 `setTimeout`은 제공되지 않습니다.

`cua.computer.target`은 선택된 데스크톱 플랫폼(`mac`, `linux`, `windows`)을 식별합니다. WSL에서는 기본값이 Windows 호스트이며, 셸 명령은 여전히 Linux에서 실행될 수 있습니다.

`cua.computer`는 플랫폼 네이티브 snake_case 메서드도 노출합니다. 이 메서드들은 아래의 App/Tab 위치 인수 대신 옵션 객체를 받습니다. `list_apps()`, `list_windows()` 및 Linux의 `get_screenshot()`은 옵션을 받지 않습니다. 먼저 선택된 인터페이스를 확인하고 목록을 읽으세요:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | 네이티브 메서드(오디오는 별도 문서화) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: 반환된 `window` 객체를 사용하여 `get_window_state({window, query?, include_screenshot?})`를 호출합니다. `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`에는 관찰된 `element_id` **또는** 정수 `x,y`를 전달합니다. 창 좌표는 창 기준 로컬 좌표이며, `window`를 생략하면 데스크톱을 대상으로 합니다. 기타 입력 메서드에는 `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` 및 `launch_app({app})`이 있습니다. `duration` 단위는 밀리초입니다. `drag_handle()`은 `start({x,y})`, `move_to({x,y})`, `end()`를 가진 데스크톱 핸들을 생성하며, 같은 턴 내에서 명시적으로 종료해야 합니다.
- Windows: 반환된 `{app,id,...}` 창 설명자를 사용합니다. 인덱스 입력이나 스크린샷 입력 전에 `get_window_state({window, include_text?, include_screenshot?})`를 먼저 읽으세요. 기본값은 스크린샷 포함, 텍스트 제외입니다. `click({window,element_index})` 또는 `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` 및 `launch_app({app})`을 사용합니다. 이미지 좌표를 사용하려면 `screenshotId`를 반환된 스크린샷의 `id`로 설정하세요. 이를 생략하면 가장 최근에 관찰된 스크린샷 크기 기준의 창 로컬 정수 좌표를 사용하며, 스크린샷 관찰 전에는 창 크기를 기준으로 합니다. 스크롤은 한 번의 호출에서 `scrollX`와 `scrollY`를 모두 받을 수 있습니다. 보조 작업(secondary action)은 현재 Expand/Collapse만 지원하며 다른 레이블은 거부됩니다.
- macOS: 반환된 앱 `id`를 `app`으로 사용합니다. `get_app_state({app})`를 먼저 읽은 뒤 `click({app,element_index,mouse_button?,click_count?})` 또는 `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})`(또는 `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})`, 또는 `perform_secondary_action({app,element_index,action})`을 호출합니다.

네이티브 목록과 상태 구조는 플랫폼마다 다릅니다. App 래퍼 핸들이 아니라 반환된 ID와 선택자를 재사용하세요. Linux 상태는 `ax_tree`와 `screenshots`를 반환하며, 각 스크린샷 항목은 `filepath`, `bytes`, `data_url`을 포함합니다. Windows 상태는 스크린샷 이미지를 자동으로 출력합니다. 그 외 네이티브 결과는 `nodeRepl.write`/`emitImage`로 출력할 수 있도록 반환되며, 변경 메서드는 undefined를 반환합니다. 현재 Host/앱 권한은 그대로 적용되며, 메서드가 존재하더라도 사용할 수 없는 백엔드나 지원되지 않는 작업은 거부될 수 있습니다. stale-target 오류가 발생하면 상태를 새로고침하고, 결과가 불확실한 입력은 다시 실행하지 마세요. 활성 드래그 상태를 다음 턴으로 넘기지 말고, 재설정 후에는 관찰 상태를 새로고침하세요.


새로 시작된 REPL에는 바인딩된 대상이 없습니다. 아래 진입점들은 API 문서와 목록 또는 초기 대상 상태를 자동으로 출력합니다. 브라우저 ID는 구성된 CDP 제공자와 연결된 확장 프로그램(Extension) 브라우저 제공자에서 가져옵니다. 정확한 ID가 우선하며, 정확히 일치하는 항목이 없을 때만 `maka`와 `chatgpt`가 현재 유일한 확장 프로그램 엔드포인트를 선택합니다. 둘 다 사용할 수 없는 경우 `getApp`을 통해 네이티브 브라우저 창을 사용하세요. 이 API는 `start_session` 같은 드라이버 관리 기능은 노출하지 않습니다.

원래 네이티브 호스트가 유지된 상태로 Chrome 또는 Chromium에 설치된 ChatGPT 확장 프로그램은 자동으로 검색됩니다. `listBrowsers()`는 이를 `on_demand`로 보고하며, 선택하면 제어권을 가져오고 `browser.release()` 호출이나 턴 정리 시 원래 호스트를 복원합니다. 설정 명령, 디버그 포트, ChatGPT 데스크톱 실행이 필요하지 않습니다. 웹사이트에는 네이티브 브라우저 창 입력보다 이 브라우저 연결을 우선 사용하세요.

ChatGPT 호환성은 최선 노력(best effort)으로 제공됩니다. 정확한 ID와 기존 핸들은 제공자를 전환하지 않습니다.

진입점(대상을 선택하면 초기 상태가 자동으로 출력됨):
- `await cua.getState({emit?})`: 목록 오류를 포함한 앱 및 사용 가능한 브라우저 목록.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  macOS에서 관찰된 앱 PID를 전달하면 해당 앱의 플로팅 패널도 포함됩니다.
  창 항목에는 `pid`와 `bindable`이 포함됩니다. `bindable: true`인 창을 선택하세요.
  바인딩할 수 없는 항목에는 `bindingError`가 포함됩니다. 바인딩 가능한 macOS 항목에는 `applicationId`와 `appPath`도 포함됩니다. 바인딩 시 앱 동의 여부와 실시간 신원이 확인됩니다.
- `const app = await cua.getApp("Name / bundle ID / app path")` 또는 `getApp({windowId})`.
  macOS에서는 실행되지 않은 앱을 자동으로 실행합니다. Windows의 `getApp`은 이미 열려 있는 창을 선택합니다. 앱을 실행하려면 `cua.listApps()`에서 얻은 ID로 `await cua.computer.launch_app({app: appId})`를 호출한 뒤 목록을 새로고침하여 정확한 창을 선택하세요. 이름이 모호할 때는 정확한 창을 선택하세요. Linux에서는 앱이 이미 열려 있어야 합니다.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: 탭을 열지 않고 브라우저만 선택합니다. 이동할 URL이 이미 열려 있을 필요는 없습니다. 여러 제공자가 있을 때는 ID를 지정하세요.
- `const tab = await cua.getTab("tab ID", {browser?})` 또는 `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: 선택한 제공자의 프로필에서 탭을 엽니다. 이 메서드와 `getBrowser`에서 스킴이 없는 URL은 HTTPS를 사용합니다. 생성 시 먼저 이 세션 소유의 빈 탭을 만든 다음, 명시된 URL이 있으면 탐색을 요청합니다. 탐색이 거부되더라도 해당 빈 탭은 턴 정리 대상으로 남습니다. 사용할 수 없는 제공자, 탭 멘션, 지원되지 않는 생성 옵션은 예외를 발생시킵니다.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`: 해당 브라우저에서 탭을 나열하거나, 정확한 탭을 바인딩하거나, 빈 임시 탭을 생성합니다. 이 메서드들은 결과를 자동 출력하지 않고 데이터만 반환하며, `get`/`new`는 초기 AX 관찰 없이 Tab 객체를 반환합니다. 관찰 대상을 사용하기 전에 `getAXState`를 호출하세요. `await tab.title()`과 `await tab.url()`은 접근성 관찰 상태를 변경하지 않고 현재 메타데이터를 반환합니다.

- 연결된 브라우저 어댑터는 `await browser.user.openTabs()`와 `await browser.user.claimTab(tabOrId)`도 노출합니다. 목록 조회는 현재 사용자 탭 메타데이터를 반환하며, 제어권 가져오기(claim)는 현재 권한과 연결 준비를 거친 후 일반 Tab을 반환합니다. 목록에 나온 문자열 ID 또는 객체를 전달하세요. 턴 정리 시 사용자 탭은 닫지 않고 제어권만 해제하며, 이 세션에서 생성한 탭은 임시 탭으로 유지됩니다. `browser.tabs.get(id)`는 지연 바인딩으로 유지되며 초기 점유나 AX 관찰을 수행하지 않습니다. 이 메서드들은 권한 부여를 유지하지 않습니다. 확장 프로그램 제공자에서 `browser.tabs.list()`는 이 세션이 관리하는 탭을 나열합니다. 구성된 CDP 제공자에는 `browser.user`가 없으므로 대신 `browser.tabs` 메서드를 사용하세요.

Maka는 AX 브라우저 프로필을 제공합니다. `tab.ax`에는 `get`, `write`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`, `setValue` 및 `typeText`가 포함됩니다. 작업 시그니처는 아래 Tab 메서드와 동일합니다.
`await tab.ax.get(mode = 'state', {disableDiffing?})`는 `state`, `screenshot`, `both` 모드에 따라 텍스트, 이미지 바이트 또는 `{state, screenshot?}`를 자동 출력 없이 반환합니다.
`await tab.ax.write(mode = 'state', options?)`는 사용 가능한 결과를 출력하고 undefined를 반환합니다. 기존의 평면(flat) Tab 메서드도 계속 사용할 수 있습니다.
AX 파사드와 평면 메서드는 동일한 바인딩된 Tab에 대해 동작합니다.

App 및 Tab 관찰:
- `getAXState({emit?, disableDiffing?})`는 텍스트를 반환합니다. 탭과 macOS 앱은 기본적으로 diff를 사용하며, Windows와 Linux 앱은 전체 상태를 반환합니다.
- `getScreenshot({emit?})`는 Uint8Array를 반환하고 이미지를 출력합니다.
- `getAXStateAndScreenshot(options?)`는 `{state, screenshot?}`를 반환하고 사용 가능한 결과를 출력합니다.
검색, 선택 및 관찰 메서드는 자동으로 결과를 출력하므로 직접 호출하세요. `getScreenshot()`을 `nodeRepl.emitImage()`로 감싸거나 `getAXState()`를 `nodeRepl.write()`로 감싸면 중복 출력됩니다. 결과를 직접 처리할 때는 `{emit:false}`를 사용하세요. 이 경우에도 목록 오류는 계속 표시됩니다. Windows 네이티브 스크린샷 메서드는 캡처 전에 `{emit:false}`를 거부합니다. 한 번의 호출 안에서 출력된 동일한 이미지는 한 번만 전달되며, 이후 호출에서는 같은 이미지를 다시 출력할 수 있습니다.
관찰에는 짧은 UI 업데이트를 위한 제한된 안정화 대기 시간(탭 200 ms, 앱 400 ms)이 포함됩니다. 이는 임의의 비동기 작업을 기다리지 않으며, 지속적인 애니메이션이 대기 시간을 연장하지도 않습니다. 이후 업데이트를 확인하려면 다시 관찰하세요.
변경되지 않은 동일한 브라우저 문서의 스크린샷 캡처에 성공하면 기존 AX 참조가 유지됩니다. 탐색, 문서 교체 또는 대상 무효화 후에는 인덱스를 다시 사용하기 전에 `getAXState()`를 새로고침해야 하며, 새로 관찰된 요소에 대해서도 새로고침이 필요합니다. Linux/Windows 네이티브 관찰은 해당 요소가 계속 유효한 동안 이전에 관찰된 요소 식별자를 유지합니다.
앱이 응답 중이라 바쁜 상태에서 네이티브 AX 관찰이 실패하면, 앱이 다시 응답할 때 동일한 바인딩 객체로 새로고침하세요. 실패한 관찰은 기존 인덱스와 좌표를 무효화합니다.

App 및 Tab 작업:
- `await app.bringToFront()`는 정확히 바인딩된 네이티브 창을 영구적으로 활성화합니다. 키나 포인터 입력을 보내지 않으며, 데스크톱이 활성화를 확인할 수 없는 경우 결과 불확실(unknown outcome)을 보고합니다.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- 네이티브 앱은 마우스 버튼 `l/r/m`과 방향 `u/d/l/r`도 허용합니다. macOS에서는 이러한 이름의 앞뒤 공백을 제거하고 대소문자를 구분하지 않으며, 왼쪽/오른쪽/가운데 버튼으로 `0/1/2`도 허용합니다.
- `setValue(index, string)`: 네이티브 Linux 앱에서는 사용할 수 없습니다.
- `selectText(index, text, {prefix?, suffix?, selectionType?})`: `selectionType`은 `text`, `cursor_before` 또는 `cursor_after`입니다. 네이티브 텍스트 선택은 macOS에서만 지원됩니다. `text_not_found`는 텍스트 또는 제공한 컨텍스트가 없음을 의미하므로 현재 상태를 다시 읽으세요. `ambiguous_text`는 더 구체적인 prefix/suffix가 필요함을 의미합니다.
- `performSecondaryAction(index, action)`: 네이티브 AX 관찰에 나열된 정확한 작업 이름을 사용하세요. CDP는 보조 작업을 노출하지 않으며 이 메서드를 거부합니다.

App 입력: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Tab 입력: `typeText(index|null, text)`, `paste(index|null, text, {format?})`, `pressKey(index|null, key)`. 인덱스를 전달하면 먼저 해당 관찰 필드에 포커스를 맞춥니다. 현재 포커스를 사용하려면 `null`을 전달하세요. 키 예시: `Return`, `Tab`, `super+a`, `shift+Left`.
붙여넣기 형식: `text`(기본값), `md`(Markdown 소스를 일반 텍스트로 붙여넣기), `html`.
네이티브 Linux 및 Windows 앱은 `text`만 지원합니다.
네이티브 HTML 붙여넣기는 macOS에서만 지원되며 읽을 수 있는 편집 가능 값과 선택 영역이 필요합니다. 정확한 창을 일시적으로 활성화하고 선택 영역을 유지한 뒤, 사용자가 더 최신 내용을 복사하지 않았다면 이전 클립보드를 복원합니다. 값이 변경되지 않으면 결과 불확실로 보고됩니다.
브라우저 HTML 붙여넣기에는 관찰된 contenteditable 요소가 필요합니다.

Tab 탐색: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })`는 이미지를 출력하지 않고 JPEG 바이트를 반환합니다. 뷰포트를 캡처하려면 `clip`을 생략하고, 전체 문서를 캡처하려면 `fullPage: true`를 지정하세요. `clip`의 너비와 높이는 양수여야 합니다. 좌표와 크기는 CSS 픽셀 단위입니다. 뷰포트 캡처는 먼저 최신 스크린캐스트 프레임을 시도하고, 확인된 정리 후 동일한 탭의 스크린샷 명령을 시도합니다. 결과가 불확실한 작업은 재실행되지 않습니다.

확장 프로그램 제공자에서 `await tab.markDeliverable()`은 정상 턴 종료 시 탭을 닫지 않고 유지하여 사용자에게 넘겨줍니다. `await tab.markHandoff()`는 이 동일한 세션에서 계속 사용할 수 있도록 탭을 유지하며, 다음 실제 턴에서는 표시가 초기화되어 이어집니다. 원래의 에이전트/사용자 출처는 보존되므로 에이전트가 생성한 탭은 이후 표시 없는 턴이 끝나면 닫힙니다. 나중에 명시적으로 표시하면 이전 표시를 대체합니다. 두 메서드 모두 일치하는 의도 ACK를 받은 뒤 undefined를 반환하지만, 이것이 물리적 전달이나 정리를 증명하지는 않습니다. 이러한 표시는 사이트 권한을 유지하지 않으며, 결과가 불확실한 호출은 재실행되지 않습니다. 직접 CDP 연결은 이러한 표시를 지원하지 않습니다.

`tab.clipboard`는 `read()`, `readText()`, `write(items)` 및 `writeText(text)`를 제공합니다. 이 메서드들은 결과를 자동 출력하지 않고 값을 반환합니다. 서식 있는 항목은 비어 있지 않은 `entries` 배열을 가지며, 각 항목은 `mimeType`과 문자열 필드 `text` 또는 `base64` 중 정확히 하나를 가집니다. 선택적 `presentationStyle`은 `unspecified`, `inline` 또는 `attachment`입니다. 예: `await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
이 가상 데이터는 동일한 구성의 백엔드 컨텍스트를 사용하는 탭들끼리 공유되며 OS 클립보드를 읽거나 변경하지 않습니다. 권한이 부여된 페이지는 설치 후 Clipboard API를 통해 동일한 데이터를 사용합니다. 에이전트의 `readText()`는 첫 번째 정확한 `text/plain` 항목의 텍스트를 반환하고, base64 전용 항목에는 빈 문자열을 반환합니다. 페이지의 `readText()`는 해당 항목을 Blob으로 디코딩합니다. 턴 정리 시 페이지 브리지는 제거되지만 저장된 데이터는 유지됩니다. 재설정하면 새로운 빈 컨텍스트가 생성됩니다.

대기(wait) 메서드는 undefined를 반환합니다. `locator.waitFor({state, timeoutMs?})`는 `state: 'attached'|'detached'|'visible'|'hidden'`을 필수로 받으며 첫 번째 일치 요소를 검사합니다. 일치하는 요소가 없으면 `detached`와 `hidden` 조건을 충족합니다.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})`은 전체 URL과 일치 여부를 확인합니다. `*`는 슬래시로 구분된 세그먼트 내에서만 일치하고, `**`는 슬래시를 넘나들 수 있으며, 그 외 문자는 리터럴로 처리됩니다. 기본 `waitUntil`은 `commit`이며, `load`, `domcontentloaded`, `networkidle`은 URL이 일치한 뒤 해당 상태까지 기다립니다.
`tab.playwright.waitForLoadState({state?, timeoutMs?})`의 기본값은 `load`이며 `domcontentloaded`와 `networkidle`도 허용합니다. 이러한 조건 대기의 기본 제한 시간은 3000 ms이며, 더 긴 명시적 제한 시간도 존중됩니다. 0을 지정하면 이벤트 대기 예산이 남지 않지만, 로케이터는 첫 번째 확인을 수행하고 현재 URL/로드 상태가 이미 일치할 수 있으며 `networkidle`은 시간 초과됩니다. `tab.playwright.waitForTimeout(ms)`는 0 이상의 정수를 받아 지정된 시간만큼 대기합니다. 작업으로 유발되는 대기는 작업을 수행하기 전에 대기를 먼저 시작한 뒤 두 Promise를 모두 `await`하세요. 중지(Stop)는 원래 대기를 취소합니다.

`tab.playwright`는 선행 AX 관찰 없이 DOM 로케이터를 해석합니다. `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder` 또는 `getByTestId`를 사용하며, `frameLocator(selector)`로 프레임에 진입합니다. 로케이터는 `first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`, `textContent`, `innerText`, `getAttribute`, `isEnabled` 및 `isVisible`을 지원합니다.
`domSnapshot()`은 페이지의 DOM 접근성 텍스트를 반환합니다.

로케이터 입력 메서드는 undefined를 반환합니다: `click(options?)`, `dblclick(options?)`, `fill(text, options?)`, `type(text, options?)`, `press(key, options?)`, `pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`, `setChecked(boolean, options?)`, `check(options?)` 및 `uncheck(options?)`.
클릭 옵션은 `button: 'left'|'right'|'middle'`, `modifiers`, `force` 및 `timeoutMs`를 받으며, 체크 옵션은 `force`와 `timeoutMs`를 받습니다. 보조 키(`modifiers`)는 `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`이며, `ControlOrMeta`는 선택한 브라우저의 플랫폼을 따릅니다. 기타 입력 옵션은 `timeoutMs`를 받습니다. 제한 시간은 양의 정수여야 하며, 준비 기본값은 3000 ms이고 더 긴 명시적 제한 시간을 존중합니다. 옵션 선택은 값 문자열이나 `value`, `label` 또는 0 이상의 정수 `index`를 가진 설명자를 받으며, 배열로 여러 옵션을 선택할 수 있습니다.

로케이터 변경 작업은 유일하게 일치하는 요소 또는 유일하게 표시되는 일치 요소를 사용합니다. 일치 대상이 모호하면 예외가 발생합니다. 일반 텍스트 `fill`/`type`은 가상 붙여넣기 이벤트를 사용하며 페이지 핸들러의 취소를 존중하고 저장된 클립보드를 보존합니다. 빈 문자열 붙여넣기는 기본적으로 기존 값을 지우지 않습니다. 클립보드 단축키도 동일한 가상 클립보드를 사용하며, 지원되지 않는 조합은 네이티브 키를 보내기 전에 예외를 발생시킵니다. 쓰기에 성공하면 호출한 로케이터 컬렉션의 캐시된 읽기만 지워집니다. 입력 결과는 여전히 페이지에서 직접 확인해야 하며, 결과가 불확실한 작업은 자동으로 재실행되지 않습니다.

다운로드는 다운로드 알림을 지원하는 연결된 확장 프로그램 제공자와 현재 Host 다운로드 권한을 사용합니다. 같은 Tab에서 동작을 트리거하기 전에 먼저 대기를 준비하세요:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
그다음 클릭이나 탐색을 수행하고 `const download = await pending`으로 받습니다.
`await download.path({timeoutMs?})`는 브라우저가 보고한 파일 이름 또는 null을 반환합니다. 이 메서드는 파일을 전송하지도 않고 해당 경로가 이 작업의 것임을 증명하지도 않으며, 다른 호스트의 경로이거나 비어 있거나 사용할 수 없을 수 있습니다. `saveAs` 작업은 제공되지 않습니다.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})`는 유일하게 일치하는 로케이터의 미디어를 요청합니다. 다운로드 대기는 결과를 출력하지 않고 데이터를 반환하며, 미디어 트리거는 undefined를 반환합니다. 네이티브 시작 제한 시간은 일치하는 첫 번째 Started 이벤트 시점에 종료되며, 그 이후에도 취소와 Host 정리는 계속 적용됩니다.
읽기 권한과 다운로드 권한은 별개이며, 출처(origin)나 대상 출처가 다른 경우에도 마찬가지입니다. 구성된 CDP 연결만으로는 네이티브 다운로드 알림을 제공하지 않습니다.
Maka는 제한된 확장 기능으로 `tab.cua.downloadMedia({x,y,timeoutMs?})`와 `tab.dom_cua.downloadMedia({node_id,timeoutMs?})`도 노출합니다. 현재 선택된 확장 프로그램 제공자는 이러한 좌표/노드 미디어 명령을 거부하므로 구현된 로케이터 경로를 사용하세요. 결과가 불확실한 다운로드 작업은 절대 자동으로 재시도되지 않습니다.
반환된 핸들은 권한 부여가 아니라 원래 Tab 바인딩을 유지합니다. 해당 탭을 계속 사용 가능한 상태로 두세요. `path()`는 캐시를 조회하기 전에 현재 탭 메타데이터와 Host 권한을 다시 확인합니다. 오래된 핸들은 닫힌 탭을 유지할 수 없습니다. 이후 턴에서도 현재 탭 액세스 권한이 필요하므로 탭 제어권을 다시 가져와야 할 수 있습니다.

`await tab.getJsDialog()`는 undefined 또는 `type`과 `dismiss()`를 가진 현재 대화상자 객체를 반환합니다. 확인(confirm) 대화상자에는 `accept()`도 있으며, 프롬프트(prompt) 대화상자에는 빈 문자열을 포함해 텍스트를 받는 `accept(text)`가 있습니다. 이전 대화상자 객체는 새로 바뀐 대화상자에 작용할 수 없습니다. 일반 페이지 읽기나 입력 전에 활성 대화상자를 먼저 처리하세요.
`getAXState()`는 대화상자 메시지와 인덱스된 컨트롤을 표시합니다. 프롬프트 컨트롤은 `setValue`, `typeText` 및 Return/Escape를 지원합니다. 대화상자 컨트롤에는 페이지 좌표가 없습니다.
대화상자가 열려 있는 동안에는 스크린샷을 사용할 수 없습니다. 스크린샷 전용 호출은 예외를 발생시키며, 통합 관찰 호출은 `screenshot` 속성 없이 대화상자 상태만 반환합니다.
연결된 브라우저 Host는 현재 제어권을 보유하는 동안 `beforeunload` 대화상자를 자동으로 수락합니다. 턴 정리 시 사용자 탭을 닫지 않고 제어권만 분리합니다.

탐색은 HTTP(S)와 `about:blank`를 지원하며 관찰 가능한 문서 상태가 될 때까지 기다립니다.
기본 CDP 대상이 지원되며, 교차 프로세스(cross-process) iframe 접근성은 완전하지 않습니다.
CDP 페이지 거리는 소수, 0, 음수를 포함한 유한 숫자를 허용합니다. 1페이지는 대상의 콘텐츠 너비 또는 높이를 사용하며 최소값은 100 CSS 픽셀이고, 좌표 대상은 뷰포트를 사용합니다. CDP의 `{pixels:n}` 확장은 양의 유한 픽셀 델타를 허용합니다.
Linux는 숫자 페이지 수를 거부합니다. Linux X11은 기본값이 `{pixels:800}`이며 1부터 65535까지의 정수 픽셀 거리를 허용합니다. `max(round(pixels/100),1)`개의 휠 단계를 전송하며, 실제 콘텐츠 이동량은 애플리케이션이 결정합니다. Linux Wayland는 현재 픽셀 입력을 거부합니다.
macOS 스크롤은 양의 유한 숫자 페이지 수를 받으며 기본값은 1이고 `{pixels}`를 거부합니다. 소수 페이지 수도 지원됩니다.
Windows는 좌표 지점과 양의 유한 `{pixels:500}` 거리를 필수로 요구하며, 거리를 생략하거나 숫자 페이지 수를 전달하면 거부됩니다. 좌표와 방향 부호가 적용된 거리는 JavaScript `Math.round`를 사용하며, 반올림된 입력은 부호 있는 32비트 정수 범위 안에 있어야 합니다. 네이티브 휠 델타는 축당 [-32768,32767] 범위로 제한되며 포인터는 대상 위치에 머뭅니다. 실제 콘텐츠 이동량은 애플리케이션이 결정합니다. 네이티브 인덱스 스크롤은 선택한 접근성 대상을 유지합니다. App 래퍼의 네이티브 인덱스 클릭은 단일 시맨틱 클릭만 지원하므로 여러 번 클릭하려면 스크린샷 좌표를 사용하세요. 원시 macOS `cua.computer.click`은 시뮬레이션된 마우스 이벤트를 통해 여러 번의 인덱스 클릭도 지원합니다.

입력이 성공적으로 전달되었다고 해서 애플리케이션의 결과 상태가 확정되는 것은 아닙니다.
브라우저 좌표 작업은 CSS 뷰포트 좌표를 사용하며 스크린샷이 필요하지 않습니다. 스크린샷은 이 좌표를 스케일링하지 않습니다.
Linux 창 로컬 좌표는 스크린샷을 찍지 않고도 사용할 수 있습니다. 네이티브 Linux/Windows 스크린샷 매핑은 다른 관찰로 대체될 때까지 입력 작업 후에도 유지되지만, AX 전용 관찰을 수행하면 이미지 매핑이 지워집니다. 그 후 Windows 좌표 입력을 하려면 다시 스크린샷을 찍어야 합니다. 창 위치나 크기가 변경되면 저장된 매핑이 무효화됩니다. macOS 좌표 입력은 현재 작업 후 매번 새 스크린샷이 필요합니다.
네이티브 시맨틱 작업은 유지된 접근성 요소를 사용합니다. 애플리케이션 메뉴는 소속 프로세스와 정확히 바인딩된 창 범위로 제한되며, 닫힌 메뉴의 내용은 메뉴를 열기 전까지 생략됩니다. 메뉴와 상호작용하면 바인딩된 창이 활성화될 수 있으며 메뉴가 열려 있는 동안 활성 상태가 유지됩니다.
네이티브 좌표 및 키보드 입력은 기본적으로 정확히 바인딩된 창으로 백그라운드 전달됩니다. 지원되지 않는 백그라운드 전달은 오류로 보고되며, 자동으로 포그라운드에서 재실행되지 않습니다. 검증되지 않은 효과가 이미 전달되었을 수 있습니다.
웹사이트에는 데스크톱 포커스와 포인터 입력을 피할 수 있는 브라우저 Tab 작업을 우선 사용하세요. 네이티브 텍스트 입력에는 `typeText` 또는 `setValue`를 우선 사용하세요. macOS `paste`는 시스템 클립보드와 포그라운드 키보드 입력을 사용합니다. 네이티브 메뉴는 해당 창을 활성화할 수 있습니다. 일부 좌표 경로는 시스템 포인터를 이동시킬 수 있으며, 전달 메타데이터가 실제 경로를 보고합니다. 필요할 때는 네이티브 `app.pressKey(key, {deliveryMode:"foreground"})` 및 `app.typeText(text, {deliveryMode:"foreground"})`로 포그라운드 경로를 명시적으로 요청할 수 있으며 기본값은 `"background"`입니다. 검증되지 않은 입력을 자동으로 재시도하거나 전달 모드를 암묵적으로 전환하지 마세요.

`nodeRepl.write(value)`는 텍스트/JSON을 출력합니다. `await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})`는 이미지를 출력합니다. 파일/HTTP 이미지 URL, Node, 임의의 파일시스템 및 네트워크 API는 사용할 수 없습니다. `cua.rewriteDocumentation()`은 이 참고 문서를 다시 출력합니다.

Host에서 출력 오디오를 활성화한 경우 `await cua.computer.start_audio_recording({max_duration_ms?})`는 녹음을 시작하고 undefined를 반환하며, 그동안 다른 호출도 계속 진행할 수 있습니다. 녹음 시간 기본값은 60000 ms이며 100부터 300000까지의 정수를 허용합니다. `await cua.computer.stop_audio_recording()`은 완료된 스테레오 24 kHz PCM16 WAV에 대해 `{filepath, bytes, data_url}`을 반환합니다. 제한 시간에 도달하면 캡처가 종료되며, 녹음 결과를 가져오려면 stop을 호출해야 합니다. `await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})`는 오디오를 명시적으로 출력합니다. 오디오가 비활성화된 경우 이러한 메서드는 존재하지 않습니다. 재설정 및 세션 정리 시 녹음 데이터와 로컬 경로는 폐기됩니다.

모든 작업은 현재 Host 권한을 사용하며 JS 객체는 권한 부여를 유지하지 않습니다.
세션 샌드박스가 꺼져 있으면 Computer Use, 애플리케이션, 브라우저 사이트, 방문 기록, 파일 전송 및 오디오에 추가 Maka 승인이 필요하지 않습니다. 권한 변경이나 현재 작업 중지는 여전히 적용됩니다.
Ask 모드에서는 REPL 실행 제한 시간 타이머가 시작되기 전에 Computer Use 승인이 진행됩니다.
앱, 브라우저 사이트 및 오디오 동의 대기 중에는 남은 실행 예산이 일시 정지됩니다. 네이티브 macOS/Windows 대기 역시 예산을 일시 정지하지만, 일반 비동기 대기와 Linux 네이티브 작업은 예산을 소모합니다. 일시 정지가 예산을 다시 채우거나 취소 기능을 비활성화하지는 않습니다.
네이티브 macOS 작업은 화면이 잠겨 있는 동안 `desktop_locked`를 보고하며, 연결된 CDP 제공자와 순수 REPL 계산은 이와 무관하게 계속 사용할 수 있습니다.
각 세션에는 고유한 Maka 커서가 있으며 입력 작업 시 자동으로 표시됩니다.
`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})`는 이 세션의 커서 표시 설정을 변경합니다. 색상은 `blue`, `mint`, `violet`, `amber`, `rose`, `cyan`이며 레이블은 최대 48자까지 허용됩니다. `cua.cursor.getState()`는 설정과 네이티브/브라우저 표시 상태를 보고합니다. `idle` 상태의 네이티브 렌더러는 첫 번째 네이티브 표시에 시작되며, `unavailable`은 디스플레이 호스트가 없거나 실패했음을 보고합니다. 실패한 렌더러를 다시 시도하려면 다시 구성하세요. 커서는 세션에 속하지만 턴이 끝난 뒤에도 화면에 남아 있지 않습니다. 턴 동안 표시되고 턴이 끝나면 숨겨지며 다음 입력 작업 시 다시 나타납니다.
커서는 입력 권한을 공유하지 않으며 시스템 포인터를 이동시키지 않습니다. 여러 커서가 있더라도 물리 키보드, 앱 포커스 또는 입력기를 격리하지는 않습니다.
취소되었거나 시간이 초과되었거나 힙이 고갈된 REPL은 `cua_reset`을 호출한 뒤 대상을 다시 바인딩해야 합니다. 이미 수락된 네이티브 작업은 반환 전에 마무리되며, 재설정은 이미 전달된 입력을 되돌리지 않습니다.
정상 턴 종료 시 이 세션은 자신이 생성한 미표시 임시 탭을 닫고 페이지 관찰을 해제합니다. 기존 사용자 탭과 유지 표시가 된 탭은 위 규칙에 따라 열린 상태로 유지됩니다. 재설정은 이 세션의 REPL과 바인딩을 초기화하지만, 새 권한을 부여하거나 이 세션이 보유한 리소스 및 정리 의무를 지우지 않습니다. 확인되지 않은 표시나 닫기 작업은 관리 책임을 유지하며 재실행되지 않습니다.

동일한 브라우저 컬렉션은 `agent.browsers`와 `cua.browsers`로 모두 사용할 수 있습니다.
이 컬렉션의 `list`, `get(id)`, `getDefault`, `getForUrl(url)` 메서드는 관찰을 출력하지 않고 메타데이터나 지연 Browser 객체를 반환합니다. `cua.getBrowser`는 문서를 출력하는 편의 진입점입니다. Browser 객체는 논리적 세션의 활성 탭을 반환하는 `tabs.selected()`를 노출하며, 이는 OS 포커스 탭을 선택하는 것이 아닙니다.
현재 직접 CDP 제공자에는 논리적 세션의 활성 탭 서비스가 없으므로 `selected()`가 `undefined`를 반환합니다.

`await browser.release()`는 이 세션의 온디맨드 ChatGPT 브라우저 임대를 반환합니다. 호스트를 해제하기 전에 이번 턴의 임시 탭과 물리 제어 리소스를 정리하며, 유지된 페이지는 열린 상태로 남습니다. 다른 세션들은 각자의 임대를 유지합니다. 마지막 세션이 해제되면 원래 네이티브 호스트가 복원됩니다. 이후 다시 사용하려면 `cua.getBrowser({id: "chatgpt"})`로 다시 확보해야 하며, 종료된 호스트 세대의 핸들은 새로 연결해야 합니다. 정상 턴 정리에서도 임대가 해제됩니다. 장기 실행 에이전트는 대기(sleep) 전에 해제해야 합니다. 다른 브라우저 제공자는 이 작업을 지원하지 않습니다.

`await browser.nameSession(name)`은 앞뒤 공백을 제거한 제목을 세션의 관리 탭 그룹 제목으로 저장합니다. 기존 관리 UI 표시는 소유된 영수증(receipt)을 통해 업데이트되며, 이후 생성되는 탭에도 저장된 제목이 적용됩니다. `cua.createBrowserTab(id, url, {sessionName})`은 탭을 생성하기 전에 브라우저를 확인하고 이름 지정을 먼저 완료합니다. 현재 브라우저 프로필은 visibility 기능을 제공하지 않습니다.

`await browser.history({queries, limit, from, to})`는 별도의 방문 기록 전송 채널을 알리는 확장 프로그램을 통해 프로필 전체의 방문 기록을 읽습니다. 샌드박스가 활성화된 경우 현재 세션 권한 경계 아래에서 실제 브라우저 ID와 세대에 대한 독립적인 `browser_history` 동의가 필요합니다. 페이지 권한이나 다운로드 권한으로는 방문 기록에 접근할 수 없으며, 페이지 출처 정책에 의해 방문 기록 요청이 자동 허용되지 않습니다.
기본값은 최대 100개 항목으로 제한된 전체 방문 기록 조회이며, 여러 검색어(`queries`)를 전달하면 방문 시간 내림차순으로 병합하고 URL 기준으로 중복 제거한 뒤 `limit`만큼 제한합니다.
번들된 Maka 확장 프로그램은 Chrome의 history 권한을 선언하지만, 해당 권한이 없는 구버전 확장 프로그램은 방문 기록 지원을 알리지 않습니다. ChatGPT 및 기타 서드파티 어댑터는 최선 노력으로 지원됩니다.

- `await browser.user.getTabContext(tabOrId)`는 현재 표시 중인 사용자 탭을 점유하거나 포커스를 주지 않고 컨텍스트를 읽습니다. 현재 탭 URL은 Host가 권한을 확인하며, 호출자가 대체 URL을 제공할 수 없습니다. 시크릿/비공개 탭과 개별 읽기 도중 URL이 변경된 경우는 거부됩니다. 결과는 `{kind:'text',text,title,url,truncated}` 또는 `{kind:'document',data,fileName,mimeType,title,url}`이며, 여기서 `data`는 실제 내보낸 파일 내용을 담은 `Uint8Array`입니다. Host가 파일 게시를 제공하는 경우 문서 결과에는 실제 세션 소유의 `path`도 포함됩니다. Google Workspace 문서는 Markdown, PDF 또는 XLSX 컨텍스트를 제공할 수 있으며, 일반 페이지는 현재 선택 영역을, YouTube 시청 페이지는 자막(transcript)을 포함할 수 있습니다. `maka` 제공자는 고정된 읽기 방식을 구현하며, `chatgpt`는 지원되는 경우 기본 읽기 프로토콜을 재사용합니다. 서드파티 지원은 최선 노력으로 제공됩니다.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)`는 현재 페이지에서 독립적인 함수를 평가합니다. 문자열은 표현식으로 처리됩니다. 로케이터 변형은 `locator.evaluate`에 `(element, arg)`를, `locator.evaluateAll`에 `(elements, arg)`를 전달합니다. 단일 요소 형식은 모호하지 않은 대상이 필요하며, 전체 요소 형식은 빈 일치 결과도 허용합니다.
  인수는 JSON 직렬화가 가능해야 합니다. 결과는 일반 데이터로 반환되며 함수와 심볼은 생략되고, BigInt는 문자열로, 유한하지 않은 숫자는 `null`로 변환됩니다. 이 API는 결과 깊이를 8, 배열을 2000개 항목, 객체를 200개 키, 문자열을 200000 UTF-16 단위로 제한하며, 해당되는 위치에 `[MaxDepth]`, `[Circular]`, `[Truncated]` 마커를 표시합니다.
- 평가는 읽기 전용 DOM, CSS, 지오메트리, Range 및 Selection 뷰만 노출합니다. 네트워크 요청, 쿠키, 모듈 로딩, DOM 편집은 노출하지 않습니다. 스크롤, 로컬 Range 경계 조작 및 함수 전용 타이머는 계속 지원됩니다.
  제한 시간 기본값은 3000 ms이며 명시적 값으로 원하는 기간을 설정할 수 있습니다. 중지되거나 중단된 스크립트는 이미 실행되었을 수 있으며 자동으로 다시 실행되지 않습니다. 기존 사이트 권한과 탭 소유권 규칙은 그대로 적용됩니다.

브라우저 포인터 입력은 `tab.cua.move({x,y,keys?})`, `click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`, `drag({path:[{x,y},...],keys?})` 및 `scroll({x,y,scrollX,scrollY,keypress?})`로 사용할 수 있습니다. 좌표와 거리는 CSS 뷰포트 숫자이며 소수 및 음수 값을 유지합니다. 버튼은 1(왼쪽), 2(가운데), 3(오른쪽)입니다. 포인터 보조 키 이름은 Alt, Control, Meta, Shift, ControlOrMeta입니다. `tab.cua.keypress({keys:[...]})`는 현재 포커스에 키 조합을 전송하며, `tab.cua.type({text})`는 브라우저의 가상 클립보드를 통해 현재 포커스에 텍스트를 붙여넣고 저장된 클립보드 데이터를 보존합니다. 텍스트에는 Markdown이 포함될 수 있으며 Google Sheets에는 일반 텍스트로 전달됩니다. 이러한 입력 메서드는 undefined를 반환하며 결과가 불확실한 입력을 재시도하지 않습니다.

`await tab.dom_cua.get_visible_dom()`은 문자열 `node_id` 값을 포함한 표시 가능한 대화형 HTML을 반환합니다. `click({node_id})` 또는 `double_click({node_id})`에 해당 정확한 문자열을 사용하세요. `scroll({node_id?,x,y})`는 스크롤 거리를 받으며 `node_id`를 생략하면 뷰포트 중앙을 사용합니다. `keypress({keys:[...]})`와 `type({text})`는 노드 ID가 아니라 현재 포커스를 사용합니다. 스냅샷을 제외한 DOM 메서드는 undefined를 반환합니다. 새 스냅샷을 가져오면 사라진 DOM 노드는 만료되며, 탐색이나 프레임 교체로 인해 노드가 오래된 상태(stale)가 될 수 있습니다. ID를 추측하거나 결과를 알 수 없는 입력을 재실행하지 말고 다시 관찰하세요.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# 브라우저 문제 해결
`cua.getState()`와 `agent.browsers.list()`를 읽어 사용 가능한 브라우저와 정확한 ID를 확인하세요. 연결이 구성되어 있다고 해서 특정 작업이 성공했다는 증거는 아닙니다. 바인딩이 오래되었거나 결과를 알 수 없을 때는 다음 작업을 선택하기 전에 현재 상태를 먼저 확인하세요. 결과가 불확실한 변경 작업은 자동으로 반복해서는 안 됩니다.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# 브라우저 권한
브라우저 바인딩은 권한을 보존하지 않습니다. 모든 작업은 현재 세션, 턴, 워크스페이스 정책 및 페이지 출처(origin)를 따릅니다. 페이지 읽기 동의는 파일 전송이나 프로필 전체 방문 기록 접근을 허용하지 않습니다. 승인 거부, 닫힌 세션 또는 변경된 권한 경계는 추가 작업 전에 먼저 처리해야 합니다.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# 브라우저 표시 여부 기능
`browser.capabilities.list()`를 읽어 이 브라우저가 visibility 기능을 게시하는지 확인하세요. 문서 이름이 존재한다고 해서 해당 기능이 활성화된 것은 아닙니다. visibility 기능이 없을 때 탭 생성에 `visible` 옵션을 전달하면 탭을 생성하기 전에 거부됩니다.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# 세션 이름 지정
`await browser.nameSession(name)`은 앞뒤 공백을 제거한 비어 있지 않은 제목을 이 브라우저 세션의 관리 탭 그룹과 이후 생성되는 탭에 지정합니다. `cua.createBrowserTab(id, url, {sessionName})`은 탭을 생성하기 전에 해당 이름 지정 단계를 먼저 기다리며, 이름 지정 중 오류가 발생하면 탭을 생성하지 않습니다.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# 사용자 탭
`browser.user.openTabs()`는 사용자 탭을 점유하지 않고 메타데이터만 반환합니다. `browser.user.claimTab(listedTabOrId)`는 선택한 정확한 탭의 제어권을 명시적으로 가져옵니다. `browser.tabs.get(id)`는 지연 바인딩을 반환하며 임의의 사용자 탭을 암묵적으로 점유하지 않습니다. 사용자 탭은 턴 정리 시 닫히지 않고 해제됩니다.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# 관리 탭 수명
생성된 탭은 현재 수명 주기에서 명시적으로 유지하도록 지정하지 않는 한 임시 탭입니다. `markDeliverable()`은 완료된 결과를 사용자를 위해 보존하며, `markHandoff()`는 같은 세션 내에서 이어서 작업할 수 있도록 탭을 유지합니다. 이러한 표시는 이전 페이지 권한을 유지하거나 다른 세션에 권한을 부여하지 않습니다. 닫기, 중지 및 결과가 불확실한 작업은 각자의 정리 요구 사항을 그대로 유지합니다.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# 브라우저 백엔드 가용성
현재 Maka 제공자 집합에는 브라우저 확장 프로그램과 구성된 CDP 연결만 포함되며, 내장 브라우저 백엔드는 추가되지 않습니다. 현재 목록의 ID를 사용하여 브라우저와 탭을 바인딩하세요. 내장 백엔드나 관리 기능 문서를 읽는다고 해서 해당 백엔드가 생성되거나 브라우저 관리 권한이 부여되지는 않습니다.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# 중단된 작업
취소는 이미 전달된 작업이 롤백되었다는 증거가 아닙니다. 원래 바인딩과 작업 결과가 확정될 때까지 유지하고, 다른 제공자를 통해 변경 작업을 반복하지 마세요. 재설정은 REPL의 바인딩을 지우며, 이후 작업은 현재 권한 아래에서 대상을 다시 바인딩해야 합니다.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# 브라우저 API 사용법
`agent.browsers`와 `cua.browsers`는 동일한 컬렉션을 공유합니다. 컬렉션 호출은 관찰을 출력하지 않고 데이터나 지연 바인딩을 반환합니다. `agent.documentation.get(name)`은 정확한 이름의 문서를 읽어 자동 출력 없이 텍스트 Promise를 반환합니다. `tabs.selected()`는 논리적 세션 활동을 따릅니다. 정확한 브라우저 ID와 기존 탭 바인딩은 제공자를 전환하지 않습니다.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# 접근성 관찰
요소 참조를 사용하기 전에 최신 접근성 상태를 읽으세요. `tab.ax`는 문서화된 접근성 작업을 노출하며 `get(mode, options)`는 자동 출력 없이 상태, 스크린샷 바이트 또는 둘 다를 반환합니다. 탐색이나 문서 변경은 이전에 관찰된 참조를 무효화할 수 있으므로 인덱스를 추측하지 말고 관찰을 새로고침하세요.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# 선택적 브라우저 기능
선택적 기능을 사용하기 전에 선택한 객체의 기능 컬렉션을 먼저 읽으세요. 문서 참조만으로 원시 CDP, WebMCP, 인증 또는 챌린지 처리 API가 활성화되지는 않습니다. 해당 컬렉션에 ID가 없으면 그 기능은 사용할 수 없으며, 기존 페이지 작업은 일반 권한 및 수명 검사를 계속 적용받습니다.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# 로컬 개발 페이지
대상 개발 URL에 도달할 수 있는 브라우저를 선택하고 해당 명시적 URL로 이동하세요. 로컬 호스트 이름에도 현재 워크스페이스 네트워크 정책과 페이지 출처 권한이 그대로 적용됩니다. 페이지를 확인하는 동안 선택한 브라우저 바인딩을 유지하세요. 다른 머신의 localhost는 서로 다른 대상입니다.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# 파일 업로드
선택한 브라우저 문서에 업로드 작업이 노출된 경우에만 이를 사용하세요. 업로드에는 페이지와 선택한 파일에 대한 별도의 현재 권한이 필요하며, 페이지 읽기 또는 다운로드 권한은 업로드 동의가 아닙니다. 파일 선택기는 이를 연 정확한 페이지 상호작용에 속합니다. 해당 페이지나 선택기가 더 이상 유효하지 않다면 이전 선택기를 재사용하지 말고 새 관찰부터 시작하세요.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# 스크린샷
`tab.getScreenshot()`은 스크린샷 바이트를 반환하며, 관찰 도우미 메서드는 이미지를 출력할 수 있습니다. 좌표를 결정하기 전에 탐색, 크기 조정 또는 스크롤 후 새로 캡처하세요. 스크린샷은 관찰 결과일 뿐, 이전 입력이 의도한 컨트롤에 도달했다는 증거는 아닙니다.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# 뷰포트 기능
크기를 변경하기 전에 `browser.capabilities.list()`를 읽고 게시된 뷰포트 기능을 가져오세요. 뷰포트 설정은 브라우저 세션의 논리적 활성 탭과 현재 수명을 따릅니다. 뷰포트 크기를 변경해도 관련 없는 OS 포커스 탭이 선택되거나 페이지 액세스 권한이 부여되지 않습니다.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# 페이지 리소스 기능
선택한 탭이 해당 기능을 게시한 경우에만 페이지 리소스를 사용하세요. 리소스 목록은 관찰된 페이지와 문서에 속합니다. 탐색이나 문서 교체 후에는 새 목록을 가져오세요. 이전 리소스 식별자는 다른 페이지의 파일에 대한 권한을 부여할 수 없습니다. 파일 저장에는 해당 작업의 현재 파일 전송 권한이 필요합니다.
<!-- /browser-document -->

### 파일 선택기 및 업로드

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

파일 선택기를 여는 작업을 수행하기 전에 먼저 대기를 시작하세요. 기본 파일 선택기 이벤트 대기 시간은 3000 ms이며, 명시적 제한 시간은 양의 정수여야 합니다. `isMultiple()`은 동기 메서드입니다. `setFiles(pathOrPaths, {timeoutMs})`는 단일 경로 또는 비어 있지 않은 배열을 받으며, 단일 파일 선택기는 여러 경로를 거부합니다. 선택적 제한 시간은 진행 중인 선택을 폐기하지 않고 유효성을 검사합니다.

경로는 Agent Host의 파일시스템을 가리키며 호출자의 워크스페이스 파일 정책을 그대로 따릅니다. 페이지 액세스, 현재 HTTP(S) 출처에 대한 업로드 동의, 파일 읽기 권한은 서로 별개입니다. 지원되는 입력 스냅샷은 일반 파일(regular file)입니다. 파일은 불변 바이트로 전송되어 선택한 Maka 브라우저 호스트에서 구체화되므로, 운영체제 간 경로를 직접 변환하지 마세요.

선택기 핸들은 발급된 탭, 문서 및 턴에 속합니다. 하위 대상(child-target) 선택기는 지원되지 않습니다. 확장 프로그램 선택기에는 완전한 소스 이벤트 출처 정보(provenance)가 필요하며, 업로드에는 검증된 브라우저 호스트 파일 배치도 추가로 필요합니다. Chatgpt는 최선 노력으로 지원되며, 이러한 파일 배치가 없는 구성된 CDP는 파일을 전송하기 전에 업로드를 거부합니다. 이 작업을 충족하기 위해 이미 바인딩된 탭을 다른 브라우저로 교체하지 않습니다. 선택에 성공하면 선택기 핸들이 소비됩니다. 결과가 불확실한 경우 재실행하지 말고 상태를 확인하여 조정해야 합니다.

정리 과정에서 확인되지 않은 결과가 보고된 경우, 복사된 업로드 데이터가 삭제되었다고 가정하지 마세요. 파일이 선택된 상태로 브라우저 호스트가 종료된 후 자동으로 회수하는 기능은 아직 제공되지 않습니다.
