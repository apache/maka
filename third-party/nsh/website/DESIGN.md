# Website design

Rules for `website/`, so later changes stay coherent. The site follows the
shared example UI's design language (`examples/nsh-gallery-ui`) on one ink
blue-black ground (white in light), one citrus accent, tinted status colours — neutral and refined,
the look of the UI nsh draws.

## Principles

1. **Say what it is, immediately.** The headline is the name and the slogan,
   the banners' composition; the lead says it in plain words: write TSX, ship
   native clients that keep pace with Rust, on 8 platforms. The home page
   follows that order: the numbers beside Rust, TSX with 0 dependencies, the
   8 platforms and what each is built from, one chat app in three forms, Rust as
   an equal way in, retained views, delivery, the ways to ship, the
   foundations. Other frameworks are named only on the comparison page. The
   one exception is GPUI Kit (gpui-kit.com), Longbridge's desktop framework:
   a single linked note under the foundations points desktop-only apps to it.
   It stays a note there, never a band, card or hero link, while GPUI Kit's
   home page recommends NSH in a band under its hero.
2. **Show the real thing.** The picture says what NSH is, and the proof runs:
   the chat band shows `demos/home-chat.tsx` live on the web player at the
   desktop and the phone idioms, beside a terminal capture of the same
   app, and the numbers come from `docs/performance-report.md` and
   `docs/web.md`, which a change to them updates first. Documentation pages run
   their demos in a frame at phone width; the code shown is always the source
   of what runs. The product is written "Native Shell" in formal places and
   "NSH" in prose; `nsh` stays as it is in code, commands and URLs.
3. **Specifics over adjectives.** Every capability card names something a
   reader can check in the repository: a crate, an element, a module, a
   command (`Taffy`, `<List>`, `Animated`, `nsh publish`). Claims track
   `README.md` and `AGENTS.md`; update the copy when they change.
4. **Restraint carries the design.** Hierarchy comes from type scale, weight,
   hairlines and surface depth (card, inset, raised), not colour fills. The
   only gradients are the surfaces' own top-to-bottom light.

## Colour

The shared source is `examples/nsh-gallery-ui/theme.json`, with surfaces in `finishes.json`. The website
loads their generated CSS through `virtual:nsh-gallery-ui.css`; its text, accent and status variables alias
those values, and the controls (`ui.css`) keep their finishes. The page surfaces are the site's own: every
page, the home page included, sits on one ground (`--background`), and the cards, insets, raised fills,
borders, hairlines, the sidebar, code and popovers are stepped from it in the same hue. No page overrides
them. The NSH gallery and runnable demos consume the shared files as they are, so a demo frame's screen
(`--screen`) keeps the demos' own background.

Tokens live in `src/styles/global.css`: `:root` holds the dark theme,
`html.light` its light variant. A pre-paint script in `BaseLayout.astro`
sets `dark` or `light` on `<html>` from `localStorage.theme` ("light",
"dark", or absent for the system's), so nothing flashes; the nav's
System / Light / Dark segmented control (`ThemeSwitch.astro`) sets it.

The light variant keeps the design and its material: a white page
`#ffffff` and a white nav with a hairline, flat (no grain or light wash),
and neutral grays, never tinted: cards and popovers `#ffffff` with a 1px
border `#e2e2e6`, hairlines `#ececef`, input borders `#d8d8dd`; insets and
muted fills `#f2f2f4`; raised fills and code `#f7f7f8`, the sidebar
`#fafafa`. Only the home page uses the banners' pale green, echoing its
art: the hero and the closing on `#f6f8f4`, the tinted bands on `#f2f5ef`
(Home.astro), with the panels and code on them white under a green hairline.
Text, muted and faint
are the gallery's. The accent token (`--citrus`) becomes `#4f6e0c`
so it reads as text and lines; the bright citrus stays the fill of accent
badges and buttons (`--finish-accent-bg`, a `#a7cf3f` border, text
`#1b2207`). Status colours for light: up `#138a5a`, danger `#d43a4a`,
info `#3d63d1`, warn `#b26a00`.
The values below are the dark theme's.

- **Surfaces**, an ink blue-black ground and its steps: page `#0e1016`
  (flat, every page), card `#161920`, popover `#181b22`, inset `#0b0d12`,
  raised `#1c1f27`, muted `#1a1d24`, sidebar `#0c0e13`, tinted bands
  `#12141b`, code `#0a0c10`; border `#282c35`, input border `#30343e`,
  hairline `#1f222a`; text `#eceef1`, muted `#9a9ea5`, faint `#6b6f76`.
- **Finishes** (`--finish-*`, the gallery's `finish`): cards take the
  site's flat card fill (`--finish-card-bg`), an inner top highlight and a soft shadow;
  insets (code, the demo stage, the search field, segmented tracks) are
  recessed with an inner shadow; raised controls (secondary buttons, kbd,
  segmented thumbs) have a top highlight. Navigation stays quiet: the
  current nav and sidebar item is a soft tint (`--nav-active`), the sidebar's
  with a 2px accent bar; scroll areas use thin overlay scrollbars.
  Primary buttons are light (`#fbfbfc → #d4d6d9`, dark text).
- **One accent, citrus `#c8f26d`** (text on it `#13160c`): the logo, links,
  kickers, the current TOC entry, the nsh module's tag in the hero, the
  accent of the diagrams. Never a large fill.
- Status colours: up / success `#45d49a`, danger `#ff6170`, info `#7ea8ff`,
  warn `#ffb547`, as small tinted badges or dots. Callouts take one
  palette colour each (note info, tip up green, important citrus, warning
  amber, caution danger): a soft tint over the page (`--callout-tint`, 11%
  dark, 7% light), a 25% border, the icon and label in the colour, the body
  in the text colour. No purple anywhere but code keywords.
- **Code colours are tokens** (`--code-*`): Shiki emits the allsum-light
  theme's hex values (`src/light.theme.json`) and `global.css` maps
  them onto the tokens, so fenced blocks, demo sources and the home page's
  code share one palette. Never hand-colour a snippet.
- Diagrams in `public/diagrams` come as a light and a dark file, each with
  `:root` tokens in its theme's palette; the page shows the one of its theme.
- **Code blocks** are one card (radius 14, hairline, the card gradient and
  top highlight, a soft outer shadow, no inner shadow): a header row naming
  the language (`pre::before`, from `data-language`) with the copy button,
  a hairline, the code on a faintly tinted surface. Syntax colours per
  theme are Allsum's code palette, the one TextView highlights with:
  keywords violet, strings green, numbers amber, functions and types blue,
  properties gold, built-ins teal, comments faint italic. Tables are clean cards (a faint header tint, 13px muted
  labels, row hairlines). Inline code is a light-touch chip.
- **A touch of liquid glass**, on floating and layered surfaces only: the nav
  bar, the search panel, menus, segmented controls (a glassy track, the
  selected item a lit glass pill), the copy buttons and badges get a
  translucent fill (`--glass-fill`), a lit rim (`--glass-edge`: top light,
  bottom dark) and backdrop blur where content passes under them, with an
  opaque fallback. Cards and reading surfaces stay calm.
- Diagrams are never upscaled (at most their 880px viewBox width, centred);
  in docs they scroll inside `.diagram-scroll` rather than shrink below
  640px.
- Radii: cards 16px, insets 12px, controls 10px.
- The logo (`public/logo.svg`, inline in `Logo.astro`) is the banners' mark:
  the shell as a lit citrus tube holding a bead, drawn in SVG layers that
  hold at favicon size, its colours the theme's `--logo-*` (a deeper citrus
  and a dark bead on the light theme). The favicon (`favicon.svg`) is the
  mark on a transparent background, its colours switching with
  `prefers-color-scheme` inside the SVG; `apple-touch-icon.png` and
  `icon-512.png` are the light mark on a plain `#f3f3ef` square. The gallery's
  app icon is `public/brand/nsh-app-icon-dark.png`: the mark on a top-lit
  graphite ground.
- The brand page (`/brand`, linked from the footer): the logo, solid logos,
  app icons, README banners, social previews and link preview, downloadable
  from `public/brand/`.
- The link preview (`public/og-image.png`, 1200×630, `og:image` and the
  large Twitter card on every page) is the mark as a lit citrus tube inside
  seven glass arches, rendered with NSH's own `<Shader>` on a soft grey-green
  wash, with the name, slogan and platforms in Figtree.

## Controls

Every control is a component of `src/components/ui/`, after shadcn/ui:
`Button` (variants `default` — the citrus primary —, `secondary` — raised —,
`outline`, `ghost`, `destructive`, `link`; sizes `xs`, `sm`, `default`, `lg`
and the square `icon-*`), `ButtonGroup`, `Input` (with an `icon` slot, an
input group), `Label`, `Select` (a trigger like an input and a listbox popup,
driven by `src/lib/ui/select.ts`), `Badge`, `Toggle`, `ToggleGroup` /
`ToggleGroupItem` (variant `segmented` for switches between views, `outline`
with `spacing` for filter chips, `count` for a quiet number), `TabsList` /
`TabsTrigger`. As shadcn's components do, they mark their parts with
`data-slot` and their look with `data-variant` / `data-size`, and their state
is ARIA (`aria-pressed`, `aria-checked`, `aria-selected`, `aria-expanded`):
the look is one file, `src/styles/ui.css`, shadcn's class lists applied to
those selectors, with shadcn's tokens (`primary`, `secondary`, `accent`,
`muted`, `border`, `input`, `ring`, ...) mapped onto the gallery's theme and
the surfaces given its finishes (raised, hover, pressed, the citrus `light`,
field, track, menu). HTML written as a string (`src/lib/demo.js`,
`src/lib/remark-code-tabs.js`, buttons a script adds) uses the same
attributes. A page never styles a control itself: it places it (margins,
widths) and picks a variant; a new kind of control is a new component.

## Typography

The platform font (SF Pro, Segoe UI, Roboto; PingFang / Noto Sans SC for
Chinese); `ui-monospace` / SF Mono for code. Base 15px. The home page's
headings are in Figtree (`@fontsource-variable/figtree`), the banners' face,
the site's one webfont.

- Display: `clamp(2.3rem, 4.6vw, 3.75rem)`, weight 680, tracking −0.045em.
- Section heading: `clamp(1.9rem, 3.4vw, 2.8rem)`, weight 660.
- Kickers: 0.68rem mono, uppercase, wide tracking, faint (citrus on the
  home page's sections). Small mono labels
  — not colour — mark structure (section kicker, sidebar group, "On this page").
- Negative and wide tracking are for Latin only: `html[lang^="zh"]` resets
  them.
- Chinese headings, titles and kickers never end with "。" (body sentences
  keep it); English headlines keep their full stop where the component's
  other headlines have one.

## Layout

- Page width 1280px, gutter 1.5rem (1rem under 640px). Nav, hero, bands and
  footer share the same left edge.
- Home bands are full-bleed sections separated only by a hairline
  (`border-top`), content in `.band__inner`.
- Docs: sidebar (232px) · article (prose capped at 46rem) · "On this page"
  (208px). The TOC hides under 1180px; under 960px the sidebar becomes a
  sticky bar naming the section and page, opening a drop-down list; under
  860px the section links move behind the burger.
- Grid columns use `minmax(0, 1fr)`; check phone widths for horizontal
  overflow (the page's `scrollWidth` must equal the viewport).

## The hero

The home hero is the banners' composition drawn live: the name, the citrus
slogan, the 8 platforms, on the banners' grounds: `#0e1016`, the whole site's
`--background`, in dark; the pale green `#f6f8f4` in light, which only the
home page's hero, tinted bands and closing use.

`HeroArches.astro` draws the mark with a fragment shader (WebGL, one pass):
eight glass arches around a lit citrus tube holding a bead, over a halftone
field. The bead is the app, the tube the engine, each arch a platform, inner
to outer in the order of the platform names beside it. Hovering or focusing a
name lights its arch and names its stack; hovering an arch does the same. On
load one ripple runs outward through the arches. Light slides slowly over the
glass. It draws at 30 FPS, pauses off screen and in hidden tabs, draws still
frames with reduced motion, never takes pointer events itself, and without
WebGL the hero is its copy. On narrow screens the arch sits under the copy,
in the room `--arch-room` keeps.

## Demo frames

- Demos (`demos/*.tsx`), the home page's live frames and the playground follow the
  page's theme: the player starts with `?theme=` and gets a message on every
  change (`themeDemos` in `src/lib/demo-client.ts`), and demos read their
  colours from `demos/palette.ts`, an adapter of `examples/nsh-gallery-ui`, inside JSX. Its palette reads the
  shared theme's tokens, so it switches live. The playground includes the shared modules in isolated scopes and
  applies their `theme.json` before the first render. `demos/nsh.json` references that same file for normal builds.
- A demo is shown in a **frame** (`.phone`, `frameBar()` in
  `src/lib/demo.js`): a card with the card finish, a slim bar (an icon tile,
  the file name, a "Live" badge) and the app on an inset surface, no device
  chrome. The app renders at its real 390×844 points and the frame is
  scaled with `--phone-scale`, so the app's own layout never reflows.
- The demo panel's bar carries the file name and "Open in new tab"; the stage
  is a faint 24px blueprint grid. Wide panels show the frame and source side
  by side (a container query on `.demo`); narrow ones switch with a segmented
  control. View switching lives in the panel's bar, never inside the frame.
- Code shown as "a file you wrote" uses the macOS window frame
  (`.code-window`): traffic lights, centred title.

## Motion

Entrances only: `rise` 620ms `cubic-bezier(.16, 1, .3, 1)`, staggered 70ms,
inside `prefers-reduced-motion: no-preference`. The live dot pulses slowly
(2.4s). Nothing conveys meaning through motion alone.

## Content

- English and Chinese pages are written together; same file names, same
  `order` and `demo` (`tests/content.test.ts`).
- Home copy is `src/home/en.json` and `src/home/zh-CN.json`, the same keys in
  both (`tests/home.test.ts`); numbers, commands and code stay in
  `src/components/Home.astro`, the same in every language. Section names and
  blurbs are in `src/lib/sections.ts`.
- The licence is Apache-2.0; no version number is shown anywhere.
