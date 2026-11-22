---
title: EmojiPicker
description: "EmojiPicker: a search field over every emoji, in groups, as a composer's emoji button or a message's reactions have it. Unicode's emoji with English names from CLDR, the app's names in its language, skin tones, recent emoji first, a virtualized grid, keyboard first, a list box for screen readers. The look of every part is the app's."
group: base
demo: el-emoji-picker
---

# EmojiPicker

An emoji picker is a search field over every emoji: the groups (smileys, people, animals, food, ...) in a grid, the
user's recent emoji first, a skin tone for the emoji that take one. `EmojiPicker` owns the behavior of one: the emoji
themselves (Unicode's, with their English names and keywords from CLDR), the search, the groups, the highlight, the
keyboard and what screen readers hear. The search runs natively and the grid is virtualized: only the rows in view are
made. The look and the words are the app's: the picker draws nothing of its own and says nothing of its own, the app
styles each part (`itemClass`, `groupClass`, `searchClass`, ...), names the groups (`groupLabels`) and fills its slots
(the groups' tabs, a preview of the emoji under the pointer).

```rust tabs
use nsh_base::{EmojiGroupLabels, EmojiPickerEvent, emoji_picker};
use nsh_core::prelude::*;

fn picker() -> impl IntoElement {
    let chosen = signal(SharedString::from("none"));
    let mut labels = EmojiGroupLabels::default();
    labels.smileys_emotion = Some("Smileys & emotion".into());
    labels.people_body = Some("People & body".into());
    emoji_picker()
        .recent(vec!["👍".into(), "🎉".into()])
        .group_labels(labels)
        .placeholder("Search emoji")
        .accessibility_label("Emoji")
        .auto_focus(true)
        .on_select(move |e: &EmojiPickerEvent| {
            if let EmojiPickerEvent::Select(emoji, ..) = e {
                chosen.set(emoji.clone());
            }
        })
        .item_class("size-9 items-center justify-center rounded-md text-[22px] hover:bg-accent focus:bg-accent")
        .w(px(342.0))
        .h(px(380.0))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { EmojiPicker } from "nsh/base";

function App() {
  const message = signal("");
  return (
    <EmojiPicker
      recent={["👍", "🎉"]}
      groupLabels={{ recent: "Frequently used", smileysEmotion: "Smileys & emotion", peopleBody: "People & body" }}
      placeholder="Search emoji"
      accessibilityLabel="Emoji"
      autoFocus
      onSelect={({ emoji }) => message.set(message() + emoji)}
      class="h-96 w-[342px] overflow-hidden rounded-xl border border-border bg-popover"
      searchBarClass="mx-2 mt-2 h-8 flex-row items-center rounded-lg bg-muted px-2.5"
      searchClass="flex-1 text-sm text-foreground placeholder:text-muted-foreground"
      rowClass="px-2"
      groupClass="px-3 pt-2.5 pb-1 text-xs font-semibold text-muted-foreground"
      itemClass="size-9 items-center justify-center rounded-md text-[22px] hover:bg-accent focus:bg-accent"
      empty={<Text class="py-6 text-center text-sm text-muted-foreground">No emoji found</Text>}
    />
  );
}

mount(App);
```

`EmojiPicker` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust,
`emoji_picker()` makes it, with a setter per prop, a listener method per event and the typed style methods. It has no
popup of its own: put it in a [`Popover`](./popover.md) on a desktop, a [`Sheet`](./sheet.md) on a phone, or inline.

## The emoji

The picker carries Unicode's emoji (emojibase-data, Emoji 18.0) in their groups and order, each with the Emoji version
that added it and its English name and keywords from Unicode CLDR. The native platforms have them in the app; on the
web the page fetches them (`nsh-emoji.bin`, about 30 KB compressed) the first time a picker shows, and `loading`
shows until then.

- **Names in the app's language**: `annotations` gives each emoji a name and keywords in the app's language, as
  emojibase's data of a locale has them (its `compact.json`: `{ emoji: unicode, label, keywords: tags }`). Cells and
  `onSelect` use the app's names; a query matches the app's words and the English ones both.
- **Search**: a query matches an emoji whose name or a keyword holds it, ignoring case; emoji whose name has a word
  starting with the query come first, then those whose keywords do, then the rest. The matches show in one group
  without a header.
- **Groups**: `groups` chooses the groups shown and their order. `"recent"` is the app's `recent` emoji: the app keeps
  them (from `onSelect`'s `base`) and the picker shows them.
- **Skin tones**: `skinTone` puts one tone on every emoji that takes one (on every person of a group emoji).
- **Newer emoji**: `emojiVersion` leaves out the emoji added after an Emoji version, for systems whose fonts do not draw
  them yet (Emoji 16 needs iOS 18.4, Android 16 or a recent Windows 11).

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `query` | `.query(..)` | `string` | none | The query (controlled), which the app sets in `onQueryChange`. |
| `defaultQuery` | `.default_query(..)` | `string` | none | The query at first, while `query` is not set. |
| `skinTone` | `.skin_tone(..)` | `EmojiSkinTone` | `"none"` | The skin tone of every emoji that takes one: `"none"`, `"light"`, `"mediumLight"`, `"medium"`, `"mediumDark"`, `"dark"`. |
| `columns` | `.columns(..)` | `number` | `8` | The cells of a row. |
| `groups` | `.groups(..)` | `EmojiGroupId[]` | every group, `"recent"` first | The groups shown, in order: `"recent"`, `"smileysEmotion"`, `"peopleBody"`, `"animalsNature"`, `"foodDrink"`, `"travelPlaces"`, `"activities"`, `"objects"`, `"symbols"`, `"flags"`. |
| `recent` | `.recent(..)` | `string[]` | `[]` | The app's recent emoji, most recent first: the `"recent"` group. |
| `groupLabels` | `.group_labels(..)` | `EmojiGroupLabels` | `{}` | The groups' headings by group (`{ recent, smileysEmotion, ... }`): a group without one shows no header (unless `renderGroup` draws one). |
| `annotations` | `.annotations(..)` | `EmojiAnnotation[]` | `[]` | The emoji's names and keywords in the app's language (`{ emoji, label, keywords }`). |
| `emojiVersion` | `.emoji_version(..)` | `string` | none | The newest Emoji version shown (`"15.1"`). |
| `searchable` | `.searchable(..)` | `boolean` | `true` | A search field above the grid. Without it the picker is one stop of the keyboard focus whose arrows move the highlight. |
| `placeholder` | `.placeholder(..)` | `string` | none | The search field's placeholder. |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | The search field takes the keyboard focus once shown: on a desktop. On a phone the keyboard would cover the emoji. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the grid ("Emoji"), and the search field while `searchAccessibilityLabel` is not set. |
| `searchAccessibilityLabel` | `.search_accessibility_label(..)` | `string` | `accessibilityLabel` | What screen readers call the search field ("Search emoji"). |
| `header`, `footer` | `.header(..)`, `.footer(..)` | `JSX.Element` | none | What shows above the search field (the groups' tabs) and below the grid (the highlighted emoji named; the tabs on a phone). |
| `empty` | `.empty(..)` | `JSX.Element` | none | What shows while no emoji does: a query that matches nothing. |
| `loading` | `.loading(..)` | `JSX.Element` | none | What shows until the emoji are there (on the web, the first time). |
| `searchPrefix`, `searchSuffix` | `.search_prefix(..)`, `.search_suffix(..)` | `JSX.Element` | none | What shows before and after the search field in its bar: a search icon, the skin tone choice. |
| `renderItem` | `.render_item(..)` | `(entry: EmojiEntry) => JSX.Element` | none | A cell's content, for the cells in view; without it a cell shows the emoji as text. |
| `renderGroup` | `.render_group(..)` | `(group: EmojiGroup) => JSX.Element` | none | A group's header (`{ id, label, first }`); without it a header shows its heading. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The picker itself: its size, frame and surface. |
| `searchBarClass`, `searchBarStyle` | `.search_bar_class(..)`, `.search_bar_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The row of `searchPrefix`, the search field and `searchSuffix`. |
| `searchClass`, `searchStyle` | `.search_class(..)`, `.search_style(..)` | `string`, `StyleProp<TextStyle>` | none | The search field. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The scroll view of the rows: it takes the height the picker's other parts leave. |
| `rowClass`, `rowStyle` | `.row_class(..)`, `.row_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each row of cells, laid out in a row. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each cell: its size (`size-9`, or `flex-1` for the row's width shared) and states; its text styles reach the emoji. A short last row keeps its cells' places. |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each group's header. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onSelect` | `.on_select(..)` | `{ emoji: string, base: string, skinTone: EmojiSkinTone, label: string }` | The user chose an emoji (Return, a press): `emoji` with the skin tone, to insert; `base` without one, to keep as a recent emoji; its name. |
| `onHighlightChange` | `.on_highlight_change(..)` | `{ highlighted: EmojiEntry \| null }` | The highlight moved (the keys, the pointer, a new query): to name the emoji in a preview. |
| `onQueryChange` | `.on_query_change(..)` | `{ query: string }` | The user typed in the search field, or Escape cleared it. |
| `onGroupChange` | `.on_group_change(..)` | `{ group: EmojiGroupId }` | Another group is at the top of the grid (scrolled there, or `scrollToGroup`): the groups' tabs follow it. Not while a query shows its matches. |
| `onCancel` | `.on_cancel(..)` | none | Escape with an empty query: close what holds the picker. |

`EmojiEntry` is what an emoji is: `emoji` (with the skin tone), `base`, `label`, `keywords`, `group`, `version` (the
Emoji version that added it) and `hasSkinTones` (whether it takes one). `renderItem` gets it for each cell in view, and
the highlight is the cell's `focus:`: the drawing is made once per emoji and keeps its views while the highlight moves.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The picker | | `class`, `style` | |
| `header` | the picker | the app's element | |
| The search bar | the picker | `searchBarClass`, `searchBarStyle` | |
| `searchPrefix`, the search field, `searchSuffix` | the search bar | the app's elements; `searchClass`, `searchStyle` | the field's `focus:` |
| The list | the picker | `listClass`, `listStyle` | |
| A group's header | the list | `groupClass`, `groupStyle`, `renderGroup` | |
| A row of cells | the list | `rowClass`, `rowStyle` | |
| A cell | a row | `itemClass`, `itemStyle` | `focus:` (highlighted), `hover:`, `active:` |
| A cell's content | a cell | `renderItem` | `group-focus:` under `group` in `itemClass` |
| `loading`, `empty` | the picker | the app's elements | |
| `footer` | the picker | the app's element | |

## Ref

| Method | Description |
|---|---|
| `focus()` | Gives the search field the keyboard focus (without one, the picker). |
| `highlight(emoji)` | Highlights the emoji and scrolls its cell into view; one not shown stays as it is. |
| `scrollToGroup(group, animated?)` | Scrolls the group's first row to the top (animated by default), as a group's tab does. |
| `entry(emoji)` | `Promise<EmojiEntry \| null>`: what an emoji is, shown or not (a reaction's name). |
| `matchedCount()` | `Promise<number>`: how many emoji the query shows. |

## The groups' tabs

Tabs over the groups are [`Tabs`](./tabs.md) the app puts in `header` (or `footer` on a phone): the group at the top
is selected (`onGroupChange`), and a press scrolls to its group (`scrollToGroup`).

```tsx
const group = signal<EmojiGroupId>("smileysEmotion");
let picker: EmojiPickerRef | undefined;

<EmojiPicker
  ref={(r) => (picker = r)}
  onGroupChange={({ group: next }) => group.set(next)}
  header={
    <Tabs class="flex-row justify-between" indicatorClass="bottom-0 h-0.5 bg-foreground">
      {groups.map((g) => (
        <Tab selected={group() === g.id} onPress={() => picker?.scrollToGroup(g.id)} accessibilityLabel={g.label}>
          <Icon name={g.icon} />
        </Tab>
      ))}
    </Tabs>
  }
/>;
```

## Names in the app's language

```tsx
// emojibase's data of the app's language: fetched once, kept by the app.
const annotations = signal<EmojiAnnotation[]>([]);
void fetch("https://cdn.jsdelivr.net/npm/emojibase-data@18/zh/compact.json")
  .then((r) => r.json())
  .then((data) => annotations.set(data.map((e) => ({ emoji: e.unicode, label: e.label, keywords: e.tags ?? [] }))));

<EmojiPicker annotations={annotations()} />;
```

## Accessibility

- The grid has the role `"listbox"`, named by `accessibilityLabel`; each cell is an `"option"` named by its emoji's
  name; a group's header is a `"header"`. The places a short row keeps are hidden.
- The search field keeps the keyboard focus while the arrow keys move the highlight, and screen readers hear the
  highlighted emoji's name.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

| Key | What it does |
|---|---|
| Typing | Searches; the first match is highlighted. |
| Down, Up | Highlights the cell in the same column of the next or the previous row (the last of a shorter row). |
| Right, Left | While the query is empty: the next or the previous cell, across rows and groups (swapped in a right-to-left layout). With a query they move the field's caret. |
| Page Down, Page Up | Moves the highlight by the rows in view. |
| Return | Chooses the highlighted emoji (`onSelect`). |
| Escape | Clears the query; with an empty query, reports `onCancel`. |
| Home, End | Without a search field: the first or the last emoji (in the field they move its caret). |

An input method's composition keeps its keys: Return and Escape commit or cancel what is being composed, and choose or
cancel nothing.

## Platform notes

- Every platform draws the emoji with its own color emoji font: Apple Color Emoji on iOS and macOS, Noto Color Emoji
  on Android and usually on Linux (install it where it is missing), Segoe UI Emoji on Windows, the system's in a
  browser. On Windows a flag shows as its two letters: leave `"flags"` out of `groups` there.
- Desktops (macOS, Windows, Linux, GPUI) and the web: the pointer highlights the cell it moves over, and a click
  chooses as the button goes down, so the search field keeps the keyboard focus.
- iOS, Android and Mac Catalyst: a tap chooses; the keyboard's return key chooses the highlighted emoji.
