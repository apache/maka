//! Drawing a surface's view tree with Direct2D.
//!
//! [`frame`] draws the whole tree of a surface into its window's swap
//! chain and presents it; [`snapshot`] draws it into an offscreen bitmap
//! and reads the pixels back (`nsh test`'s screenshots). Both go through
//! [`draw_view`], which draws one view and its subtree in this order:
//!
//! 1. shadows and background ([`crate::decor::draw_background`]),
//! 2. the content, clipped to the bounds: text, image, canvas,
//! 3. the children (clipped to the rounded bounds when the view clips),
//! 4. the hosted items ([`crate::view::Native`]) and the scroll indicator,
//! 5. the border ([`crate::decor::draw_border`]),
//!
//! all inside an opacity layer when the view is translucent, bounded by
//! the area the subtree draws in (a layer is a surface of the size of its
//! bounds and the clip: an unbounded one is as large as the window). A
//! translucent view that paints only its background color takes no layer:
//! the color is faded instead, which is the same. A view whose
//! transform is projective (perspective, `rotateX` with a perspective) is
//! drawn into an offscreen bitmap first and mapped with
//! `DrawBitmap`'s perspective transform; every other transform is a 3x2
//! world transform.
//!
//! Coordinates are points (Direct2D DIPs: the context's DPI is the
//! window's scale times 96).
//!
//! A window with web views draws the same single pass, split at each web
//! view ([`crate::compose`]): reaching one records where it goes
//! ([`DrawCx::compose`]), and the next thing drawn first moves the context
//! to the next layer above it ([`DrawCx::realize`]: the clips and opacity
//! layers pushed so far are popped, the target changes, and they are
//! pushed again). Without a composition, `realize` is one test of an
//! `Option`: the frame is the one swap chain, as before.

use std::rc::Rc;

use nsh_core::{
    BlendMode, Bounds, Color, Points, ViewKind,
    geometry::{Point, Size},
};
use windows::{
    Win32::{
        Foundation::{D2DERR_RECREATE_TARGET, RECT},
        Graphics::{
            Direct2D::{
                Common::{
                    D2D_POINT_2U, D2D_RECT_F, D2D_RECT_U, D2D_SIZE_F, D2D_SIZE_U,
                    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_FIGURE_BEGIN_FILLED,
                    D2D1_FIGURE_END_CLOSED, D2D1_PIXEL_FORMAT,
                },
                D2D1_ANTIALIAS_MODE_ALIASED, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_ARC_SEGMENT,
                D2D1_ARC_SIZE_SMALL, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_CPU_READ,
                D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
                D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LAYER_OPTIONS1_NONE, D2D1_LAYER_PARAMETERS1,
                D2D1_MAP_OPTIONS_READ, D2D1_ROUNDED_RECT, D2D1_SWEEP_DIRECTION_CLOCKWISE,
                ID2D1Bitmap1, ID2D1DeviceContext, ID2D1Geometry, ID2D1Image, ID2D1SolidColorBrush,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
        },
    },
    core::Interface,
};
use windows_numerics::Matrix3x2;

use crate::{
    compose::{Composition, Placement},
    geom::Mat4,
    gfx::{self, Gfx},
    surface::Surface,
    view::{Hosted, NshView, ViewState},
};

/// A color as Direct2D's (straight alpha; Direct2D premultiplies).
pub(crate) fn color_f(c: Color) -> D2D1_COLOR_F {
    let (r, g, b, a) = c.to_f64();
    D2D1_COLOR_F {
        r: r as f32,
        g: g as f32,
        b: b as f32,
        a: a as f32,
    }
}

/// A rectangle as Direct2D's.
pub(crate) fn rect_f(x: f32, y: f32, w: f32, h: f32) -> D2D_RECT_F {
    D2D_RECT_F {
        left: x,
        top: y,
        right: x + w,
        bottom: y + h,
    }
}

/// An unbounded rectangle (layer content bounds).
pub(crate) const INFINITE: D2D_RECT_F = D2D_RECT_F {
    left: -1.0e7,
    top: -1.0e7,
    right: 1.0e7,
    bottom: 1.0e7,
};

/// What was pushed on the context, to pop it the same way (and push it
/// again: [`DrawCx::flatten`]).
enum Pushed {
    /// A layer: its opacity, mask and content bounds, with the transform
    /// it was pushed with.
    Layer {
        transform: Matrix3x2,
        opacity: f32,
        mask: Option<ID2D1Geometry>,
        bounds: D2D_RECT_F,
    },
    /// An axis-aligned clip, with the transform it was pushed with.
    Clip {
        transform: Matrix3x2,
        rect: D2D_RECT_F,
    },
}

/// The state of one drawing pass.
pub(crate) struct DrawCx<'a> {
    /// The devices.
    pub(crate) gfx: &'a Gfx,
    /// The context drawn with (the same as `gfx.dc`).
    pub(crate) dc: &'a ID2D1DeviceContext,
    /// The world transform of the view being drawn (its coordinates to
    /// the target's DIPs).
    pub(crate) transform: Mat4,
    /// Pixels per point.
    pub(crate) scale: f32,
    /// The surface draws in its dark appearance.
    pub(crate) dark: bool,
    /// The frame's time (seconds, the animation clock).
    pub(crate) now: f64,
    brush: ID2D1SolidColorBrush,
    pushed: Vec<Pushed>,
    /// Hosted items drawn in this pass, with their window rectangles.
    pub(crate) drawn: Vec<(Rc<dyn Hosted>, RECT)>,
    /// True when drawing offscreen (a snapshot): child windows are not
    /// moved.
    pub(crate) offscreen: bool,
    /// True when the context's target holds what lies behind the view
    /// being drawn (the window's pass, a snapshot), so blend modes and
    /// backdrop filters can read it ([`crate::decor`]); false in passes
    /// drawn offscreen for a filtered or 3D-transformed view.
    pub(crate) backdrop: bool,
    /// The opacity of what is drawn now (the views' around it, multiplied).
    pub(crate) alpha: f32,
    /// The opacity [`DrawCx::solid`] multiplies into its colors: a
    /// translucent view that paints one shape is drawn with it instead of
    /// a layer ([`draw_view`]).
    fade: f32,
    /// The composed items (web views) reached in this pass, in paint
    /// order, with where they go.
    pub(crate) composed: Vec<Composed>,
    /// The window's pass of a surface with a composition: what is drawn
    /// after a composed item goes into the next layer.
    pub(crate) split: Option<Split<'a>>,
    /// The clip of the passes around this one (DIPs of the window), for
    /// a pass drawn offscreen in window coordinates.
    clip_base: Option<D2D_RECT_F>,
    /// The window's bounds (DIPs) in the window's pass: the children of a
    /// clipping view that fall outside what is visible are not drawn
    /// ([`hidden_by_clips`]). `None` in passes drawn offscreen, which
    /// draw everything.
    pub(crate) window: Option<D2D_RECT_F>,
    /// The areas (window DIPs) a partial frame draws: views wholly outside
    /// them are left out. `None`: everything.
    pub(crate) damage: Option<Vec<D2D_RECT_F>>,
    /// The first pushes clip to a partial frame's areas: not part of what
    /// views record as visible ([`DrawCx::visible`]).
    clip_skip: usize,
    /// In a pass drawn offscreen for a view (filters, 3D transforms), where
    /// that view draws in the window: what its subtree records as painted
    /// ([`NshView::set_painted`]).
    pub(crate) group_area: Option<D2D_RECT_F>,
    /// The pass draws the window's frame: views record where they were
    /// painted (not in snapshots, which leave the screen as it is).
    pub(crate) records: bool,
}

/// A composed item reached by a pass.
pub(crate) struct Composed {
    /// The item.
    pub(crate) item: Rc<dyn Hosted>,
    /// Where it goes.
    pub(crate) at: Placement,
}

/// The layers a window's pass draws into ([`DrawCx::realize`]).
pub(crate) struct Split<'a> {
    composition: &'a Composition,
    /// The window's size in pixels.
    size: (u32, u32),
    /// For each layer started, how many composed items are below it.
    pub(crate) layers: Vec<usize>,
    /// A composed item was reached: the next drawing starts a layer.
    pending: bool,
    /// Ending the draw into a target failed.
    pub(crate) error: Option<windows::core::Error>,
}

impl<'a> DrawCx<'a> {
    /// A pass with `dc` (its target set, between `BeginDraw` and
    /// `EndDraw`).
    pub(crate) fn new(
        gfx: &'a Gfx,
        scale: f32,
        dark: bool,
        now: f64,
    ) -> windows::core::Result<Self> {
        Self::with_dc(gfx, &gfx.dc, scale, dark, now)
    }

    fn with_dc(
        gfx: &'a Gfx,
        dc: &'a ID2D1DeviceContext,
        scale: f32,
        dark: bool,
        now: f64,
    ) -> windows::core::Result<Self> {
        let black = color_f(Color::BLACK);
        // SAFETY: a COM call on the live context.
        let brush = unsafe { dc.CreateSolidColorBrush(&black, None)? };
        Ok(DrawCx {
            gfx,
            dc,
            transform: Mat4::new(),
            scale,
            dark,
            now,
            brush,
            pushed: Vec::new(),
            drawn: Vec::new(),
            offscreen: false,
            backdrop: true,
            alpha: 1.0,
            fade: 1.0,
            composed: Vec::new(),
            split: None,
            clip_base: None,
            window: None,
            damage: None,
            clip_skip: 0,
            group_area: None,
            records: false,
        })
    }

    /// A pass like this one drawing with `dc` (another context of the same
    /// device, its target set and drawing begun) at `scale` pixels per
    /// point: offscreen drawing for filters and 3D transforms
    /// ([`crate::decor`]).
    pub(crate) fn nested<'b>(
        &self,
        dc: &'b ID2D1DeviceContext,
        scale: f32,
    ) -> windows::core::Result<DrawCx<'b>>
    where
        'a: 'b,
    {
        let mut cx = DrawCx::with_dc(self.gfx, dc, scale, self.dark, self.now)?;
        cx.offscreen = self.offscreen;
        cx.backdrop = false;
        cx.alpha = self.alpha;
        cx.clip_base = Some(self.clip_bounds());
        cx.group_area = self.group_area;
        cx.records = self.records;
        Ok(cx)
    }

    /// What the window and the clips pushed so far leave visible (DIPs of
    /// the window), in the window's pass.
    fn visible(&self) -> Option<D2D_RECT_F> {
        let window = self.window?;
        let clip = self.clip_bounds();
        Some(D2D_RECT_F {
            left: window.left.max(clip.left),
            top: window.top.max(clip.top),
            right: window.right.min(clip.right),
            bottom: window.bottom.min(clip.bottom),
        })
    }

    /// What the clips pushed so far leave visible, in DIPs of the target
    /// (and of the passes around it).
    fn clip_bounds(&self) -> D2D_RECT_F {
        let mut r = self.clip_base.unwrap_or(INFINITE);
        for p in self.pushed.iter().skip(self.clip_skip) {
            let b = match p {
                Pushed::Clip { transform, rect } => crate::compose::map_bounds(transform, rect),
                Pushed::Layer {
                    transform,
                    mask: Some(mask),
                    ..
                } => {
                    // SAFETY: a COM call on a live geometry.
                    match unsafe { mask.GetBounds(Some(transform)) } {
                        Ok(b) => b,
                        Err(_) => continue,
                    }
                }
                Pushed::Layer { .. } => continue,
            };
            r = crate::compose::intersect(r, b);
        }
        r
    }

    /// A composed item (`item`, `size` points with `radii`, at `m`) is
    /// drawn here: records where it goes, and what follows goes into the
    /// next layer.
    fn compose(&mut self, item: &Rc<dyn Hosted>, m: Mat4, size: (f32, f32), radii: [f32; 4]) {
        let s = self.scale;
        let t = m.to_3x2();
        // The page's pixels are the view's points times the scale: the
        // linear part stays, the translation is in pixels.
        let mut matrix = Matrix3x2 {
            M31: t.M31 * s,
            M32: t.M32 * s,
            ..t
        };
        if t.M11 == 1.0 && t.M22 == 1.0 && t.M12 == 0.0 && t.M21 == 0.0 {
            // Only moved: on whole pixels, so that the page stays sharp.
            matrix.M31 = matrix.M31.round();
            matrix.M32 = matrix.M32.round();
        }
        let c = self.clip_bounds();
        let clip = D2D_RECT_F {
            left: (c.left * s).max(0.0),
            top: (c.top * s).max(0.0),
            right: (c.right * s).min(1.0e7),
            bottom: (c.bottom * s).min(1.0e7),
        };
        let size_px = ((size.0 * s).round() as i32, (size.1 * s).round() as i32);
        let bounds = crate::compose::map_bounds(
            &matrix,
            &rect_f(0.0, 0.0, size_px.0 as f32, size_px.1 as f32),
        );
        if size_px.0 <= 0
            || size_px.1 <= 0
            || crate::compose::is_empty(&crate::compose::intersect(bounds, clip))
        {
            return;
        }
        self.composed.push(Composed {
            item: item.clone(),
            at: Placement {
                matrix,
                size: size_px,
                clip,
                radii: radii.map(|r| r * s),
                alpha: self.alpha,
            },
        });
        if let Some(split) = &mut self.split {
            split.pending = true;
        }
    }

    /// Something is about to be drawn: after a composed item, the pass
    /// goes on in the next layer (made as needed), with its clips and
    /// layers pushed again there.
    pub(crate) fn realize(&mut self) {
        let Some(split) = &mut self.split else { return };
        if !split.pending {
            return;
        }
        split.pending = false;
        let index = split.layers.len();
        let target = split
            .composition
            .layer_target(self.gfx, index, split.size, self.scale);
        let target = match target {
            Ok(t) => t,
            Err(err) => {
                // Drawn on below the web view instead.
                log::warn!("compose: no layer above the web view: {err}");
                return;
            }
        };
        split.layers.push(self.composed.len());
        let ended = self.flatten(|dc| {
            // SAFETY: COM calls on the live context between its pushes:
            // the draw into the previous target ends, one into the layer
            // begins.
            unsafe {
                let ended = dc.EndDraw(None, None);
                dc.SetTarget(&target);
                dc.BeginDraw();
                dc.SetTransform(&Matrix3x2::identity());
                dc.Clear(Some(&color_f(Color::TRANSPARENT)));
                ended
            }
        });
        if let (Err(err), Some(split)) = (ended, &mut self.split) {
            split.error.get_or_insert(err);
        }
    }

    /// Takes the composed items a nested pass reached (in window
    /// coordinates): what follows them goes above them.
    pub(crate) fn adopt_composed(&mut self, mut composed: Vec<Composed>) {
        if composed.is_empty() {
            return;
        }
        self.composed.append(&mut composed);
        if let Some(split) = &mut self.split {
            split.pending = true;
        }
    }

    /// The pass's solid brush, set to `color` (faded by the view's
    /// opacity when it is drawn without a layer).
    pub(crate) fn solid(&self, color: Color) -> &ID2D1SolidColorBrush {
        let mut c = color_f(color);
        c.a *= self.fade;
        // SAFETY: a COM call on a live brush.
        unsafe { self.brush.SetColor(&c) };
        &self.brush
    }

    /// Sets the world transform (`m` must be affine: see
    /// [`Mat4::is_affine`]).
    pub(crate) fn set_transform(&mut self, m: Mat4) {
        self.transform = m;
        let t = m.to_3x2();
        // SAFETY: a COM call on the live context.
        unsafe { self.dc.SetTransform(&t) };
    }

    /// Draws what follows at `opacity`.
    pub(crate) fn push_opacity(&mut self, opacity: f32) {
        self.push_layer(opacity, None, INFINITE);
    }

    /// Draws what follows at `opacity`, all of it inside `bounds` (current
    /// coordinates): Direct2D sizes the layer's surface to them, where an
    /// unbounded layer takes the whole clip (the window's, often).
    pub(crate) fn push_opacity_within(&mut self, opacity: f32, bounds: D2D_RECT_F) {
        self.push_layer(opacity, None, bounds);
    }

    /// Clips what follows to `geometry` (in the current coordinates).
    pub(crate) fn push_clip_geometry(&mut self, geometry: &ID2D1Geometry) {
        self.push_layer(1.0, Some(geometry.clone()), INFINITE);
    }

    /// Pushes a layer of `opacity` masked by `mask`, its content inside
    /// `bounds` (current coordinates).
    fn push_layer(&mut self, opacity: f32, mask: Option<ID2D1Geometry>, bounds: D2D_RECT_F) {
        self.push_layer_raw(opacity, mask.as_ref(), &bounds);
        self.pushed.push(Pushed::Layer {
            transform: self.dc_transform(),
            opacity,
            mask,
            bounds,
        });
    }

    fn push_layer_raw(&self, opacity: f32, mask: Option<&ID2D1Geometry>, bounds: &D2D_RECT_F) {
        let mut params = D2D1_LAYER_PARAMETERS1 {
            contentBounds: *bounds,
            geometricMask: std::mem::ManuallyDrop::new(mask.cloned()),
            maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
            maskTransform: Matrix3x2::identity(),
            opacity,
            opacityBrush: std::mem::ManuallyDrop::new(None),
            layerOptions: D2D1_LAYER_OPTIONS1_NONE,
        };
        // SAFETY: valid parameters; popped by `pop`.
        unsafe { self.dc.PushLayer(&params, None) };
        // The parameters own a reference to the mask: release it.
        // SAFETY: the field is not used afterwards.
        unsafe { std::mem::ManuallyDrop::drop(&mut params.geometricMask) };
    }

    /// The context's current transform.
    fn dc_transform(&self) -> Matrix3x2 {
        let mut t = Matrix3x2::identity();
        // SAFETY: a COM call on the live context writing to a local.
        unsafe { self.dc.GetTransform(&mut t) };
        t
    }

    /// Pops every layer and clip pushed so far, runs `between` (what was
    /// drawn into the layers is in the target then: to read what lies
    /// behind a view, [`crate::decor`]) and pushes them again as they
    /// were. Exact for clips; a translucent layer splits in two (what is
    /// drawn before and after no longer composites as one group).
    pub(crate) fn flatten<R>(&mut self, between: impl FnOnce(&ID2D1DeviceContext) -> R) -> R {
        for p in self.pushed.iter().rev() {
            match p {
                // SAFETY: matches the push.
                Pushed::Layer { .. } => unsafe { self.dc.PopLayer() },
                // SAFETY: as above.
                Pushed::Clip { .. } => unsafe { self.dc.PopAxisAlignedClip() },
            }
        }
        let out = between(self.dc);
        let current = self.dc_transform();
        for p in &self.pushed {
            match p {
                Pushed::Layer {
                    transform,
                    opacity,
                    mask,
                    bounds,
                } => {
                    // SAFETY: a COM call on the live context.
                    unsafe { self.dc.SetTransform(transform) };
                    self.push_layer_raw(*opacity, mask.as_ref(), bounds);
                }
                Pushed::Clip { transform, rect } => {
                    // SAFETY: COM calls on the live context; popped by
                    // `pop`.
                    unsafe {
                        self.dc.SetTransform(transform);
                        self.dc
                            .PushAxisAlignedClip(rect, D2D1_ANTIALIAS_MODE_ALIASED);
                    }
                }
            }
        }
        // SAFETY: a COM call on the live context.
        unsafe { self.dc.SetTransform(&current) };
        out
    }

    /// Clips what follows to the rectangle (current coordinates). Exact
    /// when the transform keeps rectangles axis-aligned; otherwise a
    /// geometric layer.
    pub(crate) fn push_clip_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let t = self.transform.to_3x2();
        if t.M12 == 0.0 && t.M21 == 0.0 {
            // Snapped to pixels when the edges fall on them, as UIKit's
            // `masksToBounds` of a pixel-aligned layer.
            let rect = rect_f(x, y, w, h);
            // SAFETY: popped by `pop`.
            unsafe {
                self.dc
                    .PushAxisAlignedClip(&rect, D2D1_ANTIALIAS_MODE_ALIASED)
            };
            self.pushed.push(Pushed::Clip {
                transform: self.dc_transform(),
                rect,
            });
        } else if let Some(g) = self.rounded_geometry(crate::geom::rect(x, y, w, h), [0.0; 4]) {
            self.push_clip_geometry(&g);
        } else {
            self.push_opacity(1.0);
        }
    }

    /// Clips what follows to the rounded rectangle `rect` with `radii`
    /// (clockwise from the top left).
    pub(crate) fn push_clip_rounded(&mut self, rect: Bounds<Points>, radii: [f32; 4]) {
        if radii.iter().all(|r| *r <= 0.0) {
            return self.push_clip_rect(
                rect.origin.x.0,
                rect.origin.y.0,
                rect.size.width.0,
                rect.size.height.0,
            );
        }
        match self.rounded_geometry(rect, radii) {
            Some(g) => self.push_clip_geometry(&g),
            None => self.push_clip_rect(
                rect.origin.x.0,
                rect.origin.y.0,
                rect.size.width.0,
                rect.size.height.0,
            ),
        }
    }

    /// Pops the last push.
    pub(crate) fn pop(&mut self) {
        match self.pushed.pop() {
            // SAFETY: matches the push.
            Some(Pushed::Layer { .. }) => unsafe { self.dc.PopLayer() },
            // SAFETY: as above.
            Some(Pushed::Clip { .. }) => unsafe { self.dc.PopAxisAlignedClip() },
            None => log::error!("render: pop without push"),
        }
    }

    /// The rounded rectangle `rect` with corner radii clockwise from the
    /// top left, as a geometry.
    pub(crate) fn rounded_geometry(
        &self,
        rect: Bounds<Points>,
        radii: [f32; 4],
    ) -> Option<ID2D1Geometry> {
        rounded_geometry(self.gfx, rect, radii)
    }
}

/// The rounded rectangle `rect` with corner radii clockwise from the top
/// left (each clamped to half the box), as a geometry.
pub(crate) fn rounded_geometry(
    gfx: &Gfx,
    rect: Bounds<Points>,
    radii: [f32; 4],
) -> Option<ID2D1Geometry> {
    let Bounds {
        origin: Point {
            x: Points(x),
            y: Points(y),
        },
        size: Size {
            width: Points(w),
            height: Points(h),
        },
    } = rect;
    let max = (w.min(h) / 2.0).max(0.0);
    let r = radii.map(|r| r.clamp(0.0, max));
    if r[0] == r[1] && r[1] == r[2] && r[2] == r[3] {
        let rr = D2D1_ROUNDED_RECT {
            rect: rect_f(x, y, w, h),
            radiusX: r[0],
            radiusY: r[0],
        };
        // SAFETY: COM calls on the live factory.
        return unsafe { gfx.factory.CreateRoundedRectangleGeometry(&rr) }
            .ok()
            .and_then(|g| g.cast().ok());
    }
    // SAFETY: COM calls on live objects; the sink is closed before use.
    unsafe {
        let path = gfx.factory.CreatePathGeometry().ok()?;
        let sink = path.Open().ok()?;
        let p = |px: f32, py: f32| windows_numerics::Vector2 { X: px, Y: py };
        let arc = |to: windows_numerics::Vector2, radius: f32| D2D1_ARC_SEGMENT {
            point: to,
            size: D2D_SIZE_F {
                width: radius,
                height: radius,
            },
            rotationAngle: 0.0,
            sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
            arcSize: D2D1_ARC_SIZE_SMALL,
        };
        sink.BeginFigure(p(x + r[0], y), D2D1_FIGURE_BEGIN_FILLED);
        sink.AddLine(p(x + w - r[1], y));
        if r[1] > 0.0 {
            sink.AddArc(&arc(p(x + w, y + r[1]), r[1]));
        }
        sink.AddLine(p(x + w, y + h - r[2]));
        if r[2] > 0.0 {
            sink.AddArc(&arc(p(x + w - r[2], y + h), r[2]));
        }
        sink.AddLine(p(x + r[3], y + h));
        if r[3] > 0.0 {
            sink.AddArc(&arc(p(x, y + h - r[3]), r[3]));
        }
        sink.AddLine(p(x, y + r[0]));
        if r[0] > 0.0 {
            sink.AddArc(&arc(p(x + r[0], y), r[0]));
        }
        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
        sink.Close().ok()?;
        path.cast().ok()
    }
}

/// Draws `view` and its subtree; `parent` is the world transform of the
/// parent's coordinates and `origin` where the view goes in them.
pub(crate) fn draw_view(cx: &mut DrawCx<'_>, view: &NshView, parent: Mat4, origin: (f32, f32)) {
    let state = view.state();
    let opacity = state.opacity();
    if state.style.hidden || state.concealed || opacity <= 0.0 {
        drop(state);
        if cx.records {
            view.set_painted(None);
        }
        return;
    }
    let mut local = Mat4::new().translate(origin.0, origin.1);
    if let Some(t) = state.transform() {
        local = Mat4::mul(&t, &local);
    }
    let world = Mat4::mul(&local, &parent);
    if crate::decor::backface_away(&state, &world) {
        drop(state);
        if cx.records {
            view.set_painted(None);
        }
        return;
    }
    if !world.is_affine() {
        drop(state);
        // Where a projected subtree lands is not kept: all of what is
        // visible stands for it, and its subtree drawn offscreen.
        let area = if cx.window.is_some() {
            cx.visible()
        } else {
            cx.group_area
        };
        if cx.records {
            view.set_painted(area);
        }
        cx.realize();
        let outer = std::mem::replace(&mut cx.group_area, area);
        draw_projected(cx, view, world, opacity);
        cx.group_area = outer;
        return;
    }
    let own = crate::compose::map_bounds(&world.to_3x2(), &own_area(&state));
    let painted = match cx.visible() {
        Some(visible) => intersection(&own, &visible),
        None => cx.group_area,
    };
    if cx.records {
        view.set_painted(painted);
    }
    // Outside a partial frame's area: a view whose subtree stays inside
    // it (it clips, or has no children) draws nothing there.
    if let Some(damage) = &cx.damage
        && !damage.iter().any(|d| intersects(&own, d))
        && state.natives.is_empty()
        && (state.clips() || view.with_children(<[NshView]>::is_empty))
    {
        return;
    }
    // Drawn above a web view reached before it, if any.
    cx.realize();
    let layered = crate::decor::layered(&state);
    // Opacity applies to the view and its subtree as one group. When the
    // view paints a single shape, fading that shape's color is the same
    // and needs no layer.
    let faded = opacity < 1.0 && !layered && paints_one_shape(view, &state);
    drop(state);
    cx.set_transform(world);
    let grouped = opacity < 1.0 && !faded;
    if grouped {
        match drawn_area(view) {
            Some(area) => cx.push_opacity_within(opacity, area),
            None => cx.push_opacity(opacity),
        }
    }
    let (alpha, fade) = (cx.alpha, cx.fade);
    cx.alpha *= opacity;
    if faded {
        cx.fade *= opacity;
    }
    if layered {
        // Filters, a shadow of the content or a blend mode: the view is
        // drawn offscreen and composited as one image.
        let area = drawn_area(view)
            .map(|a| crate::compose::map_bounds(&world.to_3x2(), &a))
            .or_else(|| cx.visible())
            .or(cx.group_area);
        let outer = std::mem::replace(&mut cx.group_area, area);
        crate::decor::draw_layered(cx, view, world);
        cx.group_area = outer;
    } else {
        draw_content(cx, view, world);
    }
    cx.alpha = alpha;
    cx.fade = fade;
    if grouped {
        cx.pop();
    }
}

/// True if `view` (its `state`) paints at most one shape, its background
/// color, and nothing else: no children, content, hosted items, border,
/// outline, shadow or effects. Its opacity is then its color's alpha.
fn paints_one_shape(view: &NshView, state: &ViewState) -> bool {
    matches!(state.kind, ViewKind::View)
        && state.text.is_none()
        && state.image.is_none()
        && state.canvas.is_none()
        && state.input.is_none()
        && state.scroll.is_none()
        && state.natives.is_empty()
        && state.style.effects.is_none()
        && state.style.blend_mode == BlendMode::Normal
        && !state.shadow().is_visible()
        && !state.borders().is_visible()
        && !state.style.outline.is_visible()
        && view.with_children(<[NshView]>::is_empty)
}

/// Where a view paints itself (not its children), in its coordinates: its
/// bounds, out by its shadows and outline, and the items it hosts.
fn own_area(state: &ViewState) -> D2D_RECT_F {
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    // A point more for the antialiased edges.
    let o = crate::decor::outset(state) + 1.0;
    let mut area = D2D_RECT_F {
        left: -o,
        top: -o,
        right: w + o,
        bottom: h + o,
    };
    for native in &state.natives {
        let r = native.rect;
        area = crate::view::union(
            &area,
            &rect_f(r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0),
        );
    }
    area
}

/// True when `a` and `b` share some area.
fn intersects(a: &D2D_RECT_F, b: &D2D_RECT_F) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// What `a` and `b` share, if anything.
fn intersection(a: &D2D_RECT_F, b: &D2D_RECT_F) -> Option<D2D_RECT_F> {
    intersects(a, b).then(|| D2D_RECT_F {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    })
}

/// True when the pixel rectangles `a` and `b` share some pixels.
pub(crate) fn overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// True if `view`, placed at `origin` in its parent drawn at `world`,
/// draws nothing inside `visible` (window DIPs): what its subtree covers
/// ([`drawn_area`], with its shadows, outlines and transforms) lies
/// outside. False when that area is not known.
fn hidden_by_clips(view: &NshView, world: Mat4, origin: (f32, f32), visible: &D2D_RECT_F) -> bool {
    let local = {
        let s = view.state();
        let mut local = Mat4::new().translate(origin.0, origin.1);
        if let Some(t) = s.transform() {
            local = Mat4::mul(&t, &local);
        }
        local
    };
    let world = Mat4::mul(&local, &world);
    if !world.is_affine() {
        return false;
    }
    let Some(area) = drawn_area(view) else {
        return false;
    };
    let b = crate::compose::map_bounds(&world.to_3x2(), &area);
    b.right <= visible.left
        || b.left >= visible.right
        || b.bottom <= visible.top
        || b.top >= visible.bottom
}

/// The area `view` and its subtree draw in, in its coordinates: its
/// bounds, out by its shadows and outline, with what its children draw
/// unless it clips them. `None` when that is not known: an item it hosts
/// unclipped (they may draw outside their rectangle), a 3D transform
/// below it.
pub(crate) fn drawn_area(view: &NshView) -> Option<D2D_RECT_F> {
    let state = view.state();
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    // A point more for the antialiased edges.
    let o = crate::decor::outset(&state) + 1.0;
    let mut area = D2D_RECT_F {
        left: -o,
        top: -o,
        right: w + o,
        bottom: h + o,
    };
    if state.clips() {
        return Some(area);
    }
    if !state.natives.is_empty() {
        return None;
    }
    view.with_children(|children| {
        for child in children {
            let local = {
                let s = child.state();
                if s.style.hidden || s.concealed || s.opacity() <= 0.0 {
                    continue;
                }
                let origin = state.child_origin(s.frame, s.shift);
                let mut local = Mat4::new().translate(origin.0, origin.1);
                if let Some(t) = s.transform() {
                    local = Mat4::mul(&t, &local);
                }
                local
            };
            if !local.is_affine() {
                return None;
            }
            let a = drawn_area(child)?;
            let b = crate::compose::map_bounds(&local.to_3x2(), &a);
            area = D2D_RECT_F {
                left: area.left.min(b.left),
                top: area.top.min(b.top),
                right: area.right.max(b.right),
                bottom: area.bottom.max(b.bottom),
            };
        }
        Some(area)
    })
}

/// Draws what `view` draws and its subtree at `world` (set on the context):
/// the backdrop filter, shadows and background, the content clipped to the
/// bounds, the children, the hosted items, the scroll indicator, the
/// border and outline.
pub(crate) fn draw_content(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4) {
    let state = view.state();
    crate::decor::draw_backdrop(cx, &state);
    crate::decor::draw_background(cx, &state);
    let clip = state.clips();
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    // Most views (boxes, rows) have no content of their own: no clip for it.
    let content = state.text.is_some() || state.image.is_some() || state.canvas.is_some();
    if clip {
        cx.push_clip_rounded(crate::geom::rect(0.0, 0.0, w, h), state.radii());
    } else if content {
        // The view's own content stays inside it, as a UIKit view's drawing
        // stays in its backing store.
        cx.push_clip_rect(0.0, 0.0, w, h);
    }
    if content {
        crate::text::draw(cx, &state);
        crate::image::draw(cx, &state);
        crate::canvas::draw(cx, &state);
    }
    if !clip && content {
        cx.pop();
    }
    let natives = state.natives.clone();
    drop(state);
    // Inside a clip (a scroll view's content), children out of sight are
    // left out: drawing them would issue their commands for nothing.
    let visible = if clip { cx.visible() } else { None };
    view.with_children(|children| {
        for child in children {
            let origin = {
                let s = child.state();
                view.state().child_origin(s.frame, s.shift)
            };
            if let Some(visible) = &visible
                && hidden_by_clips(child, world, origin, visible)
            {
                if cx.records {
                    child.set_painted(None);
                }
                continue;
            }
            draw_view(cx, child, world, origin);
        }
    });
    cx.set_transform(world);
    for native in &natives {
        let r = native.rect;
        let m = Mat4::new()
            .translate(r.origin.x.0, r.origin.y.0)
            .then(&world);
        if native.item.composed() {
            let radii = {
                let s = view.state();
                if s.clips() { s.radii() } else { [0.0; 4] }
            };
            cx.compose(&native.item, m, (r.size.width.0, r.size.height.0), radii);
            continue;
        }
        cx.realize();
        cx.set_transform(m);
        native.item.draw(cx, (r.size.width.0, r.size.height.0));
        if let Some((x, y, bw, bh)) = m.bounds(0.0, 0.0, r.size.width.0, r.size.height.0) {
            let s = cx.scale;
            let rect = RECT {
                left: (x * s).round() as i32,
                top: (y * s).round() as i32,
                right: ((x + bw) * s).round() as i32,
                bottom: ((y + bh) * s).round() as i32,
            };
            cx.drawn.push((native.item.clone(), rect));
        }
    }
    let state = view.state();
    let above = crate::scroll::indicates(&state)
        || state.borders().is_visible()
        || state.style.outline.is_visible();
    if above {
        // A scroll indicator, a border over a web view.
        cx.realize();
    }
    cx.set_transform(world);
    crate::scroll::draw_indicator(cx, &state);
    if clip {
        cx.pop();
    }
    crate::decor::draw_border(cx, &state);
}

/// Most pixels along a side of a 3D-transformed view's bitmap.
const MAX_PROJECTED: f32 = 8192.0;

/// Draws `view` (with a projective `world` transform) into an offscreen
/// bitmap, then maps the bitmap with Direct2D's perspective transform.
fn draw_projected(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4, opacity: f32) {
    let (w, h, overflow, outset) = {
        let s = view.state();
        (
            s.frame.size.width.0,
            s.frame.size.height.0,
            s.overflow,
            crate::decor::outset(&s),
        )
    };
    // What the subtree covers, in the view's coordinates, with the view's
    // shadows and outline.
    let area = overflow.unwrap_or(crate::geom::rect(0.0, 0.0, w, h));
    let area = crate::geom::rect(
        area.origin.x.0 - outset,
        area.origin.y.0 - outset,
        area.size.width.0 + 2.0 * outset,
        area.size.height.0 + 2.0 * outset,
    );
    if area.size.width.0 <= 0.0 || area.size.height.0 <= 0.0 {
        return;
    }
    // Drawn at the window's scale, less for a huge subtree (the bitmap's
    // DIPs stay the view's points).
    let scale = cx
        .scale
        .min(MAX_PROJECTED / area.size.width.0)
        .min(MAX_PROJECTED / area.size.height.0);
    let px = (
        (area.size.width.0 * scale).ceil().max(1.0) as u32,
        (area.size.height.0 * scale).ceil().max(1.0) as u32,
    );
    let props = gfx::target_properties(scale, true);
    // SAFETY: a COM call on the live context with valid properties.
    let bitmap = unsafe {
        cx.dc.CreateBitmap(
            D2D_SIZE_U {
                width: px.0,
                height: px.1,
            },
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
                ..props
            },
        )
    };
    let bitmap = match bitmap {
        Ok(b) => b,
        Err(err) => {
            log::debug!("render: projected view not drawn: {err}");
            return;
        }
    };
    let Ok(image) = bitmap.cast::<ID2D1Image>() else {
        return;
    };
    // The subtree as if untransformed, at the bitmap's origin, drawn by
    // another context: layers pushed on this one stay as they are.
    let base = Mat4::new().translate(-area.origin.x.0, -area.origin.y.0);
    let mut flat = view.clone();
    let composed = cx.composed.len();
    let drawn = crate::decor::layer::draw_into(cx, &image, scale, true, |inner| {
        draw_flat(inner, &mut flat, base);
    });
    // Web views in it were placed in the bitmap's coordinates, not the
    // window's: they are not shown (a visual takes no perspective).
    cx.composed.truncate(composed);
    if !drawn {
        return;
    }
    // The bitmap's DIPs map to the view's coordinates (offset by the
    // area's origin), then through the view's world transform.
    let m = Mat4::new()
        .translate(area.origin.x.0, area.origin.y.0)
        .then(&world);
    let dest = rect_f(0.0, 0.0, area.size.width.0, area.size.height.0);
    let saved = cx.transform;
    // SAFETY: COM calls on the live context and bitmap.
    unsafe {
        cx.dc.SetTransform(&Matrix3x2::identity());
        cx.dc.DrawBitmap(
            &bitmap,
            Some(&dest),
            opacity,
            D2D1_INTERPOLATION_MODE_LINEAR,
            None,
            Some(&m.to_d2d()),
        );
    }
    cx.set_transform(saved);
}

/// Draws `view` with its transform replaced by `base` (the inside of
/// [`draw_projected`]), at full opacity.
fn draw_flat(cx: &mut DrawCx<'_>, view: &mut NshView, base: Mat4) {
    let (saved_style_transform, saved_opacity, saved_anim) = {
        let mut s = view.state_mut();
        let t = std::mem::take(&mut s.style.transform);
        let o = std::mem::replace(&mut s.style.opacity, 1.0);
        // Only the animated opacity and transform: animated colors and
        // shadows still draw.
        let a = s.anim;
        s.anim.opacity = None;
        s.anim.transform = Default::default();
        (t, o, a)
    };
    let saved_live = view.state_mut().live.take();
    let saved_fade = std::mem::replace(&mut view.state_mut().fade, 1.0);
    draw_view(cx, view, base, (0.0, 0.0));
    let mut s = view.state_mut();
    s.style.transform = saved_style_transform;
    s.style.opacity = saved_opacity;
    s.anim = saved_anim;
    s.live = saved_live;
    s.fade = saved_fade;
}

/// Draws the surface's window: the whole tree, then presents it.
pub(crate) fn frame(surface: &Rc<Surface>) {
    let Ok(gfx) = gfx::get() else { return };
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    let scale = surface.scale();
    let size = surface.pixel_size();
    if size.0 == 0 || size.1 == 0 {
        return;
    }
    let mut swap = surface.swap.borrow_mut();
    if swap.as_ref().is_some_and(|s| s.stale()) {
        *swap = None;
    }
    if swap.is_none() {
        match gfx::SwapChain::new(&gfx, hwnd, size) {
            Ok(s) => *swap = Some(s),
            Err(err) => {
                log::error!("cannot create the swap chain: {err}");
                return;
            }
        }
    }
    let Some(chain) = swap.as_mut() else { return };
    if let Err(err) = chain.resize(&gfx, size) {
        log::error!("cannot resize the swap chain: {err}");
        *swap = None;
        return;
    }
    if (surface.target_scale.get() - scale).abs() > f32::EPSILON {
        chain.drop_target();
        surface.target_scale.set(scale);
    }
    let target = match chain.target(&gfx, scale) {
        Ok(t) => t,
        Err(err) => {
            log::error!("cannot get the back buffer: {err}");
            return;
        }
    };
    // Only a window with web views has a composition: without one the
    // frame is the one swap chain, drawn and presented as always.
    let composition = surface.composition();
    // What changed, in pixels (`None`: everything). A window with web views
    // draws its layers whole.
    let damage = surface.take_damage();
    let changed = damage
        .filter(|_| composition.is_none())
        .map(|rects| merged(pixel_rects(&rects, scale, size)))
        .filter(|rects| !rects.is_empty());
    // What the back buffer, two presents old, needs drawn again.
    let redraw = chain.to_draw(changed.as_deref()).map(merged);
    let areas: Option<Vec<D2D_RECT_F>> = redraw.as_ref().map(|rects| {
        rects
            .iter()
            .map(|r| D2D_RECT_F {
                left: r.left as f32 / scale,
                top: r.top as f32 / scale,
                right: r.right as f32 / scale,
                bottom: r.bottom as f32 / scale,
            })
            .collect()
    });
    let fps = surface.fps();
    let started = fps.as_ref().map(|_| std::time::Instant::now());
    let drawn = draw_into(
        surface,
        &gfx,
        &target,
        scale,
        false,
        composition.as_deref(),
        areas.as_deref(),
    );
    let painted = started.map(|s| s.elapsed());
    match drawn {
        Ok(drawn) => {
            if let Some(c) = &composition
                && let Err(err) = c.present(drawn.layers.len())
            {
                log::warn!("present failed: {err}");
                drop(swap);
                device_lost(surface);
                return;
            }
            let shown = std::time::Instant::now();
            if let Err(err) = chain.present(changed) {
                log::warn!("present failed: {err}");
                drop(swap);
                device_lost(surface);
                return;
            }
            if let (Some(fps), Some(painted)) = (&fps, painted) {
                fps.painted(painted, shown.elapsed());
            }
            drop(swap);
            surface.items_placed(drawn.items, redraw.as_deref());
            surface.composed_placed(composition.as_deref(), drawn.composed, &drawn.layers);
        }
        Err(err) if err.code() == D2DERR_RECREATE_TARGET => {
            drop(swap);
            device_lost(surface);
        }
        Err(err) => {
            log::error!("drawing failed: {err}");
            // The back buffer holds what is not known: drawn whole next.
            drop(swap);
            surface.invalidate();
        }
    }
}

/// The union of `rects` as one geometry.
fn rects_geometry(gfx: &Gfx, rects: &[D2D_RECT_F]) -> windows::core::Result<ID2D1Geometry> {
    // SAFETY: COM calls on the live factory.
    unsafe {
        let parts = rects
            .iter()
            .map(|r| {
                gfx.factory
                    .CreateRectangleGeometry(r)
                    .and_then(|g| g.cast())
                    .map(Some)
            })
            .collect::<windows::core::Result<Vec<Option<ID2D1Geometry>>>>()?;
        gfx.factory
            .CreateGeometryGroup(
                windows::Win32::Graphics::Direct2D::Common::D2D1_FILL_MODE_WINDING,
                &parts,
            )?
            .cast()
    }
}

/// Window DIP rectangles as the pixels they touch (rounded out), within
/// the window's `size`.
fn pixel_rects(rects: &[D2D_RECT_F], scale: f32, size: (u32, u32)) -> Vec<RECT> {
    let (w, h) = (size.0 as i32, size.1 as i32);
    rects
        .iter()
        .map(|r| RECT {
            left: ((r.left * scale).floor() as i32).clamp(0, w),
            top: ((r.top * scale).floor() as i32).clamp(0, h),
            right: ((r.right * scale).ceil() as i32).clamp(0, w),
            bottom: ((r.bottom * scale).ceil() as i32).clamp(0, h),
        })
        .filter(|r| r.right > r.left && r.bottom > r.top)
        .collect()
}

/// At most this many areas make a partial frame's clip; more are merged.
const MAX_AREAS: usize = 24;

/// `rects` merged where they overlap or touch (drawn apart, the overlap
/// would be drawn twice) or their union adds no pixels, then the cheapest
/// pairs merged until at most [`MAX_AREAS`] are left.
fn merged(mut rects: Vec<RECT>) -> Vec<RECT> {
    let area = |r: &RECT| i64::from(r.right - r.left) * i64::from(r.bottom - r.top);
    let union = |a: &RECT, b: &RECT| RECT {
        left: a.left.min(b.left),
        top: a.top.min(b.top),
        right: a.right.max(b.right),
        bottom: a.bottom.max(b.bottom),
    };
    // The same area twice (a view drawn where it was), or inside another.
    rects.sort_unstable_by_key(|r| std::cmp::Reverse(area(r)));
    let mut kept: Vec<RECT> = Vec::with_capacity(rects.len());
    for r in rects {
        let inside = |k: &RECT| {
            k.left <= r.left && k.top <= r.top && k.right >= r.right && k.bottom >= r.bottom
        };
        if !kept.iter().any(inside) {
            kept.push(r);
        }
    }
    let mut rects = kept;
    if rects.len() > 256 {
        let all = rects.iter().skip(1).fold(rects[0], |a, b| union(&a, b));
        return vec![all];
    }
    loop {
        // The pair whose union adds the fewest pixels to the two.
        let mut best: Option<(usize, usize, i64)> = None;
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let growth = area(&union(&rects[i], &rects[j])) - area(&rects[i]) - area(&rects[j]);
                if best.is_none_or(|(_, _, g)| growth < g) {
                    best = Some((i, j, growth));
                }
            }
        }
        match best {
            Some((i, j, growth))
                if growth <= 0 || rects.len() > MAX_AREAS || touching(&rects[i], &rects[j]) =>
            {
                let u = union(&rects[i], &rects[j]);
                rects.swap_remove(j);
                rects[i] = u;
            }
            _ => {
                // The cheapest pair does not touch; another pair may.
                let touch = (0..rects.len())
                    .flat_map(|i| (i + 1..rects.len()).map(move |j| (i, j)))
                    .find(|&(i, j)| touching(&rects[i], &rects[j]));
                let Some((i, j)) = touch else {
                    return rects;
                };
                let u = union(&rects[i], &rects[j]);
                rects.swap_remove(j);
                rects[i] = u;
            }
        }
    }
}

/// True when `a` and `b` overlap or share an edge.
fn touching(a: &RECT, b: &RECT) -> bool {
    a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
}

fn device_lost(surface: &Rc<Surface>) {
    *surface.swap.borrow_mut() = None;
    if let Some(c) = surface.composition() {
        c.device_lost();
    }
    gfx::lost();
    surface.invalidate();
}

/// What a pass drew besides pixels.
struct Drawn {
    /// The hosted items drawn and their window rectangles.
    items: Vec<(Rc<dyn Hosted>, RECT)>,
    /// The composed items (web views) and where they go.
    composed: Vec<Composed>,
    /// The layers drawn: how many composed items are below each.
    layers: Vec<usize>,
}

/// Draws the tree into `target` (its DPI set for `scale`), and into the
/// layers of `composition` above its web views.
#[allow(clippy::too_many_arguments)]
fn draw_into(
    surface: &Rc<Surface>,
    gfx: &Gfx,
    target: &ID2D1Bitmap1,
    scale: f32,
    offscreen: bool,
    composition: Option<&Composition>,
    areas: Option<&[D2D_RECT_F]>,
) -> windows::core::Result<Drawn> {
    let dc = &gfx.dc;
    let background = color_f(crate::system::window_background(surface));
    // SAFETY: COM calls on the live context and target; `EndDraw` always
    // follows `BeginDraw`.
    unsafe {
        dc.SetTarget(target);
        dc.SetDpi(96.0 * scale, 96.0 * scale);
        dc.BeginDraw();
        dc.SetTransform(&Matrix3x2::identity());
        if areas.is_none() {
            dc.Clear(Some(&background));
        }
    }
    let mut cx = match DrawCx::new(gfx, scale, crate::system::dark(surface), surface.now()) {
        Ok(cx) => cx,
        Err(err) => {
            // SAFETY: closes the `BeginDraw` above.
            let _ = unsafe { dc.EndDraw(None, None) };
            return Err(err);
        }
    };
    cx.offscreen = offscreen;
    cx.records = !offscreen;
    let (w, h) = surface.size();
    cx.window = Some(rect_f(0.0, 0.0, w, h));
    cx.split = composition.map(|composition| Split {
        composition,
        size: surface.pixel_size(),
        layers: Vec::new(),
        pending: false,
        error: None,
    });
    let root = surface.root.clone();
    match areas {
        None => {
            draw_view(&mut cx, &root, Mat4::new(), (0.0, 0.0));
            // The caption buttons, last: in the topmost layer, above web
            // views.
            crate::chrome::draw(surface, dc, scale);
        }
        // A partial frame: each area cleared and drawn again, the rest of
        // the back buffer kept.
        // A partial frame: the areas cleared and the tree drawn once into
        // them (a clip of their rectangles), the rest of the back buffer
        // kept.
        Some(areas) => {
            cx.set_transform(Mat4::new());
            match areas {
                [a] => cx.push_clip_rect(a.left, a.top, a.right - a.left, a.bottom - a.top),
                _ => match rects_geometry(gfx, areas) {
                    Ok(group) => cx.push_clip_geometry(&group),
                    Err(err) => {
                        // SAFETY: closes the `BeginDraw` above.
                        let _ = unsafe { dc.EndDraw(None, None) };
                        return Err(err);
                    }
                },
            }
            cx.clip_skip = 1;
            // SAFETY: a COM call between BeginDraw and EndDraw: clears what
            // the clip leaves.
            unsafe { dc.Clear(Some(&background)) };
            cx.damage = Some(areas.to_vec());
            draw_view(&mut cx, &root, Mat4::new(), (0.0, 0.0));
            crate::chrome::draw(surface, dc, scale);
            cx.damage = None;
            cx.clip_skip = 0;
            cx.set_transform(Mat4::new());
            cx.pop();
        }
    }
    let items = std::mem::take(&mut cx.drawn);
    let composed = std::mem::take(&mut cx.composed);
    let (layers, error) = match cx.split.take() {
        Some(s) => (s.layers, s.error),
        None => (Vec::new(), None),
    };
    drop(cx);
    // SAFETY: closes the last `BeginDraw` (above, or a layer's); the target
    // is unset so that the swap chains can be resized later.
    let result = unsafe { dc.EndDraw(None, None) };
    // SAFETY: as above.
    unsafe { dc.SetTarget(None) };
    if let Some(err) = error {
        return Err(err);
    }
    result.map(|()| Drawn {
        items,
        composed,
        layers,
    })
}

/// Pixels of a snapshot: BGRA, premultiplied, `width * 4` bytes per row.
#[cfg_attr(not(feature = "dev"), allow(dead_code))]
pub(crate) struct Pixels {
    /// Width in pixels.
    pub(crate) width: u32,
    /// Height in pixels.
    pub(crate) height: u32,
    /// The rows.
    pub(crate) data: Vec<u8>,
}

/// Draws the surface offscreen at `scale` and reads the pixels back,
/// whatever covers the window.
#[cfg_attr(not(feature = "dev"), allow(dead_code))]
pub(crate) fn snapshot(surface: &Rc<Surface>, scale: f32) -> windows::core::Result<Pixels> {
    let gfx = gfx::get()?;
    let (w, h) = surface.size();
    let px = (
        (w * scale).round().max(1.0) as u32,
        (h * scale).round().max(1.0) as u32,
    );
    let size = D2D_SIZE_U {
        width: px.0,
        height: px.1,
    };
    let format = D2D1_PIXEL_FORMAT {
        format: DXGI_FORMAT_B8G8R8A8_UNORM,
        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
    };
    // SAFETY: COM calls on the live context; the mapped memory is copied
    // before `Unmap`.
    unsafe {
        let target = gfx.dc.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: format,
                dpiX: 96.0 * scale,
                dpiY: 96.0 * scale,
                bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
                colorContext: std::mem::ManuallyDrop::new(None),
            },
        )?;
        // Web views are not in it: their pages are composed by the system.
        let drawn = draw_into(surface, &gfx, &target, scale, true, None, None)?;
        drop(drawn);
        let read = gfx.dc.CreateBitmap(
            size,
            None,
            0,
            &D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: format,
                dpiX: 96.0 * scale,
                dpiY: 96.0 * scale,
                bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                colorContext: std::mem::ManuallyDrop::new(None),
            },
        )?;
        read.CopyFromBitmap(
            Some(&D2D_POINT_2U { x: 0, y: 0 }),
            &target,
            Some(&D2D_RECT_U {
                left: 0,
                top: 0,
                right: px.0,
                bottom: px.1,
            }),
        )?;
        let mapped = read.Map(D2D1_MAP_OPTIONS_READ)?;
        let mut data = Vec::with_capacity((px.0 * px.1 * 4) as usize);
        for row in 0..px.1 {
            let start = mapped.bits.add((row * mapped.pitch) as usize);
            data.extend_from_slice(std::slice::from_raw_parts(start, (px.0 * 4) as usize));
        }
        read.Unmap()?;
        Ok(Pixels {
            width: px.0,
            height: px.1,
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{Edges, NodeId, TransformKind};

    use super::*;
    use crate::geom::rect;

    fn view(
        parent: Option<&NshView>,
        id: NodeId,
        kind: ViewKind,
        frame: Bounds<Points>,
    ) -> NshView {
        let v = NshView::new(id, kind);
        v.state_mut().frame = frame;
        if let Some(parent) = parent {
            v.insert_before(parent, None);
        }
        v
    }

    /// A 16-point box with a color and rounded corners, as an animated
    /// dot or a highlighted cell.
    fn dot(parent: Option<&NshView>, id: NodeId) -> NshView {
        let v = view(parent, id, ViewKind::View, rect(0.0, 0.0, 16.0, 16.0));
        {
            let mut s = v.state_mut();
            s.style.background_color = Color(0x3366_ccff);
            s.style.border_radius = Points(2.0);
            s.style.opacity = 0.5;
        }
        v
    }

    fn one_shape(v: &NshView) -> bool {
        paints_one_shape(v, &v.state())
    }

    fn area(v: &NshView) -> (f32, f32, f32, f32) {
        let a = drawn_area(v).expect("a known area");
        (a.left, a.top, a.right, a.bottom)
    }

    #[test]
    fn a_box_of_one_color_fades_its_color() {
        let v = dot(None, 2);
        assert!(one_shape(&v));
        v.state_mut().style.borders.widths = Edges::all(Points(1.0));
        v.state_mut().style.borders.colors = [Color::BLACK; 4];
        // The border overlaps the background: only a layer fades both as one.
        assert!(!one_shape(&v));

        let v = dot(None, 4);
        v.state_mut().style.shadow.opacity = 1.0;
        assert!(!one_shape(&v));

        let v = dot(None, 6);
        v.state_mut().style.outline.width = Points(2.0);
        v.state_mut().style.outline.color = Color::BLACK;
        assert!(!one_shape(&v));

        let parent = dot(None, 8);
        dot(Some(&parent), 10);
        // Its children are faded with it as one group.
        assert!(!one_shape(&parent));

        let text = view(None, 12, ViewKind::Text, rect(0.0, 0.0, 16.0, 16.0));
        assert!(!one_shape(&text));
    }

    /// A target bitmap of `size` pixels and a way to read it back.
    fn target(gfx: &Gfx, size: (u32, u32)) -> ID2D1Bitmap1 {
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: size.0,
            height: size.1,
        };
        // SAFETY: a COM call on the live context.
        unsafe { gfx.dc.CreateBitmap(size, None, 0, &props) }.unwrap()
    }

    fn read(gfx: &Gfx, bitmap: &ID2D1Bitmap1, size: (u32, u32)) -> Vec<u8> {
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        // SAFETY: COM calls on live objects; the mapped rows are copied
        // before `Unmap`.
        unsafe {
            let read = gfx
                .dc
                .CreateBitmap(
                    D2D_SIZE_U {
                        width: size.0,
                        height: size.1,
                    },
                    None,
                    0,
                    &props,
                )
                .unwrap();
            read.CopyFromBitmap(None, bitmap, None).unwrap();
            let mapped = read.Map(D2D1_MAP_OPTIONS_READ).unwrap();
            let mut data = Vec::new();
            for row in 0..size.1 {
                let start = mapped.bits.add((row * mapped.pitch) as usize);
                data.extend_from_slice(std::slice::from_raw_parts(start, (size.0 * 4) as usize));
            }
            read.Unmap().unwrap();
            data
        }
    }

    #[test]
    fn a_partial_frame_draws_what_a_whole_one_does() {
        let Ok(gfx) = gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        let size = (240, 140);
        let surface = Surface::new(Default::default());
        surface.resized(size, 1.0);
        let root = surface.root.clone();
        let boxed = |id, frame, color| {
            let v = view(Some(&root), id, ViewKind::View, frame);
            v.state_mut().style.background_color = Color(color);
            v
        };
        let a = boxed(2, rect(10.0, 10.0, 50.0, 30.0), 0xcc2244ff);
        let b = boxed(4, rect(120.0, 20.0, 40.0, 40.0), 0x2244ccff);
        b.state_mut().style.shadow.opacity = 0.5;
        b.state_mut().style.shadow.radius = Points(6.0);
        let c = boxed(6, rect(180.0, 90.0, 30.0, 30.0), 0x22cc44ff);
        boxed(8, rect(0.0, 100.0, 240.0, 40.0), 0x88888888);
        let back = target(&gfx, size);
        let whole = |into: &ID2D1Bitmap1| {
            draw_into(&surface, &gfx, into, 1.0, false, None, None).unwrap();
        };
        whole(&back);
        assert!(surface.take_damage().is_none(), "the first frame is whole");

        // A move, a new color and a removal.
        a.state_mut().frame = rect(30.0, 70.0, 50.0, 30.0);
        a.moved();
        b.state_mut().style.background_color = Color(0xeeaa22ff);
        b.changed();
        c.unparent();
        let damage = surface.take_damage().expect("the changed views' areas");
        let areas: Vec<D2D_RECT_F> = merged(pixel_rects(&damage, 1.0, size))
            .iter()
            .map(|r| {
                rect_f(
                    r.left as f32,
                    r.top as f32,
                    (r.right - r.left) as f32,
                    (r.bottom - r.top) as f32,
                )
            })
            .collect();
        // Only around what changed: not the whole window.
        let covered: f32 = areas
            .iter()
            .map(|r| (r.right - r.left) * (r.bottom - r.top))
            .sum();
        assert!(covered < (size.0 * size.1) as f32 * 0.6, "{areas:?}");
        draw_into(&surface, &gfx, &back, 1.0, false, None, Some(&areas)).unwrap();

        let fresh = target(&gfx, size);
        whole(&fresh);
        assert!(read(&gfx, &back, size) == read(&gfx, &fresh, size));
        // Nothing changed since: nothing to draw.
        assert!(surface.take_damage().is_none_or(|d| d.is_empty()));
    }

    #[test]
    fn merged_areas_cost_no_more_than_apart() {
        let r = |l, t, w, h| RECT {
            left: l,
            top: t,
            right: l + w,
            bottom: t + h,
        };
        // Overlapping ones become one; distant ones stay apart.
        let m = merged(vec![r(0, 0, 10, 10), r(5, 5, 10, 10), r(100, 100, 5, 5)]);
        assert_eq!(m.len(), 2);
        assert!(m.contains(&r(0, 0, 15, 15)));
        // Never more than MAX_AREAS.
        let many: Vec<RECT> = (0..20).map(|i| r(i * 50, 0, 10, 10)).collect();
        assert!(merged(many).len() <= MAX_AREAS);
    }

    #[test]
    fn children_outside_the_visible_area_are_hidden() {
        let visible = rect_f(0.0, 0.0, 100.0, 100.0);
        let hidden = |v: &NshView, y: f32| hidden_by_clips(v, Mat4::new(), (0.0, y), &visible);
        let row = view(None, 2, ViewKind::View, rect(0.0, 0.0, 100.0, 40.0));
        assert!(!hidden(&row, 0.0));
        assert!(!hidden(&row, 80.0));
        // Below the visible area, and above it.
        assert!(hidden(&row, 120.0));
        assert!(hidden(&row, -60.0));
        // Its shadow reaches in.
        row.state_mut().style.shadow.opacity = 1.0;
        row.state_mut().style.shadow.radius = Points(30.0);
        assert!(!hidden(&row, 120.0));
        row.state_mut().style.shadow.opacity = 0.0;
        // A child sticking out of it reaches in.
        view(Some(&row), 4, ViewKind::View, rect(0.0, -50.0, 10.0, 10.0));
        assert!(!hidden(&row, 120.0));
        assert!(hidden(&row, 200.0));
        // A transform moves it in.
        let moved = view(None, 6, ViewKind::View, rect(0.0, 0.0, 100.0, 40.0));
        moved
            .state_mut()
            .style
            .transform
            .push(TransformKind::TranslateY, -150.0);
        assert!(!hidden(&moved, 200.0));
    }

    #[test]
    fn a_layer_covers_the_bounds_and_the_shadow() {
        let v = dot(None, 2);
        assert_eq!(area(&v), (-1.0, -1.0, 17.0, 17.0));
        // React Native's shadow: offset (0, -3), radius 3.
        v.state_mut().style.shadow.opacity = 1.0;
        assert_eq!(area(&v), (-13.0, -13.0, 29.0, 29.0));
    }

    #[test]
    fn a_layer_covers_what_the_children_draw() {
        let parent = view(None, 2, ViewKind::View, rect(0.0, 0.0, 100.0, 100.0));
        let a = view(
            Some(&parent),
            4,
            ViewKind::View,
            rect(80.0, 90.0, 40.0, 20.0),
        );
        let b = view(Some(&parent), 6, ViewKind::View, rect(0.0, 0.0, 10.0, 10.0));
        b.state_mut()
            .style
            .transform
            .push(TransformKind::TranslateX, -50.0);
        assert_eq!(area(&parent), (-51.0, -1.0, 121.0, 111.0));

        // Hidden children draw nothing.
        a.state_mut().style.hidden = true;
        assert_eq!(area(&parent), (-51.0, -1.0, 101.0, 101.0));

        // Clipped children stay inside.
        a.state_mut().style.hidden = false;
        parent.state_mut().style.overflow_hidden = true;
        assert_eq!(area(&parent), (-1.0, -1.0, 101.0, 101.0));
    }

    #[test]
    fn a_layer_is_unbounded_when_the_area_is_not_known() {
        let parent = view(None, 2, ViewKind::View, rect(0.0, 0.0, 100.0, 100.0));
        let child = view(Some(&parent), 4, ViewKind::View, rect(0.0, 0.0, 50.0, 50.0));
        {
            let mut s = child.state_mut();
            s.style.transform.push(TransformKind::Perspective, 300.0);
            s.style.transform.push(TransformKind::RotateY, 60.0);
        }
        assert!(drawn_area(&parent).is_none());
    }
}
