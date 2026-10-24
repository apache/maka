//! [`ResizablePanelGroup`] and [`ResizablePanel`]: panels side by side
//! (or stacked) whose sizes the user changes by dragging the handles
//! between them, with no look of their own.

use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    AccessibilityActionDef, AccessibilityValue,
    geometry::{Along, Axis, Bounds},
    ui::{Style, StyleRefinement, prelude::*},
};

use super::{
    resize_handle::{
        Drag, HANDLE_PADDING, HANDLE_SIZE, ResizeHandleContext, ResizeHandleState, band,
        handle_thumb,
    },
    state::{PANEL_MAX_SIZE, PANEL_MIN_SIZE, ResizableState},
};

/// The props of [`ResizablePanelGroup`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ResizablePanelGroupProps {
    /// The axis the panels are laid out and resized along (default
    /// `"horizontal"`: side by side, the handles vertical bands dragged
    /// left and right).
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// No drags: the handles stay where they are (a locked layout).
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The Tailwind classes of each handle's indicator, the part the app
    /// draws, centered on the boundary between two panels in the handle's
    /// band, along the whole boundary and 1 point across unless the
    /// classes say otherwise (`bg-border` for a hairline on either axis,
    /// `w-[3px]` thicker; `group-hover:` and `group-active:` restyle it
    /// while the pointer is over the band and while it is pressed or
    /// dragged).
    pub handle_class: Prop<Option<SharedString>>,
    /// The style of each handle's indicator, over `handleClass`.
    #[prop(default)]
    pub handle_style: Prop<Style>,
    /// The Tailwind classes of each handle's thumb: a grip centered on the
    /// indicator's line, drawn upright as on a vertical line and turned a
    /// quarter on a horizontal one, so one class draws it on either axis
    /// (`h-5 w-[3px] rounded-full bg-muted-foreground opacity-0
    /// group-hover:opacity-40 transition`). It stays the same view as the
    /// handle's state changes, so `group-hover:` / `group-active:` changes
    /// transition. Without it (or `handleThumbStyle`) there is none.
    pub handle_thumb_class: Prop<Option<SharedString>>,
    /// The style of each handle's thumb, over `handleThumbClass`.
    #[prop(default)]
    pub handle_thumb_style: Prop<Style>,
    /// What screen readers say for each handle: what it resizes.
    pub handle_accessibility_label: Prop<Option<SharedString>>,
    /// The content of each handle's indicator (`gpui-base`'s handle
    /// appearance): a grip, drawn again as the handle's state changes
    /// (hovered, pressed, dragged), which it is told with the handle's
    /// index and axis.
    pub render_handle: Prop<Option<Renderer<ResizeHandleContext>>>,
    /// The panels: `ResizablePanel`s, its direct children. Made where
    /// the group places them, so they find it.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a [`ResizablePanelGroup`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ResizablePanelGroupEvent {
    /// A drag of a handle ended and moved it: the size of every visible
    /// panel along the axis, in the order they are laid out (left to
    /// right, top to bottom). Pass them back as the panels' `size` to keep the layout
    /// (when the app makes the group again, saved with its settings).
    /// Changing the group's bounds also ends an active drag and reports
    /// its last applied sizes, so the app retains the user's preference.
    #[args(sizes)]
    Resize(Vec<Points>),
}

/// Panels in a row (or a column) that the user resizes by dragging the
/// handles between them (`gpui-base`'s `ResizablePanelGroup`): the group
/// lays its `ResizablePanel` children out along its `axis`, puts a handle
/// on each boundary between two visible panels, and while one is dragged
/// moves the space between the panels in the core, frame by frame, with
/// no round trip to JS, as far as the panels' `minSize` / `maxSize` let it
/// (growing a panel takes from the panels after the handle, nearest first;
/// shrinking it below its minimum takes from the panels before it), then
/// reports the new sizes with `onResize`. The group's own size never
/// changes what a panel wants: while the group is too small for the
/// panels' sizes they shrink (`fixed` ones do not), and they come back to
/// them when there is room again; the panels without a size share the
/// rest, or, when every panel has one, the panels share it in proportion.
///
/// It looks like nothing: the panels are the app's to style, and each
/// handle is a band as thick as its hit area (a little more on touch
/// screens) with the resize cursor, whose indicator `handleClass` /
/// `handleStyle` draw. The group fills its parent (`size-full`) unless
/// its `class` says otherwise.
#[component]
pub fn ResizablePanelGroup(
    props: ResizablePanelGroupProps,
    cx: Scope<ResizablePanelGroupEvent>,
) -> impl IntoElement {
    let group = GroupContext::new(props.axis.get_untracked());
    provide_context(group.clone());
    {
        let group = group.clone();
        effect(move || {
            let axis = props.axis.get();
            group.edit(|m| {
                m.axis = axis;
                m.sync();
            });
        });
    }
    let handles = {
        let group = group.clone();
        computed(move || {
            group.tick.get();
            group.model.borrow().handles()
        })
    };
    view()
        .size_full()
        .style_with(move |s| match props.axis.get() {
            Axis::Horizontal => s.flex_row(),
            Axis::Vertical => s.flex_col(),
        })
        .on_layout({
            let group = group.clone();
            move |frame: &Bounds<Points>| {
                if let Some((sizes, panels)) = group.edit(|m| m.set_container(*frame)) {
                    for (emit, size) in panels {
                        emit(size);
                    }
                    cx.emit(ResizablePanelGroupEvent::Resize(sizes));
                }
            }
        })
        .child(props.children)
        .child(each(
            move || handles.get(),
            |spot: &HandleSpot| (spot.axis, spot.index),
            move |spot, _| {
                let HandleSpot { axis, index, .. } = spot.get_untracked();
                let state = signal(ResizeHandleState::Idle);
                // What a drag's end, or a screen reader's step, changed.
                let report = move |ended: Option<Report>| {
                    if let Some((sizes, panels)) = ended {
                        for (emit, size) in panels {
                            emit(size);
                        }
                        cx.emit(ResizablePanelGroupEvent::Resize(sizes));
                    }
                };
                let (dragged, stepped, read) = (group.clone(), group.clone(), group.clone());
                band(axis, None, props.disabled, state, move |drag| match drag {
                    Drag::Start => dragged.edit(|m| m.start_drag(index)),
                    Drag::Move(by) => dragged.edit(|m| m.drag(by)),
                    Drag::End(_) => report(dragged.edit(Model::end_drag)),
                })
                .optional_label(props.handle_accessibility_label)
                // Screen readers adjust it a step at a time, and read the
                // size of the panel before it in its range.
                .accessibility_value(move || {
                    read.tick.get();
                    read.model.borrow().handle_value(index)
                })
                .accessibility_actions(vec![
                    AccessibilityActionDef {
                        name: "increment".into(),
                        label: None,
                    },
                    AccessibilityActionDef {
                        name: "decrement".into(),
                        label: None,
                    },
                ])
                .on_accessibility_action(move |action: &str| {
                    let by = match action {
                        "increment" => ACCESSIBILITY_STEP,
                        "decrement" => -ACCESSIBILITY_STEP,
                        _ => return,
                    };
                    if !props.disabled.get_untracked() {
                        report(stepped.edit(|m| m.step(index, by)));
                    }
                })
                .absolute()
                .style_with(move |s| {
                    let at = spot.get().at;
                    match axis {
                        Axis::Horizontal => s.top(px(0.0)).bottom(px(0.0)).left(at),
                        Axis::Vertical => s.left(px(0.0)).right(px(0.0)).top(at),
                    }
                })
                .child(
                    // The line by default, so one class draws it on either
                    // axis (`bg-border`); the app's classes win.
                    view()
                        .map(|v| match axis {
                            Axis::Horizontal => v.w(HANDLE_SIZE),
                            Axis::Vertical => v.h(HANDLE_SIZE),
                        })
                        .app_class(props.handle_class)
                        .inline_style(props.handle_style)
                        .child(dynamic(move || {
                            props.render_handle.get().map(|render| {
                                let handle = ResizeHandleContext {
                                    index: index as u32,
                                    axis,
                                    state: state.get(),
                                };
                                render.render(index.to_string(), handle)
                            })
                        }))
                        .child(handle_thumb(
                            axis,
                            props.handle_thumb_class,
                            props.handle_thumb_style,
                        )),
                )
            },
        ))
}

/// The props of [`ResizablePanel`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ResizablePanelProps {
    /// The size it wants along the group's axis, within its range: it
    /// shrinks while the group is too small, and comes back to it when
    /// there is room. Without one, it takes its share of the space the
    /// panels with a size leave. A drag gives it the size the user chose
    /// until the app passes a new value; pass back what `onResize`
    /// reports to keep it when the group is made again.
    pub size: Prop<Option<Points>>,
    /// The smallest it gets (default 100). In a group too short for its
    /// panels' minimums together, they share it in proportion to them.
    #[prop(default = PANEL_MIN_SIZE)]
    pub min_size: Prop<Points>,
    /// The largest it gets (default: no limit).
    pub max_size: Prop<Option<Points>>,
    /// It keeps its size when the group grows or shrinks (a sidebar, an
    /// inspector); the other panels share the difference. Dragging its own
    /// handle still resizes it. It takes a `size`, and at least one panel
    /// of the group should not be fixed.
    #[prop(default)]
    pub fixed: Prop<bool>,
    /// Shown (default true). A hidden panel takes no space: the others
    /// share its space, and give it back when it shows again.
    #[prop(default = true)]
    pub visible: Prop<bool>,
    /// The content.
    pub children: Prop<Children>,
}

/// The events of a [`ResizablePanel`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ResizablePanelEvent {
    /// A drag of a handle of its group ended and changed its size: the
    /// new one, to pass back as its `size`.
    #[args(size)]
    Resize(Points),
}

/// A panel of a [`ResizablePanelGroup`], one of its direct children
/// (`gpui-base`'s `ResizablePanel`): the group sizes it along its axis
/// from its `size`, within `minSize` and `maxSize`, and stretches it
/// across. Its look and its content are the app's (`class`, `style`,
/// children); its flex basis, grow and shrink and its minimum and
/// maximum along the axis are the group's. Outside a group it is a plain
/// view.
#[component]
pub fn ResizablePanel(
    props: ResizablePanelProps,
    cx: Scope<ResizablePanelEvent>,
) -> impl IntoElement {
    let Some(group) = use_context::<GroupContext>() else {
        return view()
            .style_when(move || !props.visible.get(), |s| s.hidden())
            .child(props.children)
            .into_element();
    };
    let id = group.next_id();
    let read = move || PanelProps {
        size: props.size.get(),
        min: props.min_size.get(),
        max: props.max_size.get(),
        fixed: props.fixed.get(),
        visible: props.visible.get(),
    };
    let emit: Rc<dyn Fn(Points)> = Rc::new(move |size| cx.emit(ResizablePanelEvent::Resize(size)));
    {
        let group = group.clone();
        let first = untracked(read);
        group.edit(|m| m.register(id, first, emit));
    }
    {
        let group = group.clone();
        effect(move || {
            let panel = read();
            group.edit(|m| m.set_props(id, panel));
        });
    }
    {
        // The group may go first: then there is nothing to tell.
        let group = group.clone();
        cleanup(move || group.edit_if_live(|m| m.unregister(id)));
    }
    let flex = {
        let group = group.clone();
        computed(move || {
            group.tick.get();
            group.model.borrow().flex(id)
        })
    };
    view()
        .style_with(move |s| flex.get().apply(s))
        .on_layout(move |frame: &Bounds<Points>| group.edit(|m| m.set_frame(id, *frame)))
        .child(props.children)
        .into_element()
}

/// What a group's panels and handles share: its model and the signal
/// that tells them it changed.
#[derive(Clone)]
struct GroupContext {
    model: Rc<RefCell<Model>>,
    tick: Signal<u64>,
    next: Rc<std::cell::Cell<u64>>,
}

impl GroupContext {
    fn new(axis: Axis) -> Self {
        Self {
            model: Rc::new(RefCell::new(Model {
                axis,
                ..Model::default()
            })),
            tick: signal(0),
            next: Rc::default(),
        }
    }

    /// A new panel's id.
    fn next_id(&self) -> u64 {
        let id = self.next.get();
        self.next.set(id + 1);
        id
    }

    /// `f` of the model; then what reads it is told (never while it is
    /// borrowed: a binding reading it may run at once).
    fn edit<R>(&self, f: impl FnOnce(&mut Model) -> R) -> R {
        let out = f(&mut self.model.borrow_mut());
        self.tick.update(|t| *t = t.wrapping_add(1));
        out
    }

    /// [`Self::edit`], unless the group is gone.
    fn edit_if_live(&self, f: impl FnOnce(&mut Model)) {
        f(&mut self.model.borrow_mut());
        if let Some(t) = self.tick.try_get() {
            self.tick.try_set(t.wrapping_add(1));
        }
    }
}

/// A panel as the app describes it.
#[derive(Debug, Clone, PartialEq)]
struct PanelProps {
    size: Option<Points>,
    min: Points,
    max: Option<Points>,
    fixed: bool,
    visible: bool,
}

impl PanelProps {
    fn range(&self) -> std::ops::Range<Points> {
        self.min..self.max.unwrap_or(PANEL_MAX_SIZE)
    }
}

/// A panel of the group.
struct Entry {
    id: u64,
    props: PanelProps,
    /// Its frame in the group, as last laid out.
    frame: Option<Bounds<Points>>,
    /// The size the user gave it (a drag, a screen reader's step), until
    /// the app gives it another `size`.
    dragged: Option<Points>,
    emit: Rc<dyn Fn(Points)>,
}

impl Entry {
    /// The size it wants: the user's, else the app's; `None`: it takes
    /// its share of the rest.
    fn wanted(&self) -> Option<Points> {
        self.dragged.or(self.props.size)
    }

    /// It keeps its size whatever the group's: a fixed panel needs a size
    /// to keep.
    fn fixed(&self) -> bool {
        self.props.fixed && self.wanted().is_some()
    }
}

/// What a drag's end (or a step) changed: every visible panel's size,
/// and each panel it resized with its report and its new size.
type Report = (Vec<Points>, Vec<(Rc<dyn Fn(Points)>, Points)>);

/// A drag of a handle going on.
struct DragState {
    /// The panel before the handle.
    ix: usize,
    /// Its size when the drag started.
    from: Points,
    /// Every panel's then.
    before: Vec<Points>,
    /// The sizes as `gpui-base`'s rules move them.
    state: ResizableState,
    /// The one panel without a size, when there was one: it stays without
    /// one, taking the rest, which is the size the drag gives it.
    flexible: Option<u64>,
}

/// The group's panels, the sizes a drag decided and the drag going on.
///
/// The layout is flexbox's: a panel's size is what it wants (its basis),
/// shrinking while the group is too small for it and back to it once
/// there is room again; the group's own size never changes what a panel
/// wants, and only the user's drags and steps (or the app's `size`) do.
struct Model {
    axis: Axis,
    /// Every panel, in the order they were made.
    entries: Vec<Entry>,
    /// The ids of the visible panels, as laid out.
    ids: Vec<u64>,
    /// The sizes a drag or a step decided, until the panels are laid out
    /// at them (their frames come back a frame later).
    expected: Option<Vec<Points>>,
    /// The group's frame, once laid out.
    container: Option<Bounds<Points>>,
    drag: Option<DragState>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            axis: Axis::Horizontal,
            entries: Vec::new(),
            ids: Vec::new(),
            expected: None,
            container: None,
            drag: None,
        }
    }
}

impl Model {
    fn entry(&self, id: u64) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.id == id)
    }

    fn register(&mut self, id: u64, props: PanelProps, emit: Rc<dyn Fn(Points)>) {
        self.entries.push(Entry {
            id,
            props,
            frame: None,
            dragged: None,
            emit,
        });
        self.sync();
    }

    fn unregister(&mut self, id: u64) {
        self.entries.retain(|e| e.id != id);
        self.sync();
    }

    /// The app's props of panel `id`: a new `size` is what it wants from
    /// then on, over the size the user gave it.
    fn set_props(&mut self, id: u64, props: PanelProps) {
        let Some(entry) = self.entry_mut(id) else {
            return;
        };
        if entry.props == props {
            return;
        }
        if entry.props.size != props.size {
            entry.dragged = None;
        }
        entry.props = props;
        self.sync();
    }

    fn set_container(&mut self, frame: Bounds<Points>) -> Option<Report> {
        if self.container == Some(frame) {
            return None;
        }
        let ended = self.end_drag();
        // The captured offsets and expected sizes belong to the old frame.
        self.expected = None;
        self.container = Some(frame);
        ended
    }

    /// The smallest `entry` gets: its `minSize`, unless the group is too
    /// short for the visible panels' minimums together; then they share
    /// its length in proportion to them, so the panels never overflow it.
    fn min_of(&self, entry: &Entry) -> Points {
        let min = entry.props.min;
        let Some(container) = self.container else {
            return min;
        };
        let panels: Vec<&Entry> = self.ids.iter().filter_map(|&id| self.entry(id)).collect();
        let total = panels.iter().fold(Points::ZERO, |sum, e| sum + e.props.min);
        // The app's gaps between the panels are not theirs to share.
        let gaps = panels
            .windows(2)
            .filter_map(|pair| {
                let (a, b) = (pair[0].frame?, pair[1].frame?);
                let end = a.origin.along(self.axis) + a.size.along(self.axis);
                Some((b.origin.along(self.axis) - end).max(Points::ZERO))
            })
            .fold(Points::ZERO, |sum, gap| sum + gap);
        let room = (container.size.along(self.axis) - gaps).max(Points::ZERO);
        if total > room && total > Points::ZERO {
            min * (room / total)
        } else {
            min
        }
    }

    /// `size` within `entry`'s range (its minimum as [`Self::min_of`]
    /// gives it).
    fn clamp(&self, entry: &Entry, size: Points) -> Points {
        let size = size.max(self.min_of(entry));
        entry.props.max.map_or(size, |max| size.min(max))
    }

    fn set_frame(&mut self, id: u64, frame: Bounds<Points>) {
        if let Some(entry) = self.entry_mut(id) {
            entry.frame = Some(frame);
            // Laid out at what the last drag or step decided.
            if self.drag.is_none() {
                self.expected = None;
            }
            self.sync();
        }
    }

    /// Where a frame starts along the axis, when it has a length there.
    fn start(&self, frame: Option<Bounds<Points>>) -> Option<Points> {
        frame
            .filter(|f| f.size.along(self.axis) > Points::ZERO)
            .map(|f| f.origin.along(self.axis))
    }

    /// The visible panels in the order they are laid out (those not laid
    /// out yet last, in the order they were made).
    fn sync(&mut self) {
        let mut visible: Vec<(Option<Points>, usize, u64)> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.props.visible)
            .map(|(made, e)| (self.start(e.frame), made, e.id))
            .collect();
        visible.sort_by(|a, b| match (a.0, b.0) {
            (Some(x), Some(y)) => x
                .partial_cmp(&y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(&b.1)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.1.cmp(&b.1),
        });
        let ids: Vec<u64> = visible.iter().map(|v| v.2).collect();
        if ids != self.ids {
            // Another set of panels: what was decided for the old one goes.
            self.ids = ids;
            self.expected = None;
            self.drag = None;
        }
    }

    /// The visible panels' sizes now: what a drag or a step decided, else
    /// as laid out, once all of them are.
    fn current_sizes(&self) -> Option<Vec<Points>> {
        if let Some(expected) = &self.expected
            && expected.len() == self.ids.len()
        {
            return Some(expected.clone());
        }
        self.ids
            .iter()
            .map(|&id| {
                let frame = self.entry(id)?.frame?;
                Some(frame.size.along(self.axis)).filter(|&len| len > Points::ZERO)
            })
            .collect()
    }

    /// How panel `id` is laid out along the axis, flexbox's way: the size
    /// it wants is its basis, within its range, and it shrinks with the
    /// others when the group is too small for them (a fixed one does not);
    /// a panel without one takes its share of the rest (basis 0, so its
    /// content does not skew the shares). When every panel has a size, the
    /// room left over goes to them in proportion (each grows by its
    /// basis), as `gpui-base`'s panels share a group that grows.
    fn flex(&self, id: u64) -> PanelFlex {
        let Some(entry) = self.entry(id) else {
            return PanelFlex::default();
        };
        let props = &entry.props;
        let mut flex = PanelFlex {
            axis: self.axis,
            hidden: !props.visible,
            min: self.min_of(entry),
            max: props.max,
            ..PanelFlex::default()
        };
        if flex.hidden {
            return flex;
        }
        if let Some(wanted) = entry.wanted() {
            let basis = self.clamp(entry, wanted);
            flex.basis = Some(basis);
            let all_sized = self
                .ids
                .iter()
                .filter_map(|&i| self.entry(i))
                .all(|e| e.wanted().is_some());
            flex.grow = if all_sized { basis.0 } else { 0.0 };
            flex.shrink = 1.0;
        }
        if entry.fixed() {
            (flex.grow, flex.shrink) = (0.0, 0.0);
        }
        flex
    }

    /// The handles: one on each boundary between two visible panels, once
    /// they are laid out. They follow what a drag decided, which the
    /// frames show a frame later, and keep the gaps the app put between
    /// the panels.
    fn handles(&self) -> Vec<HandleSpot> {
        let axis = self.axis;
        if self.ids.len() < 2 {
            return Vec::new();
        }
        let frames: Option<Vec<Bounds<Points>>> = self
            .ids
            .iter()
            .map(|&id| self.entry(id).and_then(|e| e.frame))
            .collect();
        let (Some(frames), Some(sizes)) = (frames, self.current_sizes()) else {
            return Vec::new();
        };
        let start = |f: &Bounds<Points>| f.origin.along(axis);
        let end = |f: &Bounds<Points>| f.origin.along(axis) + f.size.along(axis);
        let mut at = start(&frames[0]);
        (0..frames.len() - 1)
            .map(|index| {
                let gap = start(&frames[index + 1]) - end(&frames[index]);
                at += sizes[index];
                let boundary = at + gap / 2.0;
                at += gap;
                HandleSpot {
                    axis,
                    index,
                    at: boundary - HANDLE_PADDING,
                }
            })
            .collect()
    }

    /// Where the handle after panel `ix` is, for screen readers: that
    /// panel's size in its range.
    fn handle_value(&self, ix: usize) -> Option<AccessibilityValue> {
        let entry = self.entry(*self.ids.get(ix)?)?;
        let size = *self.current_sizes()?.get(ix)?;
        Some(AccessibilityValue {
            min: Some(self.min_of(entry).0),
            max: entry.props.max.map(|max| max.0),
            now: Some(size.0.round()),
            text: None,
        })
    }

    /// The handle after panel `ix` moved by `by` at once, as a whole drag
    /// (a screen reader's increment or decrement): what it changed.
    fn step(&mut self, ix: usize, by: Points) -> Option<Report> {
        self.start_drag(ix);
        self.drag(by);
        self.end_drag()
    }

    /// A drag of the handle after panel `ix` begins, from the sizes now.
    fn start_drag(&mut self, ix: usize) {
        if ix + 1 >= self.ids.len() {
            return;
        }
        let Some(sizes) = self.current_sizes() else {
            return;
        };
        let mut state = ResizableState::new(self.axis);
        state.sync_panels_count(self.axis, sizes.len());
        state.set_container_size(sizes.iter().fold(Points::ZERO, |sum, &s| sum + s));
        for (i, (&id, &size)) in self.ids.iter().zip(&sizes).enumerate() {
            if let Some(entry) = self.entry(id) {
                let range = self.min_of(entry)..entry.props.range().end;
                state.update_panel(i, Some(size), range, entry.fixed());
            }
        }
        state.start_resizing(ix);
        let flexible: Vec<u64> = self
            .ids
            .iter()
            .copied()
            .filter(|&id| self.entry(id).is_some_and(|e| e.wanted().is_none()))
            .collect();
        self.drag = Some(DragState {
            ix,
            from: sizes[ix],
            before: sizes,
            state,
            flexible: (flexible.len() == 1).then(|| flexible[0]),
        });
    }

    /// The drag moved by `by`: the panels it resizes want their new
    /// sizes.
    fn drag(&mut self, by: Points) {
        let Some(drag) = &mut self.drag else {
            return;
        };
        drag.state.resize_panel_at_handle(drag.ix, drag.from + by);
        let sizes = drag.state.sizes().to_vec();
        let (before, flexible) = (drag.before.clone(), drag.flexible);
        for ((&id, &now), &was) in self.ids.iter().zip(&sizes).zip(&before) {
            if now == was || Some(id) == flexible {
                continue;
            }
            if let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) {
                entry.dragged = Some(now);
            }
        }
        self.expected = Some(sizes);
    }

    /// The drag ended: every visible panel's size, and the panels whose
    /// size it changed with their new one; nothing when it changed none.
    fn end_drag(&mut self) -> Option<Report> {
        let drag = self.drag.take()?;
        let sizes = self.expected.clone().unwrap_or_else(|| drag.before.clone());
        let changed = self
            .ids
            .iter()
            .zip(&sizes)
            .zip(&drag.before)
            .filter(|((_, now), before)| now != before)
            .filter_map(|((&id, &now), _)| self.entry(id).map(|e| (e.emit.clone(), now)))
            .collect::<Vec<_>>();
        // A press that moved nothing reports nothing.
        (!changed.is_empty()).then_some((sizes, changed))
    }
}

/// How far a screen reader's increment or decrement moves a handle.
const ACCESSIBILITY_STEP: Points = px(10.0);

/// Where a handle goes: the boundary after panel `index`, its band
/// starting `at` along the axis.
#[derive(Debug, Clone, Copy, PartialEq)]
struct HandleSpot {
    axis: Axis,
    index: usize,
    at: Points,
}

/// How a panel is laid out along the group's axis.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PanelFlex {
    axis: Axis,
    hidden: bool,
    /// `None`: none of its own, so 0: the panels without a size share
    /// the space evenly whatever their content (`flex: 1`), as
    /// `gpui-base`'s unconstrained slots do.
    basis: Option<Points>,
    grow: f32,
    shrink: f32,
    min: Points,
    max: Option<Points>,
}

impl Default for PanelFlex {
    fn default() -> Self {
        Self {
            axis: Axis::Horizontal,
            hidden: false,
            basis: None,
            grow: 1.0,
            shrink: 1.0,
            min: PANEL_MIN_SIZE,
            max: None,
        }
    }
}

impl PanelFlex {
    fn apply(self, s: StyleRefinement) -> StyleRefinement {
        if self.hidden {
            return s.hidden();
        }
        let s = s.flex_grow(self.grow).flex_shrink(self.shrink);
        let s = s.basis(self.basis.unwrap_or(Points::ZERO));
        match (self.axis, self.max) {
            (Axis::Horizontal, max) => {
                let s = s.min_w(self.min);
                match max {
                    Some(max) => s.max_w(max),
                    None => s,
                }
            }
            (Axis::Vertical, max) => {
                let s = s.min_h(self.min);
                match max {
                    Some(max) => s.max_h(max),
                    None => s,
                }
            }
        }
    }
}
