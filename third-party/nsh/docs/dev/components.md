# Components

Rust components are written in Rust and run by the core on the engine thread. JS only describes the UI: a component is
one node in the JSX tree, its props go to Rust, its events come back. One implementation draws the same on every
platform, is laid out in the same Taffy pass as everything else (no measuring round trip) and keeps its interaction
native.

NSH is layered as GPUI Kit is (`architecture.md` "Layers"): `nsh-core` is its `gpui`, `nsh-base` its `gpui-base`, and
the styled layer, GPUI Kit's `gpui-component`, is never part of NSH. The look of an app is the app's. Rust components
come from two places:

- **`nsh/base`**: unstyled base components of `gpui-base`'s scope, the crate `nsh-base` (`crates/nsh-base`,
  `nsh_base::registry()`): `SafeAreaView`, `KeyboardAvoidingView`, `Button`, `Checkbox`, `Radio`, `RadioGroup`, `Switch`, `Tab`, `Tabs`, `Collapsible`, `Progress`, `Table` with `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell` and `TableCaption` (a table's accessibility roles around the app's rows), `SelectionArea` (texts that select
  together, `text.md` "Selection areas"), `TextView` (`text-view.md`), `ResizablePanelGroup` and `ResizablePanel`, `DockArea`
  (`dock.md`), `Editor` (a code editor, `editor.md`), `DiffView` (the changes between two texts, `diff.md`), `DataTable` (a table over any number of rows and columns, `data-table.md`), the popups on the core's overlays (`Popover`,
  `Menu` with `MenuItem`, `MenuSeparator` and `Submenu`, `ContextMenu`, `Tooltip`, `Sheet`: "Popups" below), toasts
  (`Toast`, `ToastStack` and the class `ToastManager`: "Toasts" below) and the
  modules `AlertDialog`, `Keyboard`, beside the navigation `nsh-js` makes for it (`NavStack`, `NavPage`, `Dialog`, `createNavStack`); controls
  (toggles, sliders, selects, popovers, sheets, ...) join as their behavior is written. It is a UI set
  (`Registry::ui_set("nsh/base")`), with the charts' parts `Plot`, `Line`, `Area` and `Grid` in its submodule `nsh/base/plot` (`Registry::submodule`, `js-modules.md`), every host serves by default (`set_ui_sets`' default; embedders with a list of their
  own add `nsh_base::registry()` to it); Rust apps use `nsh_base::{SafeAreaView, …}`, and make navigation and
  dialogs with `nsh_base::{nav_stack, nav_page, dialog}` (builders of the core's `Stack`, `Screen` and `Modal` host
  elements; the core's `stack()`, `screen()` and `modal()` are their deprecated old names), and show system
  alerts with `nsh_base::alert_dialog()` (the prelude's `dialog(Dialog)` is its deprecated old form; import
  `nsh_base::dialog` by name, as that glob still brings the old one). What goes in is behavior:
  - it owns behavior, state, focus, keyboard handling and accessibility (roles, states, actions), or tells the
    platform (insets, the keyboard's height, the status bar's setting, a system dialog);
  - it has no look: no colors, paddings, radii, fonts or variants of its own; it takes the app's `class` / `style`
    (and styles per state) and children (the exceptions are `TextView`'s default reading typography and the default looks of `Editor` and `DiffView`, colored
    with the theme's tokens and overridable part by part: `docs/dev/text-view.md`, `docs/dev/editor.md`, `docs/dev/diff.md`);
  - its state is controlled: it reports changes (`onChange`, `onOpenChange`, ...), the app owns the value;
  - it exposes its parts (a trigger, a thumb, an item, as slots or child components) instead of fixed markup, so an
    app arranges and styles each.
- **An app's own crate**: its UI set, `#[native_module("app/native")]` (`nsh.json` `"rust"`, `docs/dev/tooling.md`),
  imported by the app's TSX by that specifier. This is the styled layer: an app's own component library (buttons,
  cards, list rows with its look), or a community library a third party publishes as a crate, built on `nsh-base`'s
  behavior and the primitives. `examples/gallery-rs` is one (`gallery/native`), and so is the crate
  `nsh init --template rust` / `mixed` writes (`app/native`).
  What such a crate keeps per engine (the languages and highlighters its editors know,
  `nsh_base::editor::register_language`; a value of `nsh_core::ui::global`) it sets up in `Registry::setup`, a
  function each engine serving the set runs once in its runtime before the app's first op (`Core::set_components`).

The TSX gallery and website demos share the repository's internal `examples/nsh-gallery-ui` source layer: design
tokens, finishes, buttons, cards, switches, segmented controls, icons and table part classes. The gallery's
`ui.tsx` keeps navigation and shell state, and the website's `palette.ts` adapts the shared layer to demo layouts.
Visual rules are changed in the shared layer; `nsh-base` supplies the components' structure and behavior.

| Where | What |
|---|---|
| `crates/nsh-core/src/ui/` | The API (`nsh_core::ui`, `prelude`): `Component`, `Module`, `Class` (`class.rs`, `callback.rs`; direct JS values: `js.rs`), elements, `Styled`, `Theme`, `Registry`, the status bar's layers (`status_bar.rs`), the declarations generator `typescript` |
| `crates/nsh-macros` | `#[component]`, `#[derive(Props)]`, `#[derive(PropEnum)]`, `#[derive(Event)]`, `#[derive(JsObject)]`; `#[methods]`, `#[module]`, `#[class]`; `#[native_module("…")]` (an app crate's set: `docs/dev/tooling.md`); `style_helpers!` (the spacing methods of `Styled`) |
| `crates/nsh-core/src/core/components.rs` | The core side: instances, children and slots, events; `core/views.rs`: views, their bindings' patches and regions |
| `crates/nsh-base/` | `nsh/base`'s components and modules, one file each (`safe_area.rs`, `keyboard.rs`, `alert_dialog.rs`, `button.rs`, `checkbox.rs`, `radio.rs`, `switch.rs`, `tabs.rs`; `TextView`, `ResizablePanelGroup`, `DockArea`, `Editor` and `DiffView` directories, `text_view/`, `resizable/`, `dock/`, `editor/`, `diff/`; `syntax.rs`, the syntax highlighting `TextView` and `Editor` share), one `Registry` (`lib.rs`) |
| `crates/nsh-core/src/runtime/` | The runtime's Rust modules (`nsh/android`, `nsh/accessibility`, `nsh/image`, `nsh/clipboard`, `nsh/desktop`), one `Registry` per JS module (`mod.rs`) |
| `crates/nsh-js/src/components.rs` | The JS face of components and modules, made from their specs when a bundle imports the module; `classes.rs`: classes' (on the web classes' machinery), synchronous functions', callbacks |
| `crates/nsh-js/src/declarations.rs` | `nsh/base.d.ts`, `app/native.d.ts`, ...: the declarations generated from each registry (`nsh_core::ui::declarations`) with the re-exports and the navigation |
| `nsh_engine::EngineConfig::ui_sets` | The UI sets a surface serves besides the runtime's modules (the platforms' `set_ui_sets`; `nsh_base::registry()` by default; an app's own set: `docs/dev/tooling.md`) |

## Writing a component

- **One file per component**, registered in the crate's `#[native_module]` function (an app's) or in its crate's
  registry (`nsh_base::registry()`, `nsh/base`'s). Start with `use nsh_core::ui::prelude::*;`. The JS export is the
  type's name (`#[component] pub fn Chip` is `Chip`): no name is written by hand. `nsh/base`'s exports are pinned
  by `nsh-base`'s `tests::the_exports_are_pinned`.
- **Props are a struct** (`#[derive(Clone, Copy, PartialEq, Props)]`, its fields `Prop<T>`), **events an enum**
  (`#[derive(Event)]`, or `NoEvent`), choices an enum (`#[derive(PropEnum)]`). The module's export and its
  TypeScript declarations are generated from them, doc comments included, so apps write `<Chip label="New"
  onPress={open} />` with full types; there is no hand-written glue. The props struct's doc comment documents the
  component in TypeScript.
- **A component runs once** and makes its view with `view()`, `text()`, `image()` and other components
  (`safe_area_view()`, `chip().label("New")`), styled with GPUI-style methods (`.px_4()`, `.rounded(px(16.0))`, `.active(|s|
  s.bg(..))`). What changes is a **binding**: a closure or a signal where the value goes (`text(props.label)`,
  `.bg(move || theme().primary)`, `.style_when(props.disabled, |s| ..)`); when what it read changes, only that part
  is updated. A prop is read with `props.x.get()` in a binding and `get_untracked()` in a listener. The root can be
  any element; the app's `class` (merged last, it wins) and `style` apply to it.
- **Colors come from the theme** (`nsh_base::theme()`: shadcn/ui's tokens, a light and a dark value each),
  not literals, so the app's `nsh.json` theme restyles its components and dark appearance switches natively. Read
  `theme()` inside the bindings that use it, so a new theme reaches them.
- **What never changes is plain Rust** (`.when(cond, |v| ..)`, `match` at build time); interaction states are
  variants (`.active(..)`, `.hover(..)`, `.focus(..)`). **What comes and goes is a region**: `when(cond, ||
  el).otherwise(|| el)`, `dynamic(move || ..)`, `each(items, key, |item, index| row)`.
- **The app's content is props, placed by closures**: `header: Prop<Option<Slot>>`, `children: Children`,
  `items: Items` for virtualized rows (in JS `each` and a row renderer, like `List`); `#[prop(lazy)]` on `children`
  has JS make them only while the view places them (below).
- **State is signals** made in the body (`signal(v)`, `computed(..)`, `stored(v)`); listeners are closures that
  write them and emit with `cx.emit(..)`; timers and async work are tasks owned by the component (`set_interval(..)`,
  `spawn(async move { .. })`) and end with it. Methods a ref calls in JS are an API type (`#[methods]`, below).
- **The surface is free functions** whose reads subscribe: `window()`, `safe_area()`, `keyboard_height()`, `dark()`,
  `font_scale()`, `locale()`, `cx.insets()`, `global::<G>()`, `provide_context(v)` / `use_context::<T>()`.
- **Modules are functions without a component**: `#[module] impl AlertDialog { pub async fn show(options:
  AlertDialogOptions) -> Result<Option<SharedString>, String> }` is `await AlertDialog.show({ … })` in JS (`nsh-base`
  `alert_dialog.rs`). A module named like a component adds static functions to it.
- **System UI**: `nsh_base::alert_dialog().title(..).cancel(..).destructive(..).show()` (TSX's `AlertDialog.show({ … })`:
  await the label of the action chosen, `None` when closed without one), `dismiss_keyboard()`, a screen's
  or modal's `.status_bar(..)` (as a view controller's `preferredStatusBarStyle`; a `StatusBarStyle` alone, a
  `StatusBarSetting` or a closure of one), `ModuleCx::set_status_bar(patch)`
  for the default under them; `.inset_padding(..)` / `.inset_margin(..)` on an element (`SafeAreaView`, `KeyboardAvoidingView`).
- **Platform-only props** are an `android` / `ios` / `web` prop of a `JsObject` struct (an app's `ChartWeb { … }`).
- Changing an app's component rebuilds the app's hosts and runners (`rust_app.rs`; `nsh run` does it on save), a
  component of `nsh/base` the dev hosts, `nsh-ios-app` and the Android runtime; TSX using it reloads as usual.

An app's crate exports components, modules and classes of its own the same way (`#[native_module("…")]`,
`docs/dev/tooling.md`): `examples/rust-exports` exports one of each to TSX, each kind of prop, event, function and
member once, with headless tests of its TSX entry.

## The API

```rust
/// A tag with a label.                   // the TypeScript doc of `Chip`
#[derive(Clone, Copy, PartialEq, Props)]
pub struct ChipProps {
    /// The label.
    pub label: Prop<SharedString>,        // required in TS
    #[prop(default)]
    pub tone: Prop<Tone>,                 // #[derive(PropEnum)]: "neutral" | "accent" | ...
    pub accessibility_label: Prop<Option<SharedString>>,   // `accessibilityLabel?`
}

#[derive(Event)]
pub enum ChipEvent {
    /// The chip was pressed.
    Press,                                // `onPress?: () => void`; in Rust `.on_press(..)`
}

#[component]                              // JS export: `Chip`, the function's name
pub fn Chip(props: ChipProps, cx: Scope<ChipEvent>) -> impl IntoElement {
    view()
        .px_3()
        .py_1()
        .rounded(move || theme().radius)
        .bg(move || theme().muted)
        .active(|s| s.bg(move || theme().border))
        .on_press(move || cx.emit(ChipEvent::Press))
        .child(text(props.label).text_color(move || theme().foreground))
}
```

A component is a function that **runs once** (`Component::view`; `#[component]` makes the unit struct named after
the function and its `Component` impl): it makes signals and effects, then its view, under an owner of its own (the
reactive graph of `crate::reactive`, instantiated for Rust in `ui/reactive.rs`). What changes is bound: a setter, a
style or a text given a closure, a signal, a memo or a `Prop` (anything `IntoReactive<T>`) is a binding, run again
when what it read changes, and the core applies only what that one binding produced. Nothing renders again and
nothing is diffed. Releasing the host disposes the owner: its bindings, effects, tasks, timers, back listeners and
child components go with it. What leaves goes as one `Delete` per view the core made, as a plain element's does
(every platform takes a deleted view out of its parent), with no `Remove` before it, also for content that leaves
another component's children; only JS's children placed in a component are removed and kept. The design and its
reasons: `reactive-components.md`.

- **Names come from the type**: `Registry::register::<Chip>()` registers it under `std::any::type_name`
  (`my_app::chip::Chip` in the crate `nsh init my-app --template rust` makes: the key the JS face sets as the host's
  `component` prop and the core finds it by, only compared within one binary) and exports it as the type's own name
  (`Chip`; a generic type's without its arguments). A second registration of a type, two types of the same name (two
  versions of a crate) or two components of one set with the same export panic at registration (`Registry::merged`
  likewise for the sets a host serves, the runtime's included, also for modules of the same name); components of
  different sets may share an export. A test pins the runtime's exports (`runtime` `the_exports_are_pinned`). A
  module's JS name is its type's too (`#[module] impl AlertDialog`: `AlertDialog`).
- **Props** are a struct, **events** an enum; the derives produce a decoder per prop (`PropSpec::decode`: the JS
  value into the field's Rust type, when JS sets it), the conversion of an event's data to JS (`Event::data_js`),
  defaults, and the TypeScript types (doc comments included: the fields' and variants', while the component's is
  its `#[component] fn`'s, `Component::DOC`; the props struct's and the event enum's own stay Rust's, and so does
  any part of a doc comment from its first heading on, `# Rust` for notes meant for Rust callers). Field and variant names become camel case in JS. An
  event handler's argument is `value` in TS (`event` for a variant with named fields); `#[args(index)]` on the
  variant names it (`onSelect?: (index: number) => void`). A variant of several unnamed fields names each
  (`#[args(open, reason)] OpenChange(bool, OpenChangeReason)`): the handler takes them as its arguments
  (`onOpenChange?: (open: boolean, reason: OpenChangeReason) => void`; `Event::spread`, the data a JS array the JS face
  spreads). Value types
  implement `JsValue` (numbers, `bool`, strings, `Hsla` (a CSS color string, as `Color`), `Option`, `Vec`, `JsonValue`, `ui::Style` (an inline
  `StyleProp<ViewStyle>`, decoded as a host element's `style` is: transforms, shadow offsets and native animated
  values included; Rust builds one with `Style::from_decls` / `with`), `PropEnum`s, `JsObject` structs). A field that can change is a `Prop<T>` (`Copy`): in the
  instance each is a memo of its own, so a new value from JS or from a parent reaches only what read it
  (`props.title.get()` in a binding, `get_untracked()` in a listener). A plain field is read once. The JS face
  decodes a prop when JS sets it and sends the typed value (`Prop::RustProp`, an `AnyValue`); one of the wrong type
  is a warning, as a host element's bad value is (``Gauge.level: expected an integer that fits u32, got 1.5``,
  through the VM's warnings and the dev overlay), and the prop keeps its value (its default in the first render)
  while every other prop is set (one effect reads them all, so each stays tracked); clearing a prop (`undefined`)
  restores its default. Only a decoder's panic or a getter's exception throws, as a render effect's error: by the
  assignment that ran it, or by `mount` in the first render. A Rust parent passes a value
  (`3.into()`), a signal (`n.into()`) or a closure (`Prop::bind(move || ..)`). Platform-only props are an `android` /
  `ios` prop of a `JsObject` struct (an app's `ChartWeb { … }`), as for host elements.
- **`Scope<E>`** (`Copy`) is what the component has of its own: `cx.emit(event)` (to the app's `on<Event>`, or to the
  parent's listener method, `.on_press(..)`), `cx.insets()` (its screen's or modal's insets, reading subscribes) and
  `cx.methods(api)` (below). Everything else is a free function of `ui::prelude`.
- **The app's content is props too, placed by closures**: the component never creates or touches the app's elements,
  it only lays them out.
  - `header: Prop<Option<Slot>>` is `Some` while the app passes non-empty JSX for it: `props.header.place(|h|
    h.px_4())` places it (a region; the closure styles the slot's own node).
  - `children: Prop<Children>`: `.child(props.children)` puts them all at one place among the view's own children;
    `.children_each(props.children, |child, at| view().py_3().child(child))` wraps each one (an `Each` keyed by
    the child's node: a child that stays keeps its wrapper; `at` is a `Position`: `index()`, `count()`,
    `is_first()`, `is_last()`, signals read in bindings).
  - `render_code: Prop<Option<Renderer<CodeBlock>>>`: a render function, `renderCode?: (value: CodeBlock) =>
    JSX.Element` in TS (optional; `T`'s TS type, its named types declared), for content the app draws for values the
    view has (a code block of a document, a mention). In a binding or region the view calls
    `props.render_code.get().map(|r| r.render(key, value))`: a `Rendered`, a view to style and place as any (in a
    `text(..)` an inline view), whose child is the content. A Rust parent passes `Renderer::new(|v| el)`, a closure
    called on the spot. The app's JS function is called by JS: the element is a placeholder (a view of the core's,
    `Attrs::render`), and after each commit the core sends `JsEvent::Render { host, prop, key, value }` for each
    (prop, key) placed with a value JS has not rendered (the value compared with the one sent last, so an equal one
    sends nothing) and `JsEvent::Unrender` once none of a (prop, key) is placed any more (its region left, the view
    went, another key took its place). The JS face (`$render` / `$unrender`, the host's native-event handler) calls
    the app's function in a root of its own under the component's owner (so context reaches it), inserts what it
    returns into a holder view (`componentRender`: the prop, U+001F, the key) and the holder into the host, replacing
    the key's previous one; the core places the holder as the only child of the key's placeholder (the last one placed
    when a view places a key twice; none placed: it waits out of the tree for the `Unrender`). The roots go with their
    holder or with the component (`core/renders.rs`; `nsh-js` `components.rs`). The decoded prop names its host, so a
    view may pass it on to a nested component's prop. Keys are unique among a component's renders of one prop.
  - `data: Prop<Rows>`: rows of data the component reads by key, `data: T[]` in TS with `#[props(generic)]` on the
    props (the props generic over `T = any`, as a component with rows is, the default for a component given no rows
    of its own). `Rows` reads each row's number fields once, when JS sets the prop, into a column per key
    (`Rows::column(key)`, `NaN` where a row has no number), so the component scales and draws them without calling
    into JS again (`nsh/base/plot`). A `RowAccessor` prop reads a value of each row: a field name TS checks against
    the rows' type (`Extract<keyof T, string>`), read natively, or the app's function `(d: T, index) => number`,
    which `RowAccessor::values` calls once per row in the next JS turn whenever the rows or the function change
    (`Rows` keeps the JS array for it, `JsHost::retain`; each call gets the app's own row object, `RowRef`), never
    while the component draws; Rust passes `RowAccessor::key` or `RowAccessor::from_fn`.
  - `items: Items`: virtualized rows. In JS the component takes `List`'s data props (`each`, the row renderer as
    children, `keyExtractor`, `onLoadMore`, `header`, ... : `ListItemsProps<T>`, so the component is
    generic over the row type). `.list(props.items, |l| l.flex_1().estimated_item_size(px(48.0)), |row, at|
    view().px_4().style_when(move || at.is_last(), |v| v.rounded_b(px(16.0))).child(row))` places the list, lays it
    out (size, columns, padding, gaps, direction; bound layout values update it in place) and wraps each row; only
    rows near the viewport exist and cells are recycled as with `List`.
- **Elements** are `view()`, `text(..)` (its `.child(..)`ren are spans, as nested `<Text>`s: texts with styles and
  presses of their own, strings, inline views and images, regions; the core merges them into one paragraph),
  `image(..)`, the other host elements (`input()`, `scroll()`, `nsh_base`'s `nav_stack()` of `nav_page()`s and
  `dialog()`, `canvas(painter)`, `web_view(url)` / `web_view_html(html, base_url)`, `video(url)`,
  `input_accessory_view(native_id)` (iOS's bar over the keyboard; empty on Android), `native(name)` for the
  embedder's components; `ui/host.rs`), strings (as texts) and other components, made as primitives are
  (`chip().label("New").on_press(move || ..)`, below). `.child(..)` (an element, or
  an `Option`, a `Vec`, an array or an iterator of them: `IntoChild<M>`, its marker telling an element from what holds
  elements) / `.children(..)`
  pass it content and a slot's setter (`.header(..)`) fills the slot, as JSX children and slot props do: the content is nodes of
  this view, placed where the nested component's view places the app's; regions in it join its children in place).
  Their abilities are traits: `Styled`, `Accessible`, `Interactive` (`active` / `hover` / `focus` styles, `disabled`,
  `hit_slop`, and the typed events every element has: `on_press`, `on_long_press`, `on_layout(Bounds<Points>)`,
  `on_touch(TouchEvent)`, `on_pan_start`, ..., the touch responder: below), `ParentElement`, `FluentBuilder` (`when`,
  `when_some`, `map`: decided once, when the view is made). Each host element has its own props and typed events
  (every option takes a value, a signal or a closure, `impl IntoReactive<T>`, as TSX's props take a value or an
  accessor; an image's `blur_radius` alone takes a value)
  (`input().value(move || name.get()).on_change_text(move |text: &str| ..)`, `scroll().on_scroll(..)`,
  `dialog().on_cancel(..)`; how scroll views and lists scroll is `Scrollable`, shared by `scroll()`,
  `virtual_list(..)` and a placed `ListElement`: snapping, `scrollable`, `keyboard_dismiss_mode`,
  `scroll_value(&v)`, refresh, the scroll events); `on(kind, listener)` takes any native event with its raw
  payload. Host props are the core's `Prop`s, kept one per property and diffed by kind against what the binding
  applied last. A listener is a closure (`Listener<E>`: `impl Fn(&E)`) that writes the signals it captured; listener
  methods take `impl IntoListener<E, M>`: a closure of the event, for an event without data also one without
  arguments (`move || ..`), or a `Listener` (a type may implement `Fn()` and `Fn(&())`, so one `From` could not take
  both: the marker `M`, inferred, tells them apart; a helper passing a listener on takes `impl IntoListener<E, M>`
  too). It runs
  under the owner current when it was made (the component, region or row whose view made it: `Owner::scope`, no
  batch, so writes notify as they happen), so the signals, animated values, refs and tasks it makes are that owner's
  and go with it rather than living as long as the surface. Once that owner is disposed the listener no longer runs
  (its view is gone). When the owner is disposed while a listener or task runs under it (a press closing the view it
  is in, then going on), the graph's current owner becomes `reactive::DISPOSED` rather than the freed slot's id, and
  what is made from then on goes at once: signals and memos are disposed (using them panics, as with any disposed
  signal), effects never run, cleanups run at once (a task spawned there is cancelled), animated values and refs do
  nothing. An owner put back after a nested run that was disposed meanwhile is `DISPOSED` too
  (`Graph::enter_owner` / `leave_owner` keep its generation).
- **What comes and goes is a region** (`ui/flow.rs`): `when(cond, || el).otherwise(|| el)` (TSX `<If when={..} else={..}>`; `If::new`, deprecated, is
  the same) makes a branch when the condition flips to it and drops the other; `dynamic(move || ..)` (an element, an `Option`, a `Vec` or an array) is made
  again whenever what it read changes (a component in it is a new one: it runs once per element made, as in TSX);
  `each(items, |item| key, |item, index| row)` makes a row when its key comes and keeps it, its `item` and
  `index` signals updated, while the key stays; `catch_error(|| view, |error,
  reset| fallback)` shows the fallback once something under it panicked (a binding, a listener, an effect, a
  component's view: the failed part is disposed; `reset.reset()` makes the view again; unhandled errors are logged,
  `js` target). A modal is presented while it is in the view (a `when` of it), a screen pushed while it is in its
  stack (an `Each` of the routes: the screens below keep their state; `on_dismiss` reports a native pop). The root
  can be any element: the host becomes it (a screen, a modal, a text, a list); a component as the root is made on
  the host itself (no view of its own); a region as the root goes in the host view.
- **Canvases** draw what a `Painter` recorded (the Canvas 2D operations: `.fill_style(..)` / `.stroke_style(..)` take
  colors, `CanvasGradient::linear` / `radial` / `conic` and animated values; `.stroke_path(&canvas::svg_path(d))`;
  `measure_text(font, text)` is `measureText`; `.fill_style_from_view(initial)`, `.stroke_style_from_view(initial)`,
  `.line_width_from_view()` and `.line_dash_from_view()` paint with the canvas view's `fill` / `stroke` /
  `strokeWidth` / `strokeDasharray` (inherited as CSS inherits them, `currentColor` its text color), which the core
  sets before the platform gets the drawing (`Drawing::view_paints`), so a component's shapes take the app's
  `fill-*` / `stroke-*` classes and follow them and the appearance without being drawn again;
  `.fill_background_from_view(area)` fills the current path with the canvas view's background (`bg-*`,
  `bg-linear-*`: a gradient under a chart's line), which the view then draws only there; operations built by hand take `painter.num(&v)` / `.paint(..)` and go
  in with `.op(..)`; `isPointInPath` / `isPointInStroke` are `painter.is_point_in_path(point, rule)` /
  `.is_point_in_stroke(point)` and, with a `Path2D`, `.path_contains(&path, point, rule)` /
  `.stroke_contains(&path, point)`, on a painter made by a function the drawing and the press handler both call, to
  find the shape under a tap). Its geometry is typed as GPUI's painting is: points and rectangles are `Point<Points>`
  and `Bounds<Points>`, lengths `Points`, angles `Radians`, color stops `Percentage`s; the methods that take
  animated values take `f32`, `Points` or `Radians` too.
  `canvas(move || draw(..))` draws in a binding: again when what it read changes (a size kept from `on_layout`, the
  appearance through `color(..)`); a new drawing replaces the old one. Props that take a plain color (an input's
  placeholder color) take `move || color(theme().muted_foreground)`: the theme color for the appearance now.
- **What TS does, in Rust**:

  | TS | Rust component |
  |---|---|
  | the component's body (runs once) | the function's body |
  | `signal(v)`, `memo(f)`, `effect(f)`, `untracked`, `batch` | `signal(v)` (`PartialEq`: equal writes are skipped; `signal_with(v, SignalEquals::Never)` without), `computed(f)`, `effect(f)`, `untracked(f)`, `batch(f)`; `stored(v)` for state nothing displays (`.get()`, `.with(\|v\| ..)`, `.replace(v)`, none subscribing); all `Copy` handles owned by the current owner |
  | event handlers | closures (`move \|e: &E\| ..`) that write signals; `cx.emit(..)` |
  | `setTimeout` / `setInterval`, `clear*` | `set_timeout(d, f)` / `set_interval(d, f)` return a `Spawned`; `.cancel()` clears it; it ends with the component either way |
  | async work | `spawn(async move { timer(d).await; value.set(..) })` on the engine thread, tokio inside; `background(fut)` / `blocking(f)` for `Send` work on the runtime's threads (not in WebAssembly) |
  | `fetch(url)` | `fetch(url).await` / `fetch(HttpRequest::post(url, body).header(..)).await` in a task: an `HttpResponse` (`status()`, `ok()`, `header(..)`, `text()`, `body`) or the error; the engine's network stack and capability checks, as JS's, so it works on the web too; the request is cancelled with its task |
  | `cleanup` | `cleanup(f)` (runs before the owner runs again or goes) |
  | `windowSize()`, `safeArea()`, `keyboardFrame()`, `colorScheme()`, ... | `window()`, `safe_area()`, `keyboard_height()`, `dark()`, `font_scale()`, `reduce_motion()`, `screen_reader()`, `rtl()`: reading subscribes |
  | `Window.setTitleBar(style, height)`, `titleBar()`, `Window.close()` (`nsh/desktop`) | `ui::desktop::set_title_bar(style, height)`, `title_bar()`, `close_window()`; the same root commands and native controls, with title-bar insets forwarded through `ui::Environment`; `.window_drag(bool)` on any interactive element marks or excludes a native drag region |
  | `pixelRatio()`, `Math.round(x * pixelRatio()) / pixelRatio()`, `platform.os` / `version` / `idiom` (`"desktop"`) | `pixel_ratio()`, `round_to_nearest_pixel(v)`, `os()`, `os_version()`, `idiom()`, `is_desktop()` |
  | `Intl.NumberFormat()`, `toLocaleString()` (the user's locale) | `locale()` (a `Locale`: `de-DE`; reading subscribes), formatted with a Rust crate: `Intl` and the locale-aware `toLocale*String`s are JS globals of TS apps |
  | `requestAnimationFrame(cb)`, `cancelAnimationFrame` | `request_animation_frame(\|at\| ..)` returns a `Spawned`; in a task `next_frame().await` (an `Instant`), once per frame in a loop |
  | a view's `direction` style | `.direction(LayoutDirection::Rtl)` (`Styled`); the surface's direction follows the user's language |
  | `import logo from "./logo@2x.png"`, `import font from "./a.ttf"` | `const LOGO: ImageAsset = asset!("logo@2x.png");` (`image(LOGO)` lays out at its natural size), `const A: FontAsset = asset!("a.ttf");` (`.font_family(A.family)`), with `registry.assets(assets!())` (below) |
  | `Image.getSize(src)`, `Image.prefetch(src)` | `image_size(src)` / `prefetch_image(src)`: answers to await in a task |
  | `Clipboard.writeText(text)`, `await Clipboard.readText()` / `hasText()`, `writeImage(src)`, `readImage()` / `hasImage()`, `readFiles()` (`nsh/clipboard`) | `set_clipboard(text)`, `clipboard_string()` / `clipboard_has_string()`, `set_clipboard_image(uri)`, `clipboard_image()` (an `Option<ClipboardImage>`) / `clipboard_has_image()`, `clipboard_files()`: answers to await in a task (the app's `capabilities.clipboard` applies as for JS) |
  | `await Storage.getItem(k)`, `setItem(k, v)`, `removeItem(k)`, `keys()`, `clear()` (`nsh/storage`) | `nsh_core::storage::Storage::get_item(k)`, `set_item(k, v)` (`Err(StorageFull)` past the quota), `remove_item(k)`, `get_all_keys()`, `clear()`: synchronous (the entries are in memory on the engine thread), and the same entries the app's JS uses, so a TSX entry and a Rust entry of one app read each other's data |
  | `announce(message)`, `setAccessibilityFocus(ref)` (`nsh/accessibility`) | `announce_for_accessibility(msg)`, `note.set_accessibility_focus()` (an `ElementRef`) |
  | `Toast.show(msg, "long")` (`nsh/android`) | `toast(msg, ToastDuration::Long)` (nothing happens off Android) |
  | `safeAreaInsets()` | `cx.insets()`: the insets where the component is (the nearest screen's or modal's, else the surface's safe area) |
  | a signal or store at module level | `global::<G>()`: a `Signal<G>` of the surface, made with `Default` (shared by its components and modules) |
  | `context(default)` / `<Ctx.Provider value>` / `Ctx()` | `provide_context(value)` in the body; `use_context::<T>()` below it (through the app's elements too: a component JS made among another's JS children is under where that one places them); provide a signal to change what readers see |
  | `createAnimatedValue`, `Animated.spring`, `interpolate` | `animated_value(0.0)` (`Copy`, kept by the current owner); `.bind_translate_y(&v)` / `.bind_opacity(..)` / `.bind_background(..)` / `.bind_border_color(..)` / `.bind_color(..)` / `.bind_shadow_color(..)` / `.bind_shadow_opacity(..)` / `.bind_shadow_radius(..)` / `.bind_scale(..)` / `.bind_rotate(..)`, `.pan_values(..)` (drags move it natively), `.pinch_value(&scale)` / `.rotation_value(&angle)` (TS `pinch={{ scale }}`, `rotation={{ angle }}`), `scroll().scroll_value(&v)`, canvas arguments (`Painter::new().fill_rect(0.0, 0.0, &v, 4.0)`); `v.spring(to, Spring::default())` / `.timing(to, ms, easing)` / `.timing_with(to, Timing { delay_ms, .. })` / `.decay(..)` / `.decay_within(.., (min, max), bounce)` return an `AnimationEnd` to await; `v.value()` (`getValue()`; after `v.stop()`, `stop()`'s promise) an `Answer<f32>`; `v.set_offset(..)` / `.flatten_offset()` / `.extract_offset()`; `ui::sample_easing` / `sample_spring` / `sample_decay` (`Easing.sample`, `Animated.sampleSpring` / `sampleDecay`) the curves, to draw them; `v.interpolate(..)`, `.interpolate_with(.., Interpolation { extrapolate_left, extrapolate_right, easing })`, `.add(..)`, `.diff_clamp(..)` derive nodes |
  | `Animated.sequence / parallel / stagger / delay / loop`, `.start(cb)` / `.stop()` / `.reset()` | `Animation::sequence([Animation::timing(&v, to, Timing::new(ms, easing)), Animation::delay(ms), Animation::spring(..)])`, `::parallel(..)` (`.stop_together(false)`), `::stagger(ms, ..)`, `.looped(iterations)` (`.reset_before_iteration(false)`); `a.start()` returns an `AnimationEnd`, `a.stop()`, `a.reset()` |
  | `keymap.bind("mod+k", f, { when, repeat })`, `keymap.label("mod+k")` (`nsh/keymap`) | `on_key("mod+k", \|keystroke\| ..)` / `on_key_with(k, KeyOptions { when, repeat }, f)`, bound while the current owner lives; `key_label("mod+k")` (`⌘K`, `Ctrl+K`). The core joins the views' bindings to JS's in the root's one table (a view's after JS's: it wins on the same keystroke) and runs a view's handler itself when the root's `KeyCommand` reports it; their ids start at 2^31, above JS's (`ui/keys.rs`) |
  | `BackHandler.onBackPress(f)`, the function it returns | `on_back_press(\|\| -> bool)`: registered while the current owner lives (only while a signal holds: inside an `effect`). After modals and before stacks, the views' listeners run newest first, then JS's; when none returns true the core sends `Command::Back`: the top stack pops, else the app exits (`ui/back.rs`) |
  | `<ErrorBoundary fallback>` | `catch_error(\|\| view, \|error, reset\| fallback)` |
  | a class TS uses (`new Tally(3)`, `tally.add(2)`, `tally.count`, `await tally.save(p)`) | `#[class]` on the struct and its `impl`, `registry.class::<Tally>()`: synchronous members run in the call, `async fn`s return promises |
  | a function returning its value (`checksum(bytes)`) | a `#[module]` function without `cx` (not `async`): it runs in the call |
  | a callback TS passes (`items.sort((a, b) => ..)`, a listener) | a `Callback<A, R>` parameter: `call(args)` inside a synchronous call, `post(args)` / `call_async(args).await` from tasks; kept in a class's field, it is collected with a cycle through the object |
  | `<Overlay anchor={ref} placement="bottom" onPressOutside onCancel>` (`nsh`) | `overlay().anchor(&r).placement(Placement::Bottom).on_press_outside(\|p: &Point<Points>\| ..).on_cancel(..)` (`.anchor_point(p)` for a point, `.align`, `.offset`, `.margin`, `.on_position(\|p: &OverlayPosition\| ..)`): on top of the root view, outside the parent's layout and clipping (`elements.md` "Overlays"); a whole-window layer is `.inset_0()`, a dialog `nsh_base::dialog()` |
  | `ref={el}`, `el.focus()`, `await el.measure()` | `element_ref()`, `.element_ref(&r)` on the element, `r.focus()` / `.scroll_to(..)` / `.seek(..)` / `.command(..)` from listeners and tasks; `r.measure()` is an `Answer<Option<Measurement>>` (`frame: Bounds<Points>`, `page: Point<Points>`) to await in a task |
  | `onStartShouldSetResponder`, `onMoveShouldSetResponder(Capture)`, `PanResponder.create` | `.claim_touches(TouchClaim::on_start())` (`::on_move()`, `.capture()`, `.ask(\|request: &ClaimRequest\| request.claim())` to decide with state and the gesture, `.block_native(false)`; `TouchClaim::on_pan(PanActivation::horizontal(px(10.0), px(10.0)))` (`panActivation`) claims when the platform activates a pan, deciding on the main thread, `elements.md`), `.keep_touches(true)` (`onResponderTerminationRequest` → false); `.on_responder_grant` / `_move` / `_release` / `_terminate` / `_start` / `_end` / `_reject` get a `ResponderEvent` (the finger's `location` and `page`, `Point<Points>`, and `gesture: PanGesture`: `delta`, `vx`, `vy`, the centroid's `position` and `origin`; `PanGesture::begin` / `update` follow one from `on_touch`) |
  | a ref to a component, `await counter.value()`, `counter.setValue(5)` | `component_ref::<Counter>()`, `counter().component_ref(&r)`, `r.api::<CounterApi>()`: the API its view registered, its methods called directly |
  | `<List header footer empty separator stickyHeaderIndices stickyHeaderOffset viewabilityConfig onViewableItemsChange loadMoreThreshold initialScrollIndex>` | `virtual_list(count, row).header(..).footer(..).empty(..).separator(\|\| ..).sticky_header_indices(..).sticky_header_offset(..).viewability(..).minimum_view_time(..).on_viewable_items_change(..).load_more_threshold(..).initial_scroll_index(..)`: the header, footer and empty view are part of the view, never recycled |
  | `<List maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }}>` | `.follow_end(px(40.0))` (`ListLayout`: on `virtual_list(..)` and on a placed `ListElement`) |
| `<List viewport="parent">` (in a `Scroll` with the rest of the page) | `.viewport(ListViewport::Parent)` (`ListLayout`): laid out at its full length, its rows follow the scroll view around it; fixed when the list is made |
  | `<Feed each={rows} keyExtractor header={Header}>{row}</Feed>` (a component with an `Items` prop) | `feed().items(virtual_list(n, row).keys(move \|\| ids).header(..))` (the `Items` field's setter) |
  | `<Text>a <Text style={link} onPress={f}>b</Text> <View/></Text>` | `text("a ").child(link("b").on_press(..)).child(" ").child(view())`: one paragraph, links and inline views |
  | `class="group"`, `group-active:`, `dark:`, `disabled:`, `selected:`, `checked:`, `activeStyle` / `hoverStyle` / `focusStyle` / `disabledStyle` | `.group()`, `.group_active(\|s\| ..)`, `.dark(\|s\| ..)`, `.disabled_style(\|s\| ..)`, `.selected(\|s\| ..)`, `.checked(\|s\| ..)` (native, no binding) |
  | `<Button disabled={saving()} onPress={save} class="px-4 active:opacity-60">Save</Button>` | `button().disabled(move \|\| saving.get()).on_press(move \|\| save()).px_4().active(\|s\| s.opacity(0.6)).child(text("Save"))`: a setter per prop, a listener method per event |
  | `<Button class="bg-blue-500 active:opacity-70 selected:bg-green-500">` (state styles on a component) | `button().bg(..).active(\|s\| s.opacity(0.7))`: `ComponentBuilder`'s `active` / `hover` / `focus` / `disabled_style` and `Styled`'s `selected` / `checked`, on the component's root (`Styled::selected(el, \|s\| ..)` where a `selected` prop's setter comes first) |
  | `<NavPage headerClass="bg-white text-black tint-blue-500">` | `nav_page().header_style_with(\|s\| s.bg(..).text_color(..).tint_color(..))` (theme colors follow the appearance natively; `header_style(Style)`, TS `headerStyle`, wins key by key) |
  | `bg-sky-500` (the palette) | `.bg(palette::SKY.shade(500))` |

- **A nested component is made as a primitive is**: `#[component] fn Chip` makes `chip()` (the function's name in
  snake case, of its visibility), which returns a `ChipElement` (a newtype of `ComponentElement<Chip>`, also made by
  the macro) with every prop at its default (`Props::initial`; a required prop too: its setter sets it). On it:
  - a **setter per prop**, named as the field (`.label(..)`, `.disabled(..)`): it takes what a primitive's setter
    takes, a value of a type that becomes the field's (`IntoProp<T, M>`: `U: Into<T>`), a signal, memo or `Prop` of
    it, a `Reactive`, or a closure returning one (a binding); a number field takes `IntoReactive<T>`, so a literal
    is of the field's type (`.index(1)`); an `Option<T>` field also takes a `T` (`From<T> for Option<T>`) and a text
    one a string (`.label("Save")`); a field that is not a `Prop` takes `Into<T>` (a number exactly its type); a
    slot's setter takes the content to fill it with (`.header(text(..))`), an `Items` field's a `VirtualList`
    (`.items(virtual_list(..))`); a style field's (`Prop<Style>` or `Style`: `Button`'s `selected_style`) the
    typed styles' closure, as the state styles take (`.selected_style(|s| s.bg(..).text_color(..))`), made into
    the field's `Style` (`From<StyleRefinement>`); a render prop's (`Option<Renderer<T>>`: `TextView`'s
    `render_image`) the closure rendering a `&T` (`.render_image(|image| ..)`, made a `Renderer`); the children are
    the element's `.child(..)`ren;
  - a **listener method per event**, named as its TSX handler in snake case (`onPressDown` is
    `.on_press_down(..)`): a unit variant's takes `move || ..` (or `move |_: &()| ..`), a one-field variant's
    `move |value: &T| ..` (a `Listener<T>` too: `IntoListener`), a named-field variant's the event itself
    (`move |e: &ChipEvent| ..`, called for that variant only). Several listeners of one event all run, in order;
    they handle the events instead of the app;
  - what every element takes (`Styled`, `ParentElement`, `FluentBuilder`, the inline style, animated values, insets;
    below) and `ComponentBuilder`'s `.active(..)` / `.hover(..)` / `.focus(..)` / `.disabled_style(..)` (the root's
    states) and `.component_ref(&r)`. `ComponentBuilder` is in the prelude, so `use nsh_core::ui::prelude::*;` and
    the constructor (`use nsh_base::button;`) are all a caller imports.

  A prop's setter is an inherent method, so it comes before a trait's method of the same name: `nsh_base`'s
  `Button`'s `selected` prop before `Styled::selected` (the `selected:` style, then `Styled::selected(button, |s|
  ..)`), a `size` prop before `Styled::size`. The setters and listener methods are made where their types are in
  scope: `#[derive(Props)]` and `#[derive(Event)]` implement `__private::PropField<I>` / `EventVariant<I>` (the
  field's type, the variant's data and how to pick it) and make a hidden `macro_rules!` of the type's name, imported
  with the type (the macro namespace), which the component's `#[component]` expands on its element with the paths
  its signature names; so a component's props and events are of its own crate. The constructor and the element
  type are items of the component's module: a function of the same name there is a conflict (`fn toggle()` beside
  `#[component] fn Toggle`), and a local variable of that name hides it.

  `Component::element(props)` (the props struct whole) and `ComponentElement::on_event` (every event, typed) remain
  for components implemented by hand (`impl Component for X`, which get no constructor) and code generic over
  components; Rust views use the constructors.
- **Platform services** are free functions (`ui/ambient.rs`): `dialog(Dialog)` (deprecated for apps in favor of
  `nsh_base::alert_dialog()`, which calls it) shows an alert or action sheet and returns a future of the index
  chosen (-1: dismissed; the answer is the root's `Dialog` event, which the core resolves; JS never sees it); `dismiss_keyboard()`, `animate_layout(..)`, `announce_for_accessibility(..)`,
  `toast(..)`, `set_color_scheme(..)`, the clipboard (`set_clipboard`, `clipboard_string`,
  `clipboard_has_string`), the image information (`image_size`, `prefetch_image`), display frames
  (`request_animation_frame`, `next_frame`: the core keeps the waiting tasks' answers, the engine asks the platform
  for a frame while one waits, `MountSink::request_frame`, and delivers it at `EngineControl::frame`), and the status
  bar (below); they are actions the core applies in order with the view's other changes (`ui/services.rs`,
  `core/services.rs`). They work wherever the core runs Rust code: a view's body, its bindings, listeners and tasks,
  and modules.
- **Animated values** (`ui/animated.rs`) are nodes of the platform's animation graph with odd ids (JS's are even, like
  node ids: the graph indexes nodes by id, so both must stay dense; ids from 2^31 are the graph's own composite steps).
  `AnimatedValue` and `AnimatedNode` are `Copy` handles, as signals are: the owner current when one is made (the
  component, a region, a row; `reactive::Kept`, a slot of the graph holding the node's `Rc`) keeps the node and releases
  it when it is disposed, so closures share a value with no clone. Used after that, a handle does nothing (its
  animations end at once, unfinished; a derivation of it is no node; a drawing reads it as 0) and never panics. What
  binds a node holds it while bound (`LiveNode`: an element's bound styles, `pan_values` / `pinch_value` /
  `rotation_value` / `scroll_value`, a drawing's slots, a composite's values, a derived node's inputs), so a binding in
  a region that outlives the handle's owner goes on moving, and so does an animation running on it; the node is released
  when the last of these goes. Deriving the same node again gets the live one, through the handle the current owner
  keeps of it (made the first time: `Derived`), so a derivation run over and over adds no slot. Made with no owner at
  all (outside any component), a handle lives as long as the surface, as a signal made there does. Colors interpolated from theme colors (`v.interpolate_colors(&[0.0, 1.0], &[colors::TRACK,
  colors::ACCENT])`, any `AdaptiveColor`) follow the appearance: a binding of the view gives the node the other
  appearance's colors in place when it changes (`AnimationOp::SetOutput`), so nothing is made again and its bindings
  stay; such a node is derived again by both appearances' colors (`DerivedKey`), so interpolations that share their
  light colors, or a constant one and a theme one, are different nodes. Bound style properties go into the element's inline style, before the app's `style` on a host (the core keeps
  the app's and composes the two). The animations' ends come back through `Core::animations_finished` (the engine hands
  JS the rest). An `Animation` is sent whole as one `AnimationOp::StartComposite` and runs in the graph step after step;
  its composite key (odd, JS's even) is what `reset()` restores by, and dropping the last handle releases it (a run
  going on goes on).
- **Element refs** (`ui/element_ref.rs`) hold the node of the element that carries them, set when the element is applied
  and cleared when it goes; their commands go out through the executor, and an event's handling applies them right after
  its own changes, so they keep their order. `ElementRef` and `ComponentRef` are `Copy` handles kept by the owner
  current when they are made, as animated values are; the element carrying one holds what it names (`RefTarget`) while
  it is mounted, so mounting and unmounting it never reach the ref's owner. Once that owner is gone, `node()` is `None`
  and commands do nothing, as with no element carrying it. A measurement (`measure()`) waits in the core for the layout
  of the commit it goes out with, as JS's `Command::Measure` does, and is answered there (`Core::measure`); none goes to
  the platform.
- **Element attributes for system UI**: `.inset_padding(insets)` / `.inset_margin(insets)` add to the padding /
  margin the styles resolve to (what `SafeAreaView` and `KeyboardAvoidingView` use, so the app's own padding stays),
  `.inline_style(props.style)` applies a `ui::Style` prop (a value or a binding).
- **A `ui::Style` holds JS's declarations, Rust's typed styles or both**: JS decodes a style object into declarations
  (`StylePatch`, applied as the prop it goes to: `selectedStyle`, the inline style); a Rust caller's closure gives typed
  styles, which the element that takes the style (`.selected_style(..)`, `.checked_style(..)`, `.inline_style(..)`) adds
  to its own in the state's variant, as `.selected(|s| ..)` would (theme colors follow the appearance natively, bound
  parts their signals; a bound `Style` adds them as a bound part when it has typed styles as the element is made, so a
  style prop left unset or set from JS costs nothing more), and a page's `.header_style(..)` as `header_style_with`'s.
- **What a view gives a nested component's element** (`chip()`) goes on the component's root, after
  the root's own, as its styles do: an inline style (`.inline_style(..)`), animated values (`.bind_opacity(&v)`,
  `.bind_translate_y(&v)`), insets (bound ones are a binding, applied again when they change), on a rooted
  component's host as on any (`Instance::given`, `RootContext`: the inner first, the outer last, then the app's style
  on the top host). Its state styles (`.active(|s| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)`, and
  `Styled`'s `.selected(..)` / `.checked(..)`) are variants of those styles, so they follow the states of that root
  (pressed and hovered as reported by the platform when the root takes presses, disabled, selected and checked as its
  view sets them), as an app's `active:` classes on a TSX component do. Listeners and accessibility are not on it
  (a component's element is not `Interactive` or `Accessible`): a component says what it hears and is through its
  events and props.
- An app's own types become static values for setters with `nsh_core::static_reactive!(Tone: Tone);`. A closure
  returning a bare float literal for an `f32` setter needs its type: `move || if on { 0.5_f32 } else { 1.0 }`.

## Methods

The methods of a component's ref in JS are those of an API handle its view makes, holding the signals they read and
write: `#[methods] impl CounterApi { pub fn set_value(&self, v: f64) {..} pub fn value(&self) -> f64 {..} }`
implements `Api`, the view registers it with `cx.methods(CounterApi { .. })` for as long as it lives, and
`#[component(methods = CounterApi)]` (`Component::METHODS = Methods::of::<CounterApi>()`) names it in the spec, so the
JS face builds the ref (`CounterRef`: `node` and the methods, typed from the Rust signatures and docs) with no TS
written. A call converts its arguments in the JS call into a closure an op carries (`RustCall::Method`), so it runs
in order with the props JS set before it, with the API the view registered. Its return type decides what TS gets:
a method returning `()` gives `void`, with no reply (JS calls it and moves on, a wrong argument throws in the call);
one returning `Result<(), E>` gives `Promise<void>` (rejected with the `Err`'s message: the method runs at the
commit, after the JS call returned, so it cannot throw); one returning a value gives `Promise<T>` (a wrong argument
rejects it). Promises settle from the core's events (`JsEvent::Reply`, the boxed value converted then) in the same
frame's commit rounds. Rust calls the methods directly: `ComponentRef::api::<CounterApi>()`.

## Modules

Functions a registry exports without a component (`AlertDialog.show`, `Keyboard.dismiss`) are a
unit struct and its `impl` block, both `#[module]` (the struct's doc comment documents the module; a component of the
same name stands for the struct): `pub fn`s are the functions, typed from their signatures (`Option`
parameters at the end may be left out). The signature decides how a call runs (`FunctionCall`):

- **No context, not `async`** (`Sync`): it runs inside the JS call, as a class's method does (below), converting
  the arguments and the result directly; TS gets the value, an `Err` throws. It computes; the UI's free functions
  (signals, `dialog`, `theme()`) are not there (the reactive graph is not entered).
- **A last `cx: &mut ModuleCx`** (`Op`): the platform's services, applied in order right after the call (a dialog,
  the status bar, focus). Its arguments are converted in the JS call into a closure an op carries
  (`RustCall::Op`, in order with the ops before it). As for a method: returning `()`, it gives `void`, with no
  reply (a conversion error throws); returning `Result<(), E>`, `Promise<void>`; returning a value, `Promise<T>`,
  settled like a method's (a conversion error rejects it).
- **`async fn`** (`Async`): no context; it runs as a root task, reaching the platform with the same free functions
  views use (`AlertDialog.show` awaits `alert_dialog()`'s `show()`), sent as the op above; it gives a Promise of its value
  (`Promise<void>` for `()`), rejected with an `Err`'s message or a panic's.

Parameters are `Arg`s: the `JsValue` types, instances (`Instance<T>`) and `Callback`s; results are `Ret`s. In an op
or a task, instances and functions ride in its closure as they are (`docs/dev/rust-classes.md`, "How calls
cross"). A panic in an op rejects it (its actions dropped). `Registry::module::<M>()` registers it; `components.rs` builds
the object. A module with a component's name is merged into it (the component gets static
functions). `Registry::reexport` re-exports environment values (`safeArea`, `safeAreaInsets`, `keyboardFrame` in `nsh/base`:
`nsh-js` `env.rs`) under the registry's module, and `Registry::native_values` names the
values `nsh-js` makes for it (`nsh/base`'s `NavStack`, `NavPage`, `Dialog`, `createNavStack`: `navigation.rs`).

The runtime's Rust modules are written the same way (`crates/nsh-core/src/runtime/`,
`runtime::registries()`): one `Registry` per JS module (`Registry::runtime("nsh/clipboard")`), always served, which the
core always serves (`Core::set_components` merges the UI sets after them); a call carries what it runs, so a
runtime module's functions never clash with an app set's of the same name. Runtime modules
use the same services as components (`cx.toast`, `cx.announce_for_accessibility`, `image_size`), and the core's
internal actions for the rest (exiting the app, a ref's accessibility focus).
`#[module(flat)]` exports functions one by one (top-level exports, not an object's). `#[module(name = "test")]` names a
module's object in JS (the type's name otherwise); a module named like a function a flat module of the set exports
is merged into it as into a component: its functions and constants are the function's properties (`test.skip(..)`,
`describe.only(..)`: `Registry::function_members`; TS declares a namespace of the function's name, and the module is
no export of its own). A function returning `Result` rejects
the promise with the error (throws, when it runs in the call); a `NodeRef` parameter is a `YNode` in TS (the node's
id, and its object again as a result).

## Classes

A Rust type TS uses with `new` (`docs/dev/rust-classes.md`): `#[class]` on the struct and on its `impl` block
implements `Class` (its `ClassDef`: name, doc, members) and `Registry::class::<C>()` exports it. In the block, `new`
is the constructor (without one TS cannot make it: `private constructor()`), `&self` / `&mut self` functions are
methods, `#[getter]` / `#[setter]` (`count`, `set_count`) the property `count`, functions without a receiver
statics, and `async fn`s (`this: Instance<Self>` first, for a method) members returning promises.

- **Instances live in Rust**, in an `Rc<RefCell<Option<C>>>` (`Instance<C>`), owned by their JS object: an object of
  the web classes' QuickJS class (`nsh-js` `web/mod.rs`) whose slot holds the `Rc` (`classes.rs`), so collection,
  `instanceof`, `new.target` (TS subclasses) and re-entrancy behave as for `URL`. The object being collected drops
  its handle; `dispose()` and `[Symbol.dispose]` drop the value at once, and any use after throws a `TypeError`. An
  instance has one object while both live (`classes.rs` remembers it by the `Rc`'s address): a member returning an
  instance Rust keeps gives the object it has.
- **Members that are not `async` run in the JS call** (`MemberCall::Sync`), outside the core: `nsh-js`'s `CallHost`
  implements `JsHost`, and the generated code converts the arguments and the result directly
  (`JsValue::from_js` / `to_js`, no JSON: the derives implement them too), borrows its instance for the call (a
  re-entrant use throws "used re-entrantly") and catches a panic as an `Error` (where Rust unwinds: the web runtime
  aborts on a panic). A wrong argument is a `TypeError`
  naming the member and the parameter (``Tally.add: `by`: expected a number, got "x"``). `&Other` / `&mut Other`
  parameters borrow another instance for the call, `Instance<Other>` keeps one; results `Self`, `Other` and
  `Instance<Other>` are objects. Another class's object is refused.
- **`async` members are ops** (`MemberCall::Async`): `this` and the arguments are converted in the JS call into
  the start of a task an op carries (`RustCall::Task`), which the core runs as a root task like an async
  function's; the instances ride in it, so a task keeps its instance after the object goes, and the instance it
  resolves with is converted to its object when the promise settles. Ops the engine drops (the VM stopped) reject
  their promises (`Core::discard_ops`).
- **Callbacks** (`callback.rs`): a `Callback<A, R>` parameter is a JS function (`A` one value, `()` or a tuple;
  `(a: string, b: number) => boolean`). `call` runs it on the spot, only inside a synchronous call from JS (it
  panics in a task, and rethrows an uncatchable interrupt when the call returns, and fails inside a collection);
  `post` and `call_async` queue a `JsCall` in `Posts`, one ordered queue the engine makes and hands to the script
  and the core (`HostOptions::posts`, `Core::set_posts`), which the engine runs (`Host::run_posted`) at each
  commit round before the core's events, so a task's posts reach JS before its result. A post made inside a
  synchronous call from JS is parked in its place until an op after the ops JS sent before it is applied
  (`RustCall::Post`: the op's place releases it whichever way the op goes), and what those ops post goes before it,
  so posts run in program order. `call_async` settles a
  promise the function returns; once the VM stops, queued and later calls are dropped and their replies say so.
  `nsh-js` keeps the functions in a table of the context (freed with it, so callbacks Rust keeps longer do
  nothing). `#[class]` on the struct implements the `unsafe trait Trace` from every field whose type implements it
  (chosen by type, so aliases count); the object's mark hook reports them when it is the instance's only owner, so
  a listener that captures its own object is collected; callbacks held elsewhere are roots. Before a collected
  object's value drops, its callbacks are released: its `Drop` calling one finds it gone.
- **A class a signature names is registered with it** (`Registry::module`, `class`, `register` follow the
  members' `ClassRefs`), so its objects have a class, an export and a declaration.

## The status bar

The status bar follows UIKit: the topmost view controller decides (`preferredStatusBarStyle`), Info.plist holds the
default. `ui/status_bar.rs` layers the surface's settings (`StatusBarSetting`: style, hidden, animated, each optional),
one `StatusBars` per surface, owned by the core. At the bottom is the app's default: `nsh.json` `"statusBar"` (the
entry's `setup` sends `Command::SetStatusBar`; a Rust app's `Root::status_bar`) and `ModuleCx::set_status_bar(patch)`,
which patch it. Over it, each screen and modal with a `statusBar` (`ScreenProp::StatusBar`, pages and dialogs share
it) holds one entry while it is in the tree: the core keeps the few nodes that have one (`status_bar_nodes`, in the
order they got it); an insert or a removal with any of them in the tree only flags them, and the commit adds the
entries of the ones now in the tree and removes the others' (so a pushed page or a presented dialog is over the
pages below it, and popping or closing removes it). A changed value is set in place and keeps its place. The most
recently added wins, field by field. Each change only marks the layers; `commit` sends one `Command::StatusBar` with
the merged result when it differs from the last one sent.

## Tasks

`ui/task.rs`: a small executor of the core runs futures on the engine thread, so they may hold signals and other
`!Send` handles. Each poll runs inside a tokio runtime's context (`Core::set_task_runtime`; the engine's
`EngineConfig::runtime`, else one runtime of two threads shared by the process), so the tokio ecosystem works in a
task: network and file IO, channels; `background(fut)` / `blocking(f)` run `Send` work on the runtime's threads. A
waker may fire on any thread: it sends the engine a `Wake` message, and the loop runs the woken tasks
(`Core::run_component_tasks`). Timers (`timer(d)`, `timer_until(at)`, and `set_timeout` / `set_interval` on them)
are the executor's own, not tokio's: the core fires them as they come due and the engine's loop waits for the
soonest (`Core::next_task_timer`), as it does for JS's, so they are as punctual as JS's on the engine thread (a
tokio timer wakes the engine from another thread, which the OS may run late), and they follow the engine's clock
(`nsh_core::time::now()`, a test's manual one: `architecture.md` "Time"); awaited off the engine thread (in
`background`), a `Delay` is tokio's. A task changes what it wants by writing
signals, inside the graph like any other Rust code of the view; the patches that makes go out with the next commit.
`spawn`, `set_timeout`, `set_interval` and `request_animation_frame` return a `Spawned`: the task belongs to the owner
current when it was made and ends with it (or at `.cancel()`), and is polled under it, so what it makes is that
owner's; awaiting a `Spawned` gives its output.

## Environment

The engine hands the core what views may read (`ui::Environment`: window, safe area, keyboard height, appearance,
font scale, reduced motion, screen reader, direction, pixel ratio, OS, its version, idiom, locale). The core keeps
each part in a signal of the surface (`ui/ambient.rs`), as it does the theme, the globals and each screen's or modal's
insets: `window()` and the like read them, so a binding that read a part runs again when it changes and nothing else
does. The surface's direction follows the user's language: its root's (`Prop::LayoutDirection`, which JS sets from
the language), else the platform's; in a Rust app the core sets the root's direction from the language from the start
and again when it changes. A view's `direction` style sets its subtree's, and each node's resolved direction is what
layout, text and overlay placement read.

## Assets

A crate ships files in its `assets/` directory, as TS imports them: `asset!("logo@2x.png")` (`nsh-macros`, the path
relative to `assets/`) reads the file at compile time and is an `ImageAsset { url, size, scales }` (the natural size in
points, `Size<Points>`: `@2x` / `@3x` divide the pixels; `scales` lists the `@1.5x`–`@4x` siblings of a file named
without a density, which `assets!()` ships and images pick from by the screen's pixel ratio, as for TS imports), a
`FontAsset { uri, family }` (`.ttf`, `.otf`: the family from the font's name table) or a `FileAsset { uri }`; a missing
or unreadable file fails the build (a variant too, and one whose pixels are off its scale), a changed one builds the
crate again (`include_bytes!`). An `.svg` is a `FileAsset`, where TS's import gives an `ImageAsset` (the macro reads
no SVG: sizing one takes usvg): `image(ICON.uri)` shows it, laid out by its style.
The URI is `asset:/@<package>/<path>`, apart from the app's own files. The registry
ships the directory: `registry.assets(assets!())` lists every file (`AssetFile`: URI, the file where the crate was
built, kind), which `nsh` (`rust_app.rs`, from the description of the set: each file's path and source) serves in development and
copies into packages next to the imported assets, and whose fonts the engine registers before the first view
(`EngineConfig::ui_sets`, read through `EngineConfig::assets`).

## Styles

`Styled` methods are named as in GPUI and Tailwind (`.flex_row()`, `.items_center()`, `.p_4()` = 16pt, `.gap(px(6.0))`,
`.rounded_xl()`, `.border_1()`, `.shadow_md()`, `.text_sm()`, `.font_weight(FontWeight::SEMIBOLD)`, ...); spacing steps
follow Tailwind's default scale, independent of the app's Tailwind theme. They cover what classes and styles do:
per-side borders and colors (`.border_t(px(6.0)).border_t_color(..)`), `.border_dashed()`, per-corner and start / end
radii (`.rounded_tl(..)`, `.rounded_ss(..)`), `.border_curve(BorderCurve::Continuous)`; shadows of their own
(`.shadow([BoxShadow { .. }])`, React Native's `.shadow_opacity(..).shadow_radius(..).shadow_offset(..)`,
`.shadow_color(..)` for both and the presets), `.inset_shadow_sm()`, rings, outlines, text shadows; 3D transforms and
skews, `.transform_origin(..)` / `.origin_top_left()`, `.backface_hidden()`; decorations (`.underline().line_through()`
draw both, `.text_decoration_wavy()`, `.text_decoration_color(..)`), `.uppercase()`, `.tabular_nums()`,
`.writing_direction(..)`; gradients (`.bg_linear_to_br().gradient_from(..).gradient_via(..).gradient_to(..)`,
`.bg_radial()`, `.bg_conic(..)`), filters and backdrop filters (`.grayscale(1.0)`, `.backdrop_blur(px(12.0))`),
`.mix_blend_mode(..)`, the pointer (`.cursor_pointer()`, `.cursor(Cursor::Text)`), transitions (`.transition_colors().duration(150.0).ease_out()`), keyframes (`.animate_spin()`; with TS's own timing keys
`.animation(KeyframeAnimation::new(Keyframes::Spin).duration(800.0))`),
grids (`.grid_cols(3)`, `.col_span(2)`), `.flex_grow(n)`. Tailwind's palette is typed too
(`ui::palette::SKY.shade(500)`). An element records declarations (`StyleRefinement`); the core lowers them into the
same rules Tailwind classes compile to (`ClassList`), cached and shared between elements with the same styles. There
is no string to parse and no `.class()`; the one way classes reach a view's element is the app's:
`.app_class(props.heading_class)` (a prop of the app's Tailwind classes for one of the component's parts,
`classes={{ heading: "text-2xl" }}`) resolves them as a host's `class` (the theme's tokens, `dark:`, states) and merges
them after the element's own styles (on a root, before the app's `class` on the host); a bound one applies again when
it changes, and they are resolved again when the tokens change (`Components::app_classes`).

- A style method given a binding (`.bg(move || ..)`, `.opacity(props.dim)`, `.style_when(cond, |s| ..)`) is a bound
  part of the element's style: when one runs again, the core lowers the element's style with the new value and
  applies only the declarations that changed. A step after a bound one in an ordered list (transforms) is kept in
  the bound part too, so the order holds.
- Theme colors are `AdaptiveColor`s (a light and a dark value) and lower into one declaration that picks by
  appearance (`Decl::Adaptive`): the platform's appearance switch restyles natively, without a binding, and the app's
  plain classes still win over it. The appearance is the app's own when it set one (`nsh.json` `"appearance"`, TS
  `setColorScheme`, `set_color_scheme`): the core keeps the system's and resolves `dark` for classes and `dark()`
  from both (`Core::set_appearance`), and tells the platform (`MountItem::Appearance`: iOS
  `overrideUserInterfaceStyle` on the root view, presented modals and alerts, the status bar's default style; Android
  the status bar's default style and alert themes; native widgets elsewhere keep the system's).
- `.active(|s| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)`, `.selected(..)`, `.checked(..)` lower into
  rules on the view's interaction states (Tailwind's ranks): press feedback is native. On a nested component's element
  they style its root. `.group()` makes a view a group and `.group_active(|s| ..)`
  (`_hover`, `_focus_within`, `_named` for `group/name`) styles what is inside it by the group's states;
  `.dark(|s| ..)` styles what is not a color in dark appearance. Nested variants all have to hold. A part of a control
  shows the control's value and disabled state to its own classes and state styles with
  `.project_checked(props.checked)` / `.project_indeterminate(props.indeterminate)` / `.project_disabled(props.disabled)`
  (`gpui-base`'s `SwitchThumb::new(checked)`, `CheckboxIndicator::state(..)`): the app writes `checked:` /
  `indeterminate:` / `disabled:` in the part's class, and only the control's root is an accessibility element.
- What never changes is plain Rust, decided when the view is made: `.when(variant == Variant::Ghost, |v| ..)`.
- The app's `class` / `classList` on a component (Tailwind) is merged after the root's rules; at equal rank it wins.
  The styles a view gives a nested component element merge the same way (bound ones too: `Patch::Nested`).

## The theme

The core has no theme, as GPUI has none: it keeps **design tokens** (`ui::Tokens`: colors with a light and a dark
value, numbers and font families, named as CSS custom properties without `--`: `muted-foreground`, `radius`,
`font-sans`), gives no name a meaning but `font-sans` (the app's default font, as Tailwind's `--font-sans` is a
page's; `font-mono` is the monospaced one) and has none of its own. The theme is `nsh/base`'s: `nsh_base::Theme`
(`crates/nsh-base/src/theme.rs`) has shadcn/ui's tokens, exactly: `background` / `foreground`, `card`, `popover`,
`primary`, `secondary`, `muted`, `accent` (each with its `-foreground`), `destructive`, `border`, `input`, `ring`,
`chart-1` to `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary` / `-foreground`, `sidebar-accent` /
`-foreground`, `sidebar-border`, `sidebar-ring` and `radius`, one field each (`theme().primary`, `theme().chart_1`,
`theme().sidebar_ring`, `theme().radius`), plus Tailwind's fonts `font-sans` / `font-mono` (`theme().font_sans`,
`theme().font_mono`; `None`, the system's fonts). `theme()` returns the theme of the tokens drawn with now, made once
per change of them; an app's own tokens are read by name (`theme().color("up")`). The defaults are shadcn's `neutral` theme (`default-theme.json`, `radius` 0.625rem = 10 pt); no component of
`nsh/base` draws with them but `TextView`'s reading typography and the default looks of `Editor` and `DiffView`.

A theme file is shadcn's registry `cssVars`, as shadcn and tweakcn export them: `{ "cssVars": { "theme": {…},
"light": {…}, "dark": {…} } }` (`theme`'s values in both appearances, `light`'s in the light one and in the dark one
where `dark` leaves them out). Values are CSS: colors (hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, names,
`color-mix()`, `var(--x[, fallback])` of the same appearance's tokens, the file's or the default's), lengths (`rem`
is 16 pt, `px`) and font family lists for `font-*` names (the first family that is not generic, `system-ui` /
`sans-serif` / ... meaning the system's); values of no kind a token has (shadows, letter spacing) are left out. An
app sets its own in `nsh.json`: `"theme": "brand.json"` (relative to `nsh.json`) or the same JSON inline, over the
default. Names the theme adds (`surface`, `up`, `radius-card`) are the app's own tokens, as the variables of a
Tailwind 4 `@theme` are (`Theme::color` / `number` / `font`, `set_color` / `set_number` / `set_font`): classes name
them (`bg-surface`, `bg-up/30`, `rounded-(--radius-card)`; `styles.md`) and TS reads them with `token()` of `nsh`
(`nsh-js` `env.rs`: reactive, a color as `#rrggbbaa` in the appearance shown, a number, a font family), typed by
`interface Tokens`, which nsh writes per app into `.nsh/types/nsh/tokens.d.ts` from the theme
(`nsh_bundler::tokens_declaration`). The bundler checks the
theme; the entry hands the file to the renderer (`nsh:rt` `setup`), which sends it to the root (`uiTheme`) before any
view is made and has `token()` read its tokens at once (`Core::theme_tokens`, given to JS before the bundle runs: the
op reaches the core only after the turn of the first render, which reads them already); the core makes tokens of it
with what a UI set brings (`Registry::tokens_from`: `nsh/base`'s `tokens_of`, which also gives the defaults when the
engine starts). A Rust app's root carries them (`Root::tokens`). `nsh_base::theme()` reads the tokens from a signal of
the surface (`ui::ambient::tokens`): new tokens run again the bindings that read them. An embedding app can give a
surface its own (`Core::set_host_tokens`, `EngineControl::set_tokens`; sent from `Engine::start_with`'s `setup` they
are in the first frame and JS's first render): they win over the app's until cleared, and the app's names they lack
stay, so an embedded app looks like its host (`embedding.md`, "GPUI and GPUI Kit apps").

## The host node and ids

In JS a component is a view (the host element `view`) with a `component` prop naming it (its registered name,
`my_app::chip::Chip`): its **host**. `Core::apply` sees the prop, creates an instance and from then on
intercepts the ops on the host (`intercept`): the host is the root of the component's view, the elements below the
root become nodes the core creates itself. Apps without components pay one check per op. The root can be any
element: at the view's first mount, before the host's native view is sent, the core gives the host the root's kind
(`Core::retag`: a text, a screen, a modal, a list), so the root's props and children apply to it; a root that is a
region goes in the host view.

A root that is a component (a view that is `press()`) is made on the same host, as a TSX function component returning
another is that one: the nested instance's host is an alias of the host's node (`Core::alias`: another id naming the
same node, no node of its own; what the core sends names the node by its own id, `native_id`), and its view makes
the node (`expand_rooted`; `Instance::rooted` / `above` link the two, as deep as roots are components). The node gets
the innermost view's root, then the styles each component above gives the one below (the outer last, then the app's
`class` on the top host and its `style`); it listens to that root's events and to JS's on the host; the host's
native events, touches and responder go to the innermost component (`base_of`), whose events reach the view above as
a nested component's do. The props, listener, ref and content the outer view gives it are a nested component's;
the JS children it passes on are placed by the inner view. Releasing the host releases them all, the aliases only
forgotten.

A view JS made (`<Chip>` in TSX) is made when its host is first in the root's tree, so it is under the view that
placed it: it adopts the owner of the nearest component above it (where that one places its JS children, else its
own owner), and `use_context` and failures reach that far (`owner_above`, `adopt`). Until then it waits
(`components.waiting`).

JS allocates even node ids (from 2), the core odd ones (from 3), so both id spaces stay dense and never collide. JS
never sees the made nodes; their events are the component's (below).

## Views and bindings

`core/views.rs`. The view is expanded once, under the component's owner. An element's bound parts (its text, its
bound props, the bound parts of its style, a list's bound layout) are taken off it first: the static parts are
applied as they are, and each bound part becomes a render effect of the graph whose runs queue a `Patch` with the new
value (`Text`, `Attrs`, `Style`, `Layout`, `Nested`, a list's `Rows`). The core keeps what it applied last per node
(`BoundNode`) and applies a patch against it with the field diffs of host props and styles, so a change sends only
what changed.

- **Patches are taken at the start of each commit round**, with the events views emitted, until none are left:
  writes in one event, task or JS turn coalesce into one run of each binding (the graph's batch), and their changes
  go out in one `MountBatch`.
- **Regions** are effects too (`Patch::Region`): the core reconciles that region's nodes alone, in place among its
  parent's other children before the region's anchor (the next static node, or the next region's first node);
  keyed elements (an `Each`'s rows) match by key and stay. Each element of a region is made under an owner of its
  own (the branch, the row), disposed with what it made when the element leaves; a region in a nested component's
  content joins that component's children in place (`join_nested_at`).
- **Failures**: Rust code of the view (its body, a binding, a listener, an effect, a task) runs shielded. A panic
  disposes the owner it happened under and goes to the nearest `catch_error` above it (`boundary_of`), else it is
  logged (`js` target). A panic never unwinds through the graph.
- An unknown component name logs a denial and shows nothing.
- Cost: a binding that runs again and changes one text costs ~0.3µs in the graph; the commit around it what the
  tree's layout costs (`bench_view_tick`, `docs/dev/performance.md`).

## Children, slots and rows

- JS inserts a component's children into the host; the core places them where the view's `Children` is, before the
  node that follows it (or keeps them out of the tree while the view has none: a `Children` in a region that is not
  shown). The core sets the `Prop<Children>` when JS adds the first child or removes the last, so
  `props.children.get().is_empty()` in a binding follows it. With `children_each`, the children are an `Each` keyed by the child's node over a signal of the host's JS
  children: one wrapper per child, so a child added or removed leaves the others' wrappers in place, and a child JS
  moves among them (a keyed `<Each>`'s row) keeps its wrapper, which the region moves. The JS face inserts a component's
  children through a memo of their getter, so their expression runs again only when what it reads itself changes: an
  `<Each>` among them is made once and keeps its rows, as a host element's does.
- A view passes its children on by placing its `Children` among a nested component's (`<Inset>{children}</Inset>`):
  they become that component's children (`Placement::Nested`), in that place among the content the view gives it,
  so its view places them, as deep as they are passed on; JS's insertions and removals follow them there, and content
  of the view above that is released leaves the children of every level it was passed on to. When the nested
  component goes, they leave its view and stay (JS's, or the content of the view above).
- Named slots: the JS face creates one holder view per slot **the app passes** (`componentSlot`), filled with that
  prop's JSX. `Prop<Option<Slot>>` is `Some` while the holder has children (the core sets it when it fills or
  empties); `place(..)` is a region of it, and the slot's element *is* the holder: its styles and handlers apply to
  it, the core places it but never releases it (it is JS's).
- A slot a Rust view fills (`.fill(name, el)`) has no holder: its content is
  nodes of that view (an element, or a region whose nodes come and go), which the nested component keeps as the
  slot's `Fill` and its view places where it places the slot, as JS children are placed (`Placement`). A place that
  only places it (`place(|s| s)`) puts the nodes there as they are (`ElKind::Filled`); a place that styles it
  (`place(|h| h.px_4())`) makes a node of the nested view's own with those styles around them. The slot's prop is
  `Some` while the fill has nodes. The fill is the placing view's content: reconciled whenever that view reconciles
  the nested element (a new element replaces the old in its place), released with it, and taken out of a place that
  goes before that place's node is deleted. A view passes a slot it is given on to a nested component's slot by
  filling that one with the place (`.fill("corner", props.corner.place(|c| c))`): the deeper fill's part is what
  fills the passing view's slot (`FillPart::Filled`, also inside the place's region), resolved through it as deep as
  it goes, and a change to the outer fill reaches the deeper slot (`Fill::forwarded`).
- Rows: the JS face makes a `List` of the app's data and row renderer and hands it to the host as the slot of the
  `Items` prop. The view places it like a slot and sends its layout (`ListConfig`: estimated size, columns,
  direction, padding, gaps; its bound parts as `Patch::Layout`). Each item cell of that list gets the component's row
  wrapper (`Inner::Row`): made once per cell under an owner of its own, with a `Position` whose index the core sets
  when the list rebinds the cell to another row (`cellIndex`) and whose count when the number of rows changes, so
  only the wrapper's bindings that read them run. The row the app rendered goes into the wrapper. Binding,
  recycling, measuring and positioning stay the list's.
- The component's own rows (`virtual_list(count, |at| row)`, layout from `ListLayout`, `.keys(ids)` for splices):
  the core creates the list and binds its cells itself, within the commit that needs them (`Core::commit` binds and
  lays out again; JS is not involved). Each cell's content (`Inner::VirtualRow`) is made once, under an owner of its
  own, and shows the row its `Position` says: a memo of the list's count and keys moves the cells' index signals
  (`move_rows`) before the bindings that read them run, so a splice runs only the bindings of the rows that moved
  and never shows a row with another row's data. With keys, rows removed or inserted before others leave their
  cells and sizes alone. A cell past the end (the list shrank) disposes its content until the list binds it again.
  The header, footer and empty view are part of the view (their `CellSlot`s), outside the recycling; a separator
  goes into each row's cell, after the row (before it, inverted), while the row is not the last.
- Another component's rows (`ComponentElement::items(virtual_list(..))`): the list is content of the nested
  component, as `.child` is: nodes of this view (its rows, header and handlers are this component's), the slot of
  the nested component's `Items` prop, which places and lays it out as it places JS's list (its layout and styles,
  so the list's own are left out). Each cell is then the placing component's row wrapper (`Inner::Row`) around a
  node showing the row (`Inner::VirtualRow`), so each part's handlers run with its own component.
- Lazy children (`#[prop(lazy)] children: Children`, a sheet's: fresh content on each opening): the JS face makes the app's children only while the
  view places them, under a `cond` on a signal; the core tells it in its events (`JsEvent::Children`, `true` /
  `false`) when the view starts or stops placing them (`ComponentSpec::lazy_children`), so they are made again on each
  opening and released after. Until they are made, `Children::is_empty()` is true. The content a Rust view passes
  such a component (`drawer().child(..)`) is lazy the same way: the core keeps it in a region of a signal it
  sets when the nested component starts or stops placing its children (slots and rows stay), instead of telling JS.

## Events

- Handlers sit on the elements; the native event of a made node, or of the host, goes to the component first
  (`Core::component_event`, called by the engine before JS). Events of made nodes never reach JS. An element given
  several listeners of one event (`.on_press(a).on_press(b)`, on a host or on a nested component) calls them
  all, in that order (touch listeners too); a listener that releases its component ends the rest. A dispatch walks
  the instance's handlers in place (`Core::next_handler`, by index: no list per event), which stay as they are while
  it does: regions change them when they are reconciled. A node a region makes again (kept, the same id) drops the
  handlers, responders and `on_event` listeners its last run gave it, so it hears the new run's only. A listener runs
  in the graph like any other Rust code of the view: the signals it writes run their bindings once it returns.
- A slot's node (JS's holder, the app's list of an `Items` prop, or another component's content) gets the
  handlers of the component it is a slot of, then its maker's: JS's (the app's `onLoadMore` on a component with rows)
  or the view's that passed it.
- A component's own list reports its viewable rows to it in the core, waiting for `minimum_view_time` when set
  (a task of the list's owner).
- `cx.emit(event)` is routed after the code that emitted it: to JS as the event itself (`JsEvent::Component`, its
  data converted by the `Event` derive's `data_js` when JS hears it; the JS face calls the app's
  `on<Name>(data)`), or, for a nested component, to the
  `on_event` listener of the view that made it, typed, whose own emits are routed in turn until none are left.
- The back button: `on_back_press` listeners of views run newest first, after modals' and before stacks', then JS's
  (`ui/back.rs`).

## The JS face and the declarations

`nsh-js` `components.rs` makes each component's and module's JS from its spec (`ComponentSpec`, `ModuleSpec`) when a
bundle first imports the module, and `classes.rs` each class's from its `ClassDef`. `nsh_core::ui::declarations(registry,
omit)` writes their declarations (into the registry's module file, `nsh/base.d.ts`, `app/native.d.ts`; `nsh-js` `declarations.rs` adds
the re-exports and native values it makes): the named types the props, events, methods and functions use (`export
type Foreground = ...` for a `PropEnum`, `export interface AlertDialogAction` for a `JsObject`, each once, with its doc
comment; `JsValue::ts_type(&mut TsTypes)` declares them), the props interfaces, the components, the module objects
(each of type `<Name>Module`; a synchronous function returns its type, an op's or task's a `Promise`) and the
classes (`export declare class`). The JS face runs for every instance, so it is kept minimal: **one render effect reading every prop
directly** and sending the ones that changed, no `split` / `merge` / `spread` (their proxies made the first version, in
the former JS runtime, cost more JS than the TSX component it replaced), no node for an absent slot, no event listener
when no handler is passed. Benchmarks against the same button in TSX: `docs/dev/performance.md` (`examples/bench`,
`component_bench`).

## Touches and the responder

The platform reports touches on the root, each finger with the listening nodes around it (`docs/dev/elements.md`).
The core takes the components' nodes on that path (`core/touch.rs`): their `on_touch` handlers hear the touches from
the finger outwards, then the responder is negotiated among their `claim_touches` as `nsh-js` does among JS's
handlers (captures from the outermost in, then from the finger outwards; with a responder, only the nodes around it;
`keep_touches` refuses to hand over), and the responder's listeners get the events with the gesture. Claims without
`ask` are decided from the element, running no component code. The event goes on to JS for its own nodes; each side
negotiates its own responder, and the core sends both sides' `SetJsResponder` / `ClearJsResponder` (the one that
blocked last wins while both do, and the other's block comes back when it lets go).

## Native components of the embedder

`nsh/native`'s `nativeComponent` is the other kind: a platform view the embedding app registered (Swift / Java
`NshComponent`, `docs/dev/embedding.md`). Those are views of their own on the main thread; Rust components are
compositions of primitives in the core.

## Popups

`nsh/base`'s popups (`crates/nsh-base`: `popup.rs`, `popover.rs`, `menu.rs`, `tooltip.rs`, `sheet.rs`) are made of
the core's overlays (`elements.md` "Overlays"), which place them and report presses outside, Escape and back; the
components decide to close. They draw nothing: the app styles each part (`popupClass` / `popupStyle`,
`backdropClass` / `backdropStyle`) and its content.

Their callbacks are one set, as `Dialog`'s (`popup.rs`: `OpenState`, `lifecycle`):

- **`open` / `defaultOpen`**: the open state is controlled when the app sets `open` (`Prop<Option<bool>>`), the
  popup's own (`OpenState`'s signal, from `defaultOpen`) otherwise. A user's request changes the own state at once
  when there is one; a controlled popup waits for the app to change `open`.
- **`onOpenChange(open, reason)`**: every request to open or close (`OpenState::request`; not a request for what it
  already is), whether controlled or not, with why: `OpenChangeReason`: `"triggerPress"`, `"pressOutside"`,
  `"backdropPress"`, `"cancel"` (Escape or back), `"select"` (a menu's item), `"hover"`, `"longPress"`,
  `"contextMenu"`, `"swipe"`. The app changing `open` itself is not reported here.
- **`onOpen` / `onClose`**: after it is all there and after it is all gone (a sheet, or a menu as a sheet, once its
  motion is over; a popup at once), whoever opened or closed it, the app's `open` included (`lifecycle`, an effect on
  what is shown). `Tooltip` has these two and `onOpenChange`.
- **`onCancel`**: each attempt of the user to close it without choosing: Escape or back, a press outside, a press on
  the backdrop. It is emitted before `onOpenChange`, whether or not a `closeOn<Trigger>` flag (`closeOnEscape`,
  `closeOnPressOutside`, `closeOnBackdropPress`, read natively when the user acts) let it close, so an app with a flag
  set to `false` can ask first and close itself. A menu's chosen item is no cancel (`"select"`); Escape in a
  sheet's submenu goes back a level and is none either.

How a popup presents itself follows the device (`is_desktop()`; one presentation, `auto`, for now), by what the popup
is for, never by replacing one popup with another everywhere:

| | Desktops (and desktop browsers) | Phones and tablets |
|---|---|---|
| `Popover` | anchored to its trigger; a press outside closes it and goes on to what is under the pointer | anchored to its trigger (what it shows belongs next to it); a press outside only closes it (a transparent backdrop overlay takes it) |
| `Menu` | a popup at its trigger (`placement`, `align`, `offset`, `margin`); `Submenu`s cascade beside their item, on hover or press | a sheet at the bottom over a backdrop; a `Submenu` shows its items in place of its menu's, with its `back` row (the app's: no built-in strings); Escape / back return a level |
| `ContextMenu` | the secondary button opens it at the pointer (`onContextMenu`'s `page`) | a finger held 400 ms on the trigger opens it as the menu's sheet (observed touches: the trigger's own presses and the scroll views around it go on; 10 points of movement cancel) |
| `Tooltip` | after the pointer rests on the trigger for `delay` (500 ms); leaving or pressing hides it | only when the app opens it (`open`, `defaultOpen`): no pointer to rest |
| `Sheet` | an edge panel (`side`) over a backdrop | the same |

`Sheet` opts into downward dragging with `closeOnSwipe` (default false, bottom side). Its pan updates
`SheetMotion.drag_y` on the platform's animation graph; a clamped fraction of the measured panel height drives both
translation and backdrop opacity. Release past 30% or 800 points/second requests `onOpenChange(false, "swipe")`
after `onCancel`; a shorter, cancelled or declined gesture returns the panel. Reduced motion snaps the release.
`Interactive::pan_enabled` filters the mounted pan values and event mask together, retaining the listeners and
children while a sheet enters, exits or changes permission. `pan_scroll_handoff` asks UIKit to share the touched
descendant scroll's pan: its initial offset consumes the first part of the drag, and the remaining downward
distance moves the panel while the scroll stays at its adjusted top. Other backends retain their usual scroll
arbitration. `SheetMotion` tags completion callbacks and fallback timers with a generation, so a prior exit cannot
unmount a reopened sheet or its backdrop.

`SheetMotion` derives the programmatic translation from the remaining fade fraction times the current measured
distance from the edge. Lazy JS children can fill in over several layout rounds in one native batch; later content
can also resize a panel during its entrance. Each layout updates that distance in the native graph, preserving the
animation's progress and completion time. `Sheet`, phone menus and compact dock drawers share this path. Dragging
is a separate value in points, so entrance measurement does not clamp or replace the finger's displacement.

The menus' items reach their menu through context (`MenuContext`: the close function, the sheet's path of submenus,
the level's open submenu), so the app arranges them freely. Every item of a sheet's hidden levels is out of the tree
(its content is not placed), so screen readers and tests see only the shown level. `Dialog` stays the modal
presented by the platform (`navigation.rs`); `AlertDialog` and `nsh/desktop`'s menus stay the system's.

On terminal and GPUI, a `Popover` captures its actual native opener before mounting its content. It respects an
input's `autoFocus` or an explicit focus command, otherwise focusing its first keyboard control. Tab stays in the
popup while it owns focus. Closing returns focus, including an input's existing caret, to its still-live opener;
an outside press that focused another control keeps that focus. Nested popups restore their logical parent even
though overlays are native siblings. This behavior uses `overlay().focus_return(true)` and the core's
`ViewProps::focus_return_parent` metadata; ordinary overlays and hints leave focus unchanged.

`Tooltip` is a hint overlay of the core (`elements.md` "Overlays": `overlay().hint(delay).hint_open(..)`) as its
view's root, so the component's host is the overlay. It is given as an element's `tooltip` (as GPUI's
`.tooltip(..)`), never placed among children: the core takes such an element as the hint overlay itself, in the
element (`Core::adopt_hint_tooltips` once its view made it one; Rust: `IntoTooltip for TooltipElement`), so the
element is what the pointer rests on and what it is placed against. The core follows the pointer on it and asks
(`on_hint_show` / `on_hint_hide`); the tooltip's open state (`OpenState`, controlled or not, `disabled` ignoring
the requests) decides, as `hint_open`. The tooltip itself is the bubble (the app's `class` / `style`), its children
what it says; it never takes the pointer (`pointer_events(None)`). An element's `tooltip` prop (`Interactive::tooltip`,
`Prop::Tooltip`) takes a text too, in a minimal bubble of the theme's tokens, or any other element as it is, in a
hint overlay the core makes itself (`Core::set_tooltip`).

## Toasts

`nsh/base`'s toasts (`crates/nsh-base/src/toast/`) are `gpui-base`'s three pieces, with its names and semantics; the
imperative layer (a `toast(..)` with a title, a description and an action, shown from anywhere) is a styled library's,
as `gpui-component`'s notifications are, and is never part of NSH (the gallery's is `examples/gallery/toast.tsx`).

| gpui-base | nsh-base (Rust) | TS |
|---|---|---|
| `ToastManager<I, T>` (`new(motion)`, `push(id, value, ToastOptions { timeout }, now)`, `dismiss(id, now)`, `dismiss_all(now)`, `advance(now, paused) -> ToastAdvance { changed, presented, ending, removed }`, `iter()`, `visible(limit)`, `get`, `len`, `is_empty`) | the same (`manager.rs`), `now` a `nsh_core::time::Instant` | the class `ToastManager` (`js.rs`) over `ToastManager<String, JsonValue>`: the same methods, `entries()` for `iter()`, no `now` (the engine's clock, so a test's manual clock moves it), milliseconds for durations |
| `ToastMotion` (`sonner()`) | the same, `Points` for distances | a plain object of the same fields, milliseconds, fields left out Sonner's |
| `ToastTransitionStatus` (`Starting`, `Present`, `Ending`) | the same (`PropEnum`) | `"starting" \| "present" \| "ending"` |
| `Toast::new(id).transition_status(..)`, role alert | the component `Toast` (`toast.rs`) | `<Toast transitionStatus>` |
| `ToastStack::new(id, state).item(id, child).motion(..).placement(Anchor).focus_handle(..)` | the component `ToastStack` (`stack.rs`): its children are the items (`children_each`, keyed by node), `Anchor` an enum of the same eight edges, `.state(ToastStackState)` | `<ToastStack motion placement onExpandedChange>` |
| `ToastStackState::is_expanded()` | the same, a signal the stack's `ExpandedChange` writes | `onExpandedChange(expanded)` |

The manager is a class rather than a reactive helper because it is `gpui-base`'s data structure, not a view: the app
keeps it, renders `visible(limit)` (a signal of its own) and calls `advance` on a timer while anything is mounted,
exactly as `gpui-component`'s `NotificationList` does; a class keeps one implementation for Rust and TS and its
methods synchronous (`docs/dev/rust-classes.md`), where a reactive helper would need the core's graph, which JS's
calls do not run in.

The stack wraps each child in an absolutely positioned item at its `placement`'s edge (`top: 0` or `bottom: 0`),
measures it (`onLayout`) and moves it with native animated values bound to its translation, `scaleX` (gpui-base's
width inset: each collapsed layer `collapsedScaleStep` narrower, centered) and opacity, driven by critically damped
springs whose response is the motion's `duration` (`spring_of`). Distances from the edge are gpui-base's geometry
(`stack_heights`, `distance`): collapsed `collapsedPeek` per rank, expanded the newer items' heights plus
`expandedGap` per rank; the stack's own height is the collapsed or expanded one, so its hover area follows.

NSH's additions fit the same pieces: gpui-base expands the stack for hover and focus; NSH's views report no focus, and
a finger down on the stack (observed `onTouch`) expands it as the pointer does, so a toast being read or swiped is
paused. A `Toast` takes a swipe (the core's responder, claimed once the pointer moved 10 points toward
`swipeDirection` along its axis, so its buttons stay presses; released past `swipeThreshold`, measured from where the
pointer went down, or flicked at 0.5 points per millisecond, it moves out and emits `DismissRequest`). The stack hears
Escape and back while it has children (an overlay of no size, `onCancel`), so nothing else loses them to an empty
stack. A `Toast`'s `accessibilityLabel` is announced once as it mounts (`announce_for_accessibility`, every platform's
announcement). The state classes are the app's look for the status: `startingClass` in the first frame while
starting (the next display frame, or 50 ms where none comes: Base UI's `data-starting-style`, so the app's
`transition` classes run the enter motion), `endingClass` while ending, `swipingClass` while swiped.
