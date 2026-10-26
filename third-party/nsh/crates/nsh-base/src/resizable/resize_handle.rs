//! [`ResizeHandle`]: a band that resizes whatever it edges when it is
//! dragged, with no look of its own; the band of a
//! [`super::ResizablePanelGroup`]'s handles too.

use nsh_core::{
    Cursor,
    element::Style,
    geometry::{Along, Axis, Edges, radians},
    prelude::*,
};

/// How far a handle's band reaches on either side of the line it is
/// centered on (`gpui-base`'s `HANDLE_PADDING`).
pub(crate) const HANDLE_PADDING: Points = px(4.0);
/// The line a band is centered on (`gpui-base`'s `HANDLE_SIZE`): the
/// pixel the app's indicator is usually drawn on.
pub(crate) const HANDLE_SIZE: Points = px(1.0);
/// How much further than its band a finger may press a handle on touch
/// screens, on either side across it: about a fingertip in all.
const TOUCH_SLOP: Points = px(10.0);

/// How far the pointer has gone with a resize handle (`gpui-base`'s
/// `ResizeHandleState`): idle, hovered, pressed, then dragged. A drag
/// takes the pointer off the band within a pixel or two, so hovering
/// cannot stand for dragging: the handle follows its progression itself
/// and reports it (`onStateChange`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ResizeHandleState {
    /// The pointer is somewhere else.
    #[default]
    Idle,
    /// The pointer is over the band.
    Hovered,
    /// The pointer went down on the handle and has not moved since.
    Pressed,
    /// The handle is being dragged.
    Dragging,
}

impl ResizeHandleState {
    /// Whether the pointer owns the handle: pressed on it, or dragging it.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pressed | Self::Dragging)
    }
}

/// What a handle's renderer is told about the handle it draws
/// (`gpui-base`'s `ResizeHandleContext`; a `ResizablePanelGroup`'s
/// `renderHandle`): which it is, its axis and how far the pointer has gone
/// with it. The band, the cursor and the drag stay the handle's; the
/// renderer only draws what is in it.
#[derive(Debug, Clone, PartialEq, JsObject)]
#[non_exhaustive]
pub struct ResizeHandleContext {
    /// Its place among the group's handles: the boundary after the
    /// `index`th visible panel.
    pub index: u32,
    /// The axis it resizes along.
    pub axis: Axis,
    /// How far the pointer has gone with it.
    pub state: ResizeHandleState,
}

impl Default for ResizeHandleContext {
    fn default() -> Self {
        Self {
            index: 0,
            axis: Axis::Horizontal,
            state: ResizeHandleState::Idle,
        }
    }
}

impl ResizeHandleContext {
    /// Whether the pointer owns the handle: pressed on it, or dragging it.
    pub fn is_active(&self) -> bool {
        self.state.is_active()
    }
}

/// Which edge of its container a handle hugs (`gpui-base`'s
/// `HandleEdge`). A handle that names none straddles the boundary it
/// resizes, half its band on either side, which is what a divider between
/// two panels wants; a container that clips its children (a dock's
/// frame) would cut the outer half off, so a handle on such a
/// container's own edge names it, and its whole band goes inside, the
/// line it is drawn on the container's outermost pixel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum HandleEdge {
    /// Where the axis starts: the left edge of a horizontal handle's
    /// container, the top edge of a vertical one's.
    Leading,
    /// Where the axis ends: the right or bottom edge.
    Trailing,
}

/// What a band reports of a drag: its start, the pointer's offset since
/// along the band's axis, and its end with the last offset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Drag {
    Start,
    Move(Points),
    End(Points),
}

/// The band of a handle along `axis`: a view as thick as the hit area
/// (`edge`'s, or a straddling one's), with the resize cursor, claiming
/// the touches that go down on it (a larger area on touch screens) and
/// following them in the core with the touch responder, reporting the
/// drag to `drag` and its progression to `state`. It is a `group`, so
/// the app's indicator inside it follows it with `group-hover:` and
/// `group-active:` classes. Its children, centered on the line (at the
/// edge's side when it hugs one), are the app's; where it goes in its
/// container is the caller's.
pub(crate) fn band(
    axis: Axis,
    edge: Option<HandleEdge>,
    disabled: Prop<bool>,
    state: Signal<ResizeHandleState>,
    drag: impl Fn(Drag) + 'static,
) -> View {
    let extent = match edge {
        Some(_) => HANDLE_SIZE + HANDLE_PADDING,
        None => HANDLE_SIZE + HANDLE_PADDING * 2.0,
    };
    let drag = std::rc::Rc::new(drag);
    let offset = move |e: &ResponderEvent| e.gesture.delta.along(axis);
    let set = move |next: ResizeHandleState| {
        if state.get_untracked() != next {
            state.set(next);
        }
    };
    let finish = {
        let drag = drag.clone();
        move |e: &ResponderEvent| {
            let active = state.get_untracked().is_active();
            set(ResizeHandleState::Idle);
            if active {
                drag(Drag::End(offset(e)));
            }
        }
    };
    let band = view()
        .group()
        .role(AccessibilityRole::Adjustable)
        .map(|v| match axis {
            Axis::Horizontal => v.flex_row().w(extent).cursor(Cursor::ColResize),
            Axis::Vertical => v.flex_col().h(extent).cursor(Cursor::RowResize),
        })
        .map(|v| match edge {
            None => v.justify_center(),
            Some(HandleEdge::Leading) => v.justify_start(),
            Some(HandleEdge::Trailing) => v.justify_end(),
        })
        .style_when(disabled, |s| s.cursor(Cursor::Default))
        .when(!is_desktop(), |v| {
            let slop = match axis {
                Axis::Horizontal => Edges {
                    left: TOUCH_SLOP,
                    right: TOUCH_SLOP,
                    ..Edges::default()
                },
                Axis::Vertical => Edges {
                    top: TOUCH_SLOP,
                    bottom: TOUCH_SLOP,
                    ..Edges::default()
                },
            };
            v.hit_slop(slop)
        })
        .on_hover_in(move || {
            if state.get_untracked() == ResizeHandleState::Idle {
                set(ResizeHandleState::Hovered);
            }
        })
        .on_hover_out(move || {
            if state.get_untracked() == ResizeHandleState::Hovered {
                set(ResizeHandleState::Idle);
            }
        })
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !disabled.get_untracked() {
                request.claim();
            }
        }))
        // A scroll view around it does not take the drag over.
        .keep_touches(true);
    let started = drag.clone();
    let moved = drag;
    band.on_responder_grant(move |_: &ResponderEvent| {
        set(ResizeHandleState::Pressed);
        started(Drag::Start);
    })
    .on_responder_move(move |e: &ResponderEvent| {
        let by = offset(e);
        if state.get_untracked() == ResizeHandleState::Pressed && by != Points::ZERO {
            set(ResizeHandleState::Dragging);
        }
        if state.get_untracked() == ResizeHandleState::Dragging {
            moved(Drag::Move(by));
        }
    })
    .on_responder_release(finish.clone())
    .on_responder_terminate(finish)
}

/// The props of [`ResizeHandle`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ResizeHandleProps {
    /// The axis it resizes along (default `"horizontal"`): a horizontal
    /// handle is a vertical band, dragged left and right.
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// The edge of its container it hugs, its whole band inside; without
    /// one it straddles the container's leading edge.
    pub edge: Prop<Option<HandleEdge>>,
    /// No drags; the cursor is the default one.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say: what it resizes.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of its thumb: a grip centered on the band's
    /// line (at the edge it hugs), drawn upright as on a vertical line and
    /// turned a quarter on a horizontal one, which `group-hover:` and
    /// `group-active:` classes show, restyle and transition (it stays the
    /// same view). Without it (or `thumb_style`) there is none.
    pub thumb_class: Prop<Option<SharedString>>,
    /// The style of its thumb, over `thumb_class`.
    #[prop(default)]
    pub thumb_style: Prop<Style>,
    /// The app's indicator, centered on the band's line (at the edge it
    /// hugs): a line that `group-hover:` and `group-active:` classes
    /// restyle while the pointer is over the band and while it is pressed
    /// or dragged.
    pub children: Prop<Children>,
}

/// The events of a [`ResizeHandle`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ResizeHandleEvent {
    /// The pointer went down on it: a drag may follow.
    DragStart,
    /// The drag moved: the pointer's offset along the axis since it went
    /// down (right and down are positive).
    #[args(offset)]
    DragMove(Points),
    /// The drag ended (the pointer lifted, or the system took it), with
    /// its last offset.
    #[args(offset)]
    DragEnd(Points),
    /// The pointer came over it, left it, pressed or dragged it.
    #[args(state)]
    StateChange(ResizeHandleState),
}

/// A band that resizes whatever it edges when it is dragged (a sidebar's
/// edge, a dock's): it owns where it sits in its container (the leading
/// edge, or the edge it hugs, across the container's whole length), how
/// thick it is, its cursor, its hit area on touch screens, the drag
/// (followed natively, in the core, for as long as the pointer is down,
/// wherever it goes) and its progression (`ResizeHandleState`); what a
/// drag resizes is the caller's, from `onDragMove`'s offset. Its look is
/// the app's indicator, its children. Rust only: a drag reports every
/// move.
#[component]
pub fn ResizeHandle(props: ResizeHandleProps, cx: Scope<ResizeHandleEvent>) -> impl IntoElement {
    let state = signal(ResizeHandleState::Idle);
    // Changes only: it starts idle.
    let reported = stored(ResizeHandleState::Idle);
    effect(move || {
        let now = state.get();
        if reported.replace(now) != now {
            cx.emit(ResizeHandleEvent::StateChange(now));
        }
    });
    // Its axis and edge are read once: they decide what it is.
    let (axis, edge) = (props.axis.get_untracked(), props.edge.get_untracked());
    band(axis, edge, props.disabled, state, move |drag| {
        cx.emit(match drag {
            Drag::Start => ResizeHandleEvent::DragStart,
            Drag::Move(by) => ResizeHandleEvent::DragMove(by),
            Drag::End(by) => ResizeHandleEvent::DragEnd(by),
        })
    })
    .optional_label(props.accessibility_label)
    .absolute()
    .map(|v| match (edge, axis) {
        (Some(HandleEdge::Trailing), Axis::Horizontal) => {
            v.top(px(0.0)).bottom(px(0.0)).right(px(0.0))
        }
        (Some(HandleEdge::Leading), Axis::Horizontal) => {
            v.top(px(0.0)).bottom(px(0.0)).left(px(0.0))
        }
        (Some(HandleEdge::Trailing), Axis::Vertical) => {
            v.left(px(0.0)).right(px(0.0)).bottom(px(0.0))
        }
        (Some(HandleEdge::Leading), Axis::Vertical) => v.left(px(0.0)).right(px(0.0)).top(px(0.0)),
        (None, Axis::Horizontal) => v.top(px(0.0)).bottom(px(0.0)).left(-HANDLE_PADDING),
        (None, Axis::Vertical) => v.left(px(0.0)).right(px(0.0)).top(-HANDLE_PADDING),
    })
    .child(props.children)
    .child(
        // The band's line, where the thumb centers: at the edge the band
        // hugs, or in its middle.
        view()
            .absolute()
            .pointer_events(PointerEvents::None)
            .map(|v| {
                let at = match edge {
                    Some(_) => px(0.0),
                    None => HANDLE_PADDING,
                };
                match (edge, axis) {
                    (Some(HandleEdge::Trailing), Axis::Horizontal) => v.right(at),
                    (_, Axis::Horizontal) => v.left(at),
                    (Some(HandleEdge::Trailing), Axis::Vertical) => v.bottom(at),
                    (_, Axis::Vertical) => v.top(at),
                }
            })
            .map(|v| match axis {
                Axis::Horizontal => v.top(px(0.0)).bottom(px(0.0)).w(HANDLE_SIZE),
                Axis::Vertical => v.left(px(0.0)).right(px(0.0)).h(HANDLE_SIZE),
            })
            .child(handle_thumb(axis, props.thumb_class, props.thumb_style)),
    )
}

/// The thumb of a handle (`handleThumbClass` / `handleThumbStyle`): a view
/// of the app's centered on its indicator's line, a grip that `group-hover:`
/// and `group-active:` classes show and restyle (and transition, as it stays
/// the same view). It is drawn upright, as on a vertical line, and turned a
/// quarter on a horizontal one, so one class draws it on either axis. Placed
/// only when it has classes or a style; it takes no touches.
///
/// It is centered by transforms, which layout does not round: a point at
/// the middle of the line (half a point into its 1 point), and the thumb
/// moved back by half its own size around it. Centered by layout, a thumb
/// of an even length turned a quarter would sit half a point off the line.
pub(crate) fn handle_thumb(
    axis: Axis,
    class: Prop<Option<SharedString>>,
    style: Prop<Style>,
) -> AnyElement {
    let half = px(0.5);
    when(
        move || class.with(Option::is_some) || style.with(|s| *s != Style::default()),
        move || {
            view()
                .absolute()
                .size(px(0.0))
                .pointer_events(PointerEvents::None)
                .map(|v| match axis {
                    Axis::Horizontal => v.left(px(0.0)).top(relative(0.5)).translate_x(half),
                    Axis::Vertical => v.top(px(0.0)).left(relative(0.5)).translate_y(half),
                })
                .child(
                    view()
                        .absolute()
                        .left(px(0.0))
                        .top(px(0.0))
                        .translate_x(relative(-0.5))
                        .translate_y(relative(-0.5))
                        .map(|v| match axis {
                            Axis::Horizontal => v,
                            Axis::Vertical => v.rotate(radians(std::f32::consts::FRAC_PI_2)),
                        })
                        .child(view().flex_none().app_class(class).inline_style(style)),
                )
        },
    )
    .into_element()
}
