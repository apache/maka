---
title: 全局 API
description: 每个 NSH 应用无需 import 就能使用的全局对象——fetch、流、URL、文本编码、Blob 与 FormData、事件与中止信号、Intl、定时器和 console——都用 Rust 原生实现。
order: 15
---

# 全局 API

除了 ECMAScript 标准库，NSH 应用的 JS 环境还提供一组标准全局对象：`fetch` 及其 `Headers`、`Request`、`Response`；Streams 标准；`URL` 和 `URLSearchParams`；`TextEncoder` / `TextDecoder`；`Blob`、`File` 和 `FormData`；`EventTarget`、`Event` 和 `AbortController`；定时器、`requestAnimationFrame` 和 `console`；以及用于数字与日期格式化的 `Intl`。它们都用 Rust 原生实现，遵循 WHATWG 标准，无需 import，因此大量基于这些标准的 JavaScript 库（HTTP 客户端、URL 与编码工具、流处理工具）可以直接使用。

本页列出了应用拥有的全部全局对象。它们属于 TSX 环境：Rust 代码改用 Rust 标准库、crates.io 和 `nsh_core::prelude` 中 NSH 的服务（`fetch`、定时器、任务；见[用 Rust 开发](../docs/rust.md)），表格的 Rust 列给出了对应项。界面用[元素](../elements/index.md)和应用自己的组件搭建，其余能力来自应用导入的[模块](./index.md)。

这些全局对象的 TypeScript 声明会生成到 `.nsh/types/nsh/globals.d.ts`（见[项目结构](../docs/project-structure.md)）。

| 分组 | 全局对象 | Rust |
|---|---|---|
| [控制台与计时](#控制台与计时) | `console`、`performance` | `log` crate（`log::info!` 等）、`nsh_core::time::now()` |
| [定时器与帧](#定时器与帧) | `setTimeout`、`setInterval`、`clearTimeout`、`clearInterval`、`queueMicrotask`、`requestAnimationFrame`、`cancelAnimationFrame` | `set_timeout`、`set_interval`、`timer(delay).await`、`request_animation_frame`、`next_frame().await`、`Spawned::cancel()` |
| [Base64 与错误](#base64-与错误) | `atob`、`btoa`、`DOMException` | `base64` crate、`Result` |
| [事件与中止信号](#事件与中止信号) | `EventTarget`、`Event`、`CustomEvent`、`AbortController`、`AbortSignal` | signal 和闭包；`Spawned::cancel()` 结束一个任务 |
| [URL](#url) | `URL`、`URLSearchParams` | `url` crate |
| [文本编码](#文本编码) | `TextEncoder`、`TextDecoder` | `str::as_bytes`、`String::from_utf8` |
| [Blob 与表单数据](#blob-与表单数据) | `Blob`、`File`、`FormData` | `HttpRequest` 的 `Vec<u8>` 请求体 |
| [Fetch](#fetch) | `fetch`、`Headers`、`Request`、`Response` | `fetch`、`HttpRequest`、`HttpResponse` |
| [数字与日期格式化](#数字与日期格式化) | `Intl.NumberFormat`、`Intl.DateTimeFormat`、`toLocaleString` | `format!` 和 crates.io 上的格式化 crate，配合 `locale()` |
| [流](#流) | `ReadableStream`、`WritableStream`、`TransformStream`、各类 reader、writer 和 controller、`ByteLengthQueuingStrategy`、`CountQueuingStrategy`、`TextEncoderStream`、`TextDecoderStream` | `fetch` 给出完整的响应体；在原生目标上用 `background` 任务运行长连接 |

原生宿主还提供 `Buffer`、`crypto`、`process` 和 `WebSocket`；其模块、授权和资源限制见[标准模块](./standard-modules.md)。

## 控制台与计时

```ts
declare var console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  debug(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare var performance: {
  /** Milliseconds since the JS context started, with sub-millisecond precision. */
  now(): number;
};
```

在 Rust 中，`log` crate 的宏（`log::info!`、`log::warn!` 等）写入同一份日志，同样会出现在 `nsh run` 的终端里。`console` 每次调用向运行时日志（target 为 `js`）写一行：`log` 和 `info` 为 info 级别，`debug`、`warn`、`error` 为各自的级别。多个参数以空格连接；字符串原样输出，错误对象带调用栈，函数输出为 `[Function name]`，对象和数组输出为 JSON（遇到循环引用时退回 `String(value)`）。

设备连接开发服务器期间，日志会出现在运行 `nsh run` / `nsh dev` 的终端里，并带上设备名前缀，参见[开发服务器与调试](../docs/dev-server-and-debugging.md)。

> [!NOTE]
> 只有上面这五个方法。没有 `console.table`、`console.group`、`console.time`、`console.assert`，也不支持 `%s` / `%o` 格式占位符。

`performance.now()` 就是 `requestAnimationFrame` 传给回调的那个时钟；在 Rust 中，`nsh_core::time::now()` 以及 `request_animation_frame` 和 `next_frame()` 给出的 `Instant` 都是这个时钟。`performance` 没有其他成员。

## 定时器与帧

```ts
function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
function clearTimeout(id: number | undefined): void;
function clearInterval(id: number | undefined): void;
function queueMicrotask(callback: () => void): void;
/** Runs `callback` at the next display frame with its time in milliseconds. */
function requestAnimationFrame(callback: (time: number) => void): number;
function cancelAnimationFrame(id: number): void;
```

Rust：`set_timeout(delay, f)` 和 `set_interval(period, f)` 返回一个 `Spawned` 句柄，调用其 `cancel()` 即清除；`timer(delay).await` 在任务中等待；`request_animation_frame(f)` / `next_frame().await` 给出下一帧的时间；它们都随创建它们的组件一起结束。定时器的行为与浏览器一致：缺省、负数或非有限的延迟视为 0，返回的 id 是正整数，清除不存在的 id 不会报错。`handler` 必须是函数（不会执行字符串形式的代码）。嵌套定时器不会被钳制到 4 ms。

> [!WARNING]
> `setTimeout` / `setInterval` 声明了额外的 `...args`，但目前并不会传给 handler。请改用闭包：`setTimeout(() => save(id), 100)`。

`requestAnimationFrame` 的回调在引擎产出下一帧时执行一次，同一帧的回调拿到相同的 `performance.now()` 时间。回调里再次请求的帧会在下一帧调用，所以常见的循环写法可以正常工作：

```rust tabs
spawn(async move {
    let start = next_frame().await;
    loop {
        let time = next_frame().await;
        let elapsed = time.duration_since(start).as_secs_f32() * 1000.0;
        progress.set((elapsed / 300.0).min(1.0));
        if elapsed >= 300.0 {
            break;
        }
    }
});
```

```tsx tabs
let start = 0;
function tick(time: number) {
  if (!start) start = time;
  progress.set(Math.min(1, (time - start) / 300));
  if (time - start < 300) requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

> [!TIP]
> 在 JS 里逐帧驱动动画，意味着每一帧都要在 QuickJS 中执行你的代码。样式和变换的动画请优先使用 [`nsh` 的动画 API](./nsh.md#animation)，它的驱动器在原生侧运行，不回调 JS（见[动画](../docs/animation.md)）。

## Base64 与错误

```ts
function atob(data: string): string;
function btoa(data: string): string;

class DOMException extends Error {
  constructor(message?: string, name?: string);
  readonly name: string;
  readonly message: string;
  readonly code: number;
}
```

`atob` / `btoa` 与浏览器一样，在二进制字符串和 Base64 之间转换。`DOMException` 是被中止的操作所 reject 的值：不带 reason 调用 `AbortController.abort()` 得到名为 `"AbortError"` 的 `DOMException`，`AbortSignal.timeout` 得到名为 `"TimeoutError"` 的。

## 事件与中止信号

```ts
class EventTarget {
  constructor();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null,
    options?: { capture?: boolean } | boolean): void;
  dispatchEvent(event: Event): boolean;
}

interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

class Event {
  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean });
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number; // NONE 0, CAPTURING_PHASE 1, AT_TARGET 2, BUBBLING_PHASE 3
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly composed: boolean;
  readonly isTrusted: boolean;
  readonly timeStamp: number;
  returnValue: boolean;
  cancelBubble: boolean;
  readonly srcElement: EventTarget | null; // legacy: `target`
  initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void; // legacy
  composedPath(): EventTarget[];
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

class CustomEvent<T = any> extends Event {
  constructor(type: string, init?: EventInit & { detail?: T });
  readonly detail: T;
}

class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}

class AbortSignal extends EventTarget {
  readonly aborted: boolean;
  readonly reason: any;
  onabort: ((event: Event) => void) | null;
  throwIfAborted(): void;
  static abort(reason?: any): AbortSignal;
  static timeout(milliseconds: number): AbortSignal;
  static any(signals: Iterable<AbortSignal>): AbortSignal;
}
```

这些就是 DOM 标准里的类，只有一处不同：没有节点树，事件只派发给目标本身。先执行捕获监听器，再执行其他监听器，与 DOM 在目标阶段的行为一致；`bubbles` 不起作用。这些类可以被继承，所以 `EventTarget` 可以当作一个小型事件发射器：

```ts
class Channel extends EventTarget {
  send(message: string) {
    this.dispatchEvent(new CustomEvent("message", { detail: message }));
  }
}

const channel = new Channel();
channel.addEventListener("message", (e) => console.log((e as CustomEvent<string>).detail));
channel.send("hello");
```

它们与元素的事件（`onPress`、`onChange` 等）无关，后者是 props，参见[触摸与手势](../docs/touch-and-gestures.md)。

`AbortSignal` 可以取消 `fetch` 请求和流的管道传输，也可以移除用 `{ signal }` 添加的监听器。在 Rust 中，请求运行在任务里，取消任务即取消请求：

```rust tabs
let search = spawn(async move {
    let _ = fetch("https://api.example.com/search?q=nsh").await;
});
// 之后，例如屏幕关闭时（任务也会随组件一起结束）：
search.cancel();
```

```tsx tabs
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
fetch("https://api.example.com/search?q=nsh", { signal }).catch((e) => {
  if (e.name === "AbortError" || e.name === "TimeoutError") return;
  throw e;
});
// later, for example when the screen closes:
controller.abort();
```

## URL

```ts
class URL {
  constructor(url: string | URL, base?: string | URL);
  static canParse(url: string | URL, base?: string | URL): boolean;
  static parse(url: string | URL, base?: string | URL): URL | null;
  /** A `blob:` URL `fetch` reads `blob` from, until revoked. */
  static createObjectURL(blob: Blob): string;
  static revokeObjectURL(url: string): void;
  href: string;
  readonly origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
  toJSON(): string;
}

class URLSearchParams {
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParams);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: unknown): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  toString(): string;
}
```

URL 按 URL 标准解析。`searchParams` 是双向联动的：修改参数会重写查询串，设置 `search` 或 `href` 会重新解析参数。Rust 代码使用遵循同一标准的 `url` crate：

```rust tabs
let mut url = url::Url::parse("https://api.example.com")?.join("/v1/items")?;
url.query_pairs_mut().append_pair("page", "2").append_pair("tag", "new");
url.as_str(); // "https://api.example.com/v1/items?page=2&tag=new"
```

```tsx tabs
const url = new URL("/v1/items", "https://api.example.com");
url.searchParams.set("page", "2");
url.searchParams.append("tag", "new");
url.href; // "https://api.example.com/v1/items?page=2&tag=new"
```

`URLSearchParams`（以及 `Headers`、`FormData`）的迭代器遍历的是创建迭代器那一刻的快照，并且带有迭代器辅助方法（`map`、`filter`、`toArray` 等）。

`URL.createObjectURL(blob)` 返回一个 `blob:` URL，在调用 `revokeObjectURL` 之前都可以用 `fetch`（`GET`）读取。`<Image>` 可以把它用作 `src` 或 `placeholder` 显示（[Image](../elements/image.md)）。

## 文本编码

```ts
class TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

/** UTF-8, UTF-16LE / BE and windows-1252 (with the labels of latin1 and ASCII). */
class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: BufferSource, options?: { stream?: boolean }): string;
}
```

`TextDecoder` 支持的编码比浏览器少：UTF-8、UTF-16LE、UTF-16BE 和 windows-1252（按 Encoding 标准，`latin1`、`iso-8859-1`、`ascii` 等标签也指向它）。其他标签会抛出 `RangeError`。传入 `{ stream: true }` 时，被切断在两个分块之间的多字节序列会保留到下一次调用。

## Blob 与表单数据

```ts
class Blob {
  constructor(blobParts?: Iterable<BlobPart>, options?: { type?: string; endings?: "transparent" | "native" });
  readonly size: number;
  readonly type: string;
  slice(start?: number, end?: number, contentType?: string): Blob;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
}

class File extends Blob {
  constructor(fileBits: Iterable<BlobPart>, fileName: string,
    options?: { type?: string; endings?: "transparent" | "native"; lastModified?: number });
  readonly name: string;
  readonly lastModified: number;
  readonly webkitRelativePath: string;
}

class FormData {
  constructor();
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): File | string | null;
  getAll(name: string): (File | string)[];
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
  forEach(callback: (value: File | string, key: string, parent: FormData) => void, thisArg?: unknown): void;
  entries(): IterableIterator<[string, File | string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<File | string>;
  [Symbol.iterator](): IterableIterator<[string, File | string]>;
}

type BlobPart = ArrayBuffer | ArrayBufferView | Blob | string;
```

Blob 的字节保存在内存中，`slice` 共享这些字节而不是复制。Blob 只是内存中的值：`File` 背后没有文件系统访问，`FormData` 也没有从表单元素构造的方式。

`FormData` 作为请求体时以 `multipart/form-data` 发送；`Response.formData()` / `Request.formData()` 能解析 `multipart/form-data` 和 `application/x-www-form-urlencoded`。

```ts
const form = new FormData();
form.append("title", "Holiday");
form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
await fetch("https://api.example.com/upload", { method: "POST", body: form });
```

## Fetch

```ts
/**
 * HTTP through the platform's network stack (NSURLSession,
 * HttpURLConnection), streaming both ways; `data:` and `blob:` URLs are
 * answered locally.
 */
function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  /** A ReadableStream is sent as it is read (chunked), with `duplex: "half"`. */
  body?: BodyInit | null;
  duplex?: "half";
  signal?: AbortSignal | null;
  /** "manual" gives the 3xx response itself. */
  redirect?: "follow" | "manual" | "error";
  credentials?: "omit" | "same-origin" | "include";
  cache?: "default" | "no-store" | "reload" | "no-cache" | "force-cache" | "only-if-cached";
  mode?: "same-origin" | "no-cors" | "cors";
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
  priority?: "high" | "low" | "auto";
}

type HeadersInit = Headers | Record<string, string> | Iterable<[string, string]>;
type BodyInit = ReadableStream<Uint8Array> | Blob | BufferSource | FormData | URLSearchParams | string;
```

`fetch` 通过平台自身的网络栈发送 HTTP 和 HTTPS 请求：iOS 和 Mac Catalyst 上是 `NSURLSession`，Android 上是 `HttpURLConnection`。因此系统的代理设置、TLS 配置和证书信任都会生效。`data:` URL 和 `blob:` URL（来自 `URL.createObjectURL`）在本地直接应答，不经过网络；其他协议一律 reject。Rust 的 `fetch(request)` 走同一个网络栈、受同样的能力约束，接受 URL 或 `HttpRequest`，resolve 为包含完整响应体的 `HttpResponse`（[网络](../docs/networking.md#在-rust-组件中)）：

```rust tabs
#[derive(serde::Deserialize)]
struct Todo {
    id: u32,
    title: String,
    done: bool,
}

async fn load_todos(token: &str) -> Result<Vec<Todo>, String> {
    let request = HttpRequest::get("https://api.example.com/todos").header("Authorization", format!("Bearer {token}"));
    let response = fetch(request).await?;
    if !response.ok() {
        return Err(format!("HTTP {}", response.status()));
    }
    serde_json::from_slice(&response.body).map_err(|e| e.to_string())
}
```

```tsx tabs
type Todo = { id: number; title: string; done: boolean };

async function loadTodos(): Promise<Todo[]> {
  const res = await fetch("https://api.example.com/todos", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

### Headers、Request 和 Response

```ts
class Headers {
  constructor(init?: HeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

interface Body {
  /** The body as it arrives (a byte stream), or null. */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  formData(): Promise<FormData>;
  json(): Promise<any>;
  text(): Promise<string>;
}

class Request implements Body {
  constructor(input: string | URL | Request, init?: RequestInit);
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly destination: string;
  readonly referrer: string;
  readonly referrerPolicy: string;
  readonly mode: string;
  readonly credentials: string;
  readonly cache: string;
  readonly redirect: "follow" | "manual" | "error";
  readonly integrity: string;
  readonly keepalive: boolean;
  readonly isReloadNavigation: boolean;
  readonly isHistoryNavigation: boolean;
  readonly signal: AbortSignal;
  readonly duplex: "half";
  clone(): Request;
  // ...and the Body members
}

class Response implements Body {
  constructor(body?: BodyInit | null, init?: { status?: number; statusText?: string; headers?: HeadersInit });
  static json(data: unknown, init?: ResponseInit): Response;
  static error(): Response;
  static redirect(url: string | URL, status?: number): Response;
  readonly type: "basic" | "default" | "error";
  readonly url: string;
  readonly redirected: boolean;
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: Headers;
  clone(): Response;
  // ...and the Body members
}
```

### 流式传输

响应的 `body` 是一个字节流，网络每交付一段数据就填充一段，所以大的或长连接的响应（下载、server-sent events、流式输出的模型结果）可以边到达边处理。未读取的数据超过 1 MiB 时，请求会暂停，直到应用继续读取。

```ts
const res = await fetch("https://api.example.com/events");
const lines = res.body!.pipeThrough(new TextDecoderStream());
for await (const chunk of lines) {
  console.log(chunk);
}
```

请求体是 `ReadableStream` 时，会随网络栈的需要逐块上传；按 Fetch 标准的要求，需要传 `duplex: "half"`：

```ts
await fetch("https://api.example.com/upload", {
  method: "PUT",
  body: blob.stream(),
  duplex: "half",
});
```

### 与浏览器的差异

- **没有 CORS，也没有 origin。** 应用不是网页：它可以访问[能力声明](../docs/sandbox-and-capabilities.md)允许的任何主机。`mode` 会被接受但被忽略。
- **没有禁止设置的请求头。** 应用可以设置 `Cookie`、`User-Agent`、`Origin` 等任意请求头。未指定 `Accept` 时会发送 `Accept: */*`。
- **`redirect: "manual"` 直接交付 3xx 响应本身**，带有状态码和 `Location` 头，而不是不透明的过滤响应。`"follow"` 会跟随重定向（每一跳都按能力声明检查）；`"error"` 在响应为重定向时 reject。
- **`FormData` 请求体总是使用 `Content-Type: multipart/form-data; boundary=…`**，即使已经设置了 `Content-Type` 头。HTTP 库常常先设一个默认类型，只在检测到浏览器时才清除；缺少 boundary，服务器就无法解析请求体。
- **`credentials`、`cache`、`referrer`、`referrerPolicy`、`integrity`、`keepalive` 和 `priority`** 会被校验并保存在 `Request` 对象上，但不会传给网络栈：缓存和 Cookie 的处理遵循平台网络栈自身的行为。
- **能力声明。** 当应用在 `nsh.json` 中声明了 `network` 能力（或嵌入它的宿主应用授予的更少）时，访问未被允许的主机的请求根本不会发到网络，`fetch` 以 `TypeError` reject。参见[沙箱与能力](../docs/sandbox-and-capabilities.md)。
- **错误。** 网络失败以 `TypeError` reject，消息以 `Network request failed:` 开头；中止则以 signal 的 `reason` reject。

在组件中加载数据的完整指南见[网络](../docs/networking.md)。

## 流

完整实现了 WHATWG Streams 标准：可读流（默认流和字节流、BYOB reader、`tee`、`pipeTo` / `pipeThrough`、`ReadableStream.from`、异步迭代）、可写流、转换流、两种排队策略以及文本编码流。

```ts
class ReadableStream<R = any> {
  constructor(underlyingSource: UnderlyingByteSource, strategy?: { highWaterMark?: number });
  constructor(underlyingSource?: UnderlyingDefaultSource<R>, strategy?: QueuingStrategy<R>);
  static from<R>(iterable: Iterable<R | PromiseLike<R>> | AsyncIterable<R>): ReadableStream<R>;
  readonly locked: boolean;
  cancel(reason?: any): Promise<void>;
  getReader(options: { mode: "byob" }): ReadableStreamBYOBReader;
  getReader(): ReadableStreamDefaultReader<R>;
  pipeThrough<T>(transform: { writable: WritableStream<R>; readable: ReadableStream<T> },
    options?: StreamPipeOptions): ReadableStream<T>;
  pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
  tee(): [ReadableStream<R>, ReadableStream<R>];
  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<R>;
  [Symbol.asyncIterator](options?: { preventCancel?: boolean }): AsyncIterableIterator<R>;
}

class ReadableStreamDefaultReader<R = any> {
  constructor(stream: ReadableStream<R>);
  readonly closed: Promise<void>;
  read(): Promise<{ done: false; value: R } | { done: true; value?: R }>;
  releaseLock(): void;
  cancel(reason?: any): Promise<void>;
}

class ReadableStreamBYOBReader {
  constructor(stream: ReadableStream<Uint8Array>);
  readonly closed: Promise<void>;
  read<T extends ArrayBufferView>(view: T, options?: { min?: number }): Promise<ReadableStreamReadResult<T>>;
  releaseLock(): void;
  cancel(reason?: any): Promise<void>;
}

class ReadableStreamDefaultController<R = any> {
  readonly desiredSize: number | null;
  close(): void;
  enqueue(chunk?: R): void;
  error(e?: any): void;
}

class ReadableByteStreamController {
  readonly byobRequest: ReadableStreamBYOBRequest | null;
  readonly desiredSize: number | null;
  close(): void;
  enqueue(chunk: ArrayBufferView): void;
  error(e?: any): void;
}

class ReadableStreamBYOBRequest {
  readonly view: ArrayBufferView | null;
  respond(bytesWritten: number): void;
  respondWithNewView(view: ArrayBufferView): void;
}

class WritableStream<W = any> {
  constructor(underlyingSink?: UnderlyingSink<W>, strategy?: QueuingStrategy<W>);
  readonly locked: boolean;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  getWriter(): WritableStreamDefaultWriter<W>;
}

class WritableStreamDefaultWriter<W = any> {
  constructor(stream: WritableStream<W>);
  readonly closed: Promise<void>;
  readonly desiredSize: number | null;
  readonly ready: Promise<void>;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
  write(chunk?: W): Promise<void>;
}

class WritableStreamDefaultController {
  readonly signal: AbortSignal;
  error(e?: any): void;
}

class TransformStream<I = any, O = any> {
  constructor(transformer?: Transformer<I, O>, writableStrategy?: QueuingStrategy<I>,
    readableStrategy?: QueuingStrategy<O>);
  readonly readable: ReadableStream<O>;
  readonly writable: WritableStream<I>;
}

class TransformStreamDefaultController<O = any> {
  readonly desiredSize: number | null;
  enqueue(chunk?: O): void;
  error(reason?: any): void;
  terminate(): void;
}

class ByteLengthQueuingStrategy {
  constructor(init: { highWaterMark: number });
  readonly highWaterMark: number;
  readonly size: (chunk: ArrayBufferView) => number;
}

class CountQueuingStrategy {
  constructor(init: { highWaterMark: number });
  readonly highWaterMark: number;
  readonly size: (chunk: any) => 1;
}

class TextEncoderStream {
  readonly encoding: "utf-8";
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<string>;
}

class TextDecoderStream {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  readonly readable: ReadableStream<string>;
  readonly writable: WritableStream<BufferSource>;
}
```

底层 source、sink 和 transformer 对象（`UnderlyingDefaultSource`、`UnderlyingByteSource`、`UnderlyingSink`、`Transformer`）以及 `StreamPipeOptions`（`preventAbort`、`preventCancel`、`preventClose`、`signal`）的结构与标准一致，完整声明见 `globals.d.ts`。

`TextEncoderStream` 会把被切断在两个字符串分块之间的代理对拼回一个字符，`TextDecoderStream` 会把切断在两个字节分块之间的多字节序列拼回完整字符。

一个把文本按行切分的转换流：

```ts
function lines(): TransformStream<string, string> {
  let rest = "";
  return new TransformStream({
    transform(chunk, controller) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop()!;
      for (const line of parts) controller.enqueue(line);
    },
    flush(controller) {
      if (rest) controller.enqueue(rest);
    },
  });
}

const res = await fetch("https://api.example.com/log");
for await (const line of res.body!.pipeThrough(new TextDecoderStream()).pipeThrough(lines())) {
  console.log(line);
}
```

## 数字与日期格式化

QuickJS 自身没有 `Intl`；NSH 补上了一个，在 Rust 中格式化：`Intl.NumberFormat`、`Intl.DateTimeFormat` 和 `Intl.getCanonicalLocales`，以及数字和 BigInt 的 `toLocaleString`、日期的 `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`，它们接受相同的 `locales` 和 `options`。它们的声明来自 TypeScript 自带的 `ES2023` 库，所以不在 `globals.d.ts` 中。

```ts
(1234567.891).toLocaleString();                                              // "1,234,567.891"（en-US）
(1234.5).toLocaleString("de-DE", { style: "currency", currency: "EUR" });  // "1.234,50 €"
new Intl.NumberFormat("en", { notation: "compact" }).format(1_500_000);      // "1.5M"
new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(12_345);      // "1.2万"
new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });   // "09:05"
new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date); // "Oct 16, 2026, 3:04 PM"
```

不传 `locales` 时使用设备的区域设置（iOS 的 `NSLocale.currentLocale`、Android 的 `Locale.getDefault()`）；`nsh test` 和 Web 上为 `en-US`。

- **数字**：`decimal`、`percent`、`currency`（`currencyDisplay` 为 `symbol`、`narrowSymbol`、`code`）和 `unit`（常用单位：长度、质量、时长、数据大小、温度、速度）样式；`minimumIntegerDigits`、`minimum` / `maximumFractionDigits`、`minimum` / `maximumSignificantDigits`、`roundingPriority`、`trailingZeroDisplay`、`useGrouping`、`signDisplay`；`standard`、`scientific`、`engineering` 和 `compact` 记数法（`compactDisplay` 为 `short` / `long`）。舍入方式是四舍五入（远离零），按数字的书写形式进行（`1.005` 舍入为 `1.01`，与浏览器一致）。`format` 也精确地接受 BigInt 和十进制字符串。`formatToParts` 和 `resolvedOptions` 与浏览器一致。
- **日期**：`weekday`、`year`、`month`（`numeric`、`2-digit`、`short`、`long`、`narrow`）、`day`、`hour`、`minute`、`second`、`fractionalSecondDigits`、`hour12` / `hourCycle`、`timeZoneName` 以及 `dateStyle` / `timeStyle`，使用公历。`timeZone` 支持设备时区（浏览器中为浏览器的时区）、`UTC` 和偏移量（`"+08:00"`）；其他时区名会抛出 `RangeError`（没有时区数据库）。
- **区域**：区域数据是一张常用语言的表（英语、德语、法语、西班牙语、意大利语、葡萄牙语、荷兰语、俄语、瑞典语、波兰语、土耳其语、印尼语、越南语、泰语、印地语、中文、日语、韩语）及其地区变体（`en-GB`、`en-IN`、`de-CH`、`es-MX`、`pt-PT`、`zh-TW` 等），而不是完整的 CLDR，所以细节可能与浏览器的输出不同。没有数据的区域会依次回退到下一个请求的区域、设备的区域、`en-US`；俄语、瑞典语、波兰语、土耳其语、印尼语、越南语、泰语和印地语的日期没有月份名（月份写成数字，星期用英语）。数字始终是拉丁数字。
- **不支持**：`Intl.Collator`（`String.prototype.localeCompare` 是 QuickJS 自带的，不区分区域）、`PluralRules`、`RelativeTimeFormat`、`ListFormat`、`DisplayNames`、`Segmenter` 和 `Intl.Locale`；`currencySign: "accounting"` 和 `currencyDisplay: "name"` 分别按 `standard` 和 `code` 格式化。

## 性能

这些类都是原生实现的：解析 URL、编解码文本、构建 multipart 请求体、搬运流的分块，都在 Rust 中完成，而不是在 QuickJS 里。不过 JS 的每次调用都要进入运行时，所以请优先使用整块缓冲区的操作（`res.json()`、`res.text()`、`encoder.encode(s)`），避免在 JS 里逐字节循环。参见[性能](../docs/performance.md)。
