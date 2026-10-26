---
title: Text
description: Showing text with the text element in Rust and TSX - nested spans and links, inline views, fonts and decorations, truncation, system text size, selection and onTextLayout.
order: 35
group: ui
---

# Text

All text is shown by text elements: `text(..)` in Rust, `<Text>` in TSX. A text element is one paragraph, typeset by the platform's text engine (CoreText on Apple platforms, `StaticLayout` on Android) on the engine thread when it is laid out, and only drawn on the main thread. Nested text elements are spans of the same paragraph, not separate views.

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
> Strings are displayed by text elements. In TSX, a string placed directly in a `<View>` is not shown: wrap it in `<Text>`.

The element itself is documented on [text](../elements/text.md); this page is about using it.

## Strings and whitespace

In Rust, a text's content is a string, shown as written: `\n` breaks the line. Content that reads signals is a closure, and the text updates when they change. In TSX, JSX text follows the same rules as in React: each line is trimmed, lines that are only whitespace are dropped, and the remaining lines are joined with a single space. Whitespace within one line is kept, so `{first} {last}` keeps its space. Use `{" "}` for a space at the start or end of a line, and `{"\n"}` for a line break:

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

Expressions in text follow what they read: `text(move || format!("{} items", count.get()))` and `<Text>{count()} items</Text>` update when `count` changes.

## Spans and inheritance

A text inside a text is a span. It inherits the text style of its parent and overrides what it sets:

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

Text styles also pass down from views, as in CSS: `view().text_color(white()).text_sm()` in Rust and `<View class="text-white text-sm">` in TSX style the text and input elements inside them.

### Links

A span with a press handler (`.on_press(..)` or `.on_long_press(..)`; `onPress` or `onLongPress`) is a link: a press on its characters goes to the span, a press elsewhere to the paragraph. Links in nested spans work too.

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

### Backgrounds of spans

A span's background color and corner radius paint a box behind its characters on each line it reaches, as tall as
its font; the text lays out the same and copies whole, so inline code is a span
([Text element](../elements/text.md#span-backgrounds)):

```rust tabs
text("Run ")
    .child(text(" npm test ").font_family("ui-monospace").bg(rgb(0xeff1f3)).rounded(px(4.0)))
    .child(" first.")
```

```tsx tabs
<Text>
  Run <Text style={{ fontFamily: "ui-monospace", backgroundColor: "#eff1f3", borderRadius: 4 }}> npm test </Text> first.
</Text>
```

### Views and images inside text

Any element other than a text inside a text is laid out inline, on the baseline, and wraps with the words. It can take presses of its own:

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

Inline elements cut off by `numberOfLines` or an ellipsis are hidden; copying the text leaves them out.

The style key `verticalAlign` places an inline element in its line, as CSS's `vertical-align` places an image:
`"baseline"` (the default) stands its bottom on the baseline, `"text-top"` and `"text-bottom"` put its top or bottom
at the top or bottom of the text's font, and `"middle"` centers it half the font's x height above the baseline. The
line grows to hold the element wherever it reaches past the font. An icon at the start of a paragraph that should
line up with the text's bottom, as Android's `ImageSpan` draws it, takes `"text-bottom"`. The classes are
`align-baseline`, `align-text-top`, `align-text-bottom` and `align-middle`; in Rust `.align_text_bottom()` and the
others of the same names.

```tsx
<Text style={{ fontSize: 16 }}>
  <Image src={badge} style={{ width: 16, height: 16, verticalAlign: "text-bottom" }} /> Verified seller
</Text>
```

## Text styles

| Property | Values | Rust |
|---|---|---|
| `color` | A [color](./styling.md#colors). Default black | `.text_color(..)` |
| `fontSize` | Points. Default 14 | `.text_size(px(..))`, `.text_sm()`, `.text_lg()`, ... |
| `fontWeight` | `"normal"` (400), `"bold"` (700), or `100`–`900` (number or string) | `.font_weight(FontWeight::BOLD)` |
| `fontStyle` | `"normal"`, `"italic"` | `.italic()` |
| `fontFamily` | A system family, a generic family, or an [imported font](./fonts.md) | `.font_family(..)` |
| `lineHeight` | Points | `.line_height(px(..))` |
| `letterSpacing` | Points | `.letter_spacing(px(..))` |
| `textAlign` | `"auto"`, `"left"`, `"center"`, `"right"`, `"justify"` | `.text_left()`, `.text_center()`, `.text_right()`, `.text_justify()` |
| `textAlignVertical` | `"auto"`, `"top"`, `"center"`, `"bottom"`: where text shorter than its box sits | |
| `textTransform` | `"none"`, `"uppercase"`, `"lowercase"`, `"capitalize"` | `.normal_case()`, `.uppercase()`, `.lowercase()`, `.capitalize()` |
| `textDecorationLine` | `"none"`, `"underline"`, `"line-through"`, `"underline line-through"` | `.no_underline()`, `.underline()`, `.line_through()` |
| `textDecorationColor`, `textDecorationStyle` | Color; `"solid"`, `"double"`, `"dotted"`, `"dashed"`, `"wavy"` | `.text_decoration_color(..)`, `.text_decoration_wavy()`, ... |
| `textDecorationThickness`, `textUnderlineOffset` | Points, or `"auto"` (thickness also `"from-font"`) | `.text_decoration_thickness(px(..))`, `.underline_offset(px(..))` |
| `textShadowColor`, `textShadowOffset`, `textShadowRadius` | A shadow behind the glyphs | `.text_shadow_color(..)`, `.text_shadow_offset(..)`, `.text_shadow_radius(..)` |
| `fontVariant` | OpenType features: `["tabular-nums"]`, `"small-caps"`, `"oldstyle-nums"`, `"lining-nums"`, `"proportional-nums"` | `.tabular_nums()`, `.small_caps()`, `.oldstyle_nums()`, `.lining_nums()`, `.proportional_nums()` |
| `writingDirection` | `"auto"`, `"ltr"`, `"rtl"`: the base direction of the paragraph | `.writing_direction(WritingDirection::Rtl)` |

A text element is also a view: it takes backgrounds, borders, corners, padding and the other [view styles](./styling.md).

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

`tabular-nums` gives every digit the same width, which keeps counters and prices from jittering as they change.

## Truncation

```rust tabs
text(long_description).number_of_lines(2)
text(file_path).number_of_lines(1).ellipsize_mode(EllipsizeMode::Middle)
```

```tsx tabs
<Text numberOfLines={2}>{longDescription}</Text>
<Text numberOfLines={1} ellipsizeMode="middle">{filePath}</Text>
```

| Prop | Rust | Description |
|---|---|---|
| `numberOfLines` | `.number_of_lines(n)` | The most lines shown; `0` (default) is unlimited |
| `ellipsizeMode` | `.ellipsize_mode(EllipsizeMode::Tail)` | Where text that does not fit is cut: `"tail"` (default), `"head"`, `"middle"`, `"clip"` |
| `adjustsFontSizeToFit` | `.shrink_to_fit(min_scale)` | Shrink the font until the text fits its lines and box |
| `minimumFontScale` | | How far `adjustsFontSizeToFit` may shrink (0–1) |

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

The Tailwind classes `truncate` and `line-clamp-*` do the same and lose to the props when both are set.

## System text size

Text follows the user's text size setting (Dynamic Type on iOS, font size on Android) by default.

| Prop | Rust | Description |
|---|---|---|
| `allowFontScaling` | `.allow_font_scaling(false)` | `false` keeps the size fixed. Default `true` |
| `maxFontSizeMultiplier` | `.max_font_size_multiplier(1.5)` | The largest scale applied, e.g. `1.5`. `0` is no limit |

`font_scale()` in Rust and `fontScale()` from [`nsh`](../modules/nsh.md#device) in TSX are the current scale, and change when the user changes the setting. Inputs take `allowFontScaling` and `maxFontSizeMultiplier` too.

```rust tabs
text("Tab label").max_font_size_multiplier(1.3).text_size(px(13.0))
```

```tsx tabs
<Text maxFontSizeMultiplier={1.3} style={{ fontSize: 13 }}>Tab label</Text>
```

Prefer limiting the scale over turning it off: large text is an accessibility setting people rely on.

## Selection

`selectable` (`.selectable(true)`) lets the user select and copy the text, as in the system's own text views: a long press selects the word under the finger, the handles move the selection's ends, and the edit menu offers Copy and Select All (iOS adds Look Up, Translate and Share; Android Share). A selection stays inside one text block. The style key `selectionColor` (`.selection_color(..)`, `selection:text-*`) colors the highlight and the handles. The class `select-text` does the same as `selectable`.

In desktop browsers text is selectable by default, as on a web page, except inside interactive elements (views with press or touch handlers, such as buttons and pressable rows); `selectable={false}` (`.selectable(false)`) or the class `select-none` keeps a text unselectable there. Phone and tablet browsers follow the native rule.

```rust tabs
text(order_number).selectable(true).selection_color(rgb(0x7c3aed))
```

```tsx tabs
<Text selectable style={{ selectionColor: "#7c3aed" }}>{orderNumber}</Text>
```

To copy from code (a Copy button), use `set_clipboard(..)` in Rust or [`Clipboard`](../modules/nsh.md#clipboard) in TSX.

## onTextLayout

`onTextLayout` (the `TextLayout` event in Rust) reports the laid-out lines after each layout, in the text's content box:

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

Each line has `text`, `x`, `y`, `width`, `height`, `ascender`, `descender`, `capHeight` and `xHeight` (`cap_height` and `x_height` in Rust). Use it to show a "Read more" button only when text was cut, or to align other content with a baseline.

## Accessibility

A text element is read by screen readers as its content. Give a role to text that acts as a heading (`.role(AccessibilityRole::Header)`, `role="header"`) and to links (`AccessibilityRole::Link`, `role="link"`). See [Accessibility](./accessibility.md).

## Related

- [Fonts](./fonts.md): custom fonts and weights.
- [text element](../elements/text.md): every prop.
- [Forms and keyboard](./forms-and-keyboard.md): text input.
