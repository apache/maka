---
title: Accordion
description: "Accordion and its parts: stacked sections that expand and collapse under their headings, one at a time or several, opened by the app's value, revealed by a springing height on request, with every look the app's."
group: base
demo: el-accordion
---

# Accordion

An accordion stacks sections that expand and collapse under their headings: the questions of an FAQ, the groups of a
settings page, the steps of a checkout. Five parts make it, each owning one piece of behavior and none of the look:

- `Accordion`, the stack: it holds the app's `value`, the values of the open items, and reports the next one with
  `onChange`. One item opens at a time, or several with `multiple`.
- `AccordionItem`, one section, identified by its `value`. It is open while the accordion's `value` holds it.
- `AccordionHeader`, the item's heading, of a `level` screen readers announce.
- `AccordionTrigger`, the button in the heading that expands and collapses its item, and says whether it is expanded.
- `AccordionPanel`, the item's content, shown while it is open; with `reveal` its height springs open and shut.

```rust tabs
use nsh_base::{accordion, accordion_header, accordion_item, accordion_panel, accordion_trigger, theme};
use nsh_core::prelude::*;

const FAQ: [(&str, &str, &str); 2] = [
    ("shipping", "When will my order ship?", "Orders placed before 2 pm leave the same day."),
    ("returns", "How do I return an item?", "Print the label from your order within 30 days."),
];

fn faq() -> impl IntoElement {
    let open = signal(vec![SharedString::from("shipping")]);
    let mut list = accordion()
        .value(open)
        .on_change(move |value: &Vec<SharedString>| open.set(value.clone()));
    for (value, question, answer) in FAQ {
        list = list.child(
            accordion_item()
                .value(value)
                .border_b_1()
                .border_color(move || theme().border)
                .child(
                    accordion_header().child(
                        accordion_trigger()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .py_3()
                            .child(text(question).font_weight(FontWeight::MEDIUM))
                            .child(text("⌄").transition_transform().rotate(move || {
                                let open = open.get().iter().any(|v| &**v == value);
                                if open { deg(180.0) } else { deg(0.0) }
                            })),
                    ),
                )
                .child(
                    accordion_panel()
                        .reveal(true)
                        .accessibility_label(question)
                        .child(view().pb_3().child(text(answer).text_color(move || theme().muted_foreground))),
                ),
        );
    }
    list
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";

const FAQ = [
  { value: "shipping", question: "When will my order ship?", answer: "Orders placed before 2 pm leave the same day." },
  { value: "returns", question: "How do I return an item?", answer: "Print the label from your order within 30 days." },
];

function App() {
  const open = signal(["shipping"]);
  return (
    <Accordion value={open()} onChange={({ value }) => open.set(value)}>
      {FAQ.map((item) => (
        <AccordionItem value={item.value} class="border-b border-border">
          <AccordionHeader>
            <AccordionTrigger class="group flex-row items-center justify-between py-3 active:opacity-70">
              <Text class="font-medium">{item.question}</Text>
              <Text class="transition-transform group-aria-expanded:rotate-180">⌄</Text>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel reveal accessibilityLabel={item.question}>
            <View class="pb-3">
              <Text class="text-muted-foreground">{item.answer}</Text>
            </View>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

mount(App);
```

The parts come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the app's: a
trigger's press reports the next `value` with `onChange`, and the accordion opens the items whose values the app passes
back. Each part finds the one around it on its own, so the app arranges them freely: dividers between the items, a badge
in a heading, an icon before a title. In Rust, `accordion()`, `accordion_item()`, `accordion_header()`,
`accordion_trigger()` and `accordion_panel()` make them, with a setter per prop and `.child(..)` for what is inside.

## Props

### Accordion

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string[]` | `[]` | The open items' `value`s. The app owns them: a trigger's press reports the next ones with `onChange`, and the accordion shows the ones the app passes back. |
| `multiple` | `.multiple(..)` | `boolean` | `false` | Several items open at once: opening one leaves the others open. Without it, opening an item closes the one that was. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | Every item is disabled: no trigger takes presses, and screen readers say each is dimmed. |
| `children` | `.child(..)` | `JSX.Element` | none | The items, and whatever the app lays out between them (dividers). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The stack's layout and look: a card around the items, the gap between them. |

### AccordionItem

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | required | What identifies the item in the accordion's `value`: the app's own id, never its title, which changes with the language. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | Its trigger takes no presses, and screen readers say it is dimmed. It stays open or closed as the accordion's `value` says. |
| `children` | `.child(..)` | `JSX.Element` | none | The item's header and panel, and whatever else the app lays out in it. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The section: a divider under it, a card around it. |

### AccordionHeader

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `level` | `.level(..)` | `number` | `3` | The heading's level among the page's headings, for screen readers (1 the top). |
| `children` | `.child(..)` | `JSX.Element` | none | The item's trigger, and whatever else the header holds (a badge, an action of its own). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The heading's layout. |

### AccordionTrigger

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `expandedStyle` | `.expanded_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The trigger's style while its item is open, as `aria-expanded:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say, when the children have no text that says it. |
| `children` | `.child(..)` | `JSX.Element` | none | The title and the chevron; `group-aria-expanded:` classes inside follow the trigger with `group` on its `class`. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The trigger itself: the row the user presses. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The trigger's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

### AccordionPanel

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `reveal` | `.reveal(..)` | `boolean` | `false` | Opens and closes with a reveal, as `Collapsible`'s: the panel clips its content and its height springs from zero to the content's own and back, critically damped (about 265 ms, no overshoot), and the items after it move along. With reduced motion it opens and closes at once. |
| `keepMounted` | `.keep_mounted(..)` | `boolean` | `false` | The content stays in the tree while the item is closed, out of sight, of the keyboard focus and of screen readers: a video keeps its place, a web view its page. Without it the content leaves the tree as the panel closes (once the reveal has closed it) and comes back as it was. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the region: usually the item's title, as its header says it. |
| `children` | `.child(..)` | `JSX.Element` | none | The content. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The region's layout and look. With `reveal` the panel is in the layout while closed, zero high, so its padding and borders go on a view of its content. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange({ value })` (`Accordion`) | `.on_change(\|value: &Vec<SharedString>\| ..)` | A trigger was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. `value` is the open items' values as they would be: an open item's value leaves it, a closed one's joins it at the end, or, without `multiple`, replaces it. It runs before anything changes: set `value` to follow it. |

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The stack | | `Accordion`'s `class`, `style` | |
| An item | the stack | `AccordionItem`'s `class`, `style` | the app's value |
| The heading | the item | `AccordionHeader`'s `class`, `style` | |
| The trigger | the heading | `AccordionTrigger`'s `class`, `style` | `aria-expanded:`, `disabled:`, `active:`, `hover:`, `focus:` (or `expandedStyle`, `disabledStyle`, ...) |
| The title and chevron | the trigger | their own elements (`children`) | `group-aria-expanded:`, `group-disabled:` with `group` on the trigger's `class` |
| The panel | the item, after the heading | `AccordionPanel`'s `class`, `style` | |
| The content | the panel | its own elements (`children`) | |

Without `reveal`, a closed panel is out of the layout and its content out of the tree. With `reveal`, the change is a
layout animation of the commit that changes `value` (as `LayoutAnimation.configureNext`, run natively, so no
JavaScript runs while it moves): the opening panel grows from zero to its content's height, the closing one shrinks
back, both in the same spring, and the items after them move along. A transition of the app's goes with it: the
chevron turns (`transition-transform group-aria-expanded:rotate-180`).

## Disabled

A disabled item's trigger takes no presses, and screen readers announce it as dimmed; `disabled:` classes on the
trigger and `group-disabled:` inside it follow. The accordion's `disabled` disables every item. A disabled item still
shows what the app's `value` says: the app can open it.

## Accessibility

- The stack is a group, each header a heading of its `level`, and each trigger a button inside it that says whether
  its item is expanded. Screen readers can move from heading to heading.
- An open panel is a region, named by its `accessibilityLabel`; a closed one is hidden from screen readers, kept
  content included.
- The look of the open item is the app's, and should not rest on color alone: turn the chevron, as the examples do.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

Where views that take presses are stops of the keyboard focus (macOS and the web), each trigger is a stop, in the
order of the page, and Space and Return press it. Disabled triggers are skipped, and so is the content of a closed
panel. Tab moves from a trigger into its open panel's controls and on to the next trigger.

## Platform notes

- Every platform shows an open item's panel under its heading and leaves a closed one out of the layout (zero high
  with `reveal`).
- With `reveal`, every platform springs the panels' heights on its own animator (iOS, Android, macOS, Windows, Linux,
  GPUI and the web), and opens and closes them at once while the system asks for reduced motion.
- Each platform's screen reader hears the heading and its level as it reads headings, and the trigger inside it as
  a button with its expanded state; on iOS, VoiceOver reads the trigger itself.
- iOS, Android and Mac Catalyst: a trigger's press is a tap. Desktops (macOS, Windows, Linux, GPUI) and the web: a
  click, and Space or Return on the focused trigger on macOS and the web.
