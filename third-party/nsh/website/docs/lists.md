---
title: Lists
description: Long and endless lists in Rust and TSX - recycling, row identity, columns, sticky headers, inverted chat lists, horizontal lists, lists in a page, loading more, viewability and scrolling to an item.
order: 40
group: ui
demo: guide-lists
---

# Lists

A list (`virtual_list(..)` in Rust, `List` from `nsh` in TSX) renders long data on a native scroll view while only creating the rows near the screen. Which rows exist, where they go, the columns, sticky headers and which items are visible are all computed natively; your code only fills cells with content when the native side asks for one. A list of a million items costs about as much as a list of thirty.

```rust tabs
use std::rc::Rc;

use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let titles: Rc<Vec<String>> = Rc::new((1..=10_000).map(|i| format!("Item {i}")).collect());
    virtual_list(titles.len(), move |at| {
        let titles = titles.clone();
        view()
            .p_4()
            .border_b_1()
            .border_b_color(rgb(0xeaeef2))
            .child(text(move || titles[at.index()].clone()).text_size(px(16.0)))
    })
    .estimated_item_size(px(52.0))
    .flex_1()
    .bg(white())
}
```

```tsx tabs
import { List, mount, Text, View } from "nsh";

const items = Array.from({ length: 10_000 }, (_, i) => ({ id: i, title: `Item ${i + 1}` }));

function App() {
  return (
    <List each={items} estimatedItemSize={52} style={{ flex: 1, backgroundColor: "#ffffff" }}>
      {(item) => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#eaeef2" }}>
          <Text style={{ fontSize: 16 }}>{item().title}</Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

In Rust, `virtual_list(count, row)` takes the number of rows (a value, a signal or a closure) and a function that builds a row from its position (`at.index()`); the rows read your data by that index. In TSX, `each` takes the items and the row function gets the item. Like a [scroll view](./scrolling.md), the list is the viewport and needs a size from its parent (`.flex_1()`, `flex: 1` or a height).

## How recycling works

The row function is not called once per item. It is called **once per cell**, and cells are reused: when a row scrolls far off screen, its cell is given another row, and its position (`at.index()` in Rust, `item()` and `index()` in TSX) changes. Everything in the row that reads it updates in place, like any other [signal](./reactivity.md).

Two rules follow from that:

**Read the position where you use it.** A value copied out at the top of the row function belongs to whichever row the cell showed first.

```rust tabs
// Wrong: `title` stays the first row's title when the cell is reused.
virtual_list(count, move |at| {
    let title = titles[at.index()].clone();
    text(title)
})

// Right: the text follows the cell's current row.
virtual_list(count, move |at| {
    let titles = titles.clone();
    text(move || titles[at.index()].clone())
})
```

```tsx tabs
// Wrong: `title` stays the first item's title when the cell is reused.
{(item) => {
  const title = item().title;
  return <Text>{title}</Text>;
}}

// Right: the text follows the cell's current item.
{(item) => <Text>{item().title}</Text>}
```

**Keep per-item state in your data, not in the row.** A signal created inside the row belongs to the cell and travels with it to the next item. Store "is this row expanded / selected / liked" in the items or in a set keyed by id:

```rust tabs
let liked = signal(HashSet::<u32>::new());
let toggle = move |id: u32| {
    liked.update(|s| {
        if !s.remove(&id) {
            s.insert(id);
        }
    })
};

virtual_list(move || posts.with(Vec::len), move |at| {
    let post = computed(move || posts.with(|p| p[at.index()].clone()));
    view()
        .flex_row()
        .p_4()
        .child(text(move || post.with(|p| p.title.clone())).flex_1())
        .child(
            text(move || if liked.with(|s| s.contains(&post.with(|p| p.id))) { "♥" } else { "♡" })
                .on_press(move || toggle(post.with(|p| p.id))),
        )
})
.estimated_item_size(px(64.0))
.flex_1()
```

```tsx tabs
const liked = signal<Set<number>>(new Set());
const toggle = (id: number) =>
  liked.update((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

<List each={posts()} estimatedItemSize={64} style={{ flex: 1 }}>
  {(post) => (
    <View style={{ flexDirection: "row", padding: 16 }}>
      <Text style={{ flex: 1 }}>{post().title}</Text>
      <Text onPress={() => toggle(post().id)}>{liked().has(post().id) ? "♥" : "♡"}</Text>
    </View>
  )}
</List>
```

Rows can have different heights. Until a row has been measured, the list assumes the estimated item size (default 50 points); pass a value close to your typical row so the scroll indicator and jumps to far items are accurate from the start.

## Changing the data

In Rust, give the count as a signal or a closure (`move || posts.with(Vec::len)`): the list grows and shrinks in place. Rows added or removed at the end need nothing more; when rows come and go elsewhere, give their identities with `.keys(move || posts.with(|p| p.iter().map(|p| p.id).collect::<Vec<_>>()))`, and the list keeps the common start and end and treats what is between as removed and inserted.

In TSX, pass a new array to change the items: `posts.set([...posts(), ...more])`. The list compares the old and the new array **by item identity** (`===`), keeps the common start and end, and treats what is between as removed and inserted.

In both, measurements stay with their rows, and when rows are inserted above the rows on screen, the visible rows stay where they are instead of jumping.

- In TSX, update immutably: a new array, with the unchanged item objects reused. Mutating the array in place (`push`) is not seen.
- A changed item should be a new object (`{ ...post, title }`), so its row shows the change.
- Prepending (new messages, a refreshed feed) keeps the user's place.

`keyExtractor` names items in viewability tokens (below); by default the key is `item.key`, then `item.id`, then the index. It does not affect how changes are matched in TSX, which is always by identity.

## Props

A list takes every scrolling prop of the scroll view that makes sense for a list (`pagingEnabled`, `snapToInterval`, `snapToOffsets`, `snapToAlignment`, `decelerationRate`, `disableIntervalMomentum`, `bounces`, `scrollable`, `contentInset`, `contentOffset`, `keyboardShouldPersistTaps`, `keyboardDismissMode`, `scrollEventThrottle`, `onScroll`, `onScrollDragStart`, `onScrollDragEnd`, `onMomentumStart`, `onMomentumEnd`, `onScrollEnd`, `scrollValue`, `pullValue`; in Rust the same methods as a scroll view's), described in [Scrolling](./scrolling.md). Lists keep a scale of 1. Its own props:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `each` | `virtual_list(count, ..)` | `readonly T[]` | | The items; in Rust, the number of rows. |
| `children` | `virtual_list(.., row)` | `(item: () => T, index: () => number) => JSX.Element` | | Renders a cell; called once per cell, see [recycling](#how-recycling-works). |
| `estimatedItemSize` | `.estimated_item_size(px(..))` | `number` | `50` | The size of rows not measured yet, in points. |
| `horizontal` | `.horizontal()` | `boolean` | `false` | Scrolls sideways. |
| `viewport` | `.viewport(ListViewport::..)` | `"own" \| "parent"` | `"own"` | `"own"`: the list scrolls in a scroll view of its own. `"parent"`: it lies at its full length in the scroll view around it, which scrolls it with the rest of the page (see [lists in a page](#lists-in-a-page-viewportparent)). Chosen when the list is made. |
| `numColumns` | `.columns(n)` | `number` | `1` | Items per row (vertical lists). |
| `inverted` | `.inverted()` | `boolean` | `false` | Item 0 at the bottom (chat); starts at the end and keeps its distance from the end. |
| `maintainVisibleContentPosition` | `.follow_end(px(..))` | `{ autoscrollToBottomThreshold?: number }` | | A list that is not inverted stays at the end while it is within that many points of it, as content grows (see below). |
| `stickyHeaderIndices` | `.sticky_header_indices(..)` | `number[]` | | Items that stick to the top while scrolled past (one column, not inverted). |
| `stickyHeaderOffset` | `.sticky_header_offset(px(..))`, `.bind_sticky_header_offset(&node)` | `number \| AnimatedNode` | `0` | How far below the top the sticky items stick, as CSS `position: sticky`'s `top`; the content scrolls on under the space above them. An animated value moves them every frame. |
| `contentStyle` | `.content_padding(..)`, `.content_padding_x(..)`, ..., `.row_gap(..)`, `.column_gap(..)` | `{ padding*, gap, rowGap, columnGap }` | | Padding and gaps of the content, numbers only. |
| `contentClass` | | `string` | | The same as classes (`p-*`, `gap-*`); `contentStyle` wins over them. |
| `header` | `.header(..)` | component or element | | Before the items. |
| `footer` | `.footer(..)` | component or element | | After the items. |
| `empty` | `.empty(..)` | component or element | | Shown instead of the items while there are none. |
| `separator` | `.separator(\|\| ..)` | component or element | | Between items (one column). |
| `initialScrollIndex` | `.initial_scroll_index(i)` | `number` | | Scrolls to this item before the first frame. |
| `onLoadMore` | `.on_load_more(..)` | `() => void` | | The end is near (see below). |
| `loadMoreThreshold` | `.load_more_threshold(..)` | `number` | `1` | How close to the end, in viewports, `onLoadMore` fires. |
| `onLoadMoreAtStart` | `.on_load_more_at_start(..)` | `() => void` | | The start is near, after a scroll (see below). |
| `loadMoreAtStartThreshold` | `.load_more_at_start_threshold(..)` | `number` | `1` | How close to the start, in viewports, `onLoadMoreAtStart` fires. |
| `onViewableItemsChange` | `.on_viewable_items_change(..)` | `(info) => void` | | Items became or stopped being viewable. |
| `viewabilityConfig` | `.viewability(..)`, `.minimum_view_time(..)` | `ViewabilityConfig` | | When items count as viewable. |
| `keyExtractor` | `.keys(..)` | `(item, index) => string` | | The key in viewability tokens; in Rust, the rows' identities. |
| `refreshing` / `onRefresh` | `.refreshing(..)` / `.on_refresh(..)` | `boolean` / `() => void` | | Pull to refresh. |
| `refreshIndicator` | `.refresh_indicator(..)` | `{ height: number }` | | The app's own pull-to-refresh indicator, in place of the platform's spinner (see [Scrolling](./scrolling.md#an-indicator-of-your-own)). |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | The scroll indicator shows. On the desktop and in desktop browsers a horizontal view keeps it: it is the mouse's scroll bar. |
| `ref` | `.element_ref(&list)` | `YNode` | | `scrollToIndex`, `scrollToOffset`, `scrollToEnd`, `scrollTo`. |

The header, footer and empty slots take an element (in TSX also a component: `header={Header}`). They are cells of their own, never recycled, and they are reactive like any other element.

## Columns and grids

`numColumns` (`.columns(n)`) lays items out in rows of that many columns; content padding goes around the content, with gaps between rows and columns. Rows of a grid may have different heights: each row is as tall as its tallest item.

```rust tabs
let count = photos.len();
virtual_list(count, move |at| {
    let photos = photos.clone();
    image(move || photos[at.index()].thumb.clone()).aspect_square().rounded(px(8.0))
})
.columns(3)
.estimated_item_size(px(120.0))
.content_padding(px(12.0))
.row_gap(px(8.0))
.column_gap(px(8.0))
.flex_1()
```

```tsx tabs
<List
  each={photos}
  numColumns={3}
  estimatedItemSize={120}
  style={{ flex: 1 }}
  contentStyle={{ padding: 12, gap: 8 }}
>
  {(photo) => <Image src={photo().thumb} style={{ aspectRatio: 1, borderRadius: 8 }} />}
</List>
```

## Sticky headers

`stickyHeaderIndices` lists items that stick to the top of the viewport while the content scrolls past them, until the next sticky item pushes them out. Sections are one list of header and row items; the headers' indices stick. The pinning is done natively on every scroll frame.

```rust tabs
#[derive(Clone, PartialEq)]
enum Row {
    Header(String),
    Name(String),
}

let mut rows = Vec::new();
let mut headers = Vec::new();
for (letter, names) in groups {
    headers.push(rows.len());
    rows.push(Row::Header(letter));
    rows.extend(names.into_iter().map(Row::Name));
}
let count = rows.len();
let rows = Rc::new(rows);

virtual_list(count, move |at| {
    let rows = rows.clone();
    let row = computed(move || rows[at.index()].clone());
    let is_header = computed(move || matches!(row.get(), Row::Header(_)));
    let label = move || match row.get() {
        Row::Header(s) | Row::Name(s) => s,
    };
    when(is_header, move || {
        text(label).p(px(6.0)).bg(rgb(0xeaeef2)).font_weight(FontWeight::BOLD)
    })
    .otherwise(move || text(label).p_3())
})
.sticky_header_indices(headers)
.estimated_item_size(px(44.0))
.flex_1()
```

```tsx tabs
type Row = { header: string } | { name: string };

const rows: Row[] = [];
const headers: number[] = [];
for (const [letter, names] of groups) {
  headers.push(rows.length);
  rows.push({ header: letter });
  for (const name of names) rows.push({ name });
}

<List each={rows} stickyHeaderIndices={headers} estimatedItemSize={44} style={{ flex: 1 }}>
  {(row) => (
    <If
      when={"header" in row()}
      else={<Text style={{ padding: 12 }}>{(row() as { name: string }).name}</Text>}
    >
      <Text style={{ padding: 6, backgroundColor: "#eaeef2", fontWeight: "700" }}>{(row() as { header: string }).header}</Text>
    </If>
  )}
</List>
```

Because a cell may show a header now and a name later, the row decides what to render with [`when` / `<If>`](../elements/control-flow.md), which switches when the row changes. Sticky headers need one column and a list that is not inverted.

`stickyHeaderOffset` (`.sticky_header_offset(..)` in Rust) makes the headers stick that many points below the top instead, as CSS `position: sticky`'s `top` does: under a translucent bar 56 points tall, `stickyHeaderOffset={56}` (`.sticky_header_offset(px(56.0))`) keeps each header below the bar while the rows scroll on under it, and the next header pushes it out from there. A negative offset leaves part of a header out of view.

The offset can be an [animated value](./animation.md#animated-values) (`.bind_sticky_header_offset(&node)` in Rust): the headers follow it every frame on the UI thread, so they stay below a bar that moves. With a bar that hides as the content scrolls down and comes back as it scrolls up ([`diffClamp`](./animation.md#arithmetic-and-diffclamp)), the headers stick to its bottom edge wherever it is:

```rust tabs
let offset = animated_value(0.0);
let hidden = offset.diff_clamp(0.0, 56.0);
let shown = hidden.mul(-1.0).add(56.0);

view().flex_1().overflow_hidden().child(
    virtual_list(rows.len(), row)
        .scroll_value(&offset)
        .sticky_header_indices(headers)
        .bind_sticky_header_offset(&shown),
).child(view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&hidden.mul(-1.0)))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const hidden = scroll.diffClamp(0, 56);
const shown = hidden.mul(-1).add(56);

<View style={{ flex: 1, overflow: "hidden" }}>
  <List each={rows} scrollValue={scroll} stickyHeaderIndices={headers} stickyHeaderOffset={shown}>…</List>
  <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: hidden.mul(-1) }] }}>…</View>
</View>
```

## Chat: inverted lists

`inverted` lays the list out from the end: item 0 is at the bottom, the list starts scrolled to the end, and it keeps its distance from the end as items change. Keep the newest message first; prepend to add one, append to load older ones with `onLoadMore` (the "end" of an inverted list is the top). A chat opened at an old message loads the newer ones with [`onLoadMoreAtStart`](#loading-at-the-start-onloadmoreatstart); with it, the list keeps its distance from the bottom while it is there and keeps the messages on screen in place when scrolled up.

```rust tabs
#[derive(Clone, PartialEq)]
struct Message {
    id: u32,
    text: String,
    mine: bool,
}

pub fn chat() -> impl IntoElement {
    let next = stored(0_u32);
    let message = move |text: String, mine: bool| Message {
        id: next.with(|n| {
            *n += 1;
            *n
        }),
        text,
        mine,
    };
    // Newest first.
    let messages = signal(
        (0..30)
            .map(|i| message(format!("Message {}", 30 - i), i % 3 == 0))
            .collect::<Vec<_>>(),
    );
    let draft = signal(String::new());
    let send = move || {
        let text = draft.get_untracked();
        if text.trim().is_empty() {
            return;
        }
        let sent = message(text, true);
        messages.update(|m| m.insert(0, sent));
        draft.set(String::new());
    };
    let load_older = move || {
        let older: Vec<_> = (0..20).map(|i| message(format!("Older {i}"), false)).collect();
        messages.update(|m| m.extend(older));
    };
    let list = virtual_list(
        move || messages.with(Vec::len),
        move |at| {
            let mine = computed(move || messages.with(|m| m[at.index()].mine));
            view()
                .style_when(mine, |s| s.self_end().bg(rgb(0x0969da)))
                .style_when(move || !mine.get(), |s| s.self_start().bg(rgb(0xeaeef2)))
                .max_w(relative(0.75))
                .px_3()
                .py_2()
                .rounded(px(14.0))
                .child(
                    text(move || messages.with(|m| m[at.index()].text.clone()))
                        .text_color(move || if mine.get() { rgb(0xffffff) } else { rgb(0x1f2328) }),
                )
        },
    )
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .inverted()
    .estimated_item_size(px(44.0))
    .content_padding(px(12.0))
    .row_gap(px(6.0))
    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
    .on_load_more(load_older)
    .load_more_threshold(0.5)
    .flex_1();
    view()
        .flex_1()
        .pb_keyboard()
        .child(list)
        .child(
            view().flex_row().gap_2().p_2().child(
                input()
                    .value(move || draft.get())
                    .on_change(move |text: &str| draft.set(text.to_owned()))
                    .on_submit(move |_: &str| send())
                    .multiline(true)
                    .submit_behavior(SubmitBehavior::Submit)
                    .return_key_type(ReturnKeyType::Send)
                    .placeholder("Message")
                    .flex_1()
                    .max_h(px(120.0))
                    .border_1()
                    .border_color(rgb(0xd0d7de))
                    .rounded(px(18.0))
                    .px_3()
                    .py_2(),
            ),
        )
}
```

```tsx tabs
import { List, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

type Message = { id: number; text: string; mine: boolean };

function Chat() {
  let next = 0;
  const message = (text: string, mine: boolean): Message => ({ id: next++, text, mine });
  const messages = signal(Array.from({ length: 30 }, (_, i) => message(`Message ${30 - i}`, i % 3 === 0)));
  const draft = signal("");
  const send = () => {
    if (!draft().trim()) return;
    messages.update((m) => [message(draft(), true), ...m]); // newest first
    draft.set("");
  };
  const loadOlder = () => messages.update((m) => [...m, ...Array.from({ length: 20 }, (_, i) => message(`Older ${i}`, false))]);
  return (
    <View style={{ flex: 1, paddingBottom: "env(keyboard-inset-height)" }}>
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
          <View
            style={{
              alignSelf: m().mine ? "flex-end" : "flex-start",
              maxWidth: "75%",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 14,
              backgroundColor: m().mine ? "#0969da" : "#eaeef2",
            }}
          >
            <Text style={{ color: m().mine ? "#ffffff" : "#1f2328" }}>{m().text}</Text>
          </View>
        )}
      </List>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        <Input
          value={draft()}
          onChange={(t) => draft.set(t)}
          onSubmit={send}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          placeholder="Message"
          style={{ flex: 1, maxHeight: 120, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }}
        />
      </View>
    </View>
  );
}

mount(Chat);
```

`scroll_to_end(..)` / `scrollToEnd()` on an inverted list scrolls to its start: the newest message.

### Following the end of a list that is not inverted

A list in reading order (oldest first) can follow its end too: with `.follow_end(px(40.0))` in Rust or `maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }}` in TSX, while the user is at the end (or within 40 points of it), the list stays at the end as the content grows: a reply streaming into the last item, a new message appended, the keyboard shrinking the list. Scrolled further up, the visible content stays where it is and the new content grows below it. Items inserted above the visible ones never move them, with or without the option.

```rust tabs
virtual_list(move || messages.with(Vec::len), move |at| bubble(messages, at))
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .follow_end(px(40.0))
    .flex_1()
```

```tsx tabs
<List each={messages()} keyExtractor={(m) => m.id} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }} style={{ flex: 1 }}>
  {(m) => <Bubble message={m()} />}
</List>
```

## Horizontal lists

`horizontal` turns the list sideways; cells are laid out at the list's height. Combined with snapping it makes a carousel of any length:

```rust tabs
let count = cards.len();
virtual_list(count, move |at| {
    let cards = cards.clone();
    view()
        .w(px(220.0))
        .h(px(140.0))
        .rounded(px(14.0))
        .bg(move || cards[at.index()].color)
})
.horizontal()
.estimated_item_size(px(232.0))
.snap_interval(px(232.0))
.deceleration(0.99)
.scrollbar(false)
.content_padding_x(px(16.0))
.column_gap(px(12.0))
.h(px(140.0))
```

```tsx tabs
<List
  each={cards}
  horizontal
  estimatedItemSize={232}
  snapToInterval={232}
  decelerationRate="fast"
  scrollbar={false}
  style={{ height: 140 }}
  contentStyle={{ paddingHorizontal: 16, gap: 12 }}
>
  {(card) => <View style={{ width: 220, height: 140, borderRadius: 14, backgroundColor: card().color }} />}
</List>
```

Right to left, horizontal lists start at the right and run leftwards.

## Lists in a page: viewport="parent"

A page often scrolls as one: a header, a few cards, then a long list, and maybe another list below it. Give the list `viewport="parent"` (`.viewport(ListViewport::Parent)` in Rust) and put it in a `Scroll` with the rest of the page: the list lies in the page at its full length, and the page's scroll view scrolls it with everything else. It still creates only the rows near the page's viewport and recycles their cells, so one page can hold several long lists.

```rust tabs
scroll()
    .flex_1()
    .child(header())
    .child(
        virtual_list(count, row)
            .viewport(ListViewport::Parent)
            .estimated_item_size(px(56.0))
            .row_gap(px(6.0)),
    )
    .child(footer())
```

```tsx tabs
<Scroll style={{ flex: 1 }}>
  <Header />
  <List viewport="parent" each={items} estimatedItemSize={56} contentStyle={{ gap: 6 }}>
    {(item) => <Row item={item()} />}
  </List>
  <Footer />
</Scroll>
```

- The list is as long as its rows: its height (its width, sideways) comes from its content, as a view's does, and its padding, border and margins work as on a view.
- Its rows follow the nearest scroll view around it along its axis, or the screen it is on.
- The page keeps what you read in place, as a browser does: rows that change size wholly above the top of the viewport move the page by as much; while the list's start is in view, rows that grow push what is below them down.
- `scrollToIndex`, `scrollToEnd` and `initialScrollIndex` scroll the page to the list's rows, within the page's content; `onLoadMore` fires as the list's end comes near the viewport, and `onViewableItemsChange` reports the rows in the page's viewport.
- `stickyHeaderIndices` and `stickyHeaderOffset` stick rows to the top of the page: a section header stays at the top while its rows scroll under it, until the next one pushes it out, and the last one leaves with the end of its list.
- How the page scrolls is its scroll view's: set `onScroll` and the other scroll events, `scrollValue`, `refreshing` / `onRefresh`, paging and snapping, `contentInset`, `scrollbar`, `scrollable` and `keyboardDismissMode` on the `Scroll`. Inverted lists and `maintainVisibleContentPosition` are features of a list with a viewport of its own (`viewport="own"`, the default).
- The viewport is chosen when the list is made: to switch, render a new list.

## Loading more: onLoadMore

`onLoadMore` (`.on_load_more(..)`) fires when the viewport comes within `loadMoreThreshold` viewports of the end (1 by default: one screen ahead). Append the next page; the list fires again when the new end comes near.

```rust tabs
let posts = signal(Vec::<Post>::new());
let page = stored(0_u32);
let loading = stored(false);

let load_more = move || {
    if loading.replace(true) {
        return;
    }
    let next = page.with(|p| {
        *p += 1;
        *p
    });
    spawn(async move {
        if let Ok(response) = fetch(format!("https://api.example.com/posts?page={next}")).await {
            let more = parse_posts(&response.text());
            posts.update(|p| p.extend(more));
        }
        loading.replace(false);
    });
};
load_more();

virtual_list(move || posts.with(Vec::len), move |at| post_row(posts, at))
    .estimated_item_size(px(72.0))
    .on_load_more(load_more)
    .load_more_threshold(0.5)
    .footer(text("Loading…").p_4().text_center().text_color(rgb(0x8c959f)))
    .flex_1()
```

```tsx tabs
const posts = signal<Post[]>([]);
let loading = false;
let page = 0;

const loadMore = async () => {
  if (loading) return;
  loading = true;
  try {
    const next: Post[] = await (await fetch(`https://api.example.com/posts?page=${++page}`)).json();
    posts.set([...posts(), ...next]);
  } finally {
    loading = false;
  }
};
loadMore();

<List
  each={posts()}
  estimatedItemSize={72}
  style={{ flex: 1 }}
  onLoadMore={loadMore}
  loadMoreThreshold={0.5}
  footer={<Text style={{ padding: 16, textAlign: "center", color: "#8c959f" }}>Loading…</Text>}
>
  {(post) => <PostRow post={post()} />}
</List>
```

Guard against overlapping loads as above: the end may be reported again while a page is on its way.

## Loading at the start: onLoadMoreAtStart

A list can also open in the middle of its data: a chat opened at an old message (a search result, a reply's quote) shows a page around it, with newer messages still to load. `onLoadMoreAtStart` (`.on_load_more_at_start(..)`) fires when the viewport comes within `loadMoreAtStartThreshold` viewports of the start (1 by default), the side of item 0: the top of a list, the bottom of an inverted one. Prepend the page: the rows on screen keep their place while it arrives before them (an inverted list too, once scrolled away from its bottom), and the list fires again on the next approach, or at once when the page left it still near the start.

It fires once the user scrolls there or a scroll command takes the list there (`initialScrollIndex` included), so a list that opens at its newest item asks for nothing, and one opened with `initialScrollIndex` near its start asks for the page before it right away.

```rust tabs
let messages = signal(page_around(target)); // newest first, ending at an old message
let loading = stored(false);

let load_newer = move |_: &()| {
    if loading.replace(true) {
        return;
    }
    let newest = messages.with(|m| m[0].id);
    spawn(async move {
        if let Ok(response) = fetch(format!("https://api.example.com/messages?after={newest}")).await {
            let newer = parse_messages(&response.text());
            messages.update(|m| {
                m.splice(0..0, newer);
            });
        }
        loading.replace(false);
    });
};

virtual_list(move || messages.with(Vec::len), move |at| message_row(messages, at))
    .inverted(true)
    .on_load_more(load_older)
    .on_load_more_at_start(load_newer)
    .load_more_at_start_threshold(0.5)
    .flex_1()
```

```tsx tabs
const messages = signal<Message[]>(pageAround(target)); // newest first, ending at an old message
let loading = false;

const loadNewer = async () => {
  if (loading) return;
  loading = true;
  try {
    const newest = messages()[0].id;
    const newer: Message[] = await (await fetch(`https://api.example.com/messages?after=${newest}`)).json();
    messages.set([...newer, ...messages()]);
  } finally {
    loading = false;
  }
};

<List
  each={messages()}
  inverted
  style={{ flex: 1 }}
  onLoadMore={loadOlder}
  onLoadMoreAtStart={loadNewer}
  loadMoreAtStartThreshold={0.5}
>
  {(message) => <Bubble message={message()} />}
</List>
```

Once the newest message is in, stop loading: new messages then arrive at the start as in any chat.

## Viewability

`onViewableItemsChange` (`.on_viewable_items_change(..)`) reports which items are on screen, for analytics, autoplaying the visible video, or marking messages read. In TSX it gets `{ viewableItems, changed }`, arrays of tokens `{ item, key, index, isViewable }`; in Rust, `ViewableItems` with the first and last viewable row (`viewable`) and the rows whose state changed (`changed()`). Viewability is computed natively; your code only hears about changes.

| `viewabilityConfig` | Rust | Description |
|---|---|---|
| `itemVisiblePercentThreshold` | `Viewability { item_visible_percent, .. }` | Percent of an item that must be visible. |
| `viewAreaCoveragePercentThreshold` | `Viewability { view_area_percent, .. }` | Percent of the viewport an item must cover. |
| `minimumViewTime` | `.minimum_view_time(Duration)` | Milliseconds an item must stay viewable before it is reported. |

Without a threshold, any visible pixel counts.

```rust tabs
let playing = signal(None::<usize>);

virtual_list(count, move |at| video_card(videos.clone(), at))
    .estimated_item_size(px(300.0))
    .viewability(Viewability {
        item_visible_percent: Some(60.0),
        ..Viewability::default()
    })
    .minimum_view_time(Duration::from_millis(250))
    .on_viewable_items_change(move |rows: &ViewableItems| {
        playing.set(rows.viewable.map(|(first, _)| first))
    })
    .flex_1()
```

```tsx tabs
<List
  each={videos}
  estimatedItemSize={300}
  style={{ flex: 1 }}
  keyExtractor={(v) => v.slug}
  viewabilityConfig={{ itemVisiblePercentThreshold: 60, minimumViewTime: 250 }}
  onViewableItemsChange={({ viewableItems }) => playing.set(viewableItems[0]?.key ?? null)}
>
  {(v) => <VideoCard video={v()} />}
</List>
```

## Scrolling from code

Give the list a ref (`element_ref()` and `.element_ref(&list)` in Rust, `ref` in TSX):

| Rust | TSX | Description |
|---|---|---|
| `scroll_to_index(index, view_position, view_offset, animated)` | `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | Scrolls item `index` into view. The view position places it: 0 at the start of the viewport (default), 0.5 in the middle, 1 at the end; the view offset shifts it further. |
| `scroll_to_offset(offset, animated)` | `scrollToOffset({ offset, animated? })` | Scrolls to a content offset along the list's axis. |
| `scroll_to_end(animated)` | `scrollToEnd({ animated? })` | Scrolls to the end of the content (the start of an inverted list). |
| `scroll_to(point, animated)` | `scrollTo({ x?, y?, animated? })` | Scrolls to an offset, as on a scroll view. |

```rust tabs
let list = element_ref();

virtual_list(count, row).estimated_item_size(px(48.0)).flex_1().element_ref(&list)

list.scroll_to_index(120, percentage(0.5), px(0.0), true);
```

```tsx tabs
import { List, type YNode } from "nsh";

let list!: YNode;

<List ref={list} each={items} estimatedItemSize={48} style={{ flex: 1 }}>…</List>

list.scrollToIndex({ index: 120, viewPosition: 0.5 });
```

Scrolling to an index (and to the end) is resolved natively with the sizes known at that moment: measured rows where they have been measured, the estimated size elsewhere. The list then follows its target while the rows around it are measured, so it lands exactly, until the user scrolls or the items change. To open a list at an item, use `initialScrollIndex` (`.initial_scroll_index(..)`) rather than scrolling after the first frame.

## A settings-style list

The look of a list is the app's own: the list places and recycles the rows, and the rows, dividers and surfaces are your views. A grouped, settings-style list is a list with padding, a separator and rounded first and last rows. Make it a component of your own and use it wherever the app lists settings:

```rust tabs
use std::rc::Rc;

use nsh_core::{element::palette::NEUTRAL, prelude::*};

pub struct Setting {
    pub id: &'static str,
    pub label: &'static str,
}

pub fn settings_list(settings: Rc<Vec<Setting>>, on_select: impl Fn(&Setting) + 'static) -> impl IntoElement {
    let surface = AdaptiveColor::new(white(), NEUTRAL.shade(900));
    let on_select = Rc::new(on_select);
    let count = settings.len();
    view().flex_1().bg(AdaptiveColor::new(NEUTRAL.shade(100), NEUTRAL.shade(950))).child(
        virtual_list(count, move |at| {
            let (pressed, shown, on_select) = (settings.clone(), settings.clone(), on_select.clone());
            view()
                .on_press(move || on_select(&pressed[at.index()]))
                .role(AccessibilityRole::Button)
                .h_12()
                .justify_center()
                .bg(surface)
                .px_4()
                .active(|s| s.bg(NEUTRAL.shade(200)))
                .rounded_t(move || px(if at.is_first() { 12.0 } else { 0.0 }))
                .rounded_b(move || px(if at.is_last() { 12.0 } else { 0.0 }))
                .child(text(move || shown[at.index()].label))
        })
        .estimated_item_size(px(48.0))
        .content_padding(px(16.0))
        .separator(move || {
            view()
                .bg(surface)
                .child(view().ml_4().h(px(1.0)).bg(AdaptiveColor::new(NEUTRAL.shade(200), NEUTRAL.shade(800))))
        })
        .flex_1(),
    )
}
```

```tsx tabs
import { List, Text, View } from "nsh";

type Setting = { id: string; label: string };

function SettingsList(props: { each: Setting[]; onSelect: (s: Setting) => void }) {
  return (
    <View class="flex-1 bg-neutral-100 dark:bg-neutral-950">
      <List
        each={props.each}
        estimatedItemSize={48}
        style={{ flex: 1 }}
        contentStyle={{ padding: 16 }}
        separator={() => (
          <View class="bg-white dark:bg-neutral-900">
            <View class="ml-4 h-px bg-neutral-200 dark:bg-neutral-800" />
          </View>
        )}
      >
        {(s, i) => (
          <View
            onPress={() => props.onSelect(s())}
            role="button"
            class="h-12 justify-center bg-white px-4 active:bg-neutral-200 dark:bg-neutral-900"
            classList={{ "rounded-t-xl": i() === 0, "rounded-b-xl": i() === props.each.length - 1 }}
          >
            <Text>{s().label}</Text>
          </View>
        )}
      </List>
    </View>
  );
}
```

## Performance notes

- Each cell is laid out on its own, so scrolling only lays out the cells that changed. Keep rows shallow and avoid reading signals in rows that change on every frame.
- The native side asks for cells in batches, up to several rounds per frame, merged into one update; a fast fling binds many cells in one frame without a call into your code per cell. Rust rows are bound in the core itself, within the commit that needs them.
- Use [`nsh test --trace` with a `scroll` step](./testing-and-trace.md#scrolling) to measure the per-frame cost of your rows.

## Related

- [`List` element](../elements/list.md): the reference.
- [Scrolling](./scrolling.md): the scrolling props lists share with scroll views.
- [Reactivity](./reactivity.md): why rows read their position in bindings.
- [Performance](./performance.md): measuring lists.
