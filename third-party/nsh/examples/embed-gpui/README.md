# NSH + GPUI Kit (embed-gpui)

A GPUI Kit app embedding NSH apps (`nsh_platform_gpui::AppView`): a sidebar, an input, buttons and a dialog of GPUI
Kit around two order tickets in a resizable split, each running `app/` in its own engine. Each pane's GPUI Kit title
bar names its ticket (the app shows no heading of its own) with the desk's symbol and orders, and closes it. The
host's theme and light or dark mode reach the surfaces on every change (`src/theme.rs`), Tab moves through the host's
widgets and the surfaces' fields, GPUI Kit's dialogs and notifications draw above the surfaces, and closing a pane
drops its view, which stops its engine. "Violet theme" loads `themes/violet.json`, a GPUI Kit theme file, into GPUI Kit's
theme registry, and the surfaces take it as shadcn/ui's tokens.

```sh
cargo run                              # in examples/embed-gpui
cargo run -p example-embed-gpui        # from the repository's root
```

`build.rs` bundles and compiles `app/` as `nsh build` does (with NSH's own modules and UI set), so `cargo run` builds
the app with the host and rebuilds it when a file under `app/` changes. Everything the host provides, it connects by
name when it runs the app.

- **The host's functions.** `src/trading.rs` is the host's paper-trading desk (sample prices; no order leaves the
  process), registered as the UI set `host/trading` with `set_ui_sets`, next to NSH's `nsh/base`. The app
  declares its type and reaches it with `nativeModule<{ Trading: TradingApi }>("host/trading")`: `Trading.quote`,
  `Trading.select` and `Trading.placeOrder` run in Rust in the call (a wrong order throws, and the ticket shows the
  message), `Trading.on("change", …)` listens to the desk and returns a function that stops it.
- **One desk, both ways.** The desk (the selected symbol, the orders, the positions) lives once, in the host, in a
  `tokio::sync::watch` channel. Each ticket listens (`Trading.on("change", …)`): the task `on` starts posts the desk
  to the ticket's listener now and after every change. The host's sidebar (the watchlist, the orders of all tickets) and toolbar (the
  positions) follow the same channel, and the sidebar's watchlist and the input (Enter) select a symbol on it. So an
  order placed in Ticket A shows in the host and in Ticket B, a symbol picked in the host shows in both tickets, and
  one picked in a ticket shows in the host and the other ticket.
- **GPUI widgets inside the app.** `host.watchlist` (`src/watchlist.rs`) and `host.switch` (`src/switch.rs`) are
  GPUI Kit widgets the host registers as native components and the app places with `nativeComponent`: the
  watchlist shows the desk's symbol and hands the one picked to `Trading.select`; the switch is the ticket's
  "Extended hours". Both take their own clicks and keys and are Tab stops among the app's fields.
- **GPUI Kit popovers and dialogs over NSH.** "Positions" in the toolbar opens a popover that hangs over the tickets;
  the watchlist's info button (a GPUI widget inside the app) opens the symbol's details in a popover anchored to it,
  which follows it when the split is resized or the ticket scrolls. Buy and Sell ask `Trading.confirm(message)`
  first: an `async` host function that sends the question to the window (a channel the shell listens on), which asks
  it in GPUI Kit's alert dialog and answers through a oneshot channel.
- **Show layers** (a switch in the toolbar, on at the start, `src/layers.rs`) outlines each NSH surface and tags it
  "NSH · TSX app", and outlines and tags the GPUI widgets inside the apps "GPUI"; a legend under the tickets names the
  three layers. Off, the window is seamless.

`cargo run … -- <bundle.nshc or its directory>` runs another bundle; `--alone` runs one surface in a window of its
own (no host widgets: Tab wraps around its fields and the switch). The example is its own Cargo workspace, so GPUI
Kit stays out of NSH's workspace builds, and builds into the repository's `target/` (`.cargo/config.toml`). From the
root, `cargo run -p example-embed-gpui` runs `run/`, a member of NSH's workspace with no dependencies, which only
runs `cargo run` here (same profile, arguments forwarded). On Linux it needs GPUI's packages (`docs/dev/gpui.md`). It depends on `gpui-kit` with feature `gpui-fast`, so GPUI Kit and NSH draw with the same GPUI
(`cargo tree -i gpui-fast` shows one version). See "GPUI and GPUI Kit apps" in `docs/dev/embedding.md`.
