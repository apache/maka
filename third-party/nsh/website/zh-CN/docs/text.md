---
title: 文字
description: 用 Rust 和 TSX 的 text 元素显示文字：嵌套 span 与链接、行内视图、字体与装饰线、截断、系统字号、选择以及 onTextLayout。
order: 35
group: ui
---

# 文字

所有文字都通过文本元素显示：Rust 中是 `text(..)`，TSX 中是 `<Text>`。一个文本元素就是一个段落，在布局时由平台的文本引擎（Apple 平台上是 CoreText，Android 上是 `StaticLayout`）在引擎线程上排版，主线程只负责绘制。嵌套的文本元素是同一段落中的 span，而不是独立的视图。

```rust tabs
text("By continuing you agree to the ")
    .text_size(px(16.0))
    .line_height(px(24.0))
    .text_color(rgb(0x1f2328))
    .child(
        text("Terms of service")
            .text_color(rgb(0x0969da))
            .underline()
            .on_press(open_terms),
    )
    .child(".")
```

```tsx tabs
<Text style={{ fontSize: 16, lineHeight: 24, color: "#1f2328" }}>
  By continuing you agree to the{" "}
  <Text style={{ color: "#0969da", textDecorationLine: "underline" }} onPress={openTerms}>
    Terms of service
  </Text>
  .
</Text>
```

> [!IMPORTANT]
> 字符串由文本元素显示。在 TSX 中，直接放在 `<View>` 中的字符串不会显示：请把它包在 `<Text>` 里。

元素本身的说明见 [text](../elements/text.md)；本页介绍如何使用它。

## 字符串与空白

在 Rust 中，文本的内容就是一个字符串，按原样显示：`\n` 表示换行。读取 signal 的内容写成闭包，signal 变化时文本随之更新。在 TSX 中，JSX 中的文字遵循与 React 相同的规则：每一行首尾的空白被去掉，只含空白的行被丢弃，剩下的行用一个空格连接。同一行内的空白会保留，所以 `{first} {last}` 中间的空格不会丢。在行首或行尾需要空格时用 `{" "}`，需要换行时用 `{"\n"}`：

```rust tabs
text(move || format!("Hello, {}!\nWelcome back.", name.get()))
```

```tsx tabs
<Text>
  Hello,
  {name()}!{"\n"}
  Welcome back.
</Text>
```

文字中的表达式会跟随它读取的值：`text(move || format!("{} items", count.get()))` 和 `<Text>{count()} items</Text>` 都会在 `count` 变化时更新。

## Span 与继承

文本中的文本是一个 span。它继承父元素的文字样式，并覆盖自己设置的部分：

```rust tabs
text("")
    .text_size(px(17.0))
    .text_color(rgb(0x1f2328))
    .child(text("Light ").font_weight(FontWeight::LIGHT))
    .child(text("Bold ").font_weight(FontWeight::BOLD))
    .child(text("Italic ").italic())
    .child(text("Spaced").letter_spacing(px(4.0)))
```

```tsx tabs
<Text style={{ fontSize: 17, color: "#1f2328" }}>
  <Text style={{ fontWeight: "300" }}>Light </Text>
  <Text style={{ fontWeight: "700" }}>Bold </Text>
  <Text style={{ fontStyle: "italic" }}>Italic </Text>
  <Text style={{ letterSpacing: 4 }}>Spaced</Text>
</Text>
```

文字样式也会像 CSS 一样从视图向下传递：Rust 中的 `view().text_color(white()).text_sm()` 和 TSX 中的 `<View class="text-white text-sm">` 会为其中的文本和输入元素设置样式。

### 链接

带有按下处理（`.on_press(..)` 或 `.on_long_press(..)`；`onPress` 或 `onLongPress`）的 span 就是链接：按在它的字符上会交给这个 span，按在其他位置则交给整个段落。嵌套 span 中的链接同样有效。

```rust tabs
text("Read the ")
    .on_press(move || tapped.set("the sentence"))
    .child(text("terms").text_color(rgb(0x0969da)).on_press(move || tapped.set("terms")))
    .child(" first.")
```

```tsx tabs
<Text onPress={() => log("the sentence")}>
  Read the <Text style={{ color: "#0969da" }} onPress={() => open(termsUrl)}>terms</Text> first.
</Text>
```

### Span 的背景

Span 的背景色和圆角会在它所在的每一行、字符后面画一个与字体等高的方框；文字排版不变，复制时内容完整，所以行内代码就是一个 span（[Text 元素](../elements/text.md#片段背景)）：

```rust tabs
text("先运行 ")
    .child(text(" npm test ").font_family("ui-monospace").bg(rgb(0xeff1f3)).rounded(px(4.0)))
    .child("。")
```

```tsx tabs
<Text>
  先运行 <Text style={{ fontFamily: "ui-monospace", backgroundColor: "#eff1f3", borderRadius: 4 }}> npm test </Text>。
</Text>
```

### 文字中的视图和图片

文本中除文本以外的任何元素都会以行内方式布局在基线上，并随文字一起换行。它也可以有自己的按下处理：

```rust tabs
text("Made with ")
    .text_size(px(16.0))
    .line_height(px(26.0))
    .child(image(LOGO).size(px(18.0)))
    .child(" nsh. Status ")
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
  Made with <Image src={logo} style={{ width: 18, height: 18 }} /> nsh. Status{" "}
  <View style={{ backgroundColor: "#1a7f37", borderRadius: 9, paddingHorizontal: 7, height: 18, justifyContent: "center" }}>
    <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "700" }}>LIVE</Text>
  </View>
</Text>
```

被 `numberOfLines` 或省略号截掉的行内元素会被隐藏；复制文字时也不会包含它们。

样式键 `verticalAlign` 决定行内元素在所在行中的位置，与 CSS 的 `vertical-align` 摆放图片的方式一致：`"baseline"`（默认）让元素底边落在基线上，`"text-top"` 和 `"text-bottom"` 让元素顶边或底边对齐文本字体的顶部或底部，`"middle"` 让元素中心位于基线上方半个 x 高度处。元素超出字体的部分会撑高所在行。段首图标若要像 Android 的 `ImageSpan` 那样与文字底部对齐，使用 `"text-bottom"`。对应的类是 `align-baseline`、`align-text-top`、`align-text-bottom` 和 `align-middle`；Rust 中是同名的 `.align_text_bottom()` 等方法。

```tsx
<Text style={{ fontSize: 16 }}>
  <Image src={badge} style={{ width: 16, height: 16, verticalAlign: "text-bottom" }} /> 认证卖家
</Text>
```

## 文字样式

| 属性 | 取值 | Rust |
|---|---|---|
| `color` | 一个[颜色](./styling.md#颜色)。默认黑色 | `.text_color(..)` |
| `fontSize` | 点。默认 14 | `.text_size(px(..))`、`.text_sm()`、`.text_lg()` 等 |
| `fontWeight` | `"normal"`（400）、`"bold"`（700），或 `100`–`900`（数字或字符串） | `.font_weight(FontWeight::BOLD)` |
| `fontStyle` | `"normal"`、`"italic"` | `.italic()` |
| `fontFamily` | 系统字体族、通用字体族或[导入的字体](./fonts.md) | `.font_family(..)` |
| `lineHeight` | 点 | `.line_height(px(..))` |
| `letterSpacing` | 点 | `.letter_spacing(px(..))` |
| `textAlign` | `"auto"`、`"left"`、`"center"`、`"right"`、`"justify"` | `.text_left()`、`.text_center()`、`.text_right()`、`.text_justify()` |
| `textAlignVertical` | `"auto"`、`"top"`、`"center"`、`"bottom"`：文字比所在框矮时的位置 | |
| `textTransform` | `"none"`、`"uppercase"`、`"lowercase"`、`"capitalize"` | `.normal_case()`、`.uppercase()`、`.lowercase()`、`.capitalize()` |
| `textDecorationLine` | `"none"`、`"underline"`、`"line-through"`、`"underline line-through"` | `.no_underline()`、`.underline()`、`.line_through()` |
| `textDecorationColor`、`textDecorationStyle` | 颜色；`"solid"`、`"double"`、`"dotted"`、`"dashed"`、`"wavy"` | `.text_decoration_color(..)`、`.text_decoration_wavy()` 等 |
| `textDecorationThickness`、`textUnderlineOffset` | 点或 `"auto"`（粗细还可以是 `"from-font"`） | `.text_decoration_thickness(px(..))`、`.underline_offset(px(..))` |
| `textShadowColor`、`textShadowOffset`、`textShadowRadius` | 字形后面的阴影 | `.text_shadow_color(..)`、`.text_shadow_offset(..)`、`.text_shadow_radius(..)` |
| `fontVariant` | OpenType 特性：`["tabular-nums"]`、`"small-caps"`、`"oldstyle-nums"`、`"lining-nums"`、`"proportional-nums"` | `.tabular_nums()`、`.small_caps()`、`.oldstyle_nums()`、`.lining_nums()`、`.proportional_nums()` |
| `writingDirection` | `"auto"`、`"ltr"`、`"rtl"`：段落的基础方向 | `.writing_direction(WritingDirection::Rtl)` |

文本元素同时也是视图：它支持背景、边框、圆角、内边距以及其他[视图样式](./styling.md)。

```rust tabs
text(move || format!("{:.2}", price.get())).text_size(px(18.0)).tabular_nums()
text("Typo").underline().text_decoration_wavy().text_decoration_color(rgb(0xcf222e))
text("Shadow")
    .text_size(px(26.0))
    .font_weight(FontWeight::EXTRA_BOLD)
    .text_color(white())
    .text_shadow_color(rgba(0x00000099))
    .text_shadow_offset(point(px(2.0), px(2.0)))
    .text_shadow_radius(px(4.0))
```

```tsx tabs
<Text style={{ fontSize: 18, fontVariant: ["tabular-nums"] }}>{price().toFixed(2)}</Text>
<Text style={{ textDecorationLine: "underline", textDecorationStyle: "wavy", textDecorationColor: "#cf222e" }}>Typo</Text>
<Text style={{ fontSize: 26, fontWeight: "800", color: "#ffffff", textShadowColor: "rgba(0,0,0,0.6)", textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 4 }}>
  Shadow
</Text>
```

`tabular-nums` 让所有数字等宽，计数器和价格变化时就不会左右跳动。

## 截断

```rust tabs
text(long_description).number_of_lines(2)
text(file_path).number_of_lines(1).ellipsize_mode(EllipsizeMode::Middle)
```

```tsx tabs
<Text numberOfLines={2}>{longDescription}</Text>
<Text numberOfLines={1} ellipsizeMode="middle">{filePath}</Text>
```

| 属性 | Rust | 说明 |
|---|---|---|
| `numberOfLines` | `.number_of_lines(n)` | 最多显示的行数；`0`（默认）表示不限 |
| `ellipsizeMode` | `.ellipsize_mode(EllipsizeMode::Tail)` | 放不下时在哪里截断：`"tail"`（默认）、`"head"`、`"middle"`、`"clip"` |
| `adjustsFontSizeToFit` | `.shrink_to_fit(min_scale)` | 缩小字号，直到文字能放进其行数和框内 |
| `minimumFontScale` | | `adjustsFontSizeToFit` 最多能缩小到的比例（0–1） |

```rust tabs
text(move || total.get())
    .number_of_lines(1)
    .shrink_to_fit(0.5)
    .text_size(px(48.0))
    .w(px(200.0))
```

```tsx tabs
<Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={{ fontSize: 48, width: 200 }}>
  {total()}
</Text>
```

Tailwind 类 `truncate` 和 `line-clamp-*` 效果相同；同时设置时以属性为准。

## 系统字号

文字默认跟随用户的字号设置（iOS 上的“动态字体”，Android 上的字体大小）。

| 属性 | Rust | 说明 |
|---|---|---|
| `allowFontScaling` | `.allow_font_scaling(false)` | 设为 `false` 时字号固定。默认 `true` |
| `maxFontSizeMultiplier` | `.max_font_size_multiplier(1.5)` | 允许的最大缩放比例，例如 `1.5`。`0` 表示不限 |

Rust 中的 `font_scale()` 和 TSX 中 [`nsh` 的设备 API](../modules/nsh.md#device) 的 `fontScale()` 是当前的缩放比例，会在用户修改设置时变化。输入框同样支持 `allowFontScaling` 和 `maxFontSizeMultiplier`。

```rust tabs
text("Tab label").max_font_size_multiplier(1.3).text_size(px(13.0))
```

```tsx tabs
<Text maxFontSizeMultiplier={1.3} style={{ fontSize: 13 }}>Tab label</Text>
```

与其关闭缩放，不如限制缩放比例：大字号是很多人依赖的辅助功能设置。

## 选择

`selectable`（`.selectable(true)`）允许用户像在系统自带的文本视图中那样选择和复制文字：长按选中手指下的词，拖动选择柄移动选区两端，编辑菜单提供“拷贝”和“全选”（iOS 还有查询、翻译和共享；Android 还有分享）。选区只在一个文本块之内。样式键 `selectionColor`（`.selection_color(..)`、`selection:text-*`）设置高亮和选择柄的颜色。类 `select-text` 与 `selectable` 效果相同。

在桌面浏览器中，文字默认可以选择，和网页一样，但交互元素（带按压或触摸处理的视图，如按钮和可按压的列表行）里的文字除外；`selectable={false}`（`.selectable(false)`）或类 `select-none` 让文字在那里也不可选择。手机和平板浏览器遵循原生规则。

```rust tabs
text(order_number).selectable(true).selection_color(rgb(0x7c3aed))
```

```tsx tabs
<Text selectable style={{ selectionColor: "#7c3aed" }}>{orderNumber}</Text>
```

要在代码中复制（比如“复制”按钮），在 Rust 中使用 `set_clipboard(..)`，在 TSX 中使用 [`Clipboard`](../modules/nsh.md#clipboard)。

## onTextLayout

`onTextLayout`（Rust 中的 `TextLayout` 事件）在每次布局后报告排好的各行，坐标位于文字的内容框中：

```rust tabs
text(move || body.get()).on(EventKind::TextLayout, move |e: &EventPayload| {
    if let EventPayload::TextLayout(laid_out) = e {
        lines.set(laid_out.len());
    }
})
```

```tsx tabs
<Text
  onTextLayout={(e) => {
    lines.set(e.lines.length);
    console.log(e.lines.map((l) => `${l.text} (${l.bounds.size.width.toFixed(0)}pt)`));
  }}
>
  {body()}
</Text>
```

每一行包含 `text`、`x`、`y`、`width`、`height`、`ascender`、`descender`、`capHeight` 和 `xHeight`（Rust 中为 `cap_height` 和 `x_height`）。可以用它在文字被截断时才显示“阅读更多”按钮，或让其他内容与基线对齐。

## 无障碍

屏幕阅读器会朗读文本元素的内容。为充当标题的文字设置角色（`.role(AccessibilityRole::Header)`、`role="header"`），为链接设置链接角色（`AccessibilityRole::Link`、`role="link"`）。参见[无障碍](./accessibility.md)。

## 相关内容

- [字体](./fonts.md)：自定义字体与字重。
- [text 元素](../elements/text.md)：所有属性。
- [表单与键盘](./forms-and-keyboard.md)：文字输入。
