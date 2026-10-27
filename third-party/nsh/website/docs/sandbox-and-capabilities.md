---
title: Sandbox and Capabilities
description: The limits every NSH app runs under (memory, time, nodes), the language hardening of release builds, and capabilities declared in nsh.json and granted by host apps.
order: 21
group: delivery
---

# Sandbox and Capabilities

An app written in Rust is native code compiled into the app that ships it, as the rest of that app is, and runs with
its trust; its calls into NSH's services (`fetch`, images, web views, the status bar) go through the same native
checks as TSX's, under what a host grants. The TSX and JavaScript an app runs, its own or a [signed
package](./signed-packages.md) it downloads, run in a QuickJS VM per view, and everything they can do outside that VM
goes through NSH's native runtime. That makes it possible to run code you did not write, such as third-party mini apps
or downloaded updates, under rules the host app controls:

- **Limits** bound the memory, time and native resources one app can use.
- **Hardening** removes the ways to turn strings into code in release builds.
- **Capabilities** list what an app may reach: which hosts it may fetch from, which pages a web view may show, whether
  it may change the status bar. The app declares them; a host app may grant less.

A bundle holds only the app's code: the reactive graph, the renderer and every module the app imports are native. So
nothing in JS is trusted, and every limit and check is enforced in Rust; there is no JS code an app could patch to get
around them.

## Limits

Limits bound a VM: they apply to TSX and JavaScript. An app embedded in another app runs within limits its host app decides. An app on its own (packaged with
`nsh package`, the web included, or run with `nsh run`) is your own code, as a native app is: it uses the memory and
time the device gives it, and its interpreter stack of 4096 KB turns deep recursion into a `RangeError` the app can
catch.

An embedded app has these limits:

| Limit | Default | When it is hit |
|---|---|---|
| JS heap | 256 MB | The VM stops. |
| Interpreter stack | 4096 KB (also the maximum) | Deep recursion throws a `RangeError`, which the app can catch. |
| Time to evaluate the bundle | 10 s | The evaluation is cut off. |
| Time of any other call into JS | 2 s | The call is cut off; the app goes on. |
| Nodes kept | 200 000 | The VM stops. |
| Changes at once (queued operations) | 8 000 000 values | The VM stops. |
| Operations in one canvas drawing | 1 000 000 | The VM stops. |

**Time is budgeted per call, not per app.** A "call" is one thing the runtime asks JS to do: handle one event
(including the rendering it causes), bind one list row, run one timer, run one frame's `requestAnimationFrame`
callbacks, drain the microtask queue. A long-running app never accumulates time toward a limit; only a single call
that does not return in time is interrupted. Calls nested inside another share the outer call's budget.

An interrupted call ends with an exception that no `catch` can swallow, and the error is reported with the budget it
exceeded:

```text
the script was interrupted: a call into JS exceeded its budget of 2000 ms
```

The VM keeps running: the next event, timer or frame runs normally.

**Running out of memory or going over a quota stops the VM.** The error is reported once (to the host app's error
handler, and in development builds over the app), no JS runs after that, and the views stay as they were. The node
and operation quotas exist because native views and queued changes live in native memory, which the JS heap limit does
not cover: without them, an app could exhaust the device's memory through the UI.

> [!TIP]
> These limits are generous for normal apps. If you hit the 2 s call budget, the work is too long for one event
> anyway: it would freeze the app's updates for that long. Split it with `setTimeout`, or move it out of the event
> handler.

Host apps set the limits per view: `NshAppView.limits` on [iOS](./ios.md#limits),
`NshView.setLimits` on [Android](./android.md#limits), `AppOptions::limits` / `AppView::set_limits` in a
[GPUI app](./gpui.md#embedding-in-a-gpui-app). They apply from the next load.

To see in development what a TSX app does within a host app's limits, run it with
[`--limits`](./cli.md#nsh-run): `nsh run App.tsx --limits` uses the defaults above, and
`nsh run --limits memory=128MB,call=500ms` sets those two as a host app would, the rest keeping their defaults.

## Hardening

Release builds (everything not loaded from a dev server) are hardened when they load:

- `eval` is removed, and the `Function`, `AsyncFunction`, `GeneratorFunction` and `AsyncGeneratorFunction`
  constructors throw. NSH runs no code made from strings:

  ```text
  TypeError: the Function constructor is disabled: nsh runs no code from strings (development builds allow it)
  ```

- The prototypes all modules share (`Object`, `Array`, `Function`, `String`, `Number`, `Promise`, `Map`, typed arrays
  and the rest) are frozen, so one module (or one library) cannot change `Array.prototype` for everyone else.
  `Error.prototype` stays writable, so error subclasses can set `this.name`.

Freezing prototypes would normally break a common pattern, the "override mistake": assigning
`Sub.prototype.constructor = Sub` or `obj.toString = …` throws when the inherited property is frozen. NSH turns the
commonly overridden members (`constructor`, `toString`, `valueOf`, `toJSON`, ...) into accessors whose setter defines
the property on the object assigned to, so such code (and libraries like axios that use it) keeps working.

Bundles served by `nsh dev` / `nsh run` (with or without `--release`) are not hardened, so you can debug with `eval`. Test the release
behavior with `nsh test` (which hardens) or a packaged build before shipping code that relies on dynamic code.

## Capabilities

An app declares what it may reach outside its VM in `nsh.json`:

```json
{
  "name": "Quotes",
  "id": "com.example.quotes",
  "version": "1.0.0",
  "build": 3,
  "capabilities": {
    "network": {
      "hosts": ["api.example.com", "*.cdn.example.com"],
      "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }],
      "sockets": ["feed.example.com:7000"]
    },
    "webview": { "hosts": ["*.example.com"] },
    "statusBar": true,
    "clipboard": true,
    "picker": true,
    "host": ["getUserInfo", "bridge.*"],
    "openUrl": { "schemes": ["https", "mailto"] }
  }
}
```

**An app without `"capabilities"` may do everything**: a standalone app is its developer's own, and nothing is
restricted. Raw TCP sockets are granted by name in every app, through `network.sockets`, and the host's functions
through `host`. **An app with `"capabilities"` may do only what it lists**: everything else is denied. Unknown keys are
build errors, so a typo is caught when you build instead of becoming a missing permission at runtime. A [signed
package](./signed-packages.md#packages-from-newer-versions-of-nsh) from a newer NSH may declare capabilities an older
runtime does not know: they are not granted there.

### `network`

Covers `fetch` (including every redirect), WebSockets, remote images (`<Image>`, `placeholder`, canvas images,
`Image.getSize` / `Image.prefetch`), video sources and raw TCP sockets (`net.connect`).

| Key | Type | Description |
|---|---|---|
| `hosts` | `string[]` | Hosts the app may reach with any method and scheme (`http`, `https`, `ws`, `wss`). |
| `http` | `object[]` | Finer grants: a host, narrowed by any of the keys below. |
| `http[].host` | `string` | The host or host pattern (required). |
| `http[].methods` | `string[]` | Allowed methods, such as `["GET", "HEAD"]`. Missing: any. |
| `http[].schemes` | `string[]` | Allowed schemes (`scheme`: one, as a string). Missing: any of `http`, `https`, `ws`, `wss`. |
| `http[].port` | `number` | The port; a URL without one has its scheme's default (443 for `https`). Missing: any. |
| `http[].paths` | `string[]` | Exact paths, such as `["/v1/quote"]` (the query is not part of the path). |
| `http[].pathPrefixes` | `string[]` | Path prefixes covering whole segments: `/v1` covers `/v1` and `/v1/quote`, `/v1/` what follows it. `pathPrefix` (one, as a string) and `path_prefixes` read the same. |
| `sockets` | `string[]` | Raw TCP destinations for [`net.connect`](../modules/standard-modules.md), each an exact `"host:port"` (`"[::1]:9000"` for IPv6). |

An `http` rule covers every path when it lists no `paths` or `pathPrefixes`, and with both a path matching either.

Host patterns are `*` (any host), `*.example.com` (any subdomain of `example.com`, not `example.com` itself) or an
exact host name. Matching ignores case and the port. The host is taken after the last `@`, so
`https://api.example.com@evil.io/` is checked as `evil.io`.

A WebSocket handshake is an HTTP GET: `ws://` is checked as `http://` and `wss://` as `https://`, so the hosts and
`http` grants that allow a GET of the URL allow the WebSocket. A raw socket reaches past every HTTP rule, so
`sockets` lists each host and port exactly, and only `sockets` grants them.

`asset:` URIs (the app's own files) are always allowed; images and videos may also use `data:` URIs and relative
paths.

### `webview`

| Key | Type | Description |
|---|---|---|
| `hosts` | `string[]` | Hosts a [web view](./web-view-and-video.md) may show and navigate to (`http` and `https`). Without `webview`, the app may not show web pages at all. |

Top-level navigations inside the web view are checked too, by the platform's navigation delegate, before they load.
The page's own subresources (its scripts, images, XHRs) are the web content's business and are not checked.
`about:blank` and inline HTML (`html`) need only web views to be granted at all: `"webview": { "hosts": [] }`
allows them without allowing any remote page.

### `statusBar`

`"statusBar": true` lets the app change the status bar (the `statusBar` of pages and dialogs in
[`nsh/base`](../modules/nsh-base.md#status-bar), and `nsh.json`'s `"statusBar"` default).

### `clipboard`

`"clipboard": true` lets the app read and write the system clipboard ([`Clipboard`](../modules/nsh.md#clipboard)). Copying from a selectable text's edit menu is the user's own act and needs no capability.

### `picker`

`"picker": true` lets the app show the system's picker for photos ([`Picker`](../modules/nsh.md#picker)): the user
picks what reaches the app.

### `openUrl`

Lets the app open URLs outside it ([`openUrl`](../modules/nsh.md#openurl), a `TextView`'s links with
`links="open"`): `"openUrl": true` for every scheme, `"openUrl": { "schemes": ["https", "mailto"] }` for the schemes
listed. A URL whose scheme is not granted throws a `TypeError`. URLs that would run code or reach the app's own data
(`javascript:`, `data:`, `file:`, ...) are never opened, whatever the capability.

### Storage

Every app may keep its own data on the device with [`Storage`](../modules/nsh.md#storage), with no capability: the storage holds only that app's data, and the embedding app decides where it is kept.

### `host`

`host` lists the functions of the app embedding NSH that `nsh`'s `host.call(name, args)` may call: exact names
(`"getUserInfo"`) or prefixes ending in `*` (`"bridge.*"` matches `bridge.call` and `bridge.share`). `"host": true`
allows every function. A function not listed is refused, also in an app without `"capabilities"`: the host's
functions are never granted by default, and building an app that imports `host` from `nsh` without `host` warns that every
call will be refused. Names are 1 to 128 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `.`, `:` and `-`, without `..`;
the call of any other name is refused before the grants are read. End a prefix with a separator (`"bridge.*"`):
`"bridge*"` matches `bridgeAdmin` too. The host's events (`host.on(event, listener)`) reach the app's listeners as the host sends them.

```ts
import { host } from "nsh";

if (host.available()) {
  const user = await host.call("getUserInfo");
  const sub = host.on("loginChanged", (payload) => console.log(payload));
  sub.remove();
}
```

`host.available()` is true on platforms that embed a host; elsewhere `host.call` rejects with
`nsh/host: this platform has no host`.

### What a refusal looks like

| Request | Result |
|---|---|
| `fetch` | The promise rejects; the request never reaches the network. |
| Remote image | The image fails with `onError`. |
| Video source, web view source, status bar change | Nothing is shown or changed. |
| Clipboard | `writeText` and `writeImage` do nothing; `readText` resolves `""`, `readImage` `null`, `readFiles` `[]`, and `hasText` and `hasImage` `false`. |
| Picker | `pickImages` shows nothing and resolves `[]`. |
| Host call | The promise rejects, saying to add the function to `capabilities.host`; the call never reaches the host. |

Each refusal is logged once, saying which key to add:

```text
fetch GET https://evil.example.org/x is not granted: add `evil.example.org` to capabilities.network in nsh.json
```

Redirects are followed by NSH, not by the platform's HTTP stack, so every hop is checked against the capabilities. (A
streamed request body is not sent twice, so a `307` / `308` redirect of a streamed upload fails.)

### Where capabilities travel

The declaration goes with the app wherever it goes:

- `nsh build` and `nsh package` write it next to the bundle as `capabilities.json`;
- `nsh publish` puts it in the [signed package](./signed-packages.md) header, covered by the signature;
- `nsh dev` sends it with every build, so development enforces the same rules. Changing `capabilities` reloads the app
  instead of hot-patching it.

## Grants: what a host app allows

A host app that embeds NSH can grant **at most** some capabilities, in the same JSON form:

```rust
// iOS, in Rust (nsh_platform_ios::AppView)
let grant = nsh_engine::Capabilities::from_json(&serde_json::json!({
    "network": { "hosts": ["api.example.com"] }
}))?;
app.set_granted_capabilities(Some(grant));
```

```swift
// iOS
try app.grantCapabilities(#"{ "network": { "hosts": ["api.example.com"] } }"#)
```

```java
// Android
nsh.setGrantedCapabilities("{ \"network\": { \"hosts\": [\"api.example.com\"] } }");
```

A request must be allowed by **both** the app's declaration and the host's grant. With the grant above, an app that
declares `"hosts": ["*"]` can still only reach `api.example.com`, and cannot show web pages or change the status bar.
Without a grant (`nil` / `null`, the default), what each app declares applies.

Grants apply from the next load. A typical setup for third-party mini apps: grant each one only its own API host, run
it from a [signed package](./signed-packages.md) whose declaration you reviewed, and keep the default limits or lower
them.

> [!WARNING]
> [Native components](./native-components.md) the host app registers are the host's own code: capabilities do not
> apply to them. Register only components that are safe for every app the view may run.

## Summary

| Layer | Enforced by | Set by |
|---|---|---|
| Limits (heap, stack, time, nodes) | the runtime, per VM | the host app per view (embedded apps) |
| Hardening | the runtime, on load | always on outside development |
| Capabilities | the runtime (fetch, images, video, web views, status bar) | the app (`nsh.json`) and the host app (grant) |
| Code integrity | signature verification | `nsh publish`; the host app's trusted roots |

## See also

- [Signed packages](./signed-packages.md)
- [Networking](./networking.md)
- [Embedding in iOS apps](./ios.md), [Embedding in Android apps](./android.md)
