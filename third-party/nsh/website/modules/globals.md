---
title: Global APIs
description: The globals every NSH app has without an import — fetch, streams, URL, encoding, Blob and FormData, events and abort signals, Intl, timers and console — implemented natively in Rust.
order: 15
---

# Global APIs

Besides the ECMAScript standard library, an NSH app's JS environment has a set of standard globals: `fetch` with `Headers`, `Request` and `Response`; the Streams Standard; `URL` and `URLSearchParams`; `TextEncoder` / `TextDecoder`; `Blob`, `File` and `FormData`; `EventTarget`, `Event` and `AbortController`; timers, `requestAnimationFrame` and `console`; and `Intl` for number and date formatting. They are implemented natively in Rust, follow the WHATWG standards, and need no import, so the many JavaScript libraries built on these standards (HTTP clients, URL and encoding helpers, stream utilities) work unchanged.

This page lists every global an app has. These are the TSX environment's: Rust code uses Rust's standard library, crates.io and NSH's services of `nsh_core::prelude` instead (`fetch`, timers, tasks; see [Building with Rust](../docs/rust.md)), named in the table's Rust column. UI is built with [elements](../elements/index.md) and the app's own components, and everything else an app uses comes from the [modules](./index.md) it imports.

The TypeScript declarations of all of these are generated into `.nsh/types/nsh/globals.d.ts` (see [Project structure](../docs/project-structure.md)).

| Group | Globals | Rust |
|---|---|---|
| [Console and timing](#console-and-timing) | `console`, `performance` | the `log` crate (`log::info!`, ...), `nsh_core::time::now()` |
| [Timers and frames](#timers-and-frames) | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`, `requestAnimationFrame`, `cancelAnimationFrame` | `set_timeout`, `set_interval`, `timer(delay).await`, `request_animation_frame`, `next_frame().await`, `Spawned::cancel()` |
| [Base64 and errors](#base64-and-errors) | `atob`, `btoa`, `DOMException` | the `base64` crate, `Result` |
| [Events and abort signals](#events-and-abort-signals) | `EventTarget`, `Event`, `CustomEvent`, `AbortController`, `AbortSignal` | signals and closures; `Spawned::cancel()` ends a task |
| [URLs](#urls) | `URL`, `URLSearchParams` | the `url` crate |
| [Text encoding](#text-encoding) | `TextEncoder`, `TextDecoder` | `str::as_bytes`, `String::from_utf8` |
| [Blobs and form data](#blobs-and-form-data) | `Blob`, `File`, `FormData` | `Vec<u8>` bodies of `HttpRequest` |
| [Fetch](#fetch) | `fetch`, `Headers`, `Request`, `Response` | `fetch`, `HttpRequest`, `HttpResponse` |
| [Number and date formatting](#number-and-date-formatting) | `Intl.NumberFormat`, `Intl.DateTimeFormat`, `toLocaleString` | `format!` and crates.io's formatting crates, with `locale()` |
| [Streams](#streams) | `ReadableStream`, `WritableStream`, `TransformStream`, readers, writers, controllers, `ByteLengthQueuingStrategy`, `CountQueuingStrategy`, `TextEncoderStream`, `TextDecoderStream` | `fetch` gives the whole body; `background` tasks run long-lived connections on native targets |

Native hosts also provide `Buffer`, `crypto`, `process` and `WebSocket`; see [Standard modules](./standard-modules.md) for their modules, permissions and resource limits.

## Console and timing

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

In Rust, the `log` crate's macros (`log::info!`, `log::warn!`, ...) write to the same log, and appear in the terminal of `nsh run` too. `console` writes one line per call to the runtime's log (target `js`): `log` and `info` at info level, `debug`, `warn` and `error` at their levels. Arguments are joined with spaces; strings print verbatim, errors with their stack, functions as `[Function name]`, and objects and arrays as JSON (falling back to `String(value)` for cycles).

While a device is connected to the dev server, its log lines appear in the terminal running `nsh run` / `nsh dev`, prefixed with the device name; see [Dev server and debugging](../docs/dev-server-and-debugging.md).

> [!NOTE]
> Only the five methods above exist. There is no `console.table`, `console.group`, `console.time` or `console.assert`, and no `%s` / `%o` format substitutions.

`performance.now()` is the clock `requestAnimationFrame` passes to its callbacks; in Rust, `nsh_core::time::now()` and the `Instant`s that `request_animation_frame` and `next_frame()` give are that clock. `performance` has no other members.

## Timers and frames

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

Rust: `set_timeout(delay, f)` and `set_interval(period, f)` return a `Spawned` handle whose `cancel()` clears them, `timer(delay).await` waits in a task, and `request_animation_frame(f)` / `next_frame().await` give the next frame's time; all of them end with the component that made them. Timers behave as in browsers: a missing, negative or non-finite delay is 0, the returned id is a positive integer, and clearing an unknown id does nothing. `handler` must be a function (string handlers are not evaluated). Timers do not clamp nested delays to 4 ms.

> [!WARNING]
> The extra `...args` of `setTimeout` / `setInterval` are declared but currently not passed to the handler. Use a closure instead: `setTimeout(() => save(id), 100)`.

`requestAnimationFrame` callbacks run once, at the next frame the engine produces, all with the same `performance.now()` time. A callback that requests another frame is called at the following frame, so the usual loop works:

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
> Driving an animation from JS frame by frame runs your code on every frame in QuickJS. For animations of styles and transforms, prefer [`nsh`'s animation API](./nsh.md#animation), whose drivers run natively without calling back into JS (see [Animation](../docs/animation.md)).

## Base64 and errors

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

`atob` / `btoa` convert between binary strings and Base64 as in browsers. `DOMException` is what aborted operations reject with: an `AbortController.abort()` without a reason gives a `DOMException` named `"AbortError"`, and `AbortSignal.timeout` one named `"TimeoutError"`.

## Events and abort signals

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

These are the DOM Standard's classes with one difference: there is no tree, so an event is dispatched to its target only. Capture listeners run first, then the others, as the DOM does at the target; `bubbles` has no effect. The classes can be subclassed, which makes `EventTarget` a small event emitter:

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

These events are unrelated to the events of elements (`onPress`, `onChange`, ...), which are props; see [Touch and gestures](../docs/touch-and-gestures.md).

`AbortSignal` cancels `fetch` requests and stream pipes, and removes listeners added with `{ signal }`. In Rust, a request runs in a task, and cancelling the task cancels it:

```rust tabs
let search = spawn(async move {
    let _ = fetch("https://api.example.com/search?q=nsh").await;
});
// later, for example when the screen closes (a task also ends with its component):
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

## URLs

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

URLs are parsed per the URL Standard. A URL's `searchParams` is live in both directions: changing the parameters rewrites the query, and setting `search` or `href` parses it again. Rust code uses the `url` crate, which follows the same standard:

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

The iterators of `URLSearchParams` (and of `Headers` and `FormData`) iterate over a snapshot taken when the iterator was created, and have the iterator helpers (`map`, `filter`, `toArray`, ...).

`URL.createObjectURL(blob)` returns a `blob:` URL that `fetch` (with `GET`) can read until `revokeObjectURL` is called. `<Image>` shows one as its `src` or `placeholder` ([Image](../elements/image.md)).

## Text encoding

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

`TextDecoder` knows fewer encodings than a browser: UTF-8, UTF-16LE, UTF-16BE and windows-1252 (which the labels `latin1`, `iso-8859-1`, `ascii` and the like also name, as the Encoding Standard specifies). Other labels throw a `RangeError`. With `{ stream: true }`, a multi-byte sequence cut between two chunks is kept for the next call.

## Blobs and form data

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

A blob holds its bytes in memory, and `slice` shares them instead of copying. Blobs are in-memory values only: there is no file system access behind `File`, and `FormData` has no constructor from a form element.

A `FormData` body is sent as `multipart/form-data`, and `Response.formData()` / `Request.formData()` parse both `multipart/form-data` and `application/x-www-form-urlencoded`.

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

`fetch` sends HTTP and HTTPS requests through the platform's own network stack: `NSURLSession` on iOS and Mac Catalyst, `HttpURLConnection` on Android. So the system's proxy settings, TLS configuration and certificate trust apply. `data:` URLs and `blob:` URLs (from `URL.createObjectURL`) are answered locally without touching the network; any other scheme rejects. Rust's `fetch(request)` goes through the same stack and the same capabilities, takes a URL or an `HttpRequest`, and resolves with an `HttpResponse` holding the whole body ([Networking](../docs/networking.md#from-rust-components)):

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

### Headers, Request and Response

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

### Streaming

A response's `body` is a byte stream filled as the network delivers data, so large or long-lived responses (downloads, server-sent events, streamed model output) can be processed while they arrive. When more than 1 MiB is waiting unread, the request is paused until the app reads again.

```ts
const res = await fetch("https://api.example.com/events");
const lines = res.body!.pipeThrough(new TextDecoderStream());
for await (const chunk of lines) {
  console.log(chunk);
}
```

A `ReadableStream` request body is uploaded chunk by chunk as the network asks for it; pass `duplex: "half"` as the Fetch Standard requires:

```ts
await fetch("https://api.example.com/upload", {
  method: "PUT",
  body: blob.stream(),
  duplex: "half",
});
```

### Differences from browsers

- **No CORS and no origin.** An app is not a web page: it may talk to any host its [capabilities](../docs/sandbox-and-capabilities.md) allow. `mode` is accepted and ignored.
- **No forbidden headers.** An app may set `Cookie`, `User-Agent`, `Origin` and any other header. When no `Accept` header is given, `Accept: */*` is sent.
- **`redirect: "manual"` delivers the 3xx response itself**, with its status and `Location` header, instead of an opaque filtered response. `"follow"` follows redirects (each hop is checked against the capabilities); `"error"` rejects when the response is a redirect.
- **A `FormData` body always gets `Content-Type: multipart/form-data; boundary=…`**, even when a `Content-Type` header was set. HTTP libraries often set a default content type and clear it only where they detect a browser; without the boundary the server cannot parse the body.
- **`credentials`, `cache`, `referrer`, `referrerPolicy`, `integrity`, `keepalive` and `priority`** are validated and kept on the `Request` object, but are not passed to the network stack: caching and cookie handling are those of the platform's stack.
- **Capabilities.** When the app declares `network` capabilities in `nsh.json` (or the embedding app grants fewer), a request to a host that is not allowed never reaches the network and `fetch` rejects with a `TypeError`. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).
- **Errors.** Network failures reject with a `TypeError` whose message starts with `Network request failed:`; aborts reject with the signal's `reason`.

See [Networking](../docs/networking.md) for a guide to loading data in components.

## Streams

The full WHATWG Streams Standard: readable streams (default and byte streams, BYOB readers, `tee`, `pipeTo` / `pipeThrough`, `ReadableStream.from`, async iteration), writable streams, transform streams, the two queuing strategies and the text encoding streams.

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

The underlying source, sink and transformer objects (`UnderlyingDefaultSource`, `UnderlyingByteSource`, `UnderlyingSink`, `Transformer`) and `StreamPipeOptions` (`preventAbort`, `preventCancel`, `preventClose`, `signal`) have the standard shapes; their full declarations are in `globals.d.ts`.

`TextEncoderStream` keeps a surrogate pair cut between two string chunks together, and `TextDecoderStream` a multi-byte sequence cut between two byte chunks.

A transform stream that splits text into lines:

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

## Number and date formatting

QuickJS has no `Intl` of its own; NSH adds one, formatting in Rust: `Intl.NumberFormat`, `Intl.DateTimeFormat` and `Intl.getCanonicalLocales`, and the `toLocaleString` of numbers and BigInts and `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` of dates, which take the same `locales` and `options`. Their declarations are TypeScript's own (the `ES2023` library), so they are not in `globals.d.ts`.

```ts
(1234567.891).toLocaleString();                                              // "1,234,567.891" (en-US)
(1234.5).toLocaleString("de-DE", { style: "currency", currency: "EUR" });  // "1.234,50 €"
new Intl.NumberFormat("en", { notation: "compact" }).format(1_500_000);      // "1.5M"
new Intl.NumberFormat("en", { style: "percent", signDisplay: "exceptZero" }).format(0.042); // "+4%"
new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });   // "09:05"
new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date); // "Oct 16, 2026, 3:04 PM"
```

Without `locales`, the device's locale is used: its region format (iOS `NSLocale.currentLocale`, Android `Locale.getDefault()`), `en-US` in `nsh test` and on the web.

- **Numbers**: the `decimal`, `percent`, `currency` (`currencyDisplay` `symbol`, `narrowSymbol`, `code`) and `unit` (common units: lengths, masses, durations, data sizes, temperatures, speeds) styles; `minimumIntegerDigits`, `minimum` / `maximumFractionDigits`, `minimum` / `maximumSignificantDigits`, `roundingPriority`, `trailingZeroDisplay`, `useGrouping`, `signDisplay`; `standard`, `scientific`, `engineering` and `compact` notation (`compactDisplay` `short` / `long`). Rounding is half away from zero, on the number as written (`1.005` rounds to `1.01`, as in browsers). `format` also takes BigInts and decimal strings, exactly. `formatToParts` and `resolvedOptions` work as in browsers.
- **Dates**: `weekday`, `year`, `month` (`numeric`, `2-digit`, `short`, `long`, `narrow`), `day`, `hour`, `minute`, `second`, `fractionalSecondDigits`, `hour12` / `hourCycle`, `timeZoneName` and `dateStyle` / `timeStyle`, in the Gregorian calendar. `timeZone` takes the device's zone (in a browser, the browser's), `UTC` or an offset (`"+08:00"`); other zone names throw a `RangeError` (there is no time zone database).
- **Locales**: the locale data is a table of common languages (English, German, French, Spanish, Italian, Portuguese, Dutch, Russian, Swedish, Polish, Turkish, Indonesian, Vietnamese, Thai, Hindi, Chinese, Japanese, Korean) with their regional variants (`en-GB`, `en-IN`, `de-CH`, `es-MX`, `pt-PT`, `zh-TW`, ...), not the whole of CLDR, so details can differ from a browser's output. A locale without data falls back to the next one asked for, then the device's, then `en-US`; Russian, Swedish, Polish, Turkish, Indonesian, Vietnamese, Thai and Hindi dates have no month names (their months are written as numbers, their weekdays in English). Digits are always Latin.
- **Not there**: `Intl.Collator` (`String.prototype.localeCompare` is QuickJS's, which ignores the locale), `PluralRules`, `RelativeTimeFormat`, `ListFormat`, `DisplayNames`, `Segmenter` and `Intl.Locale`; `currencySign: "accounting"` and `currencyDisplay: "name"` format as `standard` and `code`.

## Performance

All of these classes are native: parsing URLs, encoding and decoding text, building multipart bodies and moving stream chunks happen in Rust, not in QuickJS. Still, every call from JS crosses into the runtime, so prefer whole-buffer operations (`res.json()`, `res.text()`, `encoder.encode(s)`) over byte-by-byte loops in JS. See [Performance](../docs/performance.md).
