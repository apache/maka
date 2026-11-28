# Component benchmarks

The screens of the component benchmark with `TsButton.tsx`, a Button written in TSX (drawn exactly like the Rust
Button of the benchmark's own UI set, `test/ui`, with the default theme):

- `GridTs.tsx`: 200 Buttons in a scroll view; the first press target updates every title.
- `RowsTs.tsx`: a recycled list of 1000 rows with a Button each.

`cargo test --release -p nsh-engine --test engine bench_components -- --ignored --nocapture` prints the JS and core
time of each screen with both Buttons; `nsh test examples/bench/GridTs.tsx --trace` shows the mount items. Results:
`docs/dev/performance.md`.

`PositionalClasses.tsx` mounts 1,000 real siblings with `odd:` classes:
`nsh test examples/bench/PositionalClasses.tsx --trace`. Change `COUNT` to compare sizes,
`CLASSES` to compare ordinary styles or `first:` / `last:`, and `EACH` to exercise deferred row
creation. Its plain View has no Scroll viewport, so Each eventually creates every row.
The Core benchmark isolates operation application and commit:
`cargo test -p nsh-core bench_positional_mount -- --ignored --nocapture --test-threads=1`.

`Inputs.tsx` holds the input controls' hot paths: a searchable Select of 10 000 items, a TimeField, a NumberInput and
an OtpInput. Steps on standard input drive them, `--trace` shows each keystroke's commit, e.g.
`echo 'await app.press("Pick"); await app.type("Search", "4"); await app.type("text:4", "2")' | nsh test examples/bench/Inputs.tsx --trace`.

`data-table/` is a DataTable of 100 000 rows × 20 columns whose app serves the rows around those in view
(`onVisibleRowsChange`), as an app over more values than a prop takes (a million) must. Its test opens a 1280 × 800
desktop viewport and drives steady vertical scroll steps through `nsh/test`, verifying that `onVisibleRowsChange`
advances past the initial 200-row page. Run headless with `--trace`, or on a desktop host with `--fps -v`:

```sh
nsh test examples/bench/data-table/scroll.test.tsx --trace
nsh test examples/bench/data-table --target macos --fps -v    # or windows / linux
```

Set `EXTERNAL_DRIVER=1` to hold the 1280 × 800 window open for 20 s while an outside driver (such as Xvfb and XTest
dragging the scroll bar's thumb on Linux) drives it while `--fps` logs:

```sh
EXTERNAL_DRIVER=1 nsh test examples/bench/data-table --target linux --fps -v
```

Results: `docs/dev/performance.md`.

`RichEditor.tsx` holds 1,000 paragraphs of 80 ASCII characters. Each press alternates inserting and deleting one
character in the first paragraph, retaining the rows' keys and order:

```sh
echo 'for (let i = 0; i < 8; i++) await app.press("id:edit");' | nsh test examples/bench/RichEditor.tsx --trace
```

Compare the final four edits after four warmups. Headless runs keep the complete document mounted; the trace
includes selection geometry as well as the changed text. Results: `docs/dev/performance.md`.

`RichEditorLongDocument.tsx` holds a long Markdown document (5,000 source lines by default, `LINES`): per section a
heading, paragraphs with marks and links, a list, a code block, a pipe table and a quote. Its first commit is the
mount of every block; it grows linearly with `LINES`:

```sh
echo 'await app.wait(100)' | nsh test examples/bench/RichEditorLongDocument.tsx --trace
```

`MarkdownDefinitions.tsx` sets about 40 KB of Markdown with link and footnote definitions, then replaces text
near the start on each press. The replacement is prepared before the press, and keeps the document's shape:

```sh
echo 'await app.wait(100); for (let i = 0; i < 6; i++) await app.press("id:replace"); await app.wait(100);' | nsh test examples/bench/MarkdownDefinitions.tsx --trace
```

Compare the initial set and all six replacements, including every mount item. The parser-only controls are
`cargo test --release -p nsh-base --lib bench_streaming -- --ignored --nocapture --test-threads=1`.
Results: `docs/dev/performance.md`.

`RichEditorNodeViews.tsx` holds one paragraph with 300 inline stock tags, each rendered by the app's component
(`addNodeView`). Each press inserts or removes one character before them: every tag moves, none of their values
changes, so no JS runs for them (a runtime without `addNodeView` draws them as plain atoms):

```sh
echo 'for (let i = 0; i < 8; i++) await app.press("id:edit");' | nsh test examples/bench/RichEditorNodeViews.tsx --trace
```

`TextViewStream.tsx` shows a streamed reply in a `TextView`: 600 short blocks (the rows of an `each`), then 24
bytes more with each press, so the last block grows or one comes after it while the rows before stay:

```sh
echo 'await app.wait(100); for (let i = 0; i < 40; i++) await app.press("id:more");' | nsh test examples/bench/TextViewStream.tsx --trace
```

Compare the presses' commits and every mount item. The core's own control is
`cargo test --release -p nsh-core bench_each_update -- --ignored --nocapture`. Results: `docs/dev/performance.md`.

`jank/` is the end-to-end jank benchmark: startup to the first frame, and the frame gaps while animations run and a
10,000-row List scrolls, on the desktop's development host (`python3 examples/bench/jank/jank.py`). It fails over the
budgets in `docs/dev/performance.md` (End-to-end jank), where its baselines are.
