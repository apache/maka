use super::*;
use crate::{
    effects::{BlendMode, Cursor, Filter, GradientKind, Keyframes},
    geometry::{DefiniteLength, deg, px},
    style::{Color, FontFamily, Style},
    transform::TransformKind,
};

/// The Tailwind theme with the design tokens apps have.
fn themed() -> Theme {
    let mut theme = Theme::default();
    theme.set_tokens(&ui_theme());
    theme
}

fn ui_theme() -> crate::ui::Tokens {
    crate::ui::tokens::sample()
}

fn cx(states: u8) -> (ClassEnvironment, u8) {
    (ClassEnvironment::default(), states)
}

/// Applies `classes` with the given environment and states.
fn styled_with(
    classes: &str,
    env: ClassEnvironment,
    window: (f32, f32),
    states: u8,
) -> (Style, ClassProps) {
    let theme = themed();
    let list = parse(&theme, classes);
    assert!(
        list.unknown().is_empty(),
        "unknown classes: {:?}",
        list.unknown()
    );
    let mut style = Style::default();
    let mut props = ClassProps::default();
    let group = |_: &str| 0;
    let context = Context {
        env,
        window: crate::geometry::size_pt(window.0, window.1),
        rtl: false,
        states,
        position: 0,
        group: &group,
    };
    list.apply(&context, &theme, &mut style, &mut props, |_| {});
    (style, props)
}

fn styled(classes: &str) -> Style {
    let (env, states) = cx(0);
    styled_with(classes, env, (390.0, 844.0), states).0
}

#[test]
fn spacing_and_layout() {
    let s = styled(
        "flex flex-row items-center justify-between gap-3 p-4 px-2 -mt-1 w-1/2 h-12 min-w-0",
    );
    assert_eq!(s.layout.flex_direction, taffy::FlexDirection::Row);
    assert_eq!(s.layout.align_items, taffy::AlignItems::CENTER);
    assert_eq!(s.layout.justify_content, taffy::AlignContent::SPACE_BETWEEN);
    assert_eq!(s.layout.gap.width, taffy::LengthPercentage::length(12.0));
    assert_eq!(s.layout.padding.left, taffy::LengthPercentage::length(8.0));
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(16.0));
    assert_eq!(
        s.layout.margin.top,
        taffy::LengthPercentageAuto::length(-4.0)
    );
    assert_eq!(s.layout.size.width, taffy::Dimension::percent(0.5));
    assert_eq!(s.layout.size.height, taffy::Dimension::length(48.0));
    let s = styled("flex-[2]");
    assert_eq!(s.layout.flex_grow, 2.0);
    let s = styled("flex-[3_0_50%]");
    assert_eq!((s.layout.flex_grow, s.layout.flex_shrink), (3.0, 0.0));
    assert_eq!(s.layout.flex_basis, taffy::Dimension::percent(0.5));
    let s = styled("p-[13px] m-auto inset-0 absolute size-10 basis-1/3 flex-1");
    assert_eq!(s.layout.padding.left, taffy::LengthPercentage::length(13.0));
    assert_eq!(s.layout.margin.left, taffy::LengthPercentageAuto::auto());
    assert_eq!(s.layout.position, taffy::Position::Absolute);
    assert_eq!(
        s.layout.inset.right,
        taffy::LengthPercentageAuto::length(0.0)
    );
    assert_eq!(s.layout.size.height, taffy::Dimension::length(40.0));
    assert_eq!(s.layout.flex_grow, 1.0);
}

#[test]
fn physical_classes_name_the_other_side_right_to_left() {
    // The core lays left and right out as start and end right to left
    // (React Native's rule for inline styles); classes are physical, so
    // right to left they set the other side, and come out where they say.
    let theme = themed();
    let resolve = |classes: &str, rtl: bool| {
        let list = parse(&theme, classes);
        assert_ne!(list.deps() & deps::RTL, 0, "{classes}");
        let group = |_: &str| 0;
        let cx = Context {
            env: ClassEnvironment::default(),
            window: crate::geometry::size_pt(390.0, 844.0),
            rtl,
            states: 0,
            position: 0,
            group: &group,
        };
        let mut style = Style::default();
        list.apply(&cx, &theme, &mut style, &mut ClassProps::default(), |_| {});
        style
    };
    let s = resolve("pl-4 mr-2 left-1", true);
    assert_eq!(
        s.layout.padding.right,
        taffy::LengthPercentage::length(16.0)
    );
    assert_eq!(
        s.layout.margin.left,
        taffy::LengthPercentageAuto::length(8.0)
    );
    assert_eq!(
        s.layout.inset.right,
        taffy::LengthPercentageAuto::length(4.0)
    );
    let s = resolve("pl-4", false);
    assert_eq!(s.layout.padding.left, taffy::LengthPercentage::length(16.0));
    let s = resolve("text-left", true);
    assert_eq!(s.text.text_align, Some(crate::style::TextAlign::Left));
    assert!(s.text.text_align_physical);
    // Logical classes need nothing: the core places them.
    let list = parse(
        &theme,
        "ps-4 me-2 start-1 rounded-s-lg border-e-2 text-end text-center px-2",
    );
    assert_eq!(list.deps() & deps::RTL, 0);
}

#[test]
fn space_gives_the_children_margins() {
    // `space-x-4` is `:where(& > :not(:last-child)) { margin-inline-end }`:
    // the view's children get it, not the view (no gap).
    let (s, props) = styled_with(
        "gap-2 space-x-4 -space-y-px",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(s.layout.gap.width, taffy::LengthPercentage::length(8.0));
    assert_eq!(s.layout.gap.height, taffy::LengthPercentage::length(8.0));
    assert_eq!(
        s.layout.margin.right,
        taffy::LengthPercentageAuto::length(0.0)
    );
    let space = props.space.unwrap();
    assert_eq!(space.x, Some(crate::style::PatchValue::Number(16.0)));
    assert_eq!(space.y, Some(crate::style::PatchValue::Number(-1.0)));
    assert!(!space.reverse_x);
    let (_, props) = styled_with(
        "space-y-reverse space-y-2",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    let space = props.space.unwrap();
    assert!(space.reverse_y);
    let mut child = Style::default();
    space.apply(&mut child, false);
    assert_eq!(
        child.layout.margin.top,
        taffy::LengthPercentageAuto::length(8.0)
    );
    assert_eq!(
        child.layout.margin.bottom,
        taffy::LengthPercentageAuto::length(0.0)
    );
}

#[test]
fn widths_without_a_color_are_current_color() {
    let theme = themed();
    let resolve = |classes: &str, current: CurrentColor| {
        let list = parse(&theme, classes);
        let group = |_: &str| 0;
        let cx = Context {
            env: ClassEnvironment::default(),
            window: crate::geometry::size_pt(390.0, 844.0),
            rtl: false,
            states: 0,
            position: 0,
            group: &group,
        };
        let mut style = Style::default();
        list.apply_with(
            &cx,
            &theme,
            current,
            DEFAULT_CH,
            &mut style,
            &mut ClassProps::default(),
            |_| {},
        );
        style
    };
    let white = Color(0xffff_ffff);
    let inherited = CurrentColor {
        inherited: Some(white),
        inline: None,
    };
    // Preflight's `border: 0 solid` is `currentColor`; so are a ring's and
    // an outline's: the inherited text color...
    let s = resolve("border-2 outline ring", inherited);
    assert_eq!(s.view.borders.colors, [white; 4]);
    assert_eq!(s.view.outline.color, white);
    let e = s.view.effects.unwrap();
    assert_eq!(e.box_shadows[0].color, white);
    assert_ne!(parse(&theme, "border").deps() & deps::CURRENT_COLOR, 0);
    assert_ne!(
        parse(&theme, "inset-ring-2").deps() & deps::CURRENT_COLOR,
        0
    );
    assert_eq!(
        parse(&theme, "border-red-500 p-4").deps() & deps::CURRENT_COLOR,
        0
    );
    // ...or the node's own, a class's or its inline style's...
    let red = Color(0xfb2c_36ff);
    let s = resolve("border-t text-red-500 inset-ring", inherited);
    assert_eq!(s.view.borders.colors[0], red);
    assert_eq!(s.view.effects.unwrap().box_shadows[0].color, red);
    let blue = Color(0x0000_ffff);
    let s = resolve(
        "border text-red-500",
        CurrentColor {
            inherited: Some(white),
            inline: Some(blue),
        },
    );
    assert_eq!(s.view.borders.colors[0], blue);
    // ...whichever comes first; a color class wins wherever it is.
    let s = resolve(
        "border-sky-500 border-2 outline-red-500 outline-dashed",
        inherited,
    );
    assert_eq!(s.view.borders.colors[0], Color(0x00a6_f4ff));
    assert_eq!(s.view.outline.color, red);
    // Without one, React Native's black, as inline styles have it.
    let s = resolve("border", CurrentColor::default());
    assert_eq!(s.view.borders.colors[0], Color::BLACK);
}

#[test]
fn later_classes_win() {
    let s = styled("p-4 p-2 bg-red-500 bg-blue-500");
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(8.0));
    assert_eq!(s.view.background_color, Color(0x2b7f_ffff));
    // Variants apply after plain utilities, whatever the order.
    let (s, _) = styled_with(
        "active:bg-red-500 bg-blue-500",
        ClassEnvironment::default(),
        (390.0, 844.0),
        state::PRESSED,
    );
    assert_eq!(s.view.background_color, Color(0xfb2c_36ff));
}

#[test]
fn colors_and_opacity() {
    let s = styled("bg-white/50 text-zinc-900 border border-[#ff0000] opacity-75");
    assert_eq!(s.view.background_color, Color(0xffff_ff80));
    assert_eq!(s.text.color, Some(Color(0x1818_1bff)));
    assert_eq!(s.view.borders.widths.to_array().map(|w| w.0), [1.0; 4]);
    assert_eq!(s.view.borders.colors[0], Color(0xff00_00ff));
    assert_eq!(s.view.opacity, 0.75);
    // `border-none` is `border-style: none`: no border, in any order, and a
    // later style shows it again.
    for classes in [
        "border-2 border-none",
        "border-none border-2",
        "border-hidden border-t-4",
    ] {
        let s = styled(classes);
        assert!(!s.view.borders.is_visible(), "{classes}");
        assert_eq!(s.layout.border.top, taffy::LengthPercentage::length(0.0));
    }
    let (env, states) = cx(0);
    let (s, _) = styled_with(
        "border border-none md:border-solid",
        env,
        (800.0, 844.0),
        states,
    );
    assert_eq!(s.view.borders.widths.to_array().map(|w| w.0), [1.0; 4]);
    let s = styled("bg-[rgb(0_0_255)]/25 text-black/[0.5]");
    assert_eq!(s.view.background_color, Color(0x0000_ff40));
    assert_eq!(s.text.color, Some(Color(0x0000_0080)));
}

#[test]
fn theme_tokens() {
    let ui = ui_theme();
    let dark = ClassEnvironment {
        dark: true,
        ..Default::default()
    };
    let s = styled("bg-primary text-muted-foreground border border-border rounded-(--radius)");
    assert_eq!(
        s.view.background_color,
        Color::from(ui.color("primary").unwrap().light)
    );
    assert_eq!(
        s.text.color,
        Some(Color::from(ui.color("muted-foreground").unwrap().light))
    );
    assert_eq!(
        s.view.borders.colors[0],
        Color::from(ui.color("border").unwrap().light)
    );
    assert_eq!(s.view.border_radius, px(ui.number("radius").unwrap()));
    let (s, _) = styled_with(
        "bg-primary text-(--muted-foreground)",
        dark,
        (390.0, 844.0),
        0,
    );
    assert_eq!(
        s.view.background_color,
        Color::from(ui.color("primary").unwrap().dark)
    );
    assert_eq!(
        s.text.color,
        Some(Color::from(ui.color("muted-foreground").unwrap().dark))
    );
    // Opacity modifiers, longer prefixes, variants, the long form.
    let s = styled("bg-primary/50 border-t-2 border-t-ring");
    assert_eq!(
        s.view.background_color,
        Color::from(ui.color("primary").unwrap().light).with_alpha(0.5)
    );
    assert_eq!(
        s.view.borders.colors[0],
        Color::from(ui.color("ring").unwrap().light)
    );
    // Parts and props: shadows, rings, gradients, the caret, placeholders.
    let (s, props) = styled_with(
        "shadow-md shadow-primary ring-2 ring-ring bg-linear-to-r from-primary to-accent caret-primary placeholder:text-muted-foreground",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(
        props.caret_color,
        Some(Color::from(ui.color("primary").unwrap().light))
    );
    assert_eq!(
        props.placeholder_color,
        Some(Color::from(ui.color("muted-foreground").unwrap().light))
    );
    let e = s.view.effects.as_ref().unwrap();
    assert!(
        e.box_shadows
            .iter()
            .any(|l| l.color == Color::from(ui.color("ring").unwrap().light))
    );
    // The shadow's color keeps each layer's alpha.
    assert!(
        e.box_shadows
            .iter()
            .any(|l| l.color.0 >> 8 == Color::from(ui.color("primary").unwrap().light).0 >> 8)
    );
    let g = &e.background_images[0];
    assert_eq!(
        g.stops[0].color,
        Color::from(ui.color("primary").unwrap().light)
    );
    let accent = ui.color("accent").unwrap();
    assert_eq!(g.stops.last().unwrap().color, Color::from(accent.light));
    let (s, _) = styled_with("dark:bg-accent", dark, (390.0, 844.0), 0);
    assert_eq!(s.view.background_color, Color::from(accent.dark));
    let s = styled("text-(length:--font-size) rounded-(--radius-lg)");
    assert_eq!(s.text.font_size, Some(px(ui.number("font-size").unwrap())));
    assert_eq!(s.view.border_radius, px(ui.number("radius-lg").unwrap()));
    // Later utilities still win, in both appearances.
    let (s, _) = styled_with("bg-primary bg-red-500", dark, (390.0, 844.0), 0);
    assert_eq!(s.view.background_color, Color(0xfb2c_36ff));
    let list = parse(&themed(), "bg-primary p-4");
    assert_ne!(list.deps() & deps::THEME, 0);
    assert_ne!(list.deps() & deps::DARK, 0);
    assert_eq!(parse(&themed(), "bg-red-500").deps() & deps::THEME, 0);
    // Names that are no token, and variables there are not.
    let list = parse(&themed(), "bg-nope text-(--nope) w-primary");
    assert_eq!(list.unknown().len(), 3);
}

#[test]
fn tailwind_colors_win_over_tokens_and_tokens_come_from_the_theme() {
    let mut theme = Theme::from_json(r##"{ "colors": { "primary": "#ff0000" } }"##).unwrap();
    let mut ui = crate::ui::Tokens::default();
    ui.set_number("radius-card", 10.0);
    ui.set_color(
        "chart-up",
        crate::ui::AdaptiveColor::rgb(0x00ff00, 0x008800),
    );
    ui.set_color(
        "chart-grid",
        crate::ui::AdaptiveColor::rgb(0x0000ff, 0x0000ff),
    );
    theme.set_tokens(&ui);
    let group = |_: &str| 0;
    let apply = |classes: &str, dark: bool| {
        let list = parse(&theme, classes);
        assert!(list.unknown().is_empty(), "{:?}", list.unknown());
        let mut style = Style::default();
        let context = Context {
            env: ClassEnvironment {
                dark,
                ..Default::default()
            },
            window: crate::geometry::size_pt(390.0, 844.0),
            rtl: false,
            states: 0,
            position: 0,
            group: &group,
        };
        list.apply(
            &context,
            &theme,
            &mut style,
            &mut ClassProps::default(),
            |_| {},
        );
        style
    };
    assert_eq!(
        apply("bg-primary", false).view.background_color,
        Color(0xff00_00ff)
    );
    assert_eq!(
        apply("bg-chart-up", false).view.background_color,
        Color(0x00ff_00ff)
    );
    assert_eq!(
        apply("bg-chart-up", true).view.background_color,
        Color(0x0088_00ff)
    );
    // A color set in one mode only is used in both.
    let s = apply("border border-chart-grid rounded-(--radius-card)", true);
    assert_eq!(s.view.borders.colors[0], Color(0x0000_ffff));
    assert_eq!(s.view.border_radius, px(10.0));
}

#[test]
fn typography() {
    let s = styled(
        "text-lg font-semibold italic tracking-wide leading-tight underline decoration-wavy decoration-red-500 uppercase text-center tabular-nums",
    );
    assert_eq!(s.text.font_size, Some(px(18.0)));
    assert_eq!(s.text.font_weight, Some(600));
    assert_eq!(s.text.italic, Some(true));
    assert_eq!(s.text.letter_spacing_em, Some(0.025));
    assert_eq!(s.text.line_height_multiple, Some(1.25));
    assert!(s.text.decoration.unwrap().underline);
    assert_eq!(
        s.text.decoration_style,
        Some(crate::style::DecorationStyle::Wavy)
    );
    assert_eq!(s.text.decoration_color, Some(Color(0xfb2c_36ff)));
    assert_eq!(s.text.text_align, Some(crate::style::TextAlign::Center));
    assert!(
        s.text
            .font_variant
            .unwrap()
            .has(crate::style::FontVariant::TABULAR_NUMS)
    );
    // A unitless arbitrary line height is a multiple of the font size, as
    // in CSS (`line-height: 1.5`); lengths are points.
    let s = styled("text-base leading-[1.5]");
    assert_eq!(s.text.line_height_multiple, Some(1.5));
    assert_eq!(s.text.line_height, None);
    let s = styled("text-sm/[1.25]");
    assert_eq!(s.text.line_height_multiple, Some(1.25));
    assert_eq!(styled("leading-[150%]").text.line_height_em, Some(1.5));
    assert_eq!(styled("leading-[2em]").text.line_height_em, Some(2.0));
    assert_eq!(styled("leading-[22px]").text.line_height, Some(px(22.0)));
    assert_eq!(styled("leading-6").text.line_height, Some(px(24.0)));
    // `leading-*` wins over a size's own line height whatever the order
    // or the variant (`line-height: var(--tw-leading, ...)`).
    let s = styled("leading-tight text-lg");
    assert_eq!(s.text.font_size, Some(px(18.0)));
    assert_eq!(s.text.line_height_multiple, Some(1.25));
    let (env, states) = cx(0);
    let (s, _) = styled_with("leading-tight md:text-lg", env, (800.0, 844.0), states);
    assert_eq!(s.text.line_height_multiple, Some(1.25));
    assert_eq!(
        styled("text-lg").text.line_height_multiple,
        Some(1.75 / 1.125)
    );
    // An explicit `/<line>` is the size utility's own line height.
    assert_eq!(styled("text-lg/6").text.line_height, Some(px(24.0)));
    // `normal-nums` resets `font-variant-numeric` only.
    let s = styled("small-caps tabular-nums normal-nums");
    assert_eq!(
        s.text.font_variant,
        Some(crate::style::FontVariant(
            crate::style::FontVariant::SMALL_CAPS
        ))
    );
    let s = styled("text-sm/6 font-mono");
    assert_eq!(s.text.font_size, Some(px(14.0)));
    assert_eq!(s.text.line_height, Some(px(24.0)));
    assert_eq!(s.text.font_family.unwrap().name().as_ref(), "monospace");
    let (_, props) = styled_with("truncate", ClassEnvironment::default(), (390.0, 844.0), 0);
    assert_eq!(props.number_of_lines, Some(1));
    assert_eq!(props.no_wrap, Some(true));
}

#[test]
fn shadows_and_rings() {
    let s = styled("shadow-md");
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(e.box_shadows.len(), 2);
    assert_eq!(e.box_shadows[0].offset_y, px(4.0));
    assert_eq!(e.box_shadows[0].spread, px(-1.0));
    let s = styled("shadow-lg shadow-blue-500/50 ring-2 ring-offset-2 ring-red-500");
    let e = s.view.effects.as_ref().unwrap();
    // Ring offset, ring, then the two shadow layers.
    assert_eq!(e.box_shadows.len(), 4);
    assert_eq!(e.box_shadows[0].spread, px(2.0));
    assert_eq!(e.box_shadows[0].color, Color(0xffff_ffff));
    assert_eq!(e.box_shadows[1].spread, px(4.0));
    assert_eq!(e.box_shadows[1].color, Color(0xfb2c_36ff));
    assert_eq!(e.box_shadows[2].color, Color(0x2b7f_ff80));
    // A color replaces each layer's, alpha too (Tailwind's
    // `--tw-shadow-color` at `--tw-shadow-alpha`, 100%).
    let s = styled("shadow-sm shadow-red-500");
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(e.box_shadows[0].color, Color(0xfb2c_36ff));
    assert!(styled("shadow-md shadow-none").view.effects.is_none());
    // A size's modifier is the layers' alpha, and the color's.
    let s = styled("shadow-xl/20");
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(e.box_shadows[0].color, Color(0x0000_0033));
    let s = styled("shadow-red-500/50 shadow-xl/20");
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(e.box_shadows[0].color, Color(0xfb2c_361a));
    // Arbitrary layers take colors and modifiers too.
    let s = styled("shadow-[0_35px_35px_red]/20");
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(e.box_shadows[0].color, Color(0xff00_0033));
    // `currentColor` everywhere Tailwind has `-current`.
    let s =
        styled("text-red-500 shadow-md shadow-current/50 ring-2 ring-offset-2 ring-offset-current");
    let e = s.view.effects.as_ref().unwrap();
    let red = Color(0xfb2c_36ff);
    assert_eq!(e.box_shadows[0].color, red);
    assert_eq!(e.box_shadows[2].color, red.with_alpha(0.5));
    let s = styled("text-red-500 bg-current/50 decoration-current");
    assert_eq!(s.view.background_color, red.with_alpha(0.5));
    assert_eq!(s.text.decoration_color, Some(red));
    let s = styled("text-red-500 drop-shadow-md drop-shadow-current");
    match s.view.effects.as_ref().unwrap().filters[0] {
        Filter::DropShadow { color, .. } => assert_eq!(color, red),
        f => panic!("{f:?}"),
    }
    let s = styled("drop-shadow-blue-500/50 drop-shadow-lg");
    match s.view.effects.as_ref().unwrap().filters[0] {
        Filter::DropShadow { color, .. } => assert_eq!(color, Color(0x2b7f_ff80)),
        f => panic!("{f:?}"),
    }
}

#[test]
fn gradients() {
    let s = styled("bg-linear-to-r from-blue-500 via-purple-500 via-40% to-pink-500");
    let g = &s.view.effects.as_ref().unwrap().background_images[0];
    assert_eq!(g.kind, GradientKind::Linear { angle: deg(90.0) });
    // Tailwind's stops, and between them stops sampled in Oklab (Tailwind
    // writes `in oklab`).
    let blue = Color(0x2b7f_ffff);
    let purple = Color(0xad46_ffff);
    let pink = Color(0xf633_9aff);
    let at = |stop: &crate::effects::ColorStop| match stop.position {
        Some(DefiniteLength::Fraction(f)) => f.0,
        _ => panic!("placed by fractions"),
    };
    assert!(g.stops.len() > 3);
    assert_eq!((g.stops[0].color, at(&g.stops[0])), (blue, 0.0));
    let via = g.stops.iter().position(|s| s.color == purple).unwrap();
    assert!((at(&g.stops[via]) - 0.4).abs() < 1e-6);
    let last = g.stops.last().unwrap();
    assert_eq!((last.color, at(last)), (pink, 1.0));
    assert!(g.stops.windows(2).all(|w| at(&w[0]) < at(&w[1])));
    // Halfway from blue to purple, the Oklab mix (CSS's `color-mix(in
    // oklab, ...)`), not the sRGB one.
    let mid = g
        .stops
        .iter()
        .find(|s| (at(s) - 0.2).abs() < 1e-6)
        .expect("a stop halfway");
    assert_eq!(
        mid.color,
        crate::css::color("color-mix(in oklab, #2b7fff, #ad46ff)").unwrap()
    );
    let s = styled("bg-linear-to-br from-red-500");
    let g = &s.view.effects.as_ref().unwrap().background_images[0];
    assert!(matches!(
        g.kind,
        GradientKind::LinearCorner {
            right: true,
            bottom: true
        }
    ));
    assert_eq!(g.stops[1].color, Color::TRANSPARENT);
    let s = styled("bg-[linear-gradient(45deg,red,blue)]");
    let g = &s.view.effects.as_ref().unwrap().background_images[0];
    assert_eq!(g.kind, GradientKind::Linear { angle: deg(45.0) });
    assert_eq!(g.stops.len(), 2);
    // At an arbitrary position Tailwind writes no `in oklab`: CSS's default,
    // Oklab with the palette's (OKLCH) colors, sRGB with legacy ones.
    let stops = |classes: &str| {
        styled(classes).view.effects.unwrap().background_images[0]
            .stops
            .len()
    };
    assert!(stops("bg-linear-[25deg] from-red-500 to-blue-500") > 2);
    assert_eq!(stops("bg-linear-[25deg] from-[#f00] to-[rgb(0_0_255)]"), 2);
    assert!(stops("bg-linear-[25deg] from-[#f00] to-[oklch(60%_0.2_250)]") > 2);
    assert!(stops("bg-linear-45 from-[#f00] to-[#00f]") > 2);
    assert!(stops("bg-conic from-[#f00] to-[#00f]") > 2);
    assert_eq!(stops("bg-conic-[90deg] from-[#f00] to-[#00f]"), 2);
    let s = styled("bg-[repeating-linear-gradient(90deg,red_0px,blue_10px)]");
    let g = &s.view.effects.as_ref().unwrap().background_images[0];
    assert!(g.repeating);
    assert_eq!(g.stops[1].position, Some(DefiniteLength::from(px(10.0))));
}

#[test]
fn state_backgrounds_show_over_gradients() {
    let classes = "bg-linear-to-b from-zinc-700 to-zinc-800 active:bg-zinc-600";
    let pressed = |classes| {
        let (env, _) = cx(0);
        styled_with(classes, env, (390.0, 844.0), state::PRESSED).0
    };
    assert!(
        !styled(classes)
            .view
            .effects
            .as_ref()
            .unwrap()
            .background_images
            .is_empty()
    );
    let s = pressed(classes);
    assert!(s.view.effects.is_none());
    assert_eq!(s.view.background_color, Color(0x52_52_5c_ff));
    let s = pressed("text-red-500 bg-linear-to-b from-zinc-700 active:bg-current");
    assert!(s.view.effects.is_none());
    assert_eq!(s.view.background_color, s.text.color.unwrap());
    // A state that sets its own gradient keeps it.
    let s = pressed("bg-linear-to-b from-zinc-700 active:bg-zinc-600 active:from-zinc-500");
    assert_eq!(s.view.effects.as_ref().unwrap().background_images.len(), 1);
    // A later plain color is not feedback.
    let env = ClassEnvironment {
        dark: true,
        ..Default::default()
    };
    let (s, _) = styled_with(
        "bg-linear-to-b from-zinc-700 active:bg-zinc-600 dark:bg-black",
        env,
        (390.0, 844.0),
        state::PRESSED,
    );
    assert_eq!(s.view.effects.as_ref().unwrap().background_images.len(), 1);
    // Plain colors keep CSS's order: the gradient is drawn over them.
    let s = styled("bg-zinc-600 bg-linear-to-b from-zinc-700");
    assert_eq!(s.view.effects.as_ref().unwrap().background_images.len(), 1);
}

#[test]
fn transforms() {
    let s = styled("-translate-x-1/2 translate-y-2 rotate-45 scale-110");
    let ops = s.view.transform.ops();
    assert_eq!(ops[0].kind, TransformKind::TranslateXFraction);
    assert_eq!(ops[0].value, -0.5);
    assert_eq!(ops[1].kind, TransformKind::TranslateY);
    assert_eq!(ops[1].value, 8.0);
    assert_eq!(ops[2].kind, TransformKind::Rotate);
    assert_eq!(ops[3].kind, TransformKind::Scale);
    assert!((ops[3].value - 1.1).abs() < 1e-6);
    let t = s
        .view
        .transform
        .resolve_fractions(crate::geometry::size(px(100.0), px(40.0)));
    assert_eq!(t.ops()[0].kind, TransformKind::TranslateX);
    assert_eq!(t.ops()[0].value, -50.0);
    let kinds = |classes: &str| {
        styled(classes)
            .view
            .transform
            .ops()
            .iter()
            .map(|op| (op.kind, op.value))
            .collect::<Vec<_>>()
    };
    // `transform-none` is `transform: none`: the 3D rotations and the
    // skews; `translate`, `rotate` and `scale` are properties of their own.
    assert_eq!(
        kinds("translate-x-2 rotate-12 scale-90 rotate-x-45 skew-x-6 transform-none"),
        [
            (TransformKind::TranslateX, 8.0),
            (TransformKind::Rotate, 12.0),
            (TransformKind::Scale, 0.9),
        ]
    );
    assert_eq!(
        kinds("translate-x-2 rotate-12 scale-90 rotate-x-45 translate-none scale-none rotate-none"),
        [(TransformKind::RotateX, 45.0)]
    );
    // `rotate-z-*` is `rotateZ()` in `transform`, after `rotateX()` and
    // `rotateY()`, and composes with `rotate-*` (CSS's `rotate`, applied
    // after the transform).
    assert_eq!(
        kinds("rotate-z-30 rotate-x-45 rotate-12 scale-50"),
        [
            (TransformKind::Rotate, 12.0),
            (TransformKind::Scale, 0.5),
            (TransformKind::RotateX, 45.0),
            (TransformKind::Rotate, 30.0),
        ]
    );
    // `perspective-*` is CSS's `perspective`: its children's depth, no
    // step of its own transform.
    let s = styled("perspective-near rotate-x-45");
    assert_eq!(s.perspective, Some(px(300.0)));
    assert_eq!(
        kinds("perspective-near rotate-x-45"),
        [(TransformKind::RotateX, 45.0)]
    );
    // Every step Tailwind composes fits.
    assert_eq!(
        kinds(
            "translate-x-1 translate-y-2 rotate-3 scale-x-50 scale-y-75 rotate-x-6 rotate-y-12 rotate-z-45 skew-x-1 skew-y-2"
        )
        .len(),
        10
    );
}

#[test]
fn effects_and_interaction() {
    let s = styled(
        "blur-sm brightness-125 backdrop-blur-md mix-blend-multiply outline-2 outline-offset-2 outline-blue-500 invisible cursor-pointer",
    );
    let e = s.view.effects.as_ref().unwrap();
    assert_eq!(
        e.filters,
        vec![
            crate::effects::Filter::Blur(px(8.0)),
            crate::effects::Filter::Brightness(1.25)
        ]
    );
    assert_eq!(
        e.backdrop_filters,
        vec![crate::effects::Filter::Blur(px(12.0))]
    );
    assert_eq!(s.view.blend_mode, BlendMode::Multiply);
    // Every layer of a drop shadow is a `drop-shadow()` of the chain, after
    // the other filters, as Tailwind's `--tw-drop-shadow`.
    use crate::effects::Filter;
    let filters = |classes| {
        styled(classes)
            .view
            .effects
            .map(|e| e.filters.clone())
            .unwrap_or_default()
    };
    let drop = |y: f32, blur: f32, alpha: u32| Filter::DropShadow {
        offset_x: px(0.0),
        offset_y: px(y),
        blur: px(blur),
        color: Color(alpha),
    };
    assert_eq!(
        filters("drop-shadow blur-sm"),
        vec![
            Filter::Blur(px(8.0)),
            drop(1.0, 2.0, 0x1a),
            drop(1.0, 1.0, 0x0f)
        ]
    );
    assert_eq!(filters("drop-shadow-md").len(), 1);
    assert_eq!(
        filters("drop-shadow-[0_1px_1px_#000,0_2px_4px_#f00]").len(),
        2
    );
    assert!(filters("drop-shadow drop-shadow-none").is_empty());
    assert_eq!(s.view.outline.width, px(2.0));
    assert_eq!(s.view.outline.offset, px(2.0));
    assert!(s.view.hidden);
    // `outline-<n>` is `outline-style: var(--tw-outline-style)`: solid
    // unless a style utility is anywhere in the string.
    use crate::style::BorderStyle;
    let outline = |classes| {
        let o = styled(classes).view.outline;
        (o.style, o.width)
    };
    assert_eq!(outline("outline-2"), (BorderStyle::Solid, px(2.0)));
    assert_eq!(outline("outline"), (BorderStyle::Solid, px(1.0)));
    assert_eq!(
        outline("outline-dashed outline-2"),
        (BorderStyle::Dashed, px(2.0))
    );
    assert_eq!(
        outline("outline-2 outline-dotted"),
        (BorderStyle::Dotted, px(2.0))
    );
    assert_eq!(outline("outline-none outline-2").1, px(0.0));
    assert_eq!(outline("outline-2 outline-hidden").1, px(0.0));
    // A style alone is CSS's initial `medium` width.
    assert_eq!(outline("outline-dashed"), (BorderStyle::Dashed, px(3.0)));
    assert_eq!(outline("outline-solid"), (BorderStyle::Solid, px(3.0)));
    let (env, states) = cx(state::FOCUSED);
    let (focused, _) = styled_with(
        "outline-2 focus:outline-dashed",
        env,
        (390.0, 844.0),
        states,
    );
    assert_eq!(
        (focused.view.outline.style, focused.view.outline.width),
        (BorderStyle::Dashed, px(2.0))
    );
    assert_eq!(s.view.cursor, Cursor::Pointer);
}

#[test]
fn transitions_and_animations() {
    let s = styled("transition-colors duration-300 ease-out delay-75");
    let t = s.view.transition.unwrap();
    assert_eq!(t.duration, 300.0);
    assert_eq!(t.delay, 75.0);
    assert_eq!(t.easing, [0.0, 0.0, 0.2, 1.0]);
    assert!(t.properties.has(crate::effects::TransitionProps::COLORS));
    assert!(!t.properties.has(crate::effects::TransitionProps::TRANSFORM));
    let s = styled("transition");
    assert_eq!(s.view.transition.unwrap().duration, 150.0);
    let s = styled("animate-spin");
    assert_eq!(s.view.animation.unwrap().keyframes, Keyframes::Spin);
}

#[test]
fn display() {
    // As in CSS, a flex container is a row unless a direction utility says
    // otherwise, wherever that utility is in the string.
    let s = styled("flex");
    assert_eq!(s.layout.display, taffy::Display::Flex);
    assert_eq!(s.layout.flex_direction, taffy::FlexDirection::Row);
    assert_eq!(
        styled("inline-flex").layout.flex_direction,
        taffy::FlexDirection::Row
    );
    assert_eq!(
        styled("flex-col flex").layout.flex_direction,
        taffy::FlexDirection::Column
    );
    assert_eq!(
        styled("flex flex-col").layout.flex_direction,
        taffy::FlexDirection::Column
    );
    assert_eq!(
        styled("flex-col-reverse flex").layout.flex_direction,
        taffy::FlexDirection::ColumnReverse
    );
    // Without `flex`, views keep React Native's column.
    assert_eq!(
        styled("items-center").layout.flex_direction,
        taffy::FlexDirection::Column
    );
    // A variant `flex` is a row where it applies; a plain direction still wins.
    let (env, states) = cx(0);
    let wide = |c| styled_with(c, env, (800.0, 844.0), states).0;
    assert_eq!(
        wide("hidden md:flex").layout.flex_direction,
        taffy::FlexDirection::Row
    );
    assert_eq!(
        wide("flex-col md:flex").layout.flex_direction,
        taffy::FlexDirection::Column
    );
    assert_eq!(
        styled("hidden md:flex").layout.display,
        taffy::Display::None
    );
    assert_eq!(
        styled("hidden md:flex").layout.flex_direction,
        taffy::FlexDirection::Column
    );
    // Block formatting contexts use Taffy's block layout.
    assert_eq!(styled("block").layout.display, taffy::Display::Block);
    assert_eq!(styled("flow-root").layout.display, taffy::Display::FlowRoot);
    // Inline boxes in a flex or grid parent are blockified, as a browser
    // computes them (`display: inline-block` -> `block`).
    assert_eq!(styled("inline-block").layout.display, taffy::Display::Block);
    assert_eq!(styled("inline").layout.display, taffy::Display::Block);
    assert_eq!(
        wide("hidden md:inline-block").layout.display,
        taffy::Display::Block
    );
}

#[test]
fn grid() {
    let s = styled("grid grid-cols-3 gap-2 col-span-2");
    assert_eq!(s.layout.display, taffy::Display::Grid);
    assert_eq!(s.layout.grid_template_columns.len(), 1);
    assert_eq!(s.layout.grid_column.start, taffy::GridPlacement::Span(2));
    // Line names.
    let s = styled("grid grid-cols-[[a]_40px_[b]_1fr] col-[a/b] row-start-[main]");
    assert_eq!(s.layout.grid_template_columns.len(), 2);
    assert_eq!(s.layout.grid_template_column_names.len(), 3);
    let named = |n: &str| taffy::GridPlacement::NamedLine(n.to_owned(), 0);
    assert_eq!(s.layout.grid_column.start, named("a"));
    assert_eq!(s.layout.grid_column.end, named("b"));
    assert_eq!(s.layout.grid_row.start, named("main"));
    // Invalid arbitrary placements and tracks stay known classes that set
    // nothing (the style logs them); a negative named line is unknown.
    let theme = themed();
    let list = parse(
        &theme,
        "col-[1_2] row-start-[1a] auto-rows-[3zz] -col-start-[a]",
    );
    assert_eq!(list.unknown().len(), 2, "{:?}", list.unknown());
    let s = styled("col-[1_2] auto-rows-[3zz]");
    assert_eq!(s.layout.grid_column, Style::default().layout.grid_column);
    assert_eq!(
        s.layout.grid_auto_rows,
        Style::default().layout.grid_auto_rows
    );
}

/// Each alignment class against the declaration Tailwind CSS (v4.3)
/// generates for it, in the comment: the same property, the same value.
#[test]
fn alignment_follows_tailwind_css() {
    use taffy::{AlignContent as C, AlignItems as I};
    let content: &[(&str, C, C)] = &[
        // (class, align-content, justify-content)
        ("justify-start", C::NORMAL, C::FLEX_START), // justify-content: flex-start
        ("justify-end", C::NORMAL, C::FLEX_END),     // justify-content: flex-end
        ("justify-center", C::NORMAL, C::CENTER),    // justify-content: center
        ("justify-between", C::NORMAL, C::SPACE_BETWEEN), // justify-content: space-between
        ("justify-around", C::NORMAL, C::SPACE_AROUND), // justify-content: space-around
        ("justify-evenly", C::NORMAL, C::SPACE_EVENLY), // justify-content: space-evenly
        ("justify-stretch", C::NORMAL, C::STRETCH),  // justify-content: stretch
        ("justify-normal", C::NORMAL, C::NORMAL),    // justify-content: normal
        // align-content: normal, which is `stretch` in flex and grid
        // containers (the style's `normal` is the unset value).
        ("content-normal", C::STRETCH, C::NORMAL),
        ("content-start", C::FLEX_START, C::NORMAL), // align-content: flex-start
        ("content-end", C::FLEX_END, C::NORMAL),     // align-content: flex-end
        ("content-center", C::CENTER, C::NORMAL),    // align-content: center
        ("content-between", C::SPACE_BETWEEN, C::NORMAL), // align-content: space-between
        ("content-around", C::SPACE_AROUND, C::NORMAL), // align-content: space-around
        ("content-evenly", C::SPACE_EVENLY, C::NORMAL), // align-content: space-evenly
        ("content-stretch", C::STRETCH, C::NORMAL),  // align-content: stretch
        ("place-content-center", C::CENTER, C::CENTER), // place-content: center
        ("place-content-start", C::START, C::START), // place-content: start
        ("place-content-end", C::END, C::END),       // place-content: end
        ("place-content-between", C::SPACE_BETWEEN, C::SPACE_BETWEEN), /* place-content: space-between */
        ("place-content-stretch", C::STRETCH, C::STRETCH),             // place-content: stretch
    ];
    for &(class, align, justify) in content {
        let s = styled(class);
        assert_eq!(
            (s.layout.align_content, s.layout.justify_content),
            (align, justify),
            "{class}"
        );
    }
    let items: &[(&str, I, I)] = &[
        // (class, align-items, justify-items)
        ("items-start", I::FLEX_START, I::NORMAL), // align-items: flex-start
        ("items-end", I::FLEX_END, I::NORMAL),     // align-items: flex-end
        ("items-center", I::CENTER, I::NORMAL),    // align-items: center
        ("items-baseline", I::BASELINE, I::NORMAL), // align-items: baseline
        ("items-stretch", I::STRETCH, I::NORMAL),  // align-items: stretch
        ("justify-items-start", I::NORMAL, I::START), // justify-items: start
        ("justify-items-end", I::NORMAL, I::END),  // justify-items: end
        ("justify-items-center", I::NORMAL, I::CENTER), // justify-items: center
        ("justify-items-stretch", I::NORMAL, I::STRETCH), // justify-items: stretch
        ("justify-items-normal", I::NORMAL, I::NORMAL), // justify-items: normal
        ("place-items-center", I::CENTER, I::CENTER), // place-items: center
        ("place-items-start", I::START, I::START), // place-items: start
        ("place-items-end", I::END, I::END),       // place-items: end
        ("place-items-stretch", I::STRETCH, I::STRETCH), // place-items: stretch
    ];
    for &(class, align, justify) in items {
        let s = styled(class);
        assert_eq!(
            (s.layout.align_items, s.layout.justify_items),
            (align, justify),
            "{class}"
        );
    }
    let selves: &[(&str, Option<I>, Option<I>)] = &[
        // (class, align-self, justify-self); `auto` is unset.
        ("self-auto", None, None),                  // align-self: auto
        ("self-start", Some(I::FLEX_START), None),  // align-self: flex-start
        ("self-end", Some(I::FLEX_END), None),      // align-self: flex-end
        ("self-center", Some(I::CENTER), None),     // align-self: center
        ("self-stretch", Some(I::STRETCH), None),   // align-self: stretch
        ("self-baseline", Some(I::BASELINE), None), // align-self: baseline
        ("justify-self-auto", None, None),          // justify-self: auto
        ("justify-self-start", None, Some(I::FLEX_START)), // justify-self: flex-start
        ("justify-self-end", None, Some(I::FLEX_END)), // justify-self: flex-end
        ("justify-self-center", None, Some(I::CENTER)), // justify-self: center
        ("justify-self-stretch", None, Some(I::STRETCH)), // justify-self: stretch
        ("place-self-auto", None, None),            // place-self: auto
        ("place-self-start", Some(I::START), Some(I::START)), // place-self: start
        ("place-self-end", Some(I::END), Some(I::END)), // place-self: end
        ("place-self-center", Some(I::CENTER), Some(I::CENTER)), // place-self: center
        ("place-self-stretch", Some(I::STRETCH), Some(I::STRETCH)), // place-self: stretch
    ];
    for &(class, align, justify) in selves {
        let s = styled(class);
        assert_eq!(
            (s.layout.align_self, s.layout.justify_self),
            (align, justify),
            "{class}"
        );
    }
}

/// Grid utilities as Tailwind CSS generates them: a type hint is dropped
/// from the value (`col-[number:2]` is `grid-column: 2`), and the classes
/// it has no negative of are unknown.
#[test]
fn grid_utilities_follow_tailwind_css() {
    let s = styled("col-[number:2] row-span-[number:3] auto-cols-[length:13px]");
    assert_eq!(
        s.layout.grid_column.start,
        taffy::GridPlacement::Line(2.into())
    );
    assert_eq!(s.layout.grid_row.start, taffy::GridPlacement::Span(3));
    assert_eq!(s.layout.grid_auto_columns.len(), 1);
    // `-col-[2]` is `grid-column: calc(2 * -1)`.
    assert_eq!(
        styled("-col-[2]").layout.grid_column.start,
        taffy::GridPlacement::Line((-2).into())
    );
    // A number is no track size: the class sets nothing, as a browser
    // drops `grid-auto-rows: 2`.
    let s = styled("auto-rows-[number:2]");
    assert_eq!(
        s.layout.grid_auto_rows,
        Style::default().layout.grid_auto_rows
    );
    let theme = themed();
    let negatives = "-grid-cols-2 -grid-rows-[13px] -col-span-2 -row-span-1 -auto-cols-[13px] -auto-rows-fr -col-auto";
    let list = parse(&theme, negatives);
    assert_eq!(list.unknown().len(), 7, "{:?}", list.unknown());
}

#[test]
fn variants() {
    let theme = themed();
    let list = parse(
        &theme,
        "bg-white dark:bg-black md:p-8 hover:opacity-80 group-active:scale-95 ios:pt-1 android:pt-2 rtl:ml-2",
    );
    assert!(list.unknown().is_empty(), "{:?}", list.unknown());
    let d = list.deps();
    assert!(
        d & deps::DARK != 0 && d & deps::WIDTH != 0 && d & deps::STATE != 0 && d & deps::GROUP != 0
    );
    assert_eq!(list.tracked_states(), state::HOVERED);
    let dark = ClassEnvironment {
        dark: true,
        platform: Platform::Android,
        reduce_motion: false,
    };
    let (s, _) = styled_with("bg-white dark:bg-black", dark, (390.0, 844.0), 0);
    assert_eq!(s.view.background_color, Color(0x0000_00ff));
    let (s, _) = styled_with("p-2 md:p-8", ClassEnvironment::default(), (390.0, 844.0), 0);
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(8.0));
    let (s, _) = styled_with(
        "p-2 md:p-8",
        ClassEnvironment::default(),
        (1024.0, 768.0),
        0,
    );
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(32.0));
    let (s, _) = styled_with(
        "p-2 max-md:p-1",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(4.0));
    let (s, _) = styled_with("pt-1 ios:pt-3 android:pt-5", dark, (390.0, 844.0), 0);
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(20.0));
    let web = ClassEnvironment {
        platform: Platform::Web,
        ..ClassEnvironment::default()
    };
    let (s, _) = styled_with("pt-1 ios:pt-3 web:pt-5", web, (390.0, 844.0), 0);
    assert_eq!(s.layout.padding.top, taffy::LengthPercentage::length(20.0));
    let (s, _) = styled_with(
        "w-screen h-screen",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(s.layout.size.width, taffy::Dimension::length(390.0));
    assert_eq!(s.layout.size.height, taffy::Dimension::length(844.0));
}

#[test]
fn checked_variants() {
    let theme = themed();
    let list = parse(&theme, "checked:bg-black group-checked:translate-x-4");
    assert!(list.unknown().is_empty(), "{:?}", list.unknown());
    assert!(list.deps() & deps::STATE != 0 && list.deps() & deps::GROUP != 0);
    // The core sets it: nothing for the platform to report.
    assert_eq!(list.tracked_states(), 0);
    let env = ClassEnvironment::default();
    let (s, _) = styled_with(
        "bg-white checked:bg-black",
        env,
        (390.0, 844.0),
        state::CHECKED,
    );
    assert_eq!(s.view.background_color, Color(0x0000_00ff));
    // A value state: `selected:` and the interaction states go over it.
    let both = state::CHECKED | state::SELECTED;
    let (s, _) = styled_with(
        "selected:bg-white checked:bg-black",
        env,
        (390.0, 844.0),
        both,
    );
    assert_eq!(s.view.background_color, Color(0xffff_ffff));
    let hovered = state::CHECKED | state::HOVERED;
    let (s, _) = styled_with(
        "hover:bg-white checked:bg-black",
        env,
        (390.0, 844.0),
        hovered,
    );
    assert_eq!(s.view.background_color, Color(0xffff_ffff));
}

#[test]
fn indeterminate_variants() {
    let theme = themed();
    let list = parse(
        &theme,
        "indeterminate:bg-black group-indeterminate:opacity-50",
    );
    assert!(list.unknown().is_empty(), "{:?}", list.unknown());
    assert!(list.deps() & deps::STATE != 0 && list.deps() & deps::GROUP != 0);
    // The core sets it: nothing for the platform to report.
    assert_eq!(list.tracked_states(), 0);
    let env = ClassEnvironment::default();
    let classes = "bg-white checked:bg-black indeterminate:bg-red-500";
    let (s, _) = styled_with(classes, env, (390.0, 844.0), state::INDETERMINATE);
    assert_eq!(s.view.background_color, Color(0xfb2c_36ff));
    // Not checked: `checked:` waits for its own state.
    let (s, _) = styled_with(classes, env, (390.0, 844.0), state::CHECKED);
    assert_eq!(s.view.background_color, Color(0x0000_00ff));
    // A value state: the interaction states go over it.
    let hovered = state::INDETERMINATE | state::HOVERED;
    let (s, _) = styled_with(
        "hover:bg-white indeterminate:bg-black",
        env,
        (390.0, 844.0),
        hovered,
    );
    assert_eq!(s.view.background_color, Color(0xffff_ffff));
}

#[test]
fn groups() {
    let theme = themed();
    let root = parse(&theme, "group/card p-2");
    assert_eq!(root.groups(), ["card".into()] as [Box<str>; 1]);
    let child = parse(&theme, "opacity-100 group-hover/card:opacity-50");
    let mut style = Style::default();
    let mut props = ClassProps::default();
    let group = |name: &str| if name == "card" { state::HOVERED } else { 0 };
    let context = Context {
        env: ClassEnvironment::default(),
        window: crate::geometry::size_pt(390.0, 844.0),
        rtl: false,
        states: 0,
        position: 0,
        group: &group,
    };
    child.apply(&context, &theme, &mut style, &mut props, |_| {});
    assert_eq!(style.view.opacity, 0.5);
    // Tailwind registers `group-*` before `first:` ... `even:`, so the
    // structural variants win over it whatever the order in the string
    // (`.group:hover .x` comes before `.y:last-child` in the CSS).
    let child = parse(&theme, "last:opacity-25 group-hover/card:opacity-50");
    let context = Context {
        position: position::LAST,
        ..context
    };
    child.apply(&context, &theme, &mut style, &mut props, |_| {});
    assert_eq!(style.view.opacity, 0.25);
}

#[test]
fn unknown_classes_are_reported() {
    let theme = themed();
    let list = parse(&theme, "p-4 bg-nope-500 flexx hover:wat antialiased");
    let unknown: Vec<&str> = list.unknown().iter().map(|s| &**s).collect();
    assert_eq!(unknown, ["bg-nope-500", "flexx", "hover:wat"]);
}

#[test]
fn classes_without_a_native_meaning_are_unknown() {
    let theme = themed();
    let unknown = |classes: &str| -> Vec<String> {
        parse(&theme, classes)
            .unknown()
            .iter()
            .map(|s| s.to_string())
            .collect()
    };
    let all_unknown = |classes: &str| {
        assert_eq!(
            unknown(classes),
            classes.split_whitespace().collect::<Vec<_>>(),
            "{classes}"
        );
    };
    // What Tailwind CSS generates that NSH cannot do: unknown, never a
    // different meaning.
    all_unknown(
        "transform-3d order-1 order-first -order-2 order-[3] select-all border-double outline-double",
    );
    all_unknown("min-w-fit min-h-max max-w-min max-h-fit");
    all_unknown(
        "snap-x snap-center scroll-smooth scroll-mt-4 scroll-px-2 overscroll-none touch-none isolate md:snap-x scroll-anything",
    );
    // What Tailwind CSS generates nothing for.
    all_unknown(
        "-gap-4 -gap-x-2 -space-x-1/2 -w-4 -h-2 -size-4 -min-w-0 -max-w-sm -basis-4 -flex-1 -grow -opacity-50 -text-lg -text-red-500 -bg-red-500 -rounded-lg -border-2 -blur-sm -p-4 -px-2 -leading-6 -shadow-md -ring-2 -from-red-500 -perspective-near -duration-100",
    );
    all_unknown(
        "p-1/2 p-full px-1/3 m-full m-1/2 -m-full mt-1/4 gap-1/2 gap-full gap-x-full space-y-1/2",
    );
    all_unknown("z-1.5 z-[1.5] -z-auto inset-shadow");
    // What stays: rendering hints, negatives and fractions Tailwind has.
    assert_eq!(
        unknown(
            "antialiased subpixel-antialiased box-border isolation-auto appearance-none appearance-auto will-change-transform will-change-[opacity] md:antialiased"
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        unknown(
            "-mt-2 -mx-px -m-4 -top-1/2 -inset-x-4 -start-2 -z-10 z-[100] -z-[5] -translate-x-1/2 -rotate-6 -rotate-x-12 -scale-x-100 -skew-y-3 -tracking-wide -underline-offset-2 -outline-offset-2 -hue-rotate-30 -backdrop-hue-rotate-15 -bg-linear-45 -bg-conic-90 -col-start-2 -row-end-1 -space-y-2 w-1/2 inset-full basis-1/3 translate-full"
        ),
        Vec::<String>::new()
    );
    assert_eq!(styled("-z-10").z_index, -10);
    assert_eq!(styled("z-[100]").z_index, 100);
    // A theme of the app's own may give the bare form a value, as a
    // `--inset-shadow` in Tailwind's `@theme` does.
    let theme =
        Theme::from_json(r#"{"insetShadow": {"": "inset 0 1px 2px rgb(0 0 0 / 0.1)"}}"#).unwrap();
    assert!(parse(&theme, "inset-shadow").unknown().is_empty());
}

#[test]
fn placeholder_and_props() {
    let (_, props) = styled_with(
        "placeholder:text-zinc-400 selection:bg-blue-500 caret-blue-500 line-clamp-2 pointer-events-none object-contain select-none",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(props.placeholder_color, Some(Color(0x9f9f_a9ff)));
    assert_eq!(props.caret_color, Some(Color(0x2b7f_ffff)));
    assert_eq!(props.selection_color, Some(Color(0x2b7f_ffff)));
    assert_eq!(props.number_of_lines, Some(2));
    assert_eq!(
        props.pointer_events,
        Some(crate::props::PointerEvents::None)
    );
    assert_eq!(props.resize_mode, Some(crate::ops::ResizeMode::Contain));
    assert_eq!(props.selectable, Some(false));
    // CSS's `object-fit: none` (natural size) and `scale-down`.
    let resize = |c| {
        styled_with(c, ClassEnvironment::default(), (390.0, 844.0), 0)
            .1
            .resize_mode
    };
    assert_eq!(resize("object-none"), Some(crate::ops::ResizeMode::Center));
    assert_eq!(
        resize("object-scale-down"),
        Some(crate::ops::ResizeMode::ScaleDown)
    );
    // `::selection`'s background is the highlight; the color of the
    // selected glyphs and the other properties of the pseudo-elements
    // have no native counterpart.
    let theme = themed();
    let list = parse(
        &theme,
        "selection:text-blue-500 placeholder:italic placeholder:bg-red-500 selection:opacity-50 placeholder:text-muted-foreground selection:bg-primary",
    );
    let unknown: Vec<&str> = list.unknown().iter().map(|s| &**s).collect();
    assert_eq!(
        unknown,
        [
            "selection:text-blue-500",
            "placeholder:italic",
            "placeholder:bg-red-500",
            "selection:opacity-50"
        ]
    );
}

#[test]
fn font_tokens_are_tailwinds_sans_and_mono() {
    let mut theme = Theme::default();
    assert_eq!(
        styled_in(&theme, "font-mono").text.font_family,
        Some(FontFamily::new("monospace"))
    );
    let mut ui = crate::ui::Tokens::default();
    ui.set_font(crate::ui::FONT_SANS, "Inter");
    ui.set_font(crate::ui::FONT_MONO, "JetBrains Mono");
    theme.set_tokens(&ui);
    assert_eq!(
        styled_in(&theme, "font-sans").text.font_family,
        Some(FontFamily::new("Inter"))
    );
    assert_eq!(
        styled_in(&theme, "font-mono").text.font_family,
        Some(FontFamily::new("JetBrains Mono"))
    );
    assert_eq!(
        styled_in(&theme, "font-(family-name:--font-mono)")
            .text
            .font_family,
        Some(FontFamily::new("JetBrains Mono"))
    );
    assert_eq!(
        styled_in(&theme, "font-[family-name:Fira_Code]")
            .text
            .font_family,
        Some(FontFamily::new("Fira Code"))
    );
    assert_ne!(parse(&theme, "font-sans").deps() & deps::THEME, 0);
}

/// `classes` applied with `theme`, in light appearance.
fn styled_in(theme: &Theme, classes: &str) -> Style {
    let group = |_: &str| 0;
    let list = parse(theme, classes);
    assert!(list.unknown().is_empty(), "{:?}", list.unknown());
    let mut style = Style::default();
    let context = Context {
        env: ClassEnvironment::default(),
        window: crate::geometry::size_pt(390.0, 844.0),
        rtl: false,
        states: 0,
        position: 0,
        group: &group,
    };
    list.apply(
        &context,
        theme,
        &mut style,
        &mut ClassProps::default(),
        |_| {},
    );
    style
}

#[test]
fn current_colors_follow_the_cascade_and_inherit() {
    for classes in [
        "text-red-500 border-2 border-blue-500 border-current ring ring-blue-500 ring-current outline-2 outline-blue-500 outline-current",
        "text-red-500 border-current border-2 ring-current ring outline-current outline-2",
    ] {
        let s = styled(classes);
        let color = s.text.color.unwrap();
        assert_eq!(s.view.borders.colors, [color; 4], "{classes}");
        assert_eq!(s.view.outline.color, color, "{classes}");
        assert!(
            s.view
                .effects
                .as_ref()
                .unwrap()
                .box_shadows
                .iter()
                .all(|shadow| shadow.color == color)
        );
    }
    assert_eq!(styled("text-red-500 text-inherit").text.color, None);
    assert_eq!(styled("text-red-500 text-current").text.color, None);
}

#[test]
fn arbitrary_lengths_require_css_units_and_use_the_configured_rem() {
    let mut theme = themed();
    theme.rem = 20.0;
    for (classes, expected) in [("w-[2rem]", 40.0), ("w-[2pt]", 8.0 / 3.0)] {
        let list = parse(&theme, classes);
        let group = |_: &str| 0;
        let cx = Context {
            env: ClassEnvironment::default(),
            window: crate::geometry::size_pt(390.0, 844.0),
            rtl: false,
            states: 0,
            position: 0,
            group: &group,
        };
        let mut s = Style::default();
        list.apply(&cx, &theme, &mut s, &mut ClassProps::default(), |_| {});
        assert_eq!(s.layout.size.width, taffy::Dimension::length(expected));
    }
    for classes in [
        "w-[100]",
        "p-[8]",
        "text-[14]",
        "rounded-[8]",
        "rotate-1.5",
        "scale-x-12.5",
    ] {
        assert_eq!(parse(&theme, classes).unknown().len(), 1, "{classes}");
    }
    assert_eq!(
        styled("inset-s-4").logical.inset[0],
        styled("start-4").logical.inset[0]
    );
    assert_eq!(
        styled("inset-e-4").logical.inset[1],
        styled("end-4").logical.inset[1]
    );
}

#[test]
fn configured_rem_reaches_composite_css_values() {
    let mut theme = themed();
    theme.rem = 20.0;
    let list = parse(&theme, "shadow-[0_1rem_2rem_3px_#000]");
    let mut style = Style::default();
    let group = |_: &str| 0;
    let context = Context {
        env: ClassEnvironment::default(),
        window: crate::geometry::size_pt(390.0, 844.0),
        rtl: false,
        states: 0,
        position: 0,
        group: &group,
    };
    list.apply(
        &context,
        &theme,
        &mut style,
        &mut ClassProps::default(),
        |_| {},
    );
    let effects = style.view.effects.unwrap();
    assert_eq!(effects.box_shadows[0].offset_y, px(20.0));
    assert_eq!(effects.box_shadows[0].blur, px(40.0));
    assert_eq!(effects.box_shadows[0].spread, px(3.0));
}

#[test]
fn object_positions() {
    use crate::style::{ObjectPosition, PositionAxis as A};
    let theme = themed();
    let at = |class: &str| styled_in(&theme, class).view.object_position;
    assert_eq!(at("object-center"), ObjectPosition::CENTER);
    assert_eq!(at("object-top"), ObjectPosition::new(A::CENTER, A::START));
    assert_eq!(at("object-bottom"), ObjectPosition::new(A::CENTER, A::END));
    assert_eq!(at("object-left"), ObjectPosition::new(A::START, A::CENTER));
    assert_eq!(at("object-right"), ObjectPosition::new(A::END, A::CENTER));
    for (a, b) in [
        ("object-top-left", "object-left-top"),
        ("object-top-right", "object-right-top"),
        ("object-bottom-left", "object-left-bottom"),
        ("object-bottom-right", "object-right-bottom"),
    ] {
        assert_eq!(at(a), at(b));
    }
    assert_eq!(
        at("object-top-left"),
        ObjectPosition::new(A::START, A::START)
    );
    assert_eq!(
        at("object-bottom-right"),
        ObjectPosition::new(A::END, A::END)
    );
    assert_eq!(
        at("object-[25%_75%]"),
        ObjectPosition::parse("25% 75%").unwrap()
    );
    assert_eq!(
        at("object-[right_10px_bottom_20%]"),
        ObjectPosition::parse("right 10px bottom 20%").unwrap()
    );
    // `object-fit` stays a prop beside it.
    let (style, props) = styled_with(
        "object-cover object-top",
        ClassEnvironment::default(),
        (390.0, 844.0),
        0,
    );
    assert_eq!(props.resize_mode, Some(crate::ops::ResizeMode::Cover));
    assert_eq!(style.view.object_position, at("object-top"));
    let list = parse(
        &theme,
        "object-[sideways] object-[1px_2px_3px] object-middle",
    );
    let unknown: Vec<&str> = list.unknown().iter().map(|s| &**s).collect();
    assert_eq!(
        unknown,
        ["object-[sideways]", "object-[1px_2px_3px]", "object-middle"]
    );
}

/// Tailwind 4.3's order, which `getClassOrder` gives: a class's highest
/// variant decides, then its next highest; one more variant comes later.
#[test]
fn variants_sort_as_tailwind_sorts_them() {
    let pad = |classes: &str, dark: bool, width: f32, states: u8| {
        let env = ClassEnvironment {
            dark,
            ..Default::default()
        };
        styled_with(classes, env, (width, 800.0), states)
            .0
            .layout
            .padding
            .left
    };
    let p = |n: f32| taffy::LengthPercentage::length(n);
    // `max-*` widest first: the narrowest wins.
    assert_eq!(pad("max-md:p-2 max-lg:p-4", false, 600.0, 0), p(8.0));
    assert_eq!(pad("max-lg:p-4 max-md:p-2", false, 600.0, 0), p(8.0));
    // `px` before `rem`: `max-sm` (40rem) after `max-[600px]`.
    assert_eq!(pad("max-sm:p-2 max-[600px]:p-4", false, 500.0, 0), p(8.0));
    // A second variant comes after the first alone.
    let hovered = state::HOVERED;
    assert_eq!(pad("dark:hover:p-2 dark:p-4", true, 390.0, hovered), p(8.0));
    assert_eq!(pad("md:hover:p-2 md:p-4", false, 800.0, hovered), p(8.0));
    // Groups by their state (`focus` after `hover`), not by position.
    let group = ClassEnvironment::default();
    let list = parse(&themed(), "group-focus:p-2 group-hover:p-4");
    let mut style = Style::default();
    let mut props = ClassProps::default();
    let g = |_: &str| state::HOVERED | state::FOCUSED;
    list.apply(
        &Context {
            env: group,
            window: crate::geometry::size_pt(390.0, 800.0),
            rtl: false,
            states: 0,
            position: 0,
            group: &g,
        },
        &themed(),
        &mut style,
        &mut props,
        |_| {},
    );
    assert_eq!(style.layout.padding.left, p(8.0));
    // `indeterminate:` after `checked:`.
    let both = state::CHECKED | state::INDETERMINATE;
    assert_eq!(
        pad("indeterminate:p-2 checked:p-4", false, 390.0, both),
        p(8.0)
    );
}

/// Bare values as Tailwind takes them: written as JavaScript prints
/// numbers, integers where Tailwind wants them.
#[test]
fn bare_values_follow_tailwinds_grammar() {
    let theme = themed();
    for unknown in [
        "p-.5",
        "p-+4",
        "m-1e1",
        "border-1.5",
        "ring-2.5",
        "outline-0.5",
        "duration-1.5",
        "brightness-1.5",
        "grow-1.5",
        "line-clamp-1.5",
        "z-+4",
        "grid-cols-+2",
        "decoration-px",
        "outline-px",
        "outline-offset-px",
        "underline-offset-px",
        "w-prose",
        "min-w-prose",
        "size-screen",
        "w-1.5/2",
        "from-10.5%",
        "p-[-4px]",
        "w-[-10px]",
        "gap-[-2px]",
        "rounded-[-4px]",
        "text-[-4px]",
    ] {
        assert!(
            !parse(&theme, unknown).unknown().is_empty(),
            "{unknown} is no Tailwind class (or no valid CSS)"
        );
    }
    for known in [
        "p-0.5",
        "p-3.25",
        "opacity-2.5",
        "bg-red-500/2.5",
        "max-w-prose",
        "w-dvh",
        "size-dvw",
        "basis-3xs",
        "-m-[4px]",
        "z-[+4]",
        "perspective-none",
        "bg-mauve-500",
        "text-taupe-950",
        "border-olive-200",
        "ring-mist-400",
        "shadow-current",
        "inset-shadow-current",
        "text-shadow-current",
        "drop-shadow-current",
        "drop-shadow-red-500",
        "ring-offset-current",
        "decoration-current",
        "caret-current",
        "from-current",
        "via-current",
        "to-current",
        "bg-current/50",
        "shadow-xl/20",
        "drop-shadow-md/20",
        "text-shadow-md/20",
    ] {
        assert_eq!(
            parse(&theme, known).unknown(),
            &[] as &[Box<str>],
            "{known}"
        );
    }
}

#[test]
fn sticky_is_position_sticky() {
    // `sticky` is CSS's `position: sticky`; a later position wins.
    let s = styled("sticky top-0");
    assert!(s.pending.sticky_position);
    assert_eq!(s.layout.position, taffy::Position::Relative);
    assert!(!styled("sticky absolute").pending.sticky_position);
}

/// Tailwind CSS 4's `fill-*` / `stroke-*`: `fill: <color>`, `fill: none`,
/// `fill: currentcolor`, `fill: inherit`, `stroke: <color>`,
/// `stroke-width: <number>` and an arbitrary length.
#[test]
fn svg_paint_utilities_follow_tailwind_css() {
    use crate::style::SvgPaint;
    let s = styled("fill-red-500/50 stroke-blue-500 stroke-2");
    assert_eq!(s.paint.fill, Some(SvgPaint::Color(Color(0xfb2c_3680))));
    assert_eq!(s.paint.stroke, Some(SvgPaint::Color(Color(0x2b7f_ffff))));
    assert_eq!(s.paint.stroke_width, Some(px(2.0)));
    let s = styled("fill-none stroke-current stroke-[1.5px]");
    assert_eq!(s.paint.fill, Some(SvgPaint::None));
    assert_eq!(s.paint.stroke, Some(SvgPaint::CurrentColor));
    assert_eq!(s.paint.stroke_width, Some(px(1.5)));
    let s = styled("fill-current stroke-none stroke-0 stroke-[#00ff00]");
    assert_eq!(s.paint.fill, Some(SvgPaint::CurrentColor));
    assert_eq!(s.paint.stroke, Some(SvgPaint::Color(Color(0x00ff_00ff))));
    assert_eq!(s.paint.stroke_width, Some(px(0.0)));
    // `inherit` takes the parent's, which is what an unset property does.
    let s = styled("fill-red-500 fill-inherit");
    assert_eq!(s.paint.fill, None);
    // The design tokens, light and dark.
    let ui = ui_theme();
    let s = styled("stroke-primary");
    assert_eq!(
        s.paint.stroke,
        Some(SvgPaint::Color(Color::from(
            ui.color("primary").unwrap().light
        )))
    );
}
