# nsh-gallery-ui

The repository's internal UI layer for the TSX gallery and the website's runnable demos. It composes `nsh/base`
and NSH's elements; it is maintained with these examples, rather than published as an application API.

| File | Owns |
| --- | --- |
| `theme.json` | The canonical light/dark design tokens, referenced by both apps' `nsh.json` |
| `finishes.json` | Surface gradients, shadows and glass finishes used by NSH and HTML |
| `theme.ts` | Reactive palette roles, finish accessors, radii, focus/hover feedback and motion |
| `index.tsx` | Shared buttons, cards, insets, badges, rows, switches, sheets and presentation helpers |
| `segmented.tsx` | The segmented control shared by the gallery and demo inspectors |
| `icons.tsx` | The common line icon set |
| `data-table.ts` | Compact table spacing, resize separators, sort chevrons and selection feedback |
| `slider.ts` | The slider's rail, gradient fill, pill thumb, value column and state feedback |
| `palette.ts`, `demo.ts` | The documentation demos' palette adapter, button/field state helpers, and stage, inspector, panel and log components |
| `css.js` | CSS variables for the website, generated from the same theme and finish data |

The gallery imports through `examples/gallery/ui.tsx`; that file keeps its navigation, sidebar state, branded
header and lazy demo loading. Website demos import through `website/demos/palette.ts`. Those adapters keep
application state outside this layer while existing demo imports keep working.
The website's Vite plugin consumes `css.js`; its page CSS aliases these variables rather than keeping another
palette and another copy of the shared surface finishes.

Add or change a shared visual rule here. Keep layout, interaction and accessibility in `nsh/base`; colors, padding,
borders, surfaces and state feedback belong here. Preserve a component's iconography when changing spacing or
moving its styles. Apps can override the shared parts to demonstrate customization.

Normal builds follow these source imports with the NSH bundler. The website playground's single-module compiler
uses `website/src/lib/inline-gallery-ui.ts`: it includes the imported shared modules in isolated scopes and applies
this same theme before the first render. Changes to shared source should be checked in both the gallery and a
website demo, in light and dark appearance, including the playground.
