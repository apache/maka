# DiffView

`DiffView` (`nsh/base`, `crates/nsh-base/src/diff/`) shows the changes between two texts as code review tools do:
side by side (`layout="split"`) or one over the other (`"unified"`), the words changed within lines highlighted, the
unchanged lines between changes collapsed into separators that expand, and the text highlighted with the `Editor`'s
syntaxes. The texts are `oldValue` and `newValue`, or the files of a unified `patch` (`git diff`'s, a pull request's).
As `TextView` and `Editor` do, it has a default look built from the theme's tokens, with added lines green and
deleted lines red (an exception to "No styles in NSH", `AGENTS.md`), every part of which the app restyles. The
user-facing page is `website/elements/diff-view.md`; how each module works inside is in its `//!` docs.

| File | What |
|---|---|
| `mod.rs` | The component: `DiffViewProps`, `DiffViewEvent` (`Change`, `LineNumberPress`, `StatsChange`, `LineSelectionChange`, `FileToggle`, `Scroll`, `HunkBoundsChange`), `DiffViewApi` (the ref's methods); the values: `DiffLayout`, `DiffInline`, `DiffIndicators`, `DiffSide`, `DiffExpand`, `DiffFileStatus` (`PropEnum`s), `DiffHunk`, `DiffHunkBounds`, `DiffStats`, `DiffSeparator`, `DiffChange`, `DiffLine`, `DiffLineRange`, `DiffAnnotation`, `DiffFile` (`JsObject`s) |
| `parts.rs` | The parts the app styles: one `parts!` list makes `DiffViewClasses`, `DiffViewStyles` (each a `PartStyle`) and `DiffViewPart` |
| `model.rs` | `DiffModel`: the line diff and its hunks, the pairs of changed lines that are alike, the words changed within a pair, reverting and accepting one hunk |
| `layout.rs` | `rows`: the rows a diff shows (`Row::Line`, `Row::Separator`; `Row::File`, a file header, made by `files.rs`), `Expansions` (what the user expanded of each gap), patch hunk headers |
| `files.rs` | A patch's files: each diffed on its own and joined into the two sides (`join`), their header rows (`Row::File`) and collapsing (`Files`), each file's highlighting (`Segment`), the default file header |
| `patch.rs` | Unified diffs: `parse_patch` into `FilePatch`es and `PatchHunk`s, the texts a view shows of a file (`FilePatch::texts`), applying a patch (`FilePatch::apply`) |
| `controller.rs` | `Dv` and `State`: the two sides (text, rope, line starts, highlighter, numbering), the model and rows, the revisions bindings subscribe to, what props and the ref do; the cells and spans of a row |
| `geometry.rs` | `Geometry`: each row's top and height (its wrapped lines, the annotations under it), finding the rows at a height; `wrap_starts`: where a line wraps at a column count |
| `review.rs` | What a reviewer does: line selection on the numbers (press, Shift-press, mouse drag), hover and the app's add control, annotations' heights, navigation between changes, the scroll position and the changes' bounds (an overview ruler's), the split sides' horizontal sync |
| `view.rs` | The view: the vertical scroll view, the sides (gutter and text), the separators, the app's hunk actions, annotations and add control |

## The model

- **Lines.** A text's lines are split after each `\n`, which stays part of its line for the diff: `"a\nb\n"` and
  `"a\nb"` both have two lines and their last lines differ, so a missing final line break is a change, as git shows
  it. A `\r` before the `\n` is content: texts are compared as they are.
- **The line diff** is imara-diff's histogram algorithm (`Algorithm::Histogram` on an `InternedInput` of the lines),
  then `postprocess_lines`, git's indent heuristic: a hunk that could start at several places slides to the one that
  keeps whole blocks together (a function added after another starts at its own first line, not inside the one
  before). The hunks are in order and never touch: equal lines separate them.
- **Pairing.** Within a hunk, each deleted line is paired with the added line most like it, in order (`align`); lines
  not alike enough are paired in order as split views show them side by side, and the rest stand alone.
- **Inline changes.** A pair's changed ranges (`DiffModel::inline`) come from a diff of its tokens: words for `word`
  and `wordAlt` (CJK ideographs, kana and hangul are a word each), graphemes for `char`. `wordAlt` (the default) joins
  changed words one character apart, so a phrase reads as one change. Lines that changed almost entirely, and very
  long lines, get no ranges: the line's tint says enough.
- **Reverting and accepting** a hunk splice lines between the texts (`revert_hunk`: its old lines back into the new
  text; `accept_hunk`: its new lines into the old text), keeping each side's line breaks. The view shows the result at
  once and reports both texts with `onChange`; the app setting them back as props changes nothing more.

## Layout

`layout::rows` turns the model into rows. Split: a hunk's pairs side by side (`Modified` when both sides have a
line, `Deleted` or `Added` with a filler on the other side). Unified: a hunk's deleted lines, then its added lines.
Around each hunk `contextLines` unchanged lines show (3 by default); the unchanged lines between hunks, before the
first and after the last, are a gap, shown as one `Separator` row with how many lines it hides. Gaps are numbered
(gap 0 before hunk 0, gap `i` between hunks `i - 1` and `i`). `Expansions` keeps what the user revealed of each gap,
from its top (below the hunk above) and from its bottom (above the hunk below); the first gap expands up only, the
last down only, and a gap that would hide a single line, or none, shows in full. A new model
(other texts, a hunk reverted) clears the expansions. Rows are made only for what shows: a gap costs its shown lines
and one separator, so a big text with few changes lays out in time proportional to its rows.

## Patches

`patch.rs` reads the files of a unified diff: `git diff` and `git format-patch` (renames, copies, modes, new,
deleted and binary files; text before the first file, a commit message, is skipped) and `diff -u`. Errors name the
patch's line. A `DiffView` shows every file of the patch: its hunks' lines only (`FilePatch::texts`), so nothing
collapses, each hunk under a separator of its header (the text after the second `@@`, a function's name), and the
lines numbered as in the files (each side's `numbers`). Each file's path decides its language when `language` is not
set (`language` is every file's). A patch's texts are excerpts, so reverting and accepting hunks act only on
`oldValue` / `newValue`.

Files (`files.rs`): each file's texts are diffed on their own, then joined into the view's two texts, so the rows,
cells and ref work as for one file. Indexes stay coherent this way:

- **Lines.** File `i`'s lines start at its `old_at` / `new_at` in the joined texts; each file's text ends with a line
  break there, so no two files share a line. Numbers restart with each file (one `numbers` entry per hunk of every
  file).
- **Hunks.** The joined model's hunks are the files' in order: `DiffHunk.index`, `goToHunk` and `renderHunkActions`
  count across files, a file's being `firstHunk..firstHunk + hunks` (`DiffFile`); `DiffHunk.file` is its file's index
  and its lines count in that file's texts. `stats()` and `onStatsChange` are the sum of the files'.
- **Hunk headers.** Their separators' `gap` counts across files.

A header row (`Row::File`, one row tall) is above each file when the patch has several files or the app sets
`renderFileHeader` (told the `DiffFile`: `path`, `oldPath` for renames and copies, `status`, `binary`, `added`,
`deleted`, `hunks`, `firstHunk`, `collapsed`). A collapsed file shows its header only; collapsed paths stay collapsed
while a new patch still has them. `collapseFile`, `expandFile` and `toggleFile` (the ref, by path) collapse and
expand, and each change is reported with `onFileToggle` (the default header toggles on a press; the app's calls
`toggleFile`). `files()` lists the files, `scrollToFile(path)` scrolls a header to the top, and `goToHunk` expands a
collapsed file first. Each file and side is highlighted on its own (`Segment`, a highlighter and rope per file), so
one file's syntax state never runs into the next; a frame's budget is shared among the files in view.
`FilePatch::apply` applies a patch to the old file's text, giving the new one.

## The view

The view is a vertical `Scroll` over a box of every row's height. In it sit the sides (two side by side for `split`,
one for `unified`), each a gutter of line numbers (two columns in `unified`: old and new) beside a horizontal
`Scroll` of the text, and over them the separators and the app's hunk actions. Only the rows in view are made, plus half
a viewport (at least 16 rows) on each side, with at least 40 rows' height before the viewport is known, in a window
that stays put while it covers the rows in view (`RowWindow`, as the `Editor`'s); `each` keeps the rows that stay in
it. A row's text is one `Text` of spans per wrapped line: runs of one syntax token and one inline state
(`controller::spans`). Widths are columns of the font's `0` (tabs as 4 columns, wide characters, CJK, fullwidth forms and emoji, as 2: their East Asian Width, so a side's box is never narrower than its text, which would wrap over the rows below; a line number's column is rounded up to a whole point and a half more, as the platforms round a text's measured width up); the split sides are as wide as the
wider side's widest line and scroll sideways together (each side's `onScroll` scrolls the other, a move of under half a
point ending the echo).

Rows are not of one height: `Geometry` keeps every row's top (a prefix sum), found by binary search for the rows in
view and a press's row. A row is its lines (one, or with `softWrap` the wrapped lines of its line, in a split row the
taller side's) times `lineHeight`, plus the annotations under it. In a terminal a line is one Cell, whatever
`lineHeight` is (`terminal::row_height`): rows on another step would land on the Cell grid unevenly. A terminal's
`renderHunkActions` take a row of their own after each change's last row (and its annotations: `State::action_rows`),
since over the change's first row, as elsewhere, they would cover its code. Soft wrap counts columns, as widths do: the text box's
width (the new side's horizontal scroll view, reported by its layout) less the room around the text, in columns of
`0`, each line broken after its last whitespace that fits, else at the edge, whitespace hanging past it
(`geometry::wrap_starts`); the view draws each wrapped line as a `Text` of its spans, so rows' heights and what they
show agree. Annotations (`annotations`, drawn by `renderAnnotation`) all render, not only those in view (they are few
and their heights move the rows below them); each reports its height from its layout, and a split row's annotations
stack on their side, the row taking the taller stack.

Revisions: `rev` (texts, rows, font, layout options, wrapping), `hl_rev` (highlighting progressed) and `geo` (rows
moved: an annotation's height).

**Line selection.** The gutter takes presses: a press selects its line on the gutter's side (unified: the number
column pressed, else the side the row has), a Shift-press extends from the anchor, and on the desktops the gutter
claims the mouse's touches (`claim_touches`, as the `Editor`'s rows do) so a drag selects the lines it goes over,
rows without a line on that side keeping the last one. A press without a drag also reports `onLineNumberPress`.
`onLineSelectionChange` reports each change of the selection (other texts clear it); `setSelectedLines` sets it
silently. `renderAddAnnotation` shows at the last selected line and at the hovered one (hovers counted over the rows,
the gutter and the control itself, the hover ending a frame after the last leaves, so moving onto the control keeps
it).

**Text selection.** Each side's text box (the `content` part, inside the side's horizontal scroll view) is a
selectable view (`Element::selectable`, `nsh_core::selection`), and every line's `Text` but a filler's carries
`userSelect: "text"` and the platform's own highlight (no `selectionColor`, so it stays apart from the line
selection's tint), so the code selects as any selectable text does on each platform: a drag across rows, a double
click a word, a triple click a line, Shift to extend, the platform's copy (Ctrl / Cmd+C, the terminal's Ctrl+Shift+C).
The gutter (numbers, signs, bars), the separators, file headers, hunk actions and annotations are outside those boxes,
so a copy holds only code, its lines joined by line breaks; a tab copies as the spaces the line shows it as (`expand_tabs`).
With `softWrap`, a wrapped line's later rows continue its first (`Element::continues_text`): a copy gives the line
whole, with no break where the wrap cut it, and a triple click selects all of its rows. A split view has two areas, one per side, so a selection
stays on the side it began on; a unified view has one. Line selection on the gutter is independent of it. Rows leaving
the row window take their texts with them, as for any selectable view whose texts go: a selection whose end leaves
is cleared.

**Navigation.** `nextHunk` / `previousHunk` go on from the change navigated to last while the view stays there (it
reached that place and has not scrolled from it, or is still scrolling to it), else from the top of the view, so a
change near the end that cannot reach the top still counts; they wrap around. `currentHunk` is that change, else the
one at the top of the view, else the first starting in view.

**Scroll position.** `onScroll` reports the vertical scroll view as `ScrollEvent`'s keys do (`offset`, `contentSize`,
`size`; `offset.x` is 0 and the rows are as wide as the viewport). One effect (`report_scroll`) reads `scroll_y`,
`viewport` and the rows' height (`rows_height`, which follows `rev` and `geo`), so a scroll, a resize and every
relayout reach it, and emits only when the three differ from those reported last, from the first layout on (before
it the viewport is unknown). A component cannot tell whether the app listens to one of its events, so it is emitted
either way, one per frame the view scrolls; the JS side drops an event its host has no `on<Event>` handler for before
converting its data (`nsh-js` `components.rs`, `Components::handled`). `scrollOffset()` reads `scroll_y`. `hunkBounds()` is
`hunk_spans` (each change's rows, placed by `Geometry`: wrapped lines and annotations count, and a collapsed file's
changes have no rows) as `Bounds` across the viewport. `onHunkBoundsChange` reports the same list from a second effect
(`report_hunk_bounds`), which follows `rev`, `geo` and the viewport's width (a memo, so a new height alone does not
recompute it) and emits when the list differs from the one reported last: a change can move while the rows keep
their height (one changed line becoming another), which `onScroll`'s values cannot show. `setScrollOffset` sets
`scroll_y` and scrolls the view without an animation, clamped to the rows, for a thumb that follows the pointer
(`goToHunk` and `scrollToFile`, discrete jumps, animate).

`onStatsChange` reports `{ stats }`, a `DiffStats` (`{ added, deleted, hunks }`), once when the view is made and again whenever the
texts are diffed to counts other than those reported last (new props, a hunk kept or reverted), so an app's "+8 −8 ·
5 changes" line follows the props with no ref call. The ref's methods that return a value (`hunks()`, `stats()`) give
Promises in JS, as every component method with a result does (`docs/dev/components.md`).

## Highlighting

Each side has its own `editor::highlight::Highlighter` over a rope of its text, the `Editor`'s highlighting pipeline
(`docs/dev/editor.md` "Highlighting"), with the language and its `Syntax` found by `editor::languages::resolve`: the
engine's registered languages and highlighters first, then the built-in ones. The
controller hands both sides' jobs (and guesses, for lines far past the parse) to one blocking thread at a time, up to
1000 lines past each side's last line in view, as the `Editor` does; the syntaxes load on a blocking thread the first
time (after a frame on WebAssembly). A patch's files each have a highlighter per side, in their own language
(`files::Segment`), whose jobs go out with the others'. Colors are `crate::syntax`'s tokens, as the `Editor`'s and
`TextView`'s code blocks.

## Parts and their defaults

| Part | Default |
|---|---|
| root | `foreground` text in the font: `fontFamily` (default the theme's `font-mono`, else `monospace`), 13 points, rows of 20 |
| `side` | Each side; in `split` a `border` line between them |
| `gutter` | The numbers, 8 points apart, and the indicator |
| `lineNumber` | Right-aligned, as wide as the widest number, `muted-foreground` |
| `lineNumberAdded` / `lineNumberDeleted` | After `lineNumber` (nothing more by default) |
| `content` | 8 points before and after the text |
| `line` | Every row |
| `lineAdded` / `lineDeleted` | Green (`#16a34a`, `#4ade80` dark) / red (`#dc2626`, `#f87171` dark) at 12 % (with `background`) |
| `filler` | `muted` at 50 % |
| `wordAdded` / `wordDeleted` | The same green / red at 30 % |
| `indicatorAdded` / `indicatorDeleted` | `bars`: a 3 point bar at the gutter's edge; `classic`: `+` / `−` in green / red |
| `separator` | `⋯` and the count (or the hunk header) on `muted`, `muted-foreground`; a press expands the gap |
| `hunkActions` | The box of the app's actions, 8 points from the right of a change's first row |
| `lineSelected` | Over the selected rows of their side, gutter and text: the theme's selection color |
| `annotation` | The box of an annotation, under its line across its side (split) or the view (unified) |
| `addAnnotation` | The box of the add control: the gutter's width, a line tall, the control at its right |
| `fileHeader` | A file's header: `▾` / `▸`, the path (`old → new` when moved), `+n` green and `−n` red on `secondary`, a `border` line below; a press collapses or expands the file |

## Limits

- Widths are columns of the font's `0`: exact for monospaced fonts. Wide characters count as two columns, which fonts
  draw them about as wide as (a little less with a narrow `0`), so a line of them may end short of the box's edge.
- Text is shown, not edited: changes revert or keep a hunk at a time.
