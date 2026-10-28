//! Resizable panels (`gpui-base`'s `resizable` module): a
//! [`ResizablePanelGroup`] of [`ResizablePanel`]s whose sizes the user
//! changes by dragging the handles between them, the standalone
//! [`ResizeHandle`] for anything else a drag resizes (a sidebar's edge, a
//! dock's), and [`ResizableState`], `gpui-base`'s sizing with no view in
//! it, which a drag follows.
//!
//! ```tsx
//! <ResizablePanelGroup axis="horizontal" handleClass="w-px bg-border group-active:bg-primary"
//!   onResize={({ sizes }) => save(sizes)}>
//!   <ResizablePanel size={sidebar()} minSize={160} maxSize={480} onResize={({ size }) => setSidebar(size)}>…</ResizablePanel>
//!   <ResizablePanel>…</ResizablePanel>
//! </ResizablePanelGroup>
//! ```
//!
//! ```ignore
//! h_resizable()
//!     .handle_class("w-px bg-border")
//!     .on_resize(|sizes: &Vec<Points>| save(sizes))
//!     .child(resizable_panel().size(px(240.0)).size_range(px(160.0)..px(480.0)).child(sidebar()))
//!     .child(resizable_panel().child(content()))
//! ```
//!
//! # How it works
//!
//! - **Panels tell the group about themselves.** The group provides a
//!   context (its model: the panels, their frames, the sizes a drag
//!   decided and the drag going on) that each `ResizablePanel` below it
//!   registers with as it is made, reports its props to (an effect:
//!   `size`, `minSize`, `maxSize`, `fixed`, `visible`) and its frame to
//!   (`on_layout`), and leaves when it goes. The panels are the group's
//!   direct children, so their frames are in the group's coordinates and
//!   give their order: the visible panels as they are laid out, left to
//!   right or top to bottom (those not laid out yet last), whatever order
//!   the app made them in (an `<If>` adding one in the middle) and in
//!   right-to-left layouts too.
//! - **What a panel wants, flexbox lays out.** A panel wants the size the
//!   user last dragged it to, else its `size` (a new `size` from the app
//!   replaces the user's); each panel's root binds its flex basis, grow and
//!   shrink and its minimum and maximum along the axis to a memo of the
//!   model, so a change restyles only the panels it moved. A panel with a
//!   size has it as its basis (within its range), does not grow and shrinks
//!   with the others while the group is too small for them (a `fixed` one
//!   does not shrink), back to its size once there is room again; the
//!   panels without one share the rest (basis 0, so their content does not
//!   skew the shares); when every panel has a size, they share what is
//!   left over in proportion (each grows by its basis). A group too short
//!   for its panels' `minSize`s together shares its length in proportion
//!   to them (each panel's minimum, for the layout and for drags, is cut
//!   by the same ratio), so the panels never overflow it. The group's size
//!   is never written into what a panel wants, and a panel shown again
//!   comes back at the size it wanted. Nothing of this reports `onResize`.
//! - **Handles are the group's.** One per boundary between two visible
//!   panels, each an absolutely placed band over the boundary (9 points
//!   thick, the boundary's line in its middle; on touch screens its hit
//!   slop adds 10 points on either side), with the resize cursor and the
//!   role `adjustable`, a `group` whose child, the indicator, is the app's
//!   (`handleClass`, `handleStyle`; its `group-hover:` / `group-active:`
//!   classes follow the band's hover and press), and so is what is in it
//!   (`renderHandle`, a render prop keyed by the handle's index, told its
//!   [`ResizeHandleContext`]: drawn again when the handle's
//!   [`ResizeHandleState`] changes, a few times per drag, never per move).
//!   Their positions come from the sizes a drag or a step decided (and the
//!   gaps the panels' frames show) until the panels are laid out at them,
//!   a frame later, and from the frames otherwise.
//! - **Drags run in the core.** A band claims the touches that go down on
//!   it (the core's touch responder, `claim_touches` on start, kept against
//!   the scroll views around it): on the desktops the mouse's drags are
//!   touches too. Each move gives the gesture's offset along the axis since
//!   the press, and the group resizes the panel before the handle to its
//!   size at the press plus that offset
//!   (`ResizableState::resize_panel_at_handle`: growing takes from the
//!   panels after the handle, nearest first, as far as their minimums let
//!   it, passing over fixed ones; shrinking below its minimum takes from
//!   the panels before it; the total never exceeds the group), on a state
//!   made from the panels' sizes as the drag starts; the panels it resizes
//!   want their new sizes from then on (the one panel without a size, when
//!   there is one, keeps none: it takes the rest, which is what the drag
//!   gives it). Nothing reaches JS
//!   until the drag ends: then the group reports every visible panel's
//!   size (`onResize({ sizes })`), and each panel whose size changed its own
//!   (`onResize({ size })`), which the app passes back as `size` to keep (a
//!   group made again starts from it). Without that, the group keeps the
//!   sizes the user gave the panels while it lives.
//! - **[`ResizeHandle`]** is the same band on its own, for a container's
//!   edge ([`HandleEdge`]: hugging it from inside, as a clipping dock frame
//!   needs) or straddling its leading edge. It reports the drag
//!   (`onDragStart`, `onDragMove(offset)`, `onDragEnd(offset)`) and its
//!   [`ResizeHandleState`] (`onStateChange`), and the caller resizes what it
//!   edges. It is for Rust (the dock's edges); TSX's panels are the group's.
//!
//! **Screen readers** adjust a group's handles: each is `adjustable`
//! with the `increment` and `decrement` actions (VoiceOver's swipe up and
//! down, TalkBack's volume keys), which move it 10 points as a whole drag
//! would (reported with `onResize`; nothing while `disabled`), and its
//! value is the size of the panel before it in that panel's range
//! (`accessibilityValue`'s `now`, `min`, `max`). **Keyboards** do not move
//! them: the core reports keys only to inputs (`onKeyPress`) and the
//! surface's bindings (`on_key`, whatever has the focus), and no event
//! says that a view other than an input took the focus, so a handle cannot
//! tell that the arrow keys are meant for it.

mod panel;
mod resize_handle;
mod state;

use std::ops::Range;

use nsh_core::geometry::{Axis, Points};
pub use panel::{
    ResizablePanel, ResizablePanelElement, ResizablePanelEvent, ResizablePanelGroup,
    ResizablePanelGroupElement, ResizablePanelGroupEvent, ResizablePanelGroupProps,
    ResizablePanelProps, resizable_panel, resizable_panel_group,
};
/// The line a handle's band is centered on, 1 point: the indicator's
/// default thickness, for the dock's edge handles too.
pub(crate) use resize_handle::HANDLE_SIZE;
pub use resize_handle::{
    HandleEdge, ResizeHandle, ResizeHandleContext, ResizeHandleElement, ResizeHandleEvent,
    ResizeHandleProps, ResizeHandleState, resize_handle,
};
pub use state::{PANEL_MAX_SIZE, PANEL_MIN_SIZE, ResizableState};

/// A [`ResizablePanelGroup`] of panels side by side, resized left and
/// right (`gpui-base`'s `h_resizable`).
pub fn h_resizable() -> ResizablePanelGroupElement {
    resizable_panel_group().axis(Axis::Horizontal)
}

/// A [`ResizablePanelGroup`] of panels stacked, resized up and down
/// (`gpui-base`'s `v_resizable`).
pub fn v_resizable() -> ResizablePanelGroupElement {
    resizable_panel_group().axis(Axis::Vertical)
}

impl ResizablePanelElement {
    /// The sizes it may take (`gpui-base`'s `size_range`): `minSize` and
    /// `maxSize` at once.
    pub fn size_range(self, range: Range<Points>) -> Self {
        let max = (range.end < PANEL_MAX_SIZE).then_some(range.end);
        self.min_size(range.start).max_size(max)
    }
}
