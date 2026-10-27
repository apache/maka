//! Mount batches as the JSON the DOM mounter (`web/nsh.js`, `apply`)
//! reads: one array per batch, one array per item, `[op, id, ...]`. Visual
//! styles are turned into CSS here, so JS only assigns them: each distinct
//! CSS text is a class, `nsh-` and 8 hex digits of its hash
//! ([`class_key`]), defined once per page (`["css", name, text]`, before
//! the first item that uses it), so the browser parses it once, elements
//! carry no inline style but their geometry, and batches carry names.
//!
//! Native animation items stay in Rust ([`crate::animation::UiAnimation`]); the DOM
//! gets their results each frame.

use std::{cell::RefCell, fmt::Write as _};

use nsh_core::{
    BorderStyle, Color, Command, EventKind, Filter, Gradient, GradientKind, GradientSize,
    ImageSource, InputConfig, Keyframes, LayoutCurve, LayoutTransition, MountItem, NativeProps,
    ObjectPosition, Points, ResizeMode, ScreenAnimation, ScrollBehavior, Transform, TransformKind,
    TransitionProps, ViewKind, ViewProps, ViewStyle, WebSource,
    element::PropEnum,
    geometry::{DefiniteLength, REM_SIZE, Radians, Size, relative},
};
use rustc_hash::FxHashMap;

use crate::text::{WebLayout, css_font, font_variant_numeric};

/// JSON output.
pub(crate) struct Out {
    pub(crate) s: String,
    first: bool,
}

impl Out {
    pub(crate) fn new() -> Self {
        Out {
            s: String::from("["),
            first: true,
        }
    }

    /// Starts item `op`.
    fn item(&mut self, op: &str) -> &mut Self {
        if !self.first {
            self.s.push(',');
        }
        self.first = false;
        self.s.push_str("[\"");
        self.s.push_str(op);
        self.s.push('"');
        self
    }

    fn end(&mut self) {
        self.s.push(']');
    }

    fn num(&mut self, n: impl Into<f64>) -> &mut Self {
        let n = n.into();
        self.s.push(',');
        if n.is_finite() {
            // Points need no more than 1/1000 precision.
            let r = (n * 1000.0).round() / 1000.0;
            let _ = write!(self.s, "{r}");
        } else {
            self.s.push_str("null");
        }
        self
    }

    fn str(&mut self, v: &str) -> &mut Self {
        self.s.push(',');
        push_str(&mut self.s, v);
        self
    }

    fn opt_str(&mut self, v: Option<&str>) -> &mut Self {
        match v {
            Some(v) => self.str(v),
            None => self.raw("null"),
        }
    }

    fn bool(&mut self, v: bool) -> &mut Self {
        self.raw(if v { "true" } else { "false" })
    }

    fn raw(&mut self, json: &str) -> &mut Self {
        self.s.push(',');
        self.s.push_str(json);
        self
    }

    pub(crate) fn finish(mut self) -> String {
        self.s.push(']');
        self.s
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.first
    }

    /// An animation output: `["a", id, prop, value]`.
    pub(crate) fn animation(&mut self, id: u32, prop: &str, value: &str) {
        self.item("a").num(id).str(prop).str(value).end();
    }
}

/// New classes a view may define before its styles get rules of their own,
/// which are replaced as they change: a style animated from JS (a new CSS
/// text every frame) must not grow the stylesheet by a rule a frame.
const OWN_RULES_AFTER: u8 = 16;

/// The style classes defined in the page.
#[derive(Default)]
struct Classes {
    /// Class key -> a second hash of its text, which tells a collision.
    defined: FxHashMap<u32, u64>,
    /// How many classes each view defined (by node id).
    count: Vec<u8>,
}

thread_local! {
    static CLASSES: RefCell<Classes> = RefCell::new(Classes::default());
}

/// The key of the class of CSS text `css`: its 32-bit FNV-1a hash (as
/// `nsh.js` computes the names of the classes it makes itself).
fn class_key(css: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in css.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The 64-bit FNV-1a hash of `css`, which two texts with the same
/// [`class_key`] hardly share.
fn text_hash(css: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in css.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The class of a style.
#[derive(Clone, Copy)]
enum Class {
    /// No CSS.
    None,
    /// By content: `nsh-<8 hex digits of the key>`.
    Shared(u32),
    /// A view's own rule (`nsh.js` puts its player's prefix in front).
    Own(u32, Part),
}

/// Which of a view's styles.
#[derive(Clone, Copy)]
enum Part {
    View,
    Border,
    Text(usize),
    Selection,
    Field,
}

impl Out {
    /// The class of `css`, style `part` of view `id`, defining it first
    /// when the page does not have it.
    fn class(&mut self, id: u32, part: Part, css: &str) -> Class {
        if css.is_empty() {
            return Class::None;
        }
        let key = class_key(css);
        let hash = text_hash(css);
        // `Some(new)`: shared; `None`: the view's own rule.
        let shared = CLASSES.with(|c| {
            let mut c = c.borrow_mut();
            match c.defined.get(&key) {
                Some(&h) if h == hash => return Some(false),
                // Another text has this name.
                Some(_) => return None,
                None => {}
            }
            let i = id as usize;
            if c.count.len() <= i {
                c.count.resize(i + 1, 0);
            }
            if c.count[i] >= OWN_RULES_AFTER {
                return None;
            }
            c.count[i] += 1;
            c.defined.insert(key, hash);
            Some(true)
        });
        let class = match shared {
            Some(_) => Class::Shared(key),
            None => Class::Own(id, part),
        };
        if shared != Some(false) {
            self.item("css");
            self.class_arg(class).str(css).end();
        }
        class
    }

    fn push_class(&mut self, class: Class) {
        let _ = match class {
            Class::None => write!(self.s, "null"),
            Class::Shared(key) => write!(self.s, "\"nsh-{key:08x}\""),
            Class::Own(id, Part::View) => write!(self.s, "\"i{id}\""),
            Class::Own(id, Part::Border) => write!(self.s, "\"i{id}b\""),
            Class::Own(id, Part::Text(i)) => write!(self.s, "\"i{id}t{i}\""),
            Class::Own(id, Part::Selection) => write!(self.s, "\"i{id}s\""),
            Class::Own(id, Part::Field) => write!(self.s, "\"i{id}f\""),
        };
    }

    /// Appends a class (after [`Out::class`]).
    fn class_arg(&mut self, class: Class) -> &mut Self {
        self.s.push(',');
        self.push_class(class);
        self
    }
}

/// A view was deleted: its id's next view starts afresh.
fn forget_view(id: u32) {
    CLASSES.with(|c| {
        if let Some(n) = c.borrow_mut().count.get_mut(id as usize) {
            *n = 0;
        }
    });
}

fn push_str(out: &mut String, v: &str) {
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_str(v: &str) -> String {
    let mut s = String::new();
    push_str(&mut s, v);
    s
}

/// A CSS color.
pub(crate) fn css_color(c: Color) -> String {
    let v = c.0;
    let (r, g, b, a) = (v >> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    if a == 255 {
        format!("#{:02x}{:02x}{:02x}", r, g, b)
    } else {
        format!("rgba({r},{g},{b},{:.3})", a as f32 / 255.0)
    }
}

/// `FooBar` (a `Debug` name) as `foo-bar`.
fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn enum_name(v: &impl PropEnum) -> &'static str {
    v.js_name()
}

/// The CSS transform functions of a transform list (`value(i)` overrides
/// entry `i`).
pub(crate) fn css_transform(t: &Transform, value: impl Fn(usize) -> Option<f32>) -> String {
    let mut out = String::new();
    for (i, op) in t.ops().iter().enumerate() {
        let v = value(i).unwrap_or(op.value);
        let _ = match op.kind {
            TransformKind::TranslateX => write!(out, "translateX({v}px) "),
            TransformKind::TranslateY => write!(out, "translateY({v}px) "),
            TransformKind::TranslateXFraction => write!(out, "translateX({}%) ", v * 100.0),
            TransformKind::TranslateYFraction => write!(out, "translateY({}%) ", v * 100.0),
            TransformKind::Scale => write!(out, "scale({v}) "),
            TransformKind::ScaleX => write!(out, "scaleX({v}) "),
            TransformKind::ScaleY => write!(out, "scaleY({v}) "),
            TransformKind::Rotate => write!(out, "rotate({v}deg) "),
            TransformKind::RotateX => write!(out, "rotateX({v}deg) "),
            TransformKind::RotateY => write!(out, "rotateY({v}deg) "),
            TransformKind::SkewX => write!(out, "skewX({v}deg) "),
            TransformKind::SkewY => write!(out, "skewY({v}deg) "),
            TransformKind::Perspective => write!(out, "perspective({v}px) "),
        };
    }
    out
}

fn origin(o: DefiniteLength) -> String {
    match o {
        DefiniteLength::Absolute(v) => format!("{}px", v.to_points(REM_SIZE).0),
        DefiniteLength::Fraction(f) => format!("{}%", f.0 * 100.0),
    }
}

/// The CSS of `g`. Without lengths, the stops the core resolves, so the
/// browser places them as every platform does (a negative stop at 0);
/// with lengths, the stops as written (lengths in pixels), which only the
/// box resolves.
fn gradient(g: &Gradient) -> String {
    let stops: Vec<String> = if g.has_lengths() {
        g.stops
            .iter()
            .map(|s| match s.position {
                Some(DefiniteLength::Fraction(p)) => {
                    format!("{} {}%", css_color(s.color), p.0 * 100.0)
                }
                Some(DefiniteLength::Absolute(a)) => {
                    format!("{} {}px", css_color(s.color), a.to_points(REM_SIZE).0)
                }
                None => css_color(s.color),
            })
            .collect()
    } else {
        g.resolved_stops(Size::default())
            .iter()
            .map(|(c, p)| format!("{} {}%", css_color(*c), p.0 * 100.0))
            .collect()
    };
    let stops = stops.join(", ");
    let repeating = if g.repeating { "repeating-" } else { "" };
    match g.kind {
        GradientKind::Linear { angle } => {
            format!("{repeating}linear-gradient({}deg, {stops})", degrees(angle))
        }
        GradientKind::LinearCorner { right, bottom } => format!(
            "{repeating}linear-gradient(to {} {}, {stops})",
            if bottom { "bottom" } else { "top" },
            if right { "right" } else { "left" }
        ),
        GradientKind::Radial { circle, size, x, y } => {
            let size = match size {
                GradientSize::ClosestSide => "closest-side",
                GradientSize::ClosestCorner => "closest-corner",
                GradientSize::FarthestSide => "farthest-side",
                GradientSize::FarthestCorner => "farthest-corner",
            };
            format!(
                "{repeating}radial-gradient({} {size} at {}% {}%, {stops})",
                if circle { "circle" } else { "ellipse" },
                x.0 * 100.0,
                y.0 * 100.0
            )
        }
        GradientKind::Conic { from, x, y } => format!(
            "{repeating}conic-gradient(from {}deg at {}% {}%, {stops})",
            degrees(from),
            x.0 * 100.0,
            y.0 * 100.0
        ),
    }
}

/// An angle in CSS degrees, rounded to 1e-4 so that whole degrees are
/// written as the style wrote them (radians to degrees in `f32` can be an
/// ulp off).
fn degrees(a: Radians) -> f32 {
    (a.to_degrees() * 1e4).round() / 1e4
}

fn filters(list: &[Filter]) -> String {
    let mut out = String::new();
    for f in list {
        let _ = match *f {
            Filter::Blur(v) => write!(out, "blur({}px) ", v.0),
            Filter::Brightness(v) => write!(out, "brightness({v}) "),
            Filter::Contrast(v) => write!(out, "contrast({v}) "),
            Filter::Grayscale(v) => write!(out, "grayscale({v}) "),
            Filter::HueRotate(v) => write!(out, "hue-rotate({}deg) ", degrees(v)),
            Filter::Invert(v) => write!(out, "invert({v}) "),
            Filter::Opacity(v) => write!(out, "opacity({v}) "),
            Filter::Saturate(v) => write!(out, "saturate({v}) "),
            Filter::Sepia(v) => write!(out, "sepia({v}) "),
            Filter::DropShadow {
                offset_x,
                offset_y,
                blur,
                color,
            } => write!(
                out,
                "drop-shadow({}px {}px {}px {}) ",
                offset_x.0,
                offset_y.0,
                blur.0,
                css_color(color)
            ),
        };
    }
    out
}

fn bezier(e: [f32; 4]) -> String {
    format!("cubic-bezier({},{},{},{})", e[0], e[1], e[2], e[3])
}

/// The CSS of a view's visual style, and of its border overlay (drawn
/// over the children, as UIKit draws layer borders; also keeps borders
/// out of the content box, which layout already placed).
pub(crate) fn view_css(s: &ViewStyle) -> (String, Option<String>) {
    let mut css = String::new();
    if !s.background_color.is_transparent() {
        let _ = write!(css, "background-color:{};", css_color(s.background_color));
    }
    let radii: [f32; 4] = s
        .corner_radius
        .to_array()
        .map(|r| r.unwrap_or(s.border_radius).0);
    let radius = if radii.iter().any(|&r| r > 0.0) {
        format!(
            "border-radius:{}px {}px {}px {}px;",
            radii[0], radii[1], radii[2], radii[3]
        )
    } else {
        String::new()
    };
    css.push_str(&radius);
    if s.animation.is_some() {
        // Keyframes multiply the view's opacity (`--nsh-ko`, `nsh.js`).
        let _ = write!(css, "opacity:calc({}*var(--nsh-ko));", s.opacity);
    } else if s.opacity < 1.0 {
        let _ = write!(css, "opacity:{};", s.opacity);
    }
    // `clip`, not `hidden`: a hidden box is still a scroll container, which
    // the browser scrolls to bring a focused field into view, moving
    // content away from where the core laid it out.
    if s.overflow_hidden {
        css.push_str("overflow:clip;");
    }
    let mut shadows = Vec::new();
    if let Some(effects) = &s.effects {
        for b in &effects.box_shadows {
            shadows.push(format!(
                "{}{}px {}px {}px {}px {}",
                if b.inset { "inset " } else { "" },
                b.offset_x.0,
                b.offset_y.0,
                b.blur.0,
                b.spread.0,
                css_color(b.color)
            ));
        }
        if !effects.background_images.is_empty() {
            let images: Vec<String> = effects.background_images.iter().map(gradient).collect();
            let _ = write!(css, "background-image:{};", images.join(","));
        }
        if !effects.filters.is_empty() {
            let _ = write!(css, "filter:{};", filters(&effects.filters));
        }
        if !effects.backdrop_filters.is_empty() {
            let f = filters(&effects.backdrop_filters);
            let _ = write!(css, "backdrop-filter:{f};-webkit-backdrop-filter:{f};");
        }
        if !effects.mask_images.is_empty() {
            let images: Vec<String> = effects.mask_images.iter().map(gradient).collect();
            let m = images.join(",");
            // `-webkit-mask-image` for WebKit, which still needs the prefix.
            let _ = write!(css, "mask-image:{m};-webkit-mask-image:{m};");
        }
    }
    if !shadows.is_empty() {
        let _ = write!(css, "box-shadow:{};", shadows.join(","));
    }
    if !s.transform.is_identity() {
        let _ = write!(
            css,
            "transform:{};",
            css_transform(&s.transform, |_| None).trim_end()
        );
    }
    let o = s.transform_origin;
    if o.x != relative(0.5) || o.y != relative(0.5) {
        let _ = write!(css, "transform-origin:{} {};", origin(o.x), origin(o.y));
    }
    if s.backface_hidden {
        css.push_str("backface-visibility:hidden;");
    }
    let blend = kebab(&format!("{:?}", s.blend_mode));
    if blend != "normal" {
        let _ = write!(css, "mix-blend-mode:{blend};");
    }
    if s.outline.is_visible() {
        let _ = write!(
            css,
            "outline:{}px {} {};outline-offset:{}px;",
            s.outline.width.0,
            border_style(s.outline.style),
            css_color(s.outline.color),
            s.outline.offset.0
        );
    }
    if s.hidden {
        css.push_str("visibility:hidden;");
    }
    let cursor = kebab(&format!("{:?}", s.cursor));
    if cursor != "auto" {
        let _ = write!(css, "cursor:{cursor};");
    }
    let mut border_transition = String::new();
    if let Some(t) = &s.transition {
        let mut props = Vec::new();
        let p = t.properties;
        if p.has(TransitionProps::COLORS) {
            props.extend(["background-color", "outline-color"]);
        }
        if p.has(TransitionProps::OPACITY) {
            props.push("opacity");
        }
        if p.has(TransitionProps::TRANSFORM) {
            props.push("transform");
        }
        if p.has(TransitionProps::SHADOW) {
            props.push("box-shadow");
        }
        if p.has(TransitionProps::SHAPE) {
            props.extend(["border-radius", "outline-width"]);
        }
        let timing = format!(
            "transition-duration:{}ms;transition-delay:{}ms;transition-timing-function:{};",
            t.duration,
            t.delay,
            bezier(t.easing)
        );
        let _ = write!(css, "transition-property:{};{timing}", props.join(","));
        // The overlay draws the border.
        let mut border = Vec::new();
        if p.has(TransitionProps::COLORS) {
            border.push("border-color");
        }
        if p.has(TransitionProps::SHAPE) {
            border.extend(["border-width", "border-radius"]);
        }
        if !border.is_empty() {
            border_transition = format!("transition-property:{};{timing}", border.join(","));
        }
    }
    if let Some(a) = &s.animation {
        let name = match a.keyframes {
            Keyframes::Spin => "nsh-spin",
            Keyframes::Ping => "nsh-ping",
            Keyframes::Pulse => "nsh-pulse",
            Keyframes::Bounce => "nsh-bounce",
        };
        let iterations = a
            .iterations
            .map_or("infinite".to_owned(), |n| n.to_string());
        // Added to the view's own transform, as the native backends
        // apply keyframes after the style's transform.
        let _ = write!(
            css,
            "animation:{name} {}ms {} {}ms {iterations};animation-composition:add;",
            a.duration,
            bezier(a.easing),
            a.delay
        );
    }
    let b = &s.borders;
    let border = if b.widths.any(|&w| w > Points::ZERO) {
        let style = border_style(b.style);
        let sides = ["top", "right", "bottom", "left"];
        let mut out = String::new();
        for ((side, width), color) in sides.iter().zip(b.widths.to_array()).zip(b.colors) {
            let width = width.0;
            let _ = write!(
                out,
                "border-{side}-width:{width}px;border-{side}-style:{style};border-{side}-color:{};",
                css_color(color)
            );
        }
        out.push_str(&radius);
        out.push_str(&border_transition);
        Some(out)
    } else {
        None
    };
    (css, border)
}

fn border_style(s: BorderStyle) -> &'static str {
    match s {
        BorderStyle::Solid => "solid",
        BorderStyle::Dashed => "dashed",
        BorderStyle::Dotted => "dotted",
    }
}

fn kind_name(kind: ViewKind) -> &'static str {
    match kind {
        ViewKind::View => "view",
        ViewKind::Text => "text",
        ViewKind::Image => "image",
        ViewKind::Scroll => "scroll",
        ViewKind::Input => "input",
        ViewKind::Stack => "stack",
        ViewKind::Screen => "screen",
        ViewKind::Modal => "modal",
        ViewKind::HeaderItem => "header",
        ViewKind::InputAccessory => "accessory",
        ViewKind::Canvas => "canvas",
        ViewKind::WebView => "web",
        ViewKind::Native => "native",
        ViewKind::Video => "video",
    }
}

fn image_uri(s: &Option<ImageSource>) -> Option<&str> {
    s.as_ref().map(|s| &*s.uri)
}

/// An image's `objectPosition` as CSS, empty for the center (the default).
fn object_position(p: ObjectPosition) -> String {
    if p == ObjectPosition::CENTER {
        String::new()
    } else {
        p.to_string()
    }
}

fn resize_mode(m: ResizeMode) -> &'static str {
    match m {
        ResizeMode::Cover => "cover",
        ResizeMode::Contain => "contain",
        ResizeMode::Stretch => "fill",
        // Centered at its natural size.
        ResizeMode::Center => "none",
        // The same, scaled down to fit when larger.
        ResizeMode::ScaleDown => "scale-down",
    }
}

fn text_css(style: &nsh_core::ResolvedTextStyle, shadow: Option<&nsh_core::TextShadow>) -> String {
    let mut css = format!("font:{};color:{};", css_font(style), css_color(style.color));
    if style.letter_spacing.0 != 0.0 {
        let _ = write!(css, "letter-spacing:{}px;", style.letter_spacing.0);
    }
    let d = style.decoration;
    if !d.is_none() {
        let lines = match (d.underline, d.line_through) {
            (true, true) => "underline line-through",
            (true, false) => "underline",
            _ => "line-through",
        };
        let _ = write!(
            css,
            "text-decoration:{lines} {};",
            kebab(&format!("{:?}", style.decoration_style))
        );
        if let Some(c) = style.decoration_color {
            let _ = write!(css, "text-decoration-color:{};", css_color(c));
        }
        if let Some(t) = style.decoration_thickness.map(|t| t.0) {
            let _ = write!(css, "text-decoration-thickness:{t}px;");
        }
        if let Some(o) = style.underline_offset.map(|o| o.0) {
            let _ = write!(css, "text-underline-offset:{o}px;");
        }
    }
    if let Some(numeric) = font_variant_numeric(style.font_variant) {
        let _ = write!(css, "font-variant-numeric:{numeric};");
    }
    if style.font_variant.0 & nsh_core::FontVariant::SMALL_CAPS != 0 {
        css.push_str("font-variant-caps:small-caps;");
    }
    if let Some(s) = shadow
        && !s.color.is_transparent()
    {
        let _ = write!(
            css,
            "text-shadow:{}px {}px {}px {};",
            s.offset_x.0,
            s.offset_y.0,
            s.radius.0,
            css_color(s.color)
        );
    }
    css
}

fn props_json(p: &ViewProps) -> String {
    let a = &p.accessibility;
    let mut s = String::from("{");
    let _ = write!(
        s,
        "\"pointerEvents\":{}",
        json_str(enum_name(&p.pointer_events))
    );
    let h = p.hit_slop;
    let _ = write!(
        s,
        ",\"hitSlop\":[{},{},{},{}]",
        h.top.0, h.right.0, h.bottom.0, h.left.0
    );
    if let Some(d) = p.long_press_delay {
        let _ = write!(s, ",\"longPressDelay\":{d}");
    }
    if let Some(a) = p.pan_activation {
        let n = |v: Option<f32>| v.map_or("null".to_owned(), |v| v.to_string());
        let _ = write!(
            s,
            ",\"panActivation\":[{},{},{},{}]",
            n(a.active_offset_x.map(|v| v.0)),
            n(a.active_offset_y.map(|v| v.0)),
            n(a.fail_offset_x.map(|v| v.0)),
            n(a.fail_offset_y.map(|v| v.0))
        );
    }
    if let Some(l) = &a.label {
        let _ = write!(s, ",\"label\":{}", json_str(l));
    }
    if let Some(h) = &a.hint {
        let _ = write!(s, ",\"hint\":{}", json_str(h));
    }
    let _ = write!(
        s,
        ",\"role\":{}",
        json_str(&kebab(&format!("{:?}", a.role)))
    );
    if a.state.disabled {
        s.push_str(",\"disabled\":true");
    }
    if a.state.selected {
        s.push_str(",\"selected\":true");
    }
    if let Some(c) = a.state.checked {
        let _ = write!(s, ",\"checked\":{}", json_str(&kebab(&format!("{c:?}"))));
    }
    if a.state.busy {
        s.push_str(",\"busy\":true");
    }
    if let Some(e) = a.state.expanded {
        let _ = write!(s, ",\"expanded\":{e}");
    }
    if let Some(v) = &a.value {
        let n = |v: Option<f32>| v.map_or("null".to_owned(), |v| v.to_string());
        let _ = write!(
            s,
            ",\"value\":[{},{},{},{}]",
            n(v.min),
            n(v.max),
            n(v.now),
            v.text.as_deref().map_or("null".to_owned(), json_str)
        );
    }
    if a.live_region != nsh_core::LiveRegion::None {
        let _ = write!(
            s,
            ",\"live\":{}",
            json_str(&kebab(&format!("{:?}", a.live_region)))
        );
    }
    if a.hidden {
        s.push_str(",\"hidden\":true");
    }
    if let Some(t) = &p.test_id {
        let _ = write!(s, ",\"testID\":{}", json_str(t));
    }
    // Unset leaves it to the presses (`ViewProps::focus_stop`).
    if let Some(focusable) = p.focusable {
        let _ = write!(s, ",\"focusable\":{focusable}");
    }
    if p.selectable_view {
        s.push_str(",\"selectableView\":true");
    }
    s.push('}');
    s
}

fn input_json(c: &InputConfig) -> String {
    let mut s = String::from("{");
    let _ = write!(
        s,
        "\"placeholder\":{},\"secure\":{},\"keyboard\":{},\"returnKey\":{},\"multiline\":{},\"editable\":{},\"submit\":{},\"autoFocus\":{},\"autoCapitalize\":{},\"autoCorrect\":{},\"placeholderColor\":{}",
        json_str(&c.placeholder),
        c.secure,
        json_str(enum_name(&c.keyboard)),
        json_str(enum_name(&c.return_key)),
        c.multiline,
        c.editable,
        json_str(enum_name(&c.submit())),
        c.auto_focus,
        json_str(enum_name(&c.auto_capitalize)),
        c.auto_correct,
        c.placeholder_color.is_some(),
    );
    if let Some(m) = c.max_length {
        let _ = write!(s, ",\"maxLength\":{m}");
    }
    if c.paste_behavior != nsh_core::PasteBehavior::Insert {
        s.push_str(",\"pasteInserts\":false");
    }
    s.push('}');
    s
}

/// The CSS of a field's text: its style, alignment, line height, the
/// placeholder's color (`--ph`) and the caret's.
fn field_css(c: &InputConfig) -> String {
    let mut css = text_css(&c.style, None);
    match c.align {
        nsh_core::TextAlign::Center => css.push_str("text-align:center;"),
        nsh_core::TextAlign::Right => css.push_str("text-align:right;"),
        _ => css.push_str("text-align:left;"),
    }
    if c.style.line_height.0 > 0.0 {
        let _ = write!(css, "line-height:{}px;", c.style.line_height.0);
    }
    if let Some(c) = c.placeholder_color {
        let _ = write!(css, "--ph:{};", css_color(c));
    }
    if let Some(c) = c.caret_color {
        let _ = write!(css, "caret-color:{};", css_color(c));
    }
    css
}

fn behavior_json(b: &ScrollBehavior) -> String {
    let offsets: Vec<String> = b.snap_offsets.iter().map(|o| o.0.to_string()).collect();
    format!(
        "{{\"paging\":{},\"snapInterval\":{},\"snapOffsets\":[{}],\"snapAlignment\":{},\"enabled\":{},\"bounces\":{},\"inset\":[{},{},{},{}],\"minZoom\":{},\"maxZoom\":{},\"bouncesZoom\":{},\"pinch\":{},\"centerContent\":{},\"refreshIndicator\":{}}}",
        b.paging,
        b.snap_interval.0,
        offsets.join(","),
        json_str(enum_name(&b.snap_alignment)),
        b.enabled,
        b.bounces,
        b.content_inset.top.0,
        b.content_inset.right.0,
        b.content_inset.bottom.0,
        b.content_inset.left.0,
        b.min_zoom,
        b.max_zoom,
        b.bounces_zoom,
        b.pinch,
        b.center_content,
        b.refresh_indicator
            .map_or("null".to_owned(), |h| format!("{{\"height\":{}}}", h.0))
    )
}

fn transition_json(t: &Option<LayoutTransition>) -> String {
    match t {
        None => "null".to_owned(),
        Some(t) => {
            // UIKit's curves, which CSS's keywords are.
            let easing = match t.curve {
                LayoutCurve::Linear => "linear".to_owned(),
                LayoutCurve::EaseIn => "ease-in".to_owned(),
                LayoutCurve::EaseOut => "ease-out".to_owned(),
                LayoutCurve::EaseInEaseOut | LayoutCurve::Keyboard => "ease-in-out".to_owned(),
                LayoutCurve::Spring { damping } => spring_easing(damping),
            };
            format!(
                "{{\"duration\":{},\"delay\":{},\"easing\":{},\"property\":{}}}",
                t.duration_ms,
                t.delay_ms,
                json_str(&easing),
                json_str(&kebab(&format!("{:?}", t.property)))
            )
        }
    }
}

/// A damped spring from 0 to 1 at `x` (the fraction of the duration), its
/// stiffness chosen so that it settles by the end, as UIKit's
/// `usingSpringWithDamping` fits a spring into the given duration (the
/// Linux backend's curve).
fn spring(damping: f32, x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // The envelope falls to 1/1000 by the end.
    const SETTLE: f32 = 6.907_755; // ln(1000)
    let zeta = damping.clamp(0.05, 1.0);
    if zeta > 0.999 {
        // Critically damped: (1 + w x) e^(-w x) reaches 1/1000 at w = 9.23.
        let w = 9.233;
        return 1.0 - (1.0 + w * x) * (-w * x).exp();
    }
    let w = SETTLE / zeta;
    let wd = w * (1.0 - zeta * zeta).sqrt();
    let envelope = (-zeta * w * x).exp();
    1.0 - envelope * ((wd * x).cos() + zeta * w / wd * (wd * x).sin())
}

/// Samples of the spring as a CSS `linear()` easing (piecewise linear,
/// enough points that the overshoot keeps its shape).
fn spring_easing(damping: f32) -> String {
    const SAMPLES: usize = 48;
    let mut out = String::from("linear(0");
    for i in 1..=SAMPLES {
        let v = spring(damping, i as f32 / SAMPLES as f32);
        let _ = write!(out, ",{}", (v * 1000.0).round() / 1000.0);
    }
    out.push(')');
    out
}

/// Appends `item` (all but the animation items, which the caller keeps).
pub(crate) fn encode(out: &mut Out, item: &MountItem) {
    match item {
        MountItem::Create { id, kind } => {
            out.item("c").num(*id).str(kind_name(*kind)).end();
        }
        MountItem::TrackStates { id, states } => {
            out.item("ts").num(*id).num(*states).end();
        }
        MountItem::Insert {
            parent,
            child,
            before,
        } => {
            out.item("i").num(*parent).num(*child);
            match before {
                Some(b) => out.num(*b),
                None => out.raw("null"),
            };
            out.end();
        }
        MountItem::Remove { id } => out.item("r").num(*id).end(),
        MountItem::ProjectRoot {
            parent,
            id,
            following,
        } => {
            out.item("pr")
                .num(*parent)
                .num(*id)
                .raw(&serde_json::to_string(following).expect("node ids serialize as JSON"))
                .end();
        }
        MountItem::RetireListCell { id, request, roots } => {
            out.item("rc")
                .num(*id)
                .str(&request.to_string())
                .raw(&serde_json::to_string(roots).expect("node ids serialize as JSON"))
                .end();
        }
        MountItem::Delete { id } => {
            forget_view(*id);
            out.item("d").num(*id).end();
        }
        MountItem::Frame { id, frame } => {
            out.item("f")
                .num(*id)
                .num(frame.origin.x.0)
                .num(frame.origin.y.0)
                .num(frame.size.width.0)
                .num(frame.size.height.0)
                .end();
        }
        MountItem::ViewStyle { id, style } => {
            let (css, border) = view_css(style);
            let class = out.class(*id, Part::View, &css);
            let border = match &border {
                Some(border) => out.class(*id, Part::Border, border),
                None => Class::None,
            };
            out.item("s").num(*id).class_arg(class).class_arg(border);
            match style.tint_color {
                Some(c) => out.str(&css_color(c)),
                None => out.raw("null"),
            };
            out.end();
        }
        MountItem::Text {
            id,
            text,
            layout,
            content,
        } => {
            let layout = layout.downcast::<WebLayout>();
            // Defined before the item that uses them. A line box as tall
            // as the font: the baseline sits at the run's top plus its
            // ascent, where layout put it.
            let classes: Vec<Class> = layout.map_or_else(Vec::new, |layout| {
                layout
                    .styles
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let css = format!(
                            "{}line-height:{}px;",
                            text_css(&s.style, text.shadow.as_ref()),
                            s.ascent + s.descent
                        );
                        out.class(*id, Part::Text(i), &css)
                    })
                    .collect()
            });
            let selection = match text.selection_color {
                Some(c) => out.class(
                    *id,
                    Part::Selection,
                    &format!("--nsh-selection:{};", css_color(c)),
                ),
                None => Class::None,
            };
            out.item("t")
                .num(*id)
                .num(content.origin.x.0)
                .num(content.origin.y.0)
                .num(content.size.width.0)
                .num(content.size.height.0);
            let Some(layout) = layout else {
                out.raw("[]").raw("[]").end();
                return;
            };
            out.s.push_str(",[");
            for (i, run) in layout.runs.iter().enumerate() {
                if i > 0 {
                    out.s.push(',');
                }
                let _ = write!(out.s, "[{},{},", run.x, run.y);
                push_str(&mut out.s, &run.text);
                let _ = write!(out.s, ",{}", run.style);
                if !run.after.is_empty() {
                    out.s.push(',');
                    push_str(&mut out.s, &run.after);
                }
                out.s.push(']');
            }
            out.s.push_str("],[");
            for (i, class) in classes.into_iter().enumerate() {
                if i > 0 {
                    out.s.push(',');
                }
                out.push_class(class);
            }
            out.s.push(']');
            match text.selectable {
                Some(on) => out.bool(on),
                None => out.raw("null"),
            };
            out.class_arg(selection);
            if !layout.backgrounds.is_empty() {
                // Span backgrounds: `[x, y, width, height, radius, color]`.
                out.s.push_str(",[");
                for (i, b) in layout.backgrounds.iter().enumerate() {
                    if i > 0 {
                        out.s.push(',');
                    }
                    let _ = write!(
                        out.s,
                        "[{},{},{},{},{},",
                        b.x, b.y, b.width, b.height, b.radius
                    );
                    push_str(&mut out.s, &css_color(b.color));
                    out.s.push(']');
                }
                out.s.push(']');
            }
            out.end();
        }
        MountItem::Events { id, events } => {
            out.item("e").num(*id);
            out.s.push_str(",[");
            let mut first = true;
            for kind in EventKind::ALL {
                if events.contains(*kind) {
                    if !first {
                        out.s.push(',');
                    }
                    first = false;
                    push_str(&mut out.s, kind.prop_name());
                }
            }
            out.s.push(']');
            out.end();
        }
        MountItem::Image {
            id,
            source,
            resize_mode: mode,
            options,
        } => {
            out.item("img")
                .num(*id)
                .opt_str(image_uri(source))
                .str(resize_mode(*mode))
                .opt_str(image_uri(&options.placeholder))
                .num(options.blur_radius.0)
                .num(options.fade_ms.unwrap_or(0.0))
                // CSS's `object-position`; empty for the center.
                .str(&object_position(options.position))
                .end();
        }
        MountItem::ScrollConfig {
            id,
            horizontal,
            scrollbar_visible,
            mirrored,
            ..
        } => {
            out.item("sc")
                .num(*id)
                .bool(*horizontal)
                .bool(*scrollbar_visible)
                .bool(*mirrored)
                .end();
        }
        MountItem::ScrollContent { id, size } => {
            out.item("scs")
                .num(*id)
                .num(size.width.0)
                .num(size.height.0)
                .end();
        }
        MountItem::ScrollBy { id, dx, dy } => {
            out.item("sb").num(*id).num(dx.0).num(dy.0).end();
        }
        MountItem::LayoutDirection { rtl } => out.item("dir").bool(*rtl).end(),
        MountItem::Appearance { appearance } => out.item("appearance").num(*appearance as u8).end(),
        MountItem::StickyCells { id, cells } => {
            out.item("sticky").num(*id);
            out.s.push_str(",[");
            for (i, c) in cells.iter().enumerate() {
                if i > 0 {
                    out.s.push(',');
                }
                let end = if c.end.is_finite() { c.end.0 } else { 1e9 };
                let _ = write!(out.s, "[{},{},{}]", c.cell, c.start.0, end);
            }
            out.s.push(']');
            out.end();
        }
        MountItem::ScrollBehavior { id, behavior } => {
            out.item("sbh").num(*id).raw(&behavior_json(behavior)).end();
        }
        MountItem::Refreshing { id, refreshing } => {
            out.item("ref").num(*id).bool(*refreshing).end();
        }
        MountItem::Canvas { id, drawing } => {
            out.item("cv")
                .num(*id)
                .raw(&crate::canvas::encode(drawing))
                .end();
        }
        MountItem::Gestures { id, values } => {
            out.item("g")
                .num(*id)
                .bool(values.pan_x.is_some() || values.pan_y.is_some())
                .bool(values.pinch.is_some())
                .bool(values.rotation.is_some())
                .end();
        }
        MountItem::ViewProps { id, props } => {
            out.item("vp").num(*id).raw(&props_json(props)).end();
        }
        MountItem::AccessibilityLabel { id, label } => {
            out.item("al").num(*id).opt_str(label.as_deref()).end();
        }
        MountItem::LayoutAnimation(a) => {
            out.item("la")
                .raw(&transition_json(&a.create))
                .raw(&transition_json(&a.update))
                .raw(&transition_json(&a.delete))
                .end();
        }
        MountItem::Input { id, config } => {
            let class = out.class(*id, Part::Field, &field_css(config));
            out.item("in")
                .num(*id)
                .raw(&input_json(config))
                .class_arg(class)
                .end();
        }
        MountItem::InputValue { id, text, count } => {
            out.item("iv").num(*id).str(text).num(*count).end();
        }
        MountItem::InputContent { id, content } => {
            out.item("ic")
                .num(*id)
                .num(content.origin.x.0)
                .num(content.origin.y.0)
                .num(content.size.width.0)
                .num(content.size.height.0)
                .end();
        }
        MountItem::ScreenConfig { id, config } => {
            // NSH draws no header: the page's `header` view, placed by the
            // core, is all there is.
            out.item("scr")
                .num(*id)
                .num(config.header_height.0)
                .bool(config.prevent_back);
            match config.header_view {
                Some(n) => out.num(n),
                None => out.raw("null"),
            };
            out.str(match config.animation {
                ScreenAnimation::Default => "default",
                ScreenAnimation::Fade => "fade",
                ScreenAnimation::None => "none",
            })
            .end();
        }
        MountItem::ModalConfig { id, config } => {
            out.item("mc")
                .num(*id)
                .str(enum_name(&config.animation))
                .bool(config.close_on_escape)
                .end();
        }
        MountItem::NativeProps { id, props } => match props {
            NativeProps::WebView(w) => {
                let (url, html, base) = match &w.source {
                    WebSource::Uri(u) => (Some(&**u), None, None),
                    WebSource::Html { html, base_url } => {
                        (None, Some(&**html), base_url.as_deref())
                    }
                    _ => (None, None, None),
                };
                out.item("web")
                    .num(*id)
                    .opt_str(url)
                    .opt_str(html)
                    .opt_str(base)
                    .opt_str(w.injected_js_before.as_deref())
                    .opt_str(w.injected_js.as_deref())
                    .bool(w.scrollable)
                    .bool(w.javascript_enabled)
                    .end();
            }
            NativeProps::Video(v) => {
                out.item("video")
                    .num(*id)
                    .opt_str(v.source.as_deref())
                    .bool(v.paused)
                    .bool(v.muted)
                    .num(v.volume)
                    .num(v.rate)
                    .bool(v.repeat)
                    .str(resize_mode(v.resize_mode))
                    .bool(v.controls)
                    .num(v.progress_interval_ms)
                    .end();
            }
        },
        MountItem::Command { id, command } => encode_command(out, *id, command),
        MountItem::Component { id, name } => out.item("comp").num(*id).str(name).end(),
        // Browsers hit-test what overflows a box themselves; the keymap
        // stays in Rust (`nsh_key`).
        // No registered native components on the web.
        MountItem::ComponentProps { .. }
        | MountItem::ListCellRetired { .. }
        | MountItem::ComponentPropSlots { .. }
        | MountItem::Keymap(_)
        | MountItem::Overflow { .. }
        | MountItem::AnimationBindings { .. }
        | MountItem::Animation(_) => {}
    }
}

fn encode_command(out: &mut Out, id: u32, command: &Command) {
    match command {
        Command::Focus => out.item("cmd").num(id).str("focus").end(),
        Command::Blur => out.item("cmd").num(id).str("blur").end(),
        Command::ScrollTo { x, y, animated } => {
            out.item("cmd")
                .num(id)
                .str("scrollTo")
                .num(x.0)
                .num(y.0)
                .bool(*animated)
                .end();
        }
        Command::ScrollToEnd { animated } => {
            out.item("cmd")
                .num(id)
                .str("scrollToEnd")
                .bool(*animated)
                .end();
        }
        Command::SetSelection { start, end } => {
            out.item("cmd")
                .num(id)
                .str("setSelection")
                .num(*start)
                .num(*end)
                .end();
        }
        Command::Dialog(d) => {
            out.item("cmd").num(id).str("dialog").num(d.id);
            out.opt_str(d.title.as_deref())
                .opt_str(d.message.as_deref());
            out.s.push_str(",[");
            for (i, b) in d.buttons.iter().enumerate() {
                if i > 0 {
                    out.s.push(',');
                }
                push_str(&mut out.s, &b.text);
            }
            out.s.push_str("],[");
            for (i, b) in d.buttons.iter().enumerate() {
                if i > 0 {
                    out.s.push(',');
                }
                push_str(&mut out.s, &kebab(&format!("{:?}", b.style)));
            }
            out.s.push(']');
            out.bool(d.cancelable).bool(d.sheet).end();
        }
        Command::SetJsResponder { block } => {
            out.item("cmd")
                .num(id)
                .str("setResponder")
                .bool(*block)
                .end();
        }
        Command::ClearJsResponder => out.item("cmd").num(id).str("clearResponder").end(),
        Command::Reload => out.item("cmd").num(id).str("reload").end(),
        Command::GoBack => out.item("cmd").num(id).str("goBack").end(),
        Command::GoForward => out.item("cmd").num(id).str("goForward").end(),
        Command::PostMessage(m) => out.item("cmd").num(id).str("postMessage").str(m).end(),
        Command::InjectJavaScript(s) => {
            out.item("cmd").num(id).str("injectJavaScript").str(s).end();
        }
        Command::Back => out.item("cmd").num(id).str("back").end(),
        Command::ExitApp => out.item("cmd").num(id).str("exitApp").end(),
        Command::Announce(text) => out.item("cmd").num(id).str("announce").str(text).end(),
        Command::AccessibilityFocus => out.item("cmd").num(id).str("a11yFocus").end(),
        Command::Seek(t) => out.item("cmd").num(id).str("seek").num(*t).end(),
        Command::ZoomTo {
            scale,
            center,
            animated,
        } => {
            out.item("cmd").num(id).str("zoomTo").num(*scale);
            match center {
                Some(c) => out.num(c.x.0).num(c.y.0),
                None => out.raw("null").raw("null"),
            };
            out.bool(*animated).end();
        }
        Command::SetClipboard(text) => out.item("cmd").num(id).str("setClipboard").str(text).end(),
        Command::OpenUrl { id: request, url } => out
            .item("cmd")
            .num(id)
            .str("openUrl")
            .num(*request)
            .str(url)
            .end(),
        Command::ReadClipboard {
            id: request,
            has_only,
        } => {
            out.item("cmd")
                .num(id)
                .str("readClipboard")
                .num(*request)
                .bool(*has_only)
                .end();
        }
        Command::SetClipboardImage(uri) => out
            .item("cmd")
            .num(id)
            .str("setClipboardImage")
            .str(uri)
            .end(),
        Command::ReadClipboardImage {
            id: request,
            has_only,
        } => {
            out.item("cmd")
                .num(id)
                .str("readClipboardImage")
                .num(*request)
                .bool(*has_only)
                .end();
        }
        Command::ReadClipboardFiles { id: request } => {
            out.item("cmd")
                .num(id)
                .str("readClipboardFiles")
                .num(*request)
                .end();
        }
        // `nsh.js` `pickImages`: the request, the limit, the longest side
        // (0: any), the quality (-1: none), whether the stored format is
        // asked for.
        Command::PickImages {
            id: request,
            request: asked,
        } => {
            out.item("cmd")
                .num(id)
                .str("pickImages")
                .num(*request)
                .num(asked.limit)
                .num(asked.max_dimension.map_or(0, |d| d.0.max(1)))
                .num(asked.quality.map_or(-1.0, |q| q.0))
                .bool(asked.format == nsh_core::picker::PickFormat::Current)
                .end();
        }
        // The id is written whole (`num` rounds); the page answers with
        // `onHost` `{ type: "reply" }` (`nsh.js` `hostCall`).
        Command::HostCall {
            id: request,
            name,
            args,
        } => {
            out.item("cmd")
                .num(id)
                .str("hostCall")
                .raw(&request.to_string())
                .str(name)
                .raw(&args.to_string())
                .end();
        }
        Command::ImageInfo { id: request, uri } => {
            out.item("cmd")
                .num(id)
                .str("imageInfo")
                .num(*request)
                .str(uri)
                .end();
        }
        // A browser's bars are the browser's.
        Command::StatusBar(_) => {}
        other => log::debug!("web: command {other:?} is not supported"),
    }
}
