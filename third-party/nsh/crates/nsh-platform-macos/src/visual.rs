//! Effects beyond classic view styles, as Core Animation layers of a view:
//! layered and inset box shadows, gradient backgrounds, outlines, a
//! brightness veil, `mixBlendMode` and a backdrop (an `NSVisualEffectView`
//! blurring what the window shows behind the view: Core Animation's
//! `backgroundFilters` do nothing in AppKit windows): its material from
//! `macos={{ backdrop }}`, or core's popover material; or, for
//! `glassEffect` on macOS 26 and later, an `NSGlassEffectView` (tinted by
//! `glassTintColor`), both looked up at run time.
//!
//! CSS draws a box shadow only outside the box. Under an opaque background
//! (a fill layer, or a gradient, which draw above them) outer shadow layers
//! are plain `shadowPath` casters; otherwise they are masked to everything
//! but the box, so that they can sit above the view's own background
//! (sublayers always draw over a layer's contents) without covering it.
//! Masks are what the window server pays for on every frame the view moves:
//! a scroll of the gallery's Lists (a shadow on every card) was composited
//! at ~60 of 120 Hz with them. Inset shadows are clipped by their holder's
//! rounded bounds for the same reason, masked only for differing corners.
//! In-process renderings (`shot`) do not show unmasked outer shadows.

use std::cell::Cell;

use nsh_core::{
    BlendMode, BorderStyle, BoxShadow, Color, CornerRadii, Filter, GlassEffect, Gradient,
    GradientKind, GradientSize, MacOsBackdrop, MacOsBackdropBlending, MacOsBackdropMaterial,
    MacOsBackdropState, ViewStyle,
    geometry::{Points, px},
};
use objc2::{
    DefinedClass as _, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSColor, NSResponder, NSUserInterfaceItemIdentification as _,
    NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGMutablePath;
use objc2_foundation::{
    NSArray, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSString, ns_string,
};
use objc2_quartz_core::{
    CAGradientLayer, CALayer, CAShapeLayer, kCAFillRuleEvenOdd, kCAGradientLayerAxial,
    kCAGradientLayerConic, kCAGradientLayerRadial, kCALineCapButt, kCALineCapRound,
};

use crate::{
    decor::{cg_color, inset, rounded},
    view::NshView,
};

/// Backdrop blurs sit below the background.
const BACKDROP_Z: CGFloat = -1024.0 - 0.5;
/// Shadows sit below the background and the children.
const SHADOW_Z: CGFloat = -2048.0;
/// Gradients sit above the background color, below borders.
const GRADIENT_Z: CGFloat = -1024.0 + 0.25;
/// Inset shadows sit above backgrounds, below borders.
const INSET_Z: CGFloat = -1024.0 + 0.5;
/// Outlines and the brightness veil are above everything.
const OUTLINE_Z: CGFloat = 2048.0;
const VEIL_Z: CGFloat = 2049.0;

/// `mixBlendMode` as a Core Animation compositing filter name: `None` for
/// `normal`, which clears any filter.
fn blend_name(mode: BlendMode) -> Option<&'static NSString> {
    Some(match mode {
        BlendMode::Normal => return None,
        BlendMode::Multiply => ns_string!("multiplyBlendMode"),
        BlendMode::Screen => ns_string!("screenBlendMode"),
        BlendMode::Overlay => ns_string!("overlayBlendMode"),
        BlendMode::Darken => ns_string!("darkenBlendMode"),
        BlendMode::Lighten => ns_string!("lightenBlendMode"),
        BlendMode::ColorDodge => ns_string!("colorDodgeBlendMode"),
        BlendMode::ColorBurn => ns_string!("colorBurnBlendMode"),
        BlendMode::HardLight => ns_string!("hardLightBlendMode"),
        BlendMode::SoftLight => ns_string!("softLightBlendMode"),
        BlendMode::Difference => ns_string!("differenceBlendMode"),
        BlendMode::Exclusion => ns_string!("exclusionBlendMode"),
        BlendMode::Hue => ns_string!("hueBlendMode"),
        BlendMode::Saturation => ns_string!("saturationBlendMode"),
        BlendMode::Color => ns_string!("colorBlendMode"),
        BlendMode::Luminosity => ns_string!("luminosityBlendMode"),
        BlendMode::PlusDarker => ns_string!("plusD"),
        BlendMode::PlusLighter => ns_string!("plusL"),
    })
}

/// Applies `mixBlendMode` to `layer`, the layer that draws the view whole.
///
/// A view's content layer (text, canvases), its fill layers and the
/// container its clipped children live in are all its own layer's
/// sublayers, so the filter composites the view as one with what is behind
/// it (as the iOS backend's does). A view that gains or loses a container
/// keeps the filter where it was: the view's layer stays the outermost.
/// `normal` removes the filter.
pub(crate) fn set_blend(layer: &CALayer, mode: BlendMode) {
    let name: Option<&NSString> = blend_name(mode);
    // SAFETY: Core Animation takes filter names (strings) here.
    unsafe { layer.setCompositingFilter(name.map(|n| n.as_ref())) };
}

/// The effect layers of one view.
#[derive(Default)]
pub(crate) struct Visual {
    /// The holder masked to all but the box, and one caster per shadow.
    shadows: Option<(Retained<CALayer>, Vec<Retained<CAShapeLayer>>)>,
    /// The holder clipped to the padding box, and one caster per shadow.
    insets: Option<(Retained<CALayer>, Vec<Retained<CAShapeLayer>>)>,
    gradients: Vec<Retained<CAGradientLayer>>,
    outline: Option<Retained<CAShapeLayer>>,
    veil: Option<Retained<CALayer>>,
    backdrop: Option<Backdrop>,
    /// `maskImage`'s layer, held so it is not rebuilt every frame.
    mask_image: Option<Retained<CAGradientLayer>>,
}

/// What draws a view's backdrop.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BackdropKind {
    /// `NSGlassEffectView`, where AppKit has it (macOS 26 and later).
    Glass,
    /// `NSVisualEffectView`: an explicit macOS material, or a blur the
    /// material tints.
    Material,
    /// `PlainBlur`: a masked `backdropFilter` blur at its own radius.
    Plain,
}

/// What a backdrop draws, and what was set on its view last: only changes
/// are written, so a frame that re-applies the same style allocates
/// nothing.
struct Backdrop {
    /// The view in the view tree: the effect view, or the host of a glass
    /// view (which never takes input).
    view: Retained<NSView>,
    kind: BackdropKind,
    /// The glass view inside `view` (glass only).
    glass: Option<Retained<NSView>>,
    /// The glass style `glass` was given.
    glass_style: GlassEffect,
    /// The tint `glass` was given.
    tint: Option<Color>,
    /// The material, blending and state `view` was given (material only).
    material: MacOsBackdrop,
}

define_class!(
    /// A masked `backdropFilter`: what a progressive blur stacks. AppKit's
    /// materials blur by a radius of their own and tint, so layers of them
    /// differ in nothing but darken what is behind; this view's backdrop
    /// layer blurs by the view's radius and draws nothing else, as CSS.
    ///
    /// AppKit gives no way to say that, so it edits the layers the material
    /// is made of, each time AppKit may have made them again, through
    /// public `CALayer` API (`filters`, key-value coding). Where they are
    /// not what this expects the view stays the plain material.
    #[unsafe(super(NSVisualEffectView, NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Cell<f32>]
    #[name = "NshPlainBlur"]
    struct PlainBlur;

    impl PlainBlur {
        #[unsafe(method(layout))]
        fn layout(&self) {
            // SAFETY: NSView's `layout`, on the main thread.
            let _: () = unsafe { msg_send![super(self), layout] };
            self.strip();
        }

        #[unsafe(method(updateLayer))]
        fn update_layer(&self) {
            // SAFETY: NSView's `updateLayer`, on the main thread.
            let _: () = unsafe { msg_send![super(self), updateLayer] };
            self.strip();
        }

        #[unsafe(method(viewDidChangeEffectiveAppearance))]
        fn appearance_changed(&self) {
            // SAFETY: NSView's method of that name, on the main thread.
            let _: () = unsafe { msg_send![super(self), viewDidChangeEffectiveAppearance] };
            self.strip();
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn moved_to_window(&self) {
            // SAFETY: NSView's method of that name, on the main thread.
            let _: () = unsafe { msg_send![super(self), viewDidMoveToWindow] };
            self.strip();
        }

        /// The blur is decoration: the app's views above it take the event
        /// (the root picks the view itself, `crate::input`).
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

impl PlainBlur {
    fn new(frame: CGRect, radius: f32, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Cell::new(radius));
        // SAFETY: NSView's `initWithFrame:`, on an allocated view.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    /// Blurs by `radius` from now on.
    fn set_radius(&self, radius: f32) {
        self.ivars().set(radius);
        self.strip();
    }

    fn strip(&self) {
        if let Some(layer) = self.layer() {
            strip_material(&layer, self.ivars().get());
        }
    }
}

define_class!(
    /// An `NSVisualEffectView` — a native material, or the blur it tints —
    /// that never takes input: the app's views above it take the event (the
    /// root picks the view itself, `crate::input`).
    #[unsafe(super(NSVisualEffectView, NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshMaterialBackdrop"]
    struct MaterialBackdrop;

    impl MaterialBackdrop {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

impl MaterialBackdrop {
    fn new(frame: CGRect, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSView's `initWithFrame:`, on an allocated view.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

define_class!(
    /// Holds a glass view (looked up at run time) and never takes input:
    /// the app's views above it take the event.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshGlassBackdrop"]
    struct GlassBackdrop;

    unsafe impl NSObjectProtocol for GlassBackdrop {}

    impl GlassBackdrop {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

impl GlassBackdrop {
    fn new(frame: CGRect, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSView's `initWithFrame:`, on an allocated view.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

/// Leaves of a material's layers nothing but the blur of `radius`: the
/// backdrop layer's Gaussian blur alone, its fill and tints hidden.
fn strip_material(layer: &CALayer, radius: f32) {
    // SAFETY: reading the sublayers on the main thread, which is all this does.
    let Some(subs) = (unsafe { layer.sublayers() }) else {
        return;
    };
    for sub in subs.iter() {
        let backdrop = sub
            .class()
            .name()
            .to_str()
            .is_ok_and(|n| n.contains("Backdrop"));
        if backdrop {
            let gaussian = ns_string!("gaussianBlur");
            // A backdrop layer's `filters` are `CAFilter`s, which have a name.
            let kept: Vec<Retained<AnyObject>> = sub
                .filters()
                .map(|f| f.to_vec())
                .unwrap_or_default()
                .into_iter()
                .filter(|f| {
                    // SAFETY: `CAFilter`'s `name`, an `NSString`.
                    let name: Option<Retained<NSString>> = unsafe { msg_send![&**f, name] };
                    name.is_some_and(|n| &*n == gaussian)
                })
                .collect();
            if kept.is_empty() {
                continue;
            }
            // SAFETY: those filters, back on their layer, then their radius
            // by the key path Core Animation documents for named filters.
            unsafe {
                sub.setFilters(Some(&NSArray::from_retained_slice(&kept)));
                let value = NSNumber::new_f32(radius);
                let _: () = msg_send![
                    &*sub,
                    setValue: &*value,
                    forKeyPath: ns_string!("filters.gaussianBlur.inputRadius")
                ];
            }
        } else if unsafe { sub.sublayers() }.is_some_and(|l| l.count() > 0) {
            strip_material(&sub, radius);
        } else {
            sub.setHidden(true);
        }
    }
}

impl Drop for Backdrop {
    fn drop(&mut self) {
        self.view.removeFromSuperview();
    }
}

/// Identifies backdrop views among a view's subviews.
const BACKDROP_ID: &str = "nsh.backdrop";

/// Whether `view` is a backdrop blur or glass (nsh's, not a hosted native
/// view).
pub(crate) fn is_backdrop(view: &NSView) -> bool {
    view.identifier()
        .is_some_and(|id| id.to_string() == BACKDROP_ID)
}

/// Whether `style` draws something behind the view: an explicit macOS
/// backdrop, glass where AppKit has it, or a `backdropFilter` blur.
pub(crate) fn has_backdrop(style: &ViewStyle) -> bool {
    style.macos_backdrop.is_some()
        || (style.glass_effect != GlassEffect::None && glass_class().is_some())
        || style.effects.as_ref().is_some_and(|e| {
            e.backdrop_filters
                .iter()
                .any(|f| matches!(*f, Filter::Blur(r) if r.0 > 0.0))
        })
}

/// What draws a view's backdrop: `macos={{ backdrop }}` wins (an
/// `NSVisualEffectView` of that material, blending and state, with or
/// without a blur filter), then glass where AppKit has it (macOS 26), then
/// the `backdropFilter` blur (a [`PlainBlur`] when a mask is over it).
///
/// `glass_available` says whether this Mac has `NSGlassEffectView`: the
/// class is looked up at run time, so an older macOS keeps the blur, as
/// before.
fn backdrop_kind(
    style: &ViewStyle,
    radius: f32,
    masked: bool,
    glass_available: bool,
) -> Option<BackdropKind> {
    if style.macos_backdrop.is_some() {
        return Some(BackdropKind::Material);
    }
    if style.glass_effect != GlassEffect::None && glass_available {
        return Some(BackdropKind::Glass);
    }
    if radius > 0.0 {
        return Some(if masked {
            BackdropKind::Plain
        } else {
            BackdropKind::Material
        });
    }
    None
}

/// An `NSVisualEffectMaterial` for a material of `macos={{ backdrop }}`.
fn visual_effect_material(material: MacOsBackdropMaterial) -> NSVisualEffectMaterial {
    match material {
        MacOsBackdropMaterial::Titlebar => NSVisualEffectMaterial::Titlebar,
        MacOsBackdropMaterial::Selection => NSVisualEffectMaterial::Selection,
        MacOsBackdropMaterial::Menu => NSVisualEffectMaterial::Menu,
        MacOsBackdropMaterial::Popover => NSVisualEffectMaterial::Popover,
        MacOsBackdropMaterial::Sidebar => NSVisualEffectMaterial::Sidebar,
        MacOsBackdropMaterial::HeaderView => NSVisualEffectMaterial::HeaderView,
        MacOsBackdropMaterial::Sheet => NSVisualEffectMaterial::Sheet,
        MacOsBackdropMaterial::WindowBackground => NSVisualEffectMaterial::WindowBackground,
        MacOsBackdropMaterial::HudWindow => NSVisualEffectMaterial::HUDWindow,
        MacOsBackdropMaterial::FullScreenUI => NSVisualEffectMaterial::FullScreenUI,
        MacOsBackdropMaterial::ToolTip => NSVisualEffectMaterial::ToolTip,
        MacOsBackdropMaterial::ContentBackground => NSVisualEffectMaterial::ContentBackground,
        MacOsBackdropMaterial::UnderWindowBackground => {
            NSVisualEffectMaterial::UnderWindowBackground
        }
        MacOsBackdropMaterial::UnderPageBackground => NSVisualEffectMaterial::UnderPageBackground,
    }
}

/// An `NSVisualEffectBlendingMode` for a blending of `macos={{ backdrop }}`.
fn visual_effect_blending(blending: MacOsBackdropBlending) -> NSVisualEffectBlendingMode {
    match blending {
        MacOsBackdropBlending::WithinWindow => NSVisualEffectBlendingMode::WithinWindow,
        MacOsBackdropBlending::BehindWindow => NSVisualEffectBlendingMode::BehindWindow,
    }
}

/// An `NSVisualEffectState` for a state of `macos={{ backdrop }}`.
fn visual_effect_state(state: MacOsBackdropState) -> NSVisualEffectState {
    match state {
        MacOsBackdropState::FollowsWindowActiveState => {
            NSVisualEffectState::FollowsWindowActiveState
        }
        MacOsBackdropState::Active => NSVisualEffectState::Active,
        MacOsBackdropState::Inactive => NSVisualEffectState::Inactive,
    }
}

/// AppKit's glass view, which macOS 26 brought.
///
/// Looked up at runtime, as `nsh-platform-ios` looks up `UIGlassEffect`:
/// binding it by its link-time symbol would keep the app from launching
/// on an earlier macOS (Rust cannot link a class weakly yet,
/// rust-lang/rust#29603).
fn glass_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"NSGlassEffectView")
}

/// A glass view of `style` at `frame`, where AppKit has one.
fn new_glass(style: GlassEffect, frame: CGRect) -> Option<Retained<NSView>> {
    if style == GlassEffect::None {
        return None;
    }
    let class = glass_class()?;
    // SAFETY: the class found is NSGlassEffectView, an NSView subclass:
    // `alloc` and NSView's `initWithFrame:` make one. Called on the main
    // thread with the view it decorates.
    let view: Retained<NSView> = unsafe {
        let allocated: Allocated<NSView> = msg_send![class, alloc];
        msg_send![allocated, initWithFrame: frame]
    };
    set_glass_style(&view, style);
    Some(view)
}

/// Sets a glass view's style: regular or clear.
fn set_glass_style(view: &NSView, style: GlassEffect) {
    // NSGlassEffectViewStyle: regular, clear.
    let raw: isize = match style {
        GlassEffect::None => return,
        GlassEffect::Regular => 0,
        GlassEffect::Clear => 1,
    };
    // SAFETY: NSGlassEffectView's `setStyle:`, an NSInteger style, on the
    // main thread (`backdrop_kind` only chose glass where the class is).
    let _: () = unsafe { msg_send![view, setStyle: raw] };
}

/// Sets a glass view's tint, or clears it (`None`) where the class has the
/// setter (macOS 26's).
fn set_glass_tint(view: &NSView, tint: Option<Color>) {
    if !view.respondsToSelector(objc2::sel!(setTintColor:)) {
        return;
    }
    let color = tint.map(|c| {
        let (r, g, b, a) = c.to_f64();
        NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a)
    });
    // SAFETY: NSGlassEffectView's `tintColor` is an NSColor (`nil` for the
    // class's own tint), on the main thread.
    let _: () = unsafe { msg_send![view, setTintColor: color.as_deref()] };
}

/// Whether `style` has effects that draw outside the box (they need an
/// unclipped layer, so clipping moves to a content view).
pub(crate) fn draws_outside(style: &ViewStyle) -> bool {
    style.outline.is_visible()
        || style
            .effects
            .as_ref()
            .is_some_and(|e| e.box_shadows.iter().any(|s| !s.inset && s.is_visible()))
}

/// Whether `style` has a visible outer box shadow.
pub(crate) fn has_outer_shadow(style: &ViewStyle) -> bool {
    style
        .effects
        .as_ref()
        .is_some_and(|e| e.box_shadows.iter().any(|s| !s.inset && s.is_visible()))
}

/// The view's drop shadow filter, if any (it follows the content's shape):
/// one is drawn, the widest of the chain's (the last of equals).
pub(crate) fn drop_shadow(style: &ViewStyle) -> Option<(f32, f32, f32, Color)> {
    style
        .effects
        .as_ref()?
        .filters
        .iter()
        .filter_map(|f| match *f {
            Filter::DropShadow {
                offset_x,
                offset_y,
                blur,
                color,
            } => Some((offset_x.0, offset_y.0, blur.0, color)),
            _ => None,
        })
        .max_by(|a, b| a.2.total_cmp(&b.2))
}

impl Visual {
    /// It holds no layer, as a new one.
    pub(crate) fn is_empty(&self) -> bool {
        let Self {
            shadows,
            insets,
            gradients,
            outline,
            veil,
            backdrop,
            mask_image,
        } = self;
        shadows.is_none()
            && insets.is_none()
            && gradients.is_empty()
            && outline.is_none()
            && veil.is_none()
            && backdrop.is_none()
            && mask_image.is_none()
    }

    /// Shapes the effect layers of `view` (in its own `layer`) after
    /// `style`; `filled`: an opaque fill layer covers the box.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply(
        &mut self,
        view: &NshView,
        layer: &CALayer,
        style: &ViewStyle,
        local: CGRect,
        radii: CornerRadii,
        text: bool,
        filled: bool,
    ) {
        let effects = style.effects.as_deref();
        let shadows = effects.map_or(&[][..], |e| &e.box_shadows[..]);
        let outer: Vec<&BoxShadow> = shadows
            .iter()
            .filter(|s| !s.inset && s.is_visible())
            .collect();
        let inner: Vec<&BoxShadow> = shadows
            .iter()
            .filter(|s| s.inset && s.is_visible())
            .collect();
        // An opaque fill or gradient (both above the shadows) hides the box.
        // (Text views draw no gradient layers.)
        let covered = filled
            || !text
                && effects.is_some_and(|e| {
                    e.background_images
                        .iter()
                        .any(|g| g.stops.iter().all(|s| s.color.0 & 0xff == 0xff))
                });
        self.set_shadows(layer, &outer, local, radii, covered);
        // Text draws in the layer's own contents, below every sublayer:
        // effects inside the box would cover it.
        let inner: &[&BoxShadow] = if text { &[] } else { &inner };
        let border = style.borders.uniform().map_or(0.0, |(w, _)| w.0);
        self.set_insets(layer, inner, local, radii, border);
        let gradients = if text {
            &[][..]
        } else {
            effects.map_or(&[][..], |e| &e.background_images[..])
        };
        self.set_gradients(layer, gradients, local, radii);
        self.set_outline(layer, style, local, radii);
        let brightness = effects.map_or(1.0, |e| {
            e.filters
                .iter()
                .map(|f| match *f {
                    Filter::Brightness(b) => b,
                    _ => 1.0,
                })
                .product::<f32>()
        });
        self.set_veil(layer, brightness, local, radii);
        let blur = effects.map_or(0.0, |e| {
            e.backdrop_filters
                .iter()
                .map(|f| match *f {
                    Filter::Blur(r) => r.0,
                    _ => 0.0,
                })
                .sum::<f32>()
        });
        let masked = effects.is_some_and(|e| !e.mask_images.is_empty());
        self.set_backdrop(view, style, blur, masked, local, radii);
        // Last: the mask covers everything above, the backdrop's view included.
        self.set_mask_image(
            layer,
            effects.map_or(&[][..], |e| &e.mask_images[..]),
            local,
        );
    }

    /// `mask-image`: a gradient whose alpha decides how much of the view is
    /// drawn. Set on the view's own layer, so it masks the content, the
    /// background, the shadows and the backdrop's view alike.
    ///
    /// CSS composites several mask layers; this draws the topmost one, which
    /// is what a fade along one edge needs (as on iOS).
    fn set_mask_image(&mut self, layer: &CALayer, masks: &[Gradient], local: CGRect) {
        let Some(mask) = masks.first() else {
            if self.mask_image.take().is_some() {
                // SAFETY: clearing the mask.
                unsafe { layer.setMask(None) };
            }
            return;
        };
        let g = self.mask_image.get_or_insert_with(CAGradientLayer::new);
        g.setFrame(local);
        shape_gradient(g, mask, local.size);
        // SAFETY: the layer owns the mask, which has no superlayer of its own.
        unsafe { layer.setMask(Some(g)) };
    }

    fn set_shadows(
        &mut self,
        layer: &CALayer,
        shadows: &[&BoxShadow],
        local: CGRect,
        radii: CornerRadii,
        covered: bool,
    ) {
        if shadows.is_empty() {
            if let Some((h, _)) = self.shadows.take() {
                h.removeFromSuperlayer();
            }
            return;
        }
        let (holder, casters) = self.shadows.get_or_insert_with(|| {
            let h = CALayer::new();
            h.setZPosition(SHADOW_Z);
            layer.addSublayer(&h);
            (h, Vec::new())
        });
        // Everything but the box, as far as the farthest shadow reaches.
        let reach = shadows
            .iter()
            .map(|s| {
                s.offset_x.0.abs().max(s.offset_y.0.abs()) + s.spread.0.abs() + s.blur.0 * 2.0 + 4.0
            })
            .fold(0.0, f32::max) as CGFloat;
        let around = grow(local, reach);
        holder.setFrame(local);
        if covered {
            // SAFETY: clearing the mask.
            unsafe { holder.setMask(None) };
        } else {
            let mask = mask_layer(holder);
            let path = CGMutablePath::new();
            // SAFETY: valid mutable paths, a null transform.
            unsafe {
                CGMutablePath::add_rect(Some(&path), std::ptr::null(), around);
                CGMutablePath::add_path(
                    Some(&path),
                    std::ptr::null(),
                    Some(&rounded(local, radii)),
                );
            }
            // The mask covers all it lets through: in-process renderings
            // (`renderInContext:`) cut masks off at their bounds.
            mask.setFrame(around);
            mask.setBounds(around);
            mask.setPath(Some(&path));
        }
        resize(casters, shadows.len(), holder, CAShapeLayer::new);
        // The box, which the mask hides.
        let content = rounded(local, radii);
        // CSS order is top first; later sublayers draw on top.
        for (l, s) in casters.iter().zip(shadows.iter().rev()) {
            let shape = grow(local, s.spread.0 as CGFloat);
            l.setFrame(local);
            let path = rounded(shape, grown(radii, s.spread));
            cast(l, &path, &content, s, s.offset_x.0, s.offset_y.0);
            if covered {
                // Nothing to hide the stand-in content: the shadow only.
                l.setFillColor(None);
            }
        }
    }

    fn set_insets(
        &mut self,
        layer: &CALayer,
        shadows: &[&BoxShadow],
        local: CGRect,
        radii: CornerRadii,
        border: f32,
    ) {
        if shadows.is_empty() {
            if let Some((h, _)) = self.insets.take() {
                h.removeFromSuperlayer();
            }
            return;
        }
        let (holder, casters) = self.insets.get_or_insert_with(|| {
            let h = CALayer::new();
            h.setZPosition(INSET_Z);
            layer.addSublayer(&h);
            (h, Vec::new())
        });
        // Inside the padding box.
        let padding = inset(local, border as CGFloat);
        let inner_radii = radii.inset(px(border));
        match crate::decor::shared(&inner_radii) {
            Some(r) => {
                // Rounded bounds clip at no cost per frame (a mask has one):
                // the holder is the padding box, its sublayers keep the
                // view's coordinates.
                // SAFETY: clearing the mask.
                unsafe { holder.setMask(None) };
                holder.setFrame(padding);
                holder.setBounds(padding);
                crate::decor::set_corners(holder, r as CGFloat, inner_radii.continuous);
                holder.setMasksToBounds(true);
            }
            None => {
                holder.setCornerRadius(0.0);
                holder.setMasksToBounds(false);
                holder.setFrame(local);
                let mask = mask_layer(holder);
                mask.setFrame(local);
                mask.setPath(Some(&rounded(padding, inner_radii)));
            }
        }
        resize(casters, shadows.len(), holder, CAShapeLayer::new);
        // A frame around the box, which the mask hides.
        let content = CGMutablePath::new();
        // SAFETY: valid mutable paths, a null transform.
        unsafe {
            CGMutablePath::add_rect(Some(&content), std::ptr::null(), grow(local, 8.0));
            CGMutablePath::add_rect(Some(&content), std::ptr::null(), local);
        }
        for (l, s) in casters.iter().zip(shadows.iter().rev()) {
            let reach = (s.offset_x.0.abs().max(s.offset_y.0.abs())
                + s.spread.0.abs()
                + s.blur.0 * 2.0
                + 4.0) as CGFloat;
            // The frame around the shifted, shrunk inner shape casts its
            // shadow inwards (non-zero winding: the hole runs backwards).
            let hole = offset(
                grow(padding, -(s.spread.0 as CGFloat)),
                s.offset_x.0,
                s.offset_y.0,
            );
            let path = CGMutablePath::new();
            // SAFETY: valid mutable paths, a null transform.
            unsafe {
                CGMutablePath::add_rect(Some(&path), std::ptr::null(), grow(local, reach));
            }
            add_reversed(&path, hole, grown(inner_radii, -s.spread));
            l.setFrame(local);
            cast(l, &path, &content, s, 0.0, 0.0);
        }
    }

    fn set_gradients(
        &mut self,
        layer: &CALayer,
        gradients: &[Gradient],
        local: CGRect,
        radii: CornerRadii,
    ) {
        resize(&mut self.gradients, gradients.len(), layer, || {
            let g = CAGradientLayer::new();
            g.setZPosition(GRADIENT_Z);
            g
        });
        let shared = crate::decor::shared(&radii);
        // CSS order is top first.
        for (g, gradient) in self.gradients.iter().zip(gradients.iter().rev()) {
            g.setFrame(local);
            match shared {
                Some(r) => {
                    crate::decor::set_corners(g, r as CGFloat, radii.continuous);
                    g.setMasksToBounds(true);
                    // SAFETY: clearing the mask.
                    unsafe { g.setMask(None) };
                }
                None => {
                    g.setCornerRadius(0.0);
                    g.setMasksToBounds(false);
                    let mask = mask_layer(g);
                    mask.setFrame(local);
                    mask.setPath(Some(&rounded(local, radii)));
                }
            }
            shape_gradient(g, gradient, local.size);
        }
    }

    fn set_outline(
        &mut self,
        layer: &CALayer,
        style: &ViewStyle,
        local: CGRect,
        radii: CornerRadii,
    ) {
        let o = style.outline;
        if !o.is_visible() {
            if let Some(l) = self.outline.take() {
                l.removeFromSuperlayer();
            }
            return;
        }
        let l = self.outline.get_or_insert_with(|| {
            let l = CAShapeLayer::new();
            l.setZPosition(OUTLINE_Z);
            l.setFillColor(None);
            layer.addSublayer(&l);
            l
        });
        // Centered on a line `offset` outside the border box; the corners
        // follow the border radius outwards.
        let d = o.offset + o.width / 2.0;
        let radii = if radii.is_zero() {
            radii
        } else {
            grown(radii, d)
        };
        l.setFrame(local);
        l.setPath(Some(&rounded(grow(local, d.0 as CGFloat), radii)));
        l.setLineWidth(o.width.0 as CGFloat);
        l.setStrokeColor(cg_color(o.color).as_deref());
        let w = o.width.0 as f64;
        let pattern: Option<Retained<NSArray<NSNumber>>> = match o.style {
            BorderStyle::Solid => None,
            BorderStyle::Dashed => Some(NSArray::from_retained_slice(&[
                NSNumber::new_f64(w * 3.0),
                NSNumber::new_f64(w * 3.0),
            ])),
            BorderStyle::Dotted => Some(NSArray::from_retained_slice(&[
                NSNumber::new_f64(0.0),
                NSNumber::new_f64(w * 2.0),
            ])),
        };
        l.setLineDashPattern(pattern.as_deref());
        // SAFETY: immutable Core Animation constants.
        l.setLineCap(unsafe {
            if o.style == BorderStyle::Dotted {
                kCALineCapRound
            } else {
                kCALineCapButt
            }
        });
    }

    /// `brightness()` below 1: a black veil over the view (exact for opaque
    /// content). Brighter values are not drawn.
    fn set_veil(&mut self, layer: &CALayer, brightness: f32, local: CGRect, radii: CornerRadii) {
        if brightness >= 1.0 {
            if let Some(v) = self.veil.take() {
                v.removeFromSuperlayer();
            }
            return;
        }
        let v = self.veil.get_or_insert_with(|| {
            let v = CALayer::new();
            v.setZPosition(VEIL_Z);
            v.setBackgroundColor(cg_color(Color::BLACK).as_deref());
            layer.addSublayer(&v);
            v
        });
        v.setFrame(local);
        v.setOpacity((1.0 - brightness.max(0.0)).min(1.0));
        let mask = mask_layer(v);
        mask.setFrame(local);
        mask.setPath(Some(&rounded(local, radii)));
    }

    /// Draws what the view asked behind it below everything the view draws
    /// (the view's background moves to a fill layer above it: `decor`):
    /// `macos={{ backdrop }}`'s material on an `NSVisualEffectView`, glass
    /// where AppKit has it (macOS 26), or the `backdropFilter` blur (AppKit
    /// chooses its radius, not `radius`; a masked blur is a [`PlainBlur`]).
    ///
    /// The view is reused while the kind of backdrop stays the same, so a
    /// material, blending, state, glass style or tint that changes is
    /// written to it (only changes are), and switching between glass, a
    /// material and a blur drops the old native view instead of leaving it
    /// stale behind the new one.
    fn set_backdrop(
        &mut self,
        view: &NshView,
        style: &ViewStyle,
        radius: f32,
        masked: bool,
        local: CGRect,
        radii: CornerRadii,
    ) {
        let kind = backdrop_kind(style, radius, masked, glass_class().is_some());
        if self.backdrop.as_ref().is_some_and(|b| Some(b.kind) != kind) {
            self.backdrop = None;
        }
        let Some(kind) = kind else {
            return;
        };
        if self.backdrop.is_none() {
            // Where AppKit has the glass class, its factory answers
            // (`backdrop_kind` asked).
            let Some(backdrop) = new_backdrop(kind, style, radius, view, local) else {
                return;
            };
            self.backdrop = Some(backdrop);
        }
        let b = self.backdrop.as_mut().expect("just inserted");
        b.view.setFrame(local);
        match kind {
            BackdropKind::Plain => {
                if let Some(blur) = b.view.downcast_ref::<PlainBlur>() {
                    blur.set_radius(radius);
                }
            }
            BackdropKind::Material => {
                let material = style.macos_backdrop.unwrap_or_default();
                if b.material != material {
                    if let Some(v) = b.view.downcast_ref::<NSVisualEffectView>() {
                        v.setBlendingMode(visual_effect_blending(material.blending));
                        v.setState(visual_effect_state(material.state));
                        v.setMaterial(visual_effect_material(material.material));
                    }
                    b.material = material;
                }
            }
            BackdropKind::Glass => {
                if let Some(glass) = &b.glass {
                    if b.glass_style != style.glass_effect {
                        set_glass_style(glass, style.glass_effect);
                        b.glass_style = style.glass_effect;
                    }
                    if b.tint != style.glass_tint_color {
                        set_glass_tint(glass, style.glass_tint_color);
                        b.tint = style.glass_tint_color;
                    }
                    // The glass draws its own rounded shape.
                    let r = crate::decor::shared(&radii).unwrap_or(0.0) as CGFloat;
                    // SAFETY: NSGlassEffectView's `setCornerRadius:`, a
                    // CGFloat, on the main thread.
                    let _: () = unsafe { msg_send![&**glass, setCornerRadius: r] };
                }
            }
        }
        let Some(layer) = b.view.layer() else {
            return;
        };
        // Below the background's fill layer and every effect.
        layer.setZPosition(BACKDROP_Z);
        match crate::decor::shared(&radii) {
            Some(r) => {
                crate::decor::set_corners(&layer, r as CGFloat, radii.continuous);
                layer.setMasksToBounds(true);
                // SAFETY: clearing the mask.
                unsafe { layer.setMask(None) };
            }
            None => {
                layer.setMasksToBounds(false);
                let mask = mask_layer(&layer);
                mask.setFrame(local);
                mask.setPath(Some(&rounded(local, radii)));
            }
        }
    }
}

/// The native view a backdrop of `kind` starts as: its first subview, below
/// the view's own layers.
fn new_backdrop(
    kind: BackdropKind,
    style: &ViewStyle,
    radius: f32,
    view: &NshView,
    local: CGRect,
) -> Option<Backdrop> {
    let backdrop = match kind {
        BackdropKind::Material => {
            let material = style.macos_backdrop.unwrap_or_default();
            let v = MaterialBackdrop::new(local, view.mtm());
            v.setBlendingMode(visual_effect_blending(material.blending));
            v.setState(visual_effect_state(material.state));
            v.setMaterial(visual_effect_material(material.material));
            Backdrop {
                view: Retained::into_super(Retained::into_super(v)),
                kind,
                glass: None,
                glass_style: GlassEffect::None,
                tint: None,
                material,
            }
        }
        BackdropKind::Plain => {
            let material = MacOsBackdrop::default();
            let v = PlainBlur::new(local, radius, view.mtm());
            v.setBlendingMode(visual_effect_blending(material.blending));
            v.setState(visual_effect_state(material.state));
            v.setMaterial(visual_effect_material(material.material));
            Backdrop {
                view: Retained::into_super(Retained::into_super(v)),
                kind,
                glass: None,
                glass_style: GlassEffect::None,
                tint: None,
                material,
            }
        }
        BackdropKind::Glass => {
            let glass = new_glass(style.glass_effect, CGRect::new(CGPoint::ZERO, local.size))?;
            glass.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            let host = GlassBackdrop::new(local, view.mtm());
            host.addSubview(&glass);
            Backdrop {
                view: Retained::into_super(host),
                kind,
                glass: Some(glass),
                glass_style: style.glass_effect,
                tint: None,
                material: MacOsBackdrop::default(),
            }
        }
    };
    // Its own layer now, to order and clip it below.
    backdrop.view.setWantsLayer(true);
    backdrop
        .view
        .setIdentifier(Some(ns_string!("nsh.backdrop")));
    view.ns()
        .addSubview_positioned_relativeTo(&backdrop.view, NSWindowOrderingMode::Below, None);
    Some(backdrop)
}

/// Makes `l` cast `s`'s shadow of `path`, moved by `(x, y)`.
///
/// Core Animation needs no content for a shadow path, but in-process
/// renderings (`renderInContext:`) ignore the path and shadow the content
/// (and skip layers without any): `l` draws `content` (even-odd), which its
/// holder's mask hides, so those show a shadow of about the right shape.
fn cast(
    l: &CAShapeLayer,
    path: &CGMutablePath,
    content: &CGMutablePath,
    s: &BoxShadow,
    x: f32,
    y: f32,
) {
    l.setPath(Some(content));
    // SAFETY: an immutable Core Animation constant.
    l.setFillRule(unsafe { kCAFillRuleEvenOdd });
    l.setFillColor(cg_color(Color(s.color.0 | 0xff)).as_deref());
    l.setShadowPath(Some(path));
    l.setShadowColor(cg_color(Color(s.color.0 | 0xff)).as_deref());
    l.setShadowOpacity((s.color.0 & 0xff) as f32 / 255.0);
    l.setShadowOffset(CGSize::new(x as CGFloat, y as CGFloat));
    // CSS blur is twice the Gaussian's deviation; Core Animation's radius
    // is close to the deviation.
    l.setShadowRadius(s.blur.0 as CGFloat / 2.0);
}

/// Keeps `layers` at `n`, adding new ones from `make` to `parent`.
fn resize<L: AsRef<CALayer>>(
    layers: &mut Vec<Retained<L>>,
    n: usize,
    parent: &CALayer,
    make: impl Fn() -> Retained<L>,
) {
    while layers.len() > n {
        if let Some(l) = layers.pop() {
            l.as_ref().removeFromSuperlayer();
        }
    }
    while layers.len() < n {
        let l = make();
        parent.addSublayer(l.as_ref());
        layers.push(l);
    }
}

/// The even-odd shape mask of `layer` (created on first use).
fn mask_layer(layer: &CALayer) -> Retained<CAShapeLayer> {
    // SAFETY: masks of effect layers are always shape layers owned here.
    if let Some(m) = layer.mask()
        && let Ok(m) = m.downcast::<CAShapeLayer>()
    {
        return m;
    }
    let m = CAShapeLayer::new();
    // SAFETY: an immutable Core Animation constant.
    m.setFillRule(unsafe { kCAFillRuleEvenOdd });
    // SAFETY: a fresh mask layer, owned by `layer`.
    unsafe { layer.setMask(Some(&m)) };
    m
}

fn grow(rect: CGRect, d: CGFloat) -> CGRect {
    CGRect::new(
        CGPoint::new(rect.origin.x - d, rect.origin.y - d),
        CGSize::new(
            (rect.size.width + 2.0 * d).max(0.0),
            (rect.size.height + 2.0 * d).max(0.0),
        ),
    )
}

fn offset(rect: CGRect, x: f32, y: f32) -> CGRect {
    CGRect::new(
        CGPoint::new(rect.origin.x + x as CGFloat, rect.origin.y + y as CGFloat),
        rect.size,
    )
}

/// Radii grown by `d` (shrunk when negative), corners without a radius
/// staying square.
fn grown(radii: CornerRadii, d: Points) -> CornerRadii {
    let g = |r: Points| {
        if r > Points::ZERO {
            (r + d).max(Points::ZERO)
        } else {
            Points::ZERO
        }
    };
    CornerRadii {
        top_left: g(radii.top_left),
        top_right: g(radii.top_right),
        bottom_right: g(radii.bottom_right),
        bottom_left: g(radii.bottom_left),
        ..radii
    }
}

/// Adds a rounded rectangle to `path` counterclockwise (a hole under the
/// non-zero rule of shadow paths).
fn add_reversed(path: &CFRetained<CGMutablePath>, rect: CGRect, radii: CornerRadii) {
    crate::decor::add_rounded(path, rect, radii, true);
}

/// Configures `g` to draw `gradient` over a `size` box.
fn shape_gradient(g: &CAGradientLayer, gradient: &Gradient, size: CGSize) {
    let (w, h) = (size.width.max(1.0), size.height.max(1.0));
    // How far along the gradient line the layer's `0..1` reaches: the
    // line, but a repeating radial gradient's rings past the ending shape
    // to the farthest corner (Core Animation repeats nothing).
    let reach = shape_gradient_geometry(g, gradient, w, h);
    let stops = gradient.unrolled_stops(
        nsh_core::Size::new(nsh_core::Points(w as f32), nsh_core::Points(h as f32)),
        nsh_core::geometry::Percentage(reach as f32),
    );
    // A transparent stop takes its neighbor's hue (as CSS's premultiplied
    // mixing does), so fades to transparent do not darken.
    let colors: Vec<Retained<objc2::runtime::AnyObject>> = (0..stops.len())
        .map(|i| {
            let c = stops[i].0;
            let c = if c.is_transparent() {
                let neighbor = stops[i + 1..]
                    .iter()
                    .chain(stops[..i].iter().rev())
                    .map(|(n, _)| *n)
                    .find(|n| !n.is_transparent());
                neighbor.map_or(c, |n| Color(n.0 & 0xffff_ff00))
            } else {
                c
            };
            // Transparent stops too: `cg_color` gives none for them.
            let (r, g, b, a) = c.to_f64();
            let color = objc2_core_graphics::CGColor::new_srgb(r, g, b, a);
            // SAFETY: a CGColor, which `colors` takes; CF objects are
            // Objective-C objects.
            unsafe {
                Retained::from_raw(CFRetained::into_raw(color).as_ptr().cast()).expect("color")
            }
        })
        .collect();
    let locations: Vec<Retained<NSNumber>> = stops
        .iter()
        .map(|(_, p)| NSNumber::new_f64(p.0 as f64))
        .collect();
    // SAFETY: an array of CGColors, as `colors` documents.
    unsafe { g.setColors(Some(&NSArray::from_retained_slice(&colors))) };
    g.setLocations(Some(&NSArray::from_retained_slice(&locations)));
}

/// Sets `g`'s type and its start and end points for `gradient` over a
/// `w` × `h` box; how far along the gradient line its end point is.
fn shape_gradient_geometry(
    g: &CAGradientLayer,
    gradient: &Gradient,
    w: CGFloat,
    h: CGFloat,
) -> CGFloat {
    match gradient.kind {
        GradientKind::Radial {
            circle,
            size: extent,
            x,
            y,
        } => {
            // SAFETY: an immutable Core Animation constant.
            g.setType(unsafe { kCAGradientLayerRadial });
            let (cx, cy) = (x.0 as CGFloat * w, y.0 as CGFloat * h);
            let (dx, dy) = match extent {
                GradientSize::ClosestSide => (cx.min(w - cx), cy.min(h - cy)),
                GradientSize::FarthestSide => (cx.max(w - cx), cy.max(h - cy)),
                GradientSize::ClosestCorner => {
                    let (a, b) = (cx.min(w - cx), cy.min(h - cy));
                    (a * std::f64::consts::SQRT_2, b * std::f64::consts::SQRT_2)
                }
                GradientSize::FarthestCorner => {
                    let (a, b) = (cx.max(w - cx), cy.max(h - cy));
                    (a * std::f64::consts::SQRT_2, b * std::f64::consts::SQRT_2)
                }
            };
            let (rx, ry) = if circle {
                let r = match extent {
                    GradientSize::ClosestSide => dx.min(dy),
                    GradientSize::FarthestSide => dx.max(dy),
                    _ => {
                        let (a, b) = (dx / std::f64::consts::SQRT_2, dy / std::f64::consts::SQRT_2);
                        (a * a + b * b).sqrt()
                    }
                };
                (r, r)
            } else {
                (dx, dy)
            };
            // The farthest corner, in radii of the ending shape.
            let reach = if gradient.repeating && rx > 0.0 && ry > 0.0 {
                (cx.max(w - cx) / rx).hypot(cy.max(h - cy) / ry).max(1.0)
            } else {
                1.0
            };
            g.setStartPoint(CGPoint::new(cx / w, cy / h));
            g.setEndPoint(CGPoint::new((cx + rx * reach) / w, (cy + ry * reach) / h));
            reach
        }
        GradientKind::Conic { from, x, y } => {
            // SAFETY: an immutable Core Animation constant.
            g.setType(unsafe { kCAGradientLayerConic });
            let (x, y) = (x.0 as CGFloat, y.0 as CGFloat);
            g.setStartPoint(CGPoint::new(x, y));
            // Core Animation starts at the end point's direction, clockwise
            // from the right; CSS starts up.
            let a = from.0 as f64 - std::f64::consts::FRAC_PI_2;
            g.setEndPoint(CGPoint::new(x + a.cos() / 2.0, y + a.sin() / 2.0));
            1.0
        }
        kind => {
            // SAFETY: an immutable Core Animation constant.
            g.setType(unsafe { kCAGradientLayerAxial });
            let box_size =
                nsh_core::Size::new(nsh_core::Points(w as f32), nsh_core::Points(h as f32));
            let angle = kind
                .linear_angle(box_size)
                .unwrap_or(nsh_core::geometry::deg(180.0));
            // CSS: the gradient line through the center at `angle` (0 up,
            // clockwise), long enough that corners get the end colors.
            let (s, c) = (angle.0 as f64).sin_cos();
            let len = (w * s).abs() + (h * c).abs();
            let (dx, dy) = (s * len / 2.0, -c * len / 2.0);
            let (cx, cy) = (w / 2.0, h / 2.0);
            g.setStartPoint(CGPoint::new((cx - dx) / w, (cy - dy) / h));
            g.setEndPoint(CGPoint::new((cx + dx) / w, (cy + dy) / h));
            1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// The view style that asks for `radius`'s backdrop blur.
    fn blur_style(radius: f32) -> ViewStyle {
        ViewStyle {
            effects: Some(Arc::new(nsh_core::Effects {
                box_shadows: Vec::new(),
                background_images: Vec::new(),
                filters: Vec::new(),
                backdrop_filters: vec![Filter::Blur(px(radius))],
                mask_images: Vec::new(),
            })),
            ..ViewStyle::default()
        }
    }

    /// `macos={{ backdrop }}` wins over glass and the blur; glass wins over
    /// the blur; without either, the blur is an AppKit material, or a
    /// radius-exact [`PlainBlur`] under a mask. Glass before macOS 26 leaves
    /// the blur (and draws nothing of its own without one).
    #[test]
    fn an_explicit_backdrop_wins_then_glass_then_the_blur() {
        let none = ViewStyle::default();
        assert_eq!(backdrop_kind(&none, 0.0, false, true), None);
        assert!(!has_backdrop(&none));

        let blurred = blur_style(12.0);
        assert!(has_backdrop(&blurred));
        assert_eq!(
            backdrop_kind(&blurred, 12.0, false, true),
            Some(BackdropKind::Material)
        );
        assert_eq!(
            backdrop_kind(&blurred, 12.0, true, true),
            Some(BackdropKind::Plain)
        );

        let mut glass = ViewStyle {
            glass_effect: GlassEffect::Regular,
            ..ViewStyle::default()
        };
        assert_eq!(
            backdrop_kind(&glass, 0.0, false, true),
            Some(BackdropKind::Glass)
        );
        assert_eq!(
            backdrop_kind(&glass, 0.0, false, false),
            None,
            "no NSGlassEffectView, no blur: glass alone draws nothing"
        );
        assert_eq!(
            backdrop_kind(&glass, 12.0, true, false),
            Some(BackdropKind::Plain),
            "the blur stands in for glass before macOS 26"
        );
        assert_eq!(
            backdrop_kind(&glass, 12.0, false, true),
            Some(BackdropKind::Glass)
        );

        let mut backdrop = MacOsBackdrop::default();
        backdrop.material = MacOsBackdropMaterial::HudWindow;
        backdrop.blending = MacOsBackdropBlending::BehindWindow;
        backdrop.state = MacOsBackdropState::FollowsWindowActiveState;
        glass.macos_backdrop = Some(backdrop);
        assert!(has_backdrop(&glass));
        assert_eq!(
            backdrop_kind(&glass, 0.0, false, true),
            Some(BackdropKind::Material),
            "an explicit material needs no blur and beats glass"
        );
        assert_eq!(
            backdrop_kind(&glass, 0.0, false, false),
            Some(BackdropKind::Material),
            "an explicit material needs no glass class"
        );
        assert_eq!(
            backdrop_kind(&glass, 12.0, true, true),
            Some(BackdropKind::Material)
        );

        let mut tinted = ViewStyle {
            glass_tint_color: Some(Color::rgba(255, 0, 0, 255)),
            ..ViewStyle::default()
        };
        assert_eq!(
            backdrop_kind(&tinted, 0.0, false, true),
            None,
            "a tint needs glass"
        );
        assert!(!has_backdrop(&tinted));
        tinted.glass_effect = GlassEffect::Clear;
        assert_eq!(
            backdrop_kind(&tinted, 0.0, false, true),
            Some(BackdropKind::Glass)
        );
    }
}
