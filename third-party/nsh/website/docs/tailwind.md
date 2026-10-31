---
title: Tailwind
description: Tailwind CSS classes resolved natively in TSX and their typed equivalents in Rust - class and classList, variants for pressed states, dark mode and breakpoints, the theme in nsh.json, and the build-time class check.
order: 33
group: ui
demo: guide-tailwind
---

# Tailwind

NSH's styles follow Tailwind CSS 4. In Rust, Tailwind's utilities are typed style methods with the same names and values (`.p_4()` is `p-4`, `.rounded_2xl()` is `rounded-2xl`, `ZINC.shade(900)` is `zinc-900`); in TSX, every element accepts the classes themselves in `class`, resolved natively against Tailwind 4's default theme. Each example below shows the typed methods first and the classes second:

```rust tabs
use nsh_core::element::palette::ZINC;

view()
    .flex_row()
    .items_center()
    .gap_3()
    .rounded_2xl()
    .bg(AdaptiveColor::new(white(), ZINC.shade(800)))
    .p_4()
    .shadow_lg()
    .active(|s| s.scale(0.98))
    .child(
        text("Tailwind on native views")
            .text_base()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(AdaptiveColor::new(ZINC.shade(900), white())),
    )
```

```tsx tabs
<View class="flex-row items-center gap-3 rounded-2xl bg-white p-4 shadow-lg active:scale-[0.98] dark:bg-zinc-800">
  <Text class="text-base font-semibold text-zinc-900 dark:text-white">Tailwind on native views</Text>
</View>
```

Typed methods lower into the same style rules the classes compile to, with no string to parse. For classes, no CSS is generated and nothing runs in JavaScript: the string is passed to the core, which parses each distinct class string once (and caches it), turns it into style rules, and applies them. Variants that depend on state (pressed, dark mode, window width) are re-applied by the core when that state changes, and pressed and focused states are tracked natively, so `active:` feedback (`.active(..)` in Rust) has no round trip to your code.

Classes and the [`style` prop](./styling.md) produce the same native styles and can be combined; this page covers what is specific to classes and their typed equivalents. The [Tailwind reference](../modules/tailwind-reference.md) lists every supported utility.

## class and classList

```rust tabs
view()
    .rounded_lg()
    .px_4()
    .py_2()
    .transition_colors()
    .bg(move || if selected.get() { INDIGO.shade(600) } else { ZINC.shade(200) })
    .style_when(busy, |s| s.opacity(0.5))
```

```tsx tabs
<View
  class="rounded-lg px-4 py-2 transition-colors"
  classList={{ "bg-indigo-600": selected(), "bg-zinc-200": !selected(), "opacity-50": busy() }}
/>
```

- **`class`** is a string of classes. It can be dynamic: ``class={`h-6 rounded bg-${color()}-500`}`` works, because classes are resolved at run time.
- **`classList`** maps classes to conditions: a class applies while its value is truthy. It is applied after `class`.
- **In Rust**, a method given a closure or a signal follows it (`.bg(move || ..)`), `.style_when(condition, |s| ..)` applies styles while a condition holds, and `.when(condition, |v| ..)` decides once, when the element is made.

How conflicts resolve:

1. **Later classes win** over earlier ones in the same string: `"p-2 p-4"` is `p-4`. There is no need for `tailwind-merge`: a component can append the `class` its caller passes. Later methods win in Rust too.
2. **Variant classes apply after plain ones**, ordered by Tailwind's variant order (`hover:` before `active:`, `max-*:` widest first, breakpoints ascending, `dark:` last), whatever their position in the string. As in Tailwind, a class's highest variant decides, then its next highest, and a class with one more variant comes later: `dark:hover:bg-a dark:bg-b` is `bg-a` while hovered in dark mode, and `max-md:p-2 max-lg:p-4` is `p-2` below `md`. As in CSS, `odd:bg-a last:bg-b` gives an odd last row `bg-a`, because Tailwind sorts `odd` after `last`.
3. **`style` wins over classes.** A style key is the CSS property of its name, the one the classes set, so it replaces only that property: `style={{ paddingLeft: 8 }}` replaces `pl-4` and keeps `pr-4`.
4. `!` makes a class important: `!p-0`.

Rust components (`nsh/base`'s and those of an app's own crate) accept `class` and `classList` from TSX too; your classes are merged after the component's own styles and win at equal rank.

## Variants

| Variant | Applies when | Rust |
|---|---|---|
| `active:` | The view is pressed | `.active(\|s\| ..)` |
| `hover:` | A pointer is over the view (iPad and Mac pointers) | `.hover(\|s\| ..)` |
| `focus:`, `focus-visible:` | An input has focus | `.focus(\|s\| ..)` |
| `focus-within:` | The view or a descendant has focus | |
| `disabled:`, `enabled:` | The element's `disabled` prop is true / false | `.disabled_style(\|s\| ..)` |
| `selected:` | The element is selected (a `Button`'s `selected`, `accessibilityState.selected`) | `.selected_style(..)` |
| `checked:` | The element is checked (`accessibilityState.checked` is `true`; `"mixed"` is not checked) | `.checked_style(..)` |
| `indeterminate:` | The element is indeterminate (`accessibilityState.checked` is `"mixed"`) | `.indeterminate_style(..)` |
| `aria-expanded:` | The element is expanded (`accessibilityState.expanded` is `true`): a `Popover`'s or `Menu`'s trigger while its popup is open | `.expanded_style(..)` |
| `aria-pressed:` | The element is a toggle button that is on (`accessibilityState.pressed` is `true`; `"mixed"` is not pressed). Not `active:`, a press in progress | `.aria_pressed(..)`, `.pressed_style(..)` |
| `aria-busy:`, `aria-checked:`, `aria-selected:` | `accessibilityState.busy`, `checked` (`true`, not `"mixed"`) or `selected` is `true`, as Tailwind's `aria-*` variants: after the pseudo-classes, in the order of their names | |
| `group-active:`, `group-hover:`, `group-focus:`, `group-focus-within:`, `group-disabled:`, `group-selected:`, `group-checked:`, `group-indeterminate:`, `group-aria-expanded:`, `group-aria-pressed:`, `group-aria-busy:`, `group-aria-checked:`, `group-aria-selected:` | The nearest ancestor with the `group` class is in that state | `.group()` on the ancestor; `.group_active(..)`, `.group_hover(..)`, `.group_focus_within(..)` inside |
| `group-active/name:` ... | The same, for an ancestor marked `group/name` | `.group_named("name")`; `.group_active_named("name", ..)`, ... |
| `first:`, `last:`, `odd:`, `even:`, `only:` | The element's own position among its siblings. To color a row's label by the row's position, put `last:text-*` on the row: the label inherits it | Plain Rust from the row's index (`at.is_first()`, `at.is_last()`, `at.index() % 2`) |
| `placeholder:` | Styles an input's placeholder (`placeholder:text-zinc-400`) | `.placeholder_color(..)` |
| `selection:` | Colors the selection highlight of an input or a selectable text, and of those inside the element (`selection:bg-violet-200`) | `.selection_color(..)` |
| `dark:` | The system appearance is dark | An `AdaptiveColor`, or `.dark(\|s\| ..)` |
| `sm:`, `md:`, `lg:`, `xl:`, `2xl:` | The window is at least 640, 768, 1024, 1280, 1536 points wide | `.style_when(\|\| window().width >= px(768.0), \|s\| ..)` |
| `max-sm:`, `max-md:`, ... | The window is narrower than the breakpoint | The same, with `<` |
| `min-[600px]:`, `max-[600px]:` | Arbitrary breakpoints | The same |
| `portrait:`, `landscape:` | The window's orientation | `window().width > window().height` |
| `ios:`, `android:`, `web:` | The platform | `.when(os() == Os::Ios, \|v\| ..)` |
| `rtl:`, `ltr:` | The [layout direction](./layout.md#right-to-left) | `.direction(LayoutDirection::..)` on a view |
| `motion-safe:`, `motion-reduce:` | The user's reduce motion setting | `reduce_motion()` |

Variants combine: `dark:active:bg-zinc-700`, `md:landscape:flex-row`. In Rust, an `AdaptiveColor` in an `.active(..)` style is `dark:active:`.

```rust tabs
view()
    .group()
    .flex_row()
    .items_center()
    .gap_3()
    .rounded_xl()
    .bg(white())
    .p_3()
    .active(|s| s.bg(ZINC.shade(50)))
    .child(text("Settings").flex_1().text_color(ZINC.shade(900)))
    .child(
        text("›")
            .text_color(ZINC.shade(300))
            .transition_transform()
            .group_active(|s| s.translate_x(px(4.0))),
    )
```

```tsx tabs
<View class="group flex-row items-center gap-3 rounded-xl bg-white p-3 active:bg-zinc-50">
  <Text class="flex-1 text-zinc-900">Settings</Text>
  <Text class="text-zinc-300 transition-transform group-active:translate-x-1">›</Text>
</View>
```

`disabled` on any element (`.disabled(..)` in Rust) applies `disabled:` classes (`.disabled_style(..)`) and removes its press handlers from what is mounted, so it shows no press feedback either:

```rust tabs
view()
    .disabled(saving)
    .on_press(save)
    .rounded_lg()
    .bg(EMERALD.shade(500))
    .px_4()
    .py_2()
    .active(|s| s.bg(EMERALD.shade(600)))
    .disabled_style(|s| s.opacity(0.4))
    .child(text("Save").font_weight(FontWeight::MEDIUM).text_color(white()))
```

```tsx tabs
<View disabled={saving()} onPress={save} class="rounded-lg bg-emerald-500 px-4 py-2 active:bg-emerald-600 disabled:opacity-40">
  <Text class="font-medium text-white">Save</Text>
</View>
```

Breakpoints compare against the window (the surface NSH renders into), not the device: in an iPad split view or a resizable window, they follow the window's width, as `window()` does.

## What differs from Tailwind on the web

- **Units are points.** `p-4` (`.p_4()`) is 16 points (1 spacing step = 4pt, 1rem = 16pt). Arbitrary values in `px` are points too: `p-[13px]` (`.p(px(13.0))`) is 13pt.
- **`flex` is a row**, as in CSS: `class="flex"` lays out its children in a row unless a direction class says otherwise (anywhere in the string: `flex-col flex` is a column). A style's `display: "flex"` and Rust's `.flex()` are rows the same way, and a view that sets no display keeps NSH's default column. `block` and `flow-root` use block layout, and so do `inline` and `inline-block`, as a browser lays them out in a flex or grid parent. In Rust, `.flex_row()` and `.flex_col()` set the direction.
- **Text classes on views are inherited.** `text-*`, `font-*`, `leading-*`, `tracking-*` and the other text utilities on a view (`.text_color(..)`, `.font_weight(..)`, ... in Rust) pass to the text and input elements inside it, as CSS inheritance does: `<View class="text-white">` makes its labels white.
- **Every view is a box of its own.** `overflow-x-hidden` and `overflow-y-hidden` clip both axes, as `overflow-hidden` does (scrolling is the [scroll](../elements/scroll.md) element's); `invisible` hides the view and everything in it; `mix-blend-*` blends a view with everything drawn behind it; `block` boxes keep their own margins and their children's apart; an `absolute` view is placed in its nearest positioned ancestor, as in CSS; `fixed` lays a view out in its root view (other elements are placed as `absolute`).
- **Text keeps its whitespace.** Spaces and line breaks in a string are drawn as written, and `whitespace-*` sets the wrapping; the JSX compiler collapses the whitespace of literal JSX text, as JSX does.
- **Transitions animate property groups**: `transition` animates colors, opacity, shadows and transforms, `transition-all` also corner radii and border widths; filters, backdrop filters, gradients and layout take their new values at once.
- **`focus-visible:` is `focus:`**: it applies whenever the element has focus.
- **State backgrounds show over gradients.** In CSS a gradient covers `background-color`, so `active:bg-*` on a `bg-linear-*` surface would never be seen; in NSH a background color from `active:`, `hover:`, `focus:` or `group-*:` replaces the gradient while that state holds (unless the state sets a gradient of its own, such as `active:from-*`). So do `activeStyle` and the other state styles, and animated background colors.
- **Text and touch settings are style keys**: `line-clamp-*` sets `numberOfLines`, `text-ellipsis` and `text-clip` set `textOverflow`, `truncate` both, `select-*` sets `userSelect` and `pointer-events-*` sets `pointerEvents`, so they work in state variants and lose to the inline `style` as every class does; `caret-*`, `placeholder:text-*` and `selection:bg-*` set the `caretColor`, `placeholderColor` and `selectionColor` styles the same way. In Rust these are `Styled` methods (`.number_of_lines(..)`, `.truncate()`, `.text_overflow(..)`, `.select_text()`, `.pointer_events(..)`, ...). `whitespace-nowrap` keeps a text on one line as a class. `object-*` set the `objectFit` and `objectPosition` styles of images and videos, which a style's keys replace as any other.
- **The supported set**: utilities and variants of Tailwind 4 that have a native meaning. `peer-*` variants, pseudo-elements (`before:`, `after:`) and arbitrary properties (`[mask-type:luminance]`) are reported as unknown classes, and so is every utility NSH has no native meaning for, so a class never means something else than in a browser. Rendering hints (`antialiased`, `will-change-transform`, `appearance-none`, `box-border`, ...) are accepted and change nothing.

Everything else works as documented by Tailwind 4: the color palette, opacity modifiers (`bg-black/40`), arbitrary values (`bg-[#34c759]`, `w-[72px]`, `grid-cols-[1fr_2fr]`; on `p`, `px`, `py`, `pt`, `pr`, `pb`, `pl` and the `m` utilities also the environment variables, `pt-[env(safe-area-inset-top)]`, `pb-[calc(env(keyboard-inset-height)+49px)]`, see [Safe area](../elements/safe-area.md) and [Keyboard](../elements/keyboard.md)), fractions (`w-1/2`, `translate-x-1/2`), shadows and rings, gradients (`bg-linear-to-r`, `bg-radial`, `bg-conic` with `from-` / `via-` / `to-`), filters, `backdrop-blur-*`, `mix-blend-*`, transforms, `transition-*` and `duration-*`, `animate-spin` / `ping` / `pulse` / `bounce`, and grid, each with its typed method in Rust. The platform limits of [filters and blending](./styling.md#filters-and-blending) apply to classes too.

## Theme

Classes resolve against Tailwind 4's default theme. Extend it in `nsh.json` under `"tailwind"`; your entries are added to the defaults (or replace the default of the same name):

```json
{
  "tailwind": {
    "colors": {
      "brand": { "50": "#f5f3ff", "500": "#7c3aed", "600": "#6d28d9", "DEFAULT": "#7c3aed" },
      "ink": "#1f2328"
    },
    "radius": { "card": 14 },
    "fontFamily": { "display": "Pacifico" },
    "breakpoints": { "tablet": 600 }
  }
}
```

With this theme, `bg-brand-500`, `text-brand` (the `DEFAULT` shade), `border-ink`, `rounded-card`, `font-display` and `tablet:flex-row` are valid classes.

| Key | Values | Makes |
|---|---|---|
| `colors` | A CSS color, or an object of shades (`"DEFAULT"` for the bare name) | `bg-*`, `text-*`, `border-*`, `from-*`, `ring-*`, ... |
| `spacing` | Points per spacing step (default 4) | `p-*`, `m-*`, `gap-*`, `w-*`, ... |
| `rem` | Points per `rem` in arbitrary values (default 16) | |
| `breakpoints` | Points | `name:` variants |
| `container` | Points | `max-w-*` sizes |
| `fontSize` | Points, or `[size, lineHeight]` with the line height a multiple of the size | `text-*` |
| `fontWeight` | 1–1000 | `font-*` |
| `fontFamily` | A family name (a system family or an [imported font's](./fonts.md) name) | `font-*` |
| `tracking` | Ems | `tracking-*` |
| `leading` | Multiples of the font size | `leading-*` |
| `radius` | Points | `rounded-*` |
| `shadow`, `insetShadow`, `dropShadow` | A CSS `box-shadow` | `shadow-*`, `inset-shadow-*`, `drop-shadow-*` |
| `blur` | Points | `blur-*`, `backdrop-blur-*` |
| `perspective` | Points | `perspective-*` |
| `aspect` | A ratio (`1.5`) | `aspect-*` |
| `ease` | `[x1, y1, x2, y2]` | `ease-*` |

Unknown keys and invalid values are build errors (`nsh.json: tailwind: unknown theme key 'colours'`). The theme is compiled into the bundle and applied before the first frame.

The Tailwind theme shapes your classes. Typed methods keep Tailwind's default scales, so a Rust component looks the same in every app, and take the app's look from the design tokens of its theme, `"theme"` in `nsh.json` ([Rust](./rust.md#theme)).

## Theme tokens

The app's theme (`"theme"` in `nsh.json`) holds its design tokens: shadcn/ui's colors (`background`, `foreground`, `primary`, `muted-foreground`, `border`, `ring`, `chart-1`, `sidebar`, ...), its `radius`, its fonts `font-sans` and `font-mono`, and any token the app adds. Classes name them as Tailwind names the variables of a CSS `@theme`, Rust components read them with `theme()` from `nsh_base`, and TSX reads them with `token()` from `nsh`, so a TSX screen and the Rust components follow the same theme:

```rust tabs
use nsh_base::theme;

view()
    .rounded(move || theme().radius)
    .border_1()
    .border_color(move || theme().border)
    .bg(move || theme().card)
    .p_4()
    .child(text("Balance").text_color(move || theme().card_foreground))
    .child(text("Updated just now").text_color(move || theme().muted_foreground))
    .child(
        view()
            .rounded(move || theme().radius)
            .bg(move || theme().primary)
            .px_4()
            .py_2()
            .active(|s| s.bg(move || theme().primary.opacity(0.9)))
            .child(text("Continue").text_color(move || theme().primary_foreground)),
    )
```

```tsx tabs
<View class="rounded-(--radius) border border-border bg-card p-4">
  <Text class="text-card-foreground">Balance</Text>
  <Text class="text-muted-foreground">Updated just now</Text>
  <View class="rounded-(--radius) bg-primary px-4 py-2 active:bg-primary/90">
    <Text class="text-primary-foreground">Continue</Text>
  </View>
</View>
```

A token's name is its CSS variable's without `--`, as the theme file writes it: `muted-foreground`, `radius`, `chart-1`. In Rust, shadcn's tokens are methods of `theme()` (`primary()`, `muted_foreground()`, `radius()`, `font_mono()`), and every token is `theme().color("up")`, `theme().number("radius-card")` or `theme().font("font-display")`.

| Form | Takes | Example |
|---|---|---|
| A color name in any color utility | A theme color, with an opacity too | `bg-primary`, `text-muted-foreground/70`, `bg-up/30`, `border-t-border`, `ring-ring`, `from-accent`, `placeholder:text-muted-foreground` |
| `(--name)`, Tailwind 4's variable shorthand | A theme color or number | `bg-(--primary)`, `rounded-(--radius)`, `p-(--gap-card)` |
| `(color:--name)`, `(length:--name)`, `(number:--name)`, `(family-name:--name)` | The same, typed where a utility takes several kinds | `text-(color:--up)`, `text-(length:--text-title)`, `font-(family-name:--font-mono)` |
| `font-sans`, `font-mono` | The theme's fonts, when it sets them | `font-mono` |

- **Your own tokens.** Every name in the theme file is a token, as every variable of a CSS `@theme` is: `"up": "#16a34a"` makes `bg-up`, `text-up` and `bg-up/30`; `"radius-card": "14px"` makes `rounded-(--radius-card)`; `"font-display": "Pacifico"` makes `font-(family-name:--font-display)`. Lengths are in points; `(number:--name)` passes the plain number.
- **Fonts.** `font-sans` is the app's font: every text that sets no family of its own is drawn with it, as a page is with Tailwind's `--font-sans`. `font-mono` is the font of `font-mono` and of code in `TextView`. Unset, both are the system's fonts.
- **Both appearances.** A token has the light and the dark value of the theme: `bg-primary`, `theme().primary` and `token("primary")` switch with the appearance by themselves, with no `dark:` class. A color the theme sets in one appearance only is used in both.
- **Your Tailwind colors win.** A name in `"tailwind"` `colors` or Tailwind's palette is that color, so `bg-primary` is a theme token when the Tailwind theme has no color `primary`.
- **The theme can change while the app runs.** When an app embedded in a native app is given that app's theme, and whenever the theme changes, the classes naming tokens, the Rust bindings reading `theme()` and the TSX code reading `token()` are updated, the classes and bindings natively. Tokens the embedding app's theme does not have keep the values of the app's own `"theme"` (then the default theme's). A host that only adds its brand gives theme overrides, the tokens its brand changes in the same file format ([iOS](./ios.md#theme-overrides), [Android](./android.md#theme-overrides), `AppView::set_theme_overrides` on the desktops).
- **Checked like other classes.** A name that is no token of the default theme or of the app's `"theme"` is an unknown class when building (`unknown class 'bg-chart-up'`). To use a token only the embedding app provides, give it a value in the app's `"theme"` too: that value shows when the app runs on its own.

Classes naming tokens are resolved once per theme, like any other class: drawing them costs what a palette color does.

### `token()` in TSX

`token(name)` from `nsh` is a token's value in the appearance shown: a color as `#rrggbbaa`, a length as a number of points, a font as its family name. It is reactive, so code that reads it in a component, a memo or an effect runs again when the theme or the appearance changes, which suits values that go where no class does, such as a canvas or a chart:

```tsx
import { Canvas, token } from "nsh";

<Canvas
  style={{ height: 160 }}
  draw={(cx, { width, height }) => {
    cx.beginPath();
    cx.moveTo(0, height);
    cx.lineTo(width, 0);
    cx.strokeStyle = token("chart-1");
    cx.lineWidth = 2;
    cx.stroke();
  }}
/>
```

The names are typed: NSH writes the app's tokens into `.nsh/types/nsh/tokens.d.ts` from its theme, so `token("up")` is a `string` once `"up"` is in the theme, and a name the theme lacks is a type error.

## The class check

`nsh build`, `nsh dev`, `nsh run` and `nsh test` check the static class names in your JSX (string literals in `class` and the keys of `classList`) with the same parser and theme the runtime uses, and warn about classes that do not exist:

```text
 warn nsh::build App.tsx:12:36: unknown class `bg-brand-550`
```

Warnings do not fail the build. Classes built at run time (``bg-${color()}-500``) are checked when the runtime first sees them, which logs each unknown class once (`unknown classes: ...`). Typed methods are checked by the Rust compiler.

## Classes or styles?

Both are resolved natively and cost about the same. Classes are shorter and give you variants (pressed states, dark mode, breakpoints) without code. Inline styles take values computed in JavaScript and accept [native animated values](./animation.md) (`opacity: fade`, `translate: [x, 0]`). Most TSX apps use classes for the static look and `style` for what is computed or animated. Rust components use typed methods for both, and bind animated values with `.bind_opacity(..)`, `.bind_translate_x(..)` and the other bindings.

## Related

- [Styling](./styling.md): the style prop, the typed methods and the platform limits of effects.
- [Tailwind reference](../modules/tailwind-reference.md): every utility and variant.
- [Layout](./layout.md): flexbox and grid, also available as classes.
