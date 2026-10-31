# Images

- **Images**: background NSURLSession / file read → ImageIO downsampling decode at the view's pixel size → `NSCache` (purged under memory pressure);
  requests for the same key are coalesced and downloads nobody waits for are cancelled (Android: HttpURLConnection / APK assets →
  `BitmapFactory` power-of-two sampling → `LruCache`, same coalescing). During development `asset:/path` goes through the dev
  server's `/assets/`; `nsh build` copies assets to `out/assets/`, `nsh package` puts them in the app. Cache keys include the decode
  size and the blur radius. `blurRadius` is a stack blur on the decoding thread (`blur.rs`, `Blur.java`: the same algorithm, in
  pixels). `placeholder` loads after the image request and shows until the image arrives; the image then fades in over
  `fadeDuration` (iOS: `CATransition`; Android: alpha over the placeholder; default 0 on iOS and 300ms on Android, as in React
  Native). Animated images: iOS decodes up to 600 frames into an animated `UIImage` (frames repeated by their delays' common
  divisor) played by a discrete `CAKeyframeAnimation` on `contents` (a tinted animated image shows its first frame); Android
  (API 28+) uses `ImageDecoder` → `AnimatedImageDrawable`, not cached (each view plays its own copy; no blur). `onLoad` reports the
  source's size in pixels on both platforms, whatever size the view decodes at. Downloads are shared per URI (also between
  views decoding at different sizes) and report `onProgress` at most every 100ms; `Image.getSize` / `Image.prefetch` (Rust,
  `nsh_core::runtime`) ask with `Command::ImageInfo`, are answered by the root's `ImageInfo` event (which the core
  resolves, never JS) and keep the downloaded bytes in a data cache (32 MB) until a view
  decodes them. Android `ImageBox` draws its borders above the
  image (as Core Animation's layer border).
- **Loading and memory** (`nsh_core::image`, the design in `image-loading-design.md`; Linux, Windows, macOS and
  GPUI: iOS and Android keep their own loaders, above). One loader per process (`image::loader`) reads every view's, canvas's, `getSize` / `prefetch`'s and `element::svg`'s bytes: a
  `Location` (`http(s)`, a file, `asset:/` by the surface's `AssetBase` — the dev server, a directory, or
  `Directories` looked in in order — or the engine's `Assets` reader, bytes in memory) named by one source key (`Location::key`); one read per key in flight, later requests waiting on it; reads
  and downloads on their own threads (`DOWNLOADS` 6, `PER_HOST` 4) apart from decodes (`decoders()`,
  `min(cores − 1, 4)`), both highest `Priority` first (`Visible`, `Normal`, `Prefetch`; `Ticket::set_priority` moves
  a waiting one); the download itself is a `Transport` (`Context::transport`, else the process's
  `set_transport`, else ureq with feature `loader`): macOS sets an `NSURLSession` one and builds without ureq (the system's proxies,
  authentication and App Transport Security), Linux, Windows and GPUI use ureq, and the loader checks the size limit
  and cancellation again on what a transport returns; a `Ticket`
  dropped by its last waiter cancels the read in its queue or between two chunks of its download. Limits:
  `MAX_BYTES` (64 MiB) an HTTP response, `TIMEOUT` (60 s) a request, `MAX_REDIRECTS` (20) redirects, each checked
  by `Access::media_redirect` and never from `https` to `http`. A failed read is answered from memory for
  `FAILURE_TTL` (30 s). L3: the encoded bytes of the last reads (`ENCODED_BYTES`, 32 MiB; 16 on phones; an entry over
  a quarter is not kept), so a decode at another size, an SVG parsed again or `getSize` reads nothing again.
  Decoded images (L4, `Images<V>`: the backend gives it its decoder, bytes to its picture at a `Target`) are decoded
  at the size their view shows them: `Want` (the box in points, the device scale, the resize mode; an empty box: the
  natural size; one side alone scales by that side) gives the longest side the fitted image needs in pixels, rounded
  up to a size bucket (`image::bucket`: powers of √2, never above the natural size; an SVG's within 8192), so views of
  similar sizes share an entry and a view that grows asks for the next bucket. The natural size comes from the
  bytes' header (`Natural::of`, `imagesize`; an SVG's `svg::size`) before the decode, and is remembered, so a request
  for an image decoded before is answered from memory, here and now. Entries are keyed by (source key, bucket,
  `Frames`), one decode per key at a time. Every entry, the SVG drawings of `element::svg` included, counts in one
  `Budget` per process (`image::budget()`, `default_budget()`: on desktops a sixteenth of the memory, at most
  256 MiB; on phones an eighth, at most 128 MiB) with what it costs: its pixels, its GPU copies (`MemoryCache::add_cost`) and each variant (a smaller
  decode, a baked effect) as an entry of its own. A view holds a `Lease` on what it shows: leased entries are never
  evicted; the others go oldest first, across all the budget's caches, whenever it is over its limit (so images that
  scrolled away go before anything on screen), and an entry larger than the whole budget goes with its last lease.
  L5: a backend's GPU copy lives as long as its entry (`MemoryCache::with_on_evict` for one that must release it
  itself; GDK drops a texture's GSK upload with the texture). Linux (`nsh-platform-linux` `image.rs`): a view starts
  its loads once it has a frame (a new one's comes after its source, so they start at `HIGH_IDLE`, before the next
  frame is drawn), with the `Want` of its frame and the surface's scale; a bitmap that shrinks decodes with the
  `image` crate and `thumbnail` (shrunk as decoded, before it takes 4 bytes a pixel), others with GDK's loaders; an
  entry costs its pixels twice (the texture and its GSK upload); a frame that grows past the bucket shown loads the
  next one and swaps it in without load events; dropping the view drops its loads and leases. Windows
  (`nsh-platform-windows` `image.rs`; type-checked, not run): the same, posting to the UI thread with
  `window::invoke`; WIC decodes and its scaler (Fant) shrinks to the bucket, the `image` crate for animations and what
  WIC cannot read; a `Frame` keeps its premultiplied BGRA pixels and makes its Direct2D bitmap when first drawn,
  which then adds its bytes to the entry (`add_cost`, once: one made again after a device loss replaces it);
  evicting the entry releases its bitmaps (`on_evict`). macOS (`nsh-platform-macos` `image.rs`; type-checked, not
  run): ImageIO thumbnails (`CGImageSourceCreateThumbnailAtIndex`, `ThumbnailMaxPixelSize` the bucket's side when it
  shrinks) and the bucket's SVG raster; the CGImages are what Core Animation draws, counted once; a blur and the
  view's color matrix are baked into a variant (an entry of its own in the same budget, keyed by the decoded entry
  and the look) on a GCD queue; a view starts once its decoration sees a size and loads a larger bucket when it
  grows; it downloads through `UrlSession` (the shared `NSURLSession`, a task delegate per download handing the
  response and data to the loader thread, which cancels the task when its ticket is dropped, past `TIMEOUT` or past
  `MAX_BYTES`; every redirect checked by `loader::redirect`, at most `MAX_REDIRECTS`). GPUI (`nsh-platform-gpui` `image.rs`): the decoded `RenderImage` and, on the main thread, its picture
  (`PICTURES`, dropped when the entry is evicted, so its textures leave the atlases once no view shows them); the
  atlas copy (once drawn) and each variant (its pixels and their atlas copy, given back when trimmed) count in the
  entry through `add_cost`. glibc keeps freed heap pages, so the budget has the allocator give memory back
  (`malloc_trim(0)`, glibc only) after `Budget::clear` and after every 64 MiB evicted. Measured with
  `heap_while_scrolling_remote_photos` (ignored; `cargo test -p nsh-platform-linux heap_while -- --ignored
  --nocapture`): 1,000 4000×3000 JPEGs (4.8 MB each) from a local server, 200×150-point thumbnails at 2×, a row every
  100 ms (`NSH_IMAGE_ROWS` rows on screen, `NSH_IMAGE_BUDGET_MIB` the budget). With the default budget (256 MiB
  on this 16+ GiB machine, full at 255 MiB counted): 8 rows on screen, 321 MiB resident at the end and 350 at the
  peak, 163 after `Budget::clear` (10 MiB left in the budget); 32 rows, 320 / 371 MiB, 194 after the clear (46 MiB
  left). With 512 MiB (the first default): 8 rows, 449 / 475 MiB, 190 after the clear; 32 rows, 452 / 485, 210. The
  old loader's full-size textures: 430 / 482 MiB with 8 rows (732 MiB counted for the 8 on screen), 1,254 / 1,306
  with 32. Without giving memory back, the resident size stayed near its peak after the clear (448 MiB).
- **Fit and position**: the `objectFit` style (CSS's `object-fit`: `fill`, `contain`, `cover`, `none`, `scale-down`;
  the `object-*` fit classes set it, and the style wins over them as in CSS; `Style::pending`, a node's `object_fit`;
  images cover their box by default, videos are contained; Rust's `.object_fit(..)` sets the same style) sizes
  the image and the `objectPosition` style (`ObjectPosition`, CSS's `object-position`, parsed by
  `css::object_position`; `object-top`, ... set it) places it, both computed by one function, `ResizeMode::fit`
  (`Center` keeps the natural size, CSS's `none`, and `ScaleDown` shrinks what is larger than the box, CSS's
  `scale-down`, on every platform). The
  position is the image's, not the view's: it travels in `ImageOptions::position` with `MountItem::Image`, and a change
  sends that item again, not a `ViewStyle`. iOS and macOS show the image in a picture layer inside the clipped image
  layer, framed at the fitted rectangle (the tint and its mask inside it); Android translates its draw matrix by the
  position; Windows, Linux, GPUI and the terminal backend draw at the fitted rectangle; the web sets CSS's `object-position` on the `<img>`
  (and the tint mask's position).
- **Known follow-ups** (phase 1 of `image-loading-design.md`): Windows scales with WIC after the BGRA conversion, so
  a JPEG decodes at full size before it shrinks; the Windows and macOS surfaces carry no access policy
  (`Access::default()`), so every redirect is allowed except `https` to `http`.
- **Disk cache** (`nsh_core::image::DiskCache`, `image/cache.rs`): the encoded bytes of every `http(s)://` image (views,
  canvases, `getSize` / `prefetch`) are kept on disk on every native backend, so an app reopened shows what it showed
  without a download, and offline. One implementation in the core; each loader keeps its own networking and routes a
  download through it: `lookup` (a fresh copy, or a stale one's validators) before the request, `complete` after it
  (desktops: the core loader's `DiskCache::load` around its transport's downloads, ureq or macOS's `NSURLSession`
  with `ReloadIgnoringLocalCacheData` so the shared `URLCache` never answers for it; iOS: the lookup on a GCD queue and
  `complete` in the `NSURLSession` delegate, with an `NSMutableURLRequest` carrying `If-None-Match` /
  `If-Modified-Since` and `ReloadIgnoringLocalCacheData`, so the shared `URLCache` never answers for it; iOS starts the task from the main thread (`LoadEvent::Download`) so cancelling still works;
  Android: `Native.imageCacheLookup` / `imageCacheComplete` around `HttpURLConnection` on the image threads, the
  body crossing JNI only to be stored). Policy (RFC 9111 for a private cache, simplified): `200` / `203` are stored
  unless `no-store`, `Vary: *` or over an eighth of the cache; fresh for `max-age`, else `Expires` − `Date`, else a
  tenth of the time since `Last-Modified` (at most 7 days), less the response's age; stale at once with `no-cache`
  or no freshness. Stale copies are revalidated (`304` refreshes them by its headers over the stored ones, `4xx`
  drops them) and served when the request fails or the server answers `5xx`, unless `must-revalidate` / `no-cache`.
  Keyed by URL alone (sources carry no request headers, so `Vary` other than `*` cannot differ). `asset:/` URIs are
  never kept (the dev server's change with the app). Each entry is one file named by a digest of its URL (URL, policy
  headers, body, CRC32 of them), written under a temporary name and renamed: readers on any thread, surface or
  process see a whole entry or none, without locks; one that does not read back whole is deleted and is a miss. LRU
  by modification time (a hit refreshes it at most every 10 minutes); past its limit a scan deletes the oldest down
  to three quarters, and drops temporary files over an hour old. Every engine opens its handle in
  `<root>/<app id>/images` from `EngineConfig::cache` (`CacheOptions::images`, 256 MiB by default:
  `DEFAULT_DISK_CACHE_SIZE`), hands it to the platform (`Engine::image_cache`) and gives the core the same one for
  `element::svg` (`Core::set_image_context`); handles opened on one directory with one bound in a process are one
  cache (`DiskCache::open`), so its size is counted once, and the files are what processes share.
  Where the root is and how embedders set it: `embedding.md` "Caches". Development hosts given `--data-dir`
  (`nsh test --target`) keep the caches in it (`CacheLocation::Dir`), so a test starts cold. The web runtime leaves
  caching to the browser's HTTP cache.
- **In-memory images** (`nsh_core::image`): `data:` URIs and `blob:` URLs are resolved once, in shared code, and their
  bytes travel with the source (`ImageSource::data`, an `ImageData`: shared, cloned without a copy, equal by
  identity). The core decodes a `data:` source (base64 or percent-encoded) when the prop is set
  (`ImageSource::inline`, in `set_prop`, for TSX and Rust components alike), never per load. A `blob:` URL's blob
  lives in the JS VM (`nsh-js` `web/blob.rs`): `dom.rs` hands the decoded prop to `blob::resolve_image_source`, which
  gives the source the blob's bytes (`Blob` keeps them in an `Arc<[u8]>`, so no copy and no base64 in JS); a URL
  revoked or never made keeps its `blob:` URI and no bytes, and the platform reports `onError`. Revoking a URL later
  changes nothing: the source holds the bytes. Either way the source then goes by `data:<type>;nsh-key=<digest>`
  (`ImageSource::with_bytes`; SHA-256, 128 bits, hex), so cache keys and coalescing hash a few dozen bytes, the
  shadow tree keeps no base64 text, equal bytes share one decode whatever URL named them, and no app can make a
  key another surface's image uses (the caches are per process). The access check lets `data:` and `blob:` through
  (bytes the app has); only `Image`'s `src` and `placeholder` and Rust components' image props (an `ImageSrc`,
  whose decoding asks `JsHost::image_blob`, which `nsh-js` answers with the same `blob::resolve_image_url`, so an
  `Avatar`'s `src` and an `<Image>`'s of one URL share their key and bytes) resolve a `blob:` URL, and a video, a canvas image or
  `getSize` / `prefetch` given one report the platform's error. A `data:` URI that does not decode becomes `data:,`
  (shows nothing, `onError`): an app writing a key itself never reaches another surface's cache entry. A `blob:`
  URL keeps the key and bytes it resolved to (`BlobUrls`), so setting it again hashes nothing and sends nothing new.
  iOS, macOS, Windows, Linux and GPUI decode `ImageSource::data` as they do a download's
  bytes (`Location::Memory`, served without the download map or the `getSize` data cache; iOS wraps the bytes in an
  `NSData` without a copy); the backends that get only a URI look the bytes up by it in an `InlineImages` (weak
  references: an entry lives while a source holds the bytes): Android's `Images.java` reads `data:` / `blob:` URIs
  through `Native.imageBytes`, the web runtime gets them once per key (`image_bytes`) as a browser blob URL that
  `asset()` maps the key to, revoked (`release_image`) when no source holds them. `Image.getSize` / `prefetch` of a
  `data:` URI decode it on the platform (`nsh_core::image::decode_data_uri`, the one decoder every backend uses).
  The terminal backend passes these shared bytes to its bounded bitmap image workers, including placeholders;
  its raw-URI `getSize` and canvas paths use the same data-URI decoder.
- **Picked images** (`nsh`, `nsh_core::picker`): `Picker.pickImages` sends the root `Command::PickImages` with a
  `PickRequest` checked in Rust (`limit`: 1 for a single pick, at most `MAX_PICKED` = 100; `max_dimension`, `quality`
  as a `Percentage`, `PickFormat::Compatible` / `Current`); the `picker` capability gates it (denied: `[]` and a log
  line). What each image becomes is decided by `PickRequest::needs_encoding` from its type and its size with its
  orientation applied: JPEG, PNG, GIF and WebP stay as they are; another format (HEIC, HEIF, TIFF) becomes a JPEG
  unless `Current`; an image whose longer side passes `max_dimension` is decoded upright, scaled to fit
  (`scaled_size`) and encoded again, a PNG as a PNG and anything else as a JPEG of `jpeg_quality()` (0.9 by default);
  a `quality` re-encodes JPEGs too. Re-encoded images carry no metadata (no EXIF location); kept ones keep theirs.
  iOS: `PHPickerViewController` (PhotosUI loaded with `dlopen`, as WebKit is; no photo library permission), its
  `preferredAssetRepresentationMode` compatible (the system turns HEIC into JPEG) or current, ordered selection when
  several; each item's file is read inside `loadFileRepresentationForTypeIdentifier`'s completion (the file goes when it
  returns) and prepared with ImageIO (`picker.rs`: `CGImageSourceCreateThumbnailAtIndex` with the transform and the
  longer side, `CGImageDestination` with `kCGImageDestinationLossyCompressionQuality`). macOS: an `NSOpenPanel` sheet
  and the same ImageIO preparation (`nsh-platform-macos` `picker.rs`, tested with `sips`' HEIC). Android
  (`Picker.java`): `MediaStore.ACTION_PICK_IMAGES` (API 33+, or 30+ with SDK extension 2), else `ACTION_GET_CONTENT`
  for `image/*`, started by a headless retained `android.app.Fragment` added to the view's activity (the embedding app
  forwards no result); the bytes are read from the content resolver, sized with `BitmapFactory` bounds and the EXIF
  orientation, and re-encoded with `BitmapFactory` (power-of-two sampling), an orientation `Matrix` and
  `Bitmap.compress`; `Native.picked` hands them over. Web: an `<input type=file>` (`cancel` answers empty), scaled
  with `createImageBitmap` (`imageOrientation: "from-image"`) and an `OffscreenCanvas`; `nsh_picked_file` /
  `nsh_picked` hand the bytes over. Windows (`IFileOpenDialog` on a thread of its own), Linux (`gtk::FileDialog`) and
  GPUI (`prompt_for_paths`) read the files as they are (`nsh_core::picker::read_files`), offering only the formats
  `dialog_extensions` lists for the request (with `Compatible`: the four that stay as they are); they scale nothing.
  Every backend answers once with the root `Pick` event, `EventPayload::Picked { id, files }`, the bytes in
  `ImageData` (no base64 anywhere); the core cuts the list to the limit and fills in sizes, types and file extensions
  from the bytes (`PickedFile::fill_in`, `imagesize`), and `nsh-js` makes each a `File` over a `Blob` sharing those
  bytes, so `URL.createObjectURL(file)` shows it in an `Image` and `fetch` / `FormData` upload it without a copy in JS.
  An embedder's `PickerBackend` (`EngineConfig::picker`) answers in place of the platform: no command is sent.
- **Pixel-density variants**: an `ImageSource` carries `scales` (`ImageScales`, a `Copy` bitmask over `IMAGE_SCALES`,
  `[1, 1.5, 2, 3, 4]`) when a bundled asset ships `@Nx` siblings (of a JS `scales` list, the first `SCALES_READ`
  entries). The core picks the variant when it emits `MountItem::Image` (`ImageSource::uri_for`, for the source and the
  `placeholder`): React Native's rule, the smallest scale at least the surface's `pixel_ratio`, otherwise
  the largest, for `asset:/` URIs without a query or a fragment (a bundled file's name has neither). The backends load
  that URI as any other, so their caches and decoding are unchanged; the size in points still comes from the source, so
  layout never depends on the variant. When the pixel ratio changes (`apply_environment`: a window moved to another
  screen, browser zoom) only the images whose pick changes are marked `dirty::IMAGE` and sent again, with no relayout.
  The backends load a re-sent image as a new source, with its events: `onLoadStart`, `onLoad` (the variant's pixels, as
  for any source) or `onError`, then `onLoadEnd`. `Image.getSize` / `Image.prefetch` pick the same way, so a prefetch
  warms the bytes the views load; `getSize` returns the imported dimensions after a successful load, including when a variant has mismatched
  dimensions. Without imported dimensions it divides the variant's pixels by its scale.
  The bundler finds the variants: its image `load` hook (`plugin.rs`) stats the fixed names `<stem>@<s>x.<ext>` for the
  scales of `IMAGE_SCALES` above 1 (no directory listing), only for bitmap imports without a density suffix
  (`logo@3x.png` probes nothing and ships alone; an SVG, drawn for the screen at any ratio, ships no variants). The ones
  found join `Bundle::assets`, so the dev server, `out/assets`, every package, `.nshpkg` and the web package's asset map
  carry them, and the module gains `scales` (1 first) only when there is one: an app without variants bundles byte for
  byte as before. Width and height still come from the imported file; a variant that cannot be read fails the build as
  the imported file does, and one whose pixels are off that size times its scale by a pixel or more is warned about on
  `nsh::build`.
  Rust's `asset!` does the same for a crate image (`nsh-macros` `assets.rs`): `ImageAsset::scales` lists the siblings it
  finds (`assets!()` already ships the whole directory) and `include_bytes!`s them, so a changed variant rebuilds the
  crate. It reads each variant's size: one that cannot be read, or whose pixels are off, fails the build (a proc macro
  has errors only, where the bundler warns about the size). A proc macro cannot read nsh-core, so its `VARIANT_SCALES`
  repeats `IMAGE_SCALES` above 1: change them together.
- **SVG** (`nsh_core::svg`, cargo feature `svg`, which the GUI native platform crates enable and `nsh-platform-web` never
  does: browsers draw SVG with `<img>`, and the tint mask works on it as on bitmaps). The decoders sniff the bytes
  (`svg::sniff`: `<svg` after a BOM, XML declaration, comments and doctype, or gzip) before their platform decoder and
  draw with resvg. iOS, macOS and Android draw for the requested pixel size, the view's longer side (the size bitmaps
  are downsampled to), with the SVG's shorter side that long (`svg::rasterize_covering`: shown in the view, an image's
  shorter side never exceeds it, so no resize mode, `cover` included, enlarges the raster; Android through
  `Native.svg`), and an image at its natural size at the screen's scale (`svg::rasterize_scaled`; `center` uses the SVG's
  intrinsic dimensions with the platform's existing fitting rules: iOS through the `UIImage`'s scale, Android
  through `ImageBox`, with unrounded dimensions carried separately from the whole-point load reports over JNI). Linux draws one at its
  size bucket (`svg::rasterize`, the longest side the bucket's: "Loading and memory"). Windows and GPUI
  draw once at `svg::OVERSAMPLE` (4) pixels per point, at most `svg::MAX_OVERSAMPLED_SIDE` (2048) a side
  (`svg::rasterize_oversampled`), since they cache one bitmap per location. The premultiplied RGBA raster then takes
  the bitmap path (blur, color matrix, tint through alpha, cache). `onLoad` and `Image.getSize` report the intrinsic
  size in whole points (`svg::size`: `width` / `height`, one of them plus the `viewBox`'s ratio, or the `viewBox`;
  `svg::reported_size` rounds it), measured off the main thread; layout and fitting use it unrounded, and a file
  name's `@2x` does not apply. The bundler sizes `.svg` imports with the same `svg::size` and warns (`nsh::build`)
  about `<text>`, animation (SMIL elements, CSS `animation` and `@keyframes`), `<image>` and `<foreignObject>`, which
  only browsers draw. Canvases draw bitmaps: their image loads refuse an SVG with a warning naming it. An SVG a Rust
  component shows as an icon is better drawn by `element::svg`, as vectors at the device's pixels and with
  `currentColor` the text color (`docs/dev/canvas.md` "SVGs"): it takes the same `ImageSrc` (`asset!("x.svg")`, which
  carries the SVG's size in points, read by `nsh-macros` from its root's `width` / `height` / `viewBox`; a URL; a
  file; `ImageSrc::svg_markup(text)` for the markup itself, a `data:` URI) and loads through the same loader. Like bitmaps,
  per-view backends draw an SVG at the view's size when it loads: a view that grows later scales that raster until
  the image loads again.
- The terminal backend still decodes bitmap images only; SVG image sources are unsupported there
  (`docs/dev/tui.md`). Canvas SVG sources remain unsupported on all native backends.
- **SVG is untrusted input** (a remote SVG is a document from the network), so `nsh_core::svg` bounds what reading and
  drawing one takes. It reads nothing outside the document: usvg gets no resources directory and an `<image>` resolver
  that resolves nothing (its default one reads files), and an empty font database, so `<text>` is not drawn; the main
  workspace also builds resvg without `text`, `system-fonts` and `raster-images` (GPUI's workspace turns them on for
  GPUI, where the resolver and the empty font database still leave text and embedded images out, as the GPUI backend's
  `svg_` tests check). A document is at most `svg::MAX_BYTES` (16 MiB; a `.svgz` inflates that far and no further). A
  raster is at most `svg::MAX_SIDE` (8192) pixels a side and `svg::MAX_PIXELS` (16 Mi, 64 MiB of RGBA: a full-screen
  image on a 5K display fits) in all; a larger one is drawn smaller. resvg draws each isolated group (opacity, a mask,
  a clip path, filters, a blend mode) into a layer of its own, up to 5 × the canvas each way, and nested layers live
  at once, so a few hundred bytes of nested groups would take gigabytes: before drawing, `svg/layers.rs` walks the
  tree as resvg 0.46 draws it and adds up, along every nesting path, the layers, clip and mask pixmaps, filter regions
  (a pixmap per primitive, not clamped) and pattern tiles (not clamped) alive at once, and an SVG over
  `svg::MAX_LAYER_PIXELS` (64 Mi, four rasters' worth) or whose drawing visits more than a million nodes (shared
  patterns count each time they are drawn) is refused with an `svg::Error`. A panic in usvg or resvg is an
  `svg::Error` too (`catch_unwind`): the decoders run in GCD blocks and JNI functions, where an unwinding panic aborts.
  Android's decode threads also catch `OutOfMemoryError`, so a load that runs out of memory fails instead of hanging.
