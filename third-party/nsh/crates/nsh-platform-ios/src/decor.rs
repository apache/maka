//! Backgrounds, borders, rounded corners, clipping and shadows, all drawn by
//! Core Animation (no `drawRect`, no offscreen bitmaps where avoidable).
//!
//! The cheap path is the view's own layer: `cornerRadius` + `maskedCorners`
//! covers every shape whose rounded corners share one radius. Only corners
//! with different radii need shape layers, and only a view that both clips
//! its children and draws outside its bounds (an outer box shadow, an
//! outline) needs an extra content view (clipping a layer also clips what it
//! draws outside).
//!
//! A `drop-shadow()` filter is the layer's own shadow: it follows the
//! content. Known limits: scroll views and lists take one radius (the
//! largest); a `<text>` with different radii is masked.

use nsh_core::{
    BorderStyle, Borders, Color, CornerRadii, ObjectPosition, ResizeMode, ViewStyle,
    geometry::{px, size},
};
use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColor, CGImage, CGMutablePath};
use objc2_foundation::{NSArray, NSNumber};
use objc2_quartz_core::{
    CACornerMask, CALayer, CAMediaTiming, CAShapeLayer, CATransaction, kCACornerCurveCircular,
    kCACornerCurveContinuous, kCAFillRuleEvenOdd, kCAGravityResize, kCALineCapRound,
};
use objc2_ui_kit::{UIColor, UIImage, UIView};

/// Fills sit behind the children. Borders too (CSS), except where the
/// children are clipped: there the layer's own border, which Core Animation
/// always draws in front, looks the same and needs no shape.
const BEHIND: CGFloat = -1024.0;
const BORDER_BEHIND: CGFloat = BEHIND + 1.0;
const IN_FRONT: CGFloat = 1024.0;

/// What a native view is, as far as decoration goes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Has children; can host a content view.
    View,
    /// Draws its content in the layer itself (below any sublayer).
    Text,
    /// Shows an image in an [`Decor::image`] sublayer.
    Image,
    /// Always clips; sublayers would scroll with the content.
    Scroll,
}

/// Extra layers of one view, created on demand.
#[derive(Default)]
pub(crate) struct Decor {
    /// Background for corners of different radii.
    fill: Option<Retained<CAShapeLayer>>,
    /// Border for corners of different radii.
    stroke: Option<Retained<CAShapeLayer>>,
    /// Clip shape for corners of different radii.
    mask: Option<Retained<CAShapeLayer>>,
    /// Holds the children while the view both clips them and casts a shadow.
    content: Option<Retained<UIView>>,
    /// Image content (image views only): clips the picture to the view's
    /// shape.
    image: Option<Retained<CALayer>>,
    /// The image itself, inside [`Decor::image`], framed where the resize
    /// mode and the position put it.
    picture: Option<Retained<CALayer>>,
    /// How the image fits.
    mode: ResizeMode,
    /// Where the fitted image sits.
    position: ObjectPosition,
    /// The image, kept to switch between plain and tinted display.
    contents: Option<(Retained<CGImage>, CGFloat)>,
    /// `tintColor`: the image layer shows this color through a mask of the
    /// image.
    tint: Option<(Color, Retained<CALayer>)>,
    /// Borders whose sides differ: one even-odd ring per color.
    ring: Vec<Retained<CAShapeLayer>>,
    /// The shapes depend on the view's size: update them on resize.
    sized: bool,
    /// Layered shadows, gradients, outline, backdrop blur.
    visual: crate::visual::Visual,
}

impl Decor {
    /// Decoration of an image view: the image lives in its own clipped
    /// sublayer, so the view's layer can cast an unclipped shadow, and in
    /// a picture layer inside that, framed where it is fitted.
    pub(crate) fn for_image() -> Self {
        let image = CALayer::new();
        image.setMasksToBounds(true);
        let picture = CALayer::new();
        // SAFETY: an immutable Core Animation constant.
        picture.setContentsGravity(unsafe { kCAGravityResize });
        image.addSublayer(&picture);
        Self {
            image: Some(image),
            picture: Some(picture),
            sized: true,
            ..Self::default()
        }
    }

    /// The view children are added to.
    pub(crate) fn container<'a>(&'a self, view: &'a UIView) -> &'a UIView {
        self.content.as_deref().unwrap_or(view)
    }

    /// True if [`Decor::apply`] must run again when the view is resized.
    #[inline]
    pub(crate) fn sized(&self) -> bool {
        self.sized
    }

    /// Shows `image` (fading in over `fade` seconds); an animated image
    /// plays its frames, forever.
    pub(crate) fn set_image(&mut self, image: Option<&UIImage>, fade: f64) {
        // SAFETY: plain getters on a valid image.
        self.contents = image.and_then(|i| unsafe { i.CGImage().map(|cg| (cg, i.scale())) });
        let Some(layer) = self.picture.clone() else {
            return;
        };
        let key = objc2_foundation::ns_string!("frames");
        layer.removeAnimationForKey(key);
        if fade > 0.0 {
            // A crossfade from what was shown (nothing or a placeholder).
            let transition = objc2_quartz_core::CATransition::animation();
            transition.setDuration(fade);
            // SAFETY: an immutable Core Animation constant.
            transition.setType(unsafe { objc2_quartz_core::kCATransitionFade });
            layer.addAnimation_forKey(&transition, Some(objc2_foundation::ns_string!("fade")));
            self.show_contents();
        } else {
            quiet(|| self.show_contents());
        }
        quiet(|| self.fit_contents());
        // SAFETY: plain getters on a valid image.
        let frames = image.and_then(|i| unsafe { i.images().map(|f| (f, i.duration())) });
        if let Some((frames, duration)) = frames.filter(|(f, _)| f.count() > 1)
            && self.tint.is_none()
        {
            let values: Vec<Retained<AnyObject>> = frames
                .iter()
                // SAFETY: plain getters; CGImages are valid `contents` values.
                .filter_map(|f| unsafe { f.CGImage() })
                .map(|cg| unsafe { Retained::cast_unchecked::<AnyObject>(cg) })
                .collect();
            let animation = objc2_quartz_core::CAKeyframeAnimation::animationWithKeyPath(Some(
                objc2_foundation::ns_string!("contents"),
            ));
            // SAFETY: an array of CGImages, valid `contents` values.
            unsafe { animation.setValues(Some(&NSArray::from_retained_slice(&values))) };
            // SAFETY: an immutable Core Animation constant.
            animation.setCalculationMode(unsafe { objc2_quartz_core::kCAAnimationDiscrete });
            animation.setDuration(duration);
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
        if let Some((_, scale)) = &self.contents {
            target.setContentsScale(*scale);
        }
        // SAFETY: a CGImage is a valid `contents` object.
        unsafe {
            target.setContents(
                self.contents
                    .as_ref()
                    .map(|(c, _)| &*(&**c as *const CGImage as *const AnyObject)),
            )
        };
    }

    /// How the image fits the view.
    pub(crate) fn resize_mode(&self) -> ResizeMode {
        self.mode
    }

    /// How an image view fits its image (`objectFit`) and where it places
    /// it (`objectPosition`).
    pub(crate) fn set_fit(&mut self, mode: ResizeMode, position: ObjectPosition) {
        if self.mode != mode || self.position != position {
            self.mode = mode;
            self.position = position;
            quiet(|| self.fit_contents());
        }
    }

    /// Frames the picture layer (and the tint in it) where the resize mode
    /// and the position put the image in the image layer, which crops what
    /// reaches outside.
    fn fit_contents(&self) {
        let (Some(layer), Some(picture)) = (&self.image, &self.picture) else {
            return;
        };
        let bounds = layer.bounds().size;
        let natural = self.contents.as_ref().map_or((0.0, 0.0), |(cg, scale)| {
            let scale = scale.max(0.01);
            (
                (CGImage::width(Some(cg)) as CGFloat / scale) as f32,
                (CGImage::height(Some(cg)) as CGFloat / scale) as f32,
            )
        });
        let natural = size(px(natural.0), px(natural.1));
        let bounds = size(px(bounds.width as f32), px(bounds.height as f32));
        let fitted = self.mode.fit(natural, bounds, self.position);
        let frame = CGRect::new(
            CGPoint::new(fitted.origin.x.0 as CGFloat, fitted.origin.y.0 as CGFloat),
            CGSize::new(
                fitted.size.width.0 as CGFloat,
                fitted.size.height.0 as CGFloat,
            ),
        );
        picture.setFrame(frame);
        if let Some((_, tint)) = &self.tint {
            let inner = CGRect::new(CGPoint::new(0.0, 0.0), frame.size);
            tint.setFrame(inner);
            if let Some(mask) = tint.mask() {
                mask.setFrame(inner);
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
    ///
    /// Always on layers: UIKit paints `UIView.backgroundColor` into the
    /// contents of views with `drawRect:` (text), where corners cannot round it.
    pub(crate) fn set_background(&self, view: &UIView, color: Color) {
        match &self.fill {
            Some(fill) => quiet(|| fill.setFillColor(cg_color(color).as_deref())),
            None => view.layer().setBackgroundColor(cg_color(color).as_deref()),
        }
    }

    /// Sets the color of every border side (an animated `borderColor`) on
    /// the layers [`Decor::apply`] made for the borders.
    pub(crate) fn set_border_color(&self, view: &UIView, color: Color) {
        let cg = cg_color(color);
        quiet(|| {
            if let Some(s) = &self.stroke {
                s.setStrokeColor(cg.as_deref());
            }
            for r in &self.ring {
                r.setFillColor(cg.as_deref());
            }
            let layer = self
                .content
                .as_ref()
                .map_or_else(|| view.layer(), |c| c.layer());
            if layer.borderWidth() > 0.0 {
                layer.setBorderColor(cg.as_deref());
            }
        });
    }

    /// Shapes `view` after `style` at its current size. `background` is the
    /// current (possibly animated) background.
    pub(crate) fn apply(
        &mut self,
        view: &UIView,
        kind: Kind,
        style: &ViewStyle,
        background: Color,
        mtm: MainThreadMarker,
    ) {
        quiet(|| self.apply_quietly(view, kind, style, background, mtm));
    }

    /// Like [`Decor::apply`], letting the current transaction animate the
    /// changes of the extra layers (transitions).
    pub(crate) fn apply_animated(
        &mut self,
        view: &UIView,
        kind: Kind,
        style: &ViewStyle,
        background: Color,
        mtm: MainThreadMarker,
    ) {
        self.apply_quietly(view, kind, style, background, mtm);
    }

    fn apply_quietly(
        &mut self,
        view: &UIView,
        kind: Kind,
        style: &ViewStyle,
        background: Color,
        mtm: MainThreadMarker,
    ) {
        let layer = view.layer();
        let bounds = view.bounds();
        let (w, h) = (bounds.size.width as f32, bounds.size.height as f32);
        let local = CGRect::new(CGPoint::ZERO, bounds.size);
        // Scaling all radii by one factor keeps shared radii shared, so the
        // layer's own (self-clamping) radius needs no size: views without
        // paths are not reshaped on resize.
        let raw = style.radii();
        let radii = raw.fit(size(px(w), px(h)));
        let borders = &style.borders;
        // Sides that differ are drawn as colored rings; equal sides by the
        // layer's border or a stroke.
        let uniform = borders
            .uniform()
            .map(|(w, c)| (w.0, c))
            .filter(|_| borders.is_visible());
        let ring = uniform.is_none() && borders.is_visible();
        let border = uniform.is_some();
        let dashed = borders.style != BorderStyle::Solid;

        // Corners sharing one radius are drawn by the layer itself. Scroll
        // views always do so (their sublayers scroll): the largest radius
        // stands in for the others.
        let shared = raw.shared().map(|r| r.0).or_else(|| {
            (kind == Kind::Scroll).then(|| raw.to_array().into_iter().fold(0.0, |m, r| r.0.max(m)))
        });
        let corners = corner_mask(&raw);
        let outside = crate::visual::draws_outside(style);
        let content = kind == Kind::View && style.overflow_hidden && outside;

        // Text draws into the layer's own contents, below every sublayer: it
        // cannot have a fill layer, so its odd corners clip it instead.
        let border_behind = kind == Kind::View && !style.overflow_hidden;
        let stroke = border && (shared.is_none() || border_behind || dashed);
        // Core Animation's continuous corners differ slightly from the
        // shared outline (`nsh_core::shape`): a stroke drawn along the latter
        // gets its background from the same outline, so none shows outside.
        let fill = (shared.is_none() || (raw.continuous && stroke)) && kind != Kind::Text;
        let mask = shared.is_none() && (style.overflow_hidden || kind == Kind::Text) && !content;

        self.sized = kind == Kind::Image
            || shared.is_none()
            || content
            || stroke
            || ring
            || style.effects.is_some()
            || style.glass_effect != nsh_core::GlassEffect::None
            || style.outline.is_visible();

        // Corners of the layer itself. Core Animation draws nothing for a
        // radius over half the short side (`rounded-full` is 9999): clamp
        // it, and do so again when the size changes.
        let half = w.min(h) / 2.0;
        let r = match shared {
            Some(r) if w > 0.0 && h > 0.0 => r.min(half),
            Some(r) => r,
            None => 0.0,
        } as CGFloat;
        if shared.is_some_and(|r| r > 0.0 && (w == 0.0 || r >= half)) {
            self.sized = true;
        }
        set_corners(&layer, r, corners, raw.continuous);

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
        self.set_background(view, background);

        // Border: a stroke behind the children or for odd corners, else the
        // layer's own (on the content view when there is one, so the
        // children do not cover it).
        match (stroke, &self.stroke) {
            (true, None) => {
                let s = CAShapeLayer::new();
                s.setFillColor(None);
                layer.addSublayer(&s);
                self.stroke = Some(s);
            }
            (false, Some(s)) => {
                s.removeFromSuperlayer();
                self.stroke = None;
            }
            _ => {}
        }
        let (bw, bc) = uniform.unwrap_or((0.0, Color::TRANSPARENT));
        if let Some(s) = &self.stroke {
            s.setZPosition(if border_behind {
                BORDER_BEHIND
            } else {
                IN_FRONT
            });
            let half = (bw / 2.0) as CGFloat;
            s.setFrame(local);
            s.setPath(Some(&rounded(
                inset(local, half),
                radii.inset(px(bw / 2.0)),
            )));
            s.setLineWidth(bw as CGFloat);
            s.setStrokeColor(cg_color(bc).as_deref());
            let w = bw as f64;
            let pattern: Option<Retained<NSArray<NSNumber>>> = match borders.style {
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
            s.setLineDashPattern(pattern.as_deref());
            // SAFETY: immutable Core Animation constants.
            s.setLineCap(unsafe {
                if borders.style == BorderStyle::Dotted {
                    kCALineCapRound
                } else {
                    objc2_quartz_core::kCALineCapButt
                }
            });
        }
        self.set_ring(
            layer.as_ref(),
            ring.then_some(borders),
            local,
            radii,
            border_behind,
        );
        let ca_border = border && !stroke;
        let (width, color) = if ca_border {
            (bw as CGFloat, cg_color(bc))
        } else {
            (0.0, None)
        };

        // Children in a content view: it clips, the view draws outside.
        self.set_content(view, content, mtm);
        let border_layer = match &self.content {
            Some(c) => {
                layer.setBorderWidth(0.0);
                c.setFrame(local);
                let cl = c.layer();
                set_corners(&cl, r, corners, raw.continuous);
                match shared {
                    Some(_) => {
                        cl.setMasksToBounds(true);
                        // SAFETY: clearing the mask.
                        unsafe { cl.setMask(None) };
                    }
                    None => {
                        cl.setMasksToBounds(false);
                        let m = shape_mask(&mut self.mask, local, radii);
                        // SAFETY: a mask layer owned by this decoration.
                        unsafe { cl.setMask(Some(&m)) };
                    }
                }
                cl
            }
            None => layer.clone(),
        };
        border_layer.setBorderWidth(width);
        border_layer.setBorderColor(color.as_deref());

        // Clipping of the view's own layer.
        if self.content.is_none() {
            let clips = kind == Kind::Scroll || (style.overflow_hidden && shared.is_some());
            layer.setMasksToBounds(clips);
            if mask {
                let m = shape_mask(&mut self.mask, local, radii);
                // SAFETY: a mask layer owned by this decoration.
                unsafe { layer.setMask(Some(&m)) };
            } else {
                // SAFETY: clearing the mask.
                unsafe { layer.setMask(None) };
                self.mask = None;
            }
        } else {
            layer.setMasksToBounds(false);
            // SAFETY: clearing the mask (the content view clips).
            unsafe { layer.setMask(None) };
        }

        // Image content follows the view's shape.
        self.set_tint(style.tint_color.filter(|_| kind == Kind::Image));
        if let Some(image) = &self.image {
            image.setFrame(local);
            // In the same transaction as the image layer's frame.
            self.fit_contents();
            set_corners(image, r, corners, raw.continuous);
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
                layer.addSublayer(image);
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
        self.visual
            .apply(view, style, local, radii, kind == Kind::Text, mtm);
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
            r.setFillColor(cg_color(b.colors[i]).as_deref());
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

    /// Moves the children into (or back out of) the content view.
    fn set_content(&mut self, view: &UIView, wanted: bool, mtm: MainThreadMarker) {
        match (wanted, &self.content) {
            (true, None) => {
                let content = UIView::new(mtm);
                let children = view.subviews();
                view.addSubview(&content);
                for child in children.iter() {
                    content.addSubview(&child);
                }
                self.content = Some(content);
            }
            (false, Some(content)) => {
                for child in content.subviews().iter() {
                    view.insertSubview_belowSubview(&child, content);
                }
                content.removeFromSuperview();
                self.content = None;
            }
            _ => {}
        }
    }
}

/// Sets a standalone layer's frame without an implicit animation.
pub(crate) fn quiet_frame(layer: &CALayer, frame: CGRect) {
    quiet(|| layer.setFrame(frame));
}

/// Runs `f` without Core Animation's implicit animations (standalone
/// layers animate every property change for 0.25s by default).
pub(crate) fn quiet<R>(f: impl FnOnce() -> R) -> R {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    let result = f();
    CATransaction::commit();
    result
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

/// The corners a shared radius applies to (UIKit layers are y-down: min Y is
/// the top).
pub(crate) fn corner_mask(radii: &CornerRadii) -> CACornerMask {
    let all = [
        (radii.top_left, CACornerMask::LayerMinXMinYCorner),
        (radii.top_right, CACornerMask::LayerMaxXMinYCorner),
        (radii.bottom_right, CACornerMask::LayerMaxXMaxYCorner),
        (radii.bottom_left, CACornerMask::LayerMinXMaxYCorner),
    ];
    let rounded = all
        .iter()
        .filter(|(r, _)| r.0 > 0.0)
        .fold(CACornerMask::empty(), |m, &(_, c)| m | c);
    if rounded.is_empty() {
        CACornerMask::all()
    } else {
        rounded
    }
}

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

/// Sets the corners of a layer that draws them itself: `r` on `corners`,
/// circular or continuous.
pub(crate) fn set_corners(layer: &CALayer, r: CGFloat, corners: CACornerMask, continuous: bool) {
    layer.setCornerRadius(r);
    layer.setMaskedCorners(corners);
    // SAFETY: immutable Core Animation constants.
    layer.setCornerCurve(unsafe {
        if continuous {
            kCACornerCurveContinuous
        } else {
            kCACornerCurveCircular
        }
    });
}

fn ui_color(color: Color) -> Option<Retained<UIColor>> {
    if color.is_transparent() {
        return None;
    }
    let (r, g, b, a) = color.to_f64();
    Some(UIColor::colorWithRed_green_blue_alpha(r, g, b, a))
}

pub(crate) fn cg_color(color: Color) -> Option<Retained<CGColor>> {
    // SAFETY: the CGColor is retained for as long as the caller keeps it.
    ui_color(color).map(|c| unsafe { c.CGColor() })
}
