---
title: Testing
description: Test apps headless, in Rust with cargo test and nsh_testing or in TypeScript with nsh test - open the app, press, type, scroll and wait like a user, stub the network and storage - and read the native view operations and timings --trace prints; testID for UI tests.
order: 61
group: tools
---

# Testing

NSH runs apps **headless**: the real engine (the same reactive graph, renderer, components, layout and list
virtualization as on a device, and QuickJS for TSX), with display frames at 60 Hz, but no simulator, no device and no
window. It runs anywhere Cargo or the CLI runs, including Linux CI machines, and does two jobs:

- it runs tests: each opens the app, takes the steps a user would (press, type, scroll), and checks what is on screen.
  A Rust app's tests are Rust, run by `cargo test` with the `nsh-testing` crate; tests written in TypeScript run with
  `nsh test`, for TSX apps and Rust apps alike;
- with `--trace`, it prints every operation the runtime sends to the native views, with timings: what the first
  frame, a tap or a frame of scrolling costs.

## Writing tests

The same test, in Rust and in TypeScript: it opens the app with an empty todo list in its storage, types, presses and
checks what the screen shows.

```rust tabs
// tests/app/main.rs
use nsh_engine::{EngineConfig, Root};
use nsh_testing::{Headless, MemoryStorage};

#[test]
fn adds_a_todo() {
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    config.storage = Some(MemoryStorage::new([("todos".to_owned(), "[]".to_owned())]));
    let mut app = Headless::start(config).unwrap();
    app.type_text("id:new-todo", "Buy milk").unwrap();
    app.press("text:Add").unwrap();
    app.wait_for("text:Buy milk").unwrap();
    assert!(app.screen().texts().contains(&"1 item left"));
}
```

```tsx tabs
// App.test.tsx
import { expect, open, test } from "nsh/test";

test("adds a todo", async () => {
  const app = await open("./App.tsx", { storage: { todos: "[]" } });
  await app.type("id:new-todo", "Buy milk");
  await app.press("text:Add");
  await app.waitFor("text:Buy milk");
  expect(app.texts()).toContain("1 item left");
});
```

## Tests in Rust with cargo test

A Rust app's tests are integration tests of its crate, with `nsh-engine` and `nsh-testing` (its default features,
without QuickJS) as dev-dependencies:

```toml
[dev-dependencies]
nsh-engine = "0.1"
nsh-testing = "0.1"
```

```sh
cargo test                    # every test of the crate
cargo test adds_a_todo        # the tests whose name contains "adds_a_todo"
```

`EngineConfig::new(root)` is a phone-sized engine (390×844 points) with nothing else set; its fields set what `open`'s
options set below: `storage` (`MemoryStorage::new(entries)`), `network` (`StubNetwork`, below), `viewport`,
`environment` (the appearance, the locale, reduced motion), `clock` (`Clock::manual(time)`, below).
`nsh_testing::Headless::start(config)` starts the app and keeps a model of the views it shows. Its steps are those of
`nsh test` below, with the same selectors, in Rust: `press`, `long_press`, `clear`, `type_text`, `submit`,
`scroll(selector, px(3000.0))`, `back`, `wait`, `wait_for`, `wait_for_gone`, `wait_until`, `run_for`, `fast_forward`,
`set_system_time`, `set_viewport`, `set_clipboard` and `on_dialog`; `app.shows(text)` and `app.screen()` (`texts()`,
`count(selector)`, `enabled(selector)`, `dialogs()`, `clipboard()`, `commands()`) read what is on screen. A step
returns an error with the texts on screen when it cannot be taken.

`nsh_testing::tsx(entry, sets)` (feature `bundle`) opens an app's TSX entry the same way, built against NSH's and the
crate's UI sets ([Building with Rust](./rust.md#testing)). `examples/gallery-rs` tests its Rust root this way, one
module per demo; `examples/rust-exports` tests its TSX entry from Rust.

`nsh test` runs these tests too: given the directory of an app with Rust crates (`nsh.json` `"rust"`), it runs
`cargo test` for each crate in it before the test files, and shows and counts the Rust tests with the TypeScript ones
(`✓ src/lib.rs › tests::adds`), in its summary and its `--junit` report. So `nsh test` is the one command for a Rust app,
a TSX app with a crate and a TSX app alike, and `nsh check` likewise runs `cargo check --all-targets` on the crates
before it type checks the TypeScript.

## Tests with nsh test

A test file is a `*.test.tsx` or `*.test.ts` file next to your code. It imports `nsh/test`, as `App.test.tsx` above
does:

```sh
nsh test                      # every test file of the app in the current directory
nsh test App.test.tsx         # one file
nsh test --filter "adds"      # the tests whose name contains "adds"
```

```text
✓ App.test.tsx › adds a todo (84ms)
✗ App.test.tsx › keeps todos after a restart (312ms)
    expected ["Todos","0 items left"] to contain "1 item left"
    at <anonymous> (App.test.tsx:21:22)
    on screen: "Todos", "0 items left"
error 2 tests: 1 passed, 1 failed (0.9s)
```

A failing test shows what was thrown, where in the test file, and the texts on screen of the app it opened. Any failure
makes `nsh test` exit with a non-zero code. `nsh init` creates an `App.test.tsx` with the app, and `nsh check` type
checks test files with the rest (`.nsh/types` declares `nsh/test`).

Each test file runs on an engine of its own, and its tests run one after the other, in order. `open` starts the app on
another engine, a fresh one each time, so tests never share state; the apps a test opened are closed when it ends. A
test fails when it throws, when the promise it returns rejects, and after its timeout: 30 seconds, or the milliseconds
`test`'s third argument gives (`test("syncs", body, 60_000)`). An app with Rust crates of its own
(`nsh.json` `"rust"`) runs its tests in a headless runner NSH builds with them, the same way; in a Rust app
(`nsh.json` `"root"`, [Building with Rust](./rust.md)), `open(".")` starts its root component.

### Grouping tests and setting them up

`describe`, the hooks and the variants of `test` work as Jest's:

```tsx
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("the cart", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("./App.tsx", { storage: { cart: "[]" } });
    await app.press("Cart");
  });

  test("starts empty", () => {
    expect(app.texts()).toContain("No items");
  });

  test.todo("applies a coupon");
});
```

| Function | Description |
|---|---|
| `describe(name, body)` | Groups the tests and blocks `body` declares (at once, as the file loads): their names start with `name` (`the cart › starts empty`), and the hooks it declares run around them only. Blocks nest. |
| `beforeEach(fn, timeout?)`, `afterEach(fn, timeout?)` | Run `fn` before / after each test of the block they are declared in (the file, a `describe`): `beforeEach` of the outer blocks first, `afterEach` of the inner ones first. A `beforeEach` that fails fails the test; `afterEach` runs either way. |
| `beforeAll(fn, timeout?)`, `afterAll(fn, timeout?)` | Run `fn` once before the first and after the last test of their block, when one of its tests runs. A `beforeAll` that fails fails the block's tests; an `afterAll` that fails is reported as a failed `<block> › afterAll`. An app a `beforeAll` opens stays open for the block's tests, and is closed after its `afterAll`. |
| `test.skip(name, body, timeout?)`, `describe.skip(name, body)` | Declares a test, or a block whose tests, do not run: they are reported as skipped. |
| `test.only(name, body, timeout?)`, `describe.only(name, body)` | While a test file has one, only those tests and blocks run; the file's others are reported as skipped. |
| `test.todo(name)` | A test still to write, reported as one. |

A hook may be `async`; its `timeout` is 30 seconds unless given. Tests and hooks are declared as the file loads: a
test declared inside a test or a hook throws.

### Opening the app

`open(entry, options?)` builds the app at `entry` (relative to the test file; each entry is built once per run),
starts it on a 390×844 viewport and resolves once it rendered and is quiet.

| Option | Default | Description |
|---|---|---|
| `storage` | empty | What `nsh/storage` holds at the start: `{ todos: "[]" }`. |
| `network` | none | What the app's requests get, by route: see [Stubbing the network](#stubbing-the-network). `"live"`: the real network. |
| `width`, `height` | 390, 844 | The viewport in points. |
| `safeArea` | 0 | The safe area insets in points: `{ top: 47, bottom: 34 }`. |
| `clipboard` | empty | The text on the clipboard at the start. |
| `colorScheme` | `"light"` | The system's appearance: `"light"` or `"dark"` (`colorScheme()`, `dark:` classes). |
| `locale` | `"en-US"` | The device's locale, a BCP 47 tag (`locale()`, `Intl`'s default). |
| `reducedMotion` | `false` | The user asked for less motion (`reduceMotion()`). |
| `platform` | `"ios"` | The platform the app runs as headless: `"ios"`, `"android"`, or a desktop's, `"macos"`, `"windows"`, `"linux"`, or `"web"` in the desktop idiom (`platform.os`, `ios={{…}}` / `android={{…}}` / `desktop={{…}}` props, keyboard shortcuts). On a real platform the app runs as that one. |
| `clock` | the system's | A manual clock, whose time moves only as the test moves it: `{}`, or `{ time }` to start at a `Date` (or milliseconds since the Unix epoch). See [Controlling time](#controlling-time). |
| `host` | none | The embedding app's part, which the test plays: `{ params, handlers }`. See [Playing the host app](#playing-the-host-app). |

### Playing the host app

An app embedded in a native app talks to it through [`nsh/host`](../modules/nsh-host.md). In a test, the test plays
the host app: `host.params` gives the launch parameters the app reads at start, and `host.handlers` answers the app's
`host.call` and hears its `host.post`, by name. A handler is a value, which answers every call, or a function of the
call's data that returns the answer (or a promise of it). What the function throws rejects the call, as a host app's
error does. A call of a name `handlers` does not list fails, as it does in a host app that handles none.

```tsx
const app = await open("./App.tsx", {
  host: {
    params: { conversation: "c-42" },
    handlers: {
      "user.profile": async ({ id }) => ({ id, name: "Ada" }),
      "feature.flags": { search: true },
      analytics: null,
    },
  },
});
await app.press("Profile");
expect(app.host.calls()).toEqual([{ name: "user.profile", data: { id: 7 } }]);
expect(app.host.posts()).toEqual([{ name: "analytics", data: { screen: "profile" } }]);
// The app's `host.on("conversation.open", …)` hears it.
await app.host.send("conversation.open", { id: "c-43" });
expect(app.shows("Conversation c-43")).toBe(true);
```

`app.host.send(name, data)` sends an event, then waits until the app is quiet. `app.host.calls()` and
`app.host.posts()` list what the handlers got, in order: `name` and `data`.

The URLs the app opens ([`openUrl`](../modules/nsh-device.md#openurl), a `TextView`'s links with `links="open"`) are
recorded and reported to the app as opened, and nothing opens on this machine. `app.openedUrls()` lists them:

```tsx
await app.press("Contact us");
expect(app.openedUrls()).toEqual(["mailto:help@example.com"]);
```

### Stubbing the network

`network` lists routes by `"<METHOD> <URL>"` (a bare URL is a `GET`; `*` matches any text). A request no route
matches fails, so tests never reach the network unasked. A route is a response, or a function of the request that
returns one (or a promise of one); in Rust, `StubNetwork::new(routes)` takes the same routes, each a `StubResponse` or
a `StubRoute::Handler`:

```rust tabs
use std::sync::Arc;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::{Headless, StubNetwork, StubResponse};

#[test]
fn adds_a_todo_on_the_server() {
    let mut todos = StubResponse::default();
    todos.status = 200;
    todos.headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    todos.body = br#"[{ "id": 1, "title": "Walk" }]"#.to_vec();
    let mut created = StubResponse::default();
    created.status = 201;
    let mut offline = StubResponse::default();
    offline.error = Some("offline".to_owned());
    let network = Arc::new(StubNetwork::new([
        ("GET https://api.example.com/todos".to_owned(), todos),
        ("POST https://api.example.com/todos".to_owned(), created),
        ("GET https://api.example.com/sync".to_owned(), offline),
    ]));
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    config.network = Some(network.clone());
    let mut app = Headless::start(config).unwrap();
    app.press("Add").unwrap();
    let methods: Vec<String> = network.requests().iter().map(|r| r.method.clone()).collect();
    assert_eq!(methods, ["GET", "POST"]);
}
```

```tsx tabs
const app = await open("./App.tsx", {
  network: {
    "GET https://api.example.com/todos": { body: [{ id: 1, title: "Walk" }] },
    "POST https://api.example.com/todos": (request) => ({ status: 201, body: JSON.parse(request.body!) }),
    "GET https://api.example.com/todos/*": { status: 404 },
    "GET https://api.example.com/sync": { error: "offline" },
    "GET https://api.example.com/slow": { body: "done", delay: 2000 },
  },
});
await app.press("Add");
expect(app.requests().map((r) => r.method)).toEqual(["GET", "POST"]);
```

| Response member | Default | Description |
|---|---|---|
| `status` | 200 | The status code. |
| `headers` | none | Header names and values. |
| `body` | empty | A string, or a value sent as JSON (with `content-type: application/json` unless `headers` name one). |
| `error` | none | The request fails with this message instead, as when the device is offline. |
| `delay` | 0 | How long the response takes, in milliseconds; a step does not wait for it, `waitFor` does. On a manual clock, it comes once the clock passes it. |

A route's function gets the request (`method`, `url`, `headers`, `body` as text) and runs in the test file, so it can
count requests or answer from what the test set up. A function that throws fails the request and the step that made
it. `app.requests()` lists the requests the app made, in order, the same way.

### Controlling time

On the system's clock, an app's timers and native animations take as long as on a device, and so do the tests that
wait for them. With a manual clock (`EngineConfig::clock` in Rust, `open`'s `clock` in TypeScript), the app runs on a
clock whose time moves only as the test moves it, and at once, as with Jest's fake timers or Playwright's
`page.clock`:

```rust tabs
use std::time::{Duration, SystemTime};
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn autosaves() {
    let mut config = EngineConfig::new(Root::of::<my_app::App>());
    // 2026-01-01T09:00:00Z
    config.clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_258_000));
    let mut app = Headless::start(config).unwrap();
    app.type_text("label:Note", "Milk").unwrap();
    app.run_for(Duration::from_secs(10)).unwrap(); // the autosave, ten seconds later
    assert!(app.shows("Saved at 09:00:10"));
}
```

```tsx tabs
const app = await open("./App.tsx", { clock: { time: new Date("2026-01-01T09:00:00Z") } });
await app.type("label:Note", "Milk");
await app.clock.runFor(10_000);            // the autosave, ten seconds later
expect(app.texts()).toContain("Saved at 09:00:10");
```

A `StubNetwork` whose responses have a `delay` follows a manual clock with `.with_clock(clock.clone())`. The steps below
are `nsh test`'s; `Headless` has each of them (`run_for`, `fast_forward`, `set_system_time`).

| Step | Description |
|---|---|
| `await app.clock.runFor(ms)` | Moves the clock by `ms` milliseconds, one display frame at a time. Timers, `requestAnimationFrame`, native animations and delayed responses run as they come due, in order, each at its time. Resolves once the app is quiet. |
| `await app.clock.fastForward(ms)` | Moves the clock by `ms` milliseconds at once, as a device waking from sleep does: the timers due meanwhile run once each. |
| `app.clock.setSystemTime(time)` | Sets the wall time (`Date.now()`, `new Date()`) to a `Date` or milliseconds, moving no timer. |

`Date`, `performance.now()` and `Intl`'s default date follow the clock. Steps finish what is running without waiting
for it: while the app asks for frames or a native animation runs, frames come one after another, each a frame's time
(1/60 s) later on the clock. A 300 ms transition takes a few milliseconds, and a timer due during it runs. `app.wait(ms)`
and a long press move the clock by their time. A timer that comes due later runs only when the test moves the clock
there. `waitFor`'s timeout stays real time, as it also waits for what comes from outside (a route's function, the
network). The gallery's tests run this way (`examples/gallery/tests`): its twelve tests that wait for animations
take 6 s instead of 28 s.

### Steps

Steps name views with **selectors**, written as Playwright's:

| Selector | Matches |
|---|---|
| `id:<testID>` | The view with that `testID`. |
| `label:<label>` | The view with that `accessibilityLabel`. |
| `text:<text>` | A text that reads it (spaces around it aside), a span of a text that takes presses (a nested `<Text onPress>`, a `TextView`'s link), or an input holding it or, while empty, with that placeholder. |
| `role:<role>`, `role:<role>[<name>]` | A view with that `role` (`role:button`), and that name: its label, else the texts in it (`role:button[Save]`). |
| `view:<id>` | The view with that id in `--trace` output. |
| anything else | A `testID`, else a label, else a text, as written. |

`label:`, `text:` and a role's name also take a regex: `text:/^Buy/i`. ` >> ` looks inside what the part before matched
(`id:cart >> role:button[Remove]`), and `nth=<n>` keeps one of the matches, from 0 (`text:Delete >> nth=1`). A
selector finds the views a user would look at first: in the top modal, then on screen, and of a navigation stack only
the top screen. It matches what the user sees: views with an area, outside `visibility: hidden`, inside the window and
the views that clip them (`overflow: hidden`), or anywhere in the content of a scroll view the user can scroll, which
scrolling brings in (`opacity` and transforms aside, as in Playwright). A step that acts on a view (`press`, `type`, `clear`, `submit`, `scroll`, `longPress`) needs exactly
one: a selector matching several fails the step, and the error says how to narrow it.

| Step | Description |
|---|---|
| `await app.press(selector)` | Presses the view, or the nearest view around it that hears presses (the button around a text): `onPressDown`, `onPressUp`, `onPress`, inside a finger going down and lifting, which the views around it that listen to touches hear (an overlay's `onPressOutside`). A span of a text is pressed on its characters (`await app.press("Privacy policy")`), headless and on iOS, Android and the desktops. Rejects when it is disabled. |
| `await app.longPress(selector)` | Holds a finger on it (or the nearest view around it that hears presses or touches) for its `delayLongPress` (500 ms): `onPressDown`, `onLongPress`, `onPressUp`; no `onPress` follows. The touches' handlers hear the finger (a `ContextMenu` or `Tooltip` opens). |
| `await app.clear(selector)` | Empties the input, as selecting all and deleting does. |
| `await app.type(selector, text)` | Types into the input (or the first input inside the view; `text:` also matches an input's text or placeholder) at the end of what it holds, key by key: it takes the focus, then each character is an `onKeyPress` and an `onChange`, within `maxLength`. A `\n` in a single-line input is the return key. |
| `await app.submit(selector)` | The return key in the input, as its `submitBehavior` says: `onSubmit` (and the focus leaves a single-line input), or a line break in a multiline one. |
| `await app.scroll(selector, distance)` | Drags the scroll view or list (the view, the one around it, or the first inside it) by `distance` points along its axis, 10 points per frame, within its content, as the user may (`scrollable`). Negative scrolls back. |
| `await app.hover(selector)` | Moves the mouse over the middle of the view: the views under it that it left hear `onHoverOut`, those it came over `onHoverIn` and take their `hover:` styles, and those listening hear `onHoverMove` with where it is. The desktops and the web at any width, a browser in the phone idiom included (headless: a desktop or `"web"` `platform`); an iOS or Android phone has no mouse: there it rejects. |
| `await app.rightClick(selector)` | The mouse's secondary button over the middle of the view: it, or the nearest view around it listening, hears `onContextMenu`. The desktops and the web (headless: a desktop `platform`); a phone has no mouse: there it rejects. |
| `await app.paste(selector, { text?, files?, uris? })` | Pastes into the input as the user does with that on the clipboard: it takes the focus and hears `onPaste` (`files` are paths whose bytes it gets as `File`s, `uris` `file:` URLs), then its text goes in as `pasteBehavior` says. Headless, on macOS and on iOS; the machine's clipboard stays as it was. |
| `app.menu()` | The actions of the context menu the app shows (`Menu.popup`): `label` (a submenu's after its own, `"Share > Mail"`), `disabled`, and `checked` for a checkable item; `null` when none is open. |
| `await app.chooseMenuItem(label)` | Chooses the open context menu's action, as a click on it does: the app hears `onMenu` (its `onSelect` runs), then the menu closes. Rejects when the item is disabled or missing. |
| `await app.closeMenu()` | Closes the open context menu with nothing chosen, as Escape does. |
| `await app.keyboard.press(keys)` | Presses a key with its modifiers, as `nsh/keymap` names it (`"mod+k"`, `"shift+/"`, `"escape"`; `mod` is the platform's command key), on a hardware keyboard, on every platform (phones and tablets have one too): the app's shortcut of it hears it (`keymap.bind`, `onKeyCommand`), else the focused input takes a character, Backspace or the return key, else Escape goes back. |
| `await app.drag(selector, { x, y })` | A finger lands on the middle of the view, rests for 100 ms, moves by `x`, `y` points, 10 per frame, and lifts, as the platform's input takes it: a pan follows it (`pan={{ x, y }}`, `onPanStart`, `onPanEnd` with the release velocity), the views listening to touches hear it (`onTouchStart`, `PanResponder`), a scroll view scrolls with it and, pulled far enough past its top, refreshes (`onRefresh`), and a press under it is cancelled once it moves away. On the desktops and the web it is the mouse. |
| `await app.wait(ms)` | Lets the app run for `ms` milliseconds: timers, animations, requests. On a manual clock, moves it by `ms` (`app.clock.runFor`). |
| `await app.waitFor(selector, options?)` | Resolves once a view matches, or with `{ state: "gone" }` once none does; rejects after `timeout` ms (5000). |
| `await app.waitUntil(condition, options?)` | Resolves once `condition()` returns true, looking again after each change of the app: for what no selector says (`() => app.storage().note === "Milk"`). |
| `app.shows(selector)` | Whether a view matches now. |
| `app.count(selector)` | How many views match now. |
| `app.enabled(selector)` | Whether the view takes input: neither it nor a view around it is disabled, and an input is not `readonly`. |
| `app.texts()` | The texts on screen now, in order. |
| `app.value(selector)` | The text of an input, `null` when none matches. |
| `app.spanStyle(selector)` | In headless tests, the first matched character’s resolved style: `color`, optional `backgroundColor`, `fontSize`, `fontWeight`, `italic`, `underline`, and `lineThrough`. Colors are `#rrggbbaa`; sizes are in points. |
| `app.storage()` | What the app's storage holds now. |
| `await app.back()` | Goes back as the user does (a header's back button, swiping a sheet down): the innermost stack of the newest modal, else of the screen, pops its top screen (`onDismiss`), or asks it (`onBackRequest`) when it has `preventBack`; without one, the newest modal asks to close (`onRequestClose`). Rejects when there is nothing to go back from. |
| `app.onDialog(handler)` | Answers the dialogs the app shows from now on (`Alert.alert`, action sheets): `handler` gets the dialog (`title`, `message`, `buttons`, `cancelable`, `sheet`) and returns the text of the button to press, or `null` to close it without one. |
| `app.dialogs()` | The dialogs the app showed, in order. |
| `app.onPick(handler)` | Answers the picks the app asks for from now on (`Picker.pickImages`): `handler` gets what the pick asks (`multiple`, `limit`, `maxDimension`, `quality`, `format`) and returns the files the user picks (`{ name, type?, data: Uint8Array }`, given to the app as they are), or `null` to cancel. Without a handler, picks are cancelled. Headless runs. |
| `app.picks()` | The picks the app asked for, in order. |
| `app.clipboard()` | The text on the clipboard now, `null` when it holds none. |
| `app.requests()` | The requests the app made, in order: `method`, `url`, `headers`, `body`. |
| `await app.host.send(name, data?)` | Sends an event of the host app's to the app (`host.on`), then waits until it is quiet. See [Playing the host app](#playing-the-host-app). |
| `app.host.calls()`, `app.host.posts()` | The app's calls and posts that `open`'s `host.handlers` got, in order: `name`, `data`. |
| `app.openedUrls()` | The URLs the app opened (`openUrl`), in order: recorded, never opened. |
| `await app.setViewport(width, height)` | Resizes the viewport, as rotating the device or resizing a window does (`windowSize()`). |
| `await app.setColorScheme(scheme)` | Switches the system's appearance to `"light"` or `"dark"`, as the user does. |
| `await app.screenshot(path?)` | A picture of the app's window as a PNG (a `Uint8Array`), also saved at `path` on this machine when given (relative to the current directory). Only a real platform draws the app: see [On a real platform](#on-a-real-platform). |

A step resolves once the app rendered nothing for 100 ms and no native animation runs (2 s at most, for apps that
render all the time; on a manual clock, also 2 s of the app's time), so what it changed is on screen when the next
line runs; use `waitFor` for what comes later (a
response, a timer). A step rejects, failing the test, when nothing matches its selector (the error lists the texts on
screen), when the app threw an exception meanwhile, and when the app asked for what only a real platform answers.

`app.spanStyle("id:guide")` reads a nested `<Text testID="guide">`; `text:word` reads the first character
of that match. Scope queries with `id:note >> text:word` and select repeated matches with `>> nth=0`.
The query reports an error for a missing, ambiguous or empty span. Updating a span’s `testID` reuses its text
layout and preserves the `onTextLayout` callback count.

### What headless runs play of the platform

A headless run has the real runtime and no platform. It plays the platform's part NSH's protocol defines, and nothing
that only a real platform can do:

- **Native animations run** frame by frame, to their end: `start(callback)` callbacks run, and so does what waits for
  them.
- **Going back** pops screens and closes modals as a platform does (`app.back()`).
- **Dialogs are answered**: by the test's `onDialog`, else by their cancel button, else they are closed when they can
  be; a dialog that only its other buttons answer fails the step that showed it until the test says which to press.
- **The clipboard holds text**: what the app copies, read back when it pastes (`clipboard` to start with some).
- **The page's host answers `nsh/host`** when the app's `nsh.json` names one in `web.host` ([The page's
  host](#the-pages-host)).
- **The app runs under its capabilities**: what its `nsh.json` declares in `capabilities` is enforced as on a device,
  so what it does not declare is refused.
- **URLs are recorded**: what the app opens is reported opened, and `app.openedUrls()` lists it.
- **Picks are answered**: with the test's files (`onPick`), else cancelled, so `Picker.pickImages` resolves `[]`.
- **Modals show at once**: `onShow` comes when one is presented.
- **Images are not loaded**: no `onLoad` or `onError` comes, and `Image.getSize` and `Image.prefetch` reject.
- **What only a real platform answers fails the step**: an image or files on the clipboard.

### The page's host

An app published to the web gets its host from its page: `nsh.json` `web.host`, a module exporting
`createHost(player)` ([Web](./web.md#the-hosts-functions)). Headless runs load that module for each app a test opens,
before the app starts, in a JavaScript context of its own (timers and `console`, nothing of the browser's, no
imports): its `call` answers the app's [`host.call`](../modules/nsh-host.md), its `player.hostEvent` reaches
`host.on`, and `host.available()` is `true`. A `call` that throws, rejects or returns what is not JSON rejects the
app's call with its message, as on the page, and events sent before the app starts reach its top-level listeners
once it does. `--web-host <module>` names another module. The app's `capabilities.host` must list what it calls, as on
the page. A call's timeout and the host's own timers run on the app's time, so a manual clock moves them
(`app.clock.runFor`). In a browser (`--target web`) the development page runs `nsh.json`'s `web.host` for each app as a
published page does; on the other platforms (`--target`) the apps have no host: `host.available()` is `false`.

```tsx
// nsh.json: { "capabilities": { "host": ["echo"] }, "web": { "host": "./host.js" } }
import { open, test } from "nsh/test";

test("calls reach the page's host", async () => {
  const app = await open("./App.tsx");
  await app.press("label:call");
  await app.waitFor('text:{"n":1}');
});
```

`examples/host-echo` has an app, its host and their tests.

### Expectations

`expect(value)` compares values as JSON does (`undefined` is `null`, numbers by value), and each check throws when it
does not hold. `.not` turns them around: `expect(app.texts()).not.toContain("Error")`.

| Check | Holds when |
|---|---|
| `toBe(expected)`, `toEqual(expected)` | The value equals `expected`, member by member. |
| `toContain(item)` | An array holds `item`, or a string contains it. |
| `toBeTruthy()`, `toBeFalsy()` | The value is truthy / falsy, as JS sees it. |
| `toMatch(pattern)` | A string contains `pattern` (a string), or matches it (a `RegExp`). |
| `toHaveLength(n)` | An array has `n` items, or a string `n` UTF-16 units. |
| `toBeNull()` | The value is `null` (or `undefined`). |
| `toBeGreaterThan(n)`, `toBeGreaterThanOrEqual(n)`, `toBeLessThan(n)`, `toBeLessThanOrEqual(n)` | A number compares so with `n`. |
| `toThrow(message?)` | `expect(fn)`: calling `fn` throws, with a message matching `message` when given. |
| `rejects.toThrow(message?)` | `expect(fn)`: the promise `fn` returns rejects: `await expect(() => app.press("Pay")).rejects.toThrow("is disabled")`. |

### On a real platform

`nsh test --target macos` (or `linux`, `windows`, `gpui`, `web`, `ios`, `android`) runs the same tests on the platform's development host instead of headless:
each `open` starts the app in a window of its own, with a fresh data directory, and the steps act with the platform's
own input at the views their selectors name, as Playwright does in a browser:

- a press is a click at the view's middle, a long press a held click, `type` clicks the input and types its keys,
  `scroll` is a trackpad gesture over the scroll view, `back` is what a user does (Escape on macOS and Linux, the mouse's
  back button on Windows and in GPUI, the browser's back button on the web, a sheet swiped down, VoiceOver's escape
  gesture while a menu, popover or `Sheet` is open, else the header's back button on iOS, the back button on Android);
- a view off screen is scrolled into view first, a gesture at a time;
- selectors, waits and queries see the same model of the app as headless runs, built from what the host draws, so
  they find the same views;
- dialogs are the platform's own: `app.dialogs()` reads them, and answering one (`onDialog`, or its cancel button
  when the test says nothing) presses its button;
- `app.screenshot(path)` takes a picture of the window.

```sh
nsh test --target macos                       # the app's tests in macOS windows
nsh test --target linux                       # in GTK windows (xvfb-run -a … on a machine without a display)
nsh test --target windows                     # in Win32 windows
nsh test --target ios                         # in an iOS simulator
nsh test --target android                     # on the Android device or emulator adb lists first
nsh test --target gpui                        # in GPUI windows (macOS, Windows, Linux)
nsh test --target web                         # in a headless Chrome, Edge or Chromium
nsh test tests/form.test.tsx --target macos   # one file
```

The window opens at the viewport's size (390 × 844 unless `open` says), within the screen. A manual `clock` works as
it does headless: `app.clock.runFor`, `fastForward` and `setSystemTime` move the app's time at once (timers,
`requestAnimationFrame` a frame apart, `Date`), `app.wait(ms)` moves it too, and each frame the platform shows moves
it a frame (1/60 s), so the app's time passes while it animates. The platform's own animations, and a route's
`delay`, take real time. The app's requests come to the test as they do headless: `network` routes answer them,
a request no route matches fails, and `"live"` lets them through to the host's network; `app.requests()` lists them
all. `storage` is in the app's storage when it starts, and `app.storage()` reads it from the app. `locale`,
`reducedMotion` and `safeArea` hold whatever the platform reports, and the app's clipboard calls are served from the
test's own clipboard (`clipboard` is its text at first, `app.clipboard()` reads it), so the machine's clipboard stays
as it was; a text input's own copy and paste use the system's. `host.params` reaches the app, `app.host.send` sends
events, and the URLs the app opens are recorded for `app.openedUrls()` instead of being opened. `host.handlers` runs
headless: the development host answers no calls, and `open` rejects handlers there. An app with Rust crates of its own runs in a development host built with its crates, which NSH
builds for the platform; a Rust app's host runs its root, so `open(".")` starts it there as it does headless.

On the web, the apps run in the development host's page in a headless Chrome, Edge or Chromium: the one installed
on this machine, or the executable `--browser <PATH>` names (a browser is needed: `nsh test` says where it looked
when it finds none). One browser serves the run, and each `open` gets a page with storage of its own. The input is
the browser's trusted input, as a user's: mouse clicks, wheel scrolling and keys.

On iOS, the apps run in the development host in an iOS simulator: the booted one, else the newest iPhone, which
`nsh test` boots. The steps are a finger's touches and the software keyboard's typing, as UIKit gets them from the
device. `setColorScheme` switches the simulator's appearance, which `nsh test` sets back after the app, and the screen
has the simulated device's size.

On Android, the apps run in the development host on the first device or emulator `adb devices` lists, with storage
of their own. The steps are a finger's touches and a keyboard's keys, as the app's views get them from the device;
`back` is the system's back. `setColorScheme` switches the device's dark theme, which `nsh test` sets back after the
app.

### Steps from standard input

Given the app's entry instead of tests, `nsh test` opens the app on the real network, lets it run for 1.2 s, then takes
the steps standard input gives, with `app` the app:

```sh
echo 'await app.press("text:+1"); expect(app.texts()).toContain("1");' | nsh test App.tsx
```

The 1.2 s let the engine's idle garbage collection run before the first step, so an app that lets go of what it still
uses shows it: its handlers stop working.

The examples have tests to start from: `examples/gallery-rs` for a Rust app (`cargo test`, one module per demo, and
`App.test.tsx`), `examples/rust-exports` for an app with a Rust crate, `examples/counter` and `examples/gallery/tests`
(storage, inputs, a long list, stubbed requests, dark mode, a manual clock) for TSX apps.

## Tracing with --trace

`--trace` prints every mount batch of the apps the tests open, under the step it came in, and the time of every
commit. In Rust, a test prints the same: `observe` hands it each batch with its step, and `EngineConfig::trace` logs
the `perf` lines through the `log` crate (target `nsh::perf`; install a logger such as `env_logger` in the test):

```rust
let mut config = EngineConfig::new(Root::of::<my_app::App>());
config.trace = true;
let mut app = Headless::start(config).unwrap();
app.observe(|step, batch| nsh_testing::print_batch(&mut std::io::stdout(), step, batch));
app.press("Add").unwrap();
```

`nsh test` takes `--trace` on a test file, or on the app's entry with the steps on standard input:

```sh
nsh test App.test.tsx --trace
nsh test App.tsx --trace                                   # the first frame, then 1.2 s idle
echo 'await app.press("Add")' | nsh test App.tsx --trace    # and a press
echo 'await app.press("Add")' | nsh test App.tsx --trace --target ios   # the same in an iOS simulator
```

With `--target`, the trace is the platform's: the batches the host applied, under the steps that brought them, and
the host's own timings of each commit and event, on the device's hardware.

Use it to:

- check that an app (or a demo) builds, evaluates and renders without errors;
- see exactly which native views a change creates, moves or updates, and how many;
- measure the cost of the first frame, of a tap and of each scrolling frame;
- catch regressions in CI.

### Reading the output

Here is the counter example with one press (`echo 'await app.press("+1")' | nsh test examples/counter/App.tsx
--trace`), shortened:

```text
✓ bundled App.tsx (3255 B in 6.2 ms)
perf commit: 56 ops, 271µs (list js 5µs), 49 mount items, 21 nodes
perf first frame: eval 187µs, total 820µs
── open(App.tsx): 49 items
   LayoutDirection { rtl: false }
   Create { id: 2, kind: View }
   Create { id: 4, kind: Text }
   Insert { parent: 2, child: 4, before: None }
   ...
   Frame { id: 2, x: 0, y: 0, w: 390, h: 844 }
   Frame { id: 4, x: 24, y: 64, w: 342, h: 34 }
   ...
   Text { id: 4, text: "nsh counter", content: 342x34 @ 0,0 }
   Text { id: 14, text: "0", content: 36x77 @ 0,0 }
perf event Press on view 26
perf event js: 413µs
perf commit: 10 ops, 672µs (list js 7µs), 7 mount items, 24 nodes
── press(+1): 7 items
   Create { id: 42, kind: Text }
   Insert { parent: 32, child: 42, before: None }
   Frame { id: 32, x: 24, y: 366, w: 342, h: 43 }
   Frame { id: 42, x: 0, y: 23, w: 342, h: 20 }
   Text { id: 14, text: "1", content: 36x77 @ 0,0 }
   Text { id: 42, text: "• 1", content: 342x20 @ 0,0 }
   Text { id: 34, text: "Recent values: 1", content: 342x17 @ 0,0 }
✓ App.tsx › steps (1.4s)
```

#### Batches and mount items

Each `── step: N items` block is one **mount batch**, under the step it came in: everything the platform applies to native views for one frame,
in one hop to the main thread. The lines in it are **mount items**:

| Item | Meaning |
|---|---|
| `Create { id, kind }` | Create a native view (`View`, `Text`, `Image`, `Scroll`, ...). |
| `Insert { parent, child, before }` | Put a view into its parent, before a sibling (`None`: at the end). |
| `Remove` / `Delete` | Detach a view from its parent / free it. |
| `ViewStyle { id, style }` | The view's decoration: background, borders, radius, shadow, opacity, transform, ... |
| `ViewProps { id, props }` | Touch and accessibility settings, `testID`. |
| `Events { id, events }` | Which events the view reports (`EventMask(1)` is press). |
| `Frame { id, x, y, w, h }` | Its position and size in its parent, in points. |
| `Text { id, text, content }` | Laid-out text for a text view. |
| `Image { id, source, ... }` | An image to load. |

Only what changed is sent: a tap that changes one number sends one `Text` item; views get no default style and no empty
event mask; unchanged frames are not sent. A frame of scrolling that reveals no new row produces **no batch at all**.

#### The `perf` lines

| Line | Meaning |
|---|---|
| `✓ bundled App.tsx (3255 B in 14.3 ms)` | Bundling time and bundle size (development settings). |
| `commit: 56 ops, 395µs (list js 6µs), 49 mount items, 21 nodes` | One commit: the operations JS queued, the time the core spent (rendering components, laying out, diffing), JS time spent binding list rows, the mount items produced, and the nodes alive. |
| `turn: 2640µs (timers and tasks 1964µs)` | A turn that committed: its whole time, and what its JS timers and Rust component tasks took before the commit (a Rust component renders in the commit). |
| `first frame: eval 271µs, total 1235µs` | Time to evaluate the bundle, and from start to the first batch. |
| `event Press on view 20` / `event js: 196µs` | An event dispatched, and the time its handler (and what it caused) took in JS. |

> [!NOTE]
> Text is measured with an approximate text engine headless, so text sizes differ a little from a device, which uses
> CoreText or Android's text layout. Layout logic, view counts and operation counts are the same.

Single-run timings depend a lot on the CPU's clock state (a machine that just woke from idle is slow). Compare runs on
the same machine, look at the minimum of several runs, and trust the op and item counts more than the microseconds.

### Scrolling

```rust
app.scroll("id:photos", px(3000.0)).unwrap();
```

```sh
echo 'await app.scroll("id:photos", 3000)' | nsh test examples/gallery/Bench.tsx --trace
```

`scroll` moves the list 10 points per frame, at 60 frames a second, and each frame's batch is printed:

```text
perf commit: 55 ops, 1667µs (list js 771µs), 46 mount items, 414 nodes
── scroll(id:photos, 3000): 46 items
   Create { id: 792, kind: View }
   Insert { parent: 94, child: 792, before: None }
   ...
```

For a [list](./lists.md), this shows the virtualization at work: which frames bind new rows, how many operations a row
costs, and that frames revealing no new row produce nothing. Use it with a release build (`cargo test --release`, or `./target/release/nsh` in a checkout) for meaningful
timings.

### In CI

Headless tests need no device or display, so they run on Linux runners: `cargo test` for a Rust app's tests, and
`nsh test`, which needs nothing but the CLI. Any failing test makes either exit with a non-zero code: a test that
fails, an app that does not build or renders nothing, an exception the app throws during a step.

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test                            # a Rust app's tests
      - run: nsh test --junit test-results.xml     # its TypeScript tests, or a TSX app's
```

(Install the `nsh` CLI on the runner the way you install it locally; see [Installation](./installation.md).)

`--junit <FILE>` also writes the results as a JUnit XML report, which CI services (GitHub Actions test reporters,
GitLab, Jenkins, Azure Pipelines) show per test: a `testsuite` per test file, a `testcase` per test, with what failed,
where, and the texts on screen.

To guard performance, record the item counts of a few interactions (the `── … : N items` lines and the `ops` /
`mount items` numbers of `--trace`) and fail when they grow. Counts are deterministic; timings on shared CI machines
are not.

> [!NOTE]
> Tests run under the `capabilities` the app's `nsh.json` declares, as on a device: what the app does not declare is
> refused in the test too.

## `testID` for UI tests

Headless tests check what the runtime renders, and their `id:` selectors find views by test id. To drive the real
native UI with the platform's test tools (XCUITest, Espresso / UI Automator, Appium, Maestro), give views a test id:
`.test_id(…)` in Rust, `testID` in TSX:

```rust tabs
view()
    .test_id("add-to-cart")
    .p_3()
    .on_press(add)
    .child(text(move || format!("{} items", count.get())).test_id("cart-count"))
```

```tsx tabs
<View testID="add-to-cart" onPress={add} style={{ padding: 12 }}>
  <Text testID="cart-count">{`${count()} items`}</Text>
</View>
```

| Platform | Where `testID` goes |
|---|---|
| iOS | The view's `accessibilityIdentifier` (`app.otherElements["add-to-cart"]` in XCUITest). |
| Android | The accessibility node's view id resource name (`By.res("add-to-cart")` in UI Automator). |

The test id is a method of every element in Rust, and `testID` a prop of every element and of every Rust component (`SafeAreaView`, `KeyboardAvoidingView`, ...). It does not change what screen readers
say; use `accessibilityLabel` for that (see [Accessibility](./accessibility.md)). In `--trace` output it appears in
the view's `ViewProps` item as `test_id: Some("add-to-cart")`.

## See also

- [Performance](./performance.md): what to look for in these numbers
- [Dev server and debugging](./dev-server-and-debugging.md)
- [Architecture](./architecture.md): ops, commits and mount batches
