---
title: Design Guides
description: "Product and interaction design guidance for apps built with Native Shell: hierarchy, color and tokens, spacing, density, components, interaction states, overlays, motion, data-heavy views, interface copy, and platform fit."
order: 29
group: ui
---

# Design Guides

Use this guide before choosing components or writing layout code for an app built with Native Shell. It records the
product judgment NSH apps follow: an interface should feel native, restrained, precise, and understandable without
guesswork.

It is a general guide, not a visual style. Applied to an app's own style, it should lead to UI that is complete,
refined and consistent: every state of every control designed, motion where things change, and one system of sizes,
radii, type and spacing from the first screen to the last. The app decides how it looks; this guide decides what must
be true however it looks.

This is a normative guide. **Must** identifies a correctness or ecosystem constraint, **should** is the default that
needs a concrete reason to override, and **may** is an optional technique. The [Elements](../elements/index.md) and
[API](../modules/index.md) pages remain the authority for individual props and methods.

The rules build on behavior in `nsh/base` (`nsh_base` in Rust), the theme and its tokens, and the interaction each
platform's users already know. NSH renders with each platform's own UI and leaves the look to the app: `nsh/base`'s
components bring behavior, state, focus and accessibility, and every color, size, radius and spacing comes from the
app's own components, so these rules guide the app's design system. <a href="https://ui.shadcn.com/docs" target="_blank" rel="noopener noreferrer">shadcn/ui</a>
contributes useful methods (open code, composition, and dependable defaults) but does not determine how an NSH app
should look. When influences conflict, preserve the platform's behavior and the interaction people already understand.

## Design thesis

Build interfaces that feel native, quiet, and precise. Let content, hierarchy, and interaction carry the experience;
decoration should support them rather than compete with them.

1. **Clarity before personality.** Make the primary task and next action clear before adding brand expression.
2. **Composition before invention.** Start with established components and compose them into product-specific
   workflows. Create a new primitive only when its behavior is genuinely new.
3. **Tokens before values.** Colors, radii, typography, and spacing should form a system. Avoid isolated literals that
   cannot respond to themes. See [Styling](./styling.md), [Tailwind](./tailwind.md) and [the theme](./rust.md#theme).
4. **Platform before web convention.** Preserve keyboard access, window chrome, menus, dense data views, resizable
   regions, and persistent navigation on the desktops, and the system's headers, back gesture, alerts and touch
   targets on phones and tablets, where the task benefits from them.
5. **State must be visible.** Hover, pressed, focus, selection, disabled, loading, validation, and destructive states
   need distinct and consistent treatment.
6. **Geometry explains containment.** Radii, insets, and boundaries should describe one coherent hierarchy, even where
   surfaces overlap.
7. **Feedback reflects reality.** Loading, tooltips, and motion should clarify a real state or transition, not add
   ceremony to an immediate action.
8. **Accessibility and keyboard are requirements.** Every action works by keyboard and with a screen reader; an
   interface that fails either is broken.

## Establish the app's design system first

Before implementing screens in a new app, establish its own design standards, theme tokens and styled component
library. For an existing app, inspect and extend those foundations first; a small change uses the established system.
Keep the standards in the app repository so people and coding agents use the same decisions.

The standards should name the product's visual language, typography and spacing scales, density, radii, icons,
interaction states and supported platforms. Define semantic tokens for surfaces, foregrounds, borders, actions,
selection, focus and status, with light and dark values and readable foreground/background pairs. Theme colors must
come from these tokens throughout screens, reusable components, overlays and interaction states. Literal hex,
RGBA or HSLA values belong in the token definitions; when a role is missing, add it there before using it. A token
named after a role such as `warning` communicates more than a palette name such as `amber-500`.

Build an app-owned styled layer on `nsh/base` before composing pages. Cover the controls and their parts needed by
the app: buttons, fields, selection controls, navigation, surfaces, menus, dialogs and feedback. Give them coherent
variants, sizes, density and hover, pressed, focus, selected, disabled, loading and validation states. Pages compose
these components; they should not restyle base controls independently. Start it with the core set below and grow it
with the app's needs, keeping every control complete.

NSH has three layers: `nsh-core` provides the primitives, layout and rendering; `nsh-base` (`nsh/base`) provides
unstyled components with behavior, state, focus and accessibility; the styled layer above them belongs to the app (its
`ui` layer) or a community library. The default theme supplies starting tokens; the app's styled components turn them into a complete visual
system. See [Coding Guides](./coding-guides.md#build-the-apps-ui-foundations-before-pages).

### The app's `ui` layer

Apps stay consistent when their screens are built from components with a limited API: a `Button` that takes a
variant, a size and a few states behaves and looks the same on every screen. `nsh/base` has behavior and no look, so
an app without its own component layer drifts: each screen restyles its own buttons, rows and popups, and
as features grow their design, interaction and behavior stop agreeing. Every NSH app therefore creates its own `ui`
layer when it is created, and builds every feature from it.

- **Where.** A `ui` module beside the features (`src/ui/` in Rust, `ui/` or `src/ui/` in TSX), one file per
  component or family (`button`, `input`, `menu`, ...), with its tokens (`tokens`, `motion`) and icons. Features live
  in their own modules and import from `ui`.
- **Start with a core set**, before the first screen, so features never need to improvise: `Icon`; `Button` and
  `IconButton` (variants such as primary, secondary, ghost, outline, danger; sizes); `Input`, `Textarea` and a `Field`
  (label, control, description, error); `Checkbox`, `Switch`, `Select`; `Tabs` or a segmented control; `Menu`,
  `Popover`, `Tooltip`; `Dialog`, `AlertDialog`, `Sheet`; `Toast`; a `ListItem` / row; a `Surface` or card; `Badge`;
  `Avatar`; `Separator`; `Empty`, `Skeleton`, `Spinner`. Add others (a data table, a date picker, a toolbar) as the
  first feature needs them, built to the same standard.
- **A limited API.** Each component exposes what varies by meaning: `variant`, `size`,
  states (`selected`, `disabled`, `loading`, `invalid`), content slots (label, icon, children) and events. Its look,
  hover, pressed, focus and motion are inside it, from tokens. It takes layout from its caller (width, flex, margin,
  alignment), never colors, radii, paddings or fonts: a look a feature needs becomes a new variant or size in `ui`,
  for every screen, not an override on one.
- **Features compose `ui`, they do not style.** Feature code uses `ui` components and layout primitives (`View`,
  `Text`, `Scroll`, `List` with spacing classes and text tokens). It does not import controls from `nsh/base`
  directly, write colors, radii or font sizes, or hand-build a control from a pressable view. When `ui` lacks
  something, add it to `ui` first, then use it.
- **Consistency by construction.** One `Button` means one press feedback, one focus ring and one disabled look
  everywhere; one `Menu` means every menu opens, moves through items and closes the same way. Fixing a component
  fixes every screen.
- **Show it.** Keep a page (a debug screen or the app's own gallery) that shows every `ui` component in every
  variant, size and state, in light and dark; review new components there before features use them.

### Design for the platforms the app targets

Choose the supported targets before defining component variants. NSH apps run in three families of interfaces; share
semantics, tokens and state across them, and adapt interaction, presentation and sizes to each family the app targets:

**Desktop and Web: one family.** macOS, Windows, Linux and the web in the desktop idiom share interaction, design
and sizes; the web is not a separate design.
- Pointer and keyboard first: hover on everything pressable, visible focus, keyboard shortcuts for frequent commands,
  context menus, tooltips for icon-only controls, text selection where content is read.
- Compact controls: about 24–32pt tall (32 the default), icons 14–16pt, rows 28–36pt, dense tables and toolbars.
- Persistent navigation (sidebars, tabs, toolbars), resizable panes, popovers and menus anchored to their triggers,
  dialogs centered in the window, Escape to dismiss.
- Responsive windows: the layout holds from the minimum window size up; a web page on a phone follows Mobile.

**Mobile: iOS and Android conventions.** Mac Catalyst counts as mobile. Follow each platform's interaction design and
control sizes rather than shrinking the desktop.
- Touch targets at least 44 × 44pt on iOS and 48 × 48dp on Android, even when the drawn control is smaller; controls
  and rows usually 44–56pt tall; body text at least 16pt.
- Navigation as the platform does it: a stack with a back gesture and back button, a tab bar for top-level sections,
  the system headers; Android's back button and predictive back.
- Menus, pickers and secondary panels become sheets or full pages; no hover, no tooltips, no pointer-only actions;
  long press and swipe for secondary actions, always with a visible alternative.
- Safe areas, the software keyboard (inputs stay visible, Return moves to the next field), Dynamic Type / font size,
  the system's press and scroll physics.

**TUI: keyboard and cells.** In a terminal (`platform.idiom === "terminal"`) design for the keyboard and the
character grid.
- Every action has a key; Tab and arrows move focus visibly; Enter activates, Escape goes back; show the keys that
  matter in a footer or help line.
- Layout snaps to whole cells: no fractional spacing, no radii or shadows that cannot render; boxes drawn with line
  characters, separators as single lines.
- Terminal colors and attributes (bold, dim, reverse) carry state; never color alone; works in 16 colors and in
  monochrome.
- Text labels instead of icons whose glyphs may be missing; terminal mouse input is a bonus, never required.

A component keeps its value, events and accessibility meaning across families while its presentation changes: a popup
with a pointer, a sheet on a phone, a framed list in TUI. Use device and idiom information (`platform.idiom`,
`platform.desktop`), not assumptions. Validate the `ui` layer in each target's appearances, input modes and viewports,
including terminal cells when TUI is a target ([TUI](./tui.md)).

## Learning from Shadcn

Shadcn's most useful contribution is not a particular border color. It is a way of building a system:

- own the top layer of the interface instead of fighting a sealed abstraction;
- compose small, predictable parts into product-specific components;
- provide defaults that already form one visual language;
- keep the code and composition legible to both people and AI;
- separate behavior primitives from the styled layer.

NSH applies those ideas through the split between the primitives of `nsh`, the unstyled base components of
`nsh/base`, and the styled layer, which belongs to the app ([Three layers](./architecture.md#three-layers)).
Applications build their components on `nsh/base`, in TSX or in the app's Rust crate; reusable behavior belongs in
`nsh/base`, and visual policy stays above it.

Do not copy these web assumptions blindly:

| Web habit | NSH default |
| --- | --- |
| Pointing-hand cursor on every button | Default cursor; pointing hand (`cursor-pointer`) for links |
| Page navigation as the main structure | Persistent windows, panes, sidebars, tabs, and menus on the desktops; a `NavStack` with the system's back on phones |
| Browser focus and scrolling as a fallback | Explicit focus ownership and region-owned scrolling (`Scroll`, `List`) |
| Mobile-first single column | One column on phones, a resizable shell with a defined minimum window size on the desktops |
| Hover-revealed critical actions | Keyboard-, touch- and pointer-reachable actions that do not depend on hover |
| A row of hover-only icon buttons | A visible primary action plus `Menu` or `ContextMenu` for secondary commands |
| Link-styled text for application commands | A `Button` in the app's default, outline, or ghost style; link styling only for URLs, web resources, or email addresses |
| Large touch density everywhere | Touch-sized targets on touch screens; medium density with a pointer, compact only where information work benefits |
| A drawn header and alert card on every platform | The system's header and `AlertDialog` on iOS and Android; the page's `header` slot on the desktops and the web |
| CSS overrides across descendants | The app's components, their parts, and the theme's tokens |

## Start from the task

Before drawing a screen, write down:

- the user's primary task;
- the object being viewed or changed;
- the actions that must remain immediately available;
- the information required to make a decision;
- empty, loading, error, offline, read-only, and permission-denied states;
- the keyboard, touch and screen-reader path through the workflow;
- where the app is shown: on its own, or inside a host app.

Organize the screen around those answers. Do not begin with a dashboard grid or a component catalogue. A good interface
exposes the user's mental model: documents, accounts, projects, messages, settings, or another stable object—not the
internal service architecture.

Design the primary task before distributing controls. Its visual weight, location, and information depth should match
its importance to the product. A core result must not be reduced to a small count, an icon in a corner, or a weak
footer action while secondary content consumes the page. When a result set is the product's main value, consider a
summary region or card that exposes the count, representative results, meaningful state, and a clear next action.

For every proposed action, name its visible object, current state, scope, and result. If the interface does not show
or clearly imply those things, the action is premature. Do not expose a capability merely because the backend has it;
first design how the object enters the user's mental model.

## Visual language

Use Liquid Glass deliberately for floating surfaces over content. On supported Apple platforms, use the native material
and provide an appropriate fallback elsewhere. Inspect it over light and dark moving content: an opaque fill can hide
the effect, while too little tint can make controls unreadable. The material supplies its own edge, so add borders or
shadows only when the result needs them. Ordinary settings lists may be clearer with solid grouped surfaces; follow the
product's design and the user's preference rather than applying glass everywhere.

### Hierarchy

Prefer a small number of clear levels:

- **window or page title** identifies the current object or workspace;
- **section title** separates meaningful regions (`role="header"`, so screen readers can jump between them);
- **body text** carries the work;
- **muted text** provides secondary metadata and help;
- **labels** identify controls and values.

Use size, weight, spacing, and separators before adding color or containers. Avoid nesting cards inside cards: most
regions need only a background, a hairline boundary, and intentional spacing.

Evaluate hierarchy across the whole feature, not component by component. Hide accent color and decoration during
review: the primary task, current selection, result summary, and next action should still be obvious from structure.
A screen that contains individually plausible controls can still fail when they do not form one reading order and one
decision path.

Treat emphasis as a limited budget. A local surface needs one clear focal point, not a field of competing highlights.
If everything is colored, badged, bold, boxed, or promoted to an alert, nothing reads as important. Establish priority
with structure and proximity first; spend stronger color and components only where a distinction changes what the
user notices or does.

### Color and themes

Read colors from the theme (`theme()` in Rust, token classes in TSX) and use them by semantic role:

- `background` and `foreground` for the main surface and text;
- `card`, `popover`, `sidebar`, and their foreground tokens for their named surfaces;
- `muted` and `muted-foreground` for supporting information;
- `primary` for the principal action or selection emphasis, `secondary` and `accent` for quieter emphasis and
  hovered or focused rows;
- `destructive` only for destructive actions and errors, and status colors the app adds to its theme (`success`,
  `warning`) only for their meanings;
- `chart-1` to `chart-5` for data series;
- `border`, `input`, and `ring` for structure and interaction.

```rust tabs
use nsh_base::theme;

view()
    .rounded(move || theme().radius)
    .border_1()
    .border_color(move || theme().border)
    .bg(move || theme().background)
    .p_4()
    .gap_1()
    .child(text("Balance").text_color(move || theme().foreground))
    .child(text("Updated just now").text_sm().text_color(move || theme().muted_foreground))
```

```tsx tabs
<View class="gap-1 rounded-(--radius) border border-border bg-background p-4">
  <Text class="text-foreground">Balance</Text>
  <Text class="text-sm text-muted-foreground">Updated just now</Text>
</View>
```

Do not use a semantic status color as decoration. Do not encode meaning by color alone. Verify every custom surface in
light and dark themes and with custom theme values, including the theme of a host app that embeds yours; never assume
that foreground is black or background is white.

Use a badge for a short state, count, or classification that benefits from rapid scanning—not for every label,
metadata value, filter, or section title. Keep most badges neutral; reserve semantic colors for states that truly carry
success, warning, destructive, or informational meaning. A row of multicolored badges is usually a missing hierarchy or
grouping decision.

Application UI should not contain raw hex, `rgb()`/`rgba()`, or `hsl()` colors, or palette classes such as
`bg-zinc-100`. Resolve colors from the theme by semantic role. If the required role does not exist, define it in the
app's theme file ([Theme tokens](./tailwind.md#theme-tokens): `"up": "#16a34a"` in its `light` and `dark` makes
`text-up`, `bg-up/30`, `token("up")` in TSX and `theme().color("up")` in Rust) rather than embedding a palette value
at the call site. Raw colors belong only inside theme definitions or in audited data/raster content whose color is itself the data.

### Radius, spacing, and density

Use a finite radius scale, as with type and control sizes. Choose from the theme's `radius` (for controls and
surfaces alike, `rounded-(--radius)`), radii the app adds to its theme, and Tailwind's `rounded-sm` … `rounded-2xl` between them) instead of inventing a
radius for each element. Large containers may use a softer tier than the controls they contain; compact controls and
overlays use tighter tiers. For an ordinary rectangle, the radius should remain visibly smaller than half its shorter
side. Use `rounded-full` (`.rounded_full()`) only for intentional circles and pills; a tooltip must not become a
capsule by accident.

Nested surfaces should read as concentric shapes. Use `inner radius ≈ max(0, outer radius − gap)` to choose the
closest suitable radius; the visible band should remain even through the turn. Add a named token to the theme
(`"radius-inset": "0.375rem"`, `rounded-(--radius-inset)`) if a repeated composition needs an intermediate value. A segmented
control is one silhouette: its end segments follow the container's inner corners, its middle segments remain square,
and each boundary has one divider of consistent thickness.

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/radius-hierarchy-light.svg" alt="Light theme chat composer: the inset surface, both buttons, and placeholder spacing change together; red guide circles show their shared corner center.">
<img class="diagram diagram-dark" src="/diagrams/radius-hierarchy-dark.svg" alt="Dark theme chat composer: the inset surface, both buttons, and placeholder spacing change together; red guide circles show their shared corner center.">
</div>

A radius must govern the entire visible surface, not just its border. Exposed corners remain transparent to the
surface behind them; child backgrounds, selection fills, and scrolling content must also follow the boundary. Give
inner surfaces their own radius, or clip the container with `overflow-hidden` (`.overflow_hidden()`), then inspect
the composition against a contrasting background in both themes. Preserve outward focus rings when choosing a clip.

Use a compact spacing scale and repeat it. Related label/control pairs should be closer than separate groups; separate
groups should be closer than separate sections. Prefer the sizes of the app's components (small, default medium,
large) over one-off heights. Use compact variants for toolbars and data-dense screens, not to squeeze an unclear layout
into less space.

The shared semantic scale is intentionally small: spacing progresses through roughly 2, 4, 8, 12, 16, 24, and 32
points, while typography stays near 12, 14, 16, 18, and 20 points. Treat these as relationships rather than permission
to scatter their current values through feature code. Tailwind's spacing scale gives them: one step is 4 points
(`p-4` is 16pt), in classes and typed Rust methods alike; `"spacing"` in `nsh.json`'s `"tailwind"` changes the step of
classes, and typed methods keep Tailwind's default scale. An application that needs a different scale owns it in its
own components or theme tokens (`p-(--gap-card)`) and uses it consistently.

### Spatial grammar

Spacing expresses relationship. Choose a gap from the semantic scale by asking what the two things mean to each other:

| Relationship | Typical class | Current scale | Examples |
| --- | --- | --- | --- |
| Optical correction | `gap-0.5` | 2 pt | icon baseline, compact separator |
| Parts of one control | `gap-1` | 4 pt | menu icon/label, title/description |
| Closely related controls | `gap-2` | 8 pt | button icon/label, dialog actions |
| One content group | `gap-3` | 12 pt | notification columns, compact form rows |
| Separate groups in one section | `gap-4` | 16 pt | panel padding, form groups |
| Separate sections | `gap-6` | 24 pt | major blocks in a page or inspector |
| Major region boundary | `gap-8` | 32 pt | empty-state breathing room, page bands |

These values describe the default scale, not literals to repeat. Use the spacing classes and typed methods (`gap-2`,
`.gap_2()`, `p-4`, `.p_4()`) or the theme's tokens. A product-owned scale should preserve the ordering and
relationships and must be passed through the application's own components rather than written at each call site.

Use these rules when resolving horizontal and vertical space:

1. **Inside before outside.** A component's padding belongs to the component; the gap between components belongs to
   their parent.
2. **Vertical rhythm shows grouping.** The gap between a title and its description is smaller than the gap from that
   description to the next section. Equal gaps imply equal relationships.
3. **Horizontal space supports scanning.** Repeated rows keep icons, labels, values, badges, and trailing actions on
   stable columns.
4. **Leading and trailing are semantic.** Think in reading-order edges and write them as start and end (`ps-*`,
   `me-*`, `.ps_4()`), so the layout mirrors right to left.
5. **Do not double padding.** A card placed in an already padded panel should not automatically add another full
   panel inset.
6. **Use optical alignment sparingly.** A one- or two-point correction is valid for icon or glyph geometry, but
   document why it differs from the scale.

Common compositions illustrate the relationships:

- button contents use 4 pt at small sizes and 8 pt at normal sizes;
- dialog headers and footers use an 8 pt internal gap;
- compact list and menu rows use 4 pt vertical and 8–12 pt horizontal padding;
- sheet headers use about 16 pt leading and 12 pt trailing space, leaving room for a close affordance, while footers
  use 16 pt horizontal and 12 pt vertical space;
- notifications use 16 pt horizontal padding and a 12 pt column gap because icon, message, and action are distinct
  groups.

Do not treat these as copy-and-paste recipes for every surface. They reveal the system: controls are tighter
internally, rows optimize scanning, and containers spend more space at their boundary than between their contents.

### Proportion and layer hierarchy

Start with content requirements, then set proportions. Avoid arbitrary halves when one pane has a clearly different
role.

- A navigation sidebar should be wide enough for stable labels but visibly subordinate to the work area. Give it a
  minimum, preferred, and maximum width (`min-w-*`, `w-*`, `max-w-*`) rather than a percentage alone.
- In master–detail layouts, let the collection remain scannable and give the detail pane the surplus. A roughly
  one-third/two-thirds starting point is often useful, but content constraints are authoritative. On a phone the two
  become two pages of a `NavStack`.
- Inspectors and auxiliary sheets should not cover the primary object by default. They should be resizable or
  dismissible when their content grows; a [`Sheet`](../elements/sheet.md) closes with its backdrop, Escape and back.
- Dialog width comes from the decision: an `AlertDialog` for a short confirmation, a medium form, or a dedicated
  window/page for complex work. Do not enlarge a dialog simply to create whitespace.
- Reserve the strongest elevation for the topmost decision layer. Within a layer, use background and hairlines—not
  successively larger shadows—to show hierarchy.

Define three size constraints for every major region: the minimum at which its task still works, a comfortable
default, and how it consumes surplus. Persist user-controlled splits when they represent workflow preference, and
clamp restored values against the current window.

### Alignment details

Alignment is a structural system, not a final polish pass. Establish a small set of alignment spines for each surface:
shared leading and trailing edges, text baselines, center lines, and fixed functional lanes. Elements at the same level
should attach to the same spine from top to bottom or leading to trailing, even when they are different component
types.

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/alignment-spines-light.svg" alt="Alignment spines across a content region">
<img class="diagram diagram-dark" src="/diagrams/alignment-spines-dark.svg" alt="Alignment spines across a content region">
</div>

Vertical red lines sit beside shared edges or control centers for content, status, time, and trailing actions.
Horizontal lines sit beneath text baselines or pass through a row center to show bottom and vertical-center alignment.
The compact comparison isolates a one-rendered-pixel drift that must be corrected at its structural owner.

- Give sibling regions a shared content inset. A heading, toolbar, list row, empty state, and footer that describe the
  same level should not each invent a slightly different leading edge.
- Repeat column geometry through the whole region. Headers, rows, summaries, loading states, and inline editors should
  reserve the same lanes for identity, metadata, status, numbers, and actions.
- Align related controls across rows and sections. Form labels, fields, descriptions, and validation messages should
  reveal a stable vertical grid when the page is scanned from top to bottom.
- Keep horizontal bands coherent. Items sharing a toolbar, header, status bar, or row should use one baseline or center
  line instead of individually tuned offsets.
- Introduce indentation only for real hierarchy, containment, or disclosure. Decorative indentation makes siblings look
  subordinate and breaks the surface's reading line.
- When a nested level ends, return exactly to the parent spine. Do not let accumulated padding drift across nested
  containers.
- Preserve the spine through optional content. Missing icons, badges, descriptions, or trailing actions must not move
  the remaining labels; use intentional slots or lanes when cross-row comparison matters.
- Align major regions with one another where their hierarchy matches. Sidebar headers, content titles, split panes,
  toolbars, and bottom bars need not share every coordinate, but coincident levels should form visible continuous
  lines.

Not every edge should align. A child can indent, a primary value can lead its supporting metadata, and a destructive
decision can gain separation. Such exceptions must communicate hierarchy or meaning; they must not result from
uncoordinated component padding. Start with the shared spine, then make the exception explicit.

Treat exact alignment and repeated gaps as quality invariants. When two edges or spaces are intended to be equal, a
one-rendered-pixel difference is a defect, not an acceptable optical approximation. Inspect resolved bounds with a
measurement tool at representative window sizes, text sizes, and display scale factors. Compare coordinates and
distances; do not approve alignment only from a casual screenshot.

The rendered-pixel tolerance is a verification rule, not permission to patch the code with raw point offsets. Equal
relationships should resolve from the same spacing class or method, token, grid definition, or shared component inset.
Fix the common owner when they differ. Account for fractional layout and device rounding (2× and 3× phones, fractional
desktop scales) so intended spines land on the same physical pixel instead of drifting at particular scales.

- Align text by baselines, not by bounding-box centers, when mixed sizes share a row.
- Center icons in a fixed slot so labels do not move when icons differ in intrinsic width.
- Align comparable numbers to the end and use tabular figures (`tabular-nums`); align prose and identifiers to the
  start unless the locale requires otherwise.
- Keep trailing row actions and disclosure indicators in fixed-width lanes.
- Align form controls by their interactive frame, not by help text below them.
- Use `justify-between` (`.justify_between()`) only when the two sides truly own opposite edges; it should not
  disguise missing structure in the middle.
- Hairlines belong on the boundary owner. Two adjacent regions must not each draw the same separator.
- A scrollbar belongs to the region that scrolls and sits against that panel, editor, or window's trailing edge.
  Content padding may inset text and rows; it must not pull the scrollbar into the middle of the surface. Pad the
  scroll view's content, not the scroll view.

### Density tiers

Medium is the default. Change density for the whole local context, not one isolated control:

- **comfortable / large:** onboarding, sparse forms, prominent decisions;
- **standard / medium:** most application chrome and workflows, and every touch screen;
- **compact / small:** desktop toolbars, menus, tables, and repeated professional data;
- **extra compact / xsmall:** exceptional high-density utilities, never the automatic choice for an entire application.

Use a bounded scale rather than arbitrary sizing. On touch screens every pressable target is at least 44 × 44 points
([Touch targets](./accessibility.md#touch-targets)). With a pointer, buttons commonly move through approximately 24, 28,
and 32 pt frames, inputs extend to about 40 pt at large size, and table rows use about 28, 32, and 40 pt. Give the
app's components a size that changes typography, icon, padding, and hit target together; a custom height that changes
only the outer box is usually incomplete.

### Text size, base font, and points

A well-designed scale preserves hierarchy while text grows. Larger text is successful when the relationship between
title and body, control and icon, inner and outer spacing, primary and secondary regions still feels the same at every
size—not merely when every object becomes larger.

NSH's lengths are points, and the user's text size (Dynamic Type on iOS, font size on Android, the desktops' text
scaling, a host app's own setting) scales text: every text and input that allows font scaling grows, while spacing,
radii, borders and images keep their size ([Text size](./device-and-environment.md#text-size)). The app's base text
size (Tailwind's `text-base`, 16 points) is the body size the type scale steps around.

Design in ratios:

- type steps keep the same hierarchy around the base body size;
- spacing steps keep the same grouping relationships around the type;
- control frames and hit targets grow with their labels: size them by their content and a minimum (`min-h-11`), not a
  fixed height;
- pane minima and comfortable widths account for larger text;
- corner radii and focus treatment remain optically consistent with the control frame.

Because text grows on its own, a fixed frame around it breaks: a larger label inside a fixed-height button, a larger
document inside fixed pane minima, or larger rows inside a fixed row height destroys the original rhythm and can clip
content. Let rows wrap or switch to a column when text gets large (`fontScale()`, `font_scale()`), and cap the scale
of text that is already large, such as a 34pt title (`maxFontSizeMultiplier`).

As a rule, application layout should not write literal point values (`p-[13px]`, `px(13.0)`). Use the spacing scale
(`p-2`, `gap-3`, `w-64`, `text-sm` and their typed methods) or the app's component sizes. Use literal points only when
the value represents a physical or raster boundary: a hairline, platform window inset, bitmap dimension, minimum
hit-test tolerance, or geometry that must match an external surface. These are audited, documented exceptions. Product
spacing, typography, icon size, and ordinary control geometry stay on the scale.

Test at several text sizes, not just the default. Verify hierarchy, wrapping, truncation, minimum window size, pane
resizing, focus-ring clearance, popup placement, and list row measurement.

### Surfaces and elevation

Use elevation to explain stacking, not importance. The base surface is flat; separators and background contrast define
its regions. Popovers, menus, sheets, dialogs, and notifications may use progressively stronger shadows because they
sit above other content. Do not put a shadow on every card.

All surfaces of the same kind should share one treatment. Give the popup families one themed surface (the `popover`
tokens, the border, `radius` and one shadow) so `Popover`, `Menu`, `ContextMenu` and `Tooltip` do not drift apart.
When an application invents another anchored surface, reuse that treatment instead of approximating it with unrelated
border and shadow literals.

### Typography and icons

Use the platform UI font for interface text and monospace only for code, identifiers, shortcuts, and aligned numeric
data. Keep body text readable and avoid excessive uppercase or letter spacing, especially for CJK text.

Use one icon family in a product. Icons supplement labels; they should not replace unfamiliar actions with guesswork.
Icon-only buttons always need an accessible name (`accessibilityLabel`). Their visual explanation follows the tooltip
policy below. Use filled or colored icons to communicate a state, not merely to make a toolbar lively.

## Layout patterns

### Choose a stable shell

Most applications should use one of these shells:

- **single workspace:** a header or toolbar above one primary view;
- **navigation stack:** pages pushed and popped (`NavStack`), with the system's back gesture on phones;
- **sidebar workspace:** persistent navigation beside a changing detail view;
- **master–detail:** resizable collection and detail panes, two pages on a phone;
- **document workspace:** tabs for multiple long-lived objects;
- **utility window:** one focused task with a short, fixed action path.

Keep global navigation stable while content changes. Give the primary work area the remaining space with `flex-1`
(`.flex_1()`) and `min-w-0` / `min-h-0` where overflowing children must shrink. Use `Scroll` and `List` for their
intended behavior instead of rebuilding scrolling or virtualization from nested views.

On the desktops, a title bar of the app's own ([`nsh/desktop`](../modules/nsh-desktop.md)) is window chrome first.
Preserve its drag region (`.window_drag(true)`) and avoid binding ordinary title clicks to infrequent editing
commands. Rename belongs behind an explicit object command, with a keyboard path where appropriate.

### Responsive windows

A window can be any size: the user, a split view or the host app decides it. Decide what happens as a window narrows:

1. preserve the primary task;
2. allow resizable regions to reach a documented minimum;
3. collapse secondary labels or inspectors;
4. move low-frequency actions into a menu;
5. scroll only the region whose content actually overflows.

Do not hide an action without providing another path to it. Avoid making the entire window scroll when only a list or
document body should scroll. Breakpoints (`md:`, `lg:`) and `windowSize()` (`window()` in Rust) follow the surface NSH
renders into.

NSH's flex layout has the same intrinsic-size pressure found in other layout systems: a `flex-1` child may still refuse
to shrink around long content. Design and implementation must agree on which panes may shrink, truncate, wrap, or
scroll. A clipped region also clips an outward focus ring; never trade away keyboard visibility merely to simplify
overflow.

### Forms and settings

Use a visible label for each field and place help or validation next to the field it describes. Align related fields,
but do not force long labels into a narrow fixed column. Use the appropriate control: `Checkbox` for independent
choices, a [`RadioGroup`](../elements/radio.md) of `Radio`s for a small visible set, a `Menu` of choices for a longer set,
and [`Switch`](../elements/switch.md) for a setting that takes effect immediately. Their parts (the switch's track and
thumb, the checkbox's indicator) are the app's to style, with `checked:`, `indeterminate:` and `disabled:` classes
that follow the control:

```rust tabs
use nsh_base::{switch, theme};

fn setting_switch(label: &'static str, on: Signal<bool>) -> impl IntoElement {
    switch()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_3()
        .track_style(|s| {
            s.w(px(44.0))
                .p(px(2.0))
                .rounded_full()
                .bg(move || theme().muted)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary))
        })
        .thumb_style(|s| {
            s.size(px(20.0))
                .rounded_full()
                .bg(move || theme().background)
                .shadow_sm()
                .transition_transform()
                .checked(|s| s.translate_x(px(20.0)))
        })
        .child(text(label).text_color(move || theme().foreground))
}
```

```tsx tabs
import { Text } from "nsh";
import { Switch } from "nsh/base";

function SettingSwitch(props: { label: string; on: boolean; onChange: (e: { checked: boolean }) => void }) {
  return (
    <Switch
      checked={props.on}
      onChange={props.onChange}
      class="flex-row items-center gap-3"
      trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
      thumbClass="size-5 rounded-full bg-background shadow-sm transition-transform checked:translate-x-5"
    >
      <Text class="text-foreground">{props.label}</Text>
    </Switch>
  );
}
```

A "select all" checkbox shows a partial selection with its indeterminate state:

```rust tabs
use nsh_base::{checkbox, theme};

fn select_all(selected: Signal<usize>, total: usize) -> impl IntoElement {
    checkbox()
        .checked(move || selected.get() == total)
        .indeterminate(move || selected.get() > 0 && selected.get() < total)
        .on_change(move |all: &bool| selected.set(if *all { total } else { 0 }))
        .flex_row()
        .items_center()
        .gap_2()
        .indicator_style(|s| {
            s.size(px(20.0))
                .items_center()
                .justify_center()
                .rounded(move || theme().radius)
                .border_2()
                .border_color(move || theme().border)
                .checked(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
                .indeterminate(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
        })
        .indicator(text(move || mark(selected.get(), total)).text_color(move || theme().primary_foreground))
        .child(text("Select all").text_color(move || theme().foreground))
}

fn mark(selected: usize, total: usize) -> &'static str {
    if selected == total { "✓" } else if selected > 0 { "–" } else { "" }
}
```

```tsx tabs
import { Text } from "nsh";
import { Checkbox } from "nsh/base";

function SelectAll(props: { selected: number; total: number; onChange: (e: { checked: boolean }) => void }) {
  return (
    <Checkbox
      checked={props.selected === props.total}
      indeterminate={props.selected > 0 && props.selected < props.total}
      onChange={props.onChange}
      class="flex-row items-center gap-2"
      indicatorClass="size-5 items-center justify-center rounded-(--radius) border-2 border-border checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary"
      indicator={
        <Text class="text-primary-foreground">
          {props.selected === props.total ? "✓" : props.selected > 0 ? "–" : ""}
        </Text>
      }
    >
      <Text class="text-foreground">Select all</Text>
    </Checkbox>
  );
}
```

Disable submission while an operation is in flight, keep the user's input, and show the result near the action. Keep
inputs above the software keyboard (`env(keyboard-inset-height)`). Reserve dialogs for short, focused decisions; use a full
page or sheet for workflows that need exploration or many fields.

A loading treatment must represent actual waiting. Switching between settings panels whose content is already
available should be immediate; a skeleton is appropriate only while content is genuinely loading and its shape is
known.

## Components and composition

Follow the Shadcn principle that components are building material rather than a sealed design system. `nsh/base`
supplies behavior; the app supplies coherent defaults in its own components and owns composition and product
semantics.

- Use component variants by meaning. Primary is reserved for the explicit default commit in a decision area—normally
  the action invoked by Return on the desktops. A lone, frequent, or desirable action is not automatically primary. An
  `Add` command in a management toolbar normally uses a default button; a form's default `Create` commit may use
  primary. Use destructive for destructive commitment and ghost for quiet toolbar actions.
- Prefer explicit parts and slots over styling arbitrary descendants.
- Keep a repeated pattern consistent across the product. Wrap it in an application component when it carries domain
  language or policy.
- Use the standard component for its semantic role. `Menu`, `ContextMenu`, `Popover`, `Sheet`, `Dialog` and
  `AlertDialog` are not interchangeable boxes; each owns different selection, focus, keyboard, dismissal, and layout
  contracts, and takes its own form on each device.
- Preserve the component family's geometry. Menu rows share vertical and horizontal padding, height, icon and
  checkmark slots, separators, radius, and state treatment. Do not imitate one menu with a custom popup whose spacing
  only approximates the system.
- Do not wrap a component merely to rename every prop or freeze all of its capabilities.
- Move reusable behavior without product styling to `nsh/base`, or to a crate the app's products share; keep themed,
  opinionated presentation in the application's components.

```rust tabs
use nsh_base::{button, theme};

/// The footer of a form: a default Cancel and the primary commit.
fn form_actions(cancel: impl Fn() + 'static, create: impl Fn() + 'static) -> impl IntoElement {
    view()
        .flex_row()
        .justify_end()
        .gap_2()
        .child(
            button()
                .on_press(cancel)
                .rounded(move || theme().radius)
                .border_1()
                .border_color(move || theme().border)
                .px_4()
                .py_2()
                .active(|s| s.bg(move || theme().muted))
                .child(text("Cancel").text_color(move || theme().foreground)),
        )
        .child(
            button()
                .on_press(create)
                .rounded(move || theme().radius)
                .bg(move || theme().primary)
                .px_4()
                .py_2()
                .active(|s| s.bg(move || theme().primary.opacity(0.9)))
                .child(text("Create").text_color(move || theme().primary_foreground)),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Button } from "nsh/base";

// The footer of a form: a default Cancel and the primary commit.
function FormActions(props: { onCancel: () => void; onCreate: () => void }) {
  return (
    <View class="flex-row justify-end gap-2">
      <Button onPress={props.onCancel} class="rounded-(--radius) border border-border px-4 py-2 active:bg-muted">
        <Text class="text-foreground">Cancel</Text>
      </Button>
      <Button onPress={props.onCreate} class="rounded-(--radius) bg-primary px-4 py-2 active:bg-primary/90">
        <Text class="text-primary-foreground">Create</Text>
      </Button>
    </View>
  );
}
```

### Component standards

These standards are general; the app's style supplies the values. The numbers quoted are a starting point for an
app that has no style of its own yet. An app with its own look (larger radii, taller controls, its own palette) keeps
it, and applies the same relationships to its own values, so its controls agree with each other without per-screen
tuning:

- **One size scale drives everything.** A control takes one `size` (xs, sm, md default, lg), and the size sets its
  height, horizontal padding, text size, icon size, gap and radius together; never set them one by one per use. Sizes
  differ by family: on desktop and web, as a starting point, buttons are 20 / 24 / 32pt tall (xs / sm / md and lg), inputs share those heights, table rows 26 / 30 / 32 /
  40pt with cell padding growing in step. On mobile, controls follow iOS and Android (44pt / 48dp targets, 44–56pt
  rows); in TUI, sizes are whole cells. A `compact` variant tightens padding, not height.
- **Icon buttons are squares of the control height** (20 / 24 / 32pt) with a 14–16pt icon; a button's icon is one step
  smaller than its text line. A button group or toolbar uses one size throughout.
- **Radius comes from two tokens.** `radius` (6pt as a starting point) for controls and popups, `radius-lg` (8pt) for
  containers that hold controls; small controls and tags take half the radius. Fully round shapes come from the theme
  too (`radius-full`), so a theme that squares its corners squares avatars, dots and thumbs as well.
- **States are tokens per variant.** Each variant (default, primary, secondary, danger, ghost, outline) has a normal,
  hover and active color in the theme (`primary`, `primary-hover`, `primary-active`); tinted and ghost variants use
  one hue at rising strength, about 10% at rest, 20% hovered, 40% pressed. A selected button and a button whose menu
  is open share one style. Disabled shows no hover or press; loading dims the control slightly and keeps its size.
- **Composite controls read as one.** In a split button or segmented group, hovering one part shows the others'
  hover at half strength; only the outer corners are rounded.
- **One popup surface.** Popover, menu, select, combobox and date picker share one style: the popover background, a
  ring-and-shadow edge, the theme radius. A new anchored surface reuses it.
- **Focus ring outside the border.** The ring is drawn outside the control (its radius the control's plus the ring
  width), so translucent backgrounds stay intact; leave it room where an ancestor clips.
- **Inputs and lists share padding.** Text inputs, selects and the lists they open use the same horizontal padding
  per size, so text in a field and in its dropdown starts on one line.

## Interaction states

### Make the result understandable before the click

A control should predict its result. Use familiar platform controls and placement so people can act without learning
the interface first. Its label names the action and object, its state shows availability, and its feedback confirms
the same outcome.

Do not label a Button `Save` if it opens a configuration flow, or `Delete` if it only removes an item from a group.
Name the scope when context does not make it clear. Respond immediately to activation, prevent duplicate submission
during longer work, and show the result near the object that changed. Add a success message only when the result
itself is not visible.

For a reversible setting, the selected checkmark or switch position is the immediate feedback: update it on the user's
action while saving in the background. Do not add a persistent saving or success banner for each ordinary toggle when
the control already shows the outcome. If saving fails, restore the confirmed value and explain the failure near the
control or in a nonintrusive message. Reserve explicit progress or confirmation for actions whose outcome is not yet
visible or whose consequences require it.

Every interactive control should be designed for:

| State | NSH | Design requirement |
| --- | --- | --- |
| Rest | | Clear affordance without visual noise |
| Hover | `hover:` | Subtle pointer feedback, never the only cue |
| Pressed | `active:` | Immediate press feedback, styled by the app |
| Open / pressed | the popup's `open` | Persistent feedback while an attached popup is open |
| Focus visible | `focus-visible:` | High-contrast keyboard focus ring |
| Selected / checked | `selected:`, `checked:` | Persistent state distinct from hover |
| Disabled | `disabled:` | Lower emphasis and no misleading hover/pressed response |
| Loading | | Preserve context, prevent duplicate action, explain long waits |
| Error | | State what happened and how to recover |

Bind commands that should work from the keyboard with [`keymap`](../modules/nsh.md#keymap) on the desktops and
the web. Match familiar platform shortcuts (`"mod+k"` is Command on macOS, Control elsewhere), expose shortcuts in
menus or tooltips, and keep focus in a logical place after opening or dismissing an overlay.

Selection is part of the information model, not optional polish. Tabs, segmented choices, selectable rows, filters,
and navigation destinations must show a persistent selected state (`selected`, which screen readers announce). A
button that owns a menu must remain visibly pressed or open until the popup closes; hover alone cannot explain the
relationship between trigger and surface.

```rust tabs
use nsh_base::{tab, theme};

fn section_tab(label: &'static str, id: Section, current: Signal<Section>) -> impl IntoElement {
    let selected = move || current.get() == id;
    tab()
        .selected(selected)
        .on_press(move || current.set(id))
        .rounded(move || theme().radius)
        .px_3()
        .py_2()
        .selected_style(|s| s.bg(move || theme().muted))
        .child(text(label).text_color(move || {
            if selected() { theme().foreground } else { theme().muted_foreground }
        }))
}
```

```tsx tabs
import { Text } from "nsh";
import { Tab } from "nsh/base";

function SectionTab(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Tab
      selected={props.selected}
      onPress={props.onPress}
      class="group rounded-(--radius) px-3 py-2 selected:bg-muted"
    >
      <Text class="text-muted-foreground group-selected:text-foreground">{props.label}</Text>
    </Tab>
  );
}
```

In a segmented control, the selected fill and unselected surface must share the container's silhouette. Neither may
square off an end corner or make a boundary appear heavier than its peers.

Show a selected navigation item, list row, or tab through the item's own surface: a selected fill, stronger
foreground, or heavier weight. Do not add a leading-edge bar or one-sided border as the selection marker. It is a web
template habit, not a native convention; it breaks the item's rounded silhouette and adds a second, competing edge to a
column that already aligns on its text.

For destructive actions, distinguish between reversible and irreversible work. Prefer undo or a temporary notification
for reversible changes. Use an [`AlertDialog`](../elements/alert-dialog.md) when the consequence is serious and cannot
be undone; name the specific object and consequence in the confirmation copy.

### Pointer conventions

Use the default cursor for buttons, checkboxes, menu items, tabs, and other controls. Use a pointing hand
(`cursor-pointer`) for links and content that behaves as a link. Use text, resize, grab, and prohibited cursors only
when they describe the active manipulation. A cursor reinforces an affordance; it does not replace the control's
visible state or accessible role.

Keep hover effects modest because touch, keyboard, and accessibility interaction have no hover. Do not reveal the only
copy of a destructive or essential action on hover. Contextual row actions may become quieter at rest if the same
commands remain available through selection, keyboard, or a context menu.

### Prefer command surfaces over hover toolbars

Use command frequency and scope to choose where an action lives:

- keep the primary or frequent action visible as a labeled button or familiar toolbar control;
- put secondary actions for the current region behind a visible [`Menu`](../elements/menu.md) trigger;
- put commands that act on the object under the pointer or finger in a `ContextMenu`: a right click on the desktops,
  a held finger on touch screens;
- expose the same important command through a keyboard shortcut ([`keymap`](../modules/nsh.md#keymap)) when it has
  a natural keyboard form, and in the application menu (`Menu.setApplicationMenu` from
  [`nsh/desktop`](../modules/nsh-desktop.md));
- use a hover-revealed icon only as a shortcut to a command that remains reachable elsewhere.

This is more than a visual preference. `nsh/base`'s menus already own placement at the trigger, cascading submenus on
the desktops and a sheet with submenus in place on phones, dismissal by choosing an item, a press outside, Escape or
back, and the menu and menu item roles for screen readers. A custom strip of hover buttons must rebuild those behaviors
and is invisible to touch, keyboard-only, and many assistive technology workflows.

```rust tabs
use nsh_base::{menu, menu_item, menu_separator, theme};
use nsh_core::{color::black, element::StyleRefinement};

/// The app's popup surface, shared by its menus, popovers and tooltips.
fn popup(s: StyleRefinement) -> StyleRefinement {
    s.min_w(px(192.0))
        .p_1()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().popover)
        .shadow_lg()
}

fn item(label: &'static str, on_select: impl Fn() + 'static) -> impl IntoElement {
    menu_item()
        .on_select(on_select)
        .px_3()
        .py_2()
        .rounded(move || theme().radius)
        .hover(|s| s.bg(move || theme().muted))
        .active(|s| s.bg(move || theme().muted))
        .child(text(label).text_color(move || theme().foreground))
}

fn more_menu(rename: impl Fn() + 'static, duplicate: impl Fn() + 'static, delete: impl Fn() + 'static) -> impl IntoElement {
    menu()
        .offset(px(4.0))
        .popup_style(popup)
        .backdrop_style(|s| s.bg(black().opacity(0.5)))
        .trigger(
            view()
                .label("More actions")
                .size(px(44.0))
                .items_center()
                .justify_center()
                .rounded_full()
                .active(|s| s.bg(move || theme().muted))
                .child(text("⋯").text_color(move || theme().foreground)),
        )
        .child(item("Rename…", rename))
        .child(item("Duplicate", duplicate))
        .child(menu_separator().h(px(1.0)).my_1().bg(move || theme().border))
        .child(item("Delete…", delete))
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

/** The app's popup surface, shared by its menus, popovers and tooltips. */
export const popup = "min-w-48 rounded-(--radius) border border-border bg-popover p-1 shadow-lg";
const item = "rounded-(--radius) px-3 py-2 hover:bg-muted active:bg-muted";

function MoreMenu(props: { onRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <Menu
      offset={4}
      popupClass={popup}
      backdropClass="bg-black/50"
      trigger={
        <View accessibilityLabel="More actions" class="size-11 items-center justify-center rounded-full active:bg-muted">
          <Text class="text-foreground">⋯</Text>
        </View>
      }
    >
      <MenuItem onSelect={props.onRename} class={item}><Text class="text-foreground">Rename…</Text></MenuItem>
      <MenuItem onSelect={props.onDuplicate} class={item}><Text class="text-foreground">Duplicate</Text></MenuItem>
      <MenuSeparator class="my-1 h-px bg-border" />
      <MenuItem onSelect={props.onDelete} class={item}><Text class="text-foreground">Delete…</Text></MenuItem>
    </Menu>
  );
}
```

Choose `Menu` when users need a visible indication that more commands exist—for example a toolbar overflow, document
actions, or account menu. Choose `ContextMenu` for selection- or object-scoped commands such as rename, duplicate,
reveal, or remove. The context menu must not be the only way to perform an essential command; provide a menu-bar,
toolbar, keyboard, or detail view path as appropriate.

Do not put every action into a menu to make a screen look minimal. Discovery and speed matter: the main action stays
visible, dangerous items remain clearly labeled and separated, and a menu item should use the same verb, icon,
shortcut, enabled state, and result everywhere it appears.

### Button means application action; Link means external resource

Use a `Button` when activation changes application state, confirms a decision, opens a tool, submits data, or runs a
command. Choose its treatment by local hierarchy:

- primary button for the one emphasized commitment in a decision area;
- default button for ordinary visible actions;
- outline button when an action needs a clear boundary with less emphasis;
- ghost button for familiar, low-emphasis toolbar and inline actions;
- icon button only for a well-known symbol, with an accessible name and a tooltip when meaning or scope is unclear.

Do not assign primary because a button is the only action on screen, because it is placed at the top right, or
because the team wants more clicks. Primary communicates default commitment and keyboard behavior. If activation is
merely an ordinary command such as adding an item, opening a tool, or refreshing a view, use a default, outline, or
ghost button according to its local hierarchy.

Use an underlined link (`role="link"`) only for an external resource target: a URL, web page, online documentation, or
email address. It uses the pointing-hand cursor because its contract is leaving the current application context for
that resource. Do not use link styling to make a functional command look quiet. A link-shaped Delete, Save, Refresh,
Add, Open-menu, or in-app navigation action hides the control's affordance and exposes the wrong accessibility role.

“View” does not make an in-app destination a link. A full report, analysis, details panel, or local record still opens
through a button, row, card, tab, or disclosure control. Use concise context-aware labels such as `Full analysis` when
the containing card already establishes what opens; reserve underlining for a resource that actually opens in a browser
or mail client.

All internal navigation—sidebar rows, tabs, breadcrumbs, list items, opening a local view, or switching
workspaces—must use the navigation stack, a `Button`, or the corresponding component. Visual emphasis is chosen through
the button's variant or the navigation component's selected state, never by lying about semantics.

## Feedback and overlays

Choose the smallest surface that fits the decision:

- tooltip: a short explanation or shortcut ([`Tooltip`](../elements/tooltip.md), or any element's `tooltip`);
- popover: contextual controls that do not interrupt the task ([`Popover`](../elements/popover.md));
- menu: a compact list of actions ([`Menu`](../elements/menu.md));
- notification: asynchronous status that does not require a decision;
- dialog: a focused decision or short form ([`Dialog`](../elements/dialog.md));
- alert dialog: explicit confirmation of a consequential action ([`AlertDialog`](../elements/alert-dialog.md));
- sheet: supplementary work that benefits from more persistent space ([`Sheet`](../elements/sheet.md)).

Each takes the form its device expects, from one structure the app styles (`popupClass`, `backdropClass`):

| | Desktops | Phones and tablets |
| --- | --- | --- |
| `Tooltip` | after the pointer rests on the element | only when the app opens it |
| `Popover` | anchored; a press outside closes it and goes on | anchored; a press outside only closes it |
| `Menu` | a popup at the trigger, cascading submenus | a sheet at the bottom; a submenu takes the place of its items |
| `ContextMenu` | the secondary button, at the pointer | a held finger opens the sheet |
| `Sheet` | an edge panel over a backdrop | the same |
| `AlertDialog` | an alert in the platform's dialog style | the system's alert or action sheet |

A tooltip supplies missing meaning; it does not restate an obvious action. Reserve it for an unfamiliar symbol,
ambiguous scope, or a useful shortcut that is otherwise hidden. Repeated, recognizable commands such as Copy and
Download in a message footer need accessible names and keyboard access, but their hover labels add interruption rather
than clarity. Phones show a tooltip only when the app opens it, so a tooltip must never carry what a touch user needs.

An alert interrupts the visual hierarchy even when it does not open a modal. Use it for important, exceptional
information that needs attention in the current task, not as a decorated container for ordinary descriptions, tips,
or empty space. Prefer inline help, muted text, or a normal section when the content does not require immediate notice
or action.

Avoid stacking overlays. Escape and the Android back button dismiss the topmost dismissible layer; keep the app's state
in sync from `onOpenChange`, and return focus to the trigger or the next logical target.

An overlay action must refer to an object or state the overlay actually shows. For example, expose `Clear history`
only when a distinct recent-history section is visible and contains entries. Search results, recent items, and
favorites are different collections; label and separate them instead of merging them into one unexplained list. Hide
an inapplicable action or disable it with a useful reason—do not park an ambiguous trash icon in a footer.

Footer space is not a catch-all for capabilities that lacked a place in the design. A footer may present shortcuts,
status, or actions that apply to the whole surface, but each item must answer: what is its object, why is it available
now, what scope does it affect, and what visible state changes after activation?

## Motion

Motion explains change: where something came from, where it went, what the press did, what is live. It is part of an
NSH app's quality, not an afterthought, and NSH runs it natively: transitions, motions, springs, layout animations
and shaders play on the UI thread at the display's frame rate, with no JS per frame. Use them wherever they make a
change easier to follow, and nowhere else. Motion is never ambient decoration, never needed to understand state, and
never a default animation added to every component.

### Choose the tool by what changes

| What changes | Tool | Example |
|---|---|---|
| A state style: hover, press, selected, open, disabled, a color | Transitions: `transition` / `duration-*` / `ease-*` classes, `transition_*()` in Rust | A row's hover wash, a button pressing to 0.97 |
| A view appears or leaves | A motion (`createMotion({ enter })`, `motion().entering(..)`), or a popup's `*StartingStyle` / `*EndingStyle` | A dialog rising 10pt, a menu growing out of its trigger |
| Items arrive together | Motions with a capped, index-based delay, or `Animated.stagger` | A list's rows coming in as a wave |
| One element moves between places | An animated value with `timing` | A tab or sidebar selection sliding to the chosen item |
| The user throws, drags or releases | `spring` / `decay` with the gesture's velocity | A sheet snapping open, a card returning to rest |
| A small playful acknowledgement | `spring` with low damping, or keyframes that overshoot | A like's heart popping |
| Frames change because the layout changed | `LayoutAnimation` before that one update | A sidebar collapsing at a breakpoint, an item removed |
| Something is live or continuous | A `Shader` with uniforms (animated values, `nsh.time`) | Playing bars, an audio-reactive glow, a loading shimmer |
| The value follows a scroll offset or pointer | Animated values bound to it (`interpolate`, arithmetic) | A sticky header folding, a selection following a scrolled list |

Pick the lightest tool that says the change: a transition before a motion, a motion before an animated value, an
animated value before a shader. See [Animation](./animation.md) for the APIs and
[Shader](../elements/shader.md) for shaders.

### Motion inventory (required)

Motion that is left to judgment gets skipped. Every screen an app adds or changes therefore has a written motion
inventory, kept in the app's design document (`DESIGN.md`) or the pull request, written **before** the screen's code
and checked **before** the work is called done.

1. **List every state change on the screen**, going through these kinds one by one and writing "none" only for a
   kind the screen truly lacks:
   - press and hover on each control;
   - a glyph or label that changes (play / pause, send / stop, a count, a status);
   - a selection that moves (tabs, a sidebar's current item, a segmented control);
   - content that arrives or leaves (a page, a list's rows, a message, a result, a toast);
   - a surface that opens or closes (a menu, popover, dialog, sheet, panel);
   - a layout that changes by the user's action (a sidebar collapsing, an item added or removed);
   - a drag, swipe or throw that is released;
   - loading and progress (a skeleton, a streaming reply, a spinner);
   - something live or continuous (playback, recording, a reply being written, data that updates).
2. **For each, name the tool and the tokens** ("Choose the tool by what changes"): for example "send / stop: glyph swap,
   `base`, ease-in-out", "current chat: one sliding selection, `base`", "new message: rise 8pt and fade, `slow`,
   ease-out", "streaming: a breathing caret, paused at rest".
3. **Mark what reduced motion does** for each line.
4. **Verify each line in the running app** before finishing, and say which ones were checked.

An inventory in which every line is "fade in" or "hover color" is not done: it is the default the inventory exists
to replace. A line may say "no motion" with a reason (a value that updates many times a second, a dense data cell).

A chat screen, as an example:

| Change | Motion |
|---|---|
| Send button pressed | Scale 0.95, `fast`, soft settle |
| Send ↔ Stop while streaming | Glyph swap (shrink and fade out, grow in), `base` |
| User message sent | Rises 8pt and fades in from the composer, `slow`, ease-out |
| Reply streaming | Caret or thinking mark breathing; paused when idle |
| Reply finished | Actions (copy, retry) fade in under it, `fast` |
| Current conversation changes | One selection background slides to it, `base`, ease-in-out |
| Sidebar collapses | `LayoutAnimation` for that update, `base` |
| Conversation menu opens | Grows from the trigger's corner, slides 8pt, `slow`; leaves in `base` |
| A conversation opens | Its messages cross-fade in; the list keeps the reader's position |
| Reduced motion | All of the above instant; the caret rests |

### Define motion tokens once

Like color and spacing, motion comes from the app's tokens, not from numbers written in components; the values
below are a starting point, and an app's character (calm, playful, dense) may tune them. Define one small
set and use it everywhere (as Tailwind classes and as the options of motions and animations):

| Token | Typical value | For |
|---|---|---|
| `instant` | 120ms | A hover wash, a color change |
| `fast` | 180ms | A press, a control's state |
| `base` | 240ms | Moving into place: a selection sliding, an icon swapping, a menu leaving |
| `slow` | 360ms | Reveals: a menu or dialog opening, a pop |
| `slower` | 500ms | Unhurried entrances: a list's wave |
| Easings | ease-out entering, ease-in-out between two places, ease-in leaving; a soft settle `cubic-bezier(0.22, 1, 0.36, 1)` for presses | |
| Distances | 4 / 8 / 16pt | A label rising / a popup sliding / items entering |
| Scales | press 0.95–0.97, enter 0.9–0.97 | |

Keep durations short (most under 300ms; desktop pointer feedback under 200ms). Leaving is faster than entering.
Springs are for things the user throws or that should feel physical; time-based curves are for everything else.

### Layered feedback on controls

Every interactive control answers the pointer in layers, each small:

- **Hover** brings a translucent wash in (120ms ease-out); it does not grow the control or move its neighbors.
- **Press** scales the whole control to about 0.97 (an icon button to 0.95) on a soft settle, and deepens the wash.
  Press feedback is the app's (`active:` / `activeStyle`); NSH draws none of its own.
- **A changed glyph swaps**, it does not jump: play becomes pause by the old icon shrinking and fading while the new one
  grows in (240ms). A glyph that only changes color fades.
- **A changed label** fades in rising a few points, rather than replacing its text in place.
- Cards do not lift or resize on hover: a wash, a cover growing about 1%, a revealed action rising is enough.

```rust tabs
view()
    .on_press(open)
    .transition_transform()
    .duration(150.0)
    .when(!reduce_motion(), |v| v.active(|s| s.scale(0.97)))
```

```tsx tabs
<View onPress={open} class="transition-transform duration-150 active:scale-[0.97] motion-reduce:active:scale-100" />
```

### Surfaces, lists and navigation

- **Popups grow from where they belong.** A menu or popover grows out of the corner nearest its trigger
  (`transformOrigin`), slid a few points toward it, from about 0.97 scale and transparent; it leaves the same way,
  faster and without overshoot. Use the popup's `popupStartingStyle` / `popupEndingStyle` so it animates both ways.
- **Dialogs** rise about 10pt from 0.97 while the scrim fades; **toasts** slide in from the edge they live on.
- **One selection, sliding.** For tabs, segmented controls and a sidebar's current item, draw one selection background
  and slide it to the chosen item (an animated value with `timing`, ease-in-out), rather than one background per item
  switching on and off. When the list scrolls, bind it to the scroll offset so it follows natively.
- **Lists enter as a wave**, once per page entry: rows fade in from a few points away, about 50ms apart, the delay
  capped at the first 10–12 rows so a long list never waits. A recycled cell, a re-render or a data tick plays
  nothing; rows scrolled into view later come in on their own, quickly.
- **Loading gives way, it does not pop.** A skeleton pulses slowly and fades out while the content fades in over it.
- **Navigation follows history**: going back animates back, going forward animates forward; switching between sibling
  sections cross-fades rather than sliding.
- **Layout changes glide only when they are the user's doing** (a sidebar collapsing, an item added or removed, a
  breakpoint): call `LayoutAnimation` before that update, not on every resize.

### Springs and gestures

What the user moves follows the pointer or finger 1:1 in the same frame: a dragged thumb, a scroll bar, a resizer, a
swipe are set, never eased toward the pointer. When the user lets go, hand the gesture's velocity to a spring (or a
decay) so the element continues the throw and settles; interrupting it picks up from the current value.

```rust tabs
let spring = |velocity| Spring { velocity: Some(velocity), ..Spring::default() };
x.spring(0.0, spring(e.velocity_x));
```

```tsx tabs
x.spring(0, { velocity: e.velocity.x });
```

Keep springs critically damped or nearly so for structural motion (sheets, drawers, snapping); save visible overshoot
(stiffness about 180, damping under 12) for small, joyful acknowledgements such as a like.

### Shaders for what is live

Use a `Shader` when a surface shows something continuous or generated that styles cannot draw: a playing indicator, an
audio- or data-reactive glow, a loading shimmer, a background that responds to the content's colors. A shader draws on
the GPU under its children, so the controls on top stay as they are.

- Feed changing data as animated values in its uniforms, so new values do not resend the view; read `nsh.time` only
  for motion of its own.
- Set `paused` whenever nothing is happening (paused media, offscreen, reduced motion): a shader that reads `nsh.time`
  redraws every display frame while it runs.
- Keep its colors from theme tokens and tame their brightness, so text and controls over it keep their contrast.
- Give it a still fallback that reads the same at rest, and hide it from accessibility (`accessibilityElementsHidden`).

### What NSH takes from web motion systems

The web's best component and motion libraries agree on a few patterns; NSH apps adopt their intent, built on native
motions instead of CSS:

- **shadcn/ui**: every overlay animates by its open state, in and out, a short fade with a slight zoom (from 95%) and
  a slide of a few points from the side it opens on, about 150–200ms. In NSH: a popup's `popupStartingStyle` /
  `popupEndingStyle`, a dialog's motion.
- **ReUI**: motion is part of a component's parts, not a wrapper around it: entrances, counters and indicators are
  composed into the component and switched off together with reduced motion.
- **AffectUI**: feedback is layered and tactile: a wash on hover, a whole-button press to 0.97 on a long soft settle
  (`cubic-bezier(0.22, 1, 0.36, 1)`), an icon reacting once.
- **transitions.dev**: motion is tokenized by kind (duration, easing, distance, scale, blur) and reused as named
  patterns: a dropdown morphing out of its trigger, tabs with one sliding indicator, an icon swap (shrink to a
  quarter, fade and blur out while the next grows in), a like button that squashes and springs past its size.

Borrow the intent and the numbers, then check them on each target platform: a desktop pointer wants shorter feedback
than a phone's finger, and iOS and Android system transitions stay the platform's.

### Performance and correctness

- **Create a motion once, in a component body**, and bind its style. A motion created inside a binding that re-runs
  (a prop that ticks with playback, a style that reads a signal) plays again every time.
- **Animate opacity and transform**, not width, height or position, when they say the same thing; animating layout
  costs a layout per frame.
- **Make only what moves.** Thousands of list cells each with a full motion cost native nodes; animate only the
  channels you need, and create a motion lazily on a control that may never move.
- **Interruptions reverse from where the value is**, never restart from an old endpoint; give independently animated
  values stable identity.
- **A continuous preview stays put.** While a pointer moves among related targets, update the preview's content or
  position in place and dismiss it only when the interaction ends; repeated fade-out and re-entry reads as flicker.
- Motion policy belongs to the app: `nsh/base` owns the lifecycle and geometry a transition needs, never a default
  fade or slide.

### Reduced motion

Honor `motion-reduce:` and `reduceMotion()` everywhere: transitions become instant, waves and swaps do not play,
popups appear at once, layout changes jump, and shaders rest (`paused`). Every state stays understandable with all
motion off.

## Sound

Sound is not a default. Most apps are best silent; but in an app it suits (media, messaging, timers, games, or
controls meant to feel tactile), a touch of sound at one or two key moments can be the finishing detail: a message
sent, a switch flipped, a task done. Decide first whether the app needs it, then add it sparingly by these rules.

Sound confirms what the eye already sees; it never carries meaning alone. Keep a small set of short, quiet sounds of
one family, each for one job, so the material says the kind of event before the user knows which one: a choice, a
state switched, something opening or closing, a success, a warning, an error, a result arriving, a notice that asks for
the user. Pick by the job, not by the control: a switch and a checkbox share one sound, a segment and a radio another.
Play them where a change completes (a switch turning, a message sent, a toast's result), not on hover, per keystroke,
per streamed token or for a number that updates constantly. Silence is the default; a sound that repeats while the
user works soon reads as noise.

```rust tabs
const TOGGLE: FileAsset = asset!("sounds/toggle.wav");

let toggle = load_sound(TOGGLE.uri).await?; // once, ahead of the first press
toggle.play(0.6, if on { 1.0 } else { 0.9 }); // a little lower turning off
```

```tsx tabs
import toggleFile from "./sounds/toggle.wav";

const toggle = await Sound.load(toggleFile); // once, ahead of the first press
toggle.play({ volume: 0.6, rate: on ? 1 : 0.9 }); // a little lower turning off
```

Load sounds once, ahead of use, so they play within the frame of the change they accompany. Vary one sound with
`rate` (a switch on and off) before adding another file. Keep the volume below the system's own sounds, and keep
the interface fully understandable with the sound off: on iOS sounds follow the silent switch, and many people never
hear them.

## Designing data-heavy interfaces

Dense does not mean cramped. In tables, trees, long lists, and editors:

- keep headers and primary row identity visually stable;
- align comparable values and use tabular numerals where appropriate;
- distinguish focus, hover, active row, and multi-selection;
- keep sorting and filtering visible and reversible;
- preserve selection by domain identity across filtering and reordering;
- virtualize large collections (`List`) without changing keyboard semantics;
- use progressive disclosure for secondary columns and inspectors;
- provide a useful empty state that explains the next action.

Choose a table for comparison across consistent fields, a list for scanning heterogeneous items, and a tree for real
hierarchy. Do not use a complex data layout as a visual style.

## Interface language

Words are part of the interface architecture. Write the vocabulary for a feature as a system—destinations, objects,
commands, states, and outcomes—not as isolated translations of implementation features. Prefer the shortest wording
that remains accurate in its actual context.

### Let context carry context

Do not repeat information that the surrounding surface already establishes. A sidebar destination is usually the
object or domain itself: use `Users`, not `User Management`; `Shortcuts`, not `Shortcut Configuration Management`. A
column whose rows already contain actions can omit a generic `Operation` heading. A dialog titled `Delete “Roadmap”?`
does not need body text that asks the same question again.

This is context economy, not deletion for its own sake. Add text when it changes the decision: identify the affected
scope, an irreversible consequence, an unusual prerequisite, or a way to recover. Every extra word should answer a
question the current layout does not already answer.

Use nouns for destinations and objects (`Users`, `Appearance`, `Orders`), verbs for commands (`Save`, `Duplicate`,
`Export`), and adjectives or short phrases for states (`Offline`, `Up to date`, `Pending review`). Avoid wrappers such
as `Management`, `Module`, `Page`, `Function`, `Operation`, and `System` unless the word distinguishes a real domain
concept.

### Write each language, do not translate its shape

Start from shared intent, hierarchy, and terminology, then compose each locale as natural interface language. Do not
preserve the source language's word order, number of words, politeness filler, or grammatical category. English
`Users` can express a Chinese feature concept that would literally expand to “user management”; fidelity means
preserving purpose, not preserving tokens.

Remove words supplied by the enclosing information architecture. Inside a `Settings` surface, a destination is often
simply `Account`, not `Account Settings` and never the unnatural singular `Account Setting`. The correct English label
is chosen from its role and neighbors, not from the standalone source phrase.

Maintain a small product lexicon for recurring objects, commands, and states. Use the same term in the toolbar, menu,
context menu, dialog, shortcut search, and documentation unless the context genuinely changes its meaning. Review copy
in the rendered surface: neighboring labels often reveal repetition or inconsistent scope that a locale file cannot.

In localized technical writing, preserve an established framework term when a translation would be less precise. Keep
API identifiers in their original form and format them as code. Do not retain ordinary foreign words merely to sound
technical. Explain a retained term on first use when needed, then use the same form throughout the interface,
documentation, and API examples.

In documentation, use the exact English name for a named API, component, source file, or guide in link text, including
localized pages. For example, write `View`, `Button`, `Menu`, and `Text` rather than translating their names or adding a
redundant `NSH` prefix. Keep surrounding explanations in the page's language. Link only the named target; place words
such as “source” outside the link when they describe why it is cited.

In a technical comparison table shared across locales, keep capability names, framework names, API names, and model
names in their established English form. Translate the explanation around the table, not its technical labels. Common
interface words with an established local name may still be localized outside that comparison context.

### Buttons and confirmation dialogs

Button labels are short by default—usually one or two words—and describe the result, not the gesture or the component.
Prefer `Save`, `Move`, or `Delete` to `Click to save`, `Perform move`, or `Confirm deletion`. Use `Cancel` consistently
for the action that leaves without committing. Reserve `OK` for acknowledging purely informational content.

Short is a default, not a character limit. A deliberately longer label is better when its words expose a consequence
or distinguish choices that users could otherwise confuse, for example `Delete from this group` versus `Delete
everywhere`, or `Restart without saving`. Length must buy decision-critical information; it must not restate the
dialog title or body.

Use the most specific concise result as the confirmation label when possible:

| Context | Weak | Prefer |
| --- | --- | --- |
| Delete dialog | `Yes`, `Sure`, `Confirm deletion` | `Delete` |
| Unsaved changes | `Confirm`, `Yes` | `Discard changes` |
| Pure acknowledgement | `Confirm operation` | `OK` or `Done` |
| Complex consent whose result has no clear verb | `Yes` | `Confirm` |

`Confirm` is a useful fallback when the surrounding dialog fully names a complex commitment and no shorter result verb
is accurate. It should not replace a clear command. `Sure` is conversational rather than a stable English command and
is too ambiguous for the standard vocabulary.

A confirmation dialog should form one compact decision:

- title: the decision or condition, such as `Delete “Roadmap”?`;
- body: only new scope, consequence, or recovery information;
- actions: `Cancel` and the result, such as `Delete`;
- destructive styling: applied to the destructive result (an `AlertDialog` action with the `destructive` role), not
  substituted for precise wording.

Avoid generic titles such as `Notice`, `Warning`, `Error`, and `Confirmation` when the actual condition can be named.
Avoid ritual phrases such as “Are you sure you want to…”, “Would you like to…”, “Please note that…”, and
“successfully” when the structure or state already communicates them. Courtesy should come from a calm, respectful
tone, not repeated `please`.

### Capitalization, punctuation, and symbols

Use sentence case for English UI by default: `Reset layout`, not `Reset Layout` or `RESET LAYOUT`. Preserve proper
nouns and established acronyms. Follow a platform convention such as title case for native menu commands only when the
platform integration benefits from it, and apply that convention consistently within the component class.

ALL CAPS can provide restrained typographic emphasis for very short section labels, eyebrows, statuses, established
acronyms, and code-like identifiers. Its compact shape and measured tracking can form a level similar to bold type, but
it does not belong on buttons, long headings, sentences, or dense lists. Do not combine uppercase, strong color, and
bold weight in the same region, and do not transform every string automatically: product names, acronyms, and
localized content must preserve their intended casing.

Labels, buttons, menu items, tabs, headings, placeholders, and short states do not take a final period. Complete
explanatory, warning, and error sentences do. Avoid exclamation marks in routine success and failure messages. In
Chinese, use full-width punctuation in sentences and omit terminal punctuation from short control labels by the same
semantic rule.

Use the single ellipsis character (`…`), not three periods. Append it to every button or menu item that opens a dialog,
sheet, or separate window, and to a command that requires more input or choices before it can complete, such as
`Settings…` or `Export…`. An immediately executed command does not take an ellipsis. Use an indeterminate progress
indicator, not decorative dots, to communicate ongoing work.

Errors should say what happened and, when useful, the next recovery action. Success feedback should name the resulting
state only when that state is not already visible. Prefer `Couldn’t save. Check your connection and try again.` to a
technical code or a long apology; omit a `Saved successfully` toast when the document visibly becomes saved.

## Internationalization and platform fit

Accessibility (A11y) names and labels may remain in English; localization is not required for these strings. Keep the
item's own label when naming a control that acts on it, even when that label is localized. This exception does not
apply to visible UI copy.

Copy must survive expansion, CJK typography, right-to-left scripts, and different shortcut notation. Do not size a
control from one English label. Keep text out of raster assets, avoid concatenating translated fragments, and let
labels wrap or truncate only where the product defines a recovery path such as a tooltip.

Respect platform differences that carry meaning: Command versus Control, native window decorations, system
appearance, scrollbar behavior, menus, notification capabilities, and on phones the system header, back gesture, and
alerts. Keep the product's information architecture stable across platforms, but do not erase familiar platform
behavior for superficial pixel equality.

NSH apps run on phones, tablets, desktops, and the web, and often inside a host app. Design for each:

- **System UI keeps the platform's look.** On iOS and Android a page's header is the system's (`NavPage`'s `title` and
  header options); the desktops and the web show the page's `header` slot, which the app draws. Give every page both
  ([Navigation](./navigation.md#navpage-and-the-header)). Confirmations use `AlertDialog`; the status bar follows the
  page or dialog on top (`statusBar`).
- **The host's theme.** An embedded app can be given its host's theme; classes and Rust bindings that read tokens
  follow it natively ([Theme tokens](./tailwind.md#theme-tokens)).
- **Safe areas and the keyboard.** Keep content inside the safe area (`env(safe-area-inset-*)`, `safeAreaInsets()`) and inputs
  above the software keyboard (`env(keyboard-inset-height)`) ([Device and environment](./device-and-environment.md)).
- **Appearance, text size, and motion.** Every surface works in light and dark (`dark:`, `colorScheme()`), at the
  user's text size, and with reduced motion (`motion-reduce:`, `reduceMotion()`).
- **Right to left.** The layout direction follows the locale, and the `direction` style sets it for a view and its
  subtree; start and end properties mirror ([Right to left](./layout.md#right-to-left)).
- **Touch and pointer.** Touch targets are at least 44 × 44 points; hover and tooltips exist only with a pointer.

```rust tabs
use nsh_base::nav_page;

nav_page()
    .title("Inbox")
    .header(page_header("Inbox"))
    .child(inbox())
```

```tsx tabs
import { NavPage } from "nsh/base";

<NavPage title="Inbox" header={<PageHeader title="Inbox" />}>
  <Inbox />
</NavPage>
```

## Guidance for AI-generated interfaces

An AI changing an NSH interface should first inspect the nearest feature, the app's components and theme tokens, and
the component documentation and declarations (`.nsh/types`). It should state the primary task, state owner, component
composition, and keyboard and touch paths before generating code. It must not infer an API from React, React Native
or Shadcn examples or invent an NSH prop or method because the name seems plausible; `nsh check` and the build's class
check report what does not exist.

When it builds or changes an interactive surface, it plans the motion with the layout, not after it: for each state
change on the screen (press, hover, selection, a glyph or label changing, a popup, arriving content, a drag released,
something live) it writes the screen's motion inventory ("Motion inventory") before the code, picks each tool from "Motion", uses the app's motion tokens
(defining them if the app has none), and honors reduced motion. A screen whose every change is an instant swap is
unfinished; so is one that moves without a reason. Sound is added only where the app calls for it ("Sound").

AI output is incomplete until a human can explain why the hierarchy, density, component choice, and exceptional
literal values belong in this product. A visually plausible screenshot is not proof: keyboard and touch behavior,
focus, dynamic content, themes, resizing, text size, and failure states are part of the design.

## Accessibility and keyboard (required)

Accessibility and keyboard operation are requirements, not polish: a screen that a keyboard or a screen reader cannot
complete is broken, however it looks. These rules are **musts** on every target.

- **Every action works by keyboard.** On desktop, web and TUI, everything a pointer can do can be done from the
  keyboard: Tab / Shift-Tab move through controls in visual order, arrows move within a group (lists, menus, tabs,
  radios, grids), Enter / Space activate, Escape closes the topmost surface. Frequent commands have shortcuts shown in
  menus and tooltips.
- **Focus is visible and managed.** Every focusable control shows a focus ring when the keyboard moved focus
  (`focus-visible:`); opening a dialog, sheet or menu moves focus into it and closing returns it to the trigger;
  focus never lands on something hidden or disappears.
- **Use semantic components.** Build controls on `nsh/base` (Button, Menu, Dialog, Select, Tabs, ...), which carry
  roles, states and keyboard behavior; a control hand-built from a pressable view has none of them.
- **Everything has a name.** Icon-only controls have an `accessibilityLabel`; images that mean something have a
  description, decorative ones are hidden; states (selected, expanded, checked, disabled, busy) are exposed, not only
  drawn.
- **Never by color or motion alone.** Status has text or an icon besides its color; text and meaningful boundaries
  meet contrast in light and dark; nothing requires animation or sound to be understood.
- **It scales and adapts.** Larger text, right to left, longer translations and reduced motion keep the screen
  complete.
- **Test it.** Complete the main task with the keyboard only, and with the platform's screen reader (VoiceOver,
  TalkBack, Narrator, Orca) on at least one target; `nsh test` selects by role and label, so tests that find
  controls by `role:button[Send]` also check their names.

## Accessibility checklist

Before considering a screen complete, verify every item; any failure blocks finishing:

- every action is reachable and operable by keyboard, touch, and screen reader;
- focus order follows visual and task order;
- focus remains visible and is restored after overlays;
- controls have accessible names; icon-only controls use tooltips when their meaning, scope, or shortcut needs
  explanation;
- text and meaningful boundaries have sufficient contrast;
- status is not communicated by color alone;
- disabled and read-only states are distinguishable;
- labels, errors, and descriptions remain near their controls;
- content remains usable with longer translations, right to left, and larger text;
- every action can be completed with the keyboard alone, with visible focus, and with a screen reader;
- touch targets are at least 44 × 44pt on iOS and 48 × 48dp on Android, and pointer targets are comfortably sized
  even in a dense layout.

## Finishing checklist

The review checklist below asks whether the design made the right decisions; this one checks the execution, item by
item, on the running app. It checks consistency with the app's own design system (its tokens, sizes, radii and motion),
not particular numbers: the same guide serves every app's style. Run it on every screen the work added or changed, against screenshots in light and dark, and
report each group as passed or as what was fixed. A group not checked is not passed.

**Radius**
- [ ] Every radius comes from the theme's scale (`rounded-(--radius)`, the app's named tokens, `rounded-sm` …
  `rounded-2xl`); no one-off values.
- [ ] The scale has a clear order: the largest surfaces (a composer, a card, a sheet) softest, controls next, small
  parts (badges, icons, checkboxes) tightest; small buttons do not become pills.
- [ ] Nested shapes are concentric: inner radius ≈ outer radius − gap.
- [ ] `rounded-full` only on intentional circles and pills; no rectangle has a radius near half its height by accident.
- [ ] Children, selection fills and scrolled content stay inside the rounded corners.

**Typography**
- [ ] Every size is a step of the type scale (`text-xs` … `text-xl` and the app's display sizes); no literal font sizes.
- [ ] Hierarchy uses at most three or four sizes and two weights per screen; bold and color stay scarce.
- [ ] The UI font for interface text, monospace only for code, identifiers, shortcuts and aligned numbers.
- [ ] Secondary text uses `muted-foreground`, not a smaller size alone; nothing below 12pt for reading.
- [ ] Long text truncates or wraps on purpose; it works at a larger text size.

**Spacing and gaps**
- [ ] Every gap and padding is a step of the spacing scale; no literal points except audited exceptions.
- [ ] Gaps grow with the distance of the relationship: parts of a control < related controls < one group < groups in
  a section < sections. Equal gaps mean equal relationships.
- [ ] Padding belongs to the component, gaps to the parent; no doubled insets.
- [ ] Peers share alignment spines; repeated rows keep their columns; leading and trailing written as start / end.

**Alignment**
- [ ] Each surface has a few named spines (leading and trailing content edges, a baseline or center line per band,
  fixed lanes); every element at one level sits on one of them.
- [ ] Sibling regions (header, toolbar, rows, empty state, footer) share one content inset; nested levels return
  exactly to the parent spine.
- [ ] Repeated rows keep fixed lanes for icon, label, metadata, numbers and trailing actions; a missing icon or badge
  does not move the rest (icons centered in a fixed slot).
- [ ] Mixed text sizes in a row align by baseline; icons and text by center line; numbers end-aligned with
  `tabular-nums`.
- [ ] Equal edges and gaps are equal to the rendered pixel at the window sizes, text sizes and scales checked; a
  difference is fixed at its shared owner, never with a literal offset.
- [ ] Indentation only for real hierarchy; `justify-between` only when both sides own opposite edges.
- [ ] Hairlines drawn once by the boundary's owner; scrollbars at the scrolling region's trailing edge.

**Color and surfaces**
- [ ] Every color is a theme token; no raw hex, RGB or palette classes in presentation code.
- [ ] One primary action per surface; strong color, badges and alerts scarce.
- [ ] Popups share one surface treatment; shadows only on what floats; base regions separated by background and hairlines.
- [ ] Light and dark are balanced; no leftover colors of an earlier palette.

**Hover**
- [ ] Every pressable element on desktop and web answers hover; nothing that cannot be pressed reacts to it.
- [ ] Hover is a quiet wash (a `muted` / `accent` background, a slightly stronger border or text), weaker than
  selected and pressed, the same treatment for every control of one kind.
- [ ] Hover does not change size, weight, padding or layout, and does not move neighbors; it does not reveal the
  only way to reach an action (it is also in a menu or keyboard).
- [ ] It comes in fast (`instant`, ease-out) and leaves without lag; it is absent on touch (no stuck hover after a tap).
- [ ] Rows: the wash fills the row's full hit area, inside the list's radius, and does not double with selection.

**Pressed**
- [ ] Every pressable element has a pressed state the app styles (`active:` / `activeStyle`), visible within the
  frame of the touch or click, stronger than hover.
- [ ] Buttons scale slightly (0.97, icon buttons 0.95) and/or deepen their wash on the soft settle; rows and list
  items deepen their background instead of scaling.
- [ ] The pressed state covers the whole hit area, keeps the label readable, and does not shift layout.
- [ ] Releasing outside cancels without firing; a control owning a menu stays visibly open until the menu closes.
- [ ] Disabled controls show neither hover nor pressed.

**The `ui` layer**
- [ ] The app has a `ui` module with the core set, shown in every variant, size and state on one page.
- [ ] Feature code uses only `ui` components and layout primitives: no controls imported from `nsh/base`, no colors,
  radii, paddings or font sizes, no controls hand-built from pressable views.
- [ ] Every new look or behavior a feature needed was added to `ui` as a variant, size or component.

**Component standards**
- [ ] Each styled control takes one `size` that sets its height, padding, text, icon and radius together; heights
  and paddings match across buttons, inputs, selects and toolbars of one size.
- [ ] State colors come from per-variant tokens (normal, hover, active); selected and menu-open share one style.
- [ ] Popups share one surface; focus rings sit outside the border with room to show.

**Other states**
- [ ] Focus-visible rings on every keyboard-reachable control, outside the clip; selected, disabled and loading
  distinct from each other and from hover.
- [ ] Icon-only buttons are square, the same size within a group, and have an accessibility label.
- [ ] One icon family, one stroke weight, sizes from the scale.

**Motion and sound**
- [ ] The screen's motion inventory exists and every line was verified in the running app ("Motion inventory").
- [ ] Durations and easings come from the app's motion tokens; nothing moves without a reason; reduced motion checked.
- [ ] Sound only if the app calls for it, at completed changes, quiet, and the screen works silent.

**Accessibility and keyboard (blocking)**
- [ ] The main task completes with the keyboard alone: Tab order follows the screen, arrows within groups, Enter /
  Space activate, Escape closes; focus visible and returned after overlays.
- [ ] Every control has a role and name (icon-only included), states exposed; checked with a screen reader on one
  target.
- [ ] Nothing relies on color, motion or sound alone; contrast holds in light and dark.

**Platforms**
- [ ] Desktop and web share one design; mobile follows iOS / Android sizes and navigation (44pt / 48dp targets,
  sheets, back); TUI works by keyboard on whole cells in 16 colors.

**Platforms and states of content**
- [ ] Empty, loading, error and long-content states designed, not left blank.
- [ ] Checked at the minimum window size or a phone width, at a larger text size, and on each target platform.

## Design review checklist

A review does not inventory components; it judges whether the interface made the right decisions. Ask, in order:

1. **Is the task clear?** Can a new user recognize the purpose, primary action, and next step without learning,
   guessing, or experimenting?
2. **Does every action keep its promise?** Do the label, control, state, scope, feedback, and result describe one
   consistent outcome?
3. **Is hierarchy decisive and restrained?** Does the core feature receive the space it deserves while strong color,
   bold type, badges, alerts, and primary buttons remain scarce?
4. **Could the interface do less, better?** Can an entry point, option, or state be removed, combined, or deferred
   without weakening the complete task?
5. **Is the structure exact?** Do peers share alignment spines, equal gaps stay equal to the rendered pixel, and
   scrollbars sit at the edge of their actual scrolling region?
6. **Does it follow the component system?** Do standard controls retain their geometry, states, keyboard behavior, and
   dismissal model, with appearance supplied by theme and scale tokens?
7. **Does it remain usable in every state and constraint?** Verify keyboard, touch and focus behavior,
   empty/loading/failure/permission states, longer translations, larger text, right to left, both appearances,
   minimum window size, and reduced motion.
8. **Does motion explain the change?** Is there a motion inventory for every changed screen, each line verified? Do presses, swaps, popups, selections and arriving content move with the
   app's motion tokens, natively, interruptibly, and not at all with reduced motion, while nothing moves without a
   reason?
9. **Has it been tested on real platforms?** Complete the task with real components, copy, and representative content
   on each platform it ships to (`nsh run --target …`, `nsh test --target …`)—not only an ideal screenshot.
