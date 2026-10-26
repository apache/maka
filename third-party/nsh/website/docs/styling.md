---
title: Styling
description: Typed style methods in Rust and the style prop in TSX - flexbox, grid and CSS effects - colors, borders, corners, shadows, gradients, filters, transforms and transitions, with platform differences.
order: 32
group: ui
demo: guide-styling
---

# Styling

Every element is styled with the same native styles, written two ways. In Rust, styles are typed methods chained on the element (`.p_4()`, `.rounded(px(12.0))`, `.bg(color)`); in TSX, a `style` prop of camelCase properties, or [Tailwind classes](./tailwind.md). Both include CSS features such as box shadows, gradients, filters, outlines, transitions and grid, and only the properties that changed are sent to the native view.

CSS values (colors, lengths, gradients, filters, shadows, transforms, alignment keywords) mean exactly what they mean in a browser, and each Rust method and Tailwind utility sets exactly what Tailwind CSS 4 generates for it, so what you know from the web carries over as is. Properties you leave out take the defaults listed below.

```rust tabs
view()
    .p_4()
    .rounded(px(12.0))
    .bg(white())
    .border_1()
    .border_color(rgb(0xd0d7de))
    .shadow([BoxShadow {
        offset_y: px(4.0),
        blur: px(12.0),
        color: rgba(0x0000001f).into(),
        ..BoxShadow::default()
    }])
    .child(
        text("Card")
            .text_size(px(17.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(0x1f2328)),
    )
```

```tsx tabs
<View
  style={{
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d0d7de",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  }}
>
  <Text style={{ fontSize: 17, fontWeight: "600", color: "#1f2328" }}>Card</Text>
</View>
```

This page covers how styles combine and the visual properties. Layout properties (flexbox, grid, sizes, positions) are on [Layout](./layout.md), text properties on [Text](./text.md), and every property with its type is listed in the [style reference](../modules/style-reference.md).

## Combining styles

In Rust, shared styles are functions that take an element and return it styled, and conditions are plain Rust: `.when(condition, |v| ..)` for what is known when the element is made, `.style_when(signal, |s| ..)` for styles that switch while the app runs. In TSX, `style` takes an object, or an array of objects merged left to right; falsy entries (`false`, `null`, `undefined`) are skipped, which makes conditional styles short:

```rust tabs
fn button(danger: bool, busy: Signal<bool>) -> View {
    view()
        .px_4()
        .py(px(10.0))
        .rounded(px(10.0))
        .bg(rgb(0x0969da))
        .when(danger, |v| v.bg(rgb(0xcf222e)))
        .style_when(busy, |s| s.opacity(0.4))
}
```

```tsx tabs
const styles = {
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: "#0969da" },
  disabled: { opacity: 0.4 },
  danger: { backgroundColor: "#cf222e" },
} as const;

<View style={[styles.button, props.danger && styles.danger, busy() && styles.disabled]} />
```

In TSX, define shared styles as constants outside components (with `as const`, so TypeScript keeps literal types such as `"row"`). A plain object is all it takes: styles are parsed in Rust each time they are set, from objects nobody needs to register.

A style that reads signals follows them: in Rust, give the method a closure (`.bg(move || ..)`), and only that property is set again when the signals change; in TSX, a style expression that reads signals is rebuilt, and NSH sends only the properties whose values differ:

```rust tabs
view()
    .p_3()
    .bg(move || if selected.get() { rgb(0xddf4ff) } else { rgb(0xffffff) })
```

```tsx tabs
<View style={{ backgroundColor: selected() ? "#ddf4ff" : "#ffffff", padding: 12 }} />
```

When a TSX element has both, `style` wins over `class`: classes are applied first, then the inline style on top. A key set to `undefined` sets nothing (`backgroundColor: active ? accent : undefined` keeps the class color when inactive); `null` sets the default. In Rust, a later method wins over an earlier one for the same property.

Within one style (an object, or an array merged into one), the order of the keys makes no difference. As in React Native, a more specific property wins over its shorthand: `borderTopWidth` over `borderWidth`, `borderLeftColor` over `borderColor`, `marginTop` over `marginVertical` over `margin` (padding alike), `rowGap` over `gap`, `flexGrow` over `flex`, `gridColumnStart` over `gridColumn`. A specific property set to `null` there shows the shorthand's value.

## Units and values

- **Lengths are points** (density-independent pixels): `px(100.0)` in Rust and `width: 100` in TSX are 100pt, which is 200 or 300 physical pixels on a 2× or 3× screen.
- **Percentages** (`relative(0.5)` in Rust, `"50%"` in TSX) are relative to the parent, for sizes, positions, margins and paddings ([Layout](./layout.md)).
- **Angles** are `deg(45.0)`, `radians(0.5)` or `turn(0.25)` in Rust, and degrees as numbers or strings with a unit in TSX: `45`, `"45deg"`, `"0.5rad"`.
- **Durations** are milliseconds: `.duration(150.0)` in Rust, numbers or strings (`"150ms"`, `"0.2s"`) in TSX.

## Defaults

NSH's defaults differ from the web's:

| | Default |
|---|---|
| `flexDirection` | `"column"` |
| `flexShrink` | `0` (children do not shrink unless asked) |
| `alignContent` | `"flex-start"` (in grids, CSS's `"normal"`) |
| `position` | `"relative"` |
| `minWidth` / `minHeight` | `0` |
| `backgroundColor` | transparent |
| Text | black, 14pt, weight 400 |
| `shadowOffset` / `shadowRadius` / `shadowOpacity` | `{ width: 0, height: -3 }` / `3` / `0` |

New views carry no style at all until you give them one, so unstyled wrappers cost nothing on the native side.

## Colors

In Rust, colors are typed values: `rgb(0x0099ff)`, `rgba(0x0099ffcc)`, `hsla(..)`, `white()`, `black()`, and Tailwind's palette as `nsh_core::element::palette` (`BLUE.shade(500)`). Color methods take an `AdaptiveColor`, a light and a dark value: `AdaptiveColor::rgb(0xffffff, 0x0d1117)` switches with the system appearance natively, with no render. Colors from the app's theme (`theme().primary` from `nsh_base`) are adaptive too ([Rust](./rust.md#theme)).

In TSX, color properties accept CSS color strings:

| Form | Example |
|---|---|
| Hex | `"#09f"`, `"#09fc"`, `"#0099ff"`, `"#0099ffcc"` |
| `rgb()` / `rgba()` | `"rgb(0, 153, 255)"`, `"rgba(0, 0, 0, 0.5)"`, `"rgb(0 0 0 / 10%)"` |
| `hsl()` / `hsla()` | `"hsl(210 100% 50%)"` |
| `oklch()` / `oklab()` | `"oklch(62.3% 0.214 259.8)"` |
| Named | `"white"`, `"black"`, `"transparent"`, `"rebeccapurple"`, ... |

For dark mode in TSX, read [`colorScheme()`](../modules/nsh.md#device) from `nsh`, an accessor that follows the system appearance, or use Tailwind's `dark:` variant:

```rust tabs
view()
    .flex_1()
    .bg(AdaptiveColor::rgb(0xffffff, 0x0d1117))
    .child(text("Follows the system appearance").text_color(AdaptiveColor::rgb(0x1f2328, 0xe6edf3)))
```

```tsx tabs
import { Text, View } from "nsh";
import { colorScheme } from "nsh";

const palette = () =>
  colorScheme() === "dark"
    ? { background: "#0d1117", text: "#e6edf3" }
    : { background: "#ffffff", text: "#1f2328" };

<View style={{ flex: 1, backgroundColor: palette().background }}>
  <Text style={{ color: palette().text }}>Follows the system appearance</Text>
</View>
```

For styles other than colors, `.dark(|s| ..)` in Rust applies styles in dark appearance, and `dark()` reads the appearance. The default text color is black in both appearances: set colors explicitly in apps that support dark mode.

## Borders and corners

```rust tabs
view()
    .border_1()
    .border_color(rgb(0xd0d7de))
    .border_dashed()               // .border_solid() | .border_dashed() | .border_dotted()
    .rounded(px(12.0))
    .rounded_tl(px(24.0))          // per corner, overrides .rounded(..)
    .border_b(px(3.0))             // per side
    .border_b_color(rgb(0x0969da))
```

```tsx tabs
<View
  style={{
    borderWidth: 1,
    borderColor: "#d0d7de",
    borderStyle: "dashed",          // "solid" | "dashed" | "dotted"
    borderRadius: 12,
    borderTopLeftRadius: 24,        // per corner, overrides borderRadius
    borderBottomWidth: 3,           // per side
    borderBottomColor: "#0969da",
  }}
/>
```

- **Widths and colors** per side: `borderTopWidth`, `borderRightWidth`, ..., `borderTopColor`, ...; and the direction-aware `borderStartWidth`, `borderEndWidth`, `borderStartColor`, `borderEndColor` (`.border_t(..)`, `.border_t_color(..)`, `.border_s(..)`, `.border_e_color(..)`, ... in Rust).
- **Radii** per corner: `borderTopLeftRadius`, `borderTopRightRadius`, `borderBottomRightRadius`, `borderBottomLeftRadius`, and `borderTopStartRadius` / `borderTopEndRadius` / `borderBottomStartRadius` / `borderBottomEndRadius`, which follow the [layout direction](./layout.md#right-to-left) (`.rounded_tl(..)`, ..., `.rounded_ss(..)`, `.rounded_se(..)`, `.rounded_es(..)`, `.rounded_ee(..)` in Rust, and the presets `.rounded_lg()`, `.rounded_full()`, ...).
- **`borderCurve: "continuous"`** (`.border_curve(BorderCurve::Continuous)`) draws corners whose curvature eases into the edges, like iOS app icons, on both platforms. A pill (`borderRadius` of half the height) stays a pill.
- **`overflow: "hidden"`** (`.overflow_hidden()`) clips children to the rounded shape. What it clips away is clipped in layout too: it does not reach an enclosing scroll view's content size, so a box that lays a child out wider than itself and scales it down with a `transform` (transforms do not affect layout) leaves the scroll view alone.

Radii larger than half the side are clamped, so `borderRadius: 9999` (`.rounded_full()`) makes a circle or a pill.

## Shadows

Three ways to cast a shadow:

```rust tabs
// The shadow* properties.
view()
    .shadow_color(black())
    .shadow_opacity(0.2)
    .shadow_radius(px(8.0))
    .shadow_offset(point(px(0.0), px(4.0)))

// CSS box-shadow: several layers, with spread and inset.
view().shadow([
    BoxShadow { offset_y: px(1.0), blur: px(2.0), color: rgba(0x00000014).into(), ..BoxShadow::default() },
    BoxShadow { offset_y: px(8.0), blur: px(24.0), color: rgba(0x0000001f).into(), ..BoxShadow::default() },
])
view().shadow([BoxShadow { offset_y: px(2.0), blur: px(4.0), color: rgba(0x00000026).into(), inset: true, ..BoxShadow::default() }])

// Android's material elevation.
view().elevation(px(6.0)).bg(white()).rounded(px(12.0))
```

```tsx tabs
// The shadow* properties
<View style={{ shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }} />

// CSS box-shadow: several, comma separated, with spread and inset
<View style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)" }} />
<View style={{ boxShadow: "inset 0 2px 4px rgba(0,0,0,0.15)" }} />

// Android's material elevation (a prop, not a style)
<View android={{ elevation: 6 }} style={{ backgroundColor: "#ffffff", borderRadius: 12 }} />
```

`boxShadow` follows CSS: `offsetX offsetY blur spread color`, `inset` for inner shadows. Shadows follow the view's rounded shape. Tailwind's presets are `.shadow_sm()`, `.shadow_md()`, `.shadow_lg()`, ... in Rust.

> [!NOTE]
> On Android, shadows need a background: a view with a transparent background (a text without one, for example) casts no shadow. `elevation` takes its color from `shadowColor`.

## Gradients

`backgroundImage` takes CSS gradients, drawn over the background color; in Rust, `.bg_linear(angle)`, `.bg_radial()` and `.bg_conic(angle)` with the stops `.gradient_from(..)`, `.gradient_via(..)` and `.gradient_to(..)`, as Tailwind's `bg-linear-*` with `from-*`, `via-*` and `to-*`. In TSX, several gradients are separated by commas.

```rust tabs
view().h(px(120.0)).rounded(px(16.0)).bg_linear(deg(135.0)).gradient_from(rgb(0x54aeff)).gradient_to(rgb(0x8250df))
view().bg_radial().gradient_from(rgb(0xfff8c5)).gradient_to(rgb(0xfd8c73))
view().bg_conic(deg(0.0)).gradient_from(rgb(0xff0000)).gradient_via(rgb(0x00ff00)).gradient_to(rgb(0x0000ff))
view()
    .bg_linear_to_r()
    .gradient_from(rgb(0x8250df))
    .gradient_from_position(percentage(0.3))
    .gradient_to(rgb(0x54aeff))
    .gradient_to_position(percentage(0.3))
```

```tsx tabs
<View style={{ height: 120, borderRadius: 16, backgroundImage: "linear-gradient(135deg, #54aeff, #8250df)" }} />
<View style={{ backgroundImage: "radial-gradient(circle at top left, #fff8c5, #fd8c73)" }} />
<View style={{ backgroundImage: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} />
<View style={{ backgroundImage: "linear-gradient(90deg, #8250df 0 12px, #54aeff 12px)" }} />
```

Color stops are placed by percentages or lengths (`px`, `pt`, `rem`; plain numbers are points) along a linear or radial gradient, and by percentages or angles (`deg`, `turn`, `rad`, `grad`) around a conic one. A stop with two positions (`#8250df 0 12px`) is a band of one color, as are two stops at the same position. Lengths are measured along the gradient line at the view's current size, so a 12px band stays 12px wide as the view resizes.

Colors mix between stops as in CSS: in the space a gradient names (`linear-gradient(in oklab, …)`; also `srgb`, `srgb-linear`, `xyz`, `oklch` with a hue method such as `longer hue`, and `hsl`), and otherwise in sRGB when every color is a hex, `rgb()`, `hsl()` or named color, and in Oklab when one is `oklch()`, `oklab()`, `lab()`, `lch()` or `color()`.

Text elements do not draw gradients on iOS.

## Filters and blending

| Property | Value | Rust |
|---|---|---|
| `filter` | CSS filters of the view and its content: `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `saturate()`, `sepia()`, `opacity()`, `blur()`, `drop-shadow()`; several separated by spaces | `.brightness(n)`, `.contrast(n)`, `.grayscale(n)`, `.hue_rotate(angle)`, `.invert(n)`, `.saturate(n)`, `.sepia(n)`, `.blur(px(..))` |
| `backdropFilter` | Filters of what is behind the view: `"blur(10px)"` (frosted glass) | `.backdrop_blur(px(10.0))`, `.backdrop_saturate(n)`, ... |
| `glassEffect` | `"regular"` or `"clear"` for Apple's Liquid Glass on iOS 26 and later; `"none"` (the default) uses `backdropFilter` | `ViewStyle::glass_effect` (`GlassEffect`) |
| `mixBlendMode` | How the view blends with what is behind it: `"multiply"`, `"screen"`, `"overlay"`, ... | `.mix_blend_mode(BlendMode::Multiply)` |

```rust tabs
image(photo).size(px(120.0)).grayscale(1.0).contrast(1.2)
view()
    .absolute()
    .bottom_0()
    .left_0()
    .right_0()
    .p_3()
    .bg(rgba(0xffffff66))
    .backdrop_blur(px(12.0))
```

```tsx tabs
<Image src={photo} style={{ width: 120, height: 120, filter: "grayscale(1) contrast(1.2)" }} />
<View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: "rgba(255,255,255,0.4)", backdropFilter: "blur(12px)" }} />
```

Platform support differs:

| | iOS | Android |
|---|---|---|
| `filter` on views | `opacity`, `brightness` up to 1 and `drop-shadow` only | All, from Android 12 (API 31); color filters only below |
| `filter` on images | Every color filter and `blur` | As views |
| `backdropFilter` | A system blur material, approximating the radius | From Android 12 (API 31) |
| `mixBlendMode` | Yes | From Android 10 (API 29) |

The web, Windows and Linux apply every filter to views, macOS as iOS does; GPUI draws the color filters and `drop-shadow()`. The backdrop filter is a blur on iOS, macOS and Android, every filter on the web and Windows; Linux and GPUI draw none, and GPUI draws views in the normal blend mode. Of a `filter` with several `drop-shadow()`s, iOS, macOS and Android draw the last. `mixBlendMode` blends the view with everything drawn behind it.

On iOS, `ios={{ backdropMaterial: "regular" }}` selects the system material used by a
`backdropFilter` blur. Values are `"ultraThin"` (the default), `"thin"`, `"regular"`, `"thick"`,
and `"chrome"`. Pair the prop with a positive blur radius to show the material. Rust uses
`.backdrop_material(BackdropMaterial::Regular)` alongside `.backdrop_blur(px(30.0))`.
The radius approximates material strength: NSH applies a fraction of the chosen material,
reaching full strength at 30 points. The light or dark variant follows the view's background color.
These choices map to Apple's [system blur materials](https://developer.apple.com/documentation/uikit/uiblureffect/style/systemmaterial).

```rust tabs
view().backdrop_blur(px(30.0)).backdrop_material(BackdropMaterial::Regular)
```

```tsx tabs
<View ios={{ backdropMaterial: "regular" }} style={{ height: 64, backdropFilter: "blur(30px)" }} />
```

`glassEffect` draws Liquid Glass behind a view's content on iOS 26 and later. `"regular"` uses the standard material;
`"clear"` takes less color from the background. Pair it with `backdropFilter` for the blur shown on earlier iOS
versions and other platforms. The glass follows the view's size and rounded corners.

```tsx
<View style={{ height: 80, borderRadius: 16, backdropFilter: "blur(12px)", glassEffect: "regular" }} />
```

## Outlines, opacity and visibility

- `outlineWidth`, `outlineColor`, `outlineStyle`, `outlineOffset` (`.outline(..)`, `.outline_color(..)`, `.outline_dashed()`, `.outline_offset(..)`): a line outside the border that takes no space (negative offsets draw inside). `outlineStyle: "none"` (or `"hidden"`, `.outline_none()`) hides the outline whatever its width, as in CSS.
- `opacity` (`.opacity(n)`): 0 to 1, applied to the view and its children.
- `visibility: "hidden"`: the view is not drawn but keeps its space, and screen readers skip it and its subtree, as in a browser. `display: "none"` (`.hidden()`) removes it from layout.
- `zIndex` (`.z_index(n)`): the order among siblings, also the native stacking order (stable for equal values).
- `cursor` (`.cursor(..)`, `.cursor_pointer()`): the pointer shape over the view, for pointers and desktops.

## Transforms

In Rust, transforms are methods (`.translate_x(..)`, `.rotate(..)`, `.scale(..)`, ...) applied in Tailwind's order; in TSX, `transform` is a list of steps applied right to left, like CSS:

```rust tabs
view().translate_x(px(20.0)).rotate(deg(-8.0)).scale(0.9)
view().perspective(px(600.0)).child(view().rotate_y(deg(35.0)).backface_hidden())
view().origin_top_left().rotate(deg(30.0))
```

```tsx tabs
<View style={{ transform: [{ translateX: 20 }, { rotate: "-8deg" }, { scale: 0.9 }] }} />
<View style={{ transform: [{ perspective: 600 }, { rotateY: "35deg" }], backfaceVisibility: "hidden" }} />
<View style={{ transformOrigin: "top left", transform: [{ rotate: "30deg" }] }} />
```

Steps: `translateX`, `translateY`, `scale`, `scaleX`, `scaleY`, `rotate` (`rotateZ`), `rotateX`, `rotateY`, `skewX`, `skewY`, `perspective`. Rust's `.perspective(..)` is CSS's `perspective` property, as Tailwind's `perspective-*`: it gives the view's children their depth. `transformOrigin` takes keywords, percentages and lengths (`"top left"`, `"50% 0"`, `[10, 20]`; `.origin_top_left()`, `.transform_origin(..)` in Rust); the default is the center. Transforms do not affect layout: siblings are placed as if the view were untransformed.

Android has no skew transforms.

## Transitions

A view animates changes of its own style when you name what to animate. The animation runs natively; none of your code runs per frame.

```rust tabs
let open = signal(false);

view()
    .on_press(move || open.update(|o| *o = !*o))
    .w(px(150.0))
    .h(px(72.0))
    .rounded(move || px(if open.get() { 36.0 } else { 12.0 }))
    .bg(move || if open.get() { rgb(0x8250df) } else { rgb(0x54aeff) })
    .translate_x(move || px(if open.get() { 120.0 } else { 0.0 }))
    .transition_all()
    .duration(300.0)
    .ease_in_out()
```

```tsx tabs
<View
  onPress={() => open.set(!open())}
  style={{
    width: 150,
    height: 72,
    borderRadius: open() ? 36 : 12,
    backgroundColor: open() ? "#8250df" : "#54aeff",
    transform: [{ translateX: open() ? 120 : 0 }],
    transitionProperty: "all",
    transitionDuration: 300,
    transitionTimingFunction: "ease-in-out",
  }}
/>
```

| Property | Value | Rust |
|---|---|---|
| `transitionProperty` | What animates: `"all"`, or names separated by commas: colors (`"colors"`, `"backgroundColor"`, `"borderColor"`, ...), `"opacity"`, `"transform"`, `"boxShadow"`, `"borderRadius"` / `"borderWidth"` | `.transition()`, `.transition_all()`, `.transition_colors()`, `.transition_opacity()`, `.transition_transform()`, `.transition_shadow()` |
| `transitionDuration` | `300`, `"300ms"`, `"0.3s"` | `.duration(300.0)` |
| `transitionDelay` | As the duration | `.delay(100.0)` |
| `transitionTimingFunction` | `"linear"`, `"ease"`, `"ease-in"`, `"ease-out"`, `"ease-in-out"`, `"cubic-bezier(x1, y1, x2, y2)"` | `.ease_linear()`, `.ease_in()`, `.ease_out()`, `.ease_in_out()`, `.ease_bezier(x1, y1, x2, y2)` |

Sizes and positions are layout, not style, and do not transition; animate layout changes with `LayoutAnimation` or drive values with native animations ([Animation](./animation.md)).

### Keyframe animations

`animationName` runs one of Tailwind's built-in keyframe animations natively: `"spin"`, `"ping"`, `"pulse"` or `"bounce"`, with `animationDuration`, `animationDelay`, `animationTimingFunction` and `animationIterationCount` (a number or `"infinite"`), in any order. In Rust, `.animate_spin()`, `.animate_ping()`, `.animate_pulse()` and `.animate_bounce()` run them with Tailwind's timing, and `.animation(KeyframeAnimation::new(..))` with your own:

```rust tabs
view()
    .size(px(24.0))
    .rounded(px(4.0))
    .bg(rgb(0x0969da))
    .animation(KeyframeAnimation::new(Keyframes::Spin).duration(1000.0).easing([0.0, 0.0, 1.0, 1.0]))
```

```tsx tabs
<View style={{ width: 24, height: 24, borderRadius: 4, backgroundColor: "#0969da", animationName: "spin", animationDuration: 1000, animationIterationCount: "infinite", animationTimingFunction: "linear" }} />
```

## Press feedback

Press feedback is the app's styles for the pressed state, applied natively without a round trip to your code; the hovered, focused and disabled states take styles the same way (`.hover(..)`, `.focus(..)`, `.disabled_style(..)` in Rust; `hoverStyle`, `focusStyle` and `disabledStyle`, or `hover:`, `focus:`, `disabled:`, in TSX):

| Rust | TSX | Effect while pressed |
|---|---|---|
| `.active(\|s\| s.opacity(0.6))` | `activeStyle={{ opacity: 0.6 }}` | The view fades to this opacity |
| `.active(\|s\| s.bg(rgb(0xeaeef2)))` | `activeStyle={{ backgroundColor: "#eaeef2" }}` | The background becomes this color |
| `.ripple(Ripple { color: Some(rgba(0x00000022).into()), ..Ripple::default() })` | `android={{ ripple: { color: "#0002" } }}` | Android's material ripple |
| `.active(\|s\| s.bg(ZINC.shade(100)).scale(0.95))` | `class="active:bg-zinc-100 active:scale-95"` | Any style |

See [Touch and gestures](./touch-and-gestures.md).

## Related

- [Tailwind](./tailwind.md): the same styles as classes, with variants for dark mode, pressed states and breakpoints, and their typed equivalents.
- [Layout](./layout.md) and [Text](./text.md).
- [Style reference](../modules/style-reference.md): every style property and its type.
