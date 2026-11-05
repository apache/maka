//! `Shader` end to end: the layer the core compiles from the app's WGSL and
//! uniforms, the bindings of its animated uniforms, and a program that does
//! not compile.

use std::{sync::Arc, time::Duration};

use nsh_core::{
    MountBatch, MountItem,
    animation::AnimationProp,
    shader::{PROGRESS_WORD, ShaderInput, ShaderLayer, ShaderRole, SlotKind},
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

/// Everything the app sends, until `until` says it has what it needs (or
/// two seconds pass).
fn items_until(
    rx: &crossbeam_channel::Receiver<MountBatch>,
    until: impl Fn(&[Vec<MountItem>]) -> bool,
) -> Vec<Vec<MountItem>> {
    let mut batches = Vec::new();
    while !until(&batches)
        && let Ok(batch) = rx.recv_timeout(Duration::from_secs(2))
    {
        batches.push(batch.items);
    }
    batches
}

#[test]
fn effects_get_their_role_progress_and_pictures() {
    let (_engine, rx) = start(
        r##"import { mount, signal, createAnimatedValue, ShaderEffect, Text } from "nsh";
const progress = createAnimatedValue(0.5);
const label = signal("one");
setTimeout(() => label.set("two"), 50);
mount(() => (
  <ShaderEffect
    source="fn shade(uv: vec2f) -> vec4f { return sample_content(uv) * nsh.progress; }"
    progress={progress}
    maxSampleOffset={8}
    style={{ width: 100, height: 50 }}
  >
    <Text>{label()}</Text>
  </ShaderEffect>
));
"##,
    );
    let batches = items_until(&rx, |b| {
        b.iter()
            .flatten()
            .any(|i| matches!(i, MountItem::ShaderInput { .. }))
            && b.len() >= 2
    });
    let layer = batches
        .iter()
        .flatten()
        .find_map(|i| match i {
            MountItem::Shader { layer: Some(l), .. } => Some(l.clone()),
            _ => None,
        })
        .expect("a layer");
    assert_eq!(layer.role, ShaderRole::Effect);
    assert_eq!(layer.overflow.0, 8.0);
    assert!(layer.shader.inputs().contains(ShaderInput::Content));
    assert_eq!(layer.progress_slot(), Some(0));
    assert_eq!(layer.slots[0].word, PROGRESS_WORD);
    // The text in it changed: the effect takes its picture again.
    let later = &batches[1..];
    assert!(
        later
            .iter()
            .flatten()
            .any(|i| matches!(i, MountItem::ShaderInput { .. })),
        "{later:?}"
    );
}

#[test]
fn transitions_start_when_their_value_changes() {
    let (_engine, rx) = start(
        r##"import { mount, signal, ShaderTransition, Text } from "nsh";
const page = signal(1);
setTimeout(() => page.set(2), 50);
mount(() => (
  <ShaderTransition value={page()} duration={250} style={{ width: 100, height: 50 }}>
    <Text>{`page ${page()}`}</Text>
  </ShaderTransition>
));
"##,
    );
    let batches = items_until(&rx, |b| {
        b.iter()
            .flatten()
            .any(|i| matches!(i, MountItem::ShaderTransition { .. }))
    });
    // The first value starts nothing; the fallback cross-fades.
    let first = &batches[0];
    assert!(
        !first
            .iter()
            .any(|i| matches!(i, MountItem::ShaderTransition { .. }))
    );
    let layer = first
        .iter()
        .find_map(|i| match i {
            MountItem::Shader { layer: Some(l), .. } => Some(l.clone()),
            _ => None,
        })
        .expect("the cross-fade");
    assert_eq!(layer.role, ShaderRole::Transition);
    assert_eq!(Some(layer.shader.clone()), nsh_core::shader::crossfade());
    // The change: the start comes first in its batch, before the new text.
    let change = batches.last().expect("a batch");
    assert!(
        matches!(change[0], MountItem::ShaderTransition { duration, .. } if duration == Duration::from_millis(250)),
        "{change:?}"
    );
}

#[test]
fn pages_and_dialogs_take_a_transition_shader() {
    let (_engine, rx) = start(
        r##"import { mount, Text, View } from "nsh";
import { Dialog, NavPage, NavStack, createNavStack } from "nsh/base";
const nav = createNavStack<{ name: string }>([{ name: "home" }]);
const wipe = { source: "fn shade(uv: vec2f) -> vec4f { return select(sample_from(uv), sample_to(uv), uv.x < nsh.progress); }", duration: 400 };
mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route.name} transitionShader={wipe}>
          <Text>{route.name}</Text>
        </NavPage>
      )}
    </NavStack>
    <Dialog open transitionShader={wipe}>
      <Text>in dialog</Text>
    </Dialog>
  </View>
));
"##,
    );
    let batches = items_until(&rx, |b| {
        b.iter()
            .flatten()
            .filter(|i| {
                matches!(
                    i,
                    MountItem::NavShader {
                        shader: Some(_),
                        ..
                    }
                )
            })
            .count()
            >= 2
    });
    let shaders: Vec<_> = batches
        .iter()
        .flatten()
        .filter_map(|i| match i {
            MountItem::NavShader {
                shader: Some(s), ..
            } => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(shaders.len(), 2, "the page and the dialog");
    for shader in shaders {
        assert_eq!(shader.duration, Duration::from_millis(400));
        assert_eq!(shader.layer.role, ShaderRole::Transition);
        let inputs = shader.layer.shader.inputs();
        assert!(inputs.contains(ShaderInput::From) && inputs.contains(ShaderInput::To));
    }
}
