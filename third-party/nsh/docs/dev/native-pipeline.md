# How apps are compiled and run: NSH's JSX compiler and native modules

An app is TSX importing NSH's modules. The bundler compiles each module with NSH's JSX compiler and rolldown bundles
them into one ES module holding only the app's code (split into chunks loaded on demand for the web: "Split bundles"): imports of NSH's modules stay imports, and `nsh-js` serves them
natively. The reactive graph, the renderer and every API apps import are Rust; nothing of NSH is JS. Apps cannot
import `solid-js` (the bundler refuses it, pointing to `nsh`'s `signal` / `computed` / `effect` / ...). It also refuses a named import a
native module does not export, as the names `nsh-js` serves say (`native_module_exports`), when the code uses it as a
value (types need no `type` keyword), with the place in the source and the closest export's name.

```tsx
import { computed, mount, signal, Text, View } from "nsh";

function Counter(props: { label: string }) {
  const count = signal(0);
  return (
    <View onPress={() => count.update((c) => c + 1)}>
      <Text>{props.label}: {count()}</Text>
      <If when={count() > 2} else={<Text>keep going</Text>}>
        <Text>done</Text>
      </If>
    </View>
  );
}

mount(() => <Counter label="Taps" />);
```

## Modules

`nsh_core::js::NATIVE_MODULES` names NSH's own, the registries name the rest; the bundler leaves imports of them in the
bundle (`plugin.rs`, an unknown `nsh/…` is an error), `nsh-js` serves them (`modules.rs`, the module table and the
loader). Where each one is implemented and declared: `js-modules.md`.

- `nsh`: `signal` (`count()`, `count.set(v)`, `count.update(f)`), `computed`, `effect`, `batch`, `untracked`, `cleanup`,
  `context` (`Theme()`, `<Theme.Provider value>`), `split(props, keys)` (`[picked, rest]`, keeping getters), `mount`,
  `ErrorBoundary` (Rust's `catch_error`);
  the primitives `View`, `Text`, `Scroll`, `Input`, `Overlay`.
- `nsh:rt` (only compiled code imports it): `element`, `text`, `append`, `insert`, `prop`, `bindProp`, `spread`,
  `component`, `cond`, `each`, `merge`, `list`, `setup`, `font`, `metaUrl`. The bundle shares one `import.meta`, so
  the compiler turns each module's `import.meta.url` into `metaUrl("<its path in the app>")` (a module that mentions
  `import.meta` goes through the compiler even without JSX), which `dom.rs` resolves against the app's directory
  (`${pluginDir}` as a `file:` URL), else the page's URL (`HostOptions::base_url`), else `asset:/`. `import.meta`
  itself is left as it is.
- `nsh`'s `windowSize`, `colorScheme`, `fontScale`, `pixelRatio`, `locale`, `platform` and
  `reduceMotion`, `screenReaderEnabled`, `announce`, `setAccessibilityFocus`: the environment (`env.rs`), one
  signal per part written when the platform reports a change, read through read-only accessors.
- `nsh`'s primitives `List`, `Canvas` (with `Path2D`, `CanvasRenderingContext2D`, `CanvasGradient`), `WebView`,
  `Video` and `Image` (the image element's component with the `nsh` registry's `Image` functions on it): internal
  sources `nsh` serves (`modules.rs` `NSH_SOURCES`, `NativeModule::moved_to`), no modules apps import; their
  declarations go into `nsh`'s own file (`nsh/index.d.ts`). So are the rest of `nsh`'s hand-written exports
  (animation, gestures, native components, the host channel, keyboard shortcuts); `nsh/mobile`'s hand-written part
  (`InputAccessoryView`, `BackHandler`'s listeners) is served from `MOBILE_SOURCES` the same way (below).
- The modules of registries (`Registry::specifier`): the runtime's (the registry part of
  `nsh` (`Keyboard`, `Image`'s functions, the environment's
  and accessibility functions, `Clipboard`, `Picker`, `Storage`, `host`), `nsh/mobile` (`TabBar`, `BackHandler`) and `nsh/desktop`) and the UI sets a host serves
  (`HostOptions::ui_sets`: `nsh/base` by default, the app's `app/native`). Their
  components, modules and re-exports become exports (`components.rs`): a component is a host view naming it, with its
  props converted into their Rust types and sent by one render effect, events delivered to `on<Event>` handlers,
  children and slot holders; a module function runs in the call, or converts its arguments there and sends what it
  runs to the core as an op, returning a promise the core's events settle when it has a result
  (`docs/dev/rust-classes.md`, "How calls cross"). Values a registry names natively (`Registry::native_values`: `nsh/base`'s navigation) and
  re-exports (`nsh`'s `safeArea`, `safeAreaInsets`, `keyboardFrame`) come from the runtime. NSH's own export wins over a registry's of the
  same name.

QuickJS-NG resolves imports when it compiles a module, so the bytecode compiler installs the same loader
(`compile_bytecode_with` with the app's UI sets); names are checked when the module links (evaluation). The exports are made
on first import. The compiler only needs the names a module exports, so it takes the UI sets as data
(`nsh_core::element::description::SetDescription`: specifier, exports and their kinds, declarations, re-exports, files),
as the bundler and `.nsh/types` do: `ModuleTable::compiling` serves nsh's own modules and the runtime's registries in
full and the sets by name. That is how the prebuilt `nsh` compiles an app whose crates it does not link
(`tooling.md`, "Apps with Rust components of their own").

## The compiler (`crates/nsh-bundler/src/jsx.rs`)

One Oxc pass removes TypeScript and lowers JSX (`plugin.rs` `compile_native`):

- **Tags** are PascalCase and name bindings by normal scoping: every tag is imported or local, except `<If when else>`
  and `<Each of key>`, globals (`dom.rs` `install_globals`) a binding of the same name shadows. A tag naming one of
  `jsx::PRIMITIVES` imported from its module (alias-aware: `import { View as V } from "nsh"`) compiles to what it is,
  with no component call: `View`, `Text`, `Scroll`, `Overlay`, `Image`, `WebView`, `Video` (`nsh`) and `Input`
  (`nsh/base`) to their host elements made in place, `List` to `nsh:rt`'s `list`, `If` / `Each` to `cond` / `each`; `Canvas`,
  `Dialog` (`nsh/base`) and `InputAccessoryView` are native components that do more than make their element (the
  drawing, `open`, the popup and backdrop parts and the insets, iOS only) and are called. The exports are callable components too (`dom.rs`
  `host_component`; `If` and `Each` are real globals), so `const C = cond ? View : Text; <C />` works through the
  component path. Lowercase tags are errors with the import to write (`<view>`: write `<View>` and `import { View }
  from "nsh"`; for another, the closest binding, primitive or registry component). Why: TypeScript checks a lowercase
  tag against one global type per name, so generic components (`List`, `Each`) and local ones would lose their types.
  Props keep their camelCase names. Only `<Text>` shows text (the core lays out raw text in a text block alone): text
  written in another host element (`<View>Hi</View>`, a string, number or template literal) is an error saying where it
  goes (`check_unshown_text`); a string an expression puts there is reported once per tag at run time (`dom.rs`
  `report_unshown_text`), except in a Rust component's view or slots (`places`), which place what they get.
- **Host elements** become one arrow function making the element and its host children: static props and children
  are set once (`prop`, `append`), changing ones are functions the renderer follows natively (`bindProp`, `insert`).
  An expression changes when it calls something or reads a member outside nested functions (Solid's rule). Event
  handlers are set once when they are a function or a name, followed otherwise. `ref={…}` goes through `nsh:rt`'s `ref`
  (`dom::apply_ref`), which sets a signal or calls a function: a `let` variable or a field (`ref={refs.input}`,
  `ref={refs[k]}`, object and key evaluated once) is assigned the node otherwise (`ref(el, n) || (el = n)`); a `const`
  or an import, which cannot be assigned, passes its name, so a value that is neither is an error saying what to write.
  Other expressions are the `ref` prop, which `apply_ref` handles likewise; a component's `ref` is a method doing the
  same with what the component gives. Consecutive dynamic children share one `insert`, before the next static child.
- **Components** that take their props apart in their first parameter (`function Title({ text })`, top-level
  functions and arrows with JSX and a PascalCase name, as `hot.rs` finds them) get a build warning naming the props
  to read instead (`props.rs`, logged by the plugin with the module's path, target `nsh::build`): each would be read
  once. Taking them apart in the body (`const { id } = props;`) is left alone, as a choice the code states.
- **Components** are called untracked with a props object: static props as values, the others as getters, children as
  the `children` getter; spreads go through `merge`, which keeps getters. Among several children, an expression that
  changes is a function of its own (`["one ", () => s()]`), so the getter, which makes every sibling, reads none of
  them; a lone child is the getter's (`get children() { return s(); }`).
- **Text** follows Babel's algorithm (what React renders): lines are trimmed except at the text's ends, whitespace-only
  lines dropped, the rest joined with a space; whitespace on one line is kept (`{a} {b}` keeps its space).
- Code is generated as JS text with holes, parsed, and the app's expressions are moved into the holes: they keep their
  spans (the source map points at the app), generated nodes take their JSX element's span.
- The entry's prologue gives the renderer the app's themes (`setup`: the Tailwind theme and the components' `uiTheme`,
  the appearance and the status bar's default, `nsh.json` `"statusBar"`, before anything renders). A font import (`import Inter from "./Inter.ttf"`) compiles to `import { font } from
  "nsh:rt"; export default font(uri, family)`: its family, registered by the host before the first frame.

## The renderer (`crates/nsh-js/src/dom.rs`)

- A node is an object of a native class holding its id, its children's objects and its event handlers, reported by its
  GC mark: the tree and what handlers capture are one heap QuickJS collects. The root view is held by the renderer;
  a node nothing refers to is collected and its view released (its finalizer queues the release separately, as the op
  queue may be borrowed when a finalizer runs).
- Every change is an `Op` pushed straight into the host's queue (`Shared.ops`, at most `Limits::max_op_values` at
  once); the engine takes them after the JS turn for one `Core::commit`. Props are decoded from the JS value by
  `protocol::decode_prop`. Events go from `Host::dispatch_event` to the handler the node holds (`dom::handler`);
  touches to the responder system (`touch.rs`).
- Dynamic children are a render effect updating the nodes the insert shows (an array the insert's effects share),
  reconciled with Solid's `reconcileArrays` against the renderer's mirror of the tree; a node that comes again later
  is moved, never removed and inserted (the core would remake its view), and an insert that would not move a node is
  skipped. An insert of a function (`insert_run`) calls it, tracked by its effect; a function it returns (a component whose
  root is an `<If>` returns `cond(…)`) gets a render effect of its own under it, as Solid's `insertExpression` gives
  one, so a change in that function's condition runs only it: tracked by the outer effect, it would call the
  expression again and make the component again (its state lost). When that gives an array holding functions (a component's `children`: `[element, cond(…)]`), the array gets an effect of
  its own (`insert_items`, Solid's nested effect in `insertExpression`), made again only when the outer one runs: a
  change in an `<If>`, an `<Each>` or a ternary among the children runs that effect, never the getter, so the siblings
  it made stay (an input keeps its text and focus). Each function in such an array (also a run of dynamic children,
  one `insert` of an array, `{spans()}{tail()}`) gets a memo of its own (`memoize_run`): a change in one re-runs only
  that one, and the others' nodes stay where they are. A function such a memo's function returns (an `<If>` whose
  branch is an expression, `<If when={w}>{(() => …)()}</If>`) gets a memo of its own too, under that one
  (`item_memo`): called by the array's effect, it would make its nodes again whenever a sibling changes; called by
  the outer memo, a change in what it reads would run the outer function again (a component made again).
- `each` keys rows (`key(item, index)`, the index for `key="index"`, else the item; objects by identity, primitives by
  value) and updates the item and index signals of kept rows (rows get accessors: `item()`, `index()`); each row has
  its own owner. `cond` renders a
  branch per change of truthiness. An `<If>` whose child is a function written in place compiles to
  `((w) => cond(w, () => (fn)(w), …))(() => when)`: the function gets an accessor of `when`'s value (Solid's `<Show>`),
  read through the same thunk the condition is.
- Errors: a computation that throws keeps the exception as the round's error, thrown out of the native that ended the
  round (the first wins), unless an `ErrorBoundary` is above the owner it ran under. A boundary (`error_boundary`) is
  a memo showing its children or its fallback by a signal (`[error]` while failed); the children render in a memo of
  their own under it, whose context names that signal under a key of the graph's (`reactive::boundary_key`), so a
  failure under it (`Js::call`: the computation is still the current owner) finds the boundary as `useContext` would.
  Caught exceptions wait in `JsData.caught` (the first per boundary wins) until no computation runs (`finish` with
  `running` at 0): setting the signal then runs the boundary again, which disposes the children's memo (what failed)
  and calls `fallback(error, reset)` under the outer memo, so what fails in the fallback goes to the boundary above.
  Listeners match Rust's: each node keeps the owner it was made under (`NodeData.owner`), and a handler's exception
  (`Host::dispatch_event`, `touch.rs`) goes to that owner's boundary (`dom::catch_listener_failure`). Without a
  boundary nothing changes: no lookup runs but the context walk of a failing computation.
- Platform-only props (`ios={{…}}`, `android={{…}}`, `desktop={{…}}`): only the current platform's object is sent, each
  key as a prop of its own (`platform_props`).
- The reactive graph and the renderer share one per-context state (`state.rs`); natives reach each part by shared or
  short exclusive references, never across a call into JS or a free of a JS value.

## Lists and node methods

- `List` (`nsh`) is the renderer's (`list.rs`; its tags compile to a component call of `nsh:rt`'s `list`, the
  same function). The core asks for rows (`Host::bind_list`), bound natively (`list::bind`); a recycled cell gets a
  new index and its item accessor follows; header, footer, empty and separator cells, viewability tokens (with
  `minimumViewTime`), `initialScrollIndex`. Rust components with rows (an `Items` prop) get a list of the app's data as
  their items slot.
- Nodes have the methods of `YNode` (`_core.d.ts`: `focus`, `blur`, `setSelection`, `command`, `scrollTo`, `zoomTo`,
  `scrollToOffset`, `scrollToIndex`, `scrollToEnd`, the web view's and video's): each sends a command
  (`protocol::decode_command`); `measure` returns a promise the core settles after the turn's layout
  (`Command::Measure`, `elements.md`).

## Navigation

`createNavStack`, `NavStack`, `NavPage` and `Dialog` are natives (`navigation.rs`), which `nsh/base` exports
(`Registry::native_values`). A stack renders each route (each push its own entry, the same route pushed twice
included) with the app's function into a page, the app's `<NavPage>` or one around what it rendered (also when a hot
component returns an accessor); a page the user pops natively removes its route and calls `onDismiss`; pages and dialogs
provide the insets they report to what they render (`safeAreaInsets`). The handlers of a page's and a dialog's native
events are the runtime's: they keep the stack in step and call the app's props (`onDismiss`, `onBackPress`, `onOpen`,
`onClose`, `onCancel`, `onOpenChange`), so the app's names are not the core's events' (`onDismiss`,
`onRequestClose`, ...). A dialog renders the app's popup (`class` / `style`) and, while the app styles one
(`backdropClass` / `backdropStyle`), a backdrop part behind it whose presses are close attempts.

## Runtime modules

- `PanResponder` (`nsh`): the responder system and `PanResponder` (`touch.rs`), in Rust as it runs on every touch move.
- Animation (`nsh`, `animated.rs`): operations are encoded as a few values (`ANIMATION_*`) and decoded into `AnimationOp`s
  (`protocol::decode_animation_op`); nodes and composites are released by their finalizers; a started animation's promise
  settles when the core reports its end (`Host::animations_finished`).
- `WebView`, `Video`, `nativeComponent`, `nativeModule` (`nsh`) and the hand-written part of `nsh/mobile` (`isAvailable`, `InputAccessoryView`,
  `BackHandler`'s listeners): `platform_modules.rs`.
- `Canvas` (`nsh`, `canvas.rs`): a drawing makes thousands of calls, so the context records into a Rust list instead of a
  JS array, and the core's decoder (`nsh_core::js::canvas::decode`) reads it into one `Op::Draw`. The recording methods
  and properties are made from the core's specs (`CanvasOp::methods` / `properties`), so a new operation needs no
  change here. Paths and gradients are taken as they are when the drawing uses them.

## Types

`.nsh/types` holds the declarations of everything NSH serves, made from its Rust sources (`nsh-js`
`declarations.rs`, `tooling.md`), the same for every app: the JSX namespace (`nsh/jsx-runtime.d.ts`, `JSX` of
`nsh/types.d.ts`) has no intrinsic elements, so TypeScript checks every tag as the value it names (a lowercase tag is
an error, as in the compiler) and infers generic components (`<List each={rows}>{(row) => …}</List>`, `If` and `Each`
declared as global functions in `nsh/globals.d.ts`). The bundler's part is only the asset imports
(`nsh/assets.d.ts`, `crates/nsh-bundler/src/types.rs`).

TypeScript's import elision runs after the JSX is compiled (`plugin.rs` `elide_unused_imports`): an import only
primitives' tags use (`View` for `<View>`, made in place) goes, as does one only types use (even without `type`).

## Split bundles (`import()`)

A release bundle holds the whole app: rolldown inlines what `import()` loads (`code_splitting: false`), so
`import("./Screen")` resolves at once, and native packages (`.nshpkg`, `nsh package`) are one bundle as before.
`BundleOptions::split` (`nsh build --split`, the web) makes chunks instead: the entry is `bundle.js`
(`nsh_core::js::ENTRY_CHUNK`, also the module name the runtime evaluates it under), every other chunk is `[name].js`
with no digest (`Bundle::chunks`: id, code, source map, the chunks it imports statically), so ids stay stable and
packagers add digests (`app.<digest>.js`) with a map from id to URL. Chunks import each other and the entry statically
by relative name (`import { t } from "./bundle.js"`), which QuickJS resolves to the modules already loaded.

QuickJS's module loader is synchronous (it resolves a module's imports while compiling it), so the page could not fetch
a chunk on the way. The plugin's `render_chunk` (`split.rs`) rewrites each dynamic import of a chunk into
`__nsh_import("Screen.js", ["detail.js"])` (`nsh_core::js::IMPORT_CHUNK`): the chunk and, transitively, the chunks
it imports statically (string_wizard keeps the source map). The runtime (`nsh-js` `chunks.rs`) asks the host for the
missing ones in one go (`Host::take_chunk_requests` → `MountSink::load_chunk`; the web page fetches them), and once
all are there imports the first with QuickJS's own `JS_LoadModule` in a job: the loader (`modules.rs`) compiles each
chunk from the code given (source or bytecode, `compile_chunk_bytecode`), modules are evaluated once and in order, the
promise is QuickJS's. A chunk that cannot be loaded rejects the imports that need it (`Host::chunk_failed`); a later
import asks again. Ids are checked to be plain file names before anything is asked for: the app's code (untrusted)
cannot make the web page fetch another URL. Chunks a `nsh_engine::Bundle` carries (`Bundle::chunks`) are given before
the entry runs, so hosts that have them all (tests, native) never ask; `MountSink::load_chunk` defaults to refusing.

Development bundles (CommonJS, one chunk per module) need nothing: rolldown renders `import("./Screen")` as
`Promise.resolve().then(() => require("./Screen.js"))`, served by the hot runtime.

## Hot module replacement

Development bundles are compiled by the same compiler, after the bundler's hot transform (`crates/nsh-bundler/src/hot.rs`)
has wrapped the components, the functions passed to top-level `mount()` and the top-level `context()`, `signal()` and
`createNavStack()` calls, one CommonJS chunk per module, and run by the native hot
runtime (`crates/nsh-js/src/hot.rs`, see `tooling.md`). The script is an ES module: it imports `nsh:hot` (which makes the
`__nsh_hot` global; only development bundles import it) and the namespaces of the native modules the app imports, which
factories `require` by specifier; an edit that imports a native module the running script did not makes the host
reload.
