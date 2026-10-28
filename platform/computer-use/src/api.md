Computer Use is an independent persistent JavaScript REPL. Use cua_repl directly;
Code Mode is not required. Variables and bound objects survive calls and Turns within
the current Host process. A fresh REPL after restart has no variables from history;
follow the current Computer Use state supplied with the model request.
`cua.computer.target` identifies the selected desktop platform (`mac`, `linux`, `windows`).
In WSL it defaults to the Windows host; shell commands may still run in Linux.

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
  then refresh inventory and select its exact window. Launch revalidates the ID
  against native inventory; arbitrary executable paths are not accepted.
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
implemented locator route. These objects do not imply other `.cua` or `.dom_cua`
input methods. An uncertain download result is never automatically retried.
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
target. Native indexed clicks support one semantic
click; use screenshot coordinates for multiple clicks when needed.

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
At turn end, this Session closes temporary tabs it created for that turn and releases its page observations.
Preexisting user tabs remain open. Reset clears this Session's REPL and bindings and closes its temporary tabs;
it leaves user apps and preexisting tabs open. An unconfirmed close retains ownership and is not replayed.
