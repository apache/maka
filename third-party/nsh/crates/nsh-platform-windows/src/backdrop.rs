//! `windows={{ backdrop }}`: the system's blur of what is behind a
//! see-through window, under each view that asks for it, on Windows 11 and
//! later.
//!
//! The blur is a host backdrop brush, a `Windows.UI.Composition` object,
//! which cannot go into nsh's DirectComposition tree. A window has two
//! composition slots, below its child windows and above them, each with one
//! target, and nsh's tree takes the lower one ([`crate::compose`]). While a
//! window shows backdrop views, nsh's target moves to the upper slot and a
//! `Windows.UI.Composition` target in the lower one holds a sprite of the
//! brush per view, under everything nsh draws, placed each frame where the
//! frame drew the view ([`crate::compose::Composition::backdrops_placed`]).

use std::cell::RefCell;

use windows::{
    System::DispatcherQueueController,
    UI::Composition::{
        CompositionBackdropBrush, CompositionRoundedRectangleGeometry, Compositor, ContainerVisual,
        Desktop::DesktopWindowTarget, InsetClip, SpriteVisual,
    },
    Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DWMWA_USE_HOSTBACKDROPBRUSH, DwmSetWindowAttribute},
        System::WinRT::{
            Composition::ICompositorDesktopInterop, CreateDispatcherQueueController,
            DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
        },
    },
    core::{BOOL, Interface, Result},
};
use windows_numerics::{Matrix4x4, Vector2};

use crate::compose::Placement;

/// The first build of Windows 11, the first to give a window's own
/// composition a host backdrop brush (`DWMWA_USE_HOSTBACKDROPBRUSH`).
const FIRST_BUILD: u32 = 22000;

thread_local! {
    /// This thread's compositor, and the dispatcher queue it runs on (none
    /// when the thread had one already), made with the first backdrop.
    static COMPOSITOR: RefCell<Option<(Compositor, Option<DispatcherQueueController>)>> =
        const { RefCell::new(None) };
}

/// True where a window can show the blur: Windows 11 and later.
pub(crate) fn supported() -> bool {
    crate::system::os_build() >= FIRST_BUILD
}

/// Closes the thread's compositor: every later call on its objects fails.
#[cfg(test)]
pub(crate) fn close_compositor() {
    COMPOSITOR.with(|cell| {
        if let Some((compositor, _)) = &*cell.borrow() {
            compositor.Close().unwrap();
        }
    });
}

/// The thread's compositor, made as needed.
fn compositor() -> Result<Compositor> {
    COMPOSITOR.with(|cell| {
        if let Some((compositor, _)) = &*cell.borrow() {
            return Ok(compositor.clone());
        }
        let options = DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_NONE,
        };
        // A thread that has a queue already keeps it (this call then fails).
        // SAFETY: valid options; the controller is kept for the thread's life.
        let queue = unsafe { CreateDispatcherQueueController(options) }.ok();
        let compositor = Compositor::new()?;
        *cell.borrow_mut() = Some((compositor.clone(), queue));
        Ok(compositor)
    })
}

/// The blur under one window's backdrop views: a target in the window's
/// lower slot, and a sprite of the brush per view.
pub(crate) struct Backdrops {
    hwnd: HWND,
    compositor: Compositor,
    target: DesktopWindowTarget,
    root: ContainerVisual,
    brush: CompositionBackdropBrush,
    /// The sprites, in the order of the views a frame drew.
    sprites: Vec<Sprite>,
}

/// One view's blur: an outer visual clipped to what the view's ancestors
/// leave visible, holding the brush's sprite with the view's transform and
/// rounded corners.
struct Sprite {
    outer: ContainerVisual,
    clip: InsetClip,
    sprite: SpriteVisual,
    corners: CompositionRoundedRectangleGeometry,
    /// What was applied last.
    applied: Option<Placement>,
}

impl Backdrops {
    /// The blur for `hwnd`, whose lower slot must be free.
    pub(crate) fn new(hwnd: HWND) -> Result<Backdrops> {
        let compositor = compositor()?;
        let root = compositor.CreateContainerVisual()?;
        let brush = compositor.CreateHostBackdropBrush()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        // SAFETY: a live window of this thread.
        let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };
        // From here on, `Drop` closes the target and turns the attribute off.
        let backdrops = Backdrops {
            hwnd,
            compositor,
            target,
            root,
            brush,
            sprites: Vec::new(),
        };
        let enable = BOOL::from(true);
        // SAFETY: a BOOL for this attribute, on a live window of this thread.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_HOSTBACKDROPBRUSH,
                (&raw const enable).cast(),
                std::mem::size_of::<BOOL>() as u32,
            )?;
        }
        backdrops.target.SetRoot(&backdrops.root)?;
        Ok(backdrops)
    }

    /// Shows the blur at each of `at` (where a frame drew the backdrop
    /// views, in paint order), making or dropping sprites as needed.
    pub(crate) fn place(&mut self, at: &[Placement]) -> Result<()> {
        if self.sprites.len() > at.len() {
            let children = self.root.Children()?;
            while self.sprites.len() > at.len() {
                if let Some(s) = self.sprites.pop() {
                    children.Remove(&s.outer)?;
                }
            }
        }
        while self.sprites.len() < at.len() {
            let c = &self.compositor;
            let outer = c.CreateContainerVisual()?;
            let clip = c.CreateInsetClip()?;
            outer.SetClip(&clip)?;
            let sprite = c.CreateSpriteVisual()?;
            sprite.SetBrush(&self.brush)?;
            let corners = c.CreateRoundedRectangleGeometry()?;
            sprite.SetClip(&c.CreateGeometricClipWithGeometry(&corners)?)?;
            outer.Children()?.InsertAtTop(&sprite)?;
            self.root.Children()?.InsertAtTop(&outer)?;
            self.sprites.push(Sprite {
                outer,
                clip,
                sprite,
                corners,
                applied: None,
            });
        }
        for (s, p) in self.sprites.iter_mut().zip(at) {
            if s.applied == Some(*p) {
                continue;
            }
            s.applied = None;
            // The ancestors' clip, window pixels: the outer visual spans
            // from the window's corner to the clip's far corner.
            s.outer.SetSize(Vector2 {
                X: p.clip.right,
                Y: p.clip.bottom,
            })?;
            s.clip.SetLeftInset(p.clip.left)?;
            s.clip.SetTopInset(p.clip.top)?;
            s.outer.SetOpacity(p.alpha.clamp(0.0, 1.0))?;
            let m = p.matrix;
            s.sprite.SetTransformMatrix(Matrix4x4 {
                M11: m.M11,
                M12: m.M12,
                M13: 0.0,
                M14: 0.0,
                M21: m.M21,
                M22: m.M22,
                M23: 0.0,
                M24: 0.0,
                M31: 0.0,
                M32: 0.0,
                M33: 1.0,
                M34: 0.0,
                M41: m.M31,
                M42: m.M32,
                M43: 0.0,
                M44: 1.0,
            })?;
            let size = Vector2 {
                X: p.size.0 as f32,
                Y: p.size.1 as f32,
            };
            s.sprite.SetSize(size)?;
            s.corners.SetSize(size)?;
            // The geometry has one radius: the largest, so that the blur
            // never shows past a rounder corner of the view.
            let r = p.radii.into_iter().fold(0.0, f32::max);
            s.corners.SetCornerRadius(Vector2 { X: r, Y: r })?;
            s.applied = Some(*p);
        }
        Ok(())
    }
}

impl Drop for Backdrops {
    fn drop(&mut self) {
        // Frees the window's lower slot now, for nsh's own target.
        let _ = self.target.Close();
        let disable = BOOL::from(false);
        // SAFETY: a BOOL for this attribute; a window already gone fails harmlessly.
        let _ = unsafe {
            DwmSetWindowAttribute(
                self.hwnd,
                DWMWA_USE_HOSTBACKDROPBRUSH,
                (&raw const disable).cast(),
                std::mem::size_of::<BOOL>() as u32,
            )
        };
    }
}
