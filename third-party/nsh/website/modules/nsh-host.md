---
title: nsh/host
description: "Host: call functions of the app or page embedding NSH and listen to its events."
order: 8.6
---

# nsh/host

`nsh/host` reaches the app that embeds NSH: the native app around an `NshAppView` / `NshView`, or on the web the page that runs the player. The app calls the host's functions by name with JSON arguments and listens to the events the host sends.

```ts
import { host } from "nsh/host";
```

```ts
const host: {
  readonly params: { readonly [key: string]: unknown };
  post(name: string, data?: unknown): void;
  available(): boolean;
  call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): (() => void) & { remove(): void };
};
```

## host.available

```ts
available(): boolean;
```

Whether the platform has a host that answers calls. On the web it is `true` when the page gives the player a host ([The host on the web](#the-host-on-the-web)).

```tsx
import { Text } from "nsh";
import { host } from "nsh/host";

<Text>{host.available() ? "Embedded" : "Standalone"}</Text>;
```

## host.call

```ts
call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
```

Calls the host's function `name` with `args` (any JSON value; `null` without one) and resolves with what it returns. The call rejects with the host's error message when the function fails, with `nsh/host: this platform has no host` when `host.available()` is `false`, and when `name` is not in the app's [`host` capability](#capability) or is no valid name (1 to 128 of `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `.`, `:`, `-`, without `..`).

A call waits 30 seconds for the host's answer, then rejects with `nsh/host: <name> timed out after 30000 ms`; an answer that comes later is dropped. `options.timeout` sets the wait in milliseconds, `0` for no limit; a timeout so large the clock never gets there (about 1e22 ms) waits without limit too, and a negative, `NaN` or infinite one rejects the call with `nsh/host: invalid timeout <value>`. The time is the app's, as its timers': in `nsh test` with a manual clock it moves with the clock.

```ts
const user = (await host.call("getUserInfo")) as { name: string };
const quote = await host.call("quote.refresh", { symbol: "AAPL" }, { timeout: 5000 });
```

## host.on

```ts
on(event: string, listener: (payload: unknown) => void): (() => void) & { remove(): void };
```

Platform events call `listener` with the payload of every `event` the host sends, until `remove()`. Events the host sends before the app starts arrive once it does, so listeners registered at the top level of the app receive them; an event sent before a listener registers is not replayed to it. Read the state the app starts with through `host.call`, and follow its changes with `host.on`.

```ts
const sub = host.on("loginChanged", (payload) => console.log(payload));
// later
sub.remove();
```

## Capability

Every function the app calls must be listed in `nsh.json`'s `capabilities.host`: exact names or prefixes ending in `*`, or `true` for all of them. This holds for every app, also one without other `capabilities`: the host's functions are never granted by default. A call that is not granted rejects and is logged, and building an app that imports `nsh/host` without `capabilities.host` warns. Events need no grant. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md#host).

```json
{ "capabilities": { "host": ["getUserInfo", "bridge.*"] } }
```

## The host on the web

On the web the page is the host. `createPlayer`'s `host` option answers the calls, and `player.hostEvent(event, payload)` sends events:

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: { call: (name, args) => (name === "getUserInfo" ? { name: "Ada" } : Promise.reject(new Error(name))) },
});
player.hostEvent("loginChanged", { signedIn: true });
```

A published app names its host in `nsh.json`: `web.host` is a JS module in the app's directory, relative to `nsh.json`, exporting `createHost(player)`, which returns the object with `call`. `nsh package --target web` ships it with the site, `nsh run --target web` runs it on the development page, and `nsh test` runs it for the apps its tests open. `web.connect` lists the hosts the host's own requests reach, which the page's Content-Security-Policy allows alongside the app's `capabilities.network`. See [Web](../docs/web.md#the-hosts-functions).

```json
{ "web": { "host": "./host.js", "connect": ["api.example.com"] } }
```

## host.params

The parameters the embedding app set before it started your app, read synchronously from the first line of your code; `{}` when it set none. They stay the same while your app runs: later requests come as events.

```tsx
const conversation = host.params.conversation as string | undefined;
mount(() => (conversation ? <Conversation id={conversation} /> : <Inbox />));
```


## Native SDK channel

The native SDK's `send` keeps events until the app listens, up to 256. When the last listener unsubscribes during delivery, remaining events keep waiting in order; events sent during shutdown wait for the next loaded app. The subscription returned by `host.on` is both a cleanup function and an object with `remove()`. `host.post(name, data)` delivers data to the native SDK handler, whose `isPost` distinguishes posts from calls.

## The embedding app's side

Each view keeps one channel for every app it loads. Set parameters before loading, send events at any time from any thread, and register handlers by name. Calls and posts require the app's `capabilities.host` grant. Handlers answer once, now or later; an answer that never comes fails the call.

```rust tabs
// Any platform's AppView (GPUI, macOS, Windows, Linux, iOS): its HostChannel.
use serde_json::json;

let host = view.host();
let mut params = serde_json::Map::new();
params.insert("conversation".into(), json!("42"));
host.set_params(params);
// Runs on the engine thread: answer at once, or move the call and answer later from any thread.
host.handle("user.profile", |call| {
    let id = call.data()["id"].clone();
    call.resolve(json!({ "id": id, "name": "Ada" }));
});
host.send("conversation.open", json!({ "id": "43" })).unwrap();
```

```swift tabs
appView.params = ["conversation": "42"]
try appView.loadBundle(at: bundleURL)

// On the main thread; return the answer, or throw to reject the call.
appView.handle("user.profile") { data in
    let id = (data as? [String: Any])?["id"]
    return ["id": id ?? NSNull(), "name": try await profiles.name(of: id)]
}
appView.handle("analytics") { data, _ in analytics.log(data) }
appView.send("conversation.open", ["id": "43"])
```

```java tabs
nsh.setParams(Map.of("conversation", "42"));
nsh.loadAssetBundle("nsh");

// On the UI thread; answer now or later, from any thread.
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    profiles.load(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});
nsh.send("conversation.open", Map.of("id", "43"));
```

See [Embedding on iOS](../docs/ios.md#talking-to-the-app), [Embedding on Android](../docs/android.md#talking-to-the-app) and [GPUI](../docs/gpui.md).

> [!NOTE]
> Native SDK calls and posts use the same [`host` capability](../docs/sandbox-and-capabilities.md#host) as platform calls. A Rust app reaches the embedding app's Rust directly, through the functions it registers ([`nativeModule`](./nsh-native.md#nativemodule) and Rust imports).
