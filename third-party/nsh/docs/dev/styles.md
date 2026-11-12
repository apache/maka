# Styles, classes and effects

- **Principles** (frozen with the first recorded release):
  1. One set of properties, three ways to write it (Rust `Styled`, `style` keys, classes), one meaning; the names are
     CSS's properties, but for the few a common form says more plainly ("Forms past CSS's").
  2. Native first: defaults, units and value forms serve the platforms and performance, not compatibility with the
     web (lengths are points, `"50%"` or `"auto"`, never `"30px"` in a style: classes take CSS's units, which depend on
     the theme and the window).
  3. A static value may be a CSS-like string, parsed once in Rust; a value that changes takes numbers and structured
     forms (`translate: [x, y]`, a `transform` list, shadows' layers), which JS builds without strings and which take
     animated values where the platforms animate them.
  4. Each key takes the form most used and easiest to write, CSS's by default; where common use and CSS differ, the
     common form wins ("Forms past CSS's" below). React Native is a reference for what is common, not an API to
     match: no names or aliases for its sake. A Tailwind (v4) utility means what Tailwind's generated CSS does (the
     tests compare against it). What NSH cannot support is unsupported (an unknown class, a rejected value with a
     warning), never given another meaning. What the platforms do that CSS cannot say is an extension ("Extensions"
     below), named apart from CSS's.
  5. Frozen is the contract (keys, value forms, defaults); what a platform draws of it is its support, documented.
  6. Below TSX, values are typed: Rust's `Styled` and Tailwind classes lower to typed values (a core type of their own
     where one is needed, as `LineHeight`), never to strings the core parses again; only a TSX `style`'s values are
     parsed from strings (in `nsh-js`'s decoding and `Style::set_key`).
- **Forms past CSS's**, where the common form wins: a `lineHeight` number is points, as React Native's (CSS's is a
  multiple of the font size, which strings say: `"1.5"`, `"150%"`, `"1.5em"`); both sides of an axis are
  `marginHorizontal` / `marginVertical` / `paddingHorizontal` / `paddingVertical` (CSS's `margin-inline` / `-block`,
  the same sides in NSH's horizontal text, by the names people read at once), and the sides by the direction are
  `marginStart` / `marginEnd`, `paddingStart` / `paddingEnd`, `start` / `end`, `borderStartWidth` / `Color` and
  `borderTopStartRadius` and its family (CSS's `margin-inline-start`, `inset-inline-start`, `border-start-start-radius`,
  ..., shorter); lengths are numbers of points; unset
  properties keep React Native's / Yoga's defaults ("CSS's meanings" below).
- **Extensions**, the keys and classes NSH has that CSS / Tailwind do not: `placeholderColor` (`<Input>`'s
  `InputStyle`), `selectionColor` (inputs and selectable texts), `tintColor` (`<Image>`; class `tint-*`),
  `borderCurve` (`continuous` corners, class `corner-squircle`; the web draws them with CSS `corner-shape: superellipse()` fitted to the native curve, where the browser has it), `glassEffect` (Apple's
  Liquid Glass on iOS 26 / macOS 26, the `backdropFilter` elsewhere), `glassTintColor` (the tint of that
  glass on iOS 26 and macOS 26), `writingDirection` (a text's base direction, from
  its content by default as the platforms' text views do, beside `direction`, the layout's), `textAlignVertical` (where
  text shorter than its `<Text>` box sits); value forms past CSS's:
  `transform` lists, `translate` / `scale` pairs, shadows' layers (`{ x, y, blur, spread, color, inset }`),
  `pointerEvents`' `box-none` / `box-only` (React Native's, for the view alone), `textOverflow`'s `ellipsis-start` /
  `ellipsis-middle` (where a clamped text is cut), `textAlign`'s `auto` (React Native's: the text's natural side, by its
  direction); variants past Tailwind's: `selected:` (`accessibilityState.selected`, `selectedStyle`), `ios:` /
  `android:` / `web:` (the platform), `terminal:` (drawn in a terminal, `Idiom::Terminal`). A new one joins this list.
- **CSS's meanings**: inline styles mean what classes mean: a style key is the CSS property of its name (or of the form
  "Forms past CSS's" gives it). Every view, however it is styled, keeps
  React Native's defaults for what nothing sets (a column while no display is set, `flexShrink: 0`,
  `alignContent: flex-start` outside grids, minimum sizes of 0: Yoga's, which spare measuring every item's
  min-content size; `min-width: auto` written out is CSS's automatic minimum). Colors (`crates/nsh-core/src/css.rs`) are hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, names and
  `color-mix()` of any of them (CSS Color 5: `in srgb`, `srgb-linear`, `xyz`, `oklab`, `oklch` or `hsl`, hue methods
  for the polar spaces, premultiplied alpha), packed to sRGB with clamped channels.
- **Tailwind** (`class` / `classList` on every element): JS only passes the strings; the core resolves them (how, and
  what is cached: `crates/nsh-core/src/tailwind/mod.rs`, `core/classes.rs`). The inline `style` always wins over classes; a key set to `undefined` sets nothing, so the class value (or the default) stays, while `null` sets the default.
  Later utilities win over earlier ones (components append a `class` prop, no `tailwind-merge`); variant rules apply
  after plain ones in Tailwind's variant order: a rule's `Rank` is its variants' places highest first, compared as
  Tailwind compares the bit sets of a candidate's variants (`group-*` by inner state, then name; breakpoints by unit
  name, then value, `max-*` widest first), so `dark:hover:` follows `dark:`. Display follows CSS: `flex` / `inline-flex` are rows unless a direction
  utility says otherwise, wherever it is in the string (`flex-col flex` is a column; the implied row is a
  `Decl::Default`, applied before every rule), and so are a style's `display: "flex"` (its `StyleDecl::Default`, which
  `StylePatch::apply_defaults` applies before the classes) and the typed `.flex()`, while views that set no display
  keep React Native's column; `block` /
  `flow-root` use Taffy's block layout, and so do `inline` / `inline-block`: a browser blockifies inline boxes in flex
  and grid containers, which every NSH parent but a block is (there is no inline formatting context). Variants: `dark:`, `sm:`…`2xl:` / `max-*:` / `min-[..]:`, `portrait:` /
  `landscape:`, `ios:` / `android:` / `web:`, `terminal:`, `pointer-fine:` / `pointer-coarse:` (CSS's `pointer` media
  feature: fine on the desktops, a desktop browser and a terminal (`Environment::desktop()`), coarse on touch), `rtl:` / `ltr:`, `motion-safe:` / `motion-reduce:`, `active:` / `hover:` /
  `focus:` / `focus-within:` (text inputs always report their focus, so the views around one read it) / `disabled:` / `enabled:` / `selected:` (`accessibilityState.selected`, a `Button`'s
  `selected`) / `checked:` (`accessibilityState.checked`, not mixed) / `indeterminate:` (`accessibilityState.checked`
  mixed, CSS's `:indeterminate`) / `aria-expanded:` (`accessibilityState.expanded`: a `Popover`'s or `Menu`'s trigger
  while its popup is open) / `aria-pressed:` (`accessibilityState.pressed` true: a toggle button that is on; not
  `active:`, a press in progress) / `aria-busy:` / `aria-checked:` / `aria-invalid:` / `aria-selected:` (Tailwind v4's
  `&[aria-busy="true"]`, ...: `busy`, `checked` true, `invalid`, `selected`; `aria-current:` and Tailwind's other `aria-*` names are
  unknown, NSH has no such states), `data-<name>:` (Tailwind v4's boolean form, `&[data-<name>]`: a `data-*` attribute
  a Rust component's part shows, `Interactive::project_data`, `Prop::ProjectedData`, as a calendar's day shows
  `data-range-start`; names of lower case letters, digits and `-`; the value form `data-[state=open]:` is unknown;
  after the `aria-*` variants, by name, as Tailwind registers them; `deps::DATA`, and a node whose classes read none
  sends nothing when its attributes change), `group-*:` (named groups `group/name`; `group-data-<name>:` too), `first:` / `last:` /
  `odd:` / `even:` / `only:`, `placeholder:` / `selection:` (a color only, the pseudo-element's: `placeholder:text-*` / `selection:bg-*`, the
  `placeholderColor` / `selectionColor` style keys; other utilities under them are unknown), `!` (important). The state classes have style props of their own (`activeStyle`, `hoverStyle`,
  `focusStyle`, `focusVisibleStyle`, `focusWithinStyle`, `disabledStyle`, `checkedStyle`, `indeterminateStyle`, `expandedStyle`,
  `pressedStyle`, a `Button`'s `selectedStyle`), resolved the same way: later states win, `disabled` over all. `selected`, `checked`, `indeterminate`,
  `expanded`, `pressed` (`state::ARIA_PRESSED`), `busy` and `invalid` are value states (`state::ACCESSIBILITY`, set by
  `Core::set_accessibility_states` from `classes::accessibility_states`) the core sets from the accessibility state (never reported by the platform). The first three are
  below the interaction states: `checked`, then `indeterminate` (Tailwind's order), then `selected`, then `hover`,
  `focus`, `active` (gpui-base's order of value states); the `aria-*` variants are above them (`aria-busy`,
  `aria-checked`, `aria-expanded`, `aria-invalid`, `aria-pressed`, `aria-selected`, by name), as Tailwind's `aria-*` variants come
  after its pseudo-classes, so an open popup's trigger keeps its look while hovered or pressed. `disabled` (any element) applies `disabled:` and drops
  the node's press listeners from what is mounted, so it shows no press feedback either. A part of a Rust component
  shows its control's `checked`, `indeterminate` and `disabled` to its own classes and state styles
  (`Interactive::project_checked`, `project_indeterminate`, `project_disabled`, and `project_focused` for the part the keys act on; `Prop::ProjectedStates`; `project_data` its `data-*` attributes, `Prop::ProjectedData`): a switch's thumb styled `checked:translate-x-4`, with no accessibility
  state or press change on the part, so screen readers hear the control alone. `focus-within:` (and
  `focusWithinStyle`, `.focus_within(..)`) is the core's: the platforms report `FOCUSED` for whatever view the
  keyboard focus reaches, whether or not it tracks it (`input::reported_states`; one report per focus change), and the
  core keeps one focus per surface and puts `state::FOCUS_WITHIN` on it and the views around it in the core's tree
  (`classes::update_focus_within`: a change walks the old and the new chain, nothing else; moving or releasing a view
  in the chain walks it again), where an overlay is inside the view the app put it in, wherever its native view shows
  (a popup's content is within the view holding its trigger, as in a React portal). The order a platform reports a
  move in does not matter (a view taking the focus is the focus; a blur of another view changes nothing), and the root
  view taking it (AppKit's first responder when no view has it) is no focus. A view whose classes read only
  `focus-within:` tracks nothing natively. Rust components hear the focus come into an element and leave it with
  `ElementRef::on_focus_in` / `on_focus_out` (GPUI's names, a focus handle's), watches the core runs at the end of
  the commit round the focus moved in (`core/watch.rs`). `dark:` follows the appearance
  shown: the app's own when it set one (`nsh.json` `"appearance"`, `setColorScheme`; `Core::set_appearance`), else the
  system's. The theme is Tailwind 4's
  extended by `nsh.json` `"tailwind"` (`colors`, `spacing`, `breakpoints`, `fontSize`, `radius`, `shadow`, ...; unknown
  keys are build errors). Rust components do not use classes: their typed styles (`element/style.rs`, every utility group has its
  methods, tested against the classes) lower into the same rules and their
  colors come from `nsh/base`'s theme, `nsh.json` `"theme"` (`docs/dev/components.md`); the Tailwind theme only
  shapes the app's own classes. The app's classes name the design tokens (`element::Tokens`: shadcn/ui's and the app's
  own, `nsh.json` `"theme"`, by the names of `tailwind/theme.rs` `ClassTokens`) as Tailwind 4 names the variables of
  `@theme`: a color is a color utility's name (`bg-primary`, `text-muted-foreground/70`, `bg-up/30`) when the
  Tailwind palette has no color of that name (a palette color of the same name wins), and every token is a variable
  (`bg-(--primary)`, `rounded-(--radius)`, `text-(length:--x)`, `font-(family-name:--font-mono)`); the fonts
  `font-sans` / `font-mono`, when the theme sets them, are what the `font-sans` / `font-mono` utilities set
  (`ClassTokens::replaces`), and `font-sans` is the default font of every text (Tailwind's `--font-sans`, a page's
  preflight). Such a utility is parsed with the light and the dark values as arbitrary ones (two rules of its rank
  when they differ, so it follows the appearance with no `dark:`) and depends on `deps::THEME`. When the design
  tokens the app draws with change (`Core::set_tokens`, `set_host_tokens`; a host's keep the app's names they lack,
  `Tokens::over`), `Core::class_tokens_changed` drops the cached strings that name tokens and resolves
  their nodes (and the app's classes on Rust components) again; when the names change, every class. `nsh build` / `nsh dev` warn about unknown static classes in app code (`file:line:col:
  unknown class '...'`, target `nsh::build`); the core logs each unknown class once at run time. Settings
  that are props in React Native are style keys here, as in CSS (`numberOfLines`, `textOverflow`, `userSelect`,
  `pointerEvents`, `objectFit`; `line-clamp-*`, `truncate`, `text-ellipsis`, `select-*`, `pointer-events-*`,
  `object-*`), and the inline style wins over their classes as over any; `whitespace-nowrap` is class-only. `caret-*`,
  `placeholder:text-*` / `selection:bg-*` set the `caretColor`, `placeholderColor` / `selectionColor` style keys (the caret and the selection highlight are apart; UIKit tints both
  with one color, the caret's when set). Not supported, so unknown: `peer-*`, pseudo-elements, arbitrary CSS properties, and every
  utility without a native meaning (`order-*`, `transform-3d`, `select-all`, `border-double`, intrinsic min/max constraints,
  `snap-*`, `scroll-*`, `overscroll-*`, `touch-*`, `isolate`) or without CSS in Tailwind (a negative
  where Tailwind has none: `-gap-4`, `-p-2`; fractions and `full` on padding, margin and gaps; non-integer `z-*`; bare
  `inset-shadow` without a theme value). Rendering hints are accepted and do nothing (`ignored` in
  `tailwind/mod.rs`: `antialiased`, `will-change-*`'s values, ...). `space-x/y-*` (and `-reverse`) are margins on each
  element child but the last, as Tailwind's `:where(& > :not(:last-child))`: the parent's `ClassProps::space`, which
  the core applies to a child's style before its classes and inline style (`classes.rs` `space_of`), so the child's
  own margins win. An important space utility is applied after normal child styles and before the child's important classes; an insert or removal restyles only the children whose last-ness changed (`spacing_changed`).
- **`ch`**: `w-/min-w-/max-w-prose` are Tailwind's `65ch`, the advance of the node's font's `0` (`Decl::Ch`; the core
  measures it with the text engine, cached per font, `Core::zero_advance`): the font it inherits, or its own once its
  classes set one. Such classes depend on `deps::CH`; a font change around them restyles them (`mark_inheriting_text`),
  including text nodes and reparented subtrees; the ones styled in a batch are checked again as the commit starts, with the tree in place (`sync_ch`). Without a
  tree (`ClassList::apply`), `1ch` is 8 points. An app's theme `container.prose` (points) replaces it.
- **`perspective-*`** (and the typed `.perspective()`) is CSS's `perspective`: depth for the children, seen from the
  view's center (`Style::perspective`). The core composes `translate(-d) perspective() translate(d)` before the
  own transform of each child that turns out of its plane (`rotateX` / `rotateY`; a flat one looks the same), `d` its
  origin's distance from the parent's center (`classes.rs` `mounted_view_style`; sent again when either frame changes;
  the child's animated steps move by those five, `perspective_steps`). iOS, macOS, the web and the desktops draw it
  exactly; Android decomposes the matrix into its view properties, a camera distance about the child's own pivot. The
  `perspective()` function of a `transform` (and a `{ perspective }` step of its list) stays a step of the view's own
  transform, as in CSS.
- **Boxes** (kept, documented in the guide): `overflow-x-hidden` / `overflow-y-hidden` clip both axes and never scroll
  (views are no scroll containers; CSS's other axis would be scrollable); `invisible` hides the subtree (`setHidden`,
  `View.INVISIBLE`; CSS's `visible` child would show); `mix-blend-*` blends with everything drawn behind (no stacking
  context isolates it); `block` boxes never collapse margins with their children (an unset `align-content` resolves to
  `flex-start`, which makes taffy's block a formatting context); strings keep their whitespace (`whitespace-*` sets
  wrapping only; the JSX compiler collapses literal JSX text); `transition` / `transition-all` animate their groups
  (`TransitionProps`: colors, opacity, transform, shadows, shape), and filters, backdrop filters, gradients and layout
  take their new values at once; `focus-visible:` (`state::FOCUS_VISIBLE`) is the focus that shows, after the
  browsers' `:focus-visible`: the platforms report only how the user last gave input (`InputModality`: a key, or a
  pointer, pen or finger going down; `EngineControl::set_input_modality`), and the core decides (`classes.rs`
  `focus_shows`): an input that edits always shows its focus, any other view unless the last input was a pointer, so
  Tab, a group's arrows and a shortcut show it, a press or a tap does not, a move the app makes (`focus()`, a calendar
  or a dialog opening) shows it after a key and not after a press, and a key typed while the focus does not show
  shows it. `focus:` is any focus. A part projected focused (`project_focused`: a tree's or a list's cursor, the
  control keeping the platform's focus) also shows `focus-visible:` while the focus shows, so on such a part
  `focus:` is the cursor and `focus-visible:` the cursor the keyboard is on.
- **Layout values**: `box-content` / `box-border` select Taffy's content-box / border-box sizing. Width and
  height accept `min-content`, `max-content` and `fit-content` (`w/h/size-min/max/fit`); min-content text measures
  each Unicode line-breaking segment with the platform text engine and caches the widest one. `flow-root` uses
  Taffy's flow-root display. Intrinsic min/max constraints remain unknown classes.
- **`position`**: `static` uses Taffy's static positioning: it stays in flow, ignores insets and lets absolute
  descendants use the nearest positioned ancestor. The core converts containing-block offsets to native-parent
  coordinates. `fixed` retains the element's kind and uses Taffy's fixed positioning in a root-sized overlay wrapper
  (`overlay.rs`, `sync_fixed`); its native view mounts in the surface or modal root and returns to its logical parent
  when fixed positioning is removed.
- **`position: "sticky"`** is laid out `relative` with its insets kept as where it sticks (`Node::sticky`): after
  layout the core gives it a range of travel in the offsets of the nearest scroll view or own list around it (from its
  place less its `top`, or `left` in a horizontal one, to where its end meets its parent's content box) and sends it
  with that view's sticky list rows (`core/sticky.rs`, `MountItem::StickyCells`), which the platforms pin on every
  scroll. It draws above its siblings of the same `zIndex` (`Node::stack_rank`), as above a page's in-flow boxes.
  An animated `top` (`left`) is where it sticks, followed every frame: the core keeps it out of the view's bindings
  (`AnimationProp::StickyTop` / `StickyLeft`, warned once on a view that is not sticky) and sends it as the range's
  `StickyCell::offset`, which the platforms add as they pin, as for a list's animated `stickyHeaderOffset`. `bottom` /
  `right` stickiness and a zoomable scroll view are not supported. The `sticky` class sets it, as Tailwind's does.
- **Line heights**: unitless values inherit as multipliers. Percentages and `em` resolve against the element's
  font size before inheritance, so descendants inherit a computed length (`TextStyle::line_height_em`).
- **`cursor`** keeps resize axes in the core: `nwse-resize` / `nw-resize` / `se-resize` are `Cursor::NwseResize`,
  `nesw-resize` / `ne-resize` / `sw-resize` are `Cursor::NeswResize`. Windows, Linux, Android, the web and GPUI use
  the corresponding diagonal cursors. AppKit uses its frame resize cursors on macOS 15 and later; macOS 14 keeps
  the open-hand fallback. iPad and Mac Catalyst use UIKit's pointer effects.
- **`pointerEvents`** (the style key and the `pointer-events-*` classes) inherits `none` as CSS's `pointer-events`;
  `box-none` and `box-only`, React Native's, apply to the view alone (the views in it inherit `auto`): a view that is
  `none` by its own value or the nearest one above mounts `box-none` when a view inside it that sets another value is a
  target, `none` at the top of what it blocks, and nothing below that (`classes.rs` `update_pointer_events`, run over
  a region when a style or a class, an insert or a removal changes it; the node
  keeps what it mounts, `class_pointer`, so only changes are sent; `pointer_none_classes` counts the views with
  `none`, so apps without one skip it).
- **`currentColor`**: a border, an outline or a ring whose classes set a width and no color (`border`, `outline-2`,
  `ring`; preflight's `border: 0 solid`) is drawn in the node's text color: its inline style's, its classes', else the one
  it inherits, else black (`CurrentColor`, `Decl::CurrentColor`; such classes depend on `deps::CURRENT_COLOR`). Each node
  keeps the color it inherits (`inherited_color`): an insert compares it with its new parent's, and a change of a node's
  color passes down to the descendants that set none (`Core::inherit_color`), restyling those that read it. A style
  that sets a border or an outline width and not its color does the same (`StyleDecl::CurrentColor`, applied before
  the classes by `StylePatch::apply_defaults`; such a node is styled as one with classes, and again when its inherited
  color changes). So does a style's `boxShadow` / `textShadow` layer that names no color (`StyleDecl::CurrentColor(BoxShadow)`, the layers in `Pending`, filled in by `Style::apply_current_color` once the node's text color is known),
  and a `filter`'s `drop-shadow()` without a color (CSS's default). `currentColor` written out takes the text color too,
  in a style or an arbitrary class value (`bg-[currentColor]` is `bg-current`): a color property set to it last
  (`Pending::current_colors`; `color: currentColor` is the inherited color), or a value that writes it inside (a
  gradient's stop, a shadow's color, a `color-mix()`), checked when set with a stand-in color and parsed again with the
  node's (`Pending::current_values`, `css::with_current_color`); a class with one depends on `deps::CURRENT_COLOR`, and
  `ClassList::apply_with` fills them after the inline style and after the `!` rules. Where nothing fills it in
  (`tintColor`, a `color` mixing it, Tailwind's arbitrary shadows) it is rejected, never drawn black.
- **Right to left**, classes and style keys are physical as in a browser: `pl-*`, `ml-*`, `left-*`, `border-l*`,
  `rounded-l*` / `-tl` ..., `text-left` / `text-right` and `paddingLeft`, `left`, `borderTopLeftRadius`,
  `textAlign: "left"` ... keep their side. The logical ones take the side the direction gives them: the classes `ps-*`,
  `ms-*`, `start-*`, `border-s*`, `rounded-s*`, `text-start` / `text-end` and the start / end style keys
  (`marginStart`, `paddingEnd`, `start`, `borderStartWidth` / `Color`, `borderTopStartRadius`, ...; `textAlign: "start"` /
  `"end"`), which the core places with the node's resolved direction (`apply_direction`, from `Logical`; a direction
  change restyles the nodes that have them).
- **SVG paint** (`fill`, `stroke`, `strokeWidth`, `strokeDasharray`; Tailwind's `fill-*`, `stroke-<color>`,
  `stroke-<number>`): CSS's properties of SVG shapes, which CSS lets any element set and inherits, so they mean what
  they mean in a browser: a color, `none` or `currentColor` (the element's text color), a width that is a length, and
  dashes and gaps as lengths separated by spaces or commas (an odd list repeated, `none`, or lengths adding up to 0
  for a solid line). They style what Rust components draw on canvases (a chart's marks;
  `Painter::*_from_view`, `canvas.md`), kept per node in `Style::paint` (`PaintStyle`) and resolved by the core when
  it sends the drawing (`Core::resolved_paint`); views draw nothing with them. `fill-inherit` / `stroke-inherit` set
  nothing (they inherit already).
- **Text style inheritance** (CSS-like): a view's text properties (color, font, size, alignment, ...) pass to the texts and inputs
  inside it, so `class="text-white"` on a button styles its label. So do its `whitespace-*` / `text-wrap` / `text-nowrap`
  (and `truncate`'s no wrapping) and `select-*` classes, as CSS's `white-space` and `user-select: auto` (`Core::inherited_text_props`:
  the text's own, else the nearest view's that says; `select-auto` says none, so it takes the view's). Inset padding / margin (set by Rust
  components with `.inset_padding(..)` / `.inset_margin(..)`) and `env()` terms ("Environment variables") are added to the resolved padding / margin, so classes and
  styles keep their own.
- **Effects** (styles and classes; `effects.rs`): `boxShadow` (CSS syntax, several, `inset`; also `shadow-*` / `ring-*`; a style also takes its layers, `[{ x, y, blur, spread, color, inset }]`, which `nsh-js`'s `shadow_list` writes as the same CSS, so both forms mean one thing),
  `backgroundImage` (linear / radial / conic gradients and their `repeating-` forms,
  drawn over `backgroundColor` as in CSS; a repeating gradient's stops repeat with period last − first both ways
  over the whole box, a radial one's rings out to its farthest corner: Core Animation's gradient layers and Android's
  shaders repeat nothing, so macOS and iOS take `Gradient::unrolled_stops` (the stops repeated over the line, cut at
  its ends with the colors there, at most 16384; a period of at most 1e-4 of the line is drawn once) and Android's
  `Decor.Gradient.place` does the same; stops at percentages, at lengths along linear and radial gradients
  (a `DefiniteLength::Absolute` position: `Gradient::resolve_stops` places them against `Gradient::line_length` of the box when it is
  drawn, so every native backend passes the view's size; Android's `Decor.Gradient.place` does the same for the
  gradients `encode.rs` sends as written, with their stop count negated; the web hands them to the browser as `px`), or
  at angles around conic ones (fractions of a turn), up to two per stop; transition hints are not parsed; colors mix as in
  CSS (`in <space>`: `color-mix()`'s spaces and hue methods; without one, sRGB when every color is a legacy one, else
  Oklab; Tailwind's utilities `in oklab`), which the core gives the platforms, all drawing sRGB, as stops sampled in that
  space between each two placed in one unit (`css::interpolate_stops`: bisected until a segment is within about one
  8-bit step of the curve, at most 32 per pair); a gradient
  that does not parse is logged (inline styles, `bg-[…]` classes, Rust components' `Style`); but press feedback must show, so a background color an interaction state sets (`active:` / `hover:` / `focus:` /
  `focus-within:` / `group-*:` classes, Rust components' `.active(..)`, on a nested component's element too, `activeStyle` / `hoverStyle` / `focusStyle` / `disabledStyle`) or a native
  animation drives (`Animated` `backgroundColor`) replaces the gradients, unless that state sets a gradient of its own:
  done in the core, so every platform shows it alike), `filter` (`brightness`, `contrast`,
  `grayscale`, `hue-rotate`, `invert`, `saturate`, `sepia`, `opacity`, `blur`, `drop-shadow`; color filters are composed into one
  matrix), `backdropFilter` (blur; iOS chooses its system material through the
  `ios={{ backdropMaterial }}` prop: `ultraThin` by default, then `thin`, `regular`, `thick`, `chrome`;
  the radius approximates strength as a fraction of the material, rather than a Gaussian radius; macOS takes
  an explicit `macos={{ backdrop }}` instead (below), and blurs with `NSVisualEffectView` otherwise), `glassEffect`
  (Apple's Liquid Glass, drawn in the `backdropFilter`'s place on iOS 26 and macOS 26 and later (`UIGlassEffect`, `NSGlassEffectView`, both looked up at run time) and nowhere else, so give a glass
  view a blur to fall back to), `glassTintColor` (the tint of the native glass on iOS 26 and macOS 26;
  `null` restores its native default, an explicit transparent color remains a tint, and the earlier-system blur fallback is unchanged), `maskImage` (a gradient whose alpha decides how much of the view is drawn, its backdrop
  filter included; iOS, macOS, Android, Linux and web, the topmost layer of several. A masked `backdropFilter` blurs by its exact radius on iOS and macOS, without the material's tint (`PlainBlur` in their `visual.rs`), so layers of them stack into a progressive blur), `mixBlendMode`, `outline*`, `visibility`, `cursor`, `transition*` (CSS: property groups,
  duration, delay, easing) and `animation*` (Tailwind's `spin` / `ping` / `pulse` / `bounce`), `display: grid` with
  `gridTemplateColumns/Rows` (line names: `grid.rs` turns them into taffy's `grid_template_*_names`, one set per
  line between components, a `repeat()` counting as one), `gridAutoFlow/Columns/Rows`, `gridColumn/Row(Start/End)` (by
  number or name, `span name`), `justifyItems/Self`; CSS's logical `start` / `end` / `self-start` / `self-end` (taffy's,
  right to left aware) besides `flex-start` / `flex-end`; an unset `alignContent` / `justifyContent` is taffy's `normal`,
  which `style::resolve_normal_alignment` makes `flex-start` outside grids when a style reaches the tree, so grids
  stretch their `auto` tracks as CSS does while flex keeps React Native's default (the alignment and grid classes set
  exactly what Tailwind CSS generates for them: `content-start` is `flex-start`, `place-content-start` /
  `place-items-*` / `place-self-*` `start` / `end`, `justify-items-*` `start` / `end` / `normal`, `justify-normal`
  `normal`, `justify-self-*` / `items-*` / `self-*` `flex-start` / `flex-end`; `content-normal` sets `stretch`, which
  is what CSS's `normal` does in flex and grid containers, since the style's `normal` is the unset value; a type hint
  is dropped from an arbitrary value (`col-[number:2]` is line 2), classes Tailwind has no negative of
  (`-grid-cols-*`, `-col-span-*`, `-auto-cols-*`) are unknown, and an invalid arbitrary `col-[…]` / `row-[…]` /
  `auto-cols-[…]` / `auto-rows-[…]` sets nothing, as a browser drops the declaration); text
  `textDecorationStyle` (`double` / `dotted` / `dashed` / `wavy`), `textDecorationThickness`, `textUnderlineOffset`, `em`
  letter spacing and unitless line heights (multiples). Translations by a fraction of the size (`translate-x-1/2`) are resolved by
  the core against the frame and sent again when the size changes.
  iOS: shadows are one `CALayer` per shadow with a `shadowPath` (outer shadows masked to outside the box, inset ones to the padding
  box), gradients `CAGradientLayer`, transitions explicit `CABasicAnimation`s from the presented values, keyframes
  `CAKeyframeAnimation`s, blend modes `compositingFilter`, `cursor` a `UIPointerInteraction`, backdrop blur a
  `UIVisualEffectView` (a system material at a fraction: an approximation), text decorations other than solid single lines are
  drawn by `TextView`. Android: `Decor` draws shadows, gradients and outlines; filters are `RenderEffect`s (API 31+; below, only
  color filters through a layer paint), blend modes a layer paint (API 29+), transitions / keyframes `ValueAnimator`s,
  backdrop blur (API 31+) a `RenderNode` recorded before each frame with what lies behind the view (`Backdrop.java`: each
  ancestor's background and the siblings drawn before the next ancestor, never the view itself) and blurred by a
  `RenderEffect`, drawn clipped under the view's background.
  Known limits: iOS has no CSS filters on views (only `opacity`, `brightness` ≤ 1 and `drop-shadow`; images take every color filter
  and `blur`, applied while decoding); iOS texts draw no gradients or inset shadows; Android has no backdrop blur, `blur` or
  `drop-shadow` before API 31; Linux and GPUI draw no backdrop filter, GPUI no `blur()` or `mixBlendMode`; iOS, macOS and Android draw one `drop-shadow()`,
  the widest of the chain's (the last of equals; the web, Linux, Windows and GPUI draw every layer a class or
  style gives); a text shadow is one layer everywhere (`text-shadow-*` keep the theme's widest); a text's `color`
  transitions (`transition-colors`) on every backend when the whole text is one color before and after (a text of
  several colors, and spans with their own `transition`, take the new colors at once).
- **View styles**: `backgroundColor`, `borderWidth` / `borderColor` (also per side: `borderTopWidth`, `borderLeftColor`, ...),
  `borderStyle` (`solid` / `dashed` / `dotted`; `none` / `hidden` zero the used widths in layout and paint whatever
  order the widths come in, as `outlineStyle: "none"` does, `Pending`), `borderRadius` + the four `borderTopLeftRadius`-style corners, `borderCurve`
  (`continuous`: corners easing into the edges, Figma's 60% corner smoothing, shrinking to circular where the box is too
  small, so pills stay pills; the outline geometry is `nsh_core::shape::rounded_rect`, ported to `Decor.java`, where Android below API 30 casts the shadow of the smallest corner's round rect instead, as API 28 and 29 take only convex outlines and smoothed corners are not always convex; iOS layers that
  draw their own corners use `cornerCurve`), `overflow`, `opacity`,
  the transform properties as CSS composes them (`Style::set_transform`: `translate`, `rotate`, `scale`, then
  `transform`, CSS's string of `translate()` / `scale()` / `rotate()` / `rotateX()` / `rotateY()` / `skew()` /
  `perspective()` functions (`transform::parse_css`) or a list of steps whose amounts may be animated values, which
  CSS's string cannot hold (the bridge's `decode_transform_list`); last the steps Rust components bind). Each is a property of its
  own, in classes too (`translate-*`, `rotate-*`, `scale-*` are `translate`, `rotate`, `scale`; `rotate-x-*`, `skew-*`
  the `transform`): a style's `scale` replaces a class's scale and leaves its rotation. The list keeps how many steps
  each property holds (`Pending::transform_counts`), so setting one moves the animated bindings of those after it.
  Applied right to left like CSS; Android has no skew, `zIndex` (stable order of the native views), `boxShadow`
  (CSS's, the one shadow of styles, classes and typed styles alike; `effects.rs`), `tintColor` (images), `glassTintColor` (Liquid Glass), `objectPosition` (images: where the fitted image sits, CSS's `object-position`; `images.md`), `android={{ elevation }}` (a prop, not a style: Android's material shadow), `macos={{ backdrop }}` (a prop, not a style: macOS's `NSVisualEffectView` material, `MacOsBackdrop` in `effects.rs`: an explicit one selects the native view with no blur needed, and wins over `glassEffect` and `backdropFilter`; `None` keeps the fallback), `transformOrigin` (keywords / percentages / lengths; iOS conjugates the matrix around it,
  Android sets the pivot), `backfaceVisibility` (iOS `doubleSided`; Android hides the view while its rotations turn it away). `style` may be an array of styles merged left to right
  (falsy entries skipped), decoded in Rust. In one style object (an array is flattened into one, as React Native does) a
  longhand wins over its shorthand whatever the key order (`StylePatch::set`, `StyleKey::longhands`: border widths and
  colors per side, margin / padding sides and axes, `rowGap` / `columnGap`, `flexGrow` / `flexShrink` / `flexBasis`,
  grid start / end): a shorthand set after its longhands is recorded before them and they apply again, and a `null`
  longhand of a shorthand in the same object is dropped (unset, as in Yoga). Corner radii keep their own fields
  (`corner_radius` over `border_radius`), start / end properties are placed after the physical ones
  (`apply_direction`). Between layers (classes, then the inline style; a Rust component's own style, then the app's)
  order still decides, and classes keep "later wins". `outlineStyle: "none"` hides the outline whatever the width, and
  the `animation*` timing keys apply with or before `animationName` (`Style::pending` keeps them); `transition*` keys
  already combine in any order (`transitionProperty` defaults to `all`). Text adds `textShadow` (CSS's `text-shadow`; several layers draw as the widest, as
  `text-shadow-*` do),
  `fontVariant` (OpenType `smcp` / `onum` / `lnum` / `tnum` / `pnum`: CoreText feature settings, `Paint.setFontFeatureSettings`)
  and `writingDirection`.
  On Apple everything is drawn by Core Animation, escalating only as needed (`crates/nsh-platform-ios/src/decor.rs`
  describes the paths and their limits); Android draws in `Decor.java`.

## Layout in a terminal

A terminal draws whole character Cells, and a GUI's metrics (spacing, row heights, borders designed in points for a
screen) cost rows and columns it cannot spare. So in a terminal the core does not run Taffy: it lays out with an
algorithm of its own, the way ratatui apps are laid out (`core::terminal_layout`). The platform reports the Cell size
in `Environment::cell` (`None` on every other surface; the terminal backend sets it from its points per Cell, 8 × 16
by default). Lengths are whole Cells inside (x the Cell's width, y its height); the layouts written back are in
points, so frames, hits, overlays, scroll views and `onLayout` work as anywhere else. Leaves measure as they always
do (a text is one row per line), its lines broken within its `maxWidth` (a centered paragraph at most 320pt wide is
as tall as its lines at 40 columns).

- **Splits.** A box's content box is split among its children along `flexDirection` (reversed for the `-reverse`
  ones; `display: block` is a column), as ratatui's `Layout` splits a `Rect`: `flexGrow` is `Fill(grow)`, every other
  child is its content's size. An explicit width (points, or a percentage) is the child's `Length`, its minimum and
  maximum `Min` and `Max`. A `flexBasis` (points, or a percentage) is the child's `Length` along the main axis either
  way, whatever it holds (a resizable panel's size), within its minimum and maximum there; a fill's basis of 0 is
  its content's where its parent's length is not known. An explicit height counts only on a box without content (a chart's canvas, a spacer) and
  on a scroll view, as a maximum, and on a clip of no height (`overflow: hidden`, height 0: a collapsible's or an
  accordion's panel sprung shut), which shows none of its content; a list's is its height (its cells are laid out apart, in the size it is given). So
  does one whose content in flow is only images, videos, web views, shaders, lists or native components with no
  height in points (a photo's card around its `flex: 1` image): what it holds is as tall as it is. A bar thinner than
  a row, from 4pt (a quarter of one) and wider than high, no control, holding nothing but views with nothing in them
  (a track and its fill), of a fill that shows as a band or with an outline of its own, is one row, which the painter
  fills to its thickness; a hairline (a divider) takes none. A scroll view or a list that shows its indicator
  (`scrollbar` not `false`, no built-in bar) and whose content overflows leaves its bar a Cell of its own: its
  content is laid out a column narrower (a row lower when horizontal), as a classic scroll bar takes its width; none
  when it is a Cell wide (a row high), and none for a vertical one that reaches its parent's right border with no
  padding between, whose bar the painter draws on that line. A
  percentage height is of a known height, else of the box's own explicit height (kept or not, so a `50%` bar is as tall
  in every pass), else of the room it is given. A box with content is as tall as its content, at most its `maxHeight` (a popup bounded by the room
  below its anchor), and one with a height in points is
  not stretched across a row (a badge stays a row beside a title and its subtitle). When the children do not fit, those
  in a row give in this order: texts of limited lines (`numberOfLines`) with `flexShrink`, which are cut short with
  `…`, down to four columns (so the descriptions after a column of names stay lined up); the gaps, down to one column (before a `flexGrow` child wraps, only when that keeps it
  on its rows: columns of sections that wrap anyway keep the gaps between them); icon buttons shown as their labels, down to three
  columns (the label cut short) and then out, the last first, and so does a row of them (a toolbar's group) nested
  in the row, as one; children with `flexShrink`, down to the longest word
  of their texts; every child down to its words; then the shrinking ones and all of them below (a text wraps, the
  last resort), never below one Cell for one with content: a box never lays a child across its border. A grid's
  columns are its template's tracks (`fr` tracks fill, lengths are theirs, the others their items' widest), its rows
  as many as the items take, each as tall as its tallest item and stretched over a known height; items are placed in
  order along the rows, each in the first place its `span` of columns and rows fits (CSS's auto placement), an item
  over several tracks taking them and the gaps between. A `flexGrow`
  child's text counts at its full width for the gaps and labels, so a name next to icon buttons stays on its row.
  A negative margin (stacked avatars) is none, and keeps a column between the two in a row. `auto` margins take the
  space left, shared equally, as CSS's: `margin: 0 auto` centers a box, `marginLeft: auto` pushes it to a row's end.
  A modal's (or a screen's) child keeps its top margin in rows, as given (a dialog's popup 12% down), uncollapsed. A small box of an
  explicit width (under six columns: an avatar, a counter) is at least as wide as its content's longest words, and so
  is a control of any explicit width (a time slot with its radio's mark): its label never breaks inside a word. A label
  stretched across a box of an explicit width (absolute, both `left` and `right` set: a funnel's stage name in its
  column) widens the box to its line when the line is at most a quarter wider than the box, as a GUI's font fit it
  there; a paragraph laid over a box still wraps in it.
- **Blocks.** A border is one Cell on each side that has one, only on a card: a container (a box holding views with
  content that are not only texts; spacers and bars do not count) padded 12pt or more above or below, or around two
  rows of content or more, unless all its children are controls (a split button, a toolbar, a tab list, a segmented
  control), which is never a card. A pill, a badge, a tab list, a group of buttons or a field's chrome around one row keeps
  no border, and a compact box's padding. A box framed on every side and stated 48pt tall or more (three rows: a
  specimen, a tile, a drop target), or 40pt, of a stated width and not round too (a one-time code's cell, the same box
  with its digit as without), is a box around a single text too: it keeps its border, three rows; inside a frame,
  where its border gives way to its band, the band keeps the three rows, a row above and below its text. The core mounts each bordered view with the borders its layout gave Cells
  only (`Node::cell_border`), so the platform draws a border exactly where the layout reserved one; a control (a control's accessibility role, presses, a text input: `Core::is_control`) and a box of
  text never have one, nor does a round box (a circle: corners of half its explicit width or height or more, or `rounded-full`), except a ring: a round box larger than an icon (over 48pt either way), no control, with nothing shown in it and a border of a color of its own (a pulse's ring, an orbit around its dot), absolute or not, which is that outline, drawn as a rounded box; an absolute one its parent's box would cut is left out.
  Horizontal padding and margins are one Cell from 8pt and two from 24pt (at most one on a
  control or a box of text), and one from 4pt on a side where the box lies against its parent's border with no
  padding of the parent's there (a tree's list inside its bordered box: its rows never start or end on the line); the margins of a box of layers (all its content absolute: a chart, whose axes' labels
  overflow it into them) are gutters of their size, whole Cells and rows, inside a bordered box too; vertical padding is a row from 24pt, none on a control or a box of text. So a bordered
  40pt button is one row, its label and a column each side, a badge is its text, and a card keeps its border without
  padding rows.
- **Surfaces.** A filled container is a surface, at every color depth: where the terminal shows a fill as a band of
  its own color (256 colors or more and a known background) the band is its face, and elsewhere it is laid out the
  same, so the color depth never moves anything. Its fill is above 3% alpha and unlike the
  nearest opaque fill around it (the page's at the root: black in a dark app, white in a light one), by 1.5 in CIE L*
  or as a saturated color of another hue. A surface has no border Cells (mounted with none) unless the app's border
  is hued or at least twice as far in lightness from the backdrop as the fill, or it is a framed box that is not round (a
  specimen, a code's cell: its border is what it shows, empty or not), and keeps its padding: a row above and below
  from 12pt, two columns each side from 12pt, one from 4pt. A filled box around only a text (a popup's box, framed outside it) keeps
  that column from 4pt too, so its text never touches the band's edge or frame.
- **Spacing.** A gap between children in a row is one column from above 0, two from 24pt, their margins added; two controls side
  by side keep a column apart even without one when they share a band (a split button's halves on its fill) or each
  paints one, as the bands would read as one; unfilled controls (tabs) touch, their padding sets them apart. Controls side by side read as words (checkboxes
  and their labels, icon buttons shown as their labels): two blank columns between their texts, their padding
  included (one when the row is short). A mark's trailing space (`[ ] `, `( ) `) is the first column of the gap after
  it, so a mark and its label are one column apart. In a
  column the gap and the margins between two children collapse into one blank row when any of them is 16pt or more,
  and into none inside a bordered box (a card), whose border already sets its content apart: sections keep a row
  between them, a card's rows none. The gap a divider sits in (a box with a divider among its absolute children, a
  vertical resizable group) keeps its row inside a card too.
- **Flex.** `justifyContent` places the space left (start, center, end, space between, around, evenly: ratatui's
  `Flex`); across, `alignItems` / `alignSelf` stretch (the default) or place a child at its content's size.
  `flexWrap` makes lines of children at their bases (or contents), as CSS's, each then split as above (its fills
  share what is left on it).
- **Absolute** children take no room; their insets (nearest Cell) place them in the padding box, and both insets of
  an axis without a size along it stretch them between the two (a divider's band down a whole column). A box that holds
  only absolute children (a table's header over its cells, each of its rows) keeps its explicit height, which a box
  of content rows otherwise takes from them: nothing in it is in flow to size it. A box is at least as tall as its
  absolute labels (children with text, no control, not an overlay) placed from its top in points (a step's label
  under its dot), up to its explicit height: rows
  shorter than points leave less room than they were given, and they never cover what follows. A small label (one
  row, narrower than the sibling it is on, no control in it) pinned on a row of a sibling's text that is not white
  space (a badge on an avatar's initials) is left out: Cells cannot be seen through, so one of the two would be lost,
  and the content is kept. Controls (a slider's thumb), bars pinned over a scroll view, boxes over blank Cells and a
  box with no text or a progress bar before the sibling in tree order (a stepper's bar under its dots, which are drawn
  over it) are placed.
- **Scroll views** lay their content out unbounded along their axis, percentages of their viewport (a carousel's
  `w-full` slide is one view wide, a vertical one's `h-full` slide one view tall), a component's whose root is a
scroll view too; **grids** take their columns from the template
  (`fr` fills, points are Cells, the rest their content's), their rows their content's height, stretched to share a
  known height (a dock panel's one cell fills it), the items in order.
- **Screens and modals** fill the stack or window the core sizes them to, and the padding the core gives them below
  their header converts exactly (the nearest row), not by the spacing rule above. A **native component** takes its
  explicit size: the platform draws a component registered with it there and leaves the Cells of others blank. A
  **text input** keeps one column after its text, where the caret is when the text fills a line.
- A **divider the user drags** (a view whose cursor is `col-resize` or `row-resize`: a resizable panel's handle, a
  dock's split) is one Cell across its axis, as long as its parent lays it out along it, and never left out; what it
  holds is laid out as hidden (the platform draws its line). One pinned on its parent's edge (absolute at `right: 0`,
  a column header's resize handle) is that edge's line: its Cell is out of the parent's content, as a border's.
- A **frame around one frame** and nothing else (a bordered box without padding of its own whose only child, through
  boxes without border or padding, is a bordered box: a pane around a bordered list) draws one line, the inner one,
  as ratatui draws nested blocks once. Frames with padding between them are the app's two, and both are drawn.
- A **band inside a frame** (a filled well in a card) draws no line of its own: its color sets it apart, and its line
  would be a second frame around the same content.
- A **bare overlay** with a border (a dock's drop preview) is its outline: its size is the app's, and its border is
  drawn over its outer Cells.
- Explicit lengths round to the nearest whole Cell, an exact half down (a 300 × 200 canvas is 37 × 12 Cells), but a
  text's explicit width rounds up: it was set to hold its line in a GUI's font, and the Cell it would round off
  keeps the line's last column (curve names 84pt wide hold "cubic inOut").
- What a terminal cannot show well is never emulated. At an icon's size (an explicit width and height both at most
  48pt) images, videos, web views, shaders and canvases are `display: none`, so they take no Cells, no frame and no
  hits, and their margins and the gaps beside them go with them (`Core::grid_role`). Larger, they keep their box: a
  canvas is drawn in braille, the others stay blank (their fill too), and the labels around them stay where the box
  puts them instead of closing up over it. An empty box in flow (no control) with an explicit size of two Cells or
  more each way and a border draws its outline, as its size is its own: a code cell waiting for its digit (an absolute
  one, a selection's box over its items, draws none). So is
  a view with nothing in it smaller than a row both ways and not growing (a status dot in a row, a swatch), except a
  dot of a hued fill (round, 4pt or more) pinned on a box (absolute: an avatar's presence, which moves nothing) or
  leading a text in a row (an issue's status before its title), or of a neutral fill first in its row before its
  text and apart from what is behind it (a gray series' key in a legend), which is one Cell, drawn as a `●` in its color; or a circle with
  nothing in it at most 48pt across that is no control (a radio's ring, an avatar's placeholder), which draws
  nothing in a terminal, and a view (no control, not growing) whose content is all left out (an icon's tile or
  circle), unless it is larger than an icon (over 48pt either way) and what it shows is its own: an opaque fill the user
  handles (presses, gestures or touches: a draggable ball around its dot), an animated fill, or a ring's outline (an
  orbit around the dot on it), which stays a box. A decorative tile goes with its icon. A control whose content is all left out (an icon button; a layer that grows to center its icon, as a menu
  trigger's chevron, counts as left out) shows its accessibility label in one row, one column per character, and is
  left out without one; a popup's trigger (its accessibility `expanded` set) shows one chevron, `▾` or `▴`, in one
  column instead. A disclosure (a control with `expanded` set and no `hasPopup`: a collapsible's or an accordion's
  trigger, a tree's row) keeps at least two columns before its content (its padding or a leading empty box two columns wide counts), where the painter draws `▸` or `▾` and a space, unless
  its first text starts with such a mark itself.

The app's style is kept as given; leaving the terminal (`cell` back to `None`) lays it out with Taffy again.

## Environment variables

CSS's `env()` keeps content clear of system UI and the software keyboard, in place of wrapper components:

| Variable | Value |
|---|---|
| `safe-area-inset-top` / `-right` / `-bottom` / `-left` | the insets of the root view the node renders in: the surface's safe area, a dialog's, or a page's below its header (in a browser the page is the root, so the definitions agree) |
| `keyboard-inset-height` | the VirtualKeyboard API's: the software keyboard's height over the surface, 0 while it is hidden |

Supported on the physical padding and margin properties and their shorthands only (`padding`, `paddingTop`, ...,
`paddingHorizontal` / `paddingVertical`, the same for `margin`; Tailwind's `p*` / `m*` arbitrary values), with the
values `env(name)`, `env(name, <length>)` (the fallback stands in for an unknown name, as in CSS), `calc(env(name) +
<length>)` and `calc(<length> + env(name))` (white space around `+`, as CSS requires; Tailwind's arbitrary values may
leave it out, `pt-[calc(env(safe-area-inset-top)+8px)]`, as Tailwind CSS adds it). A padding's length is not
negative. Anything else with `env()` is rejected with a warning (unknown names without a fallback, other operators,
two variables, percentages, start / end properties, other properties) and its Tailwind class is unknown.
Rust components: `Styled`'s `.p_safe_area()`, `.px_safe_area()`, `.pt_safe_area()`, ..., the `m*` ones,
`.pt_safe_area_plus(px(8.0))`, `.pb_keyboard()`, `.pb_keyboard_plus(px(49.0))`, `.mb_keyboard()`,
`.mb_keyboard_plus(…)`.

How it works: `Style::set_key` splits a declaration into its length (the ordinary padding / margin) and its variable
(`Style::pending.env`, `EnvEdges`, by physical edge; a later plain value on the edge clears it; in right-to-left
layouts the term follows its declaration's left / right swap). The core keeps the nodes with terms
(`Core::env_styled`): `set_style` adds what the terms come to (`Core::env_insets`, from `insets_of` and the
environment's keyboard) to the padding and margin, on top of the inset padding / margin components set
(`Prop::InsetPadding` / `InsetMargin`), and each commit (`Core::sync_env`) restyles those whose value changed (a safe
area, a page's reported insets, the keyboard, a move to another root view). When the keyboard's height moves one and
the keyboard reports a duration, the commit leads with a `LayoutAnimation` on `LayoutCurve::Keyboard`, so the frames
animate natively with the keyboard; no JS runs. Nodes without `env()` cost nothing (`sync_env` returns at once with
none).

## Colors

Colors in Rust follow GPUI's design (`nsh_core::color`; GPUI is a reference, not a dependency). **`Hsla`** is the
color Rust code holds, passes and computes with: theme colors (`AdaptiveColor { light: Hsla, dark: Hsla }`), the
`Styled` color methods (`.bg(..)`, `.text_color(..)`: anything `Into<AdaptiveColor>`, so an `Hsla`, an `Rgba` or a
theme color), host element setters (`.placeholder_color(..)`, `.header_tint_color(..)`), the canvas painter, the
palette (`palette::SKY.shade(500)`), `color(..)` (an adaptive color for the appearance now) and Rust components'
props (decoded from the same CSS strings as `Color`, so their TypeScript is unchanged). **`Rgba`** is for conversions,
as in GPUI; `rgb(0x2563eb)` and `rgba(0x2563eb80)` build one, `hsla(h, s, l, a)` (each `0..=1`, the hue in turns) and
`hsl(deg, %, %)` (gpui-kit's) build an `Hsla`, and `black()`, `white()`, `transparent_black()`, `opaque_grey(l, a)` are
GPUI's constants. `Rgba::to_hsla` and `Rgba::to_packed` are `const`, for colors in `const`s.

The packed **`Color`** (`0xRRGGBBAA`) is only the storage and wire form: what the style pipeline diffs and caches
(`Style`, `BoxShadow`, gradient stops, `Prop` values), mount items, the Android and web encodings and the fixtures'
`#rrggbbaa`. A color becomes packed where it enters a style, a prop or an operation (`Declaration::lower`, the host
setters), and nowhere earlier.

Adjusting a color is a method of `Hsla`, so state colors are derived rather than picked (a pressed shade is
`c.blend(opaque_grey(0.0, 0.12))` in light appearance and `opaque_grey(1.0, 0.12)` in dark):

| Method | Does |
|---|---|
| `opacity(f)`, `alpha(a)`, `fade_out(f)` | alpha times `f`; set to `a`; times `1 - f` (in place) |
| `lighten(f)`, `darken(f)` | lightness times `1 + f` (at most 1), times `1 - f` (gpui-kit's) |
| `saturate(f)`, `desaturate(f)`, `grayscale()` | the same for the saturation; no saturation |
| `spin(deg)`, `hue(h)`, `saturation(s)`, `lightness(l)`, `apply(base)` | rotate the hue; set one channel; take `base`'s hue and saturation |
| `invert()`, `invert_l()` | `1 - x` for hue, saturation and lightness; for the lightness only |
| `blend(over)` | `over` drawn on top by its alpha (source over, sRGB), keeping this alpha |
| `mix(other, f)`, `mix_oklab(other, f)` | `f` of this color, in HSL (the hue the short way) or in Oklab (CSS `color-mix(in oklab, …)`) |
| `luminance()`, `contrast_ratio(other)`, `readable_text()` | WCAG's relative luminance and contrast ratio; white or black, whichever reads better on it |
| `to_hex()`, `Hsla::parse_hex(..)`, `"…".parse::<Hsla>()` | `#RRGGBB(AA)`; hex; any CSS color NSH reads |

`AdaptiveColor::opacity(f)` and `AdaptiveColor::map(|c| ..)` apply one to both appearances.

**Rounding** is fixed so that TSX apps render exactly as before and every packed color survives a round trip: packed
to float is `byte / 255`; float to packed clamps to `0..=1`, scales by 255 and rounds halves away from zero (the rule
`rgb()`, `hsl()` and `oklch()` in CSS pack with); HSL to RGB is CSS Color 4's formula (`color::hsl_to_rgb`, shared
with `hsl()`), so `hsla(h, s, l, a)` packs as `hsl(h·360 s·100% l·100% / a)` does. Tests hold all of it: every 24-bit
color through `Hsla` and back, a table of CSS color strings with their packed values (`css.rs`), `opacity` against the packed alpha scaling it replaced (the same for
opaque colors; for translucent ones within one alpha step, where `alpha · factor` is exactly a half).

**Deviations from GPUI**, on purpose: packing rounds (GPUI's `From<Rgba> for u32` truncates, which loses colors on a
round trip); parsing takes every CSS color, not only hex, and fails with `ColorParseError` instead of `anyhow`;
gpui-kit's `Colorize` methods are inherent methods of `Hsla` (no trait to import), without `divide` (it sets the alpha:
`alpha`), and `lighten` clamps the lightness to 1; `saturate`, `desaturate`, `spin`, `luminance`, `contrast_ratio`,
`readable_text` and the `const` conversions are NSH's; no serde, schemars or proptest implementations.

## Android differences

- **Android differences**: shadows need a background (no content shadows, e.g. text with a transparent background); odd corner
  radii clip by path before API 33; pull to refresh is our own (stretch overscroll stays native); `contentInset` is padding and
  `decelerationRate` only shapes snapping glides.
