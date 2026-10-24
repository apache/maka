---
title: Web
description: Build web apps in Rust or TSX with Native Shell components rendered as HTML and CSS, develop in the browser, and publish to any static host or CDN.
order: 16
group: platforms
demo: counter
---

# Web

Build web apps with Native Shell using the same components, styles and application logic as on native platforms. NSH renders the interface as HTML elements and CSS: text, images, inputs, scrolling, visual styles and interactions use the browser's DOM and web APIs.

`nsh package --target web` publishes the app as a static site for any web server or CDN ([Publish an app](#publish-an-app)), and `nsh run --target web` runs it in the browser while you edit it ([Develop in the browser](#develop-in-the-browser)). Every live demo on this site uses this web backend.

## What runs where

The page is built from HTML elements styled with CSS. NSH turns component updates into batches of DOM changes, while the browser displays the interface and handles scrolling, text selection and input. WebAssembly hosts the shared Rust engine for component state, layout and updates: with a Rust app's crate compiled in, or with QuickJS for a TSX app.

On every native platform the engine has its own thread and hands one `MountBatch` per commit to the main thread. A browser page has one thread, so the web build drives the same engine step by step from the page's event loop (`nsh_engine::LocalEngine`):

```text
pointer / keyboard / scroll events ─┐
setTimeout (the engine's deadline) ─┼─▶ nsh.wasm: engine turn (Rust or JS, core, layout) ─▶ one JSON batch ─▶ nsh.js: DOM
requestAnimationFrame ──────────────┘                                                 ▲
                                                          native animation outputs ───┘
```

- **Layout is the core's.** Every view is an absolutely positioned element at the frame Taffy computed, so flexbox, grid, `aspectRatio` and percentages behave exactly as on devices. The browser's own layout is not involved.
- **Styles are turned into CSS in Rust.** Background, borders, radii, shadows (`shadow*` and `boxShadow`), gradients, filters, `backdropFilter`, transforms, `transformOrigin`, `outline`, `mixBlendMode`, transitions and the built-in keyframe animations become CSS properties. Tailwind classes, `active:`, `hover:` and `focus:` states and `dark:` all resolve natively, as they do on devices.
- **Text is laid out in Rust** with font measurements from the browser (`CanvasRenderingContext2D.measureText`) and drawn run by run at the positions the layout chose, so what was measured is what is drawn. Lines break after spaces, around CJK characters and at `\n`; `numberOfLines` truncates with an ellipsis.
- **Native animations run in Rust** on `requestAnimationFrame`: `Animated` timing, spring and decay, `interpolate`, animated values bound to `opacity`, `transform` and `backgroundColor`, drags bound with `pan`, scroll-linked values and canvas arguments. JS is not involved per frame, as on devices. `LayoutAnimation`, style transitions, the `animate-*` keyframes and screen transitions move as on the desktop backends, and `prefers-reduced-motion` turns them off (screens fade).
- **Input:** presses with `activeStyle` / `active:` feedback and long presses, the responder system (`onTouch*`, `PanResponder`), native drags and two-finger pinch and rotation, scroll views (the browser's scrolling), pull to refresh, zooming scroll views (pinch, ctrl+wheel and touchpad pinches, `zoomTo`), `<Input>` with controlled values, focus and submit, `Canvas`, `NavStack` and `NavPage` with the page's `header`, `Dialog`.
- **System UI is drawn in the page:** `AlertDialog` looks like the desktop backends' dialogs on desktop browsers and like iOS's on phones (with the `desktop` idiom, see below), and `Toast.show` shows a toast at the bottom. Custom fonts are measured again once the browser has loaded them, and an app waits for the fonts it imports before its first frame shows.
- **Dialogs** are a layer over the whole app that shows the app's popup and backdrop, as on the desktop backends. Escape, the browser's back button and a press on the backdrop close them (`closeOnEscape`, `closeOnBackdropPress`), and `animation`, `onOpen`, `onClose`, `onCancel` and `onOpenChange` work as on devices.

## Keyboard, mouse and touch

Published apps behave as desktop apps in desktop browsers and as phone apps in phone browsers:

- **Wheels and touchpads** scroll the innermost scroll view along their axis that can still move (a vertical wheel scrolls a horizontal list when nothing vertical can), and stay on it until the scroll ends; wheel notches glide, paging and snapping views move one page per scroll. Ctrl + wheel and touchpad pinches pinch views with native pinch values instead of zooming the page. Dragging with the mouse does not scroll, as on the desktop platforms: mouse drags go to pans, the responder system and text selection. Scroll views report `onScrollDragStart` / `onScrollDragEnd`, `onMomentumStart` / `End` and `onScrollEnd` as on the desktop platforms.
- **Keyboard**: Tab and Shift+Tab move between pressables and inputs (a focus ring and `focus:` styles show the keyboard focus); Return presses the focused pressable, Space presses it when released; arrows, Page Up / Page Down, Space, Home and End scroll the scroll view around the focus or under the mouse; Escape leaves a field, closes the dialog, then goes back. `nsh/keymap` shortcuts work in the browser, matched on the spot (`mod` is Command in Safari and Chrome on a Mac, Control elsewhere).
- **Going back**: Escape, Alt+Left (Cmd+[ on a Mac) and the mouse's back button close the newest dialog or pop the innermost stack, as the Android back button does; `popOnBack` and `onBackPress` work as there. When the app is the whole page, every pushed page and open dialog is a browser history entry, so the browser's back button goes back in the app.
- **Touch**: only scroll views pan; the page itself never scrolls, zooms or pulls to refresh under the app, and taps have no delay. In an iframe, swipes the app does not take scroll the embedding page. Drags on views with native pans, pinches and the responder system are the app's.
- **Accessibility**: `role`, `accessibilityLabel`, `accessibilityHint`, `accessibilityState`, `accessibilityValue`, `accessibilityLiveRegion` and `accessibilityElementsHidden` become ARIA; `announce` speaks through a live region and `setAccessibilityFocus` moves the focus. Views under a dialog or alert are inert.
- **Selection and menus**: in desktop browsers text is selectable by default, as on a web page, except inside interactive elements (views with press or touch handlers: buttons, pressable rows, tabs) and text with `selectable={false}` or `select-none`; dragging the mouse over it selects it, Ctrl/Cmd+C copies it line by line and Ctrl/Cmd+A selects all of the text the selection is in. In phone and tablet browsers only `selectable` text is selectable, as in native apps. The browser's context menu appears only in selectable text and inputs.


## Apps with Rust components

An app written in Rust ([Building with Rust](./rust.md)) publishes and runs in the browser from its directory:

```sh
nsh package --target web           # .nsh/out/<Name>/: the app's own nsh.wasm, with its crate
nsh run --target web               # the dev server's page; editing the Rust code builds it again
```

When `nsh.json` names the app's root component (`"root"`), the page is the app's Rust and NSH's page script, and
nothing else: `nsh.wasm` holds the engine, the components and the app's crate with no QuickJS, the site has no
`app.nshc` or `harden.nshc`, and the page mounts the root as soon as the runtime and the fonts are in. The whole Rust
gallery is 3.3 MB (1.06 MB gzipped, 0.75 MB with brotli), less than the runtime of TSX apps. Under its TSX entry
(`nsh package App.tsx --target web`), the same app runs as TSX apps do, with QuickJS, and imports the crate's
components and modules.

Either way the crate's assets (`assets!()`) are published with the app's, and its fonts load before the first frame.
During `nsh run --target web`, a change to the crate's Rust code builds the runtime again and the open page loads it by
itself; TSX edits stay hot updates.

Rust code that runs on every platform, the web included, uses the engine's services: `fetch(url).await` makes
HTTP requests through the same network stack as JS's `fetch` (the browser's here, with its CORS rules); `timer`,
`set_timeout` and `set_interval` wait; and `nsh_core::time::Instant` and `nsh_core::time::unix_ms()` read the clock.
`background` and `blocking` run work on the native targets' threads.

The build needs the Rust target and a clang that compiles to WebAssembly, as the runtime's own build does:
`rustup target add wasm32-unknown-unknown`, plus `clang` and `llvm-ar` (on macOS, an LLVM toolchain such as
Homebrew's `llvm`, through `CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown`).

### Browser APIs from Rust

A crate can call the browser's own APIs through [wasm-bindgen](https://wasm-bindgen.github.io/wasm-bindgen/) and
its `web-sys` and `js-sys` crates, behind `#[cfg(target_arch = "wasm32")]`: a WebSocket, `IndexedDB`, the
clipboard, any Web API, and JS of the crate's own (`#[wasm_bindgen(inline_js = …)]`, `module = "/js/…"`). When the
app's web runtime calls JS this way (including `JsValue` conversions), `nsh` runs the `wasm-bindgen` CLI on it and
ships its glue and the crate's JS next to the runtime, in development and in published sites alike. The CLI's version is the one of the `wasm-bindgen`
crate the runtime links, which `nsh` names: `cargo install wasm-bindgen-cli --version <version> --locked` installs it
(`NSH_WASM_BINDGEN` names a CLI elsewhere than on `PATH`). A runtime that links wasm-bindgen and calls no JS through
it (through a dependency's default features) builds as every other runtime does.

The crate names the APIs it uses as `web-sys` features, and pinning `wasm-bindgen` keeps its version, and so the
CLI's, the same from build to build:

```toml
[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "=0.2.129"
web-sys = { version = "0.3", features = ["WebSocket", "MessageEvent"] }
futures-channel = "0.3"
```

The browser's callbacks (a message arriving, a timer of the page's) wake the app's tasks, which run at once:

```rust
#[cfg(target_arch = "wasm32")]
async fn echo(url: &str, text: String) -> Result<String, String> {
    use wasm_bindgen::{JsCast, prelude::*};
    let ws = web_sys::WebSocket::new(url).map_err(|e| format!("{e:?}"))?;
    let (tx, rx) = futures_channel::oneshot::channel();
    let tx = std::cell::RefCell::new(Some(tx));
    let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
        if let (Some(tx), Some(data)) = (tx.borrow_mut().take(), e.data().as_string()) {
            let _ = tx.send(data);
        }
    });
    ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    on_message.forget();
    let open = ws.clone();
    let on_open = Closure::<dyn FnMut()>::new(move || {
        let _ = open.send_with_str(&text);
    });
    ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    on_open.forget();
    rx.await.map_err(|_| "closed".to_owned())
}
```

A crate's calls of browser APIs run with the page's own permissions, as a crate's native code runs with the app's
on the other platforms: the capabilities of `nsh.json` govern what goes through the engine (`fetch`, the app's JS),
and the browser's rules (CORS, the page's Content-Security-Policy) govern every request the page makes.

## Publish an app

```sh
# A Rust app, from its directory
nsh package --target web                   # .nsh/out/<Name>/: a static site
nsh package --target web --run             # and serve it on this machine (open the address it prints)

# A TSX app
nsh package App.tsx --target web
nsh package App.tsx --target web --run
```

`nsh package --target web` writes `.nsh/out/<Name>/` (`--out` for another directory), laid out like a frontend build: one
page and files named after their content.

| File | What it is |
|---|---|
| `index.html` | The app's page: its name as the title, the icons, the colors of its `appearance`, a loading indicator, and a message when the app cannot load or start |
| `manifest.webmanifest` | The name, id, icons and colors browsers install the app with |
| `nsh.<digest>.js` | The DOM runtime, minified (79 KB, 22.5 KB with brotli) |
| `nsh.<digest>.wasm` | A Rust app: the engine, the components and your crate (3.3 MB for the whole Rust gallery, 0.75 MB with brotli). A TSX app: the engine, the core, the runtime's modules and QuickJS without its compiler (about 3.5 MB, 1.2 MB gzipped, 0.93 MB with brotli) |
| `nsh-bindgen.<digest>.js` | The wasm-bindgen glue of an app whose crates call [browser APIs from Rust](#browser-apis-from-rust), minified |
| `snippets.<digest>/<crate>-<hash>/…` | The JS of those crates that the glue imports (`inline_js`, `module = "/js/…"`), under the paths wasm-bindgen gives it |
| `app.<digest>.nshc` | A TSX app, built as `nsh build --release --split` builds it, compiled to QuickJS bytecode: nothing is compiled in the browser, so it starts sooner |
| `harden.<digest>.nshc` | With a TSX app, the [sandbox's](./sandbox-and-capabilities.md) hardening, compiled likewise (1.4 KB) |
| `host.<digest>.js` | The page's host, `nsh.json` `web.host` ([the host's functions](#the-hosts-functions)) |
| `chunks/<name>.<digest>.nshc` | With a TSX app, what `import()` loads, compiled likewise, downloaded the first time it is imported ([split bundles](#split-bundles)) |
| `assets/<path>.<digest>.<ext>` | Every asset the app imports, loaded from its URL when it is used (fonts before the code that registers them runs, as text is measured with them: before the app starts, or with the chunk that imports them) |
| `icons/<size>.<digest>.png` | The icon of `nsh.json` at 32 (favicon), 180 (`apple-touch-icon`), 192 and 512 pixels |

`<digest>` is the start of the SHA-256 of the file's content: a file's name changes exactly when its content does, so a
new release changes only `index.html` and the files that really changed. Everything uses relative URLs, so the site
works from any directory of any host (`https://example.com/apps/counter/`).

### Deploy it

Upload the directory to any static host: an object store behind a CDN, Cloudflare Pages, Netlify, GitHub Pages,
nginx. Two rules make it load fast and update reliably:

| Files | `Cache-Control` |
|---|---|
| `index.html`, `manifest.webmanifest` | `no-cache` (revalidated on every load, so a release shows at once) |
| everything else | `public, max-age=31536000, immutable` |

Serve `.wasm` as `application/wasm` (browsers then compile it while it downloads) and let the host or CDN compress
text and WebAssembly (gzip or brotli). `nsh package --target web --run` serves the site this way on
`http://127.0.0.1:4173/`.

An app published for the web runs like a packaged native app: as a release, a TSX app [hardened](./sandbox-and-capabilities.md)
(no `eval`), with the capabilities its `nsh.json` declares. When they restrict `network`, the page also carries a
Content-Security-Policy `connect-src` with the declared hosts (and the page's own origin), so the browser itself
refuses requests and redirect hops to any other host. An error that keeps it from starting is shown on the page;
later errors go to the browser's console.

### Embed it with an iframe

There is no embedding API on the web: embed the published app with an `<iframe>`. Its size is the app's window:

```html
<iframe src="https://apps.example.com/counter/" title="Counter"
        style="width: 390px; height: 844px; border: 0"></iframe>
```

## Develop in the browser

```sh
nsh run --target web               # a Rust app, from its directory
nsh run App.tsx --target web       # a TSX app
```

starts the dev server and prints its page's address, `http://127.0.0.1:8790/`: open it in any browser. The page is a development host
like the others: it runs each build of the app, shows build errors and runtime errors over the app, and sends the app's
logs to the terminal. A change to a Rust app's crate builds its runtime again and the open page loads it by itself;
TSX edits are applied in place (hot updates). Phones on the same network open the
address `nsh run` prints under it (`on this network: http://192.168.…:8790/`). `nsh dev` serves the same page once the
web runtime is there (in the distribution, always).

## Build the website's player

```sh
cargo xtask web                       # nsh.wasm, nsh.js, the player and website/demos/*.tsx
cargo xtask web --out target/play     # somewhere else
```

The output directory holds:

| File | What it is |
|---|---|
| `gallery/nsh.<digest>.wasm` | The runtime of published apps (about 3.5 MB, 1.2 MB gzipped, 0.93 MB with brotli; built with the `web` profile), shared by the player and the gallery |
| `nsh-playground.wasm` | The same plus NSH's TSX compiler, for the [playground](#the-playground) (about 8 MB, 2.4 MB gzipped) |
| `gallery/nsh.<digest>.js` | The DOM runtime (minified): loads the wasm, applies batches, turns input into events |
| `index.html` | A player page: runs `demos/<name>.nshc` for `#<name>` |
| `demos/<name>.nshc` | Each demo compiled by `nsh build --release` |
| `gallery/` | The gallery app published with `nsh package --target web`, shown on the [Gallery](/gallery) page |

Serve the directory with any static server (it needs the `application/wasm` MIME type for streaming compilation) and open `index.html#counter`.

## The playground

The [Playground](/playground) edits and runs an app in the browser: the page compiles the TSX with NSH's own JSX compiler (built into `nsh-playground.wasm`, without rolldown) and runs it on every pause in typing. Every demo on this site has an **Edit in Playground** link, and **Share** puts the code in the link itself, so nothing is stored on a server.

A playground app is one module: it imports NSH's modules (`nsh` and `nsh/*`) but no other files or packages. `console.log` output and errors appear below the phone.

The compiler is also a Rust function, `nsh_bundler::compile_module(name, source, ui_sets)`, available without the crate's `bundle` feature.

## Embed it in a page

A Rust app is embedded as its published site, in an [iframe](#embed-it-with-an-iframe). For TSX, `nsh.js` is an ES
module. `createPlayer` loads the runtime into a container; `run` starts a bundle that `nsh build` writes: `bundle.nshc`, its bytecode, as bytes, or `bundle.js` as a string. The runtime `nsh package --target web` ships (`nsh.wasm`) has no JavaScript compiler and runs bytecode only; the development runtime (`nsh-dev.wasm` in the distribution) runs both:

```js
import { createPlayer } from "./nsh.js";

const player = await createPlayer(document.querySelector("#phone"), {
  wasm: "./nsh.wasm",
  assetBase: "./assets/",   // where `asset:/…` URIs (image imports) are served from
  // dark: true,            // force an appearance; otherwise it follows the system
  // idiom: "phone",        // force "phone", "pad" or "desktop"; otherwise the pointer and the size decide
  // history: false,        // pages and dialogs as browser history entries; by default only when the app is the page, not in an iframe
});
player.run(await (await fetch("./bundle.nshc")).arrayBuffer());
```

`assets` (a map from `asset:/` paths to URLs) replaces `assetBase`, `readAsset(uri)` returns the bytes of an asset the engine needs at once (a font) or `null`, and `glue` is the URL of the wasm-bindgen glue of a runtime whose crates call [browser APIs from Rust](#browser-apis-from-rust) (`nsh-bindgen.<digest>.js`), which the player loads with the runtime; `player.run(code, { release: true, capabilities })` runs a bundle as a release under the capabilities it declares (the default is development settings); with bytecode, a release also takes the hardening's bytecode (`harden`, the bytes of `harden.<digest>.nshc`). The page `nsh package --target web` writes uses all of them.

`run(code, { chunks, chunkBase })` also takes where the chunks of a [split bundle](#split-bundles) are.

A page that runs code it does not own, as an app embedding NSH does, gives it limits: `run(code, { limits: "memory=128MB,call=500ms" })` sets those the page names and keeps the [embedding defaults](./sandbox-and-capabilities.md#limits) for the rest (`limits: ""`: all of them). The engine runs on the page's main thread, so the call budget also keeps the page responsive. Without `limits` the app runs on its own, as a published one does.

With `nsh-playground.wasm`, `player.runSource(tsx, name, options)` compiles TSX first, runs it with `run`'s options and returns the compile error, or `null`; `player.compile(tsx)` returns `{ code }` or `{ error }`. The website's playground runs its visitors' code with `{ limits: "" }`.

The container's size is the app's window (`windowSize()`); resizing the container resizes the app. `player.setDark(true)` switches the appearance at run time, which apps observe through `colorScheme()` and `dark:` classes.

## The host's functions

On the web the page is the app's host: it answers [`nsh/host`](../modules/nsh-host.md)'s `host.call(name, args)` and sends the events `host.on` listens to. `createPlayer`'s `host` is an object whose `call(name, args)` returns the result, or a promise of it; a throw or a rejection rejects the app's call with the error's message. `player.hostEvent(event, payload)` sends an event with a JSON payload (a payload that is not JSON throws). With a `host`, `host.available()` is `true`.

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: {
    async call(name, args) {
      if (name === "user.info") return { name: "Ada" };
      throw new Error(`no host function ${name}`);
    },
  },
});
player.hostEvent("theme", { dark: true });
```

A published app gets its host from `nsh.json`: `web.host` names a JS module in the app's directory, relative to `nsh.json`, that exports `createHost(player)`. `nsh package --target web` copies it into the site as `host.<digest>.js`, and the page runs `createHost` with the player before the app starts; what it returns (or resolves with) must have a `call` function, or the page shows that the app could not be loaded. The player `createHost` receives sends events from then on:

```json
{
  "capabilities": {
    "host": ["user.*"]
  },
  "web": { "host": "./host.js", "connect": ["api.example.com"] }
}
```

```js
// host.js
const post = (url) => (args) =>
  fetch(url, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());

// The functions the app may call, by their exact names.
const functions = new Map([
  ["user.info", post("https://api.example.com/user/info")],
  ["user.settings", post("https://api.example.com/user/settings")],
]);

export async function createHost(player) {
  addEventListener("online", () => player.hostEvent("online", {}));
  return {
    call(name, args) {
      const f = functions.get(name);
      if (!f) throw new Error(`no host function ${name}`);
      return f(args);
    },
  };
}
```

The host looks each name up as it is in a table of its functions, as above, and keeps its URLs and paths its own: `capabilities.host` grants names by their beginning (`user.*`), so a name the host turned into a path could reach what the grant leaves out. The runtime passes on names of 1 to 128 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `.`, `:` and `-`, without `..`, and rejects the call of any other name. A prefix grant ends with a separator (`bridge.*`): `bridge*` matches `bridgeAdmin` too.

Events sent before the app runs, such as from `createHost` itself, are delivered in order as soon as it starts, so the app's top-level `host.on` listeners receive them. An event sent before a listener registers is not replayed to it: an app reads the state it starts with through a call (`host.call("user.info")`) and follows its changes through events.

The host module runs in the app's page and shares its Content-Security-Policy: when the app's capabilities restrict `network`, the page's `connect-src` holds the page's origin, the hosts `capabilities.network` lists and the hosts `web.connect` lists. `web.connect` names the hosts the host module's own requests (`fetch`, `XMLHttpRequest`, `WebSocket`) reach, as patterns like those of `capabilities.network.hosts` (`api.example.com`, `*.example.com`, `"*"`), as `api.example.com` above; the app's own requests stay checked against its `capabilities`.

The module is copied as it is, so it imports other code by absolute URL. The app still needs its `host` [capability](./sandbox-and-capabilities.md) for each function it calls. `nsh run --target web` runs it on the development page, and `nsh test` runs the same module for every app its tests open, headless or in a browser (`--target web`), so the app and its host are tested together ([Testing](./testing-and-trace.md#the-pages-host)).

## The browser as a platform

`platform.os` is `"web"`. What kind of device the browser is on decides how the app behaves, as `platform.idiom`:

- `"desktop"`: a mouse (a fine pointer that hovers) and a container at least 600 points wide. `platform.select` picks `desktop` and `desktop={{…}}` props apply.
- `"pad"`: a touch screen whose short side is at least 600 points; `"phone"` otherwise. These are mobile: `platform.select` picks `mobile`.

The idiom is decided when the app starts and stays the same while it runs, as on every platform; a narrow desktop window is still a desktop, laid out for its `windowSize()`. `web={{…}}` props, `platform.select({ web })` and `web:` classes apply in browsers only; `ios={{…}}`, `native` and `ios:` do not apply there.

The page reports the rest of the environment, and keeps it current:

| Value | From the browser |
|---|---|
| Locale (`Intl`'s default) | `navigator.languages[0]` |
| Time zone (`Date`'s local time, `Intl`'s default `timeZone`) | the browser's (`Intl.DateTimeFormat().resolvedOptions().timeZone`), daylight saving time included |
| The layout direction (`rtl:` / `ltr:`) | `<html dir>` when set, else the locale's script |
| `reduceMotion()` | `prefers-reduced-motion` |
| `fontScale()` | the root element's font size / 16 px (the browser's text size setting) |
| `pixelRatio()` | `devicePixelRatio` (it changes with zoom and screens) |
| `colorScheme()` | `prefers-color-scheme` |
| `safeArea()` | `env(safe-area-inset-*)` where it overlaps the container (`viewport-fit=cover` pages on phones) |
| `keyboardFrame()` | how much of the container the on-screen keyboard covers (`visualViewport`) |

`platform.version` is `"0.0"`, and `screenReaderEnabled()` stays `false` (browsers do not tell). The browser's bars around the page are the browser's; a page's [`statusBar`](../modules/nsh-base.md#status-bar) is for the phones.

## Networking

`fetch` (with streams, `AbortController` and `FormData`) and `<Image>` URLs go through the browser's own network stack, after NSH has checked the app's [capabilities](./sandbox-and-capabilities.md). Since the requests are the browser's, the browser's rules apply:

- **Relative URLs** resolve against the page's URL, as in the browser: a published app reaches its own API with `fetch("/api/items")`, and `<Image src="/photos/a.jpg" />` loads from its own server. (Native platforms have no page, so they need absolute URLs.)
- **CORS.** A request to another origin than the page's only succeeds if that server allows the page's origin (`Access-Control-Allow-Origin`); otherwise `fetch` rejects with a network error. Only the response headers the server exposes are visible.
- **Cookies** (and HTTP authentication) are sent to the page's own origin only (`credentials: "same-origin"`), and headers browsers forbid (`Cookie`, `User-Agent`, `Host`, ...) are dropped.
- **Redirects** are followed by the browser. A redirected request that must not follow it fails: `redirect: "manual"` and `"error"`, and requests of an app whose capabilities restrict `network` (NSH checks every hop, and browsers do not reveal a redirect before following it).
- **Request bodies** that are a `ReadableStream` are collected first and sent in one piece; response bodies stream as they arrive.

## Split bundles

A TSX web app does not need to download all of its code before the first screen shows (a Rust app is one `nsh.wasm`,
which the browser compiles while it downloads). `nsh package --target web` publishes TSX apps split, with each chunk as `chunks/<name>.<digest>.nshc` and the page mapping chunks to those files (a bundle run as bytecode loads its chunks as bytecode: `Screen.nshc` next to `Screen.js`). To split a bundle yourself, `nsh build --split` puts the modules that `import()` loads into chunks of their own, next to `bundle.js`:

```sh
nsh build --release --split -o site/app
# bundle.js        the app up to its first screen
# Screen.js        import("./Screen") and what only it uses
# detail.js        what two chunks share, when they do (made by the bundler)
```

The first `import("./Screen")` downloads `Screen.js` and the chunks it imports, all at once, then evaluates them; later imports of it resolve at once. The page says where the chunks are: by default next to the page (`chunkBase`), or one URL per chunk, for files renamed with a content digest so a CDN can cache them forever:

```js
player.run(code, {
  chunks: { "Screen.js": "/app.3f2a9c.js", "detail.js": "/app.81bb07.js" },
});
```

A chunk that cannot be downloaded rejects the `import()` with a `TypeError` naming it; the next `import()` tries again. Chunk names are fixed file names from the bundle: the app cannot make the page download anything else.

The [gallery](/gallery) loads each demo this way: `lazy` (in `examples/gallery/ui.tsx`) makes a component that starts the import the first time it renders, shows a placeholder until it resolves, then renders what it loaded. Its first load is the index and the demo shown first; a font a demo imports comes with that demo's chunk. Native builds hold every module, so there the import resolves at once:

```tsx
const Stocks = lazy(() => import("./demos/Stocks").then((m) => m.Stocks));
```

## Limits

The browser decides these, and the web backend follows it:

- **Web views of other sites**: `WebView` is an `<iframe>`. Inline HTML (`html`) gets everything: `onMessage`, `postMessage`, `injectJavaScript`, the injected scripts and load events (it runs with an origin of its own, apart from the page). A page of another site only gets `postMessage` and load events with the URL it was given: browsers hide its navigations, title, history and errors from the page around it, and `userAgent` cannot be set.
- **Videos with sound that start on their own**: `Video` is a `<video>` with every prop and event, but browsers only start a video with sound after a user gesture (muted videos play).
- **Native components**: registered native components belong to the native apps that embed NSH; on the web their view stays empty, with a warning in the console.
- **Platform services**: reading the clipboard (`Clipboard.readText`, also `hasText`) needs a secure context (HTTPS) and may ask the user. Images do not report `onProgress`.
- **Text shaping details**: line breaking is a subset of UAX #14 (spaces, CJK, hyphens, and the line start and end rules of CJK punctuation: closing marks such as `。`, `，` and `」` stay off the start of a line, opening marks such as `（` and `「` off its end), with no hyphenation and no bidirectional reordering beyond the paragraph direction.

The player and the dev server run apps with development settings (no hardening); published apps run hardened. Both use the default [limits](./sandbox-and-capabilities.md).

## See also

- [Packaging](./packaging.md): the other targets of `nsh package`.
- [Architecture](./architecture.md): the engine, the core and the mount batches the web build reuses.
- [Testing](./testing-and-trace.md): `nsh test` runs the same engine headless, with an approximate text engine.
