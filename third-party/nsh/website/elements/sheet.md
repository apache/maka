---
title: Sheet
description: "The Sheet component: a panel at an edge of the screen over a backdrop, closed by the backdrop, Escape and back, resting at detents, styled by the app."
group: base
demo: el-sheet
---

# Sheet

A sheet is a panel at an edge of the screen over a backdrop that covers the rest: filters, a share panel, a side
drawer. A press on the backdrop, Escape, the Android back button and VoiceOver's escape gesture close it. It shows on top of everything in its
window, the same on every device, and draws nothing of its own: the panel and the backdrop are the app's.

```rust tabs
use nsh_base::{SheetEvent, sheet};
use nsh_core::prelude::*;

fn filters(open: Signal<bool>) -> impl IntoElement {
    sheet()
        .open(move || Some(open.get()))
        .on_open_change(move |e: &SheetEvent| {
            if let SheetEvent::OpenChange(next, _) = e {
                open.set(*next);
            }
        })
        .child(
            view()
                .gap_3()
                .p_6()
                .rounded_t(px(16.0))
                .bg(white())
                .child(text("Filters").font_weight(FontWeight::SEMIBOLD))
                .child(view().on_press(move || open.set(false)).child(text("Done"))),
        )
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";

function Filters() {
  const open = signal(false);
  return (
    <>
      <View onPress={() => open.set(true)}><Text>Filters</Text></View>
      <Sheet
        open={open()}
        onOpenChange={(e) => open.set(e.open)}
        popupClass="gap-3 rounded-t-2xl bg-white p-6"
        backdropClass="bg-black/40"
      >
        <Text class="font-semibold">Filters</Text>
        <View onPress={() => open.set(false)}><Text>Done</Text></View>
      </Sheet>
    </>
  );
}
```

`Sheet` comes from [`nsh/base`](../modules/nsh-base.md). Its content is made each time it opens. `side` puts it at
the `"bottom"` (the default) or `"top"` of the screen, as wide as the screen, or at the `"left"` or `"right"`, as tall
as the screen; its size across is the panel's, from its content or `popupClass`.

Its slide follows the panel's measured size as content is created or grows during the entrance. Lazy content and
asynchronous size updates share the same animation progress; the panel settles at its current size.

## Open state

Without `open`, the sheet keeps its own state, starting from `defaultOpen`. With `open`, the app owns it: change it in
`onOpenChange({ open, reason })`, which reports each request to close with its reason (`"backdropPress"`, `"cancel"`, `"swipe"`).
`onOpen` and `onClose` follow it in and out, whoever opened or closed it.

`closeOnEscape={false}` keeps it open on Escape and back, `closeOnBackdropPress={false}` on presses on the backdrop;
`onCancel` still hears them, to ask first.

## Dragging a bottom sheet

Set `closeOnSwipe` to let a bottom panel follow downward dragging. Its backdrop fades with the distance; releasing
past 30% of the panel's height, or downward at 800 points per second, requests closing with reason `"swipe"`.
A shorter drag returns smoothly. A controlled owner can keep `open` true to return the panel after a close request.
With reduced motion, release and programmatic opening/closing settle immediately; direct dragging still follows the finger.

The panel fits its content, including short menus; use `popupStyle` or a child's height to constrain taller content.
The app draws its own handle, which can be any view inside the panel. On iOS, an inner vertical `Scroll` or `List`
consumes the drag until its top and hands the remaining downward motion to the panel within the same gesture.
On Android, desktops and the web, dragging the handle or content outside a scroll uses their native pan support;
inner scrolls keep their platform's normal gesture arbitration. When the panel starts to follow the finger, editing
ends: the focused input inside blurs and the software keyboard goes down; scrolling an inner list keeps it. Setting `closeOnSwipe` to false keeps the panel
stationary and preserves the mounted content and scroll position. Other sides retain their existing behavior.

## Detents

A bottom sheet can rest at several heights, as a map's or a player's panel does: give it `detents`, from
`"medium"` (about half the screen) and `"large"` (the screen below the status bar) to `{ height }` in points and
`{ fraction }` of the large one. The panel is as tall as the largest and rests lower for a smaller one, so its top
part shows. A drag moves it between them, following the finger; a release springs it to the nearest detent, or on to
the next one in the direction of a flick. Below the smallest, `closeOnSwipe` closes it as without detents; without
`closeOnSwipe` it comes back. On iOS a scroll inside it hands the downward drag over once it is at its top, so a list
at the largest detent scrolls first and then brings the sheet down. Mouse drags move it the same way on the desktops
and the web.

Without `detent`, the sheet keeps its own detent, starting from `defaultDetent` (the smallest by default). With
`detent`, the app owns it: change it in `onDetentChange({ detent })`, which reports each detent the user moves it
to; a detent the app keeps brings the panel back. `detents` may change while the sheet is open: given to a sheet
that had none, or all taken away, they take effect at once, and the sheet makes its content again; so does a `side`
changing between the bottom and another edge.

`grabber` shows a handle at the top of the panel, before the content. Like the rest of the sheet it looks like
nothing: style it with `grabberClass` / `grabberStyle` and name it with `grabberAccessibilityLabel`. Screen readers
adjust it to change the detent, and a press moves to the next larger one (after the largest, the smallest). With
reduced motion the sheet moves between detents at once.

`footer` shows at the bottom of the panel, after the content: an input bar, the sheet's actions. With detents it stays
at the bottom of the part of the panel that shows, at every detent and while a drag or a spring moves the panel
between them, moving natively with the panel; below the smallest detent it goes with the panel. Give the smallest
detent room for it. Style it with `footerClass` / `footerStyle`.

```tsx
const detent = signal<SheetDetent>("medium");

<Sheet
  open={open()}
  onOpenChange={(e) => open.set(e.open)}
  detents={["medium", "large"]}
  detent={detent()}
  onDetentChange={(e) => detent.set(e.detent)}
  closeOnSwipe
  grabber
  grabberClass="h-1.5 w-9 self-center rounded-full bg-zinc-300"
  grabberAccessibilityLabel="Resize"
  popupClass="rounded-t-2xl bg-white pt-2"
  backdropClass="bg-black/40"
  footer={<Input placeholder="Add a comment" />}
  footerClass="border-t border-zinc-200 px-4 py-2"
>
  <Scroll class="flex-1">{/* … */}</Scroll>
</Sheet>
```

The software keyboard lifts a sheet with detents as any bottom sheet, below the status bar at most. While it is up the
sheet rests at its largest detent, so what is typed in the footer or the content shows, and it goes back to its detent
once the keyboard goes. The raise leaves the detent the app reads as it is, and the grabber reads and changes that
detent meanwhile.

## The software keyboard

While the software keyboard is up, a panel that reaches the bottom of the screen (a bottom sheet, a drawer at the left
or right) ends at the keyboard's top instead of the screen's bottom, and moves with the keyboard as it comes and goes,
on the keyboard's own curve. Pad the panel's bottom by the safe area (`pb-[env(safe-area-inset-bottom)]`, Rust
`.pb_safe_area()`), as without a keyboard: that padding then sits behind the keyboard, so the panel's content ends
right above it, the larger of the safe area and the keyboard. Lifted by the keyboard, a bottom sheet stays below the
status bar, however tall its content. A `maxHeight` in `popupStyle` takes the place of that limit: a lower one
subtracts the room the keyboard takes past the safe area (`keyboardFrame().height - safeArea().bottom`) itself, as
in `windowSize().height - safeArea().top - Math.max(0, keyboardFrame().height - safeArea().bottom) - 24`. Menus,
selects and date pickers that a phone shows as sheets do the same, and a `maxHeight` in their `popupStyle` or
`popupClass` takes the place of their limit the same way.

## Screen readers and keyboard focus

A sheet is a modal dialog on every platform, as a [Dialog](./dialog.md) is. Screen readers hear it as a dialog named
by `accessibilityLabel` (give it the sheet's title) and keep to it while it shows. On the desktops and the web, the
keyboard focus leaves what is under it as it opens, Tab goes round the stops in its panel, and the focus goes back
where it was as it closes. To start with the focus on a control in the panel, focus it in `onOpen`.

## Native sheets

A sheet is drawn by NSH in the app's window, styled by the app. For the platform's own presented sheet (a page sheet
on iOS), use a [Dialog](./dialog.md) with `presentation="pageSheet"`.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `side` | `.side(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | The edge it is on. |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape and the Android back button close it. |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean` | `true` | A press on the backdrop closes it. |
| `closeOnSwipe` | `.close_on_swipe(..)` | `boolean` | `false` | A bottom panel follows downward dragging and closes on a sufficient release. |
| `detents` | `.detents(..)` | `SheetDetent[]` | `[]` | The heights a bottom sheet rests at: `"medium"`, `"large"`, `{ height }`, `{ fraction }`. |
| `detent` | `.detent(..)` | `SheetDetent` | none | The detent it rests at, controlled by the app. |
| `defaultDetent` | `.default_detent(..)` | `SheetDetent` | the smallest | The detent it rests at first, without `detent`. |
| `grabber` | `.grabber(..)` | `boolean` | `false` | Shows a grabber at the top of the panel. |
| `grabberClass`, `grabberStyle` | `.grabber_class(..)`, `.grabber_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the grabber. |
| `grabberAccessibilityLabel` | `.grabber_accessibility_label(..)` | `string` | none | What screen readers call the grabber. |
| `footer` | `.footer(..)` | `JSX.Element` | none | What shows at the bottom of the panel; with detents, at the bottom of what shows. |
| `footerClass`, `footerStyle` | `.footer_class(..)`, `.footer_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the footer. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the panel. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the backdrop, such as a translucent color. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the dialog: the sheet's title. |
| `children` | `.child(..)` | `JSX.Element` | none | The content. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | A close request, with why: `"backdropPress"`, `"cancel"` or `"swipe"`. |
| `onOpen` | `.on_open(\|\| ..)` | It came in: it is all there. |
| `onClose` | `.on_close(\|\| ..)` | It went: it is all gone. Also when the app closed it. |
| `onCancel` | `.on_cancel(\|\| ..)` | The user tried to close it (Escape or back, a press on the backdrop, an enabled swipe), whether or not it closed. |
| `onDetentChange` | `.on_detent_change(\|detent\| ..)` | The user moved it to another detent (a drag, the grabber). |

On the web, embedding with `dialogs: "viewport"` presents the sheet and its backdrop over the host page,
including a same-origin iframe. Cross-origin frames use [`hostPlayerFrame`](../docs/web.md#embed-it-in-a-page).
