# Native Shell website

The documentation site for nsh, published at <https://nsh.dev>
(`src/lib/site.ts`). Astro (static output), Tailwind 4, Pagefind search,
Shiki highlighting (the site's themes, `src/light.theme.json` / `src/dark.theme.json`, are Allsum's code
palette, the one `TextView`'s built-in highlighting colors code with); [Bun](https://bun.com) runs everything.

```sh
bun run dev        # http://localhost:4321, live reload (search needs a build)
bun run build      # dist/: astro build, then the Pagefind index
bun run preview    # serve dist/
bun run test       # content rules + a link check of dist/ (build first)
```

`dev` first kills a dev server of this checkout that is still running (it
would hold the port). `dev` and `build` install the dependencies if needed and build the
WebAssembly player with the demos (`cargo xtask web`, incremental: a second
start takes seconds), and the gallery (`examples/gallery`), published with
`nsh package --target web` into `public/play/gallery/` for the Gallery page
(`/gallery`); its URLs are relative, so it works under any base path. Without Rust (and its `wasm32-unknown-unknown` target)
they print a warning and the pages show demo sources without the live preview.
While `dev` runs, demos are bundled from `demos/*.tsx` on each request and
`nsh.js` is served from `crates/nsh-platform-web/web`, so edits to either show
on reload; changes to the Rust runtime need a restart.

Set `PUBLIC_SITE_BASE=/sub/path/` to build for a sub-path.

## Writing documentation

Content is Markdown in three sections, each in English and Chinese:

| Directory | URL | Nav label |
| --- | --- | --- |
| `docs/*.md` | `/docs/<file>` | Guide · 指南 |
| `elements/*.md` | `/elements/<file>` | Elements · 元素 |
| `modules/*.md` | `/modules/<file>` | API |
| `zh-CN/<section>/*.md` | `/zh-CN/<section>/<file>` | |

`index.md` is the section's own page (`/docs`). The file name is the URL;
the Chinese page has the same file name as the English one.

When changing a documentation page, update its English and Chinese
counterparts together. Keep their `order`, `group` and `demo` frontmatter in sync, and
link to pages in the same language.

Name the product **Native Shell** in formal places (page titles, the home page,
a page's first mention, the README's opening, meta descriptions) and **NSH**
everywhere else in prose, as GPUI is written: "NSH apps", "NSH's components",
"NSH 应用". Lowercase `nsh` is for code only, in backticks: the CLI (`nsh run`),
`nsh.json`, the modules (`nsh`, `nsh/base`), crates and packages. A short,
uppercase name is one the community can build on (`nsh-*` crates, NSH plugins).

Write in positive terms: say what nsh, a platform or a feature is and does,
in both languages.

- **Describe a thing by what it is.** "The macOS backend renders with AppKit
  views", not "this is not Mac Catalyst"; readers make no comparison the page
  does not put in their heads.
- **Leave out what is missing, planned or unfinished.** No "not yet", "in
  development", "demos only", "there is no …", "without …" or "no Node.js";
  a page lists what works. When a reader needs a boundary to use a feature
  correctly, state it as the rule that holds ("`AppView` loads bundles from
  the app's own files"), and keep the detailed reference (a "What differs on
  …" section, standards compliance notes) factual.
- **Name things after what nsh is.** nsh is native UI: the standard globals
  are "global APIs", not "web APIs"; the web platform renders HTML in a page
  (say "the web", "HTML", "the browser", never the technology underneath it).

Frontmatter (checked by `src/content.config.ts`):

```yaml
---
title: Getting started          # required; the page heading and sidebar label
description: "Create an app: …" # required; meta description, llms.txt
order: 2                        # optional; sidebar position, ascending
group: start                    # optional; the sidebar group (GROUPS in src/lib/sections.ts)
demo: guide-getting-started     # optional; a demo from demos/<name>.tsx
---
```

- **Quote values that contain `: `** (a colon and a space), or YAML fails to
  parse the file and the build stops. `bun run test` names such files.
- **Sidebar order**: `index` first, then by `order` (missing = 999), then
  alphabetically by title. Chinese pages sort by their English counterpart,
  so both locales list pages in the same order; the Chinese labels are the
  Chinese titles. A Chinese page keeps the same `order`, `group` and `demo`
  as its English page (`tests/content.test.ts`).
- **Groups**: a section's pages can be listed under group headings
  (`group:`, a key of `GROUPS` in `src/lib/sections.ts`; the Guide uses
  them). A group is a run of consecutive pages, so keep a group's `order`
  values together.
- **The heading comes from `title`.** A leading `# Title` in the body is
  removed, so pages may keep one for GitHub. The first paragraph is shown as
  the page's standfirst.
- **Link to files, relatively**: `[List](../elements/list.md)`,
  `[signals](./reactivity.md#signals)`. They become site URLs, and a Chinese
  page's links stay in Chinese. A link leaving `website/`
  (`../../docs/dev/architecture.md`) points at the file on GitHub.
- **Callouts** are GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
  `> [!WARNING]`, `> [!CAUTION]`.
- **Code blocks** highlight `tsx ts js json sh bash swift java kotlin rust
  toml diff xml html yaml css`.
- **Code tabs**: consecutive fences whose info string holds the word `tabs`
  become one block with a tab per fence, named after its language (`rust`
  → Rust, `tsx` → TSX, others capitalized). The first tab is selected;
  choosing another switches every group on the page and is remembered. Any
  other text between the fences (a blank line is fine) ends the group.
  Show examples Rust first, then TSX:

  ````md
  ```rust tabs
  view().child(text("Hello"))
  ```

  ```tsx tabs
  <View><Text>Hello</Text></View>
  ```
  ````

  The `.md` endpoints and `llms-full.txt` print the fences as plain
  consecutive blocks (`src/lib/remark-code-tabs.js`).

Each page is also served as Markdown at its URL plus `.md`; `/llms.txt`
lists every page and `/llms-full.txt` holds all English pages.

## Deployment

`.github/workflows/website.yml` builds the site on every push to `main` that
touches the website or the crates, and publishes `dist/` to GitHub Pages at
<https://nsh.dev> (`public/CNAME`; `SITE_URL` in `src/lib/site.ts`).
CI sets `NSH_REQUIRE_PLAY=1`, so a failed player build fails the deployment
instead of publishing pages without their live demos. Pull requests build and
test without deploying.

## Playground

`/playground` (`src/components/Playground.astro`, `src/lib/playground-client.ts`)
edits and runs one-module apps in the browser: CodeMirror, and the player in
playground mode (`play/index.html?playground`, which loads
`nsh-playground.wasm`, the runtime with the TSX compiler). Demo panels link to
it with `#demo=<name>`; Share links carry the code itself (`#code=`, deflated,
base64url).

## Demos

`demos/<name>.tsx` are small runnable nsh apps (try one with
`nsh run website/demos/<name>.tsx`). A page with `demo: <name>` shows the demo
after its first paragraph, and a section with a demo of its own shows it where
its `<!-- demo: <name> -->` line is (on the English and the Chinese page alike): a frame with the app running in an iframe of
`play/index.html?idiom=…#<name>`, beside its source (wide pages, Mobile) or
behind a Preview / Source switch (narrow ones), and two icon buttons: edit in
the playground, open in a new tab. The home page runs `demos/counter.tsx` the
same way (`src/components/DemoFrame.astro`, `variant="phone"`).

The panel switches the demo between two layouts (`LAYOUTS` in
`src/lib/demo.js`, `demo-client.ts`), and the app runs again with the idiom
of the one chosen (the player's `?idiom=`). The visitor's choice applies to
every demo and is remembered:

| Layout | Frame | Idiom | What the app has |
| --- | --- | --- | --- |
| Mobile | 390×844 points, the default | `phone` | touches; menus as sheets, held fingers |
| Desktop | 1024×640 points, scaled to the column, the source below | `desktop` | a pointer; hover, right clicks, popups, keyboard |

The rules every demo follows, now and for the ones to come:

- **Every element page has one.** Each page of `elements/` (its index aside)
  names a demo, `el-<page>` unless one already shows the element
  (`tests/content.test.ts` checks it).
- **It is laid out for both layouts.** On a phone it is one column with flex,
  44-point targets. In a window at least 700 points wide (`wide()` from
  `demos/palette.ts`) it is a desktop layout ([Design Guides](docs/design-guides.md),
  "Layout patterns"): the subject on a stage that takes the room, beside an
  inspector column of about 300 points with its state, its event log and
  the options that tune it (`Split`, or `Stage` and `Inspector`, with
  `Panel`, `Log` and `Segmented`; buttons and text fields are never styled by hand: spread `button(kind)` and
  `field()` and give the label `buttonText(kind)`, so every demo shares one size, radius, hover, pressed, focus and
  disabled treatment). With a pointer (`desktop`, from
  `platform.idiom === "desktop"`) it has desktop density (`size`: controls
  of 28 and 32 points, rows of 32 and 40): buttons as wide as their labels,
  never as wide as the stage, comparable numbers in tabular figures at the
  end, one content inset for the whole demo. Where the element behaves
  differently by device (menus, tooltips, context menus, hover), the demo
  shows both behaviors and says on screen what to do in the device's words
  (`desktop ? "Click a row, or Tab to it and press Space" : "Tap a row"`).
  The phone layout keeps working as the desktop one changes.
- **It shows the element, not the gallery.** A short screen of what the page
  explains: the element's main props and events, its state printed on screen,
  colours and reusable components from `demos/palette.ts`, backed by `examples/nsh-gallery-ui` (light and dark).
- **It is checked in both.** `nsh test website/demos/<name>.tsx` runs it as a
  phone; `nsh test website/demos/<name>.tsx --target web` (a browser) or
  `--target linux` (a window) as a desktop. Look at both before adding it.

The player in `public/play/` is the WebAssembly build of the nsh runtime
(`crates/nsh-platform-web`, rendering to the DOM) with every demo bundled by
`nsh build`; it is generated, not checked in:

```sh
bun run play       # = cargo xtask web: nsh.wasm, nsh.js, index.html, demos/*.nshc (dev and build run it)
```

Run it again after changing the runtime. Gallery and website demos share the internal
`examples/nsh-gallery-ui` components, palette, `finishes.json` and `theme.json`.
The site also generates CSS variables from these files (`src/lib/gallery-ui-css.js`), so page surfaces and native
demos follow the same visual foundation. `demos/palette.ts` is their documentation
adapter; `demos/nsh.json` references that shared theme. Embedded demos follow the page's appearance (`?theme=`,
then a message on each change).

The playground compiles one file in the browser. `src/lib/inline-gallery-ui.ts` includes the adapter's shared
modules in separate scopes and applies the same theme before the first render, so a demo's imports and theme
work in the playground as they do in a normal NSH build. The
player is built separately from the site. Whether it exists is decided
at build time: without `public/play/index.html`, pages show the demo's source
only and the home page's host app shows a placeholder. Adding or removing the
player, or editing a demo, invalidates Astro's content cache automatically
(`demoState()` in `src/lib/demo.js`).

## Layout of the code

| Path | Role |
| --- | --- |
| `src/content.config.ts` | The six collections (three sections × two locales) and the schema |
| `src/lib/sections.ts` | Section labels, page lists in sidebar order, routes |
| `src/lib/remark-*.js`, `rehype-heading-anchors.js` | Title removal, callouts, code tabs, `.md` links, demo insertion, heading anchors |
| `src/lib/code-tabs-client.ts` | Switches code tabs, page-wide, and remembers the choice |
| `src/lib/demo.js` | Demo sources, the demo frame and the demo panel markup |
| `src/lib/markdown-endpoint.ts`, `llms.ts` | `<page>.md`, `llms.txt`, `llms-full.txt` |
| `src/pages/[section]/[...slug].astro` | Content pages (and `zh-CN/`); `[section].md.ts` / `[...slug].md.ts` the Markdown |
| `src/components/Home.astro` | The home page in both languages |
| `src/styles/global.css` | Tokens and everything shared; see `DESIGN.md` |
| `tests/` | `content.test.ts` (frontmatter, translations, demos), `code-tabs.test.ts` (code tabs), `links.test.ts` (built site) |
