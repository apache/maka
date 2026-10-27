---
title: Keyboard
description: "The keyboard-inset-height environment variable, Keyboard.dismiss and the keyboard's height: content kept above the software keyboard, moving with it."
order: 10.7
group: primitives
demo: el-keyboard
---

# Keyboard

`env(keyboard-inset-height)` is the software keyboard's height over the surface, 0 while it is hidden. As a view's
bottom padding or margin it keeps the content above the keyboard: when the keyboard shows or hides, the view makes room
by its height, and the change animates with the keyboard natively. Use it for content outside scroll views, such as a
message bar at the bottom of a chat screen; inputs inside a [scroll view](./scroll.md) or a [List](./list.md) are
scrolled into view natively. With it come `Keyboard.dismiss()`, which hides the keyboard, and the keyboard's height,
for layouts of your own.

```rust tabs
use nsh_core::prelude::*;

fn chat() -> impl IntoElement {
    let draft = signal(String::new());
    view()
        .flex_1()
        .bg(white())
        .pb_keyboard()
        .child(scroll().flex_1().child(text("Messages…").p_4()))
        .child(
            view()
                .flex_row()
                .gap_2()
                .p_2()
                .border_t_1()
                .border_color(rgb(0xe5e5e5))
                .child(
                    input()
                        .value(draft)
                        .on_change(move |v: &str| draft.set(v.to_owned()))
                        .placeholder("Message")
                        .flex_1()
                        .p_2(),
                ),
        )
}
```

```tsx tabs
import { mount, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const draft = signal("");
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", paddingBottom: "env(keyboard-inset-height)" }}>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
        <Text style={{ padding: 16, paddingTop: 48 }}>Messages…</Text>
      </Scroll>
      <View style={{ flexDirection: "row", gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: "#e5e5e5" }}>
        <Input
          value={draft()}
          onChange={(v) => draft.set(v)}
          placeholder="Message"
          style={{ flex: 1, fontSize: 16, padding: 8 }}
        />
      </View>
    </View>
  );
}

mount(App);
```

The full keyboard height suits a view that reaches the bottom of the screen, as a screen's content does. When
something is below it, such as a tab bar, subtract that with a length: `calc(env(keyboard-inset-height) + -49px)`
keeps a view above a 49 pt tab bar, and `calc(env(keyboard-inset-height) + 12px)` adds spacing above the keyboard. A
padding is at least 0.

## Padding or margin

| Style | How it makes room |
|---|---|
| `paddingBottom: "env(keyboard-inset-height)"` (Tailwind `pb-[env(keyboard-inset-height)]`, Rust `.pb_keyboard()`) | The content above shrinks; the background still reaches the bottom of the screen. |
| `marginBottom: "env(keyboard-inset-height)"` (Tailwind `mb-[env(keyboard-inset-height)]`, Rust `.mb_keyboard()`) | The whole view, including its background, ends at the top of the keyboard. |

The keyboard's height is added to the length in the same declaration only, so a view combines it with spacing of its
own in `calc()`. In Rust, `.pb_keyboard_plus(px(..))` and `.mb_keyboard_plus(px(..))` add a length.

```rust tabs
use nsh_core::prelude::*;

fn sign_in() -> impl IntoElement {
    view()
        .mb_keyboard_plus(px(-49.0))
        .flex_1()
        .p_4()
        .gap_3()
        .child(input().placeholder("E-mail").keyboard_type(KeyboardType::Email))
}
```

```tsx tabs
<View class="flex-1 gap-3 p-4 mb-[calc(env(keyboard-inset-height)+-49px)]">
  <Input placeholder="E-mail" keyboardType="email-address" class="rounded-lg border border-neutral-300 px-3 py-2" />
</View>
```

Here a 49 pt tab bar below the view already covers part of the keyboard's height. To turn the room off, leave the
variable out of the style, for example with a condition on a signal.

## Hiding the keyboard

`Keyboard.dismiss()`, from `nsh`, unfocuses the focused input, which hides the keyboard. With no input focused, it leaves
everything as it is. Rust components call `dismiss_keyboard()`.

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

fn done() -> impl IntoElement {
    button()
        .on_press(|| dismiss_keyboard())
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_4()
        .py_3()
        .child(text("Done").text_color(white()))
}
```

```tsx tabs
import { Text, Keyboard } from "nsh";
import { Button } from "nsh/base";

function Done() {
  return (
    <Button onPress={() => Keyboard.dismiss()} class="rounded-lg bg-blue-600 px-4 py-3 active:bg-blue-700">
      <Text class="text-center font-semibold text-white">Done</Text>
    </Button>
  );
}
```

> [!TIP]
> To hide the keyboard when the user drags a scroll view, set `keyboardDismissMode="on-drag"` or `"interactive"` on
> the [scroll view](./scroll.md) or [List](./list.md).

## The keyboard's height

| TSX | Rust | Returns |
|---|---|---|
| `keyboardFrame()` | `keyboard_height()`, `keyboard_duration()` | The height of the software keyboard over the NSH surface, in points (0 while it is hidden), and the duration of its show or hide animation, in seconds. |

Both are reactive: an effect, a JSX expression or a style closure that reads them runs again when the keyboard shows,
hides or changes height.

```rust tabs
use nsh_core::prelude::*;

fn message_bar() -> impl IntoElement {
    view()
        .flex_row()
        .p_2()
        .pb(move || {
            // The home indicator's inset only matters while the keyboard is hidden.
            let home = if keyboard_height() > Points::ZERO {
                Points::ZERO
            } else {
                safe_area().bottom
            };
            px(8.0) + home
        })
        .child(input().placeholder("Message").flex_1())
}
```

```tsx tabs
import { View, keyboardFrame, safeArea } from "nsh";
import { Input } from "nsh/base";

function MessageBar() {
  const insets = safeArea();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 8,
        // The home indicator's inset only matters while the keyboard is hidden.
        paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
      }}
    >
      <Input placeholder="Message" style={{ flex: 1 }} />
    </View>
  );
}
```

The height is the part of the keyboard that overlaps the NSH surface. When the window itself shrinks for the keyboard
(an Android activity that resizes), or when NSH is embedded in a view that ends above the keyboard, the height is 0.

> [!NOTE]
> To keep content above the keyboard, `env(keyboard-inset-height)` is the simpler form: it animates with the keyboard
> natively, without running code.

## Platform notes

- **iOS**: the room animates with the keyboard's own duration and an ease-in-ease-out curve.
- **Android**: where the window shrinks for the keyboard (an activity that resizes), the content already ends above
  the keyboard and the variable is 0. Where the keyboard overlaps the view, it makes room as on iOS.
- **Desktops and Mac Catalyst** type with a hardware keyboard: the variable is 0 and the view keeps its layout.
- **Web**: the variable is the browser's own (the VirtualKeyboard API's).

See [Forms and keyboard](../docs/forms-and-keyboard.md) for focus order, return keys and input accessories, and
[Safe area](./safe-area.md) for the other environment variables.
