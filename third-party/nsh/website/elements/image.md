---
title: Image
description: The element that shows a bundled or remote image, with placeholders, blur, fades, tinting and load events.
order: 4
group: primitives
demo: el-image
---

# Image

`Image` shows a picture from the app's assets or from a URL. Images are downloaded and decoded off the main thread,
downsampled to the size the view shows them at, and cached in memory. Animated GIF, WebP and APNG images play. Rust
makes one with `image(src)`, TSX with `<Image>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

// assets/logo.png in the app's crate.
const LOGO: ImageAsset = asset!("logo.png");

view()
    .flex_row()
    .gap_3()
    .child(image(LOGO))
    .child(
        image("https://example.com/avatar.jpg")
            .placeholder(LOGO)
            .resize_mode(ResizeMode::Cover)
            .size(px(64.0))
            .rounded_full(),
    )
```

```tsx tabs
import { Image, View } from "nsh";
import logo from "./assets/logo.png";

<View style={{ flexDirection: "row", gap: 12 }}>
  <Image src={logo} />
  <Image
    src="https://example.com/avatar.jpg"
    placeholder={logo}
    resizeMode="cover"
    style={{ width: 64, height: 64, borderRadius: 32 }}
  />
</View>;
```

An asset knows its size: without a width or height the image takes it, and with one of them the other follows the
asset's aspect ratio. A URL's size is known once it loads, so give remote images a width and a height (or an aspect
ratio with one of them).

## Sources

The source (`src` and `placeholder`; `image(..)` and `.placeholder(..)` in Rust) takes:

| Value | Example | Description |
|---|---|---|
| An asset | Rust `asset!("logo.png")`, TSX `import logo from "./logo.png"` | An `ImageAsset` `{ url, size, scales? }`, sized in points: a `@2x` file counts half its pixels. With `logo@2x.png` / `logo@3x.png` next to `logo.png`, the variant for the screen's pixel ratio is loaded ([pixel densities](../docs/images-and-assets.md#pixel-densities)). `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` and `.heic` can be imported, and `.svg`, sized by its `width` and `height` or `viewBox` ([SVG images](../docs/images-and-assets.md#svg-images)). |
| A URL | `"https://example.com/a.jpg"` | Downloaded and cached. Downloads of the same URL are shared between views. |
| An asset path | `"asset:/images/a.png"` | A file of the app's assets. |
| A `data:` URI | `"data:image/png;base64,iVBOR…"` | Bytes in the URI, base64 or percent-encoded (`data:image/svg+xml,%3Csvg…`). |
| A `blob:` URL | `URL.createObjectURL(blob)` | The bytes of a `Blob` or `File` (TSX). The image keeps them: revoking the URL leaves an image that shows it whole. |

An image from bytes the app already has shows without a request. A chat shows a picked photo from its blob while it
uploads, then switches `src` to the photo's URL:

```rust tabs
// Bytes in a `data:` URI (an image the app made or received inline).
image(format!("data:image/png;base64,{encoded}")).size(px(64.0))
```

```tsx tabs
import { Image, signal } from "nsh";

const preview = URL.createObjectURL(photo); // the picked `File`
const src = signal(preview);
upload(photo).then((url) => {
  src.set(url);
  URL.revokeObjectURL(preview);
});

<Image src={src()} style={{ width: 240, height: 180 }} />;
```

Equal bytes are one image: the same picture as a `data:` URI and as a blob is decoded once and shares the cache.

During development assets are served by the dev server; `nsh build` and `nsh package` copy them into the app (a Rust
crate ships its `assets/` directory with `registry.assets(assets!())`). See
[images and assets](../docs/images-and-assets.md).

> [!NOTE]
> When the app declares [capabilities](../docs/sandbox-and-capabilities.md), remote images load from the hosts it
> lists; an image from any other host fails with `onError`. `asset:` URIs, `data:` URIs and `blob:` URLs always load.

## Props

Besides the [common props](./index.md#common-props) (with `style` typed as `ImageStyle`):

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `src` | `image(src)` | `string \| ImageAsset` | | The image. |
| `resizeMode` | `.resize_mode(ResizeMode::Contain)` | `"cover" \| "contain" \| "stretch" \| "center" \| "scale-down"` | `"cover"` | How the image fits its box: `"center"` shows it at its natural size, centered (CSS's `object-fit: none`); `"scale-down"` the same, shrunk to fit where it is larger. |
| `placeholder` | `.placeholder(src)` | `string \| ImageAsset` | | Shown until `src` has loaded; best a local asset. |
| `blurRadius` | `.blur_radius(px(..))` | `number` | | Blurs the image by this radius in points (applied once while decoding, off the main thread). |
| `fadeDuration` | `.fade_duration(ms)` | `number` | iOS `0`, Android `300` | How long a loaded image fades in, in milliseconds. |
| `tintColor` (style) | `.tint_color(..)` | `ColorValue` | | Recolors a template image (an icon drawn in one color). |
| `objectPosition` (style) | `.object_position(..)`, `.object_top()`, ... | `string` | `"center"` | Where the image sits in its box once `resizeMode` has sized it, as CSS's `object-position` (`"top"`, `"25% 75%"`, `"right 10px bottom 20%"`); a covering image is cropped around it. |
| `onLoadStart` | `.on_load_start(..)` | `() => void` | | Loading began. |
| `onProgress` | `.on_progress(..)` | `(e: { loaded: number; total: number }) => void` | | Download progress in bytes (`total` is 0 when unknown), at most every 100 ms. |
| `onLoad` | `.on_load(..)` | `(e: { width: number; height: number }) => void` | | Loaded; the source image's size in pixels (not the decoded, downsampled one; an SVG's size in points, [on the web as the browser measures it](../docs/images-and-assets.md#svg-images)); for an image with variants, the loaded variant's. |
| `onError` | `.on_error(..)` | `(e: { message: string }) => void` | | Loading failed. |
| `onLoadEnd` | `.on_load_end(..)` | `() => void` | | After `onLoad` or `onError`. |

`ImageStyle` adds `tintColor` to the view styles, which recolors a template image (an icon drawn in one color), and `objectPosition`, which places the image in its box ([Image position](../docs/images-and-assets.md#image-position)).

```rust tabs
image(ICON).size(px(24.0)).tint_color(rgb(0x0969da))
```

```tsx tabs
<Image src={icon} style={{ width: 24, height: 24, tintColor: "#0969da" }} />
```

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | none | Loading began. |
| `onProgress` | `.on_progress` | `{ loaded, total }` (`ImageProgress`) | Bytes arrived (at most every 100 ms). |
| `onLoad` | `.on_load` | `{ width, height }` (`Size<Points>`) | The image is shown; its source size in pixels (an SVG's in points, [on the web as the browser measures it](../docs/images-and-assets.md#svg-images)). |
| `onError` | `.on_error` | `{ message }` (`&str`) | Loading or decoding failed, or the host is outside the app's capabilities. |
| `onLoadEnd` | `.on_load_end` | none | After `onLoad` or `onError`. |

```rust tabs
let state = signal(SharedString::from("loading"));

image(url)
    .w_full()
    .aspect_ratio(16.0 / 9.0)
    .on_load(move |size: &Size<Points>| state.set(format!("{}×{}", size.width.0, size.height.0).into()))
    .on_error(move |message: &str| state.set(message.to_string().into()))
```

```tsx tabs
const state = signal("loading");
<Image
  src={url}
  style={{ width: "100%", aspectRatio: 16 / 9 }}
  onLoad={(e) => state.set(`${e.width}×${e.height} px`)}
  onError={(e) => state.set(e.message)}
/>;
```

An image with [pixel-density variants](../docs/images-and-assets.md#pixel-densities) loads one of its files, and
`onLoad` reports that file's pixels: 192×192 for `logo@3x.png` on a 3× screen, for a 64×64 point `logo.png`. When the
pixel ratio changes and the image loads another variant, it reports that load too: `onLoadStart`, then `onLoad` with the
new file's size (or `onError`), then `onLoadEnd`.

To know an image's size or load it before showing it, TSX calls `Image.getSize(src)` and `Image.prefetch(src)` (the
same `Image` that renders the element carries them; see the [Image API](../modules/nsh-image.md)), and Rust
`image_size(src)` and `prefetch_image(src)`, awaited in a task. Given an imported image with variants, `Image.getSize`
and `Image.prefetch` load the variant this screen shows, and `getSize` resolves with the imported file's size (64×64
for `logo.png`).

## Ref methods

None of its own.

## Platform notes

- The cache key includes the decode size and the blur radius: the same URL shown at two sizes is decoded twice but
  downloaded once.
- iOS plays animated images as a keyframe animation (up to 600 frames); a tinted animated image shows its first frame.
- Android plays animated images from API 28 (`AnimatedImageDrawable`), uncached and unblurred.
- On Android borders are drawn above the image, as on iOS.
