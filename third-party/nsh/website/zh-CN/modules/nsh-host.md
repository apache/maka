---
title: nsh/host
description: Host：调用嵌入 NSH 的应用或页面提供的函数，并监听它发来的事件。
order: 8.6
---

# nsh/host

`nsh/host` 连接嵌入 NSH 的应用：`NshAppView` / `NshView` 所在的原生应用，或在 Web 上运行播放器的页面。应用按名字调用宿主的函数（参数是 JSON），并监听宿主发来的事件。

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

平台是否有应答调用的宿主。在 Web 上，页面给播放器传入宿主时为 `true`（[Web 上的宿主](#web-上的宿主)）。

```tsx
import { Text } from "nsh";
import { host } from "nsh/host";

<Text>{host.available() ? "Embedded" : "Standalone"}</Text>;
```

## host.call

```ts
call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
```

以 `args`（任意 JSON 值；不传时为 `null`）调用宿主的函数 `name`，resolve 为它的返回值。函数失败时以宿主给出的错误消息拒绝；`host.available()` 为 `false` 时以 `nsh/host: this platform has no host` 拒绝；`name` 不在应用的 [`host` 能力](#能力)中，或不是合法名字（由 `A`–`Z`、`a`–`z`、`0`–`9`、`_`、`.`、`:`、`-` 组成，长度 1 到 128，不含 `..`）时也会拒绝。

调用最多等待宿主应答 30 秒，之后以 `nsh/host: <name> timed out after 30000 ms` 拒绝，之后才到的应答会被丢弃。`options.timeout` 以毫秒设置等待时间，`0` 表示不限时；大到时钟永远走不到的值（约 1e22 毫秒）同样不限时，负数、`NaN` 或无穷大则以 `nsh/host: invalid timeout <value>` 拒绝调用。计时用的是应用的时间，与它的定时器一致：在使用手动时钟的 `nsh test` 中随时钟推进。

```ts
const user = (await host.call("getUserInfo")) as { name: string };
const quote = await host.call("quote.refresh", { symbol: "AAPL" }, { timeout: 5000 });
```

## host.on

```ts
on(event: string, listener: (payload: unknown) => void): (() => void) & { remove(): void };
```

平台事件中，宿主每发送一次 `event`，就以它的数据调用 `listener`，直到调用 `remove()`。宿主在应用启动前发送的事件会在应用启动后送达，应用顶层注册的监听器能收到；监听器注册之前发送的事件不会补发给它。应用启动时的状态用 `host.call` 读取，之后的变化用 `host.on` 跟进。

```ts
const sub = host.on("loginChanged", (payload) => console.log(payload));
// 之后
sub.remove();
```

## 能力

应用调用的每个函数都必须列在 `nsh.json` 的 `capabilities.host` 中：精确的名字、以 `*` 结尾的前缀，或者用 `true` 允许全部。所有应用都是如此，没有声明其他 `capabilities` 的应用也一样：宿主的函数从不默认授予。未授权的调用会被拒绝并记录日志；构建导入了 `nsh/host` 却没有声明 `capabilities.host` 的应用时会给出警告。事件无需授权。参见[沙箱与能力](../docs/sandbox-and-capabilities.md#host)。

```json
{ "capabilities": { "host": ["getUserInfo", "bridge.*"] } }
```

## Web 上的宿主

在 Web 上，页面就是宿主。`createPlayer` 的 `host` 选项应答调用，`player.hostEvent(event, payload)` 发送事件：

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: { call: (name, args) => (name === "getUserInfo" ? { name: "Ada" } : Promise.reject(new Error(name))) },
});
player.hostEvent("loginChanged", { signedIn: true });
```

发布的应用在 `nsh.json` 中指定宿主：`web.host` 是应用目录内的一个 JS 模块（路径相对于 `nsh.json`），导出 `createHost(player)`，返回带 `call` 的对象。`nsh package --target web` 把它随站点一起发布，`nsh run --target web` 在开发页面上运行它，`nsh test` 会为测试打开的应用运行它。`web.connect` 列出宿主自己的请求访问的主机，页面的 Content-Security-Policy 在应用的 `capabilities.network` 之外允许它们。参见 [Web](../docs/web.md#宿主的函数)。

```json
{ "web": { "host": "./host.js", "connect": ["api.example.com"] } }
```

## host.params

嵌入方在启动你的应用之前设置的参数，从你的代码第一行起就可以同步读取；没有设置时是 `{}`。应用运行期间它们保持不变：之后的请求以事件的形式到来。

```tsx
const conversation = host.params.conversation as string | undefined;
mount(() => (conversation ? <Conversation id={conversation} /> : <Inbox />));
```


## 原生 SDK 通道

原生 SDK 的 `send` 会保留尚未监听的事件，最多 256 条。最后一个监听器在接收过程中取消订阅时，其余事件仍按原顺序等待；重载停机期间发送的事件交给下一次加载的应用。`host.on` 返回的订阅既可作为清理函数调用，也提供 `remove()`。`host.post(name, data)` 向原生 SDK 的处理函数投递数据，处理函数可用 `isPost` 区分投递与调用。

## 嵌入方的一侧

每个视图为它加载的所有应用保留一条通道。在加载之前设置参数，随时在任意线程发送事件，按名称注册处理函数。调用和投递需要在 `capabilities.host` 中授权。处理函数回答一次，可以立即回答，也可以稍后回答；始终没有到来的回答会让调用失败。

```rust tabs
// 任一平台的 AppView（GPUI、macOS、Windows、Linux、iOS）：它的 HostChannel。
use serde_json::json;

let host = view.host();
let mut params = serde_json::Map::new();
params.insert("conversation".into(), json!("42"));
host.set_params(params);
// 在引擎线程运行：立即回答，或把调用移走，稍后在任意线程回答。
host.handle("user.profile", |call| {
    let id = call.data()["id"].clone();
    call.resolve(json!({ "id": id, "name": "Ada" }));
});
host.send("conversation.open", json!({ "id": "43" })).unwrap();
```

```swift tabs
appView.params = ["conversation": "42"]
try appView.loadBundle(at: bundleURL)

// 在主线程运行；返回回答，或抛出错误让调用失败。
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

// 在 UI 线程运行；立即或稍后在任意线程回答。
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    profiles.load(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});
nsh.send("conversation.open", Map.of("id", "43"));
```

参见 [iOS 嵌入](../docs/ios.md#与应用通信)、[Android 嵌入](../docs/android.md#与应用通信) 和 [GPUI](../docs/gpui.md)。

> [!NOTE]
> 原生 SDK 的调用和投递与平台调用一样，需要 [`host` 能力](../docs/sandbox-and-capabilities.md#host)授权。Rust 应用直接通过嵌入方注册的函数调用其 Rust 代码（[`nativeModule`](./nsh-native.md#nativemodule) 和 Rust 导入）。
