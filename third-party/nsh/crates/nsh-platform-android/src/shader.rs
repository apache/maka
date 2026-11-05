//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` on the UI thread next to the
//! animator and shown by `Box.java` as a bitmap under the view's children,
//! clipped to its rounded box as a background is.
//!
//! The layer stays here, by view id: `encode.rs` only tells Java which views
//! show a shader (`SHADER`), and Java reports their size in pixels
//! (`Native.shaderSize`). The GPU device is opened the first time a shader
//! is mounted on the `NshView` and kept across app loads. The animated slots
//! are written from the animation graph whenever its outputs are read
//! ([`crate::animation::UiAnimation::outputs`]), which also keeps the
//! `Choreographer` ticking while a shader view has a frame to render or
//! collect ([`ShaderView::wants_frame`]); each tick renders them, and a frame
//! that comes back crosses to Java once (`NshView.shaderFrame`), which copies
//! it into the view's bitmap.
//!
//! Effects, transitions and shaders reading what is behind them take
//! pictures Java makes (`Pictures.java`: the children, the backdrop, the
//! window, rendered by a `HardwareRenderer` into an `ImageReader`) and hands
//! over with `Native.shaderInput`. Java takes the children's and the
//! surface's only after they changed (`Box.java`'s `stale`), so they go to
//! the GPU as they come; a backdrop is taken before every window frame, and
//! one equal to the last is dropped ([`compared`]). Each frame says whether
//! it replaces the view's children (an effect always, a transition while it
//! runs): Java then draws the frame where the children were.
//!
//! A page's or a dialog's `transitionShader`
//! ([`MountItem::NavShader`](nsh_core::MountItem)) runs under the id of the
//! stack or the dialog it plays in (`Native.navTransition`), over its lower
//! side (`from`) and its upper side (`to`), each pictured once when it
//! starts: the view's transition clock moves `nsh.progress` from 0 to 1 as a
//! page or a dialog comes, from 1 to 0 as it goes
//! ([`ShaderView::start_transition_backwards`]). Java hears of it when a
//! frame comes back, which replaces what it covers, and once when its clock
//! ends, with a frame that does not: until the first frame comes back, what
//! it covers shows as it is, and a change no frame came back for by then
//! takes its own motion (`NavTransition.java`). A change that starts while
//! one runs ends that one first (`Native.navTransitionEnd`); when the user
//! asks for less motion none runs ([`through_shader`]).
//!
//! Without a device (`Renderer::new` is `None`) shader views show their
//! background and children: an effect gets no frames, a transition starts
//! no run, and a page or a dialog comes and goes with its own animation.

use std::{
    hash::{Hash, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};

use jni::{
    objects::{JObject, JValue},
    signature::{Primitive, ReturnType},
};
use nsh_core::{
    NavShader,
    geometry::{Points, size},
    shader::{ShaderInput, ShaderLayer},
};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use rustc_hash::FxHashMap;

use crate::java::{java, with_env};

/// The shader views of one `NshView` and the GPU device they render with.
#[derive(Default)]
pub(crate) struct Shaders {
    /// Opened the first time a shader is mounted (`Some(None)`: there is
    /// no device, and shader views show nothing of their own).
    renderer: Option<Option<Renderer>>,
    views: FxHashMap<u32, ShaderView>,
    /// What Java was last told of each view: whether frames replace the
    /// children, and the hash of its last backdrop ([`compared`]).
    told: FxHashMap<u32, (bool, u64)>,
    /// The pages' and dialogs' `transitionShader`s, by page or dialog id.
    nav: FxHashMap<u32, NavShader>,
    /// The running page and dialog transitions (by stack or dialog id),
    /// whose views are dropped once they end.
    navs: FxHashMap<u32, NavRun>,
}

/// A page or a dialog coming or going: when its view's transition clock
/// started, and for how long it runs.
struct NavRun {
    start: Instant,
    duration: Duration,
}

impl NavRun {
    /// Whether it ran its course at `now`.
    fn ended(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start) >= self.duration
    }
}

/// Whether a page or a dialog with a `transitionShader` comes or goes
/// through it: not when the user asks for less motion, where it takes its
/// own animation as the system's animator scale makes it (none at once).
pub(crate) fn through_shader(has_shader: bool, reduce_motion: bool) -> bool {
    has_shader && !reduce_motion
}

/// Whether `len` bytes hold `height` rows of `width` RGBA pixels `stride`
/// bytes apart. The last row needs only its pixels, as the engine's own
/// check takes it: an `ImageReader`'s plane leaves the padding of its last
/// row out, so pictures of widths whose rows are padded fit.
pub(crate) fn picture_fits(len: usize, width: u32, height: u32, stride: u32) -> bool {
    let row = u64::from(width) * 4;
    width > 0
        && height > 0
        && u64::from(stride) >= row
        && len as u64 >= u64::from(stride) * u64::from(height - 1) + row
}

/// Whether a picture of `input` is compared with the last one before it
/// goes to the GPU. A backdrop is pictured before every window frame, so
/// one that did not change is dropped; the others come only after what
/// they show changed, and a pass over each of them would be for nothing.
fn compared(input: ShaderInput) -> bool {
    input == ShaderInput::Backdrop
}

impl Shaders {
    /// Forgets every view (a new app runs), keeping the device. Java drops
    /// the frames they left itself (`NshView.endShaders`).
    pub(crate) fn clear(&mut self) {
        self.views.clear();
        self.told.clear();
        self.nav.clear();
        self.navs.clear();
    }

    fn renderer(&mut self) -> Option<&Renderer> {
        // Android's ARGB_8888 is R, G, B, A in memory, premultiplied.
        self.renderer
            .get_or_insert_with(|| Renderer::new(PixelFormat::Rgba))
            .as_ref()
    }

    /// Page or dialog `id`'s `transitionShader` (`None`: its animation).
    pub(crate) fn set_nav(&mut self, id: u32, shader: Option<NavShader>) {
        match shader {
            Some(s) => {
                self.nav.insert(id, s);
            }
            None => {
                self.nav.remove(&id);
            }
        }
    }

    /// Picture `input` of view `id`: `height` rows of `width` premultiplied
    /// RGBA pixels, `stride` bytes apart; a backdrop is dropped when it is
    /// the last one ([`compared`]).
    pub(crate) fn input(
        &mut self,
        id: u32,
        input: ShaderInput,
        picture: Option<(&[u8], u32, u32, u32)>,
    ) {
        if !self.views.contains_key(&id) || self.renderer().is_none() {
            return;
        }
        if compared(input) {
            let hash = picture.map_or(0, |(pixels, w, h, stride)| {
                let mut hasher = rustc_hash::FxHasher::default();
                (w, h, stride).hash(&mut hasher);
                pixels.hash(&mut hasher);
                hasher.finish() | 1
            });
            let told = &mut self.told.entry(id).or_default().1;
            if *told == hash {
                return;
            }
            *told = hash;
        }
        if let (Some(Some(renderer)), Some(view)) = (&self.renderer, self.views.get_mut(&id)) {
            view.set_input(renderer, input, picture);
        }
    }

    /// View `id`'s transition starts (its `from` picture came first);
    /// whether it runs. Without a device none does: its children show as
    /// they are.
    pub(crate) fn start_transition(&mut self, id: u32, duration: Duration) -> bool {
        if self.renderer().is_none() {
            return false;
        }
        let Some(view) = self.views.get_mut(&id).filter(|v| v.layer().is_some()) else {
            return false;
        };
        view.start_transition(duration, Instant::now());
        true
    }

    /// A page or a dialog comes or goes (`reverse`) through `page`'s
    /// `transitionShader` over the view `key` (the stack or the dialog) of
    /// `width` × `height` pixels at `density`: `from` is its lower side (the
    /// page under it, the window without the dialog), `to` its upper side
    /// (each `(pixels, stride)` at that size), uploaded once. Whether it
    /// runs: not without a device or when the user asks for less motion
    /// (`reduce_motion`), so the page or the dialog comes with its own
    /// animation. One still running over `key` ended first (Java ends it
    /// before it takes the pictures); one left is replaced.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn nav_transition(
        &mut self,
        key: u32,
        page: u32,
        size_px: (i32, i32),
        density: f32,
        from: (&[u8], u32),
        to: (&[u8], u32),
        reverse: bool,
        reduce_motion: bool,
    ) -> bool {
        let shader = self.nav.get(&page).cloned();
        if !through_shader(shader.is_some(), reduce_motion) {
            return false;
        }
        let Some(nav) = shader else {
            return false;
        };
        self.end_nav(key);
        self.renderer();
        let Some(Some(renderer)) = &self.renderer else {
            return false;
        };
        // The pictures cover the host's box.
        let layer = (*nav.layer).clone().with_overflow(Points::ZERO);
        let (w, h) = (size_px.0.max(0) as u32, size_px.1.max(0) as u32);
        let mut view = ShaderView::default();
        view.set_layer(Some(Arc::new(layer)));
        let d = density.max(f32::MIN_POSITIVE);
        view.set_size(size(Points(w as f32 / d), Points(h as f32 / d)), d);
        view.set_input(renderer, ShaderInput::From, Some((from.0, w, h, from.1)));
        view.set_input(renderer, ShaderInput::To, Some((to.0, w, h, to.1)));
        let run = start_nav(&mut view, nav.duration, reverse, Instant::now());
        self.views.insert(key, view);
        self.navs.insert(key, run);
        true
    }

    /// The page or dialog transition over `key` ends at once (another
    /// change starts, or Java drops it): no more frames are rendered for
    /// it, and none is sent.
    pub(crate) fn end_nav(&mut self, key: u32) {
        if self.navs.remove(&key).is_some() {
            self.views.remove(&key);
            self.told.remove(&key);
        }
    }

    /// Mounts `layer` on view `id` (`None`: it shows nothing of its own).
    pub(crate) fn set(&mut self, id: u32, layer: Option<Arc<ShaderLayer>>) {
        if layer.is_none() && !self.views.contains_key(&id) {
            return;
        }
        if layer.is_some() {
            self.renderer();
        }
        if layer.is_none() {
            self.told.remove(&id);
        }
        self.views.entry(id).or_default().set_layer(layer);
    }

    /// View `id` is `width` × `height` pixels at `density` pixels per point
    /// (Java reports it before the layer arrives, so this may come first).
    pub(crate) fn resized(&mut self, id: u32, width: i32, height: i32, density: f32) {
        let density = density.max(f32::MIN_POSITIVE);
        self.views.entry(id).or_default().set_size(
            size(
                Points(width.max(0) as f32 / density),
                Points(height.max(0) as f32 / density),
            ),
            density,
        );
    }

    /// View `id` is gone.
    pub(crate) fn delete(&mut self, id: u32) {
        self.views.remove(&id);
        self.told.remove(&id);
        self.nav.remove(&id);
        self.navs.remove(&id);
    }

    /// Whether view `id` shows (or showed) a shader: its animated values are
    /// written here, never sent to Java.
    pub(crate) fn contains(&self, id: u32) -> bool {
        self.views.contains_key(&id)
    }

    /// The views, to write their animated slots.
    pub(crate) fn views_mut(&mut self) -> impl Iterator<Item = (u32, &mut ShaderView)> {
        self.views.iter_mut().map(|(&id, view)| (id, view))
    }

    /// Whether a view has a frame to render or collect.
    pub(crate) fn wants_frame(&self) -> bool {
        matches!(self.renderer, Some(Some(_)))
            && (!self.navs.is_empty() || self.views.values().any(ShaderView::wants_frame))
    }

    /// One `Choreographer` frame: renders the views that have a frame due,
    /// hands those that came back to `nsh_view` (the `NshView`); whether
    /// one wants another frame.
    pub(crate) fn render(&mut self, nsh_view: &JObject<'_>) -> bool {
        let Some(Some(renderer)) = &self.renderer else {
            return false;
        };
        let now = Instant::now();
        let mut more = false;
        let mut ended = Vec::new();
        for (&id, view) in &mut self.views {
            if let Some(run) = self.navs.get(&id) {
                // A page or a dialog: frames while its clock runs, and one
                // that replaces nothing when it ends (Java settles it, or
                // runs its own motion if no frame came back). Until the
                // first frame comes back, what it covers shows as it is, so
                // an empty frame is never taken for its end.
                if run.ended(now) {
                    deliver(nsh_view, id, &Frame::default(), false, 0.0);
                    ended.push(id);
                    continue;
                }
                if view.wants_frame() && view.render(renderer, now) && view.frame().width > 0 {
                    deliver(nsh_view, id, view.frame(), true, view.overflow().0);
                }
                more = true;
                continue;
            }
            // Until its pictures came, the children show as they are.
            let replaces = view.replaces_children(now) && pictured(view);
            let told = self.told.entry(id).or_default();
            let flipped = told.0 != replaces;
            told.0 = replaces;
            let fresh = view.wants_frame() && view.render(renderer, now);
            if fresh || flipped {
                let frame = view.frame();
                deliver(
                    nsh_view,
                    id,
                    frame,
                    replaces && frame.width > 0,
                    view.overflow().0,
                );
            }
            more |= view.wants_frame();
        }
        for id in ended {
            self.end_nav(id);
        }
        more
    }
}

/// Starts `view`'s transition clock for a page or a dialog that comes
/// (`nsh.progress` from 0 to 1) or goes (`reverse`: from 1 to 0), `duration`
/// long from `now`.
fn start_nav(view: &mut ShaderView, duration: Duration, reverse: bool, now: Instant) -> NavRun {
    if reverse {
        view.start_transition_backwards(duration, now);
    } else {
        view.start_transition(duration, now);
    }
    NavRun {
        start: now,
        duration,
    }
}

/// Whether `view` has the pictures of what it replaces (its children's or
/// a transition's sides) that its shader reads.
fn pictured(view: &ShaderView) -> bool {
    view.layer().is_some_and(|layer| {
        layer
            .shader
            .inputs()
            .iter()
            .filter(|&i| i != ShaderInput::Backdrop)
            .all(|i| view.has_input(i))
    })
}

/// `NshView.shaderFrame(id, pixels, width, height, replaces, overflow)`:
/// Java copies the pixels into the view's bitmap (null pixels: an empty
/// frame); `replaces` says whether it shows instead of the children,
/// `overflow` how far beyond the box it reaches, in points.
fn deliver(nsh_view: &JObject<'_>, id: u32, frame: &Frame, replaces: bool, overflow: f32) {
    let pixels = frame.tight();
    let (width, height) = (frame.width as i32, frame.height as i32);
    with_env(|env| {
        let buffer = if width > 0 && height > 0 && !pixels.is_empty() {
            // SAFETY: `pixels` is a live, non-empty allocation of this
            // length that outlives the call below; Java only reads it, and
            // copies it out before `shaderFrame` returns without keeping
            // the buffer.
            JObject::from(unsafe {
                env.new_direct_byte_buffer(pixels.as_ptr().cast_mut(), pixels.len())
            }?)
        } else {
            JObject::null()
        };
        // SAFETY: matches the signature checked in `java::init`.
        unsafe {
            env.call_method_unchecked(
                nsh_view,
                java().view_shader_frame,
                ReturnType::Primitive(Primitive::Void),
                &[
                    JValue::Int(id as i32).as_jni(),
                    JValue::Object(&buffer).as_jni(),
                    JValue::Int(width).as_jni(),
                    JValue::Int(height).as_jni(),
                    JValue::Bool(replaces.into()).as_jni(),
                    JValue::Float(overflow).as_jni(),
                ],
            )
        }
        .map(|_| ())
    });
}

#[cfg(test)]
mod tests {
    use nsh_core::shader::{Shader, ShaderRole};

    use super::*;

    /// A page's or a dialog's transition view, from its lower side to its
    /// upper one.
    fn nav_view() -> ShaderView {
        let source = "fn shade(uv: vec2f) -> vec4f { return mix(sample_from(uv), sample_to(uv), nsh.progress); }";
        let layer = ShaderLayer::new(
            Shader::compile(source).expect("a shader"),
            &[],
            &mut Vec::new(),
        )
        .with_role(ShaderRole::Transition);
        let mut view = ShaderView::default();
        view.set_layer(Some(Arc::new(layer)));
        view
    }

    #[test]
    fn a_picture_fits_without_its_last_rows_padding() {
        // Three pixels a row (12 bytes), rows 16 bytes apart: the last one
        // ends at its pixels, as an `ImageReader`'s plane does.
        assert!(picture_fits(16 * 3 + 12, 3, 4, 16));
        assert!(picture_fits(16 * 4, 3, 4, 16));
        assert!(
            !picture_fits(16 * 3 + 11, 3, 4, 16),
            "the last row cut short"
        );
        assert!(
            !picture_fits(1024, 3, 4, 8),
            "rows shorter than their pixels"
        );
        assert!(!picture_fits(1024, 0, 4, 16));
        assert!(!picture_fits(1024, 3, 0, 16));
    }

    #[test]
    fn less_motion_keeps_pages_and_dialogs_off_their_shader() {
        assert!(through_shader(true, false));
        assert!(!through_shader(true, true), "their own reduced motion");
        assert!(
            !through_shader(false, false),
            "no shader: their own animation"
        );
    }

    #[test]
    fn only_backdrops_are_compared_with_the_last_picture() {
        assert!(compared(ShaderInput::Backdrop));
        for input in [ShaderInput::Content, ShaderInput::From, ShaderInput::To] {
            assert!(!compared(input), "{input:?} comes only after a change");
        }
    }

    #[test]
    fn a_page_change_runs_on_its_views_transition_clock_both_ways() {
        let now = Instant::now();
        let duration = Duration::from_millis(350);
        // A push or a presentation, then a pop or a dismissal (backwards).
        for reverse in [false, true] {
            let mut view = nav_view();
            let run = start_nav(&mut view, duration, reverse, now);
            assert!(view.wants_frame(), "{reverse}: frames while it runs");
            assert!(view.transitioning(now + duration / 2), "{reverse}");
            assert!(!run.ended(now + duration / 2), "{reverse}");
            assert!(run.ended(now + duration), "{reverse}");
            assert!(
                !view.transitioning(now + duration),
                "{reverse}: its clock ended"
            );
        }
    }

    #[test]
    fn an_interrupted_page_change_renders_no_more_frames() {
        let mut shaders = Shaders::default();
        // A stack's key (`NavTransition.java`: its id with the top bit),
        // and a shader view's id.
        let (key, other) = ((1 << 31) | 6, 8);
        let mut view = nav_view();
        let run = start_nav(&mut view, Duration::from_millis(350), false, Instant::now());
        shaders.views.insert(key, view);
        shaders.navs.insert(key, run);
        shaders.views.insert(other, nav_view());
        shaders.end_nav(key);
        assert!(!shaders.contains(key), "its view goes");
        assert!(shaders.navs.is_empty(), "its clock goes");
        // A key that runs no page change leaves the view of that id alone.
        shaders.end_nav(other);
        assert!(shaders.contains(other));
        // A new app: every change goes.
        let mut view = nav_view();
        let run = start_nav(&mut view, Duration::from_millis(350), true, Instant::now());
        shaders.views.insert(key, view);
        shaders.navs.insert(key, run);
        shaders.clear();
        assert!(shaders.navs.is_empty() && !shaders.contains(key));
    }
}
