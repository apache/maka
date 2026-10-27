---
title: Networking
description: HTTP with fetch - JSON, headers, uploads with FormData, streaming responses and request bodies, cancelling with AbortController, errors, and the network capabilities an app declares.
order: 46
group: ui
---

# Networking

NSH apps make HTTP requests with `fetch`: in Rust the function of `nsh_core::prelude`, awaited in a task, and in TSX the standard global. Both run on the platform's network stack (NSURLSession on iOS, HttpURLConnection on Android, the browser's [on the web](./web.md#apps-with-rust-components)), so requests use the system's TLS, proxies and HTTP/2, and both pass the same [capability checks](#capabilities-which-hosts-an-app-may-reach). Rust's `fetch` takes a URL or an `HttpRequest` and gives the whole response (`HttpResponse`: `status()`, `ok()`, `header(name)`, `text()`, `body`). TSX's streams both ways: a response body arrives as a stream as the stack delivers it, and a request body can be a stream sent as you produce it. TSX has the Fetch API's companions too: `Headers`, `Request`, `Response`, `AbortController`, `FormData`, `Blob`, `File`, `URL`, `URLSearchParams`, `TextEncoder` / `TextDecoder` and Web Streams.

## Getting JSON

```rust tabs
use nsh_core::prelude::*;

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

[`resource`](./reactivity.md#resource) keeps the value, the error and whether a load runs, loads again from a source that changes (or on `refetch()`), and cancels a load that no longer counts (the component goes away, or a newer load starts): in Rust by dropping the load's task, which cancels its request, in TSX through the `signal` it passes on. Rust's `fetch` takes absolute URLs; JSON is parsed with a crate such as `serde_json`.

In TSX, a `Response` reads its body once, as `json()`, `text()`, `arrayBuffer()`, `bytes()`, `blob()` or `formData()`, or as the `body` stream. `response.ok` is true for 2xx statuses; like in browsers, an HTTP error status does not reject the promise.

## Sending data

```rust tabs
use nsh_core::prelude::*;

// JSON
let body = serde_json::json!({ "title": "Groceries", "items": ["milk", "eggs"] });
let created = fetch(
    HttpRequest::post("https://api.example.com/notes", body.to_string())
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}")),
)
.await?;

// A form, URL-encoded
fetch(
    HttpRequest::post("https://api.example.com/login", "user=ada&password=…")
        .header("Content-Type", "application/x-www-form-urlencoded"),
)
.await?;

// Other methods
fetch(HttpRequest::new("DELETE", "https://api.example.com/notes/1")).await?;
```

```tsx tabs
// JSON
const created = await fetch("https://api.example.com/notes", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: "Groceries", items: ["milk", "eggs"] }),
});

// A form, URL-encoded
await fetch("https://api.example.com/login", {
  method: "POST",
  body: new URLSearchParams({ user: "ada", password: "…" }),
});

// Query strings
const url = new URL("https://api.example.com/search");
url.searchParams.set("q", "native shell");
url.searchParams.set("page", "2");
const results = await (await fetch(url)).json();
```

`HttpRequest::new(method, url)`, `get` and `post` make a request, `.header(..)` and `.body(..)` complete it. In TSX, `body` accepts a string, `URLSearchParams`, `FormData`, a `Blob` or `File`, an `ArrayBuffer` or typed array, or a `ReadableStream`.

### Uploading files with FormData

In TSX, a `FormData` body is sent as `multipart/form-data` with its boundary. NSH always sets that content type for a `FormData` body, even if a library sets a default `Content-Type` first, because without the boundary the server cannot parse it.

```ts
const form = new FormData();
form.append("title", "Sunset");
form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "sunset.jpg");

const response = await fetch("https://api.example.com/photos", { method: "POST", body: form });
```

### Uploading a photo the user picks

[`Picker`](../modules/nsh.md#picker) gives the photos the user picks as files whose bytes stay native, scaled down
and in a format servers take; Rust sends their bytes, TSX appends the `File` to a `FormData`:

```rust tabs
use nsh_core::geometry::DevicePixels;
use nsh_core::picker::PickRequest;
use nsh_core::prelude::*;

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
import { Picker } from "nsh";

const [photo] = await Picker.pickImages({ maxDimension: 2048 });
if (photo) {
  const form = new FormData();
  form.append("photo", photo.file);
  await fetch("https://api.example.com/photos", { method: "POST", body: form });
}
```

## Streaming

TSX's `fetch` streams responses and request bodies; Rust's gives the whole body with the response.

### Reading a response as it arrives

`response.body` is a `ReadableStream<Uint8Array>` filled as the network delivers bytes. Read it chunk by chunk to show progress or to process server-sent lines as they come:

```ts
const response = await fetch("https://api.example.com/large.csv");
const total = Number(response.headers.get("Content-Length") ?? 0);
let received = 0;

for await (const chunk of response.body!) {
  received += chunk.length;
  progress.set(total ? received / total : 0);
}
```

Text streams decode with `TextDecoderStream`, and a `TransformStream` splits them into lines:

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

Back pressure works end to end: while more than 1 MiB of a response waits unread, the request is paused at the network level until your code catches up.

### Streaming a request body

A `ReadableStream` body is sent chunk by chunk as the network stack asks for it (chunked transfer). Pass `duplex: "half"`, as the Fetch standard requires:

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

A streamed body cannot be sent twice, so a 307 or 308 redirect of a streamed request fails.

## Cancelling and timeouts

In Rust, a request runs in a task and is cancelled with it: when the task's component goes away, or with `cancel()` on the task `spawn` returns. In TSX, pass an `AbortSignal` to cancel a request; the promise rejects with the signal's reason (an `AbortError` `DOMException` by default), and a body being read stops.

```rust tabs
let task = spawn(async move {
    if let Ok(response) = fetch(format!("https://api.example.com/search?q={query}")).await {
        results.set(response.text());
    }
});

// Typing again: cancel the previous search.
task.cancel();
```

```tsx tabs
const controller = new AbortController();
const request = fetch("https://api.example.com/search?q=" + encodeURIComponent(query), { signal: controller.signal });

// Typing again: cancel the previous search.
controller.abort();
```

In TSX, `AbortSignal.timeout(ms)` makes a signal that aborts after a delay, and `AbortSignal.any([...])` combines signals:

```ts
const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
```

A component that loads data should cancel when it goes away: a Rust task does on its own, and TSX aborts in [`cleanup`](./reactivity.md):

```rust tabs
use nsh_core::prelude::*;

fn weather(city: String) -> impl IntoElement {
    let data = signal(String::new());
    // The task, and its request, end when the component goes away.
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

## Errors

A request that does not produce an HTTP response fails: Rust's `fetch` gives an `Err` with the message, TSX's rejects with a `TypeError` whose message starts with `Network request failed:`. That happens with no connection, a DNS or TLS failure, an unsupported URL scheme, or a request your app's capabilities do not allow. Check `ok()` / `status()` (TSX: `response.ok`, `response.status`) for HTTP errors.

```rust tabs
match fetch(url).await {
    Ok(response) if response.ok() => items.set(response.text()),
    Ok(response) => error.set(format!("Server answered {}", response.status())),
    Err(message) => error.set(message), // no response, or not granted
}
```

```tsx tabs
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Server answered ${response.status}`);
  return await response.json();
} catch (e) {
  if (e instanceof DOMException && e.name === "AbortError") return; // cancelled
  showError(String(e));
}
```

## From Rust components

Rust components, `#[module]` functions and `#[class]` members call `fetch` from a task: `spawn` in a component, `resource` for a value the UI shows, or an `async fn` exported to TSX, which TSX awaits as a Promise. A request is a URL or an `HttpRequest` (`HttpRequest::get(url)`, `HttpRequest::post(url, body)`, `.header(name, value)`), and its response arrives whole. The task owns the request: dropping it, or the component that spawned it going away, cancels the request. It uses the same network stack and capability checks as TSX, on every platform and in the browser.

## Capabilities: which hosts an app may reach

An app may declare in `nsh.json` which hosts it talks to. Once `"capabilities"` is present, everything not listed is denied:

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

| Key | Description |
|---|---|
| `network.hosts` | Hosts reachable with any method: `"*"` (any host), `"*.example.com"` (its subdomains, not `example.com` itself) or a host name. |
| `network.http` | Finer grants: a `host`, optionally limited to `methods`, `schemes`, a `port`, exact `paths` and `pathPrefixes`. |

The checks are enforced in NSH's runtime, outside your app's code, before a request reaches the network:

- A refused `fetch` fails (in TSX with a `TypeError`) with a message naming the key to add, such as ``Network request failed: fetch GET https://evil.io/ is not granted: add `evil.io` to capabilities.network in nsh.json``.
- **Every redirect is checked again.** NSH follows redirects itself (up to 20) instead of letting the platform do it, so a granted host cannot redirect your app to one that is not.
- The same `network` grants cover remote images (also in canvases and `Image.getSize` / `prefetch`) and video sources. `asset:` URIs of your own bundle are always allowed.
- The host is taken after the last `@`, so `https://ok.com@evil.io` counts as `evil.io`.

An app without `"capabilities"` may reach every host: a standalone app is its developer's own. Apps embedded in a host app or distributed as [signed packages](./signed-packages.md) should declare them; the host app can grant less than an app declares, and a request must be allowed by both. Development with `nsh dev` / `nsh run` enforces the same capabilities. See [Sandbox and capabilities](./sandbox-and-capabilities.md).

## Differences from browsers

TSX's `fetch` follows the Fetch standard with the differences that make sense for an app rather than a web page:

- **No CORS.** An app talks to any host its capabilities allow; there are no preflight requests and no opaque responses.
- **No forbidden headers.** An app may set `Cookie`, `User-Agent`, `Origin` and others.
- **`redirect: "manual"`** gives the 3xx response itself (with its `Location` header) rather than an opaque redirect. `redirect: "error"` rejects on a redirect.
- **`data:` and `blob:` URLs** are answered locally. `URL.createObjectURL(blob)` makes a `blob:` URL that `fetch` can read until you revoke it.
- Browser-only options (`mode`, `credentials`, `cache`, `referrer`, `integrity`, `keepalive`, `priority`) are accepted for compatibility with libraries.

Libraries built on `fetch` (and on `AbortController`, `FormData` and streams) generally work unchanged. There is no `XMLHttpRequest`; native hosts provide the global `WebSocket` and the [`websocket` module](../modules/standard-modules.md), checked against the same grants as `fetch`.

## Related

- [Global APIs](../modules/globals.md): every global, with its members.
- [Sandbox and capabilities](./sandbox-and-capabilities.md): capabilities, limits and how the embedding app grants them.
- [Images and assets](./images-and-assets.md): remote images.
- [Lists](./lists.md#loading-more-onloadmore): paging through an API.
