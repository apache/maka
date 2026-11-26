# Performance

Performance is the project's first priority; the rules are in `AGENTS.md`. Changes to hot paths come with before /
after `nsh test --trace` timings and item counts (`nsh trace` before it, in the records below). Current baselines
(Apple Silicon except where noted):

Sibling position classes looked at once per parent (`core/classes.rs`, 2026-11-23, macOS arm64, release, the change on
`cc19b8b38` against `main` at `2c17143e7`): every child inserted or removed ran `positions_changed` over all of its
siblings at once (cloning the list and counting them), so mounting N rows with `odd:` or `last:` classes looked at
N²/2 siblings, although only the rows whose bits moved were restyled (the 2026-11-15 change below). A parent whose
children move is now queued once and its children's positions looked at before the next flush (`flush_positions`, once
a commit round's components rendered and at each flush), and restyling a row (its hover, its press) takes the bits it
was last styled at while its siblings did not move (`known_position`) instead of counting them. Headless
`nsh test --trace` of an `<Each>` of rows with `odd:bg-neutral-100 last:border-b-0 border-b`, the first commit, three
alternating rounds (the same rows without the positional classes are the control, untouched by this change and by the
commits between the two bases); every mount item is the same:

| Rows | Before | After | Without positional classes |
|---:|---:|---:|---:|
| 1,000 | 6.7–8.9 ms | 4.5–5.8 ms | 4.2–4.7 ms |
| 4,000 | 53–57 ms | 19–21 ms | 17–21 ms |
| 8,000 | 174–184 ms | 43–50 ms | 36–42 ms |

`positions_are_looked_at_once_per_parent_as_rows_mount` keeps the siblings looked at in step with the rows (80,200 and
1,280,800 for 400 and 1,600 rows before, sixteen times).

A long RichEditor document with tables (2026-11-21, Linux x86_64, Intel Core Ultra 7 270K Plus, debug, against
`ca7b8fba3`): every block reports its frame in a layout event of its own, and each event went through all of the
component's handlers to find the block's (a list of every node's), then ran the tables' controls again, one region
laying out every table and making all their handles: the first commit grew with the square of the blocks. The
component's handlers are now kept by node (`Handlers`), and each table's controls are a region that runs again when
that table, a cell of it or a box around it moves (`docs/dev/rich-editor.md`). `examples/bench/RichEditorLongDocument.tsx`
with `LINES` set, `echo 'await app.wait(100)' | nsh test … --trace`, the first commit:

| Source lines | Mount items | Nodes | Before: commit (list js) | After: commit (list js) |
|---:|---:|---:|---:|---:|
| 200 | 2,921 | 1,039 | 109 ms (46 ms) | 71 ms (9 ms) |
| 400 | 5,783 | 2,065 | 272 ms (154 ms) | 137 ms (19 ms) |
| 800 | 11,507 | 4,117 | 951 ms (714 ms) | 278 ms (38 ms) |
| 1,600 | 22,478 | 8,050 | 3,260 ms (2,792 ms) | 537 ms (74 ms) |
| 5,000 | 70,178 | 25,150 | 28,518 ms (27,019 ms), test failed | 1,724 ms (240 ms) |

The rows were measured with the same app mounted without a `Window` (the bench file wraps it in one: 70,177 items at
5,000 lines). Item and node counts are unchanged. The same document without tables went from 75 ms to 37 ms of list js at
1,600 lines (the handlers alone). `examples/bench/RichEditor.tsx` keeps its counts (13,054 items and 4,011 nodes first,
3 or 4 items an edit); its first commit went from 312 to 246 ms (list js 109 → 50 ms), and its edits, five interleaved
runs of the last four, from 409–703 µs (list js 96–134 µs) to 386–610 µs (79–95 µs). The counter keeps 56 / 10 ops,
50 / 7 mount items and 15 / 18 nodes. `an_event_looks_only_at_its_nodes_handlers` keeps an event's handler lookups the
same at 50, 200 and 800 rows.

Rust components' events read by atom (`nsh-js` `components.rs`, 2026-11-20, macOS arm64, release, against the
change below): a Rust component's event reached its `on<Event>` prop through two `String`s of its name, a `format!`
of the handler's name, a `CString` per property read and a `Vec` of one argument; its creation checked each event's
handler the same way, and slot and children readers made a `String` and a `CString` per read. Handler atoms are now
made once per event name (`Components::handlers`), names are compared borrowed (`dom::with_str`), and the other reads
take atoms without a `CString`. `bench_components`, JS time of three rounds of each version run in turn (a press: the
mean of 2,000; a first frame: the least of 40); ops and mount items are the same:

| Entry | Before | After |
|---|---:|---:|
| `PressRust.tsx`, a press delivered to `onPress` | 552–575 ns | 433–449 ns |
| `GridRust.tsx` first frame | 588–604 µs | 573–583 µs |

`PressTs.tsx` (990–1,039 ns a press) is the control. GridRust's update of 200 titles, a path this change does not
touch, read 114–116 µs before and 117–118 µs after; the other entries stay within the runs' spread.

Render keys holding a NUL: the table of what a render function rendered was written and cleared through a
`CString`, which made every such key `""`, so two of them replaced each other's content. The table is now keyed
by the whole key (`keys_holding_a_nul_render_and_go_as_others`).

Rust components' props read by atom (`nsh-js` `components.rs`, 2026-11-19, macOS arm64, release, against
`2ede573ac`): a Rust component's props effect read each of its keys (its value and renderer props and the about 20
host props it does not declare) by name on every run, making the key list again (`ComponentSpec::host_props`, one
`format!` per host prop and event) and a `CString` and an atom per key. The keys and their atoms are now made once per
spec (`Components::prop_keys`) and read with `JS_GetProperty`. `cargo test --release -p nsh-engine --test engine
bench_components -- --ignored --nocapture`, JS time, the least of three rounds of each version run in turn; ops and
mount items are the same before and after:

| Entry | Before | After | Ops | Mount items |
|---|---:|---:|---:|---:|
| `GridRust.tsx` first frame | 988 µs | 598 µs | 1,015 | 386 |
| `GridRust.tsx` update 200 titles | 485 µs | 112 µs | 200 | 63 |
| `RowsRust.tsx` first frame | 289 µs | 263 µs | 263 | 323 |
| `RowsRust.tsx` scrolling, per rebinding frame | 4.04 µs | 1.85 µs | — | — |

The TSX twins (`GridTs.tsx` 1,053 / 127 µs, `RowsTs.tsx` 320 / 2.18 µs) are the controls, unchanged. Apps that set
no props of Rust components after they mount do not show it: headless `nsh test --trace` (debug, three alternating
rounds) of `examples/bench/data-table` (open, press row `#1`), `examples/bench/Inputs.tsx` (open the Select, type a
search) and the counter keep every commit's ops, mount items and nodes, and their commit times stay within the runs'
spread (data-table's first commit 16.6–17.9 ms before, 16.9–19.0 ms after; the Select's 30.0–34.8 ms, 26.4–32.4 ms).

Many children of one parent mounted at once (2026-11-18, Linux x86_64, Intel Core Ultra 7 270K Plus, release, one
CPU, against `6442c86be`): an `each` placed its new rows by searching the parent's children for each one, and a view
made last among its siblings looked through every overlay of the surface (a document's links each have a hint
overlay) for the one it goes below, so mounting a long document grew with the square of its blocks. A new row is now
known from its own parent, the rows are placed next to the one placed before them, and only a root view or a modal
is looked up among the overlays. `cargo test --release -p nsh-core --lib bench_each_mount -- --ignored --nocapture`,
ms from `mount_root` to the finished first `MountBatch` (`FakeEngine`, 320 × 480), the least of three rounds of the
two test binaries run in turn:

| Rows of an `each` | 1,000 | 10,000 | 50,000 |
|---|---:|---:|---:|
| In a view | 10.2 → 9.4 | 195.6 → 145.3 | 3,636.7 → 955.4 |
| In a scroll view (the rows out of sight culled) | 7.3 → 6.7 | 143.3 → 140.2 | 3,683.7 → 845.3 |
| In a scroll view, a hint overlay in each row | 16.8 → 13.1 | 437.1 → 214.6 | 12,531.1 → 1,361.5 |

A scrolled frame of the same rows (20 points a frame) is unchanged: it lays the whole column out again when rows
come into sight. A long Markdown document in a `TextView` in a scroll view (`cargo test --release -p nsh-base --test
base bench_large_document -- --ignored --nocapture`, ms to mount a document read before; with content culling off,
as test drivers have it, every block's view is made):

| Document | Blocks | Culling on | Culling off |
|---|---:|---:|---:|
| 190 KB | 3,474 | 167.9 → 125.8 | 144.4 → 103.8 |
| 950 KB | 17,211 | 907.3 → 647.0 | 1,247.4 → 586.0 |
| 1.9 MB | 34,326 | 2,707.6 → 1,296.7 | 4,473.4 → 1,210.6 |

`rows_mounted_at_once_are_placed_without_a_search_for_each` keeps the siblings and overlays looked at in step with
the rows (four times the rows: about four times the work, sixteen before).

Many components whose root is not a plain view mounted at once (2026-11-18, Linux x86_64, Intel Core Ultra 7 270K
Plus, release, against `0713ce96d`): a tooltip's hint overlay or a text as a component's root takes its kind when
the component renders, and each such root went through all the mount items of the batch, so a document with a
tooltip in every code block grew with the square of its blocks. It now grows with them within a round of renders (a
batch that makes such roots over several rounds, as rows scroll into sight, still goes over its items once a round).
`cargo test --release -p
nsh-core --lib bench_component_roots_mount -- --ignored --nocapture`, ms from `mount_root` to the first
`MountBatch` (`FakeEngine`), the least of three rounds; the mount items are the same before and after:

| Rows of an `each`, a tooltip in each | 1,000 | 10,000 | 20,000 |
|---|---:|---:|---:|
| In a view | 20.4 → 6.7 | 1,745.8 → 198.5 | 6,786.7 → 339.5 |
| In a scroll view (the rows out of sight culled) | 8.9 → 8.6 | 156.2 → 142.5 | 427.9 → 323.8 |

`component_roots_mounted_at_once_take_their_kind_without_a_pass_for_each` keeps the mount items looked at in step
with the rows: for 400 and 1,600 rows in a view, 4,814 and 19,214 items looked at (1,606,400 and 25,625,600
before, sixteen times).

Words fading into a long paragraph (`text_view` with a Markdown plugin, 2026-11-18, Linux x86_64, Ryzen 9 7950X,
release, one CPU): a streamed paragraph whose newest words are spans, hidden until their turn and then fading in
by their text color, about 30 frames a second, two words arriving a frame; a word done fading joins the plain text
again. The text engine is `ApproxTextEngine` drawing colors from the text, as the desktop engines do; it counts
the characters it typesets. `cargo test --release -p nsh-base --test base bench_word_fade -- --ignored
--nocapture`, µs a frame, medians of three rounds of fading off and on in turn (the paragraph grows by 240 words
over a round):

| Words at first | Arrival: reading + commit, off / on | Frame (colors only), on | Extra a frame | Characters typeset a frame |
|---:|---:|---:|---:|---:|
| 200 | 85.8 + 3.5 / 101.1 + 21.3 | 13.7 | +46.5 | 6,053 both |
| 800 | 222.6 + 6.2 / 235.6 + 24.0 | 14.5 | +45.1 | 16,403 both |
| 1,600 | 397.8 + 9.7 / 413.6 + 27.8 | 15.6 | +49.3 | 30,203 both |
| 3,200 | 753.1 + 16.0 / 769.4 + 35.5 | 18.1 | +53.7 | 57,803 both |

Fading costs the engine about 50 µs a frame whatever the paragraph's length: the frames of colors and hidden runs
typeset nothing and mount the text once with the layout drawn, and arriving words typeset the paragraph once
either way (`fading_words_typeset_the_paragraph_only_for_new_words` keeps both). What grows with the paragraph is
each arrival, fading or not: reading the Markdown again and one typesetting of the whole paragraph. Where a
platform's cost of a fading frame grows with the paragraph, it is its drawing, not the engine.

Out-of-line rare attributes (`core/element/builder.rs`, 2026-11-18, macOS arm64, release `bench_components`
and `size_of` on the same machine, `main` against the change): `Attrs` keeps its common
fields inline and boxes eighteen rare ones (`src`, `drawing`, `element_ref`, `animated`, `bound`, `inset_*`,
`projected_*`, `render`, `window`, the accessibility set) behind `Option<Box<RareAttrs>>`, allocated on first
non-default write; `Expanded` boxes its `VirtualList`-only `ListConfig` the same way. `Attrs::PartialEq`,
`Attrs::changes`, `slots::split` / `merged` and attribute application take a `rare.is_none()` fast path, and
`None` equals an all-default box, so cleared rare fields do not keep a node unequal.

| Record | Before | After |
|---|---:|---:|
| `Attrs` | 360 B | 104 B (-71%) |
| `Expanded` | 624 B | 312 B (-50%) |
| `BoundNode` | 464 B | 208 B (-55%) |

`size_tests::rare_attrs_keep_element_records_compact_and_default_equal` pins the ceilings. In the 45,304-node
case of `#1345` the smaller `Expanded` saves ~16 MiB of resident heap. `component_bench` (`cargo test --release
-p nsh-engine --test engine bench_components -- --ignored --nocapture`, min / median, the same ops and mount
items both ways):

| Phase | Before | After | Ops | Mount items |
|---|---:|---:|---:|---:|
| `GridRust.tsx` first frame core | 1.166 / 1.285 ms | 1.090 / 1.118 ms (-6.5%) | 1016 | 387 |
| `GridRust.tsx` update 200 titles core | 169.7 / 177.8 µs | 152.0 / 157.0 µs (-10.5%) | 200 | 63 |
| `RowsRust.tsx` first frame core | 147.2 / 157.1 µs | 142.2 / 145.4 µs | 264 | 324 |
| `RowsRust.tsx` scrolling core | 7.885 µs/frame | 7.443 µs/frame | — | — |

The `*Ts.tsx` runs, which build their views without Rust component nodes, stayed within their run-to-run
spread (`GridTs` first frame 764.5 / 750.7 µs, `RowsTs` 120.1 / 119.0 µs).

Rows an `each` keeps (2026-11-17, Linux x86_64, Ryzen 9 7950X, release, against `e2479085c`): every update of an
`each` (the rows of Rust components, `element/flow.rs`; TSX's `<Each>` is `nsh-js`'s own) built a map of all its
rows, wrote each row's item and index, and sent the core an element per kept row, which the core copied, matched
and placed again. A row added also searched the old elements once per kept row and the parent's children once per
node, so an append grew with the square of the rows. Rows are now passed in order and kept while the key in its
place is each row's own, the core matches only what follows the elements a run keeps in place, and kept rows and
nodes in order are found where the last one was (`components.md`, "What comes and goes is a region").

`cargo test --release -p nsh-core --lib bench_each_update -- --ignored --nocapture`: N rows of a view and a text,
one press an update, from `Core::component_event` to the finished `MountBatch` (`FakeEngine`, 320 × 480). µs an
update, the rows' pass + the commit, means of 200 updates; medians of three rounds of the two test binaries run
in turn on one CPU:

| Rows | Update | Before | After | Mount items |
|---:|---|---:|---:|---:|
| 640 | The last row's item changes | 102.7 + 42.2 = 144.9 | 9.0 + 7.7 = 16.7 | 1 |
| 640 | A row is added at the end | 113.9 + 841.9 = 955.8 | 13.6 + 429.9 = 443.6 | 9 |
| 1,280 | The last row's item changes | 200.7 + 83.1 = 283.9 | 19.0 + 15.0 = 33.9 | 1 |
| 1,280 | A row is added at the end | 230.3 + 2172.2 = 2402.5 | 23.1 + 815.0 = 837.9 | 9 |
| 5,000 | The last row's item changes | 820.4 + 338.0 = 1158.4 | 73.9 + 66.3 = 140.2 | 1 |
| 5,000 | A row is added at the end | 1200.6 + 22137.8 = 23338.3 | 137.9 + 3614.4 = 3752.3 | 9 |
| 1,280 | Control: a text beside the rows changes | 0.2 + 4.6 = 4.9 | 0.2 + 4.6 = 4.9 | 1 |
| 1,280 | Control: a view after the rows changes its height | 0.4 + 723.9 = 724.3 | 0.4 + 729.7 = 730.1 | 2 |

A row that stays costs 222 → 26 ns an update (1,280 rows, one item changed). With keys that allocate, as
`TextView`'s `(usize, String)`, the same updates take 331.8 → 42.2 µs and 2405.8 → 858.0 µs at 1,280 rows. What
is left of a row added is not the `each`: the second control lays the rows' parent out again with no row set, and
costs 0.57 µs a row (724 µs of the 838), which this change leaves as it is.

The mount items are the same: a list changed at random (rows changed, added, removed, moved, a key twice; four
row shapes, 7,680 commits) writes the same items in both versions (`NSH_EACH_ITEMS` with the two `random_lists_`
tests of `each_updates`), and so does every step of the traces below.

A streamed reply in a `TextView`, whose blocks are rows of an `each`
(`cargo test --release -p nsh-base --test base bench_text_view_streaming -- --ignored --nocapture`; total over the
stream / average of the last 10 updates, ms, medians of three rounds of the two test binaries run in turn on one
CPU; the item counts of all 4,822 updates are equal):

| Reply | Before | After | Mount items |
|---|---|---|---|
| Typical, 20 KB | 391.4 / 0.855 | 294.3 / 0.586 | 16,421 |
| Typical, 40 KB | 1557.6 / 2.058 | 1025.7 / 1.245 | 32,809 |
| Ends in a 400-row table | 5171.9 / 16.646 | 5087.2 / 16.513 | 18,698 |
| Ends in a 400-item tight list | 2131.3 / 6.533 | 2099.1 / 6.358 | 9,742 |
| Ends in a 400-line code block | 354.6 / 0.771 | 359.0 / 0.782 | 3,666 |

The last three replies are one block made again on each update, the same work in both versions: they stay within
the 2% two builds of the same work differ by. Of what a typical update still costs per block, the layout of the
view's column is the likely larger part: by the second control above it is about 0.7 ms of the 1.25 ms at 1,280
blocks (an estimate from that control, not measured inside the `TextView`).

Headless `nsh test <entry> --trace`, three runs of each version in turn on one CPU, every mount item of every
step equal. `Bench.tsx` and the counter are plain debug builds; the two entries with a long `each` are built with
`nsh-core` and `nsh-base` at `opt-level=3` (`--config 'profile.dev.package.nsh-core.opt-level=3'`, the same for
`nsh-base`), as the plain build takes longer to mount them than a step waits. Median of the runs' mean commit:

| Entry | Commits | Before (µs/commit) | After (µs/commit) | Ops | Mount items | Nodes |
|---|---|---:|---:|---:|---:|---:|
| `examples/bench/TextViewStream.tsx`, 40 presses of 24 bytes after 600 blocks | 40 | 4,503 | 3,394 | 1 | 1 to 12 | 5,409 to 5,550 |
| `examples/bench/RichEditor.tsx`, 8 edits of the first of 1,000 paragraphs | 8 | 3,858 | 3,412 | 0 | 4 or 5 | 5,013 |
| `examples/gallery/Bench.tsx`, `app.scroll("id:photos", 3000)` | 66 | 693 | 696 | 0 to 162 | 1 to 132 | 306 to 684 |
| Counter, press `+1` | 1 | 261 | 269 | 10 | 7 | 24 |

The first commits keep their counts (19 ops / 4,220 items / 5,406 nodes, 20 / 13,058 / 5,013, 756 / 622 / 252 and
57 / 51 / 21). The last two rows are controls of unchanged work.

Per-block RichEditor updates (2026-11-17, macOS arm64, against `126d7701`): block offsets moved out
of the reactive block items into `Tree`, the blocks' `selectedNode`/`focusedNode` state and each
textblock's selection boxes are per-block signals updated only for the blocks a selection or an edit
touches, and the geometry's ordered textblock index turns `text_at` / `range_rects` into binary
searches. Headless `nsh test examples/bench/… --trace`, debug profile:

| Phase | Before | After | Ops | Mount items | Nodes |
|---|---:|---:|---:|---:|---:|
| `RichEditorMount.tsx` initial population | 353,344 µs | 34,293 µs | 10 | 2,648 → 2,644 | 1,010 → 1,009 |
| `RichEditor.tsx` initial commit (1,000 paragraphs) | 8,346,483 µs, test failed | 216,569 µs | 20 | 13,058 → 13,054 | 5,013 → 5,012 |
| `RichEditor.tsx` single-character edit ×8 | — (never reached) | 995–1,563 µs, 3–4 items | 0 | 3–4 | 5,012 |

The 1,000-paragraph run is `for (let i = 0; i < 8; i++) await app.press("id:edit")` on standard input;
the before version's initial commit alone exceeds the step timeout, so its edits never ran. Every
edit's batch carries one Text op and its selection frames.

Leaner data-table views (`base/data_table`, 2026-11-18, macOS arm64, debug `nsh test --trace` on
`examples/bench/data-table/App.tsx`, 100,000 rows × 20 columns with the first column fixed, `main` against
the change): `fixedEdge` separators and the `headerContent` wrapper of a non-sortable column mount only when
the app styles their part, the sort chevrons position inside `SortIndicator` without a wrapping view, row
marks and cell marks are separate signals so a row selection does not wake every cell's flags memo, and
`Cell::Text` shares its `Arc<str>`.

| Phase | Before | After |
|---|---:|---:|
| First commit | mount items 1,962 / nodes 594 | mount items 1,854 (-108) / nodes 558 (-36) |
| Press row `#1` commit | 354 µs | 301 µs |

`examples/counter/App.tsx` is unchanged (57 / 10 ops, 51 / 7 mount items, 21 / 24 nodes). macOS window
screenshots of the bench before and after are pixel-identical.

Batched region cleanup (2026-11-15, macOS arm64, Apple M4 Pro, against `9efc3a2c`): three interleaved before / after
pairs, a fresh headless CLI process per sample. Both builds use the workspace's development profile with
`CARGO_PROFILE_DEV_DEBUG=line-tables-only` and incremental compilation disabled. The 200-paragraph reproduction is
`nsh test examples/bench/RichEditorMount.tsx --trace`, with `await app.wait(150)` on standard input.

| Phase | Before (µs/commit, median) | After (µs/commit, median) | Ops | Mount items | Nodes |
|---|---:|---:|---:|---:|---:|
| RichEditor initial population | 3,710,044 | 292,158 | 10 | 2,644 | 1,009 |
| Counter initial frame | 273 | 281 | 57 | 51 | 21 |
| Counter press `+1` | 847 | 878 | 10 | 7 | 24 |

Every sample passes and all work counts match. The RichEditor commit includes Rust view expansion, layout and
mount-batch construction, excluding native input, mounting and drawing. The counter uses the command below and
establishes unchanged work; three pairs do not establish a timing regression or speedup for its sub-millisecond commits.
Initial region population skips listener/binding cleanup, and regions that release nodes share one sweep per
affected view before the next event round. The core regression counts zero initial sweeps for 50–800 bound rows;
simultaneous removals from 200 / 400 regions scan 1,200 / 2,400 entries in one sweep each.

```sh
echo 'await app.press("+1"); await app.wait(50)' | nsh test examples/counter/App.tsx --trace
```

Sibling position classes (`core/classes.rs`, 2026-11-15, Linux x86_64, Intel Core Ultra 7 270K Plus, dev/test profile, `FakeEngine`).
`positions_changed` counts the element siblings once per pass and restyles only the children whose
`first:` / `last:` / `odd:` / `even:` / `only:` bits differ from the bits they were last resolved with
(`position_used`), so appending a row restyles the previous last row and the new one instead of every
sibling. Mounting N rows with `odd:` + `last:` classes, one insert per row, then one commit:

| Rows | Before (ms) | After (ms) |
|---|---|---|
| 500 | 277.0 | 18.6 |
| 2,000 | 4109.1 | 98.5 |

Mounting was then still quadratic in the passes over the siblings, one per insert (the 2026-11-23 entry above).
Results match a full per-child restyle after every tree edit
(`positional_regressions`). `examples/bench/PositionalClasses.tsx` (`COUNT`, `CLASSES`, `EACH`) reproduces
the workload headless with `nsh test --trace`; these Core timings exclude QuickJS and native mounting and drawing.

Cross-platform keyboard integration (2026-11-12, macOS arm64, debug, upstream `9fd11f836` against the core at
`c46f72f8c`): one fresh process per version running the same counter command below on the same machine.

| Phase | Before (µs/commit) | After (µs/commit) | Ops | Mount items | Nodes |
|---|---:|---:|---:|---:|---:|
| Initial frame | 681 | 744 | 57 | 51 | 21 |
| Press `+1` | 765 | 918 | 10 | 7 | 24 |

Both runs passed. Ordinary views emitted the same work; these single-run smoke timings are not a speed benchmark.
Native GTK, AppKit, Android and browser checks separately exercised actual key delivery and capture.

Focused-view keyboard input (Linux x86_64, debug, against `a44d5628b`): one fresh process per version running
`printf 'await app.press("+1");\n' | target/debug/nsh test examples/counter/App.tsx --trace`.
The counter has no raw key listeners; its work counts stay unchanged.

| Phase | Before (µs/commit) | After (µs/commit) | Ops | Mount items | Nodes |
|---|---:|---:|---:|---:|---:|
| Initial frame | 524 | 507 | 57 | 51 | 21 |
| Press `+1` | 392 | 568 | 10 | 7 | 24 |

These are single-run smoke timings, not a speed benchmark. Native XTest checks separately cover capture before
defaults, menu ordering, popup-held releases and NumLock. In the native smoke app, a 1,250 ms key callback left
the GTK 100 ms timer running (12 ticks); capture never waits for that callback.

Retained RichEditor rows (2026-11-08 audit, Linux x86_64, against `058a745a`; dev/test profile with
`nsh-core` and `nsh-base` at `opt-level=3`, `ApproxTextEngine`). Editing the visible first paragraph with content
culling enabled, 80 ASCII characters per paragraph, both Core order checks applied together:

| Paragraphs | Before (ms/edit) | After (ms/edit) |
|---|---|---|
| 1,000 | 7.56 | 6.16 |
| 5,000 | 88.18 | 52.39 |
| 10,000 | 315.43 | 128.07 |

Four warmup edits precede alternating single-character insertions and deletions. These are medians of process
means: seven alternating rounds of 32 measured edits for 1,000 paragraphs, three rounds of four for the larger
sizes. Every measured edit emits one Text and zero Create, Delete or Frame items. Timing covers session dispatch,
controller synchronization, reactive updates and Core commit/settling; setup, QuickJS and native text shaping,
mounting and drawing are excluded. The two checks were measured as one variant. RichEditor's own block walk and
other document-wide work remain, so these measurements describe the saved matching and placement work rather than
linear complete-editor updates.

Follow-up `nsh test examples/bench/RichEditor.tsx --trace` against `41100f2b` (2026-11-09, Linux x86_64,
Ryzen 9 7950X, pinned to CPU 0, the same package optimization settings): three alternating runs, four warmup edits
then four measured edits per run. The median of each run's mean commit time is **15.00 → 9.91 ms** for 1,000
paragraphs. Every edit's complete mount batch matches between versions; measured commits keep 0 ops / 4 items /
4,011 nodes (one Text and three selection Frames, zero Create, Delete, Insert or Remove). Initial counts stay at
19 ops / 9,048 items / 4,011 nodes. This JS-driven headless control keeps content culling disabled and measures the
commit log, excluding the controller work outside the commit and native input, shaping, mounting and drawing.
It is separate from the Rust audit above.

The counter control (`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx --trace`, one run per
version) keeps 56 ops / 50 items / 21 nodes initially and 10 ops / 7 items / 24 nodes after the press. Commit times
are 335 / 219 → 290 / 213 µs, a smoke check of unchanged work rather than a benchmark.

Markdown TeX preprocessing (`text_view/markdown/latex.rs`, 2026-11-08, Linux x86_64,
release, against `3b4f2abf`): a paragraph of
``"`a` x ".repeat(k) + "\\(x^2\\)"``, math enabled, streaming off. Eleven alternating
before / after rounds on one CPU, warmed and batched; medians, input construction excluded:

| Code spans | `latex::inline`, before → after | Complete Markdown parse, before → after |
|---|---|---|
| 1,000 | 0.853 → 0.00891 ms | 1.548 → 0.795 ms |
| 5,000 | 24.366 → 0.0450 ms | 27.794 → 4.444 ms |
| 10,000 | 96.966 → 0.0914 ms | 100.688 → 8.911 ms |

The ordered code spans are consumed with a cursor instead of searched from the start at
each byte. With streaming repair enabled, the complete 10,000-span parse took
544.17 → 453.83 ms; the repair's own scans made up the rest, until they got the same
cursor (Markdown streaming repair, below). A 35,200-byte control of 200 short
paragraphs takes 74.45 → 79.69 µs in TeX rewriting (about 5 µs more), while its complete
parse stays around 5.2 ms. Short Markdown and code spans without TeX delimiters have
unchanged complete-parse timings. These parser measurements exclude layout and drawing.

Headless `nsh test <entry> --trace` (debug, against `bba76ef7`, three fresh processes per
version, the same paragraphs in a mounted `TextView`): first-commit medians for 1,000 /
10,000 spans are 51.121 / 2731.507 → 43.521 / 1905.226 ms. Both versions send 7 ops /
16 mount items, with 3,007 / 30,007 nodes respectively. The counter control keeps
56 ops / 50 items / 21 nodes initially and 10 ops / 7 items / 24 nodes after `+1`;
commit medians 497 / 379 → 500 / 310 µs, noisy samples establishing stable work counts.

Markdown streaming repair (`text_view/markdown/streaming.rs`, 2026-11-15, Linux x86_64,
release, against `32f16354`): the paragraph ``"`a` x ".repeat(k)`` and a 600-row table with
three code spans per row (26,950 bytes), timed in `repair_streaming` alone and in a complete
parse with `streaming: true` (math enabled, the default). Eleven alternating before / after
rounds on one CPU, warmed and batched (at least 100 ms a sample); medians, input construction
excluded:

| Input | `repair_streaming`, before → after | Complete parse, streaming on, before → after |
|---|---|---|
| 1,000 spans | 3.893 → 0.0276 ms | 4.738 → 0.833 ms |
| 5,000 spans | 96.628 → 0.138 ms | 100.681 → 4.154 ms |
| 10,000 spans | 385.147 → 0.275 ms | 393.600 → 8.908 ms |
| 600-row table | 26.785 → 0.0947 ms | 37.992 → 10.835 ms |

The repair's TeX, link and closing scans carry a cursor into the ordered code spans instead
of searching all of them at each byte, so the repair grows with the text, not with the
square of its spans, and the complete 10,000-span parse is back at its time with streaming
off (8.911 ms in the entry above). Streaming the table's first 400 rows in 24-byte updates
(748 parses) takes 4.94 → 1.78 s in all, 6.60 → 2.38 ms an update. A 20,000-byte reply of
short blocks is unchanged (0.018 ms of repair, 5.65 ms parsed). The repaired text equals the
old scans' on 400,000 random inputs.

`TextView` streaming (`text_view/markdown/incremental.rs`, 2026-11-16, Linux x86_64, release,
against `e365872a`): replies arriving in 24-byte updates with `streaming: true` (math enabled),
one run per version. A `TextView` keeps what it read and reads a text that grew from its last
boundary on (`text-view.md` "Reading only what can change"); before, every update parsed the
whole text, copied its blocks and compared them all. Total over the stream / average of the
last 10 updates, in ms.

Reading the Markdown and the view's two memos of the document, value made and compared
(`cargo test --release -p nsh-base bench_streaming -- --ignored --nocapture`, which runs both
ways):

| Reply | Updates | Parse, before → after | Parse and memos, before → after |
|---|---|---|---|
| Typical (short blocks), 20 KB | 834 | 2481.8 / 5.886 → 29.0 / 0.036 | 2523.3 / 5.985 → 29.3 / 0.037 |
| Typical, 40 KB | 1,667 | 10424.2 / 13.974 → 59.2 / 0.038 | 10594.5 / 14.187 → 60.2 / 0.039 |
| Ends in a 400-row table | 748 | 1812.3 / 5.699 → 1799.4 / 5.684 | 1837.4 / 5.765 → 1802.4 / 5.694 |
| Ends in a 400-item tight list | 680 | 858.4 / 2.504 → 854.9 / 2.502 | 878.5 / 2.565 → 858.0 / 2.513 |
| Ends in a 400-line code block | 893 | 320.5 / 0.712 → 318.0 / 0.711 | 320.7 / 0.712 → 318.1 / 0.711 |

A whole update of a mounted `TextView`, from the press that adds the text to the batch of mount
items (`Core::component_event` and `Core::commit`, `ApproxTextEngine`, 390 × 844;
`cargo test --release -p nsh-base --test base bench_text_view_streaming -- --ignored --nocapture`,
run in a checkout of each version):

| Reply | Before | After | Mount items |
|---|---|---|---|
| Typical, 20 KB | 3004.0 / 7.682 | 378.2 / 0.822 | 16,421 |
| Typical, 40 KB | 13302.2 / 18.916 | 1461.3 / 1.872 | 32,809 |
| Ends in a 400-row table | 4816.2 / 15.482 | 4616.4 / 14.677 | 18,698 |
| Ends in a 400-item tight list | 2035.7 / 5.751 | 1950.9 / 5.710 | 9,742 |
| Ends in a 400-line code block | 348.1 / 0.754 | 351.7 / 0.763 | 3,666 |

Each update sends the same number of mount items in both versions (the counts of all 4,822
updates compared, `NSH_BENCH_ITEMS`). Reading no longer grows with the reply: 0.04 ms an update
at 20 KB and at 40 KB. What is left of a typical update does, about 1.2 µs a block (0.8 ms at
640 blocks, 1.9 ms at 1,280): the pass over the blocks in the two memos and, mostly, `Each`'s
pass over its rows and the commit in `nsh-core`, which this change leaves as they are. A reply
that ends in one large block parses and shows that block again on each update, as before: only
the blocks before it are kept.

Headless `nsh test <entry> --trace` (debug, one run per version): a `TextView` in a TSX entry
shows 24 bytes more of a 1,752-byte reply with each of 40 presses. Both versions make 47
commits with the same ops, mount items and nodes in each (56 down to 1 items, 372 nodes at
most), and every mount item of every step is the same; the presses' commits average
1796 → 1101 µs.

`TextView` definitions (2026-11-16, Linux x86_64, release, against `717b961b`): a text with a
link or footnote definition read from its start (the first set, a replaced text, a definition
in the block being written) built its tree, found the definition and parsed the whole text
again. That tree is now converted as it is; a definition first seen in the tree of a tail drops
what was kept and parses the whole text once (`text-view.md` "Reading only what can change").

`cargo test --release -p nsh-base --lib bench_streaming_set -- --ignored --nocapture`: about
40 KB of Markdown (78 KB in the quote's row), `streaming: true`, mean ms of 30 runs, the two
readers in alternating order, a new `Incremental` for each run; making the state before the
update, comparing and dropping the document are not timed. `Parser::markdown` is the full
parse measured beside the reader after the change.

| Update | `Parser::markdown` | `Incremental`, before → after |
|---|---|---|
| First set, no definition | 12.921 | 13.199 → 13.141 |
| First set, a link definition | 12.978 | 26.211 → 13.169 |
| First set, a footnote definition | 12.950 | 26.010 → 13.136 |
| First set, both | 12.970 | 26.097 → 13.152 |
| Replaced text, both | 12.941 | 26.052 → 13.129 |
| A final link definition grows | 12.961 | 25.935 → 13.115 |
| A final footnote definition grows | 12.917 | 25.916 → 13.110 |
| A link definition arrives after a kept text | 13.016 | 13.234 → 13.191 |
| A definition arrives in a 38 KB quote (the tail) | 25.174 | 33.728 → 33.223 |
| `` `[docs]: /guide` `` in a code span arrives, then grows | 12.985 | 0.021 → 0.021 |

Without `streaming` the rows read the same way. The second parse is gone; a first set
costs about 1.5% more than `Parser::markdown` (the boundary's bookkeeping and the shared
blocks), with and without definitions. The quote's row still read more than the whole text
there: the update in which a definition first shows in a tail read the tail, then the whole
text (the tail is the quote, half of the text). A tail with a line that looks like a
definition is now not read first (`may_define`, `text-view.md`); the same benchmark, against
`bde1a6af`, `Parser::markdown` beside the reader after the change:

| A definition arrives in a 38 KB quote (the tail) | `Parser::markdown` | `Incremental`, before → after |
|---|---|---|
| `streaming: true` | 25.314 | 33.223 → 25.860 |
| `streaming: false` | 26.456 | 33.413 → 26.951 |

About 2% over `Parser::markdown` is left, the first set's bookkeeping. What looks like a
definition is a guess, kept narrow: taking every `]:` in the tail for one was measured and
dropped, because the sequence is common in code and a reply whose Python has `if seen[key]:`
then parses the whole text on most updates. `bench_streaming` has such a reply (24-byte
updates, total over the stream / average of the last 10, ms):

| Reply | Updates | `Parser::markdown` | `Incremental`, any `]:` taken | `Incremental`, the guess |
|---|---|---|---|---|
| `]:` in its code, 20 KB | 834 | 1913.2 / 4.844 | 1686.5 / 4.425 | 28.5 / 0.034 |
| `]:` in its code, 40 KB | 1,667 | 8581.6 / 11.322 | 7640.7 / 10.765 | 58.5 / 0.035 |

The guess misses definitions it has no rule for (after indented code that looks like a fence,
after a table's last row): such a tail is read, then the whole text, as before. On 40,000
documents of random Markdown fragments it saw 3,577 of the 3,775 that define and took 1,039
of the 36,193 that do not; replies are far tamer than those.

The other replies of `bench_streaming` are as above (typical 20 / 40 KB: 28.5 / 0.036 and
58.4 / 0.037).

Headless `nsh test examples/bench/MarkdownDefinitions.tsx --trace` (debug, two runs per
version, the steps in `examples/bench/README.md`): 40 KB of Markdown with a link and a footnote
definition, set, then replaced six times by a text that differs near its start. Both versions
make the same commits (19 ops, 9,277 mount items, 16,657 nodes, then 1 op and 1 item for each
replacement) and every mount item of every step is the same. The first commit takes
522 → 427 ms, a replacement's 204.5 → 106.9 ms (parsing, expansion and layout; no native
mounting or drawing).

`TextView` long text (`text_view/markdown/incremental.rs`, 2026-11-18, Linux x86_64, Intel Core
Ultra 7 270K Plus, release, one CPU with `taskset`, least of three runs, other work on the
machine): one parse of a whole text grows faster than the text, so a long text given at once is
read in parts the way a streamed one is (`text-view.md` "Reading only what can change").
`cargo test --release -p nsh-base --lib bench_long_texts -- --ignored --nocapture` reads each text
both ways, without a plugin and with one that reads paragraphs, headings, code, formulas and tables
(the test's `Where`), and checks that the documents are equal. Sections are a heading, a paragraph
with a link and bold words, and a two-item list; the typical reply is the streaming benchmarks'
text repeated. ms, one parse / in parts:

| Text | Size | Without a plugin | With a plugin |
|---|---|---|---|
| Sections | 190 KB | 59.3 / 37.1 | 57.9 / 37.9 |
| Sections | 475 KB | 234.2 / 91.1 | 237.6 / 94.5 |
| Sections | 950 KB | 727.3 / 184.3 | 733.8 / 189.9 |
| Sections | 1.9 MB | 2444.6 / 369.3 | 2435.8 / 376.7 |
| Typical reply | 950 KB | 3902.6 / 454.9 | 3938.1 / 408.4 |
| Typical reply | 1.9 MB | 21113.9 / 734.1 | 21153.4 / 805.1 |
| One table, 20,000 rows | 928 KB | 18485.0 / 17214.1 | 17335.0 / 17283.7 |
| One list, 20,000 items | 848 KB | 452.8 / 460.5 | 490.6 / 471.9 |
| One code block, 20,000 lines | 1.1 MB | 101.3 / 101.5 | 99.4 / 101.2 |

A plugin costs about nothing next to the parse; until plugins were read in parts, a text read
with one took the one-parse column. A text up to twice the part's size, and one read whole
(definitions, plugins that turn a construct on or off, containers, MDX), is parsed once as before.
A text the boundary cannot cross costs what one parse does: the table, list and code block are
within noise. The table's own parse still grows with the square of its rows, inside `markdown-rs`.

Terminal `TextView` tables (2026-11-08, Linux x86_64, debug hosts,
`nsh test <entry> --target tui --trace`, against `71aeb06a`, seven alternating runs per version, medians):
100 body rows × 10 columns, each cell 100 `x` characters, in a 200 × 60 Cell terminal. Narrowing the table's
container from 200 to 120 Cells commits in 616.6 → 267.1 ms; its initial commit takes 964.8 → 647.5 ms.
Both versions send 33 / 2 ops and 12,995 / 5,267 mount items initially / on narrowing, with 5,376 nodes.
A 10 × 6 table (40 characters per cell, narrowed to 100 Cells) takes 45.6 → 44.5 ms initially and
25.9 → 22.7 ms on narrowing, keeping 869 / 379 items and 386 nodes. Commit times include component expansion,
text measurement and layout; terminal drawing and input latency are outside the samples.

The table shares one `computed` of its column widths (`text_view/view.rs`), borrowed by its cells and rules
through `Memo::with`: the same fitting algorithm runs once per width change, down from 1,013 times for
the 100 × 10 table. Its reactive graph and fitting kernel alone (`rustc -C opt-level=3`, same machine,
seven alternating runs, width from zero to 120 Cells) take 8.636 → 0.0535 ms, excluding construction,
text measurement, layout and drawing. All 49 paired terminal cell dumps match through consecutive widths,
repeated widths, column floors and `colspan`; hiding and remounting the tables passes on both hosts.

Live resize of a real app (Noop, 10 065 nodes, a horizontal corner drag of 6 s, release, `--target macos` package, no
sampler): window sizes per second 12 → 62-65, gap between sizes p50 86 → 16 ms and p95 about 25 ms, the window's lag
behind the pointer p50 20 → 3-4 pt. An empty page and TextEdit both do about 87 sizes per second on this machine. Text
far from the screen waits for the end of the drag, so that commit does the measuring the drag skipped, on the engine
thread. What remains scales with the page: Taffy and emitting frames over every node, and AppKit's walks over the view
tree.

The same on Linux (GTK 4 under Xvfb in a container, a page of 120 Markdown messages, `xdotool` setting about 115 sizes per
second): sizes the app handled per second 41 → 60.

Windows cursor refresh after a style batch, against main `a5036af4`, debug host, one native run per revision:
`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx --target windows --trace`.
Both runs produce 56 ops / 50 mount items / 21 nodes initially and 10 ops / 7 mount items / 24 nodes after the press.
Initial commits measured 1164 → 1139 µs; press commits 380 → 329 µs. These single samples establish unchanged work
counts on the counter's unchanged-cursor path. A batch compares cursor values while applying view styles, then
refreshes once if any changed; other batches skip the cursor hit test.

GPUI idle wakeups (Linux x86_64, debug `nsh-gpui-host --bundle`, lavapipe, a headless Wayland compositor answering
frame callbacks at 60 Hz; voluntary context switches per second, all threads, over 10 s; against main `da3f1683`):
static text 4.1 → 4.2 (the `blocking` pool's two threads; no frame drawn); an `autoFocus` field while it blinks
64 → 63; the same field 14–24 s after it was focused 68 → 2.1 (the caret stays shown after GTK's 10 s); the field's
window suspended while it keeps the keyboard 13.7 → 2.1 (the blink timer stopped); unfocused 2.1 → 2.1; after a 1 s
fade ended 2.1 → 2.1. Each blink drew a frame, about 30 wakeups under lavapipe (the four `llvmpipe` threads and the
renderer's). Under X11 (Xvfb) GPUI's refresh timer keeps the main thread at ~64 a second whatever the app does
(`docs/dev/gpui.md` "Idle windows").


Span test-id metadata (macOS arm64, debug CLI, three runs per revision against `e02b40f8`):
`echo 'await app.press("Rename ID")' | nsh test crates/nsh-testing/tests/testing/queries/Spans.tsx --trace`.
The first commit stays at 31 ops / 25 mount items / 13 nodes; renaming stays at 1 op / 1 item / 13 nodes.
Rename commit times were 47–208 → 37–79 µs (medians 48 → 64 µs). The regression engine counts
zero additional preparations, measurements and layouts after a metadata update, versus an additional layout
before the fix; the mounted layout is reused, including fitted font sizes, without `onTextLayout`.
The counter control stays at 56 ops / 49 items / 21 nodes initially and 10 ops / 7 items / 24 nodes after `+1`,
matching the item-count baseline below. Its minimum initial / press times were 357 / 181 → 315 / 189 µs.
These noisy single-frame timings establish stable work counts rather than a speedup.


The first `onMouseMove` (moves with a button down too, desktops and web; since merged with the hover moves into one
`onMouseMove`): Linux x86_64, debug CLI, five interleaved runs of
`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx --trace`, against main `fd772aef`.
The first commit stays at 56 ops / 49 mount items / 21 nodes; the press stays at 10 ops / 7 items / 24 nodes.
Minimum first-commit times were 277 → 280 µs, press times 180 → 189 µs (medians 189 → 202 µs for the press).
Cold-start timings varied widely (277–633 µs), so these runs establish unchanged work counts rather than a speedup.
Without mouse listeners, each backend skips the new mouse hit test. Mouse moves share the existing 8 ms hover
coalescing interval, with the latest coordinates kept independently per view and event kind (one kind since the merge).


`Editor` and `DiffView` at 200 000 lines (15 MB of Rust, Linux x86_64, release CLI, headless, `--trace`; the apps
are `mount`ed TSX building the text in JS). Editor: first frame 98 ms, of which 69 ms is the app's JS building the
string and the first commit 29 ms (22 ops / 1218 mount items / 508 nodes; before: 184 ms, fold candidates and every
row's width computed up front); a typed character, Enter or undo 1.4–2.4 ms (17 items, 77 for Enter / undo; before:
3.4 ms more, the `onChange` text built twice); scrolling 3000 points commits 13 times, 0.7 ms each (median; at most
3.3 ms, when the row window moves: before, 151 commits of 0.15 ms, one per frame, the window moving by a row). Highlighting runs off the
engine thread (before: 4 ms per frame on it, 22 s of frames to reach the end); a jump to line 199 000 shows guessed
colors in under 300 ms (12 ms of parsing per 100 lines). DiffView (a change every 500 lines): first frame 166 ms, of
which 95 ms is JS and the commit with the line diff 72 ms (3083 items); scrolling 3000 points commits 8 times, 1.9 ms
each, 16 ms in all (before: 150 commits, 51 ms). A round of the gallery's language server on 50 000 lines (macOS desktop
size, release CLI, headless): the commit taking 50 006 diagnostics and 50 002 decorations 23 ms, 7.5 and 6 ms of it
resolving them (before: 145 ms, 53 and 52 ms, four rope lookups per position; the gutter's severities and the
diagnostics at a point scanned every mark).

Editor highlighting at 200 000 lines (2026-11-08, Linux x86_64, release; `bench_highlight_200k`, ignored, in
`crates/nsh-base/src/editor/bench.rs`: the repository's Rust and TSX repeated, the controller's passes played as they
run): the first screen's colors 25 → 2.4 ms in Rust and 259 → 13 ms in TSX (the language's regexes cold: Oniguruma's
compile about 20 times faster than fancy-regex's, and the job stops at the last line in view), the parse 21 000 →
62 000 lines/s in Rust and 4 900 → 20 000 in TSX (a jump to the end shows a guess in 0.8 / 4.8 ms, was 5 / 19 ms; the
parse from the top reaches it in 3.2 / 9.9 s off the engine thread, was 9.5 / 41 s; 52 MB of tokens and states), a
typed character's colors 0.6–1.4 ms off the engine thread (0.3 ms on it), typing far past the parse guessed again
(before: the colors it continued until the parse came). The gallery's Editor demo, debug, headless: its first colors
505 → 35 ms after it asks for them (the first job now runs while the turn that mounts it goes on).

The gallery's Editor demo at 200 000 lines (its TypeScript sample pasted 3449 times, a macOS window of 1440×900,
release CLI, `--target macos --trace`): the paste's commit 21 → 13.5 ms; a sample pasted into that file 8.4 → 5.7 ms
(1832 items: the gutter measured its digit once per row, an element made again per row for each number); the commit
taking the 6900 problems 12.4 → 7.4 ms (fields read by atom, not through a C string allocated each). The engine's idle
collection walks the whole VM, 30–90 ms with the demo's language server holding the file's model: it ran every second
between the turns of pastes and of the server's slices (21 collections in the run), now only after 0.3 s without a
message or a due timer (7, none between pastes).

`pointer-events-none` regions (2026-11-08, a mounted TSX `Editor` of 200 000 lines, release CLI, headless,
`--trace`): the commit that shows the first syntax colors 11.5 → 1.2 ms (75 mount items). Each view inserted under the
rows' `pointer-events-none` walked the whole region, twice (1600 spans into 2500 views); the core notes the regions a
round changes and works each out once before its mount items (`classes.rs` `flush_pointer_events`). The first frame
sends 2631 mount items instead of 2885 (no `ViewProps` set and set back in one commit); a typed character commits in
0.37 ms, 14 items (was 0.40 ms, 15).

- counter, headless (debug): first frame ~0.5–0.65ms (58 ops / 49 mount items), one tap ~0.15ms (12 ops / 8 items).
- counter, Catalyst (release): first frame ~1.05–1.15ms (of which ~0.7ms is cold CoreText layout of 10 texts), one tap ~0.12ms.
- Hot reload: ~120ms from saving a file to the device running the new version (file event latency and ~60ms of development
  bundling included); applying a hot update takes 0.2–0.5ms on the engine thread.
- gallery Photos list (`examples/gallery/Bench.tsx`, debug, headless): first frame 653 ops / 224 nodes, ~2.7ms (list bind
  rounds included).
- Paced list binds (`Bench.tsx` scrolled 3000 pt, release, headless, three runs): the first commit binds the viewport,
  786 ops / 641 mount items in ~1.1ms (1226 / 1029 in ~1.5ms when the whole overscan bound with it); the overscan
  follows in commits of ~165 ops / 138 items. 43 commits and 1923 items in all (40 and 1943 before), commit median
  ~0.26–0.31ms either way.
- Photos scrolling (release): a frame that rebinds one row is 4 ops / 4 mount items; frames that reveal no new row call no JS and produce
  no batch. `list_bench` runs at ~9µs per frame back to back (JS ~4µs; ~30µs / JS ~20µs before reactivity went native) and
  ~50µs with caches flushed between frames, but ~60–150µs after the thread sleeps 10ms. The difference is the CPU clocking down while the thread sleeps (Apple CLPC), not the code path; neither QoS (the engine
  thread is USER_INTERACTIVE) nor the Mach time-constraint policy changes it. Judge optimizations by the back-to-back and flushed-cache numbers:
  single-frame `nsh test --trace` timings are dominated by the clock state.
- Lists in their parent's viewport (`viewport="parent"`; gallery Lists › Page, release, headless,
  `app.scroll("id:page", 3000)`): 49 commits, 651 ops / 647 mount items, median commit ~90–100µs; once the window is
  full, a frame that rebinds one row is 6 ops / 8 items (the page's scroll view moves the list; no `ScrollBy` while
  the rows match their estimates). Lists of their own pay nothing for it: `Bench.tsx --scroll 3000` and the
  gallery's Lists pages send the same mount items in every commit before and after (1226 ops / 1029 items first,
  1064 ops / 914 items over 39 scrolling commits), with commit times within the run-to-run spread.
- On Catalyst (release), rebinding one row while scrolling slowly takes ~0.4ms (clocked down) and rebinding a whole screen of ~32 rows on a
  fast fling 0.9–1.6ms.
- Host startup (`Host::new`, release): ~75–155µs (clock state). The web APIs add nothing until first used, then ~90µs to
  make their classes (`bench_first_web_global`; as JS they cost ~0.8ms as source, ~0.33ms as bytecode). The standard
  modules add `Buffer` (~30µs warm, ~70µs in a process's first VM; made at startup: it must exist before hardening
  freezes `%TypedArray%.prototype`) and the async runtime over the plain one (~12µs). The first `new WebSocket`
  starts the VM's tokio I/O runtime (~12µs and a worker thread); `process` and `crypto` are made on first use
  (`standard::LAZY`), and `WebSocket` is one of the lazy web classes (`web/websocket.rs`, ~4µs of their making; as
  a JS facade it cost ~190µs on first use). Installing `Buffer` keeps NSH's lazy web globals unmade. On a Linux x86 desktop (shared, noisy) `Host::new` is ~105µs warm and ~460µs
  cold in a trace's first VM, close to main's; the counter's hardened release first frame (`nsh trace
  examples/counter`, minimum of 81 interleaved runs) is ~650µs against main's ~540µs, of which `Buffer`'s cold
  setup is ~70µs.
- Android passive press feedback (arm64 emulator, debug; one `nsh test examples/counter/App.tsx --target android --trace`
  run before and after): the first commit stays at 56 ops / 49 mount items / 21 nodes, and the tap at
  10 ops / 7 mount items / 24 nodes. First-commit core times were 56.8 → 112.7 ms, tap core times
  3.85 → 4.09 ms; first-frame totals were 127.3 → 124.5 ms. These noisy single runs establish unchanged
  engine work counts, not a speedup or a measurement of Java touch dispatch. Passive feedback reuses the root's
  touch tracker; observers are picked at finger-down and cancelled when a native gesture takes over.
- Android, animated values (Pixel 10 Pro, 120 Hz, release-dev host, the gallery's Animations demo with its three loops,
  `simpleperf stat` over 10 s, three runs each): the UI thread runs ~4.09 G instructions before setting the camera
  distance only when it moves and ~2.99 G after (-27%), its CPU time ~2.22 → ~2.04 s; `Mounter.outputs` gets 1000+
  values a frame there (ART allocates the array as a large object), every bound value of the page, moved or not.
  RenderThread is unchanged (~18.2 G).
- Android, going back (Pixel 10 Pro, 120 Hz, dev host, Text → the gallery's index with the back button, `gfxinfo
  framestats` over the 300 ms slide, three runs each): 23 → 33 frames, mean frame time ~35 → ~13 ms, RenderThread
  issue ~12 → ~5.5 ms a frame once the slides move by whole pixels; after a back gesture's release ~13–19 → ~4–5 ms.
  The first frame still records the index again (it was `INVISIBLE`): 20–44 ms of UI-thread drawing.
- Android, push and back (Pixel 10 Pro, Android 17, 120 Hz, packaged release, the gallery's Text, Image, Scroll,
  List, Stocks and Canvas from the index and back with the back key, five rounds each, `gfxinfo framestats`): the
  screen a pop reveals keeping its display list (`StackBox.dispatchDraw`, `Decor.setVisible`) and the slides moving
  hardware layers take the slowest back frame's UI thread from 22–36 ms to 2–5 ms and missed frames from 23–32 to
  7–14 per page (p90 frame 35–58 → 14–32 ms). What remains is the RenderThread drawing both screens into their layers
  in the slide's first frames (14–29 ms). Pushes are unchanged (no push frame over 25 ms on the UI thread).
- Android, clipping to continuous corners (Pixel 10 Pro, Android 17, 120 Hz, packaged release; the gallery's index,
  whose banner of ~330 canvas dots and cards clip to continuous corners): a scrolled frame uploaded ~440 textures,
  one clip mask per draw inside those boxes, and took 7–8 ms of RenderThread; drawing their children clipped to
  rectangles and corner layers (`Box.drawInCorners`), ~20 uploads and 4–5 ms. Going back to the index (the same six
  pages, five rounds each, two runs before and three after, interleaved): missed frames per back 1.3–2.2 → 0.4–2.1 and
  the slowest RenderThread frame of a back 27–41 → 14–26 ms (Stocks 70 → 49 ms: its own page, live charts drawn into
  the slide's layer, is what remains). GPU memory after scrolling the whole index: 146–149 MB before, 116–118 MB after,
  of a 125 MB budget; layers of the whole box were ~1 missed frame per back faster but kept 167–169 MB.
- Android, glass surfaces (x86_64 emulator, Android 15, SwiftShader, 1080 × 2400 at 2.625x, packaged release; an app
  of four pages of about the screen's size in a horizontal pager, each with a 24 pt backdrop blur, a 28 pt outer
  shadow and a 1 px inset rim, under a blurred header and tab bar; eight swipes, `gfxinfo` p50 over three
  interleaved runs): 105 → 17 ms a frame (RenderThread ~61 → ~16 ms); shadows alone 32 → 10 ms, blur alone 34 →
  12 ms, neither 6 ms. A blurred drawer sliding over them: 150 → 31 ms. Box shadows come from cached bitmaps
  (`Decor.drawCachedShadow`), backdrops are recorded at the size their blur needs (`Backdrop`).
- Android emulator (arm64, release): rebinding one gallery row while scrolling ~0.3–0.4ms (JS ~60µs); text costs per new
  text: `PrecomputedText` ~120µs, measure ~50µs, final layout reused. First gallery frame 20–50ms (noisy on the emulator).

- Gradients mixed in Oklab (`cargo test --release -p nsh-core bench_gradient_oklab -- --ignored --nocapture`, a
  Tailwind gradient of three stops): ~0.5µs for one of nearly one color (no stop added), ~4.2µs blue / purple / pink
  (11 stops), ~7.9µs red / lime / blue (33 stops, out of sRGB's gamut halfway), paid when the node's classes apply.

- Rust components vs the same component in TSX (`component_bench`, which writes its screens as `examples/bench` has them; release, minimum of the runs;
  a button written as a Rust component and the same button in TSX, `TsButton.tsx`, styled to draw exactly alike),
  with the Rust button running once (its props bound) and, in brackets, as it rendered again and was diffed before:

  | | Rust button: JS / core | TSX button: JS / core |
  |---|---|---|
  | first frame, 200 buttons (ops) | 0.42ms / 1.04ms [0.75ms] (1015) | 0.85ms / 0.64ms (2415) |
  | one update of all 200 titles (ops) | 0.15ms / 0.44ms [0.48ms] (200) | 0.13ms / 0.34ms (400) |
  | first frame, 1000-row list | 0.17ms / 0.23ms [0.19ms] | 0.23ms / 0.18ms |
  | scrolling the list, per rebinding frame | 1.5µs / 6.1µs [6.3µs] | 1.5µs / 5.3µs |

  JS does half the work or less. Running once costs the first frame ~40% more core time than rendering did: each
  bound part of an element is a computation of the graph that runs as the view is made (its first value is applied
  with the element's static parts, `core/views.rs`), and each prop a signal (`element/prop.rs`); the rest of the core's
  time (node creation, styles, Taffy) is the same in both. Updates cost what they change: an update of one title runs
  its text's and label's bindings, and a large view with one changing value costs what that value costs
  (`bench_view_tick`, below). The components' JS face must stay one effect per instance reading the props directly:
  the first version (Solid's `splitProps` / `mergeProps` / `spread` in the former JS runtime) cost 4.0ms of JS for
  the same first frame, more than the TSX button.
- Rust components run once (`cargo test --release -p nsh-core bench_view_tick -- --ignored --nocapture`, a view of
  300 static rows and a counter text, one press per frame): the press and the binding it runs take ~0.3µs, the commit
  ~82µs (the text's relayout and the tree's layout pass), one mount item. The former model rendered the whole view
  again and diffed it: ~312µs per commit for the same view.
- High-frequency updates (`cargo test --release -p nsh-core bench_high_frequency -- --ignored --nocapture`: `Board`, a quote board of
  80 rows of a mark and five cells, 961 views, the first cells of 40 rows changing together on each press):
  ~4.4µs per event, then per commit ~140µs when the cells have a size of their own and ~180µs when they take their text's, 40 mount
  items either way. Nearly all of the commit is Taffy laying the dirty paths out again (~116µs of it, measured once by timing the
  commit's phases): a changed text dirties every view up to the root, and the flex algorithm of the root and of each changed row runs
  again over all their children, fixed cells included (nothing stops the dirtying at a view whose size its content cannot change); the
  frame walk is ~10µs, the texts (the tests' engine) under 2µs. This is the baseline relayout boundaries are measured against.
  With relayout boundaries (`LayoutTree::is_boundary`): ~36µs per commit for the fixed cells, each changed cell laid out on its own
  and nothing above it; content-sized cells are not boundaries (their size is their text's) and stay at ~180µs.
  With texts that measure as before (`LayoutTree::measures_as_before`: a changed text measured again for every input the layout asked
  of it; the same answers, and nothing is laid out again): ~20µs for the fixed cells and ~15µs for content-sized cells whose values
  keep their widths (the tests' text engine gives every character one width, as tabular figures do), against ~185µs before; when
  every value changes width (a sign coming and going) nothing measures as before and the commit is ~192µs, against ~184µs (the
  answers recorded and measured again). The component benchmark's update of 200 titles: core 0.19ms (Rust Button) and 0.09ms
  (TSX), against 0.43ms and 0.35ms.
- Rust components' handles (`handle_bench`: `cargo test --release -p nsh-engine --test engine bench_handles --
  --ignored --nocapture --test-threads=1`, 1000 calls in one press, the minimum of 200 presses, per call; steady
  state of five runs). In brackets, when `AnimatedValue` was an `Rc` of its node and `ElementRef` an `Rc` of its
  slot rather than `Copy` handles their owner keeps (an access is a thread-local, an index and a generation check):

  | call | per call |
  |---|---|
  | `AnimatedValue::set` | 8.3–9.2ns [8.2–9.7ns] |
  | `AnimatedValue::timing` (its end dropped) | 14.6–16.9ns [13.0–14.2ns] |
  | `AnimatedValue::interpolate` of a node made before (the handle the current owner keeps of it) | 26.5–27.5ns [20.3–20.9ns] |
  | `ElementRef::node` | 1.2ns [0.2ns] |
  | `ElementRef::focus` | 12.5–14.4ns [8.8–9.1ns] |

  Deriving a node again under an owner that keeps a handle of it returns that handle (30–31ns while it made a new
  slot each time). They are used when a view is made and on events, never per frame (the graph runs by node id), and left
  `component_bench` and `nsh trace` of the Rust gallery's Animations and Gestures pages (taps on their controls) where
  they were: the same ops and mount items in every commit (Animations: 2029 items on the page's first frame, then
  4 / 10 / 9 / 9 / 3 / 3 / 17 for Release, Stagger, Sequence, Loop, Stop, Reset and a curve; Gestures: 815, then
  4 / 14 / 3 / 10 / 4 / 2), the commits' times within their run-to-run spread.
- Rust components' structure (`origin/main` against these changes: `Copy` handles, listeners and tasks under their
  owner, every listener of an event walked in place, Delete with no Remove for what leaves a nested component,
  children passed on to a nested component, a component rooted in another made on its host, slots filled with no
  holder and passed on, what a view gives a component's element on its root; release, minimum / median):
  `component_bench` GridRust first frame JS 392–395µs / core 0.97–0.98ms before, 408–415µs / 1.01–1.02ms after,
  200 titles JS 135µs / core 412–422µs before, 145–146µs / 428µs after, RowsRust first frame core 209–211µs before,
  232µs after, scrolling 5.75µs / 6.07–6.11µs per rebinding frame core, JS 1.43µs / 1.51–1.54µs; the same ops and
  mount items (1015 / 2217, 200 / 400, 500 / 617). The renaming commit alone, the same code as before, measured right
  after gives the later numbers (GridRust core 1.01ms, RowsRust 229µs and 6.0–6.1µs), so the difference is the
  machine's drift between the runs, not the changes. `handle_bench` (two runs each): `set` 8.0–8.4ns before,
  8.8–9.6ns after; `timing` 11.9–14.8 / 15.2–15.8ns; `interpolate` of a node made before 18.8–24.6 / 29.5–29.9ns;
  `ElementRef::node` 0.2 / 1.2ns; `focus` 8.0–8.1 / 9.5–9.7ns. Release `nsh trace` (nine interleaved runs):
  `Bench.tsx --scroll 3000` the same 1205 ops / 1008 items first and 1064 ops / 914 items over 39 commits (first
  commit 1.33 / 1.65ms before, 1.35 / 1.64ms after; the scrolling 14.8 / 15.9ms against 15.4 / 16.2ms). The Rust
  gallery (its app's command line built release, five interleaved runs, the index and each demo page opened with
  `--wait 1500`): the same mount items in every commit of every page (index 1012, Stocks 1102, AI Chat 793, Lists
  900, Animations 2029, Form 1293, ...), but for the Stocks page's ticks after it opens, which follow a generator
  seeded by the clock; a page's first commit 1.0–5.0ms either way, inside the run-to-run spread (index 1.16 / 1.86ms
  before, 1.46 / 2.03ms after).
- Calls into Rust from JS (`class_bench`: `cargo test --release -p nsh-engine --test engine bench_calls -- --ignored
  --nocapture --test-threads=1`, min / median of 20 runs, per call, the JS loop included). A member or function that
  is not `async` runs in the call and converts its values directly (`docs/dev/rust-classes.md`); one awaited
  converts its arguments in the call into the closure an op carries, the core runs it, and its boxed result in the
  core's events settles the promise (thousands issued in one turn, so this is their throughput, not one call's
  latency, which also waits for the engine's turn). In brackets, when ops and replies were JSON (`Command::Native`,
  a table of held instances, a `$return` event):

  | call | per call |
  |---|---|
  | a JS method (the floor) | 34ns / 38ns |
  | `#[class]` method taking and returning a number | 36ns / 37ns [34ns] |
  | the same taking a `#[derive(JsObject)]` `{ x, y }` | 139ns / 140ns [138ns] |
  | `#[module]` function without a context | 28ns / 28ns [27ns] |
  | `#[module]` function with `cx` (an op), awaited | 560ns / 566ns [1.58µs] |
  | `async` `#[module]` function, awaited | 618ns / 627ns [1.69µs] |
  | `async` `#[class]` member, awaited | 632ns / 637ns [2.15µs] |

  A synchronous call costs what a JS method call does, ~16× less than an awaited one; reading an object's fields is
  most of the object case (one property read through QuickJS each). Typed calls made the awaited ones 2.8–3.4×
  cheaper: no JSON either way, no name lookup of the function or member, no table. Rust components' props crossing
  typed (`Prop::RustProp`) left `component_bench` where it was (GridRust first frame JS 405–415µs, core 1.01–1.03ms,
  update of 200 titles JS 133–148µs, core 395–436µs, against 410–420µs / 1.01–1.06ms / 138–150µs / 411–443µs; the same
  1015 / 200 ops and 2217 / 400 mount items), as `nsh trace` did for the gallery (`Bench.tsx --scroll 3000`: the same
  1205 ops / 1008 items first and 1064 ops / 914 items over 39 scrolling commits) and `examples/bench`.
- Canvas recording (release `nsh trace`, minimum of the runs): in the former JS runtime, 2500 iterations of
  `beginPath`, `moveTo`, `lineTo`, `lineWidth =`, `strokeStyle =`, `stroke`, `fillRect` (17 500 calls) recorded into a
  JS array in ~1.4ms, the same with methods generated from the specs as with a hand-written class (an A/B of the two
  mechanisms in one QuickJS run: 4.16 vs 4.22ms, medians within 1%, for 80 000 calls).
  Decoding that drawing in the core (`nsh_core::js::canvas::decode`, from the QuickJS array) takes ~0.52–0.57ms
  (`cargo test --release -p nsh-js --lib bench_canvas_decode -- --ignored --nocapture`), as the hand-written decoder
  it replaced did (0.57ms).
  The native context records into a Rust list (`nsh-js` `canvas.rs`): the same 17 500 calls take ~1.0–1.1ms
  (~1.7ms in the former JS runtime, measured A/B), and 12 of them plus decoding one commit 21–22ms (61ms).
- Canvas text on macOS (`cargo test --release -p nsh-platform-macos --lib bench_canvas_text -- --ignored --nocapture`,
  a 40 × 8 quote table of 320 `fillText`s painted into a 760 × 820 point bitmap at scale 2, Apple Silicon): with each
  canvas keeping its fonts and `CTLine`s (`canvas/lines.rs`), a paint with the same texts (a window being resized)
  takes ~0.34–0.41ms and one after a new drawing changed every text ~1.5–1.6ms, against ~11.2–11.8ms either way when
  every paint made a font, an attributed string and a line per text.
- `OffscreenCanvas` on Windows: the UI thread records, submits the drawing and its copy, and maps the read-back
  bitmap once a Direct3D event query polled every timer tick says the GPU is done, so a large image costs it the
  recording and one copy of its rows, never a wait for the GPU; unpremultiplying and PNG encoding run on a thread.

- Where JS time went in the former JS runtime (release `nsh trace`, which logs `event js` per dispatched event;
  2026-10-16, before the runtime went native): with Solid in JS, the empty app's eval was ~250µs (all of it the
  runtime and Solid starting), counter's ~380µs (first frame ~500µs), and a counter tap spent a median 52µs in JS
  (handler, Solid's updates, the microtask flush and the op decode) against 17µs of core commit (11 ops, 10 items).
  The native reactive graph (`nsh-js` `reactive.rs`, still under the JS runtime), measured A/B on the same loaded
  machine: empty eval ~210µs vs ~300µs, counter eval ~330µs
  vs ~460µs, counter tap median ~47µs vs ~69µs in JS, gallery list rebind (`list_bench`) JS ~4µs vs ~21µs per frame.
- The native runtime (`native-pipeline.md`) against the former JS runtime, release, the same counter app (a counter,
  `<If>`, a 3-row `<Each>`) on both: bundle 886 B JS / 1.7 KB bytecode vs 14 KB / 19.6 KB, eval ~95µs vs ~390µs, tap
  median ~5µs vs ~14µs in JS, commit ~15µs vs ~22µs. Scrolling a 1000-row `List` (avatar, two texts, a bound color)
  6000 pt: ~77µs vs ~150µs of JS per rebinding frame, commit ~205µs vs ~276µs.

## Views made over frames (all platforms)

A list row bound in the overscan, or a long reply staged into a chat, used to make its whole subtree in one batch:
hundreds of native views nobody sees yet, created and committed by the platform in one frame (423 views took one 87 ms
frame on macOS, mostly the Core Animation commit). The core now spreads them (`crates/nsh-core/src/core/pace.rs`):

- once a turn has made 64 views, a view about to be made in a scroll view or a list cell waits, culled as content culling
  holds views back (laid out, given a frame, made at once by a command for it);
- after each layout the waiting views that show (their frame meets the viewport of every scroll view and list around
  them) are made at once, down to their leaves; the rest come in later turns, nearest the viewport first, at most 32
  views or 4 ms a turn, and the engine asks for a display frame while some wait;
- content culling's overscan keeps the same budget.

Views not made yet are not in the platform's accessibility tree, as culled content is not: they are out of sight and
come within a few frames. Selection and select-all read the core's nodes, not native views. Test drivers turn content
culling off, which turns pacing off, so their steps reach every view. Nothing waits that may show away from its frame
(sticky, followers, overlays, screens, modals, views scaled, rotated or moved by a value of no known bound), nor
anything outside scroll views and lists.

A view translated by a value the core can bound waits like any other, its rectangle widened by how far it may move
(`Core::reach_of`). The core follows every animation op on its way to the platform (`crates/nsh-core/src/animation/reach.rs`)
and keeps the interval each value has held and may hold (its values, its animations' targets with their easings' and
springs' overshoot, a decay's bounds) and how interpolations and math nodes map them; values a gesture or a scroll
view drives, and decays without bounds, have none. Intervals only grow, and an op that widens one makes the core look at
what it culls again in that commit, before the platform runs the animation. Animated opacity and colors move nothing.
Before, a page of sections that fade and slide in (the gallery's `Appear`, every `DemoPage`) made every view of every
section in one frame.

A deleted subtree leaves its window with its root at once; on macOS the views are freed over the next frames, at most
1 ms a frame (`nsh-platform-macos` `mount.rs`, `release_later`), not in the frame that shows what replaced them.

Reproduce: `cargo test -p nsh-core --release --lib -- --ignored big_rows_bench --nocapture` (a 480 pt list of rows of
420 views each, 5 rows bound). Linux x64, release:

| | first batch | later batches | batches |
|---|---|---|---|
| before | 2,105 views (4,640 items), core 1.04 ms | none | 1 |
| after | 100 views (290 items), core 1.02 ms | 32 views each (96 items), core < 25 us | 64 |

Every view in sight is in the first batch in both. The platform's cost is per view made, so at the macOS figure of
about 0.2 ms a view the first frame goes from about 420 ms of platform work to about 20 ms, and each later one about
6 ms.

## Shader pictures on Linux

What the GTK backend reads back for shaders' pictures (`nsh-platform-linux` `shader.rs`, `docs/dev/shaders.md`), and
when. A picture is drawn, rendered by the window's GSK renderer into a texture and downloaded synchronously on the
main thread, so the work is held by counts the backend's tests check on Xvfb, not by timings of one machine:

- An effect or a running transition pictures its children only when GTK drew one of them again since the last
  picture (`same_nodes` over the render nodes GTK kept) or the core marked them (`ShaderInput`). An effect that reads
  `nsh.time` draws itself on every frame, which takes the children's kept nodes and compares them, without rendering
  or downloading: ten frames over unchanged children are one picture, a child drawn again one more
  (`an_effect_renders_its_children_again_only_after_they_change`). Before, every frame rendered and downloaded the
  box and its overflow (400 × 400 points at 2× is 2.5 MB a frame).
- A view that reads `sample_backdrop` takes what is behind it again (the surface's views drawn anew up to it,
  rendered, downloaded and hashed) at most once per painted frame: after a batch (the core marks every backdrop
  reader once anything changed, `ShaderInput`) and after a view that draws before it changed on the UI thread (an
  ancestor's own drawing, or a view drawn earlier); a change on the UI thread in it, above it or in a shader's own
  frame takes nothing. A picture whose pixels hash as the last one's is not given to the shader, which then renders
  no frame for it: a change that leaves the view's box as it was costs the drawing, the readback and the hash, not
  an upload and a shader frame. Each reader is listed once, however often its layer is sent (every uniform update
  sends it). Before, any change on the UI thread took every reader's backdrop again and gave it to its shader.

## Continuous corners on Linux

Measured on 2026-11-05 using the actual `NshView` snapshot implementation:
GTK 4.24.1, Intel Arrow Lake-S GPU, Vulkan renderer, Wayland, 1200 × 800
points at 2×, 60 Hz. The debug test moves and redraws 100 identical
110 × 70 point cards (radius 20) every tick, warms up for 30 ticks and
samples 180 frame-clock intervals. No screenshots or texture downloads
occur during measurement. CPU is process CPU time / wall time, where
100% means one core; it includes warm-up.

```sh
cargo test -p nsh-platform-linux --lib continuous_corner_frame_cost -- --ignored --nocapture
```

Before path reuse (`237dfd88` plus the background benchmark), continuous
backgrounds averaged 33.33 ms / 30 updates per second; circular backgrounds
averaged 16.67 ms / 60. Reusing paths alone restored backgrounds and clipped
borders to about 60, but 100 blurred continuous shadows still averaged
39.73 ms / 25.2 updates per second. Retaining their vector render nodes alone
was insufficient (32.36 ms / 30.9).

The final implementation retains equal paths and renders unchanged continuous
shadows to GPU textures once, without readback. Shadows include all shape,
color, offset, spread, blur and inset inputs in their cache key, together with
device scale. Scaling, rotation and perspective transforms use the original
vector drawing to preserve quality. Path retention is limited to 128 entries;
shadow retention to 64 entries and 16 million pixels, with a 4 million pixel
limit per shadow. Larger shadows use vector drawing.

| Scene | Corners | Mean interval | p95 | p99 | Updates/s | CPU | Intervals >25 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| Background | Circular | 16.67 ms | 18.03 ms | 18.10 ms | 60.0 | 27.0% | 0 |
| Background | Continuous | 16.67 ms | 18.30 ms | 18.46 ms | 60.0 | 31.8% | 0 |
| Clipped child + 2 pt border | Circular | 16.66 ms | 18.23 ms | 18.52 ms | 60.0 | 37.5% | 0 |
| Clipped child + 2 pt border | Continuous | 16.67 ms | 18.51 ms | 18.67 ms | 60.0 | 35.7% | 0 |
| 8 pt blurred outer shadow | Circular | 16.66 ms | 18.30 ms | 18.47 ms | 60.0 | 33.7% | 0 |
| 8 pt blurred outer shadow | Continuous | 16.67 ms | 18.41 ms | 18.66 ms | 60.0 | 33.7% | 0 |

These are update intervals, not GPU execution times or confirmed presentation
timestamps. GPU utilization, cold-cache cost, heterogeneous-card cache pressure,
animated shape/blur changes, transformed shadows and 120 Hz were not measured.
The test is explicit/ignored and does not impose timing assertions in CI.
Pixel tests compare cached inset/outset shadows with vector rendering and check
that changed radius, blur and color do not reuse stale images.

The separate five-layer backdrop-blur probe (~15 FPS including full texture
readback) is not this implementation. Linux `backdropFilter` remains unsupported.

## The browser engine (published web apps)

Headless Chromium over CDP, a published package (`nsh package --target web`), 2026-10-28:

- A call from app code into the runtime (a signal read or set, an element made) outside a Wasm entry costs ~1µs
  however many values the app holds: the weak tracing runs after the call, not inside it, at least 100ms apart
  and twenty times as long after a run as it took (`values.js` `schedule`, `collectDelay`). With a full trace per
  call it cost ~0.11ms at 1 700 retained values and ~1.2ms at 14 400 (a chat of 165 messages of 20 signals each),
  and a message pushed every second froze the page.
- Typing into a controlled `Input` beside 10 000 rows that each hold a handler, a key every 80ms, 2026-11-11: with
  accessors keyed by numbers and the accounting spaced by its own cost, the accounting took ~3.65ms per key instead
  of ~9.4ms and script ~5.4ms instead of ~10.7ms; with the CPU slowed 4×, accounting ~3.6ms instead of ~50.4ms,
  script ~6.9ms instead of ~65ms, main-thread task time ~20.9ms instead of ~79.5ms per key.
- The gallery's DataTable demo, quotes ticking every 33ms and no scroll, 10s: the rows are read a row per call
  (`JsHost::primitives`, op 49), ~220 000 value calls in 3s instead of ~8.7 million (a cell took five), script
  ~2.65s instead of ~3.86s, main thread ~4.7s instead of ~5.95s, garbage collection ~52ms instead of ~162ms.
- The same demo scrolled, the frame rate unlimited (`--disable-frame-rate-limit`): the animator sends every bound
  value with each batch (the gallery's sidebar: ~69 canvas slots, ~26 transforms, ~7 opacities), and `nsh.js` writes
  and draws only those that changed, and draws a canvas again when its size changes, not when it moves. The wheel,
  300 steps of 30pt: main thread ~3.8s instead of ~4.5s, median frame ~9.2ms instead of ~12.2ms; its scroll bar
  dragged 150 steps: script ~4.3ms per batch instead of ~5.6ms.
- Shader views (`nsh.js`, `docs/dev/shaders.md` "The web"), the gallery's Shaders page in a Chrome window over CDP
  (1200 × 713 points at 2×, 120 Hz, Apple M5 through ANGLE's Metal renderer, the development host), 2026-11-04:
  two `nsh.time` shaders in sight, then the `ScreenEffect` (Duotone) turned on below them. With the screen effect,
  each frame asked for two `shaderFrame` callbacks, so the frames doubled until one display frame took 9 to 24 s;
  now it holds 120 fps (p50 8.3 ms, p95 9.5 ms), ~3.3 ms of `shaderFrame` a frame, ~3 ms of it the surface's picture
  (`paintInputs`). Each view drawing into the corner of a shared canvas that fits the largest and copying it out,
  instead of resizing the canvas to each view and transferring it whole: ~0.1 ms a view (`drawShader`) instead of
  ~0.65 ms, and of ~1.6 ms with the screen effect, whose size the canvas took and gave back on every frame; the page
  without the screen effect ~0.3 ms of `shaderFrame` a frame instead of ~2 ms.

## Linux startup memory budget

The startup target is 50 MB (50,000,000 bytes) **RSS**. Report PSS and USS alongside it; neither replaces the RSS
criterion. On `e4cc287dd`, GTK 4.24.1, NVIDIA 615.78.08, Wayland at 1.6×, 480×640-point windows, two launches each,
8 s after resizing: minimal TSX with the full GL runner 162 MiB RSS / 65–66 MiB USS; the TSX template 164 MiB RSS;
gallery's phone-layout index 257 MiB RSS. A js-only Cairo runner gets minimal TSX to 97 MiB RSS / 31 MiB USS.
The measured configurations do not satisfy the budget. Bare GTK with Cairo is already 82 MiB RSS on this host.
The run is a resident snapshot, not a startup peak, and keeps page/driver caches between launches.

What NSH itself adds is measured as private dirty memory over a bare GTK window, the same host, one batch
(`docs/benchmarks/linux-memory-baseline-2026-11-05.json`): with GL the GTK window holds 36.7 MiB (129 MiB RSS), the
Rust template 41.6 (150), the TSX template 45.4 (163); with Cairo 15.2, 19.1 and 24.3 (82, 101, 115). NSH adds 4–5 MiB
for Rust and about 9 MiB for TSX; the 50 MB RSS target lies below the bare GTK window's own RSS with either renderer.
GL launches vary by about 60 MiB of private dirty memory in the bare GTK window as well: the driver's, not NSH's.

Reproduction and tradeoffs: `website/docs/performance-report.md`, Linux memory investigation.
Samples: `docs/benchmarks/linux-memory-2026-11-05.json`. Tools: `examples/gallery/tools/memory.py` and its
`memory-gtk.c` control. The sampler rejects logged startup errors; failed split bundles are excluded from results.

Priorities for further implementation, with before/after measurements on the same page and renderer:

1. Native gallery chunk delivery: `nsh build --split` shrinks the entry from ~1.3 MiB bytecode to 77 KiB, but the
   Linux release runner does not provide its static/dynamic chunks. Wire trusted bundle chunks and async loading
   through `Bundle` / `MountSink::load_chunk`, then verify loading/navigation/disposal before measuring savings.
2. Source-map lifetime: `Bundle::read_trusted` loads a ~4 MiB gallery map immediately. Profile retained copies and
   symbolication (`nsh-engine/src/symbolicate.rs`) before implementing lazy maps; exploratory map-removal runs
   changed gallery state and establish no controlled saving.
3. Attribute startup allocations: separate QuickJS context/module evaluation, UI registry construction, the
   reactive/core trees, text/font caches and GPU initialization. A TSX-versus-Rust delta alone does not identify
   QuickJS heap usage. Shader GPU creation is already lazy (`surface.rs::shader_renderer`); test first use separately.
4. A low-memory GTK path needs renderer/driver residency evaluated as well as the Rust heap. Cairo and lean
   features have measured benefits, but global renderer changes require animation, scrolling and feature checks.
   `GDK_DISABLE=gl,vulkan,dmabuf` did not materially improve the minimal Cairo result here.

Track first-frame and settled RSS, PSS, USS, process-tree memory where appropriate, image-cache costs and page
identity. Keep fresh storage and equal dimensions across comparisons; retain launch ranges and rendering failures.

## The performance monitor (`nsh_engine::perf`)

`PerfMonitor` collects one surface's timings for an on-screen monitor (`--fps`; the macOS backend's `fps.rs` draws it)
or an app's own tooling (`AppView::perf_monitor`), modeled on gpui-kit's `gpui-fps`. The engine thread records each
wake-up that committed (`CommitTiming`: the core's apply / render / layout / diff, and the rest as the app's code) once
`EngineControl::set_perf_monitor` installs one; the platform records its main-thread work (`record_work`), closes a
frame at each display refresh (`vsync`: a refresh in which something changed is a shown frame) and the batches'
engine-to-main-thread latency. `snapshot()` gives the rates over the last second, the distributions over the last 120
frames / commits (mean, p95, max, the share over one refresh), the engine's busy share and the process' CPU and memory
(`ProcessSampler`: `getrusage`, the physical footprint on Apple platforms, the resident set on Linux / Android). The
first frames and commits are cold and not counted. Without a monitor nothing is timed (one `Option` per wake-up and
per frame). Other platforms need only call `record_work` / `vsync` / `record_latency` where the macOS surface does and
draw a panel.

- macOS (release, Apple silicon, 1200×800 window, 120 Hz ProMotion screen; `nsh-macos-host --fps --trace` with
  scripted input (the then `--script` steps), two alternating runs of each; main-thread ms per shown frame as p50 / p95). The display link delivers
  120 Hz in every case (refresh gaps p50 8.33 ms). Before = the backend without the two drawing fixes below:

  | Scenario | Before: main p50 / p95, CPU | After: main p50 / p95, CPU |
  |---|---|---|
  | Stocks, idle (a tick every 50 ms, pulsing canvases) | 3.2–3.5 / 5.9–6.8 ms, 59–67% | 2.5–2.7 / 5.2–5.6 ms, 47–55% |
  | Stocks, scrolling the watchlist | 3.5–3.6 / 7.5–7.7 ms, 64–69% | 3.0–3.4 / 6.3–6.7 ms, 59–64% |
  | Lists grid, scrolling | 0.4–0.6 / 6.3–6.4 ms, 33–34% | 0.3–0.6 / 2.0–5.9 ms, 14–32% |
  | Animations demo | 0.2–0.5 / 0.2–0.8 ms | 0.1–0.3 / 0.2–0.6 ms |

  Single runs move by ~20% (other processes); earlier runs of Stocks without the fixes read p95 ~10.7 ms with 8–12%
  of frames over 8.3 ms. Sampled (`sample`), the main thread on Stocks is ~85% busy before and after, ~75% of it
  Core Animation drawing layers (`drawRect:` recorded ~18% → ~11%, the backing store replay the rest): the demo
  redraws its 524×340 chart canvas on every frame for a pulsing dot. Per Stocks tick the engine applies ~230 ops
  into 60–110 mount items in ~0.8–1.2 ms (`nsh trace --width 1200 --height 800 --wait 300 --duration 2000`).
  The fixes: drawing views clip to their bounds (AppKit redrew every text of a scroll view on every scroll step,
  ~150 per wheel event in Lists, ~3.5 ms each event in a debug build), and canvases out of sight are not redrawn by
  their animations.

  Partial canvas redraws (`nsh_core::canvas::DamageScan`, `docs/dev/canvas.md`): an animation of a canvas's animated
  values redraws only what the operations reading them cover (Stocks: the chart's ring ~31×31 pt of its 524×340, the
  sparklines' ~23×25 of 124×58; whole only on the ticks). With `drawRect:` this halved the main-thread frame (Stocks
  idle `main` p50 ~3.0 → ~2.0 ms, CPU ~62% → ~44%). On top of content layers drawn asynchronously the gain is within
  noise (four runs each, ABBA, presented frames by screen capture): Stocks idle window updates 75–96 /s both, `main`
  p50 ~1.9 → ~1.7 ms, CPU ~38–40% both; a test canvas (524×340: a 400-point area and line, 400 bars, a pulsing ring,
  a moving square) presented 86–117 fps before and 92–119 after, `main` p50 ~1.2 → ~1.0 ms, CPU ~17% both.

  Kept static parts (`canvas.rs` `Prefix`, `docs/dev/canvas.md`; `examples/gallery/tools/perf.py --only
  Stocks,Canvas,Animations --seconds 6`, two runs each, the display kept awake): a long static part, painted unchanged
  30 times, is kept as a `CGLayer` and its canvas drawn at once. Canvas demo idle: canvas phase 0.24–0.27 →
  0.09–0.11 ms, CPU 7–10% → 4–6%, GPU 5–6% → 0%, ~200–220 → ~106 MB; Stocks and Animations unchanged (their
  drawings are short or change every few frames, so none is kept). Tried and not kept: the layer for every drawing
  (Stocks' frame p95 ~3.3 → ~4.2 ms: its sparklines change ~15 times a second and replay faster than a layer draws),
  every canvas at once (Stocks p95 ~3.3 → ~7.5 ms, 2% of frames over a refresh: the main thread fills the screen's
  RGBA16F backing stores), 8-bit contents (canvas phase ~0.45 → ~1.6 ms).

  Canvases drawn at once unless they paint often (`canvas.rs` `Cadence`: 10 paints a second): three 340×40 line
  charts redrawn every 2 s (a menu-bar panel's) hold ~83 MB of footprint asynchronously and ~21 MB at once, with
  ~30% less CPU time over 40 s. The gallery's tour is unchanged in frame time and CPU; peak memory on the pages with
  canvases drops (Canvas scrolling ~383 → ~310 MB, Animations ~290 → ~232, Gestures ~279 → ~221).

  Small canvas animation surfaces (M2 Max, macOS 26.6.2, release, 120 Hz, 1200×800 pt Stocks; against
  `f7afd23f`, the same unmodified gallery bytecode, four interleaved 20 s runs per version after 5 s warmup,
  fresh data directories). Run the hosts with `--bundle <gallery.nshc> --window-size 1200x800 --fps --trace
  --data-dir <fresh>`. Median process CPU (100% is one core) 38.34 → 23.63%, physical footprint 152.7 →
  133.1 MB, main-thread p50 1.93 → 0.83 ms and p95 4.40 → 2.60 ms; both 119–120 fps. These are medians
  across runs; each run's frame figures are medians of the HUD's rolling 120-frame percentiles, not pooled
  frame percentiles. Live market updates seed themselves from wall-clock time, so each run has a different
  quote sequence. Short drawings can retain their background while a small source-over animated suffix
  redraws in a separate layer. Complex suffixes and long prefixes keep the existing path.

  Controls (two interleaved 12 s runs per version, same warmup): Canvas demo CPU 2.93–3.56 → 3.41–3.49%;
  a 10,000-point static path with an animated dot, CPU 7.42–8.41 → 8.39–8.99%, main p50 0.47–0.63 →
  0.61–0.67 ms. The control medians are slightly higher; these small samples do not establish a speedup
  or rule out overhead. The long-path guard preserves the existing prefix cache; an unrestricted split
  had increased geometry-scanning work.
  Fixed-clock headless `nsh test --trace` (three 1 s runs each): initial 4412 ops / 3708 mount items /
  1249 nodes; 180 update commits per version, median 124 ops / 85 items / 1249 nodes, unchanged.
  Initial commit times 4.9–6.4 → 4.9–6.9 ms, update medians 220 → 230.5 µs; the optimization is in the
  platform's painting, and these engine timings establish unchanged work rather than an engine speedup.

  List binds while scrolling (release host, 120 Hz MacBook Pro; the list scrolled by chained native
  `scrollToOffset({ animated: true })` every 300 ms, no input; each display link refresh logged with its link
  timestamp and main-thread time; three runs each, refreshes missed = link gaps of two periods or more). Before =
  four cells per turn on `Wake`; after = the viewport bound at once, the overscan paced per frame, one item per view
  part per merged frame, batches applied at frame start (4 ms), the cursor set only when it changes:

  | Scenario | Before: fps, missed, main mean / p99 / max | After: fps, missed, main mean / p99 / max |
  |---|---|---|
  | 1100 rows of 76 pt, 390×844, 6000 pt/s | 119.2–119.9, 1–12, 0.31–0.32 / 1.2 / 1.9–2.0 ms | 118.5–119.2, 12–22, 0.25–0.26 / 1.0 / 1.9–4.0 ms |
  | The same at 16700 pt/s | 119.0–120.0, 0–6, 0.51–0.52 / 1.9–2.0 / 3.2–6.3 ms | 119.7–120.0, 0–2, 0.39–0.40 / 1.7 / 3.1–4.7 ms |
  | Photos grid, 1200×800, 6000 pt/s | 118.1–120.0, 0–53, 0.30–0.34 / 0.9–1.0 / 8.5–11.3 ms | 119.8–120.0, 0–6, 0.44–0.48 / 2.2–2.5 / 4.2–5.4 ms |

  The rows' "after" runs were taken before the cursor change. Where the mouse was is not controlled: hover and cursor
  work happen only with it over the window, which may be why the grid's mean rose. The missed refreshes do not follow the main thread's time (a run missing 18% had a 0.7 ms mean): the machine was loaded
  (load average 8–29 from other processes), and one excluded run had ~100 ms stalls every 5 s with the main thread
  idle. Frames over a refresh were the Photos grid's: setting the cursor as content moved under the mouse, which
  renders its image again when the pointer is customized in Accessibility settings (45% of the main thread's
  samples). Without that, a single batch of the first tiles a scroll shows costs 4–5 ms.

- GPUI backend (`nsh-platform-gpui`; release with thin LTO, rootful Xwayland at scale 2, a focused 285×315 pt window at
  60 Hz, against the GTK backend (`GSK_RENDERER=ngl`) on the same display and bundle). `draw` is the surface element's
  prepaint and paint (the whole view tree, every frame), `frame` GPUI's whole frame with presenting (`ZED_MEASUREMENTS=1`),
  CPU the process' (both threads):

  | Scenario | GPUI: draw p50 / p95, frame p50 / p95, CPU | GTK: CPU |
  |---|---|---|
  | Photos list, three mouse flings (61 fps while gliding) | 0.29 / 0.42 ms, 0.63 / 0.89 ms, 4% | 7% |
  | Photos list, wheel notches every 30 ms | 0.23 / 0.30 ms, 0.60 / 0.87 ms, 3–4% | 4% |
  | Animations demo (three native loops) | 0.24 / 0.29 ms, 0.61 / 0.97 ms, 4% | 4% |

  An idle surface draws no frames (frames are requested only while something animates or JS asked for one). GPUI caps
  unfocused windows at 30 fps by default (`WindowOptions::inactive_frame_interval`), skipping frames in between (gaps of
  33–50 ms): NSH's own windows turn the cap off (61 fps unfocused); hosts embedding an `AppView` decide for theirs.
  Debug builds draw the Animations page in 1.5–3.5 ms.

  On the Wayland desktop (Hyprland, 3840×2160 at 144 Hz, scale 1.6; a 1500×900 pt window, unfocused, release with
  thin LTO, `nsh-gpui-host --fps` with `ZED_MEASUREMENTS=1` (`gpui.md` "Frame statistics"); `paint` is the main
  thread's per frame, `frame` GPUI's draw and present):

  | Demo | Before: fps, paint p50, frame p50 | After: fps, paint p50, frame p50 |
  |---|---|---|
  | Animations (three native loops, ~26 paths a frame) | 26, 0.62 ms, 1.07 ms | 145, 0.42 ms, 0.76 ms |
  | Stocks (live prices, sparklines, chart) | 25, 18.4 ms, 19.3 ms | 143, 1.9 ms, 2.5 ms |
  | Gestures (springs, a pulsing ring) | 26, 0.21 ms, 0.52 ms | 145, 0.17 ms, 0.35 ms |

  Before: GPUI's 30 fps cap of unfocused windows (frames 40–42 ms apart) and, in Stocks, canvases rasterized in full
  on the main thread (18 ms of every frame: ~190 new drawings a second). After: no cap in NSH's windows, canvases
  rasterized on two workers and only what animates in place (`canvas.rs`).

  Canvas animated argument batches (`canvas.rs`, 2026-11-12, Linux x86_64, Ryzen 9 7950X, against
  `9fd11f83`): the before / after setters and unchanged `DamageScan`, extracted into an isolated harness.
  Rust 1.99.1, opt-level 3, fat LTO, one codegen unit, pinned to CPU 2, no concurrent builds; four warmup
  updates, three processes with seven alternating pairs each, medians of all 21 samples per implementation:

  | Static path points | Changed slots | Argument update, before → after |
  |---|---|---|
  | 0 | 64 | 16.157 → 1.311 µs |
  | 400 | 64 | 272.069 → 5.407 µs |
  | 4,000 | 8 | 316.143 → 41.026 µs |
  | 4,000 | 32 | 1,263.803 → 41.492 µs |
  | 4,000 | 64 | 2,526.364 → 42.080 µs |
  | 4,000 | 256 | 10,262.553 → 46.824 µs |

  A canvas's animated values are applied together: at most two whole-drawing damage scans and one
  `view.changed()`, instead of up to two scans and one call per changed slot. Changed-slot storage is reused;
  one changed slot keeps a scalar predicate. Controls with one slot and 0 / 400 / 4,000 static points take
  0.0566 / 4.048 / 39.514 → 0.0563 / 3.986 / 39.279 µs (medians within 1.6%). The harness includes input
  preparation, state borrowing and slot writes, with a notification counter and supporting type shims. It
  excludes the actual invalidation walk, rasterization, workers, uploads, GPU work and presentation.

  Headless `nsh test <entry> --trace` (debug, three alternating runs per version): a canvas of 256 animated
  rectangles after 4,000 static path points keeps 287 ops / 284 mount items / 10 nodes initially, then
  0 ops / 6 items / 10 nodes and 0 ops / 5 items / 10 nodes when resized to 760×420 and 920×540. Commit
  medians are 2448 / 185 / 127 → 2490 / 171 / 140 µs. The counter control keeps 57 ops / 51 items / 21 nodes
  initially and 10 ops / 7 items / 24 nodes after `+1` (395 / 276 → 410 / 305 µs). Every mount item matches
  between versions. These are smoke checks of unchanged engine work; the optimization is in GPUI's animated
  argument writes. Native frame-time and process CPU/GPU changes have not been measured.

The dev profile builds `quickjs-jit-sys` and `taffy` with `opt-level = 3`, so debug timings are meaningful too; release uses fat LTO (the published distribution thin LTO over 16 codegen units: `docs/dev/tooling.md` "Releases").

- Linux (GTK 4, release; a 1896×1030 window on a 120 Hz headless Hyprland output, NVIDIA; `--fps` readings and the
  host's threads' CPU from `/proc`, 20 s runs). Before = main as of `8ff7b9f6` (GSK's Vulkan renderer, canvases
  replayed into a Cairo recording surface on every change):

  | Scenario | Before: fps, frame p95, CPU | After: fps, frame p95, CPU |
  |---|---|---|
  | Stocks (live prices, sparklines, chart, a tick every 50 ms) | 75–87, 17–21 ms, 82–85% | 117–120, 5–6 ms, 31–32% (29% at 1200×800) |
  | Canvas demo | 118–120, 6–11 ms, 17–23% | 120, 2.6–4.4 ms, 5–10% |
  | Animations demo | 66–85, 21–25 ms, 73% | 120, 2.0 ms, 12–13% |

  Every page of the gallery draws its frames in under 8.3 ms at p95 (`examples/gallery/tools/perf.py`). On Stocks
  the GL renderer alone gave 116 fps at 62%; the canvas rasters (tiles, partial redraws over the kept static part,
  canvases out of sight waiting) took it to the rest. What is left is GSK's rendering (~12% of the main thread: GL
  commands for the damaged areas), Cairo's rasterizing (~8%, strokes most of it: the chart's full redraw on every
  tick costs ~1.7 ms, a sparkline's pulse ~21 µs) and the engine (~5%: the demo's market in JS, canvas recording,
  layout). `fillRect` / `fillText` after a long path set it aside once instead of copying it out and back per
  call: a 400-point line then 240 bars, 840×340, 1.68 → 0.63 ms (`cargo test --release -p nsh-platform-linux
  bench_rects_after_a_path -- --ignored --nocapture`). Memory: visiting a demo again adds nothing; the first visits
  grow by bounded caches (decoded images, up to 128 MB) and libraries loaded on first use (WebKitGTK).

- Windows (Win32 / Direct2D, release; i7-13700KF, RTX 3060 Ti, a 1200 × 800 point window on a 4K 144 Hz display at
  150%; `--fps` readings through `nsh test --target windows --fps`, 4 s per scenario). Before = this branch with
  only the monitor added (every canvas whose animated value changed recorded again in full; every view pushed a
  content clip; every child of a scroll view drawn):

  | Scenario | Before: fps, frame p95, over one refresh, paint / canvas per frame, CPU | After |
  |---|---|---|
  | Stocks | 144, 8.2–8.8 ms, 11–28%, 4.4 / 1.8 ms, 87–98% | 144, 6.6–6.9 ms, 3–5%, 2.7 / 0.3 ms, 52–71% |
  | Canvas demo | 144, 2.7–5.0 ms, 0–1%, 2.2–2.5 / 0.21 ms, 30–32% | 144, 2.6–2.7 ms, 0%, 2.0–2.4 / 0.08 ms, 28–50% |

  Stocks re-recorded ~3100 canvases a second (its 22 sparklines and the chart, on every pulse), 280 ms of the main
  thread; recording only what follows the first animated operation takes that to ~26 ms (the sparklines erase their
  left edge with `destination-out`, inside the head). What is left is drawing the whole window on every refresh
  (~690 views; text ~0.6 ms of it, `EndDraw` ~0.05 ms). CPU readings vary by ±10 points between runs on this machine.

  Partial frames (`docs/dev/windows.md` "Partial frames": a frame draws the changed views' areas over the kept back
  buffer of a `FLIP_SEQUENTIAL` swap chain, once, in a clip of up to 24 rectangles, and presents them with `Present1`),
  same setup. Before = the whole window drawn on every frame:

  | Scenario | Before: frame p95, over one refresh, paint per frame, CPU | After |
  |---|---|---|
  | Stocks (~34 changed views a frame) | 6.6–6.9 ms, 3–5%, 2.7 ms, 52–71% | 3.7–4.3 ms, 0–1%, 1.4 ms, 36–43% |
  | Animations demo | 2.6 ms, 0%, 2.3 ms, 32–40% | 1.0 ms, 0%, 0.9 ms, 20–28% |
  | Canvas demo | 2.6–2.7 ms, 0%, 2.0–2.4 ms, 28–50% | 0.95 ms, 0%, 0.8 ms, 21–26% |

  Drawing each area in a pass of its own (up to 6) was tried first: Stocks' paint only went 2.7 → 2.2 ms, the
  passes each walking the tree and the merged areas covering ~30% of the window.

  Canvas paints that cannot change pixels and slot-indexed canvas damage (`docs/dev/canvas.md` "Partial redraws"),
  release, base `f0b4659e` (the baseline built from that commit in a detached worktree), i7-14650HX, RTX 4060
  Laptop GPU, 2560 × 1600 at 240 Hz and 150% scale, a 1200 × 800 point gallery window. Six alternating
  baseline/new runs per side (`examples/gallery/tools/perf.py --nsh <binary> --only Stocks,Canvas --seconds 4
  --size 1200x800`, the logs kept by an external collector), each cell the median of the per-second phase means
  and the nearest-rank p95 of the per-second p95s over the pooled seconds (`n`):

  | Scenario (n before / after) | Phase | Before, mean / p95 | After, mean / p95 |
  |---|---|---|---|
  | Stocks idle (18 / 18) | canvas | 0.475 / 2.080 ms | 0.460 / 2.140 ms |
  | Stocks idle (18 / 18) | paint | 4.350 / 9.010 ms | 4.405 / 9.180 ms |
  | Stocks scroll (77 / 78) | canvas | 0.480 / 2.300 ms | 0.480 / 2.250 ms |
  | Stocks scroll (77 / 78) | paint | 4.360 / 9.120 ms | 4.400 / 9.210 ms |
  | Canvas idle (18 / 18) | canvas | 0.050 / 0.100 ms | 0.050 / 0.070 ms |
  | Canvas idle (18 / 18) | paint | 0.510 / 0.690 ms | 0.500 / 0.740 ms |
  | Canvas scroll (26 / 29) | canvas | 0.060 / 0.100 ms | 0.060 / 0.100 ms |
  | Canvas scroll (26 / 29) | paint | 1.055 / 2.540 ms | 1.030 / 2.620 ms |

  Both gallery demos hold their rate (240 fps in the Canvas demo; Stocks' live feed keeps it at a median 186–189
  fps both sides) and the phases move within run-to-run noise: the gallery does not draw Flow's comet, the
  workload this targets (48 strokes per flowing connector, about three quarters of them at alpha zero at a
  typical step), and the Canvas demo's pulsing ring animates its radius, so its damage keeps the conservative
  full scans. The flow document is measured after Flow's pin advances. Headless
  `nsh test examples/gallery/App.tsx --trace` is unchanged: 3174 ops / 3169 mount items / 859 nodes in the first
  commit and 11 ops / 0 items / 859 nodes in the second, with every item line equal between the binaries (the
  bundle is 2 110 929 bytes from both). The scripted light and dark screenshots of the gallery's home page are
  byte-identical between the binaries (SHA-256 `6a3568db…` light, `b24d354d…` dark).

  Off-damage own painting, lazy box geometry and current-frame cache retention (`docs/dev/windows.md`
  "Partial frames"), release, the same host and a 1200 × 800 point gallery window, base `f0b4659e`
  (the detached worktree's binary). Three alternating baseline/new runs per side
  (`examples/gallery/tools/perf.py --nsh <binary> --only Stocks,Canvas --seconds 4 --size
  1200x800`, the logs kept by an external collector); `n` is the pooled seconds, each cell the median
  of the per-second means and the nearest-rank p95 of the per-second p95s:

  | Scenario (n before / after) | Phase | Before, mean / p50 / p95 | After, mean / p50 / p95 |
  |---|---|---|---|
  | Home idle (9 / 9) | paint | 4.40 / 3.60 / 7.79 ms | 3.16 / 2.55 / 7.01 ms |
  | Home idle (9 / 9) | canvas | 0.47 / 0.24 / 2.20 ms | 0.37 / 0.23 / 1.51 ms |
  | Home scroll (40 / 39) | paint | 4.60 / 4.06 / 8.38 ms | 3.66 / 2.73 / 8.77 ms |
  | Stocks idle (9 / 9) | paint | 4.54 / 3.88 / 9.35 ms | 4.52 / 3.84 / 9.59 ms |
  | Stocks scroll (41 / 38) | paint | 4.64 / 4.03 / 9.43 ms | 4.13 / 3.44 / 9.10 ms |
  | Canvas idle (9 / 9) | paint | 0.52 / 0.51 / 0.77 ms | 0.45 / 0.44 / 0.60 ms |
  | Canvas scroll (14 / 14) | paint | 1.07 / 0.57 / 2.69 ms | 1.04 / 0.51 / 2.65 ms |

  The gallery's home index gains the most: its cards are non-clipping parents with children, so an
  off-damage card no longer paints its background, border and shadow (paint's mean −28% idle, −20%
  scrolled). Stocks' idle paint barely moves because its pulsing sparklines sit inside every visible
  card's own box (the card is in damage); scrolling improves its mean by 11%. Frames per second are
  unchanged or better (Home idle median 191 → 218, Stocks scroll 181 → 195, Canvas 240 both sides)
  and commits are identical (17 / 18 / 49); CPU readings move by ±10 points between runs and are not
  used to judge this change. The decoration cache does not reach its 96 MiB limit in the gallery, so
  current-frame retention is covered by its unit tests rather than these runs. A nine-patch outer
  shadow was tried and rejected: Direct2D's blur moves its faint outer tail by one alpha unit when
  the destination shape's extent changes, so sliced pixels cannot equal the whole-box bake (the
  measurement and the two fixes tried are in `windows.md` "Partial frames"); outer shadows keep the
  original bake.

  Headless `nsh test examples/gallery/App.tsx --trace` is unchanged: both binaries bundle
  2 110 929 bytes; 3174 ops / 3169 mount items / 859 nodes in the first commit and 11 ops / 0 items /
  859 nodes in the second, with every item line identical (only timings differ). The scripted light and
  dark screenshots of the gallery's home page, the Styles demo (cards and shadows) and the Canvas demo
  are byte-identical between the binaries: home `6a3568db…` light and `b24d354d…` dark, Styles
  `ca47dbd1…` / `6e754557…`, Canvas `1d189674…` / `26ebaf3e…`. A resized viewport (777 × 523) is not
  comparable byte for byte: shots a second apart in one run differ by 17 064 pixels (new binary) and
  18 093 (baseline) of 965 448, the resized frames keep repainting, so the resize evidence is visual
  only and the partial-frame BGRA tests cover the drawing.

- Tailwind containing blocks, font-relative lengths and intrinsic text sizes (PR #323 follow-up, Linux,
  debug counter trace against `70254f80`): first commit 656 → 674µs, press commit 313 → 312µs;
  both runs produce 56 ops / 49 mount items / 21 nodes initially and 10 ops / 7 mount items / 24 nodes
  after `+1`. Single runs establish unchanged work counts; timings are a smoke check, not a benchmark.

## Terminal frame budget

The terminal budget is **apply + draw p95 below 4 ms per frame at 200 × 60 Cells**, in a release build.
The ignored host test follows the `bench_gallery_scroll` pattern:

```sh
cargo test --release -p nsh-tui-host --test host bench_terminal_scroll -- --ignored --nocapture --test-threads=1
```

It loads a pinned copy of the former terminal gallery's `LongList` and `Page` layout (500 rows, dark palette,
from revision `945be71d`, retained in `tests/fixtures/performance/LongList.tsx`), then a DataTable with
10,000 rows and 24 columns, through `AppView`. Each workload scrolls by three rows per frame, reversing every
100 frames. It discards 20 warm-up frames and measures 240 frames with a 16 ms wait between frames for engine
work. Loading, bundling and waits are outside the samples. Median and nearest-rank p95 cover apply + draw;
phase means identify apply, draw and flush costs. It prints mean bytes and changed Cells per frame, then fails
if either workload exceeds the p95 budget. The flushed buffer must show the initial content and then scroll
away from it, so an empty screen cannot establish a baseline.

The backend is ratatui's `TestBackend`; the same diff also passes through `CrosstermBackend` into memory to
count its encoded bytes. Those include cursor and style escapes, and the monitor's line. The reported flush
cost includes this test transport and encoding, not a terminal emulator, SSH or a real stdout write. The live
monitor measures the real writer. Apply + draw excludes the monitor's formatting, ratatui's diff and flushing.

| Workload (200 × 60 Cells) | Apply + draw median / p95 | Apply / draw / flush means | Bytes / Cells per frame |
|---|---|---|---|
| Terminal Long list, 500 rows | 1.144 / 2.242 ms | 0.128 / 1.177 / 0.193 ms | 3,674 B / 959 Cells |
| DataTable, 10,000 × 24 | 1.103 / 2.592 ms | 0.169 / 1.189 / 0.205 ms | 7,446 B / 1,052 Cells |

Measured on Apple M4 Max, macOS 27.0.1, on the `tui-backend` branch after the terminal's surfaces, borders and
focus bands, 240 frames each: both workloads pass the budget. Drawing each surface's fill, frame and marks raised
the Long list's draw from 0.474 to 1.177 ms; the DataTable's fell from 1.765 to 1.189 ms.
Tickets changing terminal rendering, input or layout
bring before / after runs of this command on the same machine and workload, plus the existing `nsh test --trace`
commit timings and mount-item counts. An unchanged workload and profile are essential for comparing results.


## Terminal idle CPU

```sh
cargo test --release -p nsh-tui-host --test host bench_terminal_idle_cpu -- --ignored --nocapture --test-threads=1
```

This ignored benchmark runs in an isolated scenario process and starts the actual host binary on a private
100 × 24 PTY with a static Text app. The scenario watchdog and runner deadline cover setup and cleanup; their
process costs are outside the sampled host PID. It
runs once with the monitor hidden and once with `--fps`, lets startup and the idle HUD update settle for two
seconds, then measures five seconds. CPU is the child's user + system CPU time divided by elapsed wall time
(percent of one core), read through `proc_pid_rusage` on macOS or `/proc/<pid>/stat` on Linux. It reports terminal
bytes during the same window, requires zero bytes and CPU below 2%, then sends SIGTERM and requires exit within
one second. The separate lifecycle regressions close the PTY and check that the process exits, rather than
measuring a disconnected process that should no longer exist.

| Static app, 100 × 24 Cells | Idle CPU, one core | Bytes in 5 s |
|---|---|---|
| Monitor hidden | 0.003% | 0 |
| `--fps`, after idle update | 0.003% | 0 |

The reported incident was 10–45% CPU per orphan after a tmux terminal was killed, with SIGTERM unable to end it.
Source inspection found crossterm's default Unix read loop retrying EOF/EIO without returning to the host's
shutdown flag. The fix selects its bounded reader, checks terminal lifetime, and makes input/output cancellable.
The macOS debug host suite passes, including the one-second signal, hangup and full-output shutdown checks.
Measured on Apple M4 Max, macOS 27.0.1, revision 4799709f. Repeat the same command
before and after future scheduler or transport changes; the CPU sample excludes startup and termination.

## TUI development startup

Measure development compilation separately from host rendering:

```sh
cargo test -p nsh-cli bench_dev_startup -- --ignored --nocapture
```

The ignored benchmark runs the unchanged counter and gallery three times, splitting hot bundling,
script/source-map assembly and QuickJS bytecode compilation. It checks that compilation produces bytecode;
it reports timings rather than imposing a machine-dependent startup threshold.

Linux x86_64, debug, revision `889872685`, three runs after building the CLI and TUI host:

| App | Hot bundle | Script / source map | Bytecode |
| --- | --- | --- | --- |
| Counter | 8.6–14.5 ms | 0.12–0.13 ms | 0.54–0.94 ms |
| Gallery | 1,014–1,059 ms | 82.8–83.3 ms | 70.9–72.3 ms |

Gallery produces 2,330,102 source bytes and 11,103,922 bytecode bytes. Hot development includes the demo
modules in the initial script even though the gallery executes their factories when first shown.

Separately, `target/debug/nsh run examples/<app> --target tui --trace --port 18973` on a private
200 × 60 PTY (three fresh processes, existing builds, terminal queries unanswered) reached visible
Counter content in 629–635 ms and Gallery content in 1,864–1,899 ms. The TUI host's Cargo freshness
check took about 288 ms. Gallery's engine first frame was about 77 ms: 3,172 operations,
2,202 mount items, 997 nodes. These are local development measurements, including CLI preparation,
not release-host startup numbers. Initial compilation and terminal query handling are separate costs;
repeat on the reported command and machine before attributing a longer startup to rendering.

Startup feedback: the CLI previously redirected output before app preparation, suppressing Cargo's spinner
and crate status throughout a cold build. It now keeps preparation visible and opens the diagnostic log
immediately before launching the TUI host. A private-PTY Gallery run with the change showed build progress
at 52 ms, build completion before alternate-screen entry, and Gallery content at 5.436 s (including host
recompilation). This verifies feedback during a build, not a startup speedup. The CLI integration test
checks startup output and host-diagnostic isolation in ordinary and verbose modes.

## macOS consecutive child appends

Measured on an Apple silicon Mac on 2026-11-09, debug, baseline `36b91689c` versus the
foreign-subview scan fast path. Three runs per size, medians, same Background priority:

| Children | Before wall / CPU (ms) | After wall / CPU (ms) | Wall speedup |
| --- | --- | --- | --- |
| 100 | 41.071 / 40.526 | 12.591 / 12.596 | 3.3x |
| 1,000 | 3031.449 / 2985.785 | 128.552 / 128.141 | 23.6x |
| 8,600 | 215400.935 / 213106.725 | 1142.230 / 1129.177 | 188.6x |

The isolated harness precreates a plain parent and children, then times repeated
`NshView::insert_before(parent, None)` calls on a detached AppKit hierarchy and checks the final
child count. CPU is process user + system time, not utilization. Creation, engine work, layout
and drawing are excluded. Containers with hosted views or identifier-tagged backdrops retain
the conservative scan. This removes redundant sibling scans; it does not establish that all
AppKit mounting work is linear.

The separate `NSH_MOUNT_BENCH_ONLY=1` native integration workload measures initial load to the
native hierarchy. At 8,600 rows it showed no improvement: release 3903.0 → 3960.3 ms, debug
18103.7 → 17985.3 ms (three-run medians). Most initial insertions specify a sibling and do not
use the append path. These are not first-paint timings. GPU/power and engine trace item counts
were not measured; interactive-priority execution was unavailable in this session.

## Windows painter culling

Measured on Windows 11 on 2026-11-13, release, Intel Core Ultra X9 388H, Intel Arc B390 at 60 Hz;
v0.5.0 `f4d68f7f` against the Windows painter culling change (each view culled by its own area
against what the window and the clips of the views around it leave visible, `display: none`
subtrees left out at their top, paint records of left-out subtrees forgotten). `nsh test --fps`
readings once a second, two runs each. The scenario's 1200 × 800 window holds a 1500-row column
that does not clip, two panels of 1000 rows kept mounted with `display: none`, and a clipping
scroll view of 1500 rows, scrolled 3000 points down and back. Fields are milliseconds (mean of
the readings' means; median of the p95s; largest max); CPU is the process' share sampled once a
second.

| Revision | Readings | Paint mean | Paint p95 | Frame mean | Frame p95 | Frame max | CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v0.5.0 | 16 | 4.17 | 4.93 | 3.62 | 4.89 | 7.34 | 21% |
| This change | 16 | 2.71 | 3.58 | 2.33 | 3.57 | 4.45 | 16% |

The two runs of each revision agree within 0.2 ms. fps reads 57–60 on both while scrolling, so
it does not separate them: at 60 Hz this scenario's frames fit either way; the cost per frame
does. The `display: none` part measured alone reads 3.83 / 3.15 (paint / frame mean); the
stale-records part was not measured alone, as what it fixes shows when panels move or shrink
and this scenario moves nothing. CPU differs by −4.5 points between revisions, about one
standard error of its own spread (3–37% within one run): this bench shows no CPU difference
either way; paint and frame times are what it resolves.

## Cross-platform baseline sampler (`bench.py`)

`examples/gallery/tools/bench.py` measures fresh processes from outside, in one versioned format (`nsh-bench/1`,
`<out>.json` plus `<out>.csv`), next to `perf.py` (per-page frame rate through `nsh test`) and `memory.py` (smaps by file):

- `startup --runs 10`: one new process per run; `window_ms` is when the compositor maps a window of the process tree
  (Hyprland), never a test handshake. First presented frame and interactive are `null`: nothing outside the app
  observes them yet.
- `run --rounds 5 --seconds 30 [--action <cmd>]`: process-tree CPU (utime+stime over wall time, 100% = one core) and
  memory (Linux: summed `smaps_rollup` RSS / PSS / USS in MiB, GPU excluded), with the sampler's own CPU reported.
- `size name=path ...`: file or directory bytes.

Every process runs in its own group and is killed with its descendants (SIGTERM, then SIGKILL) after each sample;
timeouts, exits and leaked processes stay in the samples and the summary counts them apart. Tests:
`python3 examples/gallery/tools/bench_test.py`. Compare optimizations with alternating A/B runs on the same machine.
