# Performance

Performance is the project's first priority; the rules are in `AGENTS.md`. Changes to hot paths come with before /
after `nsh test --trace` timings and item counts (`nsh trace` before it, in the records below). Current baselines
(Apple Silicon):

List source publication on the updated pin (macOS Apple Silicon, unoptimized without debug info,
five alternating pairs, `2f971948` → `28c011ed`): counter first/press work stays at 56/10 ops and
49/7 mount items. Gallery `Bench.tsx` stays at 1226 ops / 1029 items initially and 1064 ops /
961 items over a 3000 pt scroll. Full-scroll median core time was 151.91 → 164.81 ms, with ranges
145.23–155.71 / 141.13–169.76 ms; initial core time was 4.73 → 5.21 ms. List-binding prepend
stays at 19 ops / 22 items (median 1.19 → 1.18 ms), while removal changes 7 ops / 9 items to
6 ops / 8 items (0.76 → 0.64 ms). All five pairs preserve the selected row after both splices.
Timing ranges overlap: these traces establish bounded work and ordinary owner retention, not a
latency improvement or production input behavior. The earlier comparison below used another base
and build setup; its timings are not directly comparable with these.

List source publication, release-profile follow-up (macOS Apple Silicon, five alternating pairs,
`2f971948` → `63efd47a`; opt-level 3, fat LTO, one codegen unit): counter initial/press work stays
56/10 ops and 49/7 mount items; gallery initial/3000 pt scroll stays 1226/1064 ops and 1029/961
items. Binding prepend stays 19 ops / 22 items; removal changes 7 ops / 9 items to 6 ops / 8 items.
Every pair retains the selected row after both splices. Core timings below are marginal medians;
paired changes are medians of the five individual ratios, not ratios of the marginal medians.

| Work | Before → after (µs) | Paired change | After slower |
| --- | ---: | ---: | ---: |
| Gallery initialization | 2027 → 2124 | +4.79% | 4/5 |
| Gallery 3000 pt scroll | 37118 → 36263 | -0.83% | 2/5 |
| Binding prepend | 267 → 328 | +14.29% | 3/5 |
| Binding remove | 119 → 139 | +16.81% | 4/5 |

CLI process-tree user+system CPU paired medians are +2.04% (counter, 3/5 higher), +1.48% (gallery,
4/5) and +3.98% (binding, 4/5). They include bundling, the driver and trace output, not isolated
native Host CPU or product FPS. The debug scroll median was +8.49% with 4/5 pairs slower;
overlapping ranges do not exclude a regression. Release does not repeat that sustained-scroll
direction, but initialization and binding costs remain. An initial shared-target cache-reuse
attempt produced identical binaries and was excluded before any measurements; a targeted rebuild
produced distinct binaries. Only the fixed 30 release runs were measured, without added samples.

List source publication (macOS Apple Silicon, debug headless CLI, five alternating pairs against
`36c0fa75`): `nsh test --trace` keeps counter first/press work at 56/10 ops and 49/7 mount items.
Gallery `Bench.tsx` keeps 1226 ops / 1029 items initially and 1064 ops / 961 items over a 3000 pt
scroll. Median core time for the full scroll was 82.30 → 83.19 ms, with overlapping ranges
(74.02–86.05 / 70.57–85.19 ms); initial core time was 5.67 → 5.83 ms. In the core list-binding
compat case, prepending keeps 19 ops / 22 items (median 1.18 → 1.06 ms); removing changes
7 ops / 9 items to 6 ops / 8 items (0.58 → 0.70 ms, overlapping ranges). Both versions retain
the selected row in ordinary insertion/removal. The correction covers a pending bind from the
previous published source after JS has queued another source change; these ordinary traces
establish bounded work, not a general speedup or the frequency of that cross-frame condition.


Span test-id metadata (macOS arm64, debug CLI, three runs per revision against `e02b40f8`):
`echo 'await app.press("Rename ID")' | nsh test crates/nsh-testing/tests/testing/queries/Spans.tsx --trace`.
The first commit stays at 31 ops / 25 mount items / 13 nodes; renaming stays at 1 op / 1 item / 13 nodes.
Rename commit times were 47–208 → 37–79 µs (medians 48 → 64 µs). The regression engine counts
zero additional preparations, measurements and layouts after a metadata update, versus an additional layout
before the fix; the mounted layout is reused, including fitted font sizes, without `onTextLayout`.
The counter control stays at 56 ops / 49 items / 21 nodes initially and 10 ops / 7 items / 24 nodes after `+1`,
matching the item-count baseline below. Its minimum initial / press times were 357 / 181 → 315 / 189 µs.
These noisy single-frame timings establish stable work counts rather than a speedup.


`onMouseMove` (Desktop and web): Linux x86_64, debug CLI, five interleaved runs of
`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx --trace`, against main `fd772aef`.
The first commit stays at 56 ops / 49 mount items / 21 nodes; the press stays at 10 ops / 7 items / 24 nodes.
Minimum first-commit times were 277 → 280 µs, press times 180 → 189 µs (medians 189 → 202 µs for the press).
Cold-start timings varied widely (277–633 µs), so these runs establish unchanged work counts rather than a speedup.
Without mouse listeners, each backend skips the new mouse hit test. Mouse moves share the existing 8 ms hover
coalescing interval, with the latest coordinates kept independently per view and event kind.


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

The gallery's Editor demo at 200 000 lines (its TypeScript sample pasted 3449 times, a macOS window of 1440×900,
release CLI, `--target macos --trace`): the paste's commit 21 → 13.5 ms; a sample pasted into that file 8.4 → 5.7 ms
(1832 items: the gutter measured its digit once per row, an element made again per row for each number); the commit
taking the 6900 problems 12.4 → 7.4 ms (fields read by atom, not through a C string allocated each). The engine's idle
collection walks the whole VM, 30–90 ms with the demo's language server holding the file's model: it ran every second
between the turns of pastes and of the server's slices (21 collections in the run), now only after 0.3 s without a
message or a due timer (7, none between pastes).

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

## Terminal backend

Historical measurements from the terminal backend's Canvas measurement and
geometry-cache changes (not replacements for the release baselines above):

- Linux x86-64, debug, shared engine: the then-current `nsh trace
  examples/counter --taps 1` emitted 49 initial and 8 update mount items
  before and after the Canvas measurement hook. Commit samples were
  394/247 µs before and 525/245 µs after. The current tracing command is
  `nsh test --trace`; see [terminal verification](tui.md#verification).
- In a 160×50 Kitty-protocol PTY, the workbench's Effects-to-deployment
  interaction dropped from over 5 seconds to 195 ms after per-pass
  geometry caching and identity-transform shortcuts.

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

The dev profile builds `quickjs-jit-sys` and `taffy` with `opt-level = 3`, so debug timings are meaningful too; release uses fat LTO.

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

- Tailwind containing blocks, font-relative lengths and intrinsic text sizes (PR #323 follow-up, Linux,
  debug counter trace against `70254f80`): first commit 656 → 674µs, press commit 313 → 312µs;
  both runs produce 56 ops / 49 mount items / 21 nodes initially and 10 ops / 7 mount items / 24 nodes
  after `+1`. Single runs establish unchanged work counts; timings are a smoke check, not a benchmark.
