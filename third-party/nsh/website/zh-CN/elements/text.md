---
title: Text
description: 绘制文本的元素：嵌套片段、链接、行数限制、字体缩放、行内视图和文本布局事件。
order: 20
group: primitives
demo: el-text
---

# Text

`Text` 绘制一个段落。它是显示字符串的元素：`View` 的字符串子节点什么也不会画。段落在原生侧排版（iOS 和 Mac Catalyst 上用 CoreText，Android 上用 `StaticLayout`），并在引擎线程上测量，主线程只负责绘制。Rust 用 `text(content)` 创建，TSX 用从 `nsh` 导入的 `<Text>`。

```rust tabs
use nsh_core::prelude::*;

text("继续之前请阅读")
    .text_base()
    .line_height(px(24.0))
    .text_color(rgb(0x1f2328))
    .child(text("条款").font_weight(FontWeight::BOLD))
    .child("。")
```

```tsx tabs
<Text style={{ fontSize: 16, lineHeight: 24, color: "#1f2328" }}>
  继续之前请阅读<Text style={{ fontWeight: "700" }}>条款</Text>。
</Text>
```

`text(..)` 接受字符串、`SharedString`、signal 或闭包（`text(move || format!("{} 项", count.get()))`）：闭包或 signal 读取的内容变化时，文本就地更新。

## 片段

文本里的文本是同一段落中的一个片段（span），而不是单独的视图。片段继承段落的文本样式（`color`、`fontSize`、`fontWeight` 等），并覆盖自己设置的部分。整个文本块是一个原生视图。在 Rust 中，`text(..)` 先显示自身内容，再显示子元素：`.child(text(..))` 添加一个片段，`.child("…")` 添加一段普通文字。

```rust tabs
text("")
    .text_size(px(17.0))
    .child(text("Light ").font_weight(FontWeight::LIGHT))
    .child(text("Bold ").font_weight(FontWeight::BOLD))
    .child(text("Italic").italic().text_color(rgb(0x8250df)))
```

```tsx tabs
<Text style={{ fontSize: 17 }}>
  <Text style={{ fontWeight: "300" }}>Light </Text>
  <Text style={{ fontWeight: "bold" }}>Bold </Text>
  <Text style={{ fontStyle: "italic", color: "#8250df" }}>Italic</Text>
</Text>
```

### 片段背景

设置了背景的片段会在字符后面填充它们的方框：高度就是字体的高度（基线以上的 ascent 加基线以下的 descent，与行高无关）；片段换到几行，每行各画一个方框，圆角取片段的圆角半径。片段内部的片段沿用它的背景，除非自己另设。背景只影响绘制：文本排版与不设背景时相同，可选中的文本复制时连同片段的字符一起复制。行内代码就是一个片段：

```rust tabs
text("提交前先运行 ")
    .text_size(px(15.0))
    .line_height(px(22.0))
    .select_text()
    .child(
        text(" cargo test ")
            .font_family("ui-monospace")
            .text_size(px(13.0))
            .bg(rgb(0xeff1f3))
            .rounded(px(4.0)),
    )
    .child("。")
```

```tsx tabs
<Text style={{ userSelect: "text", fontSize: 15, lineHeight: 22 }}>
  {"提交前先运行 "}
  <Text style={{ fontFamily: "ui-monospace", fontSize: 13, backgroundColor: "#eff1f3", borderRadius: 4 }}>
    {" cargo test "}
  </Text>
  {"。"}
</Text>
```

Tailwind 类同样适用：`<Text class="bg-gray-100 rounded">`。内边距和边框是方框样式，片段上不起作用；在片段内两侧加空格，方框两边就会留出空间。

### 链接

带按压处理函数的片段就是链接：按在它的字符上由该片段处理，按在其他位置则由段落处理。

```rust tabs
text("继续即表示你同意")
    .text_size(px(15.0))
    .on_press(move || log("整句话"))
    .child(
        text("服务条款")
            .text_color(rgb(0x0969da))
            .underline()
            .on_press(move || open("terms")),
    )
    .child("。")
```

```tsx tabs
<Text style={{ fontSize: 15 }} onPress={() => log("整句话")}>
  {"继续即表示你同意"}
  <Text style={{ color: "#0969da", textDecorationLine: "underline" }} onPress={() => open("terms")}>
    服务条款
  </Text>
  。
</Text>
```

### 行内视图和图片

文本中的其他元素（视图、图片，即使位于片段内）都是行内附件：按自身尺寸布局，坐落在基线上（或由样式 `verticalAlign` 决定位置：`"text-top"`、`"text-bottom"`、`"middle"`，与 CSS 一致；所在行会撑高以容纳它），并随文字一起换行。它们可以单独响应按压。

```rust tabs
text("基于 ")
    .text_base()
    .line_height(px(26.0))
    .child(image(LOGO).size(px(18.0)).rounded(px(4.0)))
    .child(" NSH 构建。状态 ")
    .child(
        view()
            .bg(rgb(0x1a7f37))
            .rounded(px(9.0))
            .px(px(7.0))
            .h(px(18.0))
            .justify_center()
            .child(text("LIVE").text_color(white()).text_size(px(11.0)).font_weight(FontWeight::BOLD)),
    )
```

```tsx tabs
<Text style={{ fontSize: 16, lineHeight: 26 }}>
  {"基于 "}
  <Image src={logo} style={{ width: 18, height: 18, borderRadius: 4 }} />
  {" NSH 构建。状态 "}
  <View style={{ backgroundColor: "#1a7f37", borderRadius: 9, paddingHorizontal: 7, height: 18, justifyContent: "center" }}>
    <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "700" }}>LIVE</Text>
  </View>
</Text>
```

被 `numberOfLines` 或省略号截掉的附件会被隐藏。复制可选中的文本时不包含附件。

### 空白字符

JSX 文本遵循 React 的规则：除文本首尾外，每行都会去掉首尾空白，只含空白的行被丢弃，剩下的行用一个空格连接。同一行内的空格会保留（`{a} {b}` 保留中间的空格）。片段需要前导或尾随空格时，写 `{" "}` 或字符串表达式。Rust 字符串按原样绘制。

## 属性

除[通用属性](./index.md#通用属性)外（`style` 的类型为 `TextStyle`）：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `numberOfLines`（样式） | `.number_of_lines(n)`、`.truncate()` | `number` | `0` | 最多显示的行数；`0` 显示全部行。 |
| `textOverflow`（样式） | `.text_overflow(EllipsizeMode::Middle)` | `"ellipsis" \| "clip" \| "ellipsis-start" \| "ellipsis-middle"` | `"ellipsis"` | 超出 `numberOfLines` 的文本如何截断：省略号在末尾、开头或中间，或者直接裁掉。 |
| `allowFontScaling` | `.allow_font_scaling(..)` | `boolean` | `true` | 跟随系统的文字大小设置。 |
| `maxFontSizeMultiplier` | `.max_font_size_multiplier(..)` | `number` | `0` | 系统缩放的上限；`0` 表示不限。 |
| `adjustsFontSizeToFit` | `.shrink_to_fit(min_scale)` | `boolean` | `false` | 缩小字号，直到文本能放进其行数（`numberOfLines`）和盒子。 |
| `minimumFontScale` | `.shrink_to_fit(min_scale)` | `number` | | `adjustsFontSizeToFit` 最多缩小到的比例（0..1；至少 0.1）。 |
| `userSelect`（样式） | `.select_text()`、`.select_none()` | `"auto" \| "none" \| "text"` | `"auto"` | `"text"`：用户可以选择文本的任意范围：长按选中一个词，拖动选择柄扩展，编辑菜单复制。`"auto"` 取外层视图的设置；都没有设置时文字不可选择，但桌面浏览器除外：在那里文字默认可选，交互元素里的除外；设为 `"none"` 在那里也不可选择。 |
| `selectionColor`（样式） | `.selection_color(..)` | `ColorValue` | 平台的强调色 | 选区高亮和选择柄的颜色。 |
| `onTextLayout` | | `(e: { lines: TextLayoutLine[] }) => void` | | 每次布局后给出排好的各行。 |

Tailwind 类 `select-text`、`select-none` 和 `select-auto` 设置 `userSelect`，`line-clamp-*` 设置 `numberOfLines`，`text-ellipsis` 和 `text-clip` 设置 `textOverflow`，`truncate` 是单行并以省略号截断。选区高亮和选择柄的颜色由样式键 `selectionColor`（`selection:text-*`）设置，默认为平台的强调色。

## 文本样式

`TextStyle` 在视图样式之上增加了：`color`、`fontSize`、`fontWeight`（`"normal"`、`"bold"` 或 100–900）、`fontStyle`、`fontFamily`、`lineHeight`、`letterSpacing`、`textAlign`、`textAlignVertical`、`textTransform`、`textDecorationLine`、`textDecorationColor`、`textDecorationStyle`、`textDecorationThickness`、`textUnderlineOffset`、`textShadow`（CSS 的 `text-shadow`）、`fontVariant`、`writingDirection`、`numberOfLines` 和 `textOverflow`。在 Rust 中它们是 `Styled` 方法：`.text_color(..)`、`.text_size(..)`（或 `.text_sm()`、`.text_lg()` 等）、`.font_weight(FontWeight::SEMIBOLD)`、`.italic()`、`.font_family(..)`、`.line_height(..)`、`.letter_spacing(..)`、`.text_center()`、`.uppercase()`、`.underline()`、`.line_through()`、`.tabular_nums()`、`.number_of_lines(..)` 等。参见[样式参考](../modules/style-reference.md#textstyle)和[文本](../docs/text.md)。

字体族可以是系统字体族，也可以是应用的字体文件：

```rust tabs
// assets/fonts/Inter-Regular.ttf，由注册表随应用发布（`registry.assets(assets!())`）。
const INTER: FontAsset = asset!("fonts/Inter-Regular.ttf");

text("Inter").font_family(INTER.family).text_size(px(17.0))
```

```tsx tabs
import { Text } from "nsh";
import Inter from "./fonts/Inter-Regular.ttf";

<Text style={{ fontFamily: Inter, fontSize: 17 }}>Inter</Text>;
```

字体会在第一帧之前注册。参见[字体](../docs/fonts.md)。

## 事件

| 事件 | Rust | 载荷 | 触发时机 |
|---|---|---|---|
| `onTextLayout` | | `{ lines: TextLayoutLine[] }` | 段落每次布局之后。 |
| `onPress`、`onLongPress` 等 | `.on_press`、`.on_long_press` 等 | `PressEvent`（Rust 中无） | 与 [view](./view.md#事件) 相同；在片段上时，指按在其字符上的按压。 |
| `onLayout` | `.on_layout` | `{ bounds }` | 文本块的 frame 发生变化。 |

`TextLayoutLine` 为 `{ text, x, y, width, height, ascender, descender, capHeight, xHeight }`，坐标位于文本的内容盒中：

```tsx
const lines = signal(0);
<Text onTextLayout={(e) => lines.set(e.lines.length)}>{article}</Text>;
```

Rust 用 `measure_text(..)` 在布局之前测量字符串。

## ref 方法

没有自己的方法。

## 平台说明

- 选区在一个文本块（一个文本及其片段）之内。iOS 显示其编辑菜单（拷贝、全选、查询、翻译、共享），Android 显示浮动工具栏（复制、全选、分享）。
- 在 iOS 上，非实线单线的文本装饰线（`double`、`dotted`、`dashed`、`wavy`）由 NSH 自行绘制。
- iOS 上的文本绘制纯色背景和外阴影。
- [`nsh` 的设备 API](../modules/nsh.md#device) 的 `fontScale()`（Rust 中为 `font_scale()`）给出当前系统的文字缩放比例。
