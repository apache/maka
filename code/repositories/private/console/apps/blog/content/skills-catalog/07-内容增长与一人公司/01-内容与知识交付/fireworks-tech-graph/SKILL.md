---
name: fireworks-tech-graph
description: >-
  Use when the user wants to create any technical diagram - architecture, data
  flow, flowchart, sequence, agent/memory, or concept map - and export as
  SVG+PNG. Trigger on: "画图" "帮我画" "生成图" "做个图" "架构图" "流程图"
  "可视化一下" "出图" "generate diagram" "draw diagram" "visualize" or any
  system/flow description the user wants illustrated.
---

# Fireworks Tech Graph

Generate production-quality SVG technical diagrams exported as PNG via `cairosvg` (recommended), `rsvg-convert`, or `puppeteer`.

## Install Source

Install this skill from GitHub:

```bash
npx skills add yizhiyanhua-ai/fireworks-tech-graph
```

Public package page:

```text
https://www.npmjs.com/package/@yizhiyanhua-ai/fireworks-tech-graph
```

Do not pass `@yizhiyanhua-ai/fireworks-tech-graph` directly to `skills add`, because the CLI expects a GitHub or local repository source.

Update command:

```bash
npx skills add yizhiyanhua-ai/fireworks-tech-graph --force -g -y
```

## Helper Scripts (Recommended)

Four helper scripts in `scripts/` directory provide stable SVG generation and validation:

### 1. `generate-diagram.sh` - Validate SVG + export PNG
```bash
./scripts/generate-diagram.sh -t architecture -s 1 -o ./output/arch.svg
```
- Validates an existing SVG file
- Exports PNG after validation
- Example: `./scripts/generate-diagram.sh -t architecture -s 1 -o ./output/arch.svg`

### 2. `generate-from-template.py` - Create starter SVG from template
```bash
python3 ./scripts/generate-from-template.py architecture ./output/arch.svg '{"title":"My Diagram","nodes":[],"arrows":[]}'
```
- Loads a built-in SVG template
- Renders nodes, arrows, and legend entries from JSON input
- Escapes text content to keep output XML-valid

### 3. `validate-svg.sh` - Validate SVG syntax
```bash
./scripts/validate-svg.sh <svg-file>
```
- Checks XML syntax
- Verifies tag balance
- Validates marker references
- Checks attribute completeness
- Validates path data

### 4. `test-all-styles.sh` - Batch test all styles
```bash
./scripts/test-all-styles.sh
```
- Tests multiple diagram sizes
- Validates all generated SVGs
- Generates test report

**When to use scripts:**
- Use scripts when generating complex SVGs to avoid syntax errors
- Scripts provide automatic validation and error reporting
- Recommended for production diagrams

**When to generate SVG directly:**
- Simple diagrams with few elements
- Quick prototypes
- When you need full control over SVG structure

## Workflow (Always Follow This Order)

1. **Classify** the diagram type (see Diagram Types below)
2. **Extract structure** — identify layers, nodes, edges, flows, and semantic groups from user description
3. **Plan layout** — apply the layout rules for the diagram type
4. **Load style reference** — always load `references/style-1-flat-icon.md` unless user specifies another; load the matching `references/style-N.md` for exact color tokens and SVG patterns
5. **Map nodes to shapes** — use Shape Vocabulary below
6. **Check icon needs** — load `references/icons.md` for known products
7. **Write SVG** with adaptive strategy (see SVG Generation Strategy below)
8. **Validate**: Run `python3 -c "import xml.etree.ElementTree as ET; ET.parse('file.svg')"` to check XML syntax
9. **Export PNG**: Use `cairosvg` (recommended). See **SVG → PNG Conversion** section below for full method comparison
10. **Report** the generated file paths
11. **(Optional) Visual self-review** — if your runtime can read images, load the exported PNG back and inspect it. Syntactic validity does not guarantee visual correctness: arrows may cross through component interiors, labels may collide with lifelines or other labels, boxes may overlap, alt-frame text may sit on top of a message, or a legend may cover content. If you see any of these, revise the SVG and re-export; repeat until the rendered image is clean. Common fixes:
    - Route arrows through gaps between boxes, not through box interiors
    - Move arrow labels 6-8px away from the arrow line (offset-first); add background rects only when offset is insufficient
    - Widen inter-row/inter-column gutters so same-layer arrows have clear corridors
    - Collapse repeated cross-layer arrows into a single "delegates down" rail outside the content area
    - Move legend/notes out of any region where arrows or labels land
    - Increase viewBox height/width rather than packing elements tighter
    - If a filtered element (drop-shadow, blur) is missing one side of its border, move it ≥30px away from that viewBox edge, or remove the filter and rely on color/contrast for visual separation
  Skip this step silently if image reading is unavailable — do not guess.

## Diagram Types & Layout Rules

### Architecture Diagram
Nodes = services/components. Group into **horizontal layers** (top→bottom or left→right).
- Typical layers: Client → Gateway/LB → Services → Data/Storage
- Use `<rect>` dashed containers to group related services in the same layer
- Arrow direction follows data/request flow
- ViewBox: `0 0 960 600` standard, `0 0 960 800` for tall stacks

### Data Flow Diagram
Emphasizes **what data moves where**. Focus on data transformation.
- Label every arrow with the data type (e.g., "embeddings", "query", "context")
- Use wider arrows (`stroke-width: 2.5`) for primary data paths
- Dashed arrows for control/trigger flows
- Color arrows by data category (not just Agent/RAG — use semantics)

### Flowchart / Process Flow
Sequential decision/process steps.
- Top-to-bottom preferred; left-to-right for wide flows
- Diamond shapes for decisions, rounded rects for processes, parallelograms for I/O
- Keep node labels short (≤3 words); put detail in sub-labels
- Align nodes on a grid: x positions snap to 120px intervals, y to 80px

### Agent Architecture Diagram
Shows how an AI agent reasons, uses tools, and manages memory.
Key conceptual layers to always consider:
- **Input layer**: User, query, trigger
- **Agent core**: LLM, reasoning loop, planner
- **Memory layer**: Short-term (context window), Long-term (vector/graph DB), Episodic
- **Tool layer**: Tool calls, APIs, search, code execution
- **Output layer**: Response, action, side-effects
Use cyclic arrows (loop arcs) to show iterative reasoning. Separate memory types visually.

### Memory Architecture Diagram (Mem0, MemGPT-style)
Specialized agent diagram focused on memory operations.
- Show memory **write path** and **read path** separately (different arrow colors)
- Memory tiers: Working Memory → Short-term → Long-term → External Store
- Label memory operations: `store()`, `retrieve()`, `forget()`, `consolidate()`
- Use stacked rects or layered cylinders for storage tiers

### Sequence Diagram
Time-ordered message exchanges between participants.
- Participants as vertical **lifelines** (top labels + vertical dashed lines)
- Messages as horizontal arrows between lifelines, top-to-bottom time order
- Activation boxes (thin filled rects on lifeline) show active processing
- Group with `<rect>` loop/alt frames with label in top-left corner
- ViewBox height = 80 + (num_messages × 50)

### Comparison / Feature Matrix
Side-by-side comparison of approaches, systems, or components.
- Column headers = systems, row headers = attributes
- Row height: 40px; column width: min 120px; header row height: 50px
- Checked cell: tinted background (e.g. `#dcfce7`) + `✓` checkmark; unsupported: `#f9fafb` fill
- Alternating row fills (`#f9fafb` / `#ffffff`) for readability
- Max readable columns: 5; beyond that, split into two diagrams

### Timeline / Gantt
Horizontal time axis showing durations, phases, and milestones.
- X-axis = time (weeks/months/quarters); Y-axis = items/tasks/phases
- Bars: rounded rects, colored by category, labeled inside or beside
- Milestone markers: diamond or filled circle at specific x position with label above
- ViewBox: `0 0 960 400` typical; wider for many time periods: `0 0 1200 400`

### Mind Map / Concept Map
Radial layout from central concept.
- Central node at `cx=480, cy=280`
- First-level branches: evenly distributed around center (360/N degrees)
- Second-level branches: branch off first-level at 30-45° offset
- Use curved `<path>` with cubic bezier for branches, not straight lines

### Class Diagram (UML)
Static structure showing classes, attributes, methods, and relationships.
- **Class box**: 3-compartment rect (name / attributes / methods), min width 160px
  - Top compartment: class name, bold, centered (abstract = *italic*)
  - Middle: attributes with visibility (`+` public, `-` private, `#` protected)
  - Bottom: method signatures, same visibility notation
- **Relationships**:
  - Inheritance (extends): solid line + hollow triangle arrowhead, child → parent
  - Implementation (interface): dashed line + hollow triangle, class → interface
  - Association: solid line + open arrowhead, label with multiplicity (1, 0..*, 1..*)
  - Aggregation: solid line + hollow diamond on container side
  - Composition: solid line + filled diamond on container side
  - Dependency: dashed line + open arrowhead
- **Interface**: `<<interface>>` stereotype above name, or circle/lollipop notation
- **Enum**: compartment rect with `<<enumeration>>` stereotype, values in bottom
- Layout: parent classes top, children below; interfaces to the left/right of implementors
- ViewBox: `0 0 960 600` standard; `0 0 960 800` for deep hierarchies

### Use Case Diagram (UML)
System functionality from user perspective.
- **Actor**: stick figure (circle head + body line) placed outside system boundary
  - Label below figure, 13-14px
  - Primary actors on left, secondary/supporting on right
- **Use case**: ellipse with label centered inside, min 140×60px
  - Keep names verb phrases: "Create Order", "Process Payment"
- **System boundary**: large rect with dashed border + system name in top-left
- **Relationships**:
  - Include: dashed arrow `<<include>>` from base to included use case
  - Extend: dashed arrow `<<extend>>` from extension to base use case
  - Generalization: solid line + hollow triangle (specialized → general)
- Layout: system boundary centered, actors outside, use cases inside
- ViewBox: `0 0 960 600` standard

### State Machine Diagram (UML)
Lifecycle states and transitions of an entity.
- **State**: rounded rect with state name, min 120×50px
  - Internal activities: small text `entry/ action`, `exit/ action`, `do/ activity`
  - **Initial state**: filled black circle (r=8), one outgoing arrow
  - **Final state**: filled circle (r=8) inside hollow circle (r=12)
  - **Choice**: small hollow diamond, guard labels on outgoing arrows `[condition]`
- **Transition**: arrow with optional label `event [guard] / action`
  - Guard conditions in square brackets
  - Actions after `/`
- **Composite/nested state**: larger rect containing sub-states, with name tab
- **Fork/join**: thick horizontal or vertical black bar (synchronization)
- Layout: initial state top-left, final state bottom-right, flow top-to-bottom
- ViewBox: `0 0 960 600` standard

### ER Diagram (Entity-Relationship)
Database schema and data relationships.
- **Entity**: rect with entity name in header (bold), attributes below
  - Primary key attribute: underlined
  - Foreign key: italic or marked with (FK)
  - Min width: 160px; attribute font-size: 12px
- **Relationship**: diamond shape on connecting line
  - Label inside diamond: "has", "belongs to", "enrolls in"
  - Cardinality labels near entity: `1`, `N`, `0..1`, `0..*`, `1..*`
- **Weak entity**: double-bordered rect with double diamond relationship
- **Associative entity**: diamond + rect hybrid (rect with diamond inside)
- Line style: solid for identifying relationships, dashed for non-identifying
- Layout: entities in 2-3 rows, relationships between related entities
- ViewBox: `0 0 960 600` standard; wider `0 0 1200 600` for many entities

### Network Topology
Physical or logical network infrastructure.
- **Devices**: icon-like rects or rounded rects
  - Router: circle with cross arrows
  - Switch: rect with arrow grid
  - Server: stacked rect (rack icon)
  - Firewall: brick-pattern rect or shield shape
  - Load Balancer: horizontal split rect with arrows
  - Cloud: cloud path (overlapping arcs)
- **Connections**: lines between device centers
  - Ethernet/wired: solid line, label bandwidth
  - Wireless: dashed line with WiFi symbol
  - VPN: dashed line with lock icon
- **Subnets/Zones**: dashed rect containers with zone label (DMZ, Internal, External)
- **Labels**: device hostname + IP below, 12-13px
- Layout: tiered top-to-bottom (Internet → Edge → Core → Access → Endpoints)
- ViewBox: `0 0 960 600` standard

## UML Coverage Map

Full mapping of UML 14 diagram types to supported diagram types:

| UML Diagram | Supported As | Notes |
|-------------|-------------|-------|
| Class | Class Diagram | Full UML notation |
| Component | Architecture Diagram | Use colored fills per component type |
| Deployment | Architecture Diagram | Add node/instance labels |
| Package | Architecture Diagram | Use dashed grouping containers |
| Composite Structure | Architecture Diagram | Nested rects within components |
| Object | Class Diagram | Instance boxes with underlined name |
| Use Case | Use Case Diagram | Full actor/ellipse/relationship |
| Activity | Flowchart / Process Flow | Add fork/join bars |
| State Machine | State Machine Diagram | Full UML notation |
| Sequence | Sequence Diagram | Add alt/opt/loop frames |
| Communication | — | Approximate with Sequence (swap axes) |
| Timing | Timeline | Adapt time axis |
| Interaction Overview | Flowchart | Combine activity + sequence fragments |
| ER Diagram | ER Diagram | Chen/Crow's foot notation |

## Shape Vocabulary

Map semantic concepts to consistent shapes across all diagram types:

| Concept | Shape | Notes |
|---------|-------|-------|
| User / Human | Circle + body path | Stick figure or avatar |
| LLM / Model | Rounded rect with brain/spark icon or gradient fill | Use accent color |
| Agent / Orchestrator | Hexagon or rounded rect with double border | Signals "active controller" |
| Memory (short-term) | Rounded rect, dashed border | Ephemeral = dashed |
| Memory (long-term) | Cylinder (database shape) | Persistent = solid cylinder |
| Vector Store | Cylinder with grid lines inside | Add 3 horizontal lines |
| Graph DB | Circle cluster (3 overlapping circles) | |
| Tool / Function | Gear-like rect or rect with wrench icon | |
| API / Gateway | Hexagon (single border) | |
| Queue / Stream | Horizontal tube (pipe shape) | |
| File / Document | Folded-corner rect | |
| Browser / UI | Rect with 3-dot titlebar | |
| Decision | Diamond | Flowcharts only |
| Process / Step | Rounded rect | Standard box |
| External Service | Rect with cloud icon or dashed border | |
| Data / Artifact | Parallelogram | I/O in flowcharts |

## Arrow Semantics

Always assign arrow meaning, not just color:

| Flow Type | Color | Stroke | Dash | Meaning |
|-----------|-------|--------|------|---------|
| Primary data flow | blue `#2563eb` | 2px solid | none | Main request/response path |
| Control / trigger | orange `#ea580c` | 1.5px solid | none | One system triggering another |
| Memory read | green `#059669` | 1.5px solid | none | Retrieval from store |
| Memory write | green `#059669` | 1.5px | `5,3` | Write/store operation |
| Async / event | gray `#6b7280` | 1.5px | `4,2` | Non-blocking, event-driven |
| Embedding / transform | purple `#7c3aed` | 1px solid | none | Data transformation |
| Feedback / loop | purple `#7c3aed` | 1.5px curved | none | Iterative reasoning loop |

Always include a **legend** when 2+ arrow types are used.

## Layout Rules & Validation

**Spacing**:
- Same-layer nodes: 80px horizontal, 120px vertical between layers
- Canvas margins: 40px minimum, 60px between node edges
- Snap to 8px grid: horizontal 120px intervals, vertical 120px intervals

**Arrow Labels** (CRITICAL):
- **Offset-first** (default): place label 6-8px above horizontal arrows, or 8px left/right of vertical arrows — do not overlap the arrow line
- **Background fallback**: add `<rect fill="canvas_bg" opacity="0.95"/>` only when the offset label still crosses another visual element (another arrow, a node edge, etc.)
- Place mid-arrow, ≤3 words, stagger by 15-20px when multiple arrows converge
- Maintain 10px safety distance from nodes

**Arrow Routing**:
- Prefer orthogonal (L-shaped) paths to minimize crossings
- Anchor arrows on component edges, not geometric centers
- Route around dense node clusters, use different y-offsets for parallel arrows
- Jump-over arcs (5px radius) for unavoidable crossings

**Post-Generation Arrow Optimization**:

When a user asks to "优化箭头" / "fix arrow routing" / "optimize the diagram" on an already-generated diagram, preserve all nodes, containers, styles, and layout — only modify the `arrows` entries in the JSON data, then re-render with `generate-from-template.py`.

Available arrow override fields (in recommended order of use):

| Field | Type | When to Use |
|-------|------|-------------|
| `source_port` / `target_port` | `"left"` / `"right"` / `"top"` / `"bottom"` | Arrow exits/enters from the wrong edge |
| `corridor_x` | `[x, ...]` | Hint vertical segments toward this x lane (soft preference) |
| `corridor_y` | `[y, ...]` | Hint horizontal segments toward this y lane (soft preference) |
| `route_points` | `[[x1,y1], [x2,y2], ...]` | Force exact waypoints (bypasses auto-routing); keep segments orthogonal |
| `routing_padding` | number (default: 24) | *(Advanced)* Adjust obstacle clearance for this arrow |
| `port_clearance` | number | *(Advanced)* Adjust first-segment offset from node edge |
| `label_style` | `"badge"` / `"offset"` | Choose `"offset"` when badge backgrounds create visual clutter; keep `"badge"` (default) for legacy/high-contrast labels |

For JSON/template rendering, the default remains `"badge"` for backward compatibility. Set `"label_style": "offset"` on individual arrows when you want offset-first labels without background rects.

Optimization steps:
1. Read the existing SVG — identify which arrows overlap, cross nodes, or look misaligned
2. Find those arrows in the JSON data by `source` / `target` pair
3. Add `source_port` / `target_port` if the exit/entry direction is wrong; add `corridor_x` / `corridor_y` to space parallel arrows apart; use `route_points` only when hints alone cannot resolve the path
4. Re-run `generate-from-template.py` with the updated JSON and validate with `validate-svg.sh`

Example — spacing two overlapping arrows into separate corridors:
```json
{ "source": "nodeA", "target": "nodeB", "corridor_y": [280] }
{ "source": "nodeC", "target": "nodeD", "corridor_y": [320] }
```

**Line Overlap Prevention** (CRITICAL - most common bug on Codex):
When two arrows must cross each other, ALWAYS use jump-over arcs to prevent visual overlap:
- Crossing horizontal arrows: add a small semicircle arc (radius 5px, stroke same color as arrow, fill none) that "jumps over" the other line
- SVG pattern for jump-over: use a white/matching-background arc on the lower layer, then draw the upper arc on top
- Multiple crossings: stagger arc radii (5px, 7px, 9px) so arcs don't overlap each other
- Never let two arrows' straight-line segments cross without a jump-over arc

**Validation Checklist** (run before finalizing):
1. **Arrow-Component Collision**: Arrows MUST NOT pass through component interiors (route around with orthogonal paths)
2. **Text Overflow**: All text MUST fit with 8px padding (estimate: `text.length × 7px ≤ shape_width - 16px`)
3. **Arrow-Text Alignment**: Arrow endpoints MUST connect to shape edges (not floating); arrow labels should not overlap arrow lines (use offset positioning or background rects)
4. **Container Discipline**: Prefer arrows entering and leaving section containers through open gaps between components, not through inner component bodies
5. **Filter Boundary Safety**: For every element with `filter="url(...)"`, verify `(element_x + element_width + filter_extension) ≤ viewBox_width` AND `element_x ≥ filter_extension`. The default filter region extends 10-20% beyond bbox; staying near viewBox edges causes Chrome/cairosvg to clip the element's edge-side stroke (one side of the border vanishes while other sides render correctly)
6. **Arrow-Title Collision**: Arrows MUST NOT cross through section/container title text or region labels (font-size ≥ 13px). For smaller annotations (< 13px), prefer routing around but tolerate if layout constraints require it. *(Visual self-review check — not covered by `validate-svg.sh` automated checks)*
7. **Frame Label–Arrow Alignment** (sequence diagrams): Section/frame label badges MUST be vertically centered with their first message arrow. Compute `badge_y = first_arrow_y - (badge_height / 2)`. When appending new sections to an existing diagram, verify alignment matches the existing sections — this is the most common regression when adding content incrementally. Use variables in Python list generation to enforce the constraint: `sec_y = 840; badge_y = sec_y - 9  # for height=18 badge`

## SVG Technical Rules

- ViewBox: `0 0 960 600` default; `0 0 960 800` tall; `0 0 1200 600` wide
- Fonts: embed via `<style>font-family: ...</style>` — no external `@import` (cairosvg / rsvg-convert cannot fetch external URLs)
- `<defs>`: arrow markers, gradients, filters, clip paths
- Text: minimum 12px, prefer 13-14px labels, 11px sub-labels, 16-18px titles
- All arrows: `<marker>` with `markerEnd`, sized `markerWidth="10" markerHeight="7"`
- Drop shadows: `<feDropShadow>` in `<filter>`, apply sparingly (key nodes only)
- Curved paths: use `M x1,y1 C cx1,cy1 cx2,cy2 x2,y2` cubic bezier for loops/feedback arrows
- Clip content: use `<clipPath>` if text might overflow a node box
- Z-order (drawing order): SVG uses painter's model — later elements cover earlier ones. Recommended layer order (bottom → top): ① canvas background ② dashed containers / region backgrounds ③ arrows and connection lines ④ node shapes (rects, circles) ⑤ text labels and annotations ⑥ legends and overlays. When arrows pass near text, draw arrows BEFORE text so text stays readable. Adjust per diagram needs — this is guidance, not rigid.

## SVG Generation & Error Prevention

**MANDATORY: Python List Method** (ALWAYS use this):
```python
python3 << 'EOF'
lines = []
lines.append('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 700">')
lines.append('  <defs>')
# ... each line separately
lines.append('</svg>')

with open('/path/to/output.svg', 'w') as f:
    f.write('\n'.join(lines))
print("SVG generated successfully")
EOF
```

**Why mandatory**: Prevents character truncation, typos, and syntax errors. Each line is independent and easy to verify.

**Pre-Tool-Call Checklist** (CRITICAL - use EVERY time):
1. ✅ Can I write out the COMPLETE command/content right now?
2. ✅ Do I have ALL required parameters ready?
3. ✅ Have I checked for syntax errors in my prepared content?

**If ANY answer is NO**: STOP. Do NOT call the tool. Prepare the content first.

**Error Recovery Protocol**:
- **First error**: Analyze root cause, apply targeted fix
- **Second error**: Switch method entirely (Python list → chunked generation)
- **Third error**: STOP and report to user - do NOT loop endlessly
- **Never**: Retry the same failing command or call tools with empty parameters

**Validation** (run after generation):
```bash
python3 -c "import xml.etree.ElementTree as ET; ET.parse('file.svg')" && echo "✓ Valid XML"
# Or use cairosvg as a render-time check:
python3 -c "import cairosvg; cairosvg.svg2png(url='file.svg', write_to='/tmp/test.png')" && echo "✓ Renders" && rm /tmp/test.png
```

**If using `generate-from-template.py`**:
- Prefer `source` / `target` node ids in arrow JSON so the generator can snap to node edges
- Keep `x1,y1,x2,y2` as hints or fallback coordinates, not the main routing primitive
- Let the generator choose orthogonal routes; avoid hardcoding center-to-center straight lines unless the path is guaranteed clear

**Common Syntax Errors to Avoid**:
- ❌ `yt-anchor` → ✅ `y="60" text-anchor="middle"`
- ❌ `x="390` (missing y) → ✅ `x="390" y="250"`
- ❌ `fill=#fff` → ✅ `fill="#ffffff"`
- ❌ `marker-end=` → ✅ `marker-end="url(#arrow)"`
- ❌ `L 29450` → ✅ `L 290,220`
- ❌ Missing `</svg>` at end
- ❌ Element with `filter` near viewBox edge — filter region extends 20% (default) or more beyond bbox; if that region exceeds viewBox, Chrome/cairosvg clip the filter rendering AND can drop the element's own stroke on that side. Keep filtered elements at least `max(20% of element size, shadow blur radius × 3)` away from viewBox edges, or omit the filter.

## Output

- **Default**: `./[derived-name].svg` and `./[derived-name].png` in current directory
- **Custom**: user specifies path with `--output /path/` or `输出到 /path/`
- **PNG export**: see **SVG → PNG Conversion** below

## SVG → PNG Conversion

### Method Comparison

| Tool | Install | Render Quality | Notes |
|------|---------|----------------|-------|
| `rsvg-convert` | System (often preinstalled) | ⚠️ Fair | Drops some CSS styles and `<foreignObject>` elements — missing borders/text on complex SVGs |
| **`cairosvg` (recommended)** | `pip install cairosvg` | ✅ Good | Solid CSS support; clearly better than rsvg-convert |
| `puppeteer` (headless Chrome) | `npm install puppeteer` | ✅✅ Best | Real browser engine; 100% fidelity but heavy (Node + Chromium) |

### Recommended: cairosvg (Python one-liner)

```bash
# Single file (2x resolution for retina/docs)
python3 -c "import cairosvg; cairosvg.svg2png(url='input.svg', write_to='output.png', scale=2)"

# Batch convert all SVGs in a directory
python3 -c "
import cairosvg, os, glob
d = 'docs/00-core'
for svg in sorted(glob.glob(os.path.join(d, '*.svg'))):
    png = svg.replace('.svg', '.png')
    cairosvg.svg2png(url=svg, write_to=png, scale=2)
    print(f'Done: {os.path.basename(svg)} -> {os.path.basename(png)}')
"
```

> `scale=2` produces 2x resolution PNG, ideal for high-DPI screens and embedded docs.

### Fallback: rsvg-convert (simple but may drop styles)

```bash
# Single file
rsvg-convert -w 1920 file.svg -o file.png

# Batch (not recommended — complex SVGs may lose elements)
for f in docs/00-core/*.svg; do rsvg-convert -o "${f%.svg}.png" "$f"; done

# 2x resolution
for f in docs/00-core/*.svg; do rsvg-convert -z 2 -o "${f%.svg}.png" "$f"; done
```

### Highest Fidelity: puppeteer (headless Chrome)

```bash
npm install puppeteer  # auto-downloads Chromium
node svg2png.js [directory]
```

<details>
<summary>svg2png.js — full puppeteer script</summary>

```javascript
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const dir = process.argv[2] || '.';
  const svgFiles = fs.readdirSync(dir).filter(f => f.endsWith('.svg'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const file of svgFiles) {
    const svgPath = path.resolve(dir, file);
    const pngPath = svgPath.replace(/\.svg$/, '.png');
    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    const wMatch = svgContent.match(/width="(\d+)/);
    const hMatch = svgContent.match(/height="(\d+)/);
    const vbMatch = svgContent.match(/viewBox="[^"]*\s(\d+)\s(\d+)"/);

    let width = wMatch ? parseInt(wMatch[1]) : (vbMatch ? parseInt(vbMatch[1]) : 1200);
    let height = hMatch ? parseInt(hMatch[1]) : (vbMatch ? parseInt(vbMatch[2]) : 800);

    const scale = 2;
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: scale });

    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 0; background: transparent; }
  img { display: block; }
</style></head>
<body>
  <img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}" width="${width}" height="${height}" />
</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: pngPath, type: 'png', omitBackground: true });
    await page.close();

    console.log(`Done: ${file} -> ${path.basename(pngPath)} (${width}x${height} @${scale}x)`);
  }

  await browser.close();
})();
```

</details>

### Gotchas (lessons learned)

- `rsvg-convert` renders SVGs containing `<foreignObject>`, CSS `filter`, or complex `<style>` blocks **incompletely** — missing borders / missing text are the typical symptoms
- `cairosvg` (built on Cairo) has much better CSS support than rsvg and is sufficient for most cases
- `cairosvg` **may fail to render CJK characters and emoji** in `<text>` elements — Cairo's font API (`cairo_select_font_face`) does not reliably perform system fontconfig fallback, so glyphs not present in the matched font face render as □ (empty box). This commonly affects Chinese/Japanese/Korean text and emoji, depending on system font configuration. **Workaround**: use SVG as primary format for web/GitHub rendering (browsers handle CJK natively); reserve PNG export for Latin-only diagrams, or switch to the puppeteer path for full CJK+emoji fidelity
- If the SVG was generated by a browser (D3.js, Mermaid, etc.), only headless Chrome (puppeteer) renders it 100% faithfully
- **Chrome headless CLI `--window-size=W,H` is not the drawable area** — even in `--headless=new` mode, browser chrome (scrollbars, internal UI surfaces) consumes ~15-20% of both width and height, so the actual SVG viewport is only ~0.84×W by ~0.84×H. Symptom: SVG content past `x ≈ 0.84 × W` or `y ≈ 0.84 × H` is cut off and renders as a solid white band, even though the SVG file itself is correct. Typical failure modes: a Legend in the top-right corner loses its right border; a bottom-row container loses its bottom dashed line. Fix: pass window dimensions **≥ SVG width × 1.2 AND SVG height × 1.2**, then crop the raw screenshot back to `(SVG_width × scale, SVG_height × scale)` with PIL or ImageMagick. Example: for a 1280×580 SVG at 3× DPR, use `--window-size=1600,800` then crop the output to 3840×1740. The Puppeteer / `page.setViewport()` path does NOT have this issue — it sets a precise viewport regardless of window UI.

### Picking a Method

1. **Default** → `cairosvg` (pip install once, one-line conversion, good fidelity)
2. **No Python available** → `rsvg-convert` (acceptable for simple flat-color diagrams)
3. **Browser-generated SVG or pixel-perfect required** → `puppeteer`

## Styles

| # | Name | Background | Best For |
|---|------|-----------|----------|
| 1 | **Flat Icon** (default) | White | Blogs, docs, presentations |
| 2 | **Dark Terminal** | `#0f0f1a` | GitHub, dev articles |
| 3 | **Blueprint** | `#0a1628` | Architecture docs |
| 4 | **Notion Clean** | White, minimal | Notionnce |
| 5 | **Glassmorphism** | Dark gradient | Product sites, keynotes |
| 6 | **Claude Official** | Warm cream `#f8f6f3` | Anthropic-style diagrams |
| 7 | **OpenAI Official** | Pure white `#ffffff` | OpenAI-style diagrams |
| 8 | **Dark Luxury** *(AI-authored)* | `#0a0a0a` deep black | Architecture docs, premium editorial — hand-craft SVG from `references/style-8-dark-luxury.md` |

Load `references/style-N.md` for exact color tokens and SVG patterns.

## Style Selection

**Default**: Style 1 (Flat Icon) for most diagrams. Load `references/style-diagram-matrix.md` for detailed style-to-diagram-type recommendations.

These patterns appear frequently — internalize them:

**RAG Pipeline**: Query → Embed → VectorSearch → Retrieve → Augment → LLM → Response
**Agentic RAG**: adds Agent loop with Tool use between Query and LLM
**Agentic Search**: Query → Planner → [Search Tool / Calculator / Code] → Synthesizer → Response
**Mem0 / Memory Layer**: Input → Memory Manager → [Write: VectorDB + GraphDB] / [Read: Retrieve+Rank] → Context
**Agent Memory Types**: Sensory (raw input) → Working (context window) → Episodic (past interactions) → Semantic (facts) → Procedural (skills)
**Multi-Agent**: Orchestrator → [SubAgent A / SubAgent B / SubAgent C] → Aggregator → Output
**Tool Call Flow**: LLM → Tool Selector → Tool Execution → Result Parser → LLM (loop)
