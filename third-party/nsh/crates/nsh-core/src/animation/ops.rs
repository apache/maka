/// Identifier of an animation node, assigned by JS.
pub type NodeId = u32;

/// Identifier of one started animation, assigned by JS; reported back when
/// the animation finishes.
pub type AnimationId = u32;

/// A view property that an animation node can drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnimationProp {
    /// `opacity`, 0..1.
    Opacity,
    /// `backgroundColor`, from a color interpolation.
    BackgroundColor,
    /// `borderColor`: the color of every side.
    BorderColor,
    /// `color` of a text: the whole text takes it.
    Color,
    /// `shadowColor`.
    ShadowColor,
    /// `shadowOpacity`, 0..1.
    ShadowOpacity,
    /// `shadowRadius`, in points.
    ShadowRadius,
    /// The value of entry `n` of the view's `transform` list (translations
    /// in points, rotations and skews in degrees).
    Transform(u8),
    /// Animated value slot `n` of a canvas drawing: the canvas draws again
    /// with it (a number or a color).
    CanvasArg(u16),
    /// `top` of a `position: sticky` view: how far from the viewport's
    /// start of a vertical scroll view it sticks. The core hands it to the
    /// scroll view's sticky cells (`StickyCell::offset`), never to the
    /// view's bindings.
    StickyTop,
    /// `left`: the same in a horizontal scroll view.
    StickyLeft,
    /// Animated prop slot `n` of a registered native component: the platform
    /// hands the value to the component under the slot's name
    /// ([`crate::mount::MountItem::ComponentPropSlots`]), a number or a color.
    ComponentSlot(u16),
}

/// The value of a native component's animated prop
/// ([`AnimationProp::ComponentSlot`]), as the platform hands it over.
///
/// Values are equal when their bits are: a NaN that stays NaN is not a change
/// to hand over again.
#[non_exhaustive]
#[derive(Debug, Clone, Copy)]
pub enum AnimatedPropValue {
    /// A number.
    Number(f64),
    /// A color, `0xAARRGGBB` (Android's `Color` layout).
    Color(u32),
}

impl PartialEq for AnimatedPropValue {
    fn eq(&self, other: &AnimatedPropValue) -> bool {
        match (self, other) {
            (AnimatedPropValue::Number(a), AnimatedPropValue::Number(b)) => {
                a.to_bits() == b.to_bits()
            }
            (AnimatedPropValue::Color(a), AnimatedPropValue::Color(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for AnimatedPropValue {}

impl From<super::AnimationValue> for AnimatedPropValue {
    fn from(value: super::AnimationValue) -> AnimatedPropValue {
        match value {
            // The graph's colors are `0xRRGGBBAA`.
            super::AnimationValue::Color(rgba) => AnimatedPropValue::Color(rgba.rotate_right(8)),
            other => AnimatedPropValue::Number(f64::from(other.number())),
        }
    }
}

impl AnimationProp {
    /// Parses a style key (transform entries are addressed by position).
    pub fn from_name(name: &str) -> Option<AnimationProp> {
        Some(match name {
            "opacity" => AnimationProp::Opacity,
            "backgroundColor" => AnimationProp::BackgroundColor,
            "borderColor" => AnimationProp::BorderColor,
            "color" => AnimationProp::Color,
            "shadowColor" => AnimationProp::ShadowColor,
            "shadowOpacity" => AnimationProp::ShadowOpacity,
            "shadowRadius" => AnimationProp::ShadowRadius,
            "top" => AnimationProp::StickyTop,
            "left" => AnimationProp::StickyLeft,
            _ => return None,
        })
    }
}

/// Easing curve of a timing animation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Easing {
    /// Constant speed.
    Linear,
    /// CSS `ease-in`.
    EaseIn,
    /// CSS `ease-out`.
    EaseOut,
    /// CSS `ease-in-out`.
    EaseInOut,
    /// A cubic Bézier `(x1, y1, x2, y2)`, like CSS `cubic-bezier()`.
    Bezier(f32, f32, f32, f32),
    /// One of React Native's `Easing` functions with its `in` / `out` /
    /// `inOut` form.
    Curve(Curve, EaseMode),
    /// CSS `steps(count, position)`: jumps between `count` levels instead
    /// of moving (a frame-by-frame sprite, a ticking clock hand).
    Steps(u32, StepPosition),
}

impl Easing {
    /// CSS `ease`.
    pub const EASE: Easing = Easing::Bezier(0.25, 0.1, 0.25, 1.0);

    /// The curve played backwards (`1 - e(1 - t)`): what a keyframe segment
    /// follows when its animation runs in reverse, as in CSS.
    pub fn reversed(self) -> Easing {
        match self {
            Easing::Linear => Easing::Linear,
            Easing::EaseIn => Easing::EaseOut,
            Easing::EaseOut => Easing::EaseIn,
            Easing::EaseInOut => Easing::EaseInOut,
            Easing::Bezier(x1, y1, x2, y2) => {
                Easing::Bezier(1.0 - x2, 1.0 - y2, 1.0 - x1, 1.0 - y1)
            }
            Easing::Curve(curve, mode) => Easing::Curve(
                curve,
                match mode {
                    EaseMode::In => EaseMode::Out,
                    EaseMode::Out => EaseMode::In,
                    EaseMode::InOut => EaseMode::InOut,
                },
            ),
            Easing::Steps(count, position) => Easing::Steps(
                count,
                match position {
                    StepPosition::JumpStart => StepPosition::JumpEnd,
                    StepPosition::JumpEnd => StepPosition::JumpStart,
                    other => other,
                },
            ),
        }
    }
}

/// Where a [`Easing::Steps`] curve jumps (CSS's `<step-position>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StepPosition {
    /// The first jump happens at the start (`jump-start`, `start`).
    JumpStart,
    /// The last jump happens at the end (`jump-end`, `end`; the default).
    #[default]
    JumpEnd,
    /// No jump at either end: holds the first and the last level
    /// (`jump-none`).
    JumpNone,
    /// Jumps at both ends (`jump-both`).
    JumpBoth,
}

impl StepPosition {
    /// Parses a CSS `<step-position>`.
    pub fn parse(name: &str) -> Option<StepPosition> {
        Some(match name {
            "jump-start" | "start" => StepPosition::JumpStart,
            "jump-end" | "end" => StepPosition::JumpEnd,
            "jump-none" => StepPosition::JumpNone,
            "jump-both" => StepPosition::JumpBoth,
            _ => return None,
        })
    }

    /// Its CSS name.
    pub fn name(self) -> &'static str {
        match self {
            StepPosition::JumpStart => "jump-start",
            StepPosition::JumpEnd => "jump-end",
            StepPosition::JumpNone => "jump-none",
            StepPosition::JumpBoth => "jump-both",
        }
    }
}

/// A shape of React Native's `Easing` module (its "in" form).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Curve {
    /// `t²`.
    Quad,
    /// `t³`.
    Cubic,
    /// `tⁿ`.
    Poly(f32),
    /// Sinusoidal.
    Sin,
    /// Circular.
    Circle,
    /// Exponential.
    Exp,
    /// Springy overshoot; the bounciness (1 by default).
    Elastic(f32),
    /// Pulls back before going; the overshoot (1.70158 by default).
    Back(f32),
    /// Bounces at the end.
    Bounce,
}

/// How a [`Curve`] is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EaseMode {
    /// As is.
    In,
    /// Mirrored: fast start, slow end.
    Out,
    /// `In` for the first half, `Out` for the second.
    InOut,
}

/// How an animation moves a value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Driver {
    /// Fixed duration along an easing curve.
    Timing {
        /// Target value.
        to: f32,
        /// Duration in milliseconds.
        duration_ms: f32,
        /// Curve.
        easing: Easing,
        /// Delay before starting, in milliseconds.
        delay_ms: f32,
    },
    /// Damped spring.
    Spring {
        /// Target value.
        to: f32,
        /// Spring stiffness `k`.
        stiffness: f32,
        /// Damping `c`.
        damping: f32,
        /// Mass `m`.
        mass: f32,
        /// Initial velocity (units per second); `None` keeps the current one.
        velocity: Option<f32>,
    },
    /// Exponential slow-down from an initial velocity (flings).
    Decay {
        /// Initial velocity (units per second); `None` keeps the current one.
        velocity: Option<f32>,
        /// Fraction of velocity kept per millisecond, e.g. `0.998`.
        deceleration: f32,
        /// Bounds `(min, max)` the value stays within: it stops at a bound,
        /// or bounces back from it with `bounce`.
        clamp: Option<(f32, f32)>,
        /// The fraction of its speed the value keeps when it bounces off a
        /// bound (0: it stops there).
        bounce: f32,
    },
}

/// Output range of an interpolation.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// Numbers.
    Numbers(Vec<f32>),
    /// Colors packed as `0xRRGGBBAA` (same as `nsh_core::Color`).
    Colors(Vec<u32>),
}

/// What an interpolation does outside its input range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extrapolate {
    /// Continue the first / last segment.
    Extend,
    /// Stick to the first / last output.
    Clamp,
    /// Return the input unchanged.
    Identity,
}

/// Binary operation of a math node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathOp {
    /// `a` modulo `b`, always non-negative for positive `b` (0 when `b`
    /// is 0).
    Mod,
    /// `a + b`.
    Add,
    /// `a - b`.
    Sub,
    /// `a * b`.
    Mul,
    /// `a / b` (0 when `b` is 0).
    Div,
}

/// An operand of a math node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Operand {
    /// Another node.
    Node(NodeId),
    /// A constant.
    Const(f32),
}

/// A change to the animation graph, sent by JS.
#[derive(Debug, Clone, PartialEq)]
pub enum AnimationOp {
    /// A settable, animatable value.
    CreateValue {
        /// New node.
        node: NodeId,
        /// Initial value.
        value: f32,
    },
    /// Maps `input` through piecewise-linear ranges.
    CreateInterpolate {
        /// New node.
        node: NodeId,
        /// Source node.
        input: NodeId,
        /// Increasing input breakpoints.
        input_range: Vec<f32>,
        /// Outputs, same length as `input_range`.
        output: Output,
        /// Behaviour below the input range.
        extrapolate_left: Extrapolate,
        /// Behaviour above the input range.
        extrapolate_right: Extrapolate,
        /// Curve within each segment.
        easing: Easing,
    },
    /// Follows the changes of `input` but stays within `min..=max`
    /// (React Native's `diffClamp`: a header that hides as content scrolls
    /// up and shows as it scrolls down).
    CreateDiffClamp {
        /// New node.
        node: NodeId,
        /// Source node.
        input: NodeId,
        /// Lower bound.
        min: f32,
        /// Upper bound.
        max: f32,
        /// Settles at the nearer bound when the scroll view its input
        /// follows comes to rest ([`super::Graph::settle`]): a floating bar
        /// shows or hides fully.
        snap: bool,
    },
    /// Combines two operands.
    CreateMath {
        /// New node.
        node: NodeId,
        /// Operation.
        op: MathOp,
        /// Left operand.
        a: Operand,
        /// Right operand.
        b: Operand,
    },
    /// Gives an interpolation other outputs (the same number): colors that
    /// follow the appearance.
    SetOutput {
        /// Interpolation node.
        node: NodeId,
        /// Its outputs from now on.
        output: Output,
    },
    /// Sets a value immediately, stopping its animation.
    Set {
        /// Value node.
        node: NodeId,
        /// New value.
        value: f32,
    },
    /// Adjusts a base value atomically, stopping its animation and retaining
    /// the offset added by `SetOffset`.
    Adjust {
        /// Value node.
        node: NodeId,
        /// Multiplier of the current base value.
        factor: f32,
        /// Amount added after multiplication.
        offset: f32,
    },
    /// Starts an animation on a value, replacing any running one.
    Start {
        /// Value node.
        node: NodeId,
        /// Reported back on completion.
        animation: AnimationId,
        /// How to move.
        driver: Driver,
    },
    /// Starts a composite animation (sequences, parallel groups, delays,
    /// loops) run natively, step after step.
    StartComposite {
        /// Reported back when the whole animation ends.
        animation: AnimationId,
        /// The composite (one JS object, run any number of times): the
        /// values it animates are recorded as they are now, for `Reset`.
        key: u32,
        /// What to run.
        spec: Composite,
    },
    /// Stops the composite `key` and puts its values back where they were
    /// when it last started.
    ResetComposite {
        /// The composite.
        key: u32,
    },
    /// Forgets the composite `key` (collected in JS).
    ReleaseComposite {
        /// The composite.
        key: u32,
    },
    /// Stops the animation of a value where it is.
    Stop {
        /// Value node.
        node: NodeId,
    },
    /// Stops a composite animation (its running steps stay where they are).
    StopAnimation {
        /// The animation.
        animation: AnimationId,
    },
    /// Frees a node.
    Release {
        /// Node.
        node: NodeId,
    },
    /// Sets the offset added to a value (React Native's `setOffset`): the
    /// value evaluates to its own value plus the offset; animations, `Set`
    /// and gestures move its own value.
    SetOffset {
        /// Value node.
        node: NodeId,
        /// The offset.
        offset: f32,
    },
    /// Merges a value's offset into it and clears the offset (React
    /// Native's `flattenOffset`).
    FlattenOffset {
        /// Value node.
        node: NodeId,
    },
    /// Moves a value into its offset, leaving it 0 (React Native's
    /// `extractOffset`: a drag then starts from 0).
    ExtractOffset {
        /// Value node.
        node: NodeId,
    },
    /// Reports the current value of any node as a [`super::Finished`] of
    /// `request` (with its `value`), so JS can read it back.
    Read {
        /// The node.
        node: NodeId,
        /// Reported back with the value.
        request: AnimationId,
    },
}

/// A composite animation.
#[derive(Debug, Clone, PartialEq)]
pub enum Composite {
    /// Moves a value.
    Run {
        /// Value node.
        node: NodeId,
        /// How.
        driver: Driver,
    },
    /// One after the other; stops at the first that does not finish.
    Sequence(Vec<Composite>),
    /// All at once.
    Parallel {
        /// The animations.
        children: Vec<Composite>,
        /// One stopping stops the others (React Native's default).
        stop_together: bool,
    },
    /// Waits, in milliseconds.
    Delay(f32),
    /// Repeats.
    Loop {
        /// The animation.
        child: Box<Composite>,
        /// Number of runs; `None` loops forever.
        iterations: Option<u32>,
        /// Values go back to where they were before each run.
        reset: bool,
    },
}

impl Composite {
    /// The value nodes it animates.
    pub fn nodes(&self, out: &mut Vec<NodeId>) {
        match self {
            Composite::Run { node, .. } => {
                if !out.contains(node) {
                    out.push(*node);
                }
            }
            Composite::Sequence(children) | Composite::Parallel { children, .. } => {
                for c in children {
                    c.nodes(out);
                }
            }
            Composite::Delay(_) => {}
            Composite::Loop { child, .. } => child.nodes(out),
        }
    }
}
