//! Shader views on the web: the layer a view shows ([`MountItem::Shader`])
//! as `nsh.js` draws it with WebGL 2, the program translated to GLSL ES
//! 3.00 by the core ([`Shader::glsl_es`]).
//!
//! [`MountItem::Shader`]: nsh_core::MountItem::Shader
//! [`Shader::glsl_es`]: nsh_core::shader::Shader::glsl_es

use nsh_core::shader::{ShaderLayer, ShaderRole, SlotKind};
use serde_json::{Value, json};

/// What encodes a shader view's layer ([`encode`]).
type Encode = fn(Option<&ShaderLayer>) -> String;

thread_local! {
    /// [`encode`], once the page asked for shaders (`nsh_feature_shader`):
    /// the GLSL ES translation is naga's, which a runtime linked for an app
    /// without shaders leaves out.
    static ENCODE: std::cell::Cell<Option<Encode>> = const { std::cell::Cell::new(None) };
}

/// Links shaders: the core's compiler of their sources and their
/// translation to GLSL ES. The page calls it, as every gate the module
/// exports.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_feature_shader() {
    // `black_box`: each slot only ever holds these functions, so without it
    // LTO calls them directly and keeps naga in the main module, defeating
    // the side-module split (#3048).
    nsh_core::shader::set_compile(std::hint::black_box(nsh_core::shader::Shader::compile as _));
    ENCODE.with(|e| e.set(Some(std::hint::black_box(encode as Encode))));
}

/// [`encode`] when the runtime has shaders; `null` (no layer) otherwise,
/// which is all a runtime without a compiler can have.
pub(crate) fn encode_layer(layer: Option<&ShaderLayer>) -> String {
    match ENCODE.with(|e| e.get()) {
        Some(encode) => encode(layer),
        None => "null".into(),
    }
}

#[cfg(feature = "rust-parts")]
thread_local! {
    /// A Rust app's shader layers that came before the page loaded the
    /// shader gate, by view: the latest item of each, encoded again once
    /// the gate ran ([`gate_ran`]). Keyed by whether it is a page's
    /// transition too: a view may have both.
    static WAITING: std::cell::RefCell<rustc_hash::FxHashMap<(nsh_core::NodeId, bool), nsh_core::MountItem>> =
        std::cell::RefCell::default();
    /// Whether the page was asked for the gate and has not answered yet.
    static REQUESTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Notes a shader view's layer (`MountItem::Shader`) or a page's
/// transition (`MountItem::NavShader`) that this runtime cannot encode yet:
/// a Rust app's runtime splits the shader gate into a side module
/// (`nsh_feature_shader`), which the page loads the first time the app
/// shows a shader. The item shows nothing until then ([`gate_ran`]
/// encodes it again); an item without a layer drops what waited.
#[cfg(feature = "rust-parts")]
pub(crate) fn note(item: &nsh_core::MountItem) {
    use nsh_core::MountItem;
    if ENCODE.with(|e| e.get()).is_some() {
        return;
    }
    let (key, has_layer) = match item {
        MountItem::Shader { id, layer } => ((*id, false), layer.is_some()),
        MountItem::NavShader { id, shader } => ((*id, true), shader.is_some()),
        _ => return,
    };
    WAITING.with(|w| {
        let mut waiting = w.borrow_mut();
        if has_layer {
            waiting.insert(key, item.clone());
        } else {
            waiting.remove(&key);
        }
    });
    if has_layer && !REQUESTED.with(|r| r.replace(true)) {
        crate::ffi::load_data("feature:shader");
    }
}

/// The page answered the request for the shader gate ([`note`]): the
/// items that waited for it, if it ran (none if it did not load, and the
/// next shader asks again).
#[cfg(feature = "rust-parts")]
pub(crate) fn gate_ran() -> Vec<nsh_core::MountItem> {
    REQUESTED.with(|r| r.set(false));
    if ENCODE.with(|e| e.get()).is_none() {
        return Vec::new();
    }
    WAITING.with(|w| w.borrow_mut().drain().map(|(_, item)| item).collect())
}

/// The layer as `nsh.js`'s `op_sh` (and `op_shn`) takes it: `null`, or the
/// program (its key, its two shaders, the names of its uniform blocks and
/// of the samplers of the pictures it reads, `[name, input]` with input 0
/// content, 1 backdrop, 2 from, 3 to), its uniform words, its animated
/// slots (`[word, kind]`, kind 0 `f32`, 1 `i32`, 2 `u32`, 3 RGB, 4 RGBA; the
/// one at `progressSlot` moves `nsh.progress`), whether it reads the time
/// and whether it is paused, its role (0 a fill, 1 an effect, 2 a
/// transition, 3 a screen effect, 4 a screen transition), its overflow in
/// points and its progress.
fn encode(layer: Option<&ShaderLayer>) -> String {
    let Some(layer) = layer else {
        return "null".into();
    };
    let shader = &layer.shader;
    let program = match shader.glsl_es() {
        Ok(p) => p,
        Err(e) => {
            log::warn!(target: "js", "a shader WebGL 2 cannot run: {e}");
            return "null".into();
        }
    };
    let slots: Vec<Value> = layer
        .slots
        .iter()
        .map(|s| {
            let kind = match s.kind {
                SlotKind::F32 => 0,
                SlotKind::I32 => 1,
                SlotKind::U32 => 2,
                SlotKind::Rgb => 3,
                SlotKind::Rgba => 4,
            };
            json!([s.word, kind])
        })
        .collect();
    json!({
        "key": format!("{:016x}", shader.hash()),
        "vs": program.vertex,
        "fs": program.fragment,
        "nsh": program.builtins_block,
        "u": program.uniforms_block,
        "words": &layer.uniforms[..],
        "slots": slots,
        "pictures": program
            .pictures
            .iter()
            .map(|(name, input)| json!([name, input.index()]))
            .collect::<Vec<_>>(),
        "animated": shader.animated(),
        "paused": layer.paused,
        "role": match layer.role {
            ShaderRole::Fill => 0,
            ShaderRole::Effect => 1,
            ShaderRole::Transition => 2,
            ShaderRole::Screen => 3,
            ShaderRole::ScreenTransition => 4,
            // A role this runtime does not know draws as a fill, under the
            // children, as on a platform that draws no effects.
            _ => 0,
        },
        "overflow": layer.overflow.0,
        "progress": layer.progress,
        "progressSlot": layer.progress_slot(),
    })
    .to_string()
}
