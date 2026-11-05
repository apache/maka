---
title: DiffView
description: "The DiffView component: the changes between two texts or of a patch, side by side or unified, with the words changed within lines highlighted, unchanged lines collapsed into separators that expand, syntax highlighting, soft wrap, per-change actions, line selection and review annotations."
group: base
demo: el-diff-view
---

# DiffView

`DiffView` shows the changes between two texts as code review tools do: side by side, the old text on the left and the
new on the right with their lines aligned, or unified, the deleted lines above the added ones. Within a changed line
the words that changed are highlighted, the unchanged lines between changes fold into separators that expand, and the
text is highlighted in the [`Editor`](./editor.md)'s syntax colors. It shows two texts (`oldValue` and `newValue`) or the
files of a unified diff (`patch`: `git diff`'s, a pull request's), each under its header, and it is made for reviewing changes, an AI's
proposed edits among them: the app's actions on each change keep it or revert it. Only the rows in view are made, so a
long file scrolls as a short one does.

`DiffView` owns behavior and comes with a look of its own built from the theme's tokens: the theme's `font-mono` at
13pt in 20pt rows, line numbers in `muted-foreground`, added lines tinted green and deleted lines red, the changed
words in a stronger tint, a bar at the gutter's edge of each changed line, and separators on `muted`. Each part takes
the app's styles over these defaults (`classes` and `styles`). Rust makes one with `nsh_base::diff_view()`, TSX with
`<DiffView>` from `nsh/base`.

```rust tabs
use nsh_base::diff_view;
use nsh_core::prelude::*;

const OLD: &str = "fn total(prices: &[u32]) -> u32 {\n    prices.iter().sum()\n}\n";
const NEW: &str = "fn total(prices: &[u64]) -> u64 {\n    prices.iter().copied().sum()\n}\n";

fn review() -> impl IntoElement {
    diff_view().old_value(OLD).new_value(NEW).language("rust").flex_1()
}
```

```tsx tabs
import { mount } from "nsh";
import { DiffView } from "nsh/base";

const OLD = `fn total(prices: &[u32]) -> u32 {
    prices.iter().sum()
}
`;
const NEW = `fn total(prices: &[u64]) -> u64 {
    prices.iter().copied().sum()
}
`;

function App() {
  return <DiffView oldValue={OLD} newValue={NEW} language="rust" class="flex-1" />;
}

mount(App);
```

The view fills the box the app gives it (`flex-1`, a height) and scrolls inside: vertically through the rows, and
sideways to the longest line, the two sides of a split view together. With `softWrap` long lines wrap at the side's
width instead, and a split row is as tall as its taller side, so the sides stay aligned.

## Two texts or a patch

- **Two texts**: `oldValue` and `newValue`. The lines are compared as they are, so a final line break added or
  removed is a change, as git shows it.
- **A patch**: `patch`, a unified diff of one file or several (`git diff`, `git format-patch`, `diff -u`; renames,
  modes, new, deleted and binary files, and a commit message before it, read as git writes them). The view shows its
  hunks' lines, numbered as in the file, each hunk under a separator of its header (the function it is in), and each
  file of several under a header of its own ([Files of a patch](#files-of-a-patch)). Each file's path names its
  language when `language` is not set.

```tsx
const PATCH = `diff --git a/src/total.rs b/src/total.rs
--- a/src/total.rs
+++ b/src/total.rs
@@ -10,3 +10,3 @@ impl Cart {
-    fn total(&self) -> u32 {
+    fn total(&self) -> u64 {
         self.prices.iter().sum()
     }
`;

<DiffView patch={PATCH} layout="unified" class="flex-1" />
```

`language` names the language as the `Editor`'s does: a name, an alias, an extension or a file name (`"rust"`,
`"tsx"`, `"main.go"`, `"Dockerfile"`).

## Files of a patch

A patch of several files shows each file under a header row: by default its path (`old → new` when renamed), its
added and deleted line counts, and `▾`, and a press on it collapses the file to its header (`▸`) or expands it.
`renderFileHeader` draws the headers the app's way (and shows one above a patch of a single file too), told the file
(`DiffFile`): `index`, `path`, `oldPath` (renamed or copied from), `status` (`"modified"`, `"added"`, `"deleted"`,
`"renamed"`, `"copied"`), `binary` (the patch shows no lines of it), `added`, `deleted`, `hunks`, `firstHunk` and
`collapsed`. The app's header calls the ref's `toggleFile(path)`; `collapseFile` and `expandFile` set the state, and
every change is reported with `onFileToggle({ file })`. A collapsed file stays collapsed while a new `patch` still has it.

Changes count across files, in order: a file's changes are `firstHunk` to `firstHunk + hunks - 1`, which
`goToHunk`, `renderHunkActions` and `hunks()` use (a `DiffHunk`'s `file` is its file's index and its lines count in
that file), and `stats()` adds up every file's. `goToHunk` expands a collapsed file first.

```tsx
let diff!: DiffViewRef;
const files = signal<DiffFile[]>([]);

<View class="flex-1 flex-row">
  <View class="w-48">
    <Each of={files()}>
      {(file) => (
        <Button onPress={() => diff.scrollToFile(file().path)} class="px-2 py-1">
          <Text class="text-sm">{file().path} +{file().added} −{file().deleted}</Text>
        </Button>
      )}
    </Each>
  </View>
  <DiffView
    ref={(r) => {
      diff = r;
      r.files().then((list) => files.set(list));
    }}
    patch={PULL_REQUEST}
    renderFileHeader={(file) => (
      <Button onPress={() => diff.toggleFile(file.path)} class="flex-1 flex-row items-center gap-2 bg-muted px-2">
        <Text>{file.collapsed ? "▸" : "▾"}</Text>
        <Text class="flex-1 text-sm font-medium">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</Text>
        <Text class="text-xs text-muted-foreground">{file.binary ? "Binary" : file.status}</Text>
      </Button>
    )}
    class="flex-1"
  />
</View>
```

## Layout and inline changes

`layout` is `"split"` (the default: side by side, each deleted line beside the added line most like it) or
`"unified"` (one column, a change's deleted lines above its added lines, with both line numbers). `inline` decides
what is highlighted within a changed line:

| `inline` | What is highlighted |
|---|---|
| `"wordAlt"` (default) | The words that changed, joined when one character apart, so a changed phrase reads as one |
| `"word"` | Each word that changed |
| `"char"` | Each character that changed |
| `"none"` | Nothing: the lines' tints alone |

Words are runs of letters, digits and `_`; each CJK character, kana and hangul syllable is a word of its own, so a
changed character in a sentence marks only itself. A line that changed almost entirely shows its tint alone.

`indicators` marks changed lines beside their numbers: `"bars"` (the default, a bar at the gutter's edge),
`"classic"` (`+` and `−` before the text) or `"none"`. `background={false}` leaves the changed lines untinted, and
`lineNumbers={false}` hides the numbers.

```tsx
<DiffView oldValue={before()} newValue={after()} language="md" layout="unified" inline="word" indicators="classic" class="flex-1" />
```

## Collapsed lines

Around each change `contextLines` unchanged lines show (3 by default); the unchanged lines between changes, and those
before the first and after the last, collapse into a separator that says how many lines it hides. Pressing it shows
them all. `expandAll` shows every line; the ref's `expand`, `expandAll()` and `collapseAll()` reveal and fold them
from the app.

`renderSeparator` draws the separators the app's way. It gets the separator (`DiffSeparator`): `gap`, the index of
the collapsed run (0 before the first change, `i` between changes `i - 1` and `i`), `lines`, how many lines it hides,
`first` and `last`, and for a patch the hunk's `header`. `expand(gap, direction, lines)` shows `"all"` its lines (the
default), or `lines` (default 20) `"up"`, just above the change below the separator, or `"down"`, just below the
change above it. The first separator expands up and the last one down.

```tsx
let diff!: DiffViewRef;

<DiffView
  ref={diff}
  oldValue={before()}
  newValue={after()}
  language="ts"
  renderSeparator={(sep) => (
    <View class="flex-1 flex-row items-center gap-1 bg-muted px-2">
      <If when={!sep.first}>
        <Button onPress={() => diff.expand(sep.gap, "down")} class="px-1"><Text>↓</Text></Button>
      </If>
      <If when={!sep.last}>
        <Button onPress={() => diff.expand(sep.gap, "up")} class="px-1"><Text>↑</Text></Button>
      </If>
      <Button onPress={() => diff.expand(sep.gap)} class="flex-1">
        <Text class="text-xs text-muted-foreground">{sep.header ?? `${sep.lines} unchanged lines`}</Text>
      </Button>
    </View>
  )}
  class="flex-1"
/>
```

## Keeping and reverting changes

`renderHunkActions` puts the app's actions at the top right of each change in view, told the change (`DiffHunk`:
`index`, `oldStart`, `oldLines`, `newStart`, `newLines`, lines from 0, and `file`, its file's index in a patch). They call the ref: `revertHunk(index)` puts
the change's old lines back into the new text, `acceptHunk(index)` makes its new lines the old text's. The view shows
the result at once and reports both texts with `onChange({ change })` (`{ oldValue, newValue }`), which the app sets as the props.
Keeping or reverting an AI's edit one change at a time is this:

```tsx
import { signal, Text, View } from "nsh";
import { Button, DiffView, type DiffViewRef } from "nsh/base";

function Proposal(props: { file: string; current: string; proposed: string; onApply: (text: string) => void }) {
  let diff!: DiffViewRef;
  const current = signal(props.current);
  const proposed = signal(props.proposed);
  return (
    <View class="flex-1">
      <DiffView
        ref={diff}
        oldValue={current()}
        newValue={proposed()}
        language={props.file}
        onChange={({ change: { oldValue, newValue } }) => {
          current.set(oldValue);
          proposed.set(newValue);
          props.onApply(oldValue);
        }}
        renderHunkActions={(hunk) => (
          <View class="flex-row gap-1">
            <Button onPress={() => diff.revertHunk(hunk.index)} class="rounded bg-background px-2 py-0.5 border border-border">
              <Text class="text-xs">Revert</Text>
            </Button>
            <Button onPress={() => diff.acceptHunk(hunk.index)} class="rounded bg-primary px-2 py-0.5">
              <Text class="text-xs text-primary-foreground">Keep</Text>
            </Button>
          </View>
        )}
        class="flex-1"
      />
    </View>
  );
}
```

Here the old text is the file as it is: keeping a change applies it to the file (`onApply`), reverting it takes it
out of the proposal. A view showing a `patch` shows excerpts of the files, and its changes stay as they are.

## Methods

`ref={diff}` gives the view's methods (`DiffViewRef`). Methods that return a value (`hunks()`, `stats()`) return a
`Promise` of it in JS, so `await` them: `const changes = await diff.hunks()`. For counts shown on screen,
`onStatsChange` reports them as they change. A method given a change, a separator or a file the diff does not have
changes nothing and logs a warning naming the method and the value.

| Method | Description |
|---|---|
| `hunks()` | `Promise<DiffHunk[]>`: the changes, in order. |
| `stats()` | `Promise<DiffStats>`: `{ added, deleted, hunks }`, the lines added and deleted and the number of changes. |
| `goToHunk(index)` | Scrolls change `index` into view, its first row at the top. |
| `revertHunk(index)` | Puts change `index`'s old lines back into the new text and reports the texts (`onChange`). |
| `acceptHunk(index)` | Makes change `index`'s new lines the old text's and reports the texts (`onChange`). |
| `expand(gap, direction?, lines?)` | Shows the lines separator `gap` hides: `"all"` (default), or `lines` (default 20) `"up"` or `"down"`. |
| `expandAll()` | Shows every unchanged line. |
| `collapseAll()` | Collapses the unchanged lines again. |
| `nextHunk()` | `Promise<number \| null>`: scrolls the next change to the top and gives its index (after the last, the first). |
| `previousHunk()` | `Promise<number \| null>`: scrolls the previous change to the top and gives its index (before the first, the last). |
| `currentHunk()` | `Promise<number \| null>`: the change gone to last while the view stays there, else the one at the top of the view or the first in view. |
| `selectedLines()` | `Promise<DiffLineRange \| null>`: the lines selected on the line numbers. |
| `setSelectedLines(range)` | Selects lines of a side (`null`: none), without `onLineSelectionChange`. |
| `selectedText()` | `Promise<string>`: the selected lines' text. |
| `files()` | `Promise<DiffFile[]>`: the patch's files, in order, with their counts (none for two texts). |
| `scrollToFile(path)` | Scrolls the header of the file at `path` to the top. |
| `collapseFile(path)` | Shows only the header of the file at `path`. |
| `expandFile(path)` | Shows the lines of the file at `path` again. |
| `toggleFile(path)` | Collapses the file at `path`, or expands it when collapsed. |
| `hunkBounds()` | `Promise<DiffHunkBounds[]>`: where each change is in the rows, in order ([An overview ruler](#an-overview-ruler)). |
| `scrollOffset()` | `Promise<Point>`: how far the rows are scrolled (`x` is 0). |
| `setScrollOffset(offset)` | Scrolls the rows to `offset.y` at once, as far as they go, as a thumb follows the pointer that drags it. |

`nextHunk()` and `previousHunk()` go on from the change they went to while the view stays there, and otherwise from
the top of the view, so a change near the end that cannot scroll to the top still counts. Next and previous change
buttons, with the counts from `onStatsChange`:

```tsx
let diff!: DiffViewRef;
const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });

<View class="flex-row items-center gap-2 p-2">
  <Text class="text-sm text-green-600">+{stats().added}</Text>
  <Text class="text-sm text-red-600">−{stats().deleted}</Text>
  <Text class="text-sm text-muted-foreground">{stats().hunks} changes</Text>
  <Button onPress={() => diff.previousHunk()}><Text>Previous</Text></Button>
  <Button onPress={() => diff.nextHunk()}><Text>Next</Text></Button>
</View>
<DiffView ref={diff} oldValue={before()} newValue={after()} onStatsChange={(e) => stats.set(e.stats)} class="flex-1" />
```

## An overview ruler

`onScroll({ offset, contentSize, size })` reports where the rows are, with the keys of a [`Scroll`](./scroll.md)'s:
`offset.y`, how far they are scrolled (the rows scroll vertically, as wide as the view, and the sides sideways on their
own: `offset.x` is 0), `contentSize`, the size of every row together, and `size`, the viewport's. It fires once the
view is laid out and again whenever one of them changes: as the rows scroll, when the view resizes, and when the rows
change height (other texts, `layout`, `softWrap`, a file or a separator expanded or collapsed, an annotation laid out).
`hunkBounds()` gives where each change is in the rows (`DiffHunkBounds`: `{ index, bounds }`, `bounds` from the top
of its first row to the bottom of its last, with the annotations under them, across the view), the changes that show:
a collapsed file's have no rows. `onHunkBoundsChange({ hunkBounds })` gives the same list once the view is laid out and
again whenever a change moves or changes size, even when the rows keep their height (one changed line becoming
another): a ruler draws its marks from it rather than reading them on `onScroll`. `scrollOffset()` reads how far the rows are scrolled,
and `setScrollOffset({ x, y })` scrolls the rows to `y` at once, so a dragged thumb follows the pointer in the same frame.

Together they make an overview ruler beside the view, as code editors have: a mark for each change, a thumb over the
rows in view, and a press or a drag that scrolls there. Here the ruler is as tall as the view:

```rust tabs
use nsh_base::{DiffHunkBounds, DiffView, DiffViewApi, DiffViewEvent, diff_view, theme};
use nsh_core::prelude::*;

fn review(old: SharedString, new: SharedString) -> impl IntoElement {
    let diff = component_ref::<DiffView>();
    let ruler = element_ref();
    let ruler_top = stored(px(0.0));
    // How far the rows are scrolled, their height and the viewport's.
    let rows = signal((px(0.0), px(0.0), px(0.0)));
    let marks = signal(Vec::<DiffHunkBounds>::new());
    // Points of the rows per point of the ruler.
    let scale = move || {
        let (_, height, view) = rows.get();
        height.max(px(1.0)) / view.max(px(1.0))
    };
    // The thumb's middle at the pointer.
    let follow = move |page_y: Points| {
        let view = rows.get_untracked().2;
        let y = (page_y - ruler_top.get()) * scale() - view / 2.0;
        if let Some(api) = diff.api::<DiffViewApi>() {
            api.set_scroll_offset(point(px(0.0), y));
        }
    };
    view()
        .flex_1()
        .flex_row()
        .child(
            diff_view()
                .old_value(old)
                .new_value(new)
                .on_scroll(move |e: &DiffViewEvent| {
                    if let DiffViewEvent::Scroll(offset, content, size) = e {
                        rows.set((offset.y, content.height, size.height));
                    }
                })
                .on_hunk_bounds_change(move |list: &Vec<DiffHunkBounds>| marks.set(list.clone()))
                .component_ref(&diff)
                .flex_1(),
        )
        .child(
            view()
                .element_ref(&ruler)
                .w(px(12.0))
                .bg(move || theme().muted)
                .claim_touches(TouchClaim::on_start())
                .on_responder_grant(move |e: &ResponderEvent| {
                    let y = e.page.y;
                    spawn(async move {
                        ruler_top.replace(ruler.measure().await.map_or(px(0.0), |m| m.page.y));
                        follow(y);
                    });
                })
                .on_responder_move(move |e: &ResponderEvent| follow(e.page.y))
                .child(each(
                    marks,
                    |mark: &DiffHunkBounds| mark.index,
                    move |mark, _| {
                        view()
                            .absolute()
                            .left(px(0.0))
                            .right(px(0.0))
                            .bg(rgb(0xf59e0b))
                            .top(move || mark.get().bounds.origin.y / scale())
                            .h(move || (mark.get().bounds.size.height / scale()).max(px(2.0)))
                    },
                ))
                .child(
                    view()
                        .absolute()
                        .left(px(0.0))
                        .right(px(0.0))
                        .bg(move || theme().foreground.opacity(0.2))
                        .top(move || rows.get().0 / scale())
                        .h(move || rows.get().2 / scale()),
                ),
        )
}
```

```tsx tabs
import { Each, signal, View, type ViewRef } from "nsh";
import { DiffView, type DiffHunkBounds, type DiffViewRef } from "nsh/base";

let diff!: DiffViewRef;
let ruler!: ViewRef;
let rulerTop = 0;
const rows = signal({ y: 0, height: 0, view: 0 });
const marks = signal<DiffHunkBounds[]>([]);
// Points of the rows per point of the ruler.
const scale = () => Math.max(rows().height, 1) / Math.max(rows().view, 1);
// The thumb's middle at the pointer.
const follow = (pageY: number) => diff.setScrollOffset({ x: 0, y: (pageY - rulerTop) * scale() - rows().view / 2 });

<View class="flex-1 flex-row">
  <DiffView
    ref={diff}
    oldValue={before()}
    newValue={after()}
    onScroll={({ offset, contentSize, size }) => rows.set({ y: offset.y, height: contentSize.height, view: size.height })}
    onHunkBoundsChange={({ hunkBounds }) => marks.set(hunkBounds)}
    class="flex-1"
  />
  <View
    ref={ruler}
    class="w-3 bg-muted"
    onStartShouldSetResponder={() => true}
    onResponderGrant={async (e) => {
      const y = e.pageY;
      rulerTop = (await ruler.measure())?.pagePosition.y ?? 0;
      follow(y);
    }}
    onResponderMove={(e) => follow(e.pageY)}
  >
    <Each of={marks()}>
      {(mark) => (
        <View
          class="absolute inset-x-0 bg-amber-500"
          style={{ top: mark().bounds.origin.y / scale(), height: Math.max(mark().bounds.size.height / scale(), 2) }}
        />
      )}
    </Each>
    <View class="absolute inset-x-0 bg-foreground/20" style={{ top: rows().y / scale(), height: rows().view / scale() }} />
  </View>
</View>
```

A mark's `index` is the change's in `hunks()`, whose `oldLines` and `newLines` tell an added change (no old lines)
from a deleted one (no new lines), to color its mark.

## Review comments

The line numbers select lines of a side: a press selects one, a Shift-press extends the selection to it, and dragging
the mouse over the numbers selects those it goes over. `onLineSelectionChange` reports the lines as `range` (`DiffLineRange`:
`{ side, start, end }`, lines from 0, `null` for none), and a press of a number also reports
`onLineNumberPress({ line })` (`{ side, line }`). The ref reads the selection (`selectedLines()`, `selectedText()`) and sets it.

`annotations` puts the app's content under lines: each `{ id, side, line }` is drawn by `renderAnnotation` across its
line's side (the whole view when unified), as tall as it lays out, and shows while its line does. `renderAddAnnotation`
is the app's control to add one, at the right of the gutter of the line the pointer is over and of the last selected
line; it gets the selected lines when its line is one of them, else that line.

```tsx
type Comment = { id: string; side: "old" | "new"; line: number; text: string };
const comments = signal<Comment[]>([]);
const drafting = signal<DiffLineRange | null>(null);

<DiffView
  oldValue={before()}
  newValue={after()}
  annotations={comments().map(({ id, side, line }) => ({ id, side, line }))}
  renderAnnotation={(a) => (
    <View class="m-2 rounded-md border border-border bg-card p-2">
      <Text class="text-sm">{comments().find((c) => c.id === a.id)?.text}</Text>
    </View>
  )}
  renderAddAnnotation={(range) => (
    <Button onPress={() => drafting.set(range)} class="size-4 items-center justify-center rounded bg-primary">
      <Text class="text-xs text-primary-foreground">+</Text>
    </Button>
  )}
  class="flex-1"
/>
```

## Styling the parts

`class` and `style` style the view's box. `classes` takes Tailwind classes by part and `styles` inline styles by part;
a part's classes come after its own default styles, so they win, and its `styles` win over its classes. The font is
set with `fontFamily`, `fontSize` and `lineHeight`.

```tsx
<DiffView
  oldValue={before()}
  newValue={after()}
  language="py"
  fontSize={12}
  lineHeight={18}
  class="flex-1 rounded-lg border border-border"
  classes={{
    gutter: "bg-muted",
    lineAdded: "bg-blue-500/10",
    wordAdded: "bg-blue-500/30",
    indicatorAdded: "bg-blue-500",
    separator: "bg-transparent",
  }}
/>
```

| Part | What it is | Default |
|---|---|---|
| `side` | Each side (split) or the one column (unified) | A `border` line between the sides |
| `gutter` | A side's line numbers and indicators | |
| `lineNumber` | Every line number | Right-aligned, `muted-foreground` |
| `lineNumberAdded` | The numbers of added lines, after `lineNumber` | |
| `lineNumberDeleted` | The numbers of deleted lines, after `lineNumber` | |
| `content` | A side's text, beside its gutter | 8pt before and after the text |
| `line` | Every row of a side | |
| `lineAdded` | Added lines' rows, after `line` | A green tint |
| `lineDeleted` | Deleted lines' rows, after `line` | A red tint |
| `filler` | The empty half of a split row beside a line the other side lacks | A faint `muted` fill |
| `wordAdded` | The words changed within an added line | A stronger green |
| `wordDeleted` | The words changed within a deleted line | A stronger red |
| `indicatorAdded` | An added line's bar (`"bars"`) or `+` (`"classic"`) | Green, 3pt wide |
| `indicatorDeleted` | A deleted line's bar or `−` | Red, 3pt wide |
| `separator` | A separator of collapsed lines, or a patch's hunk header | `⋯` and the count on `muted` |
| `hunkActions` | The box of the app's actions on a change | At the change's top right |
| `lineSelected` | Over the selected lines' rows of their side | The theme's selection color (as the `Editor`'s selections) |
| `annotation` | The box of an annotation, under its line | Across its line's side |
| `addAnnotation` | The box of the add control, the gutter's width and a line tall | The control at its right |
| `fileHeader` | The header of a file of a patch | The path and counts on `secondary`, a `border` line below |

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `oldValue` | `.old_value(..)` | `string` | | The old text. |
| `newValue` | `.new_value(..)` | `string` | | The new text. |
| `patch` | `.patch(..)` | `string` | | A unified diff of one file or several, shown when `oldValue` and `newValue` are not set. |
| `language` | `.language(..)` | `string` | plain text (a patch: each file's) | A language's name, alias, extension or file name. |
| `layout` | `.layout(..)` | `"split" \| "unified"` | `"split"` | Side by side or one column. |
| `inline` | `.inline(..)` | `"wordAlt" \| "word" \| "char" \| "none"` | `"wordAlt"` | What is highlighted within changed lines. |
| `indicators` | `.indicators(..)` | `"bars" \| "classic" \| "none"` | `"bars"` | How changed lines are marked beside their numbers. |
| `contextLines` | `.context_lines(..)` | `number` | `3` | Unchanged lines shown around each change. |
| `expandAll` | `.expand_all(..)` | `boolean` | `false` | Every unchanged line shows. |
| `lineNumbers` | `.line_numbers(..)` | `boolean` | `true` | The line numbers. |
| `background` | `.background(..)` | `boolean` | `true` | Changed lines are tinted. |
| `fontFamily` | `.font_family(..)` | `string` | the theme's `font-mono` | The font of the text. |
| `fontSize` | `.font_size(..)` | `number` | `13` | The font size, in points. |
| `lineHeight` | `.line_height(..)` | `number` | `20` | The height of a row, in points. |
| `renderSeparator` | `.render_separator(..)` | `(separator: DiffSeparator) => JSX.Element` | | Draws the separators of collapsed lines. |
| `renderHunkActions` | `.render_hunk_actions(..)` | `(hunk: DiffHunk) => JSX.Element` | | The app's actions on each change. |
| `softWrap` | `.soft_wrap(..)` | `boolean` | `false` | Long lines wrap at the side's width. |
| `annotations` | `.annotations(..)` | `DiffAnnotation[]` | `[]` | The app's content under lines: `{ id, side, line }`. |
| `renderAnnotation` | `.render_annotation(..)` | `(annotation: DiffAnnotation) => JSX.Element` | | Draws an annotation under its line. |
| `renderAddAnnotation` | `.render_add_annotation(..)` | `(range: DiffLineRange) => JSX.Element` | | The app's control to add an annotation, beside the hovered line and the last selected one. |
| `renderFileHeader` | `.render_file_header(..)` | `(file: DiffFile) => JSX.Element` | | Draws the header of each file of a patch, one row tall. |
| `classes` | `.classes(..)` | `DiffViewClasses` | `{}` | Tailwind classes by part. |
| `styles` | `.styles(..)` | `DiffViewStyles` | `{}` | Inline styles by part, over the classes. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | | The view's box. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|change: &DiffChange\| ..)` | A change was kept or reverted: `{ change }`, the texts now (`{ oldValue, newValue }`). |
| `onLineNumberPress` | `.on_line_number_press(\|line: &DiffLine\| ..)` | A line number was pressed: `{ line }`, a `{ side, line }`. |
| `onLineSelectionChange` | `.on_line_selection_change(\|range: &Option<DiffLineRange>\| ..)` | The selected lines changed: `{ range }`, a `{ side, start, end }` or `null`. |
| `onStatsChange` | `.on_stats_change(\|stats: &DiffStats\| ..)` | The counts changed: `{ stats }`, a `{ added, deleted, hunks }`. It fires once when the view is made and again each time the texts are diffed to other counts, for a "+8 −8 · 5 changes" line. |
| `onFileToggle` | `.on_file_toggle(\|file: &DiffFile\| ..)` | A file of the patch was collapsed or expanded (its header, or the ref): `{ file }`, the `DiffFile` now. |
| `onScroll` | `.on_scroll(\|e: &DiffViewEvent\| ..)` | The rows scrolled, or they or the viewport changed size: `{ offset, contentSize, size }`, as a `Scroll`'s (`DiffViewEvent::Scroll(offset, content_size, size)` in Rust). It fires once the view is laid out and again when one of them changes. |
| `onHunkBoundsChange` | `.on_hunk_bounds_change(\|bounds: &Vec<DiffHunkBounds>\| ..)` | Where the changes are in the rows changed: `{ hunkBounds }`, the list `hunkBounds()` gives. It fires once the view is laid out and again when a change moves or changes size, the rows' height kept or not, for an overview ruler's marks. |

## Related

- [Editor](./editor.md): the code editor whose syntax colors and languages `DiffView` uses.
- [TextView](./text-view.md): documents of Markdown and HTML, for the text around a review.
- [`nsh/base`](../modules/nsh-base.md): the other base components.
