//! Window composition: web views between the content nsh draws below them
//! and the content it draws above them.
//!
//! A window without web views draws its whole tree into its flip-model
//! swap chain ([`crate::render::frame`]) and has no composition at all.
//! The first web view of a surface makes its [`Composition`]: a
//! DirectComposition target on the window, above the window's own swap
//! chain, whose root holds, bottom to top, each web view's visual
//! ([`Portal`], the WebView2 controller's root visual target) and after
//! each of them a layer ([`Layer`]: a composition swap chain the size of
//! the window, premultiplied alpha) with what nsh draws after that web
//! view in paint order:
//!
//! ```text
//! top     layer 1       later siblings, modals, dialogs, the dev overlay
//!         web view 1
//!         layer 0       what is painted between the two web views
//!         web view 0
//! bottom  swap chain    everything painted before the first web view
//! ```
//!
//! The tree is still drawn once per frame, in one pass: when the pass
//! reaches a web view it records where the view goes ([`Placement`]) and
//! the next thing it draws switches the context to the next layer
//! ([`crate::render::DrawCx::realize`]). A layer nothing is drawn into is
//! neither drawn, presented nor shown. The web views' visuals are clipped
//! to their clipping ancestors (window pixels) and their own rounded
//! corners, transformed like their views (any affine transform) and faded
//! with their opacity; the root is arranged again only when the order of
//! its visuals changed, and the whole change is one `Commit`.
//!
//! The layers' swap chains are made on the thread's Direct3D device and
//! made again after it is lost ([`crate::gfx::generation`]); the
//! DirectComposition device has no rendering device of its own (no
//! DirectComposition surfaces are used), so it survives a device loss.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use windows::{
    Win32::{
        Foundation::HWND,
        Graphics::{
            Direct2D::{Common::D2D_RECT_F, ID2D1Bitmap1},
            DirectComposition::{
                DCompositionCreateDevice2, IDCompositionDesktopDevice, IDCompositionRectangleClip,
                IDCompositionTarget, IDCompositionVisual, IDCompositionVisual2,
                IDCompositionVisual3,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN,
                    DXGI_SAMPLE_DESC,
                },
                CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT, DXGI_SCALING_STRETCH,
                DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIFactory2, IDXGISurface, IDXGISwapChain1,
            },
        },
    },
    core::{Interface, Result},
};
use windows_numerics::Matrix3x2;

use crate::gfx::{self, Gfx};

/// Where a frame put a web view: what its visuals are set to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Placement {
    /// The web view's pixels (its own coordinates times the window's
    /// scale) to window pixels.
    pub(crate) matrix: Matrix3x2,
    /// Its size in pixels.
    pub(crate) size: (i32, i32),
    /// What its clipping ancestors leave visible (window pixels).
    pub(crate) clip: D2D_RECT_F,
    /// Its own corner radii in pixels (clockwise from the top left) when
    /// it clips its content, else zeros.
    pub(crate) radii: [f32; 4],
    /// The opacity it is drawn with (its own and its ancestors').
    pub(crate) alpha: f32,
}

impl Placement {
    /// Its window rectangle (pixels) when it is only translated, as
    /// WebView2's bounds (pop-ups and the IME are placed from them).
    pub(crate) fn bounds(&self) -> windows::Win32::Foundation::RECT {
        let left = self.matrix.M31.round() as i32;
        let top = self.matrix.M32.round() as i32;
        windows::Win32::Foundation::RECT {
            left,
            top,
            right: left + self.size.0,
            bottom: top + self.size.1,
        }
    }
}

/// The DirectComposition tree of one surface's window. Made with its first
/// web view, gone with its last (each [`Portal`] holds it).
pub(crate) struct Composition {
    device: IDCompositionDesktopDevice,
    _target: IDCompositionTarget,
    root: IDCompositionVisual2,
    /// The layers made so far: layer `i` holds what is drawn after the
    /// `i`-th web view that something is drawn after.
    layers: RefCell<Vec<Layer>>,
    /// The root's visuals as last arranged, bottom to top.
    order: RefCell<Vec<IDCompositionVisual2>>,
    /// A transparent window's swap chain, below everything else
    /// ([`Composition::set_base`]).
    base: RefCell<Option<IDCompositionVisual2>>,
}

/// What nsh draws above a web view: a composition swap chain the size of
/// the window.
struct Layer {
    visual: IDCompositionVisual2,
    swap: Option<IDXGISwapChain1>,
    target: Option<ID2D1Bitmap1>,
    /// The scale of `target` (its DPI).
    scale: f32,
    /// Size in pixels.
    size: (u32, u32),
    /// The device generation `swap` was made in.
    generation: u64,
}

impl Composition {
    /// A composition for `hwnd` (above its swap chain, below its child
    /// windows).
    pub(crate) fn new(hwnd: HWND) -> Result<Rc<Composition>> {
        // SAFETY: plain DirectComposition calls on objects made here; no
        // rendering device (only swap chains are composed).
        unsafe {
            let device: IDCompositionDesktopDevice = DCompositionCreateDevice2(None)?;
            let target = device.CreateTargetForHwnd(hwnd, false)?;
            let root = device.CreateVisual()?;
            target.SetRoot(&root)?;
            device.Commit()?;
            Ok(Rc::new(Composition {
                device,
                _target: target,
                root,
                layers: RefCell::default(),
                order: RefCell::default(),
                base: RefCell::default(),
            }))
        }
    }

    /// The bitmap layer `index` is drawn into this frame (made, resized or
    /// made again as needed), at `size` pixels and `scale`.
    pub(crate) fn layer_target(
        &self,
        gfx: &Gfx,
        index: usize,
        size: (u32, u32),
        scale: f32,
    ) -> Result<ID2D1Bitmap1> {
        let mut layers = self.layers.borrow_mut();
        while layers.len() <= index {
            // SAFETY: a plain call on the live device.
            let visual = unsafe { self.device.CreateVisual()? };
            layers.push(Layer {
                visual,
                swap: None,
                target: None,
                scale: 0.0,
                size: (0, 0),
                generation: 0,
            });
        }
        let layer = &mut layers[index];
        let size = (size.0.max(1), size.1.max(1));
        if layer.generation != gfx::generation() {
            layer.target = None;
            layer.swap = None;
        }
        if layer.swap.is_none() {
            let swap = composition_swap_chain(gfx, size, DXGI_SWAP_CHAIN_FLAG(0))?;
            // SAFETY: plain calls on live objects of this thread.
            unsafe { layer.visual.SetContent(&swap)? };
            layer.swap = Some(swap);
            layer.size = size;
            layer.generation = gfx::generation();
        }
        let Some(swap) = layer.swap.clone() else {
            unreachable!("made above")
        };
        if layer.size != size {
            layer.target = None;
            // SAFETY: the layer's buffers are not referenced anymore (its
            // target bitmap is dropped, and the device context draws into
            // another target).
            unsafe {
                swap.ResizeBuffers(
                    0,
                    size.0,
                    size.1,
                    DXGI_FORMAT_UNKNOWN,
                    DXGI_SWAP_CHAIN_FLAG(0),
                )?
            };
            layer.size = size;
        }
        if (layer.scale - scale).abs() > f32::EPSILON {
            layer.target = None;
            layer.scale = scale;
        }
        if let Some(t) = &layer.target {
            return Ok(t.clone());
        }
        // SAFETY: COM calls on live objects; buffer 0 exists.
        let bitmap = unsafe {
            let surface: IDXGISurface = swap.GetBuffer(0)?;
            gfx.dc
                .CreateBitmapFromDxgiSurface(&surface, Some(&gfx::target_properties(scale, true)))?
        };
        layer.target = Some(bitmap.clone());
        Ok(bitmap)
    }

    /// Shows what was drawn into the first `used` layers.
    pub(crate) fn present(&self, used: usize) -> Result<()> {
        for layer in self.layers.borrow().iter().take(used) {
            if let Some(swap) = &layer.swap {
                // Not synchronized: the window's own swap chain paces the
                // frames of all of them (`gfx::SwapChain::ready`).
                // SAFETY: a COM call on a live swap chain.
                unsafe { swap.Present(0, DXGI_PRESENT(0)).ok()? };
            }
        }
        Ok(())
    }

    /// Stacks the web views' visuals (bottom to top) with the layers drawn
    /// this frame: `layers[i]` is how many web views are below layer `i`.
    /// Commits the frame's changes (the visuals' placements too).
    pub(crate) fn arrange(&self, portals: &[IDCompositionVisual2], layers: &[usize]) {
        let order: Vec<IDCompositionVisual2> = {
            let made = self.layers.borrow();
            let mut out = Vec::with_capacity(portals.len() + layers.len());
            let mut next = 0;
            for (i, portal) in portals.iter().enumerate() {
                out.push(portal.clone());
                while next < layers.len() && layers[next] <= i + 1 {
                    if let Some(l) = made.get(next) {
                        out.push(l.visual.clone());
                    }
                    next += 1;
                }
            }
            // Layers above web views that were dropped (in a subtree drawn
            // with perspective) go on top.
            out.extend(
                made.iter()
                    .take(layers.len())
                    .skip(next)
                    .map(|l| l.visual.clone()),
            );
            out
        };
        let same = {
            let old = self.order.borrow();
            old.len() == order.len()
                && old
                    .iter()
                    .zip(&order)
                    .all(|(a, b)| a.as_raw() == b.as_raw())
        };
        // SAFETY: plain calls on the live tree, on its thread.
        unsafe {
            if !same {
                let _ = self.root.RemoveAllVisuals();
                let base = self.base.borrow();
                let mut below: Option<&IDCompositionVisual> = None;
                if let Some(base) = &*base {
                    let _ = self.root.AddVisual(base, true, None);
                    below = Some(base);
                }
                for visual in &order {
                    // Above the one added before it: with no reference,
                    // `insertAbove` puts a visual below all its siblings.
                    let _ = self.root.AddVisual(visual, true, below);
                    below = Some(visual);
                }
                *self.order.borrow_mut() = order;
            }
            if let Err(err) = self.device.Commit() {
                log::warn!("compose: commit failed: {err}");
            }
        }
    }

    /// Shows `swap` (a transparent window's own swap chain, made again
    /// after a device loss) at the bottom of the tree, below the web views
    /// and their layers.
    pub(crate) fn set_base(&self, swap: &IDXGISwapChain1) -> Result<()> {
        let mut base = self.base.borrow_mut();
        // SAFETY: plain calls on the live device and tree, on its thread.
        unsafe {
            let visual = match &*base {
                Some(v) => v.clone(),
                None => {
                    let v = self.device.CreateVisual()?;
                    // With no reference, `insertAbove` puts it below all
                    // its siblings.
                    self.root.AddVisual(&v, true, None)?;
                    *base = Some(v.clone());
                    v
                }
            };
            visual.SetContent(swap)?;
            self.device.Commit()
        }
    }

    /// A swap chain is shown at the bottom ([`Composition::set_base`]).
    #[cfg(test)]
    pub(crate) fn has_base(&self) -> bool {
        self.base.borrow().is_some()
    }

    /// Drops what lives on the lost device (the layers' swap chains).
    pub(crate) fn device_lost(&self) {
        for layer in self.layers.borrow_mut().iter_mut() {
            layer.target = None;
            layer.swap = None;
            // SAFETY: a plain call on a live visual.
            let _ = unsafe { layer.visual.SetContent(None) };
        }
    }
}

/// A swap chain for composition of `size` pixels, premultiplied, made with
/// `flags` (a window's base: [`gfx::SWAP_CHAIN_FLAGS`], paced; a layer's:
/// none, presented with the base).
pub(crate) fn composition_swap_chain(
    gfx: &Gfx,
    size: (u32, u32),
    flags: DXGI_SWAP_CHAIN_FLAG,
) -> Result<IDXGISwapChain1> {
    // SAFETY: plain factory creation.
    let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))? };
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: size.0,
        Height: size.1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        Stereo: false.into(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        Flags: flags.0 as u32,
    };
    // SAFETY: a valid description on the live device.
    unsafe { factory.CreateSwapChainForComposition(&gfx.d3d, &desc, None) }
}

/// A web view's visuals: an outer one with its ancestors' clip (window
/// pixels) and its opacity, holding an inner one with its transform and
/// rounded corners, which WebView2 draws the page into.
pub(crate) struct Portal {
    /// Kept while the web view lives: the window composes while it has one.
    _composition: Rc<Composition>,
    outer: IDCompositionVisual2,
    inner: IDCompositionVisual2,
    corners: IDCompositionRectangleClip,
    /// What was applied last.
    applied: Cell<Option<Placement>>,
}

impl Portal {
    /// Visuals in `composition` for a web view.
    pub(crate) fn new(composition: Rc<Composition>) -> Result<Portal> {
        // SAFETY: plain calls on the live device and the visuals made here.
        unsafe {
            let device = &composition.device;
            let outer = device.CreateVisual()?;
            let inner = device.CreateVisual()?;
            let corners = device.CreateRectangleClip()?;
            inner.SetClip(&corners)?;
            outer.AddVisual(&inner, true, None)?;
            Ok(Portal {
                outer,
                inner,
                corners,
                applied: Cell::new(None),
                _composition: composition,
            })
        }
    }

    /// The visual WebView2 draws into (its root visual target).
    pub(crate) fn target(&self) -> &IDCompositionVisual2 {
        &self.inner
    }

    /// The visual the composition stacks.
    pub(crate) fn visual(&self) -> &IDCompositionVisual2 {
        &self.outer
    }

    /// Puts the visuals at `p` (committed by [`Composition::arrange`]).
    pub(crate) fn place(&self, p: &Placement) {
        if self.applied.replace(Some(*p)) == Some(*p) {
            return;
        }
        let (w, h) = (p.size.0 as f32, p.size.1 as f32);
        // SAFETY: plain calls on the live visuals, on their thread.
        unsafe {
            let _ = self.inner.SetTransform2(&p.matrix);
            let c = &self.corners;
            let _ = c.SetLeft2(0.0);
            let _ = c.SetTop2(0.0);
            let _ = c.SetRight2(w);
            let _ = c.SetBottom2(h);
            let [tl, tr, br, bl] = p.radii;
            let _ = c.SetTopLeftRadiusX2(tl);
            let _ = c.SetTopLeftRadiusY2(tl);
            let _ = c.SetTopRightRadiusX2(tr);
            let _ = c.SetTopRightRadiusY2(tr);
            let _ = c.SetBottomRightRadiusX2(br);
            let _ = c.SetBottomRightRadiusY2(br);
            let _ = c.SetBottomLeftRadiusX2(bl);
            let _ = c.SetBottomLeftRadiusY2(bl);
            let _ = self.outer.SetClip2(&p.clip);
            if let Ok(v) = self.outer.cast::<IDCompositionVisual3>() {
                let _ = v.SetOpacity2(p.alpha.clamp(0.0, 1.0));
            }
        }
    }

    /// The web view was not drawn: its visual is out of the tree until it
    /// is drawn again (the next arrangement leaves it out).
    pub(crate) fn hidden(&self) {
        self.applied.set(None);
    }
}

/// The intersection of two rectangles (empty ones have `right <= left`).
pub(crate) fn intersect(a: D2D_RECT_F, b: D2D_RECT_F) -> D2D_RECT_F {
    D2D_RECT_F {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    }
}

/// True when `r` covers no pixel.
pub(crate) fn is_empty(r: &D2D_RECT_F) -> bool {
    r.right <= r.left || r.bottom <= r.top
}

/// The bounds of `r` mapped by `m`.
pub(crate) fn map_bounds(m: &Matrix3x2, r: &D2D_RECT_F) -> D2D_RECT_F {
    let corners = [
        (r.left, r.top),
        (r.right, r.top),
        (r.right, r.bottom),
        (r.left, r.bottom),
    ];
    let mut out = D2D_RECT_F {
        left: f32::MAX,
        top: f32::MAX,
        right: f32::MIN,
        bottom: f32::MIN,
    };
    for (x, y) in corners {
        let px = x * m.M11 + y * m.M21 + m.M31;
        let py = x * m.M12 + y * m.M22 + m.M32;
        out.left = out.left.min(px);
        out.top = out.top.min(py);
        out.right = out.right.max(px);
        out.bottom = out.bottom.max(py);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: f32, top: f32, right: f32, bottom: f32) -> D2D_RECT_F {
        D2D_RECT_F {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn maps_and_intersects_rects() {
        let m = Matrix3x2 {
            M11: 0.0,
            M12: 1.0,
            M21: -1.0,
            M22: 0.0,
            M31: 10.0,
            M32: 0.0,
        };
        // A quarter turn, then 10 to the right.
        assert_eq!(
            map_bounds(&m, &r(0.0, 0.0, 4.0, 2.0)),
            r(8.0, 0.0, 10.0, 4.0)
        );
        assert_eq!(
            intersect(r(0.0, 0.0, 10.0, 10.0), r(5.0, 5.0, 20.0, 20.0)),
            r(5.0, 5.0, 10.0, 10.0)
        );
        assert!(is_empty(&intersect(
            r(0.0, 0.0, 10.0, 10.0),
            r(10.0, 0.0, 20.0, 10.0)
        )));
    }

    #[test]
    fn places_bounds_at_the_translation() {
        let p = Placement {
            matrix: Matrix3x2::translation(10.4, 20.6),
            size: (100, 50),
            clip: r(0.0, 0.0, 1.0, 1.0),
            radii: [0.0; 4],
            alpha: 1.0,
        };
        let b = p.bounds();
        assert_eq!((b.left, b.top, b.right, b.bottom), (10, 21, 110, 71));
    }
}
