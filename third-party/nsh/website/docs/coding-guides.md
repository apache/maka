---
title: Coding Guides
description: "Architecture and coding conventions for maintainable Native Shell apps and component libraries, in Rust and TSX."
order: 29.5
group: ui
---

# Coding Guides

This guide describes the application architecture and code patterns that have proved durable in Native Shell apps. It
is written for both engineers and coding agents: developers of NSH apps (TSX modules, Rust components, native apps
that embed NSH) and authors of component libraries built on `nsh/base`. Read the Design Guides first: code structure
should preserve product intent, not replace it.

This is a normative guide. **Must** marks lifecycle, correctness, or ecosystem constraints; **should** is the default
architecture and requires a concrete reason to depart from it. Current source, the reference pages and the
declarations in `.nsh/types` remain authoritative for exact signatures.

## Make the common path inexpensive

**Design principle: choose framework types and ownership so ordinary component use is inexpensive by default.**
Developers should be able to build and reuse UI without adding a cache at every call site. Components that run once
and [signals](./reactivity.md) read where they are used are examples: a component builds its part of the tree once,
and afterwards only the bindings that read a changed signal run again, so the common path avoids repeated work. The
reactive graph, the renderer, layout and lists are native, and one turn of the app's code becomes one batch of native
operations. Small costs still multiply across elements and updates, above all in TSX, whose own code runs in an
interpreter; measure exceptional hot paths before adding caches ([Performance](./performance.md)). Neither choice
promises zero cost. The [state ownership rules](#state-ownership) and later rendering sections explain the mechanics.

## Architecture at a glance

<img class="diagram diagram-light" src="/diagrams/application-layers-light.svg" alt="NSH application architecture: the App Shell, Pages and App Components above a Component Library, nsh/base and nsh; dependencies point downward.">
<img class="diagram diagram-dark" src="/diagrams/application-layers-dark.svg" alt="NSH application architecture: the App Shell, Pages and App Components above a Component Library, nsh/base and nsh; dependencies point downward.">

Dependencies point downward. Higher layers own domain meaning and orchestration; lower layers own reusable
presentation or behavior. Do not make a reusable component depend on an app page, or make a component library depend
on one app's theme ([Three layers](./architecture.md#three-layers)).

Use these boundaries:

- **app shell:** the entry (`App.tsx`, or `nsh.json` `"root"`) composes the root and the navigation stacks while
  keeping page logic out;
- **page:** one `NavPage` with its content, its dialogs and the work it starts;
- **app component:** a repeated domain-aware pattern;
- **component library:** styled, general-purpose UI, the app's own or the community's, built on `nsh/base`;
- **`nsh/base`:** reusable behavior without product presentation: navigation, dialogs, popovers, menus, sheets, a
  press target;
- **`nsh`:** the primitives, styles, layout, reactivity and the environment.

### Lay out an app's files

An app's files follow NSH's conventions, so there is nothing to configure: `App.tsx` is the entry and `nsh.json`
sits beside it, and both are found by convention.

```text
App.tsx            # the entry, by convention: mount(App)
nsh.json
Cargo.toml         # the app's crate, with Rust components ("rust": ".")
src/
  lib.rs
pages/
  Inbox.tsx
  Compose.tsx
  Settings.tsx
components/
  Card.tsx
store.ts
```

- `pages/` holds one file per `NavPage`. A page grows into more files only when it needs them.
- `components/` holds the app's reusable components, the ones several pages use.
- `store.ts` holds the app's state: its signals and the functions that change them. Pages read the signals and call
  the functions.
- Tests are `*.test.tsx` files beside what they test (`App.test.tsx`, `pages/Inbox.test.tsx`).
- `Cargo.toml` and `src/lib.rs` are the app's own crate, with its Rust components (`nsh.json` `"rust": "."`); its
  `#[native_module]` in `src/lib.rs` names what TSX imports. An app written only in Rust is the same Cargo project,
  with its root component in `src/lib.rs` ([Project structure](./project-structure.md)).

The app shell composes pages but contains little page logic. Pages read the store's signals and call its functions;
they never write another page's state. Keep the store's signals private and export what reads and changes them, so the
mutable state stays behind its public functions:

```rust tabs
/// The app's workspace: its state stays behind these functions.
#[derive(Clone, Copy)]
pub struct Workspace {
    name: Signal<SharedString>,
}

impl Workspace {
    /// A workspace named "Untitled".
    pub fn new() -> Self {
        Self { name: signal(SharedString::from("Untitled")) }
    }

    /// Its name (tracked where it is read).
    pub fn name(&self) -> SharedString {
        self.name.get()
    }

    /// Renames it.
    pub fn rename(&self, name: impl Into<SharedString>) {
        self.name.set(name.into());
    }
}
```

```tsx tabs
// store.ts
import { signal } from "nsh";

const name = signal("Untitled");

/** The workspace's name (tracked where it is read). */
export const workspaceName = () => name();

/** Renames the workspace. */
export function renameWorkspace(next: string) {
  name.set(next);
}
```

A page may hold the workspace and pass its id to search; search does not need the workspace's whole collection or its
private signals. A simple acyclic dependency shape is:

```text
App.tsx ──▶ pages/ ──▶ store.ts
              └──────▶ components/ ──▶ nsh/base, nsh
```

Pages may depend on the store and on components, but not on the shell or on another page's private parts. If one page
must change what another shows, do it through the store. These boundaries let different engineers or AI agents work
on separate pages in parallel with fewer file conflicts and less shared-state coupling; the store still requires
coordination.

## Bootstrap and root ownership

Mount the app once, and give the root the whole surface: a TSX entry calls `mount(App)`, a Rust app names its root
component in `nsh.json` (`"root": "App"`). The root fills the surface with `flex: 1` and a background from the theme:

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    provide_context(Workspace::new());
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(inbox())
}
```

```tsx tabs
import { mount, View } from "nsh";

mount(() => (
  <View class="flex-1 bg-background">
    <App />
  </View>
));
```

The root coordinates what belongs to the whole surface: the navigation stack, the dialogs, popovers, menus, sheets and
tooltips shown over everything in it, and the safe area. Do not mount a second root for each page inside one surface.
One surface is one engine: each `NshAppView`, `NshView` or `AppView` a native app embeds runs its own VM, its own module
state and its own reactive graph, so several surfaces in one host app never share state by accident.

## Understand what runs once and what runs again

NSH is retained state with declarative construction, on Solid's model ([Reactivity](./reactivity.md)). A signal
survives across updates; a component body describes its part of the tree once, when it is created. Keep that
distinction explicit:

| You write | Runs | Runs again when |
| --- | --- | --- |
| A component body | Once, when it is created | Never |
| A binding: a closure (Rust) or an expression that calls or reads a property (TSX) where a value goes | Once | A signal it read changes; only that prop or child updates |
| `computed(fn)` | When created | A signal it read changes |
| `effect(fn)` | After the elements of the pass exist | A signal it read changes |
| A row of `each` / `<Each>` | When its key first appears | Never; its item and index signals change |
| A cell of `virtual_list` / `<List>` | Once per cell | Never; the cell is given other rows |

- the component that runs is the **owner**: effects, computed values, tasks, timers, key bindings and cleanups created
  while it runs belong to it and are disposed with it;
- **context** (`provide_context` / `use_context`, `context()` and `<Ctx.Provider>`) gives a subtree a value without
  implying that the elements reading it own it;
- a Rust component's **`Scope`** (`cx`) emits its events and reads the insets it is given;
- **refs** (`element_ref()`, `ref`) name a host element for imperative calls (`focus()`, `scroll_to()`, `measure()`);
- layout and measurement are later, native phases; use `onLayout` and `measure()` only when resolved geometry is
  genuinely required.

Never read a context in an event handler or a timer, where there is no component to look it up from: read it in the
body and keep what it gave. Retain typed handles (signals, resources, refs, domain ids), which are `Copy` in Rust and
stop doing anything once their owner is gone.

## Choose the right unit

### Use a plain function for value-like elements

**Default to a plain function for lightweight, reusable pieces of UI.** The caller supplies current props and
handlers, the function returns elements, and nothing of it remains but the bindings it made. Its arguments are its
props; the displayed label, value and callbacks come from the caller's current state. It still runs once, like any
component: what changes afterwards are its bindings.

```rust tabs
fn empty_state(title: impl Into<SharedString>) -> impl IntoElement {
    view()
        .gap_2()
        .items_center()
        .child(text(title.into()).text_color(move || theme().muted_foreground))
}
```

```tsx tabs
function EmptyState(props: { title: string }) {
  return (
    <View class="items-center gap-2">
      <Text class="text-muted-foreground">{props.title}</Text>
    </View>
  );
}
```

### Use a component for retained behavior

Use a `#[component]` (or a TSX component that creates signals) when a piece of UI owns persistent state or an
independent lifecycle: signals, effects, async work, timers, key bindings. Create that state in the component body,
once, never inside a binding.

```rust tabs
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SearchProps {
    /// Shown while the field is empty.
    pub placeholder: Prop<SharedString>,
}

#[component]
pub fn Search(props: SearchProps) -> impl IntoElement {
    let query = signal(String::new());
    input()
        .value(move || query.get())
        .on_change(move |text: &str| query.set(text.to_owned()))
        .placeholder(move || props.placeholder.get().to_string())
}
```

```tsx tabs
function Search(props: { placeholder: string }) {
  const query = signal("");
  return <Input value={query()} onChange={(text) => query.set(text)} placeholder={props.placeholder} />;
}
```

A `#[component]` has typed props (`#[derive(Props)]`) and events (`#[derive(Event)]`); TSX imports it with
declarations generated from them. Retained state that TSX uses with `new` (a ledger, a parser, a session) is a
`#[class]`, and functions are a `#[module]` ([Building with Rust](./rust.md#extending-a-rust-app-with-tsx)). Write the
parts an app uses most, component libraries and demanding logic in Rust, which is native code from start to end; keep
TSX for what changes often or is delivered at run time.

Do not turn every visual fragment into a component. Component boundaries have lifecycle and coordination costs; use
them where retained identity matters.

### Elements, views, and behavior systems are different

Do not force every component into one template. The ecosystem contains:

- semantic elements such as `Button`, `Switch` and `MenuItem`;
- compound behavior roots such as `Dialog`, `Popover`, `Menu`, `ContextMenu`, `Sheet` and `NavStack`;
- stateful systems such as `Input`, `List`, `TextView` and a navigation stack's state;
- infrastructure such as overlays and their placement, virtualization, scrolling, safe areas, the keyboard and
  animation.

An element may be internally complex and still be value-like to its caller. A stateful system may expose render
functions so apps own presentation without reimplementing behavior. Choose the public seam from the behavior, not
from how many views appear in its output.

## State ownership

### Own persistent UI text with `SharedString`

**In Rust, must prefer `SharedString` for UI text retained across updates or callback closures**, including component
labels, titles and placeholders: props take it (`Prop<SharedString>`), and cloning it into a binding does not copy the
text. For a mutable editing buffer or text being assembled with formatting, use `String` and convert when the result is
ready; for temporary read-only access during one call, use `&str`. In TSX, strings are the app's own values; keep text
that is computed from state in a `computed` or a closure instead of rebuilding it in several places.

For immutable response text that the UI will retain, keep the received value intact and put derived or formatted
presentation text in a separate domain value instead of rewriting the response.

Put each state in the narrowest owner that can keep it correct:

- domain state belongs to the store (`store.ts`) or the app's crate;
- transient view state belongs to the component that renders it, as a signal;
- reusable behavioral state belongs to the component designed for it (a `Menu` or `Popover` without `open` keeps its
  own);
- state a subtree shares is a signal provided through [context](./reactivity.md#context);
- what outlives a run belongs in [storage](../modules/nsh.md#storage) or on a server.

Prefer controlled values for ordinary selection and toggles: pass the current value into the component, receive a
requested change, update the owner, and the bindings follow. A callback reports intent; it should not create a second
hidden source of truth.

```rust tabs
switch()
    .checked(show_hidden)
    .on_change(move |next: &bool| show_hidden.set(*next))
    .child(text("Show hidden files"))
```

```tsx tabs
<Switch checked={showHidden()} onChange={(next) => showHidden.set(next)}>
  <Text>Show hidden files</Text>
</Switch>
```

There is nothing to notify: writing a signal updates exactly the bindings that read it. A Rust component emits a
semantic event that its owner should handle with `cx.emit(..)`; an effect follows a signal for as long as its owner
lives. Write several fields that form one invariant in one [`batch`](./reactivity.md#batch), so effects and computed
values see them at once.

A controlled component of the app's own follows the same contract. A quantity stepper, a domain control written once
in Rust and placed from Rust and TSX:

```rust tabs
use nsh_base::{button, theme};
use nsh_core::prelude::*;

/// The props of [`QuantityStepper`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct QuantityStepperProps {
    /// The quantity: the app owns the value.
    #[prop(default)]
    pub value: Prop<u32>,
    /// The smallest quantity (0 when left out).
    #[prop(default)]
    pub min: Prop<u32>,
    /// The largest quantity (99 when left out).
    #[prop(default = 99)]
    pub max: Prop<u32>,
    /// What screen readers say for the button that takes one away.
    pub decrement_label: Prop<SharedString>,
    /// What screen readers say for the button that adds one.
    pub increment_label: Prop<SharedString>,
}

/// What a [`QuantityStepper`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum QuantityStepperEvent {
    /// The user asked for another quantity; the owner sets `value`.
    Change(u32),
}

/// A quantity with a button to take one away and one to add one.
#[component]
pub fn QuantityStepper(props: QuantityStepperProps, cx: Scope<QuantityStepperEvent>) -> impl IntoElement {
    // Read untracked: the user's act, measured against the owner's current value.
    let step = move |delta: i64| {
        let value = props.value.get_untracked();
        let (min, max) = (props.min.get_untracked(), props.max.get_untracked());
        let next = (i64::from(value) + delta).clamp(i64::from(min), i64::from(max)) as u32;
        if next != value {
            cx.emit(QuantityStepperEvent::Change(next));
        }
    };
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .child(step_button(
            "−",
            move || props.decrement_label.get(),
            move || props.value.get() <= props.min.get(),
            move || step(-1),
        ))
        .child(text(move || props.value.get().to_string()).text_color(move || theme().foreground))
        .child(step_button(
            "+",
            move || props.increment_label.get(),
            move || props.value.get() >= props.max.get(),
            move || step(1),
        ))
}

fn step_button(
    symbol: &'static str,
    label: impl Fn() -> SharedString + 'static,
    disabled: impl Fn() -> bool + 'static,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .accessibility_label(move || Some(label()))
        .on_press(on_press)
        .w(px(32.0))
        .h(px(32.0))
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || theme().muted)
        .active(|s| s.opacity(0.6))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(symbol).text_color(move || theme().foreground))
}

// The owner:
let quantity = signal(1_u32);
quantity_stepper()
    .value(quantity)
    .min(1)
    .max(10)
    .decrement_label("Fewer")
    .increment_label("More")
    .on_change(move |next: &u32| quantity.set(*next))
```

```tsx tabs
import { signal } from "nsh";
import { QuantityStepper } from "my-app";   // the Rust component: src/lib.rs has #[native_module("my-app")]

function CartRow() {
  const quantity = signal(1);
  return (
    <QuantityStepper
      value={quantity()}
      min={1}
      max={10}
      decrementLabel="Fewer"
      incrementLabel="More"
      onChange={(next) => quantity.set(next)}
    />
  );
}
```

The same contract in TSX, a component in `components/`:

```tsx
import { Text, View } from "nsh";
import { Button } from "nsh/base";

export interface QuantityStepperProps {
  /** The quantity: the app owns the value. */
  value: number;
  /** The smallest quantity (0 when left out). */
  min?: number;
  /** The largest quantity (99 when left out). */
  max?: number;
  /** What screen readers say for the button that takes one away. */
  decrementLabel: string;
  /** What screen readers say for the button that adds one. */
  incrementLabel: string;
  /** The user asked for another quantity; the owner sets `value`. */
  onChange?: (next: number) => void;
}

export function QuantityStepper(props: QuantityStepperProps) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 99;
  const step = (delta: number) => {
    const next = Math.min(max(), Math.max(min(), props.value + delta));
    if (next !== props.value) props.onChange?.(next);
  };
  const buttonClass = "size-8 items-center justify-center rounded-(--radius) bg-muted active:opacity-60 disabled:opacity-40";
  return (
    <View class="flex-row items-center gap-3">
      <Button disabled={props.value <= min()} accessibilityLabel={props.decrementLabel} onPress={() => step(-1)} class={buttonClass}>
        <Text class="text-foreground">−</Text>
      </Button>
      <Text class="text-foreground">{props.value}</Text>
      <Button disabled={props.value >= max()} accessibilityLabel={props.incrementLabel} onPress={() => step(1)} class={buttonClass}>
        <Text class="text-foreground">+</Text>
      </Button>
    </View>
  );
}
```

### Keep ownership links and subscriptions bounded

A component owns what it creates, and everything it created goes away with it: when its `<If>` branch hides, its row
is removed or its page is popped. In Rust, tasks, timers and intervals (`spawn`, `set_timeout`, `set_interval`) and key
bindings (`on_key`) end with the owner they were made under; in TSX, register the stop with
[`cleanup`](./reactivity.md#cleanup) or return it from the effect. A function that starts listening returns a
function that stops it (`() => void`), and what is registered while a component renders goes away with the component,
as `keymap.bind` does.

When something keeps running unexpectedly, first inspect effects and computed values created outside a component (in
an event handler or a timer callback they have no owner and live forever), listeners registered without their stop,
and work started from a store that no component owns. A dropped `resource` load is aborted (`info.signal` in TSX);
it does not keep its component alive. These are common places to start, not an exhaustive list.

Do not write a signal merely because a value was read or derived. Avoid unconditional writes from a binding or an
effect that reads the same signal: it runs itself again until NSH stops it with an error. A value computed from other
state is a `computed`, not an effect that writes a second signal.

### Avoid state feedback loops

Text input, selection, filters and controlled popups commonly have two paths: an external owner updates the value, and
user interaction requests a new value. Do not send an owner-supplied value back through the user callback during sync.
Read the owner's current value untracked when handling the user's act (`props.value.get_untracked()` in Rust, as
above; a TSX event handler is already untracked) and compare it with the next one, so each logical change is reported
once. Make callbacks re-entrancy-safe when a callback can synchronously close, replace or update the component that
invoked it.

## Stable identity

A key is part of behavior. It gives a row, a page or a repeated control stable identity, and decides which one keeps
its state, its focus and its measurements when the data changes.

- Use stable domain ids for rows, tabs, pages and repeated controls: `each(projects, |p| p.id, ..)`,
  `<Each of={projects()} key={(p) => p.id}>`, a list's `keyExtractor`.
- Namespace test ids with their owning object when the same control repeats (`delete-${project.id}`).
- Never derive identity from a translated label or a mutable list index when items can be inserted or reordered.
- Do not generate a fresh random key or id while rendering.

```rust tabs
each(projects, |p| p.id, move |project, _index| {
    let id = project.get_untracked().id;
    button()
        .on_press(move || delete(id))
        .child(text("Delete").test_id(&format!("delete-{id}")))
})
```

```tsx tabs
<Each of={projects()} key={(p) => p.id}>
  {(project) => (
    <Button onPress={() => remove(project().id)}>
      <Text testID={`delete-${project().id}`}>Delete</Text>
    </Button>
  )}
</Each>
```

A changed key means a changed UI identity. Treat that reset as deliberate.

The same rule applies to navigation routes, list keys, storage keys and test ids. A route that stays in `setRoutes`
keeps its page and its state; if two independently retained behaviors share a key, they can overwrite each other's
state; if one behavior changes keys every update, it never accumulates state.

## Rendering and composition

Keep a component body declarative: read current state, derive presentation values, and compose elements. Move domain
operations, parsing and non-trivial mutation to named functions of the store or the app's crate.

```rust tabs
#[component]
pub fn ProjectPage() -> impl IntoElement {
    view()
        .flex_1()
        .child(toolbar())
        .child(content())
}
```

```tsx tabs
function ProjectPage() {
  return (
    <View class="flex-1">
      <Toolbar />
      <Content />
    </View>
  );
}
```

Extract a helper when it names a meaningful region and reduces the amount of state a reader must hold at once.
Extract a new component when the region has its own reusable contract or retained lifecycle, not merely because a
builder chain or a JSX block is long.

Use the typed style methods and the components' builders consistently in Rust, and classes in TSX. Prefer
`.when(..)` / `.when_some(..)` (Rust) and `classList` (TSX) for small conditional refinements; use `when` / `<If>`
when branches represent substantially different interfaces, since a ternary in a closure builds its branch again
whenever anything it reads changes.

Compose from the standard semantic component before building a custom surface. Do not reproduce a menu, a popover, a
sheet or a dialog from generic views merely to match one screenshot: `Menu`, `ContextMenu`, `Popover`, `Sheet`,
`Tooltip` and `Dialog` from `nsh/base` preserve placement, focus transfer, keyboard navigation, selection, disabled
state, dismissal on Escape and back, and the accessibility contract. If the standard component cannot express a
recurring valid pattern, improve its explicit API instead of styling arbitrary descendants at each call site.

Render functions supplied by app code should be side-effect-free. A list's row, a `TextView`'s `renderCodeBlock` or a
menu's items may run whenever their owner needs a cell, a part or an opening. They must not perform a business
operation, append data or start an unbounded subscription.

## Behavior and presentation boundary

The durable Base rule is:

> Base owns reusable behavior and the structure required to implement it. The presentation layer owns the product's
> visual language.

"Unstyled" does not mean "one empty view." Overlay placement, keyboard navigation, editing, virtualization, back
navigation, dismissal and safe areas require internal structure and state. Moving that work to every caller would not
create flexibility; it would duplicate fragile behavior.

Conversely, Base must not choose brand colors, typography, density, final icons, component variants, strings or
application composition. Expose presentation through `class` / `style` on the main part, `<part>Class` /
`<part>Style` for every other part, typed state styles (`active`, `hover`, `focus`, `selected`, `checked`, `disabled`),
named slots (`trigger`, `header`, `footer`) and render functions. Do not inspect arbitrary descendants to discover
titles, descriptions or close buttons: make semantic parts explicit, and take every label as a prop or a child.

## Theme and styling

Read semantic values from the theme and apply layout with the typed style methods in Rust and Tailwind classes in TSX
([Tailwind](./tailwind.md), [theme tokens](./tailwind.md#theme-tokens)):

```rust tabs
view()
    .bg(move || theme().background)
    .text_color(move || theme().foreground)
    .border_1()
    .border_color(move || theme().border)
    .rounded(move || theme().radius)
```

```tsx tabs
<View class="rounded-(--radius) border border-border bg-background text-foreground" />
```

Rules:

- do not hard-code product colors, corner radii, spacing, or control geometry;
- app code must not introduce raw hex, `rgb` / `rgba` or `hsla` values; read a semantic color from `theme()` or a
  token class (`bg-primary`), or add the missing role to the app's theme file;
- app layout should use the spacing and type scales (`p-2`, `gap-3`, `w-64`, `text-sm`; `.p_2()`, `.gap_3()`,
  `.w_64()`, `.text_sm()`) instead of arbitrary values (`p-[13px]`, `px(13.0)`);
- classes mean exactly what they mean in Tailwind CSS v4, and CSS values what they mean in a browser; an
  `unknown class` warning is a finding to fix;
- use semantic tokens for meaning, not palette position;
- keep state-independent geometry in the ordinary builder chain or class string;
- use `active:`, `hover:` and `focus:` (`.active(..)`, `.hover(..)`, `.focus(..)`) for runtime interaction states;
  they apply natively, with no round trip to app code;
- use a component's semantic state styles (`selected:`, `checked:`, `disabled:`) for checked, selected, pressed, or
  disabled appearance;
- keep popup ownership in explicit state (`open` with `onOpenChange`) so its trigger can render the open or pressed
  appearance until dismissal;
- keep component variants few and meaningful rather than adding a variant for every call site;
- bind primary styling to the decision area's real default commit and its return-key action; do not derive it from
  action count, frequency, or toolbar position;
- keep badge and alert variants semantic and scarce. Ordinary metadata stays neutral; do not map every enum case or
  section to a different color merely because a variant exists.

The effective precedence is the element's own style, then the state styles, later states winning, with `disabled`
over all. Later layers only replace fields they set.

Prefer the theme's semantic tokens for new app-owned presentation. Every name in the app's theme file is a token, as a
variable of Tailwind's `@theme` is (`"up": "#16a34a"` gives `text-up`, `bg-up/30`, `token("up")` in TSX and
`theme().color("up")` in Rust), and the theme has light and dark values, so a token follows the appearance with no
`dark:` class. Name tokens after roles, not components, so they do not become the extension point
for every widget.

Change the theme through the app's theme file (`nsh.json` `"theme"`), or let the embedding app give its own: classes
naming tokens and Rust bindings reading `theme()` are restyled natively whenever it changes, with no JavaScript
running. Code that copies a token's value into a signal of its own stops following it.

An outward focus ring needs physical room. An ancestor with `overflow: hidden` (`overflow-hidden`) clips it. Prefer
layouts that leave room; if a product must clip heavily, draw the focused state inside the control instead of silently
hiding all keyboard focus.

### The user's text size is the app's zoom

Text follows the user's text size (Dynamic Type, Android's font scale, the desktops' settings): `fontScale()` in TSX,
`font_scale()` in Rust, both reactive. The type scale (`text-sm`, `text-base`: 16 points, the body size) sets
the reference, and the user's setting scales it. This deliberately follows
the useful part of Tailwind's model: named type, spacing and size steps instead of unrelated point constants.

Let text containers grow with their text: give them minimum heights and padding rather than fixed heights. A custom
component that combines scaled text with fixed geometry around it must document why that part should not grow.

Treat every arbitrary point value and raw color constructor in app UI as a review finding. Accept it only for a
documented physical or platform boundary, measured runtime geometry, raster or data color, or the theme definition
itself. Convenience and matching a screenshot are not valid exceptions.

Anything cached from resolved layout must include the font scale in its invalidation key, directly or through a
revision that changes with it: row heights a list was told, text measurements, popup geometry, icon sizes derived from
text and custom canvas metrics.

## Events, commands, and focus

Use presses for activation: `onPress`, `onLongPress`, `onPressDown` and `onPressUp` mean the same with a finger, a pen,
a mouse or the keyboard. Use touch handlers and gestures only for what follows the finger (a pan, a drag). Use
keyboard shortcuts (`keymap.bind`, `on_key`) and menu items for commands that should support key bindings, menus, or
dispatch from multiple inputs. Keep the handlers close to the page that owns the command.

Model one logical command once. A `Button`, a `Menu` item, a `ContextMenu` item, an application menu item of
`nsh/desktop` and a keyboard shortcut should call the same function of the store instead of copying five mutations.
Derive their label, icon, shortcut and disabled state from one command policy where practical (`key_label("mod+s")`
writes a shortcut the platform's way), so the entry points cannot disagree. The menu owns navigation and dismissal; the
page still owns whether the command is allowed and what it does.

```rust tabs
on_key("mod+s", move |_| save());
view()
    .child(button().on_press(save).child(text("Save")))
    .child(
        menu()
            .trigger(view().px_3().py_2().child(text("File")))
            .child(menu_item().on_select(save).child(text(format!("Save  {}", key_label("mod+s"))))),
    )
```

```tsx tabs
keymap.bind("mod+s", save);

<View>
  <Button onPress={save}><Text>Save</Text></Button>
  <Menu trigger={<View class="px-3 py-2"><Text>File</Text></View>}>
    <MenuItem onSelect={save}><Text>Save  {keymap.label("mod+s")}</Text></MenuItem>
  </Menu>
</View>
```

Preserve semantic roles in the element choice. Use `Button` for commands even when the desired treatment is quiet;
give it a quiet style instead of replacing it with a link. NSH apps reserve the `link` role for targets opened outside
the app, such as a URL or an email address; use navigation for an in-app destination and `Button` for a command.

Only stop propagation (`stopPropagation()` on a touch event) when a nested interaction must prevent its parent from
handling the same touch. Blanket propagation stops break scrolling, presses and gestures in ways that are difficult
to diagnose.

**The main thread never waits for app code.** When the system needs an answer on the spot (may this page pop, may this
sheet or popover close, may this text change), NSH answers natively from props mounted beforehand, and an event tells
the app afterwards. So a decision is a prop, set as soon as it is known, not a callback that returns true or false:
`popOnBack={!dirty()}` with `onBackPress` to confirm ([popOnBack](./navigation.md#keeping-the-user-on-a-page-poponback)),
`closeOnEscape` and `closeOnBackdropPress` with `onCancel` to hear the attempt, `maxLength` on an input, `disabled` on
a button.

A menu item's `shortcut` (`nsh/desktop`) binds its key while the menu is set, and the menu shows it in the platform's
style; a `keymap` binding of the same keystroke comes before it. Give each keystroke one owner, and set the application
menu again when its items or shortcuts change.

Make focus ownership explicit:

- `Button`, `Switch` and menu items are keyboard focus stops on the desktops and the web; build controls on them rather
  than on bare views;
- move focus with a ref's `focus()` from an event or an effect that follows a state change, and move the screen
  reader's with `set_accessibility_focus()` (Rust) or `setAccessibilityFocus` from `nsh` (TSX);
- render a visible `focus:` state;
- do not request focus unconditionally while rendering.

Composite widgets should implement the complete navigation model (arrow movement, Home / End or page movement where
appropriate, confirmation, cancellation and Tab behavior) rather than a few isolated shortcuts.

Overlays dismiss from the top: Escape and the Android back button go to the top overlay that listens (`onCancel`).
Handle rapid close and open sequences without acting on an intermediate, already-closing surface.

## Async work and side effects

Start asynchronous work from an event, an effect or a [`resource`](./reactivity.md#resource), not as an unconditional
side effect of a component body. An effect tracks only what it reads synchronously: read the signals first, then start
the work. When the work completes, update state through signals, accept that the component may be gone, and write
coherent changes together.

Keep recurring work under an owner so its going away cancels it: Rust tasks and timers end with their owner, TSX timers
stop in `cleanup`. A one-shot task that must finish independently can be started from the store, but it gives up that
cancellation. Handle errors and failed requests explicitly.

Represent async operations with explicit states: a resource's `state()` is `unresolved`, `pending`, `ready`,
`refreshing` or `errored`. Preserve usable previous data during refresh: a resource keeps its value while it loads
again. Prevent duplicate destructive submissions and surface recoverable errors in the UI; do not rely on logs as user
feedback.

```rust tabs
let results = resource(
    move || {
        let q = query.get();
        (!q.is_empty()).then_some(q)
    },
    |q, _info| async move {
        let response = fetch(format!("https://api.example.com/search?q={q}")).await?;
        if !response.ok() {
            return Err(format!("HTTP {}", response.status()));
        }
        Ok(response.text())
    },
);
```

```tsx tabs
const results = resource(
  () => query() || undefined,
  async (q, { signal }) => {
    const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(q)}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as SearchHit[];
  },
);
```

Move expensive parsing or computation out of TSX handlers: into a `computed`, off the interaction path, or into Rust.
Results can arrive after the query, the page or the selection has changed: a resource drops superseded loads, and work
of your own attaches a revision or an identity and rejects stale results rather than applying them to new state.

## Layout, measurement, and scrolling

A view lays out its children in a column, and children stretch across it by default; `class="flex"` (`.flex_row()`)
is a row, as in CSS. A row of controls wants its children centered (`items-center`), which says so. A row of
full-height columns keeps the default stretch, so a column fills the row's height and its header stays at the top:

```rust tabs
view()
    .flex_row()
    .flex_1()
    .child(sidebar())
    .child(content())
```

```tsx tabs
<View class="flex flex-1">
  <Sidebar />
  <Content />
</View>
```

Most UI should use layout rather than measuring itself ([Layout](./layout.md)). Measurement (`onLayout`, `measure()`)
is a deep behavior tool for overlays, virtualization, editors, charts and similar components whose correctness depends
on resolved geometry.

- Put measurement and geometry in the layer that owns the behavior.
- Observe layout only when ordinary layout cannot express the relationship.
- Never write unrelated app state on every layout event.
- Treat measured data as revision-scoped; it can become stale after text size, width, theme or content changes.
- Let `nsh/base`'s overlays place popups: their placement, flipping and safe-area margins follow one policy.

For alignment invariants, prefer construction over correction: sibling regions should consume the same spacing token
or shared inset instead of repeating equal literals. Add geometry checks or screenshots on a real platform
(`nsh test --target`) for critical repeated edges, columns and gaps. Exercise more than the default window: a large
text size and display scaling can turn fractional coordinates into a one-pixel drift even when the default screenshot
looks aligned.

Measure the resolved result when reviewing precision, but do not encode a measured correction as an arbitrary value.
Trace the mismatch to duplicated padding, nested insets, border ownership, font metrics or rounding, then fix the
structural owner.

Every scrollable region must have one owner. Avoid accidental nested scrolling on the same axis. Give the scroll view
the element that owns the full page, panel or list, so its indicator resolves against the region's edge, and put the
content's inset inside it (`contentClass` / `contentStyle`) rather than wrapping the scroll view in a padded
container. An indicator floating between content and the page boundary usually reveals the wrong scroll owner or
padding on the wrong layer. Keep clear of the safe area and the keyboard with `env(safe-area-inset-*)` and `env(keyboard-inset-height)` in
padding and margin (read the values with their accessors), which follow rotation and the keyboard natively.

## Lists, tables, and large data

Use [`List`](./lists.md) (`virtual_list` in Rust) when data can grow beyond a small, bounded collection. Keep row
identity separate from visible position and avoid copying the full data set on every update. Let the list own
recycling, scroll coordination and the visible range while row functions own row presentation.

Separate:

- source data and domain ids;
- filtering and sorting state;
- selection state;
- scroll state;
- row rendering.

This keeps updates local and prevents the view tree from becoming the data model.

Virtualization is a behavioral contract, not just a performance switch. A row function runs once per cell, and cells
are reused for other rows:

- **must keep per-item state in data keyed by id**, not in a signal created inside the row, which travels with the
  cell to the next item;
- **must read the item where it is used**, in bindings: a value copied at the top of the row function belongs to the
  first row the cell showed;
- update immutably in TSX (a new array, unchanged items reused, a changed item a new object), and give an
  `estimatedItemSize` close to the typical row;
- scrolling to an item (`scrollToIndex`) works in data coordinates even when most rows do not exist.

```rust tabs
let liked = signal(HashSet::<u32>::new());

virtual_list(move || posts.with(Vec::len), move |at| {
    let post = computed(move || posts.with(|p| p[at.index()].clone()));
    view()
        .flex_row()
        .p_4()
        .child(text(move || post.with(|p| p.title.clone())).flex_1())
        .child(
            text(move || if liked.with(|s| s.contains(&post.with(|p| p.id))) { "♥" } else { "♡" })
                .on_press(move || toggle(post.with(|p| p.id))),
        )
})
.estimated_item_size(px(64.0))
```

```tsx tabs
const liked = signal<Set<number>>(new Set());

<List each={posts()} estimatedItemSize={64} class="flex-1">
  {(post) => (
    <View class="flex-row p-4">
      <Text class="flex-1">{post().title}</Text>
      <Text onPress={() => toggle(post().id)}>{liked().has(post().id) ? "♥" : "♡"}</Text>
    </View>
  )}
</List>
```

## Public API design

For reusable components:

- props establish valid defaults: `#[prop(default)]` or `#[prop(default = …)]` in Rust, `??` where the prop is read in
  TSX;
- every prop, event and export has a doc comment; in Rust it becomes the TypeScript declaration TSX sees;
- callbacks describe requested changes and include pointer details only when they are meaningful;
- explicit parts, slots and render functions are preferable to inspecting arbitrary descendants;
- adding reusable behavior must not force a product-level visual choice.

Apps are delivered to host apps as signed packages and may never be built again: every later release of NSH runs them
as they are. Apply the same discipline to what an app or a component library exposes to others (its components'
props and events, its crate's exports, the functions a host app's native components and modules receive):

- inputs gain optional members only; types only widen; defaults and behavior stay (new behavior is opt-in);
- options are one object (`scrollTo({ x, y, animated })`), never a third positional parameter;
- a mode is a string union, which can gain values, rather than a boolean that later needs a third state;
- a value has one type: `version: string`, never `string | number`;
- what a function returns is an object, which can gain a field, rather than a tuple or a bare value;
- a rename keeps the old name as a `@deprecated` alias of the same implementation.

In Rust, private fields are the default for behavioral state that must evolve without breaking callers. Public fields
are appropriate for deliberately record-like configuration and serialized data. Every public struct with public fields
must carry `#[non_exhaustive]` and implement `Default`, so callers can create values without exhaustive struct literals
and a field can be added without breaking them.

Keep public import paths stable while reorganizing internals: a crate's `#[native_module]` specifier and its exports,
and a TSX module's exports, are what other code imports. Prefer platform control terminology and NSH's established
naming over web-framework vocabulary.

## Platform and capability boundaries

Do not assume every platform supports the same facility. Title bars and window controls, accessibility, the
clipboard, haptics, scroll physics, fonts and timing can differ. One bundle runs everywhere
([Platform-specific code](./platform-specific.md)); put platform-specific code where NSH gives it a place and define
the fallback behavior:

- a prop two platforms have is a top-level prop; a prop of one platform goes in `ios={{…}}`, `android={{…}}`,
  `desktop={{…}}` or `web={{…}}` (a builder method in Rust), and only the current platform's object is applied;
- APIs of mobile platforms come from `nsh/mobile`, those of the desktops from `nsh/desktop`;
- styles per platform are `ios:`, `android:` and `web:` classes.

A platform branch must preserve the semantic contract even if presentation differs. For example, a dialog is a sheet
on iOS and a layer over the window on the desktops, but the app still needs a coherent open state. Test the shared
behavior headless and the platform's part with `nsh test --target`.

An app declares what it reaches outside its VM in `nsh.json` `"capabilities"`: the hosts it fetches from, the pages a
web view shows, the clipboard, the status bar ([Sandbox and Capabilities](./sandbox-and-capabilities.md)). An app
that will be delivered into other apps lists exactly what it uses, and handles a refused request as it handles a
failed one: a host app may grant less than the app declares.

## File and naming conventions

- Name pages and components after product concepts: `ProjectList`, `ProjectEditor`, `SettingsPage`.
- Name event handlers after intent: `confirmDelete`, `openProject`, `onQueryChange`.
- Keep one main responsibility per module; split a file when state ownership or lifecycle can no longer be understood
  without reading unrelated behavior.
- Keep a component's module, props, events and focused tests together when they change together.
- Document invariants and surprising lifecycle constraints; do not narrate obvious builder calls.
- Use `rustfmt` and satisfy Clippy in Rust, and `nsh check` in TSX. Avoid broad `allow` attributes that conceal
  unrelated warnings.

### Vocabulary is part of the API

Use the same word for the same concept across components. Before naming a prop or an event, look for the term in
NSH's own API, then in GPUI Kit's `gpui-base`, GPUI and `gpui-component`, then in the platforms' controls. What a
primitive shows and the global APIs take their names from HTML, the DOM and CSS (`src`, `html`, `placeholder`). Rust
names are `snake_case` and translate to `camelCase` in TSX (`on_open_change` is `onOpenChange`); one word stays one
word (`readonly`, `multiline`).

| Concept | Naming pattern | Example |
| --- | --- | --- |
| A component | A noun, `PascalCase` | `Button`, `Dialog`, `QuantityStepper` |
| Its props and events (Rust) | `<Component>Props`, `<Component>Event` | `ButtonProps`, `ButtonEvent::Press` → `onPress` |
| A behavior's state object | `<Control>State`, made by `create<Control>` | `NavStackState`, `createNavStack` |
| Why a value changed | `<Control>ChangeReason`, a string union | `DialogChangeReason`: `"cancel"`, `"backdropPress"` |
| A state | An adjective, positive, no `is` prefix | `open`, `hidden`, `disabled`, `selected`, `checked`, `readonly` |
| What the user may do | The adjective | `scrollable`, `zoomable`, `selectable`, `resizable` |
| A feature with no adjective | `<feature>Enabled` | `pagingEnabled` |
| Whether a part shows | A boolean named after the part, default `true` | `scrollbar`, `caret` (`scrollbar={false}`) |
| Whether a slot shows | `<slot>Visible`, default `true` | `headerVisible` (`header` is a page's slot) |
| A part's styles | `<part>Class`, `<part>Style` | `backdropClass`, `contentStyle` |
| A state's styles | `<state>Style`, `<state>:` classes | `activeStyle`, `disabled:` |
| A slot | What it is | `header`, `footer`, `trigger`, `content`, `empty` |
| Content of the app's | `render<Part>` | `renderCodeBlock` |
| A dismissal flag | `closeOn<Trigger>`, default `true` | `closeOnEscape`, `closeOnBackdropPress` |
| A value's change | `on<Value>Change(next, details?)` | `onChange(text)`, `onOpenChange(open, reason)` |
| Any other event | `on<Event>`, present tense, one object | `onPress()`, `onSubmit({ text })` |
| A phase | `<act>Start`, `<act>End` | `onPanStart`, `onLoadStart` |
| The pointer over a view | `In` / `Out` | `onHoverIn`, `onHoverOut` |
| Starting to listen | Returns `() => void` | `keymap.bind(..)` |
| A value of the environment | An accessor, `set<Value>` beside it | `colorScheme()`, `setColorScheme` |
| A read-only boolean | `is<Adjective>`, `has<Noun>` | `isAvailable` |

Props are never `is<Adjective>`: that form is for what only reads a boolean (a constant, a field of a payload). A part
that shows is named after the part, never `<part>Shown`, `<part>Hidden` or `shows<Part>`.

A Rust builder takes and returns `Self` and is named after the prop it sets, with no `set_` (`.disabled(..)`,
`.checked(..)`, `.on_change(..)`); mutation in place is `set_<field>` (`setRoutes`, `setColorScheme`). A boolean reader
is either `has<Noun>`, when the value holds something, or `is<Adjective>`, when it describes a state or a permission.
Reach for the adjective whenever the action has one: `isClosable` over `canClose`, `isZoomable` over `canZoom`. When
the action is a verb phrase with no adjective form, name the thing it needs instead: `hasDefinition`, not
`canGoToDefinition`. Do not add new `can` readers.

### Let the enclosing name carry the context

A name is read inside something: a prop inside its component, a field inside its type. Neither repeats what encloses
it (`contentStyle`, not `contentContainerStyle`; `Dialog`'s `backdropClass`, not `dialogBackdropClass`). Keep one type's
fields at the same level of abbreviation.

### Use precise domain words

- **selected** is membership or the current item; **checked** and **pressed** are the value of a checkbox or a toggle;
  **focused** is the keyboard's target; **hovered** is the pointer's presence. Never use them interchangeably.
- **open / close** is an overlay's state; **show / hide** a transient request; **expand / collapse** structure.
- **disabled** blocks interaction; **readonly** allows selecting and navigating but not editing; **loading** prevents
  duplicate work while an operation runs.
- **press** is activation by any input, and NSH's events say press (`onPress`); **click** is a mouse's.
- **index** is a position; **id** is identity. Do not persist or key reorderable data by index.
- **value** is controlled domain data; **state** is retained behavior.
- **src** is the resource an element shows (an image, a video, a page); any other address is a **url**.
- **role** says what a choice means (`"cancel"`, `"destructive"`); a look is the app's.

Avoid vague names such as `data`, `item2`, `handleAction`, `updateUi`, `process`, `manager` or `config` when a narrower
domain term exists.

### Type and module style

- Rust types are `UpperCamelCase`; modules, functions, methods, fields and locals `snake_case`; constants
  `SCREAMING_SNAKE_CASE`. Name context bindings `cx`.
- TSX components and their tags are `PascalCase`; props, functions and locals `camelCase`. Primitives come from `nsh`,
  base components from `nsh/base`.
- A module named after a component owns its public seam; split its state, parts and tests into files without
  changing what others import.
- Use singular module names for one component concept and established names for families (`menu` for `Menu`,
  `MenuItem` and `Submenu`).
- Suffix identifiers with `Id`, and collections with meaningful plurals. Do not alternate `idx`, `index` and `ix` in
  one subsystem.
- Name predicates positively when possible. A positive state is easier to compose than several negatives, but keep
  established terms such as `disabled` where they match control semantics.

### Callback and event wording

- A value's change passes the value first and anything else after it: `onChange(next)`, `onOpenChange(open, reason)`.
  Every other event passes one object, even with one field (`onLinkPress({ url })`), so a later field is an addition;
  an event with nothing to report passes nothing.
- Name the act, not past tense or a request: `onPress`, `onClose`, `onCancel`, `onBackPress`.
- Name the intent rather than the geometry when the act has a name: `onLoadMore`, not "the end was reached".
- Lifecycle pairs are `onOpen` / `onClose`; phases are `Start` / `End`, never `Begin`; the pointer over a view is
  `onHoverIn` / `onHoverOut`, a file dragged over it `Enter` / `Leave`.
- Document whether a callback runs before or after the component's own state changes, and whether it may re-enter the
  component.

### Documentation and copy style

Public docs should begin with what a component does and who owns its state. Examples must use current APIs and show
stable ids. Document defaults, platform differences, focus behavior, callback ordering, and which props the main
thread reads natively.

Follow the interface language rules of the Design Guides for labels, commands, confirmation dialogs, capitalization,
and ellipses. Keep one canonical term for each domain object, command, and state.

Translation keys describe stable intent (`dialog.deleteProject.title`), not a source-language sentence or a screen
coordinate. Never assemble a sentence from translated fragments or reuse one key for meanings that happen to share the
same English text.

Localize intent, not syntax. Give every locale control over word order, pluralization, punctuation, and the amount of
context it needs. Tests should catch missing keys and inconsistent fixed terms; human review still decides whether
repetition is justified by context. Verify every string inside its component with realistic content, text expansion,
and a large text size.

## Testing strategy

Test at the lowest layer that can prove the behavior ([Testing](./testing-and-trace.md)):

1. pure tests for state transitions, formatting, parsing and ordering (`cargo test` of a crate's functions, a test
   file of the store's functions);
2. headless app tests for components, events and lifetimes: the real engine, renderer, layout and lists, with display
   frames at 60 Hz, in `nsh test` (`nsh/test`) or `cargo test` (`nsh_testing::Headless`);
3. interaction tests for focus, keyboard, pointer, layout and rendered state, with the steps a user takes (`press`,
   `type`, `scroll`, `drag`, `keyboard.press`), headless and on a real platform (`nsh test --target macos`, `ios`,
   `android`, `web`, ...);
4. example or app smoke tests for complete workflows, and `nsh test --trace` for what an interaction costs.

```rust tabs
#[test]
fn a_tap_counts() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
    app.wait_for("Count: 0").unwrap();
    app.press("Tap").unwrap();
    app.wait_for("Count: 1").unwrap();
}
```

```tsx tabs
import { expect, open, test } from "nsh/test";

test("a tap counts", async () => {
  const app = await open("./App.tsx");
  await app.press("role:button[Tap]");
  expect(app.texts()).toContain("Count: 1");
});
```

For an interactive component, cover the semantic contract rather than its implementation details: activation by press
and keyboard, controlled value changes, disabled behavior, focus movement, event count and order, stable identity, and
important empty or failure states. Stub the network (`network` routes) and control time (a manual clock) instead of
waiting on real ones. Add a regression test before fixing a bug whenever the failure can be reproduced
deterministically.

Find views as a user does: by role and name, label or text (`role:button[Save]`, `label:Close`), and by a stable
`testID` where nothing else names them. Selectors are read again at every step, so a step never acts on a stale
snapshot. Use screenshots (`app.screenshot`, on a real platform) for visual facts selectors cannot express; use
coordinates only as a fallback. Report automated and manual evidence separately.

## Performance rules

- Do not write state unconditionally from a binding or an effect that reads it.
- Avoid creating signals, effects, key bindings and expensive data structures inside bindings or row functions.
- Read signals in bindings, so a coherent change updates the narrowest part of the tree.
- Use `List` for long collections and render only the visible range.
- Avoid cloning large strings or collections solely to satisfy a closure; capture `Copy` handles or shared data
  (`SharedString`, `Rc`).
- Keep TSX handlers and computed values light; move heavy work off the interaction path or into Rust.
- Measure with `nsh test --trace` before adding caches. A cache must have a clear invalidation owner.
- Keep animation work bounded: animated values on the UI thread rather than signals written every frame, `scrollValue`
  rather than a scroll listener ([Animation](./animation.md)), and honor reduced motion (`reduceMotion()`).

## Common failure modes

Avoid these patterns:

- one signal containing the app's unrelated state;
- business logic and network requests embedded in a long component body;
- random or index-based keys for reorderable content;
- per-row state in signals created inside a `List` row;
- reading a prop or signal in a component body and expecting it to update;
- literal colors and radii that break custom themes and dark mode;
- custom pressable views where a semantic component already supplies focus, keyboard, disabled, and accessibility
  behavior;
- duplicated local state that drifts from a controlled value;
- effects that copy one signal into another, and writes that loop through a binding;
- a decision the system needs on the spot left to a callback, instead of a prop set beforehand;
- nested scroll views without explicit ownership;
- a new component variant for a one-off screen;
- confirmation dialogs for reversible, low-risk actions;
- tests that call internal functions but never press, type or scroll.

## Rules for coding agents

Before editing, an agent must read the nearest implementation, its tests, the module's public exports, and the
relevant reference page. It must search the current source and `.nsh/types` for signatures instead of translating a
React, React Native, CSS or GPUI example by analogy: NSH components run once, and bindings follow the signals they
read.

For each change, the agent should be able to name:

1. the behavior owner and presentation owner;
2. the retained identity and state lifecycle;
3. the press, keyboard, focus, and accessibility contract;
4. the layout and scrolling owner;
5. the theme tokens and intentional exceptions;
6. the test that would fail if the behavior regressed.

Generated code must be reviewed and tested by a person. "Compiles" is not a UI quality bar, and a broad refactor that
merely makes generated code look tidy is not a substitute for matching the app's architecture.

## Implementation checklist

Before opening a change for review, confirm that:

- state and side-effect ownership are explicit;
- a plain function versus a component is chosen deliberately, and props and signals are read where they are used;
- repeated elements have stable domain-based keys and test ids;
- theme tokens and the Tailwind scale replace isolated visual literals;
- presses, keyboard shortcuts, focus, disabled state, and overlays work together;
- decisions the system needs on the spot are props, set beforehand;
- loading, empty, error, and cancellation paths are represented;
- long data sets use `List`, with per-item state in data;
- public API additions only widen, and preserve dependency direction and encapsulation;
- tests prove behavior at the appropriate layer, headless and on the platforms the change touches;
- formatting, Clippy, `nsh check`, targeted tests, and relevant examples pass.

See [Getting started](./getting-started.md) for app setup, and the [Elements](../elements/index.md) and
[API](../modules/index.md) references for current API details.
