---
title: Tabs
description: "Tab and Tabs: the tabs of a tab list and the list. Each tab owns presses, keyboard activation, the disabled state and its role and selected state for screen readers; the list is the set, with an indicator that follows the selected tab natively; the look, the value and the content each tab shows are the app's."
group: base
demo: el-tabs
---

# Tabs

Tabs switch between the sections of one place: the overview and the activity of a project, the views of a document.
Each `Tab` owns the behavior of one tab: presses, keyboard activation, the disabled state, and the tab role and its
selected state for screen readers. A `Tabs` around them is the tab list, which screen readers announce as one set. The
look is the app's: a tab has no colors, sizes or label of its own. Its children are the app's label, and
`selected:` classes on the tab, or `group-selected:` classes on what is inside it, follow its state. The content of
each section is the app's too: it shows the one its value names, next to the list. The list's indicator, an
underline or a pill the app styles, sits on the selected tab and travels to the next one natively
([Indicator](#indicator)).

```rust tabs
use nsh_base::{tab, tabs, theme};
use nsh_core::prelude::*;

fn sections() -> impl IntoElement {
    let section = signal("overview");
    let item = move |value: &'static str, label: &'static str| {
        let selected = move || section.get() == value;
        tab()
            .selected(selected)
            .on_press(move |_: &()| section.set(value))
            .rounded(move || theme().radius)
            .px_3()
            .py_2()
            .child(text(label).text_sm().text_color(move || {
                if selected() { theme().foreground } else { theme().muted_foreground }
            }))
    };
    view()
        .gap_4()
        .child(
            tabs()
                .flex_row()
                .self_start()
                .gap_1()
                .p_1()
                .rounded(move || theme().radius)
                .bg(move || theme().muted)
                .indicator_style(|s| {
                    s.top_1()
                        .bottom_1()
                        .rounded(move || theme().radius)
                        .bg(move || theme().background)
                })
                .child(item("overview", "Overview"))
                .child(item("activity", "Activity")),
        )
        .child(text(move || {
            if section.get() == "overview" {
                "Visitors, sign-ups and conversion this week."
            } else {
                "Deploys, invoices and new members, newest first."
            }
        }).text_color(move || theme().foreground))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";

function App() {
  const section = signal("overview");
  const item = (value: string, label: string) => (
    <Tab
      selected={section() === value}
      onPress={() => section.set(value)}
      class="group rounded-(--radius) px-3 py-2"
    >
      <Text class="text-sm text-muted-foreground group-selected:text-foreground">{label}</Text>
    </Tab>
  );
  return (
    <View class="gap-4">
      <Tabs
        class="flex-row self-start gap-1 rounded-(--radius-lg) bg-muted p-1"
        indicatorClass="inset-y-1 rounded-(--radius) bg-background"
      >
        {item("overview", "Overview")}
        {item("activity", "Activity")}
      </Tabs>
      <Text class="text-foreground">
        {section() === "overview"
          ? "Visitors, sign-ups and conversion this week."
          : "Deploys, invoices and new members, newest first."}
      </Text>
    </View>
  );
}

mount(App);
```

`Tab` and `Tabs` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the
app's: the list holds none. Each tab is told whether it is selected; a press reports `onPress`, the app sets its value
and shows that section, and every tab shows the `selected` the app passes back. The list's corners and the tabs' are
concentric: the list's padding (`p-1`) is the difference between `radius.lg` and `radius`. The selected tab's fill is
the list's indicator (`indicatorClass`, inside that padding: `inset-y-1`), which springs to the tab the app selects. In
Rust, `tab()` and `tabs()` make them, with a setter per prop (`.selected(..)`), a listener per event (`.on_press(..)`),
the typed style methods and `.child(..)` for their content.

## Props

### Tab

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `selected` | `.selected(..)` | `boolean` | `false` | The current tab of its list: screen readers say it is selected, and `selected:` styles apply. A press reports `onPress`; the tab shows the value the app passes back. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply, and screen readers say it is dimmed. |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The tab's style while selected and not disabled, as `selected:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: the tab's name, when its children have no text that says it (an icon). |
| `children` | `.child(..)` | `JSX.Element` | none | The app's label, icon or badge, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The tab itself: the surface around its label. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The tab's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

### Tabs

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `indicatorClass` | `.indicator_class(..)` | `string` | none | The Tailwind classes of the indicator on the selected tab: its look and its place across the list (`bottom-0 h-0.5` for an underline in a row, `inset-y-1` for a pill). Along the list it spans the selected tab, inside its own margins on that axis. With `indicatorClass` or `indicatorStyle` the list has an indicator. |
| `indicatorStyle` | `.indicator_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The style of the indicator, over `indicatorClass`. |
| `children` | `.child(..)` | `JSX.Element` | none | The tabs of the list, and whatever the app lays out between them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The list's layout and look: a column by default, `flex-row` for a row. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onPress` (`Tab`) | `.on_press(\|_: &()\| ..)` | The tab was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation; or an arrow key, Home or End of its list moved the keyboard focus to it. It runs before anything changes: the tab shows the `selected` the app passes back. |

The selected tab reports its presses too, so the app can act on a second press (scroll its section to the top, say).
A disabled tab reports nothing.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The list | | `Tabs`' `class`, `style` | |
| The indicator | the list, behind the tabs | `indicatorClass`, `indicatorStyle` | on the selected tab |
| The tab | the list | `Tab`'s `class`, `style` | `selected:`, `disabled:`, `active:`, `hover:`, `focus:` (or `selectedStyle`, `disabledStyle`, ...) |
| The label | the tab | its own elements (`children`) | `group-selected:`, `group-disabled:` and the other `group-*:` variants with `group` on the tab's `class` |
| The section's content | next to the list | the app's elements | the app's value |

Show the selected tab through its own surface: a fill, a stronger label, a heavier weight (see
[Design guides](../docs/design-guides.md#interaction-states)).

## Indicator

An underline under the selected tab, a pill behind it or a segmented control's raised segment is the list's
indicator: a view the app styles with `indicatorClass` and `indicatorStyle`, drawn behind the tabs and absolutely
positioned in the list. Native Shell places it on the selected tab after each layout. Along the list (a row's width,
a column's height) it spans that tab, inside the indicator's own margins on that axis (`mx-3` for an underline
shorter than its tab); across the list its classes place it:

```tsx
// An underline at the bottom of a row of tabs.
<Tabs class="flex-row gap-4 border-b border-border" indicatorClass="bottom-0 h-0.5 bg-foreground">
  {item("overview", "Overview")}
  {item("activity", "Activity")}
</Tabs>

// A pill behind the selected tab, inside the list's padding.
<Tabs class="flex-row self-start gap-1 rounded-(--radius-lg) bg-muted p-1" indicatorClass="inset-y-1 rounded-(--radius) bg-background shadow-sm">
  {item("overview", "Overview")}
  {item("activity", "Activity")}
</Tabs>
```

When the app selects another tab, the indicator springs there natively, as GPUI Kit's tab bar indicator does; with
reduced motion it moves at once. While no tab is selected it is hidden; while several are, it is on the first. A
resize or a change of a tab's width moves it in the same frame as the tabs. The
indicator needs no layout events and no code of the app's: the selected tab is the one whose `selected` is true. In a
list that scrolls, the scroll view goes around the `Tabs`, and the indicator scrolls with the tabs.

## Disabled

A disabled tab takes no presses, and screen readers announce it as dimmed. Its `disabled:` classes apply over its
`selected:` ones, and `group-disabled:` classes inside it follow:

```tsx
<Tab
  selected={section() === "billing"}
  disabled={!isOwner()}
  onPress={() => section.set("billing")}
  class="group rounded-(--radius) px-3 py-2 selected:bg-background disabled:opacity-50"
>
  <Text class="text-sm text-muted-foreground group-selected:text-foreground">Billing</Text>
</Tab>
```

## Accessibility

- A tab is one element for screen readers, with the role `"tab"` and its selected state. Its label is the text of its
  children, or `accessibilityLabel`.
- `Tabs` has the role `"tablist"`: screen readers hear the tabs inside it as one set, each still an element of its
  own.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).
- On macOS and the web the list is one stop of the keyboard focus, and the arrow keys move between its tabs (below).
- The indicator is hidden from screen readers and takes no focus: the tabs alone are the list's elements.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

On macOS and the web, where Tab reaches the views that take presses, a `Tabs` list follows the
[WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/):

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Enters the list at the selected tab (the first tab that is not disabled while none is), and leaves it in one step. |
| Right, Down | Moves the focus to the next tab, from the last to the first. |
| Left, Up | Moves the focus to the previous tab, from the first to the last. |
| Home, End | Moves the focus to the first or the last tab. |
| Space, Return | Presses the focused tab. |

The arrow keys skip disabled tabs, and the tab they move to reports `onPress`, so the app selects it as the focus
moves: the section follows the focus. Both pairs of arrows move, whatever the list's layout, which is the app's
class. `focus:` styles show where the focus is. A `Tab` outside a `Tabs` is a stop of its own.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the tab, its label included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  press the tab that has the keyboard focus, and the arrow keys, Home and End move it ([Keyboard](#keyboard)).
- Every platform draws what the app styles: the tabs, the selected one's surface, the indicator and the sections'
  content. The indicator's travel is a native layout animation on every platform.
