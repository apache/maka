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
| `mod.rs` | The component: `DiffViewProps`, `DiffViewEvent` (`Change`, `LineNumberPress`, `StatsChange`, `LineSelectionChange`, `FileToggle`), `DiffViewApi` (the ref's methods); the values: `DiffLayout`, `DiffInline`, `DiffIndicators`, `DiffSide`, `DiffExpand`, `DiffFileStatus` (`PropEnum`s), `DiffHunk`, `DiffStats`, `DiffSeparator`, `DiffChange`, `DiffLine`, `DiffLineRange`, `DiffAnnotation`, `DiffFile` (`JsObject`s) |
| `parts.rs` | The parts the app styles: one `parts!` list makes `DiffViewClasses`, `DiffViewStyles` (each a `PartStyle`) and `DiffViewPart` |
| `model.rs` | `DiffModel`: the line diff and its hunks, the pairs of changed lines that are alike, the words changed within a pair, reverting and accepting one hunk |
| `layout.rs` | `rows`: the rows a diff shows (`Row::Line`, `Row::Separator`; `Row::File`, a file header, made by `files.rs`), `Expansions` (what the user expanded of each gap), patch hunk headers |
| `files.rs` | A patch's files: each diffed on its own and joined into the two sides (`join`), their header rows (`Row::File`) and collapsing (`Files`), each file's highlighting (`Segment`), the default file header |
| `patch.rs` | Unified diffs: `parse_patch` into `FilePatch`es and `PatchHunk`s, the texts a view shows of a file (`FilePatch::texts`), applying a patch (`FilePatch::apply`) |
| `controller.rs` | `Dv` and `State`: the two sides (text, rope, line starts, highlighter, numbering), the model and rows, the revisions bindings subscribe to, what props and the ref do; the cells and spans of a row |
| `geometry.rs` | `Geometry`: each row's top and height (its wrapped lines, the annotations under it), finding the rows at a height; `wrap_starts`: where a line wraps at a column count |
| `review.rs` | What a reviewer does: line selection on the numbers (press, Shift-press, mouse drag), hover and the app's add control, annotations' heights, navigation between changes, the split sides' horizontal sync |
| `view.rs` | The view: the vertical scroll view, the sides (gutter and text), the separators, the app's hunk actions, annotations and add control |

## The model

- **Lines.** A text's lines are split after each `\n`, which stays part of its line for the diff: `"a\nb\n"` and
  `"a\nb"` both have two lines and their last lines differ, so a missing final line break is a change, as git shows
  it. A `\r` before the `\n` is content: texts are compared as they are.
- **The line diff** is imara-diff's histogram algorithm (`Algorithm::Histogram` on an `InternedInput` of the lines),
  then `postprocess_lines`, git's indent heuristic: a hunk that could start at several places slides to the one that
  keeps whole blocks together (a function added after another starts at its own first line, not inside the one
  before). The hunks are in order and never touch: equal lines separate them.
- **Pairing.** Within a hunk, each deleted line is paired with the added line most like it, in order (`align`: a
  weighted longest common subsequence over a similarity from 0 to 1, the better of the common prefix and suffix over
  the longer line, ignoring indentation, which finds an edit in place, and the Dice coefficient of their word tokens,
  which finds words moved). Lines less alike than 0.4 do not pair by similarity; the lines left between two pairs are
  paired in order as far as both sides have lines (as split views show them side by side), and the rest stand alone.
  A hunk of more than 64 lines on a side pairs in order (the alignment is quadratic).
- **Inline changes.** A pair's changed ranges (`DiffModel::inline`) come from a Myers diff of its tokens: words for
  `word` and `wordAlt` (letter, digit and `_` runs, whitespace runs, any other grapheme alone; CJK ideographs, kana
  and hangul are a word each, so a changed character marks only itself), graphemes for `char`. `wordAlt` (the default)
  joins changed words one character apart, so a phrase reads as one change. When more than 70 % of either line
  changed, the line's tint says enough and no ranges are marked; lines over 10 000 bytes get none.
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
(`controller::spans`). Widths are columns of the font's `0` (tabs as 4 columns); the split sides are as wide as the
wider side's widest line and scroll sideways together (each side's `onScroll` scrolls the other, a move of under half a
point ending the echo).

Rows are not of one height: `Geometry` keeps every row's top (a prefix sum), found by binary search for the rows in
view and a press's row. A row is its lines (one, or with `softWrap` the wrapped lines of its line, in a split row the
taller side's) times `lineHeight`, plus the annotations under it. Soft wrap counts columns, as widths do: the text box's
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

**Navigation.** `nextHunk` / `previousHunk` go on from the change navigated to last while the view stays there (it
reached that place and has not scrolled from it, or is still scrolling to it), else from the top of the view, so a
change near the end that cannot reach the top still counts; they wrap around. `currentHunk` is that change, else the
one at the top of the view, else the first starting in view.

`onStatsChange` reports `DiffStats` (`{ added, deleted, hunks }`) once when the view is made and again whenever the
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

- Widths are columns of the font's `0`: exact for monospaced fonts. Soft wrap counts characters as columns, so wide
  characters (CJK) wrap later than they fill the line.
- Text is shown, not edited: changes revert or keep a hunk at a time.
