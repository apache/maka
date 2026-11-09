//! Bound animated values (`animation::UiAnimation`): `nsh.js` writes them
//! into the view's inline style, so a property that is no longer bound is
//! cleared there, and the view shows its own style again.

use nsh_core::{
    MountItem,
    animation::{AnimationOp, AnimationProp},
};

use crate::{animation::UiAnimation, encode::Out};

fn outputs(a: &mut UiAnimation) -> Vec<(u32, String, String)> {
    let mut out = Out::default();
    a.outputs(&mut out);
    out.0
}

fn item(prop: &str, value: &str) -> (u32, String, String) {
    (4, prop.to_owned(), value.to_owned())
}

#[test]
fn a_view_taken_over_without_its_bindings_keeps_no_animated_opacity_or_transform() {
    let mut a = UiAnimation::default();
    a.apply(&MountItem::Animation(AnimationOp::CreateValue {
        node: 2,
        value: 0.5,
    }));
    let bind =
        |a: &mut UiAnimation, bindings| a.apply(&MountItem::AnimationBindings { id: 4, bindings });
    bind(
        &mut a,
        vec![
            (AnimationProp::Opacity, 2),
            (AnimationProp::Transform(0), 2),
        ],
    );
    assert_eq!(
        outputs(&mut a),
        [item("opacity", "0.5"), item("transform", "Some(0.5)")]
    );

    // An endless motion loses its opacity: only that is cleared.
    bind(&mut a, vec![(AnimationProp::Transform(0), 2)]);
    assert_eq!(
        outputs(&mut a),
        [item("opacity", ""), item("transform", "Some(0.5)")]
    );

    // Another element takes the view over (a region that ran again) with
    // none: the last values do not stay, and are cleared once.
    bind(&mut a, vec![]);
    assert_eq!(outputs(&mut a), [item("transform", "")]);
    assert_eq!(outputs(&mut a), []);
}
