pub use nsh_core::keymap::Modifiers;
use nsh_core::{EventKind, EventPayload, NodeId, Point, Points, PressEvent, input::Press};
use nsh_engine::EngineControl;
use ratatui_core::layout::{Position, Rect};

use crate::{
    CellSize,
    mount::Mounter,
    render::{Geometry, Hit},
};

pub(crate) const WHEEL_ROWS: f32 = 3.0;
pub(crate) const WHEEL_COLUMNS: f32 = 6.0;
/// Presses of one button on one Cell this close together count as a double or triple click.
pub(crate) const CLICK_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// The terminal cursor's shape a frame asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum CursorStyle {
    /// The user's own cursor shape: nothing is being edited.
    #[default]
    Default,
    /// A steady bar between Cells, while a text field is edited.
    Bar,
}

/// Whether the surface used an event. Ignored events remain the embedder's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handled {
    /// Used by this surface.
    Yes,
    /// Available for another widget or the embedding application.
    Ignored,
}

/// A terminal mouse button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
    /// Primary button.
    #[default]
    Left,
    /// Secondary button.
    Right,
    /// Middle button.
    Middle,
}

/// A terminal pointer action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseKind {
    /// Button pressed.
    Down(MouseButton),
    /// Button released.
    Up(MouseButton),
    /// Motion, including motion with a button held.
    #[default]
    Move,
    /// Wheel steps, positive right and down: three rows vertically, six columns horizontally.
    Wheel {
        /// Horizontal steps.
        x: i16,
        /// Vertical steps.
        y: i16,
    },
}

/// Pointer coordinates are absolute terminal Cells, including the surface's offset.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct MouseInput {
    /// Action.
    pub kind: MouseKind,
    /// Column in the terminal.
    pub column: u16,
    /// Row in the terminal.
    pub row: u16,
    /// Modifier keys held.
    pub modifiers: Modifiers,
}

/// Input independent of the embedder's terminal backend. Resizing comes from rendering an area.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Input {
    /// Mouse input.
    Mouse(MouseInput),
    /// A key name as in NSH's keymap (`Enter`, `Escape`, or a character).
    Key {
        /// Key name.
        key: String,
        /// Held modifiers.
        modifiers: Modifiers,
        /// True for a release when the terminal reports it.
        release: bool,
    },
    /// A repeated key press identified by the terminal protocol.
    KeyRepeat {
        /// Key name, as for `Key`.
        key: String,
        /// Held modifiers.
        modifiers: Modifiers,
    },
    /// One bracketed paste.
    Paste(String),
    /// The embedding application gave or removed keyboard focus.
    Focus(bool),
}

/// Where `mouse` is in the surface `area`, in points: the middle of its Cell.
pub(crate) fn page_point(mouse: MouseInput, area: Rect, cells: CellSize) -> Point<Points> {
    Point::new(
        cells.width() * (f32::from(mouse.column) - f32::from(area.x) + 0.5),
        cells.height() * (f32::from(mouse.row) - f32::from(area.y) + 0.5),
    )
}

pub(crate) struct PointerContext<'a> {
    pub(crate) area: Rect,
    pub(crate) cells: CellSize,
    pub(crate) hits: &'a [Hit],
    pub(crate) geometry: &'a [Geometry],
    pub(crate) tree: &'a mut Mounter,
    pub(crate) control: &'a EngineControl,
}

/// Counts consecutive presses of one button on one Cell (1, 2, 3, then 1 again).
#[derive(Default)]
struct Clicks {
    last: Option<(std::time::Instant, Position, MouseButton)>,
    count: u32,
}

impl Clicks {
    fn down(&mut self, mouse: MouseInput) -> u32 {
        let MouseKind::Down(button) = mouse.kind else {
            return self.count.max(1);
        };
        let at = Position::new(mouse.column, mouse.row);
        let now = std::time::Instant::now();
        self.count = match self.last {
            Some((time, cell, held))
                if cell == at && held == button && now.duration_since(time) <= CLICK_INTERVAL =>
            {
                self.count % 3 + 1
            }
            _ => 1,
        };
        self.last = Some((now, at, button));
        self.count
    }
}

#[derive(Default)]
pub(crate) struct Pointer {
    clicks: Clicks,
    pressed: Option<(Press<NodeId>, Point<Points>)>,
    backdrop: Option<NodeId>,
    hovered: Vec<NodeId>,
    last: Option<MouseInput>,
    drag: Option<Drag>,
    active_states: Vec<NodeId>,
}

struct Drag {
    target: NodeId,
    origin: Point<Points>,
    start: Point<Points>,
    page: Point<Points>,
    started: std::time::Instant,
    path: Vec<NodeId>,
    candidates: Vec<(NodeId, nsh_core::input::Candidate)>,
    gate: Option<nsh_core::input::Gate>,
    active: Option<(NodeId, nsh_core::input::Candidate)>,
    velocity: nsh_core::input::VelocityTracker,
    activated: Option<NodeId>,
    scroll_start: Points,
}

impl Drag {
    fn report(&self, control: &EngineControl, phase: nsh_core::TouchPhase) {
        if self.path.is_empty() {
            return;
        }
        control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(nsh_core::TouchEvent {
                phase,
                timestamp: self.started.elapsed().as_secs_f64() * 1000.0,
                activated: self.activated,
                points: vec![nsh_core::TouchPoint {
                    id: 0,
                    target: self.target,
                    path: if phase == nsh_core::TouchPhase::Start {
                        self.path.clone()
                    } else {
                        Vec::new()
                    },
                    page: self.page,
                    location: self.page - self.origin,
                    changed: true,
                }],
            })),
        );
    }
}

impl Pointer {
    /// Counts a press for double and triple clicks; call once per button press, before routing it.
    pub(crate) fn count_click(&mut self, mouse: MouseInput) -> u32 {
        self.clicks.down(mouse)
    }

    /// Consecutive clicks of the last press: 2 for a double click, 3 for a triple click.
    /// Whether a drag is held: a scroll view it moves has not come to rest.
    pub(crate) fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    pub(crate) fn clicks(&self) -> u32 {
        self.clicks.count.max(1)
    }

    /// A secondary press: the nearest view around the one under the pointer that listens to
    /// `onContextMenu` hears it, as on the desktops.
    pub(crate) fn context_menu(
        &mut self,
        mouse: MouseInput,
        cx: &mut PointerContext<'_>,
    ) -> Handled {
        let position = Position::new(mouse.column, mouse.row);
        if !cx.area.contains(position) {
            return Handled::Ignored;
        }
        self.last = Some(mouse);
        let scope = crate::navigation::focus_scope(cx.tree);
        let Some(hit) = cx.hits.iter().rev().find(|hit| {
            hit.area.contains(position) && crate::keyboard::contains(cx.tree, scope, hit.node)
        }) else {
            return Handled::Ignored;
        };
        let page = page_point(mouse, cx.area, cx.cells);
        // The press goes down as a touch first, so an open popover hears a
        // press outside it, as it does for the primary button.
        let mut path = Vec::new();
        let mut node = Some(hit.node);
        while let Some(id) = node {
            let Some(view) = cx.tree.get(id) else {
                break;
            };
            if view.events.contains(EventKind::Touch) && !view.props.accessibility.state.disabled {
                path.push(id);
            }
            node = if id == scope { None } else { view.parent };
        }
        let touch = Drag {
            target: hit.node,
            origin: hit.node_origin,
            start: page,
            page,
            started: std::time::Instant::now(),
            path,
            candidates: Vec::new(),
            gate: None,
            active: None,
            velocity: Default::default(),
            activated: None,
            scroll_start: Points::ZERO,
        };
        touch.report(cx.control, nsh_core::TouchPhase::Start);
        touch.report(cx.control, nsh_core::TouchPhase::Cancel);
        let mut node = Some(hit.node);
        while let Some(id) = node {
            let Some(view) = cx.tree.get(id) else {
                break;
            };
            if view.events.contains(EventKind::ContextMenu)
                && !view.props.accessibility.state.disabled
            {
                let origin = cx
                    .geometry
                    .iter()
                    .find(|g| g.id == id)
                    .map_or_else(Point::default, |g| g.frame.origin);
                cx.control.dispatch_event(
                    id,
                    EventKind::ContextMenu,
                    EventPayload::ContextMenu(nsh_core::ContextMenuEvent::new(
                        page - origin,
                        page,
                        mouse.modifiers,
                        Some(nsh_core::PointerType::Mouse),
                    )),
                );
                return Handled::Yes;
            }
            node = if id == scope { None } else { view.parent };
        }
        if scope == nsh_core::ROOT_ID {
            Handled::Ignored
        } else {
            Handled::Yes
        }
    }

    pub(crate) fn leave(&mut self, cx: &mut PointerContext<'_>) {
        self.set_hovered(Vec::new(), cx);
        self.last = None;
    }

    /// The mouse at its last place, as view `id` hears it (`onMouseEnter`,
    /// `onMouseLeave`, `onMouseMove`): a drag holds the primary button.
    fn mouse_event(&self, id: NodeId, cx: &PointerContext<'_>) -> EventPayload {
        let (page, modifiers) = self.last.map_or_else(Default::default, |mouse| {
            (page_point(mouse, cx.area, cx.cells), mouse.modifiers)
        });
        let origin = cx
            .geometry
            .iter()
            .find(|g| g.id == id)
            .map_or_else(Point::default, |g| g.frame.origin);
        let pressed = self.drag.is_some().then_some(nsh_core::MouseButton::Left);
        EventPayload::Mouse(nsh_core::MouseEvent::new(
            page - origin,
            page,
            modifiers,
            pressed,
        ))
    }

    /// Hovers `hovered`, reporting whether that changed anything: a view
    /// left or entered must be drawn again even when none is hovered now.
    fn set_hovered(&mut self, hovered: Vec<NodeId>, cx: &mut PointerContext<'_>) -> bool {
        let (left, entered) = nsh_core::input::hover_changes(&self.hovered, &hovered);
        let changes: Vec<_> = left
            .into_iter()
            .map(|&id| (id, false, EventKind::MouseLeave))
            .chain(
                entered
                    .into_iter()
                    .map(|&id| (id, true, EventKind::MouseEnter)),
            )
            .collect();
        let changed = !changes.is_empty();
        for (id, active, event) in changes {
            let payload = self.mouse_event(id, cx);
            if let Some(view) = cx.tree.get_mut(id) {
                let bit = nsh_core::tailwind::state::HOVERED;
                if active {
                    view.states |= bit;
                } else {
                    view.states &= !bit;
                }
                if view.tracked & bit != 0 {
                    cx.control.set_states(id, view.states);
                }
                if view.events.contains(event) {
                    cx.control.dispatch_event(id, event, payload);
                }
            }
        }
        self.hovered = hovered;
        changed
    }

    /// Hovers what is under the pointer's last position; true when the
    /// hovered views changed.
    pub(crate) fn rehover(&mut self, cx: &mut PointerContext<'_>) -> bool {
        if self
            .drag
            .as_ref()
            .is_some_and(|drag| !visible_target(cx.tree, drag.target))
        {
            self.cancel(cx.tree, Some(cx.control));
        }
        let Some(mouse) = self.last else {
            return false;
        };
        let position = Position::new(mouse.column, mouse.row);
        let scope = crate::navigation::focus_scope(cx.tree);
        let mut hovered = Vec::new();
        let mut node = cx
            .area
            .contains(position)
            .then(|| {
                cx.hits.iter().rev().find(|hit| {
                    hit.area.contains(position)
                        && crate::keyboard::contains(cx.tree, scope, hit.node)
                })
            })
            .flatten()
            .map(|hit| hit.node);
        while let Some(id) = node {
            let Some(view) = cx.tree.get(id) else {
                break;
            };
            // A control that takes presses shows a hover band in a
            // terminal (the painter's), whether or not it styles `hover:`.
            if nsh_core::input::hoverable(view.tracked, view.events)
                || nsh_core::input::has_press(view.events)
            {
                hovered.push(id);
            }
            node = if id == scope { None } else { view.parent };
        }
        self.set_hovered(hovered, cx)
    }

    /// Takes the press the pointer holds on view `id` itself, with its
    /// view's origin, so a text field that takes the pointer still reports
    /// the press: [`Pointer::cancel`] leaves it to the caller.
    pub(crate) fn take_press(&mut self, id: NodeId) -> Option<(Press<NodeId>, Point<Points>)> {
        if self
            .pressed
            .as_ref()
            .is_some_and(|(press, _)| press.view == id && press.node == id)
        {
            self.pressed.take()
        } else {
            None
        }
    }

    pub(crate) fn cancel(&mut self, tree: &mut Mounter, control: Option<&EngineControl>) {
        self.backdrop = None;
        self.release_states(tree, control);
        if let Some(drag) = self.drag.take()
            && let Some(control) = control
        {
            if let Some((id, nsh_core::input::Candidate::Pan { .. })) = drag.active {
                pan_event(
                    tree,
                    control,
                    id,
                    EventKind::PanEnd,
                    drag.page - drag.start,
                    &drag.velocity,
                );
            }
            drag.report(control, nsh_core::TouchPhase::Cancel);
        }
        if let Some((mut press, _)) = self.pressed.take()
            && let Some(control) = control
        {
            for event in press.press_out(false) {
                control.dispatch_event(press.node, event, EventPayload::None);
            }
        }
    }

    fn release_states(&mut self, tree: &mut Mounter, control: Option<&EngineControl>) {
        for id in self.active_states.drain(..) {
            if let Some(view) = tree.get_mut(id) {
                view.states &= !nsh_core::tailwind::state::PRESSED;
                if let Some(control) = control {
                    control.set_states(id, view.states);
                }
            }
        }
    }

    pub(crate) fn handle(&mut self, mouse: MouseInput, mut cx: PointerContext<'_>) -> Handled {
        self.last = Some(mouse);
        let rehovered = self.rehover(&mut cx);
        if matches!(mouse.kind, MouseKind::Move) {
            for &id in &self.hovered {
                if cx
                    .tree
                    .get(id)
                    .is_some_and(|view| view.events.contains(EventKind::MouseMove))
                {
                    let payload = self.mouse_event(id, &cx);
                    cx.control.dispatch_event(id, EventKind::MouseMove, payload);
                }
            }
        }
        let PointerContext {
            area,
            cells,
            hits,
            geometry,
            tree,
            control,
        } = cx;
        let scope = crate::navigation::focus_scope(tree);
        let modal = scope != nsh_core::ROOT_ID;
        // A move off the last hovered view onto Cells no view claims is
        // still used: the view's hover band must go. A press there stays
        // the embedder's (its hover goes with the next draw).
        let moved_off = rehovered && matches!(mouse.kind, MouseKind::Move);
        let unused = if modal || moved_off || !self.hovered.is_empty() {
            Handled::Yes
        } else {
            Handled::Ignored
        };
        if self
            .pressed
            .as_ref()
            .is_some_and(|(press, _)| !crate::keyboard::contains(tree, scope, press.view))
        {
            self.cancel(tree, Some(control));
        }
        let position = Position::new(mouse.column, mouse.row);
        let page = page_point(mouse, area, cells);
        if self
            .drag
            .as_ref()
            .is_some_and(|drag| !crate::keyboard::contains(tree, scope, drag.target))
        {
            self.cancel(tree, Some(control));
        }
        if matches!(
            mouse.kind,
            MouseKind::Move | MouseKind::Up(MouseButton::Left)
        ) && let Some(mut drag) = self.drag.take()
        {
            drag.page = page;
            drag.velocity
                .add(drag.started.elapsed().as_secs_f64() * 1000.0, page);
            let moved = page - drag.start;
            if moved.x.abs().max(moved.y.abs()) > nsh_core::input::PRESS_SLOP {
                self.release_states(tree, Some(control));
                if let Some((mut press, origin)) = self.pressed.take() {
                    for event in press.press_out(false) {
                        dispatch(control, &press, event, page, origin);
                    }
                }
            }
            if tree.responder.is_some()
                && let Some((id, nsh_core::input::Candidate::Pan { .. })) = drag.active
            {
                pan_event(tree, control, id, EventKind::PanEnd, moved, &drag.velocity);
                drag.active = None;
            }
            drag.activated =
                nsh_core::input::Gate::step(&mut drag.gate, &mut drag.candidates, moved.x, moved.y);
            if drag.active.is_none()
                && tree.responder.is_none()
                && moved.x.abs().max(moved.y.abs()) > nsh_core::input::PAN_SLOP
            {
                drag.active = nsh_core::input::startable(
                    &drag.candidates,
                    drag.gate.as_ref(),
                    moved.x,
                    moved.y,
                )
                .copied();
                if let Some((id, nsh_core::input::Candidate::Scroll { horizontal })) = drag.active {
                    if let Some(scroll) = tree.get(id).and_then(|view| view.scroll.as_ref()) {
                        drag.scroll_start = if horizontal { scroll.x } else { scroll.y };
                    }
                    drag.report(control, nsh_core::TouchPhase::Cancel);
                    drag.path.clear();
                }
                if let Some((id, nsh_core::input::Candidate::Pan { .. })) = drag.active {
                    tree.animator.pan_began(id);
                    pan_event(
                        tree,
                        control,
                        id,
                        EventKind::PanStart,
                        Point::default(),
                        &drag.velocity,
                    );
                }
            }
            if let Some((id, candidate)) = drag.active {
                self.release_states(tree, Some(control));
                if let Some((mut press, origin)) = self.pressed.take() {
                    for event in press.press_out(false) {
                        dispatch(control, &press, event, page, origin);
                    }
                }
                match candidate {
                    nsh_core::input::Candidate::Pan { .. } => tree.animator.pan_moved(id, moved),
                    nsh_core::input::Candidate::Scroll { horizontal } => {
                        if tree.get(id).is_some_and(|view| view.scroll.is_some()) {
                            let to = drag.scroll_start - if horizontal { moved.x } else { moved.y };
                            crate::keyboard::move_scroll(tree, id, to);
                        }
                    }
                }
            }
            if matches!(mouse.kind, MouseKind::Move) {
                drag.report(control, nsh_core::TouchPhase::Move);
                self.drag = Some(drag);
                return Handled::Yes;
            }
            if let Some((id, nsh_core::input::Candidate::Pan { .. })) = drag.active {
                pan_event(tree, control, id, EventKind::PanEnd, moved, &drag.velocity);
            }
            self.release_states(tree, Some(control));
            drag.report(control, nsh_core::TouchPhase::End);
            if self.pressed.is_none() {
                return if !area.contains(position) && drag.path.is_empty() && drag.active.is_none()
                {
                    Handled::Ignored
                } else {
                    Handled::Yes
                };
            }
        }
        let hit = hits.iter().rev().find(|hit| {
            hit.area.contains(position) && crate::keyboard::contains(tree, scope, hit.node)
        });
        let backdrop = modal && hit.is_none_or(|hit| hit.node == scope && hit.target.is_none());
        if matches!(mouse.kind, MouseKind::Up(MouseButton::Left))
            && let Some(id) = self.backdrop.take()
        {
            if scope == id && area.contains(position) && backdrop {
                crate::navigation::request_close(
                    tree,
                    control,
                    id,
                    crate::navigation::CloseReason::Backdrop,
                );
            }
            return Handled::Yes;
        }
        if !area.contains(position) {
            if matches!(mouse.kind, MouseKind::Up(MouseButton::Left)) {
                self.cancel(tree, Some(control));
            }
            return Handled::Ignored;
        }
        if backdrop {
            if matches!(mouse.kind, MouseKind::Down(MouseButton::Left)) {
                self.cancel(tree, Some(control));
                self.backdrop = Some(scope);
            }
            return Handled::Yes;
        }
        match mouse.kind {
            MouseKind::Down(MouseButton::Left) => {
                self.cancel(tree, Some(control));
                if let Some(hit) = hit {
                    let mut grab = nsh_core::input::Grab::default();
                    let mut node = Some(hit.node);
                    while let Some(id) = node {
                        let Some(view) = tree.get(id) else {
                            break;
                        };
                        if !view.props.accessibility.state.disabled {
                            grab.add(
                                &id,
                                &nsh_core::input::Link::new(
                                    id,
                                    view.events,
                                    view.tracked,
                                    view.gestures,
                                    view.scroll.as_ref().map(|s| s.horizontal),
                                    view.props.pan_activation,
                                ),
                                nsh_core::input::GrabOptions::new(true, false, false, true),
                            );
                        }
                        node = if id == scope { None } else { view.parent };
                    }
                    self.active_states = grab.pressed;
                    for &id in &self.active_states {
                        if let Some(view) = tree.get_mut(id) {
                            view.states |= nsh_core::tailwind::state::PRESSED;
                            control.set_states(id, view.states);
                        }
                    }
                    if !grab.path.is_empty()
                        || !grab.candidates.is_empty()
                        || hit.target.is_some()
                        || !self.active_states.is_empty()
                    {
                        let mut drag = Drag {
                            target: hit.node,
                            origin: hit.node_origin,
                            start: page,
                            page,
                            started: std::time::Instant::now(),
                            path: grab.path,
                            candidates: grab.candidates,
                            gate: grab.gate,
                            active: None,
                            velocity: Default::default(),
                            activated: None,
                            scroll_start: Points::ZERO,
                        };
                        drag.velocity.add(0.0, page);
                        drag.report(control, nsh_core::TouchPhase::Start);
                        self.drag = Some(drag);
                    }
                }
                // A pressable span (a nested `<Text onPress>`, a link) under
                // the pointer takes the press before the views around it.
                // The span is no view of its own: its text view (`view`)
                // stands for it in the tree.
                let link = hit.and_then(|hit| {
                    link_at(tree, geometry, hit.node, page).map(|link| (link, hit))
                });
                let target = link
                    .map(|(link, hit)| (hit.node, link.node, link.events, hit.node_origin))
                    .or_else(|| {
                        let (id, origin) =
                            hit.and_then(|hit| hit.target.map(|id| (id, hit.origin)))?;
                        Some((id, id, tree.get(id)?.events, origin))
                    });
                let Some((view, id, events, origin)) = target else {
                    return if self.drag.is_some() {
                        Handled::Yes
                    } else {
                        unused
                    };
                };
                // A span's press delay is its text view's.
                let delay = tree.get(view).and_then(|view| view.props.long_press_delay);
                let mut press =
                    Press::new(view, id, events, delay, 0).clicked(mouse.modifiers, self.clicks());
                if let Some(event) = press.press_in() {
                    dispatch(control, &press, event, page, origin);
                }
                self.pressed = Some((press, origin));
                Handled::Yes
            }
            MouseKind::Up(MouseButton::Left) => {
                let Some((mut press, origin)) = self.pressed.take() else {
                    return unused;
                };
                let link = hit.and_then(|hit| link_at(tree, geometry, hit.node, page));
                if tree.get(press.view).is_none() {
                    return unused;
                }
                let fire = match link {
                    Some(link) => link.node == press.node,
                    None => hit.is_some_and(|hit| hit.target == Some(press.node)),
                };
                for event in press.press_out(fire) {
                    dispatch(control, &press, event, page, origin);
                }
                Handled::Yes
            }
            _ => unused,
        }
    }
}

/// The pressable span (a nested `<Text onPress>`) of text view `id` on the
/// Cell at `page`: the innermost one around the character drawn there.
fn link_at(
    tree: &Mounter,
    geometry: &[Geometry],
    id: NodeId,
    page: Point<Points>,
) -> Option<nsh_core::TextLink> {
    let view = tree.get(id)?;
    let text = view.text_content.as_ref()?;
    if text.links.is_empty() {
        return None;
    }
    let frame = geometry.iter().rev().find(|g| g.id == id)?.text_frame?;
    let layout = view
        .text
        .as_ref()?
        .0
        .downcast::<crate::text::CellLayout>()?;
    let point = page - frame.origin;
    let (_, range) = layout
        .glyphs
        .iter()
        .find(|(bounds, range)| !range.is_empty() && bounds.contains(&point))?;
    text.link_at(range.start)
        .filter(|link| nsh_core::input::has_press(link.events))
        .copied()
}

pub(crate) fn dispatch(
    control: &EngineControl,
    press: &Press<NodeId>,
    event: EventKind,
    page: Point<Points>,
    origin: Point<Points>,
) {
    control.dispatch_event(
        press.node,
        event,
        EventPayload::Press(PressEvent {
            position: page - origin,
            page_position: page,
            modifiers: press.modifiers,
            clicks: press.clicks,
        }),
    );
}

fn pan_event(
    tree: &Mounter,
    control: &EngineControl,
    id: NodeId,
    kind: EventKind,
    translation: Point<Points>,
    velocity: &nsh_core::input::VelocityTracker,
) {
    if !tree.get(id).is_some_and(|view| view.events.contains(kind)) {
        return;
    }
    let (value_x, value_y) = tree.animator.pan_values(id);
    let (velocity_x, velocity_y) = velocity.velocity();
    control.dispatch_event(
        id,
        kind,
        EventPayload::Pan {
            translation,
            velocity_x,
            velocity_y,
            value_x: value_x.map(Points),
            value_y: value_y.map(Points),
        },
    );
}

fn visible_target(tree: &Mounter, mut id: NodeId) -> bool {
    let scope = crate::navigation::focus_scope(tree);
    loop {
        let Some(view) = tree.get(id) else {
            return false;
        };
        if view.concealed || view.style.hidden || view.style.opacity <= 0.0 {
            return false;
        }
        if id == scope {
            return true;
        }
        let Some(parent) = view.parent else {
            return false;
        };
        id = parent;
    }
}

/// A press on a scroll bar: dragging its thumb scrolls in proportion, a press on its
/// track first jumps the thumb under the pointer.
#[derive(Clone, Copy)]
pub(crate) struct BarDrag {
    pub(crate) node: NodeId,
    vertical: bool,
    /// The whole track along its axis, past the screen too (start, Cells).
    extent: (i32, i32),
    /// The thumb's Cells.
    thumb: i32,
    /// Where the pointer holds the thumb, in Cells from its start.
    grab: i32,
}

impl BarDrag {
    /// The bar under a primary press, if any; a press on its track scrolls at once.
    pub(crate) fn press(
        bars: &[crate::scrollbar::ScrollBar],
        mouse: MouseInput,
        tree: &mut Mounter,
    ) -> Option<BarDrag> {
        if !matches!(mouse.kind, MouseKind::Down(MouseButton::Left)) {
            return None;
        }
        let at = Position::new(mouse.column, mouse.row);
        let scope = crate::navigation::focus_scope(tree);
        let bar = bars.iter().rev().find(|bar| {
            bar.track.contains(at) && crate::keyboard::contains(tree, scope, bar.node)
        })?;
        let p = i32::from(if bar.vertical { at.y } else { at.x });
        let (thumb_start, thumb) = bar.thumb_extent;
        let thumb = thumb.max(1);
        let on_thumb = bar.thumb.contains(at);
        let drag = BarDrag {
            node: bar.node,
            vertical: bar.vertical,
            extent: bar.extent,
            thumb,
            grab: if on_thumb { p - thumb_start } else { thumb / 2 },
        };
        if !on_thumb {
            drag.moved(mouse, tree);
        }
        Some(drag)
    }

    /// Scrolls so the thumb follows the pointer; returns whether the offset changed.
    pub(crate) fn moved(&self, mouse: MouseInput, tree: &mut Mounter) -> bool {
        let Some(view) = tree.get(self.node) else {
            return false;
        };
        let Some(scroll) = view.scroll.as_ref() else {
            return false;
        };
        if scroll.horizontal == self.vertical {
            return false;
        }
        let max = scroll.max(view.frame.size);
        let max = if self.vertical { max.y } else { max.x };
        // The thumb moves along the whole track, as it is drawn: a view
        // the screen cuts off keeps the Cells past its edge.
        let (start, len) = self.extent;
        let free = (len - self.thumb).max(0);
        if free == 0 || max <= Points::ZERO {
            return false;
        }
        let p = if self.vertical {
            mouse.row
        } else {
            mouse.column
        };
        let moved = (i32::from(p) - start - self.grab).clamp(0, free);
        let to = max * (moved as f32 / free as f32);
        crate::keyboard::move_scroll(tree, self.node, to) != Points::ZERO
    }
}
