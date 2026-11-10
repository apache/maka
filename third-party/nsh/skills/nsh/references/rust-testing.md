# Testing a Rust app

Read [rust.md](rust.md) first. A Rust app has two test surfaces that share one driver and one selector syntax:

| | `cargo test` | `nsh test` |
|---|---|---|
| Written in | Rust, `nsh_testing::Headless` | TypeScript, `nsh/test`, `open(".")` |
| Runs | Your crate on the real engine, no window | `cargo test` for each crate first, then every `*.test.tsx`, headless |
| Use for | Logic and flows, most tests | Picking a test up on a platform with `--target`, screenshots |

Default to `cargo test`. It is compiled with the app, so a renamed prop is a compile error. Use `nsh test` as the one
command to run everything, and write `*.test.tsx` when a flow must run on a real platform, since `--target` runs those
files. The repository's `examples/gallery-rs` has one `*.test.tsx` per demo; `crates/nsh-base/tests/base` has hundreds of
Rust ones.

## cargo test with Headless

Add `nsh-engine` and `nsh-testing` under `[dev-dependencies]` using the same
version requirement and source as the project’s existing `nsh-core` dependency.
For a workspace dependency, reuse its workspace entry; for a path or Git dependency,
use the corresponding crates from that same checkout or revision. Inspect
`Cargo.toml` (and its workspace manifest) first; do not copy a release number from
this guide. Keep `default-features = false` on both for headless Rust-only tests.

Reuse these dev-dependencies if the project already declares them.

A test goes in `tests/app.rs`, or in a `#[cfg(test)]` module of the crate.

```rust
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

fn start() -> Headless {
    Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap()
}

#[test]
fn a_tap_counts() -> Result<(), String> {
    let mut app = start();
    app.wait_for("Count: 0")?;
    app.press("Tap")?;
    app.wait_for("Count: 1")?;
    assert!(app.shows("Count: 1"));
    Ok(())
}
```

- `Root::of::<App>()` needs the component's root; a `#[component]` with props uses `Root::new::<C>(|| props)`.
- Steps return `Result<(), String>`. When a step cannot be taken, the error lists the texts on screen. Return `Result` from
  the test, or `.unwrap()`; do not swallow it.
- `Headless` runs the real engine with display frames at 60 Hz, so timers, tasks and animations run as on screen. A manual
  clock (below) is the way to skip waiting.

### EngineConfig

`EngineConfig::new(root)` is a 390×844 phone-sized engine with nothing else: no network, no assets, no data directory. It
has no `Default`. Set what matters with struct update syntax:

```rust
use std::{sync::Arc, time::{Duration, SystemTime}};

use nsh_engine::{Clock, ColorScheme, EngineConfig, Environment, Points, Root, Size};
use nsh_testing::{Headless, MemoryStorage, StubNetwork, StubResponse};

fn configured() -> Headless {
    // `#[non_exhaustive]`: start from `default()` and set fields.
    let mut response = StubResponse::default();
    response.status = 200;
    response.body = b"[]".to_vec();
    response.delay = Duration::from_millis(50);
    let network = StubNetwork::new([(
        "GET https://api.example.com/todos".to_owned(),
        response,
    )]);
    let environment = Environment { color_scheme: ColorScheme::Dark, ..Environment::default() };
    Headless::start(EngineConfig {
        viewport: Size::new(Points(1200.0), Points(800.0)),
        environment,
        network: Some(Arc::new(network)),
        storage: Some(MemoryStorage::new([("todos".to_owned(), "[]".to_owned())])),
        clock: Clock::manual(SystemTime::UNIX_EPOCH),
        ..EngineConfig::new(Root::of::<my_app::App>())
    })
    .unwrap()
}
```

| Field | For |
|---|---|
| `viewport` | The window. Test the desktop layout by making it wide; `app.set_viewport(..)` changes it mid-test |
| `environment` | `color_scheme`, `safe_area`, `reduce_motion`, `font_scale`, `rtl`, `keyboard_height`. `app.set_environment(..)` changes it |
| `network` | A `StubNetwork`. Routes are `"<METHOD> <URL>"`, a bare URL is a `GET`, the URL matches whole with its query, and `*` matches anything |
| `storage` | `MemoryStorage::new(entries)`: start with saved state and assert persistence |
| `clock` | `Clock::manual(time)`: time moves only when the test moves it, with `app.run_for(d)` and `app.fast_forward(d)` |
| `ui_sets` | Only for TSX entries. A Rust root does not need them |

Stub the network in every test that reaches it. With `network` unset, a `fetch` fails.

### Selectors

The selector syntax is in `crates/nsh-testing/src/selector.rs`.

| Selector | Matches |
|---|---|
| `Save` | A test id, else a label, else a text, as written |
| `id:row-3` | `.test_id("row-3")` |
| `label:Close` | `.label("Close")` or `.accessibility_label("Close")` |
| `text:Save`, `text:/^Saved/i` | A text, an input holding it, or an empty input with that placeholder |
| `role:button`, `role:button[Save]` | A view by role, and its name |
| `view:42` | A node id, as `--trace` prints it |
| `id:list >> text:Row 3` | Look inside what the part before matched |
| `role:button >> nth=1` or `text:Add >> nth=0` | One of several matches |

A word and a colon at the start is taken as a prefix, and an unknown prefix is an error. So a text such as `Total: 5` is
written `text:Total: 5`. Prefer `.test_id(..)` for repeated or translated things, and a label or text for what a user
reads, which also tests that it is there. `.test_id` takes a `&str` fixed at build time, so in a recycled cell it stays with
the cell. Select by text there.

### Steps

| Step | Does |
|---|---|
| `press(sel)`, `long_press(sel)`, `press_at(sel, point)` | As a tap: press down, up, press, inside a finger's touch |
| `type_text(sel, "text")` | Focuses, then a key and a change per character, at the end of the text. A line break in a single-line input is the return key |
| `clear(sel)`, `submit(sel)` | Empties an input; the return key |
| `press_key("cmd-k")`, `hold_keys(keys, down)` | The keymap |
| `scroll(sel, px(3000.0))` | Scrolls the view, and lists bind the rows they reach |
| `hover(sel)`, `right_click(sel)`, `drag(sel, by)` | Pointer |
| `back()` | Pops a screen or closes a modal, as a platform does |
| `wait_for(sel)`, `wait_for_within(sel, d)`, `wait_for_gone(sel, d)` | Until a view matches, or until none does |
| `wait_until(what, timeout, \|screen\| ..)` | Until any condition on the screen |
| `wait(d)` | Real time. Avoid it |
| `run_for(d)`, `fast_forward(d)` | Moves a manual clock; an error without one |
| `on_dialog(\|d\| answer)` | Answers system dialogs for the rest of the test |

Steps wait until the app is quiet, so do not sleep between them. Wait with `wait_for` for what a task produces.

```rust
use nsh_engine::{EngineConfig, Root};
use nsh_testing::{DialogAnswer, Headless};

#[test]
fn adds_and_deletes_a_todo() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
    app.type_text("text:New todo", "Buy milk")?;
    app.submit("text:Buy milk")?;
    app.wait_for("Buy milk")?;
    assert_eq!(app.screen().count("role:checkbox")?, 1);
    assert!(app.screen().enabled("Clear done")?);

    // Press the alert's button by its text. Without this, its cancel button is pressed.
    app.on_dialog(|_dialog| DialogAnswer::Press("Delete".to_owned()));
    app.press("label:Delete Buy milk")?;
    app.wait_for_gone("Buy milk", std::time::Duration::from_secs(1))?;
    Ok(())
}
```

### app.screen()

`app.screen()` is the driver's model of what is shown. Read from it instead of keeping state in the test:

- `texts()`: every text on screen, in order. Print it when a test fails.
- `shows(text)`, `matches(sel)`, `count(sel)`, `enabled(sel)`, `selected(sel)`, `input_text(sel)`,
  `accessibility_state(sel)`.
- `dialogs()`, `clipboard()`, `opened_urls()`, `picks()`, `file_requests()`: what the app asked the platform for.
- `commands()`, `sent(&command)`: commands sent to views (focus, scroll).

Assert on what a user sees. Do not export signals from the app so that a test can read them.

### Testing pieces without the whole app

Plain domain types need no engine: test them as ordinary Rust. To test one component with chosen props, write a small
`#[component]` in the test module that places it and shows its events as text. `crates/nsh-base/tests/base/menu.rs` and
`select.rs` work this way: a view with a text line per signal (`format!("sort:{}", sort.get())`), asserted with `wait_for`.

## What headless does not prove

A headless run has the real runtime and no platform. A green `cargo test` proves the state, the structure, the wiring and
the texts. It does not prove:

- **Anything visual.** Colors, spacing, clipping, z-order, fonts, and whether an unstyled part is visible at all. A `switch()`
  with no `track_style` passes every behavioral test while drawing nothing.
- **Images.** They are not loaded: `on_load` and `on_error` never come, and `image_size` and `prefetch_image` reject.
- **Native input.** IME composition, real keyboards, the keyboard's animation, gesture recognition, swipe back, and what a
  press hits when something covers the view.
- **Native presentation.** Modals show at once, dialogs are answered by the driver, and the header is not a real system bar.
- **Performance.** Use `nsh test nsh.json --trace` for what is mounted and the time per commit; on a device for frame rates.

Layout is computed by the real layout engine, but on the headless text measure, so do not assert exact text widths.

## nsh test with open(".")

`nsh init --template rust` writes an `App.test.tsx`. It runs in a headless runner built with your crate, where
`open(".")` starts the root that `nsh.json` names. This is TypeScript, and the app under test is still pure Rust.

```tsx
import { expect, open, test } from "nsh/test";

test("counts taps", async () => {
  const app = await open(".");
  await app.press("Tap");
  expect(app.texts()).toContain("Count: 1");
});
```

```sh
nsh test                       # cargo test for each crate, then every test file
nsh test --filter "counts"     # by name
nsh test nsh.json --trace      # headless: what the root mounts, and the time of each commit
```

`open` options include `width`, `height`, `safeArea`, `colorScheme`, `locale`, `reducedMotion`, `platform`, `storage`,
`network`, `clock`. Headless, `platform` defaults to `"ios"`, so `platform: "macos"` tests a desktop idiom. All steps and
options: `website/docs/testing-and-trace.md`.

## Platform runs

`--target` runs the same `*.test.tsx` files on the platform's development host, with real input at the views the selectors
name. `nsh test --target` skips the Rust tests and says so, so a flow that must be checked on a device needs a `.test.tsx`.

```sh
nsh test --target macos      # also linux (xvfb-run -a on a machine without a display), windows, gpui
nsh test --target ios        # an iOS simulator
nsh test --target android    # the first device or emulator adb lists
nsh test --target web        # headless Chrome, Edge or Chromium
nsh test --target tui        # an in-memory terminal, suited to CI
nsh test form.test.tsx --target macos    # one file
```

An `open` option that the target cannot honor (`width` on iOS) rejects with `ERR_NSH_TEST_UNSUPPORTED`. Do not pass them in
a test meant for every target.

## Screenshots

`await app.screenshot("out/settings.png")` returns a PNG of the window on graphical targets, and cell JSON on `tui`. It is
TypeScript-only: `Headless` has no screenshot step, and in a headless `open` it fails because nothing draws the app. Use it
with `--target`.

Look at the picture: it is the only check here of the appearance. For a visual change, take one in light and dark, and on a
phone and a desktop width.

## What to cover

For each feature, at least:

- **The main flow**, end to end through the UI: open, act, see the result.
- **Each state a user can reach**: empty, loading, error (a `StubResponse` with `status: 500`, and one with `error: Some(..)`
  for offline), populated.
- **Stale results**: a stub with `delay` on the first response, a second request, and an assertion that the later answer
  stays. The cases in [rust.md](rust.md#stale-results) break silently otherwise.
- **Persistence**: `MemoryStorage` seeded and read back after an action.
- **Back**: `app.back()` on a pushed page, then assert that the route left and the page below kept its state. A missing
  `.on_dismiss` shows up here.
- **Recycling**: for a `virtual_list`, `scroll` far enough to reuse cells, then assert that the rows show the right data. A
  value read once outside a binding passes without this.
- **Width**: when the app has a phone and a desktop layout, run both with `viewport`.
- **Dialogs**: answer each button with `on_dialog`, including cancel.

Name tests for behavior (`a_tap_counts`), one flow per test. Each `Headless::start` is a fresh engine, so tests share
nothing and run in parallel. Do not assert on animation frames or a fixed sleep; assert on the end state.
