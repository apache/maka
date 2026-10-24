---
title: 网络
description: 用 fetch 发起 HTTP 请求：JSON、请求头、用 FormData 上传、流式响应与请求体、用 AbortController 取消、错误处理，以及应用声明的网络能力。
order: 46
group: ui
---

# 网络

NSH 应用用 `fetch` 发起 HTTP 请求：在 Rust 中是 `nsh_core::ui::prelude` 的函数，在任务中 await；在 TSX 中是标准的全局函数。两者都运行在平台的网络栈上（iOS 上是 NSURLSession，Android 上是 HttpURLConnection，[在 Web 上](./web.md#带-rust-组件的应用)是浏览器的），因此请求使用系统的 TLS、代理和 HTTP/2，并经过相同的[能力检查](#能力声明应用可以访问哪些主机)。Rust 的 `fetch` 接受 URL 或 `HttpRequest`，返回完整的响应（`HttpResponse`：`status()`、`ok()`、`header(name)`、`text()`、`body`）。TSX 的 `fetch` 双向流式传输：响应体随网络栈的交付以流的形式到达，请求体也可以是一个边生成边发送的流。TSX 还具备 Fetch API 的配套对象：`Headers`、`Request`、`Response`、`AbortController`、`FormData`、`Blob`、`File`、`URL`、`URLSearchParams`、`TextEncoder` / `TextDecoder` 以及 Web Streams。

## 获取 JSON

```rust tabs
use nsh_core::ui::prelude::*;

#[derive(Clone, PartialEq)]
struct Post {
    id: u64,
    title: String,
}

fn parse(body: &str) -> Result<Vec<Post>, String> {
    let posts: Vec<serde_json::Value> = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok(posts
        .iter()
        .map(|p| Post {
            id: p["id"].as_u64().unwrap_or_default(),
            title: p["title"].as_str().unwrap_or_default().to_owned(),
        })
        .collect())
}

#[component]
fn App() -> impl IntoElement {
    let posts = resource(
        || Some(()),
        |(), _| async move {
            let response = fetch("https://jsonplaceholder.typicode.com/posts?_limit=5").await?;
            if !response.ok() {
                return Err(format!("HTTP {}", response.status()));
            }
            parse(&response.text())
        },
    );
    scroll().flex_1().child(
        view()
            .p_4()
            .pt(px(60.0))
            .gap_2()
            .child(
                text(move || {
                    if posts.loading() { "loading…".to_owned() } else { posts.error().unwrap_or_default() }
                })
                .text_color(rgb(0x57606a)),
            )
            .child(each(
                move || posts.get().unwrap_or_default(),
                |post| post.id,
                |post, _| text(move || post.with(|p| p.title.clone())).number_of_lines(1),
            )),
    )
}
```

```tsx tabs
import { mount, resource, Scroll, Text, View } from "nsh";

type Post = { id: number; title: string };

function App() {
  const posts = resource(async ({ signal }) => {
    const response = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=5", { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Post[];
  });

  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 16, paddingTop: 60, gap: 8 }}>
        <Text style={{ color: "#57606a" }}>{posts.loading() ? "loading…" : String(posts.error() ?? "")}</Text>
        <Each of={posts() ?? []}>{(post) => <Text numberOfLines={1}>{post().title}</Text>}</Each>
      </View>
    </Scroll>
  );
}

mount(App);
```

[`resource`](./reactivity.md#resource) 会保存值、错误以及是否正在加载；source 变化（或调用 `refetch()`）时重新加载；对于不再需要的加载（组件被移除，或有更新的加载开始）会取消请求：Rust 中丢弃加载任务，其请求随之取消；TSX 中通过它传入的 `signal` 取消。Rust 的 `fetch` 使用绝对 URL；JSON 用 `serde_json` 等 crate 解析。

在 TSX 中，`Response` 的响应体只能读取一次，可以用 `json()`、`text()`、`arrayBuffer()`、`bytes()`、`blob()` 或 `formData()`，也可以读取 `body` 流。2xx 状态码时 `response.ok` 为 true；与浏览器一样，HTTP 错误状态码不会让 promise 被拒绝。

## 发送数据

```rust tabs
use nsh_core::ui::prelude::*;

// JSON
let body = serde_json::json!({ "title": "Groceries", "items": ["milk", "eggs"] });
let created = fetch(
    HttpRequest::post("https://api.example.com/notes", body.to_string())
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}")),
)
.await?;

// URL 编码的表单
fetch(
    HttpRequest::post("https://api.example.com/login", "user=ada&password=…")
        .header("Content-Type", "application/x-www-form-urlencoded"),
)
.await?;

// 其他方法
fetch(HttpRequest::new("DELETE", "https://api.example.com/notes/1")).await?;
```

```tsx tabs
// JSON
const created = await fetch("https://api.example.com/notes", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: "Groceries", items: ["milk", "eggs"] }),
});

// URL 编码的表单
await fetch("https://api.example.com/login", {
  method: "POST",
  body: new URLSearchParams({ user: "ada", password: "…" }),
});

// 查询字符串
const url = new URL("https://api.example.com/search");
url.searchParams.set("q", "native shell");
url.searchParams.set("page", "2");
const results = await (await fetch(url)).json();
```

`HttpRequest::new(method, url)`、`get` 和 `post` 创建请求，`.header(..)` 和 `.body(..)` 补充它。在 TSX 中，`body` 可以是字符串、`URLSearchParams`、`FormData`、`Blob` 或 `File`、`ArrayBuffer` 或类型化数组，或者 `ReadableStream`。

### 用 FormData 上传文件

在 TSX 中，`FormData` 请求体以带 boundary 的 `multipart/form-data` 发送。即使某个库事先设置了默认的 `Content-Type`，NSH 也总会为 `FormData` 请求体设置这个类型，因为缺少 boundary 时服务器无法解析。

```ts
const form = new FormData();
form.append("title", "Sunset");
form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "sunset.jpg");

const response = await fetch("https://api.example.com/photos", { method: "POST", body: form });
```

### 上传用户选中的照片

[`nsh/picker`](../modules/nsh-picker.md) 把用户选中的照片交给应用，它们是字节留在原生侧的文件，已经缩小并转成服务器认的格式；
Rust 直接发送字节，TSX 把 `File` 加进 `FormData`：

```rust tabs
use nsh_core::geometry::DevicePixels;
use nsh_core::picker::PickRequest;
use nsh_core::ui::prelude::*;

let mut request = PickRequest::new(false, 1);
request.max_dimension = Some(DevicePixels(2048));
let picked = pick_images(request);
spawn(async move {
    if let Some(photo) = picked.await.into_iter().next() {
        let upload = HttpRequest::post("https://api.example.com/photos", photo.data.to_vec())
            .header("Content-Type", photo.mime.as_str());
        let _ = fetch(upload).await;
    }
});
```

```tsx tabs
import { Picker } from "nsh/picker";

const [photo] = await Picker.pickImages({ maxDimension: 2048 });
if (photo) {
  const form = new FormData();
  form.append("photo", photo.file);
  await fetch("https://api.example.com/photos", { method: "POST", body: form });
}
```

## 流式传输

TSX 的 `fetch` 流式传输响应和请求体；Rust 的 `fetch` 随响应一次给出完整的响应体。

### 边到达边读取响应

`response.body` 是一个 `ReadableStream<Uint8Array>`，随网络送达的字节逐步填充。逐块读取它，可以显示进度，或在服务器推送的行到达时立即处理：

```ts
const response = await fetch("https://api.example.com/large.csv");
const total = Number(response.headers.get("Content-Length") ?? 0);
let received = 0;

for await (const chunk of response.body!) {
  received += chunk.length;
  progress.set(total ? received / total : 0);
}
```

文本流用 `TextDecoderStream` 解码，再用 `TransformStream` 拆成行：

```ts
const response = await fetch("https://api.example.com/events", { headers: { Accept: "text/event-stream" } });
let rest = "";
const lines = response
  .body!.pipeThrough(new TextDecoderStream())
  .pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) controller.enqueue(line);
      },
    }),
  );

for await (const line of lines) {
  if (line.startsWith("data: ")) messages.update((m) => [...m, line.slice(6)]);
}
```

背压贯穿全程：响应中有超过 1 MiB 的数据尚未读取时，请求会在网络层暂停，直到你的代码跟上。

### 流式发送请求体

`ReadableStream` 请求体会在网络栈需要时逐块发送（分块传输）。按照 Fetch 标准的要求，传入 `duplex: "half"`：

```ts
const encoder = new TextEncoder();
const body = new ReadableStream<Uint8Array>({
  async start(controller) {
    for (const line of logLines) controller.enqueue(encoder.encode(line + "\n"));
    controller.close();
  },
});

await fetch("https://api.example.com/logs", { method: "POST", body, duplex: "half" });
```

流式请求体无法发送第二次，因此流式请求遇到 307 或 308 重定向会失败。

## 取消与超时

在 Rust 中，请求在任务中运行，并随任务一起取消：任务所属的组件被移除时，或对 `spawn` 返回的任务调用 `cancel()` 时。在 TSX 中，传入 `AbortSignal` 即可取消请求；promise 会以 signal 的 reason 被拒绝（默认是 `AbortError` 类型的 `DOMException`），正在读取的响应体也会停止。

```rust tabs
let task = spawn(async move {
    if let Ok(response) = fetch(format!("https://api.example.com/search?q={query}")).await {
        results.set(response.text());
    }
});

// 用户又输入了：取消上一次搜索。
task.cancel();
```

```tsx tabs
const controller = new AbortController();
const request = fetch("https://api.example.com/search?q=" + encodeURIComponent(query), { signal: controller.signal });

// 用户又输入了：取消上一次搜索。
controller.abort();
```

在 TSX 中，`AbortSignal.timeout(ms)` 创建一个在延迟后中止的 signal，`AbortSignal.any([...])` 组合多个 signal：

```ts
const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
```

加载数据的组件应该在销毁时取消请求：Rust 任务会自动取消，TSX 在 [`cleanup`](./reactivity.md) 中中止：

```rust tabs
use nsh_core::ui::prelude::*;

fn weather(city: String) -> impl IntoElement {
    let data = signal(String::new());
    // 组件被移除时，任务及其请求随之结束。
    spawn(async move {
        if let Ok(response) = fetch(format!("https://api.example.com/weather?city={city}")).await {
            data.set(response.text());
        }
    });
    text(move || data.get())
}
```

```tsx tabs
import { cleanup, signal, Text } from "nsh";

function Weather(props: { city: string }) {
  const data = signal<unknown>(null);
  const controller = new AbortController();
  cleanup(() => controller.abort());
  fetch(`https://api.example.com/weather?city=${encodeURIComponent(props.city)}`, { signal: controller.signal })
    .then((r) => r.json())
    .then((d) => data.set(d))
    .catch(() => {});
  return <Text>{JSON.stringify(data())}</Text>;
}
```

## 错误

没有得到 HTTP 响应的请求会失败：Rust 的 `fetch` 给出带消息的 `Err`，TSX 的 `fetch` 以 `TypeError` 被拒绝，其消息以 `Network request failed:` 开头。这发生在无网络连接、DNS 或 TLS 失败、不支持的 URL 协议，或者应用的能力声明不允许该请求时。HTTP 错误请检查 `ok()` / `status()`（TSX：`response.ok`、`response.status`）。

```rust tabs
match fetch(url).await {
    Ok(response) if response.ok() => items.set(response.text()),
    Ok(response) => error.set(format!("Server answered {}", response.status())),
    Err(message) => error.set(message), // 没有响应，或未获授权
}
```

```tsx tabs
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Server answered ${response.status}`);
  return await response.json();
} catch (e) {
  if (e instanceof DOMException && e.name === "AbortError") return; // 已取消
  showError(String(e));
}
```

## 在 Rust 组件中

Rust 组件、`#[module]` 函数和 `#[class]` 成员在任务中调用 `fetch`：组件里用 `spawn`，界面显示的值用 `resource`，导出给 TSX 的 `async fn` 则由 TSX 当作 Promise 等待。请求是一个 URL 或一个 `HttpRequest`（`HttpRequest::get(url)`、`HttpRequest::post(url, body)`、`.header(name, value)`），响应整体到达。请求归任务所有：丢弃任务，或发起它的组件消失，请求就会取消。它在每个平台和浏览器中都使用与 TSX 相同的网络栈和能力检查。

## 能力声明：应用可以访问哪些主机

应用可以在 `nsh.json` 中声明它要访问的主机。一旦存在 `"capabilities"`，未列出的一切都会被拒绝：

```json
{
  "capabilities": {
    "network": {
      "hosts": ["api.example.com", "*.cdn.example.com"],
      "http": [
        { "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }
      ]
    }
  }
}
```

| 键 | 说明 |
|---|---|
| `network.hosts` | 可以用任何方法访问的主机：`"*"`（任意主机）、`"*.example.com"`（其子域名，不含 `example.com` 本身）或主机名。 |
| `network.http` | 更精细的授权：一个 `host`，可以再限制 `methods`、`schemes`、`port`、精确的 `paths` 和 `pathPrefixes`。 |

这些检查在 NSH 的运行时中、在应用代码之外执行，请求到达网络之前就已完成：

- 被拒绝的 `fetch` 会失败（TSX 中为 `TypeError`），消息中指出需要添加的键，例如 ``Network request failed: fetch GET https://evil.io/ is not granted: add `evil.io` to capabilities.network in nsh.json``。
- **每次重定向都会再次检查。** NSH 自己跟随重定向（最多 20 次），而不交给平台处理，所以获准的主机无法把应用重定向到未获准的主机。
- 同样的 `network` 授权也适用于远程图片（包括画布中的图片和 `Image.getSize` / `prefetch`）和视频来源。应用自身包中的 `asset:` URI 始终允许。
- 主机取最后一个 `@` 之后的部分，所以 `https://ok.com@evil.io` 被视为 `evil.io`。

没有 `"capabilities"` 的应用可以访问任何主机：独立应用属于开发者自己。嵌入在宿主应用中或以[签名包](./signed-packages.md)分发的应用应当声明能力；宿主应用可以授予比应用声明更少的能力，请求必须同时被两者允许。使用 `nsh dev` / `nsh run` 开发时执行同样的能力检查。见[沙箱与能力声明](./sandbox-and-capabilities.md)。

## 与浏览器的差异

TSX 的 `fetch` 遵循 Fetch 标准，但在对应用（而不是网页）有意义的地方有所不同：

- **没有 CORS。** 应用可以访问其能力允许的任何主机；没有预检请求，也没有不透明响应。
- **没有禁止的请求头。** 应用可以设置 `Cookie`、`User-Agent`、`Origin` 等。
- **`redirect: "manual"`** 返回 3xx 响应本身（带有 `Location` 头），而不是不透明重定向。`redirect: "error"` 遇到重定向时拒绝。
- **`data:` 和 `blob:` URL** 在本地应答。`URL.createObjectURL(blob)` 生成一个 `blob:` URL，在撤销之前 `fetch` 都可以读取它。
- 浏览器专用的选项（`mode`、`credentials`、`cache`、`referrer`、`integrity`、`keepalive`、`priority`）为兼容各种库而被接受。

基于 `fetch`（以及 `AbortController`、`FormData` 和流）构建的库通常无需修改即可使用。没有 `XMLHttpRequest`；原生宿主提供全局 `WebSocket` 和 [`websocket` 模块](../modules/standard-modules.md)，按与 `fetch` 相同的授权检查。

## 相关内容

- [全局 API](../modules/globals.md)：所有全局对象及其成员。
- [沙箱与能力声明](./sandbox-and-capabilities.md)：能力、限制以及嵌入应用如何授予它们。
- [图片与资源](./images-and-assets.md)：远程图片。
- [列表](./lists.md#加载更多onloadmore)：分页加载 API 数据。
