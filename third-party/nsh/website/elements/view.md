---
title: View
description: "The basic container element: layout, backgrounds, borders, shadows, press handling and gestures."
order: 10
group: primitives
demo: el-view
---

# View

`View` is the building block of every screen: a native container (a UIView on iOS and Mac Catalyst, a ViewGroup on
Android) that lays out its children with flexbox or grid, draws a background, borders, shadows and gradients, and handles
presses. Buttons, cards, rows and screens are all views. Rust makes one with `view()`, TSX with `<View>` from `nsh`.

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

function App() {
  const liked = signal(false);
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: "#f6f8fa" }}>
      <View
        style={{
          backgroundColor: "#ffffff",
          borderRadius: 16,
          padding: 16,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#8250df" }} />
        <Text style={{ flex: 1, fontSize: 16 }}>A card</Text>
        <View onPress={() => liked.set(!liked())} activeStyle={{ opacity: 0.5 }} hitSlop={8}>
          <Text style={{ fontSize: 22 }}>{liked() ? "♥" : "♡"}</Text>
        </View>
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

```rust tabs
use nsh_core::prelude::*;

fn app() -> impl IntoElement {
    let liked = signal(false);
    view()
        .flex_1()
        .p_6()
        .gap_4()
        .bg(rgb(0xf6f8fa))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .p_4()
                .rounded(px(16.0))
                .bg(white())
                .shadow_md()
                .child(view().size(px(40.0)).rounded_full().bg(rgb(0x8250df)))
                .child(text("A card").flex_1().text_base())
                .child(
                    view()
                        .hit_slop(EdgeInsets::all(px(8.0)))
                        .active(|s| s.opacity(0.5))
                        .on_press(move || liked.update(|l| *l = !*l))
                        .child(text(move || if liked.get() { "♥" } else { "♡" }).text_size(px(22.0))),
                ),
        )
}
```

## Layout

A view lays out its children with flexbox, with these defaults: `flexDirection: "column"`, `flexShrink: 0`,
`alignContent: "flex-start"`, `position: "relative"`. `display: "grid"` (`.grid()` in Rust) switches to CSS grid and
`display: "block"` to block layout. Sizes are in points. See [layout](../docs/layout.md) and the
[style reference](../modules/style-reference.md).

`display: "flex"` follows CSS: in a style, as the `flex` class and Rust's `.flex()`, it is a row unless a direction is
set (`flexDirection: "column"`, `flex-col`, `.flex_col()`). A view that sets no display stacks its children in a column.

## Props

`View` has one prop of its own, `selectable` (`.selectable(true)` in Rust): the texts inside the view select together, as one selection ([Text selection](./text-selection.md)). The rest are the [common props](./index.md#common-props): its styles (`style`, `class`,
`classList`; the `Styled` methods in Rust), `disabled`, the press props (`onPress`, `onLongPress`, `onPressDown`,
`onPressUp`, `delayLongPress`, `hitSlop`), the state styles (`activeStyle`, `hoverStyle`,
`focusStyle`, `disabledStyle`, `checkedStyle`), `onMouseEnter` / `onMouseMove` / `onMouseLeave`, `onWheel`, `onPinch`, `onMouseUp`, `onContextMenu`,
`onFileDragEnter` / `onFileDragLeave` / `onFileDrop`, `focusable`, `captureKeys`, `onKeyDown` / `onKeyUp`, `onLayout`, `ref`, `nativeID`, `testID`, the page's
markup on the web (`web={{ element }}`), the
gesture props (`pan`, `pinch`, `rotation` and their events), the touch and responder props, the accessibility props
and `ios` / `android` / `desktop`.

## Selectable views

With `selectable`, a selection runs across the [`Text`](./text.md) elements and [`TextView`](./text-view.md)s inside
the view, in reading order; texts with `selectable={false}` stay out, and a selectable view inside another is part of
the outer one. See [Text selection](./text-selection.md) for the gestures on each platform.

```tsx
<View selectable class="gap-3 p-4">
  <Text>One selection runs from here…</Text>
  <Text>…to here.</Text>
</View>
```

## Press feedback

A pressable view is any view with a press handler. Its feedback is the app's: a style while pressed, applied natively
while the finger is down, with no round trip to the app's code. `hoverStyle`, `focusStyle` and `disabledStyle` do the
same for the other states:

```tsx tabs
// Fade the whole view.
<View onPress={open} activeStyle={{ opacity: 0.6 }}>…</View>

// Show a background; group-active: styles the children.
<View onPress={open} class="group" activeStyle={{ backgroundColor: "#e5e7eb" }}>
  <Text class="group-active:opacity-70">Open</Text>
</View>

// Change any style while pressed with active: classes.
<View onPress={open} class="bg-blue-600 active:bg-blue-800 active:scale-95">…</View>
```

```rust tabs
// Fade the whole view.
view().on_press(open).active(|s| s.opacity(0.6))

// Show a background; group_active styles the children.
view()
    .group()
    .on_press(open)
    .active(|s| s.bg(rgb(0xe5e7eb)))
    .child(text("Open").group_active(|s| s.opacity(0.7)))

// Change any style while pressed.
view().on_press(open).bg(rgb(0x2563eb)).active(|s| s.bg(rgb(0x1e40af)).scale(0.95))
```

On Android, `android={{ ripple: { color: "#0000001f" } }}` (`.ripple(Ripple { .. })` in Rust) adds the material
ripple (`borderless`, `radius` and `foreground` adjust it).

`disabled` removes the press listeners from the native view (no press, no feedback) and applies the disabled styles:

```tsx tabs
<View onPress={submit} disabled={!valid()} class="bg-green-600 disabled:opacity-40">…</View>
```

```rust tabs
view()
    .on_press(submit)
    .disabled(move || !valid.get())
    .bg(rgb(0x16a34a))
    .disabled_style(|s| s.opacity(0.4))
```

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onPress` | `.on_press` | `PressEvent` (none in Rust) | A tap ended inside the view. |
| `onLongPress` | `.on_long_press` | `PressEvent` (none in Rust) | The finger stayed down for `delayLongPress` (500 ms). |
| `onPressDown` / `onPressUp` | `.on_press_down` / `.on_press_up` | `PressEvent` (none in Rust) | A finger went down / lifted or left. |
| `onFocusIn` / `onFocusOut` | `ElementRef::on_focus_in` / `on_focus_out` | none | The keyboard focus came into the view (onto it or a view inside it) from outside / left it for a view outside or none; moving between the views inside is no new coming in. A panel notes where its focus is and puts it back later with `ref.focus()`. |
| `onMouseEnter` / `onMouseLeave` | `.on_mouse_enter` / `.on_mouse_leave` | `MouseEvent` | The mouse came over the view (or a view inside it) / left it or the window ([hover](./index.md#hover)); `onMouseLeave`'s is where it was last. |
| `onMouseMove` | `.on_mouse_move` | `MouseEvent` | The mouse moved over the view (or a view inside it), with or without a button down, or a modifier key was pressed or released while it rests there with none down: `position`, `pagePosition` (`Point`s), `modifiers` and `pressedButton` (`"left"`, `"right"`, `"middle"`, `"back"`, `"forward"` or `null`); at most once a frame. |
| `onWheel` | `.on_wheel` | `WheelEvent` | A mouse wheel or touchpad scrolled over the view (or a view inside it): `position`, `pagePosition`, `delta`, `deltaMode` (`"lines"` or `"points"`) and `modifiers`; a listener nearer than the scroll views under the pointer takes the wheel ([wheel](./index.md#wheel)). |
| `onPinch` | `.on_pinch` | `PinchEvent` | A touchpad pinched over the view (or a view inside it): `position`, `pagePosition`, `delta` (the change of scale since the last event), `phase` (`"start"`, `"move"`, `"end"`) and `modifiers`; macOS, Linux, the GPUI backend and Safari, from the start of a pinch to its end ([touchpad pinches](./index.md#wheel)). |
| `onMouseUp` | `.on_mouse_up` | `MouseEvent` | A mouse button was released over the view (or a view inside it): `button`, `position`, `pagePosition` and `modifiers`; desktops, the terminal and the web, never iOS or Android. A release outside the view is not reported (no pointer capture). |
| `onContextMenu` | `.on_context_menu` | `ContextMenuEvent` | A context menu was asked for over the view: the secondary button, the keyboard in the browser or a screen reader on macOS and Windows ([context menus](./index.md#context-menus)). |
| `onFileDragEnter` | `.on_file_drag_enter` | `{ uris: string[], mimeTypes: string[] }` (`FileDragEvent`) | A local-file drag entered the active desktop destination with its offered file list and their types. |
| `onFileDragLeave` | `.on_file_drag_leave` | none | A local-file drag left the active desktop destination. |
| `onFileDrop` | `.on_file_drop` | `{ uris: string[], mimeTypes: string[], pagePosition? }` (`FileDropEvent`) | Local files or directories were dropped on the destination (desktops, iOS, Android and the Web). |
| `onLayout` | `.on_layout` | `{ bounds }` (`Bounds<Points>`) | The frame relative to the parent changed. |
| `onPanStart` / `onPanEnd` | `.on_pan_start` / `.on_pan_end` | `PanEvent` | A drag bound with `pan` started / ended; `cancelled` is true when the system cancels it. |
| `onPinchStart` / `onPinchEnd` | `.on_pinch_start` / `.on_pinch_end` | `{ scale, velocity }` | A pinch bound with `pinch` started / ended. |
| `onRotationStart` / `onRotationEnd` | `.on_rotation_start` / `.on_rotation_end` | `{ rotation, velocity }` | A rotation bound with `rotation` started / ended. |
| `onAccessibilityAction` | `.on_accessibility_action` | `{ actionName }` | A custom accessibility action ran. |

Touch and responder events: see [common props](./index.md#raw-touches-and-the-responder-system).

## Desktop file drops

On AppKit, GTK, Win32 and GPUI, a view with `onFileDrop` receives local files and directories dragged from another
application. `onFileDragEnter` and `onFileDrop` receive `{ uris: string[], mimeTypes: string[] }` in the native file-list order. Each entry of `uris` is an absolute `file:` URL with escaped spaces and
non-ASCII characters. Parse the URL to obtain a filesystem path rather than removing the prefix by hand.
`mimeTypes[i]` is the MIME type of `uris[i]` by its file name (`image/png` for `a.png`), and `""` when the name
names none, a directory for instance, as the DOM's `File.type`. It is the same on every platform, and no file is read
to give it.

`onFileDrop` also gives `pagePosition`: where the files were let go, in the same coordinates as a mouse event's
`pagePosition` (the window's root view, in points), so an editor can put what it makes of them at the drop point
rather than at its caret. AppKit, GTK, Win32, iOS, Android and the Web give it; on the GPUI backend it is absent
(`None` in Rust).

Use the entry list to preview filenames, counts or kinds before release ("Release to add 2 images"). It contains metadata only; validate the files
again at drop time. AppKit resolves Finder file references to path URLs. GTK reports entry when its asynchronous
file-list preload finishes, including when the pointer stays still, and ignores completion after leave or reset.
Moving between destinations reports leave then entry with the same offered list. `onFileDragLeave` clears the
preview. Rust entry handlers receive `&FileDragEvent`; existing `||`, `|_: &()|` and `Listener<()>` handlers work too.

On AppKit, a drag that carries no file URLs but promises files, such as an image dragged out of a page in Safari or
Chrome or an attachment from Mail, is taken as well. Its files are only written once dropped, so `onFileDragEnter`
gives `uris: []` with the promised files' `mimeTypes`, and `onFileDrop` gives `uris: []` and the files' contents in
`files` (the same `{ file, name, type, size, status }` entries as on the Web and `Picker.pickFiles`), in the drag's
order, with `pagePosition`. NSH writes them to a temporary folder and removes it once they are read. A drag that also
carries file URLs, such as the screenshot thumbnail, drops its `uris` as above.

On AppKit, a drag that carries a picture as image data is taken too. Chat apps and other apps drag pictures this way,
either alone or next to the URL of a file in their own container that your app cannot read. Such a drag often
offers only the generic drag operation, not a copy, and NSH accepts it. It drops like promised files:
`onFileDragEnter` gives `uris: []` with the pictures' `mimeTypes`, and `onFileDrop` gives `uris: []` and `files`, in
the drag's order, with `pagePosition`. Each picture keeps its type, except TIFF and BMP, which become PNG. It is
named after the file next to it, or `image-<n>` when there is none. Readable files in the same drag are read into
`files` as well, and directories are left out. When every item is a file your app can read, or a file with no
picture next to it, the drag drops its `uris` as above. A drag that promises files drops those files instead of its
pictures.

On iOS (and iPadOS), a view with `onFileDrop` takes the files of a drag, such as images and documents dragged from Photos,
Files, Safari or the app's own web views. The closest view
that listens takes them, as on desktops. A drag's items carry no file URLs, only data in types that are read
when they are dropped, so `onFileDragEnter` gives `uris: []` there, and `onFileDrop` gives the `file:` URLs of copies
in the app's temporary directory (`pagePosition` too), in the drag's order. NSH leaves the copies there, where the
system removes them in time: move or upload what the app keeps. An item that offers only text or a link
is no file, and is not offered. A text input inside the view keeps what it accepts: UIKit's text drop takes text and
links, so an image that also carries its link (from a web page) goes into the input as its link.

On Android, a view with `onFileDrop` takes the files another app drags into it in split screen or a freeform window,
such as photos from the gallery or documents from a file manager. The closest view that listens takes them, by the
same hit testing as touches. As on iOS, Android opens a drag's data only at the drop: `onFileDragEnter` gives
`uris: []`, and `onFileDrop` gives the `file:` URLs of copies in the app's cache directory, named as the providing app
names them (with the extension of their type when the name has none), in the drag's order, with `pagePosition`;
then the view hears `onFileDragLeave`. NSH leaves the copies there, where the system removes them in time: move or
upload what the app keeps. A drag that offers only text or links is no file drag and stays with text inputs; a drag
of files over a text input inside the view goes to the view.

```tsx tabs
const hint = signal("");
const files = signal<string[]>([]);

<View
  onFileDragEnter={(event) => {
    const images = event.mimeTypes.filter((t) => t.startsWith("image/")).length;
    hint.set(`Release to add ${images} of ${event.uris.length} files as images`);
  }}
  onFileDragLeave={() => hint.set("")}
  onFileDrop={(event) => {
    files.set(event.uris);
    hint.set("");
  }}
  style={{ minHeight: 160, padding: 24 }}
>
  <Text>{hint() || "Drop files here"}</Text>
  <Text>{files().join("\n")}</Text>
</View>
```

```rust tabs
let hint = signal(String::new());
let files = signal(Vec::<String>::new());

view()
    .min_h(px(160.0))
    .p_6()
    .on_file_drag_enter(move |event: &FileDragEvent| {
        let images = event.mime_types.iter().filter(|t| t.starts_with("image/")).count();
        hint.set(format!("Release to add {images} of {} files as images", event.uris.len()));
    })
    .on_file_drag_leave(move || hint.set(String::new()))
    .on_file_drop(move |event: &FileDropEvent| {
        files.set(event.uris.clone());
        hint.set(String::new());
    })
    .child(text(move || if hint.get().is_empty() { "Drop files here".into() } else { hint.get() }))
    .child(text(move || files.get().join("\n")))
```

The closest enabled ancestor listening to `onFileDrop` receives the drop. A modal root bounds that search. `disabled`
removes file-drag/drop listeners; leaving, cancellation, completion and destination removal clear the active state.
Acceptance uses the Copy operation (on AppKit, the generic operation when the source offers no copy) and mounted
native state. The app decides whether to read, open or transfer the received files.

Text inputs belong to the destination around them: files dropped on an input's text reach that destination as
anywhere else in it, with the same enter and leave events, and the input keeps its text as it was. Text dragged
into an input, and files dropped on an input outside any destination, behave as the platform's text fields do.

## Ref methods

A plain view's ref is a `ViewRef`: `focus()`, `blur()`, `measure()` and
[`reveal()`](../docs/scrolling.md#revealing-a-view). `ref` (`.element_ref(&handle)` in Rust) gives you its node, e.g. to pass to
`setAccessibilityFocus` ([`nsh`'s accessibility API](../modules/nsh.md#accessibility)), or to measure it
(`handle.measure()` in Rust).

## Views inside text

A view placed inside a text is an inline attachment: it sits on the baseline and wraps with the words, and it takes
presses of its own. See [text](./text.md#inline-views-and-images).

## Platform notes

- `boxShadow` draws on every platform; `android={{ elevation }}` gives Android's material shadow instead. On Android a shadow needs a
  background color (a view with a transparent background casts none).
- `filter` on views: iOS supports `opacity()`, `brightness()` up to 1 and `drop-shadow()` (images take every color
  filter and `blur()`); Android supports them all from API 31, and the color filters below it.
- `backdropFilter: "blur(…)"` is a system material on iOS (an approximation) and needs API 31 on Android.
- Android draws `translate`, `scale` and `rotate` transforms; skews (`skew()`, `skewX()`, `skewY()`) apply on the other platforms.
- `borderCurve: "continuous"` (`.border_curve(BorderCurve::Continuous)`) draws corners that ease into the edges (as
  iOS app icons), on both platforms.
- The `cursor` style applies where there is a pointer (Mac Catalyst, iPad with a pointer, desktops).
