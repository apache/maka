---
title: Tabs
description: "Tab and Tabs: the tabs of a tab list and the list. Each tab owns presses, keyboard activation, the disabled state and its role and selected state for screen readers; the list is the set; the look, the value and the content each tab shows are the app's."
order: 20.6
group: base
demo: el-tabs
---

# Tabs

Tabs switch between the sections of one place: the overview and the activity of a project, the views of a document.
Each `Tab` owns the behavior of one tab: presses, keyboard activation, the disabled state, and the tab role and its
selected state for screen readers. A `Tabs` around them is the tab list, which screen readers announce as one set. The
look is the app's: a tab has no colors, sizes, indicator or label of its own. Its children are the app's label, and
`selected:` classes on the tab, or `group-selected:` classes on what is inside it, follow its state. The content of
each section is the app's too: it shows the one its value names, next to the list.

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
            .selected_style(|s| s.bg(move || theme().background))
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
      class="group rounded-(--radius) px-3 py-2 selected:bg-background"
    >
      <Text class="text-sm text-muted-foreground group-selected:text-foreground">{label}</Text>
    </Tab>
  );
  return (
    <View class="gap-4">
      <Tabs class="flex-row self-start gap-1 rounded-(--radius-lg) bg-muted p-1">
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
concentric: the list's padding (`p-1`) is the difference between `radius.lg` and `radius`. In Rust, `tab()` and
`tabs()` make them, with a setter per prop (`.selected(..)`), a listener per event (`.on_press(..)`), the typed style
methods and `.child(..)` for their content.

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
| `children` | `.child(..)` | `JSX.Element` | none | The tabs of the list, and whatever the app lays out between them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The list's layout and look: a column by default, `flex-row` for a row. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onPress` (`Tab`) | `.on_press(\|_: &()\| ..)` | The tab was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. It runs before anything changes: the tab shows the `selected` the app passes back. |

The selected tab reports its presses too, so the app can act on a second press (scroll its section to the top, say).
A disabled tab reports nothing.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The list | | `Tabs`' `class`, `style` | |
| The tab | the list | `Tab`'s `class`, `style` | `selected:`, `disabled:`, `active:`, `hover:`, `focus:` (or `selectedStyle`, `disabledStyle`, ...) |
| The label | the tab | its own elements (`children`) | `group-selected:`, `group-disabled:` and the other `group-*:` variants with `group` on the tab's `class` |
| The section's content | next to the list | the app's elements | the app's value |

Show the selected tab through its own surface: a fill, a stronger label, a heavier weight (see
[Design guides](../docs/design-guides.md#interaction-states)).

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
- On macOS and the web each tab is a stop of the keyboard focus: Tab reaches it, Space and Return press it, and
  `focus:` styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the tab, its label included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  press the tab that has the keyboard focus.
- Every platform draws what the app styles: the tabs, the selected one's surface and the sections' content.
