//! Keyframes, staggering and motions: what is played on animated values
//! described as data, turned into [`Composite`] trees the graph runs like
//! any other (so every platform plays them, with no code of its own).
//!
//! - [`keyframes`]: one value through keyframes, as CSS `@keyframes` and
//!   the Web Animations API mean them: offsets (missing ones spread
//!   evenly), an easing per segment, iterations, a direction, a delay.
//! - [`stagger_delay`]: the delay of each item of a staggered group,
//!   counted from the first, the last, the center or any item.
//! - [`MotionSpec`]: several channels of a view ([`MotionChannel`]: opacity and
//!   the parts of its transform) through keyframes with one timing, and
//!   the ready-made ones ([`MotionPreset`]: entrances, exits, attention
//!   seekers and loops). The values are the app's: a motion has no look,
//!   it only moves what the app styled.

use super::ops::{Composite, Driver, Easing, NodeId};
use crate::TransformKind;

/// One keyframe of a value: where it is at `offset` (0..=1 of an
/// iteration) and the easing of the segment that starts there.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct Keyframe {
    /// Where it is in the iteration, 0..=1; `None` spreads it evenly
    /// between its neighbors (the first is 0 and the last 1 by default).
    pub offset: Option<f32>,
    /// The value there.
    pub value: f32,
    /// The curve to the next keyframe (`None`: the timing's).
    pub easing: Option<Easing>,
}

impl Default for Keyframe {
    fn default() -> Self {
        Self {
            offset: None,
            value: 0.0,
            easing: None,
        }
    }
}

impl Keyframe {
    /// `value`, spread evenly with the keyframes around it.
    pub const fn new(value: f32) -> Self {
        Self {
            offset: None,
            value,
            easing: None,
        }
    }

    /// `value` at `offset` (0..=1).
    pub const fn at(offset: f32, value: f32) -> Self {
        Self {
            offset: Some(offset),
            value,
            easing: None,
        }
    }

    /// With `easing` for the segment that starts here.
    pub const fn ease(mut self, easing: Easing) -> Self {
        self.easing = Some(easing);
        self
    }
}

/// Which way the iterations of keyframes play (CSS `animation-direction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlaybackDirection {
    /// From the first keyframe to the last, each iteration.
    #[default]
    Normal,
    /// From the last to the first.
    Reverse,
    /// Forwards, then backwards, and so on.
    Alternate,
    /// Backwards, then forwards, and so on.
    AlternateReverse,
}

impl PlaybackDirection {
    /// Parses a CSS `animation-direction`.
    pub fn parse(name: &str) -> Option<PlaybackDirection> {
        Some(match name {
            "normal" => PlaybackDirection::Normal,
            "reverse" => PlaybackDirection::Reverse,
            "alternate" => PlaybackDirection::Alternate,
            "alternate-reverse" => PlaybackDirection::AlternateReverse,
            _ => return None,
        })
    }

    /// Its CSS name.
    pub fn name(self) -> &'static str {
        match self {
            PlaybackDirection::Normal => "normal",
            PlaybackDirection::Reverse => "reverse",
            PlaybackDirection::Alternate => "alternate",
            PlaybackDirection::AlternateReverse => "alternate-reverse",
        }
    }

    /// Whether iteration `index` (from 0) plays backwards.
    fn reversed(self, index: u32) -> bool {
        match self {
            PlaybackDirection::Normal => false,
            PlaybackDirection::Reverse => true,
            PlaybackDirection::Alternate => !index.is_multiple_of(2),
            PlaybackDirection::AlternateReverse => index.is_multiple_of(2),
        }
    }

    fn alternates(self) -> bool {
        matches!(
            self,
            PlaybackDirection::Alternate | PlaybackDirection::AlternateReverse
        )
    }
}

/// How keyframes play (CSS `animation-duration`, `-delay`,
/// `-timing-function`, `-iteration-count` and `-direction`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct KeyframeTiming {
    /// One iteration, in milliseconds.
    pub duration_ms: f32,
    /// Before the first iteration, in milliseconds.
    pub delay_ms: f32,
    /// The curve of each segment without one of its own (CSS `ease` by
    /// default; as in CSS it shapes every segment, not the whole).
    pub easing: Easing,
    /// How many iterations; `None` repeats until stopped.
    pub iterations: Option<u32>,
    /// Which way the iterations play.
    pub direction: PlaybackDirection,
}

impl Default for KeyframeTiming {
    fn default() -> Self {
        Self {
            duration_ms: 300.0,
            delay_ms: 0.0,
            easing: Easing::EASE,
            iterations: Some(1),
            direction: PlaybackDirection::Normal,
        }
    }
}

impl KeyframeTiming {
    /// One iteration of `duration_ms` with the defaults otherwise.
    pub fn new(duration_ms: f32) -> Self {
        Self {
            duration_ms,
            ..Self::default()
        }
    }

    /// With `easing` for segments without one.
    pub fn easing(mut self, easing: Easing) -> Self {
        self.easing = easing;
        self
    }

    /// Waiting `delay_ms` before the first iteration.
    pub fn delay(mut self, delay_ms: f32) -> Self {
        self.delay_ms = delay_ms;
        self
    }

    /// `iterations` times (`None`: until stopped).
    pub fn iterations(mut self, iterations: Option<u32>) -> Self {
        self.iterations = iterations;
        self
    }

    /// Repeating until stopped.
    pub fn infinite(self) -> Self {
        self.iterations(None)
    }

    /// Playing in `direction`.
    pub fn direction(mut self, direction: PlaybackDirection) -> Self {
        self.direction = direction;
        self
    }
}

/// Keyframes with their offsets resolved (increasing, within 0..=1), as
/// the Web Animations API spaces them: the first defaults to 0 and the
/// last to 1 (a single one is the end), the ones between spread evenly
/// between their neighbors with an offset.
fn resolve(frames: &[Keyframe]) -> Vec<(f32, f32, Option<Easing>)> {
    let n = frames.len();
    let mut offsets: Vec<Option<f32>> = frames
        .iter()
        .map(|f| {
            f.offset
                .filter(|o| o.is_finite())
                .map(|o| o.clamp(0.0, 1.0))
        })
        .collect();
    if n == 1 {
        offsets[0].get_or_insert(1.0);
    } else if n > 1 {
        offsets[0].get_or_insert(0.0);
        offsets[n - 1].get_or_insert(1.0);
    }
    let mut i = 0;
    while i < n {
        if offsets[i].is_some() {
            i += 1;
            continue;
        }
        let start = i - 1;
        let mut end = i;
        while offsets[end].is_none() {
            end += 1;
        }
        let (a, b) = (offsets[start].unwrap_or(0.0), offsets[end].unwrap_or(1.0));
        for (k, slot) in offsets.iter_mut().enumerate().take(end).skip(i) {
            *slot = Some(a + (b - a) * (k - start) as f32 / (end - start) as f32);
        }
        i = end;
    }
    // Offsets go up: one below the one before it is held there.
    let mut last = 0.0f32;
    frames
        .iter()
        .zip(offsets)
        .map(|(f, o)| {
            let o = o.unwrap_or(1.0).max(last);
            last = o;
            (o, f.value, f.easing)
        })
        .collect()
}

/// One iteration over `frames` (resolved), forwards or backwards.
fn iteration(
    node: NodeId,
    frames: &[(f32, f32, Option<Easing>)],
    timing: &KeyframeTiming,
    backwards: bool,
) -> Composite {
    let duration = timing.duration_ms.max(0.0);
    // Backwards, offsets mirror and each segment runs its curve reversed.
    let oriented: Vec<(f32, f32, Easing)> = if backwards {
        let mut out = Vec::with_capacity(frames.len());
        for i in (0..frames.len()).rev() {
            let easing = match i {
                0 => timing.easing,
                _ => frames[i - 1].2.unwrap_or(timing.easing).reversed(),
            };
            out.push((1.0 - frames[i].0, frames[i].1, easing));
        }
        out
    } else {
        frames
            .iter()
            .map(|&(o, v, e)| (o, v, e.unwrap_or(timing.easing)))
            .collect()
    };
    let timing_to = |to: f32, ms: f32, easing: Easing| Composite::Run {
        node,
        driver: Driver::Timing {
            to,
            duration_ms: ms,
            easing,
            delay_ms: 0.0,
        },
    };
    let mut steps = Vec::with_capacity(oriented.len() + 1);
    let Some(&(first_offset, first_value, _)) = oriented.first() else {
        return Composite::Sequence(steps);
    };
    // Without a keyframe at 0 the value goes from where it is, as CSS
    // goes from the underlying value.
    steps.push(timing_to(
        first_value,
        first_offset * duration,
        timing.easing,
    ));
    for pair in oriented.windows(2) {
        let ((a, _, easing), (b, value, _)) = (pair[0], pair[1]);
        steps.push(timing_to(value, (b - a) * duration, easing));
    }
    let last = oriented.last().map_or(1.0, |f| f.0);
    if last < 1.0 {
        steps.push(Composite::Delay((1.0 - last) * duration));
    }
    Composite::Sequence(steps)
}

/// The value `node` through `frames` as `timing` says: a tree of timing
/// steps the graph runs natively, each starting at the exact end of the
/// one before. Each iteration starts at its first keyframe (a jump, as in
/// CSS), so a loop of keyframes that end where they start never jumps;
/// a delay holds that first keyframe (CSS `animation-fill-mode:
/// backwards`). The value stays where the last iteration leaves it.
pub fn keyframes(node: NodeId, frames: &[Keyframe], timing: &KeyframeTiming) -> Composite {
    let frames = resolve(frames);
    let pass = |index| iteration(node, &frames, timing, timing.direction.reversed(index));
    let body = match (timing.iterations, timing.direction.alternates()) {
        (Some(0), _) => Composite::Sequence(Vec::new()),
        (Some(1), _) => pass(0),
        (iterations, false) => Composite::Loop {
            child: Box::new(pass(0)),
            iterations,
            reset: false,
        },
        (None, true) => Composite::Loop {
            child: Box::new(Composite::Sequence(vec![pass(0), pass(1)])),
            iterations: None,
            reset: false,
        },
        (Some(n), true) => {
            let pairs = Composite::Loop {
                child: Box::new(Composite::Sequence(vec![pass(0), pass(1)])),
                iterations: Some(n / 2),
                reset: false,
            };
            match n % 2 {
                0 => pairs,
                _ => Composite::Sequence(vec![pairs, pass(0)]),
            }
        }
    };
    if timing.delay_ms <= 0.0 {
        return body;
    }
    // During the delay the value already holds the first keyframe (CSS
    // `animation-fill-mode: backwards`), so a delayed entrance does not
    // show its view at rest first.
    let mut steps = Vec::with_capacity(3);
    let first = if timing.direction.reversed(0) {
        frames.last().map(|f| (1.0 - f.0, f.1))
    } else {
        frames.first().map(|f| (f.0, f.1))
    };
    if let Some((0.0, value)) = first {
        steps.push(Composite::Run {
            node,
            driver: Driver::Timing {
                to: value,
                duration_ms: 0.0,
                easing: Easing::Linear,
                delay_ms: 0.0,
            },
        });
    }
    steps.push(Composite::Delay(timing.delay_ms));
    steps.push(body);
    Composite::Sequence(steps)
}

/// Where the value of `frames` is when keyframes played as `timing` says
/// begin and when they end: `(start, end)`. `None` without keyframes.
pub fn keyframe_ends(frames: &[Keyframe], timing: &KeyframeTiming) -> Option<(f32, f32)> {
    let (first, last) = (frames.first()?.value, frames.last()?.value);
    let at = |backwards| if backwards { last } else { first };
    let start = at(timing.direction.reversed(0));
    let end = match timing.iterations {
        Some(0) => start,
        Some(n) => {
            if timing.direction.reversed(n - 1) {
                first
            } else {
                last
            }
        }
        // Stopped at some point; where a single iteration ends.
        None => {
            if timing.direction.reversed(0) {
                first
            } else {
                last
            }
        }
    };
    Some((start, end))
}

/// Where the items of a staggered group start counting from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StaggerFrom {
    /// The first item starts at once, the others one interval after the
    /// one before.
    #[default]
    First,
    /// The last item starts at once.
    Last,
    /// The middle item starts at once, the others spread out from it.
    Center,
    /// The item at this index starts at once.
    Index(usize),
}

/// How many intervals item `index` of `count` waits, counted from `from`.
pub fn stagger_delay(index: usize, count: usize, from: StaggerFrom) -> f32 {
    if count == 0 {
        return 0.0;
    }
    let index = index.min(count - 1);
    match from {
        StaggerFrom::First => index as f32,
        StaggerFrom::Last => (count - 1 - index) as f32,
        // Even counts have two middle items; both start at once.
        StaggerFrom::Center => (index as f32 - (count - 1) as f32 / 2.0).abs().floor(),
        StaggerFrom::Index(origin) => index.abs_diff(origin.min(count - 1)) as f32,
    }
}

/// What a motion moves: the opacity of a view and the parts of its
/// transform, applied in this order (translations first, then rotations,
/// then scales, about the view's transform origin).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MotionChannel {
    /// `opacity` (multiplies the view's), 0..1.
    Opacity,
    /// `translateX`, points.
    TranslateX,
    /// `translateY`, points.
    TranslateY,
    /// `rotate`, degrees clockwise.
    Rotate,
    /// `rotateX`, degrees.
    RotateX,
    /// `rotateY`, degrees.
    RotateY,
    /// `scale`.
    Scale,
    /// `scaleX`.
    ScaleX,
    /// `scaleY`.
    ScaleY,
}

impl MotionChannel {
    /// Every channel, in the order a motion applies them.
    pub const ALL: [MotionChannel; 9] = [
        MotionChannel::Opacity,
        MotionChannel::TranslateX,
        MotionChannel::TranslateY,
        MotionChannel::Rotate,
        MotionChannel::RotateX,
        MotionChannel::RotateY,
        MotionChannel::Scale,
        MotionChannel::ScaleX,
        MotionChannel::ScaleY,
    ];

    /// Its position in [`Self::ALL`].
    pub fn index(self) -> usize {
        self as usize
    }

    /// Its name in styles (`opacity`, `translateX`, ...).
    pub fn name(self) -> &'static str {
        match self {
            MotionChannel::Opacity => "opacity",
            MotionChannel::TranslateX => "translateX",
            MotionChannel::TranslateY => "translateY",
            MotionChannel::Rotate => "rotate",
            MotionChannel::RotateX => "rotateX",
            MotionChannel::RotateY => "rotateY",
            MotionChannel::Scale => "scale",
            MotionChannel::ScaleX => "scaleX",
            MotionChannel::ScaleY => "scaleY",
        }
    }

    /// The channel named `name`.
    pub fn parse(name: &str) -> Option<MotionChannel> {
        MotionChannel::ALL.into_iter().find(|c| c.name() == name)
    }

    /// Its value at rest (what changes nothing).
    pub fn identity(self) -> f32 {
        match self {
            MotionChannel::Opacity
            | MotionChannel::Scale
            | MotionChannel::ScaleX
            | MotionChannel::ScaleY => 1.0,
            _ => 0.0,
        }
    }

    /// The transform part it binds to (`None`: the opacity).
    pub fn transform(self) -> Option<TransformKind> {
        Some(match self {
            MotionChannel::Opacity => return None,
            MotionChannel::TranslateX => TransformKind::TranslateX,
            MotionChannel::TranslateY => TransformKind::TranslateY,
            MotionChannel::Rotate => TransformKind::Rotate,
            MotionChannel::RotateX => TransformKind::RotateX,
            MotionChannel::RotateY => TransformKind::RotateY,
            MotionChannel::Scale => TransformKind::Scale,
            MotionChannel::ScaleX => TransformKind::ScaleX,
            MotionChannel::ScaleY => TransformKind::ScaleY,
        })
    }
}

/// Several channels of a view through keyframes, played with one timing:
/// a preset ([`MotionPreset`]) or the app's own.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct MotionSpec {
    /// The keyframes of each channel it moves.
    pub tracks: Vec<(MotionChannel, Vec<Keyframe>)>,
    /// How they play.
    pub timing: KeyframeTiming,
}

impl MotionSpec {
    /// A motion over `timing` with no tracks yet.
    pub fn new(timing: KeyframeTiming) -> Self {
        Self {
            tracks: Vec::new(),
            timing,
        }
    }

    /// With `channel` through `frames` (replacing its track, if any).
    pub fn track(
        mut self,
        channel: MotionChannel,
        frames: impl IntoIterator<Item = Keyframe>,
    ) -> Self {
        let frames: Vec<Keyframe> = frames.into_iter().collect();
        match self.tracks.iter_mut().find(|(c, _)| *c == channel) {
            Some((_, f)) => *f = frames,
            None => self.tracks.push((channel, frames)),
        }
        self
    }

    /// With `channel` through `values`, spread evenly.
    pub fn values(self, channel: MotionChannel, values: impl IntoIterator<Item = f32>) -> Self {
        self.track(channel, values.into_iter().map(Keyframe::new))
    }

    /// With its timing changed by `f`.
    pub fn timing(mut self, f: impl FnOnce(KeyframeTiming) -> KeyframeTiming) -> Self {
        self.timing = f(self.timing);
        self
    }

    /// The tree that plays it on the channels' value nodes (`nodes`, by
    /// [`MotionChannel::index`]). `reduced`: the user asked for less motion,
    /// so it lands where it ends at once, without moving.
    pub fn composite(&self, nodes: &[NodeId; 9], reduced: bool) -> Composite {
        let mut children = Vec::with_capacity(self.tracks.len());
        for (channel, frames) in &self.tracks {
            let node = nodes[channel.index()];
            if reduced {
                let Some((_, end)) = keyframe_ends(frames, &self.timing) else {
                    continue;
                };
                children.push(Composite::Run {
                    node,
                    driver: Driver::Timing {
                        to: end,
                        duration_ms: 0.0,
                        easing: Easing::Linear,
                        delay_ms: 0.0,
                    },
                });
            } else {
                children.push(keyframes(node, frames, &self.timing));
            }
        }
        Composite::Parallel {
            children,
            stop_together: true,
        }
    }

    /// Where each channel it moves starts: a motion that brings a view in
    /// starts from there, set before its first frame shows.
    pub fn start_values(&self) -> impl Iterator<Item = (MotionChannel, f32)> + '_ {
        self.tracks.iter().filter_map(|(channel, frames)| {
            Some((*channel, keyframe_ends(frames, &self.timing)?.0))
        })
    }
}

/// What a preset is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionKind {
    /// Brings a view in: it starts hidden or away and ends at rest.
    Enter,
    /// Takes a view out: it starts at rest and ends hidden or away.
    Exit,
    /// Draws the eye: it starts and ends at rest.
    Attention,
    /// Repeats until stopped.
    Loop,
}

impl MotionKind {
    /// Its name (`enter`, `exit`, `attention`, `loop`).
    pub fn name(self) -> &'static str {
        match self {
            MotionKind::Enter => "enter",
            MotionKind::Exit => "exit",
            MotionKind::Attention => "attention",
            MotionKind::Loop => "loop",
        }
    }
}

/// Keyframes of a preset's track: `(offset, value)`.
type Track = (MotionChannel, &'static [(f32, f32)]);

/// A ready-made motion, as data.
#[derive(Debug)]
pub struct PresetDef {
    /// Its name in JS (`fadeIn`, `shake`, ...).
    pub name: &'static str,
    /// What it is for.
    pub kind: MotionKind,
    /// One line about it.
    pub doc: &'static str,
    duration_ms: f32,
    easing: Easing,
    iterations: Option<u32>,
    direction: PlaybackDirection,
    tracks: &'static [Track],
}

impl PresetDef {
    /// The motion.
    pub fn spec(&self) -> MotionSpec {
        let timing = KeyframeTiming {
            duration_ms: self.duration_ms,
            easing: self.easing,
            iterations: self.iterations,
            direction: self.direction,
            ..KeyframeTiming::default()
        };
        let mut spec = MotionSpec::new(timing);
        for (channel, frames) in self.tracks {
            spec = spec.track(*channel, frames.iter().map(|&(o, v)| Keyframe::at(o, v)));
        }
        spec
    }
}

use MotionChannel::{
    Opacity as O, Rotate as R, RotateX as RX, RotateY as RY, Scale as S, ScaleX as SX,
    ScaleY as SY, TranslateX as X, TranslateY as Y,
};

/// Strong deceleration: things that arrive.
const OUT_EXPO: Easing = Easing::Bezier(0.16, 1.0, 0.3, 1.0);
/// Things that leave.
const IN_QUART: Easing = Easing::Bezier(0.5, 0.0, 0.75, 0.0);
/// A slight overshoot.
const OUT_BACK: Easing = Easing::Bezier(0.34, 1.56, 0.64, 1.0);
const IN_OUT_SINE: Easing = Easing::Bezier(0.37, 0.0, 0.63, 1.0);

macro_rules! presets {
    ($(
        $(#[doc = $doc:literal])+
        $variant:ident $name:literal $kind:ident $ms:literal $easing:expr, $iterations:expr, $direction:ident
            [$($channel:ident: [$(($o:literal, $v:literal)),* $(,)?]),* $(,)?]
    )*) => {
        /// The ready-made motions: entrances, exits, attention seekers and
        /// loops, as data ([`PresetDef`]). Distances are in points, sized
        /// for controls and cards; scale a motion's values for larger
        /// views, or write your own keyframes.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum MotionPreset {
            $($(#[doc = $doc])+ $variant,)*
        }

        /// Every preset, in [`MotionPreset`]'s order.
        pub const PRESETS: &[PresetDef] = &[$(
            PresetDef {
                name: $name,
                kind: MotionKind::$kind,
                doc: concat!($($doc),+),
                duration_ms: $ms,
                easing: $easing,
                iterations: $iterations,
                direction: PlaybackDirection::$direction,
                tracks: &[$(($channel, &[$(($o, $v)),*])),*],
            },
        )*];

        impl MotionPreset {
            /// Every preset.
            pub const ALL: &[MotionPreset] = &[$(MotionPreset::$variant),*];
        }
    };
}

presets! {
    /// Fades in.
    FadeIn "fadeIn" Enter 300.0 Easing::EaseOut, Some(1), Normal [O: [(0.0, 0.0), (1.0, 1.0)]]
    /// Fades in, rising into place.
    FadeInUp "fadeInUp" Enter 450.0 OUT_EXPO, Some(1), Normal
        [O: [(0.0, 0.0), (1.0, 1.0)], Y: [(0.0, 24.0), (1.0, 0.0)]]
    /// Fades in, dropping into place.
    FadeInDown "fadeInDown" Enter 450.0 OUT_EXPO, Some(1), Normal
        [O: [(0.0, 0.0), (1.0, 1.0)], Y: [(0.0, -24.0), (1.0, 0.0)]]
    /// Fades in, coming from the left.
    FadeInLeft "fadeInLeft" Enter 450.0 OUT_EXPO, Some(1), Normal
        [O: [(0.0, 0.0), (1.0, 1.0)], X: [(0.0, -24.0), (1.0, 0.0)]]
    /// Fades in, coming from the right.
    FadeInRight "fadeInRight" Enter 450.0 OUT_EXPO, Some(1), Normal
        [O: [(0.0, 0.0), (1.0, 1.0)], X: [(0.0, 24.0), (1.0, 0.0)]]
    /// Fades in, growing from 90 %.
    ZoomIn "zoomIn" Enter 350.0 OUT_EXPO, Some(1), Normal
        [O: [(0.0, 0.0), (1.0, 1.0)], S: [(0.0, 0.9), (1.0, 1.0)]]
    /// Pops in: grows from half its size past its own and settles.
    PopIn "popIn" Enter 450.0 OUT_BACK, Some(1), Normal
        [O: [(0.0, 0.0), (0.4, 1.0), (1.0, 1.0)], S: [(0.0, 0.5), (1.0, 1.0)]]
    /// Bounces in, overshooting twice.
    BounceIn "bounceIn" Enter 650.0 Easing::Bezier(0.215, 0.61, 0.355, 1.0), Some(1), Normal
        [O: [(0.0, 0.0), (0.6, 1.0), (1.0, 1.0)],
         S: [(0.0, 0.3), (0.2, 1.1), (0.4, 0.9), (0.6, 1.03), (0.8, 0.97), (1.0, 1.0)]]
    /// Slides up from below, unfaded (sheets, toasts).
    SlideInUp "slideInUp" Enter 400.0 OUT_EXPO, Some(1), Normal [Y: [(0.0, 64.0), (1.0, 0.0)]]
    /// Slides down from above, unfaded.
    SlideInDown "slideInDown" Enter 400.0 OUT_EXPO, Some(1), Normal [Y: [(0.0, -64.0), (1.0, 0.0)]]
    /// Flips in about its horizontal axis.
    FlipInX "flipInX" Enter 600.0 Easing::EaseOut, Some(1), Normal
        [O: [(0.0, 0.0), (0.6, 1.0), (1.0, 1.0)], RX: [(0.0, 90.0), (0.4, -20.0), (0.6, 10.0), (0.8, -5.0), (1.0, 0.0)]]
    /// Flips in about its vertical axis.
    FlipInY "flipInY" Enter 600.0 Easing::EaseOut, Some(1), Normal
        [O: [(0.0, 0.0), (0.6, 1.0), (1.0, 1.0)], RY: [(0.0, 90.0), (0.4, -20.0), (0.6, 10.0), (0.8, -5.0), (1.0, 0.0)]]
    /// Fades out.
    FadeOut "fadeOut" Exit 250.0 Easing::EaseIn, Some(1), Normal [O: [(0.0, 1.0), (1.0, 0.0)]]
    /// Fades out, rising away.
    FadeOutUp "fadeOutUp" Exit 300.0 IN_QUART, Some(1), Normal
        [O: [(0.0, 1.0), (1.0, 0.0)], Y: [(0.0, 0.0), (1.0, -24.0)]]
    /// Fades out, dropping away.
    FadeOutDown "fadeOutDown" Exit 300.0 IN_QUART, Some(1), Normal
        [O: [(0.0, 1.0), (1.0, 0.0)], Y: [(0.0, 0.0), (1.0, 24.0)]]
    /// Fades out to the left.
    FadeOutLeft "fadeOutLeft" Exit 300.0 IN_QUART, Some(1), Normal
        [O: [(0.0, 1.0), (1.0, 0.0)], X: [(0.0, 0.0), (1.0, -24.0)]]
    /// Fades out to the right.
    FadeOutRight "fadeOutRight" Exit 300.0 IN_QUART, Some(1), Normal
        [O: [(0.0, 1.0), (1.0, 0.0)], X: [(0.0, 0.0), (1.0, 24.0)]]
    /// Fades out, shrinking to 90 %.
    ZoomOut "zoomOut" Exit 250.0 IN_QUART, Some(1), Normal
        [O: [(0.0, 1.0), (1.0, 0.0)], S: [(0.0, 1.0), (1.0, 0.9)]]
    /// Pops out: swells a little, then shrinks away.
    PopOut "popOut" Exit 300.0 Easing::EaseIn, Some(1), Normal
        [O: [(0.0, 1.0), (0.3, 1.0), (1.0, 0.0)], S: [(0.0, 1.0), (0.3, 1.08), (1.0, 0.5)]]
    /// Slides down out of view, unfaded.
    SlideOutDown "slideOutDown" Exit 300.0 IN_QUART, Some(1), Normal [Y: [(0.0, 0.0), (1.0, 64.0)]]
    /// Slides up out of view, unfaded.
    SlideOutUp "slideOutUp" Exit 300.0 IN_QUART, Some(1), Normal [Y: [(0.0, 0.0), (1.0, -64.0)]]
    /// Shakes sideways: a wrong password, an invalid field.
    Shake "shake" Attention 500.0 Easing::EaseInOut, Some(1), Normal
        [X: [(0.0, 0.0), (0.1, -8.0), (0.3, 8.0), (0.5, -8.0), (0.7, 8.0), (0.9, -4.0), (1.0, 0.0)]]
    /// Shakes its head: a gentler no.
    HeadShake "headShake" Attention 800.0 Easing::EaseInOut, Some(1), Normal
        [X: [(0.0, 0.0), (0.065, -6.0), (0.185, 5.0), (0.315, -3.0), (0.435, 2.0), (0.5, 0.0), (1.0, 0.0)],
         RY: [(0.0, 0.0), (0.065, -9.0), (0.185, 7.0), (0.315, -5.0), (0.435, 3.0), (0.5, 0.0), (1.0, 0.0)]]
    /// Wiggles about its center: something to notice.
    Wiggle "wiggle" Attention 600.0 Easing::EaseInOut, Some(1), Normal
        [R: [(0.0, 0.0), (0.15, -6.0), (0.3, 6.0), (0.45, -4.0), (0.6, 4.0), (0.75, -2.0), (1.0, 0.0)]]
    /// Swings side to side like a hanging sign (hang it from its top edge
    /// with a top transform origin).
    Swing "swing" Attention 900.0 Easing::EaseInOut, Some(1), Normal
        [R: [(0.0, 0.0), (0.2, 15.0), (0.4, -10.0), (0.6, 5.0), (0.8, -5.0), (1.0, 0.0)]]
    /// Grows a little and back: a soft emphasis.
    Pulse "pulse" Attention 500.0 Easing::EaseInOut, Some(1), Normal
        [S: [(0.0, 1.0), (0.5, 1.06), (1.0, 1.0)]]
    /// Beats twice, like a heart: a like, a favorite.
    Heartbeat "heartbeat" Attention 900.0 Easing::EaseInOut, Some(1), Normal
        [S: [(0.0, 1.0), (0.14, 1.25), (0.28, 1.0), (0.42, 1.25), (0.7, 1.0), (1.0, 1.0)]]
    /// Squashes and stretches like rubber.
    RubberBand "rubberBand" Attention 800.0 Easing::EaseInOut, Some(1), Normal
        [SX: [(0.0, 1.0), (0.3, 1.25), (0.4, 0.75), (0.5, 1.15), (0.65, 0.95), (0.75, 1.05), (1.0, 1.0)],
         SY: [(0.0, 1.0), (0.3, 0.75), (0.4, 1.25), (0.5, 0.85), (0.65, 1.05), (0.75, 0.95), (1.0, 1.0)]]
    /// Wobbles like jelly.
    Jello "jello" Attention 800.0 Easing::EaseInOut, Some(1), Normal
        [SX: [(0.0, 1.0), (0.2, 1.12), (0.4, 0.92), (0.6, 1.05), (0.8, 0.98), (1.0, 1.0)],
         SY: [(0.0, 1.0), (0.2, 0.88), (0.4, 1.08), (0.6, 0.95), (0.8, 1.02), (1.0, 1.0)]]
    /// Shrinks, then grows with a wiggle: a reward.
    Tada "tada" Attention 900.0 Easing::EaseInOut, Some(1), Normal
        [S: [(0.0, 1.0), (0.1, 0.9), (0.2, 0.9), (0.3, 1.1), (0.9, 1.1), (1.0, 1.0)],
         R: [(0.0, 0.0), (0.1, -3.0), (0.2, -3.0), (0.3, 3.0), (0.4, -3.0), (0.5, 3.0), (0.6, -3.0), (0.7, 3.0), (0.8, -3.0), (0.9, 3.0), (1.0, 0.0)]]
    /// Jumps and lands with a squash.
    Jump "jump" Attention 700.0 Easing::EaseInOut, Some(1), Normal
        [Y: [(0.0, 0.0), (0.4, -18.0), (0.55, -18.0), (0.8, 0.0), (1.0, 0.0)],
         SY: [(0.0, 1.0), (0.15, 0.9), (0.4, 1.05), (0.8, 0.92), (1.0, 1.0)]]
    /// Blinks out and in twice.
    Flash "flash" Attention 800.0 Easing::Linear, Some(1), Normal
        [O: [(0.0, 1.0), (0.25, 0.0), (0.5, 1.0), (0.75, 0.0), (1.0, 1.0)]]
    /// Turns once, forever (CSS `animate-spin`'s turn on a motion).
    Spin "spin" Loop 1000.0 Easing::Linear, None, Normal [R: [(0.0, 0.0), (1.0, 360.0)]]
    /// Floats up and down, forever.
    Float "float" Loop 1500.0 IN_OUT_SINE, None, Alternate [Y: [(0.0, 0.0), (1.0, -8.0)]]
    /// Breathes: grows and fades a little, forever.
    Breathe "breathe" Loop 1800.0 IN_OUT_SINE, None, Alternate
        [S: [(0.0, 1.0), (1.0, 1.05)], O: [(0.0, 1.0), (1.0, 0.8)]]
    /// Sways about its center, forever.
    Sway "sway" Loop 1600.0 IN_OUT_SINE, None, Alternate [R: [(0.0, -4.0), (1.0, 4.0)]]
    /// Bobs like a bouncing ball, forever (Tailwind's `animate-bounce`).
    Bob "bob" Loop 1000.0 Easing::Linear, None, Normal
        [Y: [(0.0, 0.0), (0.5, -12.0), (1.0, 0.0)]]
    /// Glows in and out, forever (Tailwind's `animate-pulse` on a motion).
    Glow "glow" Loop 2000.0 Easing::Bezier(0.4, 0.0, 0.6, 1.0), None, Normal
        [O: [(0.0, 1.0), (0.5, 0.5), (1.0, 1.0)]]
}

impl MotionPreset {
    /// Its definition.
    pub fn def(self) -> &'static PresetDef {
        &PRESETS[self as usize]
    }

    /// Its name in JS.
    pub fn name(self) -> &'static str {
        self.def().name
    }

    /// The preset named `name`.
    pub fn parse(name: &str) -> Option<MotionPreset> {
        MotionPreset::ALL.iter().copied().find(|p| p.name() == name)
    }

    /// The motion.
    pub fn spec(self) -> MotionSpec {
        self.def().spec()
    }
}

impl From<MotionPreset> for MotionSpec {
    fn from(preset: MotionPreset) -> Self {
        preset.spec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{AnimationOp, Finished, Graph};

    fn value(g: &mut Graph, node: NodeId, start: f32) {
        g.apply(
            AnimationOp::CreateValue { node, value: start },
            &mut Vec::new(),
        );
    }

    /// Runs `spec` on node 2 from `start`, sampled at `times` (ms).
    fn run(spec: Composite, start: f32, times: &[f64]) -> (Vec<f32>, Vec<Finished>) {
        let mut g = Graph::default();
        value(&mut g, 2, start);
        let mut f = Vec::new();
        g.apply(
            AnimationOp::StartComposite {
                animation: 10,
                key: 12,
                spec,
            },
            &mut f,
        );
        // Frames every 10 ms up to each sample (a composite starts at most a
        // few steps per frame).
        let mut out = Vec::new();
        let mut now = 0.0;
        for &t in times {
            while now + 10.0 < t {
                now += 10.0;
                g.tick(now / 1000.0, &mut f);
            }
            now = t;
            g.tick(t / 1000.0, &mut f);
            out.push((g.value(2).unwrap() * 1000.0).round() / 1000.0);
        }
        (out, f)
    }

    fn linear(ms: f32) -> KeyframeTiming {
        KeyframeTiming::new(ms).easing(Easing::Linear)
    }

    #[test]
    fn offsets_spread_as_the_web_animations_api_spreads_them() {
        let frames = [
            Keyframe::new(0.0),
            Keyframe::new(1.0),
            Keyframe::at(0.8, 2.0),
            Keyframe::new(3.0),
        ];
        let resolved: Vec<f32> = resolve(&frames).iter().map(|f| f.0).collect();
        assert_eq!(resolved, [0.0, 0.4, 0.8, 1.0]);
        assert_eq!(resolve(&[Keyframe::new(5.0)])[0].0, 1.0);
        // Out of order: held at the one before.
        let held: Vec<f32> = resolve(&[Keyframe::at(0.5, 0.0), Keyframe::at(0.2, 1.0)])
            .iter()
            .map(|f| f.0)
            .collect();
        assert_eq!(held, [0.5, 0.5]);
    }

    #[test]
    fn keyframes_play_their_segments_on_time() {
        let frames = [
            Keyframe::new(0.0),
            Keyframe::at(0.25, 10.0),
            Keyframe::new(0.0),
        ];
        let spec = keyframes(2, &frames, &linear(400.0));
        // The jump to the first keyframe happens on the first frame.
        let (values, f) = run(spec, 7.0, &[0.0, 50.0, 100.0, 250.0, 400.0, 450.0]);
        assert_eq!(values, [0.0, 5.0, 10.0, 5.0, 0.0, 0.0]);
        assert!(f.iter().any(|f| f.animation == 10 && f.finished), "{f:?}");
    }

    #[test]
    fn directions_iterations_and_delays() {
        let frames = [Keyframe::new(0.0), Keyframe::new(10.0)];
        let alternate = linear(100.0)
            .direction(PlaybackDirection::Alternate)
            .iterations(Some(3));
        let (values, _) = run(
            keyframes(2, &frames, &alternate),
            0.0,
            &[0.0, 50.0, 150.0, 250.0, 300.0, 400.0],
        );
        assert_eq!(values, [0.0, 5.0, 5.0, 5.0, 10.0, 10.0]);
        let reverse = linear(100.0)
            .direction(PlaybackDirection::Reverse)
            .delay(100.0);
        let (values, _) = run(
            keyframes(2, &frames, &reverse),
            3.0,
            &[0.0, 50.0, 150.0, 200.0],
        );
        // The delay holds the first keyframe (the last, backwards).
        assert_eq!(values, [10.0, 10.0, 5.0, 0.0]);
        // Endless: still going long after.
        let (values, f) = run(
            keyframes(2, &frames, &linear(100.0).infinite()),
            0.0,
            &[0.0, 10_050.0],
        );
        assert_eq!(values[1], 5.0);
        assert!(!f.iter().any(|f| f.animation == 10), "{f:?}");
        assert_eq!(
            keyframe_ends(&frames, &alternate.iterations(Some(2))),
            Some((0.0, 0.0))
        );
    }

    #[test]
    fn a_reversed_segment_runs_its_curve_backwards() {
        let ease = Easing::Bezier(0.42, 0.0, 1.0, 1.0);
        let frames = [Keyframe::new(0.0).ease(ease), Keyframe::new(1.0)];
        let timing = KeyframeTiming::new(100.0).direction(PlaybackDirection::Reverse);
        let (backwards, _) = run(keyframes(2, &frames, &timing), 0.0, &[0.0, 25.0]);
        let (forwards, _) = run(
            keyframes(2, &frames, &KeyframeTiming::new(100.0)),
            0.0,
            &[0.0, 75.0],
        );
        assert!(
            (backwards[1] - forwards[1]).abs() < 1e-3,
            "{backwards:?} {forwards:?}"
        );
    }

    #[test]
    fn steps_jump_as_in_css() {
        use super::super::sample_easing;
        use crate::animation::StepPosition::*;
        let at = |e| sample_easing(Easing::Steps(4, e), 5);
        assert_eq!(at(JumpEnd), [0.0, 0.25, 0.5, 0.75, 1.0]);
        assert_eq!(at(JumpStart), [0.25, 0.5, 0.75, 1.0, 1.0]);
        let none = sample_easing(Easing::Steps(3, JumpNone), 4);
        assert_eq!(none, [0.0, 0.5, 1.0, 1.0]);
        let both = sample_easing(Easing::Steps(1, JumpBoth), 3);
        assert_eq!(both, [0.5, 0.5, 1.0]);
        assert_eq!(
            Easing::Steps(2, JumpStart).reversed(),
            Easing::Steps(2, JumpEnd)
        );
    }

    #[test]
    fn staggering_counts_from_its_origin() {
        let delays = |from| {
            (0..5)
                .map(|i| stagger_delay(i, 5, from))
                .collect::<Vec<_>>()
        };
        assert_eq!(delays(StaggerFrom::First), [0.0, 1.0, 2.0, 3.0, 4.0]);
        assert_eq!(delays(StaggerFrom::Last), [4.0, 3.0, 2.0, 1.0, 0.0]);
        assert_eq!(delays(StaggerFrom::Center), [2.0, 1.0, 0.0, 1.0, 2.0]);
        assert_eq!(delays(StaggerFrom::Index(1)), [1.0, 0.0, 1.0, 2.0, 3.0]);
        let even: Vec<f32> = (0..4)
            .map(|i| stagger_delay(i, 4, StaggerFrom::Center))
            .collect();
        assert_eq!(even, [1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn presets_are_well_formed() {
        assert_eq!(PRESETS.len(), MotionPreset::ALL.len());
        for (i, preset) in MotionPreset::ALL.iter().enumerate() {
            let def = preset.def();
            assert_eq!(def.name, PRESETS[i].name);
            assert_eq!(MotionPreset::parse(def.name), Some(*preset));
            let spec = preset.spec();
            assert!(!spec.tracks.is_empty(), "{}", def.name);
            for (channel, frames) in &spec.tracks {
                let resolved = resolve(frames);
                assert_eq!(resolved.first().map(|f| f.0), Some(0.0), "{}", def.name);
                assert_eq!(resolved.last().map(|f| f.0), Some(1.0), "{}", def.name);
                assert!(
                    resolved.windows(2).all(|w| w[0].0 <= w[1].0),
                    "{}",
                    def.name
                );
                let (start, end) = keyframe_ends(frames, &spec.timing).unwrap();
                let rest = channel.identity();
                match def.kind {
                    MotionKind::Enter => assert_eq!(end, rest, "{} ends at rest", def.name),
                    MotionKind::Exit => assert_eq!(start, rest, "{} starts at rest", def.name),
                    MotionKind::Attention => {
                        assert_eq!((start, end), (rest, rest), "{}", def.name)
                    }
                    MotionKind::Loop => assert!(spec.timing.iterations.is_none(), "{}", def.name),
                }
            }
        }
    }

    #[test]
    fn a_reduced_motion_lands_at_its_end() {
        let spec = MotionPreset::FadeInUp.spec();
        let nodes = [2, 4, 6, 8, 10, 12, 14, 16, 18];
        let Composite::Parallel { children, .. } = spec.composite(&nodes, true) else {
            panic!()
        };
        assert_eq!(children.len(), 2);
        for child in &children {
            assert!(matches!(
                child,
                Composite::Run {
                    driver: Driver::Timing {
                        duration_ms: 0.0,
                        ..
                    },
                    ..
                }
            ));
        }
        let starts: Vec<_> = spec.start_values().collect();
        assert_eq!(
            starts,
            [
                (MotionChannel::Opacity, 0.0),
                (MotionChannel::TranslateY, 24.0)
            ]
        );
    }
}
