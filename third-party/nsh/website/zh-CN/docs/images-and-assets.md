---
title: 图片与资源
description: 用 Rust 和 TSX 显示图片：应用的资源与 @2x 文件、SVG 图片、远程 URL、缩放模式、占位图、模糊、着色、加载事件，以及读取图片尺寸和预取图片。
order: 36
group: ui
---

# 图片与资源

图片元素（Rust 中的 `image(..)`，TSX 中的 `<Image>`）显示一张位图或一幅 SVG 图：随应用一起发布的文件，或从 URL 下载的图片。图片在主线程之外读取和解码，按视图实际显示的尺寸降采样后缓存；主线程只负责显示解码结果。

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

元素的属性列在 [image](../elements/image.md) 中。

## 应用内的图片

Rust crate 把文件放在它的 `assets/` 目录中：`asset!("logo@2x.png")`（路径相对于 `assets/`）是一个 `ImageAsset`，即 `{ url, size, scales }`，在 crate 编译时读取；在 crate 的 `#[native_module]` 函数中调用 `registry.assets(assets!())` 会把该目录中的每个文件随应用发布。在 TSX 中，像导入模块一样导入图片文件：导入得到一个 `ImageAsset`，即 `{ url, size, scales? }`，打包器会把文件随应用一起发布：

```rust tabs
const LOGO: ImageAsset = asset!("logo@2x.png");

// LOGO.url："asset:/@my-app/logo@2x.png"，LOGO.size：64 × 64 点

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.assets(assets!());
}
```

```tsx tabs
import logo from "./assets/logo@2x.png";

logo; // { url: "asset:/imports/<digest>/logo@2x.png", size: { width: 64, height: 64 } }
```

支持的文件：`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.heic`，以及 `.svg`（[SVG 图片](#svg-图片)）。

**尺寸以点为单位。** 文件名中的 `@2x` 或 `@3x` 后缀表示文件每个点有 2 或 3 个像素，因此 128×128 像素的 `logo@2x.png` 是一个 64×64 点的资源。没有后缀时，一个像素就是一个点。带后缀的文件显示的就是该文件本身；不带后缀的文件如果有[像素密度变体](#像素密度)，会显示适合屏幕的那一个。

**自然尺寸。** 当样式没有指定宽度或高度时，来自资源的图片按自然尺寸布局，所以 `image(LOGO)` 和 `<Image src={logo} />` 不需要任何样式。若要改变大小，设置其中一边加宽高比，或同时设置两边。

在 Rust 中，缺失或损坏的文件会让构建失败，文件改动后 crate 会重新构建。在 TSX 中，资源路径相对于导入它的模块解析，即使资源在入口目录以外也会打包。编译后的 `url` 使用 `asset:/imports/<digest>/<文件名>`；摘要包含整个资源族的文件名和内容，像素密度变体保留同目录的文件名关系，不受 checkout 位置影响。`nsh build` 会把它们复制到 `out/assets/`，`nsh package` 会把它们放进应用，开发时则由开发服务器提供。

> [!TIP]
> 在 TSX 中，`src` 也接受 `asset:/path` 字符串，被导入的文件才保证会被发布。从未导入的路径在开发服务器下可以使用（它提供整个应用目录），在打包后的应用中却会缺失。请导入你用到的每一张图片。Rust crate 通过 `assets!()` 发布整个 `assets/` 目录。

### 像素密度

指定不带后缀的文件，并把更高密度的版本放在它旁边，应用就会加载适合屏幕的那一个：

```text
assets/
├── logo.png       64×64 像素
├── logo@2x.png    128×128
└── logo@3x.png    192×192
```

```rust tabs
const LOGO: ImageAsset = asset!("logo.png");

// LOGO.size：64 × 64 点，LOGO.scales：[1.0, 2.0, 3.0]
```

```tsx tabs
import logo from "./assets/logo.png";

logo; // { url: "asset:/imports/<digest>/logo.png", size: { width: 64, height: 64 }, scales: [1, 2, 3] }
```

- 对不带后缀的图片，`asset!` 和打包器会查找它的 `@1.5x`、`@2x`、`@3x` 和 `@4x` 同名文件。`scales` 列出它们，其中 1 表示指定的文件本身；没有同名文件的图片没有 scales（在 TSX 中导入为 `{ url, size }`）。打包器发布找到的同名文件，`assets!()` 发布整个目录。
- 图片会加载不小于屏幕像素比的最小倍数，否则加载最大的倍数，与 React Native 的选择规则相同：1× 屏幕上加载 `logo.png`，2× 屏幕上加载 `logo@2x.png`，3× 手机上（以及 2.625 时）加载 `logo@3x.png`。在 Web 上只会下载这一个文件。
- 像素比变化时（窗口移到另一块屏幕、浏览器缩放），选择发生变化的图片会重新加载，并触发各自的[加载事件](#加载事件)。它们的尺寸保持为指定文件的尺寸，以点为单位。
- 当某个变体的像素尺寸不等于指定文件尺寸乘以其倍数时，TSX 构建会给出警告，Rust 构建会失败。
- 指定带密度后缀的文件（`./logo@3x.png`、`asset!("logo@3x.png")`）时，就只是该文件本身。
- [SVG 图片](#svg-图片)在任何像素比下都按屏幕绘制，因此不发布变体。

只用一个文件也可以：按需要的最高密度导出（`@3x` 能在所有手机上得到最清晰的效果），并带后缀指定它；解码时图片会降采样到屏幕所需的大小。变体让每块屏幕只下载、解码和保存适合它的那个文件。

## SVG 图片

终端后端暂不支持 SVG 图片源，请使用位图图片。

像导入其他图片一样导入 `.svg` 文件。它的尺寸（以点为单位）取自 `width` 和 `height`（只给出其中一个时，另一个按 `viewBox` 的宽高比算出），否则取自 `viewBox`：SVG 中的一个 CSS 像素就是一个点，文件名中的 `@2x` 后缀对 SVG 文件不起作用。

```tsx
import logo from "./assets/logo.svg"; // <svg width="120" height="40" …>
import star from "./assets/star.svg"; // <svg viewBox="0 0 24 24" …>

logo; // { url: "asset:/imports/<digest>/logo.svg", size: { width: 120, height: 40 } }

<Image src={logo} />
<Image src={star} style={{ width: 36, height: 36, tintColor: "#0969da" }} />
```

SVG 在显示的尺寸下清晰。浏览器以矢量方式绘制它；iOS、macOS 和 Android 在图片加载时按视图显示它的像素尺寸绘制（与位图的降采样相同；之后变大的视图会缩放这次绘制的结果，直到图片重新加载）；Windows、Linux 和 GPUI 以每点四个像素绘制一次（每边最多 2048 像素），再缩放到各个视图。其余一切与位图相同：`objectFit`、`tintColor`（透过 SVG 的不透明形状着色，单色图标因此能随主题变色）、滤镜、`blurRadius`、占位图、加载事件、`Image.getSize` 与 `Image.prefetch`。`onLoad` 和 `Image.getSize` 以整数点报告 SVG 的尺寸；图片按它的精确尺寸布局。远程 SVG 文件以同样的方式加载，经过同样的下载与[能力](./sandbox-and-capabilities.md)检查；NSH 根据内容识别 SVG（包括 gzip 压缩的 `.svgz`），与 URL 的结尾无关。

**原生平台绘制的内容。** iOS、macOS、Android、Windows、Linux 和 GPUI 用同一个渲染器（resvg）绘制 SVG，因此同一幅图在各平台上看起来一致：形状与路径、填充与描边、渐变与图案、裁剪路径与蒙版、不透明度、滤镜和变换。文本（`<text>`）、动画（SMIL 与 CSS）、嵌入的图片（`<image>`）和 HTML（`<foreignObject>`）在浏览器中显示；原生平台绘制 SVG 的其余部分，保持静止，`nsh build` 会指出用到它们的文件。把文本导出为轮廓（路径），即可在各处得到相同的效果。

**自成一体的图片。** 在原生平台上，SVG 只绘制它自身包含的内容：它引用的文件、URL、`data:` 图片和其他文档都不会加载。原生平台在控制内存的范围内绘制 SVG（包括远程的 SVG）：文档最大 16 MiB（压缩的 SVG 按解压后计算），绘制结果每边最多 8192 像素、总共最多 4096 × 4096 像素（64 MiB；更大的会缩小绘制），图层（带不透明度、蒙版、裁剪路径和滤镜的组，渲染器会单独绘制它们）同时最多 256 MiB。超出文档或图层范围的 SVG 加载失败，并触发 `onError`。

**Web 上报告的尺寸。** 浏览器自行测量 SVG，无论是导入的还是远程的：SVG 有 `width` 和 `height` 时，`onLoad` 和 `Image.getSize` 报告这两个值，否则报告浏览器给出的尺寸，浏览器通常由默认尺寸 300 × 150 和 `viewBox` 的宽高比得出它。导入的 SVG 在所有平台上都按打包器给出的尺寸布局。为 SVG 设置 `width` 和 `height`，即可在各处得到相同的报告尺寸。

## 远程图片

给元素一个 URL：在 Rust 中是字符串（会变化的 URL 用闭包），在 TSX 中是 URL 字符串：

```rust tabs
image(move || user.with(|u| u.avatar_url.clone()))
    .size(px(48.0))
    .rounded(px(24.0))
    .bg(rgb(0xeaeef2))
```

```tsx tabs
<Image src={user().avatarUrl} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#eaeef2" }} />
```

- **为远程图片指定尺寸。** 加载完成前无法得知它们的尺寸，所以如果没有宽和高（或其中一边加宽高比），它们的高度会塌缩为 0。
- 加载期间会显示**背景色**，也可以使用占位图（见下文）。
- 下载是共享的：多个视图显示同一个 URL 时只下载一次，即使它们按不同尺寸解码也是如此。没有任何视图再等待的下载会被取消。
- 解码后的图片缓存在内存中（内存紧张时会清理），以 URL、解码尺寸和模糊半径为键。
- 当应用声明了[能力](./sandbox-and-capabilities.md)时，图片的主机必须在 `network` 中被允许；被拒绝的图片会触发错误事件。

### 磁盘缓存

下载的图片还会按服务器发送的原样保存在磁盘上，所以再次打开的应用（满是头像和照片的会话、信息流）无需重新下载就能显示之前显示过的图片，离线时也一样。应用无需任何设置：在 iOS、Android、macOS、Windows、Linux 和 GPUI 上，每张 `http://` 或 `https://` URL 的图片都经过这个缓存；在浏览器中，由浏览器自己的 HTTP 缓存完成同样的事。

缓存遵循服务器的 HTTP 缓存头：

- 图片会被保存，除非响应带有 `Cache-Control: no-store`。
- 在新鲜期内直接使用，不发请求：新鲜期为 `max-age`，否则到 `Expires` 为止，否则为距 `Last-Modified` 时长的十分之一（最多一周）。
- 过期后向服务器确认（用它的 `ETag` 发 `If-None-Match`，用它的 `Last-Modified` 发 `If-Modified-Since`）：未变的图片（`304`）无需下载即可再次使用，变了的则被替换。
- 请求失败（没有网络）或服务器出错（`5xx`）时，显示保存的副本，除非响应声明了 `must-revalidate` 或 `no-cache`。

每个应用有自己的缓存，大小为 256 MiB；超出后，最久未使用的图片先被删除。同一应用的多个视图、surface 和进程可以安全地共用它。嵌入应用可以选择它的位置和大小，或关闭它：

```rust tabs
// macOS、Windows、Linux 和 GPUI：AppView 的选项（或 AppView::set_cache）。
let mut cache = CacheOptions::at(CacheLocation::Dir(caches.join("nsh")));  // 每个应用在 <dir>/<app id>
cache.images = CachePolicy::MaxSize(ByteSize::mib(64));                     // CachePolicy::Off：不保存
let view = AppView::new(mtm, AppOptions { cache, ..AppOptions::default() });
```

```swift tabs
// iOS：NshAppView，在加载之前设置。
app.cacheOptions = NshCacheOptions(location: .directory(caches.appendingPathComponent("nsh")),
                                   images: .maxSize(megabytes: 64))   // .off：不保存
```

```java tabs
// Android：NshView，在加载之前设置。
nsh.setCacheOptions(NshCacheOptions.builder()
        .location(new File(getCacheDir(), "nsh"))
        .imagesMaxMegabytes(64)          // imagesOff()：不保存
        .build());
```

`CacheLocation::Off`（`.off`、`noDiskCache()`）表示不在磁盘上保存任何内容。

默认情况下，缓存位于系统的缓存目录：iOS 上是 `Library/Caches/nsh`，Android 上是缓存目录中的 `nsh`，macOS 上是 `~/Library/Caches`，Windows 上是 `%LOCALAPPDATA%`，Linux 上是 `$XDG_CACHE_HOME`（`~/.cache`），每个应用在其中的 `<app id>/images`。系统需要空间时可能会清理这些目录。

## 缩放模式

`objectFit` 样式，即 CSS 的 `object-fit`（Rust 中的 `.object_fit(..)`），决定图片如何填充形状不同的框：

| 取值 | 效果 |
|---|---|
| `"cover"`（`ResizeMode::Cover`，默认） | 保持宽高比填满整个框，裁掉溢出部分 |
| `"contain"`（`ResizeMode::Contain`） | 保持宽高比完整放入框内，留出空白 |
| `"fill"`（`ResizeMode::Stretch`） | 精确填满框，图片会变形 |
| `"none"`（`ResizeMode::Center`） | 自然尺寸，放在 `objectPosition` 处（默认居中） |
| `"scale-down"`（`ResizeMode::ScaleDown`） | 自然尺寸，比框大时缩小到放得下 |

```rust tabs
image(photo).object_fit(ResizeMode::Contain).size(px(140.0)).bg(rgb(0xeaeef2))
```

```tsx tabs
<Image src={photo} style={{ width: 140, height: 140, objectFit: "contain", backgroundColor: "#eaeef2" }} />
```

Tailwind 类 `object-cover`、`object-contain`、`object-fill`、`object-none` 和 `object-scale-down` 设置的是同一个样式。

### 图片位置

缩放后的图片在框中的位置由 `objectPosition` 样式决定（Rust 中为 `.object_position(..)` 和 `.object_top()` 等），即 CSS 的 `object-position`，默认居中。覆盖整个框的图片围绕这个位置裁剪，完整放入的图片在留白中按它移动。它接受关键字（`"top"`、`"left bottom"`）、百分比与长度（`"25% 75%"`、`"10px 0"`），以及带偏移的边（`"right 10px bottom 20%"`）。聊天气泡里的长图可以这样显示顶部：

```rust tabs
image(photo).object_fit(ResizeMode::Cover).object_top().w(px(220.0)).h(px(160.0)).rounded(px(16.0))
```

```tsx tabs
<Image src={photo} style={{ width: 220, height: 160, borderRadius: 16, objectPosition: "top" }} />
```

Tailwind 类与 Tailwind 相同：`object-top`、`object-bottom`、`object-left`、`object-right`、`object-center`、`object-top-left`、`object-top-right`、`object-bottom-left`、`object-bottom-right`，以及任意值（`object-[25%_75%]`）。

## 图片样式

图片也是视图：它们支持圆角（也可按角设置）、边框、阴影、不透明度和变换。圆角会裁剪图片。

```rust tabs
image(avatar).size(px(90.0)).rounded(px(45.0)).border(px(3.0)).border_color(rgb(0x8250df))
```

```tsx tabs
<Image src={avatar} style={{ width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: "#8250df" }} />
```

- **着色**（Rust 中的 `.tint_color(..)`，TSX 中的 `tintColor` 样式）会给图片的不透明像素重新着色：适合随主题变色的单色图标。
- **滤镜**（`.grayscale(..)`、`.sepia(..)`、`.blur(..)`；TSX 中的 `filter`）在两个平台上都可用于图片（[滤镜](./styling.md#滤镜与混合)）。

```rust tabs
image(ICON).size(px(24.0)).tint_color(AdaptiveColor::rgb(0x0969da, 0x58a6ff))
```

```tsx tabs
<Image src={icon} style={{ width: 24, height: 24, tintColor: active() ? "#0969da" : "#6e7781" }} />
```

## 占位图、淡入与模糊

| 属性 | Rust | 说明 |
|---|---|---|
| `placeholder` | `.placeholder(..)` | `src` 加载完成前显示的图片，URL 或资源；最好是本地资源 |
| `fadeDuration` | `.fade_duration(ms)` | 加载完成的图片淡入所用的毫秒数。iOS 默认 0，Android 默认 300 |
| `blurRadius` | `.blur_radius(px(..))` | 按此半径（点）模糊图片，在解码时一次性应用 |

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

## 动图

动态 GIF、WebP 和 APNG 文件会自动播放，无论是资源还是来自 URL。它们支持相同的样式，包括 `objectFit`；在 iOS 上，着色后的动图只显示第一帧。

## 加载事件

| 事件 | Rust | 负载 | 触发时机 |
|---|---|---|---|
| `onLoadStart` | `.on_load_start(..)` | | 开始加载 |
| `onProgress` | `.on_progress(..)` | `{ loaded, total }`，单位为字节（未知时 `total` 为 0） | 下载过程中，最多每 100 ms 一次 |
| `onLoad` | `.on_load(..)` | `{ width, height }` | 图片就绪；源图的像素尺寸（SVG 为点，[在 Web 上为浏览器测得的尺寸](#svg-图片)） |
| `onError` | `.on_error(..)` | `{ message }`（Rust 中为 `&str`） | 加载或解码失败 |
| `onLoadEnd` | `.on_load_end(..)` | | 在 `onLoad` 或 `onError` 之后 |

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

加载事件报告的是源图的尺寸，而不是解码时的尺寸。

带有[像素密度变体](#像素密度)的图片会加载其中一个文件，加载事件报告的是该文件的像素尺寸：在 3× 屏幕上，`logo@3x.png` 报告 192×192，而 `Image.getSize(logo)` resolve 为导入文件的 64×64。像素比变化、图片加载另一个变体时，这次加载同样会触发事件：先是 `onLoadStart`，然后是带有新文件尺寸的 `onLoad`（或 `onError`），最后是 `onLoadEnd`。

## 图片尺寸与预取

不在屏幕上的图片也可以测量尺寸和提前加载：Rust 中是 `image_size(..)` 和 `prefetch_image(..)`，TSX 中是 `Image.getSize` 和 `Image.prefetch`（就在渲染元素的那个 `Image` 上）：

```rust tabs
spawn(async move {
    // Ok(ImageSize { width, height })，单位为像素。
    let size = image_size("https://example.com/photo.jpg").await;
    // 字节进入内存后为 true。
    let ok = prefetch_image("https://example.com/next.jpg").await;
});
```

```tsx tabs
import { Image } from "nsh";

const size = await Image.getSize("https://example.com/photo.jpg");   // { width, height } in pixels
const ok = await Image.prefetch("https://example.com/next.jpg");      // true once the bytes are in memory
```

| Rust | TSX | 返回值 |
|---|---|---|
| `image_size(src)` | `Image.getSize(src)` | 图片的像素尺寸（SVG 为点，[在 Web 上为浏览器测得的尺寸](#svg-图片)）；无法加载时返回错误 |
| `prefetch_image(src)` | `Image.prefetch(src)` | 图片字节加载完成后为 `true` |

在 TSX 中，`src` 是 URL 字符串或导入的图片。对于带有[变体](#像素密度)的导入图片，两者都会加载视图在当前屏幕上加载的那个变体，`getSize` 返回导入文件的尺寸。两者都会为接下来显示该图片的视图保留已下载的字节，因此先预取再显示的图片无需再次下载。

一个常见用法是按宽高比确定远程图片的尺寸：

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

## 其他资源

| 文件 | Rust（`asset!`） | TSX 导入 | 页面 |
|---|---|---|---|
| `.ttf`、`.otf` | 带字体族名的 `FontAsset` | 字体的字体族名 | [字体](./fonts.md) |
| `.json` 及其他文件 | 带 URI 的 `FileAsset` | `.json`：解析后的值，打包进脚本 | [项目结构](./project-structure.md#模块) |

两种方式下，字体都在第一帧之前注册。

### 模块自身的 URL

在 TSX 中，`import.meta.url` 是书写它的模块的 URL，因此 `new URL("./data.json", import.meta.url)` 指向它旁边的文件。本地运行或打包的桌面应用中，模块的 URL 是应用目录下的 `file:` URL，可在 `${pluginDir}` 授权下用 `fs/promises` 读取；Web 应用中是页面的 URL；打包的移动应用中是 `asset:/` URL，与导入的图片相同。要随应用发布图片，请导入它：这样构造的 URL 只指向文件，并不会打包它。

位图也可以用 `draw_image` / `drawImage` 绘制在画布上（[Canvas](./canvas.md)），而渐变能替代许多装饰性图片（[样式](./styling.md#渐变)）。

## 相关内容

- [image 元素](../elements/image.md)：所有属性，以及 `getSize` 和 `prefetch`。
- [列表](./lists.md)：长图片列表会复用视图。
