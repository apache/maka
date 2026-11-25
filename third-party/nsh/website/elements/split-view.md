---
title: SplitView
description: "SplitView: two or three columns of navigation stacks side by side (a sidebar, an optional content column and the detail) that show one at a time where the room is compact. UISplitViewController on iOS and Mac Catalyst, columns the user resizes elsewhere; which columns show is the app's value."
group: base
demo: el-split-view
---

# SplitView

A split view shows the app's navigation in columns: a sidebar (the sections or the lists), an optional content column
(the items of what the sidebar selects) and the detail. Each column is a [`NavStack`](./nav-stack.md) of its own, so
each keeps its pages and pushes and pops on its own. On iOS, iPadOS and Mac Catalyst the columns are a
`UISplitViewController`'s: the sidebar floats over the content on iPadOS 26, comes in with a swipe from the edge and
with the system's sidebar button, and the system arranges the columns as the window turns and is resized. Elsewhere
the columns stand side by side, resized by dragging their edges. Where the room is compact (a phone, a narrow window) one column shows
at a time. Which columns show is `columnVisibility`, a value the app owns.

```tsx tabs
import { horizontalSizeClass, mount, signal, Text, View } from "nsh";
import { Button, type ColumnVisibility, createNavStack, NavPage, NavStack, SplitView } from "nsh/base";
import { Window } from "nsh/desktop";

const messages = ["Welcome", "Release notes"];
const inbox = createNavStack(["inbox"]);
const message = createNavStack(["message"]);

function App() {
  const visibility = signal<ColumnVisibility>("automatic");
  const selected = signal(messages[0]);
  const open = (title: string) => {
    selected.set(title);
    // Where one column shows, the message comes in front.
    if (horizontalSizeClass() === "compact") visibility.set("detailOnly");
  };
  return (
    <SplitView
      class="flex-1"
      columnVisibility={visibility()}
      onColumnVisibilityChange={({ columnVisibility }) => visibility.set(columnVisibility)}
      sidebar={
        <NavStack state={inbox}>
          {() => (
            <NavPage title="Inbox">
              <View class="flex-1">
                {messages.map((title) => (
                  <Button onPress={() => open(title)} class="px-4 py-3">
                    <Text class="text-foreground">{title}</Text>
                  </Button>
                ))}
              </View>
            </NavPage>
          )}
        </NavStack>
      }
      detail={
        <NavStack state={message}>
          {() => (
            <NavPage title={selected()}>
              <Text class="p-4 text-foreground">{`${selected()} …`}</Text>
            </NavPage>
          )}
        </NavStack>
      }
    />
  );
}

mount(() => (
  <Window id="main">
    <App />
  </Window>
));
```

```rust tabs
use nsh_base::{ColumnVisibility, button, nav_page, nav_stack, split_view, theme};
use nsh_core::prelude::*;

const MESSAGES: [&str; 2] = ["Welcome", "Release notes"];

/// A message of the inbox: a press shows it in the detail.
fn row(
    title: &'static str,
    selected: Signal<&'static str>,
    visibility: Signal<ColumnVisibility>,
) -> impl IntoElement {
    button()
        .on_press(move || {
            selected.set(title);
            // Where one column shows, the message comes in front.
            if horizontal_size_class() == SizeClass::Compact {
                visibility.set(ColumnVisibility::DetailOnly);
            }
        })
        .px_4()
        .py_3()
        .child(text(title).text_color(move || theme().foreground()))
}

fn mail() -> impl IntoElement {
    let visibility = signal(ColumnVisibility::Automatic);
    let selected = signal(MESSAGES[0]);
    split_view()
        .flex_1()
        .column_visibility(move || Some(visibility.get()))
        .on_column_visibility_change(move |next: &ColumnVisibility| visibility.set(*next))
        .sidebar(nav_stack().child(nav_page().title("Inbox").child(
            view()
                .flex_1()
                .children(MESSAGES.map(|title| row(title, selected, visibility))),
        )))
        .detail(nav_stack().child(
            nav_page()
                .title(move || SharedString::from(selected.get()))
                .child(text(move || format!("{} …", selected.get())).p_4()),
        ))
}
```

`SplitView` comes from [`nsh/base`](../modules/nsh-base.md), `nsh_base::split_view()` in Rust, with
`ColumnVisibility`. In Rust each column is a setter that takes its stack (`.sidebar(..)`, `.content(..)`,
`.detail(..)`); in TSX each is a prop that takes a `<NavStack>`.

## Columns

- **`sidebar`**: the first column, the app's sections or lists.
- **`content`**: the middle column of three, the items of what the sidebar selects (a mailbox's messages). Without
  it the view has two columns.
- **`detail`**: the last column, what the others select.

Each column is a `NavStack`: its pages, its header, its back button and its state are the stack's, and pushing and
popping one column leaves the others as they are. The columns' widths are the platform's: on iOS UIKit's, which
follow the window; elsewhere iPadOS's defaults, the sidebar and the content column 320 points wide and the detail the
rest to start, which the user resizes by dragging. The look is the app's: the pages draw the columns' content and backgrounds, the borders between them included.

## Which columns show

| `columnVisibility` | Where there is room | Where the room is compact |
|---|---|---|
| `"automatic"` (default) | iPadOS decides by the window's size and orientation, keeping what the user shows; elsewhere every column | The sidebar |
| `"all"` | Every column | The sidebar |
| `"doubleColumn"` | The content and the detail; with two columns, both | The content; with two columns, the sidebar |
| `"detailOnly"` | The detail | The detail |

Without `columnVisibility` the view keeps its own value, starting from `"automatic"`. With it, the app owns the
value and changes it in `onColumnVisibilityChange({ columnVisibility })`, which reports what the user or the system
shows instead: iPadOS's sidebar button, a swipe from the edge, a press beside a column shown over the detail, going
back from a column's first page on a phone. When the app keeps another value, the view shows the app's again. Under
`"automatic"` the view keeps what the user shows; the changes iPadOS makes as the window turns or is resized belong to
`"automatic"` itself, so the user's are the ones reported.

## Phones and narrow windows

Where the window is horizontally compact
([`horizontalSizeClass()`](../modules/nsh.md#horizontalsizeclass--verticalsizeclass) is `"compact"`,
`horizontal_size_class()` in Rust), one column shows, the first `columnVisibility` shows. A selection that should
bring the detail in front sets `"detailOnly"` then, as the example above does.

- **iOS, iPadOS and Mac Catalyst**: where the window is horizontally compact (an iPhone, an iPad in Slide Over or a
  narrow Split View or Stage Manager window) the split collapses into one navigation stack of the columns' pages: the
  sidebar's, then the content's and the detail's, as far as `columnVisibility` goes, with the system's back button and
  swipe back between them. A page pushed on any column is pushed there. Going back from a column's first page shows
  the column before, reported with `onColumnVisibilityChange` (`"detailOnly"` becomes `"doubleColumn"` with three
  columns, `"all"` with two); a page left that is not its column's first is popped as in any stack. Widened again,
  each column takes its pages back.
- **Android, the desktops and the web**: where the window is horizontally compact (below 600 points of its width),
  the column shows alone, full size. The app shows the way back to the column before: a back button in the column's
  header, or [`BackHandler`](../modules/nsh-mobile.md#backhandler) on Android.

On every platform each column keeps its pages and their state across both presentations.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `sidebar` | `.sidebar(..)` | `JSX.Element` | none | The first column: a `NavStack`. |
| `content` | `.content(..)` | `JSX.Element` | none | The middle column of three: a `NavStack`. Without it the view has two columns. |
| `detail` | `.detail(..)` | `JSX.Element` | none | The last column: a `NavStack`. |
| `columnVisibility` | `.column_visibility(..)` | `ColumnVisibility` | none | Which columns show (controlled): `"automatic"`, `"all"`, `"doubleColumn"` or `"detailOnly"`. Without it the view keeps its own, from `"automatic"`. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The view itself: its size in its parent (`flex-1`). It stays within its bounds and takes no minimum size from its columns. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onColumnVisibilityChange` | `.on_column_visibility_change(\|v: &ColumnVisibility\| ..)` | `{ columnVisibility }`: the user or the system changed which columns show, to `"all"`, `"doubleColumn"` or `"detailOnly"`. |

## Accessibility

- Each column's pages are its stack's, read in column order, the sidebar first. On iOS the system's sidebar button
  and back buttons are VoiceOver's as in any `UISplitViewController`.
- Where one column shows, only that column is on screen for screen readers.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- **iOS, iPadOS and Mac Catalyst**: `UISplitViewController` with two or three columns, each the
  `UINavigationController` of its `NavStack`. iPadOS 26 floats the sidebar over the content in Liquid Glass. The
  swipe from the edge and the sidebar button are the system's.
- **Android, the desktops and the web**: the columns stand side by side; the user drags the sidebar's edge and the
  boundary between the columns to resize them. A [`DockArea`](./dock.md) is the workspace whose columns the user also
  rearranges.
