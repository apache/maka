---
title: List
description: List, a virtualized and recycling list on a native scroll view, with all its props, events and ref methods.
order: 2.1
---

# List

`nsh` exports `List`: a virtualized list on a native scroll view. Only the rows near the viewport exist, and their cells are reused as you scroll. Which rows exist, where they are, columns, sticky headers and viewability are all computed natively, so scrolling a list of ten thousand items runs no JS except the row bindings that change when a cell is reused.

```ts
import { List, type ListProps, type ViewToken, type ViewabilityConfig } from "nsh";
```

See [Lists](../docs/lists.md) for the guide and [`<List>`](../elements/list.md) for the element's props.

## List

```ts
function List<T>(props: ListProps<T>): JSX.Element;
```

```tsx
import { List, mount, Text, View } from "nsh";

const contacts = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Contact ${i}` }));

function App() {
  return (
    <List each={contacts} estimatedItemSize={48} style={{ flex: 1 }}>
      {(item, index) => (
        <View style={{ height: 48, paddingHorizontal: 16, justifyContent: "center", backgroundColor: index() % 2 ? "#f8fafc" : "#fff" }}>
          <Text>{item().name}</Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

### Rows are recycled

`children` is a function that renders **one cell**. It runs once per cell, not once per item: when a cell scrolls out of view it is reused for another item, and `item()` and `index()` (both accessors) change. Read them inside JSX expressions (`{item().name}`) so the cell updates when it is reused.

> [!WARNING]
> Do not keep per-item state in signals created inside the row function: the cell is reused for other items and the signal would follow the cell, not the item. Keep it in your data, keyed by id (a signal holding a `Set` of selected ids, for example).

## Props

`ListProps<T>` combines the list's own props with the scrolling props shared with `<Scroll>` and the props every
element takes, which go to the list's scroll view.

### Data and rendering

| Prop | Type | Default | Description |
|---|---|---|---|
| `each` | `readonly T[]` | (required) | The items. Pass a signal's value (`each={items()}`) to follow changes; inserting items above the visible rows keeps those rows in place. |
| `children` | `(item: () => T, index: () => number) => JSX.Element` | (required) | Renders one row (see above). |
| `estimatedItemSize` | `number` | `50` | The size of rows not measured yet, in points, along the list's axis. Close estimates make the scroll indicator and `scrollToIndex` more accurate. |
| `numColumns` | `number` | `1` | Items per row (vertical lists): a grid. |
| `horizontal` | `boolean` | `false` | Scrolls sideways. |
| `inverted` | `boolean` | `false` | Lays out from the end, item 0 last (chat style); starts scrolled to the end and keeps its distance from the end as content changes. |
| `stickyHeaderIndices` | `number[]` | | Items that stick to the start while scrolled past (one column, not inverted). |
| `header` | `ListSlot` | | Rendered before the items. |
| `footer` | `ListSlot` | | Rendered after the items. |
| `empty` | `ListSlot` | | Shown instead of the items while `each` is empty. |
| `separator` | `ListSlot` | | Rendered between items (one column). |
| `keyExtractor` | `(item: T, index: number) => string` | `item.key`, `item.id`, or the index | The key of an item in viewability tokens. |
| `initialScrollIndex` | `number` | | Scrolls to this item before the first frame. |
| `contentStyle` | `ListContentStyle` | | Padding and gaps of the content: `padding`, `paddingHorizontal`, `paddingVertical`, `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`, `gap`, `rowGap`, `columnGap` (numbers). |
| `contentClass` | `string` | | Padding and gaps of the content as classes (`p-*`, `gap-*`); `contentStyle` wins over them. |
| `style` | `StyleProp<ViewStyle>` | | The list's own style (give it a size: `flex: 1` or a height). |
| `testID` | `string` | | The id UI tests find the list's scroll view by (`nsh test`'s `id:`, XCUITest, UI Automator). |
| `ref` | `ListRef \| ((node: ListRef) => void)` | | See [ref methods](#ref-methods). |

`ListSlot` is a component (`Header`) or an element (`<Header />`).

### Loading, refreshing and viewability

| Prop | Type | Default | Description |
|---|---|---|---|
| `onLoadMore` | `() => void` | | Called when the end comes within `loadMoreThreshold` viewports: load more. |
| `loadMoreThreshold` | `number` | `1` | How close to the end (in viewport lengths) `onLoadMore` fires. |
| `onLoadMoreAtStart` | `() => void` | | Called when the start comes within `loadMoreAtStartThreshold` viewports after the user or a scroll command moved the list: load what comes before the first item. |
| `loadMoreAtStartThreshold` | `number` | `1` | How close to the start (in viewport lengths) `onLoadMoreAtStart` fires. |
| `refreshing` | `boolean` | | The pull-to-refresh spinner shows. |
| `onRefresh` | `() => void` | | Enables pull to refresh; set `refreshing` while you load. |
| `refreshIndicator` | `{ height: number }` | | The app draws its own pull-to-refresh indicator, `height` tall, in place of the spinner. |
| `pullValue` | `AnimatedValue` | | Fed with how far the list is pulled past its top, for that indicator. |
| `onViewableItemsChange` | `(info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => void` | | Items that became or stopped being viewable. |
| `viewabilityConfig` | `ViewabilityConfig` | | When an item counts as viewable. |

```ts
interface ViewToken<T> {
  item: T;
  key: string;
  index: number;
  isViewable: boolean;
}

interface ViewabilityConfig {
  /** How much of the viewport an item must cover to count as viewable, from 0 to 1. */
  viewAreaCoverageThreshold?: number;
  /** How much of an item must be visible, from 0 to 1. Without either threshold, any visible pixel counts. */
  itemVisibleThreshold?: number;
  /** Milliseconds items must stay viewable before they are reported. */
  minimumViewTime?: number;
}
```

### Scrolling

| Prop | Type | Default | Description |
|---|---|---|---|
| `scrollbar` | `boolean \| ScrollbarTheme` | `true` | The scroll indicator shows: the platform's, or the app's [built-in bar](../elements/scrollbar.md#built-in-bars); an object is a theme of the view's own. |
| `scrollable` | `boolean` | `true` | The user can scroll it. |
| `bounces` | `boolean` | `true` | Overscroll past the edges. |
| `pagingEnabled` | `boolean` | `false` | Stops at multiples of the viewport. |
| `snapToInterval` | `number` | `0` | Stops at multiples of this length (0: off). |
| `snapToOffsets` | `number[]` | | Stops at these offsets. |
| `snapToAlignment` | `"start" \| "center" \| "end"` | `"start"` | Which point of an item aligns with the viewport with `snapToInterval`. |
| `disableIntervalMomentum` | `boolean` | `false` | A fling moves one snap point at most. |
| `decelerationRate` | `"normal" \| "fast" \| number` | platform | How fast a fling slows down (`0.998` / `0.99`, or the velocity kept per millisecond). |
| `contentInset` | `Partial<Edges>` | | Room around the content. |
| `contentOffset` | `{ x?, y? }` | | Where it starts. |
| `keyboardShouldPersistTaps` | `"never" \| "always" \| "handled" \| boolean` | `"never"` | Whether a tap dismisses the keyboard (`"never"`: the tap only dismisses it). |
| `keyboardDismissMode` | `"none" \| "on-drag" \| "interactive"` | `"none"` | Whether dragging dismisses the keyboard. |
| `scrollEventThrottle` | `number` | | Minimum milliseconds between `onScroll` events (at most one per frame anyway). |
| `scrollValue` | `AnimatedValue` | | A [animated value](./nsh.md#animation) fed with the scroll offset (main axis) on the UI thread, for scroll-linked effects. |

### Scroll events

| Event | Payload | When |
|---|---|---|
| `onScroll` | `ScrollEvent`: `{ offset, contentSize, size, zoomScale }` | While scrolling. |
| `onScrollDragStart` | `{ offset }` | A drag starts. |
| `onScrollDragEnd` | `{ offset }` | The finger lifts. |
| `onMomentumStart` | `{ offset }` | A glide starts after the drag. |
| `onMomentumEnd` | `{ offset }` | The glide ends (also when a new drag catches it). |
| `onScrollEnd` | `{ offset }` | Scrolling came to rest. |

Lists also take the props every element takes ([common props](../elements/index.md)).

## Ref methods

A list's `ref` receives a `ListRef`, with these methods besides `ViewRef`'s:

| Method | Description |
|---|---|
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | Scrolls item `index` into view. `viewPosition` places it: `0` at the start of the viewport (default), `0.5` in the middle, `1` at the end; `viewOffset` shifts it further. Resolved natively with the measured (or estimated) row sizes. |
| `scrollToOffset({ offset, animated? })` | Scrolls to a content offset along the list's axis. |
| `scrollToEnd({ animated? })` | Scrolls to the end of the content (the start of an inverted list). |
| `scrollTo({ x?, y?, animated? })` | Scrolls to an offset. |

```tsx
import { List, type ListRef, Text, View } from "nsh";

let list!: ListRef;

<View style={{ flex: 1 }}>
  <Text onPress={() => list.scrollToIndex({ index: 60, viewPosition: 0.5 })}>Jump to 60</Text>
  <List ref={list} each={items} numColumns={3} estimatedItemSize={90} style={{ flex: 1 }}
        contentStyle={{ padding: 12, gap: 8 }}>
    {(item) => <View style={{ height: 90, backgroundColor: "#e0e7ff" }}><Text>{item().title}</Text></View>}
  </List>
</View>
```

## Examples

A chat: newest message at the bottom, older messages loaded as you scroll up.

```tsx
<List
  each={messages()}
  inverted
  estimatedItemSize={44}
  style={{ flex: 1 }}
  contentStyle={{ padding: 12, gap: 6 }}
  keyboardDismissMode="interactive"
  onLoadMore={loadOlder}
  loadMoreThreshold={0.5}
>
  {(m) => (
    <View style={{ alignSelf: m().mine ? "flex-end" : "flex-start", maxWidth: "75%", padding: 10, borderRadius: 14, backgroundColor: m().mine ? "#6366f1" : "#e2e8f0" }}>
      <Text style={{ color: m().mine ? "#fff" : "#0f172a" }}>{m().text}</Text>
    </View>
  )}
</List>
```

Pull to refresh:

```tsx
const refreshing = signal(false);
const refresh = async () => {
  refreshing.set(true);
  items.set(await load());
  refreshing.set(false);
};

<List each={items()} refreshing={refreshing()} onRefresh={refresh} style={{ flex: 1 }}>
  {(item) => <Text style={{ padding: 16 }}>{item().title}</Text>}
</List>
```

## ListItemsProps

```ts
type ListItemsProps<T> = Pick<ListProps<T>,
  "each" | "children" | "keyExtractor" | "stickyHeaderIndices" | "initialScrollIndex"
  | "onViewableItemsChange" | "viewabilityConfig" | "refreshing" | "onRefresh"
  | "onLoadMore" | "loadMoreThreshold"
  | "header" | "footer" | "empty">;
```

The data-and-rows half of `ListProps`: what you pass to a component of your own that lays out a list itself, such as a settings list that wraps `List` with its own padding and dividers.
