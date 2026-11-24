---
title: Dialog
description: "The Dialog component: a modal surface over everything else, for full-screen flows, sheets and dialogs the app styles."
group: base
demo: el-dialog
---

# Dialog

A dialog presents content over the rest of the app in its own native window layer: a presented view controller on iOS
and Mac Catalyst, a Dialog on Android, a layer over the whole window on the desktops and the web. It is used for
full-screen flows, sheets and dialogs. The system's own gestures (swiping a sheet down, the Android back button,
Escape) work, and are decided natively. Rust makes one with `nsh_base::dialog()`, TSX with `<Dialog>` from `nsh/base`.

The dialog owns its behavior and leaves its look to the app: its styles style the popup (the view holding the
children), and in TSX `backdropClass` / `backdropStyle` add a backdrop behind it.

On macOS and Linux, closing a dialog returns keyboard focus to the input or control that had it before opening,
including `Editor` and `RichEditor`, while that control remains visible in the current scope. If another
control has already taken focus, it keeps it.

```rust tabs
use nsh_base::{button, dialog};
use nsh_core::prelude::*;

/// A blue button with a white label.
fn primary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_4()
        .py_3()
        .active(|s| s.opacity(0.7))
        .child(text(label).font_weight(FontWeight::SEMIBOLD).text_color(white()))
}

fn example() -> impl IntoElement {
    let open = signal(false);
    view()
        .flex_1()
        .justify_center()
        .p_6()
        .child(primary("Open", move || open.set(true)))
        .child(when(open, move || {
            dialog()
                .presentation(ModalPresentation::PageSheet)
                .on_cancel(move || open.set(false))
                .flex_1()
                .bg(white())
                .child(
                    view()
                        .flex_1()
                        .px_5()
                        .pt_safe_area_plus(px(20.0))
                        .pb_safe_area_plus(px(20.0))
                        .gap_3()
                        .child(text("A sheet").text_2xl().font_weight(FontWeight::BOLD))
                        .child(primary("Close", move || open.set(false))),
                )
        }))
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";

function Example() {
  const open = signal(false);
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <Button onPress={() => open.set(true)} class="items-center rounded-lg bg-blue-600 px-4 py-3 active:opacity-70">
        <Text class="font-semibold text-white">Open</Text>
      </Button>
      <Dialog open={open()} presentation="pageSheet" onOpenChange={(e) => open.set(e.open)} class="flex-1 bg-white">
        <View
          style={{
            flex: 1,
            gap: 12,
            paddingHorizontal: 20,
            paddingTop: "calc(env(safe-area-inset-top) + 20px)",
            paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)",
          }}
        >
          <Text style={{ fontSize: 24, fontWeight: "700" }}>A sheet</Text>
          <Button onPress={() => open.set(false)} class="items-center rounded-lg bg-blue-600 px-4 py-3 active:opacity-70">
            <Text class="font-semibold text-white">Close</Text>
          </Button>
        </View>
      </Dialog>
    </View>
  );
}
```

In TSX, the dialog is shown while `open` is not `false` and closed when it becomes `false`. In Rust, it is presented
while it is in the view and dismissed when it leaves it, so `when` holds it. Either way it gives its content the dialog's
safe-area insets, which the [`env(safe-area-inset-*)`](./safe-area.md) variables and `safeAreaInsets()` (`cx.insets()` in a Rust
component) inside it read. [`Button`](./button.md), also from `nsh/base`, is a press target styled by the app.

`nsh_core::prelude` also has an older, deprecated `dialog` function: import `nsh_base::dialog` by name, as above,
and the explicit import takes its place. For the system's alert or action sheet, use
[`AlertDialog`](./alert-dialog.md).

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | in the view while open (`when(open, ..)`) | `boolean` | `true` | Shown while true. |
| `animation` | `.animation(ModalAnimation::Fade)` | `"slide" \| "fade" \| "none"` | `"slide"` | How it comes in and goes. |
| `transitionShader` | `.transition_shader(TransitionShader::new(program))` | `{ source: string; uniforms?: Record<string, ShaderUniform>; duration?: number }` | none | It comes in and goes through a WGSL shader in place of its `animation`: `shade(uv)` reads what is behind as `sample_from` and the dialog as `sample_to` while `nsh.progress` runs from 0 to 1 over `duration` milliseconds (350 by default), and from 1 back to 0 as it closes. When the system asks for less motion, it takes its own `animation`. See [Shader](./shader.md). |
| `presentation` | `.presentation(ModalPresentation::PageSheet)` | `"fullScreen" \| "pageSheet" \| "formSheet"` | `"fullScreen"` | Its form on iOS: `fullScreen` covers the screen with a clear background; `pageSheet` and `formSheet` are system sheets that keep what is behind visible (`formSheet` is a smaller centered sheet on large screens). |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape and the Android back button close it natively. |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean` | `true` | A press on the backdrop closes it. |
| `closeOnSwipe` | `.close_on_swipe(..)` | `boolean` | `true` | Swiping a sheet down (iOS, phone browsers) closes it natively. |
| `detents` | `.detents(vec![SheetDetent::Medium, SheetDetent::Large])` | `SheetDetent[]` | `[]` | iOS sheets (`pageSheet`, `formSheet`): the heights it rests at, `"medium"` (about half the screen), `"large"`, `{ height }` in points or `{ fraction }` of the large one (the `SheetDetent` values [`Sheet`](./sheet.md) takes). None: the system's full height. See [A sheet at half height](#a-sheet-at-half-height). |
| `detent` | `.detent(..)` | `SheetDetent` | | The detent it rests at: it moves there when the value changes. The user's moves stand even when the app does not follow them. |
| `defaultDetent` | `.default_detent(..)` | `SheetDetent` | the smallest | The detent it opens at without `detent`. |
| `grabber` | `.grabber(..)` | `boolean` | `false` | The system's grabber at the top of the sheet. |
| `largestUndimmedDetent` | `.largest_undimmed_detent(..)` | `SheetDetent` | none | Up to this detent, what is behind the sheet stays undimmed and takes touches. |
| `statusBar` | `.status_bar(..)` | `{ foreground?, hidden?, animated? }` | none | iOS and Android: the status bar while the dialog is open, over the pages' ([Status bar](../modules/nsh-base.md#status-bar)). |
| `accessibilityLabel` | `.label(..)` | `string` | none | What screen readers call the dialog as the focus enters it: its title. |
| `accessibilityDescription` | `.accessibility_description(..)` | `string` | none | What screen readers read after its name: its message. |
| `role` | `.role(AccessibilityRole::AlertDialog)` | `"dialog" \| "alertdialog"` | `"dialog"` | What it is for screen readers: `"alertdialog"` for one that asks the user to confirm something or tells them something urgent. |
| `onOpen` | `.on_open(..)` | `() => void` | | It finished appearing. |
| `onClose` | `.on_close(..)` | `() => void` | | It went away: the user closed it, or the app removed it. |
| `onCancel` | `.on_cancel(..)` | `() => void` | | The user tried to close it (Escape, back, a backdrop press, a swipe down), whether or not a `closeOn*` flag let it close. |
| `onDetentChange` | `.on_detent_change(..)` | `(e: { detent: SheetDetent }) => void` | | The user moved the sheet to another detent (a drag, the grabber, a scroll at its edge, a screen reader). |
| `onOpenChange` | `.on_cancel(..)` | `(e: { open: boolean; reason: "cancel" \| "backdropPress" \| "swipe" }) => void` | | The user closed it: keep `open` in sync here. In Rust, `on_cancel` removes the dialog from the view. |
| `class`, `style` | `Styled` methods | `string`, `StyleProp<ViewStyle>` | | The popup: the view holding the children. |
| `backdropClass`, `backdropStyle` | a child view filling the dialog | `string`, `StyleProp<ViewStyle>` | | A backdrop filling the dialog behind the popup, present when either is set. |
| `children` | `.child(..)` | `JSX.Element` | | The content. |

| `ios` key | Rust | Type | Default | Description |
|---|---|---|---|---|
| `supportedOrientations` | `.supported_orientations(..)` | `("portrait" \| "portrait-upside-down" \| "landscape" \| "landscape-left" \| "landscape-right")[]` | the presenter's | The orientations the dialog allows. `landscape-left` is the device turned clockwise, its home side on the left (UIKit's `landscapeLeft`). |

| `android` key | Rust | Type | Default | Description |
|---|---|---|---|---|
| `statusBarTranslucent` | `.status_bar_translucent(..)` | `boolean` | `false` | The content reaches under the status bar; otherwise it starts below it. |

## Accessibility

Screen readers hear a dialog as one: as the focus enters it they say that it is a dialog and its name, then read
what is inside. Give it its title as its name, `accessibilityLabel` in TSX and `.label(..)` in Rust, and its message
as its description, `accessibilityDescription` and `.accessibility_description(..)`, which screen readers read right
after the name, so the user hears what the dialog is about before reaching its buttons. A dialog that asks
the user to confirm something, such as a deletion, is an alert dialog: `role="alertdialog"`,
`.role(AccessibilityRole::AlertDialog)`. Each platform presents the role as its own dialogs: VoiceOver's dialog on
macOS, a semantic group named by the title on iOS, UI Automation's dialog pane on Windows, AT-SPI's dialog on Linux,
a dialog with `aria-modal` on the web.

```rust tabs
dialog()
    .role(AccessibilityRole::AlertDialog)
    .label("Delete this item?")
    .accessibility_description("This can't be undone.")
    .on_cancel(move || confirm.set(false))
    .child(card())
```

```tsx tabs
<Dialog
  open={confirm()}
  role="alertdialog"
  accessibilityLabel="Delete this item?"
  accessibilityDescription="This can't be undone."
  onOpenChange={(e) => confirm.set(e.open)}
>
  …
</Dialog>
```

## Opening and closing

The dialog's state is the app's. When the user closes the dialog (Escape, the Android back button, a press on the
backdrop, a sheet swiped down), it closes natively and tells the app, which sets its state to match: TSX's
`onOpenChange({ open: false, reason })`, Rust's `on_cancel`. In TSX, while `open` stays `true` the dialog stays closed, and it
opens again when `open` goes from `false` to `true`.

Each `closeOn*` flag is read natively when the user acts, since the main thread never waits for the app's code. To
confirm before closing, set the flags to `false`: the attempt then calls `onCancel`, and the app closes the dialog
itself (in TSX by setting `open` to `false`, in Rust by taking it out of the view):

```rust tabs
dialog()
    .presentation(ModalPresentation::PageSheet)
    .close_on_escape(false)
    .close_on_backdrop_press(false)
    .close_on_swipe(false)
    .on_cancel(move || ask_to_discard.set(true))
    .flex_1()
    .bg(white())
    .child(form())
```

```tsx tabs
<Dialog
  open={open()}
  presentation="pageSheet"
  closeOnEscape={false}
  closeOnBackdropPress={false}
  closeOnSwipe={false}
  onCancel={() => askToDiscard.set(true)}
  class="flex-1 bg-white"
>
  …
</Dialog>
```

`onCancel` is called on every attempt, whether the flags let the dialog close or not.

## A sheet at half height

On iOS, a `pageSheet` or `formSheet` dialog with `detents` rests at those heights: the user drags it between them,
the system way, and past the smallest it closes when `closeOnSwipe` allows. A [`NavStack`](./nav-stack.md) inside
it pushes pages with the system's header, back button and swipe back, inside the sheet:

```rust tabs
dialog()
    .presentation(ModalPresentation::PageSheet)
    .detents(vec![SheetDetent::Medium, SheetDetent::Large])
    .detent(move || Some(detent.get()))
    .on_detent_change(move |d: &SheetDetent| detent.set(*d))
    .grabber(true)
    .on_cancel(move || open.set(false))
    .flex_1()
    .child(nav_stack().flex_1().child(nav_page().key("settings").child(settings())))
```

```tsx tabs
<Dialog
  open={open()}
  presentation="pageSheet"
  detents={["medium", "large"]}
  detent={detent()}
  onDetentChange={(e) => detent.set(e.detent)}
  grabber
  onOpenChange={(e) => open.set(e.open)}
  class="flex-1"
>
  <NavStack state={pages} class="flex-1">
    {(route) => <NavPage title={route}>…</NavPage>}
  </NavStack>
</Dialog>
```

`detent` moves the sheet when its value changes, and follows the user with `onDetentChange` as above; a drag the app
does not follow stays where the user left it.

The content is laid out at the height the sheet rests at. Elsewhere the detents are ignored and the dialog keeps its
form there; for a bottom sheet that rests at detents on every platform, use [`Sheet`](./sheet.md).

## A dialog with a backdrop

A dialog with the default `fullScreen` presentation shows what the app draws: here a dimmed backdrop and a card centered
over it. A press on the backdrop closes it:

```rust tabs
when(confirm, move || {
    dialog()
        .animation(ModalAnimation::Fade)
        .on_cancel(move || confirm.set(false))
        .flex_1()
        .child(
            // The backdrop: a press on it closes the dialog.
            view()
                .absolute()
                .inset_0()
                .bg(rgba(0x00000066))
                .on_press(move || confirm.set(false)),
        )
        .child(
            view()
                .m(auto())
                .w_80()
                .gap_3()
                .rounded_2xl()
                .bg(white())
                .p_5()
                .child(text("Delete this item?").text_xl().font_weight(FontWeight::BOLD))
                .child(
                    button()
                        .on_press(remove)
                        .items_center()
                        .rounded_lg()
                        .bg(rgb(0xdc2626))
                        .px_4()
                        .py_3()
                        .active(|s| s.opacity(0.7))
                        .child(text("Delete").font_weight(FontWeight::SEMIBOLD).text_color(white())),
                ),
        )
})
```

```tsx tabs
<Dialog
  open={confirm()}
  animation="fade"
  onOpenChange={({ open }) => confirm.set(open)}
  backdropClass="bg-black/40"
  class="m-auto w-80 gap-3 rounded-2xl bg-white p-5"
>
  <Text style={{ fontSize: 20, fontWeight: "700" }}>Delete this item?</Text>
  <Button onPress={remove} class="items-center rounded-lg bg-red-600 px-4 py-3 active:opacity-70">
    <Text class="font-semibold text-white">Delete</Text>
  </Button>
</Dialog>
```

For the system's alert or action sheet, use [`AlertDialog`](./alert-dialog.md) from `nsh/base`.

## Ref methods

None.

## Platform notes

- iOS and Mac Catalyst: `presentation` picks the form. `fullScreen` presents over the full screen with a clear
  background; `pageSheet` and `formSheet` are system sheets with the system background, which follow the finger when
  swiped down (`closeOnSwipe`). A sheet rests at its `detents`, with the system's grabber when `grabber` is set;
  custom heights need iOS 16, and iOS 15 takes the nearer of medium and large.
- Android: the dialog fills the window and shows the app's popup and backdrop. The back button goes to the topmost
  dialog first, before stacks and `BackHandler` listeners.
- Desktops (macOS, Windows, Linux, GPUI) and the web: the dialog is a transparent layer over the whole window that
  shows the app's popup and backdrop. Escape is a close attempt.
- `detents`, `detent`, `defaultDetent`, `grabber`, `largestUndimmedDetent` and `onDetentChange` are iOS's: Android,
  the desktops and the web have no system sheet, so they are ignored there (use [`Sheet`](./sheet.md)).
- `supportedOrientations` is iOS's; `statusBarTranslucent` is Android's. An Android dialog's content starts below the
  status bar unless `statusBarTranslucent` is set.
