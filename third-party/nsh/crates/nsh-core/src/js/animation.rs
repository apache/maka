//! The easings of native animations and the layout animations, as JS
//! passes them (`Easing.quad`, `LayoutAnimation.Presets.spring`): their
//! names, parameters and defaults in one table each, from which they are
//! decoded, `nsh/animated` is made (`nsh-js` `animated.rs`) and
//! `animation.gen.ts` (the declarations) is generated. Keyframes and
//! motions (`Animated.keyframes`, `createMotion`, `motions`) are decoded
//! here too, and their presets come from `animation::PRESETS`.

use std::fmt::Write as _;

use super::host::{HostCx, HostInput, HostList, HostValue, field};
use crate::{
    LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition,
    animation::{
        Composite, Curve, EaseMode, Easing, Keyframe, KeyframeTiming, MotionChannel, MotionPreset,
        MotionSpec, NodeId, PRESETS as MOTIONS, PlaybackDirection, StaggerFrom, StepPosition,
        keyframes,
    },
    ui::TsTypes,
};

/// A curve of `Easing`: its name, its parameter (name and default) and
/// documentation.
struct CurveSpec {
    name: &'static str,
    param: Option<(&'static str, f32)>,
    make: fn(f32) -> Curve,
    doc: &'static str,
}

const CURVES: &[CurveSpec] = &[
    CurveSpec {
        name: "quad",
        param: None,
        make: |_| Curve::Quad,
        doc: "`t²`.",
    },
    CurveSpec {
        name: "cubic",
        param: None,
        make: |_| Curve::Cubic,
        doc: "`t³`.",
    },
    CurveSpec {
        name: "poly",
        param: Some(("n", 2.0)),
        make: Curve::Poly,
        doc: "`tⁿ`.",
    },
    CurveSpec {
        name: "sin",
        param: None,
        make: |_| Curve::Sin,
        doc: "Sinusoidal.",
    },
    CurveSpec {
        name: "circle",
        param: None,
        make: |_| Curve::Circle,
        doc: "Circular.",
    },
    CurveSpec {
        name: "exp",
        param: None,
        make: |_| Curve::Exp,
        doc: "Exponential.",
    },
    CurveSpec {
        name: "elastic",
        param: Some(("bounciness", 1.0)),
        make: Curve::Elastic,
        doc: "Springy overshoot.",
    },
    CurveSpec {
        name: "back",
        param: Some(("s", 1.70158)),
        make: Curve::Back,
        doc: "Pulls back before going; `s` is the overshoot.",
    },
    CurveSpec {
        name: "bounce",
        param: None,
        make: |_| Curve::Bounce,
        doc: "Bounces at the end.",
    },
];

/// The easings by name.
const NAMED: &[(&str, Easing)] = &[
    ("linear", Easing::Linear),
    // CSS / React Native `ease`.
    ("ease", Easing::Bezier(0.25, 0.1, 0.25, 1.0)),
    ("easeIn", Easing::EaseIn),
    ("easeOut", Easing::EaseOut),
    ("easeInOut", Easing::EaseInOut),
];

/// A name, a cubic Bézier `[x1, y1, x2, y2]`, `{ curve, param, mode }` or
/// `{ steps, position }`; `None` for anything else (the animation's
/// default).
pub fn easing<I: HostInput>(input: &I) -> Option<Easing> {
    if let Some(list) = input.as_list() {
        let p = |i| list.item(i).and_then(|v| v.as_number()).unwrap_or(0.0) as f32;
        return Some(Easing::Bezier(p(0), p(1), p(2), p(3)));
    }
    if let Some(steps) = input.field("steps").and_then(|n| n.as_number()) {
        let position = input
            .field("position")
            .and_then(|p| p.as_string())
            .and_then(|p| StepPosition::parse(&p))
            .unwrap_or_default();
        return Some(Easing::Steps(steps.clamp(1.0, 10_000.0) as u32, position));
    }
    if input.is_object() {
        let name = input.field("curve").and_then(|c| c.as_string())?;
        let spec = CURVES.iter().find(|c| c.name == name)?;
        let param = input.field("param").and_then(|p| p.as_number());
        let curve = (spec.make)(param.map_or_else(
            || spec.param.map_or(0.0, |(_, default)| default),
            |p| p as f32,
        ));
        let mode = match input.field("mode").and_then(|m| m.as_string()).as_deref() {
            Some("out") => EaseMode::Out,
            Some("inOut") => EaseMode::InOut,
            _ => EaseMode::In,
        };
        return Some(Easing::Curve(curve, mode));
    }
    let name = input.as_string()?;
    NAMED.iter().find(|(n, _)| *n == name).map(|&(_, e)| e)
}

/// A keyframe's value: a number, or an angle (`"45deg"`, `"0.5turn"`,
/// `"1rad"`) in degrees.
fn keyframe_value<I: HostInput>(input: &I) -> Option<f32> {
    match input.as_number() {
        Some(n) => Some(n as f32).filter(|n| n.is_finite()),
        None => crate::css::angle(&input.as_string()?),
    }
}

/// Keyframes of one value: numbers (spread evenly) or `{ offset?, value,
/// easing? }`.
pub fn keyframe_list<I: HostInput>(input: &I) -> Vec<Keyframe> {
    input
        .items()
        .iter()
        .filter_map(|item| {
            if let Some(value) = keyframe_value(item) {
                return Some(Keyframe::new(value));
            }
            let mut frame = Keyframe::new(keyframe_value(&item.field("value")?)?);
            frame.offset = item
                .field("offset")
                .and_then(|o| o.as_number())
                .map(|o| o as f32);
            frame.easing = item.field("easing").and_then(|e| easing(&e));
            Some(frame)
        })
        .collect()
}

/// How keyframes play: `{ duration, delay, easing, iterations, direction
/// }` (CSS's defaults: 300 ms, `ease`, once, `normal`).
pub fn keyframe_timing<I: HostInput>(input: &I) -> KeyframeTiming {
    let number = |key| {
        input
            .field(key)
            .and_then(|v| v.as_number())
            .filter(|n| n.is_finite())
            .map(|n| n as f32)
    };
    let defaults = KeyframeTiming::default();
    let iterations = match input.field("iterations") {
        Some(v) if v.as_string().as_deref() == Some("infinite") => None,
        Some(v) => match v.as_number() {
            Some(n) if n.is_infinite() && n > 0.0 => None,
            Some(n) if n.is_finite() => Some(n.max(0.0).round().min(u32::MAX as f64) as u32),
            _ => defaults.iterations,
        },
        None => defaults.iterations,
    };
    KeyframeTiming {
        duration_ms: number("duration").map_or(defaults.duration_ms, |d| d.max(0.0)),
        delay_ms: number("delay").map_or(0.0, |d| d.max(0.0)),
        easing: input
            .field("easing")
            .and_then(|e| easing(&e))
            .unwrap_or(defaults.easing),
        iterations,
        direction: input
            .field("direction")
            .and_then(|d| d.as_string())
            .and_then(|d| PlaybackDirection::parse(&d))
            .unwrap_or_default(),
    }
}

/// `Animated.keyframes(value, config)`'s tree on `node`: `config` is `{
/// keyframes, duration, delay, easing, iterations, direction }`.
pub fn keyframes_composite<I: HostInput>(input: &I, node: NodeId) -> Composite {
    let frames = input
        .field("keyframes")
        .map(|k| keyframe_list(&k))
        .unwrap_or_default();
    keyframes(node, &frames, &keyframe_timing(input))
}

/// A motion: a preset's name, or `{ keyframes, ...timing }` where
/// `keyframes` is an object of channels' keyframes (`{ opacity: [0, 1] }`)
/// or a list of frames of channels (`[{ opacity: 0 }, { opacity: 1,
/// offset: 1, easing }]`, as the Web Animations API's). Unknown channels
/// are left out.
pub fn motion_spec<I: HostInput>(input: &I) -> Option<MotionSpec> {
    if let Some(name) = input.as_string() {
        return MotionPreset::parse(&name).map(MotionPreset::spec);
    }
    if !input.is_object() {
        return None;
    }
    let mut spec = MotionSpec::new(keyframe_timing(input));
    let frames = input.field("keyframes")?;
    if frames.as_list().is_some() {
        // Frames of channels: each channel's keyframes are the frames that
        // name it, with the frame's offset and easing.
        let items = frames.items();
        let count = items.len();
        for channel in MotionChannel::ALL {
            let mut track = Vec::new();
            for (i, item) in items.iter().enumerate() {
                let Some(value) = item.field(channel.name()).and_then(|v| keyframe_value(&v))
                else {
                    continue;
                };
                let offset = item
                    .field("offset")
                    .and_then(|o| o.as_number())
                    .map(|o| o as f32);
                // A frame without an offset sits where its index puts it,
                // so channels missing from some frames stay in step.
                let offset = offset.or_else(|| match count {
                    1 => Some(1.0),
                    n => Some(i as f32 / (n - 1) as f32),
                });
                track.push(Keyframe {
                    offset,
                    easing: item.field("easing").and_then(|e| easing(&e)),
                    ..Keyframe::new(value)
                });
            }
            if !track.is_empty() {
                spec = spec.track(channel, track);
            }
        }
    } else {
        for (name, value) in frames.entries() {
            if let Some(channel) = MotionChannel::parse(&name) {
                let track = keyframe_list(&value);
                if !track.is_empty() {
                    spec = spec.track(channel, track);
                }
            }
        }
    }
    Some(spec)
}

/// Where a staggered group counts from: `"first"`, `"last"`, `"center"` or
/// an item's index.
pub fn stagger_from<I: HostInput>(input: &I) -> StaggerFrom {
    if let Some(index) = input.as_number() {
        return StaggerFrom::Index(index.max(0.0) as usize);
    }
    match input.as_string().as_deref() {
        Some("last") => StaggerFrom::Last,
        Some("center") => StaggerFrom::Center,
        _ => StaggerFrom::First,
    }
}

/// Makes a layout curve (from `springDamping`).
type MakeLayoutCurve = fn(f32) -> LayoutCurve;

/// The curves of layout animation phases (`type`), by name; the first is
/// the default.
const LAYOUT_TYPES: &[(&str, MakeLayoutCurve)] = &[
    ("easeInEaseOut", |_| LayoutCurve::EaseInEaseOut),
    ("spring", |damping| LayoutCurve::Spring { damping }),
    ("linear", |_| LayoutCurve::Linear),
    ("easeIn", |_| LayoutCurve::EaseIn),
    ("easeOut", |_| LayoutCurve::EaseOut),
    ("keyboard", |_| LayoutCurve::Keyboard),
];

/// What appearing and disappearing views animate (`property`), by name
/// (and alias: `false`); the first is the default.
const LAYOUT_PROPERTIES: &[(&str, LayoutProperty, bool)] = &[
    ("opacity", LayoutProperty::Opacity, true),
    ("scaleXY", LayoutProperty::Scale, true),
    ("scale", LayoutProperty::Scale, false),
];

/// React Native's default damping of layout springs.
const SPRING_DAMPING: f32 = 0.7;

/// One phase of `{ duration, create, update, delete }`.
fn transition<I: HostInput>(part: &I, duration: f32, cx: &mut HostCx) -> LayoutTransition {
    // The entry named by `key`, or the first.
    let named = |key, names: &mut dyn Iterator<Item = &'static str>| {
        let name = part.field(key).and_then(|v| v.as_string());
        let mut at = 0;
        for (i, n) in names.enumerate() {
            if Some(n) == name.as_deref() {
                at = i;
                break;
            }
        }
        at
    };
    let damping = field::<f32, _>(part, "springDamping", cx)
        .unwrap_or(SPRING_DAMPING)
        .clamp(0.01, 1.0);
    let curve = LAYOUT_TYPES[named("type", &mut LAYOUT_TYPES.iter().map(|t| t.0))].1(damping);
    let property =
        LAYOUT_PROPERTIES[named("property", &mut LAYOUT_PROPERTIES.iter().map(|p| p.0))].1;
    LayoutTransition {
        curve,
        property,
        duration_ms: field(part, "duration", cx).unwrap_or(duration),
        delay_ms: field(part, "delay", cx).unwrap_or(0.0),
    }
}

/// `LayoutAnimation.configureNext(config)`: `{ duration, create, update,
/// delete }`, each phase `{ type, property, duration, delay, springDamping
/// }` (without one, that kind of change is not animated).
impl HostValue for LayoutAnimation {
    fn decode<I: HostInput>(input: &I, cx: &mut HostCx) -> Option<Self> {
        let duration = field(input, "duration", cx).unwrap_or(300.0);
        let mut phase = |key| {
            input
                .field(key)
                .filter(|p| p.is_object())
                .map(|p| transition(&p, duration, cx))
        };
        Some(LayoutAnimation {
            create: phase("create"),
            update: phase("update"),
            delete: phase("delete"),
        })
    }

    fn ts_type(types: &mut TsTypes) -> String {
        let union = |names: &mut dyn Iterator<Item = &str>| {
            names
                .map(|n| format!("{n:?}"))
                .collect::<Vec<_>>()
                .join(" | ")
        };
        let curve = types.declare("LayoutAnimationType", |_| {
            format!(
                "/** The curve of a layout animation phase (`type`). */\nexport type LayoutAnimationType = {};",
                union(&mut LAYOUT_TYPES.iter().map(|t| t.0))
            )
        });
        let property = types.declare("LayoutAnimationProperty", |_| {
            format!(
                "/** What appearing and disappearing views animate (`property`). */\n\
                 export type LayoutAnimationProperty = {};",
                union(&mut LAYOUT_PROPERTIES.iter().map(|p| p.0))
            )
        });
        types.declare("LayoutAnimationAnimation", |_| {
            format!(
                "/** How one kind of change animates. */\nexport interface LayoutAnimationAnimation {{\n  \
                 type?: {curve};\n  /** What appearing and disappearing views animate. */\n  \
                 property?: {property};\n  /** Milliseconds (the config's by default). */\n  \
                 duration?: number;\n  delay?: number;\n  /** The `spring`'s damping ratio, 0..1 \
                 ({SPRING_DAMPING} by default; 1 does not overshoot). */\n  springDamping?: number;\n}}"
            )
        });
        types.declare("LayoutAnimationConfig", |_| {
            "/** What the next commit's changes animate: views inserted (`create`), moved or \
             resized (`update`) and removed (`delete`). */\nexport interface LayoutAnimationConfig {\n  \
             /** Milliseconds. */\n  duration: number;\n  create?: LayoutAnimationAnimation;\n  \
             update?: LayoutAnimationAnimation;\n  delete?: LayoutAnimationAnimation;\n}"
                .into()
        })
    }
}

/// The presets, by their JS names.
const PRESETS: &[(&str, LayoutAnimation)] = &[
    ("easeInEaseOut", LayoutAnimation::EASE_IN_EASE_OUT),
    ("linear", LayoutAnimation::LINEAR),
    ("spring", LayoutAnimation::SPRING),
];

/// The declarations of the easing and layout animation types (`nsh/animated`
/// declares the values: `Easing`, `LayoutAnimation`).
pub fn declarations() -> String {
    let mut types = TsTypes::default();
    let layout = <LayoutAnimation as HostValue>::ts_type(&mut types);
    let names = |list: &mut dyn Iterator<Item = &str>| {
        list.map(|n| format!("{n:?}"))
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let mut out = String::new();
    let _ = write!(
        out,
        "/** The curves of `Easing` (their \"in\" form; `Easing.out` / `inOut` turn them around). */\n\
         export type EasingCurveName = {};\n\n\
         /** A curve of the `Easing` module. */\n\
         export interface EasingCurve {{\n  curve: EasingCurveName;\n  param?: number;\n  mode: \"in\" | \"out\" | \"inOut\";\n}}\n\n\
         /** CSS `steps()`: jumps between `steps` levels instead of moving. */\n\
         export interface EasingSteps {{\n  steps: number;\n  position?: StepPosition;\n}}\n\n\
         /** Where a `steps()` curve jumps (CSS's `<step-position>`; `\"jump-end\"` by default). */\n\
         export type StepPosition = \"jump-start\" | \"jump-end\" | \"jump-none\" | \"jump-both\" | \"start\" | \"end\";\n\n\
         /** How a timing animation (or an interpolation segment) progresses: a name, a cubic\n \
         * Bézier `[x1, y1, x2, y2]`, a curve from `Easing` or `Easing.steps(…)`. */\n\
         export type Easing = {} | [number, number, number, number] | EasingCurve | EasingSteps;\n",
        names(&mut CURVES.iter().map(|c| c.name)),
        names(&mut NAMED.iter().map(|(n, _)| *n)),
    );
    out.push_str("\n/** `Easing`'s curves. */\nexport interface EasingCurves {\n");
    for c in CURVES {
        match c.param {
            Some((p, default)) => {
                let _ = writeln!(
                    out,
                    "  /** {} `{p}`: {default} by default. */\n  {}({p}?: number): EasingCurve;",
                    c.doc, c.name
                );
            }
            None => {
                let _ = writeln!(out, "  /** {} */\n  {}: EasingCurve;", c.doc, c.name);
            }
        }
    }
    out.push_str("}\n");
    for declaration in types.declarations() {
        let _ = write!(out, "\n{declaration}\n");
    }
    let _ = write!(
        out,
        "\n/** Ready-made layout animations. */\nexport interface LayoutAnimationPresets {{\n{}}}\n",
        PRESETS
            .iter()
            .map(|(name, _)| format!("  {name}: {layout};\n"))
            .collect::<String>()
    );
    out.push_str(&motion_declarations());
    // `LayoutAnimation.Types` / `Properties`: each name as itself.
    let object = |iface: &str, doc: &str, names: &mut dyn Iterator<Item = &str>| {
        let fields: String = names.map(|n| format!("  readonly {n}: {n:?};\n")).collect();
        format!("\n/** {doc} */\nexport interface {iface} {{\n{fields}}}\n")
    };
    out.push_str(&object(
        "LayoutAnimationTypes",
        "The curves, by name.",
        &mut LAYOUT_TYPES.iter().map(|t| t.0),
    ));
    out.push_str(&object(
        "LayoutAnimationProperties",
        "The properties, by name.",
        &mut LAYOUT_PROPERTIES.iter().filter(|p| p.2).map(|p| p.0),
    ));
    out
}

/// The declarations of channels, keyframes and the presets' names.
fn motion_declarations() -> String {
    let mut out = String::new();
    let channels = MotionChannel::ALL
        .iter()
        .map(|c| format!("{:?}", c.name()))
        .collect::<Vec<_>>()
        .join(" | ");
    let _ = write!(
        out,
        "\n/** What a motion moves: the opacity and the parts of the transform (translations in points,\n \
         * rotations in degrees), applied translations first, then rotations, then scales. */\n\
         export type MotionChannel = {channels};\n"
    );
    out.push_str("\n/** The ready-made motions:\n");
    for preset in MOTIONS {
        let _ = writeln!(
            out,
            " * - `{}` ({}):{}",
            preset.name,
            preset.kind.name(),
            preset.doc
        );
    }
    out.push_str(" */\nexport type MotionName =\n");
    for preset in MOTIONS {
        let _ = writeln!(out, "  | {:?}", preset.name);
    }
    out.push_str("  ;\n");
    out
}

/// A preset as JS data (as `motions.<name>`): `{ kind, keyframes: {
/// channel: [{ offset, value }] }, duration, easing, iterations, direction
/// }`, which `motion_spec` reads back.
fn motion_json(preset: &crate::animation::PresetDef) -> crate::JsonValue {
    use serde_json::{Map, Value, json};
    let spec = preset.spec();
    let mut keyframes = Map::new();
    for (channel, frames) in &spec.tracks {
        keyframes.insert(
            channel.name().into(),
            Value::Array(
                frames
                    .iter()
                    .map(|f| json!({ "offset": f.offset, "value": f.value }))
                    .collect(),
            ),
        );
    }
    let t = spec.timing;
    json!({
        "kind": preset.kind.name(),
        "keyframes": keyframes,
        "duration": t.duration_ms,
        "easing": easing_json(t.easing),
        "iterations": match t.iterations {
            Some(n) => json!(n),
            None => json!("infinite"),
        },
        "direction": t.direction.name(),
    })
}

/// An easing as JS passes it (what `easing` decodes).
fn easing_json(e: Easing) -> crate::JsonValue {
    use serde_json::json;
    match e {
        Easing::Linear => json!("linear"),
        Easing::EaseIn => json!("easeIn"),
        Easing::EaseOut => json!("easeOut"),
        Easing::EaseInOut => json!("easeInOut"),
        Easing::Bezier(a, b, c, d) => json!([a, b, c, d]),
        Easing::Curve(curve, mode) => {
            let (name, param) = match curve {
                Curve::Quad => ("quad", None),
                Curve::Cubic => ("cubic", None),
                Curve::Poly(n) => ("poly", Some(n)),
                Curve::Sin => ("sin", None),
                Curve::Circle => ("circle", None),
                Curve::Exp => ("exp", None),
                Curve::Elastic(b) => ("elastic", Some(b)),
                Curve::Back(s) => ("back", Some(s)),
                Curve::Bounce => ("bounce", None),
            };
            let mode = match mode {
                EaseMode::In => "in",
                EaseMode::Out => "out",
                EaseMode::InOut => "inOut",
            };
            json!({ "curve": name, "param": param, "mode": mode })
        }
        Easing::Steps(steps, position) => json!({ "steps": steps, "position": position.name() }),
    }
}

/// The easing and layout animation tables as data for `nsh/animated`
/// (`nsh-js` `animated.rs`): `curves` (`[name, parameter,
/// default]`, the parameter `null` for curves without one), `presets`
/// (name -> config, as `LayoutAnimation.Presets`), `types` and
/// `properties` (the names of `LayoutAnimation.Types` / `Properties`),
/// `motions` (name -> motion, as `motions`).
pub fn tables() -> crate::JsonValue {
    use serde_json::{Map, Value, json};
    let transition = |t: &LayoutTransition| {
        let (kind, damping) = match t.curve {
            LayoutCurve::Linear => ("linear", None),
            LayoutCurve::EaseIn => ("easeIn", None),
            LayoutCurve::EaseOut => ("easeOut", None),
            LayoutCurve::EaseInEaseOut => ("easeInEaseOut", None),
            LayoutCurve::Spring { damping } => ("spring", Some(damping)),
            LayoutCurve::Keyboard => ("keyboard", None),
        };
        let property = match t.property {
            LayoutProperty::Opacity => "opacity",
            LayoutProperty::Scale => "scaleXY",
        };
        let mut o = json!({
            "type": kind,
            "property": property,
            "duration": t.duration_ms,
            "delay": t.delay_ms,
        });
        if let Some(d) = damping {
            o["springDamping"] = json!(d);
        }
        o
    };
    let mut presets = Map::new();
    for (name, preset) in PRESETS {
        let duration = [preset.create, preset.update, preset.delete]
            .iter()
            .flatten()
            .map(|t| t.duration_ms + t.delay_ms)
            .fold(0.0, f32::max);
        let mut o = Map::new();
        o.insert("duration".into(), json!(duration));
        for (key, phase) in [
            ("create", &preset.create),
            ("update", &preset.update),
            ("delete", &preset.delete),
        ] {
            if let Some(t) = phase {
                o.insert(key.into(), transition(t));
            }
        }
        presets.insert((*name).into(), Value::Object(o));
    }
    json!({
        "curves": CURVES
            .iter()
            .map(|c| match c.param {
                Some((p, default)) => json!([c.name, p, default]),
                None => json!([c.name, null, null]),
            })
            .collect::<Vec<_>>(),
        "presets": presets,
        "types": LAYOUT_TYPES.iter().map(|t| t.0).collect::<Vec<_>>(),
        "properties": LAYOUT_PROPERTIES.iter().filter(|p| p.2).map(|p| p.0).collect::<Vec<_>>(),
        "motions": MOTIONS
            .iter()
            .map(|p| (p.name.to_string(), motion_json(p)))
            .collect::<Map<String, Value>>(),
    })
}
