---
title: Tailwind reference
description: Every Tailwind utility and variant NSH resolves natively, the arbitrary value syntax, and how to extend the theme in nsh.json.
order: 17
---

# Tailwind reference

Every element takes Tailwind CSS classes in its `class` prop (and conditional ones in `classList`). NSH resolves them in Rust against Tailwind 4's default theme: JS passes only the string, each distinct string is parsed once and cached, and variants such as `dark:` or `active:` are re-evaluated natively when the appearance, window size or press state changes, without running any JS.

Each utility sets exactly what Tailwind CSS 4 generates for it, with the same meaning as in a browser. This page lists what is supported. For an introduction see [Tailwind](../docs/tailwind.md); for the style keys the utilities set, see the [Style reference](./style-reference.md).

Rust components take no class strings: they style elements with the typed methods of `Styled` (`nsh_core::prelude`), named after these utilities and resolving to the same values, Tailwind's default scales included (`px-4` is `.px_4()`, `rounded-2xl` `.rounded_2xl()`, `shadow-md` `.shadow_md()`, `bg-linear-to-br` `.bg_linear_to_br()`). Colors are values: theme colors, or Tailwind's palette as `nsh_core::element::palette` (`ZINC.shade(800)` is `zinc-800`). Variants are methods taking a closure of styles: `.active(|s| …)`, `.hover(…)`, `.focus(…)`, `.disabled_style(…)`, `.dark(…)`, `.group_active(…)`, and `.style_when(condition, …)` for the rest. The [Style reference](./style-reference.md) names the method of each style key.

```rust tabs
use nsh_core::{element::palette::{RED, ZINC}, prelude::*};

view()
    .flex_row()
    .items_center()
    .gap_3()
    .rounded_2xl()
    .bg(white())
    .p_4()
    .shadow_md()
    .active(|s| s.scale(0.98))
    .transition()
    .dark(|s| s.bg(ZINC.shade(800)))
    .child(
        text("Inbox")
            .text_base()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(ZINC.shade(900))
            .dark(|s| s.text_color(white())),
    )
    .child(
        text(move || unread.get().to_string())
            .text_color(move || if unread.get() > 0 { RED.shade(500) } else { ZINC.shade(400) }),
    )
```

```tsx tabs
<View class="flex-row items-center gap-3 rounded-2xl bg-white p-4 shadow-md active:scale-[0.98] transition dark:bg-zinc-800">
  <Text class="text-base font-semibold text-zinc-900 dark:text-white">Inbox</Text>
  <Text classList={{ "text-red-500": unread() > 0, "text-zinc-400": unread() === 0 }}>{unread()}</Text>
</View>
```

## How classes combine

- **Later wins.** Among utilities of the same variant level, the one later in the string wins: `"p-4 p-2"` is `p-2`. A component can take a `class` prop and append it to its own classes without `tailwind-merge`.
- **Variants apply after plain utilities**, in Tailwind's variant order: `group-*:` (by their state, then by group name), `selection:`, `placeholder:`, position (`first:` ...), `checked:`, `indeterminate:`, `selected:`, `focus-within:`, `hover:`, `focus:`, `focus-visible:`, `active:`, `enabled:`, `disabled:`, motion, `max-*:` breakpoints widest first, then breakpoints ascending, orientation, direction, `dark:`, then platform. A class's highest variant decides, then its next highest, and one more variant comes later (`dark:hover:` after `dark:`), as Tailwind sorts them. So `"active:bg-red-500 bg-blue-500"` is red while pressed.
- **`style` wins over classes.** The inline `style` is applied on top of the resolved classes. An important utility (`!p-4` or `p-4!`) wins over the inline style too.
- **Text styles inherit.** Text utilities on a view (`text-white`, `font-bold`, `text-center`, ...) pass to the `<Text>` and `<Input>` elements inside it, as in CSS.
- **Display is CSS's.** `flex` and `inline-flex` make a row unless a direction utility says otherwise, wherever it is in the string (`flex-col flex` is a column). Views without `flex` keep NSH's column default.

## Units and the theme

Lengths are points (`1` = one point on iOS, one dp on Android). Tailwind's `1rem` is 16 points, so the theme matches the web at the same density: one spacing step is 4 points (`p-4` = 16 points), `text-base` is 16 points.

### Spacing values

Utilities that take a spacing value (padding, margin, gap, inset, width, height, `basis`, `translate`, `leading`) accept:

| Value | Example | Result |
|---|---|---|
| Steps (quarter steps allowed) | `p-4`, `gap-1.5`, `m-0.25` | step × 4 points |
| `px` | `p-px`, `-mt-px` | 1 point |
| `0` | `m-0` | 0 |
| Fraction (inset, width, height, `basis`, `translate`) | `w-1/2`, `left-1/3` | percentage of the parent |
| `full` (the same) | `w-full`, `inset-full` | 100% |
| `auto` (margin, inset, width, height, basis) | `mx-auto`, `w-auto` | `"auto"` |
| Arbitrary | `p-[13px]`, `w-[42%]`, `mt-[1.5rem]` | the given length |

Margins, insets, `translate`, `rotate`, `skew`, `scale`, `z`, `hue-rotate`, `tracking`, `underline-offset`, `outline-offset`, grid lines and gradient angles take a leading `-` for negative values: `-mt-2`, `-translate-x-1/2`, `-rotate-6`. Tailwind has no negative form of the others (`-p-4`, `-gap-2`, `-w-4`), and neither has NSH.

### Colors

The full Tailwind 4 palette is built in: `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`, `slate`, `gray`, `zinc`, `neutral`, `stone`, `mauve`, `olive`, `mist`, `taupe`, each in shades `50`, `100`–`900`, `950`; plus `black`, `white` and `transparent`. Your own colors come from `nsh.json` (see [Theme customization](#theme-customization)).

Every color utility takes:

| Form | Example |
|---|---|
| A theme color | `bg-sky-500`, `text-brand` |
| An opacity modifier (percent) | `bg-black/50`, `ring-black/5` |
| An arbitrary opacity | `text-black/[0.35]` |
| An arbitrary color | `bg-[#0ea5e9]`, `border-[rgb(0_0_0_/_0.1)]`, `text-[oklch(70%_0.2_50)]` |
| An arbitrary color with a modifier | `bg-[rgb(0_0_255)]/25` |

`currentColor` and `inherit` are not color values. As in a browser, a border, an outline or a ring without a color class is drawn in the element's text color, its own or the one it inherits (`<View class="text-white"><View class="border ring-2" /></View>` draws both white); a border set in the `style` prop is black by default.

## Arbitrary values

Square brackets pass a value the theme does not have: `w-[37px]`, `grid-cols-[200px_1fr]`, `bg-[linear-gradient(45deg,red,blue)]`.

- `_` stands for a space (`grid-cols-[1fr_2fr]`); write `\_` for a literal underscore.
- Lengths: a bare number or `px` (points), `pt` (4/3 of a point, as in CSS), `rem` (16 points), and `%` where percentages make sense.
- Angles (`rotate-[...]`, `hue-rotate-[...]`, `bg-linear-[...]`): `deg`, `rad`, `grad`, `turn`.
- Times (`duration-[...]`, `delay-[...]`): `ms` or `s`; a bare number is milliseconds.
- Type hints settle ambiguous values: `text-[length:22px]` is a size, `text-[color:#333]` a color; `border-[length:3px]` likewise.

Arbitrary CSS properties (`[mask-type:luminance]`) are not supported.

## Layout

| Class | Sets |
|---|---|
| `flex`, `inline-flex` | `display: "flex"`, and a row unless a direction utility is present |
| `grid`, `inline-grid` | `display: "grid"` |
| `block`, `flow-root` | block layout or an independent block formatting context |
| `box-border`, `box-content` | dimensions include borders and padding, or content alone |
| `w/h/size-min`, `w/h/size-max`, `w/h/size-fit` | Taffy intrinsic sizes: `min-content`, `max-content`, `fit-content` |
| `inline`, `inline-block` | `display: "block"`: what a browser computes for them in a flex or grid parent |
| `hidden` | `display: "none"` |
| `relative`, `absolute` | `position` |
| `static` | `position: "static"`: in the flow, its insets ignored ; absolute descendants use their nearest positioned ancestor |
| `sticky` | `position: "sticky"`: in the flow, it sticks `top` (`left` in a horizontal scroll view) within the scroll view around it while its parent is in view |
| `fixed` | `position: "fixed"`: an element laid out in its root view's box (the window or its modal) above that root view's children, in place while what is around it scrolls |
| `inset-<n>`, `inset-x-<n>`, `inset-y-<n>` | `top` / `right` / `bottom` / `left` |
| `top-<n>`, `right-<n>`, `bottom-<n>`, `left-<n>` | the matching offset |
| `start-<n>`, `end-<n>` | `start` / `end` (direction-aware) |
| `z-<n>`, `z-auto`, `z-[<n>]` | `zIndex` (`z-auto` is 0) |
| `visible` | `visibility: "visible"` |
| `invisible`, `collapse` | `visibility: "hidden"` (keeps its space) |
| `overflow-hidden`, `overflow-clip`, `overflow-x-hidden`, `overflow-y-hidden` | `overflow: "hidden"` |
| `overflow-visible` | `overflow: "visible"` |
| `aspect-square`, `aspect-video`, `aspect-<a>/<b>`, `aspect-[<a>/<b>]`, `aspect-auto` | `aspectRatio` (1, 16/9, a/b, none) |

Scrolling is an element, not a class: `overflow-auto` and `overflow-scroll` are not supported; use [scroll](../elements/scroll.md).

## Flexbox and grid

| Class | Sets |
|---|---|
| `flex-row`, `flex-row-reverse`, `flex-col`, `flex-col-reverse` | `flexDirection` |
| `flex-wrap`, `flex-wrap-reverse`, `flex-nowrap` | `flexWrap` |
| `flex-1` | grow 1, shrink 1, basis 0 |
| `flex-<n>` | grow n, shrink 1, basis 0 |
| `flex-auto` | grow 1, shrink 1, basis auto |
| `flex-initial` | grow 0, shrink 1, basis auto |
| `flex-none` | grow 0, shrink 0, basis auto |
| `flex-[<grow>]`, `flex-[<grow>_<shrink>_<basis>]` | the CSS shorthand: `flex-[2]`, `flex-[3_0_50%]` |
| `grow`, `grow-<n>`, `grow-[<n>]` | `flexGrow` (bare: 1) |
| `shrink`, `shrink-<n>`, `shrink-[<n>]` | `flexShrink` (bare: 1) |
| `basis-<n>` | `flexBasis` (spacing, fraction, `full`, `auto`, arbitrary) |
| `justify-start`, `justify-end`, `justify-center`, `justify-between`, `justify-around`, `justify-evenly`, `justify-stretch`, `justify-normal` | `justifyContent` |
| `items-start`, `items-end`, `items-center`, `items-baseline`, `items-stretch` | `alignItems` |
| `self-auto`, `self-start`, `self-end`, `self-center`, `self-stretch`, `self-baseline` | `alignSelf` |
| `content-start`, `content-end`, `content-center`, `content-between`, `content-around`, `content-evenly`, `content-stretch`, `content-normal` | `alignContent` |
| `justify-items-start`, `-end`, `-center`, `-stretch`, `-normal` | `justifyItems` |
| `justify-self-auto`, `-start`, `-end`, `-center`, `-stretch` | `justifySelf` |
| `place-content-center`, `-start`, `-end`, `-between`, `-stretch` | `alignContent` and `justifyContent` |
| `place-items-center`, `-start`, `-end`, `-stretch` | `alignItems` and `justifyItems` |
| `place-self-auto`, `-center`, `-start`, `-end`, `-stretch` | `alignSelf` and `justifySelf` |
| `gap-<n>`, `gap-x-<n>`, `gap-y-<n>` | `gap`, `columnGap`, `rowGap` |
| `space-x-<n>`, `space-y-<n>` (and negative) | a margin on each child but the last: the end margin (`space-x`) or the bottom one (`space-y`), under the child's own margins, as in Tailwind CSS; it adds to a `gap` |
| `space-x-reverse`, `space-y-reverse` | the margin on the start / top side instead (children in reverse order) |
| `grid-cols-<n>` | `gridTemplateColumns: "repeat(n, minmax(0, 1fr))"` |
| `grid-cols-[<tracks>]`, `grid-cols-none` | `gridTemplateColumns` (`grid-cols-[200px_1fr]`) |
| `grid-rows-<n>`, `grid-rows-[<tracks>]`, `grid-rows-none` | `gridTemplateRows` |
| `col-span-<n>`, `col-span-full`, `col-auto`, `col-<n>`, `col-[<value>]` | `gridColumn` |
| `col-start-<n>`, `col-end-<n>` (and `-auto`) | `gridColumnStart`, `gridColumnEnd` |
| `row-span-<n>`, `row-span-full`, `row-auto`, `row-<n>`, `row-[<value>]` | `gridRow` |
| `row-start-<n>`, `row-end-<n>` (and `-auto`) | `gridRowStart`, `gridRowEnd` |
| `grid-flow-row`, `grid-flow-col`, `grid-flow-dense`, `grid-flow-row-dense`, `grid-flow-col-dense` | `gridAutoFlow` |
| `auto-cols-auto`, `-min`, `-max`, `-fr`, `auto-cols-[<track>]` | `gridAutoColumns` |
| `auto-rows-auto`, `-min`, `-max`, `-fr`, `auto-rows-[<track>]` | `gridAutoRows` |

## Spacing

| Class | Sets |
|---|---|
| `p-<n>`, `px-<n>`, `py-<n>` | `padding`, `paddingHorizontal`, `paddingVertical` |
| `pt-<n>`, `pr-<n>`, `pb-<n>`, `pl-<n>` | `paddingTop` / `Right` / `Bottom` / `Left` |
| `ps-<n>`, `pe-<n>` | `paddingStart`, `paddingEnd` |
| `m-<n>`, `mx-<n>`, `my-<n>` | `margin`, `marginHorizontal`, `marginVertical` |
| `mt-<n>`, `mr-<n>`, `mb-<n>`, `ml-<n>` | `marginTop` / `Right` / `Bottom` / `Left` |
| `ms-<n>`, `me-<n>` | `marginStart`, `marginEnd` |

## Sizing

| Class | Sets |
|---|---|
| `w-<n>`, `h-<n>` | `width`, `height` (spacing, fraction, `full`, `auto`, arbitrary) |
| `size-<n>` | `width` and `height` |
| `min-w-<n>`, `max-w-<n>`, `min-h-<n>`, `max-h-<n>` | the matching limit |
| `w-screen`, `w-dvw`, `w-svw`, `w-lvw` | the window width (also on `min-w-` / `max-w-`) |
| `h-screen`, `h-dvh`, `h-svh`, `h-lvh` | the window height (also on `min-h-` / `max-h-`) |
| `w-auto`, `h-auto` | `auto` (sized by content) |
| `max-w-none`, `max-h-none` | no limit |
| `w-<container>`, `min-w-<container>`, `max-w-<container>` | a container width (below) |

Container widths (points): `3xs` 256, `2xs` 288, `xs` 320, `sm` 384, `md` 448, `lg` 512, `xl` 576, `2xl` 672, `3xl` 768, `4xl` 896, `5xl` 1024, `6xl` 1152, `7xl` 1280; `prose` is 65 times the width of the element's font's `0` (CSS's `65ch`), as in Tailwind CSS.

## Typography

### Font

| Class | Sets |
|---|---|
| `font-sans` | the system font |
| `font-serif`, `font-mono` | `fontFamily: "serif"` / `"monospace"` |
| `font-thin` (100), `font-extralight` (200), `font-light` (300), `font-normal` (400), `font-medium` (500), `font-semibold` (600), `font-bold` (700), `font-extrabold` (800), `font-black` (900) | `fontWeight` |
| `font-[<weight>]`, `font-[<family>]` | a numeric weight, otherwise a family: `font-[650]`, `font-[Inter]` |
| `italic`, `not-italic` | `fontStyle` |
| `normal-nums`, `small-caps`, `oldstyle-nums`, `lining-nums`, `tabular-nums`, `proportional-nums` | `fontVariant` (they combine; `normal-nums` resets the number forms) |

### Size, color and line height

`text-<size>` sets the font size and Tailwind's matching line height, which a `leading-*` class replaces wherever it is in the string and whatever its variant (`leading-tight md:text-lg` keeps the tight leading):

| Class | Size | Line height |
|---|---|---|
| `text-xs` | 12 | 16 |
| `text-sm` | 14 | 20 |
| `text-base` | 16 | 24 |
| `text-lg` | 18 | 28 |
| `text-xl` | 20 | 28 |
| `text-2xl` | 24 | 32 |
| `text-3xl` | 30 | 36 |
| `text-4xl` | 36 | 40 |
| `text-5xl` | 48 | 1× |
| `text-6xl` | 60 | 1× |
| `text-7xl` | 72 | 1× |
| `text-8xl` | 96 | 1× |
| `text-9xl` | 128 | 1× |

| Class | Sets |
|---|---|
| `text-<size>/<leading>` | size and line height: `text-sm/6` (24 points), `text-lg/tight` |
| `text-[<length>]` | `fontSize`: `text-[22px]`, `text-[length:22px]` |
| `text-<color>` | `color` |
| `leading-none` (1), `leading-tight` (1.25), `leading-snug` (1.375), `leading-normal` (1.5), `leading-relaxed` (1.625), `leading-loose` (2) | `lineHeight` as a multiple of the font size |
| `leading-<n>`, `leading-[<length>]` | `lineHeight` in points (`leading-6` = 24) |
| `leading-[<number>]` | `lineHeight` as a multiple of the font size (`leading-[1.5]`), inherited as that multiplier; `em` and `%` compute a length at the element's font size before inheritance |
| `tracking-tighter` (-0.05em), `tracking-tight` (-0.025em), `tracking-normal` (0), `tracking-wide` (0.025em), `tracking-wider` (0.05em), `tracking-widest` (0.1em) | `letterSpacing` relative to the font size |
| `tracking-[<value>]` | `letterSpacing`: `tracking-[0.2em]`, `tracking-[1px]` |

### Alignment, case and wrapping

| Class | Sets |
|---|---|
| `text-left`, `text-center`, `text-right`, `text-justify` | `textAlign` |
| `text-start` | `textAlign: "auto"` |
| `align-baseline`, `align-text-top`, `align-text-bottom`, `align-middle` | `verticalAlign` (views and images inside a text) |
| `text-end` | `textAlign: "right"` |
| `uppercase`, `lowercase`, `capitalize`, `normal-case` | `textTransform` |
| `truncate` | one line, tail ellipsis, no wrapping, `overflow: hidden` (on a view: its texts do not wrap) |
| `line-clamp-<n>`, `line-clamp-none` | `numberOfLines` (`none` removes the limit) |
| `text-ellipsis`, `text-clip` | `ellipsizeMode` `"tail"` / `"clip"` |
| `whitespace-nowrap`, `text-nowrap` | lines never wrap; on a view, the lines of the texts in it (inherited, as CSS's `white-space`) |
| `whitespace-normal`, `text-wrap`, `text-balance`, `text-pretty` | lines wrap (balancing is not done) |
| `select-text`, `select-none` | `selectable`; on a view, of the texts in it that set none |
| `select-auto` | the `selectable` of the view around it, as CSS's `user-select: auto` (`select-none md:select-auto`) |

### Decoration and shadow

| Class | Sets |
|---|---|
| `underline`, `line-through`, `no-underline` | `textDecorationLine` |
| `decoration-solid`, `decoration-double`, `decoration-dotted`, `decoration-dashed`, `decoration-wavy` | `textDecorationStyle` |
| `decoration-<n>`, `decoration-[<length>]` | `textDecorationThickness` |
| `decoration-auto`, `decoration-from-font` | `textDecorationThickness: "auto"` |
| `decoration-<color>` | `textDecorationColor` |
| `underline-offset-<n>`, `underline-offset-[<length>]`, `underline-offset-auto` | `textUnderlineOffset` |
| `text-shadow-2xs`, `-xs`, `-sm`, `-md`, `-lg`; `/<alpha>` | a text shadow from the theme (one layer: the widest of the theme's); the modifier is the layers' alpha: `text-shadow-md/20` |
| `text-shadow-<color>`, `text-shadow-current` | its color, at the size's alpha |
| `text-shadow-none` | removes it |

Tailwind's text shadows have several layers; natively one shadow is drawn, the widest layer.

### Inputs

| Class | Sets |
|---|---|
| `placeholder:text-<color>` | `placeholderColor` |
| `selection:bg-<color>` | `selectionColor` (the highlight of an input's or a selectable text's selection, and of those inside the element) |
| `caret-<color>` | the cursor color |

## Backgrounds

| Class | Sets |
|---|---|
| `bg-<color>` | `backgroundColor` |
| `bg-[<gradient>]` | `backgroundImage`: `bg-[linear-gradient(45deg,red,blue)]`, `bg-[radial-gradient(...)]` |
| `bg-linear-to-t`, `-tr`, `-r`, `-br`, `-b`, `-bl`, `-l`, `-tl` | a linear gradient toward a side or corner (`bg-gradient-to-*` is the v3 name) |
| `bg-linear-<angle>`, `bg-linear-[<angle>]` | a linear gradient at an angle: `bg-linear-45`, `-bg-linear-12`, `bg-linear-[0.25turn]` |
| `bg-radial` | a radial gradient from the center |
| `bg-conic`, `bg-conic-<angle>` | a conic gradient, optionally starting at an angle |
| `from-<color>`, `via-<color>`, `to-<color>` | the gradient's stops (default transparent at the ends) |
| `from-<p>%`, `via-<p>%`, `to-<p>%` | stop positions: `via-40%`, `from-[15%]` |
| `bg-none` | removes the gradient |

Gradient utilities mix their colors in Oklab, as Tailwind CSS writes them (`in oklab`); at an arbitrary position (`bg-linear-[25deg]`, `bg-conic-[0.25turn]`) they follow CSS's default, Oklab with the palette's colors and sRGB when every stop is a hex, `rgb()`, `hsl()` or named color.

```rust tabs
view()
    .h_32()
    .rounded_2xl()
    .bg_linear_to_br()
    .gradient_from(INDIGO.shade(500))
    .gradient_via(PURPLE.shade(500))
    .gradient_via_position(percentage(0.4))
    .gradient_to(PINK.shade(500))
```

```tsx tabs
<View class="h-32 rounded-2xl bg-linear-to-br from-indigo-500 via-purple-500 via-40% to-pink-500" />
```

## Borders

| Class | Sets |
|---|---|
| `border`, `border-<n>`, `border-[<length>]` | `borderWidth` (bare: 1) |
| `border-x`, `border-y`, `border-t`, `border-r`, `border-b`, `border-l`, `border-s`, `border-e` (with `-<n>` or bare) | the matching sides' widths |
| `border-<color>`, `border-t-<color>`, ... | `borderColor` and the per-side colors |
| `border-solid`, `border-dashed`, `border-dotted` | `borderStyle` |
| `border-none`, `border-hidden` | `borderStyle: "none"` / `"hidden"`: no border whatever the width classes, in any order (`md:border-solid` shows it again) |
| `rounded`, `rounded-<size>`, `rounded-none`, `rounded-full`, `rounded-[<length>]` | `borderRadius` (bare: `sm`) |
| `rounded-t-`, `-r-`, `-b-`, `-l-`, `-tl-`, `-tr-`, `-br-`, `-bl-` | the matching corners |
| `rounded-s-`, `-e-`, `-ss-`, `-se-`, `-es-`, `-ee-` | start / end corners (direction-aware) |
| `outline`, `outline-<n>`, `outline-[<length>]` | `outlineWidth` (bare: 1), solid unless a style class is anywhere in the string (`outline-dashed outline-2` is dashed, `outline-none outline-2` draws nothing) |
| `outline-<color>` | `outlineColor` |
| `outline-solid`, `outline-dashed`, `outline-dotted`, `outline-none`, `outline-hidden` | `outlineStyle`; a style alone is CSS's medium width, 3 points |
| `outline-offset-<n>`, `outline-offset-[<length>]` | `outlineOffset` |

Radius sizes (points): `xs` 2, `sm` 4, `md` 6, `lg` 8, `xl` 12, `2xl` 16, `3xl` 24, `4xl` 32, `full` 9999.

### Rings

Rings are box shadows with a spread, drawn outside the border without taking space.

| Class | Sets |
|---|---|
| `ring`, `ring-<n>`, `ring-[<length>]` | a ring of that width (bare: 1) |
| `ring-<color>` | its color (default the element's text color) |
| `ring-inset` | draws the ring inside |
| `ring-offset-<n>`, `ring-offset-<color>` | a gap between element and ring (default white) |
| `inset-ring`, `inset-ring-<n>`, `inset-ring-<color>` | an inner ring |

## Effects

| Class | Sets |
|---|---|
| `shadow-2xs`, `shadow-xs`, `shadow-sm`, `shadow`, `shadow-md`, `shadow-lg`, `shadow-xl`, `shadow-2xl`; `/<alpha>` | `boxShadow` from the theme; the modifier is the layers' alpha: `shadow-xl/20` |
| `shadow-[<box-shadow>]` | an arbitrary shadow: `shadow-[0_8px_24px_rgb(0_0_0_/_0.12)]` |
| `shadow-<color>`, `shadow-current` | recolors the shadow layers, at the size's alpha: `shadow-indigo-500/40` |
| `shadow-none` | no shadow |
| `inset-shadow-2xs`, `-xs`, `-sm`, `inset-shadow`, `inset-shadow-[...]`, `inset-shadow-<color>`, `inset-shadow-none` | an inner shadow |
| `opacity-<n>`, `opacity-[<value>]` | `opacity`: `opacity-50` = 0.5 |
| `mix-blend-<mode>` | `mixBlendMode`: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`, `plus-darker`, `plus-lighter` |

Shadows, rings and inset shadows combine into one `boxShadow` list, as in CSS. A shadow color replaces each layer's color, alpha too, as Tailwind's `--tw-shadow-color`: `shadow-md shadow-red-500` is an opaque red shadow, `shadow-md/20 shadow-red-500` one at 20%.

## Filters

| Class | Sets |
|---|---|
| `blur`, `blur-xs` (4), `-sm` (8), `-md` (12), `-lg` (16), `-xl` (24), `-2xl` (40), `-3xl` (64), `blur-none`, `blur-[<length>]` | `blur()` |
| `brightness-<n>`, `contrast-<n>`, `saturate-<n>` | percentage factors: `brightness-125` = 1.25 |
| `grayscale`, `grayscale-<n>`, `invert`, `invert-<n>`, `sepia`, `sepia-<n>` | bare: 100% |
| `hue-rotate-<deg>`, `-hue-rotate-<deg>` | `hue-rotate()` |
| `drop-shadow`, `drop-shadow-xs`, `-sm`, `-md`, `-lg`, `-xl`, `-2xl`, `drop-shadow-[...]`, `drop-shadow-none`; `drop-shadow-<color>`, `drop-shadow-current`; `/<alpha>` on either | a `drop-shadow()` per layer, after the other filters; a color replaces the layers', at the size's alpha; the web, Linux, Windows and GPUI draw every layer, iOS, macOS and Android the widest |
| `drop-shadow-none` | removes it |
| `filter-none` | removes all filters |
| `backdrop-blur`, `backdrop-blur-<size>`, `backdrop-blur-[<length>]` | blurs what is behind the view |
| `backdrop-brightness-<n>`, `backdrop-contrast-<n>`, `backdrop-grayscale`, `backdrop-hue-rotate-<deg>`, `backdrop-invert`, `backdrop-opacity-<n>`, `backdrop-saturate-<n>`, `backdrop-sepia` | backdrop filters |
| `backdrop-filter-none` | removes them |

> [!WARNING]
> iOS applies only `opacity`, `brightness` up to 1 and `drop-shadow` to views; `<Image>` takes every color filter and `blur`. Android needs API 31 for `blur`, `drop-shadow` and backdrop blur. See the [Style reference](./style-reference.md#filters-and-blending).

## Transforms

| Class | Sets |
|---|---|
| `translate-x-<n>`, `translate-y-<n>`, `translate-<n>` | translation (spacing, `full`, fractions of the element's own size: `-translate-x-1/2`, arbitrary) |
| `rotate-<deg>`, `rotate-[<angle>]` | rotation (CSS's `rotate`) |
| `rotate-x-<deg>`, `rotate-y-<deg>`, `rotate-z-<deg>` | 3D rotation (in `transform`, after the translation, the rotation and the scale) |
| `scale-<pct>`, `scale-x-<pct>`, `scale-y-<pct>`, `scale-[<factor>]` | scale: `scale-95` = 0.95, `-scale-x-100` mirrors |
| `skew-<deg>`, `skew-x-<deg>`, `skew-y-<deg>` | skew (not on Android) |
| `perspective-dramatic` (100), `-near` (300), `-normal` (500), `-midrange` (800), `-distant` (1200), `perspective-[<length>]`, `perspective-none` | depth for the 3D rotations of the element's children, seen from its center (CSS's `perspective`: `<View class="perspective-near"><View class="rotate-y-45" /></View>`) |
| `origin-center`, `-top`, `-top-right`, `-right`, `-bottom-right`, `-bottom`, `-bottom-left`, `-left`, `-top-left`, `origin-[<value>]` | `transformOrigin` |
| `backface-hidden`, `backface-visible` | `backfaceVisibility` |
| `transform-none` | clears the 3D rotations and the skews (CSS's `transform: none`) |
| `translate-none`, `rotate-none`, `scale-none` | clears the translation, the rotation, the scale |

Transform utilities compose like CSS: `translate-*`, `rotate-*` and `scale-*` combine regardless of order. `transform`, `transform-gpu`, `transform-cpu` and `transform-flat` are accepted and do nothing: NSH composes every transform alike, flat. Translations by a fraction of the size are resolved against the element's frame and follow it when it resizes.

## Transitions and animation

| Class | Sets |
|---|---|
| `transition` | colors, opacity, shadow and transform; 150 ms, `cubic-bezier(0.4, 0, 0.2, 1)` |
| `transition-all`, `transition-colors`, `transition-opacity`, `transition-shadow`, `transition-transform` | the animated properties |
| `transition-none` | no transition |
| `duration-<ms>`, `duration-[<time>]` | `transitionDuration`: `duration-300`, `duration-[0.4s]` |
| `delay-<ms>`, `delay-[<time>]` | `transitionDelay` |
| `ease-linear`, `ease-in`, `ease-out`, `ease-in-out`, `ease-initial`, `ease-[cubic-bezier(...)]` | `transitionTimingFunction` |
| `animate-spin`, `animate-ping`, `animate-pulse`, `animate-bounce` | a native keyframe animation, repeated forever |
| `animate-none` | stops it |

Transitions run on the UI thread when a value changes, including when a variant starts or stops matching, so `transition active:scale-95` animates the press without JS. Wrap animations in `motion-safe:` to respect the reduce-motion setting.

## Interactivity

| Class | Sets |
|---|---|
| `pointer-events-none`, `pointer-events-auto` | whether the view is a target for touches and the pointer, inherited as in CSS: inside a `pointer-events-none` view, a `pointer-events-auto` one is a target again (the `pointerEvents` prop keeps its own meaning: `"none"` takes the whole subtree out) |
| `cursor-<name>`, `cursor-[<name>]` | `cursor`: `cursor-pointer`, `cursor-grab`, `cursor-not-allowed`, ... (every CSS cursor keyword) |
| `select-none`, `select-text`, `select-auto` | text selection (see Typography) |

## SVG

| Class | Sets |
|---|---|
| `fill-<color>`, `fill-none`, `fill-current`, `fill-inherit` | `fill` (`fill-current` is `currentColor`) |
| `stroke-<color>`, `stroke-none`, `stroke-current`, `stroke-inherit` | `stroke` |
| `stroke-<number>`, `stroke-[<length>]` | `strokeWidth` |

## Images

| Class | Sets |
|---|---|
| `object-cover`, `object-contain`, `object-fill`, `object-none`, `object-scale-down` | `resizeMode` (`fill` stretches, `none` is `"center"`: natural size, placed at `objectPosition`, `scale-down` is `"scale-down"`: the same, shrunk to fit where larger) |
| `object-top`, `object-bottom`, `object-left`, `object-right`, `object-center`, `object-top-left`, `object-top-right`, `object-bottom-left`, `object-bottom-right`, `object-[<position>]` | `objectPosition` (`object-left-top`, ... are the same as `object-top-left`, ...) |
| `tint-<color>` | `tintColor` (recolors template images) |

## Accepted without effect

These utilities are rendering hints, or what every native view already is; they parse without a warning and change nothing: `antialiased`, `subpixel-antialiased`, `isolation-auto`, `box-border`, `appearance-none`, `appearance-auto`, `will-change-auto`, `will-change-scroll`, `will-change-contents`, `will-change-transform`, `will-change-[<value>]`, `transform`, `transform-gpu`, `transform-cpu`, `transform-flat`. Scrolling, snapping and overscroll are props of [scroll](../elements/scroll.md).

## Not supported

`peer-*` variants, pseudo-elements (`before:`, `after:`), arbitrary properties (`[prop:value]`), `overflow-auto` / `overflow-scroll`, `divide-*`, `columns-*`, `float-*`, `container`, container queries, `order-*`, `transform-3d`, `select-all`, `border-double` / `outline-double`, intrinsic min/max constraints (such as `max-w-max`), `snap-*`, `scroll-*`, `overscroll-*`, `touch-*` and `isolate` are unknown classes. `nsh build` and `nsh dev` warn about unknown classes they find in your source (`file:line:col: unknown class '...'`), and the runtime logs each unknown class once.

## Variants

Variants make a utility conditional: `dark:bg-zinc-900`, `md:flex-row`, `active:opacity-70`. They stack (`dark:active:bg-zinc-700`) and are evaluated natively whenever what they depend on changes.

### Appearance and environment

| Variant | Applies when | Rust |
|---|---|---|
| `dark:` | the appearance is dark | `.dark(\|s\| …)` |
| `ios:` | running on iOS or Mac Catalyst | `.when(os() == Os::Ios, …)` |
| `android:` | running on Android | `.when(os() == Os::Android, …)` |
| `portrait:`, `landscape:` | the window is taller than wide / wider than tall | `.style_when(move \|\| window().height > window().width, …)` |
| `ltr:`, `rtl:` | the layout direction | `.style_when(rtl, …)` |
| `motion-safe:`, `motion-reduce:` | the user has not / has asked for reduced motion | `.style_when(reduce_motion, …)` |

### Breakpoints

Breakpoints compare the window width in points.

| Variant | Min width |
|---|---|
| `sm:` | 640 |
| `md:` | 768 |
| `lg:` | 1024 |
| `xl:` | 1280 |
| `2xl:` | 1536 |

| Form | Example | Applies when |
|---|---|---|
| `<bp>:` | `md:p-8` | width ≥ breakpoint |
| `max-<bp>:` | `max-md:p-1` | width < breakpoint |
| `min-[<length>]:` | `min-[600px]:grid-cols-3` | width ≥ the length |
| `max-[<length>]:` | `max-[400px]:text-sm` | width < the length |

A phone in portrait (390 points wide) matches none of the default breakpoints; a tablet or a phone in landscape matches several. In Rust, a breakpoint is a condition on the window: `.style_when(move || window().width >= px(768.0), |s| s.p_8())` is `md:p-8`.

### Interaction states

States are tracked by the platform only for elements whose classes use them, and changes apply natively, with no JS round trip.

| Variant | Applies when | Rust |
|---|---|---|
| `active:` | the element is pressed | `.active(\|s\| …)` |
| `hover:` | a pointer is over it (iPad pointer, Mac Catalyst, Android mouse) | `.hover(\|s\| …)` |
| `focus:`, `focus-visible:` | the input has focus | `.focus(\|s\| …)` |
| `focus-within:` | the element or a descendant has focus |  |
| `disabled:` | the element has the `disabled` prop | `.disabled_style(\|s\| …)` |
| `enabled:` | the element does not have the `disabled` prop |  |
| `selected:` | the element is selected: a `Button`'s `selected`, or `accessibilityState.selected` |  |
| `checked:` | the element is checked: `accessibilityState.checked` is `true` (`"mixed"` is not checked) |  |
| `indeterminate:` | the element is indeterminate: `accessibilityState.checked` is `"mixed"` |  |

The same states as style objects are the `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle`, `checkedStyle` and `indeterminateStyle` props of every element (and a `Button`'s `selectedStyle`); they go over the element's style and classes.

`disabled` works on any element: it applies `disabled:` and removes the element's press handlers, so it shows no press feedback either.

```rust tabs
view()
    .on_press(save)
    .disabled(saving)
    .rounded_lg()
    .bg(BLUE.shade(600))
    .px_4()
    .py_2()
    .transition()
    .active(|s| s.scale(0.95).bg(BLUE.shade(700)))
    .disabled_style(|s| s.opacity(0.4))
    .child(text("Save").font_weight(FontWeight::MEDIUM).text_color(white()))
```

```tsx tabs
<View
  onPress={save}
  disabled={saving()}
  class="rounded-lg bg-blue-600 px-4 py-2 transition active:scale-95 active:bg-blue-700 disabled:opacity-40"
>
  <Text class="font-medium text-white">Save</Text>
</View>
```

### Groups

Mark an ancestor with `group` and style descendants by its state with `group-<state>:`. Name groups to nest them: `group/card` and `group-hover/card:`.

| Variant | Applies when the group is | Rust |
|---|---|---|
| `group-active:` | pressed | `.group_active(…)`, `.group_active_named(name, …)` |
| `group-hover:` | hovered | `.group_hover(…)`, `.group_hover_named(name, …)` |
| `group-focus:`, `group-focus-visible:` | focused |  |
| `group-focus-within:` | focused or containing focus | `.group_focus_within(…)`, `.group_focus_within_named(name, …)` |
| `group-disabled:` | disabled |  |
| `group-selected:` | selected |  |
| `group-checked:` | checked |  |
| `group-indeterminate:` | indeterminate |  |

```rust tabs
view()
    .on_press(open)
    .group_named("row")
    .flex_row()
    .items_center()
    .gap_3()
    .p_3()
    .active(|s| s.bg(ZINC.shade(100)))
    .child(
        text("Settings")
            .flex_1()
            .text_color(ZINC.shade(900))
            .group_active_named("row", |s| s.text_color(BLUE.shade(600))),
    )
    .child(
        text("›")
            .text_color(ZINC.shade(400))
            .group_active_named("row", |s| s.translate_x(px(4.0)))
            .transition_transform(),
    )
```

```tsx tabs
<View onPress={open} class="group/row flex-row items-center gap-3 p-3 active:bg-zinc-100">
  <Text class="flex-1 text-zinc-900 group-active/row:text-blue-600">Settings</Text>
  <Text class="text-zinc-400 group-active/row:translate-x-1 transition-transform">›</Text>
</View>
```

### Position among siblings

| Variant | Applies to |
|---|---|
| `first:` | the first child |
| `last:` | the last child |
| `only:` | the only child |
| `odd:` | the 1st, 3rd, ... child |
| `even:` | the 2nd, 4th, ... child |

```rust tabs
each(items, |item: &Item| item.id, move |item, index| {
    text(move || item.with(|i| i.name.clone()))
        .border_b(px(1.0))
        .border_color(ZINC.shade(200))
        .py_3()
        .style_when(move || index.get() + 1 == items.with(Vec::len), |s| s.border_b(px(0.0)))
})
```

```tsx tabs
<Each of={items()}>{(item) => <Text class="border-b border-zinc-200 py-3 last:border-b-0">{item().name}</Text>}</Each>
```

### Placeholder and selection

`placeholder:` applies to an `<Input>`'s placeholder and only takes a text color: `placeholder:text-zinc-400` (the style key `placeholderColor`). `selection:` applies to the selection of an `<Input>` or a selectable `<Text>`, and on any element to those inside it (Tailwind's `& *::selection`; the nearest element's wins), and takes its background, the highlight: `selection:bg-violet-200` (the style key `selectionColor`, which also tints an input's caret where the platform draws them in one color).

### Important

`!` before or after a utility (`!p-4`, `p-4!`) makes it win over every other class and over the inline `style`.

## Theme customization

Extend the theme in the `"tailwind"` object of your app's `nsh.json`. Entries with a new name are added; entries with an existing name replace the default. Lengths are points. The theme is checked when the app is bundled: an unknown key or an invalid value is a build error.

```json
{
  "name": "My App",
  "id": "com.example.myapp",
  "tailwind": {
    "colors": {
      "brand": { "50": "#f5f3ff", "500": "#7c3aed", "600": "#6d28d9", "DEFAULT": "#7c3aed" },
      "accent": "#f59e0b"
    },
    "spacing": 4,
    "breakpoints": { "tablet": 600 },
    "fontFamily": { "display": "Inter" },
    "fontSize": { "huge": [48, 1.1] },
    "fontWeight": { "heavy": 850 },
    "radius": { "card": 14 },
    "shadow": { "card": "0 2px 8px rgb(0 0 0 / 0.12)" },
    "insetShadow": { "well": "inset 0 2px 6px rgb(0 0 0 / 0.1)" },
    "dropShadow": { "icon": "0 2px 4px rgb(0 0 0 / 0.2)" },
    "tracking": { "label": 0.08 },
    "leading": { "dense": 1.15 },
    "blur": { "glass": 20 },
    "perspective": { "card": 700 },
    "aspect": { "photo": 1.5 },
    "ease": { "snappy": [0.2, 0, 0, 1] },
    "container": { "content": 680 }
  }
}
```

With this theme, `bg-brand-500`, `bg-brand` (the `DEFAULT` shade), `text-accent`, `tablet:flex-row`, `font-display`, `text-huge`, `font-heavy`, `rounded-card`, `shadow-card`, `inset-shadow-well`, `drop-shadow-icon`, `tracking-label`, `leading-dense`, `blur-glass`, `perspective-card`, `aspect-photo`, `ease-snappy` and `max-w-content` all work.

| Key | Value | Used by |
|---|---|---|
| `colors` | `{ name: color }` or `{ name: { shade: color } }`; `DEFAULT` names the bare color. Any CSS color syntax. | every color utility |
| `spacing` | points per step (default 4) | `p-*`, `m-*`, `gap-*`, `w-*`, ... |
| `rem` | points per `rem` (default 16) | |
| `breakpoints` | `{ name: width }` | breakpoint variants (sorted by width) |
| `container` | `{ name: width }` | `w-*`, `min-w-*`, `max-w-*` |
| `fontFamily` | `{ name: family }` (a system family or the name of a bundled font) | `font-*` |
| `fontSize` | `{ name: size }` or `{ name: [size, lineHeightMultiple] }` | `text-*` |
| `fontWeight` | `{ name: 1–1000 }` | `font-*` |
| `tracking` | `{ name: em }` | `tracking-*` |
| `leading` | `{ name: multiple }` | `leading-*` |
| `radius` | `{ name: points }` | `rounded-*` |
| `shadow`, `insetShadow`, `dropShadow` | `{ name: "CSS box-shadow" }` | `shadow-*`, `inset-shadow-*`, `drop-shadow-*` |
| `blur` | `{ name: points }` | `blur-*`, `backdrop-blur-*` |
| `perspective` | `{ name: points }` | `perspective-*` |
| `aspect` | `{ name: ratio }` | `aspect-*` |
| `ease` | `{ name: [x1, y1, x2, y2] }` | `ease-*` |

> [!NOTE]
> The Tailwind theme shapes only your app's classes. The app's design tokens (shadcn/ui's colors, `radius`, the fonts and the app's own) are its theme, the `"theme"` key of `nsh.json`, which Rust components draw with; see [Rust](../docs/rust.md#theme). Classes name those tokens as Tailwind names `@theme` variables (`bg-primary`, `bg-up/30`, `rounded-(--radius)`): see [Theme tokens](../docs/tailwind.md#theme-tokens).

## Related

- [Tailwind](../docs/tailwind.md): the guide.
- [Styling](../docs/styling.md): `class`, `classList`, `style` and how they combine.
- [Style reference](./style-reference.md): the style keys utilities set.
