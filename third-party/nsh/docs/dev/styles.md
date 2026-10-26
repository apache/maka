# Styles, classes and effects

- **CSS and Tailwind as in a browser**: CSS values (colors, lengths, gradients, filters, shadows, transforms,
  alignment keywords, ...) and Tailwind utilities and variants mean exactly what they mean in a browser and in Tailwind
  CSS (v4), whose generated CSS is the reference for each utility (the tests compare against it). What NSH cannot
  support is unsupported (an unknown class, a rejected value with a warning), never given a different meaning. Inline
  style objects keep React Native's defaults for unset keys (a column, `flexShrink: 0`, `alignContent: flex-start`
  outside grids). Colors (`crates/nsh-core/src/css.rs`) are hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, names and
  `color-mix()` of any of them (CSS Color 5: `in srgb`, `srgb-linear`, `xyz`, `oklab`, `oklch` or `hsl`, hue methods
  for the polar spaces, premultiplied alpha), packed to sRGB with clamped channels.
- **Tailwind** (`class` / `classList` on every element): JS only passes the strings; the core resolves them (how, and
  what is cached: `crates/nsh-core/src/tailwind/mod.rs`, `core/classes.rs`). The inline `style` always wins over classes; a key set to `undefined` sets nothing, so the class value (or the default) stays, while `null` sets the default.
  Later utilities win over earlier ones (components append a `class` prop, no `tailwind-merge`); variant rules apply
  after plain ones in Tailwind's variant order: a rule's `Rank` is its variants' places highest first, compared as
  Tailwind compares the bit sets of a candidate's variants (`group-*` by inner state, then name; breakpoints by unit
  name, then value, `max-*` widest first), so `dark:hover:` follows `dark:`. Display follows CSS: `flex` / `inline-flex` are rows unless a direction
  utility says otherwise, wherever it is in the string (`flex-col flex` is a column; the implied row is a
  `Decl::Default`, applied before every rule), while views without them keep React Native's column; `block` /
  `flow-root` use Taffy's block layout, and so do `inline` / `inline-block`: a browser blockifies inline boxes in flex
  and grid containers, which every NSH parent but a block is (there is no inline formatting context). Variants: `dark:`, `sm:`…`2xl:` / `max-*:` / `min-[..]:`, `portrait:` /
  `landscape:`, `ios:` / `android:` / `web:`, `rtl:` / `ltr:`, `motion-safe:` / `motion-reduce:`, `active:` / `hover:` /
  `focus:` / `focus-within:` / `disabled:` / `enabled:` / `selected:` (`accessibilityState.selected`, a `Button`'s
  `selected`) / `checked:` (`accessibilityState.checked`, not mixed) / `indeterminate:` (`accessibilityState.checked`
  mixed, CSS's `:indeterminate`), `group-*:` (named groups `group/name`), `first:` / `last:` /
  `odd:` / `even:` / `only:`, `placeholder:` / `selection:` (a color only, the pseudo-element's: `placeholder:text-*` / `selection:bg-*`, the
  `placeholderColor` / `selectionColor` style keys; other utilities under them are unknown), `!` (important). The state classes have style props of their own (`activeStyle`, `hoverStyle`,
  `focusStyle`, `disabledStyle`, `checkedStyle`, `indeterminateStyle`, a `Button`'s `selectedStyle`), resolved the same
  way: later states win, `disabled` over all. `selected`, `checked` and `indeterminate` are value states the core sets
  from the accessibility state (never reported by the platform), below the interaction states: `checked`, then
  `indeterminate` (Tailwind's order), then `selected`, then `hover`, `focus`, `active` (gpui-base's order of value
  states). `disabled` (any element) applies `disabled:` and drops
  the node's press listeners from what is mounted, so it shows no press feedback either. A part of a Rust component
  shows its control's `checked`, `indeterminate` and `disabled` to its own classes and state styles
  (`Interactive::project_checked`, `project_indeterminate`, `project_disabled`; `Prop::ProjectedStates`): a switch's thumb styled `checked:translate-x-4`, with no accessibility
  state or press change on the part, so screen readers hear the control alone. `dark:` follows the appearance
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
  unknown class '...'`, target `nsh::build`); the core logs each unknown class once at run time. Class-only settings
  that are props in React Native (`line-clamp-*`, `truncate`, `whitespace-nowrap`, `pointer-events-*`, `object-*`,
  `caret-*`) lose to explicit props; `placeholder:text-*` / `selection:bg-*` lose to the `placeholderColor` /
  `selectionColor` style keys. Not supported, so unknown: `peer-*`, pseudo-elements, arbitrary CSS properties, and every
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
  inline `transform: [{ perspective }]` stays a step of the view's own transform (React Native).
- **Boxes** (kept, documented in the guide): `overflow-x-hidden` / `overflow-y-hidden` clip both axes and never scroll
  (views are no scroll containers; CSS's other axis would be scrollable); `invisible` hides the subtree (`setHidden`,
  `View.INVISIBLE`; CSS's `visible` child would show); `mix-blend-*` blends with everything drawn behind (no stacking
  context isolates it); `block` boxes never collapse margins with their children (an unset `align-content` resolves to
  `flex-start`, which makes taffy's block a formatting context); strings keep their whitespace (`whitespace-*` sets
  wrapping only; the JSX compiler collapses literal JSX text); `transition` / `transition-all` animate their groups
  (`TransitionProps`: colors, opacity, transform, shadows, shape), and filters, backdrop filters, gradients and layout
  take their new values at once; `focus-visible:` is `focus:` (the state bits, a `u8`, have none left for a focus's
  origin, which only the desktops and the web report).
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
- **`pointer-events-*` classes** inherit as CSS's `pointer-events` (the `pointerEvents` prop keeps React Native's
  subtree meaning, and wins): a view that is `none` by its own class or the nearest one above mounts `box-none` when a
  `pointer-events-auto` inside it is a target, `none` at the top of what it blocks, and nothing below that
  (`classes.rs` `update_pointer_events`, run over a region when a class, an insert or a removal changes it; the node
  keeps what it mounts, `class_pointer`, so only changes are sent; `pointer_none_classes` counts the views with
  `none`, so apps without one skip it).
- **`currentColor`**: a border, an outline or a ring whose classes set a width and no color (`border`, `outline-2`,
  `ring`; preflight's `border: 0 solid`) is drawn in the node's text color: its inline style's, its classes', else the one
  it inherits, else black (`CurrentColor`, `Decl::CurrentColor`; such classes depend on `deps::CURRENT_COLOR`). Each node
  keeps the color it inherits (`inherited_color`): an insert compares it with its new parent's, and a change of a node's
  color passes down to the descendants that set none (`Core::inherit_color`), restyling those that read it. Inline
  styles keep React Native's black.
- **Right to left**, classes are physical as in a browser: `pl-*`, `ml-*`, `left-*`, `border-l*`, `rounded-l*` /
  `-tl` ..., `text-left` / `text-right` keep their side, while style keys keep React Native's swap. The core swaps every
  left / right property of a node right to left (`apply_direction`), so a class names the other side there
  (`utilities::directed`, applied with the node's resolved direction; such classes depend on `deps::RTL`), and the
  swap puts it back. `text-end` is React Native's `right`, which the swap makes the end.
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
- **Effects** (styles and classes; `effects.rs`): `boxShadow` (CSS syntax, several, `inset`; also `shadow-*` / `ring-*`),
  `backgroundImage` (linear / radial / conic gradients and their `repeating-` forms,
  drawn over `backgroundColor` as in CSS; stops at percentages, at lengths along linear and radial gradients
  (a `DefiniteLength::Absolute` position: `Gradient::resolve_stops` places them against `Gradient::line_length` of the box when it is
  drawn, so every native backend passes the view's size; Android's `Decor.Gradient.resolve` does the same for the
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
  the radius approximates strength as a fraction of the material, rather than a Gaussian radius), `glassEffect`
  (Apple's Liquid Glass, drawn in the `backdropFilter`'s place on iOS 26 and later and nowhere else, so give a glass
  view a blur to fall back to), `maskImage` (a gradient whose alpha decides how much of the view is drawn, its backdrop
  filter included; iOS and web, the topmost layer of several), `mixBlendMode`, `outline*`, `visibility`, `cursor`, `transition*` (CSS: property groups,
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
  style gives); a text shadow is one layer everywhere (`text-shadow-*` keep the theme's widest).
- **View styles**: `backgroundColor`, `borderWidth` / `borderColor` (also per side: `borderTopWidth`, `borderLeftColor`, ...),
  `borderStyle` (`solid` / `dashed` / `dotted`; `none` / `hidden` zero the used widths in layout and paint whatever
  order the widths come in, as `outlineStyle: "none"` does, `Pending`), `borderRadius` + the four `borderTopLeftRadius`-style corners, `borderCurve`
  (`continuous`: corners easing into the edges, Figma's 60% corner smoothing, shrinking to circular where the box is too
  small, so pills stay pills; the outline geometry is `nsh_core::shape::rounded_rect`, ported to `Decor.java`; iOS layers that
  draw their own corners use `cornerCurve`), `overflow`, `opacity`,
  `transform` (translate / scale / rotate / rotateX / rotateY / skew / perspective, applied right to left like CSS; Android has no
  skew), `zIndex` (stable order of the native views), `shadowColor` / `shadowOffset` / `shadowOpacity` / `shadowRadius` (RN
  defaults: offset `(0, -3)`, radius 3, opacity 0), `tintColor` (images), `objectPosition` (images: where the fitted image sits, CSS's `object-position`; `images.md`), `android={{ elevation }}` (a prop, not a style: Android's material shadow, with
  `shadowColor` from API 28), `transformOrigin` (keywords / percentages / lengths; iOS conjugates the matrix around it,
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
  already combine in any order (`transitionProperty` defaults to `all`). Text adds `textShadowColor` / `textShadowOffset` / `textShadowRadius`,
  `fontVariant` (OpenType `smcp` / `onum` / `lnum` / `tnum` / `pnum`: CoreText feature settings, `Paint.setFontFeatureSettings`)
  and `writingDirection`.
  On Apple everything is drawn by Core Animation, escalating only as needed (`crates/nsh-platform-ios/src/decor.rs`
  describes the paths and their limits); Android draws in `Decor.java`.

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
