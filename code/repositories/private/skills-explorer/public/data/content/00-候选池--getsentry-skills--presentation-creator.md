---
name: presentation-creator
description: Create data-driven presentation slides using React, Vite, and Recharts with Sentry branding. Use when asked to "create a presentation", "build slides", "make a deck", "create a data presentation", "build a Sentry presentation". Scaffolds a complete slide-based app with charts, animations, and single-file HTML output.
---

# Sentry Presentation Builder

Create interactive, data-driven presentation slides using React + Vite + Recharts, styled with the Sentry design system and built as a single distributable HTML file.

## Step 1: Gather Requirements

Ask the user:

1. What is the presentation topic?
2. How many slides (typically 5-8)?
3. What data/charts are needed? (time series, comparisons, diagrams, zone charts)
4. What is the narrative arc? (problem → solution, before → after, technical deep-dive)

### Data Assessment (CRITICAL)

Before designing any slides, assess whether the source content contains **real quantitative data** (numbers, percentages, measurements, time series, costs, metrics). Only create Recharts visualizations for slides where real data exists. Do NOT fabricate, estimate, or invent data to fill charts.

- **Has real data** → use a Recharts chart (bar, area, line, etc.)
- **Has no data** → use text-based layouts: cards, tables, bullet columns, diagrams, or quote blocks. Do NOT create a chart with made-up numbers.

If the source content is purely qualitative (narrative, opinions, strategy, process descriptions), the presentation should use zero charts. Recharts and `Charts.jsx` should only be included in the project if at least one slide has real data to visualize.

## Step 2: Scaffold the Project

Create the project structure:

```
<project-name>/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── App.css
    └── Charts.jsx
```

### index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link
      href="https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
      rel="stylesheet"
    />
    <title>TITLE</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

### package.json

```json
{
  "name": "PROJECT_NAME",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "recharts": "^2.15.3" },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.0",
    "vite-plugin-singlefile": "^2.3.0"
  }
}
```

### vite.config.js

```javascript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({ plugins: [react(), viteSingleFile()] });
```

### main.jsx

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
```

## Step 3: Build the Slide System

Read `references/design-system.md` for the complete Sentry color palette, typography, CSS variables, layout utilities, and animation system.

### App.jsx Structure

Define slides as an array of functions returning JSX:

```jsx
const SLIDES = [
  () => ( /* Slide 0: Title */ ),
  () => ( /* Slide 1: Context */ ),
  // ...
];
```

Each slide function returns a `<div className="slide-content">` with:

1. An `<h2>` heading
2. Optional subtitle paragraph
3. Main content (charts, cards, diagrams, tables)
4. Animation classes: `.anim`, `.d1`, `.d2`, `.d3` for staggered fade-in

Do NOT add category tag pills/badges above headings (e.g., "BACKGROUND", "EXPERIMENTS"). They look generic and add no value. Let the heading speak for itself.

### Navigation

Implement keyboard navigation (ArrowRight/Space = next, ArrowLeft = prev) and a bottom nav overlay with prev/next buttons, dot indicators, and slide number. The nav has **no border or background** — it floats transparently. A small low-contrast Sentry glyph watermark sits fixed in the top-left corner of every slide.

```jsx
function App() {
  const [cur, setCur] = useState(0);
  const go = useCallback((d) => setCur((c) => Math.max(0, Math.min(SLIDES.length - 1, c + d))), []);

  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);

  return (
    <>
      {cur > 0 && (
        <div className="glyph-watermark">
          <SentryGlyph size={50} />
          <span className="watermark-title">TITLE</span>
        </div>
      )}
      <div className="progress" style={{ width: `${((cur + 1) / SLIDES.length) * 100}%` }} />
      {SLIDES.map((S, i) => (
        <div key={i} className={`slide ${i === cur ? "active" : ""}`}>
          <div className={`slide-content${i === cur ? " anim" : ""}`}>
            <S />
          </div>
        </div>
      ))}
      <Nav cur={cur} total={SLIDES.length} go={go} setCur={setCur} />
    </>
  );
}
```

## Step 4: Create Charts (Only When Data Exists)

**IMPORTANT: Only create charts for slides backed by real, concrete data from the source content.** If a slide's content is qualitative (strategies, learnings, process descriptions, opinions), use text-based layouts instead (cards, tables, bullet lists, columns). Never invent numbers, fabricate percentages, or generate synthetic data to populate a chart. If you are unsure whether data is real or inferred, do NOT create a chart.

If NO slides require charts, skip this step entirely — do not create `Charts.jsx` or import Recharts.

When real data IS available, read `references/chart-patterns.md` for Recharts component patterns including axis configuration, color constants, chart types, and data generation techniques.

Put all chart components in `Charts.jsx`. Key patterns:

- Use `ResponsiveContainer` with explicit height
- Wrap in `.chart-wrap` div with max-width 920px
- Use `useMemo` for data generation
- **Color rule**: Use the Tableau-inspired categorical palette (`CAT[]`) for distinguishing data series and groups. Only use semantic colors (`SEM_GREEN`, `SEM_RED`, `SEM_AMBER`) when the color itself carries meaning (good/bad, success/failure, warning).
- Common charts: `ComposedChart` with stacked `Area`/`Line`, `BarChart`, custom SVG diagrams
- **Every data point in a chart must come from the source content.** Do not interpolate, extrapolate, or round numbers to make charts look better.

## Step 5: Style with Sentry Design System

Apply the complete CSS from the design system reference. Key elements:

- **Font**: Rubik from Google Fonts
- **Colors**: CSS variables for UI chrome (`--purple`, `--dark`, `--muted`). Semantic CSS variables (`--semantic-green`, `--semantic-red`, `--semantic-amber`) only where color conveys meaning. Categorical palette (`CAT[]`) for all other data visualization.
- **Slides**: Absolute positioned, opacity transitions
- **Animations**: `fadeUp` keyframe with staggered delays
- **Layout**: `.cols` flex rows, `.cards` grid, `.chart-wrap` containers
- **Tags**: `.tag-purple`, `.tag-red`, `.tag-green`, `.tag-amber` for slide labels
- **Logo**: Read the official SVG from `references/sentry-logo.svg` (full wordmark) or `references/sentry-glyph.svg` (glyph only). Do NOT hardcode an approximation — always use the exact SVG paths from these files.

## Step 6: Common Slide Patterns

### Title Slide

Logo (from `references/sentry-logo.svg` or `references/sentry-glyph.svg`) + h1 + subtitle + author/date info.

### Problem/Context Slide

Tag + heading + 2-column card grid with icon headers.

### Data Comparison Slide

Tag + heading + side-by-side charts or before/after comparison table.

### Technical Deep-Dive Slide

Tag + heading + full-width chart + annotation bullets below.

### Summary/Decision Slide

Tag + heading + 3-column layout with category headers and bullet lists.

## Step 7: Iterate and Refine

After initial scaffolding:

1. Run `npm install && npm run dev` to start the dev server
2. Iterate on chart data models and visual design
3. Adjust animations, colors, and layout spacing
4. Build final output: `npm run build` produces a single HTML file in `dist/`

## Output Expectations

A working React + Vite project that:

- Renders as a keyboard-navigable slide deck
- Uses Sentry branding (colors, fonts, icons)
- Contains Recharts visualizations **only for slides with real quantitative data** from the source content — no fabricated data
- Omits `Charts.jsx` and the Recharts dependency entirely if no slides have real data
- Builds to a single distributable HTML file
- Has smooth fade-in animations on slide transitions
