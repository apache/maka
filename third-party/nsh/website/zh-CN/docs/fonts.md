---
title: 字体
description: 系统字体与通用字体族、从 Rust crate 的资源或 TSX 导入发布 .ttf 和 .otf 文件、含多个字重和斜体的字体族，以及在类型化样式和 Tailwind 类中使用字体。
order: 37
group: ui
---

# 字体

除非字体族另有指定（Rust 中的 `.font_family(..)`，TSX 中的 `fontFamily`），文字使用系统字体（iOS 上是 San Francisco，Android 上是 Roboto）。字体族可以是通用字体族、设备上已安装的字体，或随应用发布的字体文件。

## 系统字体与通用字体族

| `fontFamily` | 字体 |
|---|---|
| （不设置）、`"system-ui"`、`"sans-serif"`、`"ui-sans-serif"`、`"-apple-system"` | 系统字体 |
| `"serif"`、`"ui-serif"` | 系统衬线字体（iOS 上是 New York，Android 上是 Noto Serif） |
| `"monospace"`、`"ui-monospace"` | 系统等宽字体（iOS 上是 SF Mono） |
| `"ui-rounded"` | 系统圆体（SF Pro Rounded），仅限 iOS |

系统字体支持 100 到 900 的所有字重。Tailwind 的 `font-sans`、`font-serif` 和 `font-mono` 分别对应前三行；主题设置了字体时，`font-sans` 和 `font-mono` 对应主题的字体（[应用的默认字体](#应用的默认字体)）。

设备上已安装的字体族可以直接用名称指定（iOS 上的 `"Georgia"`、`"Avenir Next"`）。不同平台和系统版本安装的字体各不相同，所以设计依赖的字体请随应用发布。在 iOS 上，不存在的字体族会回退到系统字体，并在日志中输出警告（`font family 'X' is not available`）。

## 发布字体

Rust crate 发布其 `assets/` 目录中的文件：在 `#[native_module]` 函数中调用 `registry.assets(assets!())` 会发布全部文件，`asset!("fonts/Pacifico-Regular.ttf")` 是一个 `FontAsset`，它的 `family` 是字体的字体族名，在 crate 编译时从文件中读取。在 TSX 中，导入一个 `.ttf` 或 `.otf` 文件，导入的值就是字体的字体族名。两种方式下字体都会在第一帧之前注册，文字首次渲染时即可使用：

```rust tabs
use nsh_core::{element::FontAsset, prelude::*};

const PACIFICO: FontAsset = asset!("fonts/Pacifico-Regular.ttf");

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.assets(assets!());
}

text("Custom fonts").font_family(PACIFICO.family).text_size(px(30.0))
```

```tsx tabs
import { Text } from "nsh";
import Pacifico from "./fonts/Pacifico-Regular.ttf";

<Text style={{ fontFamily: Pacifico, fontSize: 30 }}>Custom fonts</Text>
```

`PACIFICO.family` 和 TSX 导入的 `Pacifico` 都是字符串 `"Pacifico"`：它是字体文件中存储的字体族名（优先取排版字体族名，否则取字体族名），而不是文件名。使用资源的值而不是手写名称，可以让两者始终一致；缺失或损坏的文件会让 Rust 构建失败，导入的文件则一定会被打包。

这些文件会像其他[资源](./images-and-assets.md)一样随应用发布。字体只为应用进程注册，不会安装到设备上。

> [!WARNING]
> 在 TSX 中，值从未被使用的导入会被 TypeScript 的导入消除（import elision）移除，字体也随之丢失。如果你只通过名称引用某个字体族（例如在 Tailwind 主题中），请以副作用方式导入文件：`import "./fonts/Inter-Bold.ttf";`。Rust crate 通过 `assets!()` 发布 `assets/` 中的每一个文件。

## 字重与斜体

一个字体族通常由多个文件组成，每个字重和样式一个。逐个发布它们（Rust 中放进 `assets/`，TSX 中逐个导入）；它们会注册在同一个字体族名下，由字重和样式选择具体字形：

```rust tabs
// assets/fonts：Inter-Regular.ttf、Inter-Medium.ttf、Inter-Bold.ttf、Inter-Italic.ttf
const INTER: FontAsset = asset!("fonts/Inter-Regular.ttf");

text("Regular, ")
    .font_family(INTER.family)
    .text_size(px(16.0))
    .child(text("medium").font_weight(FontWeight::MEDIUM))
    .child(", ")
    .child(text("bold").font_weight(FontWeight::BOLD))
    .child(" and ")
    .child(text("italic").italic())
    .child(".")
```

```tsx tabs
import { Text } from "nsh";
import Inter from "./fonts/Inter-Regular.ttf";
import "./fonts/Inter-Medium.ttf";
import "./fonts/Inter-Bold.ttf";
import "./fonts/Inter-Italic.ttf";

const body = { fontFamily: Inter, fontSize: 16 } as const;

<Text style={body}>
  Regular, <Text style={{ fontWeight: "500" }}>medium</Text>, <Text style={{ fontWeight: "bold" }}>bold</Text> and{" "}
  <Text style={{ fontStyle: "italic" }}>italic</Text>.
</Text>
```

当没有已注册字形恰好匹配所需字重时，会使用最接近的一个。缺少字形时两个平台的表现不同：

| | iOS | Android |
|---|---|---|
| 没有对应字重的字形 | 最接近的已注册字形 | 最接近的字形，在适用时由 Android 合成粗体 |
| 没有斜体字形 | 使用正体字形（不倾斜） | 将正体字形倾斜后显示 |

发布你用到的所有字形，才能在两个平台上得到一致的结果。

## 在类型化样式和 Tailwind 类中使用字体

在 Rust 中，任何可以写样式的地方，`.font_family(..)` 都接受资源的字体族，字重方法（`.font_weight(FontWeight::SEMIBOLD)`）选择字形。对于类名，在 `nsh.json` 的 Tailwind 主题中为字体族命名，就可以把它们当作 `font-*` 类使用：

```json
{
  "tailwind": {
    "fontFamily": { "display": "Pacifico", "body": "Inter" }
  }
}
```

```rust tabs
use nsh_core::element::palette::VIOLET;

text("Custom fonts").font_family(PACIFICO.family).text_3xl().text_color(VIOLET.shade(600))
text("Bold Inter").font_family(INTER.family).font_weight(FontWeight::BOLD)
```

```tsx tabs
import { Text } from "nsh";
import "./fonts/Pacifico-Regular.ttf";
import "./fonts/Inter-Regular.ttf";
import "./fonts/Inter-Bold.ttf";

<Text class="font-display text-3xl text-violet-600">Custom fonts</Text>
<Text class="font-body font-bold">Bold Inter</Text>
```

不在主题中登记也可以使用任意字体族：`font-[Pacifico]`。字重类（`font-light`、`font-semibold`、`font-bold` 等）与 `fontWeight` 一样选择字形。视图上的文字样式会传给其内部的文字，因此视图上的 `.font_family(INTER.family)` 或 `<View class="font-body">` 可以为整个页面设置字体族。

## 应用的默认字体

主题的 `font-sans` 是应用的字体：没有设置自己字体族的文字都用它绘制，Rust 组件和 TSX 都一样，就像网页使用 Tailwind 的 `--font-sans`。`font-mono` 是等宽字体，用于 `font-mono` 类和 `TextView` 中的代码。在应用的主题（`nsh.json` 的 `"theme"`，[用 Rust 开发](./rust.md#主题)）中设置它们，并像上文那样发布字体文件：

```json
{
  "cssVars": {
    "theme": {
      "font-sans": "Inter, sans-serif",
      "font-mono": "JetBrains Mono, monospace"
    }
  }
}
```

列表中第一个非通用的字体族就是所用的字体；第一个是通用字体族（`system-ui`、`sans-serif`）时使用系统字体。字体也可以设置在容器上，内部的文字会继承它。

```rust tabs
#[component]
pub fn Root() -> impl IntoElement {
    view().flex_1().font_family(INTER.family).child(app())
}
```

```tsx tabs
mount(() => (
  <View class="flex-1 font-body">
    <App />
  </View>
));
```

## 字体特性

`fontVariant` 用于开启字体的 OpenType 特性：`"tabular-nums"`、`"proportional-nums"`、`"lining-nums"`、`"oldstyle-nums"` 和 `"small-caps"`（Rust 中的 `.tabular_nums()`、`.small_caps()` 等；[文字](./text.md#文字样式)）。字体本身必须包含这些特性；系统字体都包含。

## 相关内容

- [文字](./text.md)：文字样式、字号以及系统字号设置。
- [Tailwind](./tailwind.md#主题)：主题的各个键。
- [图片与资源](./images-and-assets.md)：应用的文件如何发布。
