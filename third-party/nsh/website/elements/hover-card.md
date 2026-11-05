---
title: HoverCard
description: "The HoverCard component: a preview of what its trigger points at, shown while the pointer rests on the trigger, styled by the app."
group: base
demo: el-hover-card
---

# HoverCard

A hover card previews what its trigger points at without leaving the page: the profile behind a mention, the page
behind a link, the quote behind a ticker. On the desktops and in desktop browsers it opens once the pointer has rested
on the trigger for `openDelay` (600 ms), or once the keyboard focus comes to the trigger. It stays open while the
pointer moves from the trigger onto the card and back, and while the keyboard focus is on the trigger or on a link or
button in the card, so everything in the card can be used with the pointer and the keyboard alike. It closes
`closeDelay` (300 ms) after the pointer has left both and the focus is in neither. Escape and a press outside close it
at once. On phones and
tablets a press on the trigger opens and closes it, and a press outside closes it.

`HoverCard` from [`nsh/base`](../modules/nsh-base.md) draws nothing of its own: the trigger is your element, the
popup and its content are yours.

```rust tabs
use nsh_base::hover_card;
use nsh_core::prelude::*;

fn mention() -> impl IntoElement {
    hover_card()
        .offset(px(8.0))
        .popup_class("w-72 gap-2 rounded-xl border border-border bg-popover p-4 shadow-lg")
        .trigger(text("@ada").text_color(rgb(0x2563eb)))
        .child(text("Ada Lovelace").font_weight(FontWeight::SEMIBOLD))
        .child(text("Writes the first programs for the Analytical Engine."))
}
```

```tsx tabs
import { Text } from "nsh";
import { HoverCard } from "nsh/base";

function Mention() {
  return (
    <HoverCard
      offset={8}
      popupClass="w-72 gap-2 rounded-xl border border-border bg-popover p-4 shadow-lg"
      trigger={<Text class="text-blue-600">@ada</Text>}
    >
      <Text class="font-semibold">Ada Lovelace</Text>
      <Text>Writes the first programs for the Analytical Engine.</Text>
    </HoverCard>
  );
}
```

The trigger keeps its own role, presses and look: a view with `role="link"` and its own `onPress` still goes where it
goes when pressed, and the card adds a preview to it. The content is made each time the card opens, so it can load what it shows then. On
phones and tablets, where a press opens the card, the trigger tells screen readers whether its card is open. In a
[Toolbar](./toolbar.md) the trigger can be one of its items; what the card shows is not: its buttons and links keep
their own Tab stops and the toolbar's `disabled` leaves them as they are.

## Delays

`openDelay` keeps the card from flashing open as the pointer crosses the trigger on its way elsewhere; `closeDelay`
gives the pointer time to cross the gap between the trigger and the card. Both are milliseconds. The pointer and the
delays are followed natively, so resting on a trigger and moving between it and the card run none of your code until
the card opens or closes. An `openDelay` of `Infinity` leaves opening to the app (and to a press on a touch screen); a
`closeDelay` of `Infinity` leaves closing to Escape, a press outside and the app.

```tsx
<HoverCard openDelay={300} closeDelay={150} trigger={<Text>AAPL</Text>}>
  <Quote symbol="AAPL" />
</HoverCard>
```

## Open state

Without `open`, the card keeps its own state, starting from `defaultOpen`. With `open`, the app owns it: change it in
`onOpenChange({ open, reason })`, which reports every request to open or close with its reason: `"hover"` (the
pointer), `"focus"` (the keyboard focus), `"triggerPress"` (a press on a touch screen), `"pressOutside"` or
`"cancel"` (Escape or back).

```tsx
const open = signal(false);

<HoverCard open={open()} onOpenChange={(e) => open.set(e.open)} trigger={<Text>@ada</Text>}>
  <Profile id="ada" />
</HoverCard>
```

## Entrance and exit

A hover card comes and goes with your transitions, as a [Popover](./popover.md) does. `popupStartingClass` is the
popup's look in its first frame, and the `transition-*` classes of `popupClass` carry it to its own look.
`popupEndingClass` is its look once closed: the card stays, taking no pointer, while those transitions run, then goes,
and `onClose` follows. Resting on the trigger again while it goes takes it back. When the user asks for less motion, it
appears and goes at once.

```tsx
<HoverCard
  popupClass="rounded-xl bg-popover p-4 shadow-lg transition-all duration-150 ease-out"
  popupStartingClass="opacity-0 scale-95"
  popupEndingClass="opacity-0 scale-95"
  trigger={<Text>@ada</Text>}
>
  <Profile id="ada" />
</HoverCard>
```

It goes below the trigger by default (`placement`, `align`), on the other side when there is no room, and stays
inside the safe area. `onPosition({ placement, bounds, available })` says where it went.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `openDelay` | `.open_delay(..)` | `number` | `600` | Milliseconds the pointer rests on the trigger, or the focus stays on it, before it opens; `Infinity`: never by itself. |
| `closeDelay` | `.close_delay(..)` | `number` | `300` | Milliseconds the pointer is away from the trigger and the card, with the focus in neither, before it closes; `Infinity`: never by itself. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | The side of the trigger it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | How it lines up with the trigger along that side. |
| `offset` | `.offset(..)` | `number` | `0` | The gap between the trigger and the card. |
| `margin` | `.margin(..)` | `number` | `0` | The distance it keeps from the edges of the safe area. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the popup, the card the content is in. |
| `popupStartingClass`, `popupStartingStyle` | `.popup_starting_class(..)`, `.popup_starting_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup's look in its first frame, over its own: its transitions run from it. |
| `popupEndingClass`, `popupEndingStyle` | `.popup_ending_class(..)`, `.popup_ending_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup's look once closed, over its own: it stays while its transitions run. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What it previews; it is placed against it. |
| `children` | `.child(..)` | `JSX.Element` | none | The content, made each time it opens. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | It asks to open or close, with why: `"hover"`, `"focus"`, `"triggerPress"`, `"pressOutside"` or `"cancel"`. |
| `onOpen` | `.on_open(\|\| ..)` | It is shown. |
| `onClose` | `.on_close(\|\| ..)` | It is gone, after its exit; also when the app closed it. |
| `onPosition` | `.on_position(\|e\| ..)` | The popup was placed: `placement` (the side it went on), `bounds` (its frame), `available` (the room on that side). |

## Accessibility

A hover card adds to its trigger: the trigger keeps its role and label, and what it opens or does when pressed stays
the same. Keyboard users get the card when the focus rests on the trigger, and Escape closes it. The card takes no
focus of its own, so Tab moves on from the trigger as before. Links and buttons in the card take the focus as anywhere
else, and the card stays open while one of them has it; what matters in the card should also be reachable from the
page the trigger leads to.
