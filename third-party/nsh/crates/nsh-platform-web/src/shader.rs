//! Shader views on the web: the layer a view shows ([`MountItem::Shader`])
//! as `nsh.js` draws it with WebGL 2, the program translated to GLSL ES
//! 3.00 by the core ([`Shader::glsl_es`]).
//!
//! [`MountItem::Shader`]: nsh_core::MountItem::Shader
//! [`Shader::glsl_es`]: nsh_core::shader::Shader::glsl_es

use nsh_core::shader::{ShaderLayer, SlotKind};
use serde_json::{Value, json};

/// The layer as `nsh.js`'s `op_sh` takes it: `null`, or the program (its
/// key, its two shaders and the names of its uniform blocks), its uniform
/// words, its animated slots (`[word, kind]`, kind 0 `f32`, 1 `i32`, 2
/// `u32`, 3 RGB, 4 RGBA), whether it reads the time and whether it is
/// paused.
pub(crate) fn encode(layer: Option<&ShaderLayer>) -> String {
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
