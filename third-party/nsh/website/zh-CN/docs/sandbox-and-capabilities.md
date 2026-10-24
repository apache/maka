---
title: 沙箱与能力
description: 每个 NSH 应用运行时受到的限制（内存、时间、节点），release 构建的语言加固，以及在 nsh.json 中声明、由宿主应用授予的能力。
order: 21
group: delivery
---

# 沙箱与能力

用 Rust 编写的应用是编译进发布它的应用中的原生代码，和该应用的其余部分一样，以它的信任运行；它对 NSH 服务的调用（`fetch`、图片、
web view、状态栏）和 TSX 一样经过同样的原生检查，受宿主授予的范围约束。应用运行的 TSX 和 JavaScript（它自己的，或它下载的
[签名包](./signed-packages.md)）在每个视图一个的 QuickJS VM 中运行，它们在 VM 之外能做的一切都要经过 NSH 的原生运行时。因此，
你可以在宿主应用制定的规则下运行并非自己编写的代码，例如第三方小程序或下载的更新：

- **限制（Limits）** 约束单个应用可使用的内存、时间和原生资源。
- **加固（Hardening）** 在 release 构建中移除所有把字符串变成代码的途径。
- **能力（Capabilities）** 列出应用可以访问什么：可以向哪些主机发起 fetch、web view 可以显示哪些页面、是否可以修改
  状态栏。能力由应用声明；宿主应用可以授予得更少。

bundle 中只有应用自己的代码：响应式图、渲染器以及应用导入的所有模块都是原生的。因此 JS 中的任何东西都不受信任，所有
限制和检查都在 Rust 中执行；应用没有任何 JS 代码可以打补丁来绕过它们。

## 限制

限制约束的是 VM：它们作用于 TSX 和 JavaScript。嵌入在其他应用中的应用，在宿主应用决定的限制内运行。独立运行的应用（用 `nsh package` 打包的应用，包括 Web，以及用
`nsh run` 运行的应用）是你自己的代码，和原生应用一样：它可以使用设备给它的内存和时间；4096 KB 的解释器栈让过深的递归
抛出应用可以捕获的 `RangeError`。

嵌入的应用有以下限制：

| 限制 | 默认值 | 触发时 |
|---|---|---|
| JS 堆 | 256 MB | VM 停止。 |
| 解释器栈 | 4096 KB（也是上限） | 过深的递归抛出 `RangeError`，应用可以捕获。 |
| 执行 bundle 的时间 | 10 s | 执行被中断。 |
| 其他任意一次进入 JS 的调用的时间 | 2 s | 该调用被中断；应用继续运行。 |
| 保留的节点数 | 200 000 | VM 停止。 |
| 一次性的变更（排队的操作） | 8 000 000 个值 | VM 停止。 |
| 单次 canvas 绘制中的操作数 | 1 000 000 | VM 停止。 |

**时间按调用计算，而不是按应用计算。** 一次“调用”是运行时让 JS 做的一件事：处理一个事件（包括它引起的渲染）、绑定
一个列表行、运行一个定时器、运行一帧的 `requestAnimationFrame` 回调、清空微任务队列。长时间运行的应用不会累积时间
而触及限制；只有某一次没能按时返回的调用才会被中断。嵌套在另一次调用中的调用共享外层调用的预算。

被中断的调用会以一个任何 `catch` 都无法吞掉的异常结束，报告的错误中会写明超出的预算：

```text
the script was interrupted: a call into JS exceeded its budget of 2000 ms
```

VM 会继续运行：下一个事件、定时器或帧照常执行。

**内存耗尽或超出配额会停止 VM。** 错误只报告一次（报告给宿主应用的错误处理器，在开发构建中还会显示在应用上方），此后
不再运行任何 JS，视图保持原样。之所以有节点和操作配额，是因为原生视图和排队的变更位于原生内存中，不受 JS 堆限制约束：
如果没有这些配额，应用就可能通过 UI 耗尽设备内存。

> [!TIP]
> 对普通应用来说，这些限制相当宽松。如果你触到了 2 s 的调用预算，说明这项工作本来就不该放在一个事件里：它会让应用的
> 更新冻结那么久。可以用 `setTimeout` 把它拆开，或者把它移出事件处理函数。

宿主应用按视图设定限制：[iOS](./ios.md) 上用 `NshAppView.limits`，
[Android](./android.md) 上用 `NshView.setLimits`，[GPUI 应用](./gpui.md) 里用 `AppOptions::limits` / `AppView::set_limits`。修改从下一次加载开始生效。

开发时想看 TSX 应用在宿主应用的限制下表现如何，用 [`--limits`](./cli.md#nsh-run) 运行它：`nsh run App.tsx --limits` 使用上面的默认值，
`nsh run --limits memory=128MB,call=500ms` 像宿主应用那样设置这两项，其余保持默认值。

## 加固

release 构建（所有并非从开发服务器加载的代码）在加载时会被加固：

- 移除 `eval`，`Function`、`AsyncFunction`、`GeneratorFunction` 和 `AsyncGeneratorFunction` 构造函数会抛出异常。
  NSH 不运行由字符串生成的代码：

  ```text
  TypeError: the Function constructor is disabled: nsh runs no code from strings (development builds allow it)
  ```

- 所有模块共享的原型（`Object`、`Array`、`Function`、`String`、`Number`、`Promise`、`Map`、类型化数组等）都被冻结，
  因此一个模块（或一个库）无法为其他所有人修改 `Array.prototype`。`Error.prototype` 保持可写，以便错误子类设置
  `this.name`。

冻结原型通常会破坏一种常见写法，即所谓的 “override mistake”：当继承来的属性已被冻结时，赋值
`Sub.prototype.constructor = Sub` 或 `obj.toString = …` 会抛出异常。NSH 把常被覆盖的成员（`constructor`、`toString`、
`valueOf`、`toJSON` 等）改成访问器，其 setter 会在被赋值的对象上定义该属性，因此这类代码（以及 axios 等使用它的库）
依然可以正常工作。

由 `nsh dev` / `nsh run` 提供的 bundle（无论是否带 `--release`）都不加固，所以你可以用 `eval` 调试。在发布依赖动态
代码的功能之前，请用 `nsh test`（会加固）或打包后的构建测试 release 下的行为。

## 能力

应用在 `nsh.json` 中声明它可以访问 VM 之外的哪些东西：

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

**没有 `"capabilities"` 的应用可以做任何事**：独立应用归开发者自己所有，不受任何限制。原始 TCP socket 在每个应用中都按名称授予，即
`network.sockets`；宿主的函数也一样，即 `host`。**有 `"capabilities"` 的应用
只能做其中列出的事**：其他一律拒绝。未知的键会导致构建错误，因此拼写错误会在构建时被发现，而不会变成运行时缺失的权限。由更新的 NSH 签名的
[签名包](./signed-packages.md#由更新版本的-nsh-签名的包)可能声明了旧运行时不认识的能力：旧运行时不会授予它们。

### `network`

涵盖 `fetch`（包括每一次重定向）、WebSocket、远程图片（`<Image>`、`placeholder`、canvas 图片、`Image.getSize` /
`Image.prefetch`）、视频源以及原始 TCP socket（`net.connect`）。

| 键 | 类型 | 说明 |
|---|---|---|
| `hosts` | `string[]` | 应用可以用任意方法和协议（`http`、`https`、`ws`、`wss`）访问的主机。 |
| `http` | `object[]` | 更细粒度的授权：一个主机，由下面任意的键进一步限定。 |
| `http[].host` | `string` | 主机或主机模式（必填）。 |
| `http[].methods` | `string[]` | 允许的方法，例如 `["GET", "HEAD"]`。缺省：任意。 |
| `http[].schemes` | `string[]` | 允许的协议（`scheme`：以字符串写一个）。缺省：`http`、`https`、`ws`、`wss` 中的任意一种。 |
| `http[].port` | `number` | 端口；URL 未写端口时按其协议的默认端口（`https` 为 443）。缺省：任意。 |
| `http[].paths` | `string[]` | 精确路径，例如 `["/v1/quote"]`（查询参数不属于路径）。 |
| `http[].pathPrefixes` | `string[]` | 按完整路径段匹配的前缀：`/v1` 覆盖 `/v1` 和 `/v1/quote`，`/v1/` 覆盖其后的路径。`pathPrefix`（以字符串写一个）和 `path_prefixes` 含义相同。 |
| `sockets` | `string[]` | [`net.connect`](../modules/standard-modules.md) 可连接的原始 TCP 目标，每项是精确的 `"host:port"`（IPv6 写作 `"[::1]:9000"`）。 |

`http` 规则没有列出 `paths` 或 `pathPrefixes` 时覆盖所有路径；两者都列出时，匹配其一的路径即被覆盖。

主机模式可以是 `*`（任意主机）、`*.example.com`（`example.com` 的任意子域名，不包括 `example.com` 本身）或一个确切的
主机名。匹配时忽略大小写和端口。主机取最后一个 `@` 之后的部分，因此 `https://api.example.com@evil.io/` 会按 `evil.io`
检查。

WebSocket 握手是一次 HTTP GET：`ws://` 按 `http://`、`wss://` 按 `https://` 检查，因此允许以 GET 访问该 URL 的主机和
`http` 授权也允许这个 WebSocket。原始 socket 不经过任何 HTTP 规则，所以 `sockets` 精确列出每个主机和端口，也只有
`sockets` 能授予它们。

`asset:` URI（应用自己的文件）始终允许；图片和视频还可以使用 `data:` URI 和相对路径。

### `webview`

| 键 | 类型 | 说明 |
|---|---|---|
| `hosts` | `string[]` | [web view](./web-view-and-video.md) 可以显示和导航到的主机（`http` 和 `https`）。没有 `webview` 时，应用完全不能显示网页。 |

web view 内的顶层导航也会在加载前由平台的导航代理检查。页面自身的子资源（脚本、图片、XHR）属于网页内容自己的事，
不做检查。`about:blank` 和内联 HTML（`html`）只要求 web view 被授予即可：`"webview": { "hosts": [] }`
允许它们，但不允许任何远程页面。

### `statusBar`

`"statusBar": true` 允许应用修改状态栏（[`nsh/base`](../modules/nsh-base.md#status-bar) 中页面和对话框的 `statusBar`，以及 `nsh.json` 中 `"statusBar"` 的默认值）。

### `clipboard`

`"clipboard": true` 允许应用读写系统剪贴板（[`nsh/clipboard`](../modules/nsh-clipboard.md)）。从可选文本的编辑菜单复制是用户自己的操作，不需要这项能力。

### `picker`

`"picker": true` 允许应用显示系统的照片选择器（[`nsh/picker`](../modules/nsh-picker.md)）：由用户决定哪些内容交给应用。

### `openUrl`

允许应用在应用之外打开 URL（[`openUrl`](../modules/nsh-device.md#openurl)，以及 `links="open"` 的 `TextView` 中的链接）：`"openUrl": true` 允许所有 scheme，`"openUrl": { "schemes": ["https", "mailto"] }` 只允许列出的 scheme。scheme 未被授予的 URL 会抛出 `TypeError`。会执行代码或访问应用自身数据的 URL（`javascript:`、`data:`、`file:` 等）无论能力如何都不会打开。

### 存储

每个应用都可以用 [`nsh/storage`](../modules/nsh-storage.md) 在设备上保存自己的数据，无需任何能力：存储里只有该应用自己的数据，保存位置由宿主应用决定。

### `host`

`host` 列出 `nsh/host` 的 `host.call(name, args)` 可以调用的、嵌入 NSH 的宿主应用的函数：确切的函数名
（`"getUserInfo"`），或以 `*` 结尾的前缀（`"bridge.*"` 匹配 `bridge.call` 和 `bridge.share`）。`"host": true`
允许所有函数。没有列出的函数会被拒绝，没有 `"capabilities"` 的应用也一样：宿主的函数从不默认授予；构建导入了
`nsh/host` 却没有声明 `host` 的应用时会警告每次调用都会被拒绝。函数名由 `A`–`Z`、`a`–`z`、`0`–`9`、`_`、`.`、`:`、`-`
组成，长度 1 到 128，不含 `..`；其他名字的调用在检查授权之前就被拒绝。前缀以分隔符结尾（`"bridge.*"`）：`"bridge*"`
也会匹配 `bridgeAdmin`。宿主发来的事件（`host.on(event, listener)`）在宿主发送时
送到应用的监听函数。

```ts
import { host } from "nsh/host";

if (host.available()) {
  const user = await host.call("getUserInfo");
  const sub = host.on("loginChanged", (payload) => console.log(payload));
  sub.remove();
}
```

在嵌入了宿主的平台上 `host.available()` 为 true；在其他平台上 `host.call` 会以
`nsh/host: this platform has no host` reject。

### 被拒绝时的表现

| 请求 | 结果 |
|---|---|
| `fetch` | Promise 被 reject；请求根本不会发到网络。 |
| 远程图片 | 图片加载失败，触发 `onError`。 |
| 视频源、web view 源、状态栏修改 | 不显示也不修改任何东西。 |
| 剪贴板 | `writeText` 和 `writeImage` 不做任何事；`readText` 返回 `""`，`readImage` 返回 `null`，`readFiles` 返回 `[]`，`hasText` 和 `hasImage` 返回 `false`。 |
| 选择器 | `pickImages` 不显示任何内容，返回 `[]`。 |
| 宿主调用 | Promise 被 reject，错误信息提示把该函数加入 `capabilities.host`；调用不会到达宿主。 |

每种拒绝只记录一次日志，并说明需要添加哪个键：

```text
fetch GET https://evil.example.org/x is not granted: add `evil.example.org` to capabilities.network in nsh.json
```

重定向由 NSH 跟随，而不是由平台的 HTTP 栈跟随，因此每一跳都会按能力检查。（流式请求体不会发送两次，所以流式上传遇到
`307` / `308` 重定向会失败。）

### 能力随应用传递

声明会随应用一起走到任何地方：

- `nsh build` 和 `nsh package` 把它作为 `capabilities.json` 写在 bundle 旁边；
- `nsh publish` 把它放进[签名包](./signed-packages.md)的头部，受签名保护；
- `nsh dev` 每次构建都会发送它，因此开发时执行的是同样的规则。修改 `capabilities` 会重新加载应用，而不是热更新。

## 授权：宿主应用允许什么

嵌入 NSH 的宿主应用可以用同样的 JSON 格式授予 **至多** 哪些能力：

```rust
// iOS，用 Rust（nsh_platform_ios::AppView）
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

一个请求必须 **同时** 被应用的声明和宿主的授权所允许。在上面的授权下，即使应用声明了 `"hosts": ["*"]`，也只能访问
`api.example.com`，并且不能显示网页或修改状态栏。没有授权时（`nil` / `null`，即默认值），以各应用自己的声明为准。

授权从下一次加载开始生效。第三方小程序的典型配置是：只授予每个小程序它自己的 API 主机，从你审核过声明的
[签名包](./signed-packages.md)运行它，并保持默认限制或调低限制。

> [!WARNING]
> 宿主应用注册的[原生组件](./native-components.md)是宿主自己的代码：能力对它们不起作用。只注册对该视图可能运行的
> 每个应用都安全的组件。

## 小结

| 层 | 由谁执行 | 由谁设定 |
|---|---|---|
| 限制（堆、栈、时间、节点） | 运行时，按 VM | 宿主应用按视图设定（嵌入的应用） |
| 加固 | 运行时，在加载时 | 开发环境之外始终开启 |
| 能力 | 运行时（fetch、图片、视频、web view、状态栏） | 应用（`nsh.json`）和宿主应用（授权） |
| 代码完整性 | 签名验证 | `nsh publish`；宿主应用信任的根密钥 |

## 另请参阅

- [签名包](./signed-packages.md)
- [网络](./networking.md)
- [嵌入 iOS 应用](./ios.md)、[嵌入 Android 应用](./android.md)
