---
title: Keyboard
description: "The keyboard-inset-height environment variable, Keyboard.dismiss and the keyboard's height: content kept above the software keyboard, moving with it."
order: 120
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
import { Window } from "nsh/desktop";

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
          onChange={({ value }) => draft.set(value)}
          placeholder="Message"
          style={{ flex: 1, fontSize: 16, padding: 8 }}
        />
      </View>
    </View>
  );
}

mount(() => (
  <Window id="main">
    <App />
  </Window>
));
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
| `keyboardFrame()` | `keyboard_height()`, `keyboard_duration()` | The height of the software keyboard over the NSH surface, in points (0 while it is hidden), and the duration of its show or hide animation, in milliseconds. |

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

## Hardware keys on custom views

A focused view hears the hardware key transitions its platform reports: `onKeyDown` / `onKeyUp` in TSX, or
`on_key_down` / `on_key_up` in Rust. This suits a custom-rendered canvas or embedded interaction surface. Named
shortcuts use `on_key` / `on_key_with`; text editing uses `Input`, and terminal sessions use `Terminal`.

`KeyEvent` reports what the source actually gives:

| Field | Meaning |
|---|---|
| `key` | The source's logical key: the DOM spelling for named keys (`"Enter"`, `"ArrowLeft"`), else the character the key reports, in its case and layout, never forced onto another layout. `"Unidentified"` when the source names none. |
| `code` | The key's physical identity in the DOM's `KeyboardEvent.code` spelling (`"KeyA"`, `"ArrowLeft"`, `"NumpadEnter"`, `"ShiftLeft"`), mapped by the platform from its real native identifier. `""` when the source has none (GPUI's logical events, synthetic input); it is never guessed from `key`. |
| `modifiers` | The modifiers held after this transition. |
| `repeat` | An auto-repeat of a held key. |
| `defaultPrevented` | The mounted `captureKeys` policy decided this transition: the platform runs no native default and types no text. It is this transition's decision, observable as the DOM's `defaultPrevented` is, not a veto a listener casts. |

On Linux, common media, volume and browser keys use UI Events names such as `"MediaPlayPause"`, `"AudioVolumeUp"` and
`"BrowserBack"`.

Both listeners return nothing. One platform event on the focused view bubbles to the enabled listening ancestors
within the same native window, once each, for `onKeyDown` and `onKeyUp` alike. A real release the source reports
reaches the focused view even when its press went elsewhere, as the DOM's does; losing the window's focus clears
held state and invents no releases.

The same typed props apply to host elements such as `Scroll`, `List` and `Overlay`. A listener or capture rule on
one of these ancestors follows the focused descendant's logical ancestry, including children rendered in overlays.
That forwarding only engages for an overlay whose logical ancestry has such a listener or rule: ordinary overlays
without one (a menu, a popover, a dialog) keep their usual routing.

A listener cannot decide handling: the UI thread never waits for app callbacks. GTK runs a key's default inside its
own propagation loop, AppKit applies a window's default handling (a menu shortcut, a beep) on the event or the next
one, Win32 reaches `TranslateMessage` and `DefWindowProc` after the window procedure returns, and GPUI notifies the
listener from its `on_key_event` Bubble pass and reads the window's `prevent_default` after that pass: each has
already run its default or not when the listener is told. `defaultPrevented` only reports what the mounted policy
decided for that transition.

Matching uses the platform's existing shortcut normalization, independently of the raw event: capture rules are
canonical `nsh/keymap` keystrokes and match the stroke the platform's own shortcut matcher builds from the key, not
the reported `key` string or the physical `code`. A key that produces no shortcut stroke (a modifier key, an
unidentified key, another layout's letter) is taken only by `captureKeys="all"`.

`captureKeys` in TSX (`{"none"}`, `{"all"}` or an array such as `{["mod+k", "escape"]}`), or
`capture_keys(KeyCapture::All)` / `capture_keys(KeyCapture::keys(...))` in Rust, mounts the consumption rule before
input arrives. The rule is parsed once into canonical shortcut keystrokes (the `nsh/keymap` syntax; `mod` is
Command on Apple platforms, Control elsewhere), and `defaultPrevented` reports this transition's decision. The rule
accepts reactive values; omitting it on a retained view restores `"none"`. Eligible app shortcuts keep their
priority, focused native inputs keep the keys that edit them, and a capture cannot defeat a shortcut the operating
system never delivers. A captured Tab stays in the view; an observed Tab follows normal traversal.
Inside the top overlay that closes on Escape (a `Popover`, a `Sheet`), a focused view whose rule, or an enabled
ancestor's within that overlay, captures `escape` takes Escape before the overlay does: an editor in a popover
clears its selection first, and the overlay closes on Escape again once the rule drops the key. Back and the screen
reader's escape gesture still close the overlay.

```tsx
import { signal, Text, View } from "nsh";

function Pad() {
  const log = signal("");
  return (
    <View
      focusable
      captureKeys={["mod+k", "shift+tab"]}
      onKeyDown={(e) => log.set(`${e.key} ${e.code} ${e.defaultPrevented} ${e.repeat}`)}
      onKeyUp={(e) => log.set(`up ${e.key} ${e.defaultPrevented}`)}
    >
      <Text>{log()}</Text>
    </View>
  );
}
```

The Rust API is also exercised by the Linux-desktop headless driver; Rust UI sets can expose app-specific
components and events to TSX. Input sources differ: a terminal that reports only strokes (legacy terminals) sends
no synthetic releases, repeats or codes; a terminal speaking the kitty keyboard protocol reports releases and
auto-repeats for the keys it sends as escape codes, and still no physical code (`code` is `""`), as GPUI's logical
events have none either. Android reports `key` from the character the hardware keyboard types (else the key code's
DOM name) and `code` only from a real scan code, so a synthetic `adb shell input keyevent` has `""`. A system key
(Back, Home, volume, media, camera, call) is never captured, even by `captureKeys="all"`, and still reaches listeners.
A `focusable` view takes the hardware keyboard's focus; Tab and Shift+Tab move between the stops and go to the
embedding Android host at the first and last one, and while no view has the focus the first arrow key moves it to the
first stop on screen. A `keymap` binding on that arrow keeps the key for the app, as does a `captureKeys` rule of a
view that hears it. See `docs/dev/tooling.md` and each platform's development page
for what its source reports.

On iOS, a hardware keyboard reports `UIKey.characters` as `key` (its case and layout kept) and maps
`UIKey.keyCode`'s USB HID usage to the DOM `code`. UIKit sends a held key's press once, so `repeat` is false. A Tab
captured by `captureKeys` or bound in `keymap` arrives as a key command: its `code` is `""` and no release is invented.

## Platform notes

- **iOS**: the room animates with the keyboard's own duration and an ease-in-ease-out curve.
- **Android**: where the window shrinks for the keyboard (an activity that resizes), the content already ends above
  the keyboard and the variable is 0. Where the keyboard overlaps the view, it makes room as on iOS.
- **Desktops and Mac Catalyst** type with a hardware keyboard: the variable is 0 and the view keeps its layout.
- **Web**: the variable is the browser's own (the VirtualKeyboard API's).

See [Forms and keyboard](../docs/forms-and-keyboard.md) for focus order, return keys and input accessories, and
[Safe area](./safe-area.md) for the other environment variables.
