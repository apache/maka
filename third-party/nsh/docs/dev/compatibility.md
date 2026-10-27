# Backward compatibility

NSH runs apps it did not build: host apps download signed packages and run them as plugins, and an app that shipped
may never be built again (its team moved on, its source is frozen in a business process, the host app updated NSH
without asking). So every release of NSH runs every app built for an earlier one, unchanged. An app that stops
starting after an NSH update is a bug in NSH, never in the app.

This page is the contract and how it is enforced. It holds from the first release recorded in
`nsh-compat` ("Releasing") on, and for good, whatever the version number says; earlier versions made no promises.
No release is recorded yet, 0.3.0 included: the first one recorded starts the contract.

## What apps depend on

| Surface | Where it is | Why it matters |
|---|---|---|
| The exports of every module (`nsh`, `nsh/*`, `nsh/base`) and their members | `crates/nsh-js` (`modules.rs` and the tables it lists), `crates/nsh-base` | a bundle imports them by name: one missing name and the module fails to link, so the app never starts |
| `nsh:rt`, what compiled JSX calls (`element`, `prop`, `insert`, ...) | `crates/nsh-js/src/dom.rs` (`RT_EXPORTS`) | bundles carry the output of the compiler that built them, so every function any compiler ever emitted keeps its name, its arguments and what it does |
| The globals (web APIs, timers, `console`) and their members | `crates/nsh-js` (`host.rs`, `web/`) | as above |
| Host element props, events, style keys and their values | `crates/nsh-core/src/js/` (`Prop`, `host::EVENTS`, `style_keys!`) | bundles pass them by name; a prop renamed is silently ignored, so the app runs wrong |
| Tailwind utilities and variants | `crates/nsh-core/src/tailwind/` | resolved at run time from the class strings in the bundle |
| Behavior: defaults, units, event payloads, the order of callbacks | everywhere | an app relies on what it saw when it was written |
| The TypeScript declarations (`.nsh/types`) | generated (`crates/nsh-js/src/declarations.rs`) | an old app's source must still type-check and build when its team fixes a bug |
| The package format (`.nshpkg`) and its signatures | `crates/nsh-package` | a package signed for an earlier release still verifies; it carries its JS source, which runs when its bytecode is not this runtime's (`BYTECODE_VERSION` may change freely) |

The standard catalog also imports `buffer`, `crypto`, `path`, `url` and `zlib` from quickjs-stdlib. That project
owns their API, declarations and exhaustive compatibility tests, including its `Buffer` and cryptography globals.
NSH keeps the catalog, native integration, capability checks and resource limits under local tests; `nsh-compat` records
NSH-owned declarations and behavior rather than copying the upstream API into its fixture coverage requirements.

## The rules

They hold for what a compatible release shipped (its record in `nsh-compat`, below), from that release on and for
good, whatever the version number says. Between releases, and before the first compatible release, what is only on
`main` may still change.

1. **Nothing a release shipped is removed or renamed**: no module, export, member, prop, event, payload key, style key
   or value, Tailwind utility, global or `nsh:rt` function. Removing something wrong-headed is not a reason either: it
   is deprecated (rule 2) and stays.
2. **A rename adds the new name and keeps the old one** as an alias of the same implementation (the same function or
   class object at run time), declared `@deprecated` with the new name, and kept for good. The same goes for moving an
   export between modules: the old module keeps exporting it.
3. **Types only widen.** A union gains alternatives, a function gains overloads or trailing optional parameters, a
   parameter becomes optional, a prop accepts more values, a function or method that returned `void` returns a value
   (a callback an app passes in keeps returning `void`). Nothing else narrows or changes a return type, and what apps
   pass in (props, styles, options, configs) gains optional members only. Parameter names are not part of a type:
   TypeScript compares function types by structure, so `(data: number) => void` and `(value: number) => void` are one
   type, and a function, method or callback may rename its parameters; their count, optionality and types may not
   change.
4. **Behavior is kept.** Defaults, units, coordinate spaces, the payload of an event and when it fires stay as they
   were. New behavior is opt-in, through a new prop, option or value. A bug fix that changes what a working app sees
   is a behavior change: fix it behind an opt-in, or make sure no app can rely on the old result.
5. **`nsh:rt` is append-only.** The JSX compiler may start emitting new functions; the ones it emitted before keep
   their signatures and semantics, because bundles built by older compilers call them as those compilers did.
6. **Formats are read forever.** Readers of packages, certificates, revocation lists and `app.json` accept every
   format an earlier release wrote. New fields are optional. The other direction holds for packages too: a runtime
   ignores the header fields, files and capabilities a later release added (never granting what it does not know),
   unless the header's `critical` names them, so a package published with a lower minimum runtime
   (`nsh publish --min-runtime`) runs on the older runtimes it names ("Format evolution" in `nsh-package`).
7. **The only exception is security**: a capability that cannot be kept safe may be closed. A pull request of
   `nsh-compat` adds what it removes to that repository's `closed.txt`, each with its reason (`<entry> -- <reason>`,
   the entry as the checks report the break: `[<module>] <path>`, `<file>: <Name>`, `<file>: <Name>.<member>` or
   `tailwind <class>`), and the release notes say why. It is the only list of removals there will ever be.

## How it is enforced

What is frozen lives in a repository of its own, [`longbridge/nsh-compat`](https://github.com/longbridge/nsh-compat),
not next to the code: a change to NSH cannot rename an API and rewrite the record of it in the same pull request.
`nsh-compat` holds:

```
nsh-compat/
  releases/v<version>/    one per compatible release, written when it ships and never changed:
    runtime.txt           every module's exports (`nsh:rt` included) and the globals, with their members and kinds
    types/                the declarations of `.nsh/types`
    tailwind.txt          every Tailwind class the resolver offers and what it sets, in each context
    apps/<app>/           the apps of `tests/compat/` as that release's `nsh build --release` wrote them
                          (bundle.js, assets/, app.json, capabilities.json) with their script.txt
  closed.txt              the entries closed for security (rule 7), each with its reason
  src/                    the checks: the script runner, the surface, the comparison, the coverage
```

It is a Cargo project that depends on NSH's crates at `../nsh`, the checkout under test, and uses only their public
API. Its checks:

- `checkout_apps_run`: the apps of this checkout's `tests/compat/` (below), built by its `nsh build --release`, do
  what their scripts say, and every `covers` claim of their scripts holds.
- `nothing_released_is_removed`: everything each recorded release offered is still offered, by rules 1 to 3:
  no name of its `runtime.txt` is gone or changed kind; every declaration of its `types/` is kept, the same or
  widened (`compare.rs` says exactly what counts as widening; it compares declarations with their parameters' names
  erased); every class of its `tailwind.txt` still resolves to the same line. `closed.txt` holds the only exceptions.
- `released_apps_run`: every app each recorded release built, as it was built, starts on this runtime without an
  error and does what its script says. This is what catches what names cannot: `nsh:rt`'s calling conventions,
  props and styles that still parse, behavior.

Until a release is recorded the last two have nothing to check: nothing is frozen.

`cargo xtask compat` runs them all: it clones `nsh-compat` into `target/nsh-compat/nsh-compat` (or brings it up to
date; one with changes of its own is used as it is), links this checkout as `target/nsh-compat/nsh`, builds `nsh` and
runs `nsh-compat`'s tests with this checkout's Cargo cache. The Compat workflow does the same with both repositories
checked out side by side. Its job, `compat`, is a check `main` requires, so it reports on every pull request: one
that changes nothing the checks build passes in seconds, the others run them. `nsh-compat`'s own CI runs it against NSH's `main`, so a change to
the checks is held to the code as it is. Its pull requests are reviewed by NSH's maintainers (its CODEOWNERS).

### The apps of the API being written

`tests/compat/` holds the apps whose scripts check the API, and changes with it, as any test does:

```
tests/compat/
  cases/<domain>/         an app per domain, App.tsx with a module per case, nsh.json, script.txt
  examples/<app>.txt      the script of examples/<app> (counter, desktop, gallery, hopper)
```

The cases are grouped by domain (`base`, `core`, `events`, `layout`, `paint`, `props`, `modules`, `web`), one app
each. The domain's `App.tsx` imports every case and shows one at a time: the script taps `id:case-<case>` (one of the
one-point views over the top left corner, out of the layout) and checks that case, then the next. What applies to a
whole app has a domain of its own: the platform (`android`; `macos`, which also declares capabilities; `browser`, a
desktop browser with the user's text size at 2) and `nsh.json`'s settings (the `layout` domain's theme spacing, the
`base` domain's status bar). A case goes where its platform and settings are, and where they change nothing its
neighbors check. An app whose `nsh.json` declares `capabilities` runs with the `capabilities.json` and `app.json` its
build wrote and a new, empty data directory, so a script checks what a grant allows and what stays refused (the
`macos` domain's files case).

A new API comes with its case: a module `tests/compat/cases/<domain>/<case>.tsx` whose default export is a component
that uses it and shows its result, added to the domain's `App.tsx`, and steps in the domain's `script.txt` after
`tap id:case-<case>` that check the result, with a `covers <item>` step for each part. A rename before the API is
released renames it in the cases and scripts too.

### Releasing

`cargo xtask compat record <version>` records this checkout as a release in its checkout of `nsh-compat`
(`releases/v<version>/`): the surface, and every app of `tests/compat/` built by it with its script. It refuses an
existing record, an app whose script fails, a `covers` claim that does not hold and any part of the API no script
checks (`[<module>] <name>`, `[globals] <name>`, `[props] <name>`, `[events] <name>`, `[styles] <name>`; a
component's own props and events as `[props] <Component>.<name>`, `[events] <Component>.<name>`; platform props as
`ios.<name>`, ...). Commit the record in `nsh-compat` and open a pull request there; once it is merged, the release
is frozen. The first release recorded starts the contract.

Before the first record, two things land in NSH:

- **Stability.** An item is stable or experimental, marked where it is declared (the export's spec, `#[prop]`,
  `style_keys!`, a component's derives); declarations say `@experimental`, the bundler warns when an app uses one and
  `nsh publish` refuses it unless the app opts in, binding the package to the runtime it was built for. A release
  freezes only stable items, and only they must be covered.
- **The target.** The compiler emits the release an app was built for into its bundle (a `target` call of `nsh:rt`),
  the runtime keeps it per VM, and a behavior change applies to apps built for the release that makes it, so rule 4
  no longer forces every change behind an opt-in. A bundle without it is the first compatible release's.

### A claim is verified

A script claims the parts it checks with `covers <item>` steps, and each claim is verified: the bundle uses the item
(for a component's, the component and the name), and for props, events and style keys, renaming the item in the
bundle makes a check step of the script fail (or, for a prop the component requires, makes the app fail). For
exports and globals only the use can be verified: the claim is the author's word that a step checks the result.

### Scripts

`script.txt` is one step per line (`nsh-compat`'s `apps.rs` has the full list): `expect <text>` waits for a text on
screen, `absent <text>` checks one is gone, `tap id:<testID>` / `label:<label>` / `text:<text>` presses a view (or its
nearest pressable ancestor; `span:<text>` the link or pressable span where `<text>` starts; `parent:<selector>` the
view around the one it names, a component's popup by the app's content in it, and `below:<selector>` its sibling
below it, a popup's backdrop), `wait <ms>` runs timers, and `viewport <w> <h>` and `platform <os>` (first) size the
screen and pick the platform whose `ios={{…}}` / `android={{…}}` / `desktop={{…}}` / `web={{…}}` props apply, and
`fontscale <scale>` sets the user's text size. What a view looks like is checked as the platform receives it:
`frame <selector> <x> <y> <width> <height>` (its layout, in points relative to its parent), `prop` / `noprop` (a host
prop), `style` / `nostyle` (a paint or text style key), `listens` (an event the platform reports),
`statusbar <key>=<value>...` (the status bar the platform was last told to show: `foreground`, `hidden`, `animated`);
`log <text>` checks a `console` line, and `covers <item>` is a claim, not a step. Other steps stand in for the
platform's input: `event <selector> <onEvent> [<key>=<value>...]` reports an event with its payload keys as the
handler reads them (`event id:video onProgress currentTime=3.25 duration=12.5`), `touch start <selector> <x> <y>` /
`touch move|end|cancel [<x> <y>]` move one finger through the touch handlers and the responder system,
`type <selector> <text>` types into an input (`onKeyPress`, `onChange` and `onSelectionChange` per character),
`key <selector> <key>` presses a key, `scroll <selector> <x> <y>` scrolls a scroll view (`onScroll`),
`keyboard <height> <duration>` shows the software keyboard (at height 0, hides it), `pixelratio <ratio>` moves the
surface to a screen of that pixel ratio (1 at the start) as a window moved to another screen does, and
`state <selector> pressed|hovered|focused|none...` reports a view's interaction states as a platform does
(`activeStyle`, `hover:`, ...), failing when the core did not ask the platform to track them. Props and style keys
are named and written as apps write them (`style id:card backgroundColor #3366ffff`,
`prop id:field ios.keyboardAppearance dark`), in the stable text forms `nsh-compat`'s `values.rs` defines, never from
the core's types, so the scripts stay valid while those change. A script should open every screen of its app and
check what its app offers. `NSH_COMPAT_APP=<name>` runs one app, `NSH_COMPAT_DUMP=1` prints the texts each step adds
and removes:

```sh
NSH_COMPAT_APP=paint NSH_COMPAT_DUMP=1 cargo xtask compat -v
```

## What the checks do not see

They hold the names, the declarations, the Tailwind classes and what the scripts check. They cannot prove that a
behavior no script checks is unchanged, or that a platform backend draws the same: rules 4 and 6 are also the
reviewer's job. A pull request that changes behavior apps can see says so, and every behavior worth keeping gets a
step in a script.

The host side (the iOS and Android SDKs, `nsh.h`, `AppView`) is the host app's API, rebuilt with each NSH update; it
follows the crates' versions and is outside these records.
