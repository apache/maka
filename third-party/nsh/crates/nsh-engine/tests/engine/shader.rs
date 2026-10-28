//! `Shader` end to end: the layer the core compiles from the app's WGSL and
//! uniforms, the bindings of its animated uniforms, and a program that does
//! not compile.

use std::{sync::Arc, time::Duration};

use nsh_core::{
    MountBatch, MountItem,
    animation::AnimationProp,
    shader::{ShaderLayer, SlotKind},
};

use crate::canvas::start;

const APP: &str = r##"import { mount, signal, createAnimatedValue, Shader } from "nsh";

const SOURCE = `
struct Uniforms { level: f32, tint: vec4f, center: vec2f, glow: f32 }
fn shade(uv: vec2f) -> vec4f {
  return vec4f(uniforms.tint.rgb * uniforms.level + uniforms.glow, 1.0) + vec4f(uniforms.center, 0.0, 0.0);
}`;

const level = signal(0.5);
const glow = createAnimatedValue(0.25);
setTimeout(() => level.set(0.75), 50);

mount(() => (
  <Shader
    source={SOURCE}
    uniforms={{ level: level(), tint: "#ff0000", center: [0.25, 0.5], glow }}
    style={{ width: 100, height: 50 }}
  />
));
"##;

/// The shader layers and animation bindings of what the app sends, until
/// `count` layers came.
fn layers(
    rx: &crossbeam_channel::Receiver<MountBatch>,
    count: usize,
) -> (Vec<Option<Arc<ShaderLayer>>>, Vec<Vec<AnimationProp>>) {
    let (mut layers, mut bindings) = (Vec::new(), Vec::new());
    while layers.len() < count
        && let Ok(batch) = rx.recv_timeout(Duration::from_secs(2))
    {
        for item in batch.items {
            match item {
                MountItem::Shader { layer, .. } => layers.push(layer),
                MountItem::AnimationBindings { bindings: b, .. } => {
                    bindings.push(b.into_iter().map(|(prop, _)| prop).collect())
                }
                _ => {}
            }
        }
    }
    (layers, bindings)
}

#[test]
fn uniforms_are_packed_and_animated_ones_bound() {
    let (_engine, rx) = start(APP);
    let (layers, bindings) = layers(&rx, 2);
    let first = layers[0].as_ref().expect("a layer");
    let f = |w: u32| f32::from_bits(w);
    let words = &first.uniforms;
    // `level` at 0, `tint` at 16 bytes, `center` at 32, `glow` at 40.
    assert_eq!(words.len(), 12);
    assert_eq!(f(words[0]), 0.5);
    assert_eq!(
        [f(words[4]), f(words[5]), f(words[6]), f(words[7])],
        [1.0, 0.0, 0.0, 1.0]
    );
    assert_eq!([f(words[8]), f(words[9])], [0.25, 0.5]);
    assert_eq!(first.slots.len(), 1);
    assert_eq!(first.slots[0].word, 10);
    assert_eq!(first.slots[0].kind, SlotKind::F32);
    assert!(!first.shader.animated(), "it never reads nsh.time");
    assert!(
        bindings
            .iter()
            .any(|b| b.contains(&AnimationProp::CanvasArg(0))),
        "{bindings:?}"
    );
    // A new value of a uniform: the same program, new words.
    let second = layers[1].as_ref().expect("a layer");
    assert_eq!(f(second.uniforms[0]), 0.75);
    assert_eq!(second.shader.hash(), first.shader.hash());
}

#[test]
fn a_program_that_does_not_compile_draws_nothing() {
    let (_engine, rx) = start(
        r##"import { mount, Shader } from "nsh";
mount(() => <Shader source="fn shade(uv: vec2f) -> vec4f { return 1.0; }" style={{ width: 10, height: 10 }} />);
"##,
    );
    let (layers, _) = layers(&rx, 1);
    assert!(layers.is_empty() || layers[0].is_none(), "{layers:?}");
}
