# Findings from building Hopper Lab

Hopper Lab was written against NSH as it is, without changing the runtime, to see what an app of this kind needs.
These are the gaps it ran into, each with what the app does instead. Fix them in the runtime and delete the
workaround here in the same change.

## Open

| # | Area | Finding | Workaround in the app |
|---|---|---|---|
| 1 | Touch, layout | There is no popover / anchored overlay primitive: a menu renders inside its anchor's parent, and nothing closes it on a tap elsewhere on the screen. | The easing menu hangs under the picker's row, which has a `zIndex` over the curve; a backdrop over the curve closes it (`cards/ThrottleProfile.tsx`). |

## By design

- Styled controls (switch, slider, segmented control, stepper, menu, tab bar) are the app's own look: the switch
  and the segmented control are `nsh/base`'s `Switch` and `Tabs` with the app's parts, the others are drawn with
  NSH's primitives (`ui.tsx` and the tab bar in `App.tsx`).

## Fixed

- No direction-locked pan: the `panActivation` prop decides natively which of a pan and its scroll view takes the
  touch, and the negotiation callbacks get a `gestureState`.
- Mac Catalyst header band and colors: the content sits below the measured header, and the bar stays in the window.
- Type checking needed `tsc` from npm: `nsh check`.
- A child outside its parent's bounds drew but could not be touched: hit testing reaches children that overflow a
  parent with visible overflow (`MountItem::Overflow`), so the easing menu hangs under its picker.
- `locationX` is relative to the touched view, and there was no `measure()`: `ref.measure()` gives a view's `pageX` /
  `pageY`, and `track` (`ui.tsx`) follows the finger in page coordinates, so the slider's children take touches.
- No keyboard for signed numbers: `keyboardType="numbers-and-punctuation"` has a minus key (the ± button is gone).
- `borderColor` could not be animated natively: `borderColor`, `color` and shadows bind to animated values.
- QuickJS had no `Intl`: `Intl.NumberFormat` / `DateTimeFormat` and `toLocaleString` are formatted in Rust.
- No `isPointInPath`: `cx.isPointInPath` / `isPointInStroke` are answered in Rust; the RCS quads and the tank in
  the mass section are hit-tested with paths.
- A hot update of the entry popped pushed screens and reset state: top-level signals and navigators keep their state,
  and an unchanged `mount(App)` is kept (editing `App` itself still resets the state inside it).
