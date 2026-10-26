//! Applies mount items to the views, in order. Each kind of content has
//! its module ([`crate::text`], [`crate::image`], [`crate::scroll`],
//! [`crate::text_input`], [`crate::navigation`], ...); this file only
//! keeps the view table and the tree.

use std::{cell::RefCell, rc::Rc};

use nsh_core::{Command, LayoutAnimation, MountItem, NodeId, ROOT_ID, ViewKind};
use rustc_hash::FxHashMap;

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
        self.views.insert(ROOT_ID, root);
        self.layout_animation = None;
    }

    /// The batch is applied.
    pub(crate) fn end_batch(&mut self, surface: &Rc<Surface>) {
        self.layout_animation = None;
        crate::selection_area::end_batch(surface);
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
                | MountItem::ProjectRoot { .. }
                | MountItem::Remove { .. }
                | MountItem::Delete { .. }
                | MountItem::ViewProps { .. }
        ) {
            crate::selection_area::tree_changed();
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
            MountItem::Insert {
                parent,
                child,
                before,
            } => self.insert(surface, *parent, *child, *before),
            MountItem::ProjectRoot {
                parent,
                id,
                following,
            } => {
                let before =
                    self.views
                        .get(*parent)
                        .zip(self.views.get(*id))
                        .and_then(|(parent, child)| {
                            if matches!(
                                child.kind(),
                                ViewKind::Modal | ViewKind::HeaderItem | ViewKind::InputAccessory
                            ) {
                                return None;
                            }
                            following.iter().find_map(|id| {
                                let candidate = self.views.get(*id)?;
                                (candidate.parent_view().as_ref() == Some(&parent)
                                    && !matches!(
                                        candidate.kind(),
                                        ViewKind::Modal
                                            | ViewKind::HeaderItem
                                            | ViewKind::InputAccessory
                                    )
                                    && (child.kind() != ViewKind::Screen
                                        || candidate.kind() == ViewKind::Screen))
                                    .then_some(*id)
                            })
                        });
                self.insert(surface, *parent, *id, before);
            }
            MountItem::RetireListCell { id, request, roots } => {
                let path = surface.focus_path();
                if roots.iter().any(|id| path.contains(id)) {
                    surface.control(|control| {
                        control.set_focus_path(path);
                        control.retire_list_cell(*id, *request, false);
                    });
                    return;
                }
                for root in roots {
                    let Some(view) = &self.get(*root) else {
                        continue;
                    };
                    crate::text_input::retire_cell(view);
                    crate::input::retire_cell(surface, view);
                    crate::scroll::detached(surface, view);
                    crate::selection_area::tree_changed();
                    // A native child window must stop receiving input before
                    // Core is allowed to release this row's current owner.
                    crate::native::detached(view);
                    crate::navigation::park_retired_root(surface, view);
                }
                surface.control(|control| control.retire_list_cell(*id, *request, true));
            }
            // The roots were synchronously parked before our true reply.
            MountItem::ListCellRetired { .. } => {}
            MountItem::Remove { id } => {
                if let Some(view) = &self.get(*id) {
                    crate::navigation::removing(surface, view);
                    // A removal animation detaches the view when it ends.
                    if !crate::transition::removing(surface, view, self.layout_animation.as_ref()) {
                        self.detach(surface, view);
                    }
                }
            }
            MountItem::Delete { id } => {
                crate::file_drop::deleted(surface, *id);
                if let Some(view) = self.views.remove(*id) {
                    crate::navigation::removing(surface, &view);
                    crate::navigation::deleted_parked_root(surface, &view);
                    crate::native::deleted(surface, &view);
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
                if *id == ROOT_ID {
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
                    _ => {}
                }
            }
            MountItem::ViewStyle { id, style } => {
                let Some(view) = &self.get(*id) else { return };
                let old = std::mem::replace(&mut view.state_mut().style, style.clone());
                crate::input::style_changed(view);
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
                    crate::text::set(view, text, layout, *content);
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
                mirrored,
                ..
            } => {
                if let Some(view) = &self.get(*id) {
                    crate::scroll::config(
                        surface,
                        view,
                        *horizontal,
                        *scrollbar_visible,
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
            MountItem::Command { id, command } => self.command(surface, *id, command),
            // The animator's (`Surface::apply`).
            MountItem::Animation(_)
            | MountItem::AnimationBindings { .. }
            | MountItem::ComponentPropSlots { .. } => {}
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

    /// Inserts through the existing native host for this kind of child.
    fn insert(&self, surface: &Rc<Surface>, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        let (Some(parent), Some(child)) = (&self.get(parent), &self.get(child)) else {
            return;
        };
        match child.kind() {
            ViewKind::Modal => return crate::navigation::present(surface, child),
            ViewKind::HeaderItem => return crate::navigation::header_item(surface, parent, child),
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
            Command::Focus => view.map_or((), crate::text_input::focus),
            Command::Blur => match view {
                Some(view) if view.kind() == ViewKind::Input => crate::text_input::blur(view),
                _ => crate::text_input::blur_all(surface),
            },
            Command::SetSelection { start, end } => {
                if let Some(view) = view {
                    crate::text_input::set_selection(view, *start, *end);
                }
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
            | Command::Seek(_)
            | Command::Native { .. } => {
                if let Some(view) = view {
                    crate::native::command(surface, view, command);
                }
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
        | MountItem::ComponentPropSlots { .. } => Redraw::Nothing,
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
