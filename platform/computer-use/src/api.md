Computer Use is an independent persistent JavaScript REPL. Use cua_repl directly;
Code Mode is not required. Variables and bound objects survive calls and Turns within
the current Host process. A fresh REPL after restart has no variables from history;
follow the current Computer Use state supplied with the model request.
`cua.computer.target` identifies the selected desktop platform (`mac`, `linux`, `windows`).
In WSL it defaults to the Windows host; shell commands may still run in Linux.

`cua.computer` also exposes platform-native snake_case methods. These take an options object rather than the App/Tab positional arguments below; `list_apps()`, `list_windows()` and Linux `get_screenshot()` take no options. Discover the selected surface and read its inventory first:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Native methods (audio is documented separately) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: use a returned `window` object for `get_window_state({window, query?, include_screenshot?})`. Pass an observed `element_id` **or** integer `x,y` to `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`; window coordinates are local, and omitting `window` uses the desktop. Other inputs include `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` and `launch_app({app})`. `duration` is milliseconds. `drag_handle()` creates a desktop handle with `start({x,y})`, `move_to({x,y})`, `end()`; finish it explicitly within the turn.
- Windows: use the returned `{app,id,...}` window descriptor. Read `get_window_state({window, include_text?, include_screenshot?})` before indexed or screenshot input; screenshots default on, text off. Use `click({window,element_index})` or `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` and `launch_app({app})`. Set `screenshotId` to the returned screenshot `id` to use image coordinates. Without it, use integer window-local coordinates in the latest observed screenshot dimensions, or the window dimensions before a screenshot observation. Scroll accepts both `scrollX` and `scrollY` in the same call. Secondary actions currently support Expand/Collapse; other labels are refused.
- macOS: use a returned app `id` as `app`. Read `get_app_state({app})`, then call `click({app,element_index,mouse_button?,click_count?})` or `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (or `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})`, or `perform_secondary_action({app,element_index,action})`.

Native inventories and state shapes differ by platform; reuse returned IDs and selectors, not App-wrapper handles. Linux state returns `ax_tree` and `screenshots`; screenshot entries include `filepath`, `bytes`, `data_url`. Windows state emits its screenshot images. Other native results are returned for `nodeRepl.write`/`emitImage`; mutators return undefined. Current Host/app permissions still apply, and a present method may refuse an unavailable backend or unsupported operation. Refresh state after a stale-target error; do not replay input whose outcome is unknown. Do not carry an active drag across turns; refresh observations after reset.


A fresh REPL has no bound targets. The entry points below emit API documentation
and inventory or initial target state. Browser IDs come from configured CDP providers and connected Extension browser
providers. Exact IDs take precedence; only without an exact match do `maka` and `chatgpt` select a unique current Extension endpoint. If neither is available, use native browser windows through getApp. The API does not expose driver administration such as start_session.

ChatGPT and stock OpenCLI compatibility is best effort. Stock OpenCLI currently cannot serve this browser-session contract. Without an exact provider ID or extension-instance selection, `getBrowser({id: "opencli"})` selects a unique usable existing provider before any tab creation or claim; zero or multiple candidates refuses selection. Exact IDs and existing handles never switch providers.

Entry points (selection emits initial state):
- `await cua.getState({emit?})`: app and available browser inventory, including inventory errors.
- `await cua.listApps({emit?})`, `await cua.listWindows({emit?})`.
- `const app = await cua.getApp("Name / bundle ID / app path")` or `getApp({windowId})`.
  macOS launches a missing app. Windows getApp selects an already open window;
  use `await cua.computer.launch_app({app: appId})` with an ID from cua.listApps(),
  then refresh inventory and select its exact window.
  Select an exact window when names are ambiguous. Linux requires the app to be open already.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: select without opening a tab.
  A prospective URL need not be open already. Select an ID when multiple providers are available.
- `const tab = await cua.getTab("tab ID", {browser?})` or `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: open in the selected provider's profile.
  Here and in getBrowser, URLs without a scheme use HTTPS.
  Creation starts with an owned blank tab; an explicit URL then requests navigation.
  Refused navigation leaves that blank tab for turn cleanup.
  Unavailable providers, tab mentions and unsupported creation options throw.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`:
  list, bind an exact tab, or create a blank temporary tab in that browser. These methods
  return data without emitting it; get/new return Tab objects without an initial AX observation.
  Call getAXState before using observed targets. `await tab.title()` and `await tab.url()`
  return current metadata without changing the accessibility observation.

- Connected browser adapters also expose `await browser.user.openTabs()` and
  `await browser.user.claimTab(tabOrId)`. The listing returns current user-tab metadata;
  claiming returns the ordinary Tab after current permissions and attachment preparation.
  Use a listed string ID or a listed object. Turn cleanup releases user tabs without closing
  them; tabs created by this Session remain temporary. `browser.tabs.get(id)` remains a lazy
  binding and performs no initial claim or AX observation. These methods do not
  retain grants. For Extension providers, `browser.tabs.list()` lists this Session's
  managed tabs. Configured CDP providers omit `browser.user`; use their
  `browser.tabs` methods instead.

Maka exposes an AX browser profile: `tab.ax` contains `get`, `write`, `click`,
`drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`,
`setValue` and `typeText`. Action signatures match the Tab methods below.
`await tab.ax.get(mode = 'state', {disableDiffing?})` returns text, image bytes or
`{state, screenshot?}` for `state`, `screenshot` or `both`, without emitting.
`await tab.ax.write(mode = 'state', options?)` emits the available results and
returns undefined. The existing flat Tab methods remain available.
The AX facade and flat methods act on the same bound Tab.

App and Tab observations:
- `getAXState({emit?, disableDiffing?})` returns text. Tabs and macOS apps use a diff by default;
  Windows and Linux apps return the complete state.
- `getScreenshot({emit?})` returns Uint8Array and emits the image.
- `getAXStateAndScreenshot(options?)` returns `{state, screenshot?}` and emits the available results.
Discovery, selection and observations emit automatically. Call them directly;
wrapping `getScreenshot()` in `nodeRepl.emitImage()` or `getAXState()` in
`nodeRepl.write()` is redundant. Use `{emit:false}` when processing the result
yourself; inventory errors still appear. Native Windows screenshot methods reject
`{emit:false}` before capture. Identical images emitted within one call
are delivered once. A later call may emit the same image again.
Observations include a bounded settling window for brief UI updates (200 ms for
tabs, 400 ms for apps). This does not wait for arbitrary asynchronous work;
continuous animation does not extend the window. Refresh to observe later updates.
A successful screenshot of the same unchanged browser document preserves existing
AX references. After navigation, document replacement or target invalidation,
refresh `getAXState()` before reusing indices; also refresh for newly observed elements. Native Linux/Windows retain previously observed element identities
while those exact elements remain valid.
If a native AX observation fails while an app is busy, refresh the same bound object
when the app responds again. Failed observations invalidate old indices and coordinates.

App and Tab actions:
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Native apps also accept mouse buttons `l/r/m` and directions `u/d/l/r`.
  macOS trims and ignores case for these names and also accepts buttons `0/1/2`
  for left/right/middle.
- `setValue(index, string)`; unavailable for native Linux apps.
- `selectText(index, text, {prefix?, suffix?, selectionType?})` where selectionType is
  `text`, `cursor_before` or `cursor_after`. Native selection is macOS-only.
  `text_not_found` means the text or supplied context is absent; read the current
  state again. `ambiguous_text` requires a more specific prefix/suffix.
- `performSecondaryAction(index, action)`: use an exact action listed in the native
  AX observation. CDP does not expose secondary actions and rejects this method.

App input: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Tab input: `typeText(index|null, text)`, `paste(index|null, text, {format?})`,
`pressKey(index|null, key)`. A supplied index focuses the observed field first.
Use `null` for current focus. Key examples: `Return`, `Tab`, `super+a`, `shift+Left`.
Paste formats: `text` (default), `md` (Markdown source as plain text), and `html`.
Native Linux and Windows apps support only `text`.
Native HTML paste is macOS-only and needs a readable editable value and selection. It temporarily
activates the exact window, preserves its selection, and restores the prior clipboard
unless the user copied something newer. An unchanged value is reported as uncertain.
Browser HTML paste requires an observed contenteditable element.

Tab navigation: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` returns JPEG bytes without emitting an image. Omit `clip` for the viewport; `fullPage: true` captures the document. Clip width and height must be positive. Coordinates and dimensions use CSS pixels. Viewport capture first tries a fresh screencast frame and then the same tab's screenshot command after acknowledged cleanup; uncertain operations are not replayed.

On Extension providers, `await tab.markDeliverable()` keeps the tab open at normal turn end and releases it to the user. `await tab.markHandoff()` retains the tab for this same Session; the next actual turn resumes it with no mark. The original agent/user origin is preserved, so an agent-created tab closes at a later unmarked turn end. A later explicit mark replaces the previous mark. Both methods return undefined after the matching intent ACK, which does not prove physical delivery or cleanup. Marks retain no site permission; an uncertain call is not replayed. Direct CDP does not support these marks.

`tab.clipboard` provides `read()`, `readText()`, `write(items)` and `writeText(text)`.
These methods return values without emitting them. A rich item has nonempty `entries`;
each entry has `mimeType` and exactly one string field, `text` or `base64`. Optional
`presentationStyle` is `unspecified`, `inline` or `attachment`. For example,
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
The virtual data is shared by tabs using the same configured backend context;
it does not read or change the OS clipboard. Authorized pages use the same data
through their Clipboard API after installation. Agent `readText()` returns the
first exact `text/plain` entry's text, or an empty string for a base64-only entry;
the page's `readText()` decodes that entry through a Blob. Turn cleanup removes
page bridges and preserves stored data. Reset creates a fresh empty context.

Wait methods return undefined. `locator.waitFor({state, timeoutMs?})` requires
`state: 'attached'|'detached'|'visible'|'hidden'` and tests the first match;
no match satisfies `detached` and `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` matches the full URL:
`*` stays within a slash-delimited segment, `**` may cross slashes, and other
characters are literal. The default `waitUntil` is `commit`; `load`,
`domcontentloaded` and `networkidle` wait for that state after a match.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` defaults to `load` and also
accepts `domcontentloaded` and `networkidle`. These condition waits default to
3000 ms and cap numeric timeouts at 3000 ms. Zero leaves no event-wait budget:
a locator still gets its first probe, current URL/load state may already match,
and networkidle times out. `tab.playwright.waitForTimeout(ms)` accepts a nonnegative
integer and waits for a fixed duration. For an action-triggered wait, start the
wait before the action, then await both promises. Stop cancels the original wait.

`tab.playwright` resolves DOM locators without requiring a preceding AX observation.
Use `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`
or `getByTestId`; `frameLocator(selector)` enters a frame. Locators support
`first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`,
`textContent`, `innerText`, `getAttribute`, `isEnabled` and `isVisible`.
`domSnapshot()` returns the page's DOM accessibility text.

Locator input methods return undefined: `click(options?)`, `dblclick(options?)`,
`fill(text, options?)`, `type(text, options?)`, `press(key, options?)`,
`pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`,
`setChecked(boolean, options?)`, `check(options?)` and `uncheck(options?)`.
Click options accept `button: 'left'|'right'|'middle'`, `modifiers`, `force` and
`timeoutMs`; check options accept `force` and `timeoutMs`. Modifiers are `Alt`,
`Control`, `ControlOrMeta`, `Meta` and `Shift`; `ControlOrMeta` uses the selected
browser's platform. Other input options accept `timeoutMs`. Timeouts are positive
integers; preparation defaults to 3000 ms and is capped there, or at 5000 ms for
sequential input. An option selection accepts a value string or a descriptor with
`value`, `label` or a nonnegative integer `index`; arrays select multiple options.

Locator mutations use a unique match or the sole visible match. Ambiguous matches
throw. Ordinary text fill/type use a virtual paste event, respect a page handler's
cancellation and preserve the stored clipboard. An empty paste does not erase a
value by default. Clipboard keyboard shortcuts use the same virtual clipboard;
unsupported combinations throw before sending native keys. Successful writes clear
only the calling locator collection's cached reads. Input results must still be
checked in the page; an uncertain result is not automatically replayed.

Downloads use a connected Extension provider with download notifications and current
Host download permission. Arm before triggering the action on the same Tab:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
then perform the click or navigation and `const download = await pending`.
`await download.path({timeoutMs?})` returns the browser-reported filename or null.
It neither transfers a file nor proves that a path belongs to this task; it may be
a path on another host, empty, or unavailable. It has no saveAs operation.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` requests media
for a unique matching locator. Download waits return data without emitting it;
media triggers return undefined. The native start deadline ends at the first
matching Started event; cancellation and Host cleanup still apply afterward.
Read permission and download permission are separate, including for a different
source or destination origin. A configured CDP connection alone does not provide
native download notifications.
Maka also exposes `tab.cua.downloadMedia({x,y,timeoutMs?})` and
`tab.dom_cua.downloadMedia({node_id,timeoutMs?})` as narrow extensions. The selected
Extension providers currently reject these coordinate/node media commands; use the
implemented locator route. An uncertain download result is never automatically retried.
The returned handle retains its original Tab binding, not a grant. Keep that tab
available: `path()` rechecks current tab metadata and Host permissions before its
cache lookup. A stale handle cannot keep a closed tab alive. Later Turns still
require current tab access; claiming the tab again may be necessary.

`await tab.getJsDialog()` returns undefined or the current dialog object with
`type` and `dismiss()`. Confirm dialogs also have `accept()`; prompt dialogs have
`accept(text)`, including an empty string. Old dialog objects cannot act on a
replacement dialog. Handle an active dialog before ordinary page reads or input.
`getAXState()` shows its message and indexed controls; prompt controls support
`setValue`, `typeText` and Return/Escape. Dialog controls have no page coordinates.
Screenshots are unavailable while a dialog is open: screenshot-only calls throw,
and combined observations return the dialog state without a screenshot property.
An attached browser Host automatically accepts beforeunload dialogs while it owns
current control. Turn cleanup detaches control without closing user tabs.

Navigation supports HTTP(S) and about:blank and waits for an observable document.
The main CDP target is covered; cross-process iframe accessibility is not complete.
CDP page distances accept finite numbers, including fractions, zero and negative
values. One page uses the target's content width or height, with a minimum of
100 CSS pixels; coordinate targets use the viewport. CDP's `{pixels:n}` extension
accepts positive finite pixel deltas.
Linux rejects numeric page counts. Linux X11 defaults to `{pixels:800}` and accepts integer pixel distances from 1 to
65535. It sends `max(round(pixels/100),1)` wheel steps; the application determines
the resulting content movement. Linux Wayland currently refuses pixel input.
macOS scrolling takes positive finite numeric pages, defaulting to one, and rejects
`{pixels}`. The current native adapter can deliver only integer page counts from
1 to 50; fractional or larger page counts remain unsupported.
Windows requires a coordinate point and a positive finite `{pixels:500}` distance;
omitted distances and numeric page counts are rejected. Coordinates and direction-signed distances use JavaScript
`Math.round`; rounded inputs must fit signed 32-bit integers. Native wheel deltas
are bounded per axis to [-32768,32767], and the pointer stays at the target.
The application determines content movement. Native indexed scrolling preserves the selected accessibility
target. App-wrapper native indexed clicks support one semantic click; use
screenshot coordinates for multiple clicks. Raw macOS `cua.computer.click` also
supports multiple indexed clicks through simulated mouse events.

A successful input dispatch does not establish the resulting application state.
Browser coordinate actions use CSS viewport coordinates and require no screenshot.
Screenshots do not scale these coordinates.
Linux window-local coordinates can be used without taking a screenshot. Native
Linux/Windows screenshot mappings survive input actions until another observation
replaces them; an AX-only observation clears the image mapping. Windows coordinate
input then requires another screenshot. A window geometry change invalidates a
stored mapping. macOS coordinate input currently requires a fresh screenshot after
an action.
Native semantic actions use retained accessibility elements. Application menus
are scoped to their owning process and the exact bound window; closed menu
contents are omitted until the menu is opened. Menu interaction may activate the
bound window and keeps it active while the menu is open.
macOS/Windows coordinate and keyboard input use the exact window's foreground
route; macOS restores the prior application after delivery where supported.
Linux keeps background delivery. Coordinate input can move the system pointer.
Unverified input effects are reported in the call output. There is no public
`delivery_mode` option or automatic replay.

`nodeRepl.write(value)` emits text/JSON. `await nodeRepl.emitImage(bytes | dataUrl |
{bytes, mimeType})` emits an image. File/HTTP image URLs, Node, arbitrary filesystem
and network APIs are unavailable. `cua.rewriteDocumentation()` reprints this reference.

When the Host enables output audio, `await cua.computer.start_audio_recording({max_duration_ms?})`
starts recording and returns undefined while other calls can continue. The duration defaults
to 60000 ms and accepts integers from 100 to 300000. `await cua.computer.stop_audio_recording()`
returns `{filepath, bytes, data_url}` for the finalized stereo 24 kHz PCM16 WAV. Reaching the
duration ends capture; call stop to retrieve it. `await nodeRepl.emitAudio(bytes | dataUrl |
{bytes, mimeType})` emits audio explicitly. These methods are absent when audio is disabled.
Reset and Session cleanup discard recordings and their local paths.

Every operation uses current Host permissions; JS objects retain no grants.
In Ask mode, Computer Use approval happens before the REPL execution timeout starts.
App, browser-site and audio consent waits pause the remaining budget. Native
macOS/Windows waits also pause it; ordinary asynchronous waits and Linux native
operations consume it. Pausing never refills the budget or disables cancellation.
Native macOS operations report `desktop_locked` while the screen is locked; connected
CDP providers and pure REPL computations remain independently available.
Each Session has its own Maka cursor. Input actions show it automatically.
`cua.cursor.configure({label?, color?,
enabled?, reducedMotion?})` changes this Session's display. Colors are `blue`, `mint`,
`violet`, `amber`, `rose`, `cyan`; labels allow up to 48 characters. `cua.cursor.getState()`
reports settings and native/browser visibility. A native renderer in `idle` state starts
on the first native indication; `unavailable` reports a missing/failed display host.
Configure again to retry a failed renderer. Idle cursors remain until disabled or cleaned up.
Cursors share no input authority and do not move the system pointer. Multiple cursors
do not isolate the physical keyboard, application focus or input method.
Cancelled, timed-out or heap-exhausted REPLs require `cua_reset`, then target rebinding. Admitted
native work settles before returning; reset does not undo dispatched input.
At normal turn end, this Session closes unmarked temporary tabs it created and releases its page observations.
Preexisting user tabs and marked retained tabs remain open under the rules above. Reset clears this Session's
REPL and bindings; it does not grant new access or erase this Session's retained resource and cleanup obligations.
An unconfirmed mark or close retains custody and is not replayed.

The same browser collection is available as `agent.browsers` and `cua.browsers`.
Its `list`, `get(id)`, `getDefault`, and `getForUrl(url)` methods return metadata
or lazy Browser objects without emitting an observation. `cua.getBrowser` is the
convenience entry point that emits documentation. A Browser exposes `tabs.selected()`
for its logical session's active tab; this does not select the OS focused tab.
The current direct CDP provider has no logical-session active-tab service and
returns `undefined` from `selected()`.

`await browser.nameSession(name)` trims and stores the session's managed group
title. Existing managed presentation is updated through its owned receipts;
future created tabs use the stored title. `cua.createBrowserTab(id, url,
{sessionName})` resolves the browser and awaits naming before creating the tab.
The current browser profile does not offer the visibility capability.

`await browser.history({queries, limit, from, to})` reads profile-wide history
through an extension that advertises the separate history transport. It requires
independent `browser_history` consent for the actual browser ID and generation
under the current Session permission boundary. Page and download grants do not
authorize it. No history request is automatically granted by page-origin policy.
The default is a whole-history query limited to 100 entries; supplied query
results are combined by descending visit time, deduplicated by URL, then limited.
The bundled Maka extension declares Chrome's history permission; an older
installed extension without that permission advertises no history support.
ChatGPT and other third-party adapters remain best effort.

- `await browser.user.getTabContext(tabOrId)` reads context from a currently visible
  user tab without claiming or focusing it. The current tab URL is authorized by
  the Host; callers cannot supply a replacement URL. Private tabs and a URL that
  changes during an individual read are refused. The result is either
  `{kind:'text',text,title,url,truncated}` or
  `{kind:'document',data,fileName,mimeType,title,url}`, where `data` is a
  `Uint8Array` containing the actual exported file. When the Host provides file
  publication, documents also include a real Session-owned `path`. Google
  Workspace documents can supply Markdown, PDF or XLSX context; ordinary pages
  can include the current selection, and YouTube watch pages can include a
  transcript. The `maka` provider implements the fixed reads; `chatgpt` reuses its
  stock read protocol when supported. Third-party support remains best effort.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` evaluates a
  self-contained function against the current page. A string is treated as an
  expression. Locator variants pass `(element, arg)` to `locator.evaluate` or
  `(elements, arg)` to `locator.evaluateAll`; the single-element form requires
  an unambiguous target and the all-elements form accepts an empty match.
  Arguments must be JSON-serializable. Results are plain data; functions and
  symbols are omitted, big integers become strings, and non-finite numbers
  become `null`. This API limits result depth to 8, arrays to 2000 entries,
  objects to 200 keys and strings to 200000 UTF-16 units, with `[MaxDepth]`,
  `[Circular]` and `[Truncated]` markers where applicable.
- Evaluation exposes read-only DOM, CSS, geometry, range and selection views.
  It does not expose networking, cookies, module loading or DOM edits. Scrolling,
  local range boundaries and function-only timers remain supported operations.
  The timeout defaults to 3000 ms and numeric values are clamped to 0–3000 ms.
  A stopped or interrupted script may already have run; it is not automatically
  executed again. Existing site permissions and tab ownership still apply.

Browser pointer input is available through `tab.cua.move({x,y,keys?})`,
`click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`,
`drag({path:[{x,y},...],keys?})` and
`scroll({x,y,scrollX,scrollY,keypress?})`. Coordinates and distances are CSS
viewport numbers and retain fractional and negative values; buttons are 1 (left),
2 (middle) or 3 (right). Pointer modifier names are Alt, Control, Meta, Shift and
ControlOrMeta. `tab.cua.keypress({keys:[...]})` sends a chord to the current focus;
`tab.cua.type({text})` pastes text at the current focus through the browser's
virtual clipboard, preserving stored clipboard data. Text may include Markdown;
Google Sheets receives plain text. These input methods return undefined and do
not retry an uncertain input.

`await tab.dom_cua.get_visible_dom()` returns visible interactive HTML with
string `node_id` values. Use those exact strings with `click({node_id})` or
`double_click({node_id})`; `scroll({node_id?,x,y})` takes scroll distances and
uses the viewport center when node_id is omitted. `keypress({keys:[...]})` and
`type({text})` use current focus, not a node ID. DOM methods return undefined
except the snapshot. A new snapshot retires missing DOM nodes; navigation or
frame replacement can make a node stale. Observe again rather than guessing an
ID or replaying an input whose result is unknown.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Browser troubleshooting
Read `cua.getState()` and `agent.browsers.list()` to identify the available browser and its exact ID. A configured connection is not proof that a particular action succeeded. When a binding is stale or its outcome is unknown, inspect current state before choosing the next operation; an uncertain mutation must not be repeated automatically.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Browser authority
A browser binding does not preserve permission. Operations use the current Session, turn, workspace policy and page origin. Consent for reading a page does not authorize file transfers or profile-wide history. A refused approval, closed Session or changed permission boundary must be handled before further action.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Browser visibility
Read `browser.capabilities.list()` to determine whether this browser publishes a visibility capability. A documentation name is not evidence that the capability is enabled. When visibility is absent, passing a `visible` option to tab creation refuses before creating the tab.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Session naming
`await browser.nameSession(name)` assigns a nonempty trimmed title to this browser Session's managed tab group and future created tabs. `cua.createBrowserTab(id, url, {sessionName})` awaits that naming step before creating a tab; a naming error does not create the tab.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# User tabs
`browser.user.openTabs()` returns user-tab metadata without claiming those tabs. `browser.user.claimTab(listedTabOrId)` explicitly acquires the exact chosen tab. `browser.tabs.get(id)` returns a lazy binding and is not an implicit claim of an arbitrary user tab. User tabs are released rather than closed during turn cleanup.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Managed tab lifetime
Created tabs are temporary unless their current lifecycle explicitly retains them. `markDeliverable()` preserves a finished result for the user; `markHandoff()` retains a tab for continuation within the same Session. These marks do not preserve old page permissions or authorize a different Session. Closing, stopping and uncertain effects retain their own cleanup requirements.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Browser backend availability
The current Maka provider set contains browser extensions and configured CDP connections; it does not add an embedded-browser backend. Bind browsers and tabs using IDs from current inventory. Reading a reference for an embedded backend or management capability does not create that backend or grant browser-management authority.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Interrupted operations
Cancellation is not evidence that a dispatched operation was rolled back. Keep the original binding and operation outcome until they have settled; do not repeat a mutation through another provider. A reset clears the REPL's bindings, and subsequent work must bind targets again under current permission.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Browser API use
`agent.browsers` and `cua.browsers` share the same collection. Collection calls return data or lazy bindings without emitting an observation. `agent.documentation.get(name)` reads an exact named document and returns a Promise for its text without emitting it. `tabs.selected()` follows logical Session activity. Exact browser IDs and existing tab bindings do not switch providers.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Accessibility observations
Read a fresh accessibility state before using its element references. `tab.ax` exposes the documented accessibility operations and `get(mode, options)` returns state, screenshot bytes or both without automatic emission. Navigation or a changed document can invalidate previously observed references; refresh the observation rather than guessing an index.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Optional browser capabilities
Read the selected object's capability collection before using an optional capability. A documentation reference does not enable raw CDP, WebMCP, authentication or challenge-handling APIs. If its ID is absent from that collection, the capability is unavailable; existing page operations keep their normal permissions and lifetime checks.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Local development pages
Choose a browser that can reach the intended development URL and navigate to that explicit URL. A local hostname is still subject to the current workspace network policy and page-origin authorization. Preserve the selected browser binding while checking the page; another machine's localhost is a different destination.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# File uploads
Use upload operations only when the selected browser documentation exposes them. An upload needs its own current permission for the page and chosen files; a page-read or download grant is not upload consent. A file chooser belongs to the exact page interaction that opened it. If that page or chooser is no longer current, start from a new observation instead of reusing an old chooser.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Screenshots
`tab.getScreenshot()` returns screenshot bytes; observation helpers can emit the image. Use a fresh capture after navigation, resize or scrolling before deciding coordinates. A screenshot is an observation, not proof that earlier input reached its intended control.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Viewport capability
Read `browser.capabilities.list()` and obtain the published viewport capability before changing size. Viewport settings follow the browser Session's logical active tab and its current lifetime. Changing viewport size does not select an unrelated OS-focused tab or grant page access.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Page asset capability
Use page assets only when the selected tab publishes that capability. Asset inventory belongs to the observed page and document. After navigation or document replacement, obtain a fresh inventory; old asset identifiers cannot authorize another page's files. Saving files requires the operation's current file-transfer permission.
<!-- /browser-document -->

### File choosers and uploads

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Start the wait before the action that opens the chooser. The default and maximum chooser event wait are 3000 ms; an explicit timeout must be a positive integer. `isMultiple()` is synchronous. `setFiles(pathOrPaths, {timeoutMs})` accepts one path or a nonempty array; a single-file chooser rejects multiple paths. Its optional timeout is validated without discarding an in-flight selection.

Paths refer to the Agent Host's filesystem and remain subject to the caller's workspace file policy. Page access, upload consent for the current HTTP(S) origin, and file-read permission are separate. The supported input snapshot is a regular file. Files are transported as immutable bytes and materialized by the selected Maka browser host; do not translate paths between operating systems yourself.

Chooser handles belong to their issued tab, document and turn. Child-target choosers are unsupported. Extension choosers require complete source-event provenance; uploads additionally require verified browser-host file placement. Chatgpt is best effort, and configured CDP without such placement refuses upload before sending files. An existing bound tab is never replaced with another browser to satisfy the operation. A successful selection consumes the chooser. An unknown outcome must be reconciled rather than replayed.

If cleanup reports an unconfirmed result, do not assume copied upload data has been deleted. Automatic reclamation after the browser host exits while files remain selected is not yet available.
