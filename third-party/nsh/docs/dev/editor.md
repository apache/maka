# Editor

`Editor` (`nsh/base`, `crates/nsh-base/src/editor/`) is a code editor: syntax highlighting, line numbers, several
carets, folding, soft wrap, find and replace, diagnostics and decorations, with the keys of code editors. It is the
port of GPUI Kit's `Editor` (`gpui-kit/crates/base/src/input/`) to NSH's primitives: the editor draws its text itself,
as one `Text` per display row, and keeps its own model in Rust. It owns behavior (editing, selections, keys, input
methods, folding, search, accessibility) and, as `TextView` does, has a default look of its own built from the
theme's tokens (the second exception to "No styles in NSH", `AGENTS.md`), every part of which the app restyles. The
user-facing page is `website/elements/editor.md`; how each module works inside is in its `//!` docs.

| File | What |
|---|---|
| `mod.rs` | The component: `EditorProps`, `EditorEvent`, `EditorContextMenuEvent`, `EditorCommand` (what `run` takes), `EditorApi` (the ref's methods) |
| `data.rs` | The values the editor and the app pass each other: `EditorPosition` (line, UTF-16 column), `EditorRange`, `EditorSelection`, `EditorSearch`, `EditorSearchResult`, `EditorDiagnostic` / `EditorDiagnosticSeverity` / `EditorDiagnosticTag` / `EditorDiagnosticCodeDescription` / `EditorDiagnosticRelatedInformation` / `EditorLocation`, `EditorDecoration` |
| `parts.rs` | The parts the app styles: one `parts!` list makes `EditorClasses`, `EditorStyles` (each a `PartStyle`, as `TextView`'s) and `EditorPart` |
| `controller.rs` | `Ed`: the state, the revisions bindings subscribe to, and what props, keys, typing, presses, the clipboard and the ref do to them; scrolling the caret into view; scheduling the highlighter |
| `state.rs` | `State`: what the editor holds between frames, outside the reactive graph (buffer, selections, display map, highlighter, marks, matches); what the view draws of each row (`row_content`, `gutter_row`, the rectangles of selections, matches, brackets, diagnostics, indent guides) |
| `view.rs` | The view: the scroll views, the gutter, the rows' box and its layers, the sink |
| `completion.rs` | Completion: the session (requests, the query, what ends it), filtering and ranking, the list's keys, accepting, inline completion, and the list's overlay and ghost text |
| `definition.rs` | Go to definition and code actions: `onDefinitionRequest` (Mod over a word, Mod-click, F12), the link the app's answer underlines (`presentDefinitionLink`) and what hides it, `onCodeActionRequest` (Mod+.) |
| `hooks.rs` | What language features are built on: hovers (`onHover` / `onHoverEnd`), `onTextPress`, the ref's geometry and scrolling (`caretBounds`, `rangeBounds`, `revealPosition`, `goToLine`, ...), where the editor is in the root view |
| `layout.rs` | Sizing and scrolling: `EditorScrollBeyond`, the height of an editor growing with its text, the margin around the caret, scrolling while a drag is past the edges |
| `touch.rs` | Touch selection: taps, double taps and long presses, the range a touch made, its handles and their drags, the edit menu's `onContextMenu` (`EditorRect`) |
| `buffer.rs` | The text: a `ropey::Rope`, edits as change lists, undo / redo with grouping, UTF-16 positions, the lines each change touched (`LineSpan`) |
| `types.rs` | `Point`, `Selection`, `Selections` (the primary one, the newest, kept apart), the trait `RowLayout` the moves use |
| `movement.rs` | Graphemes, words and their parts (camelCase, snake_case), paragraphs, smart Home / End, vertical moves keeping their x, matching and enclosing brackets |
| `commands.rs` | `Command`, `Editing`: every editing command at every selection, typing (auto-close, step-over, outdent), paste, copy, cut; `commands/selecting.rs` (the previous occurrence, splitting into lines) and `commands/transforms.rs` (sorting lines, case, trailing whitespace, block comments) |
| `select.rs` | The selection history (`undoSelection`), expanding and shrinking selections, block selections, the scope of a search in the selection |
| `keymap.rs` | The default key bindings as data, in `nsh`'s keystroke syntax, Apple's and the others' |
| `language.rs` | `LanguageConfig`: per-language comments, brackets, auto-close pairs, word characters, indentation, tab size and the syntax hint; the lookup by name, alias, extension or file name |
| `display.rs` | `DisplayMap`: tabs, measured widths, soft wrap and folds as display rows |
| `fold.rs` | Where folds can start, by indentation |
| `fold_set.rs` | Folds as sets of ranges: the app's `foldRanges` normalized and carried through edits, the folded set after an edit, levels, nesting, the outermost folds |
| `search.rs` | Find and replace on `regex`: matches, replacements with groups, the next and previous match |
| `diagnostics.rs` | `Mark<T>`: the app's ranges resolved to byte ranges once (line by line, an ASCII line's columns taken as bytes) and carried through edits (only the marks from the first change on, in order); the gutter's severities by binary search |
| `highlight.rs` | `Highlighter`: the highlighting pipeline (tokens by line, jobs off the engine thread, guesses, edits), `Syntax` (what highlights a language), the built-in highlighter on syntect (feature `highlight`) |
| `highlighter.rs` | `EditorHighlighter`, the trait of the app's highlighters, and what crosses it: `EditorText`, `EditorTextEdit`, `EditorTokens`; `EditorToken::from_scope` |
| `languages.rs` | The engine's own languages and highlighters: `EditorLanguage`, `register_language`, `register_highlighter`, and `resolve` (registered first, then built in) |
| `app_highlight.rs` | The app's highlighting: decorations' `token`s over the highlighter's tokens; a row's decorations found by binary search |
| `../syntax.rs` | What `TextView`'s code blocks and the editor share: `Token`, Allsum's palette, the syntaxes and the scope → token mapping |

## How it works

### The model

- **Offsets are byte offsets of the UTF-8 text**, on char boundaries, everywhere inside the editor. Lines end with
  `\n` only: the buffer turns `\r\n` and `\r` into `\n` as text comes in, so a text of `n` line breaks has `n + 1`
  lines. The JS API speaks positions (`EditorPosition`: a line and a UTF-16 column from 0, as JS strings and LSP's
  `Position` do), converted at the edge (`Buffer::position` / `offset_of`, clamped), so a language server's
  diagnostics pass through as they come.
- **An edit is a change list.** `Buffer::edit` takes the edits of one command at once (ranges of the text as it is,
  sorted, not overlapping) with the selections before and after, and returns the `Change`s applied; everything that
  follows the text (the display map, the highlighter, marks, matches) is brought up to date from them in
  `State::changed`, through the one `LineSpan` the list touched.
- **Undo** groups as editors do: runs of typing at one place merge into one step while each edit starts where the
  previous ended, a whitespace typed after a word starts a new step, deleting merges likewise, and a move, a press or
  `setSelections` ends a group (`break_undo_group`). Each step restores the selections it had. At most 1000 steps
  are kept.
- **Selections** are a list with a primary one (the newest: the last one `onSelectionChange` reports and `selections()`
  returns), merged when they overlap. Every command runs at every selection (`commands.rs` gathers each command's edits
  as a plan, applies them in one `Buffer::edit` and carries each selection through all the edits). Each move records
  the selections it leaves (`select.rs`, at most 100), which `undoSelection` / `redoSelection` go back and forth
  through; an edit forgets them, as their offsets no longer mean the same text. `expandSelection` grows each selection
  to the smallest unit around it that is larger, without a syntax tree: the word, a string's contents (the language's
  `string_quotes`, paired on the line), the string, a bracket pair's contents, the pair, the line's text, the whole
  lines, the text; `shrinkSelection` retraces those steps while nothing else moved the selections.
- **The text is controlled or the editor's own.** `value` replaces the text as one undoable edit that changes only
  what differs (the common prefix and suffix stay, so carets and folds away from the change stay put); the value
  `onChange` just reported is recognized and costs nothing. `defaultValue` is the first text of an uncontrolled
  editor.
- **The language** (`language.rs`, static data) is found by name, alias, extension or file name, case-insensitive
  (`"rust"`, `"rs"`, `"main.rs"`, `"tsx"`, `"Dockerfile"`), among the engine's registered languages first
  (`languages.rs`, see "Highlighting"); anything else is plain text. It decides the comment
  tokens, brackets, auto-close pairs, extra word characters (`$` in JS), whether lines indent after (an opening
  bracket at the end, Python's `:`, Ruby's `do`) and outdent (a closing bracket, `end`), and the default tab size and
  hard tabs (`tabSize` and `hardTabs` override them).

### The display map

`DisplayMap` lays the text out in display rows: one vector of rows, with the first row of every line beside it, so
line → row is an index and row → line a field. Tabs advance to the next stop; widths come from the editor's font,
measured per char with the platform's text engine (`measure_text`) and cached, and summed along a row (exact for
monospaced fonts, close for others). Without soft wrap a row is a line and nothing is measured while laying out (a
row's width is measured when the scroll width first needs it; above 20 000 rows only the rows in view are measured,
as they show, and the scroll width grows to the widest seen), so 200 000 lines lay out in about 30 ms. With
`softWrap`, a line breaks after whitespace where the row would overflow, else between graphemes, and its continuation
rows start at its indentation unless that is over half the width. A folded line shows as one row and the lines it
hides as none. An edit lays out only the lines of its `LineSpan` and shifts the rows after them.

### Rendering and virtualization

The view is a vertical `Scroll` of a row of the gutter and the text area (a horizontal `Scroll` without soft wrap).
The scroll views hold the hit layer: boxes of the rows' size that take the wheel, the scroll bars, touches,
presses and the pointer's cursor. The active-line backgrounds are drawn in these boxes, below the scroll indicators.
The text and foreground decorations are the paint layer, drawn over the scroll views (`pointer_events(None)`)
and moved by the offsets they report (`top(-scroll_y)`, `left(-scroll_x)`): the rows the offset needs and the offset
itself come in the same commit, so a scroll bar dragged across a long file or a paste of many lines never shows a
frame where the platform moved the content before the rows it needs were made. The paint layer's views keep the hit
layer's handlers, so tests that press a row's text reach the same code. Only the rows in view are made, plus a
viewport and a half (at least 16 rows) ahead in the way they scroll and half a viewport behind, and at least 40 rows'
height before the viewport is known. That window (`window.rs`'s `RowWindow`, which the `DiffView` shares) stays put
while it covers the rows in view with half a viewport to spare, so most scroll frames change no rows and commit
nothing; the row list is a memo of the window, and `each` keeps the views of rows that stay in it. Each row is an absolutely placed view holding one `Text` whose spans are
the row's runs of one token and one set of decorations (`State::row_content`). The rows' box draws, from back to
front: the rulers, indent guides, search matches, selections, the matching brackets,
the rows, the whitespace marks, diagnostics' marks, the placeholder, the carets and the composition. Each layer is a
`dynamic` over the revisions it depends on.

`showWhitespaces` draws a `·` per space and a `→` per tab over the rows in view: one `Text` per run of spaces and per
tab, placed and sized by the display map (`DisplayMap::whitespace`), so the row's own text and its measuring stay as
they are. `rulers` are 1 point lines at columns a space wide (`State::ruler_xs`), the rows' box's height.

### Sizing and scrolling

`layout.rs` holds the arithmetic. `scrollBeyondLastLine` (`EditorScrollBeyond`: `true`, `false` or a number of rows)
is the room the rows' box has past its last row. With `minRows` and / or `maxRows` the editor grows with its text: the
root's height is its display rows within those bounds plus the padding its parts take around the rows (the vertical
scroll view's content as last laid out, less the rows' box), and there is no room past the last line; past `maxRows`
the text scrolls. Moving the caret keeps `cursorSurroundingLines` rows around it (a row by default, at most a quarter
of the viewport; never more than half of what the caret's row leaves).

A drag that selects (`drag_to`) never jumps to the caret: while the pointer is near or past the viewport's top or
bottom edge (from 16 points inside), or past the text area's left or right edge without soft wrap, a 16 ms
`set_interval` scrolls by 12 to 64 points a tick, faster the farther out (`edge_speed`), within the content, and
extends the selection to the pointer again; it stops when the pointer comes back, on release, and when the drag ends.

Revisions (`Signal<u64>` in `Ed`) keep a change to the parts that depend on it: `text_rev` (the text or its layout),
`hl_rev` (highlighting progressed), `sel_rev` (selections), `marks_rev` (diagnostics, decorations, matches). The state
itself lives in an `Rc<RefCell<State>>` outside the reactive graph.

### Typed text and input methods

A native `Input` (the sink), invisible, 1 point wide and a row tall, is kept at the primary caret, so input methods
open their candidate windows there and soft keyboards show. It lies over the scroll views, not in them, placed in the
editor's box (`Ed::in_editor`) and held inside it: the platforms scroll the scroll views around a focused field to
show it, which the editor does itself for its caret, and doing it again moved the text under the caret by a margin,
animated, when the editor took the focus. It holds only what was just typed: each `onChange` is
compared with what it held, and the difference becomes Backspaces and typed text at every selection (`sink_changed`),
which is how autocorrection and input methods that replace their text work. While an input method composes, its text
is drawn at the caret over the text (the `composition` part, underlined) and the carets hide; the commit arrives as
typed text. The sink is emptied when the caret moves (unless a composition is under way) and once it holds 256 bytes.
A paste reaches the sink as a paste event (`PasteBehavior::Report`) and goes through `Editing::paste`; text copied
from carets (whole lines) pastes back as whole lines.

### Keys

The bindings of `keymap.rs` are registered with `on_key_with` in an effect that runs while the editor has the focus
(`focused`), so arrows and Tab reach other inputs when it does not. They are data: `default_bindings(apple)` gives
macOS and iOS their conventions (Option moves by words, Command to line and text ends, Cocoa's Emacs keys) and the
others theirs (Control by words, Home / End, Control+Home / End), on a common VS Code set. The commands the
controller runs itself (find next / previous, folding, `findWithSelection`, the selection history, expanding) are bound
from `editor_bindings(apple)`, as the `EditorCommand`s `run` takes: VS Code's keys (`cmd+g` / `cmd+shift+g` on Apple
platforms and `f3` / `shift+f3` everywhere, `cmd+alt+[` / `]` or `ctrl+shift+[` / `]` to fold, `cmd+e`, `cmd+u` or
`ctrl+u`, `ctrl+shift+cmd+right` / `left` or `shift+alt+right` / `left`, `f12` to go to a definition and `mod+.` for
code actions). Copy and cut (`mod+c`, `mod+x`) are the
controller's, through the clipboard. `run(command)` runs the same commands from the app, plus those that have no
default keys (fold all, sorting lines, changing case, trimming trailing whitespace, paragraph moves, paste from the
clipboard), for the app's own bindings and menus.

### Presses

On the desktops a press (`PressDown`) places the caret, a double press selects a word, a triple press a line, Shift
extends the primary selection, Alt (Option) adds a selection; dragging extends what the press selected by its unit
(`drag_to`). An Alt+Shift press (on Linux also Control+Alt, where window managers keep Alt drags) drags a block: one
selection per display row between the press and the pointer, each from the press's x to the pointer's (`select::block`),
so the block keeps its columns past the end of short rows, which select what they have; the pointer's row is primary. On touch screens (`touch.rs`) a tap places the caret, a double tap (two taps within 300 ms and 24 points,
or a platform's click count of 2) or a long press selects the word under the finger (a long press on blank space places
the caret), and the range it made becomes the touch selection. While it is the selection (one selection, exactly that
range) and the editor has the focus, a handle stands at each end: a hit area 32 points wide over the end's line and
the knob's room (above the start's line, below the end's), holding the `selectionHandle` knob. A handle claims its
touches on start and keeps them from the scroll views (as a resize handle does), so the text around it still scrolls
with a finger; dragging moves that end (`drag_selection`: the other end stays, the end stops at the other one, and
passing it swaps them), scrolling near the viewport's edges as the caret shows. Anything else that changes the
selection drops the touch selection without a word. A long press, a double tap, a handle let go and a tap on the
selection (or a handle) report `onContextMenu` with `selection`, the selection's box in the root view (its rows in
view), and `x` / `y` at its top middle: the app opens its edit menu there. A secondary press reports `onContextMenu` with the position in
the text and the point in the root view, for the app's `Menu.popup`. A press on a line number reports
`onLineNumberPress` (a breakpoint's place); a press on a fold marker or a fold's placeholder toggles the fold.

### Language features

Completion, go to definition and the request for code actions are built in (`completion.rs`, with `completion`;
`definition.rs`); hover cards and code action menus are the app's, built on what gpui-base's `lsp` hooks use
(`hooks.rs`). Completion is the editor's because a view's key bindings win over the
app's (`Core::keymap`): while the editor has the focus Up, Down, Enter, Tab and Escape are its own, so only it can
give them to a list. Typing a word character at a word's end asks the app (`onCompletionRequest`, trigger `typing`,
the query the word before the caret), as does one of `completionTriggerCharacters` (`character`, an empty query after
it) and `showCompletions` / `run("showCompletions")` (`invoked`, no default keys). Requests count up (`id`); the
app answers with `presentCompletions(id, items, incomplete)`. A session keeps where its query starts: typing on in the
word filters the answer in Rust without asking again (unless it was `incomplete`), and it ends when the caret leaves
the word (left of the query's start, across a character that is not a word's, to another line), the selection grows,
an edit lands before the query, a character that is neither a word's nor a trigger is typed, a word typed back to its
start, the focus goes, the caret scrolls out of view, a press lands outside the list, or on Escape and accepting. An
answer to an older request or a session that ended is dropped, and so is one arriving after an edit the session did not
see (the app's `value`). Filtering is a subsequence match in any case over `filterText ?? label`, the most compact one
per item: prefix matches first, then the fewest characters between the matched ones, then `sortText ?? label` (in any
case first); the matched characters of the label are the `completionMatch` part. While the list shows, `up` / `down`
(and `ctrl+p` / `ctrl+n` everywhere) move around its ends, `pageup` / `pagedown` move a page, `enter` and `tab` accept,
`escape` closes: bound in an effect while it shows, after the editor's own, so they win. The pointer over an item marks
it and a press accepts it (on the desktops at the press down, before anything could take the focus; on touch screens
at the tap). Accepting replaces the item's `range` (default from the query's start to the caret) with
`insertText ?? label` as one undo step, at the primary caret and at every other caret preceded by the same text (as VS
Code does; the others stay), without asking again, then reports `onCompletionAccept`; snippets go in as plain text.
The list is an overlay (`<Overlay>`, which never takes the focus) anchored to a 1 point view at the query's start on
the caret's row, in the rows' box, so the core places it below (above without room) and follows the scrolling; it
makes only the rows in view of its own scroll view (ten at most show), sized to the widest label and detail in the
editor's monospaced font; the selected item's `documentation` shows beside it. Inline completion: after an edit that
typed text, once typing pauses `inlineCompletionDelay` (one task waits, whatever the number of keystrokes) with no list
showing, `onInlineCompletionRequest` asks; `presentInlineCompletion(id, text)` shows it at the caret in the
`inlineCompletion` part (over the text after the caret, on the editor's background, mid-line; its further lines on the
rows below), Tab inserts it as one undo step, Escape, any edit, any move and the list opening clear it. Without
`completion` nothing of this runs on a keystroke.

The mouse resting 150 ms (`HOVER_DELAY`) over a character reports
`onHover`: the character's position and UTF-16 offset, its word's range, the pointer and the word's box in the root
view, the modifiers and the diagnostics there. While a hover is shown, moving inside its word reports nothing and
moving to another word reports the next one at once; leaving the text, an edit, a new layout or scrolling reports
`onHoverEnd`. One task waits for the pointer to rest, whatever the number of moves. A press on a character reports
`onTextPress` (position, word, modifiers, clicks) after the editor placed its caret. The ref places popups and moves: `caretBounds()` and `rangeBounds(range)` give boxes in the editor (its
scrolling applied) and in the root view, `visibleRange()` what the viewport shows, `revealPosition` / `goToLine`
scroll (centered on request), `offsetToPosition` / `positionToOffset` convert UTF-16 offsets of `value()`. `edit`
applies a language server's `TextEdit`s (code actions, formatting): the ranges sorted, overlapping ones after the first
dropped, all replaced in one `Editing::replace` between two `break_undo_group`s (`replace_in_one_step`, which
accepting a completion uses too), the selections carried as through any edit.

Go to definition takes the shape of completion: the editor asks, the app answers later through the ref, the main
thread never waits for JS. Mod held (Command on Apple platforms, Control elsewhere, as `bind_keys` decides `apple`;
Alt not held, which adds carets) with the pointer over a word asks at once (`onDefinitionRequest`, trigger `hover`:
`id`, the character's position and UTF-16 offset, the word's range), unless the pointer is inside the word asked about
or the link shown; blanks and punctuation ask nothing. `presentDefinitionLink(id, range)` answers the last hover
request: the range is underlined (the `definitionLink` part, a view per row it covers in the rows' box, under the
glyphs) and the hit layer's cursor turns into a hand (`style_when` over the link signal), until Mod is released, the
pointer leaves the range or the editor, or the text, its layout or the scrolling changes (`follow_definition`), or
`hideDefinitionLink()`; each of these also drops the request out, so an answer to any but the last request, or one
arriving after an edit, is ignored. The platforms report a modifier key pressed or released under a still mouse as a
hover move where it is (`elements.md`), so pressing Mod over a word asks without moving the mouse; `hover_move` then
also reports `onHover` again for the word shown, with the new modifiers. A Mod-click on a word asks with trigger
`press` after `onTextPress`: on the link the caret stays where it is (as GPUI Kit's editor does), elsewhere the press
places it first. `goToDefinition` (F12) asks with trigger `key` at the primary caret, for the word there (the word
before it at a word's end). Answers to `press` and `key` are the app's to act on (`revealPosition`, `setSelections`,
opening another file). `showCodeActions` (Mod+.) reports `onCodeActionRequest`: the primary selection, start first,
the caret, and the caret's box (`caretBounds`), where the app opens its menu of the language server's actions, whose
edits `edit` applies.

Where the text is in the root view: the editor and its rows' box are measured (`ElementRef::measure`) after their
layouts and when the gutter changes width, and every pointer event over the rows tells where they are then (its
`pagePosition` less its `position`). The rows move in the editor only with its own scrolling, which the controller
knows, so a box is placed with what was last seen and the scrolling since: an editor moved by a scroll view around it
is placed right again on the next pointer event or layout.

### Highlighting

`highlight.rs` is one pipeline for every highlighter: the built-in one, syntect line by line (the syntaxes and scope
mapping of `crate::syntax`, shared with `TextView`), and the app's (`EditorHighlighter`, below). The tokens stay on
the engine thread, by line; the highlighter goes off it. The controller hands a `Job` (the highlighter, a snapshot of
the rope, 25 ms of work) to a blocking thread, shows the lines it gave tokens and hands the next, up to 1000 lines past
the last one in view, until the highlighter says those lines are current. Edits made while a job is out are kept and
given to the highlighter when it comes back; the lines it highlighted from the text before them move with them (those
the edits replaced are dropped). When the lines in view are more than 500 lines past the highlighter's frontier (a jump
to the end of a long file), a `Guess` highlights them with a highlighter made for it, starting 40 lines before them,
and shows that until the highlighting from the top reaches them; a highlighter that does not guess is not asked
again. Nothing is parsed on the engine thread: syntect costs about a millisecond a line, so a guess of the lines in
view there took tens of milliseconds an edit in a long file (held paste keys never let a frame out); lines with no
tokens yet (pasted, or jumped to) show plain until the job or the guess brings theirs, a frame or two later, as
gpui-component's highlighters leave a long document's new text until their background parse. An edit shifts the tokens of the lines it
touches with the text (`LineEdit`): typed text takes the color of the token it extends and the rest of the line keeps
its colors until the highlighter gives the line new ones, so colors do not flicker. Lines not highlighted again keep
the tokens they had. On WebAssembly there are no threads: jobs run in place, 4 ms per frame. `highlighting={false}`
drops the highlighter (and never loads the syntaxes for it) while the language keeps deciding comments, brackets and
indentation.

The built-in highlighter keeps syntect's state every 16 lines (and on lines that kept one before an edit). An edit
marks the lines from its first one dirty; parsing starts at the nearest state kept before it and stops as soon as a
line ends in the state the next line started with before, so typing in a function costs a few lines. Only an edit that
changes what follows (opening a block comment or a string) parses on. The syntaxes load on a blocking thread the
first time a language needs them. Without feature `highlight` the built-in languages are plain; the app's
highlighters still run.

The app's highlighters and languages (`highlighter.rs`, `languages.rs`) are kept per engine, in a value of the
surface (`nsh_core::element::global`), never process-wide. `register_language` adds an `EditorLanguage` (a
`LanguageConfig` built with `const` methods, so a `static`); `register_highlighter` binds a factory of
`EditorHighlighter`s to a language name (resolved when registered: `"rs"` binds Rust). `languages::resolve` finds a
name among the registered languages (latest first: name, alias, extension, then as a path) before the built-in table,
and the language's `Syntax`: the app's factory, else the built-in hint. The editor's language effect and the
`DiffView`'s texts effect read the registrations tracked, so a registration since finds them again. A Rust app
registers in its root before it mounts its editors; a UI set (an app's crate, `#[native_module]`) does in
`Registry::setup`, which the core runs in its runtime when it takes the sets (`Core::set_components`), before the app's
first op. An `EditorHighlighter` is `Send` and runs where the jobs run. It hears every edit as an `EditorTextEdit`: the
lines (what a line-by-line highlighter reads) and the bytes and places of tree-sitter's `InputEdit` (one change as it
is, several as one over the lines they touched; a new text as every line changed). The places cost a scan of the
edited line, so only the app's highlighters get them. It gives tokens per line through `EditorTokens::line`, which
sorts out overlaps and joins touching tokens of one kind; `EditorToken::from_scope` maps tree-sitter captures and
TextMate scopes onto the kinds. A registered highlighter for a built-in language replaces syntect for it.

`onChange` carries the text as a `SharedString`, built once per version of the buffer: the same text is not built
again for the echo of a controlled `value`. Building it is the one cost of an edit that grows with the text.

### Search

`search` is a prop: its matches (at most 10 000) are found again on every change of it and every edit, highlighted
(`searchMatch`, `currentSearchMatch` for the one the primary selection is on), and reported with `onSearchChange`
(`{ count, current, error }`). A plain query is escaped into a regular expression, so both kinds run on `regex`:
Unicode case folding, linear time whatever the query, `^` / `$` at every line's start and end, whole words by word
boundaries. `findNext` / `findPrevious` (commands) select the next / previous match from the primary selection,
wrapping; `replace(text)` replaces the current match and selects the next, `replaceAll(text)` replaces every match as
one edit and returns how many. Replacements expand `$1` and `${name}` for regular expressions. `inSelection` keeps
the matches inside a scope: what was selected when the search turned to the selection (the carets' lines when nothing
was), kept while it stays on and carried through edits as marks are (`State::set_search`). The find bar is the app's;
`findWithSelection` (`cmd+e`) reports the selected text (a caret: its word) with `onFindWithSelection` for it to take
as its query.

### Diagnostics and decorations

`diagnostics` and `decorations` are resolved into byte ranges once when the app sets them (`diagnostics::resolve`)
and carried through every edit (`adjust`, through `map_offset`), so a mark stays on its text while the user types and
the linter has not answered yet. A diagnostic underlines its text with a 1 point wavy line in its severity's part, as GPUI
Kit draws it: the spans are cut at its bounds and carry the most serious severity over them (`SpanTags`), so the text
engine draws the line; an empty range marks the character after it (the one before it at a line's end), and on an
empty line a short line a space wide is drawn under the row (`diagnostic_rects`). A decoration's `class` / `style` style its text (the spans are cut at its
bounds), its `lineClass` / `lineStyle` the rows of its lines behind the text. A row looks for its decorations by two
binary searches over the marks (sorted by start): those starting from the longest mark's length before the row
(`decoration_reach`) up to its end, so thousands of short ones (semantic tokens) cost a row only its own.

A diagnostic is LSP's `Diagnostic` with names for its enums: `codeDescription` and `relatedInformation` are data the
hover hands back (related ranges as the app gave them, as they may be in other documents), and `tags` style its text.
A tagged diagnostic's text is cut into spans as a decoration's is, in the same pass of `State::row_content`: the row
finds the tagged diagnostics over it by the same two binary searches (`app_highlight::near`, with `tag_reach`, the
longest tagged diagnostic's length, kept with the marks), and each span carries the union of their tags
(`SpanTags`). The view gives an `unnecessary` span `muted-foreground` and a `deprecated` one a line through, then the
`unnecessaryText` / `deprecatedText` parts' classes and styles and the span's decorations' over them: one text run
per span, no view per diagnostic. A hint with a tag draws no mark under it, as language clients show such hints in
their text alone.

A decoration's `token` (`EditorToken`: the built-in kinds of `crate::syntax`) is the app's highlighting: its text takes
that token's colors in place of the built-in highlighter's there (the innermost decoration's token wins), its `class` /
`style` over them. It is how an app plugs in a highlighter of its own (a language server's semantic tokens, a parser in
the app), rather than a second API beside decorations: the ranges are the same data, resolved and carried through edits
the same way, and the tokens give the app's highlighting the editor's palette in both appearances. The app's
highlighter runs in the app (JS cannot be asked for tokens while a row draws), so its tokens arrive as data;
`highlighting={false}` leaves them alone on the text.

### Folds

Folds are by indentation, as VS Code's indentation folding (`fold.rs`): a line followed by lines indented deeper
starts a fold that hides them; blank lines inside join it, and the line that ends the block at the start line's
indentation (a closing bracket, `end`) stays visible. `foldRanges` replaces them with the app's (`{ startLine, endLine }`,
an LSP `FoldingRange`'s shape): normalized as the indentation's are (sorted, one per start line, crossing ones
dropped) and carried through edits (`fold_set::carry`: a range around an edit grows and shrinks with it) until the app sets
new ones. Where folds can start is computed once per edit, when the gutter first asks, in one pass over the rope's
chunks (about 4 ms for 200 000 lines).

The state keeps every folded range, nested ones included (`State::folded`, as VS Code does); the display map hides the
outermost ones. Folding a block keeps the folds inside it, so unfolding it shows them folded; an edit that unfolds a
fold (one of its lines changed) leaves the folds inside it folded. `fold` on a line no fold starts on folds the
innermost one around it; `foldRecursive` / `unfoldRecursive` take a fold and every fold inside it, `foldLevel(n)` the
folds at nesting level `n`, `foldAll` every fold (nested ones too), `foldSelection` / `foldRange` any lines (a fold
crossing a folded one's end is refused). Folding moves carets inside the fold to the end of its first line; a caret
moving into a fold (a move, a search match, `scrollToLine`) unfolds every fold hiding it. The folds are reported with
`onFoldChange` after each change and read and set with `folds()` / `setFolds()`, as the selections are: the editor owns
them, the app restores them. `folding={false}` removes the markers and the folds.

## Parts and their defaults

The defaults are the theme's tokens (`crate::theme()`), so a theme and the dark appearance reach them; a part's
`classes` come after its own styles, its `styles` over its classes.

| Part | Default |
|---|---|
| root | `foreground` text in the editor's font: `fontFamily` (default the theme's `font-mono`, else the system's `monospace`), 13 points, rows of 20 points |
| `gutter` | 12 points before the numbers, 4 after the markers |
| `lineNumber` | Right-aligned, as wide as the widest number (at least 2 digits), `muted-foreground` |
| `activeLineNumber` | `foreground` |
| `foldMarker` | `⌄` (open) or `›` (folded), a row's height wide, `muted-foreground` |
| `content` | 4 points before the text |
| `line` | Every row (nothing by default) |
| `activeLine` | `muted` at 60 % behind the rows of lines with a caret |
| `selection` | The theme's selection color: its `selection` color, else `primary` at 22 % |
| `caret` | 2 points wide, `foreground`, blinking every 530 ms while focused |
| `composition` | Underlined, on `background` |
| `searchMatch` / `currentSearchMatch` | Amber (`#fbbf24` / `#d97706` dark) at 25 % / 55 % |
| `matchingBracket` | A 1 point border, `muted-foreground` at 60 %, while focused |
| `indentGuide` | A 1 point line of `border` per level |
| `foldPlaceholder` | ` ⋯ ` after a folded line, `muted-foreground` |
| `placeholder` | `muted-foreground` |
| `diagnosticError` / `Warning` / `Info` / `Hint` | A 1 point wavy underline: `destructive` / amber / blue / `muted-foreground` |
| `unnecessaryText` / `deprecatedText` | The text of tagged diagnostics: `muted-foreground` / struck through |
| `whitespace` | `·` per space, `→` per tab, `muted-foreground` at 60 %, while `showWhitespaces` |
| `ruler` | A 1 point line of `border` at each of `rulers`' columns |
| `selectionHandle` / `selectionHandleStart` / `selectionHandleEnd` | A 10 point dot of `primary`, centered in the knob's 16 point room |
| `completionMenu` | `popover` with `popover-foreground` text, a 1 point `border`, radius `radius - 2`, `shadow-md`; as wide as the widest label and detail (160 to 480 points), ten rows tall at most |
| `completionItem` | A row's height, 8 points of padding, the kind, label and detail 6 points apart |
| `selectedCompletionItem` | `accent` behind, `accent-foreground` text |
| `completionMatch` | Semibold, `primary` |
| `completionDetail` | Right-aligned after the label, one line, `muted-foreground` |
| `completionKind` | A short name (`fn`, `var`, `cls`, ...) five characters wide, `muted-foreground` |
| `completionDocumentation` | As `completionMenu`, at most 320 points wide, 8 / 6 points of padding |
| `inlineCompletion` | `muted-foreground`; on `background` mid-line |
| `definitionLink` | A 1 point line of `primary` under the link's text, on each row it covers |

Syntax colors are `crate::syntax`'s `Token` styles, Allsum's palette in light and dark (the table in `text-view.md`
"Syntax highlighting"). The font is a prop, not a class: the editor measures its text in it.

## Accessibility

The sink carries `accessibilityLabel`; the rows are real texts, read in order.

## From GPUI Kit

| GPUI Kit | NSH |
|---|---|
| `InputState` with `code_editor(language)` | `<Editor value language>`: controlled text, the model inside the component |
| Tree-sitter highlighting, themes | Syntect with Allsum's palette (`crate::syntax`), incremental per line; the app's `decorations` for semantic highlighting |
| `InputHighlighter` (the app's highlighter), highlight names resolved to styles | `decorations` with a `token` (the built-in palette's kinds) and `highlighting={false}` |
| `DisplayMap` (wrap, folds), the highlighter's fold candidates | `display.rs` on measured char widths; folds by indentation or the app's `foldRanges`, nested folds kept |
| Search panel | `search` prop, `onSearchChange`, `findNext` / `replace` / `replaceAll`: the find bar is the app's |
| Diagnostics with hover popovers | `diagnostics` marked and carried through edits; `onHover` carries those under the mouse, the app shows them |
| `CompletionProvider` (`completions`, `is_completion_trigger`, `inline_completion`), `ShowCompletions` | `completion`, `onCompletionRequest` / `presentCompletions`, `completionTriggerCharacters`, `onInlineCompletionRequest` / `presentInlineCompletion`, `inlineCompletionDelay`, `showCompletions`: the editor draws the list and the ghost text, the app asks its language server |
| `CompletionHighlighter` (`highlight_prefix`, `highlight_characters`, ...) | One subsequence match, in Rust, highlighted as `completionMatch` |
| `lsp` providers (hover, definition, code actions) | `onHover` / `onHoverEnd`, `onTextPress`, `caretBounds` / `rangeBounds`: the app asks its language server and draws the popups |
| `DefinitionProvider`, `HoverDefinition` (the Cmd-hover underline), `GoToDefinition`, `ToggleCodeActions` | `onDefinitionRequest` (`hover`, `press`, `key`) / `presentDefinitionLink` / `hideDefinitionLink`, the `definitionLink` part, `goToDefinition` (F12), `showCodeActions` (Mod+.) / `onCodeActionRequest`: the editor underlines, the app finds the definitions and shows the actions |
| Key bindings as GPUI actions | `keymap.rs` data on `nsh`'s `keymap`, bound while focused; `run(command)` |
| `show_whitespaces`, `auto_grow(min, max)`, `scroll_beyond_last_line(rows)`, `cursor_surrounding_lines`, `AutoScroll` | `showWhitespaces`, `minRows` / `maxRows`, `scrollBeyondLastLine` (also `true` / `false`), `cursorSurroundingLines`; dragging scrolls past the edges the same way (`layout.rs`) |

## Limits

- Widths are sums of per-char widths: ligatures and kerning are not applied, and rows lay out left to right.
- Highlighting parses from the top down: after a jump to the end of a long file, the lines in view show a guess
  (parsed from 40 lines before them) until the parse reaches them, which can differ inside a long comment or string.
- At most 10 000 search matches are found and 1000 undo steps kept.
- On touch screens the sweep after a long press does not extend the selection: the handles do.
