---
title: Project structure
description: The files of an NSH app in TSX or Rust, every key of nsh.json, the TypeScript setup in .nsh/types, assets, and how modules and packages are imported.
order: 5
group: start
---

# Project structure

An NSH app is a directory with an `nsh.json` and its code: a TSX entry module, with Rust crates in `ext/` when it has any, or a Rust crate whose root component `nsh.json` names. Everything else (more modules, images, fonts, JSON files) is found from there: the files the TSX entry imports, or a crate's modules and its `assets/` directory, so there is no file list to maintain.

A TSX app is an entry and the modules it imports:

```text
my-app/
├── App.tsx            the entry module: calls mount()
├── App.test.tsx       its tests (nsh test)
├── nsh.json           name, id, version, icon, Tailwind theme, capabilities
├── tsconfig.json      TypeScript settings for editors
├── .gitignore         .nsh/ and target/
├── src/               your own modules (any layout you like)
│   └── Header.tsx
├── ext/               the app's Rust, when it has any: one nshm crate per directory (nshm)
├── assets/
│   ├── logo@2x.png    imported images
│   └── Inter.ttf      imported fonts
├── locales/           translations, rust-i18n's files: t("hello") (I18n)
└── .nsh/              generated: type declarations, development host builds, test entries, build output (.nsh/out)
```

An app written entirely in Rust is a Cargo project:

```text
my-app/
├── nsh.json           name, id, version, icon, the crate ("rust") and its root component ("root"), theme
├── Cargo.toml         the crate: nsh-core, nsh-base and your dependencies
├── src/
│   ├── lib.rs         the root component and the crate's UI set (#[native_module])
│   ├── main.rs        cargo run: the root on this machine's desktop backend
│   └── screens/       your own modules (any layout you like)
├── assets/            files the crate ships: asset!("logo@2x.png"), fonts
├── locales/           translations, rust-i18n's files: t!("hello") (I18n)
├── .gitignore         .nsh/ and target/
├── .nsh/              generated: the runners' sources, test entries, build output (.nsh/out)
└── target/            Cargo's build directory
```

A TSX app extends itself with Rust through nshm crates of its own in `ext/`, listed in `"dependencies"` by path ([An app's own Rust: ext/](./nshm.md#an-apps-own-rust-ext)); `src/` holds its TSX, `ext/` its Rust. A Rust app can also list its crates in `"rust"` and add a TSX entry that imports them ([Building with Rust](./rust.md#extending-a-rust-app-with-tsx)).

Every command takes the app's directory or its entry as its argument (`nsh run my-app`, `nsh run my-app/App.tsx`). The directory of `nsh.json` is the app's root: `nsh.json` is read from there, the paths it names and asset paths are relative to it, and `.nsh/` is written there. The entry is `App.tsx` beside it, unless `nsh.json` names another with `"entry"`. In a Rust app (`nsh.json` `"root"`), the directory runs the root component; naming a TSX entry runs that instead.

### An app in a larger project

A project that also has other code, a server or a website, can keep `nsh.json` at its root, beside `package.json` or `Cargo.toml`, and its app's code in a directory of its own, which `"entry"` names:

```text
my-project/
├── nsh.json           { "name": "…", "entry": "app/App.tsx", "theme": "app/theme.json", … }
├── package.json       the server's
├── server/
└── app/
    ├── App.tsx        the entry
    ├── App.test.tsx   its tests
    ├── tsconfig.json  TypeScript settings for the app's modules
    └── theme.json
```

`nsh run`, `nsh test` and the other commands then work from the project's root as from an app's directory: the root is the app's root (`.nsh/`, `locales/` and the paths `nsh.json` names, such as `theme`, `icon` and `web.host`, are relative to it), while `nsh test` looks for test files in the entry's directory (`app/`, not the server's tests), and `nsh check` and `.nsh/types` follow the entry's `tsconfig.json`.

## The root component

A TSX entry is a normal module that ends by rendering the root component. A Rust app's root is a component of its crate, which `nsh.json`'s `"root"` names by its path in the crate (`App`, `shell::Gallery`):

```tsx tabs
// App.tsx
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Home } from "./components/Home";

function App() {
  return <Home />;
}

mount(() => <Window id="main"><App /></Window>);
```

```rust tabs
// src/lib.rs; nsh.json: { "rust": ".", "root": "App" }
mod screens;

use nsh_core::{element::desktop::window as app_window, prelude::*};

/// What a TSX entry may import from the crate.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>().assets(assets!());
}

#[component]
pub fn App() -> impl IntoElement {
    // On the desktops this is the app's window; off them it shows its content.
    app_window().id("main").content(screens::home)
}
```

In TSX, `mount(component, props?)` renders the component into the app root and returns a function that removes it again; an app calls it once. On the desktops the root holds top-level `<Window>` scenes (an app that declares windows declares the first too; a plain root renders in the implicit first window); off the desktops `<Window>` shows its content in the one surface. Code at the top level of the entry runs when the bundle loads, before the first frame. `nsh run` and `nsh package` mount a Rust root on every platform, with no QuickJS.

## nsh.json

`nsh.json` sits in the app's root. `nsh init` writes `name`, `id`, `version` and `build`, and for a Rust app the crate and its root component:

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "rust": ".",
  "root": "App",
  "theme": "theme.json"
}
```

Every other key is optional; a TSX app may also leave out the four. A TSX app's `nsh.json` might read:

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "icon": "icon.png",
  "tailwind": {
    "colors": { "brand": { "500": "#7c3aed", "600": "#6d28d9" } },
    "radius": { "card": 14 }
  },
  "capabilities": {
    "network": { "hosts": ["api.example.com", "*.cdn.example.com"] }
  }
}
```

| Key | Type | Used by | Description |
|---|---|---|---|
| `name` | string | `package` | The display name under the app icon. Default: the name of `nsh.json`'s directory. |
| `entry` | string | every command | The TSX entry module, relative to `nsh.json` and inside its directory, e.g. `"app/App.tsx"` ([An app in a larger project](#an-app-in-a-larger-project)). Default: `App.tsx` beside `nsh.json`. An entry named on the command line (`nsh run app/Other.tsx`) takes precedence. |
| `id` | string | `package`, `publish`, `Storage` | Bundle identifier / application id in reverse-DNS form, e.g. `com.yourcompany.app`; required by `package` and `publish`. `nsh run` uses `com.example.<name>` without one. |
| `version` | string | `package`, `publish` | The user-visible version, e.g. `1.2.0` (`CFBundleShortVersionString`, Android `versionName`). |
| `build` | number | `package`, `publish` | The build number (`CFBundleVersion`, Android `versionCode`). Signed packages require it to grow with every release. |
| `nsh` | string | every command | The NSH versions the app is written for, as a Cargo-style requirement, e.g. `">=0.5"` or `">=0.5, <0.7"`. Every command that takes the app checks the CLI against it first and stops with one message, `this app requires nsh >=0.5; this is nsh 0.4.0`, instead of type or build errors from the other version. A nightly counts as its release. |
| `minRuntime` | string | `publish` | The lowest NSH runtime that runs the signed package, e.g. `0.2.0`. Default: the CLI's version ([Signed packages](./signed-packages.md#which-runtimes-run-a-package)). |
| `schemes` | string[] | `package`, `run` | URL schemes that open the app, e.g. `["myapp"]` for `myapp://…` links, which reach [`UrlScheme`](../modules/nsh.md#urlscheme). Lowercase letters, digits, `+`, `-` and `.`; not one the system or browser owns (`https`, `file`, …). |
| `links` | object[] | `package`, `run` | Web links that open the app (Universal Links, App Links): `[{ "host": "example.com", "paths": ["/orders/*"] }]`, `host` a domain name or `*.` and one for its subdomains, `paths` whole paths or starts ending in `*` (none: every path). Their `https` links reach [`UrlScheme`](../modules/nsh.md#web-links) as a scheme's do. iOS packages claim the hosts in their associated domains entitlement, Android packages in a verified intent filter per link. |
| `fileTypes` | object[] | `package`, `run` | The file types the app opens, `[{ "name": "Video", "extensions": ["mp4"], "mimeTypes": ["video/mp4"] }]`, which packages declare to the system (on Android, through `mimeTypes`, in the share sheet); the files reach [`Application.on("openFiles")`](../modules/nsh-desktop.md#opening-files). |
| `handoff` | boolean | `package` | `true`: on iOS and macOS the address the app sets with [`UrlScheme.setUrl`](../modules/nsh.md#handoff) goes to the system, so Handoff continues it on the user's other devices; packages declare its activity type, `<id>.url`, in `NSUserActivityTypes`. |
| `singleInstance` | boolean | `package` | `true`: the app runs once on Windows and Linux; a second launch hands its arguments and working directory to the running app and exits ([Single instance](../modules/nsh-desktop.md#single-instance)). |
| `logDir` | string | `package` | The directory a packaged desktop app (macOS, Windows, Linux) writes its log files (`app.log`, `app.1.log`, ...) in, and the directory `log_file()` and `process.logFile` point into. Spelled like `dataDir`: an absolute path or `"${homeDir}/.myapp/logs/ui"` (no `..`, no other `${...}`); NSH warns about and ignores any other value. Unset, the logs are in `logs` in the data directory (`dataDir`, or the app's id in the system's directory for apps' data); with `logDir` set, that `logs` directory is not created. iOS, Android, the web and embedded apps have no log file and ignore it. |
| `dataDir` | string | `package` | The app's data directory on the desktop (macOS, Windows, Linux): its storage (`nsh/storage`), logs, `process.dataDir` and the files of `${dataDir}` live there. An absolute path or `"${homeDir}/.myapp"` (no `..`, no other `${...}`); NSH warns about and ignores any other value. Unset, it is the app's id in the system's directory for apps' data: `~/Library/Application Support/<id>` on macOS, `%APPDATA%\<id>` on Windows, `$XDG_DATA_HOME/<id>` (`~/.local/share/<id>`) on Linux. A directory set here stays the same when the app's id changes. Caches and downloaded updates keep their own places; iOS, Android, the web and embedded apps use the platform's directory. |
| `features` | string[] | `package` | Native features the release runner always keeps (built locally when the app has Rust crates, or packages for this machine's OS with `cargo` installed), e.g. `["plot"]`: those only its Rust code or a computed import needs. `package` otherwise leaves out the ones its bundle never reaches (`shader`, `editor`, `plot`, …) and prints why. |
| `icon` | string \| object | `package`, `run` | A square PNG, ideally 1024×1024, relative to `nsh.json`, or one per platform (`{ "macos": "…", "windows": "…" }`, [Packaging](./packaging.md#icons)). Android's may be an adaptive icon (`{ "foreground": "…", "background": "…", "monochrome": "…" }`, [Packaging](./packaging.md#icons)). |
| `tailwind` | object | every build | Extends the Tailwind theme your `class` strings resolve against ([Tailwind](./tailwind.md#theme)). |
| `appearance` | string | every build, `package` | `"light"`, `"dark"` or `"system"` (the default): an app that is always light or dark says so here. `colorScheme()`, `dark:` classes, the components' theme and the platform's controls follow it from the start ([Device and environment](./device-and-environment.md#dark-mode)). |
| `locales` | string[] | every build | The languages the app formats numbers and dates in besides English (`["de", "zh-CN"]`), whose data its bundle carries. Default: the languages of its translations in `locales/` ([I18n](./i18n.md#numbers-and-dates)). |
| `timeZones` | string[] | every build | The named time zones `Intl` formats in besides the device's, `UTC` and offsets (`["America/New_York"]`), whose rules its bundle carries. Default: none ([Time zones](./i18n.md#time-zones)). |
| `theme` | string or object | every build | The app's design tokens (shadcn/ui's `cssVars`, over the default `neutral` theme), which token classes, `token()` and Rust components draw with: a theme file's path relative to `nsh.json`, or the theme inline ([Building with Rust](./rust.md#theme), [Theme tokens](./tailwind.md#theme-tokens)). |
| `statusBar` | object | every build, `package` | The status bar's default under every page and dialog (iOS and Android): `{ "foreground": "auto" \| "light" \| "dark", "hidden": boolean }`, both optional. Packaged iOS apps show it from the launch screen on ([Status bar](../modules/nsh-base.md#status-bar)). |
| `capabilities` | object | every build | What the app may reach outside its VM: network hosts, web view hosts, the status bar, windows of its own ([Sandbox and capabilities](./sandbox-and-capabilities.md)). |
| `window` | object | every build, `package` | Launch settings for the first window the app declares on the desktops, which it has from its first frame: `title`, `defaultSize`, `minSize`, `titleBar`, `backdrop` and the other options and attributes of a window, as `nsh/desktop`'s `WindowOptions` spells them (`{ "defaultSize": { "width": 1100, "height": 720 }, "titleBar": { "style": "hidden" } }`) ([The app host and the first window](../modules/nsh-desktop.md#the-app-host-and-the-first-window)). `defaultVisible` no longer applies: the app host never shows; an app that starts without a window opens none. |
| `application` | object | every build, `package` | The app's lifecycle: `"quitMode": "platform" \| "lastWindowClosed" \| "explicit"`. `"platform"` (the default for `<Window>` apps) keeps a macOS app running with no windows and quits Windows and Linux apps when the last window closes; `"lastWindowClosed"` quits on every platform; `"explicit"` leaves the app running with no windows. A plain `mount(App)` app's implicit main window quits on every platform when closed unless `quitMode` is explicitly set here or with `Application.setQuitMode` ([Quitting](../modules/nsh-desktop.md#quitting)). |
| `resolve` | object | every build | How bare imports resolve: the export conditions of npm packages and aliases ([npm packages](#npm-packages)). |
| `rust` | string or string[] | every command | The app's Rust crate, or a list of them, relative to `nsh.json`: their components and modules, which TSX imports by each crate's `#[native_module]` specifier ([Building with Rust](./rust.md#several-crates)). |
| `dependencies` | object | every command | The [nshm](./nshm.md) the app uses, by package name, which `nsh add` lists here and NSH pins in `nsh.lock`: a version requirement from crates.io (`"acme-gauge": "^1.0"`), or an object with `"github"`, `"git"` or `"path"`, optional `"version"`, `"tag"` or `"rev"`, `"features"`, the Cargo features of a Rust nshm to turn on (`"nsh-extra": { "version": "^0.6", "features": ["camera"] }`), and `"targets"`, the targets a Rust nshm is linked for by `platform.os` name (default: every target; [nshm](./nshm.md#using-an-nshm)) ([CLI: nsh add](./cli.md#nsh-add)). |
| `web` | object | `package` | What a web package adds to its page. `web.host`: a JS module relative to `nsh.json` exporting `createHost(player)`, which answers the app's [`host`](../modules/nsh.md#host) calls; `web.connect`: the hosts that module's own requests reach, as patterns of `capabilities.network.hosts`, which the page's Content-Security-Policy allows ([Web](./web.md#the-hosts-functions)); `web.base`: the path the site is served under (`"/apps/counter/"`), the page's `<base href>`, so that it loads at the app's own paths ([Web](./web.md#deploy-it)); `web.history`: whether pushed pages and open dialogs are browser history entries (by default when the app is the whole page, not in an iframe). |
| `updater` | object | `package` | Where the packaged app gets its updates: `{ "github": "owner/repo" }` or `{ "url": "https://…/latest.json", "publicKey": "…" }`, `publicKey` optional with `github`, and `"packages": { "roots": [...] }` for [OTA updates](./ota-updates.md) ([App Updates](./app-updates.md), [nsh/updater](../modules/nsh-updater.md#nshjson)). |
| `ios` | object | `package` | What iOS packages add: `infoPlist`, keys of the app's `Info.plist`, `infoPlistStrings`, their text in other languages, by language (`{ "zh-Hans": { "NSCameraUsageDescription": "…" } }`), which `nsh run`'s simulator host also takes ([Info.plist text in other languages](./packaging.md#infoplist-text-in-other-languages)), `entitlements`, which device builds check against the provisioning profile, `launchScreen`, the color and image the system shows while the app starts ([Launch screen](./packaging.md#launch-screen)), `extensions`, the app extensions (`.appex`) the app builds itself, which packages carry and sign ([App extensions](./packaging.md#app-extensions)), and `privacyManifest`, what the app adds to its `PrivacyInfo.xcprivacy`, which packages join with NSH's own entries ([Privacy manifest](./packaging.md#privacy-manifest)). NSH's own keys are refused ([Packaging](./packaging.md#infoplist-keys-and-entitlements)); `infoPlist`'s `MinimumOSVersion` raises the iOS version the app needs ([Minimum system version](./packaging.md#minimum-system-version)). |
| `android` | object | `package` | What Android packages set: `targetSdk`, the API level the app targets and compiles against (default 35) ([Packaging](./packaging.md#target-api-level)); `usesCleartextTraffic`, plain `http://` requests allowed (default `false`) ([Packaging](./packaging.md#plain-http)); `permissions`, the permissions the manifest declares besides NSH's own (default none) ([Packaging](./packaging.md#permissions)); `launchScreen`, the window's color and the splash screen's image while the app starts, the same keys as `ios.launchScreen` ([Launch screen](./packaging.md#launch-screen)); `libraries`, jar, Android library (`.aar`) and dex files of the Java libraries the app ships, relative to `nsh.json`, before the ones its crates list (default none) ([Packaging](./packaging.md#java-code)); `manifestPlaceholders`, the values of the `${name}` placeholders in the libraries' manifests and the app's and crates' manifest entries, which only the app sets (default none) ([Packaging](./packaging.md#java-code)); `queries` and `application`, elements the manifest's `<queries>` and `<application>` declare besides NSH's own (default none) ([Packaging](./packaging.md#components-and-queries)). |
| `macos` | object | `package`, `run`, `test` | What macOS packages add: `infoPlist`, `infoPlistStrings` and `entitlements`, as `ios`'s ([Packaging](./packaging.md#infoplist-keys-and-entitlements)), `infoPlist`'s `LSMinimumSystemVersion` raising the macOS version the app needs ([Minimum system version](./packaging.md#minimum-system-version)); `extensions`, the app extensions (`.appex`) the app builds itself, which packages carry in `Contents/PlugIns/` and sign ([macOS app extensions](./packaging.md#macos-app-extensions)); and `activationPolicy`, how the app takes part in the system's UI whichever way NSH starts it: `"regular"` (the default), with a Dock icon and the menu bar, or `"accessory"`, a menu bar app ([macOS](./macos.md#menu-bar-apps)). |
| `root` | string | `run`, `package` | A Rust app's root component, its path in the `rust` crate, the first one of a list (`App`, `shell::Gallery`): `nsh run` and `nsh package` of the app's directory mount it with no QuickJS, on every platform; `nsh run App.tsx` still runs the TSX entry ([Building with Rust](./rust.md)). |
| `watch` | object | `run`, `dev` | What the development watcher skips: `"ignore"`, directories whose file changes do not rebuild or restart the app — paths relative to `nsh.json` (`"vendor"`, `"third/jpeg-turbo"`) or absolute, for generated code and other checkouts kept inside the app's directory (the watcher already skips `.nsh`, `node_modules` and nested Git checkouts). |

The flags of `nsh package` and `nsh publish` (`--name`, `--id`, `--app-version`, `--build`, `--icon`, `--min-runtime`) override the file's values ([CLI](./cli.md)).

Every key is checked when the app is built. What NSH cannot read, a key it does not know or a value of a form it does
not know, is reported as a warning and left out, entry by entry, and the rest of the file applies. So an app written
for a newer NSH builds and runs with an older one, and a typo shows up in the build's output:

```text
warn nsh.json: tailwind: unknown key `colours`, ignored (one of a newer NSH, or a typo)
```

A capability NSH cannot read is not granted, so nothing left out ever widens what the app may do.


### capabilities

Without a `capabilities` key, an app may use the network, web views and the status bar freely: a standalone app is its developer's own. With the key, everything not listed is denied, both in development and in packaged apps:

```json
"capabilities": {
  "network": {
    "hosts": ["api.example.com", "*.cdn.example.com"],
    "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }]
  },
  "webview": { "hosts": ["*.example.com"] },
  "statusBar": true
}
```

`network` covers `fetch`, remote images and video sources; local assets are always allowed. An app that embeds NSH may grant less than an app declares. The details are in [Sandbox and capabilities](./sandbox-and-capabilities.md).

## tsconfig.json and .nsh/types

NSH does not need `node_modules`. Instead, every command that builds the app (`init`, `build`, `test`, `dev`, `run`, `package`, `publish`, `check`) writes the TypeScript declarations of everything NSH provides into `.nsh/types`, and NSH's TypeScript settings into `.nsh/tsconfig.json`. The app's `tsconfig.json` extends them:

```json
{
  "extends": "./.nsh/tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`.nsh/tsconfig.json` points the `nsh` imports and your app's crates to `.nsh/types`, includes the globals, asset and token declarations, and sets the compiler options NSH apps use (`lib`, `jsx`, `strict`, ...). NSH keeps it current: when a new version adds a library or a path, your app has it with the next build, and your `tsconfig.json` stays as you wrote it. Options you add to `tsconfig.json` apply over NSH's.

| File in `.nsh/types/nsh/` | Declares |
|---|---|
| `index.d.ts` | `nsh`: `signal`, `computed`, `effect`, `mount`, `View`, `Text`, ... and re-exports the types below |
| `types.d.ts` | Styles (`ViewStyle`, `TextStyle`, ...), every element's props and events, the refs (`ViewRef`, `InputRef`, ...: what a `ref` receives) |
| `jsx-runtime.d.ts` | The JSX runtime TypeScript resolves through `jsxImportSource` (the `JSX` namespace) |
| `globals.d.ts` | `If` and `Each`; `console`, timers, `requestAnimationFrame`, `fetch` and the other [global APIs](../modules/globals.md) |
| `assets.d.ts` | What importing an image or font gives |
| `tokens.d.ts` | `Tokens`: the app's design tokens, from its `"theme"`, which type [`token()`](../modules/nsh.md#token) |
| `mobile.d.ts`, `desktop.d.ts` | One file per module (`nsh/mobile`, `nsh/desktop`) |
| `base.d.ts` | `nsh/base` |

`lib` is `ES2023` without `DOM`: there is no `document` or `window`. The files in `.nsh` are regenerated (only when their contents change), so do not edit them and do not commit them; `.gitignore` already excludes `.nsh/`. If your editor shows `nsh` as missing after cloning a project, run any build command once, e.g. `nsh check`.

`.nsh/tsconfig.json` adds `"ESNext.Disposable"`, which declares `using` declarations and `Symbol.dispose`, which the runtime has: `using account = new Account()` frees a [Rust class](./rust.md)'s value at the end of the block. Its `jsxImportSource: "nsh"` and `jsx: "preserve"` only matter to the editor: NSH compiles JSX with its own compiler, whatever the `tsconfig.json` says. TypeScript is checked by your editor or by `nsh check`; the other commands strip types without checking them.

An app made by an earlier `nsh init` gets the new `tsconfig.json` with its next build when its own is NSH's template, unchanged; NSH prints a line saying so. A `tsconfig.json` you changed is yours: `nsh check` points out when it does not extend `./.nsh/tsconfig.json`, and you add the `extends` line and remove the options it sets.

## Modules

A Rust app's code is its crate's modules (`mod screens;`), and its dependencies come from crates.io like any crate's; NSH's own crates are `nsh-core` (the primitives, signals and typed styles, `use nsh_core::prelude::*`) and `nsh-base` (the base components and the theme).

In TSX, split the app into as many `.ts` and `.tsx` modules as you like and import them with relative paths; the extension may be left out:

```tsx
import { Header } from "./components/Header";
import { formatPrice } from "./lib/format";
import strings from "./strings.json";
```

All of them are bundled into one script. JSON files import as their parsed value.

### Leaving parts out of the binary

The platform crates turn every optional part on by default: `js`, `shader`, `editor` (with `DiffView`), `rich-editor`, `plot`, `term`, `highlight`, `math`, `emoji-picker` (`EmojiPicker`), `zlib`, `crypto`, `websocket` and `updater`, and the platform's own: `net` and `sound` on Linux, `net`, `webview` and `media` on Windows. SVG images are always included. `nsh run` and the development hosts have every part.

`nsh package` builds the release runner with only the parts the app's bundle reaches, when it builds the runner on this machine (the app has Rust crates, or it packages for this machine's OS, or for Android, with `cargo` installed), and prints why it keeps or leaves out each one. A `TextView` keeps `highlight` and `math`, since the text it shows may hold code and formulas. Linux's runner keeps sounds (`sound`, which loads GStreamer) only when the app imports `Sound`, and Windows' links Media Foundation (`media`) only when it imports `Sound` or `AudioPlayer` or shows a `Video`, so an app that plays nothing carries no media code. It cannot see what the app's Rust code uses, or what a computed `import()` loads: name those parts in [`nsh.json`'s `features`](#nshjson), e.g. `"features": ["shader"]`. A Rust crate that depends on `nsh-base` with its default features keeps `editor`, `rich-editor`, `plot`, `term` and `highlight` through Cargo; Rust code drawing a `Shader` still needs `"shader"` named, or its views draw nothing. A part `nsh-base` does not turn on by default (`math`, `emoji-picker`) goes in the crate's own dependency: `nsh-base = { version = "0.6", features = ["emoji-picker"] }`.

If you build your own executable with Cargo (embedding NSH, or your own `main`), you choose the parts yourself: set `default-features = false` on the platform crate and on `nsh-base`, since either one left at its defaults turns them back on, and name what you keep:

```toml
nsh-base = { version = "0.6", default-features = false, features = ["editor"] }
nsh-platform-macos = { version = "0.6", default-features = false, features = ["js", "editor", "highlight", "shader"] }
```

Rust that uses a part its build left out does not compile; TSX that imports one fails when it loads (`Could not find export 'Editor' in module 'nsh/base'`). Without `shader`, shader views draw nothing; without `highlight` and `math`, code and formulas show as plain text.

### Loading code on demand

`import()` of one of the app's modules returns a promise of its exports, as in a browser:

```tsx
const open = async () => {
  const { Settings } = await import("./screens/Settings");
  screen.set(() => Settings);
};
```

Apps on devices ship one bundle, so the module is already there and the promise resolves at once. A web app published split (`nsh build --split`) gets the module, and what only it uses, as a separate file that is downloaded the first time `import()` asks for it ([Web](./web.md#split-bundles)). The specifier must be a literal relative path: the bundler has to see which module is meant.

### NSH's modules

Imports of `nsh` and `nsh/...` are not bundled: the runtime provides them natively.

| Module | What it has |
|---|---|
| `nsh` | Reactivity (`signal`, `computed`, `effect`, ...), `mount`, `split`, `context`; the primitives `View`, `Text`, `Scroll`, `Image`, `List`, `Canvas`, `WebView`, `Video` (`View`'s `selectable` for text selection); safe area insets (`safeArea`, `safeAreaInsets`) and the software keyboard (`Keyboard`, `keyboardFrame`); native animations; `PanResponder`; the environment (`platform`, `windowSize`, `colorScheme`, `fontScale`, `pixelRatio`, `locale`); screen reader and reduce motion state, announcements; the clipboard, the photo picker, storage, the host channel, keyboard shortcuts; components and functions the embedding app registers ([reference](../modules/nsh.md)) |
| `nsh/base` | The unstyled foundation of an app's UI: navigation stacks and their pages (`NavStack`, `NavPage`, `createNavStack`), dialogs (`Dialog`), a press target (`Button`), a text input (`Input`) and the system's alert dialog (`AlertDialog`); pages and dialogs set the status bar (`statusBar`) ([reference](../modules/nsh-base.md)) |
| `nsh/mobile` | What iOS and Android have: `TabBar`, `InputAccessoryView` (iOS), `BackHandler` (Android) ([reference](../modules/nsh-mobile.md)) |
| `nsh/desktop` | What macOS, Windows and Linux have: windows (`Window`, `currentWindow`, `windows`), `titleBar`, `displays`, `Menu`, `Tray`, `GlobalShortcut` ([reference](../modules/nsh-desktop.md)) |
| `nsh/i18n` | The app's translations (its `locales/` files or loaded at run time) and the language it shows: `t`, `setLocale`, `availableLocales`, `addTranslations` ([I18n](./i18n.md), [reference](../modules/nsh-i18n.md)) |
| `nsh/updater` | A packaged app updates itself: `checkForUpdate`, `downloadUpdate`, `installAndRestart`, `installOnQuit` ([reference](../modules/nsh-updater.md)) |

The [modules reference](../modules/index.md) documents each one. Importing a module NSH does not have (`nsh/foo`) is a build error. So is a name your code uses that the module does not export (`import { Buton } from "nsh/base"`): the error points at the import and names the closest export (``did you mean `Button`?``). Names used only as types are checked by `nsh check`.

### npm packages

NSH needs nothing from npm, but the bundler resolves bare imports from a `node_modules` directory if you install packages with a package manager. Packages resolve their browser builds, because the runtime provides web APIs (`fetch`, streams, `URL`, `TextEncoder`, ...) and not Node's (`fs`, `Buffer`, `process`). Packages that touch the DOM do not work: there is none.

The bundler looks for `node_modules` in the directories above the importing file. An import it cannot resolve fails the build, naming the file that imports it. A TSX [nshm](./nshm.md) is installed outside the app, in `~/.nsh/nshms`, so a package it imports is not found there. Install the package in the app and point the import at the package's file with `resolve.alias`; the package's own imports then resolve from the app's `node_modules`:

```json
"resolve": { "alias": { "@internationalized/date": "./node_modules/@internationalized/date/dist/import.mjs" } }
```

An alias names a file, not a package directory, and each subpath the nshm imports needs its own entry.

A package whose browser build uses the DOM often has another build for workers or React Native. `resolve.conditions` picks the export conditions packages resolve with, in place of the default `["browser"]`: `import`, `require`, `module` and `default` always apply, and without `browser` packages resolve through their `module` and `main` fields. `resolve.alias` replaces an import: by a path relative to `nsh.json` (`./` or `../`), another package, or `false` for an empty module. TypeScript (`nsh check`, editors) types the import as written: a name that is not an installed package gets its types from a `.d.ts` file of the app.

```json
"resolve": {
  "conditions": ["worker"],
  "alias": { "dom-only-helper": "./shims/helper.ts", "node-polyfill": false }
}
```

```ts
// shims/aliases.d.ts
declare module "node-polyfill";
```

`solid-js` cannot be imported: the bundler refuses it and points to `nsh`'s own `signal`, `computed` and `effect`, which replace it.

## Assets

Images and fonts ship with the app. A Rust crate reads each file of its `assets/` directory at compile time with `asset!`, and ships them all with `registry.assets(assets!())` in its `#[native_module]` function; TSX imports them like modules, and the bundler records each imported file (and an image's pixel-density variants). `nsh build` copies them to `.nsh/out/assets/`, `nsh package` puts them in the app, and during development they are served to the app.

```tsx tabs
import { Image, Text } from "nsh";
import logo from "./assets/logo@2x.png";   // { url: "asset:/assets/logo@2x.png", size: { width: 64, height: 64 } }
import Inter from "./assets/Inter.ttf";     // "Inter"

<Image src={logo} />
<Text style={{ fontFamily: Inter }}>Hello</Text>
```

```rust tabs
use nsh_core::element::{FontAsset, ImageAsset, asset};

const LOGO: ImageAsset = asset!("logo@2x.png");      // its url, and its size: 64×64 points
const INTER: FontAsset = asset!("Inter.ttf");        // its uri, and its family: "Inter"

image(LOGO)
text("Hello").font_family(INTER.family)
```

| Extension | Import gives |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic` | An `ImageAsset`: `{ url, size, scales? }`, sized in points. An `@2x` / `@3x` suffix divides the pixel size by 2 / 3. A file without a suffix also ships its `@1.5x`–`@4x` siblings, listed in `scales`, and the screen's variant is loaded ([pixel densities](./images-and-assets.md#pixel-densities)). |
| `.svg` | An `ImageAsset` sized in points by the SVG's `width` and `height` (or `viewBox`). |
| `.ttf`, `.otf`, `.woff`, `.woff2` | The font's family name, a string. The font is registered before the first frame. |
| `.json` | The parsed JSON |

See [Images and assets](./images-and-assets.md) and [Fonts](./fonts.md).

## Generated directories

- **`.nsh/`**: everything NSH generates: the type declarations (`.nsh/types`), the sources of a Rust app's runners (`.nsh/rust`), what `nsh run` installs on simulators and devices (the Catalyst host app, the Android development APK), and `.nsh/out`, the default output of `nsh build` (`bundle.js`, `bundle.js.map`, `bundle.nshc`, `capabilities.json`, `assets/`; for a Rust app, `app.json` and `assets/`) and `nsh package` (`.app`, `.ipa`, `.apk`, a site); `-o` writes elsewhere. Safe to delete; it is recreated.
- **`target/`**: Cargo's build directory for an app's crates and runners (or `CARGO_TARGET_DIR`). With [huacnlee/cargo](https://github.com/huacnlee/cargo), which we recommend, it holds only the binaries, and the builds live under `~/.cargo/targets/`.
