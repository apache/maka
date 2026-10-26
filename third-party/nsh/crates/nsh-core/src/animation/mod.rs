//! The native animation graph.
//!
//! JS declares values, derived nodes (interpolations, math) and animations
//! once; the platform evaluates them every display frame on the UI thread,
//! so animations, gestures and scroll-linked effects never wait for JS.
//!
//! Keyframes, staggering and motions (`motion.rs`) are data that become
//! the same composite trees, so they need nothing of a platform either.
//!
//! It is platform-free: the platform feeds it [`AnimationOp`]s, frame
//! timestamps, gesture and scroll values, and reads back evaluated values.
//! [`Animator`] does that for the desktop backends, binding the graph to
//! their views, gestures and scroll views.

mod animator;
mod driver;
mod graph;
mod motion;
mod ops;

pub use self::{
    animator::{AnimValues, Animator},
    driver::{MAX_SAMPLES, sample_driver, sample_easing},
    graph::{AnimationValue, Finished, Graph},
    motion::{
        Keyframe, KeyframeTiming, MotionChannel, MotionKind, MotionPreset, MotionSpec, PRESETS,
        PlaybackDirection, PresetDef, StaggerFrom, keyframe_ends, keyframes, stagger_delay,
    },
    ops::{
        AnimationId, AnimationOp, AnimationProp, Composite, Curve, Driver, EaseMode, Easing,
        Extrapolate, MathOp, NodeId, Operand, Output, StepPosition,
    },
};
