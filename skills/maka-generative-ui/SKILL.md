---
name: maka-generative-ui
description: Render interactive inline UIs, dashboards, data charts, calculators, and forms inside Maka conversation messages using json-render spec blocks.
license: Apache-2.0
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Maka Generative UI

Use inline ```spec code fences in assistant replies to render interactive UIs, metrics dashboards, native GPU/Braille charts, sortable tables, calculators, and forms directly in the conversation stream on both Desktop and Terminal.

Generated UIs are strictly client-local: state bindings (`$state`, `$item`, `$index`), two-way bindings (`$bindState`, `$bindItem`), directives (`$cond`, `$template`, `$format`, `$math`, `$concat`, `$count`, `$truncate`, `$pluralize`, `$join`), computed helpers (`{ "$computed": "sum" | "avg" | "min" | "max" | "count" | "join", "args": { "values": ..., "separator"?: ... } }`), validation checks, watchers, and built-in actions execute inside the conversation view and never send prompts or RPC calls back to the Agent.

Maka natively renders inline ```spec code blocks inside conversation messages using the catalog and rules below.

OUTPUT FORMAT (text + JSONL, RFC 6902 JSON Patch):
You respond conversationally. When generating UI, first write a brief explanation (1-3 sentences), then output JSONL patch lines wrapped in a ```spec code fence.
The JSONL lines use RFC 6902 JSON Patch operations to build a UI tree. Always wrap them in a ```spec fence block:
  ```spec
  {"op":"add","path":"/root","value":"main"}
  {"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Hello"},"children":[]}}
  ```
If the user's message does not require a UI (e.g. a greeting or clarifying question), respond with text only — no JSONL.
Each line is a JSON patch operation (add, remove, replace). Start with /root, then stream /elements and /state patches interleaved so the UI fills in progressively as it streams.

Example output (each line is a separate JSON object):

{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Overview","description":"Live metrics and controls"},"children":["child-1","list"]}}
{"op":"add","path":"/elements/child-1","value":{"type":"Text","props":{"text":"Summary item"},"children":[]}}
{"op":"add","path":"/elements/list","value":{"type":"Card","props":{"title":"Overview","description":"Live metrics and controls"},"repeat":{"statePath":"/items","key":"id"},"children":["item"]}}
{"op":"add","path":"/elements/item","value":{"type":"Text","props":{"text":{"$item":"title"}},"children":[]}}
{"op":"add","path":"/state/items","value":[]}
{"op":"add","path":"/state/items/0","value":{"id":"1","title":"First Item"}}
{"op":"add","path":"/state/items/1","value":{"id":"2","title":"Second Item"}}

Note: state patches appear right after the elements that use them, so the UI fills in as it streams. ONLY use component types from the AVAILABLE COMPONENTS list below.

INITIAL STATE:
Specs include a /state field to seed the state model. Components with { $bindState } or { $bindItem } read from and write to this state, and $state expressions read from it.
CRITICAL: You MUST include state patches whenever your UI displays data via $state, $bindState, $bindItem, $item, or $index expressions, or uses repeat to iterate over arrays. Without state, these references resolve to nothing and repeat lists render zero items.
Output state patches right after the elements that reference them, so the UI fills in progressively as it streams.
Stream state progressively - output one patch per array item instead of one giant blob:
  For arrays: {"op":"add","path":"/state/posts/0","value":{"id":"1","title":"First Post",...}} then /state/posts/1, /state/posts/2, etc.
  For scalars: {"op":"add","path":"/state/newTodoText","value":""}
  Initialize the array first if needed: {"op":"add","path":"/state/posts","value":[]}
When content comes from the state model, use { "$state": "/some/path" } dynamic props to display it instead of hardcoding the same value in both state and props. The state model is the single source of truth.
Include realistic sample data in state. For blogs: 3-4 posts with titles, excerpts, authors, dates. For product lists: 3-5 items with names, prices, descriptions. Never leave arrays empty.

DYNAMIC LISTS (repeat field):
Any element can have a top-level "repeat" field to render its children once per item in a state array: { "repeat": { "statePath": "/arrayPath", "key": "id" } }.
The element itself renders once (as the container), and its children are expanded once per array item. "statePath" is the state array path. "key" is an optional field name on each item for stable React keys.
For nested lists, an inner repeat can read an array from the enclosing item with { "statePath": { "$item": "field" } }. This form is valid only inside another repeat. Use an empty field to repeat over the enclosing item itself.
Example: {"type":"Card","props":{"title":"Overview","description":"Live metrics and controls"},"repeat":{"statePath":"/todos","key":"id"},"children":["todo-item"]}
Inside children of a repeated element, use { "$item": "field" } to read a field from the current item, and { "$index": true } to get the current array index. For two-way binding to an item field use { "$bindItem": "completed" } on the appropriate prop.
ALWAYS use the repeat field for lists backed by state arrays. NEVER hardcode individual elements for each array item.
IMPORTANT: "repeat" is a top-level field on the element (sibling of type/props/children), NOT inside props.

ARRAY STATE ACTIONS:
Use action "pushState" to append items to arrays. Params: { statePath: "/arrayPath", value: { ...item }, clearStatePath: "/inputPath" }.
Values inside pushState can contain { "$state": "/statePath" } references to read current state (e.g. the text from an input field).
Use "$id" inside a pushState value to auto-generate a unique ID.
Example: on: { "press": { "action": "pushState", "params": { "statePath": "/todos", "value": { "id": "$id", "title": { "$state": "/newTodoText" }, "completed": false }, "clearStatePath": "/newTodoText" } } }
Use action "removeState" to remove items from arrays by index. Params: { statePath: "/arrayPath", index: N }. Inside a repeated element's children, use { "$index": true } for the current item index. Action params support the same expressions as props: { "$item": "field" } resolves to the absolute state path, { "$index": true } resolves to the index number, and { "$state": "/path" } reads a value from state.
For lists where users can add/remove items (todos, carts, etc.), use pushState and removeState instead of hardcoding with setState.

IMPORTANT: State paths use RFC 6901 JSON Pointer syntax (e.g. "/todos/0/title"). Do NOT use JavaScript-style dot notation (e.g. "/todos.length" is WRONG). To generate unique IDs for new items, use "$id" instead of trying to read array length.

AVAILABLE COMPONENTS (63):

- Card: { title?: string, description?: string, subtitle?: string, padding?: "none" | "sm" | "md" | "lg" } - Elevated container grouping related content with optional title, description, and header/footer slots. [accepts children; slots: header, footer]
- Text: { text: string, variant?: "body" | "caption" | "muted" | "lead" | "code", color?: "default" | "secondary" | "muted" | "accent" | "success" | "warning" | "danger", bold?: boolean, italic?: boolean, align?: "left" | "center" | "right", truncate?: boolean } - Body, caption, or inline monospace text.
- Stack: { direction?: "vertical" | "horizontal", gap?: "none" | "xs" | "sm" | "md" | "lg" | number, align?: "start" | "center" | "end" | "stretch" | "baseline", justify?: "start" | "center" | "end" | "between" | "around", wrap?: boolean } - Vertical or horizontal flex stack with configurable gap and alignment. [accepts children]
- Grid: { columns?: number, gap?: "none" | "xs" | "sm" | "md" | "lg" | number } - Multi-column CSS/Taffy grid container (defaults to 2 columns, collapses cleanly on narrow terminals). [accepts children]
- Box: { direction?: "column" | "row", gap?: number, padding?: number, paddingX?: number, paddingY?: number, alignItems?: "flex-start" | "center" | "flex-end" | "stretch", justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around", bordered?: boolean, grow?: number } - Low-level flex container with explicit padding, border, and flex grow. [accepts children]
- Spacer: { size?: number, flex?: boolean } - Fixed spacing gap or flexible spring space inside a Stack or Box.
- Newline: { count?: number } - Vertical line break spacing (count defaults to 1).
- Separator: { orientation?: "horizontal" | "vertical" } - Thin visual rule separating sections or inline items.
- Divider: { title?: string, orientation?: "horizontal" | "vertical" } - Section divider line with an optional centered title label.
- Heading: { text: string, level?: "h1" | "h2" | "h3" | "h4" } - Section heading (h1-h4).
- Markdown: { content: string } - Rich formatted Markdown block (lists, emphasis, inline code, tables).
- CodeBlock: { code: string, language?: string } - Syntax-highlighted code block with copy and wrap actions.
- Badge: { text: string, variant?: "default" | "secondary" | "outline" | "info" | "success" | "warning" | "danger" | "destructive" } - Compact status or category pill badge.
- StatusLine: { label: string, status?: "info" | "success" | "warning" | "error" | "pending", detail?: string } - Single-line status indicator with semantic icon, label, and trailing detail.
- Alert: { title: string, description?: string, type?: "info" | "success" | "warning" | "error" | "default" | "destructive" } - Prominent status banner with title and optional description.
- Callout: { type?: "info" | "tip" | "warning" | "important" | "caution", title?: string, content: string } - Highlighted callout block with left accent border for tips, notes, or warnings.
- Metric: { label: string, value: string | number, change?: string, trend?: "up" | "down" | "neutral", caption?: string, sparkline?: Array<number> } - KPI stat tile displaying a primary value, label, optional delta/trend badge, caption, and mini sparkline.
- KeyValue: { label?: string, value?: string | number | boolean, items?: Array<{ key: string, value: string | number | boolean }>, striped?: boolean } - Aligned key-value pair or list of key-value rows.
- Table: { columns: Array<string | { key: string, header: string, align?: "left" | "center" | "right", width?: number, sortable?: boolean }>, rows: Array<Array<unknown> | Record<string, unknown>>, caption?: string, sortable?: boolean, striped?: boolean } - Structured data table supporting either string[] columns + 2D rows or {key, header}[] columns + object[] rows, with optional client-side column sorting.
- List: { items?: Array<string>, ordered?: boolean, divided?: boolean } - Ordered or bulleted list from string items or ListItem children. [accepts children]
- ListItem: { title: string, subtitle?: string, trailing?: string, leading?: string } - Structured row inside a List with title, optional subtitle, leading marker, and trailing value. [events: press]
- Timeline: { items: Array<{ title: string, description?: string, time?: string, status?: "completed" | "active" | "pending" | "error" }> } - Vertical chronological timeline of milestones, stages, or events.
- Progress: { value: number, max?: number, label?: string, showValue?: boolean, color?: "accent" | "success" | "warning" | "danger" } - Horizontal progress bar (0 to max, default 100) with optional label and percentage.
- ProgressBar: { progress: number, total?: number, label?: string, color?: "accent" | "success" | "warning" | "danger" } - Alias progress indicator supporting fraction (0..1 when total omitted and progress <= 1) or progress/total.
- LineChart: { title?: string, data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string, color?: string }>, height?: number, curve?: "linear" | "monotone" | "step", dots?: boolean, grid?: boolean } - Native GPU/Braille multi-series line chart. Provide data rows, xKey for x-axis labels/numbers, and series [{ key, label?, color? }].
- AreaChart: { title?: string, data: Array<Record<string, unknown>>, xKey: string, series: Array<{ key: string, label?: string, color?: string }>, height?: number, curve?: "linear" | "monotone" | "step", stacked?: boolean } - Native GPU/Braille filled area chart supporting single, multi-series, or stacked series.
- BarChart: { title?: string, data: Array<Record<string, unknown>>, xKey?: string, series?: Array<{ key: string, label?: string, color?: string }>, stacked?: boolean, height?: number, showValues?: boolean } - Native bar chart. Accepts either simple [{ label, value, color? }] data or multi-series data with xKey and series [{ key, label?, color? }].
- PieChart: { title?: string, data: Array<{ label: string, value: number, color?: string }>, donut?: boolean, height?: number } - Native pie or donut chart with automatic legend and percentage breakdown.
- ScatterChart: { title?: string, data: Array<Record<string, unknown>>, xKey: string, yKey: string, labelKey?: string, sizeKey?: string, height?: number } - 2D scatter or bubble plot for numeric xKey and yKey coordinates.
- Heatmap: { title?: string, xLabels: Array<string>, yLabels: Array<string>, values: Array<Array<number>>, height?: number } - 2D matrix heatmap where values[row][col] maps to yLabels[row] and xLabels[col].
- Sparkline: { data: Array<number>, width?: number, height?: number, color?: "accent" | "success" | "warning" | "danger" | "muted", label?: string } - Compact inline trend sparkline for an array of numbers.
- Tabs: { tabs: Array<{ label: string, value: string, content?: string }>, defaultValue?: string, value?: string } - Tabbed navigation container. Bind value with { "$bindState": "/tab" } and place TabContent children (or named slots matching tab value, or inline tab.content). [accepts children] [events: change]
- TabContent: { value: string } - Content panel inside Tabs shown only when its value matches the active tab. [accepts children]
- Accordion: { items: Array<{ title: string, content: string, value?: string }>, type?: "single" | "multiple", defaultOpen?: Array<number> } - Expandable accordion sections with title and content.
- Collapsible: { title: string, defaultOpen?: boolean, open?: boolean } - Disclosure container that folds and unfolds its child elements. [accepts children] [events: change]
- Dialog: { title: string, description?: string, openPath: string } - Modal dialog controlled by boolean state at openPath (JSON Pointer, e.g. "/dialogOpen"). Open via a Button setting openPath to true. [accepts children]
- Drawer: { title: string, description?: string, openPath: string } - Sheet overlay controlled by boolean state at openPath (JSON Pointer, e.g. "/drawerOpen"). [accepts children]
- Popover: { trigger: string, content?: string } - Anchored popover button showing text content or child elements when pressed. [accepts children]
- Tooltip: { content: string, text?: string } - Hover/focus hint attached to a text label or child element. [accepts children]
- Carousel: { items?: Array<{ title?: string, description?: string }> } - Paged slide switcher stepping through items or child elements with Previous/Next controls. [accepts children]
- Image: { src?: string, alt: string, width?: number, height?: number } - Image with alt label and graceful fallback frame when offline or in terminal.
- Avatar: { name: string, src?: string, size?: "sm" | "md" | "lg" } - Initials badge (or image) representing a person or service.
- Skeleton: { lines?: number, height?: number } - Placeholder block indicating pending layout regions.
- Spinner: { label?: string } - Compact activity indicator with optional label.
- EmptyState: { title: string, description?: string } - Centered empty-state placeholder with title, optional description, and optional action children. [accepts children]
- Input: { label?: string, value?: string, placeholder?: string, type?: "text" | "email" | "password" | "number" | "url" | "search", helperText?: string, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Single-line text input. Bind value via { "$bindState": "/path" } or { "$bindItem": "field" }. [events: change, blur, submit]
- TextInput: { label?: string, value?: string, placeholder?: string, masked?: boolean, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Single-line text field alias compatible with terminal/ink specs. [events: change, blur, submit]
- Textarea: { label?: string, value?: string, placeholder?: string, rows?: number, helperText?: string, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Multi-line text editor bound via { "$bindState": "/path" }. [events: change, blur]
- NumberInput: { label?: string, value?: number, min?: number, max?: number, step?: number, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }> } - Numeric field with decrement/increment buttons and min/max/step clamping. [events: change]
- Select: { label?: string, value?: string, options: Array<string | { label: string, value: string, description?: string, disabled?: boolean }>, placeholder?: string, helperText?: string, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }> } - Dropdown selector accepting string[] or { label, value, description? }[] options. Bind value with { "$bindState": "/path" }. [events: change]
- MultiSelect: { label?: string, value?: Array<string>, options: Array<string | { label: string, value: string, description?: string, disabled?: boolean }>, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }> } - Multi-option selector toggling values inside a bound string[] state array. [events: change]
- Checkbox: { label: string, description?: string, checked?: boolean, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }> } - Boolean checkbox control. Bind checked with { "$bindState": "/path" } or { "$bindItem": "done" }. [events: change]
- Radio: { label?: string, value?: string, options: Array<string | { label: string, value: string, description?: string, disabled?: boolean }>, direction?: "vertical" | "horizontal", disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }> } - Exclusive radio group bound via { "$bindState": "/path" }. [events: change]
- Switch: { label: string, description?: string, checked?: boolean, disabled?: boolean } - Immediate on/off toggle row. Bind checked with { "$bindState": "/path" }. [events: change]
- Slider: { label?: string, value?: number, min?: number, max?: number, step?: number, unit?: string, disabled?: boolean } - Interactive range slider with live value readout. Bind value with { "$bindState": "/path" }. [events: change]
- Button: { label: string, variant?: "primary" | "secondary" | "outline" | "ghost" | "danger", size?: "sm" | "md", disabled?: boolean } - Action button triggering client actions on press (setState, pushState, resetState, validateForm, copyText). [events: press]
- ButtonGroup: { buttons?: Array<{ label: string, value: string, disabled?: boolean }>, selected?: string } - Segmented button row either from buttons[] bound via selected or from Button children. [accepts children] [events: change]
- Toggle: { label: string, pressed?: boolean, disabled?: boolean } - Two-state pressed toggle button. Bind pressed with { "$bindState": "/path" }. [events: change]
- ToggleGroup: { items: Array<{ label: string, value: string }>, type?: "single" | "multiple", value?: string | Array<string> } - Single or multi-value segmented toggle group. Bind value with { "$bindState": "/path" }. [events: change]
- DropdownMenu: { label: string, value?: string, items: Array<{ label: string, value: string, disabled?: boolean }> } - Popover action menu writing the chosen item value to bound value or firing on.select. [events: select]
- Pagination: { page?: number, totalPages: number } - Page navigator (1..totalPages). Bind page with { "$bindState": "/page" }. [events: change]
- ConfirmInput: { message: string, confirmLabel?: string, cancelLabel?: string, value?: boolean } - Inline Yes/No confirmation prompt updating bound boolean value and firing confirm/cancel events. [events: confirm, cancel]
- Link: { label: string, href: string } - External link opened through the workbench link handler (or firing client press actions). [events: press]

AVAILABLE ACTIONS:

- setState: Set a value in the state model at the given JSON Pointer statePath. Params: { statePath: string, value: unknown } [built-in]
- pushState: Append an item to an array in state. Params: { statePath: string, value: unknown, clearStatePath?: string }. Value may contain { "$state": "/path" } refs and "$id" for unique IDs. [built-in]
- removeState: Remove an item from an array in state by index. Params: { statePath: string, index: number } [built-in]
- toggleState: Flip a boolean value in state at the given JSON Pointer statePath. Params: { statePath: string } [built-in]
- resetState: Restore initial /state values, or restore a single subtree when statePath is given. Params: { statePath?: string } [built-in]
- validateForm: Validate all registered form fields with checks and write { valid: boolean, errors: Record<string, string[]> } to statePath (defaults to /formValidation). Params: { statePath?: string } [built-in]
- copyText: Copy text to the clipboard. Params: { text: string } [built-in]

EVENTS (the `on` field):
Elements can have an optional `on` field to bind events to actions. The `on` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Each key in `on` is an event name (from the component's supported events), and the value is an action binding: `{ "action": "<actionName>", "params": { ... } }`.

Example:
  {"type":"Card","props":{"title":"Overview","description":"Live metrics and controls"},"on":{"press":{"action":"setState","params":{"statePath":"/saved","value":true}}},"children":[]}

Action params can use dynamic references to read from state: { "$state": "/statePath" }.
IMPORTANT: Do NOT put action/actionParams inside props. Always use the `on` field for event bindings.

VISIBILITY CONDITIONS:
Elements can have an optional `visible` field to conditionally show/hide based on state. IMPORTANT: `visible` is a top-level field on the element object (sibling of type/props/children), NOT inside props.
Correct: {"type":"Card","props":{"title":"Overview","description":"Live metrics and controls"},"visible":{"$state":"/activeTab","eq":"home"},"children":["..."]}
- `{ "$state": "/path" }` - visible when state at path is truthy
- `{ "$state": "/path", "not": true }` - visible when state at path is falsy
- `{ "$state": "/path", "eq": "value" }` - visible when state equals value
- `{ "$state": "/path", "neq": "value" }` - visible when state does not equal value
- `{ "$state": "/path", "gt": N }` / `gte` / `lt` / `lte` - numeric comparisons
- Use ONE operator per condition (eq, neq, gt, gte, lt, lte). Do not combine multiple operators.
- Any condition can add `"not": true` to invert its result
- `[condition, condition]` - all conditions must be true (implicit AND)
- `{ "$and": [condition, condition] }` - explicit AND (use when nesting inside $or)
- `{ "$or": [condition, condition] }` - at least one must be true (OR)
- `true` / `false` - always visible/hidden

Use a component with on.press bound to setState to update state and drive visibility.
Example: A Card with on: { "press": { "action": "setState", "params": { "statePath": "/activeTab", "value": "home" } } } sets state, then a container with visible: { "$state": "/activeTab", "eq": "home" } shows only when that tab is active.

For tab patterns where the first/default tab should be visible when no tab is selected yet, use $or to handle both cases: visible: { "$or": [{ "$state": "/activeTab", "eq": "home" }, { "$state": "/activeTab", "not": true }] }. This ensures the first tab is visible both when explicitly selected AND when /activeTab is not yet set.

DYNAMIC PROPS:
Any prop value can be a dynamic expression that resolves based on state. Three forms are supported:

1. Read-only state: `{ "$state": "/statePath" }` - resolves to the value at that state path (one-way read).
   Example: `"color": { "$state": "/theme/primary" }` reads the color from state.

2. Two-way binding: `{ "$bindState": "/statePath" }` - resolves to the value at the state path AND enables write-back. Use on form input props (value, checked, pressed, etc.).
   Example: `"value": { "$bindState": "/form/email" }` binds the input value to /form/email.
   Inside repeat scopes: `"checked": { "$bindItem": "completed" }` binds to the current item's completed field.

3. Conditional: `{ "$cond": <condition>, "$then": <value>, "$else": <value> }` - evaluates the condition (same syntax as visibility conditions) and picks the matching value.
   Example: `"color": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "#007AFF", "$else": "#8E8E93" }`

Use $bindState for form inputs (text fields, checkboxes, selects, sliders, etc.) and $state for read-only data display. Inside repeat scopes, use $bindItem for form inputs bound to the current item. Use dynamic props instead of duplicating elements with opposing visible conditions when only prop values differ.

4. Template: `{ "$template": "Hello, ${/name}!" }` - interpolates references in the string. Absolute paths like `${/path}` resolve against the state model. Bare names like `${field}` resolve against the current repeat item first, then fall back to the state model at `/<field>`.
   Example: `"label": { "$template": "Items: ${/cart/count} | Total: ${/cart/total}" }` renders "Items: 3 | Total: 42.00" when /cart/count is 3 and /cart/total is 42.00. Inside a repeat, `{ "$template": "${name} - ${email}" }` reads name and email from each item.

CUSTOM DYNAMIC VALUES:

- $format (Locale-aware value formatting (date, currency, number, percent). Supports style: "relative" for relative dates.): { $format: "date" | "currency" | "number" | "percent", value: unknown, locale?: string, currency?: string, notation?: string, style?: string, options?: Record<string, unknown>, now?: number }
- $math (Arithmetic operations. Unary ops (round, floor, ceil, abs) only use "a". Division by zero returns 0.): { $math: "add" | "subtract" | "multiply" | "divide" | "mod" | "min" | "max" | "round" | "floor" | "ceil" | "abs", a?: unknown, b?: unknown }
- $concat (Concatenate multiple dynamic values into a string.): { $concat: Array<unknown> }
- $count (Get the length of an array or string.): { $count: unknown }
- $truncate (Truncate text to a max length with a suffix.): { $truncate: unknown, length?: number, suffix?: string }
- $pluralize (Select singular/plural/zero form based on count. Output: "3 items", "1 item", or "no items".): { $pluralize: unknown, zero?: string, one: string, other: string }
- $join (Join array elements with a separator.): { $join: unknown, separator?: string }

Directives compose: any value field can contain another directive or a $state expression, resolved inside-out.

VALIDATION:
Form components that accept a `checks` prop support client-side validation.
Each check is an object: { "type": "<name>", "message": "...", "args": { ... } }

Built-in validation types:
  - required — value must be non-empty
  - email — valid email format
  - minLength — minimum string length (args: { "min": N })
  - maxLength — maximum string length (args: { "max": N })
  - pattern — match a regex (args: { "pattern": "regex" })
  - min — minimum numeric value (args: { "min": N })
  - max — maximum numeric value (args: { "max": N })
  - numeric — value must be a number
  - url — valid URL format
  - matches — must equal another field (args: { "other": { "$state": "/path" } })
  - equalTo — alias for matches (args: { "other": { "$state": "/path" } })
  - lessThan — value must be less than another field (args: { "other": { "$state": "/path" } })
  - greaterThan — value must be greater than another field (args: { "other": { "$state": "/path" } })
  - requiredIf — required only when another field is truthy (args: { "field": { "$state": "/path" } })

Example:
  "checks": [{ "type": "required", "message": "Email is required" }, { "type": "email", "message": "Invalid email" }]

IMPORTANT: When using checks, the component must also have a { $bindState } or { $bindItem } on its value/checked prop for two-way binding.
Always include validation checks on form inputs for a good user experience (e.g. required, email, minLength).

STATE WATCHERS:
Elements can have an optional `watch` field to react to state changes and trigger actions. The `watch` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Maps state paths (JSON Pointers) to action bindings. When the value at a watched path changes, the bound actions fire automatically.

Example (cascading select — country changes reset dependent city selection):
  {"type":"Select","props":{"value":{"$bindState":"/form/country"},"options":["US","Canada","UK"]},"watch":{"/form/country":{"action":"setState","params":{"statePath":"/form/city","value":""}}},"children":[]}

Use `watch` for cascading dependencies where changing one field should trigger side effects (resetting dependent fields, clearing stale selections, updating client state).
IMPORTANT: `watch` is a top-level field on the element (sibling of type/props/children), NOT inside props. Watchers only fire when the value changes, not on initial render.

RULES:
1. When generating UI, wrap all JSONL patches in a ```spec code fence - one JSON object per line inside the fence
2. Write a brief conversational response before any JSONL output
3. First set root: {"op":"add","path":"/root","value":"<root-key>"}
4. Then add each element: {"op":"add","path":"/elements/<key>","value":{...}}
5. Output /state patches right after the elements that use them, one per array item for progressive loading. REQUIRED whenever using $state, $bindState, $bindItem, $item, $index, or repeat.
6. ONLY use components listed above
7. Each element value needs: type, props, children (array of child keys)
8. Use unique keys for the element map entries (e.g., 'header', 'metric-1', 'chart-revenue')
9. CLIENT-ONLY BOUNDARY: Generated UI runs strictly locally in the conversation stream and NEVER sends messages, prompts, or RPC calls back to the Agent or Host. Use ONLY the built-in client actions (setState, pushState, removeState, toggleState, resetState, validateForm, copyText); never invent server or agent actions.
10. CRITICAL INTEGRITY CHECK: Every key referenced in an element's "children" or "slots" MUST exist in "elements". Emit child elements alongside or immediately after their parent so no branch is left dangling.
11. REQUIRED FIELDS: Every element MUST include "type", "props", and "children" (use "children": [] on leaf elements).
12. FIELD PLACEMENT: "visible", "on", "repeat", and "watch" belong on the ELEMENT object (siblings of type/props/children), NEVER inside "props".
13. STATE & REPEAT: Put initial state at top-level "/state" patches. For arrays of items, use "repeat": { "statePath": "/items", "key": "id" } on a container element (or { "statePath": { "$item": "subItems" } } inside an outer repeat) with { "$item": "field" }, { "$index": true }, and { "$bindItem": "field" } inside repeated children.
14. NATIVE LAYOUT & VISUALS: Maka renders natively on both Desktop (GPU) and Terminal (TUI) without HTML/CSS/WebView. Rely on Stack, Grid, Card, Tabs, Table, and native chart components with clean hierarchy and realistic data rather than raw markup.
15. Prefer interactive client state ($bindState, Slider, Tabs, Select, Switch, Table sorting) over static prose when the user is comparing trade-offs, exploring parameters, inspecting structured metrics, or filling a calculator/checklist.
16. Do NOT emit ```spec blocks for plain text answers, simple 2-row tables, or flowcharts/sequence diagrams (use ```mermaid for architecture/sequence diagrams, and ```spec for data charts, dashboards, metrics, and interactive UI).
