use std::{
    collections::{HashMap, HashSet},
    mem::{Discriminant, discriminant},
};

use nsh_core::{Command, MountBatch, MountItem, NodeId, Points, ROOT_ID, ViewKind};

use crate::{Appearance, ComponentFactory, canvas::CanvasView, view::NshView};

pub(crate) struct Mounter {
    pub(crate) animator: nsh_core::animation::Animator,
    pub(crate) responder: Option<NodeId>,
    pub(crate) views: Vec<Option<NshView>>,
    pub(crate) components: HashMap<String, ComponentFactory>,
    pub(crate) appearance: Option<Appearance>,
    pub(crate) exit: bool,
    /// The app turned the performance line on or off
    /// (`setFpsEnabled`), for the app to apply.
    pub(crate) perf_monitor: Option<bool>,
    pub(crate) keymap: std::sync::Arc<nsh_core::keymap::Keymap>,
    pub(crate) scrolled: Vec<NodeId>,
    pub(crate) dirty_stacks: Vec<NodeId>,
    pub(crate) dirty_screens: Vec<NodeId>,
    pub(crate) modals: Vec<NodeId>,
    pub(crate) pending_modals: Vec<NodeId>,
    pub(crate) back_requests: usize,
    pub(crate) focus_requests: Vec<(NodeId, bool)>,
    pub(crate) dirty_images: Vec<NodeId>,
    pub(crate) removed_images: Vec<NodeId>,
    pub(crate) image_infos: Vec<(u32, String)>,
    /// The system dialogs shown (`AlertDialog`), oldest first.
    pub(crate) dialogs: crate::dialog::Dialogs,
    /// The context menu open (`Menu.popup`), and where the pointer last was.
    pub(crate) menus: crate::menu::Menus,
    /// The scroll bars drawn in the last frame, topmost last.
    pub(crate) scroll_bars: Vec<crate::scrollbar::ScrollBar>,
    /// The Cells text was drawn on this frame (by buffer index), kept to
    /// reuse its allocation (`render.rs`).
    pub(crate) text_cells: Vec<bool>,
    /// The links of the texts drawn last that are stops of Tab
    /// (`TextLink::focus_stop`), by the span's node: no views of their own,
    /// each stands after its text view in the focus order.
    pub(crate) spans: HashMap<NodeId, crate::keyboard::Span>,
    /// The link that has the keyboard focus, which its text shows.
    pub(crate) focused_span: Option<NodeId>,
    unhandled: HashSet<Discriminant<MountItem>>,
    unsupported: HashSet<String>,
}

impl Default for Mounter {
    fn default() -> Self {
        let mut this = Self {
            animator: Default::default(),
            responder: None,
            views: Vec::new(),
            components: HashMap::new(),
            appearance: None,
            exit: false,
            perf_monitor: None,
            keymap: Default::default(),
            scrolled: Vec::new(),
            dirty_stacks: Vec::new(),
            dirty_screens: Vec::new(),
            modals: Vec::new(),
            pending_modals: Vec::new(),
            back_requests: 0,
            focus_requests: Vec::new(),
            dirty_images: Vec::new(),
            removed_images: Vec::new(),
            image_infos: Vec::new(),
            scroll_bars: Vec::new(),
            text_cells: Vec::new(),
            spans: HashMap::new(),
            focused_span: None,
            dialogs: Default::default(),
            menus: Default::default(),
            unhandled: HashSet::new(),
            unsupported: HashSet::new(),
        };
        this.insert(ROOT_ID, NshView::new(ViewKind::View));
        this
    }
}

impl Mounter {
    fn insert(&mut self, id: NodeId, view: NshView) {
        self.views
            .resize_with(self.views.len().max(id as usize + 1), || None);
        self.views[id as usize] = Some(view);
    }

    pub(crate) fn get(&self, id: NodeId) -> Option<&NshView> {
        self.views.get(id as usize)?.as_ref()
    }

    pub(crate) fn get_mut(&mut self, id: NodeId) -> Option<&mut NshView> {
        self.views.get_mut(id as usize)?.as_mut()
    }

    fn children_changed(&mut self, parent: NodeId) {
        if self
            .get(parent)
            .is_some_and(|view| view.kind == ViewKind::Stack)
            && !self.dirty_stacks.contains(&parent)
        {
            self.dirty_stacks.push(parent);
        }
        if self
            .get(parent)
            .is_some_and(|view| view.kind == ViewKind::Screen)
            && !self.dirty_screens.contains(&parent)
        {
            self.dirty_screens.push(parent);
        }
    }

    fn request_focus(&mut self, id: NodeId, focus: bool) {
        if focus {
            self.focus_requests.retain(|&(_, pending)| !pending);
        } else {
            self.focus_requests.retain(|&(pending, _)| pending != id);
        }
        self.focus_requests.push((id, focus));
    }

    fn cancel_subtree_focus(&mut self, root: NodeId) {
        if self.focus_requests.is_empty() {
            return;
        }
        let mut pending = std::mem::take(&mut self.focus_requests);
        pending.retain(|&(id, focus)| !focus || !crate::keyboard::contains(self, root, id));
        self.focus_requests = pending;
    }

    fn detach(&mut self, id: NodeId) {
        self.cancel_subtree_focus(id);
        self.modals.retain(|&modal| modal != id);
        self.pending_modals.retain(|&modal| modal != id);
        let parent = self.get_mut(id).and_then(|view| {
            if matches!(view.kind, ViewKind::Screen | ViewKind::HeaderItem) {
                view.concealed = true;
            }
            view.parent.take()
        });
        if let Some(parent) = parent {
            if let Some(view) = self.get_mut(parent) {
                view.children.retain(|&child| child != id);
            }
            self.children_changed(parent);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.animator = Default::default();
        self.responder = None;
        self.focus_requests.clear();
        self.scroll_bars.clear();
        self.dialogs.clear();
        self.menus.reset();
        self.spans.clear();
        self.focused_span = None;
        self.views.clear();
        self.insert(ROOT_ID, NshView::new(ViewKind::View));
        self.appearance = None;
        self.exit = false;
        self.keymap = Default::default();
        self.unhandled.clear();
        self.unsupported.clear();
        self.scrolled.clear();
        self.dirty_stacks.clear();
        self.dirty_screens.clear();
        self.modals.clear();
        self.pending_modals.clear();
        self.back_requests = 0;
        self.dirty_images.clear();
        self.removed_images.clear();
        self.image_infos.clear();
    }

    pub(crate) fn apply(&mut self, batch: MountBatch) {
        // The scroll views whose viewport or content changed: their offset
        // is pulled back within the content once the batch is applied.
        let mut resized: Vec<NodeId> = Vec::new();
        for item in batch.items {
            self.animator.apply(&item);
            match item {
                MountItem::Gestures { id, values } => {
                    if let Some(view) = self.get_mut(id) {
                        view.gestures = values;
                    }
                }
                MountItem::Animation(_) | MountItem::LayoutAnimation(_) => {}
                MountItem::AnimationBindings { id, .. } => {
                    if let Some(view) = self.get_mut(id) {
                        view.animated = Default::default();
                        if let Some(canvas) = &mut view.canvas {
                            canvas.args.clear();
                        }
                    }
                }
                MountItem::Create { id, kind } => {
                    if !matches!(
                        kind,
                        ViewKind::View
                            | ViewKind::Text
                            | ViewKind::Image
                            | ViewKind::Canvas
                            | ViewKind::Native
                            | ViewKind::Input
                            | ViewKind::Scroll
                            | ViewKind::Stack
                            | ViewKind::Screen
                            | ViewKind::HeaderItem
                            | ViewKind::Modal
                            | ViewKind::InputAccessory
                    ) && self.unsupported.insert(format!("{kind:?}"))
                    {
                        log::warn!(
                            "terminal: {kind:?} is not supported in the terminal and is left out"
                        );
                    }
                    self.insert(id, NshView::new(kind));
                }
                MountItem::Insert {
                    parent,
                    child,
                    before,
                } => {
                    // There is no software keyboard to show it over, as on the desktops.
                    if self
                        .get(child)
                        .is_some_and(|view| view.kind == ViewKind::InputAccessory)
                    {
                        continue;
                    }
                    let was_attached = self.get(child).is_some_and(|v| v.parent.is_some());
                    let modal_position = self.modals.iter().position(|&id| id == child);
                    self.detach(child);
                    if self.get(parent).is_none() || self.get(child).is_none() {
                        continue;
                    }
                    self.get_mut(child).unwrap().parent = Some(parent);
                    let siblings = &mut self.get_mut(parent).unwrap().children;
                    let index = before
                        .and_then(|b| siblings.iter().position(|&id| id == b))
                        .unwrap_or(siblings.len());
                    siblings.insert(index, child);
                    self.children_changed(parent);
                    if self.get(child).is_some_and(|v| v.image.is_some())
                        && !self.dirty_images.contains(&child)
                    {
                        self.dirty_images.push(child);
                    }
                    if let Some(view) = self.get_mut(child)
                        && let Some(modal) = &mut view.modal
                    {
                        if !was_attached {
                            modal.closed = false;
                            modal.shown = false;
                            modal.reported = Default::default();
                        }
                        view.concealed = modal.closed;
                        if let Some(index) = modal_position {
                            self.modals.insert(index.min(self.modals.len()), child);
                        } else {
                            self.pending_modals.push(child);
                        }
                    }
                }
                MountItem::Remove { id } => {
                    if self.get(id).is_some_and(|v| v.image.is_some()) {
                        self.removed_images.push(id);
                    }
                    self.detach(id);
                }
                MountItem::Delete { id } => {
                    if self.get(id).is_some_and(|v| v.image.is_some()) {
                        self.removed_images.push(id);
                    }
                    self.detach(id);
                    if let Some(slot) = self.views.get_mut(id as usize) {
                        *slot = None;
                    }
                }
                MountItem::Frame { id, frame } => {
                    let mut dirty_image = false;
                    if let Some(view) = self.get_mut(id) {
                        if view.scroll.is_some()
                            && view.frame.size != frame.size
                            && !resized.contains(&id)
                        {
                            resized.push(id);
                        }
                        dirty_image = view.image.is_some() && view.frame.size != frame.size;
                        view.frame = frame;
                    }
                    if dirty_image && !self.dirty_images.contains(&id) {
                        self.dirty_images.push(id);
                    }
                }
                MountItem::ViewStyle { id, style } => {
                    if let Some(view) = self.get_mut(id) {
                        view.style = *style;
                        if view.states & nsh_core::tailwind::state::HOVERED == 0 {
                            view.rest_fill = view.style.background_color;
                        }
                    }
                }
                MountItem::ViewProps { id, props } => {
                    if let Some(view) = self.get_mut(id) {
                        view.props = *props;
                    }
                }
                MountItem::Keymap(keymap) => self.keymap = keymap,
                MountItem::Command {
                    id,
                    command: Command::SetJsResponder { block },
                } => {
                    self.responder = block.then_some(id);
                }
                MountItem::Command {
                    command: Command::ClearJsResponder,
                    ..
                } => self.responder = None,
                MountItem::Input { id, config } => {
                    if let Some(view) = self.get_mut(id) {
                        let auto_focus = config.auto_focus && view.input.is_none();
                        view.input = Some(config);
                        if auto_focus {
                            self.request_focus(id, true);
                        }
                    }
                }
                MountItem::InputValue { id, text, count } => {
                    if let Some(field) = self.get_mut(id).and_then(|v| v.field.as_mut()) {
                        field.set_value(&text, count);
                    }
                }
                MountItem::InputContent { id, content } => {
                    if let Some(field) = self.get_mut(id).and_then(|v| v.field.as_mut()) {
                        field.content = content;
                    }
                }
                MountItem::Command {
                    id,
                    command: Command::SetSelection { start, end },
                } => {
                    if let Some(field) = self.get_mut(id).and_then(|v| v.field.as_mut()) {
                        field.select(start, end);
                    }
                }
                MountItem::Command {
                    id,
                    command: Command::Focus,
                } => self.request_focus(id, true),
                MountItem::Command {
                    id,
                    command: Command::Blur,
                } => self.request_focus(id, false),
                MountItem::TrackStates { id, states } => {
                    if let Some(view) = self.get_mut(id) {
                        view.tracked = states;
                        // The focus is reported whatever the view tracks.
                        view.states &= nsh_core::input::reported_states(states);
                    }
                }
                MountItem::ProjectStates { id, states } => {
                    if let Some(view) = self.get_mut(id) {
                        view.projected = states;
                    }
                }
                MountItem::Events { id, events } => {
                    let mut dirty_image = false;
                    if let Some(view) = self.get_mut(id) {
                        dirty_image = view.image.is_some() && view.events != events;
                        view.events = events;
                    }
                    if dirty_image && !self.dirty_images.contains(&id) {
                        self.dirty_images.push(id);
                    }
                }
                MountItem::Text {
                    id,
                    layout,
                    content,
                    text,
                } => {
                    if let Some(view) = self.get_mut(id) {
                        view.text_content = Some(text);
                        view.text = Some((layout, content));
                    }
                }
                MountItem::Canvas { id, drawing } => {
                    if let Some(view) = self.get_mut(id) {
                        match &mut view.canvas {
                            Some(canvas) => canvas.drawing = drawing,
                            None => view.canvas = Some(Box::new(CanvasView::new(drawing))),
                        }
                    }
                }
                MountItem::ScrollConfig {
                    id,
                    horizontal,
                    scrollbar_visible,
                    replaced,
                    mirrored,
                    ..
                } => {
                    if let Some(scroll) = self.get_mut(id).and_then(|view| view.scroll.as_mut()) {
                        scroll.horizontal = horizontal;
                        // A bar of the app's own (a themed `Scrollbar`) is
                        // drawn as the terminal's: `nsh/base`'s Scrollbar
                        // shows nothing in the terminal idiom.
                        scroll.indicator = scrollbar_visible || replaced;
                        scroll.mirrored = mirrored;
                    }
                }
                MountItem::Image {
                    id,
                    source,
                    resize_mode,
                    options,
                } => {
                    if let Some(view) = self.get_mut(id) {
                        view.image = Some(crate::image::ImageMount {
                            source,
                            resize_mode,
                            options,
                        });
                        if !self.dirty_images.contains(&id) {
                            self.dirty_images.push(id);
                        }
                    }
                }
                MountItem::Command {
                    command: Command::ImageInfo { id, uri },
                    ..
                } => self.image_infos.push((id, uri)),
                MountItem::ScrollContent { id, size } => {
                    if let Some(scroll) = self.get_mut(id).and_then(|view| view.scroll.as_mut()) {
                        scroll.content = size;
                        if !resized.contains(&id) {
                            resized.push(id);
                        }
                    }
                }
                MountItem::ScrollBehavior { id, behavior } => {
                    if let Some(scroll) = self.get_mut(id).and_then(|view| view.scroll.as_mut()) {
                        scroll.behavior = *behavior;
                    }
                }
                MountItem::ScrollBy { id, dx, dy } => {
                    if let Some(scroll) = self.get_mut(id).and_then(|view| view.scroll.as_mut()) {
                        // Core anchoring moves with content changes; it must not be clamped.
                        if scroll.horizontal {
                            scroll.x += dx;
                        } else {
                            scroll.y += dy;
                        }
                        scroll.applied = scroll.applied.wrapping_add(1);
                        if !self.scrolled.contains(&id) {
                            self.scrolled.push(id);
                        }
                    }
                }
                MountItem::Command {
                    id,
                    command: Command::ScrollTo { x, y, .. },
                } if self.get(id).is_some_and(|view| view.scroll.is_some()) => {
                    if let Some(view) = self.get_mut(id)
                        && let Some(scroll) = &mut view.scroll
                    {
                        let max = scroll.max(view.frame.size);
                        if scroll.horizontal {
                            scroll.x = (x + scroll.behavior.content_inset.left)
                                .max(Points::ZERO)
                                .min(max.x);
                        } else {
                            scroll.y = (y + scroll.behavior.content_inset.top)
                                .max(Points::ZERO)
                                .min(max.y);
                        }
                        scroll.applied = scroll.applied.wrapping_add(1);
                        if !self.scrolled.contains(&id) {
                            self.scrolled.push(id);
                        }
                    }
                }
                MountItem::ModalConfig { id, config } => {
                    if let Some(modal) = self.get_mut(id).and_then(|v| v.modal.as_mut()) {
                        modal.config = config;
                    }
                }
                MountItem::Command {
                    command: Command::Back,
                    ..
                } => self.back_requests += 1,
                MountItem::ScreenConfig { id, config } => {
                    if let Some(screen) = self.get_mut(id).and_then(|view| view.screen.as_mut()) {
                        screen.config = *config;
                        if !self.dirty_screens.contains(&id) {
                            self.dirty_screens.push(id);
                        }
                    }
                }
                MountItem::Appearance { appearance } => self.appearance = Some(appearance),
                MountItem::Component { id, name } => {
                    let component = self.components.get(name.as_ref()).map(|factory| factory());
                    if component.is_none() && self.unsupported.insert(name.to_string()) {
                        log::warn!(
                            "terminal: native component {name} is not supported in the terminal and is left out"
                        );
                    }
                    if let Some(view) = self.get_mut(id) {
                        view.component = component;
                        view.component_name = Some(name.to_string());
                    }
                }
                MountItem::ComponentProps { id, props } => {
                    if let Some(component) = self.get_mut(id).and_then(|v| v.component.as_mut()) {
                        component.set_props(&props);
                    }
                }
                MountItem::Command {
                    command: Command::ExitApp,
                    ..
                } => self.exit = true,
                MountItem::Command {
                    command: Command::PerfMonitor(enabled),
                    ..
                } => self.perf_monitor = Some(enabled),
                // `Application.quit()`: the app ends, as with a menu's quit role.
                MountItem::Command {
                    command: Command::Desktop(ref desktop),
                    ..
                } if **desktop == nsh_core::desktop::DesktopCommand::Quit => self.exit = true,
                // The app's design tokens, for the platform's own controls
                // (Linux's menus, iOS's and Android's alerts). The
                // terminal's own controls (menus, the menu bar, system
                // dialogs, the focus) are drawn in the terminal theme's
                // colors, as its other programs are, and the app's views
                // already have the tokens resolved in the core: there is
                // nothing left for them to change here.
                MountItem::Command {
                    command: Command::Tokens(_),
                    ..
                } => {}
                MountItem::Command {
                    command: Command::Dialog(dialog),
                    ..
                } => self.dialogs.show(*dialog),
                MountItem::Command {
                    command: Command::Desktop(ref desktop),
                    ..
                } if matches!(
                    **desktop,
                    nsh_core::desktop::DesktopCommand::PopupMenu { .. }
                        | nsh_core::desktop::DesktopCommand::SetMenu(_)
                        | nsh_core::desktop::DesktopCommand::SetMenuBar(_)
                ) =>
                {
                    match &**desktop {
                        nsh_core::desktop::DesktopCommand::PopupMenu { items, at } => {
                            self.menus.popup(items, *at);
                        }
                        nsh_core::desktop::DesktopCommand::SetMenu(items) => {
                            self.menus.set_application_menu(items.as_deref());
                        }
                        nsh_core::desktop::DesktopCommand::SetMenuBar(mode) => {
                            self.menus.set_menu_bar(*mode);
                        }
                        _ => {}
                    }
                }
                MountItem::Command { id, ref command }
                    if self
                        .get_mut(id)
                        .and_then(|v| v.component.as_mut())
                        .is_some_and(|c| c.command(command)) => {}
                MountItem::AccessibilityLabel { id, label } => {
                    if let Some(view) = self.get_mut(id) {
                        view.props.accessibility.label = label;
                    }
                }
                // Text, layout and accessibility already have their core representation.
                MountItem::TreeOrder(nodes) => {
                    for (order, id) in nodes.into_iter().enumerate() {
                        if let Some(view) = self.get_mut(id) {
                            view.tree_order = order;
                        }
                    }
                }
                MountItem::Overflow { .. } | MountItem::LayoutDirection { .. } => {}
                other => {
                    if self.unhandled.insert(discriminant(&other)) {
                        log::warn!("terminal: mount operation not implemented: {other:?}");
                    }
                }
            }
        }
        for id in resized {
            self.pull_back(id);
        }
        crate::navigation::end_batch(self);
    }

    /// Scroll view `id` past the end of its content (the viewport grew, a
    /// terminal made taller, or the content shrank) is pulled back to it,
    /// as the GUI platforms' scroll views clamp their offset: no blank rows
    /// below the content's end. After the whole batch, so the `ScrollBy`
    /// that keeps the visible content in place is applied first.
    fn pull_back(&mut self, id: NodeId) {
        let Some(view) = self.get_mut(id) else {
            return;
        };
        let size = view.frame.size;
        let Some(scroll) = view.scroll.as_mut() else {
            return;
        };
        let max = scroll.max(size);
        let moved = if scroll.horizontal {
            (scroll.x > max.x).then(|| scroll.x = max.x)
        } else {
            (scroll.y > max.y).then(|| scroll.y = max.y)
        };
        if moved.is_some() && !self.scrolled.contains(&id) {
            self.scrolled.push(id);
        }
    }
}
