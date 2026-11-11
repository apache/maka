//! Applies mount items to the views, in order. Each kind of content has
//! its module ([`crate::text`], [`crate::image`], [`crate::scroll`],
//! [`crate::text_input`], [`crate::navigation`], ...); this file only
//! keeps the view table and the tree.

use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    Command, LayoutAnimation, MountItem, NodeId, ROOT_ID, ViewKind, desktop::DesktopCommand,
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{surface::Surface, view::NshView};

/// Every live view of a surface by node id (the root included).
///
/// Shared by the mounter and the surface: looking a view up never needs
/// the mounter, which a batch holds while it is applied, so modules may
/// find views from any callback (an image that was already cached
/// answers while the item that asked for it is applied).
#[derive(Default)]
pub(crate) struct Views(RefCell<FxHashMap<NodeId, NshView>>);

impl Views {
    /// The view of node `id`.
    pub(crate) fn get(&self, id: NodeId) -> Option<NshView> {
        self.0.borrow().get(&id).cloned()
    }

    fn insert(&self, id: NodeId, view: NshView) {
        self.0.borrow_mut().insert(id, view);
    }

    fn remove(&self, id: NodeId) -> Option<NshView> {
        self.0.borrow_mut().remove(&id)
    }

    fn take(&self) -> FxHashMap<NodeId, NshView> {
        std::mem::take(&mut *self.0.borrow_mut())
    }
}

/// The views of a surface.
pub(crate) struct Mounter {
    /// Every live view by node id (the root included).
    pub(crate) views: Rc<Views>,
    /// The root view.
    pub(crate) root: NshView,
    /// Rejected OS-window roots stay detached instead of becoming terminal dialogs.
    terminal_windows: FxHashSet<NodeId>,
    /// Animates the frame changes, insertions and removals of the rest of
    /// the batch.
    pub(crate) layout_animation: Option<LayoutAnimation>,
    /// The surface lays out right to left.
    pub(crate) rtl: bool,
}

impl Mounter {
    pub(crate) fn new(root: NshView) -> Self {
        let views = Rc::new(Views::default());
        views.insert(ROOT_ID, root.clone());
        Mounter {
            views,
            root,
            terminal_windows: FxHashSet::default(),
            layout_animation: None,
            rtl: false,
        }
    }

    /// Removes every view but the root.
    pub(crate) fn clear(&mut self) {
        for child in self.root.child_views() {
            child.unparent();
        }
        let root = self.root.clone();
        for (_, view) in self.views.take() {
            if view != root {
                view.unparent();
            }
        }
        // A screen effect's or transition's layer is the root's: it goes
        // with the views that mounted it.
        root.state_mut().shader = None;
        self.views.insert(ROOT_ID, root);
        self.terminal_windows.clear();
        self.layout_animation = None;
    }

    /// The batch is applied.
    pub(crate) fn end_batch(&mut self, surface: &Rc<Surface>) {
        self.layout_animation = None;
        crate::text_input::end_batch(surface);
        crate::selectable_view::end_batch(surface);
        crate::navigation::end_batch(surface);
        crate::system::end_batch(surface);
    }

    fn get(&self, id: NodeId) -> Option<NshView> {
        let view = self.views.get(id);
        if view.is_none() {
            log::debug!("mount: no view {id}");
        }
        view
    }

    pub(crate) fn apply(&mut self, surface: &Rc<Surface>, item: &MountItem) {
        if matches!(
            item,
            MountItem::Text { .. }
                | MountItem::Insert { .. }
                | MountItem::Remove { .. }
                | MountItem::Delete { .. }
                | MountItem::ViewProps { .. }
                | MountItem::Frame { .. }
                | MountItem::ViewStyle { .. }
        ) {
            crate::selectable_view::tree_changed();
        }
        match item {
            MountItem::Create { id, kind } => {
                let view = NshView::new(*id, *kind);
                crate::access::created(&view);
                match kind {
                    ViewKind::Input => crate::text_input::create(surface, &view),
                    ViewKind::Canvas => crate::canvas::create(&view),
                    ViewKind::Image => crate::image::create(&view),
                    ViewKind::WebView | ViewKind::Video | ViewKind::Native => {
                        crate::native::create(surface, &view)
                    }
                    _ => {}
                }
                self.views.insert(*id, view);
            }
            MountItem::TrackStates { id, states } => {
                if let Some(view) = &self.get(*id) {
                    crate::input::track_states(surface, view, *states);
                }
            }
            MountItem::Insert { child, .. } if self.terminal_windows.contains(child) => {}
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                let (Some(parent), Some(child)) = (&self.get(*parent), &self.get(*child)) else {
                    return;
                };
                match child.kind() {
                    ViewKind::Modal => return crate::navigation::present(surface, child),
                    ViewKind::HeaderItem => {
                        return crate::navigation::header_item(surface, parent, child);
                    }
                    ViewKind::InputAccessory => {
                        return crate::text_input::accessory(surface, parent, child);
                    }
                    _ => {}
                }
                let before = before
                    .and_then(|id| self.views.get(id))
                    .filter(|before| before.parent_view().as_ref() == Some(parent));
                child.insert_before(parent, before.as_ref());
                crate::transition::inserted(surface, child, self.layout_animation.as_ref());
                if parent.kind() == ViewKind::Stack {
                    crate::navigation::stack_changed(surface, parent, Some(child));
                }
                if parent.kind() == ViewKind::Scroll {
                    crate::scroll::child_inserted(parent);
                }
            }
            MountItem::Remove { id } => {
                if let Some(view) = &self.get(*id) {
                    crate::input::removing(surface, view);
                    crate::text_input::removing(surface, view);
                    crate::navigation::removing(surface, view);
                    // A removal animation detaches the view when it ends.
                    if !crate::transition::removing(surface, view, self.layout_animation.as_ref()) {
                        self.detach(surface, view);
                    }
                }
            }
            MountItem::Delete { id } => {
                self.terminal_windows.remove(id);
                crate::file_drop::deleted(surface, *id);
                if let Some(view) = self.views.remove(*id) {
                    crate::input::removing(surface, &view);
                    crate::text_input::removing(surface, &view);
                    crate::navigation::removing(surface, &view);
                    crate::native::deleted(surface, &view);
                    crate::shader::deleted(surface, &view);
                    crate::navigation::deleted(surface, &view);
                    // A removal animation detaches the view when it ends.
                    if !crate::transition::removing(surface, &view, self.layout_animation.as_ref())
                    {
                        crate::transition::deleted(&view);
                        self.detach(surface, &view);
                    }
                }
            }
            MountItem::Frame { id, frame } => {
                let Some(view) = &self.get(*id) else { return };
                // A window's root takes its window's size, which the core
                // lays it out at (`set_root_size`).
                if *id == ROOT_ID || crate::app_window::is_window(surface, *id) {
                    return;
                }
                let mut frame = *frame;
                if view.kind() == ViewKind::Modal {
                    // Where a modal sits is navigation's (over the whole
                    // window): the core only sizes it.
                    let old = view.state().frame;
                    (frame.origin.x.0, frame.origin.y.0) = (old.origin.x.0, old.origin.y.0);
                }
                let frame = &frame;
                // Compared with where a running layout animation is headed,
                // not with the in-between frame it shows: a frame set back
                // to the shown one must still stop the animation.
                let target = crate::transition::frame_target(view);
                if target.unwrap_or(view.state().frame) == *frame {
                    return;
                }
                let old = std::mem::replace(&mut view.state_mut().frame, *frame);
                view.moved();
                crate::transition::frame_changed(
                    surface,
                    view,
                    old,
                    self.layout_animation.as_ref(),
                );
                match view.kind() {
                    ViewKind::Stack => crate::navigation::stack_resized(surface, view),
                    ViewKind::Scroll => crate::scroll::resized(surface, view),
                    ViewKind::Canvas => view.changed(),
                    ViewKind::WebView | ViewKind::Video | ViewKind::Native => {
                        crate::native::resized(view)
                    }
                    ViewKind::Image => {
                        crate::shader::resized(surface, view);
                        crate::image::resized(surface, view);
                    }
                    _ => crate::shader::resized(surface, view),
                }
            }
            MountItem::ViewStyle { id, style } => {
                let Some(view) = &self.get(*id) else { return };
                let old = std::mem::replace(&mut view.state_mut().style, style.clone());
                if !old.hidden && style.hidden {
                    crate::text_input::removing(surface, view);
                }
                crate::input::style_changed(view);
                if old.cursor != style.cursor {
                    crate::input::cursor_changed(surface);
                }
                crate::transition::style_changed(surface, view, &old);
                crate::access::style_changed(view, &old);
                view.moved();
            }
            MountItem::Text {
                id,
                text,
                layout,
                content,
            } => {
                if let Some(view) = &self.get(*id) {
                    let old = view.state().text.as_ref().map(|t| t.text.clone());
                    crate::text::set(view, text, layout, *content);
                    if let Some(old) = old {
                        crate::transition::text_changed(surface, view, &old, text);
                    }
                    crate::access::text_changed(view);
                }
            }
            MountItem::Events { id, events } => {
                if let Some(view) = &self.get(*id) {
                    view.state_mut().events = *events;
                    crate::input::events_changed(surface, view);
                    crate::file_drop::events_changed(surface, view);
                    crate::access::events_changed(view);
                }
            }
            MountItem::Image {
                id,
                source,
                resize_mode,
                options,
            } => {
                if let Some(view) = &self.get(*id) {
                    crate::image::set(surface, view, source.as_ref(), *resize_mode, options);
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
                if let Some(view) = &self.get(*id) {
                    crate::scroll::config(
                        surface,
                        view,
                        *horizontal,
                        *scrollbar_visible,
                        *replaced,
                        *mirrored,
                    );
                }
            }
            MountItem::ScrollContent { id, size } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::content(surface, view, *size);
                }
            }
            MountItem::ScrollBy { id, dx, dy } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::scroll_by(surface, view, dx.0, dy.0);
                }
            }
            MountItem::LayoutDirection { rtl } => self.rtl = *rtl,
            MountItem::Overflow { id, extent } => {
                if let Some(view) = &self.get(*id) {
                    view.state_mut().overflow = *extent;
                }
            }
            MountItem::Appearance { appearance } => {
                crate::system::set_appearance(surface, *appearance);
            }
            MountItem::Keymap(keymap) => crate::keymap::set(surface, keymap.clone()),
            MountItem::AccessibilityLabel { id, label } => {
                if let Some(view) = &self.get(*id) {
                    crate::access::label(view, label);
                }
            }
            MountItem::StickyCells { id, cells } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::sticky(surface, view, cells.clone());
                }
            }
            MountItem::ScrollBehavior { id, behavior } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::behavior(surface, view, behavior);
                }
            }
            MountItem::Refreshing { id, refreshing } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::refreshing(surface, view, *refreshing);
                }
            }
            MountItem::Canvas { id, drawing } => {
                if let Some(view) = &self.get(*id) {
                    crate::canvas::set(surface, view, drawing.clone());
                }
            }
            MountItem::Shader { id, layer } => {
                if let Some(view) = &self.get(*id) {
                    crate::shader::set(surface, view, layer.clone());
                }
            }
            // A shader's pictures are taken as the window draws.
            MountItem::ShaderInput { .. } => {}
            MountItem::ShaderTransition { id, duration } => {
                if let Some(view) = &self.get(*id) {
                    crate::shader::start_transition(surface, view, *duration);
                }
            }
            MountItem::NavShader { id, shader } => {
                crate::navigation::nav_shader(surface, *id, shader.clone());
            }
            MountItem::Gestures { id, values } => {
                if let Some(view) = &self.get(*id) {
                    crate::input::gestures(surface, view, *values);
                }
            }
            MountItem::ViewProps { id, props } => {
                let Some(view) = &self.get(*id) else { return };
                view.state_mut().props = props.clone();
                crate::input::props_changed(surface, view);
                crate::access::props_changed(view);
            }
            MountItem::LayoutAnimation(a) => self.layout_animation = Some(*a),
            MountItem::Input { id, config } => {
                if let Some(view) = &self.get(*id) {
                    crate::text_input::config(surface, view, config);
                }
            }
            MountItem::InputValue { id, text, count } => {
                if let Some(view) = &self.get(*id) {
                    crate::text_input::value(view, text, *count);
                }
            }
            MountItem::InputContent { id, content } => {
                if let Some(view) = &self.get(*id) {
                    crate::text_input::content(view, *content);
                }
            }
            MountItem::ScreenConfig { id, config } => {
                if let Some(view) = &self.get(*id) {
                    crate::navigation::screen_config(surface, view, config);
                }
            }
            MountItem::ModalConfig { id, .. } if self.terminal_windows.contains(id) => {}
            MountItem::ModalConfig { id, config } => {
                if let Some(view) = &self.get(*id) {
                    crate::navigation::modal_config(surface, view, config);
                }
            }
            MountItem::NativeProps { id, props } => {
                if let Some(view) = &self.get(*id) {
                    crate::native::props(surface, view, props);
                }
            }
            MountItem::Component { id, name } => {
                if let Some(view) = &self.get(*id) {
                    crate::native::component(surface, view, name);
                }
            }
            MountItem::ComponentProps { id, props } => {
                if let Some(view) = &self.get(*id) {
                    crate::native::component_props(surface, view, props);
                }
            }
            // Pixel terminals use desktop layout, not OS shell integration.
            MountItem::Command {
                id,
                command: Command::Desktop(command),
            } if surface.terminal_active.get().is_some() => {
                if *id != ROOT_ID && matches!(command.as_ref(), DesktopCommand::OpenWindow(_)) {
                    self.terminal_windows.insert(*id);
                    if let Some(view) = self.get(*id) {
                        crate::navigation::release(surface, &view);
                    }
                }
            }
            MountItem::Command { id, command } => self.command(surface, *id, command),
            // The animator's (`Surface::apply`).
            MountItem::Animation(_)
            | MountItem::AnimationBindings { .. }
            | MountItem::ComponentPropSlots { .. }
            | MountItem::TreeOrder(_)
            | MountItem::ProjectStates { .. } => {}
        }
        // What the item may change on screen is drawn again, whether or not
        // what applied it said so: a partial frame draws only that.
        match redrawn(item) {
            Redraw::Nothing => {}
            Redraw::View(id) => {
                if let Some(view) = self.views.get(id) {
                    view.changed();
                }
            }
            Redraw::Window => surface.invalidate(),
        }
    }

    /// Takes `view` out of its parent (a modal is dismissed).
    pub(crate) fn detach(&self, surface: &Rc<Surface>, view: &NshView) {
        match view.kind() {
            ViewKind::Modal => return crate::navigation::dismiss(surface, view),
            ViewKind::HeaderItem => return crate::navigation::header_item_removed(surface, view),
            _ => {}
        }
        let parent = view.parent_view();
        view.unparent();
        if let Some(parent) = parent
            && parent.kind() == ViewKind::Stack
        {
            crate::navigation::stack_changed(surface, &parent, None);
        }
    }

    fn command(&self, surface: &Rc<Surface>, id: NodeId, command: &Command) {
        let view = self.views.get(id);
        let view = view.as_ref();
        match command {
            Command::Focus => {
                if let Some(view) = view {
                    crate::text_input::focus_view(surface, view);
                }
            }
            Command::Blur => match view {
                Some(view) if view.kind() == ViewKind::Input => crate::text_input::blur(view),
                _ => crate::text_input::blur_all(surface),
            },
            Command::SetSelection { start, end } => {
                if let Some(view) = view {
                    crate::text_input::set_selection(view, *start, *end);
                }
            }
            // Not carried out on this platform yet: the app's paste is lost,
            // so say so.
            Command::InsertText(_) => {
                log::warn!("insertText is not supported on Windows yet; nothing inserted")
            }
            Command::ScrollTo { y, .. } if view.is_some_and(|v| v.kind() == ViewKind::Input) => {
                crate::text_input::scroll_to(view.expect("an input"), *y);
            }
            Command::ScrollTo { .. }
            | Command::ScrollToEnd { .. }
            | Command::ScrollToIndex { .. }
            | Command::ZoomTo { .. } => {
                if let Some(view) = view {
                    crate::scroll::command(surface, view, command);
                }
            }
            // Here, with the view at hand: `Surface::view` would borrow the
            // mounter again while a batch is applied.
            Command::AccessibilityFocus => {
                if let Some(view) = view {
                    crate::access::focus(surface, view);
                }
            }
            Command::ImageInfo { .. } => crate::image::command(surface, id, command),
            Command::SetJsResponder { .. } | Command::ClearJsResponder => {
                crate::input::command(surface, id, command);
            }
            Command::Reload
            | Command::GoBack
            | Command::GoForward
            | Command::StopLoading
            | Command::InjectJavaScript(_)
            | Command::PostMessage(_)
            | Command::Load(_)
            | Command::Seek(_)
            | Command::Native { .. } => {
                if let Some(view) = view {
                    crate::native::command(surface, view, command);
                }
            }
            // A window of the app's own (`Window.open`) shows dialog root
            // `id`.
            Command::Desktop(desktop) if id != ROOT_ID => {
                crate::app_window::command(surface, id, view, desktop);
            }
            other => crate::system::command(surface, id, other),
        }
    }
}

/// What a mount item may change on screen.
enum Redraw {
    Nothing,
    /// The view and its subtree.
    View(NodeId),
    /// Anything.
    Window,
}

/// What `item` may change on screen once applied. Insertions and removals
/// draw their parents again themselves ([`NshView::insert_before`],
/// [`NshView::unparent`]); a new view is drawn when it is inserted.
fn redrawn(item: &MountItem) -> Redraw {
    match item {
        MountItem::Create { .. }
        | MountItem::Insert { .. }
        | MountItem::Remove { .. }
        | MountItem::Delete { .. }
        | MountItem::TrackStates { .. }
        | MountItem::Events { .. }
        | MountItem::AccessibilityLabel { .. }
        | MountItem::Gestures { .. }
        | MountItem::Keymap(_)
        | MountItem::LayoutAnimation(_)
        | MountItem::Animation(_)
        | MountItem::AnimationBindings { .. }
        | MountItem::ComponentPropSlots { .. }
        | MountItem::TreeOrder(_)
        | MountItem::ProjectStates { .. }
        | MountItem::NavShader { .. } => Redraw::Nothing,
        MountItem::Frame { id, .. }
        | MountItem::ViewStyle { id, .. }
        | MountItem::Text { id, .. }
        | MountItem::Image { id, .. }
        | MountItem::ScrollConfig { id, .. }
        | MountItem::ScrollContent { id, .. }
        | MountItem::ScrollBy { id, .. }
        | MountItem::Overflow { id, .. }
        | MountItem::StickyCells { id, .. }
        | MountItem::ScrollBehavior { id, .. }
        | MountItem::Refreshing { id, .. }
        | MountItem::Canvas { id, .. }
        | MountItem::Shader { id, .. }
        | MountItem::ShaderInput { id }
        | MountItem::ShaderTransition { id, .. }
        | MountItem::ViewProps { id, .. }
        | MountItem::Input { id, .. }
        | MountItem::InputValue { id, .. }
        | MountItem::InputContent { id, .. }
        | MountItem::ScreenConfig { id, .. }
        | MountItem::ModalConfig { id, .. }
        | MountItem::NativeProps { id, .. }
        | MountItem::Component { id, .. }
        | MountItem::ComponentProps { id, .. }
        | MountItem::Command { id, .. } => Redraw::View(*id),
        MountItem::LayoutDirection { .. } | MountItem::Appearance { .. } => Redraw::Window,
    }
}
