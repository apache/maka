# TSX

TSX mode: UI and logic in TypeScript on QuickJS, with hot updates and no Rust toolchain. Pick it for UI delivered at
run time. With Rust of your own, see [mixed.md](mixed.md); with no JS at all, [rust.md](rust.md). A complete app is in
[tsx-recipe.md](tsx-recipe.md). `.nsh/types` is the authority on what exists.

## Components run once

A component is a function called once, when it is created. It sets up state and returns elements. It never runs again.
What updates are **bindings**: JSX expressions the compiler wraps, each a small effect that sets one prop or one child.

`function Counter() { const count = signal(0); ... <Text>Tapped {count()} times</Text> }` runs its body once; a tap updates one text node.

An expression in JSX changes when it **calls a function or reads a property**, outside nested functions. Everything else is set once:

| In JSX | Behaviour |
| --- | --- |
| `{count()}`, `{count}` | Follows the signal. Both work; write `count()` |
| `{props.title}`, `{user.name}` | Re-read when something it depends on changes |
| `{label}`, with `const label = count()` in the body | Set once: the body read it once |
| `style={{ opacity: busy() ? 0.5 : 1 }}` | The object is rebuilt; only changed keys reach the view |
| `onPress={() => ...}` | Set once. `onPress={props.onPress}` follows the prop |

Code in the body runs untracked: create signals, start effects, and read values you want only once there.

`mount(App)` starts the app and returns a function that unmounts it.

## Signals and writes

- `const todos = signal<Todo[]>([])`. Read with `todos()`, write with `.set(v)` or `.update(fn)`.
- Equality is `===`. `todos().push(x)` then `todos.set(todos())` notifies nobody, and no tool reports it. Write a new array: `todos.update((l) => [...l, item])`.
- `signal(0, { equals: false })` notifies on every write. Each write notifies at once; event handlers are not batched. Wrap several writes in `batch(() => { ... })`.
- `untracked(fn)` reads without subscribing. Signals at the top of a module are the app's store, and keep their value across hot updates while their initializer is unchanged.

## Reading props

Props are getters when the parent passed a changing expression. Reading one where it is used is what keeps it live.

```tsx
import { Text } from "nsh";

export function Price(props: { cents: number; currency?: string }) {
  const formatted = () => `${props.currency ?? "$"}${(props.cents / 100).toFixed(2)}`;
  return <Text>{formatted()}</Text>;
}
```

`const { title } = props` and `const upper = props.title.toUpperCase()` in the body read once and go stale.

`nsh build` warns only about taking props apart **in the parameter** (`function Row({ title })`). Those two pass every tool. Write them only when you mean "the value at creation", such as an initial id.

Defaults go at the read: `props.color ?? "#ddf4ff"`.

### split, to pass the rest on

`const { a, ...rest } = props` reads everything once. `split` keeps both halves live:

```tsx
import { split, Text, type TextProps } from "nsh";

export function Label(props: TextProps & { strong?: boolean }) {
  const [own, rest] = split(props, ["strong"]);
  return <Text {...rest} class={own.strong ? "font-semibold" : "font-normal"} />;
}
```

### children

Each read of `props.children` builds new views. Read it once, as `{props.children}`, where the children go. Type it `children?: JSX.Element`, with `JSX` a type import from `nsh`. A child can be a function, `children: (i: number) => JSX.Element`, so a component can pass it arguments.

## Text

Text shows only inside `<Text>`. Nested `<Text>` elements are spans.

A literal string directly in `<View>` is a build error. A literal in any other component (`<Button>Save</Button>`) and a
number or call in a `View` (`<View>{count()}</View>`) pass every tool and **show nothing**. Always wrap in `<Text>`.

## If, Each, List

`If` and `Each` are globals: no import.

```tsx
import { signal, Text, View } from "nsh";

type User = { name: string };
const user = signal<User | null>(null);
const todos = signal([{ id: 1, title: "Buy milk" }]);

export function Home() {
  return (
    <View class="gap-2">
      <If when={user()} else={<Text>Signed out</Text>}>
        {(u) => <Text>Hello, {u().name}</Text>}
      </If>
      <Each of={todos()} key={(t) => t.id}>
        {(todo, index) => (
          <Text>
            {index() + 1}. {todo().title}
          </Text>
        )}
      </Each>
    </View>
  );
}
```

- `If` builds a branch only when truthiness flips. A function child gets an accessor of `when`'s value without `null`.
- `cond() && <A />` and `cond() ? <A /> : <B />` work, but rebuild the branch each time anything they read changes, losing its state. Fine for a leaf; use `If` for more.
- `Each` keeps rows by `key`, by default the item (objects by identity, primitives by value). The row gets **accessors**, so read `todo().title`. Give a `key` whenever items get replaced by new objects, or rows rebuild.
- `items().map(...)` compiles, and rebuilds every row on any change. Use `Each`.

### List

`List` is for long data: it virtualizes and **recycles**. The row function runs once per cell, not per item, and a cell's item changes as it scrolls.

```tsx
import { List, signal, Text, View } from "nsh";

type Row = { id: string; title: string };
const rows = signal<Row[]>([{ id: "a", title: "First" }]);
const expanded = signal<Record<string, boolean>>({});

export function Rows() {
  return (
    <List
      each={rows()}
      keyExtractor={(row) => row.id}
      estimatedItemSize={52}
      class="flex-1"
    >
      {(row) => (
        <View
          class="border-b border-border p-4"
          onPress={() => expanded.update((e) => ({ ...e, [row().id]: !e[row().id] }))}
        >
          <Text>{row().title}</Text>
          <If when={expanded()[row().id]}>
            <Text class="text-muted-foreground">Details</Text>
          </If>
        </View>
      )}
    </List>
  );
}
```

Two silent bugs, reported by nothing:

- `const title = row().title` at the top of the row function stays the first item's title.
- `signal(false)` in a row belongs to the cell and travels to the next item. Keep per-item state in data keyed by id, as above.

## computed or a closure

| Use | When |
| --- | --- |
| A closure, `const label = () => ...` | Cheap, read in one place |
| `computed(() => ...)` | Expensive or read in several places: runs once per change, and readers are notified only if the result changed |
| `signal` + `effect` | Never for a derived value |

`const total = computed(() => price() * quantity())`. `computed` passes its previous value to the function, for values that accumulate.

`effect(() => b.set(a() * 2))` passes every tool, and takes a second pass to settle. An effect writing a signal it also reads stops the app at run time: `Error: potential infinite loop: an effect keeps changing what it reads`.

## Refs

`ref` gets the element's ref. Its type comes from `nsh`, not `nsh/base`.

```tsx
import type { InputRef } from "nsh";
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";

export function Search() {
  let input: InputRef | undefined;
  return (
    <View>
      <Input ref={input} placeholder="Search" />
      <View onPress={() => input?.focus()}>
        <Text>Focus</Text>
      </View>
    </View>
  );
}
```

A `let` or field is assigned, a signal is set, and a function is called with the node. A plain `const` holding anything else is reported when the element is made. Refs are set before the component returns.

## Context

```tsx
import { context, type Signal, signal, Text } from "nsh";

const Accent = context<Signal<string>>(signal("text-foreground"));

function Label(props: { children: string }) {
  const accent = Accent();
  return <Text class={accent()}>{props.children}</Text>;
}

export function Screen() {
  const accent = signal("text-primary");
  return (
    <Accent.Provider value={accent}>
      <Label>Hello</Label>
    </Accent.Provider>
  );
}
```

Calling the context reads the nearest provided value **once**. To provide something that changes, provide a signal, and read that in a binding. If only one exists, a module-level signal is simpler.

## Effects and cleanup

`effect(fn)` runs `fn` now and again whenever a signal it read synchronously changes. There is no dependency list. Reads after an `await` or in a `.then` are not tracked.

```tsx
import { cleanup, effect, signal, Text } from "nsh";

export function Clock(props: { running: boolean }) {
  const now = signal(Date.now());
  effect(() => {
    if (!props.running) return;
    const id = setInterval(() => now.set(Date.now()), 1000);
    cleanup(() => clearInterval(id));
  });
  return <Text>{new Date(now()).toISOString()}</Text>;
}
```

- `cleanup(fn)` runs before the effect runs again, and when the owner goes. Returning a function from the effect does the same.
- In a component body, `cleanup` runs when the component goes. A component goes when its `If` branch hides, its `Each` row leaves, or its page pops. Everything it created goes with it.
- `ErrorBoundary` catches what throws in a component's body, a binding, an effect or a listener under it: `fallback={(error, reset) => ...}`.

## resource, and stale results

Use `resource` for anything loaded. An effect with `fetch` gets races and no state.

```tsx
import { List, resource, signal, Text, View } from "nsh";

type Post = { id: number; title: string };

const query = signal("nsh");
const posts = resource(query, async (q, { signal: abort }) => {
  const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(q)}`, { signal: abort });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Post[];
});

export function Posts() {
  return (
    <View class="flex-1">
      <If when={posts.error()}>
        <Text class="text-destructive">Failed: {String(posts.error())}</Text>
      </If>
      <List each={posts() ?? []} refreshing={posts.state() === "refreshing"} onRefresh={posts.refetch} class="flex-1">
        {(post) => <Text>{post().title}</Text>}
      </List>
    </View>
  );
}
```

- A new source value starts a load. `undefined`, `null` or `false` loads nothing: state `"unresolved"`.
- **Only the latest load counts.** A new load drops the one running, and so does the component going away; `info.signal` aborts its `fetch`. A superseded result changes nothing.
- `posts()` is the latest value, `undefined` before the first load ends, kept while reloading and after a failure.
- States: `"unresolved"`, `"pending"`, `"ready"`, `"refreshing"`, `"errored"`.
- `refetch` and `mutate(value)` are bound, so `onRefresh={posts.refetch}` works. `mutate` is an optimistic write.
- `resource(fetcher)` with no source loads once. `{ initialValue }` removes `undefined` from the type.

A hand-written async handler must guard itself: check a token after each `await`. One that throws with nobody awaiting logs `unhandled rejection`.

## Styling: class and tokens

```tsx
import { signal, Text, View } from "nsh";

export function Chip(props: { label: string; class?: string }) {
  const on = signal(false);
  return (
    <View
      onPress={() => on.update((s) => !s)}
      class={`rounded-(--radius) px-3 py-1 active:opacity-80 ${props.class ?? ""}`}
      classList={{ "bg-primary": on(), "bg-muted": !on() }}
    >
      <Text class={on() ? "text-primary-foreground" : "text-muted-foreground"}>{props.label}</Text>
    </View>
  );
}
```

- `class` is Tailwind v4's scale, resolved natively. `classList` applies after it. Later classes win, so a component can append the caller's `class`.
- `style={{ ... }}` wins over classes per property; numbers are points. Use it for computed values and animated values.
- A `View` is a **column** by default. `flex-row` or `class="flex"` makes a row.
- Tokens are shadcn's: `bg-background`, `text-foreground`, `bg-card`, `bg-primary`, `text-primary-foreground`, `bg-muted`, `text-muted-foreground`, `border-border`, `border-input`, `text-destructive`, `rounded-(--radius)`. Add roles in the theme file (`nsh.json` `"theme"`): a role `up` gives `bg-up` and `token("up")`, typed.
- Variants: `active:`, `hover:`, `focus:`, `disabled:`, `dark:`, breakpoints, `ios:`, `android:`, `web:`.
- Safe area: `pt-[env(safe-area-inset-top)]`.
- `nsh/base` has behaviour and no look. A `Switch` without `trackClass` and `thumbClass` draws nothing, and its test still passes. Style each part and look at it.
- An unknown static class is a `warn` from `nsh build`, and does nothing. A class built at run time is logged once when first seen. Raw `#hex` and arbitrary values pass every tool; use tokens.

### Liquid Glass on Apple platforms

Use the native material on a floating `View`, with a blur for older systems and other platforms:

```tsx
<View style={{ borderRadius: 24, borderCurve: "continuous", glassEffect: "regular", backdropFilter: "blur(20px)" }}>
  {props.children}
</View>
```

`glassEffect` draws Apple's Liquid Glass on iOS 26+ and macOS 26+; elsewhere `backdropFilter` supplies the fallback.
Verify these properties against the project's generated types. An opaque background drawn over the material hides the
effect; use a transparent or restrained translucent tint if needed, checking contrast in light and dark appearance.
The native material already draws its edge: inspect before adding a border or shadow, which can make a double outline.
Platforms without a usable backdrop need a legible solid fallback. Keep content and hit targets above the material.
Test against both light and dark content moving behind the surface, in focused and unfocused states on the actual
target when available; an empty or uniform background and a headless test cannot establish the visual result. Use glass
for surfaces that float over content when appropriate, not automatically for every settings row or card.

## Events take one object

Every handler takes one object. Destructure the event; that is safe, unlike props.

| Prop | Argument |
| --- | --- |
| `Input` `onChange` | `{ value }` |
| `Input` `onSubmit` | `{ text }` |
| `Input` `onKeyPress`, `onSelectionChange`, `onCompositionChange` | `{ key }`, `{ start, end }`, `{ composing, text }` |
| `View` `onPress`, `onLongPress` | `PressEvent`; may be ignored |
| `Button` (`nsh/base`) `onPress` | Nothing |
| `View` `onLayout` | `{ bounds }` |
| `Dialog`, `Sheet`, `Popover` `onOpenChange` | `{ open, reason }` |

**Handlers run asynchronously.** The main thread never waits for app code, so a handler cannot veto anything. A decision the system needs at once is a prop set beforehand: `popOnBack`, `closeOnEscape`, `disabled`. There is no callback returning a boolean.

## Forms and the keyboard

```tsx
import type { InputRef } from "nsh";
import { signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

export function SignIn(props: { onSubmit: (email: string, password: string) => void }) {
  const email = signal("");
  const password = signal("");
  let passwordField: InputRef | undefined;
  const submit = () => props.onSubmit(email(), password());
  return (
    <View class="gap-3 p-4">
      <Input
        value={email()}
        onChange={({ value }) => email.set(value)}
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="next"
        onSubmit={() => passwordField?.focus()}
        class="rounded-(--radius) border border-input px-3 py-2 text-base"
      />
      <Input
        ref={passwordField}
        value={password()}
        onChange={({ value }) => password.set(value)}
        masked
        returnKeyType="done"
        onSubmit={submit}
        class="rounded-(--radius) border border-input px-3 py-2 text-base"
      />
      <Button onPress={submit} disabled={!email()} class="rounded-(--radius) bg-primary px-4 py-2 active:bg-primary/90">
        <Text class="text-primary-foreground">Sign in</Text>
      </Button>
    </View>
  );
}
```

- `Input` is from `nsh/base`. It is controlled with `value`, uncontrolled with `defaultValue`.
- `submitBehavior`: `"blurAndSubmit"` (single line default), `"submit"`, `"newline"` (multiline default).
- During CJK composition, `onChange` also reports the text being composed on iOS, Android, macOS and the web. To act only on committed text, track `onCompositionChange`.
- Inputs inside `Scroll` stay above the keyboard automatically. Outside one, use `keyboardFrame()` from `nsh`.
- Shortcuts: `keymap.bind("mod+k", handler)` from `nsh`; the binding goes with the component.
- Use `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `DatePicker`, `NumberInput`, `OtpInput` from `nsh/base`. Do not rebuild them.

## Navigation

```tsx
import { Scroll, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

type Route = { name: "inbox" } | { name: "message"; id: number };

const nav = createNavStack<Route>([{ name: "inbox" }]);

function Header(props: { title: string }) {
  return (
    <View class="h-12 flex-row items-center gap-3 border-b border-border px-4">
      <If when={nav.routes().length > 1}>
        <Text role="button" onPress={() => nav.pop()}>Back</Text>
      </If>
      <Text class="font-semibold">{props.title}</Text>
    </View>
  );
}

function Inbox() {
  return (
    <NavPage title="Inbox" header={<Header title="Inbox" />}>
      <Scroll class="flex-1">
        <Text onPress={() => nav.push({ name: "message", id: 1 })} class="p-4">Message 1</Text>
      </Scroll>
    </NavPage>
  );
}

function Message(props: { id: number }) {
  return (
    <NavPage title={`Message ${props.id}`} header={<Header title="Message" />}>
      <Text class="p-4">Body of {props.id}</Text>
    </NavPage>
  );
}

export function App() {
  return (
    <NavStack state={nav} class="flex-1">
      {(route) => (route.name === "inbox" ? <Inbox /> : <Message id={route.id} />)}
    </NavStack>
  );
}
```

- **Give a page both.** `title` feeds the system header on iOS and Android. `header` is what shows on desktops and the web. With only `title`, a desktop page has no header and no Back.
- State methods: `routes()`, `push`, `pop(count?)`, `popToRoot`, `replace`, `setRoutes`, `remove`.
- Pages stay mounted with their state while in the stack. A stack made at module level keeps its pages across hot updates.
- To guard leaving, set `popOnBack={!dirty()}` beforehand and react in `onBackPress`. Android's back button goes to the top dialog, then `BackHandler` listeners, then the stack.
- On phones, use `TabBar` from `nsh/mobile` for system tabs; `Tabs` from `nsh/base` is the app-styled one.

## Overlays

```tsx
import { signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";

export function Confirm() {
  const open = signal(false);
  return (
    <View>
      <Button onPress={() => open.set(true)}>
        <Text>Open</Text>
      </Button>
      <Dialog open={open()} onOpenChange={(e) => open.set(e.open)} class="m-auto rounded-(--radius) bg-popover p-4" backdropClass="bg-black/50">
        <Text class="text-popover-foreground">Hello</Text>
      </Dialog>
    </View>
  );
}
```

- Each has focus, keyboard, dismissal and accessibility. Do not rebuild them from `View` and `Overlay`.
- `Dialog` keeps closing if the user closes it, whatever `open` says: keep `open` in sync in `onOpenChange`.
- `closeOnEscape`, `closeOnBackdropPress`, `closeOnSwipe`, `closeOnPressOutside` decide dismissal up front.
- `Sheet` takes `open`, `onOpenChange`, `side` and `popupClass`. `Popover` and `Menu` take `trigger` and `popupClass`.
- `const { action } = await AlertDialog.show({ title, actions: [{ id: "delete", label: "Delete", role: "destructive" }] })` resolves the chosen `id`, or `null` when closed without one.
- `Menu` holds `MenuItem`s, each with `onSelect`.
- `ToastStack`, `Tooltip`, `HoverCard`, `ContextMenu` and `Command` are also in `nsh/base`.

## Runtime and sandbox limits

TSX runs on QuickJS (in a browser, its JS engine). There is no DOM, no Node and no npm UI.

- **Imports:** `nsh`, `nsh/base`, `nsh/base/plot`, `nsh/mobile`, `nsh/desktop`, `nsh/updater`, `nsh/test`, relative files, your crates' specifiers, and the standard modules.
- **Standard modules, exactly these:** `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib`. `fs` and `node:fs` fail: `nsh has no module`. Other bare packages fail: `could not load module`.
- **Globals:** `fetch`, `AbortController`, `URL`, `Blob`, `TextEncoder`, `WebSocket`, `crypto`, `performance`, `Buffer`, `process`, timers, `requestAnimationFrame`, `queueMicrotask`. Not `structuredClone`, `window`, `document` or `localStorage`; use `windowSize()` and `Storage` (async).
- **Hardened outside `nsh dev` and `nsh run`:** `eval` is removed, the `Function` constructor throws, and shared prototypes are frozen. `nsh test` hardens, so run it before relying on any library that builds code from strings.
- **Limits**, only when embedded in a host: call budget 2 s (the call is cut off, and the app goes on), load 10 s, heap 256 MB and 200 000 nodes (the VM stops). `nsh run --limits` tries them. Split long work.

### Capabilities

An app with no `"capabilities"` key may do everything except `host`, raw sockets and web view `input`, which are always named. One with the key may do only what it lists, such as `"capabilities": { "network": { "hosts": ["api.example.com"] }, "clipboard": true }`.

- Keys: `network`, `webview`, `statusBar`, `clipboard`, `picker`, `speech`, `notifications`, `openUrl`, `process`, `fs`, `host`. An unknown key fails `nsh build` and passes `nsh check`.
- A refusal rejects with `code` `ERR_ACCESS_DENIED`, `permission` and `resource`; `fetch` rejects with a `TypeError` of that code. Each refusal logs the key to add.
- A host embedding the app may grant less than declared.
- Details are in [tooling.md](tooling.md#capabilities).

## Who reports what

Every row was run through `nsh build` and `nsh check` at `nsh 0.4.0`, and the run-time rows through `nsh test`. "Nothing" means every tool passes and the app is wrong.

| Mistake | What happens | Reported by |
| --- | --- | --- |
| Type error, wrong prop, missing prop | Build passes; wrong at run time | `nsh check` only |
| Props that do not exist: `className`, `onClick`, `onChangeText`, `onBeforeLeave`, `List`'s `data` and `renderItem` | Do nothing, or wrong at run time | `nsh check` only |
| `onChange={(t: string) => ...}` | `t` is the object | `nsh check` only |
| `window`, `document`, `localStorage` | Throws at run time | `nsh check` only |
| `item.title` in `Each` or `List`, not `item().title` | `undefined` | `nsh check` only |
| `style={{ foo: 1 }}` | Run-time `warn unsupported style property` | `nsh check`; at run time a `warn` |
| `<view>` lowercase tag, `<Buton />` | Fails | `nsh build`, `nsh check` |
| Using a missing export (`useState`, `FlatList`, `StyleSheet`, `Input` from `"nsh"`) | Fails | `nsh build`, `nsh check` |
| Same name imported and **not used** | Dropped from the bundle | `nsh check` only |
| Using a bare package (`react`, `left-pad`), `fs`, `node:fs`, a missing relative file | Fails | `nsh build`, `nsh check` |
| Missing asset (`./x.png`) | Fails | `nsh build` only |
| `<View>hello</View>`, `<View>{"hello"}</View>` | Fails | `nsh build` only |
| `nsh.json` capabilities typo | Fails | `nsh build` only |
| `function Row({ title })` | Stale | `nsh build`, a `warn` only |
| Unknown class in a static `class` | The class does nothing | `nsh build`, a `warn` only |
| Unknown class built at run time | The class does nothing | Run-time log, once |
| Effect writing a signal it reads | App stops: `potential infinite loop` | `nsh test`, or at run time |
| `eval`, `new Function`, writing to `Array.prototype` | Fine in `nsh run`; throws when hardened | `nsh test`, or in the package |
| `<Button>Save</Button>`, `<View>{count()}</View>` | Not shown | Nothing |
| `const { title } = props`, `const { a, ...rest } = props`, `const v = count()` or `props.title.toUpperCase()` in the body | Stale | Nothing |
| `items().push(x); items.set(items())` | No update | Nothing |
| `effect(() => b.set(a()))` | Works; an extra pass | Nothing |
| `cond() && <A />`, `.map(...)` | Works; rebuilds, losing state | Nothing |
| `signal` or `const t = row().title` in a `List` row | State or data of the wrong item | Nothing |
| Hand-made dropdown from `View` | No keyboard or dismissal | Nothing |
| Raw `#hex`, `bg-[#123456]` | Ignores the theme and dark mode | Nothing |
| `Switch` with no `trackClass` or `thumbClass` | Invisible; tests pass | Nothing; look at it |

Run `nsh check`, `nsh build` (read its warnings), `nsh test`, then `nsh run` and look.
