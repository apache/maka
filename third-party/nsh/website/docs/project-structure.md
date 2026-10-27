---
title: Project structure
description: The files of an NSH app in Rust or TSX, every key of nsh.json, the TypeScript setup in .nsh/types, assets, and how modules and packages are imported.
order: 5
group: start
---

# Project structure

An NSH app is a directory with an `nsh.json` and its code: a Rust crate whose root component `nsh.json` names, or a TSX entry module, or both. Everything else (more modules, images, fonts, JSON files) is found from there: a crate's modules and its `assets/` directory, or the files the TSX entry imports, so there is no file list to maintain.

An app written in Rust is a Cargo project:

```text
my-app/
├── nsh.json           name, id, version, icon, the crate ("rust") and its root component ("root"), theme
├── Cargo.toml         the crate: nsh-core, nsh-base and your dependencies
├── src/
│   ├── lib.rs         the root component and the crate's UI set (#[native_module])
│   ├── main.rs        cargo run: the root on this machine's desktop backend
│   └── screens/       your own modules (any layout you like)
├── assets/            files the crate ships: asset!("logo@2x.png"), fonts
├── .gitignore         .nsh/ and target/
├── .nsh/              generated: the runners' sources, test entries, build output (.nsh/out)
└── target/            Cargo's build directory
```

A TSX app is an entry and the modules it imports:

```text
my-app/
├── App.tsx            the entry module: calls mount()
├── App.test.tsx       its tests (nsh test)
├── nsh.json           name, id, version, icon, Tailwind theme, capabilities
├── tsconfig.json      TypeScript settings for editors
├── .gitignore         .nsh/ and target/
├── components/        your own modules (any layout you like)
│   └── Header.tsx
├── assets/
│   ├── logo@2x.png    imported images
│   └── Inter.ttf      imported fonts
└── .nsh/              generated: type declarations, development host builds, test entries, build output (.nsh/out)
```

An app with both lists its crates in `"rust"` and has a TSX entry that imports them ([Building with Rust](./rust.md#extending-a-rust-app-with-tsx)).

Every command takes the app's directory or its entry as its argument (`nsh run my-app`, `nsh run my-app/App.tsx`). The directory of `nsh.json` and the entry is the app's root: `nsh.json` is read from there, asset paths are relative to it, and `.nsh/` is written there. In a Rust app (`nsh.json` `"root"`), the directory runs the root component; naming a TSX entry runs that instead.

## The root component

A Rust app's root is a component of its crate, which `nsh.json`'s `"root"` names by its path in the crate (`App`, `shell::Gallery`). A TSX entry is a normal module that ends by rendering the root component:

```rust tabs
// src/lib.rs; nsh.json: { "rust": ".", "root": "App" }
mod screens;

use nsh_core::prelude::*;

/// What a TSX entry may import from the crate.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>().assets(assets!());
}

#[component]
pub fn App() -> impl IntoElement {
    screens::home()
}
```

```tsx tabs
// App.tsx
import { mount } from "nsh";
import { Home } from "./components/Home";

function App() {
  return <Home />;
}

mount(App);
```

`nsh run` and `nsh package` mount a Rust root on every platform, with no QuickJS. In TSX, `mount(component, props?)` renders the component into the app's surface and returns a function that removes it again; an app calls it once. Code at the top level of the entry runs when the bundle loads, before the first frame.

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
| `name` | string | `package` | The display name under the app icon. Default: the entry directory's name. |
| `id` | string | `package`, `publish`, `Storage` | Bundle identifier / application id in reverse-DNS form, e.g. `com.yourcompany.app`; required by `package` and `publish`. `nsh run` uses `com.example.<name>` without one. |
| `version` | string | `package`, `publish` | The user-visible version, e.g. `1.2.0` (`CFBundleShortVersionString`, Android `versionName`). |
| `build` | number | `package`, `publish` | The build number (`CFBundleVersion`, Android `versionCode`). Signed packages require it to grow with every release. |
| `minRuntime` | string | `publish` | The lowest NSH runtime that runs the signed package, e.g. `0.2.0`. Default: the CLI's version ([Signed packages](./signed-packages.md#which-runtimes-run-a-package)). |
| `icon` | string | `package` | A square PNG, ideally 1024×1024, relative to `nsh.json`. |
| `tailwind` | object | every build | Extends the Tailwind theme your `class` strings resolve against ([Tailwind](./tailwind.md#theme)). |
| `appearance` | string | every build, `package` | `"light"`, `"dark"` or `"system"` (the default): an app that is always light or dark says so here. `colorScheme()`, `dark:` classes, the components' theme and the platform's controls follow it from the start ([Device and environment](./device-and-environment.md#dark-mode)). |
| `theme` | string or object | every build | The app's design tokens (shadcn/ui's `cssVars`, over the default `neutral` theme), which token classes, `token()` and Rust components draw with: a theme file's path relative to `nsh.json`, or the theme inline ([Building with Rust](./rust.md#theme), [Theme tokens](./tailwind.md#theme-tokens)). |
| `statusBar` | object | every build, `package` | The status bar's default under every page and dialog (iOS and Android): `{ "foreground": "auto" \| "light" \| "dark", "hidden": boolean }`, both optional. Packaged iOS apps show it from the launch screen on ([Status bar](../modules/nsh-base.md#status-bar)). |
| `capabilities` | object | every build | What the app may reach outside its VM: network hosts, web view hosts, the status bar ([Sandbox and capabilities](./sandbox-and-capabilities.md)). |
| `resolve` | object | every build | How bare imports resolve: the export conditions of npm packages and aliases ([npm packages](#npm-packages)). |
| `rust` | string or string[] | every command | The app's Rust crate, or a list of them, relative to `nsh.json`: their components and modules, which TSX imports by each crate's `#[native_module]` specifier ([Building with Rust](./rust.md#several-crates)). |
| `web` | object | `package` | What a web package adds to its page. `web.host`: a JS module relative to `nsh.json` exporting `createHost(player)`, which answers the app's [`host`](../modules/nsh.md#host) calls; `web.connect`: the hosts that module's own requests reach, as patterns of `capabilities.network.hosts`, which the page's Content-Security-Policy allows ([Web](./web.md#the-hosts-functions)). |
| `root` | string | `run`, `package` | A Rust app's root component, its path in the `rust` crate, the first one of a list (`App`, `shell::Gallery`): `nsh run` and `nsh package` of the app's directory mount it with no QuickJS, on every platform; `nsh run App.tsx` still runs the TSX entry ([Building with Rust](./rust.md)). |

The flags of `nsh package` and `nsh publish` (`--name`, `--id`, `--app-version`, `--build`, `--icon`, `--min-runtime`) override the file's values ([CLI](./cli.md)).

`tailwind`, `theme`, `appearance`, `statusBar`, `capabilities` and `resolve` are checked when the app is built. A typo is a build error rather than a setting that silently does nothing:

```text
error building App.tsx failed
nsh.json: tailwind: unknown theme key `colours`
```


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
| `types.d.ts` | Styles (`ViewStyle`, `TextStyle`, ...), every element's props and events, `YNode` (what a `ref` receives) |
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
| `nsh/desktop` | What macOS, Windows and Linux have: `Window`, `titleBar`, `Menu` ([reference](../modules/nsh-desktop.md)) |

The [modules reference](../modules/index.md) documents each one. Importing a module NSH does not have (`nsh/foo`) is a build error. So is a name your code uses that the module does not export (`import { Buton } from "nsh/base"`): the error points at the import and names the closest export (``did you mean `Button`?``). Names used only as types are checked by `nsh check`.

### npm packages

NSH needs nothing from npm, but the bundler resolves bare imports from a `node_modules` directory if you install packages with a package manager. Packages resolve their browser builds, because the runtime provides web APIs (`fetch`, streams, `URL`, `TextEncoder`, ...) and not Node's (`fs`, `Buffer`, `process`). Packages that touch the DOM do not work: there is none.

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

```rust tabs
use nsh_core::element::{FontAsset, ImageAsset, asset};

const LOGO: ImageAsset = asset!("logo@2x.png");      // its url, and its size: 64×64 points
const INTER: FontAsset = asset!("Inter.ttf");        // its uri, and its family: "Inter"

image(LOGO)
text("Hello").font_family(INTER.family)
```

```tsx tabs
import { Image, Text } from "nsh";
import logo from "./assets/logo@2x.png";   // { url: "asset:/assets/logo@2x.png", size: { width: 64, height: 64 } }
import Inter from "./assets/Inter.ttf";     // "Inter"

<Image src={logo} />
<Text style={{ fontFamily: Inter }}>Hello</Text>
```

| Extension | Import gives |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic` | An `ImageAsset`: `{ url, size, scales? }`, sized in points. An `@2x` / `@3x` suffix divides the pixel size by 2 / 3. A file without a suffix also ships its `@1.5x`–`@4x` siblings, listed in `scales`, and the screen's variant is loaded ([pixel densities](./images-and-assets.md#pixel-densities)). |
| `.svg` | An `ImageAsset` sized in points by the SVG's `width` and `height` (or `viewBox`). |
| `.ttf`, `.otf` | The font's family name, a string. The font is registered before the first frame. |
| `.json` | The parsed JSON |

See [Images and assets](./images-and-assets.md) and [Fonts](./fonts.md).

## Generated directories

- **`.nsh/`**: everything NSH generates: the type declarations (`.nsh/types`), the sources of a Rust app's runners (`.nsh/rust`), what `nsh run` installs on simulators and devices (the Catalyst host app, the Android development APK), and `.nsh/out`, the default output of `nsh build` (`bundle.js`, `bundle.js.map`, `bundle.nshc`, `capabilities.json`, `assets/`; for a Rust app, `app.json` and `assets/`) and `nsh package` (`.app`, `.ipa`, `.apk`, a site); `-o` writes elsewhere. Safe to delete; it is recreated.
- **`target/`**: Cargo's build directory for an app's crates and runners (or `CARGO_TARGET_DIR`).
