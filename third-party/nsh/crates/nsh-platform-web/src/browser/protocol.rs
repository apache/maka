//! Decoding of JS values into the core's types: props and styles
//! ([`decode_prop`]), commands ([`decode_command`]), animation operations
//! ([`decode_animation_op`], as `nsh/animated` encodes them) and JSON
//! ([`to_json`]).

use nsh_core::{
    Color, Command, EventKind, LayoutAnimation, NodeId, Op, Prop, Style, StyleDecl, StyleError,
    StylePatch, StyleValue, TransformKind, TransformProperty,
    animation::{AnimationOp, AnimationProp, Driver, Easing, Extrapolate, MathOp, Operand, Output},
    geometry::{Percentage, Points, point},
    js::{
        host::{HostCx, HostInput, HostList, HostProps, HostValue},
        protocol::*,
    },
};
use rustc_hash::FxHashSet;

use super::{
    compat,
    compat::{Array, Ctx, Exception, Object, Type, Value},
};

/// Reports each distinct problem once, so a bad style in a list does not
/// flood the log.
#[derive(Default)]
pub(crate) struct Warnings {
    seen: FxHashSet<String>,
    /// Collecting for [`Warnings::merge`] instead of logging.
    deferred: Option<Vec<String>>,
}

impl Warnings {
    /// Warnings that are only collected, to be merged into the VM's
    /// (when decoding runs JS that may itself decode).
    pub(crate) fn deferred() -> Warnings {
        Warnings {
            seen: FxHashSet::default(),
            deferred: Some(Vec::new()),
        }
    }

    pub(crate) fn warn(&mut self, message: String) {
        if let Some(pending) = &mut self.deferred {
            pending.push(message);
        } else if self.seen.len() < 1024 && self.seen.insert(message.clone()) {
            log::warn!("{message}");
        }
    }

    /// Whether `message` was reported (tests).
    #[cfg(test)]
    pub(crate) fn reported(&self, message: &str) -> bool {
        self.seen.contains(message)
    }

    /// Logs what `other` collected and was not reported yet.
    pub(crate) fn merge(&mut self, other: Warnings) {
        for message in other.deferred.unwrap_or_default() {
            self.warn(message);
        }
    }
}

struct Reader<'a, 'js> {
    cx: &'a Ctx<'js>,
    buf: &'a Array<'js>,
    pos: usize,
}

impl<'js> Reader<'_, 'js> {
    #[inline]
    fn value(&mut self) -> compat::Result<Value<'js>> {
        let v = self.buf.get::<Value>(self.pos)?;
        self.pos += 1;
        Ok(v)
    }

    #[inline]
    fn int(&mut self) -> compat::Result<i32> {
        let v = self.value()?;
        v.as_int()
            .or_else(|| v.as_float().map(|f| f as i32))
            .ok_or_else(|| Exception::throw_type(self.cx, "nsh/animated: expected an integer"))
    }

    #[inline]
    fn number(&mut self) -> compat::Result<f32> {
        let v = self.value()?;
        v.as_number()
            .map(|n| n as f32)
            .ok_or_else(|| Exception::throw_type(self.cx, "nsh/animated: expected a number"))
    }

    fn numbers(&mut self) -> compat::Result<Vec<f32>> {
        let v = self.value()?;
        let Some(items) = v.as_array() else {
            return Err(Exception::throw_type(
                self.cx,
                "nsh/animated: expected an array",
            ));
        };
        items.iter::<f64>().map(|v| v.map(|v| v as f32)).collect()
    }

    /// A math operand: a number or an animated value.
    fn operand(&mut self) -> compat::Result<Operand> {
        let v = self.value()?;
        match (v.as_number(), animated_value(&v)) {
            (Some(n), _) => Ok(Operand::Const(n as f32)),
            (_, Some(node)) => Ok(Operand::Node(node)),
            _ => Err(Exception::throw_type(
                self.cx,
                "nsh/animated: expected a number or animated value",
            )),
        }
    }

    #[inline]
    fn string(&mut self) -> compat::Result<String> {
        let v = self.value()?;
        match v.as_string() {
            Some(s) => s.to_string(),
            None => Err(Exception::throw_type(
                self.cx,
                "nsh/animated: expected a string",
            )),
        }
    }
}

/// Decodes an animation operation, encoded as `nsh/animated` builds it
/// (`ANIMATION_*`, the node, then the operation's values).
pub(crate) fn decode_animation_op<'js>(
    cx: &Ctx<'js>,
    buf: &Array<'js>,
) -> compat::Result<AnimationOp> {
    decode_animation(&mut Reader { cx, buf, pos: 0 })
}

/// The command `name` with argument `arg` sends to a node's view (`None`:
/// an unknown command).
pub(crate) fn decode_command<'js>(name: &str, arg: Value<'js>) -> compat::Result<Option<Command>> {
    Ok(Some(match name {
        "focus" => Command::Focus,
        "blur" => Command::Blur,
        "reload" => Command::Reload,
        "goBack" => Command::GoBack,
        "goForward" => Command::GoForward,
        "stopLoading" => Command::StopLoading,
        "injectJavaScript" => Command::InjectJavaScript(string(&arg)?),
        "postMessage" => Command::PostMessage(string(&arg)?),
        "seek" => Command::Seek(arg.as_number().unwrap_or(0.0)),
        "native" => {
            let o = arg.as_object();
            let name = o
                .as_ref()
                .and_then(|o| o.get::<_, Option<String>>("name").ok().flatten())
                .unwrap_or_default();
            let args = match o.map(|o| o.get::<_, Value>("args")).transpose()? {
                Some(args) => to_json(&args)?,
                None => nsh_core::JsonValue::Null,
            };
            Command::Native {
                name: name.into(),
                args,
            }
        }
        "setJsResponder" => Command::SetJsResponder {
            block: arg.as_bool().unwrap_or(true),
        },
        "clearJsResponder" => Command::ClearJsResponder,
        "setSelection" => {
            let field = |key: &str| {
                arg.as_object()
                    .and_then(|o| o.get::<_, Option<f64>>(key).ok().flatten())
                    .unwrap_or(0.0)
                    .max(0.0) as u32
            };
            Command::SetSelection {
                start: field("start"),
                end: field("end"),
            }
        }
        "scrollToIndex" => {
            let o = arg.as_object();
            let f = |key: &str| -> compat::Result<Option<f32>> {
                o.as_ref().map_or(Ok(None), |o| field_f32(o, key))
            };
            Command::ScrollToIndex {
                index: f("index")?.unwrap_or(0.0).max(0.0) as u32,
                animated: o
                    .as_ref()
                    .and_then(|o| o.get::<_, Option<bool>>("animated").ok().flatten())
                    .unwrap_or(true),
                view_position: Percentage(f("viewPosition")?.unwrap_or(0.0)),
                view_offset: Points(f("viewOffset")?.unwrap_or(0.0)),
            }
        }
        "scrollToEnd" => Command::ScrollToEnd {
            animated: arg
                .as_object()
                .and_then(|o| o.get::<_, Option<bool>>("animated").ok().flatten())
                .unwrap_or(true),
        },
        "layoutAnimation" => Command::LayoutAnimation(
            <LayoutAnimation as HostValue>::decode(&Js(arg), &mut HostCx::default())
                .unwrap_or_default(),
        ),
        "zoomTo" => {
            let field = |key: &str| {
                arg.as_object()
                    .and_then(|o| o.get::<_, Option<f64>>(key).ok().flatten())
            };
            Command::ZoomTo {
                scale: field("scale").unwrap_or(1.0) as f32,
                center: field("x")
                    .zip(field("y"))
                    .map(|(x, y)| point(Points(x as f32), Points(y as f32))),
                animated: arg
                    .as_object()
                    .and_then(|o| o.get::<_, Option<bool>>("animated").ok().flatten())
                    .unwrap_or(true),
            }
        }
        "scrollTo" => {
            let field = |key: &str| {
                arg.as_object()
                    .and_then(|o| o.get::<_, Option<f64>>(key).ok().flatten())
            };
            Command::ScrollTo {
                x: Points(field("x").unwrap_or(0.0) as f32),
                y: Points(field("y").unwrap_or(0.0) as f32),
                animated: arg
                    .as_object()
                    .and_then(|o| o.get::<_, Option<bool>>("animated").ok().flatten())
                    .unwrap_or(true),
            }
        }
        _ => return Ok(None),
    }))
}

/// Reads the node id of an animated value object (`{ __av: id }`).
pub(crate) fn animated_value(value: &Value<'_>) -> Option<nsh_core::animation::NodeId> {
    value
        .as_object()?
        .get::<_, Option<u32>>("__av")
        .ok()
        .flatten()
}

fn number(value: &Value<'_>) -> Option<f32> {
    value.as_number().map(|n| n as f32)
}

/// A string prop; anything else (null, undefined) is the empty string.
fn string(value: &Value<'_>) -> compat::Result<String> {
    match value.as_string() {
        Some(s) => s.to_string(),
        None => Ok(String::new()),
    }
}

fn field_f32(obj: &Object<'_>, key: &str) -> compat::Result<Option<f32>> {
    Ok(obj.get::<_, Option<f64>>(key)?.map(|v| v as f32))
}

/// A QuickJS value as host props read it.
struct Js<'js>(Value<'js>);

/// A QuickJS array, read by index.
struct JsList<'js>(Array<'js>);

impl<'js> HostList for JsList<'js> {
    type Item = Js<'js>;

    #[inline]
    fn len(&self) -> usize {
        self.0.len()
    }

    #[inline]
    fn item(&self, index: usize) -> Option<Js<'js>> {
        self.0.get::<Value>(index).ok().map(Js)
    }
}

impl<'js> HostInput for Js<'js> {
    #[inline]
    fn is_nullish(&self) -> bool {
        self.0.is_null() || self.0.is_undefined()
    }

    #[inline]
    fn is_object(&self) -> bool {
        self.0.is_object()
    }

    #[inline]
    fn as_bool(&self) -> Option<bool> {
        self.0.as_bool()
    }

    #[inline]
    fn as_number(&self) -> Option<f64> {
        self.0.as_number()
    }

    #[inline]
    fn as_string(&self) -> Option<String> {
        self.0.as_string().and_then(|s| s.to_string().ok())
    }

    fn field(&self, key: &str) -> Option<Self> {
        let value: Value = self.0.as_object()?.get(key).ok()?;
        (!value.is_undefined()).then_some(Js(value))
    }

    type List = JsList<'js>;

    #[inline]
    fn as_list(&self) -> Option<JsList<'js>> {
        self.0.as_array().map(JsList)
    }

    fn entries(&self) -> Vec<(String, Self)> {
        match self.0.as_object() {
            Some(o) => o
                .props::<String, Value>()
                .filter_map(|e| e.ok())
                .map(|(k, v)| (k, Js(v)))
                .collect(),
            None => Vec::new(),
        }
    }

    #[inline]
    fn truthy(&self) -> bool {
        truthy(&self.0)
    }

    fn node(&self) -> Option<NodeId> {
        self.0.node()
    }
}

/// The op setting prop `name` to `value`: a style, a registered native
/// component's prop, one of the core's host props or an event listener.
/// `tag` is the element's, when known: it picks the prop of a name several
/// elements share (`src`, `placeholder`).
pub(crate) fn decode_prop<'js>(
    id: NodeId,
    tag: Option<nsh_core::Tag>,
    name: &str,
    value: Value<'js>,
    warnings: &mut Warnings,
) -> compat::Result<Option<Op>> {
    // A registered native component's own props: `$name`, any JSON value,
    // or an animated value the platform pushes to it on every frame.
    if let Some(key) = name.strip_prefix('$') {
        if let Some(node) = animated_value(&value) {
            return Ok(Some(Op::SetProp {
                id,
                prop: Prop::ComponentPropBinding(key.into(), Some(node)),
            }));
        }
        let value = if value.is_undefined() {
            None
        } else {
            Some(to_json(&value)?)
        };
        return Ok(Some(Op::SetProp {
            id,
            prop: Prop::ComponentProp(key.into(), value),
        }));
    }
    if name == "style" {
        let mut entries = Vec::new();
        style_entries(&value, &mut entries)?;
        let (style, patch) = decode_style(entries, warnings)?;
        return Ok(Some(Op::SetStyle { id, style, patch }));
    }
    let mut cx = tag.map_or_else(HostCx::default, HostCx::for_element);
    let input = Js(value);
    let decoded = <Prop as HostProps>::decode(name, &input, &mut cx);
    for message in cx.warnings {
        warnings.warn(message);
    }
    match decoded {
        Some(prop) => Ok(prop.map(|prop| Op::SetProp { id, prop })),
        None => {
            if let Some(event) = EventKind::from_handler(name) {
                return Ok(Some(Op::Listen {
                    id,
                    event,
                    enabled: input.0.as_bool().unwrap_or(false),
                }));
            }
            warnings.warn(format!("unsupported prop `{name}`"));
            Ok(None)
        }
    }
}

/// Style `value` (an object or an array of them) as a host element's
/// `style` decodes it: its declarations.
pub(crate) fn style_patch<'js>(
    value: &Value<'js>,
    warnings: &mut Warnings,
) -> compat::Result<StylePatch> {
    let mut entries = Vec::new();
    style_entries(value, &mut entries)?;
    Ok(decode_style(entries, warnings)?.1)
}

/// The properties of a style: an object, or (React Native style) an array
/// of styles, possibly nested, merged left to right; falsy entries are
/// skipped. A property set by a later style replaces it whole.
fn style_entries<'js>(
    value: &Value<'js>,
    out: &mut Vec<(String, Value<'js>)>,
) -> compat::Result<()> {
    if let Some(items) = value.as_array() {
        for item in items.iter::<Value>() {
            style_entries(&item?, out)?;
        }
    } else if let Some(obj) = value.as_object() {
        for prop in obj.props::<String, Value>() {
            let (key, value) = prop?;
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = value,
                None => out.push((key, value)),
            }
        }
    }
    Ok(())
}

fn decode_style<'js>(
    entries: Vec<(String, Value<'js>)>,
    warnings: &mut Warnings,
) -> compat::Result<(Box<Style>, StylePatch)> {
    let mut style = Box::<Style>::default();
    let mut patch = StylePatch::default();
    for (key, value) in entries {
        // `undefined` sets nothing (`color: active ? c : undefined`): the
        // class's value, or the default, stays, as in a spread object.
        if value.is_undefined() {
            continue;
        }
        if (key == "boxShadow" || key == "textShadow")
            && let Some(layers) = value.as_array()
        {
            // The structured form: the same layers as the string's.
            match shadow_list(&key, &layers) {
                Ok(css) => {
                    if let Err(e) = patch.set(&mut style, &key, StyleValue::Str(&css)) {
                        warnings.warn(format!("style `{key}`: {e:?}"));
                    }
                }
                Err(message) => warnings.warn(format!("style `{key}`: {message}")),
            }
            continue;
        }
        if key == "transform"
            && let Some(items) = value.as_array()
        {
            // The list of steps, which CSS's string cannot hold with
            // animated values.
            decode_transform_list(&items, &mut style, &mut patch, warnings)?;
            continue;
        }
        if let Some((property, axes)) = transform_property(&key) {
            // `[x, y]`, or an animated value: the bridge's forms, which CSS's
            // string cannot hold.
            let steps = match value.as_array() {
                Some(items) => match transform_axes(&key, &items, axes, warnings)? {
                    Some(steps) => Some(steps),
                    None => continue,
                },
                None => animated_value(&value)
                    .map(|node| vec![(axes[0], axes[0].identity(), Some(node))]),
            };
            if let Some(steps) = steps {
                let decl = StyleDecl::SetTransform(property, steps.into());
                if patch.push(&mut style, decl).is_err() {
                    warnings.warn(format!(
                        "too many transforms (at most {})",
                        nsh_core::MAX_TRANSFORMS
                    ));
                }
                continue;
            }
        }
        if (key == "fontVariant" || key == "transformOrigin")
            && let Some(items) = value.as_array()
        {
            // Arrays of names / coordinates: the string form.
            let mut words = Vec::new();
            for item in items.iter::<Value>() {
                let item = item?;
                if let Some(n) = item.as_number() {
                    words.push(format!("{n}px"));
                } else if let Some(s) = item.as_string() {
                    words.push(s.to_string()?);
                }
            }
            let joined = words.join(" ");
            if let Err(e) = patch.set(&mut style, &key, StyleValue::Str(&joined)) {
                warnings.warn(format!("style `{key}`: {e:?}"));
            }
            continue;
        }
        if let Some(node) = animated_value(&value) {
            match AnimationProp::from_name(&key) {
                Some(prop) => {
                    let _ = patch.push(&mut style, StyleDecl::Animated(prop, node));
                }
                None => warnings.warn(format!("style `{key}` cannot be animated natively")),
            }
            continue;
        }
        let string;
        let v = match value.type_of() {
            Type::Float => StyleValue::Number(value.as_number().unwrap_or_default() as f32),
            Type::String => {
                string = value.as_string().expect("string").to_string()?;
                StyleValue::Str(&string)
            }
            Type::Null | Type::Undefined => StyleValue::Null,
            _ => {
                warnings.warn(format!("style `{key}`: unsupported value type"));
                continue;
            }
        };
        match patch.set(&mut style, &key, v) {
            Ok(()) => {}
            Err(StyleError::UnknownProperty) => {
                warnings.warn(format!("unsupported style property `{key}`"))
            }
            Err(StyleError::InvalidValue) => {
                warnings.warn(format!("invalid value for style `{key}`: {v:?}"))
            }
        }
    }
    Ok((style, patch))
}

/// `boxShadow` / `textShadow` as a list of layers (`{ x, y, blur, spread,
/// color, inset }`; a text shadow has no spread and no inset), written as
/// the CSS the string form takes, so both forms mean the same (a layer
/// without a color is the text color). A field of the wrong kind drops the
/// whole value.
fn shadow_list(key: &str, layers: &compat::Array<'_>) -> Result<String, String> {
    let boxed = key == "boxShadow";
    let mut out = Vec::new();
    for layer in layers.iter::<Value>() {
        let layer = layer.map_err(|e| e.to_string())?;
        let object = layer
            .as_object()
            .ok_or_else(|| "a layer is an object".to_owned())?;
        let (mut x, mut y, mut blur, mut spread) = (None, None, 0.0, 0.0);
        let (mut color, mut inset) = (None, false);
        for entry in object.props::<String, Value>() {
            let (field, value) = entry.map_err(|e| e.to_string())?;
            if value.is_undefined() {
                continue;
            }
            let length = || {
                if animated_value(&value).is_some() {
                    return Err(format!("`{field}` cannot be animated natively"));
                }
                number(&value).ok_or_else(|| format!("`{field}` is a number"))
            };
            match field.as_str() {
                "x" => x = Some(length()?),
                "y" => y = Some(length()?),
                "blur" => blur = length()?.max(0.0),
                "spread" if boxed => spread = length()?,
                "color" => {
                    let c = value
                        .as_string()
                        .and_then(|s| s.to_string().ok())
                        .ok_or_else(|| "`color` is a color string".to_owned())?;
                    color = Some(c);
                }
                "inset" if boxed => {
                    inset = value
                        .as_bool()
                        .ok_or_else(|| "`inset` is a boolean".to_owned())?;
                }
                _ => return Err(format!("unsupported field `{field}`")),
            }
        }
        let (Some(x), Some(y)) = (x, y) else {
            return Err("a layer needs `x` and `y`".to_owned());
        };
        let mut css = String::new();
        if inset {
            css.push_str("inset ");
        }
        css.push_str(&format!("{x}px {y}px {blur}px"));
        if boxed {
            css.push_str(&format!(" {spread}px"));
        }
        if let Some(color) = color {
            css.push(' ');
            css.push_str(&color);
        }
        out.push(css);
    }
    Ok(if out.is_empty() {
        "none".to_owned()
    } else {
        out.join(", ")
    })
}

/// The transform property `key` names that takes `[x, y]` or an animated
/// value, and the steps of its axes (an animated value alone is the
/// first's).
fn transform_property(key: &str) -> Option<(TransformProperty, [TransformKind; 2])> {
    use TransformKind as K;
    Some(match key {
        "translate" => (TransformProperty::Translate, [K::TranslateX, K::TranslateY]),
        "rotate" => (TransformProperty::Rotate, [K::Rotate, K::Rotate]),
        "scale" => (TransformProperty::Scale, [K::Scale, K::ScaleY]),
        _ => return None,
    })
}

/// `translate: [x, y]` / `scale: [x, y]`: numbers, CSS strings or animated
/// values per axis (`translate: [x]` is x alone, `scale: [k]` both).
fn transform_axes(
    key: &str,
    items: &compat::Array<'_>,
    axes: [TransformKind; 2],
    warnings: &mut Warnings,
) -> compat::Result<Option<TransformSteps>> {
    let translate = key == "translate";
    let len = items.len();
    if key == "rotate" || !(1..=2).contains(&len) {
        warnings.warn(format!("style `{key}` takes one value, or `[x, y]`"));
        return Ok(None);
    }
    let mut steps = Vec::with_capacity(len);
    for (i, item) in items.iter::<Value>().enumerate() {
        let item = item?;
        let kind = match (translate, i, len) {
            (true, 0, _) => TransformKind::TranslateX,
            (true, _, _) => TransformKind::TranslateY,
            (false, 0, 1) => TransformKind::Scale,
            (false, 0, _) => TransformKind::ScaleX,
            (false, _, _) => axes[1],
        };
        if let Some(node) = animated_value(&item) {
            steps.push((kind, kind.identity(), Some(node)));
            continue;
        }
        let step = match (item.as_number(), item.as_string()) {
            (Some(n), _) => Some((kind, n as f32)),
            (None, Some(s)) if translate => {
                nsh_core::translation(i == 1, &s.to_string()?).map(|op| (op.kind, op.value))
            }
            (None, Some(s)) => {
                let s = s.to_string()?;
                let s = s.trim();
                match s.strip_suffix('%') {
                    Some(p) => p.trim().parse::<f32>().ok().map(|p| p / 100.0),
                    None => s.parse().ok(),
                }
                .map(|v| (kind, v))
            }
            _ => None,
        };
        match step {
            Some((kind, value)) => steps.push((kind, value, None)),
            None => {
                // As CSS drops a declaration with an invalid value: the
                // property stays as it was.
                warnings.warn(format!("invalid value in style `{key}`"));
                return Ok(None);
            }
        }
    }
    Ok(Some(steps))
}

/// Transform steps, each driven by an animated value when it has one.
type TransformSteps = Vec<(TransformKind, f32, Option<nsh_core::animation::NodeId>)>;

/// `transform: [{ perspective: 800 }, { rotateY: animatedValue }]`: steps
/// whose amounts may be animated values, in `transform`'s place.
fn decode_transform_list(
    items: &compat::Array<'_>,
    style: &mut Style,
    patch: &mut StylePatch,
    warnings: &mut Warnings,
) -> compat::Result<()> {
    let mut steps = Vec::new();
    for item in items.iter::<Object>() {
        for entry in item?.props::<String, Value>() {
            let (key, value) = entry?;
            let Some(kind) = TransformKind::parse(&key) else {
                warnings.warn(format!("unsupported transform `{key}`"));
                continue;
            };
            // Animated entries keep their place in the list; the animated
            // value replaces the placeholder amount.
            let (amount, node) = match animated_value(&value) {
                Some(node) => (Some(kind.identity()), Some(node)),
                None => (
                    match value.as_string() {
                        Some(s) if kind.is_angle() => parse_angle(&s.to_string()?),
                        Some(s) => s.to_string()?.trim().parse().ok(),
                        None => number(&value),
                    },
                    None,
                ),
            };
            match amount {
                Some(amount) => steps.push((kind, amount, node)),
                None => warnings.warn(format!("invalid transform `{key}`")),
            }
        }
    }
    let decl = StyleDecl::SetTransform(TransformProperty::Transform, steps.into());
    if patch.push(style, decl).is_err() {
        warnings.warn(format!(
            "too many transforms (at most {})",
            nsh_core::MAX_TRANSFORMS
        ));
    }
    Ok(())
}

/// JS truthiness.
fn truthy(v: &Value<'_>) -> bool {
    if let Some(b) = v.as_bool() {
        return b;
    }
    if let Some(n) = v.as_number() {
        return n != 0.0 && !n.is_nan();
    }
    if let Some(s) = v.as_string() {
        return s.to_string().is_ok_and(|s| !s.is_empty());
    }
    !(v.is_null() || v.is_undefined())
}

/// `"45deg"` / `"0.5rad"` -> degrees.
fn parse_angle(s: &str) -> Option<f32> {
    let s = s.trim();
    if let Some(deg) = s.strip_suffix("deg") {
        deg.trim().parse().ok()
    } else if let Some(rad) = s.strip_suffix("rad") {
        rad.trim().parse::<f32>().ok().map(f32::to_degrees)
    } else {
        s.parse().ok()
    }
}

fn decode_animation(r: &mut Reader<'_, '_>) -> compat::Result<AnimationOp> {
    let sub = r.int()?;
    let node = r.int()? as nsh_core::animation::NodeId;
    Ok(match sub {
        ANIMATION_VALUE => AnimationOp::CreateValue {
            node,
            value: r.number()?,
        },
        ANIMATION_INTERPOLATE => {
            let input = r.int()? as nsh_core::animation::NodeId;
            let input_range = r.numbers()?;
            let outputs = r.value()?;
            let output = decode_output(r, &outputs)?;
            let extrapolate = |name: String| match name.as_str() {
                "extend" => Extrapolate::Extend,
                "identity" => Extrapolate::Identity,
                _ => Extrapolate::Clamp,
            };
            let extrapolate_left = extrapolate(r.string()?);
            let extrapolate_right = extrapolate(r.string()?);
            let easing = r.value()?;
            AnimationOp::CreateInterpolate {
                node,
                input,
                input_range,
                output,
                extrapolate_left,
                extrapolate_right,
                easing: nsh_core::js::animation::easing(&Js(easing)).unwrap_or(Easing::Linear),
            }
        }
        ANIMATION_DIFF_CLAMP => AnimationOp::CreateDiffClamp {
            node,
            input: r.int()? as nsh_core::animation::NodeId,
            min: r.number()?,
            max: r.number()?,
            snap: r.value()?.as_bool().unwrap_or(false),
        },
        ANIMATION_START_COMPOSITE => {
            // `node` carries the animation id here.
            let key = r.int()? as u32;
            let spec = r.value()?;
            AnimationOp::StartComposite {
                animation: node,
                key,
                spec: decode_composite(r, &spec, 0)?,
            }
        }
        ANIMATION_STOP_ANIMATION => AnimationOp::StopAnimation { animation: node },
        ANIMATION_RESET_COMPOSITE => AnimationOp::ResetComposite { key: node },
        ANIMATION_RELEASE_COMPOSITE => AnimationOp::ReleaseComposite { key: node },
        ANIMATION_MATH => {
            let op = match r.string()?.as_str() {
                "add" => MathOp::Add,
                "sub" => MathOp::Sub,
                "mul" => MathOp::Mul,
                "mod" => MathOp::Mod,
                _ => MathOp::Div,
            };
            let a = r.operand()?;
            let b = r.operand()?;
            AnimationOp::CreateMath { node, op, a, b }
        }
        ANIMATION_SET => AnimationOp::Set {
            node,
            value: r.number()?,
        },
        ANIMATION_START => {
            let animation = r.int()? as nsh_core::animation::AnimationId;
            let config = r.value()?;
            let driver = decode_driver(r.cx, &config)?;
            AnimationOp::Start {
                node,
                animation,
                driver,
            }
        }
        ANIMATION_STOP => AnimationOp::Stop { node },
        ANIMATION_RELEASE => AnimationOp::Release { node },
        ANIMATION_SET_OFFSET => AnimationOp::SetOffset {
            node,
            offset: r.number()?,
        },
        ANIMATION_FLATTEN_OFFSET => AnimationOp::FlattenOffset { node },
        ANIMATION_EXTRACT_OFFSET => AnimationOp::ExtractOffset { node },
        ANIMATION_READ => AnimationOp::Read {
            node,
            request: r.int()? as nsh_core::animation::AnimationId,
        },
        other => {
            return Err(Exception::throw_type(
                r.cx,
                &format!("nsh/animated: unknown operation {other}"),
            ));
        }
    })
}

fn decode_output(r: &Reader<'_, '_>, outputs: &Value<'_>) -> compat::Result<Output> {
    let Some(items) = outputs.as_array() else {
        return Err(Exception::throw_type(
            r.cx,
            "interpolate: outputRange must be an array",
        ));
    };
    let first_is_string = items
        .get::<Value>(0)
        .map(|v| v.is_string())
        .unwrap_or(false);
    let angles = first_is_string
        && items
            .get::<String>(0)
            .is_ok_and(|s| s.ends_with("deg") || s.ends_with("rad"));
    if angles {
        // `"45deg"` / `"0.5rad"`: rotations, in degrees.
        let mut degrees = Vec::with_capacity(items.len());
        for item in items.iter::<String>() {
            let item = item?;
            let value = match (item.strip_suffix("deg"), item.strip_suffix("rad")) {
                (Some(d), _) => d.trim().parse::<f32>().ok(),
                (_, Some(r)) => r.trim().parse::<f32>().ok().map(f32::to_degrees),
                _ => None,
            };
            degrees.push(value.ok_or_else(|| {
                Exception::throw_type(r.cx, &format!("interpolate: invalid angle {item:?}"))
            })?);
        }
        return Ok(Output::Numbers(degrees));
    }
    if first_is_string {
        let mut colors = Vec::with_capacity(items.len());
        for item in items.iter::<String>() {
            let color = Color::parse(&item?).ok_or_else(|| {
                Exception::throw_type(r.cx, "interpolate: invalid color in outputRange")
            })?;
            colors.push(color.0);
        }
        Ok(Output::Colors(colors))
    } else {
        Ok(Output::Numbers(
            items
                .iter::<f64>()
                .map(|v| v.map(|v| v as f32))
                .collect::<compat::Result<_>>()?,
        ))
    }
}

/// A driver config (`{ type, to, ... }`), as `Animated` passes them.
pub(crate) fn driver<'js>(cx: &Ctx<'js>, config: &Value<'js>) -> compat::Result<Driver> {
    decode_driver(cx, config)
}

/// An `Easing` value (`linear` when it is none).
pub(crate) fn easing(value: Value<'_>) -> Easing {
    nsh_core::js::animation::easing(&Js(value)).unwrap_or(Easing::Linear)
}

fn decode_driver(cx: &Ctx<'_>, config: &Value<'_>) -> compat::Result<Driver> {
    let Some(c) = config.as_object() else {
        return Err(Exception::throw_type(
            cx,
            "animation config must be an object",
        ));
    };
    let num = |key: &str| c.get::<_, Option<f64>>(key).map(|v| v.map(|v| v as f32));
    let kind = c.get::<_, String>("type")?;
    Ok(match kind.as_str() {
        "timing" => Driver::Timing {
            to: num("to")?.unwrap_or(0.0),
            duration_ms: num("duration")?.unwrap_or(300.0),
            easing: nsh_core::js::animation::easing(&Js(c.get::<_, Value>("easing")?))
                .unwrap_or(Easing::EaseInOut),
            delay_ms: num("delay")?.unwrap_or(0.0),
        },
        "spring" => Driver::Spring {
            to: num("to")?.unwrap_or(0.0),
            stiffness: num("stiffness")?.unwrap_or(170.0),
            damping: num("damping")?.unwrap_or(26.0),
            mass: num("mass")?.unwrap_or(1.0),
            velocity: num("velocity")?,
        },
        "decay" => Driver::Decay {
            velocity: num("velocity")?,
            deceleration: num("deceleration")?.unwrap_or(0.998),
            clamp: match c.get::<_, Option<Vec<f64>>>("clamp")? {
                Some(bounds) if bounds.len() == 2 => Some((bounds[0] as f32, bounds[1] as f32)),
                Some(_) => {
                    return Err(Exception::throw_type(
                        cx,
                        "decay: `clamp` must be [min, max]",
                    ));
                }
                None => None,
            },
            bounce: num("bounce")?.unwrap_or(0.0),
        },
        other => {
            return Err(Exception::throw_type(
                cx,
                &format!("unknown animation type `{other}`"),
            ));
        }
    })
}

/// Where the channels of motion `value` (a preset's name or a spec) start,
/// by `MotionChannel::ALL` (`None` for those it does not move).
pub(crate) fn motion_start(value: Value<'_>) -> [Option<f32>; 9] {
    let mut starts = [None; 9];
    if let Some(spec) = nsh_core::js::animation::motion_spec(&Js(value)) {
        for (channel, start) in spec.start_values() {
            starts[channel.index()] = Some(start);
        }
    }
    starts
}

/// A composite animation: `{ type, ... }` with `node` on the runs.
fn decode_composite(
    r: &Reader<'_, '_>,
    spec: &Value<'_>,
    depth: u32,
) -> compat::Result<nsh_core::animation::Composite> {
    use nsh_core::animation::Composite;
    let Some(o) = spec.as_object().filter(|_| depth < 64) else {
        return Err(Exception::throw_type(r.cx, "animation: invalid composite"));
    };
    let children = |key: &str| -> compat::Result<Vec<Composite>> {
        let list: compat::Array = o.get(key)?;
        list.iter::<Value>()
            .map(|c| decode_composite(r, &c?, depth + 1))
            .collect()
    };
    let kind: String = o.get("type")?;
    Ok(match kind.as_str() {
        "sequence" => Composite::Sequence(children("children")?),
        "parallel" => Composite::Parallel {
            children: children("children")?,
            stop_together: o.get::<_, Option<bool>>("stopTogether")?.unwrap_or(true),
        },
        "delay" => Composite::Delay(o.get::<_, Option<f64>>("ms")?.unwrap_or(0.0) as f32),
        "loop" => Composite::Loop {
            child: Box::new(decode_composite(
                r,
                &o.get::<_, Value>("child")?,
                depth + 1,
            )?),
            iterations: o
                .get::<_, Option<f64>>("iterations")?
                .filter(|n| *n >= 0.0)
                .map(|n| n as u32),
            reset: o.get::<_, Option<bool>>("reset")?.unwrap_or(true),
        },
        // `Animated.keyframes`: the tree is made natively from the config.
        "keyframes" => nsh_core::js::animation::keyframes_composite(
            &Js(spec.clone()),
            o.get::<_, f64>("node")? as nsh_core::animation::NodeId,
        ),
        // A motion's `play`: its channels' nodes (by `MotionChannel::ALL`) and
        // the motion; `reduced` lands it at its end without moving.
        "motion" => {
            let nodes: Vec<f64> = o.get("nodes")?;
            let nodes: [nsh_core::animation::NodeId; 9] =
                std::array::from_fn(|i| nodes.get(i).copied().unwrap_or(0.0) as _);
            let motion = nsh_core::js::animation::motion_spec(&Js(o.get("motion")?))
                .ok_or_else(|| Exception::throw_type(r.cx, "motion: unknown motion"))?;
            motion.composite(
                &nodes,
                o.get::<_, Option<bool>>("reduced")?.unwrap_or(false),
            )
        }
        _ => Composite::Run {
            node: o.get::<_, f64>("node")? as nsh_core::animation::NodeId,
            driver: decode_driver(r.cx, spec)?,
        },
    })
}

/// Deepest nesting of a value sent to a native component.
const JSON_DEPTH: usize = 64;
/// Most entries (array items, object fields) in such a value.
pub(crate) const JSON_ENTRIES: usize = 1 << 20;

/// A JS value as JSON for a native component (like `JSON.stringify`:
/// functions and symbols become `null`, non-finite numbers too). Values
/// nested deeper than [`JSON_DEPTH`] or larger than [`JSON_ENTRIES`] throw.
pub(crate) fn to_json<'js>(value: &Value<'js>) -> compat::Result<nsh_core::JsonValue> {
    let mut entries = 0;
    json(value, 0, &mut entries)
}

fn json<'js>(
    value: &Value<'js>,
    depth: usize,
    entries: &mut usize,
) -> compat::Result<nsh_core::JsonValue> {
    use nsh_core::JsonValue as J;
    let too_big = |cx: &Ctx<'js>| {
        Exception::throw_range(
            cx,
            &format!(
                "a native component value is nested deeper than {JSON_DEPTH} or has more than {JSON_ENTRIES} entries"
            ),
        )
    };
    if depth > JSON_DEPTH {
        return Err(too_big(value.ctx()));
    }
    Ok(match value.type_of() {
        Type::Bool => J::Bool(value.as_bool().unwrap_or(false)),
        Type::Float => {
            let f = value.as_float().unwrap_or(0.0);
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                J::from(f as i64)
            } else {
                serde_json::Number::from_f64(f).map_or(J::Null, J::Number)
            }
        }
        Type::String => J::String(
            value
                .as_string()
                .map(|s| s.to_string())
                .transpose()?
                .unwrap_or_default(),
        ),
        Type::Array => {
            let array = value.as_array().expect("array");
            let mut out = Vec::with_capacity(array.len());
            for item in array.iter::<Value>() {
                *entries += 1;
                if *entries > JSON_ENTRIES {
                    return Err(too_big(value.ctx()));
                }
                out.push(json(&item?, depth + 1, entries)?);
            }
            J::Array(out)
        }
        Type::Object => {
            let object = value.as_object().expect("object");
            let mut out = serde_json::Map::new();
            for entry in object.props::<String, Value>() {
                let (key, item) = entry?;
                *entries += 1;
                if *entries > JSON_ENTRIES {
                    return Err(too_big(value.ctx()));
                }
                if matches!(
                    item.type_of(),
                    Type::Undefined | Type::Function | Type::Symbol
                ) {
                    continue;
                }
                out.insert(key, json(&item, depth + 1, entries)?);
            }
            J::Object(out)
        }
        _ => J::Null,
    })
}
