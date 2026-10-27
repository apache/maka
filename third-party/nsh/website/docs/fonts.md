---
title: Fonts
description: The system font and generic families, shipping .ttf and .otf files from a Rust crate's assets or TSX imports, families with several weights and italics, and fonts in typed styles and Tailwind classes.
order: 37
group: ui
---

# Fonts

Text uses the system font (San Francisco on iOS, Roboto on Android) unless a font family says otherwise (`.font_family(..)` in Rust, `fontFamily` in TSX). A family can be a generic family, a font installed on the device, or a font file you ship with the app.

## System and generic families

| `fontFamily` | Font |
|---|---|
| (none), `"system-ui"`, `"sans-serif"`, `"ui-sans-serif"`, `"-apple-system"` | The system font |
| `"serif"`, `"ui-serif"` | The system serif (New York on iOS, Noto Serif on Android) |
| `"monospace"`, `"ui-monospace"` | The system monospace font (SF Mono on iOS) |
| `"ui-rounded"` | The rounded system font (SF Pro Rounded), iOS only |

The system font honors every weight from 100 to 900. Tailwind's `font-sans`, `font-serif` and `font-mono` map to the first three rows, and `font-sans` and `font-mono` to the theme's fonts when it sets them ([A default font for the app](#a-default-font-for-the-app)).

A family installed on the device can be named directly (`"Georgia"`, `"Avenir Next"` on iOS). Installed fonts differ between platforms and versions, so ship the fonts your design depends on. On iOS, a family that does not exist falls back to the system font with a warning in the log (`font family 'X' is not available`).

## Shipping a font

A Rust crate ships the files of its `assets/` directory: `registry.assets(assets!())` in its `#[native_module]` function ships them all, and `asset!("fonts/Pacifico-Regular.ttf")` is a `FontAsset` whose `family` is the font's family name, read from the file when the crate compiles. In TSX, import a `.ttf` or `.otf` file: the import evaluates to the font's family name. Either way the font is registered before the first frame, so it is ready when text first renders:

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

`PACIFICO.family` and the TSX import `Pacifico` are the string `"Pacifico"`: the family name stored in the font file (its typographic family name, or else its family name), not the file name. Using the asset's value instead of writing the name by hand keeps the two in sync; a missing or broken file fails the Rust build, and an imported file is sure to be bundled.

The files ship with the app like any other [asset](./images-and-assets.md). Fonts are registered for the app's process only; they are not installed on the device.

> [!WARNING]
> In TSX, an import whose value is never used is removed by TypeScript's import elision, and with it the font. If you only refer to a family by its name (for example in the Tailwind theme), import the file for its side effect: `import "./fonts/Inter-Bold.ttf";`. A Rust crate ships every file of `assets/` through `assets!()`.

## Weights and italics

A family usually comes as several files, one per weight and style. Ship each one (put them in `assets/` in Rust, import each in TSX); they register under the same family name, and the weight and style choose the face:

```rust tabs
// assets/fonts: Inter-Regular.ttf, Inter-Medium.ttf, Inter-Bold.ttf, Inter-Italic.ttf
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

When no registered face has the exact weight asked for, the nearest one is used. The platforms differ when a face is missing:

| | iOS | Android |
|---|---|---|
| Weight without a face | The nearest registered face | The nearest face, with Android's synthetic bold where it applies |
| Italic without an italic face | The upright face (no slanting) | A slanted version of the upright face |

Ship the faces you use to get the same result on both.

## Fonts in typed styles and Tailwind classes

In Rust, `.font_family(..)` takes the asset's family wherever a style goes, and the weight methods (`.font_weight(FontWeight::SEMIBOLD)`) select faces. For classes, name your families in the Tailwind theme in `nsh.json` to use them as `font-*` classes:

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

An arbitrary family works without a theme entry: `font-[Pacifico]`. Weight classes (`font-light`, `font-semibold`, `font-bold`, ...) select faces as `fontWeight` does. Text styles on a view pass down to the texts inside it, so `.font_family(INTER.family)` on a view, or `<View class="font-body">`, sets the family for a whole screen.

## A default font for the app

The theme's `font-sans` is the app's font: every text that sets no family of its own is drawn with it, in Rust components and TSX alike, as a web page is with Tailwind's `--font-sans`. `font-mono` is the monospaced font, of the `font-mono` class and of code in `TextView`. Set them in the app's theme (`"theme"` in `nsh.json`, [Rust](./rust.md#theme)) and ship the font files as above:

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

The first family of the list that is not a generic one is the font; a generic first family (`system-ui`, `sans-serif`) is the system font. The font can also be set on a container: the texts inside inherit it.

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

## Font features

`fontVariant` turns on OpenType features of the font: `"tabular-nums"`, `"proportional-nums"`, `"lining-nums"`, `"oldstyle-nums"` and `"small-caps"` (`.tabular_nums()`, `.small_caps()`, ... in Rust; [Text](./text.md#text-styles)). The font has to contain them; system fonts do.

## Related

- [Text](./text.md): text styles, sizes and the system text size setting.
- [Tailwind](./tailwind.md#theme): the theme keys.
- [Images and assets](./images-and-assets.md): how the app's files are shipped.
