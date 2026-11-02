---
title: Text
description: "The element that draws text: nested spans, links, line limits, font scaling, inline views and text layout events."
order: 20
group: primitives
demo: el-text
---

# Text

`Text` draws a paragraph. It is the element that shows strings: a string child of a `View` draws nothing. The
paragraph is typeset natively (CoreText on iOS and Mac Catalyst, `StaticLayout` on Android) and measured on the engine
thread, so the main thread only draws it. Rust makes one with `text(content)`, TSX with `<Text>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

text("Read the ")
    .text_base()
    .line_height(px(24.0))
    .text_color(rgb(0x1f2328))
    .child(text("terms").font_weight(FontWeight::BOLD))
    .child(" before you continue.")
```

```tsx tabs
<Text style={{ fontSize: 16, lineHeight: 24, color: "#1f2328" }}>
  Read the <Text style={{ fontWeight: "700" }}>terms</Text> before you continue.
</Text>
```

`text(..)` takes a string, a `SharedString`, a signal or a closure (`text(move || format!("{} items", count.get()))`):
a closure or a signal updates the text in place when what it reads changes.

## Spans

A text inside a text is a span of the same paragraph, not a separate view. Spans inherit the text styles of the
paragraph (`color`, `fontSize`, `fontWeight`, …) and override what they set. The whole block is one native view. In
Rust, `text(..)` shows its content and then its children: `.child(text(..))` adds a span, `.child("…")` a plain run.

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

### Span backgrounds

A span with a background fills the box of its characters, behind them: as tall as its font (the ascent above the
baseline and the descent below it, whatever the line height), and on every line it wraps to, each line's part a box of
its own with the span's corner radius. Spans inside it share its background unless they set their own. It is drawing
only: the text lays out as without it, and a selectable text copies the span's characters with the rest. Inline code
is a span:

```rust tabs
text("Run ")
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
    .child(" before you commit.")
```

```tsx tabs
<Text style={{ userSelect: "text", fontSize: 15, lineHeight: 22 }}>
  {"Run "}
  <Text style={{ fontFamily: "ui-monospace", fontSize: 13, backgroundColor: "#eff1f3", borderRadius: 4 }}>
    {" cargo test "}
  </Text>
  {" before you commit."}
</Text>
```

The Tailwind classes work the same way: `<Text class="bg-gray-100 rounded">`. Padding and borders are box styles and
leave spans as they are; spaces inside the span give the box room on its sides.

### Links

A span with a press handler is a link: a press on its characters goes to the span, a press elsewhere to the paragraph.

```rust tabs
text("By continuing you agree to the ")
    .text_size(px(15.0))
    .on_press(move || log("the sentence"))
    .child(
        text("Terms of service")
            .text_color(rgb(0x0969da))
            .underline()
            .on_press(move || open("terms")),
    )
    .child(".")
```

```tsx tabs
<Text style={{ fontSize: 15 }} onPress={() => log("the sentence")}>
  {"By continuing you agree to the "}
  <Text style={{ color: "#0969da", textDecorationLine: "underline" }} onPress={() => open("terms")}>
    Terms of service
  </Text>
  .
</Text>
```

### Inline views and images

Any other element inside a text (a view, an image, even inside spans) is an inline attachment: it is laid out at its
own size, sits on the baseline (or where its `verticalAlign` style puts it: `"text-top"`, `"text-bottom"`,
`"middle"`, as in CSS; the line grows to hold it) and wraps with the words. It takes presses of its own.

```rust tabs
text("Made with ")
    .text_base()
    .line_height(px(26.0))
    .child(image(LOGO).size(px(18.0)).rounded(px(4.0)))
    .child(" NSH. Status ")
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
  {"Made with "}
  <Image src={logo} style={{ width: 18, height: 18, borderRadius: 4 }} />
  {" NSH. Status "}
  <View style={{ backgroundColor: "#1a7f37", borderRadius: 9, paddingHorizontal: 7, height: 18, justifyContent: "center" }}>
    <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "700" }}>LIVE</Text>
  </View>
</Text>
```

Attachments cut off by `numberOfLines` or an ellipsis are hidden. Copying a selectable text leaves them out.

### Whitespace

JSX text follows React's rules: lines are trimmed except at the text's ends, whitespace-only lines are dropped and the
remaining lines are joined with one space. Spaces on one line are kept (`{a} {b}` keeps its space). Write
`{" "}` or a string expression when a span needs a leading or trailing space. Rust strings are drawn as written.

## Props

Besides the [common props](./index.md#common-props) (with `style` typed as `TextStyle`):

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `numberOfLines` (style) | `.number_of_lines(n)`, `.truncate()` | `number` | `0` | The most lines shown; `0` shows them all. |
| `textOverflow` (style) | `.text_overflow(EllipsizeMode::Middle)` | `"ellipsis" \| "clip" \| "ellipsis-start" \| "ellipsis-middle"` | `"ellipsis"` | How text that does not fit `numberOfLines` is cut: an ellipsis at its end, at its start or in its middle, or clipped. |
| `allowFontScaling` | `.allow_font_scaling(..)` | `boolean` | `true` | Follow the system text size setting. |
| `maxFontSizeMultiplier` | `.max_font_size_multiplier(..)` | `number` | `0` | The upper bound of the system scale; `0` is none. |
| `adjustsFontSizeToFit` | `.shrink_to_fit(min_scale)` | `boolean` | `false` | Shrink the font until the text fits its lines (`numberOfLines`) and its box. |
| `minimumFontScale` | `.shrink_to_fit(min_scale)` | `number` | | How far `adjustsFontSizeToFit` shrinks at most (0..1; at least 0.1). |
| `userSelect` (style) | `.select_text()`, `.select_none()` | `"auto" \| "none" \| "text"` | `"auto"` | `"text"`: the user can select ranges of the text: a long press selects a word, handles extend it, the edit menu copies it. `"auto"` takes the setting of the views around the text; with none set, text is not selectable, except in desktop browsers, where it is unless it is inside an interactive element; `"none"` keeps it unselectable there too. |
| `selectionColor` (style) | `.selection_color(..)` | `ColorValue` | the platform's accent | The selection's highlight and handles. |
| `onTextLayout` | | `(e: { lines: TextLayoutLine[] }) => void` | | The laid-out lines after each layout. |

The Tailwind classes `select-text`, `select-none` and `select-auto` set `userSelect`, `line-clamp-*` sets `numberOfLines`, `text-ellipsis` and `text-clip` set `textOverflow`, and `truncate` is one line cut with an ellipsis. The selection's highlight and handles take the style key
`selectionColor` (`selection:text-*`), the platform's accent by default.

## Text styles

`TextStyle` adds to the view styles: `color`, `fontSize`, `fontWeight` (`"normal"`, `"bold"` or 100–900), `fontStyle`,
`fontFamily`, `lineHeight`, `letterSpacing`, `textAlign`, `textAlignVertical`, `textTransform`, `textDecorationLine`,
`textDecorationColor`, `textDecorationStyle`, `textDecorationThickness`, `textUnderlineOffset`, `textShadow` (CSS's
`text-shadow`), `fontVariant`, `writingDirection`, `numberOfLines` and `textOverflow`. In Rust they are `Styled` methods:
`.text_color(..)`, `.text_size(..)` (or `.text_sm()`, `.text_lg()`, …), `.font_weight(FontWeight::SEMIBOLD)`,
`.italic()`, `.font_family(..)`, `.line_height(..)`, `.letter_spacing(..)`, `.text_center()`, `.uppercase()`,
`.underline()`, `.line_through()`, `.tabular_nums()`, `.number_of_lines(..)` and the rest. See the
[style reference](../modules/style-reference.md#textstyle) and [text](../docs/text.md).

The font family is a system family or a font file of the app:

```rust tabs
// assets/fonts/Inter-Regular.ttf, shipped by the registry (`registry.assets(assets!())`).
const INTER: FontAsset = asset!("fonts/Inter-Regular.ttf");

text("Inter").font_family(INTER.family).text_size(px(17.0))
```

```tsx tabs
import { Text } from "nsh";
import Inter from "./fonts/Inter-Regular.ttf";

<Text style={{ fontFamily: Inter, fontSize: 17 }}>Inter</Text>;
```

The font is registered before the first frame. See [fonts](../docs/fonts.md).

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onTextLayout` | | `{ lines: TextLayoutLine[] }` | After each layout of the paragraph. |
| `onPress`, `onLongPress`, … | `.on_press`, `.on_long_press`, … | `PressEvent` (none in Rust) | As on [view](./view.md#events); on a span, presses on its characters. |
| `onLayout` | `.on_layout` | `{ bounds }` | The block's frame changed. |

`TextLayoutLine` is `{ text, x, y, width, height, ascender, descender, capHeight, xHeight }`, in the text's content box:

```tsx
const lines = signal(0);
<Text onTextLayout={(e) => lines.set(e.lines.length)}>{article}</Text>;
```

Rust measures a string before it lays out with `measure_text(..)`.

## Ref methods

None of its own.

## Platform notes

- Selection stays inside one text block (one text and its spans). iOS shows its edit menu (Copy, Select All, Look Up,
  Translate, Share), Android a floating toolbar (Copy, Select all, Share).
- Text decorations other than a solid single line (`double`, `dotted`, `dashed`, `wavy`) are drawn by NSH on iOS.
- iOS texts draw solid backgrounds and outer shadows.
- `fontScale()` from [`nsh`](../modules/nsh.md#device) (`font_scale()` in Rust) reports the current system text
  scale.
