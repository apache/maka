---
title: Pagination
description: "The Pagination component: the pages of a set to move among, with the pages around the current one, ellipses, Previous and Next, a compact pager, the keyboard and the current page for screen readers, styled by the app."
group: base
demo: el-pagination
---

# Pagination

A pagination moves among the pages of a set: search results, the rows of a table, an archive. It shows Previous, the
pages around the current one (the first and the last always, an ellipsis for each run left out), the app's children and
Next. It owns the behavior: which pages show, presses, the keyboard, Previous and Next disabled at the ends, the
navigation landmark and the current page for screen readers. The look is the app's: the items have no color, size or
label of their own, and the app styles them or draws them.

```rust tabs
use nsh_base::{pagination, theme};
use nsh_core::prelude::*;

fn results() -> impl IntoElement {
    let page = signal(1u32);
    pagination()
        .page(move || page.get())
        .total_pages(24)
        .accessibility_label("Search results")
        .previous_accessibility_label("Previous")
        .next_accessibility_label("Next")
        .item_class("min-w-9 h-9 px-2 items-center justify-center rounded-md hover:bg-accent selected:bg-primary selected:text-primary-foreground disabled:opacity-50")
        .gap_1()
        .on_change(move |p: &u32| page.set(*p))
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { Pagination } from "nsh/base";

function App() {
  const page = signal(1);
  return (
    <Pagination
      page={page()}
      totalPages={24}
      accessibilityLabel="Search results"
      previousAccessibilityLabel="Previous"
      nextAccessibilityLabel="Next"
      class="gap-1"
      itemClass="min-w-9 h-9 px-2 items-center justify-center rounded-md hover:bg-accent selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      onChange={({ page: next }) => page.set(next)}
    />
  );
}

mount(App);
```

`Pagination` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust,
`pagination()` makes one with a setter per prop (`.page(..)`, `.total_pages(..)`), `.on_change(..)` for the page the
user picks, the typed style methods for the row and `.child(..)` for the app's content.

## The page

The page is the app's: `page` is the current one, from 1, and `onChange({ page })` reports the page the user picked
with a press on a page, on Previous or on Next. The app sets it, loads that page and shows its rows. `totalPages` is
how many there are; a `page` past the last shows the last. The current page reports nothing when pressed, and neither
do Previous on the first page and Next on the last.

## The pages shown

With `visiblePages` (at least 5, the default) the row shows every page while they fit. Past that it shows the first and
the last page, the current one with as many pages on each side as fit, `(visiblePages - 3) / 2`, and an ellipsis for
each run of pages left out:

| `page` of 20, `visiblePages={7}` | Shown |
|---|---|
| 1 | `1 2 3 4 5 … 20` |
| 6 | `1 … 4 5 6 7 8 … 20` |
| 20 | `1 … 16 17 18 19 20` |

Ten thousand pages show the same seven items. An odd `visiblePages` centers the current page.

## Items

Each item takes the app's `itemClass` and `itemStyle`: the current page is `selected:`, an item that takes no press
`disabled:`, the item with the keyboard focus `focus:`. The row is the app's to lay out with `class` (a row by
default; `gap-*`, `justify-*`).

Without `renderItem` a page shows its number, an ellipsis `…`, and Previous and Next their accessibility labels (`‹` and
`›` without them). `renderItem` draws each item's content from a `PaginationItemState`:

| Field | Type | Description |
|---|---|---|
| `kind` | `"previous" \| "page" \| "ellipsis" \| "next"` | What the item is. |
| `page` | `number` | A page's number; the page Previous or Next goes to (the current one at the ends); an ellipsis's first hidden page. |
| `start`, `end` | `number` | An ellipsis's hidden pages: `start` included, `end` (the next page shown) not. |
| `current` | `boolean` | The current page. |
| `disabled` | `boolean` | It takes no press: Previous on the first page, Next on the last, everything of a disabled pagination. |

```tsx
<Pagination
  page={page()}
  totalPages={pages()}
  previousAccessibilityLabel="Previous page"
  nextAccessibilityLabel="Next page"
  itemClass="size-9 items-center justify-center rounded-md selected:bg-primary"
  renderItem={(item) =>
    item.kind === "previous" ? <Icon name="chevron-left" /> :
    item.kind === "next" ? <Icon name="chevron-right" /> :
    item.kind === "ellipsis" ? <JumpMenu from={item.start!} to={item.end!} onPick={(p) => page.set(p)} /> :
    <Text class={item.current ? "font-semibold text-primary-foreground" : "text-foreground"}>{item.page}</Text>
  }
  onChange={({ page: next }) => page.set(next)}
/>
```

An ellipsis takes no press of its own: what it does is the app's. A `Menu` drawn in it lists the pages it hides, as
`JumpMenu` above does.

## Compact

`compact` shows Previous, the children and Next only: a pager for a narrow screen, the page told in the children.

```tsx
<Pagination compact page={page()} totalPages={12} onChange={({ page: next }) => page.set(next)} class="items-center gap-3">
  <Text class="text-sm text-muted-foreground">{`${page()} of 12`}</Text>
</Pagination>
```

The children sit after the pages and before Next in either form: a page count, a field to go to a page.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `page` | `.page(..)` | `number` | required | The current page, from 1; the app sets it in `onChange`. |
| `totalPages` | `.total_pages(..)` | `number` | required | How many pages there are, at least 1. |
| `visiblePages` | `.visible_pages(..)` | `number` | `5` | The most pages shown at once, the first and the last included; at least 5. |
| `compact` | `.compact(..)` | `boolean` | `false` | Previous, the children and Next only. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No item takes a press or the keyboard focus; `disabled:` styles apply, and screen readers say they are dimmed. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the navigation: what it pages through. |
| `previousAccessibilityLabel`, `nextAccessibilityLabel` | `.previous_accessibility_label(..)`, `.next_accessibility_label(..)` | `string` | none | What screen readers say for Previous and Next, and their content without `renderItem`. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(\|s\| ..)` | `string`, `StyleProp<TextStyle>` | none | Each item's look: `selected:` on the current page, `disabled:`, `focus:`; text styles pass to its content. |
| `renderItem` | `.render_item(\|s: &PaginationItemState\| ..)` | `(item: PaginationItemState) => JSX.Element` | none | Draws each item's content from its state. |
| `children` | `.child(..)` | `JSX.Element` | none | The app's content after the pages, before Next. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The row's look and layout. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|page: &u32\| ..)` | `{ page }`: the page the user picked with a page, Previous or Next. The current page is never reported. |

## Motion

The current page moves from item to item as the app's `selected:` classes say: `transition-colors` on `itemClass` fades
the highlight from the page left to the page reached. A page change keeps every item in place and changes what the items
show, so the row never flickers; the app's transitions stand still with reduced motion (`motion-reduce:transition-none`).

## Accessibility

- The row is a navigation landmark named by `accessibilityLabel`.
- Each page, Previous and Next is a button. The current page is said as the current page (ARIA's
  `aria-current="page"`) and is selected; Previous on the first page and Next on the last are dimmed.
- On macOS and the web each page, Previous and Next is a stop of the keyboard focus, and Return and Space press it. A
  page pressed from the keyboard keeps the focus once the app shows it, wherever it lands in the row, and so does the
  first or the last page when Previous or Next reaches it.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on an item.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click; on macOS and the web, Tab reaches the items.
- Every platform draws what the app styles.
