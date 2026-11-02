//! Shader views on the web: the layer a view shows ([`MountItem::Shader`])
//! as `nsh.js` draws it with WebGL 2, the program translated to GLSL ES
//! 3.00 by the core ([`Shader::glsl_es`]).
//!
//! [`MountItem::Shader`]: nsh_core::MountItem::Shader
//! [`Shader::glsl_es`]: nsh_core::shader::Shader::glsl_es

use nsh_core::shader::{ShaderLayer, SlotKind};
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
    nsh_core::shader::set_compile(nsh_core::shader::Shader::compile);
    ENCODE.with(|e| e.set(Some(encode)));
}

/// [`encode`] when the runtime has shaders; `null` (no layer) otherwise,
/// which is all a runtime without a compiler can have.
pub(crate) fn encode_layer(layer: Option<&ShaderLayer>) -> String {
    match ENCODE.with(|e| e.get()) {
        Some(encode) => encode(layer),
        None => "null".into(),
    }
}

/// The layer as `nsh.js`'s `op_sh` takes it: `null`, or the program (its
/// key, its two shaders and the names of its uniform blocks), its uniform
/// words, its animated slots (`[word, kind]`, kind 0 `f32`, 1 `i32`, 2
/// `u32`, 3 RGB, 4 RGBA), whether it reads the time and whether it is
/// paused.
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
        "animated": shader.animated(),
        "paused": layer.paused,
    })
    .to_string()
}
