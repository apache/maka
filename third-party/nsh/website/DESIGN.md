# Website design

Rules for `website/`, so later changes stay coherent. The site follows the
shared example UI's design language (`examples/nsh-gallery-ui`): graphite surfaces lit
from above, one citrus accent, tinted status colours — neutral and refined,
the look of the UI nsh draws.

## Principles

1. **Say what it is, immediately.** The headline states the purpose in plain
   words: a native UI framework for every platform — one app, native on
   each. The home page follows the positioning in that order: what native
   means (the platform's foundations and its interaction), cross-platform
   from phone to desktop to the web, Rust first with TSX beside it, the
   foundations, then the ways to ship (standalone apps first, dynamically
   delivered and AI-generated UI on the same engine). Other frameworks are
   named only on the comparison page. Architecture comes further down.
2. **Show the real thing.** The hero runs the gallery's AI chat
   (`demos/home-chat.tsx`, its files in `demos/hero-chat/`, copied from
   `examples/gallery`) live on the web player: it plays one scenario on
   load (a tool call and a streamed Markdown reply, fictional content) and
   stays interactive. Documentation pages run their demos in a frame at
   phone width; the code shown is always the source of what runs.
   The product is written "Native Shell" in formal places and "NSH" in
   prose; `nsh` stays as it is in code, commands and URLs.
3. **Specifics over adjectives.** Every capability card names something a
   reader can check in the repository: a crate, an element, a module, a
   command (`Taffy`, `<List>`, `Animated`, `nsh publish`). Claims track
   `README.md` and `AGENTS.md`; update the copy when they change.
4. **Restraint carries the design.** Hierarchy comes from type scale, weight,
   hairlines and surface depth (card, inset, raised), not colour fills. The
   only gradients are the surfaces' own top-to-bottom light.

## Colour

The shared source is `examples/nsh-gallery-ui/theme.json`, with surfaces in `finishes.json`. The website
loads their generated CSS through `virtual:nsh-gallery-ui.css`; its own semantic variables alias those values.
The NSH gallery and runnable demos consume the same files.

Tokens live in `src/styles/global.css`: `:root` holds the dark theme,
`html.light` its light variant. A pre-paint script in `BaseLayout.astro`
sets `dark` or `light` on `<html>` from `localStorage.theme` ("light",
"dark", or absent for the system's), so nothing flashes; the nav's
System / Light / Dark segmented control (`ThemeSwitch.astro`) sets it.

The light variant keeps the design and its material: a warm off-white page
`#f3f3ef` with a faint grain (`--grain`, both themes), cards `#ffffff →
#fafaf7` with a 1px border, a crisp top highlight, a faint bottom edge and
layered warm shadows; insets `#ecece7` with an inner shadow; raised
controls `#ffffff → #f4f4f0` with a top highlight; text `#15161a`, muted
`#565a61`, faint `#8c9097`. The accent token (`--citrus`) becomes `#4a6a0a`
so it reads as text and lines; the bright citrus stays the fill of accent
badges and buttons (`--finish-accent-bg`, a `#a7cf3f` border, text
`#1b2207`). Primary buttons are dark (`#2a2b30 → #16171a`). Status colours
for white: up `#0f8a55`, danger `#d43345`, info `#3d63d1`, warn `#b26a00`.
The values below are the dark theme's.

- **Surfaces**, as in the gallery: page `#101113`, card `#18191c`, inset
  `#0c0d0f`, raised `#24262a`; border `#2c2e33`, hairline `#1f2124`; text
  `#eceef1`, muted `#8d9198`, faint `#5a5e65`.
- **Finishes** (`--finish-*`, the gallery's `finish`): cards take a
  `#1d1e22 → #17181b` gradient, an inner top highlight and a soft shadow;
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
- The logo is the app icon's mark (`public/logo.svg`, inline in
  `Logo.astro`): a citrus arch holding a light dot (on the light theme a
  deeper citrus arch and a dark dot, `--logo-*`). The favicon
  (`favicon.svg`) is the mark itself on a transparent background, its
  colours switching with `prefers-color-scheme` inside the SVG;
  `apple-touch-icon.png` and `icon-512.png` (og:image) are the light mark on
  a plain `#f3f3ef` square. The graphite app icon is the gallery's, not
  the site's.

## Typography

The platform font (SF Pro, Segoe UI, Roboto; PingFang / Noto Sans SC for
Chinese); `ui-monospace` / SF Mono for code. No webfonts. Base 15px.

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

The chat sits in a card frame of the site's design (a slim bar with the
file name and a "Live" badge, the app on an inset surface; no device
chrome) and follows the page's theme (the player's `?theme=`, then a
message on every change); the gallery's palette has both. The caption says
what runs; Replay reloads it, which plays the scenario again. Entrance
motion only, 620ms `cubic-bezier(.16, 1, .3, 1)`. The copied chat imports
`./clipboard`, a no-op, because this runtime has no `Clipboard` yet;
the playground lists every demo but this one (it compiles single files).

Behind the hero, `HeroField.astro` draws the dot grid on a 2D canvas, mostly
dark and quiet: every dot has a seeded size, brightness and twinkle, and a
slowly drifting value-noise field decides where the grid shimmers. Near the
pointer (or the last touch) a few dots light up more than their
neighbours inside a noise-perturbed reach that trails the pointer a little,
over a small faint halo (140 px, peak alpha 0.06); the field is faint over
the copy. It pauses off
screen and in hidden tabs, draws one static frame with reduced motion,
never takes pointer events, and costs about 0.2 ms a frame (`?fieldperf`
logs it).

## Demo frames

- Demos (`demos/*.tsx`), the hero's chat and the playground follow the
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
- Home copy is the bilingual `copy` object in `src/components/Home.astro`;
  section names and blurbs are in `src/lib/sections.ts`.
- The licence is Apache-2.0; no version number is shown anywhere.
