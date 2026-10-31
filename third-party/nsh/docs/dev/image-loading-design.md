# Image loading, caching and memory: design

Status: approved; phase 1 implemented in the core, on Linux and GPUI (run),
and on Windows and macOS (type-checked, not run). Covers `image()`, `svg()`, remote downloads, the disk
cache, the in-memory caches, bundled assets and icons, and the app's control
over them.

## What we have, and what others do

NSH today (see `images.md`):

- A shared **disk cache** (`image::cache::DiskCache`) with private-cache RFC 9111
  semantics: freshness from `Cache-Control`/`Expires`/heuristic, revalidation
  with `If-None-Match`/`If-Modified-Since`, stale-if-error, 256 MiB, mtime LRU.
  It is good and stays. But it is **off by default** (`EngineConfig::new`), and
  apps cannot control it.
- **Everything else is per backend.** Linux, Windows, GPUI and macOS each have a
  128 MiB decoded LRU; iOS an `NSCache` of 96 MiB; Android an `LruCache`. They
  differ in what they count, when they downscale and whether they cancel.
- Gaps: the budget counts only the cache, not images on screen; GPUI variants
  and Windows' GPU copies are uncounted; Linux/Windows/GPUI decode at full
  size (a 4000×3000 thumbnail costs 48 MB); desktop loads are never cancelled
  and their queue is unbounded; no memory-pressure handling except iOS; the
  `svg()` drawing cache is keyed by the whole text and cleared all at once;
  `asset!("x.svg")` has no natural size.

GPUI (Zed) and gpui-kit have **no** disk cache, no HTTP cache semantics, no
byte budget and no downscaling: decoded images live in a process-wide map
until `remove_asset`, atlas tiles until `drop_image`; bounded memory is left to
the app (`ImageCache` with eviction, as `image_gallery`'s LRU by count). Worth
taking from them: one load per source in flight, decode off the main thread,
caching failures, a 200 ms delay before a loading placeholder, caches scoped to
a view and released with it, and gpui-kit's icon catalog (a pinned Lucide set,
an `IconName` enum generated at build time, only the icons used embedded).

## Goals

1. Many remote images (feeds, avatars, Markdown documents) with **bounded
   process memory**, whatever the source images' sizes.
2. **Browser-like** remote loading: HTTP caching that survives restarts,
   revalidation, dedup, priorities, cancellation.
3. **The app controls the caches**: limits, clearing, per-request policy.
4. `image()` and `svg()` share **one source type and one pipeline**.
5. Bundled assets and icons cost nothing until used and are sharp at any scale.

## Sources

`image(src)` and `svg(src)` take the same `ImageSrc`:

| Source | Example | Disk cache | Natural size up front |
|---|---|---|---|
| Remote | `https://…/a.png` | yes | no |
| File | `/home/me/a.png`, `file://…` | no | no |
| Bundled | `asset:/icons/x.svg`, `asset!("x.svg")` | no | yes (`asset!`) |
| Inline | `data:image/svg+xml,…` | no (bytes already in memory, keyed by `nsh-key` digest) | no |

Inline SVG text is a `data:` URI; a helper builds one
(`ImageSrc::svg_data(text)`, name to be checked against `api-naming.md`).
`asset!` accepts `.svg` and records its natural size (fix
`nsh-macros/src/assets.rs` `IMAGE_EXTENSIONS`).

One **source key** identifies a source everywhere: the URL, the canonical
path, the `asset:/` URI after `@Nx` resolution, or the `nsh-key` of inline
bytes.

## Layers

```
view ── lease ──▶ L4 decoded (per display size) ──▶ GPU texture
                     ▲ decode (pool)
                  L3 encoded bytes (small LRU)
                     ▲ read / fetch (download pool)
          L2 disk cache (HTTP)   L1 bundled assets / files / inline
```

### L1 — bytes from assets, files and inline data

- Bundled assets: shipped in the package's `assets/` (as now); in development
  served by the dev server. Read on demand, never copied into the disk cache.
- Files: read on the I/O pool without the HTTP response-size limit.
- Inline: already in memory (`ImageData`), shared, keyed by digest.

### L2 — remote downloads and the disk cache

One **core loader** for the native backends (moving the four desktop copies of
ureq + workers + inflight map into `nsh-core`; iOS and Android may keep their
platform networking but follow the same policy and budget):

- **Dedup**: one fetch per source key in flight; waiters attach to it.
- **Pools**: downloads (6 at once, 4 per host) separate from decodes
  (`min(cores−1, 4)`), so slow networks never block decoding.
- **Priority**: loads for views on screen first, prefetches last; waiting reads
  are re-prioritized as views scroll.
- **Cancellation**: a load nobody waits for any more is cancelled (the network
  request too) — on every platform.
- **Limits**: 64 MiB per response, 60 s timeout, 20 redirects each checked
  against the app's access policy, no HTTPS→HTTP downgrade.
- **Transport**: the loader keeps the policy above; the GET itself is a
  `Transport` a backend may supply (`Context::transport`, else the process's
  `set_transport`, else ureq). macOS uses `NSURLSession`, so the system's
  proxies, authentication and App Transport Security apply; it still honours
  cancellation, the limits and every redirect check (`loader::redirect`), and
  the loader checks the size and cancellation again on what it returns.
  Linux, Windows and GPUI use ureq.
- **Disk cache** (`DiskCache`, unchanged semantics): **on by default** for apps
  (`<cache dir>/<app id>/images`, 256 MiB), embedders keep `CacheOptions`.
  Add: honour `Vary` on the request headers we send (we send fixed ones, so in
  practice only `Vary: *` matters — keep), and failures cached in memory for a
  short time (30 s) so a broken URL in a list is not refetched per row.

### L3 — encoded bytes in memory

A small LRU (32 MiB desktop, 16 MiB mobile) of encoded bytes by source key, so
that a re-decode at a new size, an SVG re-parse, `getSize` and `prefetch` don't
re-read the disk or network. Entries larger than 1/4 of it are not kept.

### L4 — decoded images, one process-wide budget

- **Decode at display size.** A view asks for its size in device pixels; the
  decoder downsamples (ImageIO thumbnails, `image` crate `thumbnail`, WIC
  scaler, Android `inSampleSize`) to the smallest **size bucket** (powers of
  √2 of the longest side) that covers it, never above natural size. Views of
  similar sizes share an entry; a view that grows asks for the next bucket.
  `center`/natural-size views ask for natural size.
- **Key** = (source key, bucket, animation frame set). Effects (blur, tint,
  color matrix) are drawing-time where the platform can; where they must be
  baked (GPUI variants), the variant is an entry of its own **in the same
  budget**.
- **One budget per process**, counting everything an entry costs: CPU pixels,
  GPU copies (Windows D2D bitmap, GPUI atlas texture) and variants. Defaults:
  desktop `min(RAM/16, 256 MiB)`, mobile `min(heap/8, 128 MiB)` (desktop was
  `min(RAM/8, 512 MiB)` at first: the 8-row measurement showed 256 MiB enough
  for a scrolling list with far less resident memory).
- **Leases.** A view holds a lease on the entry it shows; leased entries are
  *in use*, counted, never evicted. Unleased entries form the LRU. When the
  total exceeds the budget, unleased entries go oldest first (so images that
  scrolled away go before anything visible). An image too large for the
  budget is still shown, leased, and dropped the moment its view goes.
- **Animations**: frames count in full; at most 600 frames / 48 MiB (as now).

### L5 — GPU

A texture lives exactly as long as its L4 entry (GPUI: `drop_image` when the
entry goes; Metal/D2D/GDK: release the texture object). No atlas tile outlives
its image.

### SVG

- `svg(src)`: the bytes come through L1/L2/L3 like any image; the **parsed
  drawing** (`svg::Drawing`) is cached by source key in L4 (its cost estimated
  from its op count), shared by every size since it is vector — no rasters.
- `image(src)` showing an SVG: rasterized at the bucket size (not 4× natural),
  so it is sharp at its display size and costs what a bitmap of that size does.
- Limits as today (`MAX_BYTES`, `MAX_SIDE`, `MAX_PIXELS`, node visits).

## Memory pressure and idle

- On pressure, drop every unleased L4 entry and all of L3:
  iOS `didReceiveMemoryWarning` (and `NSCache` already), macOS
  `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`, Android `onTrimMemory`, Windows
  `CreateMemoryResourceNotification`, Linux: the cgroup PSI `memory.pressure`
  trigger when available, else nothing.
- When the app goes to the background (mobile) or all its windows are hidden
  (desktop): trim unleased entries to a quarter of the budget.

## The app's control

Names follow the DOM where it has one (`fetch`'s `RequestCache`).

```rust
// Per image (TS: <Image cache="reload" />)
image("https://…/a.png").cache(RequestCache::Reload)
// default | no-store | reload | no-cache | force-cache | only-if-cached

// The app's caches
let caches = nsh_core::image::caches();
caches.clear(CacheKind::Memory | CacheKind::Disk);   // e.g. a "Clear Cache" setting
caches.disk_usage().await;                          // bytes on disk
caches.set_disk_limit(512 * MB);
caches.set_memory_limit(256 * MB);
Image::prefetch(src).await; Image::get_size(src).await;  // exist today
```

`nsh.json` sets the defaults:

```json
{ "images": { "diskCache": "256MB", "memory": "auto" } }
```

Loading states stay the image's: `on_load`, `on_error`, a placeholder shown
after 200 ms (`ImageOptions`).

## Bundled assets and icons

- `asset!` and `asset:/`: as today, plus `.svg` with natural size.
- Development reads assets from disk/the dev server, so edits show without a
  rebuild; packages ship them in `assets/`.
- **Icons** (a later step): an `nsh-icons` crate with a pinned Lucide catalog
  (version and checksum recorded), an `IconName` generated at build time, and
  only the icons an app names shipped; `icon(IconName::ChevronRight)` is an
  `svg()` of a bundled asset, so icons are vector, follow `currentColor` and
  share the drawing cache. Apps add their own sets the same way.

## Phases

1. **Core pipeline**: the shared loader (dedup, pools, priority,
   cancellation, limits), L3, L4 with leases, display-size decoding and one
   budget, on Linux, Windows, GPUI and macOS; `svg()` on `ImageSrc` with its
   drawing in L4; `asset!` SVGs.
2. **Control and pressure**: disk cache on by default, `RequestCache`,
   `caches()`, `nsh.json` defaults, memory-pressure and idle trimming on every
   platform; iOS and Android moved onto the same budget and policy.
3. **Icons**: `nsh-icons`.

Known follow-ups of phase 1:

- Windows scales with WIC after the BGRA conversion, so a JPEG is decoded at
  full size before it shrinks (no decode-time scaling as libjpeg's or
  ImageIO's).
- The Windows and macOS surfaces carry no access policy (`Access::default()`):
  every redirect is allowed except HTTPS→HTTP.

Each phase lands with tests for its contract (dedup, eviction order, leases
pinning, budget accounting including variants, cancellation, bucket choice,
disk-cache policy) and a samply/heap measurement of scrolling a list of 1,000
remote 4000×3000 images before and after.
