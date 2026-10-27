---
title: Safe area
description: "The safe-area-inset environment variables and the safeArea and safeAreaInsets accessors: content kept clear of the notch, the status bar, the home indicator and headers."
order: 10.6
group: primitives
demo: el-safe-area
---

# Safe area

The safe area keeps content clear of the notch or Dynamic Island, the status bar, the home indicator, a navigation
header and the Mac Catalyst title bar. Any view pads itself by it with CSS's `env()`:
`env(safe-area-inset-top)`, `env(safe-area-inset-right)`, `env(safe-area-inset-bottom)` and
`env(safe-area-inset-left)`, in its padding or margin. They are the insets of the root view the node renders in:
inside a [NavPage](./nav-stack.md) the insets below the page's header, inside a [Dialog](./dialog.md) the dialog's
insets, and elsewhere the surface's safe area. In a browser the page is the root, and the variables are the browser's
own.

```rust tabs
use nsh_core::prelude::*;

fn app() -> impl IntoElement {
    view()
        .flex_1()
        .bg(rgb(0xfff8c5))
        .p_safe_area()
        .child(text("Clear of the notch").text_2xl().font_weight(FontWeight::BOLD))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";

function App() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#fff8c5",
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Clear of the notch</Text>
    </View>
  );
}

mount(App);
```

The background color fills the whole area, including the area behind the status bar, and the content starts below
it. The values follow the insets: on rotation, in another page or dialog, the padding updates natively.

## Values

| Value | Example | Means |
|---|---|---|
| `env(name)` | `paddingTop: "env(safe-area-inset-top)"` | The inset. |
| `env(name, <length>)` | `env(safe-area-inset-top, 20px)` | The inset; the length stands in for an unknown name, as in CSS. |
| `calc(env(name) + <length>)` | `calc(env(safe-area-inset-bottom) + 16px)` | The inset plus a length, for content that keeps its own spacing. |
| `calc(<length> + env(name))` | `calc(16px + env(safe-area-inset-left))` | The same. |

They apply to `padding`, `paddingHorizontal`, `paddingVertical`, `paddingTop`, `paddingRight`, `paddingBottom`,
`paddingLeft` and the same `margin` keys. In Tailwind they are arbitrary values of `p`, `px`, `py`, `pt`, `pr`, `pb`,
`pl` and the `m` utilities (spaces may be left out): `pt-[env(safe-area-inset-top)]`,
`pb-[calc(env(safe-area-inset-bottom)+16px)]`. The TypeScript type of these values is `EnvValue`. See
[the style reference](../modules/style-reference.md).

In Rust the `Styled` methods set them: `.p_safe_area()`, `.px_safe_area()`, `.py_safe_area()`, `.pt_safe_area()`,
`.pr_safe_area()`, `.pb_safe_area()`, `.pl_safe_area()`, the same `m` methods, and `.pt_safe_area_plus(px(16.0))`
(and `pr`, `pb`, `pl`, `mt`, `mr`, `mb`, `ml`) for an inset plus a length.

## Choosing the edges

Pad only the edges that need it, for example when a tab bar or a bottom bar of your own handles the bottom inset:

```rust tabs
view()
    .flex_1()
    .pt_safe_area()
    .px_safe_area()
```

```tsx tabs
<View class="flex-1 pt-[env(safe-area-inset-top)] px-[calc(env(safe-area-inset-left)+16px)]">
  …
</View>
```

## Where to use it

A [NavPage](./nav-stack.md) with a visible, opaque header already places its content below the header, so the top
inset there is 0. The safe area insets are for:

- the root of an app without a navigation stack,
- a page with `headerVisible={false}` or `headerTransparent`,
- the content of a full-screen [Dialog](./dialog.md),
- bars of your own at the edges of the screen.

## safeArea and safeAreaInsets

When you need the numbers in code, read them directly. Both TSX accessors come from `nsh`, return an `Edges` object
(`{ top, right, bottom, left }` in points) and are reactive: code that reads them runs again when they change, for
example on rotation.

| TSX | Rust | Returns |
|---|---|---|
| `safeArea()` | `safe_area()` | The surface's safe area: the parts clear of system UI (notch, home indicator, title bar). |
| `safeAreaInsets()` | `cx.insets()` | The insets where the component renders: the nearest page's (below its header), the nearest dialog's, or else the surface's safe area. These are the values of the `safe-area-inset-*` variables. In TSX, call it in a component; it returns an accessor. A Rust component of your crate reads them with `cx.insets()`. |

```rust tabs
use nsh_core::prelude::*;

fn bottom_bar() -> impl IntoElement {
    view()
        .flex_row()
        .p_2()
        .pb(move || if safe_area().bottom > Points::ZERO { px(4.0) } else { px(8.0) })
        .child(text("Bottom bar"))
}
```

```tsx tabs
import { Text, View, safeArea } from "nsh";

function BottomBar() {
  const insets = safeArea();
  return (
    <View style={{ flexDirection: "row", padding: 8, paddingBottom: insets().bottom > 0 ? 4 : 8 }}>
      <Text>Bottom bar</Text>
    </View>
  );
}
```

For padding by the inset itself, `env()` is the simpler form: it updates natively, without running code.

## Platform notes

- **iOS**: the insets come from UIKit's safe area: the status bar, the notch or Dynamic Island, and the home
  indicator.
- **Android**: NSH reports the parts of the system bars and the display cutout that overlap the NSH view. When NSH is
  [embedded](../docs/android.md) below a native toolbar, the view's top inset is 0.
- **Mac Catalyst**: the top inset is the window's title bar.
- **Desktops (macOS, Windows, Linux, GPUI) and the web**: a page's content starts below its `header`, and a dialog
  gives its content insets of its own, as on the phones.

## Related

- [Keyboard](./keyboard.md): `env(keyboard-inset-height)`, content kept above the software keyboard.
- [Device and environment](../docs/device-and-environment.md): the safe area among the device's other values.
