# Sandbox and capabilities

Each surface is one QuickJS VM. A bundle holds only the app's code (NSH's runtime is native), so nothing in JS is
trusted: every limit and check is enforced in Rust, never in JS.

- **Who sets the limits.** Only apps embedded in another app have limits, and the embedding app decides them
  (`nsh_core::js::HostLimits` over `Limits::default`: 256 MB heap, 4 MB stack, 10 s to load, 2 s per call, 200 000
  nodes); `nsh.json` has no say. An app on its own (every platform's hosts and runners, a web package, `nsh run`
  without `--limits`) is its developer's code, as a native app's is, and runs with `Limits::standalone()`: no heap
  limit (0), no time budget (`Duration::MAX`: no deadline), no quota (`usize::MAX`), only the interpreter stack's
  4 MB, which turns deep recursion into a `RangeError` instead of a crash of the process (it is also the most an
  embedder may set: the engine thread's stack is 8 MB). `nsh run` / `nsh dev --limits [memory=..,stack=..,load=..,call=..,nodes=..]`
  run the app as an embedding app setting those would (alone: the embedding defaults): the dev server sends the spec in
  its bundle message (`limits`) and the dev hosts start the app with `Limits::development(spec)`. On the web the page
  decides (`run(code, { limits })`, `nsh_bundle_limits`); the website's playground runs its visitors' code with the
  embedding defaults, since the engine runs on the page's main thread.
- **Limits** (`nsh_js::Limits`, `EngineConfig::limits`, per VM): the QuickJS heap and stack, a
  time budget per call from Rust into JS (`sandbox.rs`: loading the bundle 10 s, any other call 2 s — one event with the
  rendering it causes, one list bind, one timer, one frame's callbacks, the microtask drain; nested calls share the
  outermost budget), and quotas for what the heap limit does not cover: changes at once (the op queue,
  `max_op_values`: ops are Rust memory), ops per canvas drawing, nodes in the core (`Core::set_max_nodes`; each may hold a native view) and dense
  node ids (an id far past the ids in use would grow the id table: `ApplyError::IdOutOfRange`).
- An overrun call is cut off by the interrupt handler with an exception no `catch` swallows, reported with the budget it
  exceeded; the VM goes on. Running out of memory or going over a quota **stops the VM** (`Host::fatal`), also when the
  app catches the error: the heap's allocator (`HeapAllocator`) enforces the limit and records reaching it, since QuickJS
  reports running out in several ways (an `InternalError`, a `null` exception). It is reported once
  (`MountSink::report` with `AppErrorKind::Stopped`, the embedder's error callback), no JS runs after that and the
  views stay as they were.
- **Hardening** (`Policy::harden`, on unless the bundle came from a dev server): `eval` is deleted, the `Function`,
  `AsyncFunction` and generator constructors throw, and the shared prototypes (`Object`, `Array`, `Function`, `String`,
  `Number`, `Promise`, `Map`, typed arrays, ...) are frozen so one module cannot change them for the others.
  `Error.prototype` stays writable (subclasses set `this.name`). Their commonly overridden members (`constructor`,
  `toString`, `valueOf`, `toJSON`, ...) become accessors whose setter defines the property on the object assigned to:
  without that, `Sub.prototype.constructor = Sub` or `obj.toString = …` throws (the "override mistake"), which breaks
  libraries such as axios. Hot updates are evaluated from Rust and need none of it.
- **Capabilities** (`nsh_core::access`): an app declares what it may reach in `nsh.json` `"capabilities"` — `network`
  (`hosts`: `*`, `*.example.com` or a host; `http`: a host narrowed by methods, schemes, a port, paths and path prefixes),
  `webview` (`hosts` a web view may show and navigate to), `statusBar`, `process` (`execute`: exact executable names or absolute paths; `exit`: host exit requests; `env`: additional
  visible environment names), `fs` (`read` / `write`: trusted path roots), `clipboard` (`nsh`'s `Clipboard`: reading and
  writing the system clipboard; the copy menu of selectable text is the user's own act and needs none), `picker`
  (`nsh`'s `Picker`: showing the system's picker, whose picked files reach the app; denied, a pick rejects), `host`
  (`nsh`'s `host`: the embedding app's functions `host.call` may call, names or prefixes ending in `*`, `true` for all;
  names and grants are 1 to 128 of `[A-Za-z0-9_.:-]` without `..` (`access::valid_host_name`), and the core refuses
  the call of any other name before it reads the grants, since hosts may put names in paths or URLs;
  never granted without it, also in apps without a declaration (`Capabilities::all` leaves it empty), and the bundler
  warns of an app importing `host` from `nsh` without it (`bundle.rs` `ungranted_host`); the host's events need none, the
  host sends them), `openUrl`
  (`openUrl` of `nsh`: `true`, or `{ "schemes": [...] }` for the schemes listed). `nsh`'s `Storage`
  is no capability: an app's storage holds only its own data, and the host decides where it is kept. Everything not listed is denied and unknown keys
  are build errors (`Capabilities::from_json`); a signed package's declaration is read with `from_json_lenient`, as a
  newer signer may have written it: an unknown capability is not granted, an unknown key inside one drops that
  capability or `http` grant (it may be a restriction), so unknown keys never widen access; an app without the key
  retains unrestricted network, webview, status bar, clipboard, picker and URL opening access. Process execution, filesystem access and
  the host's functions always require explicit declarations, including standalone apps. The embedding app
  may grant less (`NshAppView.grantCapabilities` / `NshView.setGrantedCapabilities`, the same JSON): a request must be
  allowed by both (`Access`). The declaration travels with the bundle (`capabilities.json` next to it, written by
  `nsh build` / `nsh package`; the dev protocol's `Bundle` message, so development enforces the same capabilities; a change
  reloads instead of patching) into `Policy::declared`.
- Enforced in Rust: `fetch` in the engine (`access.rs`; refused requests never reach the network, and redirects are
  followed by the engine with `follow_redirects` off for the platform, so every hop is checked — hops are issued on the
  engine thread when a hop's head arrives; a streamed request body is not sent again, so a 307 / 308 then fails); remote images, placeholders, canvas images, `Image.getSize` / `prefetch`, video sources, web view
  sources, the status bar, the clipboard, the picker and host calls in the core (`Core::check_prop`, the commit's commands and actions;
  each refusal is logged once, target `js`, saying which key to add); top-level web view navigations on the platforms
  (`WKNavigationDelegate decidePolicyForNavigationAction` / `WebViewClient.shouldOverrideUrlLoading` → `Native.allowsWebview`).
- What a refusal does: every call JS makes fails with `JsError::access_denied` (`ERR_ACCESS_DENIED`, `permission` the
  capability's key, `resource` what was asked for, `""` when the capability has none), which its promise rejects with.
  The modules check in the call, on the `System` the call gets, so the error is typed and nothing is queued:
  `Clipboard`'s functions (`runtime/clipboard.rs`), `Picker.pickImages`, `openUrl` (`runtime/device.rs`,
  `open_url::not_granted`) and `Image.getSize` / `prefetch` (`runtime/image.rs`, `resource` the URL). `host.call` is
  refused by the core (the commit's `Command::HostCall`) and by the SDK channel (`nsh-js` `host_channel.rs`) with
  `nsh_core::host_channel::not_granted`. A refused `fetch` rejects as every failed fetch, with a `TypeError`, which
  carries `code`, `permission` `"network"` and `resource` the request's or the redirect's URL (`access::Refused`,
  `Host::fetch_refused`). A refused source (image, placeholder, video, web view `src` or `html`) shows nothing and
  reports `onError` with `code` `ERR_ACCESS_DENIED`, as the platforms report a refused navigation. What has no caller
  to answer (the status bar, a canvas image) only logs. Rust components' calls keep their Rust types: the core's
  checks answer them as the system would with nothing there (an empty clipboard, no picked files, `open_url` `false`)
  and an `Err` with the message for `fetch`.
  `asset:` URIs are always allowed. Host checks take the host after the last `@` (`https://ok.com@evil.io` is evil.io).
- **Desktop system APIs**: `process` and `fs/promises` (the only process and file APIs) check the intersection of the
  declaration and the optional host grant in Rust. Process commands match exactly: a grant for `codex` grants that
  command, while `/usr/bin/codex` requires its own entry. The runtime launches the executable directly with an
  argument array, in the app data directory or a `cwd` within an `fs.write` root, with a cleared environment
  refilled from the host's `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `LC_*`
  and the names `process.env` grants (`nsh_core::runtime::process`). A child leads its own process group; its exit is noticed
  without reaping it (`waitid(WNOWAIT)` on Linux, a kqueue `NOTE_EXIT` on Apple platforms), so the group is only
  signalled while the leader's pid is still taken. VM teardown sends every child SIGKILL before joining any
  supervisor. On Windows a child starts suspended, runs once it is in a job object of its own
  (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), and ending it terminates the job, so everything it started ends with it;
  pipe threads still blocked at teardown have their I/O cancelled (`CancelSynchronousIo`). Filesystem checks
  work on the path's text (`.` and `..` resolved as written) against each granted root in both its written and its
  canonical form (the nearest existing ancestor canonicalized once per VM, `Roots` in `sys.locals`), so the call
  does no disk work on the engine thread; a path reaching a root through an outside symlink is refused. The
  operation then runs off the engine thread in the granted root, opened (on Unix component by component with
  `O_NOFOLLOW` from `/`, ancestors for search only) as a cap-std `Dir`, so no symlink leads it outside; a write
  creates a root that does not exist yet, a read finds nothing in it. Operations on links (`lstat`, `readlink`,
  `exists`, `unlink`, `rename`, `rmdir`) act on the last component itself. Files are opened non-blocking and must be regular files. One VM has at most 1024 operations and
  64 MiB of file data in flight (`nsh_core::runtime::fs`, counted in the VM's `Quotas`). `${dataDir}`, `${pluginDir}` and
  `${homeDir}` are resolved from trusted host configuration. Relative roots are anchored at the host plugin
  directory; an unconfigured anchor grants nothing. Read and write grants are separate. Environment visibility
  uses the default metadata-name list in `default-env` (language, time zone, terminal and desktop kind only: no
  identity, paths or proxies, which can carry credentials), plus explicit `process.env` names (matched exactly, ignoring case only on Windows)
  allowed by both policies. `process.exit` requests a host handler and never exits the embedding process itself.
  The engine forwards a granted request as the platform app-close command, closing its surface or standalone window.
- **Embedding limits**: `NshAppView.limits` (`NshLimits`) / `NshView.setLimits` (heap MB, stack KB, load / call
  budgets, node quota; unset / 0 keeps a default; both through `HostLimits`, as `--limits` is), from the next load;
  on macOS, Windows, Linux and GPUI `AppOptions::limits` / `AppView::set_limits` (a whole `Limits`), likewise from
  the next load. nsh's own Android activities run apps on their own (`NshView.useStandaloneLimits`, package-private).

Implementation: `crates/nsh-js/src/sandbox.rs` (limits, budgets, hardening), `crates/nsh-core/src/access.rs`
(capabilities), `crates/nsh-engine/src/access.rs` (`fetch` and redirects).

Standard networking: global `fetch` keeps engine checks and redirect handling. A `network.http` rule (`HttpGrant`,
one form) names a `host` pattern; every other key narrows it and is optional: `methods` (any), `schemes` / `scheme`
(any of `http`, `https`, `ws`, `wss`), `port` (any; a URL without one has its scheme's default), `paths` (exact,
without the query) and `pathPrefixes` / `pathPrefix` / `path_prefixes` (whole segments: `/v1` covers `/v1/x`, not
`/v10`; a prefix ending in `/` covers what follows). Without paths or prefixes a rule covers every path, so
`{host, methods}` means what it always did. The spellings of a key are merged and may appear together (gpui-shell's
`scheme` and `path_prefixes` read as they are); rules serialize in one form (`schemes`, `pathPrefixes`). What cannot
match is a parse error rather than a silent grant of nothing: a scheme outside the four, port 0, a path without a
leading `/` or with `*`, `?` or `#`, a method that is not a token. WebSockets (the global and the `websocket` module)
go through `Access::allows_websocket`: a handshake is an HTTP GET, so `ws` / `wss` are checked as GETs over `http` /
`https` (or under their own scheme, for rules listing `ws` / `wss`), on the parsed URL the handshake then connects
to, before DNS; redirects are rejected; both APIs share one cap of 32 per VM (the `Quotas` kind `runtime::WEBSOCKETS`). A
`websocket` connection's unread messages are bounded by back pressure: it stops reading from the network while 8
messages or 8 MiB wait (`runtime/websocket.rs`), so the native memory one keeps stays under 16 MiB. Raw TCP
`net.connect({ host, port })` requires an exact `network.sockets` entry (`"host:port"`, no patterns, port 1 to 65535): a socket
bypasses every HTTP rule, so neither `hosts` nor `http` grants imply one, and `Capabilities::all()` (apps without a
declaration) has none. Sockets are capped at 32 per VM (the call's `System` quotas) and 4 MiB of pending writes each;
`close()` ends pending reads and writes. `zlib` decompression output is capped at 64 MiB or the heap limit if
smaller (`standard/zlib.rs` wraps LLRT's module and clamps `maxOutputLength`), and `Buffer.alloc`,
`allocUnsafe`, `allocUnsafeSlow` and `crypto.randomBytes` refuse a size past the heap limit (1 GiB without one) with a
`RangeError` (`standard/bounds.rs`; Rust's allocator would abort the process); `allocUnsafe` memory is zeroed. LLRT's
buffers are native memory the heap limit does not count, so these bound one call, not a VM's total. `fs/promises`, `process` and `net` check the call's `System` (the VM's `Access`, data directory,
`TrustedPaths`) in Rust before any work starts, and count their limits in its quotas. A call they refuse fails with
`JsError::access_denied` (`ERR_ACCESS_DENIED`, `permission` the capability's key, `resource` the path, command or
`"host:port"`), as `websocket`'s does (`resource` the URL): promise functions reject with it, `spawn` and `exit` throw it;
a used-up quota is `ERR_NSH_QUOTA_EXCEEDED`. The global `WebSocket` reports a URL not granted as a browser reports a
refused connection: `error`, then `close` (1006), after the constructor returns. The standard catalog is
eleven bare specifiers and nothing else: `node:` prefixes and other Node modules (`fs`, `child_process`,
`events`, ...) do not import, so no module reaches files, processes or sockets around these checks. See
`website/modules/standard-modules.md` for the public surface.

Opening URLs (`openUrl` of `nsh`, `TextView`'s `links="open"`; `nsh_core::open_url`) is checked in Rust
twice before anything leaves the app: the URL (`check_url`: absolute, at most 16 KiB, no whitespace or control
characters, never `javascript:`, `vbscript:`, `data:`, `blob:`, `file:`, `about:` or `asset:`, which run code or
reach the app's own data rather than another app; a web address needs a host) and the `openUrl` capability
(`Capabilities::open_url`: `true`, every scheme, or `{ "schemes": [...] }`; `Access::allows_open_url`), in the
module's call (its promise rejects: a `TypeError` for the URL, `ERR_ACCESS_DENIED` for the capability) and again in
the core for Rust callers (`false`, logged once). The embedding app's URL
handler sees only URLs that passed both (`embedding.md` "The host channel").

The system's file dialogs and file manager for local paths (`nsh_core::file_dialog`: `pick_paths`, `pick_save_path`,
`open_path`, `reveal_path`, `move_to_trash`) are Rust's only: no runtime module gives them to an app's JS, so their callers are
native code that reaches the filesystem anyway, and no capability gates them. The dialogs give only what the user
chose; the core refuses relative paths before the platform sees them. A JS face added later checks a capability in
its module call, as `openUrl` does.

`nsh`'s native SDK transport (`embedding.md` "The host channel") checks `capabilities.host` for calls and
posts before invoking embedding code, using the same name rules and grants as the platform transport. Its bounds are checked in Rust (`nsh_core::host_channel`, `nsh-js` `host_channel.rs`): event names of 1 to 256 bytes,
data as `protocol::to_json` bounds it (64 levels, 2^20 entries), 1024 calls waiting for answers per VM (one more
rejects with `ERR_NSH_QUOTA_EXCEEDED`) and 256 events kept for listeners not there yet (the oldest dropped), in the VM and in the channel while no
app runs.
