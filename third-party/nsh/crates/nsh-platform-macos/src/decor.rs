//! Backgrounds, borders, rounded corners, clipping and shadows, all drawn by
//! Core Animation on a view's layer and sublayers ([`apply`]).
//!
//! The cheap path is the view's own layer: `cornerRadius` covers every
//! shape whose corners share one radius. Other corners need shape layers
//! (scroll views take the largest radius instead). A view
//! that both clips its children and draws outside its box (an outer box
//! shadow, an outline) gets a container ([`NshView::ensure_container`])
//! that clips the children, so its own layer keeps what it draws outside
//! (clipping a layer clips that too). Scroll
//! views always have a container: there it clips too, and the decoration
//! stays in the view's own layer, where it does not scroll.
//!
//! A shader view's frames are the contents of a sublayer
//! ([`crate::shader`]) shaped here as an image view's image layer is.
//!
//! Text and canvas views draw into their layer's contents (`drawRect:`),
//! which Core Animation shows below every sublayer: their background is the
//! layer's own, never a fill layer, and nothing inside the box is drawn over
//! them but borders.
//!
//! A `drop-shadow()` filter is the layer's own shadow: it follows the
//! content.
//!
//! [`apply`] runs on every frame of an animation that touches the view
//! (transitions, animated colors): it compares what it applied last and
//! only sets the colors when nothing else changed.

use nsh_core::{
    BorderStyle, Borders, Color, CornerRadii, Edges, ObjectPosition, Points, ResizeMode, ViewKind,
    ViewStyle,
    geometry::{px, size},
};
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColor, CGMutablePath};
use objc2_foundation::{NSArray, NSNumber, ns_string};
use objc2_quartz_core::{
    CAKeyframeAnimation, CALayer, CAMediaTiming, CAShapeLayer, CATransition, kCAAnimationDiscrete,
    kCACornerCurveCircular, kCACornerCurveContinuous, kCAFillRuleEvenOdd, kCAGravityResize,
    kCALineCapButt, kCALineCapRound, kCATransitionFade,
};

use crate::{
    image::Decoded,
    surface::quiet,
    view::{NshView, ViewState},
};

/// Fills sit behind the children. Borders too (CSS), except where the
/// children are clipped: there they are drawn in front, as the layer's own
/// border always is.
pub(crate) const BEHIND: CGFloat = -1024.0;
const BORDER_BEHIND: CGFloat = BEHIND + 1.0;
const IN_FRONT: CGFloat = 1024.0;

/// What a view is, as far as decoration goes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    /// Has children.
    View,
    /// Draws its content in the layer itself (below any sublayer).
    Text,
    /// Shows an image in a [`Decor`] image sublayer.
    Image,
    /// Has a container that scrolls; its decoration must not.
    Scroll,
}

impl Kind {
    fn of(state: &ViewState) -> Self {
        match state.kind {
            ViewKind::Scroll => Kind::Scroll,
            ViewKind::Image => Kind::Image,
            ViewKind::Text | ViewKind::Canvas => Kind::Text,
            _ if state.draws() => Kind::Text,
            _ => Kind::View,
        }
    }
}

/// What shapes the layers: when it is unchanged, only colors may need
/// setting again.
#[derive(Clone, PartialEq)]
struct Shape {
    kind: Kind,
    size: (f32, f32),
    radii: CornerRadii,
    clips: bool,
    widths: Edges<Points>,
    border_style: BorderStyle,
    /// Whether every side has the same color (one ring layer, or four).
    one_color: bool,
    tint: Option<Color>,
    outline: nsh_core::Outline,
    effects: Option<std::sync::Arc<nsh_core::Effects>>,
    /// It shows a shader's frames ([`crate::shader`]).
    shader: bool,
}

/// The colors [`apply`] set last.
#[derive(Clone, Copy, PartialEq)]
struct Colors {
    background: Color,
    borders: [Color; 4],
}

/// The layers decoration added to a view, created on demand.
#[derive(Default)]
pub(crate) struct Decor {
    /// Background for corners of different radii.
    fill: Option<Retained<CAShapeLayer>>,
    /// Border for corners of different radii, dashes, or behind children.
    stroke: Option<Retained<CAShapeLayer>>,
    /// Clip shape for corners of different radii.
    mask: Option<Retained<CAShapeLayer>>,
    /// Borders whose sides differ: one even-odd ring per color.
    ring: Vec<Retained<CAShapeLayer>>,
    /// Image content (image views only): clips the picture to the view's
    /// shape.
    image: Option<Retained<CALayer>>,
    /// The image itself, inside [`Decor::image`], framed where the resize
    /// mode and the position put it.
    picture: Option<Retained<CALayer>>,
    /// The image shown, and its natural size in points.
    contents: Option<(Decoded, (f32, f32))>,
    /// How the image fits.
    mode: ResizeMode,
    /// Where the fitted image sits.
    position: ObjectPosition,
    /// `tintColor`: the image layer shows this color through a mask of the
    /// image.
    tint: Option<(Color, Retained<CALayer>)>,
    /// Layered shadows, gradients, outline, filters.
    visual: crate::visual::Visual,
    /// What was applied last.
    shape: Option<Box<Shape>>,
    colors: Option<Colors>,
}

impl Decor {
    /// The image layer of an image view, made on first use (clipped on its
    /// own, so the view's layer can cast an unclipped shadow), with the
    /// picture layer inside it.
    fn image_layer(&mut self) -> Retained<CALayer> {
        if let Some(l) = &self.image {
            return l.clone();
        }
        let l = CALayer::new();
        l.setMasksToBounds(true);
        let picture = CALayer::new();
        // SAFETY: an immutable Core Animation constant.
        picture.setContentsGravity(unsafe { kCAGravityResize });
        l.addSublayer(&picture);
        self.image = Some(l.clone());
        self.picture = Some(picture);
        // Shaped (and added to the view's layer) by the next `apply`.
        self.shape = None;
        l
    }

    /// Shows `image` (natural size `natural` in points), fading in over
    /// `fade` seconds; an animated image plays its frames, forever.
    pub(crate) fn set_image(&mut self, image: Option<(&Decoded, (f32, f32))>, fade: f64) {
        self.contents = image.map(|(d, n)| (d.clone(), n));
        self.image_layer();
        let Some(layer) = self.picture.clone() else {
            return;
        };
        let key = ns_string!("frames");
        layer.removeAnimationForKey(key);
        if fade > 0.0 {
            // A crossfade from what was shown (nothing or a placeholder).
            let transition = CATransition::animation();
            transition.setDuration(fade);
            // SAFETY: an immutable Core Animation constant.
            transition.setType(unsafe { kCATransitionFade });
            layer.addAnimation_forKey(&transition, Some(ns_string!("fade")));
        }
        quiet(|| {
            self.show_contents();
            self.fit_contents();
        });
        let Some((decoded, _)) = &self.contents else {
            return;
        };
        if decoded.frames.len() > 1 && self.tint.is_none() {
            let values: Vec<Retained<AnyObject>> =
                decoded.frames.iter().map(|f| image_object(f)).collect();
            let times: Vec<Retained<NSNumber>> = decoded
                .key_times
                .iter()
                .map(|t| NSNumber::new_f64(*t))
                .collect();
            let animation = CAKeyframeAnimation::animationWithKeyPath(Some(ns_string!("contents")));
            // SAFETY: an array of CGImages, valid `contents` values.
            unsafe { animation.setValues(Some(&NSArray::from_retained_slice(&values))) };
            animation.setKeyTimes(Some(&NSArray::from_retained_slice(&times)));
            // SAFETY: an immutable Core Animation constant.
            animation.setCalculationMode(unsafe { kCAAnimationDiscrete });
            animation.setDuration(decoded.duration);
            animation.setRepeatCount(f32::INFINITY);
            animation.setRemovedOnCompletion(false);
            layer.addAnimation_forKey(&animation, Some(key));
        }
    }

    /// Puts the image into the picture layer, or into the tint mask.
    fn show_contents(&self) {
        let Some(layer) = &self.picture else { return };
        let target = match &self.tint {
            Some((_, tint)) => {
                // SAFETY: clearing the contents.
                unsafe { layer.setContents(None) };
                match tint.mask() {
                    Some(mask) => mask,
                    None => return,
                }
            }
            None => layer.clone(),
        };
        let image = self
            .contents
            .as_ref()
            .map(|(d, _)| image_object(&d.frames[0]));
        // SAFETY: a CGImage is a valid `contents` object.
        unsafe { target.setContents(image.as_deref()) };
    }

    /// How an image view fits its image.
    pub(crate) fn resize_mode(&self) -> ResizeMode {
        self.mode
    }

    /// How an image view fits its image (`objectFit`) and where it places
    /// it (`objectPosition`).
    pub(crate) fn set_fit(&mut self, mode: ResizeMode, position: ObjectPosition) {
        if self.mode != mode || self.position != position || self.image.is_none() {
            self.mode = mode;
            self.position = position;
            self.image_layer();
            quiet(|| self.fit_contents());
        }
    }

    /// Frames the picture layer (and the tint in it) where the resize mode
    /// and the position put the image in the image layer, which crops what
    /// reaches outside: `center` shows the image at its natural size,
    /// `scale-down` too unless it is larger than the view (then it is
    /// shrunk to fit), as CSS's `object-fit`.
    fn fit_contents(&self) {
        let (Some(layer), Some(picture)) = (&self.image, &self.picture) else {
            return;
        };
        let bounds = layer.bounds().size;
        let natural = self.contents.as_ref().map(|(d, n)| (d, *n));
        let (w, h) = natural.map_or((0.0, 0.0), |(_, n)| n);
        let fitted = self.mode.fit(
            size(px(w), px(h)),
            size(px(bounds.width as f32), px(bounds.height as f32)),
            self.position,
        );
        let frame = CGRect::new(
            CGPoint::new(fitted.origin.x.0 as CGFloat, fitted.origin.y.0 as CGFloat),
            CGSize::new(
                fitted.size.width.0 as CGFloat,
                fitted.size.height.0 as CGFloat,
            ),
        );
        picture.setFrame(frame);
        // Pixels per point of the decoded image at its natural size.
        let scale = natural.map_or(1.0, |(d, (w, _))| {
            if w > 0.0 {
                d.pixel_width() as CGFloat / w as CGFloat
            } else {
                1.0
            }
        });
        picture.setContentsScale(scale.max(0.01));
        if let Some((_, tint)) = &self.tint {
            let inner = CGRect::new(CGPoint::new(0.0, 0.0), frame.size);
            tint.setFrame(inner);
            if let Some(mask) = tint.mask() {
                mask.setFrame(inner);
                mask.setContentsScale(scale.max(0.01));
            }
        }
    }

    /// Shows the image in a single color (`tintColor`), or as is.
    fn set_tint(&mut self, tint: Option<Color>) {
        let Some(layer) = self.picture.clone() else {
            return;
        };
        match (tint, self.tint.clone()) {
            (Some(color), Some((current, t))) => {
                if color != current {
                    t.setBackgroundColor(cg_color(color).as_deref());
                    self.tint = Some((color, t));
                }
            }
            (Some(color), None) => {
                let t = CALayer::new();
                t.setBackgroundColor(cg_color(color).as_deref());
                let mask = CALayer::new();
                // SAFETY: an immutable Core Animation constant.
                mask.setContentsGravity(unsafe { kCAGravityResize });
                // SAFETY: a fresh mask layer owned by the tint layer.
                unsafe { t.setMask(Some(&mask)) };
                layer.addSublayer(&t);
                // A tinted image does not animate its frames.
                layer.removeAnimationForKey(ns_string!("frames"));
                self.tint = Some((color, t));
                self.show_contents();
            }
            (None, Some((_, t))) => {
                t.removeFromSuperlayer();
                self.tint = None;
                self.show_contents();
            }
            (None, None) => {}
        }
    }

    /// Sets the background color: the fill layer's if there is one.
    fn set_background(&self, layer: &CALayer, color: Color) {
        match &self.fill {
            Some(fill) => fill.setFillColor(cg_color(color).as_deref()),
            None => layer.setBackgroundColor(cg_color(color).as_deref()),
        }
    }

    /// Sets the colors of the border layers [`Decor::shape`] made.
    fn set_border_colors(&self, layer: &CALayer, container: Option<&CALayer>, b: &Borders) {
        if let Some(s) = &self.stroke {
            s.setStrokeColor(cg_color(b.colors[0]).as_deref());
        }
        for (i, r) in self.ring.iter().enumerate() {
            r.setFillColor(cg_color(b.colors[i]).as_deref());
        }
        let border_layer = container.unwrap_or(layer);
        if border_layer.borderWidth() > 0.0 {
            border_layer.setBorderColor(cg_color(b.colors[0]).as_deref());
        }
    }

    /// Shapes the layers of `view` after `s` at its current size.
    #[allow(clippy::too_many_arguments)]
    fn shape(
        &mut self,
        view: &NshView,
        layer: &CALayer,
        container: Option<&CALayer>,
        kind: Kind,
        s: &ViewState,
        shape: &Shape,
    ) {
        let style = &s.style;
        let size = CGSize::new(shape.size.0 as CGFloat, shape.size.1 as CGFloat);
        let (w, h) = shape.size;
        let local = CGRect::new(CGPoint::ZERO, size);
        let raw = style.radii();
        let radii = shape.radii;
        let borders = s.borders();
        let clips = shape.clips;
        // Sides that differ are drawn as rings; equal sides by the layer's
        // border or a stroke.
        let uniform = borders.uniform().filter(|_| borders.is_visible());
        let ring = uniform.is_none() && borders.is_visible();
        let border = uniform.is_some();
        let dashed = borders.style != BorderStyle::Solid;

        // Corners sharing one radius are drawn by the layer itself. Scroll
        // views always do so (a mask on their container would scroll): the
        // largest radius stands in for the others.
        let shared = shared(&raw).or_else(|| {
            (kind == Kind::Scroll).then(|| raw.to_array().into_iter().fold(0.0, |m, r| r.0.max(m)))
        });

        // Text draws into the layer's own contents, below every sublayer:
        // it cannot have a fill layer, so its odd corners clip it instead.
        let border_behind = kind == Kind::View && !clips;
        let stroke = border && (shared.is_none() || border_behind || dashed);
        // Core Animation's continuous corners differ slightly from the
        // shared outline (`nsh_core::shape`): a stroke drawn along the
        // latter gets its background from the same outline. A backdrop
        // blur is a subview, above the layer's own background: the
        // background moves to a fill layer above the blur.
        // An opaque background under outer box shadows moves to the fill
        // layer too: above the shadows, it hides them inside the box, and
        // they need no mask (`visual.rs`).
        let covers_shadows = crate::visual::has_outer_shadow(style)
            && style.background_color.0 & 0xff == 0xff
            && s.anim.background.is_none();
        let fill = (shared.is_none()
            || (raw.continuous && stroke)
            || crate::visual::has_backdrop(style)
            || covers_shadows)
            && kind != Kind::Text;

        // Corners of the layer itself. Core Animation draws nothing for a
        // radius over half the short side (`rounded-full` is 9999). Empty
        // views get none: in-process renderings draw an empty layer's
        // background as the corners of its radius (list cells the core
        // never placed are 0 × 0 at their parent's origin).
        let half = w.min(h).max(0.0) / 2.0;
        let r = shared.map_or(0.0, |r| r.min(half)) as CGFloat;
        // Continuous corners need about 1.53 times their radius of straight
        // edge; past that Core Animation draws them with stray edges (in
        // process renderings): a circle or a pill is circular anyway.
        let continuous = raw.continuous && (r as f32) * 1.528 <= half;
        set_corners(layer, r, continuous);

        // Background.
        match (fill, &self.fill) {
            (true, None) => {
                let f = CAShapeLayer::new();
                f.setZPosition(BEHIND);
                layer.insertSublayer_atIndex(&f, 0);
                self.fill = Some(f);
                layer.setBackgroundColor(None);
            }
            (false, Some(f)) => {
                f.removeFromSuperlayer();
                self.fill = None;
            }
            _ => {}
        }
        if let Some(f) = &self.fill {
            f.setFrame(local);
            f.setPath(Some(&rounded(local, radii)));
        }

        // Border: a stroke behind the children or for odd corners, else the
        // layer's own (on the container when there is one, so the children
        // do not cover it).
        match (stroke, &self.stroke) {
            (true, None) => {
                let st = CAShapeLayer::new();
                st.setFillColor(None);
                layer.addSublayer(&st);
                self.stroke = Some(st);
            }
            (false, Some(st)) => {
                st.removeFromSuperlayer();
                self.stroke = None;
            }
            _ => {}
        }
        let bw = uniform.map_or(0.0, |(w, _)| w.0);
        if let Some(st) = &self.stroke {
            st.setZPosition(if border_behind {
                BORDER_BEHIND
            } else {
                IN_FRONT
            });
            st.setFrame(local);
            st.setPath(Some(&rounded(
                inset(local, (bw / 2.0) as CGFloat),
                radii.inset(px(bw / 2.0)),
            )));
            st.setLineWidth(bw as CGFloat);
            set_dashes(st, borders.style, bw);
        }
        self.set_ring(layer, ring.then_some(&borders), local, radii, border_behind);
        let ca_border = border && !stroke;
        let width = if ca_border { bw as CGFloat } else { 0.0 };
        let border_layer = container.unwrap_or(layer);
        if container.is_some() {
            layer.setBorderWidth(0.0);
        }
        border_layer.setBorderWidth(width);

        // Clipping: by the container when there is one, else by the view's
        // own layer (never an image view's: its image layer clips).
        let clip_layer = match kind {
            Kind::Image => None,
            _ => Some(container.unwrap_or(layer)),
        };
        if let Some(c) = container {
            set_corners(c, r, continuous);
            layer.setMasksToBounds(false);
            // SAFETY: clearing the mask (the container clips).
            unsafe { layer.setMask(None) };
        }
        if kind == Kind::Image {
            layer.setMasksToBounds(false);
        }
        // A text view with odd corners is masked even when it does not clip.
        let masks = shared.is_none() && (clips || kind == Kind::Text);
        // Text and canvas views clip their drawing to their bounds (as
        // UIKit's `drawRect:` does): AppKit otherwise backs what such a
        // view could draw outside them, up to what its ancestors show, and
        // draws it again whenever that changes: every text in a scroll
        // view on every scroll step. Not with a shadow or anything drawn
        // outside, which the mask would cut.
        let contained = kind == Kind::Text
            && !crate::visual::draws_outside(style)
            && crate::visual::drop_shadow(style).is_none();
        if let Some(cl) = clip_layer {
            cl.setMasksToBounds((clips && shared.is_some()) || (contained && container.is_none()));
            if masks {
                let m = shape_mask(&mut self.mask, local, radii);
                // SAFETY: a mask layer owned by this decoration.
                unsafe { cl.setMask(Some(&m)) };
            } else {
                // SAFETY: clearing the mask.
                unsafe { cl.setMask(None) };
                self.mask = None;
            }
        }

        // Image content follows the view's shape.
        self.set_tint(shape.tint.filter(|_| kind == Kind::Image));
        if let Some(image) = &self.image {
            image.setFrame(local);
            set_corners(image, r, continuous);
            if shared.is_some() {
                // SAFETY: clearing the mask.
                unsafe { image.setMask(None) };
            } else {
                let m = CAShapeLayer::new();
                m.setPath(Some(&rounded(local, radii)));
                // SAFETY: a fresh mask layer, owned by the image layer.
                unsafe { image.setMask(Some(&m)) };
            }
            if image.superlayer().is_none() {
                image.setZPosition(BEHIND + 0.5);
                layer.addSublayer(image);
            }
            self.fit_contents();
        }

        // A shader's frames fill the view's shape, as a background does
        // (clipped even when the children are not).
        if let Some(shader) = s.shader.as_ref() {
            let l = shader.layer();
            l.setFrame(local);
            set_corners(l, r, continuous);
            if shared.is_some() {
                // SAFETY: clearing the mask.
                unsafe { l.setMask(None) };
            } else {
                let m = CAShapeLayer::new();
                m.setPath(Some(&rounded(local, radii)));
                // SAFETY: a fresh mask layer, owned by the shader layer.
                unsafe { l.setMask(Some(&m)) };
            }
            if l.superlayer().is_none() {
                layer.addSublayer(l);
            }
        }

        if let Some((x, y, blur, color)) = crate::visual::drop_shadow(style) {
            // `drop-shadow()`: follows the content's shape (no path).
            layer.setShadowColor(cg_color(Color(color.0 | 0xff)).as_deref());
            layer.setShadowOpacity((color.0 & 0xff) as f32 / 255.0);
            layer.setShadowOffset(CGSize::new(x as CGFloat, y as CGFloat));
            layer.setShadowRadius(blur as CGFloat / 2.0);
            layer.setShadowPath(None);
        } else {
            layer.setShadowOpacity(0.0);
            layer.setShadowPath(None);
        }
        let covered = covers_shadows && kind != Kind::Text;
        self.visual.apply(
            view,
            layer,
            style,
            local,
            radii,
            kind == Kind::Text,
            covered,
        );
    }

    /// Draws borders with differing sides: the ring between the outer and
    /// the inner edge, one layer per side color, each masked to its side.
    fn set_ring(
        &mut self,
        layer: &CALayer,
        borders: Option<&Borders>,
        local: CGRect,
        radii: CornerRadii,
        behind: bool,
    ) {
        let Some(b) = borders else {
            for r in self.ring.drain(..) {
                r.removeFromSuperlayer();
            }
            return;
        };
        let [top, right, bottom, left] = b.widths.to_array().map(|w| w.0 as CGFloat);
        let ring = ring_path(local, radii, [top, right, bottom, left]);
        let same_color = b.colors.iter().all(|&c| c == b.colors[0]);
        let count = if same_color { 1 } else { 4 };
        while self.ring.len() > count {
            if let Some(r) = self.ring.pop() {
                r.removeFromSuperlayer();
            }
        }
        while self.ring.len() < count {
            let r = CAShapeLayer::new();
            // SAFETY: an immutable Core Animation constant.
            r.setFillRule(unsafe { kCAFillRuleEvenOdd });
            layer.addSublayer(&r);
            self.ring.push(r);
        }
        let (w, h) = (local.size.width, local.size.height);
        for (i, r) in self.ring.iter().enumerate() {
            r.setZPosition(if behind { BORDER_BEHIND } else { IN_FRONT });
            r.setFrame(local);
            r.setPath(Some(&ring));
            if count == 1 {
                // SAFETY: clearing the mask.
                unsafe { r.setMask(None) };
                continue;
            }
            // The side's trapezoid, from the outer to the inner corners.
            let points = match i {
                0 => [(0.0, 0.0), (w, 0.0), (w - right, top), (left, top)],
                1 => [(w, 0.0), (w, h), (w - right, h - bottom), (w - right, top)],
                2 => [
                    (w, h),
                    (0.0, h),
                    (left, h - bottom),
                    (w - right, h - bottom),
                ],
                _ => [(0.0, h), (0.0, 0.0), (left, top), (left, h - bottom)],
            };
            let path = CGMutablePath::new();
            let p = Some(&*path);
            let m = std::ptr::null();
            // SAFETY: a valid mutable path and a null transform.
            unsafe {
                CGMutablePath::move_to_point(p, m, points[0].0, points[0].1);
                for &(x, y) in &points[1..] {
                    CGMutablePath::add_line_to_point(p, m, x, y);
                }
                CGMutablePath::close_subpath(p);
            }
            let mask = CAShapeLayer::new();
            mask.setFrame(local);
            mask.setPath(Some(&path));
            // SAFETY: a fresh mask layer owned by the ring layer.
            unsafe { r.setMask(Some(&mask)) };
        }
    }
}

/// Applies a view's decoration (background, corners, borders, shadows,
/// clipping, effects) to its layers. Cheap when nothing changed.
pub(crate) fn apply(view: &NshView) {
    let Some(layer) = view.ns().layer() else {
        return;
    };
    let kind = Kind::of(&view.state());
    // A view that clips its children and draws outside its box (a shadow,
    // an outline) clips them in a container instead.
    let needs_container = {
        let s = view.state();
        kind == Kind::View && s.clips() && crate::visual::draws_outside(&s.style)
    };
    if needs_container && view.container_view().is_none() {
        view.ensure_container();
    }
    let container = view.container_view().and_then(|c| c.layer());
    let mut guard = view.state_mut();
    let state = &mut *guard;
    let shape = shape_of(state, kind);
    let borders = state.borders();
    let colors = Colors {
        background: state.background(),
        borders: borders.colors,
    };
    let reshape = state.decor.shape.as_deref() != Some(&shape);
    if !reshape && state.decor.colors == Some(colors) {
        return;
    }
    quiet(|| {
        if reshape {
            // The decoration is taken out of the state it reads.
            let mut d = std::mem::take(&mut state.decor);
            d.shape(view, &layer, container.as_deref(), kind, state, &shape);
            state.decor = d;
        }
        let d = &state.decor;
        d.set_background(&layer, colors.background);
        d.set_border_colors(&layer, container.as_deref(), &borders);
    });
    state.decor.shape = Some(Box::new(shape));
    state.decor.colors = Some(colors);
    drop(guard);
    if kind == Kind::Image {
        // An image decodes at its view's size, once that is known.
        crate::image::resume(view);
    }
}

/// What shapes `s`'s layers.
fn shape_of(s: &ViewState, kind: Kind) -> Shape {
    let style = &s.style;
    let (w, h) = (s.frame.size.width.0, s.frame.size.height.0);
    let borders = s.borders();
    Shape {
        kind,
        size: (w, h),
        radii: style.radii().fit(size(px(w), px(h))),
        clips: s.clips(),
        widths: borders.widths,
        border_style: borders.style,
        one_color: borders.colors.iter().all(|&c| c == borders.colors[0]),
        tint: style.tint_color,
        outline: style.outline,
        effects: style.effects.clone(),
        shader: s.shader.is_some(),
    }
}

/// A view's style changed (`old` is the previous one): images decode again
/// when their filters changed (they apply to the pixels).
pub(crate) fn style_changed(view: &NshView, old: &ViewStyle) {
    let changed = {
        let s = view.state();
        s.kind == ViewKind::Image
            && old.effects.as_ref().map(|e| &e.filters)
                != s.style.effects.as_ref().map(|e| &e.filters)
    };
    if changed {
        crate::image::filters_changed(view);
    }
}

/// True if `backfaceVisibility: "hidden"` hides the view: its own
/// rotations turn it away (its ancestors' are not considered, as on
/// Android).
pub(crate) fn backface_away(state: &ViewState) -> bool {
    // The z axis's own component keeps its sign through translations and
    // a perspective, so it tells which way the face points.
    state.style.backface_hidden && state.transform().is_some_and(|t| t.0[10] < 0.0)
}

/// `color` as a Core Graphics color (`None` when transparent).
pub(crate) fn cg_color(color: Color) -> Option<CFRetained<CGColor>> {
    if color.is_transparent() {
        return None;
    }
    let (r, g, b, a) = color.to_f64();
    Some(CGColor::new_srgb(r, g, b, a))
}

/// A CGImage as an object (`contents` values).
pub(crate) fn image_object(image: &objc2_core_graphics::CGImage) -> Retained<AnyObject> {
    let ptr = image as *const objc2_core_graphics::CGImage as *mut AnyObject;
    // SAFETY: CF objects are Objective-C objects; retained for the result.
    unsafe { Retained::retain(ptr) }.expect("image")
}

/// Sets the dash pattern of a stroke `width` wide in `style`.
pub(crate) fn set_dashes(layer: &CAShapeLayer, style: BorderStyle, width: f32) {
    let w = width as f64;
    let pattern: Option<Retained<NSArray<NSNumber>>> = match style {
        BorderStyle::Solid => None,
        BorderStyle::Dashed => Some(NSArray::from_retained_slice(&[
            NSNumber::new_f64(w * 3.0),
            NSNumber::new_f64(w * 3.0),
        ])),
        // Zero-length dashes with round caps draw dots.
        BorderStyle::Dotted => Some(NSArray::from_retained_slice(&[
            NSNumber::new_f64(0.0),
            NSNumber::new_f64(w * 2.0),
        ])),
    };
    layer.setLineDashPattern(pattern.as_deref());
    // SAFETY: immutable Core Animation constants.
    layer.setLineCap(unsafe {
        if style == BorderStyle::Dotted {
            kCALineCapRound
        } else {
            kCALineCapButt
        }
    });
}

fn shape_mask(
    slot: &mut Option<Retained<CAShapeLayer>>,
    rect: CGRect,
    radii: CornerRadii,
) -> Retained<CAShapeLayer> {
    let mask = slot.get_or_insert_with(CAShapeLayer::new).clone();
    mask.setFrame(rect);
    mask.setPath(Some(&rounded(rect, radii)));
    mask
}

/// `rect` shrunk by `d` on every side.
pub(crate) fn inset(rect: CGRect, d: CGFloat) -> CGRect {
    CGRect::new(
        CGPoint::new(rect.origin.x + d, rect.origin.y + d),
        CGSize::new(
            (rect.size.width - 2.0 * d).max(0.0),
            (rect.size.height - 2.0 * d).max(0.0),
        ),
    )
}

/// The area between the outer edge (corners `radii`) and the inner edge of
/// borders `[top, right, bottom, left]` wide, for an even-odd fill. Inner
/// corners are elliptical where the adjacent sides differ.
fn ring_path(rect: CGRect, radii: CornerRadii, widths: [CGFloat; 4]) -> CFRetained<CGMutablePath> {
    let path = rounded(rect, radii);
    let [top, right, bottom, left] = widths;
    let inner = CGRect::new(
        CGPoint::new(rect.origin.x + left, rect.origin.y + top),
        CGSize::new(
            rect.size.width - left - right,
            rect.size.height - top - bottom,
        ),
    );
    if inner.size.width <= 0.0 || inner.size.height <= 0.0 {
        return path;
    }
    let [tl, tr, br, bl] = radii.to_array().map(|r| r.0 as CGFloat);
    // (horizontal, vertical) radii of each inner corner.
    let corner = |r: CGFloat, h: CGFloat, v: CGFloat| ((r - h).max(0.0), (r - v).max(0.0));
    let corners = [
        corner(tl, left, top),
        corner(tr, right, top),
        corner(br, right, bottom),
        corner(bl, left, bottom),
    ];
    add_outline(&path, inner, corners, radii.continuous, false);
    path
}

/// A rectangle with the corners `radii` (circular or continuous).
pub(crate) fn rounded(rect: CGRect, radii: CornerRadii) -> CFRetained<CGMutablePath> {
    let path = CGMutablePath::new();
    add_rounded(&path, rect, radii, false);
    path
}

/// Adds a rectangle with the corners `radii` to `path`, counterclockwise
/// with `reverse` (a hole under the non-zero rule).
pub(crate) fn add_rounded(path: &CGMutablePath, rect: CGRect, radii: CornerRadii, reverse: bool) {
    let corners = radii.to_array().map(|r| (r.0 as CGFloat, r.0 as CGFloat));
    add_outline(path, rect, corners, radii.continuous, reverse);
}

/// Adds `nsh_core::shape::rounded_rect` to `path`.
fn add_outline(
    path: &CGMutablePath,
    rect: CGRect,
    corners: [(CGFloat, CGFloat); 4],
    continuous: bool,
    reverse: bool,
) {
    use nsh_core::{
        Corners, Point, Points,
        geometry::{bounds, point, size},
        shape::Segment,
    };
    let pt = |v: CGFloat| Points(v as f32);
    let rect = bounds(
        point(pt(rect.origin.x), pt(rect.origin.y)),
        size(pt(rect.size.width), pt(rect.size.height)),
    );
    let [tl, tr, br, bl] = corners.map(|(h, v)| size(pt(h), pt(v)));
    let corners = Corners {
        top_left: tl,
        top_right: tr,
        bottom_right: br,
        bottom_left: bl,
    };
    let cg = |p: Point<Points>| (p.x.0 as CGFloat, p.y.0 as CGFloat);
    let p = Some(path);
    let m = std::ptr::null();
    nsh_core::shape::rounded_rect(rect, corners, continuous, reverse, &mut |s| {
        // SAFETY: a valid mutable path and a null transform.
        unsafe {
            match s {
                Segment::Move(to) => {
                    let (x, y) = cg(to);
                    CGMutablePath::move_to_point(p, m, x, y)
                }
                Segment::Line(to) => {
                    let (x, y) = cg(to);
                    CGMutablePath::add_line_to_point(p, m, x, y)
                }
                Segment::Cubic([c1, c2, to]) => {
                    let ((a, b), (c, d), (x, y)) = (cg(c1), cg(c2), cg(to));
                    CGMutablePath::add_curve_to_point(p, m, a, b, c, d, x, y)
                }
                Segment::Close => CGMutablePath::close_subpath(p),
            }
        }
    });
}

/// The radius every corner has, if they all have the same.
///
/// Corners where only some are rounded (`maskedCorners`) are drawn as
/// shapes too: in-process renderings (`renderInContext:`, the scripts'
/// screenshots) ignore `maskedCorners` and round every corner.
pub(crate) fn shared(radii: &CornerRadii) -> Option<f32> {
    let [a, b, c, d] = radii.to_array();
    (a == b && b == c && c == d).then_some(a.0)
}

/// Sets the corners of a layer that draws them itself: `r` on each,
/// circular or continuous.
pub(crate) fn set_corners(layer: &CALayer, r: CGFloat, continuous: bool) {
    layer.setCornerRadius(r);
    // SAFETY: immutable Core Animation constants.
    layer.setCornerCurve(unsafe {
        if continuous {
            kCACornerCurveContinuous
        } else {
            kCACornerCurveCircular
        }
    });
}
