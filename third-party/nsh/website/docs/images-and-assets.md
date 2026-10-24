---
title: Images and assets
description: Showing images in Rust and TSX - the app's assets and @2x files, SVG images, remote URLs, resize modes, placeholders, blur, tint, load events, and reading an image's size or prefetching it.
order: 36
group: ui
---

# Images and assets

The image element (`image(..)` in Rust, `<Image>` in TSX) shows a bitmap or an SVG drawing: a file shipped with the app, or an image downloaded from a URL. Images are read and decoded off the main thread, downsampled to the size the view shows them at, and cached; the main thread only displays the decoded result.

```rust tabs
const LOGO: ImageAsset = asset!("logo@2x.png");

image(LOGO)
image("https://picsum.photos/seed/nsh/600/400").w_full().h(px(200.0)).rounded(px(12.0))
```

```tsx tabs
import { Image } from "nsh";
import logo from "./assets/logo@2x.png";

<Image src={logo} />
<Image src="https://picsum.photos/seed/nsh/600/400" style={{ width: "100%", height: 200, borderRadius: 12 }} />
```

The element's props are listed on [image](../elements/image.md).

## Images in the app

A Rust crate keeps its files in its `assets/` directory: `asset!("logo@2x.png")` (the path relative to `assets/`) is an `ImageAsset`, `{ url, size, scales }`, read when the crate compiles, and `registry.assets(assets!())` in the crate's `#[native_module]` function ships every file of the directory with the app. In TSX, import an image file like a module: the import gives an `ImageAsset`, `{ url, size, scales? }`, and the bundler ships the file with the app:

```rust tabs
const LOGO: ImageAsset = asset!("logo@2x.png");

// LOGO.url: "asset:/@my-app/logo@2x.png", LOGO.size: 64 × 64 points

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.assets(assets!());
}
```

```tsx tabs
import logo from "./assets/logo@2x.png";

logo; // { url: "asset:/assets/logo@2x.png", size: { width: 64, height: 64 } }
```

Supported files: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic`, and `.svg` ([SVG images](#svg-images)).

**Sizes are in points.** An `@2x` or `@3x` suffix in the file name says the file has 2 or 3 pixels per point, so `logo@2x.png` at 128×128 pixels is a 64×64 point asset. Without a suffix, one pixel is one point. A file named with a suffix is the one that shows; a file named without one shows its [pixel-density variants](#pixel-densities) when it has them.

**Natural size.** An image from an asset lays out at its natural size when its style leaves the width or height open, so `image(LOGO)` and `<Image src={logo} />` need no style. Set one dimension and the aspect ratio, or both, to size it differently.

In Rust, a missing or broken file fails the build, and a changed one builds the crate again. In TSX, assets are resolved relative to the importing module, and their `url` is relative to the app's root (the entry's directory). `nsh build` copies them to `out/assets/`, `nsh package` puts them in the app, and during development the dev server serves them.

> [!TIP]
> In TSX, `src` also accepts `asset:/path` strings, and imported files are the ones guaranteed to ship. A path that is never imported works with the dev server, which serves the whole app directory, and is missing from packaged apps. Import every image you use. A Rust crate ships its whole `assets/` directory through `assets!()`.

### Pixel densities

Name the file without a suffix and put its denser versions next to it, and the app loads the one that fits the screen:

```text
assets/
├── logo.png       64×64 pixels
├── logo@2x.png    128×128
└── logo@3x.png    192×192
```

```rust tabs
const LOGO: ImageAsset = asset!("logo.png");

// LOGO.size: 64 × 64 points, LOGO.scales: [1.0, 2.0, 3.0]
```

```tsx tabs
import logo from "./assets/logo.png";

logo; // { url: "asset:/assets/logo.png", size: { width: 64, height: 64 }, scales: [1, 2, 3] }
```

- `asset!` and the bundler look for `@1.5x`, `@2x`, `@3x` and `@4x` siblings of an image named without a suffix. `scales` lists them, with 1 for the named file; an image without siblings has no scales (in TSX it imports as `{ url, size }`). The bundler ships the siblings it finds, and `assets!()` ships the whole directory.
- The image loads the smallest scale at least the screen's pixel ratio, otherwise the largest, as React Native picks: `logo.png` on a 1× screen, `logo@2x.png` on a 2× one, `logo@3x.png` on a 3× phone (and at 2.625). On the web only that file is downloaded.
- When the pixel ratio changes (a window moved to another screen, browser zoom), the images whose choice changes load again, with their [load events](#load-events). Their size stays the named file's size, in points.
- A variant whose pixels are not the named file's size times its scale gets a build warning in TSX and fails the build in Rust.
- A file named with a density suffix (`./logo@3x.png`, `asset!("logo@3x.png")`) is that file alone.
- An [SVG image](#svg-images) is drawn for the screen at any ratio, so it ships no variants.

One file is fine too: export it at the highest density you need (`@3x` for the sharpest result on every phone) and name it with its suffix; images are downsampled to the screen when decoded. Variants let each screen download, decode and keep the file that fits it.

## SVG images

The terminal backend does not support SVG image sources yet; use a bitmap image there.

Import an `.svg` file like any image. Its size in points is its `width` and `height` (or one of them, with the other from the `viewBox`'s aspect ratio), else its `viewBox`: a CSS pixel of the SVG is a point, and `@2x` suffixes leave SVG files as they are.

```tsx
import logo from "./assets/logo.svg"; // <svg width="120" height="40" …>
import star from "./assets/star.svg"; // <svg viewBox="0 0 24 24" …>

logo; // { url: "asset:/assets/logo.svg", size: { width: 120, height: 40 } }

<Image src={logo} />
<Image src={star} style={{ width: 36, height: 36, tintColor: "#0969da" }} />
```

An SVG is sharp at the size it is shown. The browser draws it as vectors; iOS, macOS and Android draw it at the size the view shows it, in pixels, when the image loads (as they downsample bitmaps; a view that grows afterwards scales that drawing, until the image loads again); Windows, Linux and GPUI draw it once at four pixels per point (up to 2048 pixels a side) and scale it to each view. Everything else works as for bitmaps: `resizeMode`, `tintColor` (through the SVG's opaque shapes, so one-color icons follow the theme), filters, `blurRadius`, placeholders, the load events, `Image.getSize` and `Image.prefetch`. `onLoad` and `Image.getSize` report an SVG's size in whole points; the image lays out at its exact size. Remote SVG files load the same way, through the same downloads and [capability](./sandbox-and-capabilities.md) checks; NSH recognizes an SVG by its content (also gzip-compressed, `.svgz`), whatever its URL ends with.

**What native platforms draw.** iOS, macOS, Android, Windows, Linux and GPUI draw SVGs with one renderer (resvg), so a drawing looks the same on each: shapes and paths, fills and strokes, gradients and patterns, clip paths and masks, opacity, filters and transforms. Text (`<text>`), animation (SMIL and CSS), embedded images (`<image>`) and HTML (`<foreignObject>`) show in the browser; native platforms draw the rest of the SVG, still, and `nsh build` names the files that use them. Export text as outlines (paths) for the same result everywhere.

**A self-contained picture.** On native platforms an SVG draws only what it holds: files, URLs, `data:` images and other documents it references are left out. Native platforms draw SVGs, remote ones included, within bounds that keep memory in check: a document of up to 16 MiB (a compressed one once inflated), a drawing of up to 8192 pixels a side and 4096 × 4096 pixels in all (64 MiB; a larger one is drawn smaller), and layers (groups with opacity, masks, clip paths and filters, which the renderer draws apart) of up to 256 MiB at once. An SVG over the document or layer bound fails to load, with `onError`.

**Reported sizes on the web.** The browser measures SVGs itself, imported or remote: `onLoad` and `Image.getSize` report an SVG's `width` and `height` when it has them, and otherwise the size the browser gives it, which browsers typically derive from a default of 300 × 150 and the `viewBox`'s aspect ratio. Imported SVGs lay out at the bundler's size on every platform. Give SVGs a `width` and `height` for the same reported size everywhere.

## Remote images

Give the element a URL: a string in Rust (a closure for one that changes), a URL string in TSX:

```rust tabs
image(move || user.with(|u| u.avatar_url.clone()))
    .size(px(48.0))
    .rounded(px(24.0))
    .bg(rgb(0xeaeef2))
```

```tsx tabs
<Image src={user().avatarUrl} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#eaeef2" }} />
```

- **Give remote images a size.** Their size is unknown until they load, so without a width and height (or one of them and an aspect ratio) they collapse to no height.
- **A background color** shows while the image loads, or use a placeholder (below).
- Downloads are shared: several views showing the same URL download it once, also when they decode it at different sizes. A download nobody waits for any more is cancelled.
- Decoded images are cached in memory (the cache is purged under memory pressure), keyed by URL, decode size and blur radius.
- When the app declares [capabilities](./sandbox-and-capabilities.md), the image's host must be allowed under `network`; a refused image fails with its error event.

### Kept on disk

Downloaded images are also kept on disk, as the server sent them, so an app that is opened again (a conversation full
of avatars and photos, a feed) shows the images it showed before without downloading them, also offline. The app
needs no setting: every image with an `http://` or `https://` URL goes through the cache on iOS, Android, macOS,
Windows, Linux and GPUI, and in the browser the browser's own HTTP cache does the same.

The cache follows the server's HTTP caching headers:

- An image is kept unless the response says `Cache-Control: no-store`.
- It is used without a request while it is fresh: for `max-age`, else until `Expires`, else for a tenth of the time
  since `Last-Modified` (at most a week).
- After that it is checked with the server (`If-None-Match` with its `ETag`, `If-Modified-Since` with its
  `Last-Modified`): an unchanged image (`304`) is used again without downloading it, a changed one replaces it.
- When the request fails (no network) or the server has an error (`5xx`), the kept copy is shown, unless the response
  said `must-revalidate` or `no-cache`.

Each app has its own cache of 256 MiB; past that, the images used least recently are dropped first. Several views,
surfaces and processes of one app share it safely. Embedding apps choose where it is and how large, or turn it off:

```rust tabs
// macOS, Windows, Linux and GPUI: the AppView's options (or AppView::set_cache).
let mut cache = CacheOptions::at(CacheLocation::Dir(caches.join("nsh")));  // each app in <dir>/<app id>
cache.images = CachePolicy::MaxSize(ByteSize::mib(64));                     // CachePolicy::Off: none
let view = AppView::new(mtm, AppOptions { cache, ..AppOptions::default() });
```

```swift tabs
// iOS: NshAppView, before loading.
app.cacheOptions = NshCacheOptions(location: .directory(caches.appendingPathComponent("nsh")),
                                   images: .maxSize(megabytes: 64))   // .off: none
```

```java tabs
// Android: NshView, before loading.
nsh.setCacheOptions(NshCacheOptions.builder()
        .location(new File(getCacheDir(), "nsh"))
        .imagesMaxMegabytes(64)          // imagesOff(): none
        .build());
```

`CacheLocation::Off` (`.off`, `noDiskCache()`) keeps nothing on disk.

By default the cache is in the system's cache directory: `Library/Caches/nsh` on iOS, `nsh` in the cache directory
on Android, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows and `$XDG_CACHE_HOME` (`~/.cache`) on Linux,
each app in `<app id>/images` there. The system may clear these directories when it needs the space.

## Resize modes

The resize mode (`.resize_mode(..)` in Rust, `resizeMode` in TSX) decides how an image fills a box of a different shape:

| Value | Result |
|---|---|
| `"cover"` (`ResizeMode::Cover`, default) | Fills the box, keeping the aspect ratio, cropping what overflows |
| `"contain"` (`ResizeMode::Contain`) | Fits inside the box, keeping the aspect ratio, leaving empty bands |
| `"stretch"` (`ResizeMode::Stretch`) | Fills the box exactly, distorting the image |
| `"center"` (`ResizeMode::Center`) | Natural size, centered |

```rust tabs
image(photo).resize_mode(ResizeMode::Contain).size(px(140.0)).bg(rgb(0xeaeef2))
```

```tsx tabs
<Image src={photo} resizeMode="contain" style={{ width: 140, height: 140, backgroundColor: "#eaeef2" }} />
```

The Tailwind classes `object-cover`, `object-contain`, ... do the same.

### Image position

Where the sized image sits in its box is the `objectPosition` style (`.object_position(..)` and `.object_top()`, ... in Rust), CSS's `object-position`: the center by default. A covering image is cropped around it, a contained one moves within its bands. It takes keywords (`"top"`, `"left bottom"`), percentages and lengths (`"25% 75%"`, `"10px 0"`) and edges with offsets (`"right 10px bottom 20%"`). A tall photo in a chat bubble shows its top this way:

```rust tabs
image(photo).resize_mode(ResizeMode::Cover).object_top().w(px(220.0)).h(px(160.0)).rounded(px(16.0))
```

```tsx tabs
<Image src={photo} resizeMode="cover" style={{ width: 220, height: 160, borderRadius: 16, objectPosition: "top" }} />
```

The Tailwind classes are Tailwind's: `object-top`, `object-bottom`, `object-left`, `object-right`, `object-center`, `object-top-left`, `object-top-right`, `object-bottom-left`, `object-bottom-right` and arbitrary values (`object-[25%_75%]`).

## Styling images

Images are views: they take corner radii (also per corner), borders, shadows, opacity and transforms. Corners clip the image.

```rust tabs
image(avatar).size(px(90.0)).rounded(px(45.0)).border(px(3.0)).border_color(rgb(0x8250df))
```

```tsx tabs
<Image src={avatar} style={{ width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: "#8250df" }} />
```

- **Tint** (`.tint_color(..)` in Rust, the `tintColor` style in TSX) recolors the image's opaque pixels: use it for one-color icons that follow the theme.
- **Filters** (`.grayscale(..)`, `.sepia(..)`, `.blur(..)`; `filter` in TSX) apply to images on both platforms ([Filters](./styling.md#filters-and-blending)).

```rust tabs
image(ICON).size(px(24.0)).tint_color(AdaptiveColor::rgb(0x0969da, 0x58a6ff))
```

```tsx tabs
<Image src={icon} style={{ width: 24, height: 24, tintColor: active() ? "#0969da" : "#6e7781" }} />
```

## Placeholders, fading and blur

| Prop | Rust | Description |
|---|---|---|
| `placeholder` | `.placeholder(..)` | An image shown until `src` has loaded, a URL or an asset; best a local asset |
| `fadeDuration` | `.fade_duration(ms)` | Milliseconds the loaded image fades in over. Default 0 on iOS, 300 on Android |
| `blurRadius` | `.blur_radius(px(..))` | Blurs the image by this radius in points, applied once when decoding |

```rust tabs
image(move || format!("https://picsum.photos/seed/{}/300/300", id.get()))
    .placeholder(PLACEHOLDER)
    .fade_duration(250.0)
    .size(px(100.0))
    .rounded(px(12.0))
image(cover).blur_radius(px(16.0)).absolute().inset_0()
```

```tsx tabs
<Image
  src={`https://picsum.photos/seed/${id()}/300/300`}
  placeholder={placeholder}
  fadeDuration={250}
  style={{ width: 100, height: 100, borderRadius: 12 }}
/>
<Image src={cover} blurRadius={16} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
```

## Animated images

Animated GIF, WebP and APNG files play automatically, as assets or from URLs. They take the same styles and resize modes; a tinted animated image shows its first frame on iOS.

## Load events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onLoadStart` | `.on_load_start(..)` | | Loading starts |
| `onProgress` | `.on_progress(..)` | `{ loaded, total }` in bytes (`total` 0 when unknown) | During a download, at most every 100 ms |
| `onLoad` | `.on_load(..)` | `{ width, height }` | The image is ready; the source's size in pixels (an SVG's in points, [on the web as the browser measures it](#svg-images)) |
| `onError` | `.on_error(..)` | `{ message }` (a `&str` in Rust) | Loading or decoding failed |
| `onLoadEnd` | `.on_load_end(..)` | | After `onLoad` or `onError` |

```rust tabs
let status = signal(SharedString::from("loading…"));

image(url)
    .on_load(move |size: &Size<Points>| status.set(format!("{}×{}", size.width.0, size.height.0).into()))
    .on_error(move |message: &str| status.set(message.to_owned().into()))
    .w(px(90.0))
    .h(px(60.0))
```

```tsx tabs
const status = signal("loading…");

<Image
  src={url}
  onLoad={(e) => status.set(`${e.width}×${e.height}`)}
  onError={(e) => status.set(e.message)}
  style={{ width: 90, height: 60 }}
/>
```

The load event reports the source image's size, not the size it was decoded at.

An image with [pixel-density variants](#pixel-densities) loads one of its files, and the load event reports that file's pixels: 192×192 for `logo@3x.png` on a 3× screen, where `Image.getSize(logo)` resolves with the imported file's 64×64. When the pixel ratio changes and the image loads another variant, that load reports its events too: `onLoadStart`, then `onLoad` with the new file's size (or `onError`), then `onLoadEnd`.

## An image's size and prefetching

Images that are not on screen can be measured and loaded ahead: `image_size(..)` and `prefetch_image(..)` in Rust, `Image.getSize` and `Image.prefetch` (on the same `Image` that renders the element) in TSX:

```rust tabs
spawn(async move {
    // Ok(ImageSize { width, height }), in pixels.
    let size = image_size("https://example.com/photo.jpg").await;
    // true once the bytes are in memory.
    let ok = prefetch_image("https://example.com/next.jpg").await;
});
```

```tsx tabs
import { Image } from "nsh";

const size = await Image.getSize("https://example.com/photo.jpg");   // { width, height } in pixels
const ok = await Image.prefetch("https://example.com/next.jpg");      // true once the bytes are in memory
```

| Rust | TSX | Returns |
|---|---|---|
| `image_size(src)` | `Image.getSize(src)` | The image's size in pixels (an SVG's in points, [on the web as the browser measures it](#svg-images)); an error when it cannot be loaded |
| `prefetch_image(src)` | `Image.prefetch(src)` | `true` once the image's bytes are loaded |

In TSX, `src` is a URL string or an imported image. For an imported image with [variants](#pixel-densities), both load the variant the views load on this screen, and `getSize` gives the imported file's size. Both keep the downloaded bytes for the views that show the image next, so an image prefetched before it is shown appears without a download.

A common use is sizing a remote image by its aspect ratio:

```rust tabs
fn remote_image(url: &'static str) -> impl IntoElement {
    let ratio = signal(1.0_f32);
    spawn(async move {
        if let Ok(size) = image_size(url).await {
            ratio.set(size.width.0 as f32 / size.height.0 as f32);
        }
    });
    image(url).w_full().aspect_ratio(ratio)
}
```

```tsx tabs
function RemoteImage(props: { url: string }) {
  const ratio = signal(1);
  Image.getSize(props.url).then((s) => ratio.set(s.width / s.height));
  return <Image src={props.url} style={{ width: "100%", aspectRatio: ratio() }} />;
}
```

## Other assets

| File | Rust (`asset!`) | TSX import | Page |
|---|---|---|---|
| `.ttf`, `.otf` | A `FontAsset` with its family name | The font's family name | [Fonts](./fonts.md) |
| `.json` and other files | A `FileAsset` with its URI | `.json`: the parsed value, bundled into the script | [Project structure](./project-structure.md#modules) |

Fonts are registered before the first frame in both.

### A module's own URL

In TSX, `import.meta.url` is the URL of the module it is written in, so `new URL("./data.json", import.meta.url)` names a file beside it. A local or packaged desktop app's modules have `file:` URLs in the app's directory, which `fs/promises` reads under a `${pluginDir}` grant; a web app's are the page's; a packaged mobile app's are `asset:/` URLs like those of imported images. Import an image to ship it: a URL made this way names the file, it does not package it.

Bitmap images are also drawn on a canvas with `draw_image` / `drawImage` ([Canvas](./canvas.md)), and gradients replace many decorative images ([Styling](./styling.md#gradients)).

## Related

- [image element](../elements/image.md): every prop, with `getSize` and `prefetch`.
- [Lists](./lists.md): long lists of images recycle their views.
