---
title: Image
description: 显示打包资源或远程图片的元素，支持占位图、模糊、淡入、着色和加载事件。
order: 4
group: primitives
demo: el-image
---

# Image

`Image` 显示来自应用资源或 URL 的图片。图片在主线程之外下载和解码，按视图显示的尺寸降采样，并缓存在内存中。动态 GIF、WebP 和 APNG 图片会自动播放。Rust 用 `image(src)` 创建，TSX 用从 `nsh` 导入的 `<Image>`。

```rust tabs
use nsh_core::prelude::*;

// 应用 crate 中的 assets/logo.png。
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

资源知道自己的尺寸：不设宽高时图片使用该尺寸；只设其中一个时，另一个按资源的宽高比计算。URL 的尺寸在加载完成后才知道，所以要给远程图片设置宽和高（或者其中一个加上宽高比）。

## 图片来源

图片来源（`src` 和 `placeholder`；Rust 中为 `image(..)` 和 `.placeholder(..)`）接受：

| 值 | 示例 | 说明 |
|---|---|---|
| 资源 | Rust `asset!("logo.png")`，TSX `import logo from "./logo.png"` | 一个 `ImageAsset` `{ url, size, scales? }`，以点为单位：`@2x` 文件按像素的一半计算。当 `logo.png` 旁边有 `logo@2x.png` / `logo@3x.png` 时，会加载适合屏幕像素比的变体（[像素密度](../docs/images-and-assets.md#像素密度)）。可以导入 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp` 和 `.heic`，以及按 `width` 和 `height` 或 `viewBox` 确定尺寸的 `.svg`（[SVG 图片](../docs/images-and-assets.md#svg-图片)）。 |
| URL | `"https://example.com/a.jpg"` | 下载并缓存。同一 URL 的下载在多个视图之间共享。 |
| 资源路径 | `"asset:/images/a.png"` | 应用资源中的文件。 |
| `data:` URI | `"data:image/png;base64,iVBOR…"` | URI 中的字节，base64 或百分号编码（`data:image/svg+xml,%3Csvg…`）。 |
| `blob:` URL | `URL.createObjectURL(blob)` | `Blob` 或 `File` 的字节（TSX）。图片保有这些字节：撤销 URL 后，正在显示它的图片保持完整。 |

来自应用已有字节的图片无需请求即可显示。聊天应用在照片上传期间用它的 blob 显示所选照片，上传完成后把 `src`
换成照片的 URL：

```rust tabs
// `data:` URI 中的字节（应用生成或内联收到的图片）。
image(format!("data:image/png;base64,{encoded}")).size(px(64.0))
```

```tsx tabs
import { Image, signal } from "nsh";

const preview = URL.createObjectURL(photo); // 所选的 `File`
const src = signal(preview);
upload(photo).then((url) => {
  src.set(url);
  URL.revokeObjectURL(preview);
});

<Image src={src()} style={{ width: 240, height: 180 }} />;
```

相同的字节是同一张图片：同一张图片无论作为 `data:` URI 还是 blob，都只解码一次并共享缓存。

开发期间资源由开发服务器提供；`nsh build` 和 `nsh package` 会把它们拷贝进应用（Rust crate 用 `registry.assets(assets!())` 发布它的 `assets/` 目录）。参见[图片与资源](../docs/images-and-assets.md)。

> [!NOTE]
> 应用声明了[能力](../docs/sandbox-and-capabilities.md)时，远程图片从其中列出的主机加载；来自其他主机的图片会以 `onError` 失败。`asset:` URI、`data:` URI 和 `blob:` URL 始终可以加载。

## 属性

除[通用属性](./index.md#通用属性)外（`style` 的类型为 `ImageStyle`）：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `src` | `image(src)` | `string \| ImageAsset` | | 图片。 |
| `resizeMode` | `.resize_mode(ResizeMode::Contain)` | `"cover" \| "contain" \| "stretch" \| "center" \| "scale-down"` | `"cover"` | 图片如何适配其盒子：`"center"` 以原始尺寸居中显示（CSS 的 `object-fit: none`）；`"scale-down"` 同样居中，较大时缩小以适应。 |
| `placeholder` | `.placeholder(src)` | `string \| ImageAsset` | | `src` 加载完成前显示的图片；最好是本地资源。 |
| `blurRadius` | `.blur_radius(px(..))` | `number` | | 以该半径（点）模糊图片（在解码时于主线程外处理一次）。 |
| `fadeDuration` | `.fade_duration(ms)` | `number` | iOS `0`，Android `300` | 图片加载完成后淡入的时长，单位毫秒。 |
| `tintColor`（样式） | `.tint_color(..)` | `ColorValue` | | 为模板图片（单色绘制的图标）重新着色。 |
| `objectPosition`（样式） | `.object_position(..)`、`.object_top()` 等 | `string` | `"center"` | `resizeMode` 确定尺寸后图片在盒子中的位置，同 CSS 的 `object-position`（`"top"`、`"25% 75%"`、`"right 10px bottom 20%"`）；覆盖盒子的图片围绕它裁剪。 |
| `onLoadStart` | `.on_load_start(..)` | `() => void` | | 开始加载。 |
| `onProgress` | `.on_progress(..)` | `(e: { loaded: number; total: number }) => void` | | 以字节计的下载进度（未知时 `total` 为 0），最多每 100 ms 一次。 |
| `onLoad` | `.on_load(..)` | `(e: { width: number; height: number }) => void` | | 加载完成；给出源图片的像素尺寸（不是解码、降采样后的尺寸；SVG 为它的点尺寸，[在 Web 上为浏览器测得的尺寸](../docs/images-and-assets.md#svg-图片)）；带有变体的图片给出所加载变体的尺寸。 |
| `onError` | `.on_error(..)` | `(e: { message: string }) => void` | | 加载失败。 |
| `onLoadEnd` | `.on_load_end(..)` | `() => void` | | 在 `onLoad` 或 `onError` 之后。 |

`ImageStyle` 在视图样式之上增加了 `tintColor`，为模板图片（单色绘制的图标）重新着色；以及 `objectPosition`，决定图片在盒子中的位置（[图片位置](../docs/images-and-assets.md#图片位置)）。

```rust tabs
image(ICON).size(px(24.0)).tint_color(rgb(0x0969da))
```

```tsx tabs
<Image src={icon} style={{ width: 24, height: 24, tintColor: "#0969da" }} />
```

## 事件

| 事件 | Rust | 载荷 | 触发时机 |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | 无 | 开始加载。 |
| `onProgress` | `.on_progress` | `{ loaded, total }`（`ImageProgress`） | 收到数据（最多每 100 ms 一次）。 |
| `onLoad` | `.on_load` | `{ width, height }`（`Size<Points>`） | 图片已显示；给出源图片的像素尺寸（SVG 为点，[在 Web 上为浏览器测得的尺寸](../docs/images-and-assets.md#svg-图片)）。 |
| `onError` | `.on_error` | `{ message }`（`&str`） | 加载或解码失败，或主机不在应用的能力范围内。 |
| `onLoadEnd` | `.on_load_end` | 无 | 在 `onLoad` 或 `onError` 之后。 |

```rust tabs
let state = signal(SharedString::from("加载中"));

image(url)
    .w_full()
    .aspect_ratio(16.0 / 9.0)
    .on_load(move |size: &Size<Points>| state.set(format!("{}×{}", size.width.0, size.height.0).into()))
    .on_error(move |message: &str| state.set(message.to_string().into()))
```

```tsx tabs
const state = signal("加载中");
<Image
  src={url}
  style={{ width: "100%", aspectRatio: 16 / 9 }}
  onLoad={(e) => state.set(`${e.width}×${e.height} px`)}
  onError={(e) => state.set(e.message)}
/>;
```

带有[像素密度变体](../docs/images-and-assets.md#像素密度)的图片会加载其中一个文件，`onLoad` 报告的是该文件的像素尺寸：对于 64×64 点的 `logo.png`，在 3× 屏幕上报告 `logo@3x.png` 的 192×192。像素比变化、图片加载另一个变体时，这次加载同样会触发事件：先是 `onLoadStart`，然后是带有新文件尺寸的 `onLoad`（或 `onError`），最后是 `onLoadEnd`。

如果需要在显示前获取图片尺寸或预先加载，TSX 调用 `Image.getSize(src)` 和 `Image.prefetch(src)`（它们就挂在渲染这个元素的同一个 `Image` 上；参见 [Image API](../modules/nsh-image.md)），Rust 在任务中 await `image_size(src)` 和 `prefetch_image(src)`。
传入带有变体的导入图片时，`Image.getSize` 和 `Image.prefetch` 加载当前屏幕显示的那个变体，`getSize` resolve 为导入文件的尺寸（`logo.png` 为 64×64）。

## ref 方法

没有自己的方法。

## 平台说明

- 缓存键包含解码尺寸和模糊半径：同一 URL 以两种尺寸显示会解码两次，但只下载一次。
- iOS 以关键帧动画播放动态图片（最多 600 帧）；着色的动态图片显示第一帧。
- Android 从 API 28 起播放动态图片（`AnimatedImageDrawable`），这些图片直接播放，不经缓存和模糊。
- 在 Android 上边框绘制在图片之上，与 iOS 一致。
