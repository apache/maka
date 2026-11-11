# Packaging and embedding

- `nsh package <entry> --target ios|ios-simulator|android|linux|macos|windows` builds an installable app from the prebuilt runtime: metadata from
  `nsh.json` next to the entry (`name`, `id`, `version`, `build`, `icon`; `appearance` also sets `UIUserInterfaceStyle`
  and a dark window theme, so the launch screen is in it) or flags. iOS and macOS packages add the app's
  `ios` / `macos` `infoPlist` keys and `entitlements` (`crates/nsh-cli/src/apple.rs`: JSON as property list values,
  the keys NSH sets refused with what to set instead; `MinimumOSVersion` / `LSMinimumSystemVersion` are the runtime's
  minimum, `IOS_MINIMUM` / `MACOS_MINIMUM`, which an app may raise but not lower (checked when `nsh.json` is read;
  `actool` compiles the iOS icon for the version declared); device builds check entitlements against the profile,
  which keeps the app's values in place of its own). iOS: `.app`, `.ipa` with `--sign <identity>
  --profile <file.mobileprovision>` (entitlements come from the profile; icons are compiled by `actool` into `Assets.car`).
  Android: an APK assembled without Gradle (`aapt2 link`, native libraries stored uncompressed and 16 KB ZIP aligned, `apksigner`;
  the debug key unless `--keystore`). Linux: a directory `<name>/` with the release runner (`crates/nsh-linux-app`) as
  the executable, `nsh/bundle.nshc`, `nsh/assets/` and `nsh/app.json` (the window title, the GTK application id and
  nsh.json `window`, the main window's options, which the runner reads next to itself), `<id>.desktop` (`StartupWMClass`
  is the id, which GTK makes the window's app id) and `<id>.png`, plus the same as `<name>.tar.gz`; GTK 4, Pango and
  WebKitGTK 6.0 (the runner's default `webview` feature, `linux.md`) must be installed where it runs. macOS:
  `<name>.app` with the release runner (`crates/nsh-macos-app`) as `Contents/MacOS/<executable>`,
  `Contents/Resources/nsh/` holding `bundle.nshc`, `assets/` and `app.json` (the window title, appearance and nsh.json
  `window`), the icon as `AppIcon.icns` (`sips`), signed ad hoc (`codesign -s -`); `--run` opens it.
  Windows: a directory `<name>\` with the release runner (`crates/nsh-windows-app`, a windowed program: no console)
  as `<name>.exe` (characters Windows forbids in file names dropped), the icon embedded as its icon group 1 (which the
  window class loads, and Explorer and the taskbar show) with Windows' resource update API (`crates/nsh-cli/src/windows.rs`:
  16 to 64 pixels as DIBs plus a 256-pixel PNG; packaging off Windows keeps the runner's icon, with a warning), and
  `nsh\bundle.nshc`, `nsh\assets\` and `nsh\app.json` (the window title, the app id, which groups the app's windows in
  the taskbar, the version, the appearance, which the window opens in, and nsh.json `window`, the main window's
  options); plus the same as `<name>.zip`. No tools are needed; `--run` launches the executable.
  GPUI is the backend for embedding in GPUI and GPUI Kit apps (below), which ship it in their own executable: `nsh
  package` refuses `--target gpui` and names this OS's target, the one backend each desktop packages apps with.
- Links: `nsh.json` `"schemes": [...]` names the URL schemes a packaged app claims (checked by
  `nsh_core::url_scheme::schemes_from_json` in the bundler, the CLI and a Rust app's generated root). `nsh package`
  declares them to the system (`CFBundleURLTypes` on macOS and iOS) and writes them to `app.json`, which the runner
  reads with the app's id (`nsh_engine::Bundle::url_schemes`; a Rust app's `Root::url_schemes`), never
  from the app's code. The platform reports every URL the system opens the app with as the root's `UrlScheme` event; the
  core drops the links of other schemes and keeps the rest until the app listens (`UrlScheme.on("open")`,
  `next_url_scheme_open()`). Links are untrusted input: the app checks what they ask for, and nothing navigates on its own.
  A signed package embedded in another app claims no schemes: the embedding app owns them.
- Android's `libnsh.so` uses 16 KB ELF LOAD alignment and a 16 KB-aligned RELRO end, set by `nsh-platform-android/build.rs` and
  the generated Android runtimes' build scripts. `cargo xtask android` checks every linked library's LOAD alignment
  with the NDK's `llvm-objdump` before copying it into the runtime; `cargo xtask dist` uses the same checked libraries
  for the APK runtimes and AARs. APK ZIP alignment is checked separately by `zipalign -c -P 16 -v 4 <app.apk>`.
- Release runtimes' `lib/<abi>/libnsh.so` is stripped with the NDK's `llvm-strip --strip-unneeded` (a quarter of each
  library, which APKs store uncompressed; the dynamic symbols JNI needs stay), and checked again; `symbols/<abi>/`
  keeps the linked library for `ndk-stack` and Play Console. The AARs carry the linked libraries: Gradle strips what
  it packages and extracts the symbols itself.
- The AARs carry `proguard.txt` (`AAR_KEEP_RULES` in `crates/xtask/src/dist.rs`), which an app's minified build
  applies: `libnsh.so` finds `TextLayouts`, `NshView`, `Net` and `TestAgent` and their members by name over JNI
  (`JNI_OnLoad` fails without them) and binds the `native` methods of `Native`, `Net` and `SelectableView` by name,
  while Java code names few of them, so R8 removed or renamed them (`ClassNotFoundException: TextLayouts`). The rule
  keeps the whole package rather than a list that a new JNI lookup would have to extend, including the
  package-private `NshView.handle` field custom Rust hosts read. Hosts packaging the Java sources or `classes.jar`
  themselves include the same consumer rule, plus rules keeping their own JNI bridge names.
- Fonts the host ships: `NshView.registerFont(byte[])` and `NshAppView.registerFont(_:)` register a TrueType, OpenType, WOFF or WOFF2 file with the view, before a load or while an app runs. Apps then set `fontFamily` to the family name in the file and do not import it, so the file is not packed into each bundle. The same file registered again is kept once.
- Embedding: iOS apps link `NativeShell.xcframework` and `import NativeShell` (Swift: `NshAppView`, a `UIView`;
  `NshTrust`, `NshPackage`, `NshLimits`, `NshError`); Android apps add `nsh.aar` and use `com.longbridge.nsh.NshView`.
  `*Dev` / `-dev` variants can also load from a dev server. See `examples/embed-*`. Rust desktop apps use the platform
  crate itself: `nsh_platform_linux::AppView` (a GTK widget), `nsh_platform_macos::AppView` (an `NSView`) or
  `nsh_platform_windows::AppView` (a child window of the app's `HWND`, run by the app's message loop; `windows.md`).
  An embedded macOS view draws no window background of its own: to show what is behind the window (a
  `macos={{ backdrop }}` with `behindWindow`, a translucent panel), the embedding app makes its `NSWindow`
  nonopaque with a clear `backgroundColor` itself. `AppOptions::transparent` supplies a custom `run_app` host's
  initial default; explicit main-window attributes and later window updates take precedence. Standard hosts
  leave that option false but can request transparency through their window configuration. A view's
  `behindWindow` material does not enable window transparency. An `AppView` never changes its host's window.
  GPUI and GPUI Kit apps use `nsh_platform_gpui::AppView`, a GPUI view (`gpui.md`): `let view = cx.new(|cx|
  AppView::new(options, window, cx));` inside a window, `view.read(cx).load(App::Js(bundle))`, then put the entity in
  any element tree (in a GPUI Kit window, as a child of its `Root`); it fills the space its parent gives it and takes
  the focus it is given (`Focusable`). The crate depends on `gpui-fast` 0.1 from crates.io (re-exported as
  `nsh_platform_gpui::gpui`); GPUI Kit's `gpui-fast` feature makes `gpui_component` use that same crate, so both share
  one GPUI. `open_app_window` opens a window showing an app in a running GPUI app.
- **An application-owned Tokio runtime (Rust-linked mobile hosts)**: iOS `SurfaceOptions::runtime` and Android
  `nsh::set_runtime(handle, runtime)` (`host.rs`) forward an optional `tokio::runtime::Handle` to
  `EngineConfig::runtime`, per view; `None` keeps the process-wide shared runtime. Both are read each time an engine
  starts, so a change applies from the next load and a running engine keeps its runtime. NSH only clones the handle;
  the app owns the runtime. The engine's `runtime` tests cover it (`nsh-engine/tests/engine/runtime.rs`).
- **Native components** (`nsh`'s `nativeComponent`; `component.rs`, `ComponentBox.java`): the embedding app registers its own native
  views by name — Swift `NshAppView.register(component:) { context in … }` (`NshComponent`: `view`, `setProp`,
  `command`), Java `NshView.registerComponent(name, factory)` (`NshComponent`), Rust `AppView::register_component`
  (`NativeComponent`) — one registry per view, no globals. An app's own crate (`nsh.json` `"rust"`) registers into
  the hosts and runners nsh generates for it with `#[native_components(<platform>)]` (Windows, macOS, Linux, iOS:
  the platform's `set_components`, which every `AppView` calls on its registry when it is made, so a name registered
  on the view afterwards replaces the crate's; a process-wide function as `set_ui_sets`' sets are, which only the
  generated hosts and runners set, so an embedding app's registries stay its views'; `docs/dev/tooling.md`). Names under `nsh/` are NSH's own
  (`nsh_core::platform::is_reserved_component`): each backend registers them itself (`nsh/tab-bar`, `nsh/mobile`'s
  `TabBar`, on iOS and Android) and refuses an embedding app's registration of one with a warning. JS declares one with `nativeComponent<P, E>(name, { props,
  events })`; the element is a `<native>` leaf: `component` names it, each own prop goes as `$name` (any JSON value,
  `nsh_core::JsonValue`, sent when it changes; `undefined` removes it), view props (style, classes, accessibility, `ref`)
  stay the box's. The core sends `Create` (`ViewKind::Native`, a box decorated and placed like any view), then
  `MountItem::Component { name }` and `ComponentProps` (all props, then the changed ones). The component fills the box,
  emits events (`ComponentContext::emit` → `onNativeEvent` `{ name, data }` → the `on<Name>` handler) and may report
  its own size (`set_size`; the leaf measures to it where the style leaves a dimension open, like an image's natural
  size). A component is destroyed once, when its element is deleted or its app stops: on Android a stopped engine
  sends no `Delete`, so `NshView.destroy()` and a load replacing the app (`Host::load` → `NshView.appStopped`) call
  `NshComponent.destroy()` on every component still alive (`Mounter.destroyComponents`). `ref.command(name, args)` → `Command::Native`. Unknown names render an empty box (warned once). Props and events
  cross the C ABI / JNI as JSON text (Swift `JSONSerialization`, Java `org.json` as maps and lists). Registered
  components are the embedding app's own code: capabilities do not apply to them.
  An own prop given an animated value (JS: an `AnimatedNode` as the prop; Rust: `NativeView::bind_animated_prop`) is bound
  instead of sent: `Prop::ComponentPropBinding`, a slot per name (`AnimationProp::ComponentSlot(n)` among the view's
  `AnimationBindings`, the names in `MountItem::ComponentPropSlots`, sent before the bindings that use new slots). The
  platform evaluates it with its graph and hands the component the value on the frames it changed, on the main / UI
  thread with no JS: `setAnimatedNumber(name, double)` / `setAnimatedColor(name, argb)` (Java, Swift; `set_animated_number`
  / `set_animated_color` on the Rust traits), whose defaults call `setProp` with the number. De-duplicated per (view,
  slot): Android in `ComponentBox` (the outputs, codes `70000 + n` for a number and `140000 + n` for a color, come every
  frame), iOS in `ComponentHost`, the desktops in `Animator::write_components`; a component attached after its bindings
  gets the values then, and bindings that change are handed over again. While bound, a static value of the same name is
  kept but not sent; unbinding (JS: the prop is a plain value again) sends it, or `None`. The C ABI takes the callbacks
  through `nsh_app_register_component_with_animation` (`NshComponentAnimationCallbacks`); `nsh_app_register_component` is
  unchanged and its components get the values as `set_prop` JSON. GPUI delivers them with the next frame;
  the web has no registered components and ignores them.
  On the GPUI backend (`nsh-platform-gpui`, `native.rs`) a component renders a GPUI element
  (`NativeComponent::render(window, cx) -> Option<AnyElement>`, any GPUI / GPUI Kit element or `Entity` view): the
  surface element's prepaint lays it out at the box's window bounds and prepaints it (`prepaint_as_root`, clipped to the
  clipping ancestors), the tree paints it where it draws the box (NSH content drawn later covers it), and a `BlockMouse`
  hitbox under it keeps NSH's input away; keys go to it first while focus is inside it (GPUI dispatches its key
  bindings, then its key listeners, then the surface's), and the keys it lets through reach the window's shortcuts,
  then the app's `keymap` bindings (as while a text field is focused, so a binding whose `when` is `auto` leaves
  typing keys to the component) and the menu's shortcuts, and nothing else of NSH's (`input::component_key`); one that returns its widget's
  handle from `NativeComponent::focus_handle` is a Tab stop among the text fields (in tree order, in the newest modal's
  scope). Props and commands reach it soon after they arrive, in a main-thread task of their own (never inside a frame),
  before the next `render`, with its window and `App` (`set_prop(name, value, window, cx)`, `command(name, args, window,
  cx)`), so it can update its entities; they do not wait for a frame, so a host that hides the view or a window in the
  background still gets them, in order and once (a frame that comes first delivers them itself). `render` is also called while
  the box is empty, so a component can size itself. Content masks are
  rectangles: rounded corners do not cut a component (videos follow them).
  `crates/gpui/nsh-platform-gpui/examples/embed.rs` runs `examples/embedded` with its badge as a GPUI element.
- **Watched scroll views** (`NshView.watchScroll`, `NshScrollHandle`): native UI of the host that moves with the
  app's content in every frame (a sheet the end of the content pulls up) follows a `<Scroll>` by its `nativeID`, on
  the UI thread, in the frame of the scroll: `onScroll` through JS would be a frame late. `nativeID` (not `testID`,
  which is for tests) reaches the platforms in `ViewProps::native_id`. Both axes, and the same names on Android, iOS
  (Swift, C, Rust): `onAttached`/`onDetached`, `scrollX`/`scrollY`, `contentWidth`/`contentHeight`,
  `viewportWidth`/`viewportHeight`, `contentView`, `scrollBy(dx, dy, animated)`, `stopScrolling`, `onScroll(scrollX,
  scrollY, dx, dy)`, `onContentSizeChange(contentWidth, contentHeight)`; only listener removal follows each platform
  (Android `remove…Listener`, Swift a returned closure, C/Rust an id). The mounter keys a `ScrollBox` by the
  `nativeID` of its props (`Mounter.keyScroll`, the newest of an id wins) and unkeys it when it is deleted, loses the
  id or its app stops (`destroyComponents`), which tells the watcher and kills its handle (`isAlive`, by the box's
  `hostKey`). Host listeners run in the platform scroll view's scroll callback after the core's report, and from
  `setContentSize` when the size changes without a scroll. Host scrolls are the user's kind, not the core's
  (`applied` stays): the app hears them; `hostStop` ends a fling with two empty smooth scrolls (a zero fling would
  leave one running). Nothing runs for a scroll view no host watches but an empty-list check.
  On iOS (`NshAppView.watchScroll`, `scroll_watch.rs`; `AppView::watch_scroll`, `nsh_app_watch_scroll`) the
  watchers live in the view's options (`ScrollWatchers`) and a surface's keyed scroll views in `SurfaceScrolls`,
  shared by its mounter (props, content sizes, deletes, its drop when the app stops) and its event target, which calls
  the listeners from `scrollViewDidScroll` without borrowing the mounter (a listener may scroll, which calls back in).
  Offsets count from the start of the content (the adjusted insets added back); `stop_scrolling` sets the current
  offset without animation, which ends UIKit's glide or animation, and reports the glide's end to the app, as UIKit
  does not. Desktop and web have no equivalent: they are not embedded.
- **Native modules** (`nsh`'s `nativeModule`; `platform_modules.rs`, `modules::host_module`): an embedding app
  written in Rust gives its engines a UI set of its own (`Registry::ui_set("host/trading")` with its `#[module]`s,
  `#[class]`es and Rust components) next to NSH's (`set_ui_sets` of the platform crate, `EngineConfig::ui_sets`), and
  the app reaches it by name at run time: `nativeModule<{ Trading: TradingApi }>("host/trading")` is an object of
  the set's exports, made as an import of the set makes them, once per specifier and engine. The app declares `T`
  itself, so it is built with the stock `nsh build` and the CLI never needs the host's registry (an `import` of the
  set needs a CLI built with it, `rust_app.rs`). Calls keep the typed machinery (`rust-classes.md`): plain functions
  answer in the call, `cx` functions are ops, `async` ones tasks. Where the host gave no set under the specifier, it
  throws a `ReferenceError` naming it.
- **The host channel** (`nsh`'s `host`; `nsh_engine::HostChannel`, `nsh_core::host_channel`, `nsh-js`
  `host_channel.rs`): the embedding app and the app talk without a view in between and without Rust of the
  embedding app's. Every view keeps one channel for every app it loads (Rust `AppView::host()` on iOS, macOS,
  Linux, Windows and GPUI, `AppOptions::host` / `SurfaceOptions::host` to bring one's own; Swift `NshAppView.params`,
  `send(_:_:)`, `handle(_:_:)`, `removeHandler(_:)`, C `nsh_app_set_host_params`, `nsh_app_send_host_event`,
  `nsh_app_set_host_handler`, `nsh_host_call_resolve` / `_reject` / `_free`; Java `NshView.setParams`, `send`,
  `handle`, `NshView.HostHandler`, `NshHostReply`) and hands it to each engine (`EngineConfig::host`), one channel per
  surface, no globals.
  - *Launch parameters*: `set_params(map)` before a load; the engine snapshots them when it starts (`HostChannel::bridge`)
    and `host.params` reads them synchronously (a JSON object, `{}` without any), fixed for the app's life. Later
    requests ("open conversation X" from a notification) are events.
  - *Events* (`send(name, data)`, any thread, never waiting): `Message::HostEvent` on the attached engine
    (`HostChannel::attach`: an engine attaches when it starts and detaches when it goes, by id, so a reload's new engine
    is not detached by the old one). While no engine runs, the channel keeps them for the next (`HostInbox`, 256, the
    oldest dropped and logged). Stopping the engine serializes its interrupt and shutdown message with `send`;
    its attachment recovers events left in the engine queue for the next app under the same lock. In the VM, an
    event of a name nobody listens to is kept likewise until the first
    listener of that name is added; a job then delivers what was kept, in order, at the end of the turn that added it
    (after the code adding it, so listeners added together all hear it). A listener that throws is reported as an
    uncaught error; the others still run. Delivery takes one event at a time (`HostInbox::pop`): when the last
    listener stops during a callback, the rest keep their original order and age in the inbox.
  - *Calls* (`host.call(name, data)`): a promise kept by id (at most 1024 waiting per VM; one more rejects with
    `ERR_NSH_QUOTA_EXCEEDED`). The engine (`EngineBridge`) runs the handler of `name` on the engine thread, at once,
    with a `HostCall`; no handler rejects at once. The handler answers once from any thread (`resolve`, `reject`, `reply`, or `into_reply` to answer
    elsewhere): `Message::HostReply(id, result)` settles the promise in the engine's next turn. A `HostReply` dropped
    unanswered rejects ("did not answer"), so a handler that panics (caught) or forgets fails the call rather than
    leaving it pending; an answer for an engine that stopped goes nowhere. Calls use the platform API's timeout:
    30 seconds by default, `{ timeout: 0 }` to wait without a deadline, on the app's clock. Calls and posts require
    `capabilities.host` and the same function-name validation as the platform transport. A call never throws: what
    fails rejects it, with the same errors as the platform transport's, built by `nsh_core::host_channel`
    (`host_error`: the handler's message, its own error or "no handler" / "did not answer", `code`
    `ERR_NSH_HOST_ERROR`; `not_granted`: `ERR_ACCESS_DENIED`, `permission` `"host"`, `resource` the name;
    `timed_out`: `ETIMEDOUT`; `no_host`: `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; `too_many_calls`:
    `ERR_NSH_QUOTA_EXCEEDED`; `invalid_name`: a `TypeError`), so an app branches on `code` whichever transport answers.
    `host.post` is synchronous and throws the name's `TypeError` or `ERR_ACCESS_DENIED`. *Posts* (`host.post`) reach the same handler with nothing to answer (`HostCall::is_post`); without a
    handler they are dropped.
  - *Threads*: the main thread never waits for JS and JS never waits for the main thread. Rust handlers run on the
    engine thread and must not block it; the SDKs' glue hops to the main thread (iOS: `DispatchQueue.main` in
    `embed.rs`; Android: `NshView.hostMessage`, called over JNI on the engine thread, posts to the UI thread), where
    Swift's and Java's handlers run. Android serializes the native part of `send` with taking the handle in
    `destroy`, then joins the engine with the Java lock released. Data crosses the C ABI and JNI as JSON text
    (Swift `JSONSerialization`, Java
    `org.json` as maps and lists), the VM as JSON values converted natively.
  - A Rust app (`App::Rust`) has no `host`: events reach no one; its own Rust reaches the embedding app's
    directly ("Native modules", below). The host grants the native functions the app may call through `capabilities.host`.
  - *The URL handler* (`HostChannel::handle_open_url`; Swift `NshAppView.onOpenURL`, C
    `nsh_app_set_open_url_handler`; Java `NshView.setOpenUrlHandler`, `NshView.OpenUrlHandler`): the URLs the app
    opens (`openUrl` of `nsh`, `nsh_core::element::open_url`, a `TextView` with `links="open"`;
    `nsh_core::open_url`) reach it before the platform, so a host routes its own links through its router. It is a
    typed hook of the channel, not a named message: the channel is already the view's one object for the host's side,
    threaded to every engine and through both SDKs' main-thread glue, and a hook of its own takes only what passed
    the URL check and the `openUrl` capability, where no `host.call` name of the app can reach it or be mistaken for
    it. The core keeps each request (`Action::OpenUrl` → `Core::take_url_opens`); the engine (`State::open_urls`,
    after each commit round) runs the handler on the engine thread with an `OpenUrlRequest`, answered once from any
    thread: `handled()` resolves the app's promise with `{ opened: true }` (`Core::answer_open_url`), `decline()` or dropping it
    hands the URL to the platform (`Message::UrlHandled` → `Core::open_url_on_platform`: `Command::OpenUrl` on the
    root, answered by `EventKind::OpenUrl` `{ id, opened }`). Without a handler the platform opens it at once. The
    SDKs' handlers are synchronous on the main thread (Swift `(URL) -> Bool`, Java `boolean openUrl(String)`), reached
    as the call handlers are.
- **The host's data in every app.** Host and apps stay in step through the host: it keeps the shared state (a
  `tokio::sync::watch` or `broadcast` channel in a static the module's functions reach), functions the apps call
  change it, and an `on(event, listener: Callback<State>, cx: CallCx) -> Result<Stop, String>` keeps every app
  informed: the task it starts (`cx.start`, on the engine thread; tokio's channels need no runtime there, their
  wakers wake the engine) posts the current state, then awaits each change and posts it (`Callback::post`, which
  runs the callback in the engine's next JS turn). The `Stop` it returns is JS's stop function: it drops the
  listener, so the task ends at the next change, when the app calls it or when what called `on` goes (a component,
  or the module's run under hot module replacement); otherwise the task ends with the engine. The host's own UI
  reads and changes the same channel, so a change from the host, or from any app, reaches all of them. `examples/embed-gpui` keeps its
  selected symbol and orders this way (`src/trading.rs`); the engine's `host_modules` tests run it with two engines.
- **Each engine's own part of the host** (`nsh_core::element::EngineContext`): a host serving several engines (windows,
  panels) gives each one typed values when it builds it (`EngineConfig::context`; GPUI `AppOptions::context`):
  `EngineContext::default().with(MyLink { .. })`, at most one value per type, `Send + Sync`. The set's Rust code
  reads the context of the engine running it with `engine_context::<MyLink>()` (`Option<Arc<MyLink>>`): plain
  functions in the call, `cx` functions as ops, `async` ones in their task, after awaits too, and components. The
  engine makes its context its thread's for its whole run (`EngineContext::enter`, as its clock); work sent to other
  threads (`background`) reads it first and moves the value there. The engine's `host_modules` tests and the GPUI
  backend's window tests run two engines reading their own.
- **The host's own picker** (`nsh_core::picker::PickerBackend`): an embedding app that has a picker of its own answers
  the apps' `Picker.pickImages` with it: `EngineConfig::picker` (GPUI: `AppView::set_picker`, from the next load) gets
  every pick's `PickRequest` and returns a future of `PickedFile`s (bytes as `ImageData`, which may come from any
  thread), and the core resolves the pick with them (cut to the limit, sizes, types and extensions filled in from the
  bytes), sending no `Command::PickImages`. `PickerBackend::pick_files` answers `Picker.pickFiles` the same way (a
  backend that does not implement it cancels those picks; the platform's picker is still not shown). The capability check comes first, so a pick the app is not granted never
  reaches it. Where no backend is set, the platform's picker shows (`images.md` "Picked images"): on iOS and Android it
  needs nothing of the embedding app (PhotosUI is loaded on first use; Android's result comes to a headless fragment of
  the view's activity).
- **The host's own recognizer** (`nsh_core::speech::SpeechBackend`): an embedding app that recognizes speech its own
  way answers the apps' `Speech` with it: `EngineConfig::speech` gets every session's `SpeechRequest` and a
  `SpeechSink` it reports to from any thread (`start`, `result` with the whole transcript, one `end`), and returns the
  `SpeechControl` the core stops and aborts it with; `available` answers `Speech.available()`. No `Command::Speech` is
  sent then. The capability check comes first. Where no backend is set, macOS and iOS recognize with the Speech
  framework (the app's Info.plist needs `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`,
  which `nsh package` writes); other platforms end every session with `unavailable`.
- **The host's locale and text size** (`nsh_core::platform::HostEnvironment`): an embedding app that lets its users
  pick a language or a text size of its own gives them to its views in place of the system's: Rust `AppView::set_locale(Option<Locale>)`
  / `set_font_scale(Option<f32>)` (GPUI, AppKit, GTK, Win32; GPUI's take `cx`), Swift `NshAppView.locale` / `fontScale`
  (C `nsh_app_set_locale` / `nsh_app_set_font_scale`), Java `NshView.setLocale` / `setFontScale`. Each platform writes
  them over the system's values where it builds the environment (`Surface::set_environment` on the desktops, the root
  view's `environment()` on iOS, `publishEnvironment` in Java), so they reach the engine as a system change would and
  are in the first frame of every app loaded later; the platform's own drawing that reads the environment (alerts)
  follows too. `None` / `nil` / `null` / 0 follows the system's again (its settings are read again). The text
  size scales what allows font scaling (`Core::set_font_scale`): texts, inputs, the components' labels; lengths, `rem`
  in classes included, stay as they are. The layout direction stays the system's language's.
- **The host's theme overrides**: a host that embeds one app in several branded host apps overrides the app's theme
  tokens (brand colors, `radius`, ...) at run time: Rust `AppView::set_theme_overrides(Option<&str>)` (AppKit, GTK,
  Win32; the iOS `AppView`'s too), Swift `NshAppView.setThemeOverrides(_:)` (C `nsh_app_set_theme_overrides`), Java
  `NshView.setThemeOverrides`. The value is a theme file in the format of `nsh.json`'s `"theme"` (shadcn's `cssVars`:
  `theme`, `light` and `dark` sections, values as CSS writes them; `components.md` "The theme"); it is parsed on the
  calling thread by `nsh_base::theme_overrides`, which keeps only the tokens the file sets (a `var()` it names and
  does not set is the default theme's), and a file that does not parse is an error (Swift throws `NshError`, Java an
  `IllegalArgumentException`, C returns it) that changes nothing. The tokens go to the engine as host tokens
  (`EngineControl::set_tokens`, `Core::set_host_tokens`): they win over the app's tokens of the same names in both
  appearances, the app's others stay (`Tokens::over`), and classes naming the changed tokens (`bg-primary`,
  `rounded-(--radius)`) are resolved again at once, as are Rust components reading `theme()`. Each platform keeps
  them on its surface and starts every engine with them (`Engine::start_with`), so they are in the first frame of
  every app loaded later, a development reload included; `None` / `nil` / `null` gives the app its own theme back. A
  token takes both appearances: one the file gives only in `light` (or `theme`) is that color in dark mode too, as
  in a theme file, so an override that differs in dark mode names it in `dark`. GPUI's `AppView::set_theme` /
  `set_theme_json` (below) give a whole theme instead, the default's where the file is silent.
- **The iOS SDK** (`crates/xtask/src/ios.rs`): per platform slice (device, simulator, Catalyst) a static
  `NativeShell.framework` whose binary is `nsh-platform-ios` with feature `embed` (built by `cargo rustc --crate-type
  staticlib`, so the hosts never build or export it) merged by `libtool` with the Swift module, compiled with library
  evolution (`.swiftinterface`: apps on other Swift compilers can import it). The Swift module imports the C ABI's
  module `NativeShellC` with `internal import`, so it is neither in the interface nor shipped; its module map's `link`
  lines become autolink entries of the Swift objects (apps link nothing but the framework). Catalyst frameworks use the
  versioned macOS layout and Swift needs the SDK's `iOSSupport` paths. The Rust static library goes in as one
  relocatable object (`ld -r` with an exported symbols list) that exports only the C ABI (`_nsh_*`): Rust's runtime
  (`rust_eh_personality`), the standard library and QuickJS (`JS_*`) become local, so apps that link another Rust
  static library (each defines `rust_eh_personality`) or QuickJS link NativeShell without duplicate symbols (with
  `-dead_strip` the linker only warns and keeps one of them, which the other runtime then unwinds with).
  Hiding the symbols is not always enough: an image's compact unwind table encodes at most three personality routines,
  and an app that already has the Objective-C and C++ ones plus another Rust library's (`rust_eh_personality`, which
  NSH's local copy then adds to) fails to link with "Too many personality routines for compact unwind". `--dynamic`
  builds dynamic frameworks instead (the Swift module and the runtime object linked with `swiftc -emit-library`,
  `-dead_strip`, installed at `@rpath/NativeShell.framework/NativeShell`), which the app embeds: the runtime gets an
  image, and an unwind table, of its own.
  `cargo xtask ios-embed` options: `--dynamic`; `--x86-64-simulator` adds the x86_64 simulator architecture (merged
  with arm64 by `lipo`: apps whose simulator builds run under Rosetta; `rustup target add x86_64-apple-ios`);
  `--no-catalyst` and `--no-dev` leave out the Catalyst slice and `NativeShellDev`. The C functions return errors as strings
  (`nsh_string_free`) that Swift throws as `NshError`; the error handler's context is released by a callback.
  `NativeShell`'s logs go to the unified log under the host app's bundle identifier (`nsh_platform_apple::unified_log`,
  installed by the first `nsh_app_create` or `nsh_trust_create` unless the process has a logger; `macos.md` "Packaged
  apps' logs"); `NativeShellDev`'s go to the dev server while connected, to stderr otherwise (`dev.rs`).

## GPUI and GPUI Kit apps

Desktop apps built with GPUI or GPUI Kit (Longbridge Pro, Allsum Desktop) embed NSH with `nsh-platform-gpui`'s
`AppView`, a GPUI view; `examples/embed-gpui` is a GPUI Kit window with a sidebar, buttons, an input and two order
tickets in a resizable split, sharing the host's trading desk (`src/trading.rs`, `nativeModule("host/trading")`) with
each other and with the host's sidebar and toolbar, and a "Show layers" toggle outlining what GPUI Kit draws and what
NSH draws (`src/layers.rs`).

- **One GPUI.** NSH draws with GPUI Fast (`gpui-fast` from crates.io); GPUI Kit (`gpui-kit` / `gpui-component`) must
  use it too: its `gpui-fast` feature. `cargo tree -i gpui-fast` must show one version, else the app has two GPUIs
  and NSH's views are not the app's elements. `nsh_platform_gpui::gpui` re-exports NSH's.
- **A view.** `cx.new(|cx| AppView::new(options, window, cx))`, then `view.read(cx).load(App::Js(bundle))` (or a
  Rust app's root); the app puts the entity wherever it wants as a child element. The surface fills the space its
  parent gives it and follows it when resized (each layout reports the size to the engine). Several views run at once,
  in one window or several, each with its own engine thread; the process shares only the main-thread queue (`rt.rs`)
  and the key bindings. Dropping the view (its last entity handle) stops its engine and joins its thread, as does
  `AppView::stop`.
- **Focus.** `AppView` is `Focusable` and a tab stop (a `div` with `track_focus` around the surface element, which
  registers the stop). A press focuses it; keys reach it only while it is focused, so several surfaces and the host's
  inputs never share keys. Its key context `NshAppView` binds Tab and Shift + Tab deeper than GPUI Kit's `Root` (which
  binds them to move the window's focus): the surface's text fields come first, and past the last one (the first
  with Shift) the field is blurred and `window.focus_next()` / `focus_prev()` move on to the host's widgets. Tab from
  the host's widgets onto the view goes on to its first field (its last with Shift: a keystroke observer, since the
  host handles that Tab); in a window with no other tab stop (`run_app`) the fields wrap around, as on the other
  backends.
- **Frame rate.** Open the host window with `inactive_frame_interval: None` in its `WindowOptions`: GPUI draws
  windows without keyboard focus at 30 fps by default, which halves the surfaces' animations whenever the host window
  is not focused (NSH's own windows set it, `open_app_window`).
- **Overlays.** The surface draws only inside its bounds and takes the mouse only on its hitbox: GPUI Kit's dialogs,
  sheets, popovers and notifications (drawn by `Root` above the content) cover it and take the input, while its app
  keeps running.
- **The host's theme in NSH.** `AppView::set_theme(Some(theme), cx)` gives the surface a `nsh_base::Theme`
  (re-exported as `nsh_platform_gpui::Theme`) and `set_theme_json(json, cx)` one from a theme file (shadcn's
  `cssVars`, as `nsh.json`'s `"theme"`: `components.md` "The theme"): the app
  renders with its tokens instead of its own theme's (`Core::set_host_tokens`, which win until cleared with
  `None`), and the surface is drawn on its `background`. The app's classes naming its tokens (`bg-primary`,
  `bg-sidebar`, `rounded-(--radius)`; every token of the theme, the host's own names too) restyle with it;
  tokens it lacks keep the app's values. It applies at once and to every app loaded later, in their
  first frame (the surface starts engines with `Engine::start_with`, sending the theme before the start).
  `set_appearance(Appearance::Light | Dark, cx)` is the host's mode, standing in for the system's (`System` follows
  the window again); an app that sets its own appearance still wins, as over the system's. The example's
  `src/theme.rs` maps GPUI Kit's active `Theme` onto shadcn's tokens: the current mode's colors as GPUI Kit resolved
  them, each set on the token of the same role (`Theme::set_color`: `background`, `primary`, `muted-foreground`,
  `border`, `ring`, ...) for both appearances, its radius on `radius` and its font families on `font-sans` /
  `font-mono` (`set_number`, `set_font`), so NSH's components match GPUI Kit's widgets. It runs again on every
  change, a mode switch included (`cx.observe_global::<Theme>`), so one appearance's values are always the shown
  mode's. The example's `themes/violet.json` is the host's own GPUI Kit theme, loaded into GPUI Kit's
  `ThemeRegistry`; the embedded app takes it on through this mapping.
- **From NSH to the host.** The app talks to the embedding app through its channel (`AppView::host()`, "The host
  channel" above: launch parameters, events, calls and posts); through the native components the latter registers
  (`AppView::register_component`): their events and commands, as on the other platforms; and through the functions
  of the UI sets it gives `set_ui_sets` ("Native modules" above): the example's tickets call `Trading.placeOrder` and
  listen to the desk (`Trading.on("change", …)`), whose `watch` channel the host's own GPUI widgets follow too (`cx.spawn` awaiting
  `changed()`), so the host and every ticket show the same symbol and orders. A component can render GPUI
  Kit widgets in its box (`NativeComponent::render`), which take their own input: the example's "Extended hours" is a
  GPUI Kit `Switch` (`src/switch.rs`, `host.switch`) that reports its natural size (`ComponentContext::set_size`: its
  track and label, so the app's style leaves the box's size open), emits `change` to JS, and toggles on clicks and on
  Space or Enter while focused (NSH's fields do not see those keys). It returns a focus handle of its own
  (`NativeComponent::focus_handle`; a wrapper's, since the `Switch` keeps its handle internal), so it is a Tab stop
  among the app's text fields, and a click focuses that handle too.
- **Limits.** `AppOptions::limits` (or `AppView::set_limits`, from the next load) are the VM limits of the apps the
  view runs, as `NshAppView.limits` and `NshView.setLimits` on iOS and Android: `Limits::default()` (an app embedded
  in another app) unless set; the development host `nsh-gpui-host` runs apps on its own, with `Limits::standalone()`
  (`sandbox.md`).
- **Storage.** Each app keeps its `Storage` in `<data dir>/<app id>/storage.json`, which the engine picks
  (`EngineConfig::data_dir`, `app_dir_name(App::app_id())`, `default` without a valid id): the id travels with the app
  (`app.json` next to a bundle, written by `nsh build` / `nsh package`; the dev server's bundle message; a verified
  package's id; `Root::app_id` in Rust apps' generated code). Platforms only give the data dir: the system's
  (`nsh_engine::data_dir()`) on the desktops (`AppOptions::data_dir` to change it), `Application Support/nsh` on iOS,
  `filesDir/nsh` on Android. `AppOptions::storage`, `NshAppView.storageDirectory` and `NshView.setStorageDirectory`
  override one app's place; all from the next load.
- **Notifications.** The process's notifications (`nsh`'s `Notifications`) belong to the embedding app unless it
  hands them to the app it embeds: `AppOptions::notifications` on macOS and Windows (off by default; `run_app` sets
  it). Then the view's app owns them for the whole process: on macOS NSH becomes the notification center's delegate
  (a delegate the embedding app already set stays), on Windows the process takes the app's id as its
  AppUserModelID, registers it for toasts and hears their presses; the first such view's app wins. Without it the
  permission is `unavailable`, `show` resolves `false` and the badge is left alone. On Linux the desktop portal knows
  the app by its id either way.
- **Caches.** An app's caches (today the images it downloads, `nsh_core::image::DiskCache`) live in
  `<root>/<app id>/<kind>`, which the engine opens from `EngineConfig::cache` (`nsh_engine::CacheOptions`: a
  `CacheLocation` (`System`, `Dir`, `Off`) and a `CachePolicy` per kind (`Default`, `MaxSize(ByteSize)`, `Off`),
  sizes in `ByteSize::mib` / `gib`) and hands to the platform (`Engine::image_cache`). `EngineConfig::new` keeps none.
  `System` is the engine's own (`~/Library/Caches`, `%LOCALAPPDATA%`, `$XDG_CACHE_HOME`) on the desktops; iOS and
  Android, which alone know theirs, resolve it before the engine sees it (`Library/Caches/nsh`; `nsh` in the
  Context's cache directory). One shape on every face: `AppOptions::cache` / `SurfaceOptions::cache` and
  `AppView::set_cache` in Rust, `NshAppView.cacheOptions` (`NshCacheOptions`: `.system` / `.directory(URL)` /
  `.off`, `.default` / `.maxSize(megabytes:)` / `.off`) in Swift over `nsh_app_set_cache` (a C struct with a leading
  `size`, read up to it, so it can grow), `NshView.setCacheOptions(NshCacheOptions)` (immutable, built) in Java; all
  from the next load. A new kind of cache is one more `CachePolicy` field, never another option per platform.
- **Development.** With feature `dev`, `view.update(cx, |view, cx| view.connect_dev_server(url, cx))` loads the app
  from a `nsh dev` server and reloads it on every change, as `connectDevServer` on iOS and Android: the server's
  assets, logs forwarded to the developer's terminal, the status line and the error overlay over the view, the reload
  key. The embedding app's `on_error` keeps hearing the app's errors next to the overlay; connecting again replaces
  the session. `crates/gpui/nsh-platform-gpui/examples/embed.rs` takes a dev server's URL.
- **Errors.** `AppView::on_app_error` hears every error of the app (also logged) as an `AppError` (`nsh_engine`,
  re-exported): its `kind` (`Load`: the bundle did not start; `Uncaught`: an exception escaped a callback, the app goes
  on; `Stopped`: the VM was stopped, reported once; `HotUpdate`; `Asset`), `is_fatal()` (`Load` or `Stopped`: no JS
  of that app runs again, where a host falls back to another build), the `message` and the `stack` apart (the stack
  mapped to the sources when the bundle has a source map), and the signed `package` it came from (`PackageInfo`: id,
  name, version, build, SHA-256; `Bundle::package`, set by `Bundle::from_package`). `AppView::on_error` is the same
  handler with the error's text. The engine reports them through `MountSink::report`, whose default calls
  `MountSink::report_error` with the text, so the other platforms' text callbacks (`NshAppView.onError`,
  `NshView.ErrorListener`) are unchanged.

## TestFlight uploads

`nsh publish ios <IPA>` (`publish_ios.rs`) uploads a device IPA made by `nsh package` directly
to App Store Connect's build uploads API. It reads the IPA's Info.plist, verifies the remote app's
bundle ID, creates a build upload and file reservation, streams the prescribed ranges, and commits
the SHA-256 checksum. Apple then processes the build; beta distribution and review remain in
App Store Connect. The existing `.nshpkg` signing form of `publish` is preserved (`./ios` disambiguates
an entry directory named `ios`).

Credentials use flags or `NSH_APP_STORE_{APP_ID,ISSUER_ID,KEY_ID,PRIVATE_KEY}` environment variables,
never project configuration. Each control request gets a two-minute ES256 JWT; delivery requests
use only Apple's supplied headers. HTTP redirects are disabled, transfer errors omit signed URLs,
and upload ranges must cover the file exactly. The CLI uses the existing ring dependency tree for
P-256 signing, and existing ureq, base64, sha2, zip and plist crates.

Unit tests verify JWT signatures and claims, request bodies, IPA metadata and range validation.
A real upload requires a macOS machine, an App Store-signed IPA and an owner's App Store Connect
team API key; local tests do not prove Apple's signing validation or TestFlight processing.
