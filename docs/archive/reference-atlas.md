# Reference Layout — UI Atlas

> Archived on 2026-07-13. This reverse-engineering snapshot is provenance, not current product design authority.

Systematic reverse-engineering pass of the external reference layout used as the
visual north star for Maka. Built from the extracted bundle at
`/tmp/qoder-extracted/out/renderer/`.

This document is the source of truth for Phase 2 reapplication. Every section is
backed by direct evidence pulled from `assets/globals-UfMzAdiO.css` (265KB
minified, beautified to `/tmp/reference-globals.css` = 8032 lines) and
`index.html`. Where an entry says "from JS chunk", it's a string literal extracted
from `index-C02cm0ok.js`.

**Use the reference's mechanics — never copy product names.** Naming hygiene
rule (memory `project_reference_layout_lane`) requires every artifact in Maka's
codebase use neutral terms ("reference layout", "upstream design"). The product
name appears in this atlas only because it's needed to identify what we're
analyzing; it must not leak into commit messages, JSDoc, or shipped CSS comments.

---

## 1. Theme System

`<html data-theme="...">` carries 8 themes:

| Theme              | Loading bg  | Loading fg  | Notes                                   |
|--------------------|-------------|-------------|-----------------------------------------|
| `light`            | `#ffffff`   | `#09090b`   | Default on Windows/Linux                |
| `dark`             | `#09090b`   | `#fafafa`   |                                         |
| `light-glass`      | transparent | `#09090b`   | macOS default; uses Electron vibrancy   |
| `dark-glass`       | `#171716`   | `#eeeeeb`   |                                         |
| `classic-light`    | `#fafaf9`   | `#171716`   | Warmer neutral                           |
| `classic-dark`     | `#09090b`   | `#fafafa`   |                                         |
| `light-parchment`  | `#FAF9F6`   | `#202116`   | Warm bone canvas                        |
| `dark-parchment`   | `#1E1C18`   | `#FAF9F6`   |                                         |

Initial body fallback (before React mounts): `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`.

macOS default is `light-glass` (transparent + native vibrancy). Maka does **not**
currently use Electron vibrancy — adding it is a separate platform concern.

### Glass theme implication

`light-glass`/`dark-glass` make the window content render against the system
material (translucent panels with desktop bleed-through). The whole page chrome
is calibrated to look correct on a vibrancy substrate. If we adopt `light-glass`
later, all the colors below need an alpha pass too.

---

## 2. Font System

CSS custom props in light-parchment:

| Token              | Value                                                                  |
|--------------------|------------------------------------------------------------------------|
| `--font-ui`        | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'` |
| `--font-sans`      | `ui-sans-serif, system-ui, sans-serif, …emoji fallbacks`                |
| `--font-mono`      | `ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, …` (light) / `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, …` (dark) |
| `--font-body`      | `var(--font-ui)` in sans mode; `'Libre Baskerville', Georgia, 'Songti SC', …` in serif mode |

Plus a downloaded variable: `InstrumentSans-VariableFont_wdth_wght-BjF37L9x.ttf` —
not declared via `@font-face` in the snippet I checked; investigate further if a
specific surface uses Instrument Sans explicitly.

### Font weight scale
- `--font-weight-normal: 400`
- `--font-weight-medium: 500`
- `--font-weight-semibold: 600`
- `--font-weight-bold: 700`

### Type scale (Tailwind v4 defaults)
| Token         | Value      | Px equivalent | Line height                  |
|---------------|------------|---------------|------------------------------|
| `--text-xs`   | `.75rem`   | 12px          | `calc(1 / .75)` = 16px       |
| `--text-sm`   | `.875rem`  | 14px          | `calc(1.25 / .875)` = 20px   |
| `--text-base` | `1rem`     | 16px          | `1.5`                        |
| `--text-lg`   | `1.125rem` | 18px          | `calc(1.75 / 1.125)` = 28px  |
| `--text-xl`   | `1.25rem`  | 20px          | `calc(1.75 / 1.25)` = 28px   |
| `--text-2xl`  | `1.5rem`   | 24px          | `calc(2 / 1.5)` = 32px       |
| `--text-3xl`  | `1.875rem` | 30px          | `1.2`                        |

### Runtime size controller — `data-font-size`

Set on `<html>` via `localStorage.getItem('qoder-work-ui:fontStyle')` / `'…:fontSize'`. Three steps:

| Mode                                              | Chat input  | Prose body  | Code in prose |
|---------------------------------------------------|-------------|-------------|---------------|
| `[data-font-size=small]`                          | 13 / 24     | 13          | 12            |
| `[data-font-size=medium]` (default; `:not([…])`)  | 14 / 24     | (default)   | 13            |
| `[data-font-size=large]`                          | 16 / 28     | 16          | (larger)      |

Default font-style: `sans`. `[data-font-style=serif]` swaps body to `Libre
Baskerville` (Songti SC for CJK).

Maka currently has neither `data-font-size` nor `data-font-style` runtime
controls — those are an unimplemented feature, not a styling miss.

---

## 3. Color Tokens (light-parchment as canonical reference)

Reference uses an Ant-Design-style semantic naming with `--color-bg-*`,
`--color-fill-*`, `--color-text-*`, `--color-border-*`, `--color-link-*` families.
Below is the light-parchment family — the warm-canvas theme that maka's
"reference-layout lane" targets.

### Backgrounds
- `--color-bg-base: #faf9f6` — canvas / page background (warm bone)
- `--color-bg-container: #faf9f6` — primary card background
- `--color-bg-elevated: #f7f4ef` — slightly deeper for elevated surfaces
- `--color-bg-highlight: #c9c4b8` — selected row fill
- `--color-bg-highlight-hover: #d4c9bc` — hover fill (warm taupe)
- `--color-bg-layout: #fdfcfa` — outer shell (sidebar / chrome plate; lightest)

### Fill scale (subtle tints used for chips, sub-panels)
- Tertiary fill: `var(--color-fill-tertiary)` — most subtle (think 4-5% black)

### Borders
- `--color-border` — primary
- `--color-border-secondary` — slightly lighter
- `--color-border-tertiary` — the lightest (used on the workbench card border)

### Light (default) family condensed
- `--color-bg-base: #fff`
- `--color-bg-container: #fff`
- `--color-bg-elevated: #f9f9f9`
- `--color-bg-highlight-hover: #e0e0e0` (or `#eeeeeb`)

### Dark family condensed
- `--color-bg-base: #171716`
- `--color-bg-container: #171716`
- `--color-bg-elevated: #22221f`

Maka's tokens (`maka-tokens.css`) use `oklch()` — semantically equivalent. The
gap is in **the chrome variables** (`--agents-*`) below — those don't exist in
maka.

---

## 4. Page Architecture Tokens (THE critical findings)

### Content area tokens
- `--agents-content-area-radius: 6px` — the universal corner radius for cards,
  panels, content area outer ring. **Six pixels, not 10-12.**
- `--agents-content-area-gap: 4px` — the gap between sibling cards / panels.
  **Four pixels.** Cards sit very close, almost touching.
- `--agents-content-area-bg` — `var(--color-bg-container)` in default/dark,
  `#fff` in light, `transparent` in glass themes
- `--agents-layout-bg` — `var(--color-bg-layout)` for shell; in glass:
  `#0006` (dark) / `#ffffff80` (light); in parchment: a 172° linear gradient
  from `--color-fill-tertiary` to `--color-bg-container`

### The page layout DOM (inferred from CSS selectors)

```
[data-agents-page]                              ← root, theme-scoped
  └── .agents-layout-root
       └── .agents-layout-body
            ├── (left sidebar, sometimes glass material)
            └── .agents-content-area            ← right column / main pane
                 └── [data-agents-view=cron|skills|chat|im_hub|new_chat]
                      └── .agents-inner-view-clamp   ← THE page card itself
                           ├── (page header / hero)
                           └── content (workbench-split-root, dual-card-row, etc.)
```

### The signature card chrome

When **`light-parchment` / `dark-parchment` theme** + view is `skills` / `cron` /
`im_hub` (the three "wide" views, vs chat which is a centered conversation
column), `.agents-inner-view-clamp` paints as the lifted page card:

```css
border: 1px solid var(--color-border-tertiary);   /* often 50-60% via color-mix */
border-radius: var(--agents-content-area-radius); /* 6px */
min-width: 350px;
```

### Layout primitives inside the page card

- `.workbench-split-root` / `.workbench-split-view` — split-pane container
  (uses resizable panels; `gap: var(--agents-content-area-gap)` = 4px)
- `.agents-dual-card-row` — alternative dual-card row
- `.workbench-card` — content card inside the split
- `.aux-panel` — sibling card / sub-panel
- `.task-monitor-right-panel` — special right-side monitor variant (no border /
  no shadow / `--color-fill-tertiary` background to recede)

### The universal card recipe

```css
border: 1px solid var(--color-border-tertiary);
border-radius: var(--agents-content-area-radius);  /* 6px */
background: var(--color-bg-base);
box-shadow: 0 1px 2px #0c0c0d0a;                   /* black @ ~4% */
```

This is the formula for `.workbench-card`, `.aux-panel`, and
`.agents-chat-panel`. It is the **single most-reused look** in the bundle and
the gap with maka — maka's cards have 8-10px radii, 0.04 foreground shadows,
and use `var(--border)` (more like `--color-border-secondary`). Visually maka's
cards read as "bigger / softer / more isolated" than reference's tight 6px /
hairline-tertiary cards.

### The `--agents-layout-bg` (sidebar / chrome) — flat, NOT gradient (corrected 2026-06-24)

```css
background: var(--color-bg-container);
```

**This section originally claimed a 172° linear-gradient.** Corrected
2026-06-24 (WAWQAQ msg `5d3b10e5` + `1e693dee`): the reference product
actually renders a flat `--color-bg-container` here. The gradient I
extracted from the bundle CSS *was* present, but only as a leftover
in the source — the production app doesn't render it. Following the
stale extracted CSS reintroduced the gradient into maka's
`.maka-shell-2col` and `--agents-layout-bg` tokens, which WAWQAQ
flagged as wrong:

> 谁让你他妈的用渐变的啊？参考实现就没有啊

PR-CHAT-CHROME-FIX-0 (`ed292897`) reverted both maka tokens to flat
`var(--background)` / `var(--color-bg-container)`. **Future agents:
do NOT re-add this gradient based on RE evidence; the user's
observable ground truth is flat.**

---

## 5. Shadow Vocabulary (curated; 5 patterns)

The bundle has hundreds of `box-shadow:` declarations, but they reduce to these
5 patterns:

| Pattern                                            | Use                                |
|----------------------------------------------------|-----------------------------------|
| `box-shadow: 0 1px 2px #0c0c0d0a`                  | **Universal card lift** (the only shadow on default cards) |
| `box-shadow: 0 6px 20px -12px #0c0c0d33`           | Medium float (popovers, sticky panels) |
| `box-shadow: 0 8px 24px -16px #0000006b`           | Deep float (dark mode equivalent) |
| `box-shadow: 0 4px 12px #00000026`                 | Anchored anchored alerts |
| 3-layer triple-glow (10px wing-out variants)       | Composer hero glow (multiple tints) |

Notes:
- `#0c0c0d0a` = `rgba(12, 12, 13, 0.04)` — about 4% black.
- All non-glow shadows use plain hex with alpha suffix (not `rgba(…)`), keeping
  the declarations short.

Maka uses `oklch(from var(--foreground) l c h / 0.04)` style alpha shadows
mostly — semantically the same lift, just expressed via oklch. The numeric gap:
maka's lift cards use 0.10 in the second shadow layer (per `da1a40f1` removal).
Reference would have used the `0 1px 2px` 4% only and let the 1px border do
the visual separation.

---

## 6. Keyframes (all 13)

| Keyframe                          | Spec (from earlier samples)                                                   |
|-----------------------------------|------------------------------------------------------------------------------|
| `agents-fade-in`                  | 200ms ease-out opacity 0→1                                                   |
| `agents-slide-up`                 | 200ms translateY 8px → 0 with opacity 0→1                                   |
| `streaming-fade-in`               | `.18s ease-out` opacity 0→1 (per-token fade on streaming Markdown)          |
| `workbench-card-scale-in`         | `.35s cubic-bezier(.16,1,.3,1) .15s both` scale .97→1, opacity 0→1         |
| `chat-input-glow-pulse`           | `4.8s ease-in-out infinite` (composer ambient breathing — already ported)    |
| `indeterminate-slide`             | `1.4s ease-in-out infinite` `left -40% → 100%` (indeterminate progress bar) |
| `pointer-poke`                    | `4s linear infinite`, micro-shake to draw cursor attention                    |
| `pulse`                           | `2s cubic-bezier(.4,0,.6,1) infinite` (Tailwind built-in)                    |
| `spin`                            | `1s linear infinite` (Tailwind built-in)                                     |
| `chroma-slide`                    | Color shift on tiled chrome (not yet sampled)                                |
| `connectors-lightning-pulse`      | Connector banner emphasis                                                    |
| `industry-guide-marquee`          | Horizontal marquee for the industry-guide page                               |
| `agents-chat-design-launch-narrow`| Chat hero launch (likely the empty-chat slide-up sequence)                   |

**Already ported into maka:**
- `agents-fade-in` → kept as ambient utility
- `agents-slide-up` → `maka-message-row-enter` (rounds 24/30) and `maka-hero-enter` (round 29/30)
- `workbench-card-scale-in` → `maka-tool-card-enter` (round 23/30)
- `chat-input-glow-pulse` → `maka-composer-glow-pulse`

**Not yet ported (good Phase 2 candidates):**
- `streaming-fade-in` — would be a real per-token fade in streamed Markdown
- `indeterminate-slide` — loading bar for retry / pending states
- `chroma-slide` / `connectors-lightning-pulse` — non-core, skip
- `industry-guide-marquee` — non-applicable (no Maka counterpart)

---

## 7. Page-Level Component Names (from JS chunks)

Strings literal-grep'd from `index-C02cm0ok.js`. These are React component or
className tokens — useful for naming Maka equivalents.

| Reference string                            | Likely surface                                  |
|---------------------------------------------|------------------------------------------------|
| `agents-settings`                           | Settings page root                              |
| `agents-settings-page-heading`              | Settings page H1                                |
| `agents-settings-page-title-narrow`         | Settings page H1 (narrow viewport variant)      |
| `agents-settings-page-description`          | Settings page lede                              |
| `workbench-aux-stack-from-panel-layout`     | Aux panel stack adapter                         |
| `workbench-root-from-panel-layout`          | Main workbench wrapper                          |
| `workbench-tab`                             | Tab control variant                             |
| `cron-tasks`                                | Cron page tasks list                            |
| `skills-navigation`                         | Skills page nav                                 |
| `agents-rename-subchat`                     | Inline rename overlay                           |

The settings page has a dedicated heading/description block (per the H1 + lede
hierarchy below). Cron page has a `cron-tasks` content area for the actual
schedule list.

---

## 8. Data attribute selectors (state vocabulary)

Reference uses `[data-*]` heavily for state. Subset relevant to Maka:

- `[data-agents-page]` — root scope guard (theme-aware blocks)
- `[data-agents-view=cron]` / `[data-agents-view=skills]` / `[data-agents-view=chat]` / `[data-agents-view=new_chat]` / `[data-agents-view=im_hub]` — current route
- `[data-active=true]` — list selection
- `[data-disabled=true]` / `[data-disabled]` — interaction disabled
- `[data-focused=true]` — focus-within (used on the composer)
- `[data-font-size=small|medium|large]` / `[data-font-style=sans|serif]` — runtime typography
- `[data-glass-effects=off]` — disables vibrancy / backdrop blur
- `[data-composer-message]` — composer rich-text shell
- `[data-user-bubble]` — user message bubble (in chat)
- `[data-chat-launch-transition=design]` — initial chat launch animation flag
- `[data-skills-banner]` / `[data-skill-filter-menu]` — skills page chrome
- `[data-canvas-dialog]` / `[data-close-button]` — modal chrome
- `[data-gradual-blur-layer]` — blur scrim
- `[data-banner-logo]` — Settings banner logo

Maka mostly uses `[data-active="true"]` on list rows. There's no `[data-agents-view]` route attribute — module switching uses local React state, not a documented DOM contract. Adopting `[data-agents-view]` would make CSS targeting easier.

---

## 9. Specific gap analysis: Maka vs reference

| Surface              | Reference recipe                                            | Maka current                                                | Gap to close in Phase 2                              |
|----------------------|-------------------------------------------------------------|-------------------------------------------------------------|------------------------------------------------------|
| Page card outer      | 1px `--color-border-tertiary` + 6px radius + `0 1px 2px #0c0c0d0a` | flat (no border / no shadow after da1a40f1)                 | Restore the lift, but tight 6px radius (was 10)      |
| Inter-card gap       | 4px (`--agents-content-area-gap`)                           | 10-14px gap                                                 | Tighten to 4-6px                                     |
| Card shadow          | `0 1px 2px` 4% only — no second softer layer                | Used to have 2-layer (0 1px 2px + 0 8px 24px -16px 10%)     | Single 4% lift; let border do the separation         |
| Sidebar / chrome bg  | Flat `--color-bg-container` (corrected 2026-06-24)         | Flat `--background` (parity)                                | **None — do NOT add a gradient (see §4.5 correction)** |
| Cron page heading    | (Need to extract — JS chunk has `cron-tasks` block)         | h2 24px / 650                                               | Likely larger / display weight                       |
| Settings page        | `agents-settings-page-heading` + lede + `narrow` variant    | Modal popup (still!)                                        | Restructure as inline page in module-main pane       |
| Active list fill     | `var(--color-bg-highlight)` = `#c9c4b8` (warm taupe)        | `oklch(from --foreground l c h / 0.07)` (neutral gray)      | Optional: warm taupe in parchment theme              |
| Glass theme          | Vibrancy + `data-glass-effects` toggle                     | Not implemented                                             | Out of UI scope (Electron platform work)             |
| `data-font-size` ctl | Runtime small / medium / large                              | Not implemented                                             | Future settings surface                              |
| Streaming tokens     | `streaming-fade-in` per-token                               | Bubble-level fade only                                      | Would need ChatMarkdown renderer wrap                |

---

## 10. Phase 2 plan (atlas-driven)

Goal: rewrite Maka's **Plan/Reminder** page and **Settings** surface to match
reference's signature card chrome + heading hierarchy + tight 4-6px geometry.

### 10.1 Plan/Reminder page (ScheduledTaskPanel)
- Wrap content in a `.maka-page-card` matching the universal recipe (1px
  border-tertiary + 6px radius + 4% lift), with `--agents-content-area-gap`
  equivalent at 4-6px between internal sections.
- Heading: change `.maka-scheduled-task-heading h2` from 24/650 to 30px / weight-600
  (reference uses `--text-3xl` for page headings).
- Internal sections render as workbench-card-style sub-cards: 1px border, 6px
  radius, soft lift. Card-vs-card gap = 4-6px.
- Task list = aux-panel pattern: per-row 1px divider (`border-bottom` on
  `:not(:last-child)`), no per-row border or radius (cockpit-mode density per
  taste skills).

### 10.2 Settings (currently a modal!)
- Convert from Base UI Dialog overlay to an inline `.maka-module-main` view.
- Header: `.maka-page-heading` (30px display) + lede paragraph + narrow variant
  (`-title-narrow`) for tighter sidebar widths.
- Nav: left rail (current modal nav) → keep, but as part of a 2-column
  workbench-split-root inside the page card.
- Content panel: right side workbench-card; sub-sections divided by
  `border-bottom` lines, not nested cards.

### 10.3 Shared primitives (CSS-only first)
- Add `.maka-card-base` mixin via custom property: a single rule that defines
  the recipe (1px border-tertiary, 6px radius, 4% lift). Compose into
  `.maka-skill-library`, `.maka-scheduled-task-shell`, future settings page.
- Add `.maka-page-heading` typography class (30px / 1.2 line / weight 600).
- Optionally add `[data-maka-view=plan|skills|settings|...]` on a wrapper to
  match reference's `[data-agents-view]` pattern.

### 10.4 Out of Phase 2 scope (file follow-ups)
- Glass theme + Electron vibrancy
- `data-font-size` / `data-font-style` runtime controls
- Streaming-fade-in per-token (requires Markdown renderer surgery)
- The warm taupe `--color-bg-highlight` (parchment-only)

---

## 11. Source pointers (where evidence lives)

- `/tmp/qoder-extracted/out/renderer/index.html` — DOM bootstrap, theme bootstrap, font preload
- `/tmp/reference-globals.css` — beautified CSS (multi-line)
- `/tmp/qoder-extracted/out/renderer/assets/globals-UfMzAdiO.css` — original minified CSS
- `/tmp/qoder-extracted/out/renderer/assets/index-C02cm0ok.js` — main JS bundle (component names live here)
- `/tmp/qoder-extracted/out/renderer/assets/chat-view-inner-Dgjr-1Tu.js` — chat view chunk
- `/tmp/qoder-extracted/out/renderer/assets/chat-markdown-renderer-C-R6Fd8_.js` — Markdown chunk

Grep patterns used for this pass (re-runnable):
```sh
# CSS custom props
grep -E '^[[:space:]]*--[a-z][a-z0-9-]+:' /tmp/reference-globals.css | sort -u
# All keyframes
grep -oE '^[[:space:]]*@keyframes [a-zA-Z][a-zA-Z0-9-]+' /tmp/reference-globals.css | sort -u
# All shadow patterns
grep -oE 'box-shadow:[^;}]+' /tmp/reference-globals.css | sort -u
# Page-level class strings from JS
grep -oE '"(agents|workbench|aux|cron|skills|settings)-[a-z-]+"' /tmp/qoder-extracted/out/renderer/assets/index-C02cm0ok.js | sort -u
```

---

## 12. Deep-RE Addendum (Phase 1 follow-up)

Additional findings from a second pass focused on JS chunk component naming,
secondary entry-point HTMLs, and the data-* state vocabulary. Builds on §1–§11.

### 12.1 Secondary entry-point HTMLs

The bundle ships 4 secondary HTML entry points beyond `index.html`:

| File                       | Lines | Role                                              |
|----------------------------|-------|---------------------------------------------------|
| `quickpick.html`           | 58    | Floating spotlight-style command bar (transparent body, vibrancy-aware, own renderer bundle `quickpick-CilslRnn.js`) |
| `voice-overlay.html`       | 39    | Voice transcription overlay (Whisper-style)       |
| `artifact-preview.html`    | 34    | Sandboxed artifact preview surface                |
| `mcp-app-preview.html`     | 33    | Sandboxed MCP app preview surface                 |

Quickpick deserves special attention: `html, body, #root` all get
`background: transparent !important` and a system-font fallback. The window
chrome (corners, shadow) is owned by the **Electron window** itself, not CSS —
they pad nothing and rely on `setVibrancy(theme)` for material rendering. This
is a strong signal that the reference layout's "premium floating chrome" is
half CSS and half native window-level treatment. Maka has no quickpick-equivalent.

### 12.2 Data-* state vocabulary (beyond §8)

A second sweep through the JS bundle surfaced the **structural** data-attrs
the reference layout uses for layout state. These are CSS hooks the
component tree sets imperatively, not user state:

- `[data-resizable-sidebar]` — sidebar is resizable (drag handle present)
- `[data-sidebar-collapse-button]` — the collapse toggle button
- `[data-sidebar-collapsed]` — current collapse state
- `[data-sidebar-content]` — sidebar content slot
- `[data-workbench-root]` — workbench tree root
- `[data-workbench-stack]` — vertical card stack inside workbench
- `[data-workbench-card]` — individual workbench card
- `[data-workbench-fixed-panel-child]` — non-resizable child panel
- `[data-panel-name]` — named panel (for the resizable react-panel lib)
- `[data-settings-nav-column]` — Settings left-nav column
- `[data-canvas-dialog]` — canvas-style dialog (probably used for full-bleed previews)
- `[data-banner-logo]` — branded banner logo slot

The pattern: structural state is on `data-*`, theming is on
`[data-theme=…]`, route is on `[data-agents-view=…]`. CSS targets the
data-attrs heavily, components don't carry presentation classes —
they wear semantic classes (e.g. `settings-nav-column`) AND set
their parent's `data-*` for the CSS targeting layer to see.

Maka mostly uses regular className prefixes (`.maka-*`). Adopting
`data-*` state would let us write tighter CSS without prop drilling
classNames through every component.

### 12.3 Telemetry naming as a structure proxy

The JS bundle also contains telemetry event names (underscore-separated:
`cron_run_log_view_conversation`). These reveal the **surface granularity**
the reference team thinks in. A few patterns worth knowing:

- **Cron page surfaces:** `cron_page_view` / `cron_task_create` /
  `cron_task_update` / `cron_toggle_enabled` / `cron_run_now` /
  `cron_run_log_detail_view` / `cron_run_log_rerun` /
  `cron_run_logs_filter` / `cron_run_logs_tab_view` /
  `cron_sort_change` — there are multiple top-level surfaces:
  task list, run logs, log detail, plus filter/sort.
- **Settings page surfaces:** `settings_tab_view` / `settings_tab` /
  `settings_general_section` / `settings_preferences` /
  `settings_profile_tab_view` / `settings_app_update_check_click` /
  `settings_legokit_tab` / `settings_general_hidden_entry_unlock` —
  Settings has *tabs* (not the single rail Maka has), with
  Profile / General / Preferences / LegoKit (their term for skills/extensions)
  as top-level. The hidden-entry unlock is a 5-click easter egg.
- **Sidebar:** `sidebar_chat_group_set` / `sidebar_chat_group_delete` /
  `sidebar_chat_group_dissolve` / `sidebar_chat_group_toggle` /
  `sidebar_workspace_group` / `sidebar_im_session` /
  `sidebar_cron_group` — sidebar supports nested groups (workspace,
  chats, IM channels, cron). Maka's sidebar is flat.

Maka has none of the group-nesting in its sidebar. The reference layout
keeps an entire IM-hub and a workspace-group structure that Maka would
need new IPC + data model to support — out of pure-UI scope, but worth
noting that **the reference sidebar is materially more structured**.

### 12.4 Streaming + indeterminate keyframe specs (ready to port)

Two keyframes I flagged in §6 as worth porting, with exact specs verified:

```css
@keyframes streaming-fade-in {
  0%   { opacity: 0; }
  100% { opacity: 1; }
}
.streaming-token-fade-in {
  animation: 0.18s ease-out forwards streaming-fade-in;
}
```
Per-token fade on Markdown stream — wrap each streamed token in a span
with `.streaming-token-fade-in`. Requires Markdown renderer surgery in
Maka's chat-markdown-renderer to wrap each delta in a span; skipping
for now to avoid renderer risk. Adding the keyframe + utility class
so the wrapping can happen later without another atlas pass.

```css
@keyframes indeterminate-slide {
  0%   { left: -40%; }
  100% { left: 100%; }
}
.animate-indeterminate {
  animation: 1.4s ease-in-out infinite indeterminate-slide;
}
```
Indeterminate progress bar — needs a container with `overflow: hidden`
and a child of `width: 40%; position: absolute; top: 0; bottom: 0;`
applying the animation. Useful for: retry-load pending state, action
in-flight in modal footers, scheduled-task run-now in-flight.

### 12.5 Heading + lede typography (settings page)

Three settings-specific typography classes surfaced in the JS bundle:

- `.agents-settings-page-heading` — page H1 (no exact size sampled; per
  the type-scale and convention this is `--text-3xl` = 30px / 600 with
  tight tracking)
- `.agents-settings-page-title-narrow` — narrow-viewport variant
  (probably `--text-2xl` = 24px when sidebar is at full width)
- `.agents-settings-page-description` — lede paragraph under the H1
  (probably `--text-sm` = 14px with `--color-text-secondary`)

Maka's `.settingsHeader h1` is currently 30/600 after Phase 2B — already
matches. The `-narrow` responsive variant doesn't exist in Maka; could
add via `@media (max-width: 1100px)` (atlas-style).

### 12.6 Updated Phase 2 plan (revised after deep RE)

Phase 2C (next big PR): wire the deep findings into code.

**Done so far:**
- Atlas §1–§11 (Phase 1 commit `fe74d870`)
- Plan + Skills page card + display heading + token system (Phase 2A `81b180d2`)
- Settings page chrome card recipe + display heading (Phase 2B `753ae8e0`)

**Phase 2C scope:**
- a) Port `streaming-fade-in` + `indeterminate-slide` keyframes + utility
     classes (Atlas §12.4) — CSS only, no JSX wiring; future PRs can use
     them on streamed tokens / loading bars.
- b) Apply page-card recipe to chat composer card outer chrome
     (`.composer .maka-composer-inner` → 6px radius + hairline border +
     1px inner highlight + 4% lift).
- c) Apply page-card recipe to Plan/Reminder sub-sections (alert hero,
     tabs panel, template strip) so each acts as a workbench-card-style
     aux-panel with 4-6px gaps between siblings (atlas `--card-gap: 4px`).
- d) Settings: add the `-narrow` responsive variant per §12.5.
- e) Settings: apply the page-card recipe to internal sub-cards
     (preferences sections, profile card) so they read as aux-panels
     instead of flat dividers.

**NOT in Phase 2C (deferred):**
- f) Real Settings Modal → inline-page restructure (main.tsx render tree
     change, requires focus-trap / a11y rework, deserves a focused PR).
- g) `data-*` state vocabulary refactor (atlas §12.2) — too invasive,
     touches every component file.
- h) Sidebar group-nesting (workspace / IM channels) — needs new IPC
     + data model, out of pure-UI scope.
- i) Wrap streamed Markdown tokens in `.streaming-token-fade-in` (needs
     renderer surgery; the CSS lands in 2C so future wiring is one-line).

---

## 13. Deep-RE Round 3 — Sidebar, Composer, Banners, Resize Handle

Follow-up after WAWQAQ msg f31b4611 ("还是多研究 参考布局 的代码 和前端
设计，一定要深入挖掘他们的设计和代码"). Three days into the RE program
and most surface-level patterns are caught (atlas §1–§12). This round
focuses on the structural state machines and the smaller specialized
chrome we haven't yet decoded.

### 13.1 Sidebar — two-mode chrome system

The reference sidebar has two distinct visual modes the renderer
swaps between at run-time:

- **Standard / glass-vibrancy mode (default in glass themes):**
  the sidebar renders edge-to-edge against the OS vibrancy material.
  CSS rules under `[data-agents-page] [data-resizable-sidebar].agents-sidebar`
  set `contain: layout paint style` for performance isolation.
- **`agents-sidebar-floating-glass` mode (parchment themes):**
  opaque `--color-bg-container` background + 1px `--color-border-tertiary`
  border + `box-shadow: none` + `-webkit-backdrop-filter: none`. This is
  the "card-style sidebar" pattern — sidebar reads as a lifted card on
  the warm parchment canvas, not a translucent panel.

This is the answer to "how to support warm parchment themes alongside
glass themes": the SAME sidebar component conditionally applies
`.agents-sidebar-floating-glass` based on `data-theme=light-parchment` /
`dark-parchment`. The class lights up via CSS theme matching, not
runtime branching.

Sidebar resize: rendered via the `react-resizable-panels` library
(`[role=separator]` + `data-resize-handle-active`).

- `[role=separator]` always has `background-color: transparent !important`
  and `box-shadow: none / outline: none` on `:focus-visible`. The
  resize affordance lives in JS hit-region, not visible chrome — the
  user only sees the column edge.
- `[data-resizing=true]` on the sidebar drops `box-shadow` while
  dragging so the "lift" doesn't get janky during column drag.

`.sidebar-section-title` (the small group label inside the sidebar)
uses `var(--color-text-quaternary)` (a faint 4th-tier text color that
maka doesn't have). In `color-mix` browsers it gets 90% of that token
+ 10% transparent, so the label fades slightly into the chrome.

### 13.2 Composer — primary glow + 3-layer wing pattern (verified)

`.chat-input-primary-glow` is the composer hero card. Two pseudo-
elements (`::before` and `::after`) each carry a 3-layer wing glow:

- **`::before`** (forward animation):
  - `0 10px 30px -14px var(--color-primary)` (bottom drop, primary)
  - `-18px 0 42px -24px var(--color-primary-hover)` (left wing)
  - `+18px 0 42px -24px var(--color-primary-border)` (right wing)
- **`::after`** (reverse animation):
  - `0 12px 34px -12px var(--color-primary)` (deeper drop)
  - `+20px 0 48px -22px var(--color-primary-hover)` (right wing)
  - `-20px 0 48px -22px var(--color-primary-border)` (left wing)

Both run the `chat-input-glow-pulse` keyframe at 4.8s ease-in-out
infinite. Maka has the same glow ported as `maka-composer-glow-pulse`
(2 layers via `::before` and `::after`); the wing-direction
alternation is the magic that makes the composer feel "alive" rather
than "blinking". Verifying maka's port — it uses the SAME pattern
already (looked back at styles.css), with the `--accent` token in
place of `--color-primary`. Good parity.

Composer in parchment theme has its own glow palette via:
- `--chat-input-parchment-glow` = primary glow color
- `--chat-input-parchment-halo` = mid-range halo (uses `--color-warning`
  in parchment, so the glow reads as warm amber, not cold blue)
- `--chat-input-parchment-edge` = far-wing edge (uses `--color-link`)

Maka doesn't have a parchment-specific composer palette — the
composer glow uses `--accent` regardless of theme. If we adopt the
parchment theme later, the composer should get warm-amber glow
overrides per the reference.

### 13.3 Banners — three animated mascot families

Three distinct banner families, each with their own mascot animation:

- **`[data-skills-banner]`** — Skills page hero. In parchment themes:
  `background-color: var(--color-fill-tertiary)` (subtle warm wash).
  Hosts the `.animate-pointer-poke` SVG mascot (4s linear infinite
  micro-shake — atlas §6 keyframe).
  - Inner SVG attribute rewrites in parchment theme:
    `[data-banner-logo], [data-skill-deco-cover]` get
    `[fill*=color-primary]` → `var(--color-fill-secondary)` and
    `[stroke*=color-primary-border]` → `var(--color-border-tertiary)`.
    This neutralizes the brand-blue to a parchment-friendly neutral.
- **`[data-connectors-banner-visual]`** — Connectors page hero. Has
  `[data-connectors-lightning]` SVG inside it pulsing on the
  `connectors-lightning-pulse` keyframe (1.4s ease-in-out infinite).
  Same parchment color rewrite pattern.
- **`[data-plugins-banner]`** — Plugins page hero with multi-part
  mascot: `[data-plugins-banner-mascot-body]`,
  `[data-plugins-banner-mascot-hand]`, `[data-plugins-banner-tags-layer]`,
  `[data-plugins-banner-dynamic-visual]`. Each animates independently
  for a layered character animation. Could not extract exact specs in
  this pass; complex enough to deserve a dedicated note PR.

Maka has no equivalent banner mascots. They are a meaningful visual
hook the reference uses on hero pages; porting one (e.g., a Skills
mascot) would close a real "delight" gap, but requires custom SVG
illustration assets the maka team would need to commission.

### 13.4 Theme-tinted brand motion (`[data-parchment-brand-motion]`)

A specific attribute on any element that does its own brand motion
animation (Lottie / SVG): in parchment themes, get
`filter: hue-rotate(-85deg) saturate(.65)`; in dark themes (dark,
dark-glass, classic-dark), get `filter: brightness(.8)`. This is how
the reference's mascots stay on-palette across all 8 themes without
the Lottie author hand-tinting every variant.

Maka could adopt: any third-party brand motion (e.g., the loader.gif
under `apps/desktop/assets/`) could pick up a `data-brand-motion`
attribute and these filter rules so it auto-tints with theme. Tiny
patch, high payback if we adopt mascots later.

### 13.5 Selectable text marker

`.allow-text-selection { user-select: text !important }` — explicit
class for surfaces where the user must be allowed to text-select
(e.g., assistant Markdown body). Maka mostly defaults to selectable;
the reference flips the default to "non-selectable" globally
(probably for the chrome) and opts in with `.allow-text-selection`.
This is the reverse policy from Maka but probably worth aligning on
the chrome side (sidebar / nav rows / chips) since `user-select: none`
on those would prevent accidental text-select on click-drag.

### 13.6 Settings sidebar slot `.agents-settings-wide-content`

`.agents-settings-wide-content { background: var(--agents-content-area-bg);
margin: var(--agents-content-area-gap) var(--agents-content-area-gap)
var(--agents-content-area-gap) 0 }` — the content slot inside Settings
that holds each sub-page (Profile / General / Preferences / etc.).
The margins use the `--agents-content-area-gap` (4px) token so the
content slot has a 4px gap on top/bottom/right (left is 0, the nav
column is flush). This is the "Settings tab content fits inside the
page card" pattern — exactly what maka should adopt when it does the
Phase 2C Settings inline restructure.

### 13.7 Updated defer list (post-§13)

Items to consider for a Phase 3 PR after WAWQAQ verdict:
- Adopt `.agents-sidebar-floating-glass` pattern for parchment-mode
  sidebar (opaque card variant) — pure CSS + a `data-theme` selector.
- Adopt `[data-parchment-brand-motion]` theme-tint pattern for any
  loader / mascot we ship later — 4 lines of CSS, no JS.
- Port the `[data-banner-logo]` SVG color-rewrite pattern for any
  brand-colored SVG so it auto-neutralizes in parchment themes.
- Adopt the `.allow-text-selection` opt-in policy on chrome surfaces
  so click-drag on a nav row doesn't begin a text selection.
- Use `--agents-content-area-gap` (4px) consistently for Plan/Skills
  sub-section gaps (we currently use 14px; the reference's 4px reads
  much tighter, matching the dense-cockpit aesthetic).

---

## 14. Deep-RE Round 4 — Settings palette, popovers, Settings layout (§14)

Continuing after WAWQAQ msg 7f3ca067 ("继续学习…多解决现有前端的问题，设计 布局的问题").

### 14.1 Settings has its own primary-color palette

When the renderer sets `[data-modal=agents-settings]` on the Settings
surface, the reference applies a palette OVERRIDE:

- Light / light-glass / classic-light / **default**:
  - `--color-primary: #8ee5a1` (mint green)
  - `--color-fill-secondary: #ebebeb` (warm gray)
  - `--color-text-on-primary: #fdfdfd`
- Light-parchment:
  - `--color-primary: #202116` (deep charcoal — almost off-black)
  - `--color-fill-secondary: #ede8e0` (parchment cream)
- Dark themes: tokens come from `--color-bg-container` / `--color-text`
  family (no warm primary override).

**This is a meaningful design choice the reference team made:** Settings
feels visually DISTINCT from chat because its primary accent is mint
green instead of brand blue. A user clicking "Save" or "Apply" in
Settings sees a mint-green CTA — semantically distinct from a Chat
submit (brand blue). It's a subtle but premium pattern.

**Maka uses `var(--accent)` everywhere**, including Settings. Adopting
a Settings-only `data-surface=settings` token override would close
this gap. ~10 lines of CSS.

### 14.2 Sidebar background bypass for Settings

When Settings is open and the theme is `light-parchment` /
`dark-parchment` / `classic-light`:
- `aside[data-settings-nav-column].agents-sidebar > div { background: 0 0 }`
- `html[data-theme=light-parchment] .agents-layout-root .agents-sidebar
  { background: 0 0 !important }`

So the Settings nav column has NO background — it inherits from the
Settings modal palette. Maka's Settings nav has its own
`.settingsNavGroup` chrome; could simplify to inherit too.

### 14.3 Popover side-translate pattern (Tailwind data-* variants)

Reference uses Tailwind v4's data-attribute variants extensively for
popover positioning:

```
.data-[side=top]:-translate-y-1[data-side=top] { translate: 0 -4px; }
.data-[side=bottom]:translate-y-1[data-side=bottom] { translate: 0 4px; }
.data-[state=open]:bg-fill-secondary[data-state=open] { background: var(--color-fill-secondary); }
```

So Base UI (or Radix-style) primitives that set `[data-side=top]`
automatically get the right translate via the Tailwind utility class.
Maka uses Base UI primitives too, but our CSS file has hand-rolled
positioning rules instead of using Tailwind data-* variants. We have
the tooling already (Tailwind v4 is installed); shifting to data-*
variants would unify the pattern and remove ~30 lines of custom CSS.

### 14.4 Selectable text — opt-in policy confirmed

Atlas §13.5 already flagged `.allow-text-selection`. Verified in
reference: it has `user-select: text !important`. The implication
is that the reference's GLOBAL DEFAULT for chrome surfaces is
`user-select: none` — the opposite of Maka, which inherits browser
default (text everywhere). This explains why reference chat looks
"more app-like" while Maka can accidentally enter text selection
mode on chrome clicks.

**Phase 3 candidate** (atlas §13.7): apply `user-select: none` to
`.maka-session-panel`, `.maka-nav-row`, `.maka-list-row`,
`.maka-module-main-header` headings (chrome surfaces only), and
keep text selection on Markdown bodies + composer + readonly content.

### 14.5 Additional polish gaps spotted

- **Reference uses `cmd+k` global** to focus the chat input (`focus-input`
  / `agent-input-history` in JS chunk strings); Maka has `cmd+k` but
  the input doesn't auto-focus on cold open. Cold-open onboarding
  would be smoother.
- **Reference distinguishes `[data-glass-effects=off]` on win32 host**:
  it disables all `backdrop-filter` globally. If we adopt
  `[data-glass-effects=off]` toggle as a Settings option, the user
  can opt out of macOS vibrancy too (some users dislike it). 4 lines
  of CSS + a settings toggle.
- **Reference has `[data-canvas-dialog]`** that overrides the standard
  modal background with `var(--color-bg-container)` — a full-bleed
  preview / artifact dialog variant. Maka doesn't have a canvas-style
  dialog; would be useful for Artifacts pane preview.

### 14.6 Phase 3 expanded scope (now 8 quick wins)

Combining §13.7 + §14:
1. `.agents-sidebar-floating-glass` for parchment-mode opaque sidebar
2. `[data-parchment-brand-motion]` global theme tint
3. SVG color-rewrite pattern (`[fill*=color-primary]` -> token)
4. `.allow-text-selection` opt-in policy reversal
5. Tighten Plan/Skill sub-section gaps 14 -> 4-6px
6. **NEW:** Settings primary-color palette override
   (`data-surface=settings` → mint-green primary)
7. **NEW:** Adopt Tailwind data-* variants for popover side translate
8. **NEW:** `cmd+k` cold-open composer auto-focus
9. **NEW:** `[data-glass-effects=off]` toggle in Settings
10. **NEW:** `[data-canvas-dialog]` variant for Artifacts pane

Items 1-5 are pure CSS, can ship today. Items 6-7 need small JSX
changes. Items 8-10 are bigger (new IPC / new dialog mounting).

---

## 15. Deep-RE Round 5 — Fonts, hero, blur-layer (§15)

Following WAWQAQ msg 500eddc9 ("一定要多做、多分析…深度抄袭和学习 参考
界面 布局"). This round catches typography + visual-effect patterns I
hadn't decoded.

### 15.1 Instrument Sans variable font on hero surfaces

Reference loads a downloaded variable font:
```css
@font-face {
  font-family: Instrument Sans;
  src: url(./InstrumentSans-…ttf) format("truetype");
  font-weight: 1 1000;
  font-display: swap;
}
```

Used only on `.welcome-title` and `.login-title`:
```css
.welcome-title {
  font-variation-settings: "wdth" 100, "wght" 500;
  font-family: Instrument Sans, ui-sans-serif, system-ui, sans-serif;
}
```

When `[data-font-style=serif]` is set, falls back to `--font-body`
(Libre Baskerville).

**Insight**: reference distinguishes hero typography from chrome
typography via a specific variable font with bespoke axes. Maka uses
Geist Variable everywhere — adopting the same distinction WITHOUT
shipping a second font is possible: set
`font-variation-settings: "wght" 550, "wdth" 105` on hero titles to
get the "wider, slightly heavier" feel. This commit applies it to
`.maka-hero h1` / `.emptyChat h1`.

### 15.2 `[data-gradual-blur-layer]` overlay pattern

Reference has a `[data-gradual-blur-layer]` attribute marking a
backdrop-blur scrim element used to fade out content edges (e.g.
under a sticky header). It uses `-webkit-backdrop-filter` directly,
and the `[data-glass-effects=off]` toggle disables it via
`-webkit-backdrop-filter: none !important`.

**Pattern**: a fixed `pointer-events: none` overlay layer at the top
or bottom of a scroll container with a `linear-gradient(transparent
0%, var(--background) 100%)` mask + `backdrop-filter: blur(8px)`
creates a "content fades into chrome" effect. Maka has no equivalent;
adding one on sticky chat headers / sidebar scroll edges would close
a real polish gap.

### 15.3 Font-display swap + Instrument Sans local

Reference's font is shipped at the bundle, loaded with `font-display:
swap`. Best practice for variable fonts in Electron — initial paint
uses the system fallback (`ui-sans-serif, system-ui`) while the
variable font loads from local disk (fast on first run, instant on
subsequent). Maka uses Geist Variable from `@fontsource-variable/geist`
which also self-hosts and uses `font-display: swap` by default.
Aligned by accident; not a gap.

### 15.4 `[data-os=win32][data-glass-effects=off]` per-platform fallback

For Windows users who explicitly disable glass effects via Settings,
reference disables ALL `backdrop-filter` rules globally:

```css
:root[data-os=win32][data-glass-effects=off] [class*=backdrop-blur],
:root[data-os=win32][data-glass-effects=off] [data-gradual-blur-layer],
:root[data-os=win32][data-glass-effects=off] .agents-layout-root,
:root[data-os=win32][data-glass-effects=off] [data-resizable-sidebar].agents-sidebar.agents-sidebar-floating-glass {
  -webkit-backdrop-filter: none !important;
}
```

Maka's `data-os` is set on `<html>` after Phase 2C (atlas §12.1).
Adopting the `data-glass-effects` toggle would let users opt out of
sidebar vibrancy on macOS too — useful for users who find blur
distracting. Pattern: add a Settings toggle that writes
`document.documentElement.dataset.glassEffects = 'off' | 'on'`, gate
the existing sidebar glass CSS rules on `:not([data-glass-effects=off])`.

### 15.5 Phase 5 candidate list (expanded)

Adding to atlas §14.6:
11. Variable-font hero typography (Geist axes) — applied in this commit
12. `[data-gradual-blur-layer]` overlay primitive — ~10 lines of CSS,
    one CSS rule + apply attribute on sticky-header containers
13. `[data-glass-effects]` opt-out toggle — small Settings JSX + CSS
    pattern gating
14. Login surface (Maka has no auth; future surface if we add it)
