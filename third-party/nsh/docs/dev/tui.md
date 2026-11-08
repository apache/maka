# The terminal backend (ratatui)

`crates/nsh-platform-tui` renders an NSH surface into a terminal grid with ratatui. Its `AppView` lives on the
embedding app's thread; the app owns the terminal, its event loop and the area given to the surface.
`crates/nsh-tui-host` is the Development host: it fills the terminal with one surface and restores the terminal
when it exits. It loads source bundles directly or connects to the CLI's development server.

```sh
cargo build -p nsh-cli -p nsh-tui-host
./target/debug/nsh run examples/gallery --target tui
./target/debug/nsh run examples/counter --target tui --points-per-cell 8x16
```

The CLI serves and watches the app in its own process. It builds `nsh-tui-host` in a checkout, using the CLI's
profile, and starts it with inherited stdin/stdout. App preparation and host builds show their progress on stderr
until the host is ready to launch. While it runs, CLI diagnostics, the host's stderr and the host logger append
to the app's `.nsh/tui.log`, including verbose tool output. The host alone writes the terminal UI. Ctrl+C copies a selection and otherwise exits;
Unix stop signals and Windows console breaks ask the host loop to exit so its terminal guard can restore the
screen and raw mode before the CLI reaps it.

The host enables [alternate scroll mode (DECSET 1007)](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
with `ESC[?1007h` on entering the alternate screen and disables it with `ESC[?1007l` during normal, error and panic
restoration. With `--no-mouse`, terminals supporting this mode send Up/Down keys for the wheel, which follow the
terminal Key scheme; captured wheel events keep the three-row/six-column behavior below.

On entering, the host also turns on bracketed paste (`?2004`), focus reports (`?1004`, which reach
`AppView::set_focused`), mouse capture (any-event tracking `?1003` with SGR coordinates `?1006`; `--no-mouse`
leaves the mouse to the terminal) and, where the terminal answers its query, the kitty keyboard protocol with
`DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES | REPORT_ALTERNATE_KEYS`, so Ctrl+I, Ctrl+M and Ctrl+[ arrive
apart from Tab, Enter and Esc, repeats and releases are reported, and Super arrives as Cmd
(`TerminalCapabilities::command_key`). The flags are not pushed in Apple Terminal, VS Code's terminal, VTE
terminals (`VTE_VERSION`) or tmux before 3.3, whose answers are not to be relied on. Without the protocol on
macOS, a Ctrl keystroke no app binding matches is matched again as Cmd, so `cmd+` bindings stay reachable.
There the environment's `ctrl_for_command` is set, and labels show such shortcuts with Ctrl, the key to press
(`Keystroke::pressed`: `keymap.label`, `Command`'s hints, the menus' right column).
Every mode is restored on exit, on errors, on a panic and on a stop signal, the kitty flags popped first.
When the terminal reports focus coming back, the host turns bracketed paste, focus reports and mouse capture on
again (another program in the same terminal may have turned them off) and the next frame repaints every Cell;
losing focus cancels a held pointer and a scroll bar drag. The host collects what ratatui writes for a frame
and writes it between frames as one synchronized update (`?2026h` … `?2026l`), so the terminal never shows half
a frame; a frame that changes no Cell (only the cursor commands of the frame before) writes nothing at all. Inside
tmux (`TMUX` set) the markers are written only when tmux reported mode 2026 to DECRQM.
Before drawing, in raw mode, the host writes one query, `OSC 10 ?`, `OSC 11 ?`, `CSI ? u`, DECRQM 2026
(`CSI ? 2026 $ p`) and DA1 (`CSI c`),
and reads the answers for at most 100 ms; DA1's answer, which every terminal gives, ends the wait early. When
stdin or stdout is not a terminal, nothing is queried and startup does not wait. The
default foreground and background (`rgb:RRRR/GGGG/BBBB`, one to four hex digits per channel) fill
`TerminalCapabilities::foreground_color` / `background_color`, and the background's relative luminance (above
0.4 is light) its `background` scheme. The color depth comes from the environment: `COLORTERM=truecolor` or
`24bit` is 24-bit, a `TERM` with `256color` the 256-color palette, anything else the 16 colors;
a non-empty `NO_COLOR` none (`ColorDepth::Monochrome`, before `COLORTERM`); `NSH_TUI_COLORS=truecolor|256|16|mono`
overrides them all. Without colors every color of the frame is reset after drawing (`palette::strip_colors`): a
Cell with a background is reversed, accent text bold.

`C-h e` toggles the logs and errors panel. Escape, `C-g` or `q` closes it; arrows and PageUp/PageDown scroll,
Home/End select the start/end, and `r` reloads the latest build. Errors open the panel automatically and the next
update closes it. Ordinary builds and connection messages stay in the log. With both diagnostics and the performance line closed, the app owns
every row. The panel reads at most 64 KiB from the log tail every 250 ms while open; its recent error history keeps
at most 256 lines of 4096 characters each. Control characters are removed before drawing diagnostics.

A source bundle can also be loaded directly:

```sh
./target/debug/nsh build examples/counter --out .nsh/tui-counter
./target/debug/nsh-tui-host --bundle .nsh/tui-counter/bundle.js --log-file .nsh/tui-counter/host.log
./target/debug/nsh-tui-host --dev-server ws://127.0.0.1:8790/ws
```

`--bundle` reads the adjacent source map and capability metadata. Its `asset:/` resources resolve inside the
adjacent `assets/` directory; connected to a development server (`nsh run`), they are read from the server's
`/assets/`, as on the desktop hosts. Bundled fonts load successfully while text uses the terminal font. An embedding
app can supply its own `AppOptions::assets` reader, which takes precedence over both. Bytecode files require the trusted-resource
or verified-package path, owned by the packaging work. Direct hosts without `--log-file` keep diagnostics in
`nsh-tui-host-<pid>.log` in the system temporary directory, visible through the same panel. `--trace` includes
the engine's timing logs; app `console.log` output is recorded with or without it. `--data-dir` selects persistent
app data. A source-bundle failure exits after terminal restoration; a development session stays open for a fix.

## Interaction

Mobile, the desktops and the terminal are three interaction models, and a component's terminal behavior is
designed for the terminal rather than scaled down from the desktop's. In a terminal nothing stacks, expands on
hover or animates in and out: a notice is one line in a fixed place that the next one replaces, overlays appear
and disappear in one frame, and everything a pointer reveals is also reachable from the keyboard. What terminal
apps (ratatui's, gitui, MS Edit) do is the reference; the desktop look and motion are not. `nsh-base`'s
components branch on `terminal::is_terminal()` for this, so the desktops and mobile keep their own behavior.

The viewport's bottom row is the status line (`crates/nsh-base/src/status_line.rs`): a toast's message and the
tooltip of what the focus or the pointer is on show there, one at a time. The components claim it (`claim`) and draw
it (`line`) through that module, so they share its place and its rule: a toast wins over a hint, and of two claims of a
kind the newer shows.

A pressable mark of one Cell (a trigger's `▾`, a field's clear `×`, a mask toggle, a stepper's `−` / `+`) takes a slot
of three Cells, ` ▾ `, and the whole slot takes the press, so a pointer need not land on the glyph itself. Slots
stand side by side with no gap (` ×  ▾ `); at a band's end the last slot's blank Cell matches the blank Cell before
the band's text. The mark is muted, the accent while its control is focused or open, while it is pressed and while
the pointer is over its slot (its color alone, no band, as a resize handle lights). `nsh-base`'s triggers make them
with `terminal::mark_slot` (`MARK_SLOT` Cells wide; `trigger_marks` places `▾` and the clear at the band's end,
`trigger_marks_width` is the room they take); an app's own mark is a pressable view three Cells wide and
a row high with its glyph centered (the gallery's NumberInput steppers: a Cell inside the band's start, the prefix,
the value at the field's end, its caret's Cell, the suffix as wide as the widest, then the `−` and `+` slots, whose
last blank Cell is the band's end). With `controlsRight`, `NumberInput` sets them side by side in a terminal, the
decrement first.

Tab always moves the focus on in a terminal: a component that takes Tab for itself elsewhere (a `DataTable`'s Tab
moving its selection, as gpui-component's) leaves it to the focus there and moves with the arrows.

A primary press gives the focus to what it went down on as it comes up (while it is held the view shows the press):
the focusable view under the pointer, or the nearest one around it (a card around the text pressed), and Tab goes
on from there, as in MS Edit or lazygit. A press on nothing Tab
stops at leaves a field and keeps the focus elsewhere where it is (`Keyboard::pressed_stop`; the headless driver
does the same in the terminal idiom). The desktops keep theirs: a click on a button there gives it no focus.

## Performance monitor and frame budget

```sh
./target/debug/nsh run examples/gallery --target tui --fps
cargo test --release -p nsh-tui-host --test host bench_terminal_scroll -- --ignored --nocapture --test-threads=1
```

`--fps` enables a single line at the top right; `C-h p` toggles it beside `C-h e`. These prefixes apply outside
editable fields and inside diagnostics; a field keeps C-h as Backspace. The line shows active FPS (`idle` after
a second with no app frames), mean frame time and p95, mean apply / draw / flush milliseconds, and mean bytes
and changed Cells per frame. It logs the same line through `nsh::perf`, visible in `C-h e`. Long lines clip to
the terminal width. The readings update once a second while active, with one final idle update; HUD-only
refreshes never count as app frames and idle monitoring schedules no recurring draws.

`perf.rs` retains 120 application frames. Apply includes draining pending work, callbacks, scroll reports and native animation evaluation;
draw includes surface painting and focus reconciliation; flush includes ratatui's diff, encoding and the
writer's flush. HUD formatting is outside those phases. Cells count the backend's actual diff iterator, including
wide-character handling; bytes count successful writer output, including ANSI escapes. Output means include
the HUD when it is part of an app frame. An uninstrumented transport displays `-` for its unknown counters.
`PerfMonitor` supplies the active FPS and engine timings (its four cold frames are skipped for FPS); the
terminal phase history includes every app frame. The budget and baseline are in [Performance](performance.md#terminal-frame-budget).
Changes to terminal rendering, input or layout include before / after benchmark numbers and trace counts.

For a full-terminal embedder, enable `AppOptions::fps` or call `AppView::set_fps_monitor(bool)`, wrap the
writer with `view.measure_writer(writer)` and the backend with `view.measure_backend(backend)`, then draw with
`view.draw_terminal(&mut terminal)` (as `run_app` does). The adapters remain pass-through while the monitor is
hidden: no timers, clock reads, history, diff scans or output counting are added on that path. `frame_metrics()`
returns the last completed frame's `FrameMetrics`; `perf_monitor()` exposes the shared engine monitor for tools.
Disabling drops the monitor and detaches it from the engine; enabling starts a fresh history. Ordinary `render`
and Widget embedding keep the same layout API; full transport timings require `draw_terminal`.

## Terminal lifetime and idle waits

On Unix, SIGHUP, SIGTERM and SIGINT request shutdown. The host checks the flag before and after input waits
and while waiting for a full output queue. A disconnected stdin/stdout (`POLLHUP`, `POLLERR`, `POLLNVAL`),
loss of the input TTY, or a read/write error ends the run loop. On macOS, select readiness plus an empty
input queue also detects EOF on PTYs whose poll does not report HUP. The check consumes no input. Interactive runs require a live terminal on
stdin; `--headless` continues to accept redirected or closed input.

The Unix session saves the descriptor flags and enables nonblocking input/output. It uses crossterm 0.29's
`use-dev-tty` reader: its EOF/error path returns to the bounded poll, whereas the default mio reader can keep
reading zero bytes or EIO forever, never returning to the host's signal check. The event parsing and conversion
remain crossterm's. On non-macOS Unix, the reader's millisecond poll truncation can spin over a fractional
millisecond; decoding is capped at 50 microseconds and `run_app` sleeps the remainder of its 16 ms wait.
On macOS the reader uses select with microsecond waits. Every Unix decode poll gets at least 50 microseconds,
including when another frame is already due: crossterm's `use-dev-tty` reader skips its input and parser queue
entirely at zero timeout. Continuous frames therefore retain an input opportunity between draws. Neither path
retries a failed host poll.

Terminal and OSC 52 writes share the cancellable output path, with buffered frame encoding. Output backpressure
waits for writability in 16 ms slices and checks shutdown between waits; errors propagate. Once the loop ends,
writer destructors stop writing. The session attempts mouse/alternate-screen/cursor restoration with nonblocking
writes, discards undeliverable queued output if that write would block (macOS can otherwise wait in process
teardown), restores raw-mode settings, then restores the original descriptor flags. Cleanup does not wait for a
hung-up or full output queue. Signals do only an atomic store; cleanup runs on the host thread.

`run_app` honors the remainder of a poll that returns `Idle` early, capped by the next frame deadline, so
spurious wakeups do not turn into a busy loop. Engine wakeups coalesce until rendering, animation deadlines are
consumed by a frame, and the performance HUD stops scheduling after its idle update. Pending work still has an
immediate deadline. The maximum sleep remains 16 ms; headless hosts use the same loop and sleep contract.

The host integration binary has private-PTY regressions for each stop signal, partial input, hangup with and
without a controlling terminal, closed stdin, and shutdown with a full output queue. The default parallel
runner starts each lifecycle scenario in a separate copy of that test binary, selecting only that scenario.
Each worker has a new session, no controlling terminal, null input and a private log. Each host then gets its
own new session and PTY; inherited signal masks and ignored termination/job-control signals are reset before
exec. The test process never changes its own session, terminal or signal handlers.

The worker opens PTYs and launches hosts sequentially within its scenario, so parallel scenarios share neither
PTY descriptors nor fork-time descriptor setup. The retained probe opens the slave independently, with
`O_NOCTTY | O_NONBLOCK`: host restoration cannot change the probe's blocking mode. Reads drain a bounded batch,
fill writes have a one-second deadline, and cleanup closes the master, kills the owned child and polls for
reaping with a one-second bound rather than blocking in `wait()`.

Exit is still required within one second of a signal or hangup. Startup has a separate ten-second deadline.
A 45-second worker watchdog covers the whole scenario, kills and reaps its registered hosts, then ends the
worker if the scenario stops making progress. The parallel runner also enforces a 50-second worker limit.
Deliberately blocked and panicking scenarios verify that cleanup leaves no live host. Fixtures and captured
stderr belong to the scenario's private directory and are removed even when its worker times out.

Restoration is inspected on a non-controlling PTY, which remains queryable after child exit; kernel `PENDIN`
bookkeeping is excluded from the termios comparison. Workers validate session/process-group identity and retain
host stderr in failure messages. Their successful output, including benchmark readings, is forwarded to the
outer test so `--nocapture` retains its usual meaning.

Use each worktree's own default `target` directory. The suite itself uses the default parallel runner:

```sh
cargo test -p nsh-tui-host
cargo test --release -p nsh-tui-host --test host bench_terminal_ -- --ignored --nocapture --test-threads=1
```

See [idle CPU measurement](performance.md#terminal-idle-cpu) for the sample window and pending results.

## Development sessions

Feature `dev` adds `AppView::connect_dev_server`. The shared `nsh-dev::DevClient` reports `HostPlatform::Tui`,
bytecode compatibility and the linked UI sets, reconnects on disconnect and queues ordered events for the
embedding thread. Rendering processes those events. Full bundles carry their source map, app ID, declared
capabilities, development policy and VM limits. A patch applies only to its `(session, base)` through
`EngineControl::hot_update`; its following full bundle becomes the reload target without restarting the app.
The existing hot-runtime rules determine which signals and component instances survive an edit (see
[tooling](tooling.md#dev-server-nsh-dev--nsh-run)). A rejected patch reloads its matching full bundle, whether
that bundle arrived before or after the rejection. Build failures, incompatible UI sets and structured app
errors appear in the dismissible panel. Public `load` and `stop` disconnect the dev client; internal development
reloads replace only the engine and retained tree.

Apps with their own Rust UI sets get a generated `tui-host` in `.nsh/rust`, using `main_with_options` to pass
registries and an optional Rust root. Rust roots use the development server's `Root` message; Rust edits use the
CLI's existing rebuild/restart path. Embedders may select a diagnostic file with `AppView::set_dev_log_path`.
The library neither installs a logger nor takes over terminal streams.

## Platform tests and Cell screenshots

`nsh test --target tui` runs the existing `nsh/test` files through the Development host. The CLI starts it with
`--headless`, selecting ratatui's `TestBackend` before any terminal session is initialized. It uses the same
`run_app`, `AppView`, engine, renderer and input path as an interactive run. Standard input may be closed; raw mode,
alternate-screen setup, terminal queries and crossterm polling are never entered on this path. The host's
`--window-size WIDTHxHEIGHT` is in points, rounded up to whole Cells. `open` supplies 390 × 844 points by default
(49 × 53 Cells at 8 × 16); a directly started headless host defaults to 100 × 40 Cells. Tests use the app's
`nsh.json` `tui.pointsPerCell` setting when present.

Feature `dev` links `nsh_testing::agent`. Its `Tester` consumes test protocol events on the dev-client thread.
Model attachment and bundles share one ordered inbox: `Model::set_up_engine` runs before startup and
`Model::engine_started` receives the resulting control. Completed mount batches and app errors feed the Model;
storage, network routes, clipboard, environment pins and manual clocks use the shared agent's setup.

The private `TuiNative` posts requests to the view and wakes it. Rendering applies complete batches, draws, then
services requests; a screenshot serializes that completed buffer. Input requests call `AppView::handle`, exactly
as the host's terminal input does. Pointer coordinates convert from content-relative points to absolute Cells,
including the embedding area's origin. `Native::bounds` uses the renderer's unclipped Cell geometry, including
absolute edge rounding, transforms and scroll offsets. Mounted controls outside a Scroll keep their bounds,
including negative coordinates above its viewport, so the shared agent can scroll them into view before pressing.
Concealed or hidden views have no rendered geometry. Pointer input still uses clipped hit regions, and text-span
bounds describe visible characters. The agent drives press/release, motion, wheel events, individual keys and
bracketed paste. Scroll requests are quantized to the same three-row/six-column wheel steps as real input. Their behavior
is the platform's current input implementation: this adapter does not emulate missing input features. Richer pointer/scroll behavior and system dialogs are supplied by their respective platform tickets.
Fields use the same editor for real keys, synthetic keys and bracketed paste.
`setViewport` currently returns an error; select the initial viewport with `open(entry, { width, height })`.

`app.screenshot(path?)` returns bytes and optionally writes them on the test machine, through the existing
base64 screenshot transport. On the terminal target those bytes are UTF-8 JSON (use a `.json` path):

```json
{"format":"nsh-tui-cells","version":1,"width":1,"height":1,"rows":[[{"symbol":"A","fg":"blue","bg":"reset","underline":"reset","modifiers":["bold"]}]]}
```

`rows[y][x]` is one Cell, including blank Cells and the trailing Cells of wide symbols. Width and height count
Cells in the rendered surface. `symbol` preserves the Cell's entire string. Colors are `reset`, lowercase
ratatui named colors (`black`, `darkgray`, `lightred`, etc.), `#rrggbb`, or `indexed:N`. Modifiers are ordered:
`bold`, `dim`, `italic`, `underlined`, `slow_blink`, `rapid_blink`, `reversed`, `hidden`, `crossed_out`, with only
active entries present. Screenshots contain no timing or terminal escape framing, so identical renders compare
byte for byte. Graphical targets continue to return PNG bytes.

```ts
const picture = JSON.parse(new TextDecoder().decode(await app.screenshot()));
expect(picture.rows[0][0].symbol).toBe("A");
```

## The example app

The terminal's demo is the official `examples/gallery`, the same code every platform runs, so a page can be
compared side by side with the others. Its layout and colors' meanings are the gallery's own
(`examples/nsh-gallery-ui`); the terminal backend draws them at the terminal's color depth (Drawing below).

```sh
./target/debug/nsh run examples/gallery --target tui
./target/debug/nsh build examples/gallery --out .nsh/gallery
./target/debug/nsh-tui-host --bundle .nsh/gallery/bundle.js
```

## Architecture

- **The core lays out in points.** Taffy places each view. The backend projects its frame to Cells using the
  rounding rule below; child frames, content boxes, drawing and hit testing share that projection. Text is measured
  on the grid on the engine thread. Changing the area passed to `render` sends the new viewport and environment
  to the engine. An app loaded before the surface's first draw shows from the engine's layout at the drawn area
  on, never laid out for a surface with no size.
- **One engine per surface.** `app.rs` owns the public lifecycle and configuration. `surface.rs` carries complete
  `MountBatch` messages, structured errors and frame requests over a channel. Only rendering drains the inbox;
  `mount.rs` applies a whole batch before callbacks, drawing or input can observe it. Replacing or stopping an
  app drops its engine and inbox, so messages from the previous app cannot reach the next one.
- **One retained view per node.** `view.rs` stores tree links, point frames, styles, props, events and laid-out
  text, indexed by node id. `render.rs` walks children in paint order, propagating clipping, visibility, opacity
  and pointer policy, and paints each view's fill, borders, text and content into the buffer Cell by Cell,
  keeping every Cell's resolved colors so translucent layers blend (Drawing below).
- **Input belongs to the embedder.** `Input` is independent of a terminal backend. Mouse positions are absolute
  terminal Cells; `handle` localizes them against the last rendered area, follows the painted hit regions and
  uses the core's `input::Press` to deliver PressDown, PressUp and Press. Releasing outside the area cancels the
  press and returns `Handled::Ignored`. Unused keys and pastes are ignored. `set_focused` lets an embedder remove
  keyboard focus and cancel a pending press.
- **Scheduling is passive.** The wake callback only schedules a render on the embedding thread. Wakeups coalesce
  until rendering begins. `next_frame_deadline` is immediate for pending messages, timed for an engine display
  frame request or native animation, and `None` while idle. Error and appearance callbacks run during render on the embedding thread.
  `Widget for &mut AppView` follows the same batch and drawing path for buffer-only callers.
- **The terminal transport stays in the host.** The library depends on `ratatui-core` 0.1 and `ratatui-widgets`
  0.3, the crates behind ratatui 0.30. Feature `run-app` adds a generic loop over `Terminal<B>` and a polling
  callback; it uses only public `AppView` methods. The host supplies `ratatui-crossterm`, event conversion, raw
  mode, the alternate screen, the terminal modes and queries above, and the cursor's shape: it writes
  `CSI 6 SP q` (a steady bar) when `AppView::on_cursor_style_changed` reports `CursorStyle::Bar`, while a field
  is edited, and `CSI 0 SP q` (the user's own shape) when it reports `Default` and on restoration. Since crossterm polling cannot be woken by the engine, the loop
  polls at most 16 ms at a time; idle polls draw no frames. An RAII guard restores terminal state on normal and
  error returns; a panic hook restores it before printing the panic. Forced termination cannot run that guard.

`AppOptions` supplies the point scale, appearance/background, limits, UI sets, cache, storage, assets, clipboard
and host channel. `TerminalCapabilities` carries the terminal's background scheme, its default background and
foreground colors and its color depth (`ColorDepth`); the standalone host fills them from its startup query. Embedding defaults to bounded limits; the Development host explicitly selects standalone limits.
`register_component` creates per-node widgets with ordered property updates, commands and buffer rendering;
reserved `nsh/` names are rejected. Native component input, sizing and richer context belong to the native
component ticket. The Release runner is a separate slice.

The surface reports the Terminal idiom (`Idiom::Terminal`, `platform.idiom` `"terminal"`) and the machine's
operating system (macOS, Windows or Linux), as the desktop development hosts report theirs, so `fs/promises` and
`process` run under the app's declared capabilities and `platform.os` names the real system. The terminal is a form
of device, as the phone, pad and desktop are, so it is an idiom rather than a flag beside one: an app that lays out
for Cells asks the one question it asks for every other device form, and the OS stays free to say which system it
runs on. Desktop behavior applies to the idiom on any OS (`Idiom::desktop_on`): keyboard shortcuts, hover,
tooltips, context menus, `desktop={{…}}` props and `platform.select`'s `desktop` key. `nsh/desktop`'s
`isAvailable` follows the OS, so an app that draws its own window chrome there (the gallery's `TitleBar`) draws it
in the terminal too, as the app's own content, until it leaves it out for `platform.idiom === "terminal"`. Code
that tests `platform.idiom === "desktop"` for a pointer or a wide layout no longer matches in the terminal; apps
choose what the terminal gets from the idiom.

## Points per Cell

One **Cell** is **8 × 16 points** by default. These are layout units, independent of the terminal font's physical
pixel dimensions. `CellSize::new` accepts finite, positive typed dimensions; the same value is used for the text
engine, viewport, drawing and input. `nsh run --target tui --points-per-cell 10x20` overrides the app setting:

```json
{ "tui": { "pointsPerCell": "10x20" } }
```

The CLI option wins over `nsh.json`; the default is `8x16`. Both dimensions must be finite and positive.
The development host takes the same `--points-per-cell WIDTHxHEIGHT` option. The selection is made when the
session starts; restart the run after changing this setting.

In the terminal idiom the core lays out with its terminal algorithm (`docs/dev/styles.md` "Layout in a terminal"),
so view frames arrive in whole Cells and a container's border takes exactly one Cell on its side. The painter divides frames by the Cell size; where a frame
is still off the grid (a transform's translation, a scroll offset), each edge rounds from its absolute point
coordinate with **round-half-up**, `floor(points / points_per_cell + 0.5)`, a tie going toward positive
coordinates. The embedding area's integer Cell origin is added after conversion. `geometry::CellBounds` is the
common boundary for view frames and content boxes; input content boxes follow the same rule as text content
boxes. The painter records each view's Cells (`render::Geometry`: clipped `visible`, unclipped `bounds`) and the
views that take the pointer (`render::Hit`) for input, focus, search and the test agent.

In a row, controls read as words: two blank columns between their texts (a checkbox and its label), one beside a
mark of one column (a field's `×` and `▾`, and what follows them), none between two marks alone in their box (a
stepper's `▴▾`); a mark's slot (a control of no fill and no words, three Cells or more wide, its mark in the middle)
has a blank column of its own each side, so slots of a mark touch (` ×  ▾ `). A box that shows nothing in flow (a field's
prefix holding only its focus ring) keeps none of its margins (`shows_nothing`).

`CellTextEngine` counts Unicode display width: wide characters take two Cells and grapheme clusters stay whole.
Ordinary text occupies one row at any font size. Inline attachments reserve their width in whole Cells
and grow the line to hold their height; baseline, text-top, text-bottom and middle alignment use Cell font metrics.
Their child views draw and receive input in the reserved space, and attachments removed by truncation stay hidden.
Wrapping prefers spaces after content, then breaks inside a word. Leading indentation stays with the first part
of the word instead of becoming a separate whitespace-only row. Explicit newlines
preserve empty rows. A grapheme wider than the available line remains whole and is clipped by drawing.
`numberOfLines` limits the rows; tail, head and middle ellipses reserve one Cell, while clip adds no marker.
Alignment becomes a whole-Cell indent. Line geometry reports UTF-16 offsets and point dimensions, as the core's
`TextEngine` contract requires. Custom font registration succeeds with the terminal font remaining in use.

## Drawing

`render.rs` draws the retained view tree in the terminal's own look, as terminal apps such as grok-build look:
the user's terminal theme gives the colors, depth comes from steps of the terminal's own background, and
box-drawing lines and bold give the rest of the structure and state. The app's design tokens reach its views
through the core, which resolves them into the styles it sends; `Command::Tokens`, which colors other platforms'
own controls (Linux's menus, mobile alerts), changes nothing here: the terminal's own controls (menus, the menu
bar, system dialogs, the focus) keep the terminal theme's colors.

**Two looks.** A terminal whose background is known (OSC 11, `TerminalCapabilities::background_color`) and that
shows 256 colors or more has **surfaces** (`palette::Ramp`): steps of its background mixed toward its foreground
(OSC 10, else white or black against the background), quantized to the xterm palette at 256 colors. The
terminal's own background (`Color::Reset`) is never painted, so its color and transparency stay:

| Step | Mix | Used for |
|---|---|---|
| base | 0 | the page, a modal's box |
| sunken | 3% | a fill darker than its ground, a focused text field without a line |
| raised | 7% | a fill lighter than its ground, anchored overlays (one step above the ground's step) |
| hover | 11% | a hovered control |
| select | 16% | selected rows, focused and pressed controls |
| border | 22% | box lines |
| popup line | 45% | a popover's or menu's line |
| faint / muted | 35% / 50% | disabled text, placeholders / secondary text |
| focus line | 40% | a focused field's or container's line |

Elsewhere (a 16-color terminal, an unknown background) the look is **bandless**: no ramp of bands, dim secondary
text and lines, reverse video for selection, as described with each rule below. Focus is reverse video in the accent
(reversed and underlined without colors), so it is never mistaken for a selection; a hover is the standard dark
gray band at 16 colors, on controls only and with its text undimmed; a text field without its line is underlined
along its last row, the row reversed in the accent while it has the focus; where dim is the only gray (16 colors,
none) a disabled control's label is also struck through, so it is told from muted text; and there a small box of
a tone (a price tag, a meter's filled segment: a saturated fill under three rows) is reversed in its color, as a
progress bar's fill is. A filled box is still a surface (the layout is the same at every depth: its fill, no
line), so a small one (under three rows: a chip, a tag, a button) keeps an edge in the standard colors
(`palette::bandless_fill`): a tone fill (a primary button, a badge) in its color at the depth, any other fill (a
chip) the standard dark gray, a glyph in the fill's own color taking the default foreground; without colors a small
one holding text is reversed. A panel or a card of three rows or more is left unfilled, set apart by its space,
its lines and scroll bars: one gray across a sidebar would put each muted label on a patch of its own. An
overlay's own box is its frame at every depth, and a field keeps its underline.
The app's design decides what is there and where it is; it is not reproduced Cell by
Cell. Views draw in tree order (the core orders siblings by `zIndex`), modals after the root, and each view
draws, in order:

1. when it is the first surface (a border or a fill) of an overlay: its box cleared of what is under it; with
   surfaces an anchored overlay's box is then raised and a modal's stays base;
2. with surfaces, its fill as a band over its whole frame (below). A face is a line or a fill, never both: a
   filled box has no border Cells, at every color depth (the layout never depends on it: at 16 colors the box is
   laid out as with surfaces, a small one's fill in the standard colors), and a fill inside a frame (an
   inset palette in a padded card) is laid out against the frame's line, across its padding (`band_reach`), its
   rows' text in the column where the frame's other content (a caption under it) starts. A popup's panel (the
   first face in an anchored overlay: a popover, a hover card, a menu, a tooltip; the overlay itself when the app
   styles it, as a select's popup, and then nothing in it is a panel) keeps a column each side and no rows, filled
   or framed from 4pt (`popup_panel`); its rows (a menu's items, a list's options, a palette's commands) reach its
   line across that padding whether filled now or not, so a hover's band runs line to line, and keep at least that
   padding inside, so their text starts where the panel's other content (a group's title, a search field) does. A
   list's cells are its rows: the list, or the scroll view around it, reaches the line and keeps none, and each
   cell, laid out apart, keeps what its list reached across (`rows_reach`), which the row in it (an option)
   reaches across in turn. A popup is its line at every depth of color: its frame takes a Cell
   around its panel (`Core::framed_box`), and the app's fill of the panel is the popup itself, not painted again;
3. its borders in box drawing on each side wider than zero, one Cell whatever the width: `─` and `│`, `╭╮╰╯` at
   a corner whose radius is above zero and `┌┐└┘` at a square one, dashed `╌╎`, dotted `┈┊`; a border on one
   side only is that side's line. Borders draw only where the layout gave them a Cell: in a terminal the core
   sends a border width only for those sides (`Node::cell_border`), which only cards have (a container with
   vertical padding of 12 points or two rows of content). A control (a button, link, tab, menu item, option,
   checkbox, radio, switch, slider, combobox, text field or other pressable view) is its label row, a box of
   text and a small box have none, nor has a group of controls (a split button, a toolbar: controls, the dividers
   between them and wrappers of one control, such as a menu's trigger in its view), filled or not, with bands or
   without (`controls_group`); a tab's indicator bar takes no Cells, and the selected tab is a reversed
   band instead;
4. its content: text runs (below); a text field; a canvas (below; icon-sized ones take no Cells); a native
   component's terminal rendering; a control whose content is all left out (an icon button such as a `⋯` menu
   trigger) shows its accessibility label, trimmed, as its label: the layout gives it one row that wide, or narrower (at
   least three Cells) when its row is short of room, the label then cut and ending in `…`; an icon-only popup
   trigger (a split button's chevron, a menu's: `accessibilityState.hasPopup`) shows `▾` instead, `▴` while its popup
   is open, an icon-only disclosure `▸`, `▾` while open. A disclosure with a label (an `expanded` pressable without
   `hasPopup`: a collapsible's trigger) gets `▸` / `▾` two Cells before its label's first glyph (one when only one is
   free), muted, the accent while focused, unless its label starts with one (`nsh-base`'s accordion and tree rows
   draw their own); only a popup's trigger stands raised while open. Content counts only when
   it draws: a wrapper around an icon the terminal leaves out is empty;
5. its children, offset by a scroll view's offset (and sticky cells' shifts), clipped to the view's content box
   (inside its border) when it clips, scrolls or has a border; an anchored overlay is clipped only to the surface;
6. a scroll view's scroll bar (`scrollbar.rs`);
7. its state (below), over what it and its children drew.

**Fills** are steps with surfaces (`palette::surface`): a fill of alpha 0.03 or more that is saturated (its own
color, however translucent: an accent wash over a selected row) or, blended over its ground, 1.5 L* lighter or
darker than the ground, is a band over the view's whole frame, behind its children; a text without a background
of its own paints none. The app's page color (an opaque fill over the whole screen with nothing filled above it)
is the terminal's background: no band, and the ground the steps below it are taken from. Lighter is
raised, one step above its ground's step (a fill inside a raised card is lighter still); darker is sunken; a fill
never takes the step around its ground (a bar filled out of a sunken track goes a step past the box around it); a
saturated fill (a primary button, a badge) is its color mixed 20% into the step under it, its text the accent of
its hue (the default foreground when the app's text is light), bold on a control under three rows tall (a
pressable container's text keeps its weights). A filled view has no line:
its band is its edge, unless the app's border is hued or stands out at least twice as far from the ground as the
fill does, or the box is framed with corners (a one-time code's cell): the terminal layout decides, and the painter
draws every side it gave a width. A dot (a round box of a hued fill, holding no text, that the layout pins to one
Cell: an avatar's presence dot) is `●` in its fill's color over what is under it, no band of its own. A view in the image role is a swatch of its color (the terminal draws no images, so the role is free to
mean that): with surfaces its fill is its own color blended over its ground, at the terminal's depth
(truecolor, else the nearest of 256 or 16), never a step, and its text is black or white, whichever reads on it
(`palette::swatch`, `palette::swatch_text`); bandless it is its color at the depth (`palette::bandless_fill`). A color picker's swatches and
the Cells of its tracks are such views, inside the control that takes the press, so hover and focus bands leave
the color alone. A run with its own background (a
highlight, inline code) is a band the same way. A text field without a
line or a fill of its own is a raised band (a search field); an input group, a one-row box of an opaque fill
holding a field with something beside it (a prefix or suffix, chips, a clear button, a chevron), is that band as
a whole, the field raised with it rather than a step of its own (`input_group`). Bandless, a fill is the standard
colors' (above).

A view's gradient over no fill of its own is a fill of its first stop, a band as any fill is.

**Nothing is drawn** for radii other than a border's corners, shadows,
outlines and focus rings, opacity, filters, blend modes, backdrop effects, transforms other than translation
(rounded to Cells), icons, images, videos, web views and native views without a terminal rendering: the
terminal cannot show them well, so they are left out rather than imitated (the core gives icon-sized images, videos,
web views, shaders and canvases no Cells; larger ones keep their box, which the painter leaves blank, fill included,
so the labels around them keep their places; the mounter logs each unsupported kind once). A view that is invisible, concealed (a screen under the top one)
or nearly transparent (opacity under 0.03) draws nothing. Cells keep the terminal's default foreground and
background (`Color::Reset`) unless something below sets them.

**Colors** are meanings, not values (`palette.rs`). Each app color is read against its ground, the opaque fill
the app drew it on (what the app designed it against), else the page of the appearance (black when dark, white
when light), its alpha first blended over that ground:

- a saturated color (chroma at least 20%) is the accent of its hue band at normal intensity: red, yellow (orange,
  amber), green (lime, emerald), cyan (teal), blue (violet) or magenta (purple, pink);
- a near-neutral color is the default foreground, muted when its lightness is within 75 L* of the ground's
  (secondary text, separators) and faint within 35 L* (placeholders): with surfaces those are fades of the
  ramp (50% and 35%), bandless both are dim; never a gray of the palette, which themes set without regard to
  contrast. Black (the core's default text color) and colors within 4 L* of the page's foreground are always
  the default foreground, so unstyled text reads on dark and light terminals alike;
- a fully transparent color hides what it draws.

A neutral border is the ramp's border step with surfaces, dim bandless; a border in an accent keeps it. The color depth matters only for canvases, whose
pictures keep their colors at the terminal's `ColorDepth` (true color, the nearest xterm 256-color cube or gray
ramp entry, or the nearest of the 16 standard colors). A view's opacity changes no color.

**Text** keeps its weight (bold from 600), italic, underline and strike-through; its color is the meaning of the
run's color. A run with its own accent background (a highlight) is reversed in that accent; other run backgrounds
draw nothing.

**State** comes from the view's interaction states and accessibility state, not from the app's state styles.
With surfaces (`render::mark_surface`) states are bands and bold; a band replaces only the Cells on the view's
own background, so what its children filled stays, and it is at least one step above the view's own:

- a selected or current item (a toggle that is on included) is a select band and bold, never the accent; one
  whose every glyph is in a hue of the app's (a pagination's current dot in the accent) is only bold, its color
  telling it apart already; a
  focused control (a button, a row, a tab) is the accent band, its text in the terminal's background color, bold
  when it is also selected, so focus is the accent and on or chosen a gray step wherever they meet; a focused
  container three or more rows tall shows its line in the focus color (without a line, a hover band and an accent
`▎` rail down its leading column); a focused
  text field shows its line in the focus color and the caret; one whose box has no room for its line (one row tall)
  is a hover band with an accent underline along its row instead, a step alone being too faint to find; a framed box of any
  size (a one-time code's cell) shows focus with its line alone; a focused control whose Cells are all its
  children's fills (a swatch's color, a chip's own fill, a pagination's bar) or that holds no glyph shows it as an
  accent underline under its Cells, its fills kept (a swatch, all fill and no glyph, underlined in the color its
  check takes, which reads on any fill, the accent's own blue included);
- a tab is bold when selected or focused and muted otherwise; a selected tab is a select band, unless the app
  underlines its label (an underlined tab strip keeps the underline alone); a focused tab is the accent band, a
  pressed or hovered one banded (select, hover);
- a hovered pressable view is a hover band, a pressed one a select band;
- an interactive view drawn in lines or marks alone, no letter or digit (a resize handle's `│` or `─`), shows
  its states in its foreground alone: hovered, held, dragged or focused, the same glyphs turn the accent on the
  ground they rest on, with no band under them and no weight, as a terminal's split line lights;
- in a popup (an anchored overlay: a menu, a select or combobox list, a command palette) the highlighted item,
  the keyboard's (the item the list projects as focused, which the sink opts into as `MountItem::ProjectStates`:
  `MountSink::needs_projected_states`; the view keeps them apart from the states it reports, so they never go
  back to the core) or the pointer's, is a full-row accent band, its text in
  the terminal's background color; a selected item that is not highlighted keeps the select band;
- the item a list outside a popup highlights for the keys (a command's inline list, a palette in a dialog) is the
  same full-row accent band inside a dialog or the pane holding the focus, so two lists never band at once;
- the selected row of a list or tree inside the pane holding the focus (the innermost box with a line around the
  focused view, or the overlay holding it) is the same accent band, as lazygit's: the list the keys go to; the
  same selection in another pane keeps the select band; a pressable control that is on (a toolbar's toggle) is
  not a row and keeps the select band there too; a selected control covered by its children's fills
  (the chosen swatch) keeps its fill, and one with no glyph shows a `✓` in its middle, black on a light fill and
  white on a dark one (`palette::mark_on`), focused or not;
- a trigger whose popup or menu is open (`expanded`) stands on a raised band;
- an `adjustable` view (a slider's track, a resize handle's line) shows focus its own way and takes no focus
  marks; a slider's thumb `●` and a color area's picked Cell `◆` are reversed while it has the focus;
- a divider (a row of `─` alone, as a menu's separator draws, or a resize handle's column of `│`) is a line of
  the box it splits: in the frame's color (a popup's line color in a popup), lit only in its accent, its box's
  fill (the app's line color on a hairline) no band; where it ends on another line (a frame's side, another
  divider) the two are joined, `├ ┤ ┬ ┴ ┼` (`render::join_lines`), and so are the ends of a box's lone line across
  (a search field's rule under it, a footer's over it), in a modal too;
- a framed box that is itself the focused stop, or the part showing its control's focus (a one-time code's next
  cell), shows its line in the accent (blue), bold: the line glyphs of the sides that draw one, never a text on
  the box's row (a sidebar's first row under only its right line); so does a pane holding the focus, the
  innermost framed box around it whose own content holds a scroll view or a selected item (lazygit's: the keys
  go to its rows); any other box holding the focus (a card around a focused button, a menu bar's) keeps its
  line as it rests, and a focused overlay's title, and a system dialog's, is an accent chip;
- a disabled view is faint, never bold, with no band; a glyph already fainter than faint (a box's resting line)
  goes a step nearer the background still, so disabling never brightens a glyph and always shows.

Bandless:

- a selected or current item (`selected`, `current`, a toggle pressed, a checked menu item) is a reversed band
  over its whole inner box; checkboxes, radios and switches show their state in their own glyphs;
- a focused view reverses its label, the Cells of each row from its first to its last glyph; inside a band the
  label is bold and underlined instead; a container three or more rows tall shows focus on its border (bold,
  not dim) or, without one, as a bold underlined label; a focused text field underlines its text and shows the
  terminal cursor as its caret (its placeholder is always dim);
- a hovered pressable view (a button, link, menu item, option, tab or a view with a press handler) is a faint
  band behind its box: the terminal's background (OSC 11, else black or white by the scheme) mixed 10% toward
  its foreground (OSC 10, else white or black), at the terminal's depth; a pressed one is the same band at 18%.
  Modifiers stay as they are. With only the 16 standard colors there is no hover band, and a pressed view
  reverses its label;
- a control under three rows tall whose own opaque fill stands out from what it is on (a saturated fill, or one
  40 L* from its ground: a primary button) shows its text bold, in the fill's accent when it has one; the fill itself is not
  drawn;
- a disabled view is dim and never bold.

**Overlays**: an anchored overlay (a popover, menu, tooltip) or a modal is its line alone, the same at every
depth, as ratatui's `Clear` and `Block`: its box is cleared to the page's background, whatever the app filled it
with (a box is its line or its fill), and framed with a rounded line in the border step (dim bandless); the
line's Cells are cleared as the box's are, so nothing of the page (a band, a fill, a field) shows beside the line
or inside it, and nothing is drawn around it (no shadow).
The accessibility label of its first surface is the title in the top border, bold, set off by the line with
surfaces (`╭─ Title ─`). Inside it a menu's highlighted row is still a band across the inner width. A box without a border of its own gets the
frame one Cell outside it; so does a popup holding a list or menu with no box of the app's, its own box,
and the layout keeps the frame's Cells (`Core::framed_box`), moving an unanchored box in from the screen's edge so
its frame shows (a popover by the screen's edge); a box across the whole screen (a bottom sheet as wide as it, a drawer as
tall) stays docked to the edge it is flush with, its frame's side there off the screen (`Core::framed_within`). A
dropdown's list (a select's, a combobox's, a date picker's calendar: `popup::dropdown`) is at least as wide as its
trigger less two Cells, so its frame, lines included, runs from the trigger's first column to its last, whichever edge the
app aligns it on. A word behind the box that it or its frame cuts is
left out whole, no half of it glued to the frame; a run longer than 12 Cells (a URL, a path) keeps the part that
shows, ending in `…` by the frame. A fill the frame cuts goes with its words the same way when it is one row of a
band of its own up to 12 Cells past the frame (a badge, a chip); a taller band (a panel's) goes on past it. A modal shows the page behind it as it is: a terminal
has no scrim, so nothing is faded or dimmed, and the app's backdrop (a translucent fill of a modal's layer across
the whole screen, `bg-black/50`) draws no fill, while it still takes presses (closing on a press outside) and
keeps the focus in the modal. A system dialog (`AlertDialog`) is drawn the same way, framed over the page; its buttons are `Cancel  OK` with surfaces, the default one bold and the focused one a select band and
bold, and `< Cancel >  < OK >` bandless, the focused one reversed.

**Scroll bars**: a scroll view whose content overflows along its axis shows a one-Cell bar on its inner right
edge (bottom edge when it scrolls horizontally), or on the right line of the framed box it fills when a vertical
scroll view reaches it, directly or through boxes that run to the line, up to one padding Cell before it, a popup's
frame drawn around its box too (a pane filled by its list, as lazygit's, a command palette's list: the thumb over the
line, no column of its own), unless its `scrollbar` is off, it is a single Cell across, or
its content drew a glyph in the column (row) the bar would take (the layout keeps none for it, and content wins):
the track `│` (`─`) in the border step (dim bandless), the thumb `┃` (`━`) muted (the default foreground
bandless; the accent while the scroll view has the focus, its keys scrolling it), as long as the share of the content in
view (at least one Cell) and placed by the offset. A scroll view the app gave a bar of its own (`nsh/base`'s
`Scrollbar`, a scroll bar theme) shows the terminal's bar, since `Scrollbar` draws nothing in the terminal
idiom. Each drawn bar is a `scrollbar::ScrollBar` (the scroll view,
its track and thumb Cells), which input reads to drag the thumb.

**Clipping**: a text run never draws past its own view's box; a view that clips (`overflow: hidden`), scrolls or has a
border keeps its children inside its content box, while elsewhere a child placed outside its parent (a badge, an
absolute label) shows, as in CSS. A one-line text cut
at its right edge shows `…` in its last Cell, and a text whose rows go past the bottom of the box ends its last
row shown in `…`; a text a scroll view's viewport cuts is only cut (it scrolls into view), and so is a run of
glyphs without letters or digits (a slider's track). The content of a disabled view is dim (faint with surfaces)
even where it stands outside the view's own frame. Where two texts share Cells, the later one wins them whole and the earlier one's Cell just before it becomes
`…`, so the overlap reads as truncation, never as mixed letters.

An unchanged frame changes no Cell: ratatui's diff then writes nothing.

## System UI

What the system draws on other platforms is drawn in the same look (`dialog.rs`, `menu.rs`).

- **Alerts** (`AlertDialog.show`, `Command::Dialog`): the screen is dimmed and the dialog is a centered box (at
  most 64 Cells wide) cleared of what is under it, with a rounded dim border, the title in the top border, the
  message wrapped inside and the buttons as `< OK >` in a row at the bottom right; a sheet lists them one per row.
  The focused button is reversed, the default one bold, a destructive one red. An alert puts its cancel button
  first and a sheet last; focus starts on the default button. Tab and the arrows move between buttons, Enter and
  Space choose, Escape chooses cancel or dismisses a cancelable dialog; a press on a button chooses it, one
  outside dismisses a cancelable dialog. The answer is the `dialog` event with the dialog's `id` and the button's
  `index` (-1 when dismissed). While a dialog is shown it takes every key and press, and nothing behind it is hit.
- **Context menus** (`Menu.popup`, `DesktopCommand::PopupMenu`): a box at the pointer's Cell (or the app's point),
  above the pointer or moved left where it has no room, on the raised surface of an anchored popup with the
  popover's rounded line, no backdrop. One row per item: the label from the first Cell inside the line (a role's own
  without one), the shortcut at the right (macOS's `⌃⌥⇧⌘` on macOS, else `Ctrl+Shift+N`) or `›` on a submenu,
  whose box opens beside its row; a box with a checkable item keeps a one-Cell column at its rows' right end, a
  Cell inside the line and a Cell after the shortcuts, for the `✓` of a checked item and a submenu's `›`, as
  `nsh/base`'s `Menu`, `Select` and `Combobox` place their marks; disabled items faint, separators a line across the box, the focused row on the
  selection band (reversed without surfaces). Up / Down, Tab / Shift+Tab and Ctrl+N / Ctrl+P go round the items that
  can be chosen, Home / End to the ends, a letter to the next item it starts; Right, Enter or Space opens a submenu,
  Left closes it; Enter or Space chooses, Escape (Ctrl+G) closes a submenu, then the menu. The pointer moves the
  focus and opens submenus; a press on an item chooses it, outside the boxes closes the menu and reaches nothing
  behind it. A choice is the root's `Menu` event with the item's id (a `quit` or `close` role ends the app), then
  every close `{ id: 0, closed: true }`, as Linux reports them. While a menu is open it takes every key and press.
- **The application menu** (`Menu.setApplicationMenu`, `DesktopCommand::SetMenu` / `SetMenuBar`; `menu.rs`'s `Bar`): a
  menu bar on the surface's top row, as mc's and htop's, the titles ` File ` ` Edit ` from the second Cell on the
  raised surface, the app laid out in the rows below (its area, environment and hit tests start there). With no
  application menu the bar takes no row; with the menu bar mode `"autoHide"` it takes none either and is drawn over the app's
  top row only while it has the keys. F10 gives the bar the keys (the first enabled title marked with the accent);
  Left / Right, Tab and Home / End move between the titles, Down, Enter, Space or a title's initial opens its menu
  below the title (the context menu's box and keys), Left / Right in an open menu go to the neighboring title's (Right
  opens a focused submenu first), Escape closes the menu and then leaves the bar, F10 leaves it at once. A press on a
  title opens its menu or closes it when open; while one is open the pointer over another title opens that one. A
  top-level item without a submenu is chosen at once. A choice is the `Menu` event with the item's id, as the context
  menu's, without the close event. The items' shortcuts are matched after the keymap's
  bindings and the focused component's, as the GPUI backend matches them (`MenuItem::find_shortcut`, a shortcut that
  needs no modifier not while a field is edited, Ctrl tried as Cmd where Ctrl stands in for it; while the bar has the
  keys a shortcut with Ctrl, Alt or Cmd still chooses its item and folds the bar up, a letter alone stays a title's
  initial, and Alt+Escape, two quick Escapes as tmux joins them, is Escape; the edit roles' keys stay the field's and
  the selection's own, so Ctrl+C still copies or quits); the edit roles (`undo`, `redo`, `cut`, `copy`, `paste`,
  `selectAll`) act as their Cmd keys on the focused field, and the roles of a window or app the terminal has none of
  (`about`, `hide`, `hideOthers`, `showAll`, `minimize`, `zoom`, `toggleFullScreen`) are left out, with the separators
  and submenus they leave empty.
- **Scroll bars, selection and the caret**: as above; selected text and the Minibuffer's matches are reversed,
  a text field's caret is the terminal cursor.

## Navigation stacks

Each stack keeps the core's `navigation::Stack`. Inserts, moves and removals mark the affected stack; after the
whole mount batch, `Stack::reconcile` selects its top screen. Every other screen is concealed: drawing and hit
testing skip its subtree. The app can remove the top screen to reveal the previous one. Pushes and app-driven
removals settle immediately, with no transition frames. Stacks and screens clip their children to their bounds
and draw the app's own styles, with no placeholder box.

A screen keeps its `ScreenConfig`. Of its header items, only the node named by `header_view` is visible; the
native left, right and title slots stay concealed. The selected header is kept above the app's content, including
content inserted later. Header items draw their children directly, without a placeholder.

Before drawing, attached, visible screens report their stack's point size and zero insets. A screen's
`navigation::Reported::update` suppresses unchanged reports; a change sends `set_root_size`, and an inset change
also sends the core's Insets event. A hidden screen, including one inside a concealed outer screen, is not
reported until it becomes visible.

`Esc` and `C-g` use `navigation::back_target`. Without a modal, the app's `onBackPress` hears the request first;
a declined request returns as `Command::Back`, which proceeds directly to navigation. Otherwise the innermost
stack takes it: its top screen receives BackRequest when listened for, `prevent_back` keeps it in place, and a
native pop sends Dismiss immediately. The shared Stack remembers native pops until the app removes those screens.
Each screen remembers its last focused control when another screen covers it. On back or an app-driven pop,
that control regains focus if it still exists, is focusable and shows; otherwise the screen's first focusable
control is selected and revealed. Covered screens stay mounted, including their Scroll states, so returning to
a valid saved control keeps both focus and scroll offsets. Only a fallback that needs revealing moves a Scroll.
Modal focus restoration takes precedence over page history and retains its separate invalid-opener policy.

Modals cover the surface and paint above the page. A batch's new modals follow the completed tree's order (core
sibling insertions may arrive in reverse); a modal presented in a later batch goes above the existing ones.
Presenting a modal saves the previous focus and moves focus to its first focusable view in tree order; an
empty modal has no focus. Keyboard traversal stays inside the newest modal, including when it has no controls.
Closing a modal, natively or through an app update, restores the saved view only if it still exists, is focusable
and has visible Cells. Otherwise focus is cleared, rather than moved to another page control. Nested modals keep
this history per presentation, so closing several at once restores the page's focus.

Mouse hit testing is also scoped to the newest modal, even when its container uses `pointerEvents: "box-none"` or
`"none"`. A completed press on its own backdrop sends RequestClose with reason `backdrop`; the modal's
`close_on_backdrop_press` also closes it natively and sends Dismiss. The release is consumed even if the modal
closed in between, so it cannot press the underlying page. App-rendered backdrop controls keep their own handlers.

A stack inside the newest modal gets back first; otherwise the modal receives RequestClose with
reason `cancel`. `close_on_escape` also closes it natively and sends Dismiss. Modal sizes and zero insets use the
same Reported contract, and first presentation sends Show. Transitions settle immediately.

## Scroll content

A Scroll draws its children within its viewport, using the current content offset; it starts at zero. The view's
own fill and border stay fixed. Children are translated by the offset (with content insets from the core's scroll
behavior), then projected to Cells and clipped to the Scroll and its ancestors. Text that starts outside the
viewport is clipped Cell by Cell like other clipped text. The hit regions use these translated,
clipped rectangles, so only visible content receives presses.

The retained view owns the core's `scroll::ScrollState`. `ScrollConfig`, `ScrollContent` and `ScrollBehavior`
update its axis, extent and behavior data. `ScrollTo` from the core, including an initial `contentOffset` and
resolved `scrollToEnd`, moves immediately within the content limits in this reduced-motion slice. `ScrollBy`
applies the core's anchoring delta without clamping it. After applying pending batches, the surface reports each
changed scroll view's final offset and applied-command count to the engine, which delivers scroll events and
updates its view of the content. Keyboard movement reveals the focused control in its surrounding Scroll,
innermost first. A reveal leaves a fully visible target in place. When vertical scrolling is needed, it centers
the target in the viewport, clamped to the content limits, keeping it away from app overlays at the edges.
Horizontal reveals and targets too large to center retain the core's reveal margin (16 points, capped at a
quarter of the viewport) and favor the target's start when it does not fit.
Paging and endpoint keys act on the innermost Scroll around focus, or around the search point
when a plain-text match holds it. With neither in a Scroll, they use the first Scroll in the active focus scope.
Paging moves focus to the visible control nearest its old relative row in the viewport (relative column
for horizontal scrolling). Home/End and Alt+< / Alt+> choose the Scroll's first/last focusable control and reveal
it, even when nonfocusable content precedes or follows the controls. With no focusable controls, these keys only
scroll, to the content endpoints for Home/End. Page selection uses the next completed frame's geometry, and Enter
never presses an off-screen control. These user-driven offsets keep the applied count unchanged; only core
ScrollBy and ScrollTo increment it.

Each wheel step moves three rows vertically, or six columns horizontally (three columns times two). Shift sends
vertical wheel steps horizontally. The core's
`input::scroll_target` selects the innermost Scroll under the pointer that can move; at an edge the same-axis
parent can take the event. This search stays inside the newest modal. A vertical wheel uses a horizontal view
only when no surrounding Scroll takes the vertical axis. Disabled scroll views do not take the wheel.

The wheel scrolls the pane under the pointer and never moves keyboard focus, as on the desktops: a focused
control that scrolls out of sight stays focused, and the next key that moves focus starts from it. A wheel event
with no keyboard focus creates none. Gestures and scrolling animations remain
separate work; the scroll bar is drawn (Drawing above).

## Native animations

The retained tree owns one core `animation::Animator`. Every mount item feeds it, including deletion and binding
changes. `AppView::render` and its buffer-only Widget path tick it with monotonic seconds, write `AnimValues` and
canvas slots, then send its finished runs and value reads through `EngineControl::animations_finished`. Timing,
springs, decay, composites and native keyframes use the core's drivers. Replacing or stopping an app clears the
graph and its deadline. Replacing bindings clears their old overrides, so ordinary styles become visible again.

Active drivers request the next render in 16 ms through `next_frame_deadline`; they have their own deadline,
separate from the engine's display-frame request. Embedders arm a timer for that deadline after rendering. The
standalone loop already uses this contract. Once the graph finishes or is stopped, it schedules no further
frames. The test agent reports the graph's actual animation state when settling input.

Animated opacity hides a view only below 0.03, as static opacity does. Animated border and text colors override
their style values and are drawn like any other color (animated fills, like fills, draw nothing but decide the
ground of what is on them); a text field's placeholder stays dim. Canvas numeric and
color slots are evaluated on the same frame, including the slots used by drawing transforms.

Animated transform steps override their style values: translation moves a view and its content by whole Cells
(Drawing above), and clipping, focus geometry and hit regions follow it. Canvas paths receive the canvas's own
transforms on the braille grid, including after a canvas `setTransform`.

The environment reports reduced motion. Navigation, modal transitions, layout animations and style transitions
take their final state immediately. Motions honor reduced motion through the core; explicit `Animated` and
animated-value drivers run as written, so entrance fades such as the gallery's `Appear` finish visible and
completion callbacks and promises resolve normally.

## Canvases

`canvas.rs` replays a canvas's `Drawing` against a small 2D context onto a grid of braille dots, 2 across and 4
down per Cell (4 × 4 points at the default 8 × 16), and ratatui's `canvas::Canvas` with `Marker::Braille` turns
them into symbols. Only the canvas's visible Cells are replayed onto, so a canvas partly scrolled or clipped keeps
its dots in place. The widget resets the background of its area, so it draws into a scratch buffer and only its
symbols and inks are copied: what lies under it stays, and the dots keep the background of the Cells they are
drawn on.

- **State**: the affine transform (`translate`, `scale`, `rotate`, `transform`, `setTransform`), `save` /
  `restore`, `fillStyle` / `strokeStyle`, `globalAlpha`, the line dash and its offset, `font` (its weight and
  italic only), `textAlign` and `textBaseline`, and the clip.
- **Paths** (`canvas/path.rs`) are flattened to polylines in the view's points, within half a point: lines,
  quadratic and cubic curves, `arc`, `arcTo`, `ellipse`, `rect` and `roundRect`, under the transform at the time
  each part was added.
- **Fills** set the dots whose centers the fill rule (nonzero or even-odd) puts inside the path, every subpath
  closed; `fillRect` fills a rectangle without touching the current path. **Strokes** set the dots each segment
  passes through, one dot wide; `strokeRect` strokes a rectangle. `clearRect` empties dots.
- **Clips** are masks of dots, each new one intersected with those in effect; fills, strokes and text stay inside.
- **Dashes** are sampled at each dot's center along its subpath, in user-space lengths scaled by the transform; an
  odd pattern repeats, and every subpath starts the pattern again. A pattern whose shortest dash or gap is under
  two dots (a guide's 3 on, 5 off at 4-point dots) is scaled up in proportion until it is two (`Dash::at_least`):
  sampled as it is it would alternate single dots, a dotted line that reads as a denser row of a dot grid.
- **Colors**: a gradient draws its middle stop, and an animated color (`Paint::Slot`) its current value from the
  canvas arguments the native animator writes (transparent until it has one; numbers read 0). A paint's alpha
  times `globalAlpha` is part of its color, blended over the page of the appearance and drawn at the terminal's
  color depth; the view's opacity is not. At 16 colors the canvases of one frame share their entries
  (`palette::Hues`), so the app's distinct colors stay apart where nearest-color quantizing would merge them: a
  hued color takes its hue's accent (as text of that color does), else the nearest hue still free; a gray the
  nearest of Black, DarkGray, Gray and White still free; none takes the entry of the ground it is on. Colors share
  an entry only once every one is taken (a fifth gray series). A Cell shows one
  ink: that of its most recently painted dot. A fill under half opaque is a wash, a sparse floor of dots;
  under 15% (a ring's track, hatching) a fill is its outline and a stroke its path, both a hairline in the faintest
  gray, drawn only where no other dot is and never the ink of a Cell another mark shares, so a track still shows
  the full scale without burying the marks over it.
- **Text** (`fillText` / `strokeText`) is printed on whole Cells above the dots, one row tall: `textAlign` places
  it by its width in Cells, and `textBaseline` puts its row's top at `y` (`top`, `hanging`), half a row above
  (`middle`), three quarters of a row above (`alphabetic`) or a whole row above (`ideographic`, `bottom`). A weight
  of 600 or more is bold; `maxWidth` cuts it to the Cells that fit. The Cell before and after it shows no dots,
  so a label stands apart from the marks it names; a text view drawn over a canvas (a chart's value on its bar)
  clears the dot Cell before and after each of its rows the same way.

A drawing's nodes (`Drawing::nodes`) are pressed as a pointer at their center presses: the agent's model finds the
node, the canvas reports its Cells like any view, and the press goes to whatever takes presses under that Cell, the
canvas itself included.

## The terminal Key scheme

`key_scheme.rs` maps keystrokes to actions; `keyboard.rs` applies focus, activation and scrolling, and
`navigation.rs` handles back. This keeps a future vim scheme independent of the actions, with one scheme selected
today and no mode switch. The app's `nsh/keymap` table is matched first, including its editing and repeat policy, and with it the
bindings a focused component holds (a slider's or a list's arrows), so a focused component gets its keys before
the scheme moves focus. Those bindings follow the focus in the app's effects, so a key right after a focus change waits up to 100 ms for the engine to run it (`EngineControl::flush`, then `Message::Focused` behind its batches), applying the batches meanwhile: Escape and Tab sent together leave an editor rather than indent it. Ctrl+C copies a text selection (in a field or selectable text) and otherwise exits. Outside fields, C-h e opens diagnostics; inside fields,
C-h is Backspace (leave the field with Esc or C-g to open diagnostics). While the diagnostics panel is open,
it owns keys and the app's field caret is hidden; closing it restores the caret when an editable field has focus.

| Keys | Action |
|---|---|
| Ctrl+N, Tab | Next focusable view in tree order; with the focus in the open popup of a trigger (a date picker's calendar, a menu), the next one in it, round it: its box covers the controls around the trigger, and Escape closes it and gives the trigger the focus. A popup anchored to no focusable view is passed through in tree order; one over a backdrop that covers the page (a dialog, a sheet) keeps the focus inside it (`covering_layer`), and closing it gives the focus back to the stop it covered, also when Escape closes it before the focus went in |
| Ctrl+P, Shift+Tab | Previous focusable view in tree order, in the same popup as Tab |
| Down / Up | Nearest focusable view below / above, one in an overlapping column first; with none focused, the first / last one in sight, inside an open anchored popup (a menu or select opened by a click) when one is open. One out of sight within a wheel step is revealed; one farther away is approached by a wheel step (three rows) of the innermost Scroll that can still move that way, focus then staying on a control in sight |
| Ctrl+F, Right / Ctrl+B, Left | Nearest focusable view to the right / left on the same row |
| Enter, Space | Press the focused view, reporting PressDown, PressUp and Press in order, at its middle |
| Esc, Ctrl+G | Leave the focused field; otherwise go back through the app handler, stack or newest modal |
| Ctrl+V, PageDown / Alt+V, PageUp | Scroll one viewport down / up in the innermost Scroll around focus or the search point |
| Alt+<, Home / Alt+>, End | In that Scroll, focus the first / last control in tree order; center it when a vertical reveal must scroll, or scroll to the endpoint when there are no controls |
| Ctrl+S / Ctrl+R | Search the text on screen forward / backward in the Minibuffer |
| Ctrl+C | Copy the selection; with none, quit |
| F10 | The application menu's bar (System UI above): the arrows, Tab, Home / End, Down / Enter / Space, a title's initial, Escape / Alt+Escape |
| Ctrl+H, E / Ctrl+H, P | Outside fields: the diagnostics panel / the performance line |

Focus visits pressable and editable views, honoring `focusable` and disabled state, in depth-first document
order within the focus scope, as NSH's other platforms do (Tab and Ctrl+N / Ctrl+P; Up / Down are spatial). A sidebar's stops stay together before the next
panel's stops, regardless of their Cell positions. Traversal wraps at the ends; horizontal movement stays
spatial, choosing the nearest control on overlapping row ranges. Traversal centers a control vertically when
revealing it requires scrolling, and leaves fully visible controls in place (see Scroll content). When the
focus leaves a control for none (Esc out of a field, an editor's included), the next Tab or Shift+Tab continues
from that control rather than from the ends. A text field narrower than a Cell (an editor's sink at its caret)
is still a stop, and while it has the focus the terminal's cursor (Bar) is at its origin Cell
(`Keyboard::cursor`): an `Editor` and a `RichEditor` keep their sink at the caret and draw no caret of their own.
A text's links that are stops (`TextLink::focus_stop`: a `TextView`'s, a nested `<Text onPress>`) are stops
right after their text, in text order, a link inside another after the one around it (`render.rs` records each
with its Cells as `Mounter::spans`, `keyboard::Span`): the focused one's characters are reversed, it reports
`focused` and `Focus` / `Blur` as a view does, and Return presses it as a click on its characters does.
The sink opts into `MountItem::TreeOrder`: the core supplies logical document order in the same batch as
structural changes. `Insert` retains native paint order, including `zIndex`; raising a sidebar changes its
stacking while its focus stops retain their document order. Ordinary text and style updates keep the stored
order. The backend filters that order through the completed frame's geometry and current focus scope.
Concealed screens supply no candidates. When a modal is open, candidates come only from the newest modal.
Focus and focus-within states are reported through TrackStates and `EngineControl::set_states`, so the app's
focus styles apply. Pressable views have no platform focus marker: their app-defined focus styles are the
indicator, and their terminal cursor is hidden. `AppView::render` reserves the terminal cursor for a focused
editable field's caret and respects `caret={false}`. A buffer-only Widget cannot position the terminal cursor.
Removing an ordinary focused view clears focus. Modal presentation and closing use the focus history described
above; unfocused surfaces ignore keys. A programmatic `focus()` (a ref's, `autoFocus`) on a view scrolled out of
sight focuses it and reveals it in its surrounding Scrolls, as keyboard traversal does.

Focus changes clear the old focused state before setting the new one, so the core's derived `focus-within`
state stays on a shared ancestor when moving backward between its controls. The focused control shows
as the terminal marks focus: its label reversed, or a large container's border bold (Drawing above).

The host preserves Ctrl, Alt, Shift and known releases; crossterm also decodes an ESC-prefixed character as Alt.
`Input::KeyRepeat` preserves a repeat identified by the terminal, so a nonrepeating app shortcut consumes it
without firing again. Navigation activation completes a press in one action; a later release does not press
again. Legacy terminal presses are independent actions: Ctrl+I/Tab, Ctrl+M/Enter and Ctrl+[/Esc can be
indistinguishable, and a terminal may consume Ctrl+S/Ctrl+Q for flow control (the host's raw mode turns
the tty's own flow control off). With the kitty keyboard protocol the standalone host negotiates, those pairs
arrive apart. Editing uses the keys below while a field is focused.

## The Minibuffer

`search.rs` searches the text on screen incrementally, as readline's and Emacs's incremental searches do:
`C-s` forward, `C-r` backward. The app's shortcuts are matched first, so an app that binds either key keeps it;
inside a field both still search. While searching, the Minibuffer owns the keys:

| Keys while searching | Action |
|---|---|
| Characters, bracketed paste | Extend the query; the current match stays while it still matches, else the next one in the search's direction is taken |
| Ctrl+S / Ctrl+R | Next / previous match; with an empty query, search for the previous search's query |
| Backspace, Ctrl+H | Return to the query and match before the last key |
| Enter | End the search at the match |
| Esc, Ctrl+G | Cancel: restore the focus, the search point and the Scroll offsets from before the search |
| Other keys, mouse input, losing focus | End the search at the match; the key or mouse input then acts as usual |

The search reads the rows the Cell text engine laid out for the Text views of the current focus scope (the
newest modal, else the page), including text scrolled out of a Scroll's viewport; concealed screens and hidden
views supply none. Field contents and canvas text are not searched. A match lies within one displayed row and is
compared grapheme by grapheme; a query without capitals ignores case (smart case). Matches are ordered by Cell
position, top to bottom and left to right, and the order wraps at both ends. A search starts at the focused
control (inclusive), at the search point, or at the first / last match when there is neither.

A match moves keyboard focus to the nearest focusable view around it (a button's label focuses the button) and
reveals the match's row in its surrounding Scrolls, innermost first. As with focus traversal, a vertical reveal
that must scroll centers the row in the viewport, within the content limits; an already fully visible row stays
in place. Horizontal reveals retain the margin described under Scroll content. A match in other text clears
focus and becomes the search point: Next / Previous (Ctrl+N, Ctrl+P, Tab, Shift+Tab) then continue from it to the nearest
control after or before it in tree order, so a match in a page panel moves within that panel rather than to a
sidebar beside it on the same rows. Paging and endpoint keys use the innermost Scroll around that search point,
including after the Minibuffer closes.

While searching, the platform draws the Minibuffer over the bottom row of the surface's area, in the terminal's
default colors: `/` (forward) or `?` (backward), after less and vim, then as much of the query's end as fits,
with the terminal cursor after it. A query with no match is crossed out. The current match's Cells are
reversed, also inside the reversed label of the focused control it moved to or a selected row.
The prompt is a symbol because the platform draws no built-in strings. The app's layout never changes for the
Minibuffer, and once the search ends nothing of it, or of the match highlight, is drawn. A match on the bottom
row lies under the Minibuffer until the search ends. Positions come from the last completed frame.

### Base controls

The official gallery's Controls demo uses the same `nsh/base` components in the terminal. Button, Checkbox,
Radio/RadioGroup, Switch and Tab/Tabs take Enter after focus traversal; disabled controls are skipped. The app
owns their values and the content of Collapsible. Checked, mixed, selected and disabled styles, including the
projected states of Checkbox indicators and Switch tracks/thumbs, are resolved by the core and painted through
ordinary mount batches. The backend supplies interaction states and never substitutes a terminal control.

A focused Slider thumb installs its component's keys in the existing app keymap: arrows change by a step,
PageUp/PageDown by a page, and Home/End move to its limits. Those bindings run before terminal navigation and
scrolling. Tab/Shift+Tab leave the thumb; Ctrl+N/Ctrl+P remain traversal keys. Range thumbs stay within each
other and disabled thumbs are skipped. Progress, Tabs, Checkboxes, Radios and Switches draw their own glyphs; a
selected tab is a reversed band (an underline alone when the app underlines its label) and a disabled control is
dim.

Mouse presses use the same hit regions as other views when the host captures the mouse. The controls
acceptance covers keyboard and press behavior; Slider dragging and hover feedback require the joint pointer
acceptance described below. Shadows, rings and transforms follow "Drawing"; focus, selection and
disabled states show as the terminal's attributes described there.

## Mouse and text selection

The standalone host captures the mouse: clicks, motion with and without a button down, and the wheel. Start
`nsh-tui-host --no-mouse --bundle <bundle.js>` (or `--no-mouse --dev-server <url>`) to leave the mouse to the
terminal emulator and its own text selection. An embedder owns this transport choice and forwards
`Input::Mouse`; AppView never changes terminal modes. The test agent forwards the same input independently of
terminal capture.

A press on the Cell of a pressable span (a nested `<Text onPress>`, a `TextView` link) is the span's, as on the
desktop backends: the innermost span around the character drawn there takes it before the views around its
text, and it fires only when released on that span.

A text field takes the pointer itself (the caret, a drag's selection), and one that listens to presses (a
combobox's field) still reports the press: `onPressDown` as it goes down, then the focus it takes, then
`onPressUp` and, released on the field, `onPress`, focused before or not. Return stays `onSubmit`.

Presses of one button on one Cell within 500 ms count up to a triple click and start over: `Press` events carry
the count (`clicks`), a double click in a field selects the word, a triple click its line, and selectable text
selects its word and paragraph the same way. Dragging after a double or triple click extends the selection by
whole words or lines, keeping the unit first clicked. A secondary (right) press asks the nearest enabled view around
the one under the pointer that listens to `onContextMenu`, with the Cell's middle as its position, as the
desktop backends do; it first goes down and is cancelled as a touch, so an open popover closes on a right
press outside it. A press in a field still goes down as a touch before the field takes the pointer, so an
open popover hears a press outside it there as anywhere else.

A scroll bar answers the pointer: a primary press on its track moves the thumb's middle there at once, and a
held thumb follows the pointer Cell by Cell, the offset proportional to the thumb's place in the track's free
Cells. The press takes neither focus nor a selection.

The handles of `ResizablePanelGroup` and `DockArea` are their own terminal forms (`docs/dev/dock.md`
"Resizable"): a `│` or `─` line in the Cell between two panes, lit in the accent while hovered, held or focused.
A primary press on the line and a drag resize the panes Cell by Cell as the pointer moves, through the Touch
events below; Tab reaches the line and its arrows step it one Cell. A tab dragged in a `DockArea` outlines where it would land: an unanchored
overlay with an accent border and no fill, drawn as a frame over the content, which stays as it is.

`input.rs` picks the last painted, clipped hit regions inside the newest modal. Hover follows the ancestor
chain, reports `HOVERED`, HoverIn/Out/Move and rechecks the pointer after rendering a changed tree. Leaving the
surface or losing focus clears hover. Pressed states clear on release, cancellation or a drag. Pointer coordinates
are absolute Cells at the input seam and Cell centers in points in events, including an embedded area's offset.

A primary-button drag retains its initial target outside the surface. The core's Grab, Gate and Candidate
helpers choose native pans or content scrolling; Touch start/move/end/cancel events feed the responder system,
including `panActivation`. A blocking JS responder prevents native gesture takeover. Native pans write the
surface's Animator and report translation, velocity and values at release; the animation renderer consumes that
same graph. The terminal deliberately admits mouse drags as scroll candidates, so dragging unclaimed scroll
content moves it directly within its bounds. Selecting text takes precedence over content scrolling.

`selection.rs` adapts the core SelectionModel to the visible tree's text layouts. `<View selectable>` groups its
texts (nested groups belong to the outer group); `userSelect: "text"` selects a standalone Text and
`userSelect: "none"` excludes it. Dragging highlights whole graphemes with reversed Cells, Shift+click extends,
and Ctrl+Shift+C, Ctrl+Insert, Alt+W or Cmd+C copies through the existing clipboard backend (OSC 52 in the
standalone host), and so does Ctrl+C while there is a selection. Ctrl+A / Cmd+A selects the area's texts;
Esc / Ctrl+G and any other key clear the selection, and so do clicking elsewhere and losing focus. A click on selectable pressable text still presses; a drag past the shared press slop selects.
The layout retains each painted grapheme's UTF-16 range, including wide characters and ellipsis gaps; copying
uses original text and joins paragraphs with newlines. Highlights stay within clipped text Cells and below
covering views. Removed text endpoints clear the selection through the shared model.

## Syntax highlighting

The terminal runtime enables `nsh-base`'s built-in highlighting, as the desktop backends do.
Editor, DiffView and TextView code blocks draw their language token colors at the terminal's color depth in both appearances.

## Text fields

`text_input.rs` keeps one `nsh_core::text_edit::Model` per Input. The core model owns the text, byte selection,
character/word boundaries, replacement, deletion and undo history. The backend maps the terminal Key scheme to
those operations and projects text to Cells. `InputValue` updates are accepted only when their edit count is at
least the local count; an equal value preserves the selection and undo history. Every local edit reports one
`ChangeText` with the new count, including when the app has no change listener. Selection events use UTF-16
positions; Cell columns and model byte offsets are never used as event offsets. Typed insertions and Backspace
report `KeyPress`; Enter reports it before `SubmitEditing`. Focus changes use the shared keyboard Focus/Blur and
tracked-state path. `autoFocus`, `focus()`, `blur()` and `setSelection` use the same field state.

Tab / Shift+Tab enter and leave fields. C-n/C-p and Up/Down traverse controls in single-line fields; in multiline
fields they move between visual lines, retaining the desired Cell column across short lines. A mouse press in a
field positions its caret; dragging or Shift+click extends the selection, a double click selects the word and a
triple click the line, and dragging on from either extends by words or lines. While a field is edited the
terminal cursor is a bar at the caret (`CursorStyle::Bar`, the terminal's own shape restored after), and Ctrl+C
copies the field's selection. The last painted, clipped hit regions
respect modal scope and `pointerEvents`. Esc / C-g clears field focus before a later cancellation reaches the app.
App shortcuts run before editing, with the existing `When::Editing` policy.

| Keys in a field | Action |
|---|---|
| C-a / C-e, Home / End | Start / end of the logical line |
| C-f / C-b, Right / Left | Forward / back one core character boundary |
| M-f / M-b | End of the next / start of the previous alphanumeric word (readline) |
| Ctrl+Right / Ctrl+Left, M-Right / M-Left | Core desktop word boundaries, including trailing / leading whitespace |
| Shift+arrows, Shift+Home/End | Extend the selection |
| C-n / C-p, Down / Up (multiline) | Next / previous visual line |
| C-d / Delete, C-h / Backspace | Delete forward / back |
| C-k / C-u | Kill to line end / start; C-k at line end also kills the newline |
| C-w / M-d | Kill back to the whitespace boundary / forward to the end of the next alphanumeric word |
| M-Backspace | Kill back to the start of the previous alphanumeric word |
| Ctrl+Backspace / Ctrl+Delete | Delete back / forward to the core's desktop word boundary |
| C-y | Insert the last killed text, shared between fields of this surface |
| C-t | Transpose the characters beside the caret, or the last two at the end |
| Ctrl+Shift+C / Ctrl+Shift+X, Cmd+C / Cmd+X | Copy / cut the selection |
| Ctrl+Insert / Shift+Delete, M-w | Copy / cut; M-w copies |
| Ctrl+V, Ctrl+Shift+V, Cmd+V, Shift+Insert | Paste the clipboard text |
| Ctrl+Shift+A, Cmd+A | Select all; the test agent's clear step uses Ctrl+Shift+A |
| Ctrl+Z / Ctrl+Shift+Z, Cmd+Z / Cmd+Shift+Z | Undo / redo |
| Ctrl+Home / Ctrl+End, M-< / M-> | Start / end of the text |
| Enter | `InputConfig::submit()`: newline, submit, or submit and blur |
| Shift+Enter / Alt+Enter (multiline) | Insert a newline even in a field configured to submit |
| Esc / C-g | Leave the field |

The readline word policies follow [GNU Readline's killing commands](https://www.gnu.org/software/bash/manual/html_node/Commands-For-Killing.html);
C-w treats punctuation within a whitespace-delimited word as part of that word. They choose a range using the
core's character boundaries, then use the core Model for selection and deletion.

The app's `InputContent` box defines padding and border offsets. Text is a Paragraph with the app's text style;
empty fields show the placeholder, dim. Single-line fields center their text and caret vertically
in that content box; drawing, selection and pointer placement use the same row. Multiline fields begin at its top.
Graphemes stay whole; wide graphemes occupy their display width,
multiline fields wrap at Cell boundaries, and single-line fields scroll horizontally. The field scrolls its caret
into sight vertically and horizontally. Selected glyphs are reversed. Masked fields show one `•` per grapheme and
do not export their selection through copy/cut. `AppView::render` places the terminal cursor at the caret;
`caret={false}` hides it. While it shows there, `AppView::cursor_style()` is `CursorStyle::Bar`, which the
standalone host draws as a steady bar; elsewhere it is `Default`, the user's own shape. Input-method composition belongs to the terminal emulator; committed characters enter
through the ordinary key/paste path.

Bracketed paste is one model insertion and one ChangeText event; it is clipped by the core's
UTF-16 `maxLength`. The core's `pasted` helper normalizes CRLF and single-line line breaks. `Paste` is reported
before insertion, and `pasteBehavior="report"` reports without insertion.

Fields share the exact `ClipboardBackend` passed to their engine, including the test agent's isolated clipboard.
An embedder without one gets a memory clipboard. The standalone host supplies OSC 52: writes are base64 encoded,
queued from engine calls and flushed between terminal frames so escape sequences cannot interleave. Its copied
text is retained in process for reads, including over SSH. Before a local copy, it tries the available desktop
reader (`pbpaste`, PowerShell's `Get-Clipboard`, `wl-paste` or `xclip`). Bracketed paste is the terminal emulator's
clipboard delivery and does not require a remote read. OSC 52 delivery requires the user's terminal/multiplexer to
permit clipboard writes; `nsh test` uses memory and never writes to the machine's clipboard.

## Features in the terminal

| Feature | Terminal representation |
|---|---|
| Device form | `platform.idiom` `"terminal"` with the real `platform.os`; desktop behavior (`desktop={{…}}`, `platform.select`'s `desktop`, shortcuts, hover, context menus) |
| Performance monitor | One corner line, toggled by `C-h p` or enabled by `--fps`; idle draws stop and readings also go to `nsh::perf` |
| Development logs and connection/build status | Append-only log file, visible in the on-demand `C-h e` panel |
| Test screenshots | Versioned UTF-8 JSON of Cell symbols, foreground/background/underline colors and modifiers |
| Alerts (`AlertDialog`) | A centered framed box over the dimmed screen, buttons as `< OK >`, the focused one reversed |
| Context menus (`Menu.popup`) | A framed box at the pointer on a raised surface, one row per item, shortcuts at the right, submenus beside their row |
| Application menu (`Menu.setApplicationMenu`) | A menu bar on the top row (none without a menu; over the app's top row while active with `"autoHide"`): F10, the arrows, a title's initial and presses open its menus; item shortcuts work with the bar closed |
| Development errors | Dismissible panel, with the mapped message and stack; cleared by the next update |
| Colors | The terminal theme's meanings: the default foreground, dim for low contrast, or the accent of a saturated color's hue; canvases keep their colors at the terminal's depth |
| View fills | With surfaces (256 colors or more and a known background): a band of the ramp's step over the view's frame (lighter raised, darker sunken, a saturated fill mixed 20% into the step under it), the app's page color the terminal's own background; bandless (16 colors or an unknown background): a small box's (under three rows) tone fill in its color at the depth, any other the standard dark gray, reversed without colors when it holds text; panels and cards unfilled (Drawing, "Fills") |
| Opacity | Left out (a view under 0.03 is not shown) |
| Selected, focused, pressed, hovered and disabled views | A reversed band, a reversed label (a bold border on large containers; an underlined text field), a faint background band (the dark gray at 16 colors), dim (struck through at 16 colors and none) |
| Borders | Box drawing on each side wider than zero, one Cell, dim (an accent color kept), rounded corners where a radius is set, dashed and dotted lines |
| Outlines and focus rings | Left out; focus shows as described in "Drawing" |
| Box shadows | Left out |
| Images, videos, web views, shaders and canvases | At most 48 × 48 points (icons): left out, laid out as `display: none` by the terminal layout (no Cells, frame or hits, their margins and gaps gone). Larger: their box kept and left blank, so the content around them keeps its place; larger canvases are drawn |
| Scroll bars | A one-Cell track `│` (dim) and thumb `┃` on the inner edge of an overflowing scroll view, unless hidden |
| Anchored overlays | Snapped outside the anchor's Cell rect on the core-resolved placement side; cleared and framed, the label as title |
| Gaps between texts | Positive point gaps between one-line sibling texts or canvas text runs retain at least one Cell; zero gaps keep adjacent text |
| Base control value states and projected part states | Drawn by the components' own glyphs; a selected item a reversed band |
| Slider keyboard input | Component-owned arrows, page and endpoint keys while its thumb has focus |
| Slider dragging and control hover | A primary press on a slider's track moves the nearest thumb there and a drag moves it Cell by Cell, through the responder events the Touch path feeds (`nsh-base`'s `Slider`); hover reports `HOVERED` (`hover:` styles) and HoverIn/Out/Move on the Cell hit regions (Mouse and text selection) |
| Border width | One Cell whatever the width |
| Text | The run's color as a meaning, an accent background reversed, bold at weight 600 and above, italic, underline and strikethrough |
| Hover and pressed states | With surfaces the ramp's hover and select steps; bandless a faint band (10% and 18% toward the terminal's foreground; at 16 colors the dark gray for hover, none for press); hover events on the Cell hit regions |
| Mouse drags | Native pan values, responder moves and bounded content scrolling |
| Selectable text | Reversed grapheme Cells; copies use the shared clipboard and OSC 52 |
| Pointer precision | One terminal Cell, converted to its center in points |
| Input | Editable Paragraph, reversed selection and terminal caret; single-line text and caret centered in the content box; masked text is dots |
| Searching the screen | The Minibuffer over the bottom row and the match's Cells reversed (also inside a bar), only while searching |
| Keyboard paging and endpoints | The innermost Scroll around focus or a plain-text search point; otherwise the first Scroll in the active scope |
| Focus and search reveals | Fully visible targets stay in place; vertical scrolling centers the target within the content limits, with core margins for horizontal or oversized targets |
| Input-method composition | Terminal emulator composition, committed text delivered to the field |
| Input accessories (`InputAccessoryView`) | Left unmounted, as on the desktops: no software keyboard to show them over |
| Clipboard | OSC 52 writes, desktop reads when available and an in-process copy |
| Syntax highlighting | The built-in Editor, DiffView and TextView token colors |
| Inline attachments, mentions and inline math | Measured child content placed in whole Cells, wrapping with the surrounding text |
| Font size, family, line height and letter spacing | Terminal font, display width and one row per line; imported fonts load from adjacent `assets/` or the development server |
| Blur, materials, filters, backdrop effects, 3D transforms and blend modes | Left out |
| View gradients (`backgroundImage`: linear, radial and conic) | The first stop as a fill, where the view has no fill of its own |
| Native animated values | Host-frame opacity, background/border/text colors, transforms and canvas slots; completion and cancellation reported |
| 2D view transforms | Translation, rounded to Cells; scale, rotation and skew left out |
| Canvas transforms | Affine paths on the braille grid, with animated numeric and color slots |
| Navigation, modal, layout and style transitions | Final state applied immediately under reduced motion |
| Scroll | Children translated by the current offset and clipped to the viewport |
| Stack, Screen and HeaderItem | The top screen and its selected header, clipped and styled by the app |
| Modal | A surface-sized root above the page, with its own focus scope; what is behind it dimmed, its box cleared and framed |
| Canvas | Braille dots (2 × 4 per Cell) for fills and strokes, text on whole Cells above them, a Cell clear of dots each side |
| Canvas line widths, caps, joins and miters | Decorative features left out: every stroke is one dot wide |
| Canvas shadows, compositing (`globalCompositeOperation`) and images (`drawImage`) | Decorative features left out silently |
| Canvas gradients | The gradient's middle stop as a flat color |
| Canvas colors within a Cell | One color per Cell: the most recently painted dot's |
| Videos, web views, other view kinds and unregistered native components | Left out, logged once per kind or name |
| Icons (canvases at most 48 points both ways) | Left out; an icon button shows its accessibility label |

The trunk applies View/Text geometry, styles, props, text, events, appearance, component registration, core scroll
positions, top screens and their headers, modal cancellation, terminal navigation, search and editing keys, InputValue/InputContent, field commands and app exit. Other mount operations are reported once per operation kind per loaded app; they are not implemented by
an empty success path.
Safe areas are zero, reduced motion is true and `screen_reader` is false.

## Checks

The single integration test binary exercises the public `TextEngine` and `AppView` seams. It uses ratatui's
`TestBackend`, real engines and the counter example compiled by NSH's single-module compiler. It checks visible
cells, mouse-driven changes, area ownership, resize, callbacks and idle scheduling; canvases are checked by their
braille Cells, clipping, fill rules and a press at a node's center, and the library's unit tests cover path
flattening, fill-rule spans and dash patterns. The host's integration test
bundles the counter into a temporary directory, loads it through `Bundle::read`, and drives `run_app` with
crossterm events passed through `convert`. Its scripted user locates `+1` in the flushed cells, clicks it and
waits through idle polls for the value and history to change. It needs no prebuilt CLI, existing bundle or TTY.
The development tests use a real local `DevServer` and `TestBackend` to check complete loads, hot updates retaining
clicked state, rejected-patch reloads, errors and the log panel. CLI subprocess tests select a temporary host via
`NSH_RUNTIME` to check inherited input/output, file diagnostics (including `-v`) and Cell scale precedence and
validation. These are additional ticket-02 seams. The test-agent acceptance seam is `nsh test --target tui`: the existing
counter test and `crates/nsh-tui-host/tests/fixtures/agent` (styled Cell snapshots after a press, and startup errors).
The pointer tests exercise hover, responder capture, pan values, drag scrolling and cross-text copying through
AppView; the pointer fixture imports the unchanged Physics, Gestures and Resizable demos. Their runtime acceptance
and pan animation rendering must be checked together with the animation ticket.
The text-input fixture checks typing, readline navigation, one large paste, selection, copy/cut through the
engine's isolated clipboard, masked Cells, multiline paste and report-only paste. Its Form entry, a sign-up form of
its own, checks invalid fields and successful account creation.
The `controls` fixture imports `examples/gallery/demos/Controls.tsx` unchanged, traverses and operates its
controls with terminal keys, exercises ordinary mouse presses, and reads Cell screenshots. AppView controls
tests cover focus marks, backward focus-within transitions, projected value/disabled styles and focused
Slider keys. The palette module checks colors as meanings at each depth (accents by hue, dim
secondary text, the light and dark pages), translucent text and opacity, text attributes and gradients; the
painting module checks borders (dim or accented sides, dashed, dotted, single sides), that shadows, outlines and
rings draw nothing, scroll bars, that images keep their box blank and icons are left out, icon buttons labeled, tiny and round boxes without borders and empty ones as their outline,
clipping to the parent's content box with an ellipsis, selected bands, focus and disabled marks, overlays cleared
and framed, unchanged frames and invisible views; `dialog.rs`'s unit tests check alerts' button order, keys,
presses and drawing, `menu.rs`'s a context menu's placement, keys and presses. The menu bar module checks the
application menu's row above the app (and none without one), F10 and the arrows between titles and menus, the roles
left out, shortcuts at the right, initials, Escape, presses and hover on titles and an item's shortcut with the bar
closed. These tests do not exercise hover or Slider drags yet.
The search fixture searches forward and backward through a Scroll's rows and checks the Minibuffer row before,
during and after the search.
The animation module at the AppView seam checks completion, cancellation, active-frame and idle scheduling,
app replacement, binding removal, animated fills, transform geometry and presses, and canvas slots. The
`animation` host fixture checks final Cells and callbacks through `nsh test --target tui`.
The host's unit checks cover crossterm conversion and busy-frame input. The latter runs the real `run_app`,
parser and AppView in an isolated process on a private PTY. Each backend flush requests an app update and waits
for its engine wakeup, forcing a due frame at every input poll without timing sleeps. Queued Ctrl+N keys must
focus four controls in order and Enter must activate the fourth. The two ignored lifecycle checks require a
real terminal; the ignored input worker is launched automatically by its supervising test.

```sh
cargo test -p nsh-platform-tui --features dev,run-app --test tui
cargo test -p nsh-platform-tui --lib canvas
cargo test -p nsh-tui-host
cargo build -p nsh-cli -p nsh-tui-host
./target/debug/nsh test examples/counter --target tui
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/text-input --target tui < /dev/null
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/pointer --target tui < /dev/null
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/agent --target tui < /dev/null
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/controls --target tui < /dev/null
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/search --target tui < /dev/null
./target/debug/nsh test crates/nsh-tui-host/tests/fixtures/animation --target tui < /dev/null
cargo test -p nsh-cli --test cli
cargo test -p nsh-tui-host --lib terminal::tests::normal_exit_restores_raw_mode -- --ignored --nocapture --test-threads=1
cargo test -p nsh-tui-host --lib terminal::tests::panic_restores_raw_mode -- --ignored --nocapture --test-threads=1
```

After the lifecycle checks, verify that the shell cursor is visible, the main screen is back and typed input is
echoed. The panic check deliberately emits a panic and catches the unwind. These terminal checks, counter demo,
Linux/Windows checks and performance measurements require runtime validation; `cargo check` proves compilation
only. The CLI acceptance commands above check the complete handshake, in-memory rendering and screenshot
transport, including execution with standard input redirected.
