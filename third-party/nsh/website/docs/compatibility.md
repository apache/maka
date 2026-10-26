---
title: Backward Compatibility
description: "How Native Shell keeps apps running across releases: what a compatible release promises, the record in nsh-compat that holds every change to it, the release flow, and how to add, rename or change an API."
order: 22
group: delivery
---

# Backward Compatibility

Host apps download NSH apps as [signed packages](./signed-packages.md) and run them as plugins, and an app that
shipped may never be built again: its team moved on, its source sits in a business process, the host app updated
NSH on its own schedule. So Native Shell keeps a promise to every app: **an app built for a compatible release runs
on every later release, unchanged.** An app that stops working after an NSH update is a bug in NSH.

This page describes the promise, how it is enforced, and how to change NSH within it.

## What an app can rely on

The promise covers everything a built app touches:

| Part | Why it matters |
| --- | --- |
| The exports of every module (`nsh`, `nsh/*`, `nsh/base`, the standard modules) and their members | A bundle imports them by name: a missing name and the app does not start. |
| `nsh:rt`, the functions compiled JSX calls | Each bundle carries the output of the compiler that built it. |
| The globals (timers, `fetch`, `console`, ...) and their members | Apps call them by name. |
| Element props, events and their payloads, style keys and their values | Apps pass them by name; a renamed prop is ignored, so the app runs wrong. |
| Tailwind utilities and variants | Classes are resolved at run time from the strings in the bundle. |
| Behavior: defaults, units, payloads, the order of callbacks | An app relies on what it saw when it was written. |
| The TypeScript declarations (`.nsh/types`) | An old app's source still type-checks when its team fixes a bug. |
| The package format and its signatures | A package signed for an earlier release still verifies. |

The rules that keep it:

1. **What a release shipped stays.** No module, export, member, prop, event, payload key, style key or value,
   Tailwind utility, global or `nsh:rt` function goes away.
2. **A rename keeps the old name** as an alias of the same implementation, marked `@deprecated` with the new name,
   for good. Moving an export to another module keeps it in the old one too.
3. **Types only widen.** A union gains alternatives, a function gains overloads or trailing optional parameters, a
   parameter becomes optional; what apps pass in (props, styles, options) gains optional members only.
4. **Behavior is kept.** New behavior is opt-in, through a new prop, option or value.
5. **`nsh:rt` only grows**, each function keeping its signature and meaning.
6. **Formats are read forever.** Packages, certificates, revocation lists and `app.json` of earlier releases are read
   by later ones; a package names the lowest runtime it needs (`nsh publish --min-runtime`).
7. **Security is the one exception.** A capability that cannot be kept safe is closed, listed with its reason and
   named in the release notes.

The promise starts at the first release recorded as compatible and holds for good, whatever the version number
says. Between releases, an API that only `main` has may still change.

## How it is enforced

What releases froze lives in its own repository,
[longbridge/nsh-compat](https://github.com/longbridge/nsh-compat), apart from NSH's code. A change to NSH runs
against it and cannot edit it: a pull request that renames an API cannot also rewrite the record of that API.

```
nsh                                       nsh-compat
├─ crates/          the code              ├─ releases/v<version>/   one per compatible release, never changed
└─ tests/compat/    apps that test the    │  ├─ runtime.txt         every export, global and nsh:rt function
   ├─ cases/        API being written     │  ├─ types/              the declarations apps build against
   └─ examples/                           │  ├─ tailwind.txt        every Tailwind class and what it sets
                                          │  └─ apps/               the test apps as that release built them
                                          ├─ closed.txt             security closures, each with its reason
                                          └─ src/                   the checks
```

Every pull request to NSH runs the checks of `nsh-compat` against its checkout (the **Compat** workflow, or
`cargo xtask compat` locally):

| Check | What passes |
| --- | --- |
| `checkout_apps_run` | The apps of `tests/compat/`, built by this checkout, do what their scripts say, and every part of the API a script claims to check is really checked. |
| `nothing_released_is_removed` | Everything each recorded release offered (exports, members and their kinds, declarations, Tailwind classes and what they set) is still offered, the same or widened. |
| `released_apps_run` | The apps each recorded release built, as its compiler built them, start on this runtime and do what their scripts say. |

The first check tests the API being written; the other two hold every release that was recorded. A rename of a
released API fails like this:

```
v0.2.0: runtime [nsh] Platform: removed
Keep it: a rename keeps the old name as a @deprecated alias of the new one, a type only widens.
```

`nsh-compat` is reviewed by NSH's maintainers, and its own CI runs it against NSH's `main`.

## The release flow

1. **Develop.** An API lands on `main` with a case in `tests/compat/` whose script checks it. Until a release records
   it, it may be renamed or reshaped; the case changes with it.
2. **Record.** At a release, `cargo xtask compat record <version>` writes `releases/v<version>/` into a checkout of
   `nsh-compat`: the surface the release offers and every app of `tests/compat/` built by its compiler, with their
   scripts. It records only an API whose every part a script checks.
3. **Freeze.** The record is merged through a pull request of `nsh-compat`. From then on every NSH change is held to
   it, together with every earlier record.

## Developing within the promise

### Adding an API

Every new export, global, prop, event or style key comes with a case:

1. Write a module `tests/compat/cases/<domain>/<case>.tsx` whose default export is a component that uses the API and
   shows its result. The domains are `base`, `core`, `events`, `layout`, `paint`, `props`, `modules` and `web`, plus
   `android`, `macos` and `browser` for what one platform or one `nsh.json` setting decides.
2. Add it to the domain's `App.tsx`, which shows one case at a time.
3. Append the steps to the domain's `script.txt`: `tap id:case-<case>`, then the steps that check what the API does,
   and a `covers <item>` step for each part it adds.
4. Run `cargo xtask compat` (`NSH_COMPAT_APP=<domain>` runs one domain).

```txt
# props-media-video
tap id:case-props-media-video
prop id:clip src https://example.com/clip.mp4
prop id:clip paused true
tap id:play
prop id:clip paused false
covers [props] src
covers [props] paused
```

A `covers` step is verified: the app must use the item, and for a prop, event or style key, taking it out of the
built app must make a step of the script fail. Items are named `[<module>] <export>`, `[globals] <name>`,
`[props] <name>`, `[events] <name>`, `[styles] <name>`, a component's own as `[props] <Component>.<name>`, and a
platform's props as `ios.<name>`, `android.<name>`, `desktop.<name>`, `web.<name>`.

### Renaming or moving an API

Add the new name and keep the old one as an alias of the same implementation, declared `@deprecated` with the new
name. Update the case and its script to the new name. An API no release recorded yet is simply renamed.

### Changing a type

Widen it: more alternatives in a union, more overloads, trailing optional parameters, optional new members of what
apps pass in. Parameter names are free to change; their count, optionality and types stay.

### Changing behavior

Keep the old behavior and add the new one behind a new prop, option or value. A bug fix that changes what a working
app sees is a behavior change too: put it behind an opt-in, or make sure no app can rely on the old result. Give the
behavior a step in a case, so it stays as it is.

### Changing the compiler

Nothing extra: the apps of each release stay as that release's compiler built them, and the cases are built fresh by
yours. The functions it emits into bundles (`nsh:rt`) only grow.

### Closing an API for security

A pull request of `nsh-compat` adds the entry to its `closed.txt` with the reason (`<entry> -- <reason>`, the entry
as the check reports it), and lands first; the NSH change that removes the API then passes. The release notes say
why.

## Scripts

A `script.txt` is one step per line. Steps that act: `tap <selector>`, `type <selector> <text>`,
`key <selector> <key>`, `scroll <selector> <x> <y>`, `touch start|move|end|cancel`, `event <selector> <onEvent>
[<key>=<value>...]`, `wait <ms>`, `keyboard <height> <duration>`, `pixelratio <ratio>`. Steps that check:
`expect <text>`, `absent <text>`, `frame <selector> <x> <y> <width> <height>`, `origin`, `prop` / `noprop`,
`style` / `nostyle`, `listens`, `state`, `statusbar`, `log <text>`. First lines may set the screen: `viewport <w> <h>`,
`platform <os> [desktop]`, `fontscale <scale>`. A selector is `id:<testID>`, `label:<label>`, `text:<text>` or
`span:<text>`; props and styles are written as apps write them (`style id:card backgroundColor #3366ffff`).
`NSH_COMPAT_DUMP=1` prints what each step adds to and removes from the screen, for writing a script.

## Commands

```sh
cargo xtask compat                      # the checks against this checkout
NSH_COMPAT_APP=props cargo xtask compat -v
cargo xtask compat record 0.2.0         # at a release: record it in nsh-compat, then open a pull request there
```

`cargo xtask compat` keeps a checkout of `nsh-compat` in `target/nsh-compat/` and brings it up to date on each run;
one with changes of its own is used as it is, so a change to the checks can be tried against NSH before its pull
request.
