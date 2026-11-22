# Engineering constraints

Reference for contributors; read the relevant section before changing its area.
Paths and shell commands below are relative to the repository root.
This page is loaded on demand, not imported as an agent instruction file.

## Rules

- **Convention over configuration (CoC, a project constraint).** Follow the existing project and toolchain conventions
  before adding configuration, wrapper scripts, environment overrides or another cache directory. NSH-managed
  temporary/generated files belong in `.nsh/`. Cargo keeps its normal `target/` directory and the user's existing
  `CARGO_TARGET_DIR` behavior; do not add Cargo configuration or change that environment variable just to organize
  NSH files. Reuse the existing Cargo cache rather than creating a second one under `.nsh/`.
- **Three layers, as GPUI Kit's (an architecture rule).** `nsh-core` ↔ `gpui`: the primitives and the environment,
  `nsh` (native in `crates/nsh-js` or Rust modules of the runtime, `crates/nsh-core/src/runtime/`);
  TSX imports every primitive from `nsh`, as Rust does from `nsh_core::element` (and `nsh_core::prelude`).
  Which side an element is on: `nsh-core` holds the foundational elements, what draws or lays out content and what
  the surface reports (`View`, `Text`, `Scroll`, `List`, `Image`, `Canvas`, `Overlay`, `Video`, `WebView`,
  selectable views, the `env()` insets of padding and margin, with `safeArea()`, `safeAreaInsets()`, `Keyboard` and
  `keyboardFrame()`); `nsh-base` holds the functional components, controls a
  user operates (`Button`, `Input`, `Checkbox`, `Switch`, `Slider`, `Editor`, ...), even when one is a native view the
  core makes (`Input`: `nsh_base::input()`, TSX `nsh/base`). The Rust home and the TS home of an element are the
  same layer. Navigation (`NavStack`, `NavPage`), `Dialog` and `AlertDialog` are `nsh-base`'s: the core makes their
  native containers, `nsh-base` owns the component apps use, in Rust and TS alike.
  `nsh-base` ↔ `gpui-base`: `nsh/base` (`crates/nsh-base`), unstyled base components of `gpui-base`'s scope that own
  behavior, state, focus, keyboard and accessibility and leave every visual choice to the app (navigation, dialogs, a
  button, a checkbox, radios, a switch, tabs, popovers, menus, tooltips and sheets, text input and system alerts today, with the status bar a
  prop of pages and dialogs; controls such as toggles, sliders and selects as their behavior is written). Names follow `gpui-base`'s
  (`docs/dev/api-naming.md`), and so do the API and the features: GPUI Kit's components are long proven, so an
  `nsh-base` component covers every option of its `gpui-base` / `gpui-component` counterpart (as a prop, a part or the
  app's slot), or `docs/dev/api-naming.md` says why it does not. `gpui-component` ↔ nothing: a styled component library is never part of NSH; apps and
  the community build theirs on `nsh-base`, or style the UI in the app itself. Each export has one home (two
  registries exporting one name panic, `Registry::merged`). Mobile-only APIs (iOS, Android or both) go to `nsh/mobile`, desktop-only ones to `nsh/desktop`,
  platform-only props into `ios={{…}}` / `android={{…}}` / `desktop={{…}}` (typed objects: a system feature
  several platforms have goes in each of theirs under one name; what an element means everywhere is a top-level
  prop, ignored where it does not apply). Desktop has one definition: a desktop OS (macOS, Windows, Linux) or the
  web in the desktop idiom (`Environment::desktop()`), which `desktop={{…}}`, `platform.select({ desktop })`,
  `platform.desktop` and `platform.idiom === "desktop"` all follow; Mac Catalyst is mobile (the iOS backend);
  `nsh/desktop`'s `isAvailable` alone is narrower, the OSes with its windows and menus (`api-naming.md`). `nsh` has
  no catch-all re-exports. Beside
  them sits a fixed catalog of eleven standard modules with bare specifiers (`nsh_core::js::STANDARD_MODULES`:
  `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib`):
  Node-shaped subsets compatible with gpui-shell's, built on the same native machinery (typed registries, capability
  checks in Rust) with generated declarations. Exactly these names import; `node:` prefixes and other Node modules
  (`fs`, `events`, `util`, ...) are refused. Files and processes are these modules (`fs/promises`, `process`), never
  part of `nsh`, `nsh/mobile` or `nsh/desktop`; the catalog grows only by a design decision.
- **Backward compatible, from the first recorded release on.** Apps are delivered to host apps as plugins and may
  never be built again, so every release runs every app built for an earlier compatible one. What a release recorded
  in [`longbridge/nsh-compat`](https://github.com/longbridge/nsh-compat) shipped is never removed or renamed: modules,
  exports and their members, `nsh:rt` (what compiled JSX calls: append-only, signatures and semantics kept), globals,
  props, events and payload keys, style keys and values, Tailwind utilities. A rename or move keeps the old name as a
  `@deprecated` alias of the same implementation, for good. Types only widen, a union gaining members whichever way it
  goes (what apps read too: `platform.os`, a state, a reason; apps handle a value they do not know); inputs gain
  optional members only; behavior and defaults stay (new behavior is opt-in); formats (`.nshpkg`, certificates) are
  read forever. The record
  and its checks live in that repository, never here: a change to NSH cannot rewrite them, and the only removals are
  security closures in its `closed.txt`. No release is recorded yet, so nothing is frozen: what is on `main` may still
  change until the first release recorded, which is not chosen yet (0.3.0, 0.4.0 and 0.5.0 are not recorded). A new API lands with its test, a case in
  `tests/compat/cases/<domain>/` whose script checks it (`cargo xtask compat`; `docs/dev/compatibility.md`).
- **Native views and interaction, app-owned design.** Common controls have one cross-platform home in `nsh/base`.
  A system-styled version of a common control does not justify another public component in a platform module.
  Extend shared behavior and styling parts instead. `nsh/mobile`'s `TabBar` is a mobile navigation capability,
  distinct in role from `Tabs`; platform modules expose platform-specific semantics, not parallel catalogs of
  system-styled form controls. See `docs/dev/js-modules.md` "Component scope and project goals" and
  `website/docs/goals.md` (with its Chinese counterpart).
- **No styles in NSH.** Nothing NSH ships has a look of its own: no default colors, paddings, radii, fonts or variants
  in `nsh-base`'s components (its theme's default tokens, shadcn/ui's, are the app's to draw with; the
  exceptions are `TextView`'s default reading typography, its colors the theme's shadcn tokens (alerts GitHub's alert
  colors, highlights a marker's yellow), every part overridable by the
  app's `classes` / `styles` / `TextViewParts`, and its built-in syntax highlighting colors, Allsum's code palette, which an app's
  `CodeHighlighter` or `renderCodeBlock` replaces, and the `Editor`'s default look, its colors the theme's shadcn tokens
  (search matches amber, warnings amber, information blue), its font the theme's `font-mono`, every part overridable by
  the app's `classes` / `styles`, and the same built-in syntax highlighting colors, which the app's `decorations` style over, and `DiffView`'s default look: theme tokens, added green, deleted red, every part
  overridable by `classes` / `styles`, and the URL hint of `Link` and `TextView`'s links: the theme's popover tokens, so every app shows where a link goes (`link_hint.rs`)); a component takes the app's styles (`class`, `style`, styles per state) and children, and exposes its
  parts instead of fixed markup. Its state is controlled (it reports changes, the app owns the value). The platforms
  draw nothing of NSH's either: no header where the system has none (the desktops and the web place a page's `header`
  slot), no dialog card, scrim or shadow, no native press fade (press feedback is the app's `activeStyle` /
  `active:`), no built-in strings (every label comes from the app); system UI keeps the platform's look (iOS / Android
  headers; `AlertDialog`, drawn in the platform's dialog style where the system has no dialog to show). React Native and
  UIKit are references for which capabilities exist, not APIs to be compatible with.
- **Pointer-driven motion follows the pointer in the same frame; transitions and springs are for discrete
  changes.** A hover's cross line, a dragged thumb, a scroll bar, a resizer, a swipe track the pointer 1:1 and are
  set, never eased toward it; keyboard steps, snaps on enter / leave, releases, fades and data changes animate
  (`docs/dev/animation.md` "Pointer-driven motion follows the pointer"), in components and demos alike.
- **Styles: native first, in the forms people write.** One set of properties written three ways (Rust `Styled`,
  `style` keys, Tailwind classes) means the same in each; the names are CSS's but for a few common forms. Each key takes the form most used and
  easiest to write, CSS's by default: where common use and CSS differ, the common form wins (a `lineHeight` number is
  points) and `docs/dev/styles.md` lists it. React Native is a reference for what is common, not an API to match: no
  names or aliases for its sake. Tailwind (v4) utilities mean what Tailwind's generated CSS does. What NSH cannot
  support is unsupported (an unknown class, a rejected value with a warning), never given another meaning. Past
  that the design serves the native platforms and performance, not compatibility with the web: lengths are points,
  unset properties take React Native's / Yoga's defaults, values that change take numbers and structured forms (JS
  builds no strings), and what the platforms do that CSS cannot say is a registered extension key or class, named
  apart from CSS's. Below TSX, values are typed: Rust's `Styled` and Tailwind classes lower to typed values (a core
  type of their own where one is needed, as `LineHeight`), never to strings the core parses again; only a TSX
  `style`'s values are parsed from strings. Frozen with the first recorded release as `docs/dev/styles.md` writes it ("Principles",
  "Extensions").
- **API shapes: one form per thing, shapes that can grow** (decided by the user before the freeze; details and
  examples in `docs/dev/api-naming.md` "Conventions", "Shapes that can grow" and "Units"; the API is being brought to
  them). Names are short, accurate and neutral: the project's own word for a concept first, then `gpui-base` /
  GPUI's and the DOM's (`CONTRIBUTING.md` "API design"); React Native is a reference only.
  - Units: one per quantity. Lengths are points; an image's or a video's own size is pixels, typed `PixelSize`
    (never `Size`); times are milliseconds; velocities points per second; shares fractions from 0 to 1 (no `Percent`
    in names). Only media time is seconds (HTML's `currentTime`) and a deceleration the velocity kept per
    millisecond (UIKit's 0.998 / 0.99).
  - Events: every handler gets one object, value changes included (`onChange({ value })`, `onOpenChange({ open,
    reason })`, `onLayout({ bounds })`), its fields named as the props they report; never positional arguments, a
    bare value or a shared data type passed as the payload itself. An event with nothing to report passes nothing.
    Only the responder callbacks keep React Native's `(e, gestureState)`.
  - Mouse events are the DOM's and GPUI's: `onMouseEnter` / `onMouseMove` / `onMouseLeave`, each with a
    `MouseEvent { position, pagePosition, modifiers, pressedButton }`; `onMouseMove` fires with or without a button
    down. `onWheel` passes `WheelEvent { position, pagePosition, delta, deltaMode, modifiers }` (GPUI's
    `ScrollWheelEvent`, the DOM's sign); a listener nearer than the scroll views under the pointer takes the wheel,
    and one scroll stays where it went (`input::WheelLatch`). `onPinch` passes a touchpad pinch's
    `PinchEvent { position, pagePosition, delta, phase, modifiers }` (GPUI's `on_pinch`), routed the same way.
    State styles keep CSS's names (`hover:`, `hoverStyle`).
  - Returns: an object, never a bare value that may need a second field (`AlertDialog.show` → `{ action }`,
    animations → `{ finished }`); yes / no questions (`hasText()`, `canUndo()`) return booleans.
  - Failures (of what JS calls): a function returning a promise never throws, every failure rejects (arguments,
    grants, quotas, I/O, as Node's `fs/promises`); a synchronous one throws a `TypeError` / `RangeError` for a wrong
    use. A failure the app can handle carries a stable `code` (`nsh_core::element::codes`: `ERR_ACCESS_DENIED` with
    `permission` and `resource` for what the capabilities do not grant, an `Error` (`fetch`'s keeps the web's
    `TypeError`), `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ERR_NSH_QUOTA_EXCEEDED`, `ETIMEDOUT`, `ERR_NSH_HOST_ERROR`,
    Node's errno codes for I/O; `nsh/test`'s own `ERR_NSH_TEST_*`); messages are not API. Never a sentinel
    (`false`, `-1`, `""`, `[]`) or silence for a failure; `null` stays an answer ("nothing there"), a cancel resolves
    empty. A command that runs at the commit (a component's or ref's method) cannot throw: given an unknown id or
    index it does nothing and logs a warning.
  - Methods whose parameters may grow take their options as one object (`net.connect({ host, port })`,
    `WindowRef.setBounds({ origin, size, animated })`); parameters the user judged will not grow stay positional
    (`setSelection(start, end?)`, `seek(seconds)`, `DockArea.addPanel(panel, placement?, size?)`,
    `DataTable.scrollToRow(row, animated?)`, `Editor.revealPosition(position, center)`, a range's start and end):
    decided per method by the user (2026-10-28), not changed on reading this rule.
  - Identifiers an app matches on are the app's and required, never derived from a label (`AlertDialogAction.id`).
  - Refs: each element has a ref type of its own (`InputRef`, `ScrollRef`, `VideoRef`, ... over a common `ViewRef`),
    never one type carrying every element's methods.
  - Listening: the function that registers a listener is `on(event, listener)` in everything TSX calls
    (`BackHandler.on("press", l)`, `host.on(name, l)`; Rust's own API keeps GPUI's `on_<event>`), never an
    `on<Event>(l)`, `subscribe` or `addListener`; it returns a function that stops it (`() => void`, a Rust
    function's `Stop`), never `{ remove() }` or an id for an `off`, and what is registered while a component renders
    goes with the component. `keymap.bind` keeps `bind` (a shortcut is not an event); the standard modules keep
    Node's `on`, which returns its object.
- **Components are Rust.** Rust components live in `crates/nsh-base` or in an app's own crate (its UI set,
  `#[native_module("…")]`), run in the core and render primitives with typed styles (GPUI-style `Styled` methods,
  never class strings); props and events are derived types, their JS face is made from the specs (`nsh-js`
  `components.rs`) and their TypeScript declarations generated from them (`nsh_core::element::declarations`), never
  hand-written per component. JS allocates even node ids, the core odd ones for what components expand
  (`docs/dev/components.md`).
- **The main thread never waits for JS.** Callbacks the system wants answered on the spot (may this text change, may
  the back button pop, may the sheet close, ...) are answered natively from props mounted beforehand; events tell JS
  afterwards (`docs/dev/elements.md`).
- **One surface / `NshView` is one engine**, with no global singletons (NSH is embedded with several instances).
- **Limits and checks are enforced in Rust, never in JS**: a bundle holds only the app's code, so nothing in JS is
  trusted. QuickJS bytecode is trusted input (`Bundle::bytecode` is `unsafe`): it only loads from the app's own
  resources, the dev server and verified packages (`docs/dev/signed-packages.md`).
- **Generated, never hand-copied**: the codes of encoded operations (`ANIMATION_*`, `CV_*`), the canvas's recording
  methods and properties (made natively from `CanvasOp`'s `#[derive(JsOps)]` specs, which also decode them), the style
  types, the host elements' props and events and the easings / layout animation presets come from
  `crates/nsh-core/src/js/`, and so do their declarations, as do those of the runtime's Rust modules, of `nsh/base` and of apps'
  UI sets. No `.d.ts` is checked in: a native module's export carries its declaration (`modules::Ts`), a web
  class's spec its members' (`web::ClassTs`), and tests load every module and global and check that what exists is
  what is declared (`nsh-js` `declarations.rs`). A new style property is one line of `style_keys!` (`style.rs`) with
  its TS type, a new host prop one variant of `Prop` with `#[prop(js = …)]`, a new event a row of `host::EVENTS` (or
  `INTERNAL_EVENTS`) (`docs/dev/elements.md`).
- **Keep in sync**: the handler types of `host::EVENTS` ↔ the payloads of `nsh-js`'s `dispatch_event`; the order of `EventKind` ↔ `Native.java`; `encode.rs`
  opcodes ↔ `Mounter.java`; new event payload keys ↔ the JNI event map's key list; `BUNDLE_NAME` /
  `BYTECODE_VERSION` ↔ the linked QuickJS; `nsh-macros`' `VARIANT_SCALES` ↔ `IMAGE_SCALES` above 1.

## Code conventions

- Name context bindings and parameters `cx`.

- Formatting: `cargo +nightly fmt --all`, configured in `.rustfmt.toml`.
- Units and geometry are typed, as GPUI's are (`nsh_core::geometry`): a length is `Points` (GPUI's `Pixels`), `Rems`,
  a `Percentage` (a fraction, 0.5 is 50%) or a style length (`AbsoluteLength`, `DefiniteLength`, `Length`), an angle is
  `Radians`, shapes are `Point` / `Size` / `Bounds` / `Edges` / `Corners` of a unit. Public API never takes or returns a
  bare `f32` / `f64` for a length, an angle or a fraction; platform boundaries (taffy, the toolkits, JS decoding) convert.
  Enforced: nsh-core's `unit_types` test (and nsh-js's and nsh-engine's `public_api_is_typed`) fails on a bare float
  in public API that the crate's `unitless.txt` (unitless quantities, with reasons) or its shrinking `untyped.txt`
  (legacy, to migrate) does not list (`docs/dev/geometry.md`).
- TSX tags are PascalCase, everywhere (examples, docs, tests): every tag names a binding in scope, only `<If>` and
  `<Each>` are globals that need no import. Imports mirror the Rust crates' layers: every primitive comes from `nsh`
  (`View`, `Text`, `Scroll`, `Overlay`, `Image`, `List`, `Canvas` and its classes, `WebView`, `Video`), as `nsh_core::element` holds them, every base
  component from `nsh/base` (`Input`, `Dialog`, `Button`, `NavStack`, ...), and
  `InputAccessoryView` from `nsh/mobile`; the compiler makes their tags in place (`jsx::PRIMITIVES`). Lowercase tags are compile errors: TypeScript checks a lowercase tag
  against one global type per name, so generic components (`List`, `Each`) and local ones would lose their types.
- Workspace lints: `missing_docs = warn`, `unreachable_pub = deny`, `private_interfaces = deny`. New crates must set `[lints] workspace = true`.
  They cover NSH's own Rust crates only: not the Java / Swift / TS sources, and never the apps built with NSH.
  - Every public API has a doc comment.
  - Items in private modules are `pub(crate)`, never `pub`.
- Everything is written in English: code comments, docs, logs and this file. Comments explain why, not what the code says.
- Colors in Rust are GPUI's: `Hsla` (`nsh_core::color`) is the color code holds, passes and computes with (theme
  colors, typed styles, props, every new signature: `impl Into<Hsla>` or `AdaptiveColor`), `Rgba` is only for
  conversions; the packed `Color` (`0xRRGGBBAA`) is only the storage and wire form (styles, mount items, the
  platforms) (`docs/dev/styles.md` "Colors").
- Library crates only log through the `log` facade (no `eprintln!`); performance logs use target `nsh::perf`, JS logs target `js`. Binaries install the logger.
  The CLI prints through `nsh-cli`'s `ui.rs` (steps, captured tools, `error` reports), xtask through `term.rs`.
- Dependencies are declared once in the root `Cargo.toml` `[workspace.dependencies]` (the GPUI backend's in `crates/gpui/Cargo.toml`); crates only write `.workspace = true`.
- Every `unsafe` block has a `// SAFETY:` comment.
- A crate's integration tests are one test binary (`tests/<name>/main.rs` with a module per area, as
  `nsh-engine/tests/engine/`), never a new `tests/*.rs`: each binary links its own copy of the bundler, QuickJS and
  the core (about 1 GiB of debug objects apiece).

## Public Rust structs

- New `pub struct` types use `#[non_exhaustive]` and implement `Default`, deriving it when possible.
- Set only the fields needed and leave the rest at their defaults. Within the defining crate, use `..Default::default()`; callers in other crates start with `Type::default()` and assign fields, because non-exhaustive structs cannot be constructed with external struct literals.
- New fields have sensible defaults so extending a struct does not break downstream construction.

## Public Rust element API

What apps call to build UI in Rust stays stable and strongly typed:

- Element constructors take no content: `shader()`, then builder methods (`.source(program)`, `.uniform(..)`), so a
  new input is a new method, never a changed signature. Existing constructors that take their content
  (`canvas(painter)`, `video(url)`) are not a model for new ones.
- Names NSH defines (style properties, built-in values) are typed; names the app defines in its own code (a
  shader's uniforms, declared in its WGSL) are plain `&str`, as TSX's keys are, checked where they are defined.
- Values are typed (`impl Into<UniformValue>`, `Hsla`, `Points`), not strings to parse.
- No macros to make elements or set their props (declaring components with `#[component]` and its derives stays):
  plain functions, methods and traits.
