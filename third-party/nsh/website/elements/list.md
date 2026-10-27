---
title: List
description: "The virtualized, recycling list: rows, columns, sticky headers, inverted chat lists, viewability and scrolling to items."
order: 7
group: primitives
demo: el-list
---

# List

`List` shows long or unbounded data. The rows near the viewport exist: as the user scrolls, rows that leave are
recycled for the rows that come in. Which rows exist, their positions, columns, sticky headers and viewability are all
computed natively, so scrolling a list of thousands of items costs as much as a list of twenty. Rust makes one with
`virtual_list(count, |at| row)`, TSX with `<List>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
struct Contact {
    id: usize,
    name: String,
}

fn app() -> impl IntoElement {
    let contacts = signal(
        (0..1000).map(|i| Contact { id: i, name: format!("Contact {}", i + 1) }).collect::<Vec<_>>(),
    );
    virtual_list(move || contacts.with(|c| c.len()), move |at| {
        view().h(px(56.0)).px_4().justify_center().child(
            text(move || contacts.with(|c| format!("{}. {}", at.index() + 1, c[at.index()].name)))
                .text_base(),
        )
    })
    .estimated_item_size(px(56.0))
    .flex_1()
}
```

```tsx tabs
import { List, mount, Text, View } from "nsh";

const contacts = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `Contact ${i + 1}` }));

function App() {
  return (
    <List each={contacts} estimatedItemSize={56} style={{ flex: 1 }}>
      {(contact, index) => (
        <View style={{ height: 56, paddingHorizontal: 16, justifyContent: "center" }}>
          <Text style={{ fontSize: 16 }}>
            {index() + 1}. {contact().name}
          </Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

In TSX, `List` is generic: `List<T>` checks that `each` and the row function agree on the item type, which TypeScript
infers from `each` (see the [List API](../modules/nsh-list.md)). In Rust, `virtual_list` takes the number of rows (a
value, a signal or a closure: the list grows and shrinks in place) and the function that builds the row at a
`Position`; the rows read the component's data by `at.index()`.

For a short list whose rows should all exist (a settings page, a form), an [`Each`](./control-flow.md) inside a
[scroll view](./scroll.md) is simpler. For a list styled as a grouped table, see
[a settings-style list](../docs/lists.md#a-settings-style-list). The [lists guide](../docs/lists.md) covers patterns:
infinite loading, chat, sections.

## Rows are recycled

The row function runs once per cell, not once per item. When a cell is reused for another item, its position changes
(TSX: the `item()` and `index()` accessors; Rust: `at.index()`) and everything that reads it updates:

```rust tabs
virtual_list(move || messages.with(|m| m.len()), move |at| {
    text(move || messages.with(|m| m[at.index()].body.clone()))
})
```

```tsx tabs
<List each={messages()}>
  {(message) => <Text>{message().body}</Text>}
</List>
```

So keep per-item state in your data (keyed by id), not in signals created inside the row function: such a signal stays
with the cell and shows up on another item.

Cells waiting for their next item are hidden once their row is gone or shown by another cell, so screen readers,
touches and UI tests meet each row once.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `each` | `virtual_list(count, ..)` | `readonly T[] \| ReadonlyListSource<T>` | | The items: an array or an [indexed snapshot](../modules/nsh-list.md#data-and-rendering). |
| `children` | `virtual_list(.., \|at\| row)` | `(item: () => T, index: () => number) => JSX.Element` | | Renders one row. |
| `estimatedItemSize` | `.estimated_item_size(px(..))` | `number` | `50` | The size of items not measured yet, in points. Close estimates keep the scroll bar steady. |
| `horizontal` | `.horizontal()` | `boolean` | `false` | Scrolls sideways. |
| `viewport` | `.viewport(ListViewport::..)` | `"own" \| "parent"` | `"own"` | `"own"`: the list scrolls in a scroll view of its own. `"parent"`: it lies at its full length in its parent's layout and renders the rows near the viewport of the scroll view around it, which scrolls it with the rest of the page (see [lists in a page](../docs/lists.md#lists-in-a-page-viewportparent)). Chosen when the list is made. |
| `numColumns` | `.columns(n)` | `number` | `1` | Items per row (vertical lists). |
| `inverted` | `.inverted()` | `boolean` | `false` | Laid out from the end, item 0 last (chat style): starts scrolled to the end and keeps its distance from the end as content changes. |
| `maintainVisibleContentPosition` | `.follow_end(px(threshold))` | `{ autoscrollToBottomThreshold?: number }` | | For lists that are not inverted: at the end of the content, or within that many points of it, the list stays at the end as the content grows or the viewport shrinks; scrolled further up, the visible content stays. |
| `stickyHeaderIndices` | `.sticky_header_indices([..])` | `number[]` | | Items that stick to the start while scrolled past (one column, not inverted). |
| `contentStyle` | `.content_padding(..)`, `.content_padding_x(..)`, `.row_gap(..)`, `.column_gap(..)`, … | `ListContentStyle` | | Padding and gaps of the content, in points: `padding`, `paddingHorizontal`, `paddingVertical`, `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`, `gap`, `rowGap`, `columnGap`. |
| `contentClass` | | `string` | | Padding and gaps of the content as classes (`p-*`, `gap-*`); `contentStyle` wins over them. |
| `header` | `.header(el)` | `ListSlot` | | Before the items: a component (`Header`) or an element (`<Header />`). |
| `footer` | `.footer(el)` | `ListSlot` | | After the items. |
| `empty` | `.empty(el)` | `ListSlot` | | Shown instead of the items while `each` is empty. |
| `separator` | `.separator(\|\| el)` | `ListSlot` | | Between items (one column). |
| `initialScrollIndex` | `.initial_scroll_index(i)` | `number` | | Scrolls to this item before the first frame. |
| `keyExtractor` | `.keys(\|\| ids)` | `(item: T, index: number) => string` | `item.key`, `item.id` or the index | The key of an item in viewability tokens. In Rust, the rows' identities, so rows keep their cells and sizes when rows come and go before them. |
| `onLoadMore` | `.on_load_more(..)` | `() => void` | | The end is near: load more. |
| `loadMoreThreshold` | `.load_more_threshold(viewports)` | `number` | `1` | How close to the end (in viewports) `onLoadMore` fires. |
| `onLoadMoreAtStart` | `.on_load_more_at_start(..)` | `() => void` | | The start is near, after the user or a scroll command moved the list: load what comes before the first item. |
| `loadMoreAtStartThreshold` | `.load_more_at_start_threshold(viewports)` | `number` | `1` | How close to the start (in viewports) `onLoadMoreAtStart` fires. |
| `onViewableItemsChange` | `.on_viewable_items_change(..)` | `(info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => void` | | Items became viewable or stopped being viewable. |
| `viewabilityConfig` | `.viewability(..)`, `.minimum_view_time(..)` | `ViewabilityConfig` | | When items count as viewable (below). |
| `refreshing` | `.refreshing(..)` | `boolean` | | The pull-to-refresh spinner shows. |
| `onRefresh` | `.on_refresh(..)` | `() => void` | | The user pulled to refresh. |
| `refreshIndicator` | `.refresh_indicator(Some(height))` | `{ height: number }` | | The app draws its own indicator, `height` points tall: the platform's spinner is hidden, a pull refreshes once it reaches `height`, and refreshing keeps `height` above the content. A height of 0 or less is none. |
| `pullValue` | `.pull_value(&value)` | `AnimatedValue` | | An animated value fed with how far the list is pulled past its top (0 at rest, growing with the pull; the room kept above the content while it refreshes: `height` with `refreshIndicator`), for the app's indicator. |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | The scroll indicator shows. On the desktop and in desktop browsers a horizontal view keeps it: it is the mouse's scroll bar. |
| `scrollValue` | `.scroll_value(&value)` | `AnimatedValue` | | An animated value fed with the scroll offset, for scroll-linked animations. |
| `keyboardDismissMode` | `.keyboard_dismiss_mode(..)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | Whether dragging dismisses the keyboard. |
| `style` | `Styled` methods | `StyleProp<ViewStyle>` | | The list's own style (it needs a bounded size: `flex: 1` or a height). |
| `testID` | `.test_id(id)` | `string` | | The id UI tests find the list's scroll view by (`nsh test`'s `id:`, XCUITest, UI Automator). |
| `ref` | `.element_ref(&handle)` | `YNode \| (node: YNode) => void` | | The list's node (see [ref methods](#ref-methods)). |

Lists also take the scrolling props of [`Scroll`](./scroll.md#scrolling) (the `Scrollable` methods in Rust):
`pagingEnabled`, `snapToInterval`, `snapToOffsets`, `snapToAlignment`, `disableIntervalMomentum`, `decelerationRate`,
`bounces`, `contentInset`, `contentOffset`, `keyboardShouldPersistTaps`, `scrollEventThrottle` and `scrollable`.
Lists keep their scale.

The props every element takes ([common props](./index.md#common-props)) go to the list's scroll view as they are:
`testID`, `accessibilityLabel` and the other accessibility props, the styles, `onLayout`, touch and responder props.
UI tests find a list by its `testID` as they find any view.

`ViewabilityConfig` (Rust: `Viewability { item_visible_percent, view_area_percent }` and `.minimum_view_time(..)`):

| Field | Type | Description |
|---|---|---|
| `itemVisiblePercentThreshold` | `number` | Percent of an item that must be visible. |
| `viewAreaCoveragePercentThreshold` | `number` | Percent of the viewport an item must cover. Without either threshold, any visible pixel counts. |
| `minimumViewTime` | `number` | Milliseconds items must stay viewable before they are reported. |

`ViewToken<T>` is `{ item, key, index, isViewable }`. Rust's listener gets `ViewableItems`: `indices()` is the range of
viewable rows, `changed()` the rows that came or went.

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onScroll` | `.on_scroll` | `ScrollEvent` | The offset changed. |
| `onScrollDragStart` / `onScrollDragEnd` | `.on_scroll_drag_start` / `.on_scroll_drag_end` | `{ x, y }` | Dragging started / stopped. |
| `onMomentumStart` / `onMomentumEnd` | `.on_momentum_start` / `.on_momentum_end` | `{ x, y }` | A glide started / stopped. |
| `onScrollEnd` | `.on_scroll_end` | `{ x, y }` | Scrolling came to rest. |
| `onLoadMore` | `.on_load_more` | none | Within `loadMoreThreshold` viewports of the end. |
| `onLoadMoreAtStart` | `.on_load_more_at_start` | none | Within `loadMoreAtStartThreshold` viewports of the start, once per approach after a scroll. |
| `onViewableItemsChange` | `.on_viewable_items_change` | `{ viewableItems, changed }` (`ViewableItems`) | Viewability changed. |
| `onRefresh` | `.on_refresh` | none | Pulled to refresh. |

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | `scroll_to_index(index, percentage(0.5), px(0.0), animated)` | Scrolls item `index` into view. `viewPosition` places it: 0 at the start of the viewport (default), 0.5 in the middle, 1 at the end; `viewOffset` shifts it further. Resolved natively with the current (measured or estimated) item sizes. |
| `scrollToOffset({ offset, animated? })` | `scroll_to_offset(px(..), animated)` | Scrolls to an offset along the list's axis. |
| `scrollToEnd({ animated? })` | `scroll_to_end(animated)` | Scrolls to the end of the content (the start of an inverted list). |
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point(..), animated)` | Scrolls to an offset. |

## Examples

A grid with a header and viewability:

```rust tabs
let visible = signal(SharedString::default());
let list = element_ref();

virtual_list(move || photos.with(|p| p.len()), move |at| {
    image(move || photos.with(|p| p[at.index()].url.clone())).h(px(120.0)).rounded(px(8.0))
})
.element_ref(&list)
.columns(3)
.estimated_item_size(px(120.0))
.content_padding(px(12.0))
.row_gap(px(8.0))
.column_gap(px(8.0))
.viewability(Viewability { item_visible_percent: Some(50.0), ..Viewability::default() })
.on_viewable_items_change(move |items: &ViewableItems| {
    visible.set(format!("{} visible", items.indices().count()).into())
})
.header(
    text("Jump to 60")
        .on_press(move || list.scroll_to_index(60, percentage(0.5), px(0.0), true)),
)
.flex_1()
```

```tsx tabs
const visible = signal("");
let list!: YNode;

<List
  ref={list}
  each={photos}
  numColumns={3}
  estimatedItemSize={120}
  contentStyle={{ padding: 12, gap: 8 }}
  viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
  onViewableItemsChange={({ viewableItems }) => visible.set(`${viewableItems.length} visible`)}
  header={<Text onPress={() => list.scrollToIndex({ index: 60, viewPosition: 0.5 })}>Jump to 60</Text>}
  style={{ flex: 1 }}
>
  {(photo) => <Image src={photo().url} style={{ height: 120, borderRadius: 8 }} />}
</List>;
```

A chat:

```rust tabs
virtual_list(move || messages.with(|m| m.len()), move |at| bubble(messages, at))
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .inverted()
    .estimated_item_size(px(64.0))
    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
    .flex_1()
```

```tsx tabs
<List each={messages()} inverted estimatedItemSize={64} keyboardDismissMode="interactive" style={{ flex: 1 }}>
  {(m) => <Bubble message={m()} />}
</List>
```

Item 0 is the newest message, drawn at the bottom; new messages prepended to the items appear without moving what the
user is reading.

## Platform notes

- Inserting items above the visible rows keeps the visible rows in place on both platforms.
- Horizontal lists in right-to-left layouts are mirrored natively.
- Sticky headers are pinned natively on every scroll frame.
