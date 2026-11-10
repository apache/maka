//! Applies mount items to the views, in order. Each kind of content has
//! its module ([`crate::text`], [`crate::image`], [`crate::scroll`],
//! [`crate::text_input`], [`crate::navigation`], ...); this file only
//! keeps the view table and the tree.

use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    Command, LayoutAnimation, MountItem, NodeId, ROOT_ID, ViewKind, canvas::Damage,
    desktop::DesktopCommand,
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    sight::Sights,
    surface::Surface,
    view::{NshView, Planned, Views},
};

/// The views of a surface.
pub(crate) struct Mounter {
    /// Every live view by node id (the root included).
    pub(crate) views: FxHashMap<NodeId, NshView>,
    /// The root view.
    pub(crate) root: NshView,
    /// Rejected OS-window roots stay detached instead of becoming terminal dialogs.
    terminal_windows: FxHashSet<NodeId>,
    /// Animates the frame changes, insertions and removals of the rest of
    /// the batch.
    pub(crate) layout_animation: Option<LayoutAnimation>,
    /// The surface lays out right to left.
    pub(crate) rtl: bool,
    /// Views whose drawing changed while they could not be seen
    /// ([`Mounter::draw_when_shown`]).
    stale: RefCell<Vec<NshView>>,
    /// During a window's live resize, the views out of sight whose frames
    /// wait to be placed ([`Mounter::place_shown`]).
    unplaced: RefCell<Vec<NshView>>,
    /// Whether the window is in a live resize.
    live_resize: bool,
    /// The ancestors [`Mounter::revisit`] resolved (kept for the
    /// allocations; cleared on each pass).
    sights: RefCell<Sights<NshView>>,
    /// The same over the frames waiting to be placed
    /// ([`Mounter::place_shown`]).
    planned_sights: RefCell<Sights<NshView>>,
}

impl Mounter {
    pub(crate) fn new(root: NshView) -> Self {
        let mut views = FxHashMap::default();
        views.insert(ROOT_ID, root.clone());
        Mounter {
            views,
            root,
            terminal_windows: FxHashSet::default(),
            layout_animation: None,
            rtl: false,
            stale: RefCell::default(),
            unplaced: RefCell::default(),
            live_resize: false,
            sights: RefCell::default(),
            planned_sights: RefCell::default(),
        }
    }

    /// Removes every view but the root.
    pub(crate) fn clear(&mut self) {
        for child in self.root.child_views() {
            child.unparent();
        }
        let root = self.root.clone();
        for (_, view) in self.views.drain() {
            if view != root && view.has_parent() {
                view.unparent();
            }
        }
        self.views.insert(ROOT_ID, root);
        self.terminal_windows.clear();
        self.layout_animation = None;
        self.stale.borrow_mut().clear();
    }

    /// `view`'s drawing changed in `damage` (on every frame of an animation
    /// of a canvas's values): that is drawn again now if it can be seen,
    /// else the whole view when it shows ([`Mounter::revisit`]). Lists keep
    /// rows out of sight, and a pulse on each of them would otherwise
    /// redraw them all on every frame.
    pub(crate) fn draw_when_shown(&self, view: &NshView, damage: Damage) {
        // Already waiting: it was out of sight, and anything that could
        // show it since (a move, a batch) has the frame revisit it. Charts
        // below the fold get new values on every frame of their appear.
        if view.is_stale() {
            return;
        }
        if view.shown() {
            match damage {
                Damage::Rect(r) => view.redraw_rect(r),
                _ => view.redraw(),
            }
        } else if view.set_stale(true) {
            self.stale.borrow_mut().push(view.clone());
        }
    }

    /// Takes views the surface put off while a batch held the mounter
    /// ([`crate::surface::Surface::draw_when_shown`]); whether it could.
    pub(crate) fn adopt_stale(&self, views: &mut Vec<NshView>) -> bool {
        let Ok(mut stale) = self.stale.try_borrow_mut() else {
            return false;
        };
        stale.append(views);
        true
    }

    /// Draws the views [`Mounter::draw_when_shown`] put off that can be
    /// seen now (after scrolls, batches and frames). Views out of the tree
    /// wait (their content is drawn once they show); deleted ones are
    /// dropped. Whether the pass ran (it does not while one runs).
    ///
    /// The views it keeps share their ancestors: each ancestor's visible
    /// part is resolved once per pass ([`Sights`]), which keeps a pass
    /// over the hundreds of out-of-sight views of a long page cheap.
    pub(crate) fn revisit(&self) -> bool {
        let Ok(mut stale) = self.stale.try_borrow_mut() else {
            return false;
        };
        if stale.is_empty() {
            return true;
        }
        let Ok(mut sights) = self.sights.try_borrow_mut() else {
            return false;
        };
        // Nothing moves while the pass decides (drawing comes after), so
        // what it resolves stays true until it ends.
        sights.clear();
        let shown: Vec<NshView> = stale
            .extract_if(.., |v| !self.alive(v) || sights.shows(&Views, v))
            .collect();
        sights.clear();
        drop(sights);
        drop(stale);
        for view in shown {
            view.set_stale(false);
            if self.alive(&view) {
                view.redraw();
                crate::shader::shown(&view);
            }
        }
        true
    }

    /// The window's live resize starts or ends. Its end places every view
    /// still waiting, so nothing outside a drag sees a frame not applied.
    pub(crate) fn set_live_resize(&mut self, on: bool) {
        self.live_resize = on;
        if !on {
            for view in std::mem::take(self.unplaced.get_mut()) {
                view.set_unplaced(false);
                if self.alive(&view) {
                    view.moved();
                }
            }
        }
    }

    /// Places the views whose frames waited and that can be seen now, where
    /// they are or where they go: left where it is, a view whose new frame is
    /// out of sight would stay on screen over what took its place. A window's
    /// live resize changes the frame of every view of a long page on every
    /// size, and moving a view costs the main thread and Core Animation's
    /// commit whether it shows or not.
    pub(crate) fn place_shown(&self) {
        let Ok(mut unplaced) = self.unplaced.try_borrow_mut() else {
            return;
        };
        if unplaced.is_empty() {
            return;
        }
        let Ok(mut sights) = self.sights.try_borrow_mut() else {
            return;
        };
        let Ok(mut planned) = self.planned_sights.try_borrow_mut() else {
            return;
        };
        sights.clear();
        planned.clear();
        let shown: Vec<NshView> = unplaced
            .extract_if(.., |v| {
                !self.alive(v) || planned.shows(&Planned, v) || sights.shows(&Views, v)
            })
            .collect();
        sights.clear();
        planned.clear();
        drop(sights);
        drop(planned);
        drop(unplaced);
        for view in shown {
            view.set_unplaced(false);
            if self.alive(&view) {
                view.moved();
            }
        }
    }

    /// Whether `view` is still mounted (not deleted).
    fn alive(&self, view: &NshView) -> bool {
        self.views.get(&view.state().id) == Some(view)
    }

    /// The batch is applied.
    pub(crate) fn end_batch(&mut self, surface: &Rc<Surface>) {
        self.layout_animation = None;
        crate::navigation::end_batch(surface);
        crate::system::end_batch(surface);
        crate::input::content_moved(surface, None);
        crate::selectable_view::end_batch(surface);
        crate::text_input::end_batch(surface);
        surface.control(|control| control.set_focus_path(crate::input::focus_path(surface)));
    }

    fn get(&self, id: NodeId) -> Option<&NshView> {
        let view = self.views.get(&id);
        if view.is_none() {
            log::debug!("mount: no view {id}");
        }
        view
    }

    pub(crate) fn apply(&mut self, surface: &Rc<Surface>, item: &MountItem) {
        match item {
            MountItem::Create { id, kind } => {
                let view = NshView::new(surface.mtm, *id, *kind);
                // The mounter places it by its frame alone. Once its window
                // lays out with Auto Layout, AppKit gives a view that
                // translates its autoresizing mask constraints, anchors and
                // layout storage that nothing here reads: hundreds of bytes
                // per view. The root keeps them: the host places it.
                view.ns()
                    .setTranslatesAutoresizingMaskIntoConstraints(false);
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
                if let Some(view) = self.get(*id) {
                    crate::input::track_states(surface, view, *states);
                }
            }
            MountItem::Insert { child, .. } if self.terminal_windows.contains(child) => {}
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                let (Some(parent), Some(child)) = (self.get(*parent), self.get(*child)) else {
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
                    .and_then(|b| self.views.get(&b))
                    .filter(|b| b.parent_view().as_ref() == Some(parent));
                if child.has_parent() {
                    child.unparent();
                }
                child.insert_before(parent, before);
                crate::transition::inserted(surface, child, self.layout_animation.as_ref());
                if parent.kind() == ViewKind::Stack {
                    crate::navigation::stack_changed(surface, parent, Some(child));
                }
                if parent.kind() == ViewKind::Scroll {
                    crate::scroll::child_inserted(parent);
                }
            }
            MountItem::Remove { id } => {
                if let Some(view) = self.get(*id) {
                    crate::text_input::removing(surface, view);
                    // A removal animation detaches the view when it ends.
                    if !crate::transition::removing(surface, view, self.layout_animation.as_ref()) {
                        self.detach(surface, view);
                    }
                }
            }
            MountItem::Delete { id } => {
                self.terminal_windows.remove(id);
                crate::file_drop::deleted(surface, *id);
                if let Some(view) = self.views.remove(id) {
                    crate::text_input::removing(surface, &view);
                    crate::native::deleted(surface, &view);
                    crate::shader::deleted(surface, &view);
                    // A removal animation detaches the view when it ends.
                    if !crate::transition::removing(surface, &view, self.layout_animation.as_ref())
                    {
                        crate::transition::deleted(&view);
                        self.detach(surface, &view);
                    }
                    // After the detach: a dialog closing through its shader
                    // has read it.
                    crate::navigation::deleted(surface, &view);
                }
            }
            MountItem::Frame { id, frame } => {
                let Some(view) = self.get(*id) else { return };
                // The root and a window's root fill their window: the
                // platform reports their size (`set_root_size`), and the
                // core's frame for them is never theirs to take (it is
                // the one of a dialog over the main window until the
                // window's size comes).
                if *id == ROOT_ID || crate::window::is_window(surface, *id) {
                    return;
                }
                let mut frame = *frame;
                if view.kind() == ViewKind::Modal {
                    // Where a modal sits is the platform's (it covers the
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
                // Plain views go through `place_shown`, which needs no
                // answer from anything they contain.
                if self.live_resize
                    && self.layout_animation.is_none()
                    && matches!(view.kind(), ViewKind::View | ViewKind::Text)
                    && view.state().live.is_none()
                {
                    if view.set_unplaced(true) {
                        self.unplaced.borrow_mut().push(view.clone());
                    }
                    crate::sight::moved();
                } else {
                    view.moved();
                }
                crate::transition::frame_changed(
                    surface,
                    view,
                    old,
                    self.layout_animation.as_ref(),
                );
                match view.kind() {
                    ViewKind::Stack => crate::navigation::stack_resized(surface, view),
                    ViewKind::Canvas => view.changed(),
                    ViewKind::Scroll => crate::scroll::resized(surface, view),
                    _ => crate::shader::resized(surface, view),
                }
            }
            MountItem::ViewStyle { id, style } => {
                let Some(view) = self.get(*id) else { return };
                let old = std::mem::replace(&mut view.state_mut().style, style.clone());
                if old.hidden != style.hidden {
                    crate::sight::moved();
                }
                crate::input::style_changed(surface, view);
                crate::transition::style_changed(surface, view, &old);
                view.moved();
                crate::decor::style_changed(view, &old);
                crate::access::style_changed(view, &old);
            }
            MountItem::Text {
                id,
                text,
                layout,
                content,
            } => {
                if let Some(view) = self.get(*id) {
                    let old = view.state().text.as_ref().map(|t| t.text.clone());
                    let same = crate::text::draws_the_same(view, text, layout, *content);
                    crate::text::set(view, text, layout, *content);
                    if let Some(old) = old {
                        crate::transition::text_changed(surface, view, &old, text);
                    }
                    if !same {
                        self.draw_when_shown(view, Damage::All);
                    }
                    crate::access::text_changed(view);
                }
            }
            MountItem::Events { id, events } => {
                if let Some(view) = self.get(*id) {
                    view.state_mut().events = *events;
                    crate::file_drop::events_changed(surface, view);
                    crate::input::events_changed(surface, view);
                    crate::access::events_changed(view);
                }
            }
            MountItem::Image {
                id,
                source,
                resize_mode,
                options,
            } => {
                if let Some(view) = self.get(*id) {
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
                if let Some(view) = self.get(*id) {
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
                if let Some(view) = self.get(*id) {
                    crate::scroll::content(surface, view, *size);
                }
            }
            MountItem::ScrollBy { id, dx, dy } => {
                if let Some(view) = self.get(*id) {
                    crate::scroll::scroll_by(surface, view, dx.0, dy.0);
                }
            }
            MountItem::LayoutDirection { rtl } => self.rtl = *rtl,
            MountItem::Overflow { id, extent } => {
                if let Some(view) = self.get(*id) {
                    view.state_mut().overflow = *extent;
                }
            }
            MountItem::Appearance { appearance } => {
                crate::system::set_appearance(surface, *appearance);
            }
            MountItem::Keymap(keymap) => crate::keymap::set(surface, keymap.clone()),
            MountItem::AccessibilityLabel { id, label } => {
                if let Some(view) = self.get(*id) {
                    crate::access::label(view, label);
                }
            }
            MountItem::StickyCells { id, cells } => {
                if let Some(view) = self.get(*id) {
                    crate::scroll::sticky(surface, view, cells.clone());
                }
            }
            MountItem::ScrollBehavior { id, behavior } => {
                if let Some(view) = self.get(*id) {
                    crate::scroll::behavior(surface, view, behavior);
                }
            }
            MountItem::Refreshing { id, refreshing } => {
                if let Some(view) = self.get(*id) {
                    crate::scroll::refreshing(surface, view, *refreshing);
                }
            }
            MountItem::Canvas { id, drawing } => {
                if let Some(view) = self.get(*id) {
                    crate::canvas::set(surface, view, drawing.clone());
                    self.draw_when_shown(view, Damage::All);
                }
            }
            MountItem::ShaderTransition { id, duration } => {
                if let Some(view) = self.get(*id) {
                    crate::shader::start_transition(surface, view, *duration);
                }
            }
            MountItem::ShaderInput { id } => {
                if let Some(view) = self.get(*id) {
                    crate::shader::input_changed(surface, view);
                }
            }
            MountItem::NavShader { id, shader } => {
                if let Some(view) = self.get(*id) {
                    crate::navigation::set_shader(surface, view, shader.clone());
                }
            }
            MountItem::Shader { id, layer } => {
                if let Some(view) = self.get(*id) {
                    crate::shader::set(surface, view, layer.clone());
                }
            }
            MountItem::Gestures { id, values } => {
                if let Some(view) = self.get(*id) {
                    crate::input::gestures(surface, view, *values);
                }
            }
            MountItem::ViewProps { id, props } => {
                let Some(view) = self.get(*id) else { return };
                view.state_mut().props = props.clone();
                crate::input::props_changed(surface, view);
                crate::access::props_changed(view);
            }
            MountItem::LayoutAnimation(a) => self.layout_animation = Some(*a),
            MountItem::Input { id, config } => {
                if let Some(view) = self.get(*id) {
                    crate::text_input::config(surface, view, config);
                }
            }
            MountItem::InputValue { id, text, count } => {
                if let Some(view) = self.get(*id) {
                    crate::text_input::value(view, text, *count);
                }
            }
            MountItem::InputContent { id, content } => {
                if let Some(view) = self.get(*id) {
                    crate::text_input::content(view, *content);
                }
            }
            MountItem::ScreenConfig { id, config } => {
                if let Some(view) = self.get(*id) {
                    crate::navigation::screen_config(surface, view, config);
                }
            }
            MountItem::ModalConfig { id, .. } if self.terminal_windows.contains(id) => {}
            MountItem::ModalConfig { id, config } => {
                if let Some(view) = self.get(*id) {
                    crate::navigation::modal_config(surface, view, config);
                }
            }
            MountItem::NativeProps { id, props } => {
                if let Some(view) = self.get(*id) {
                    crate::native::props(surface, view, props);
                }
            }
            MountItem::Component { id, name } => {
                if let Some(view) = self.get(*id) {
                    crate::native::component(surface, view, name);
                }
            }
            MountItem::ComponentProps { id, props } => {
                if let Some(view) = self.get(*id) {
                    crate::native::component_props(surface, view, props);
                }
            }
            // Pixel terminals use desktop layout, not OS shell integration.
            MountItem::Command {
                id,
                command: Command::Desktop(command),
            } if surface.terminal.get() => {
                if *id != ROOT_ID && matches!(command.as_ref(), DesktopCommand::OpenWindow(_)) {
                    self.terminal_windows.insert(*id);
                    crate::navigation::release(surface, *id);
                    if let Some(view) = self.get(*id)
                        && view.has_parent()
                    {
                        view.unparent();
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
    }

    /// Takes `view` out of its parent (a modal is dismissed).
    pub(crate) fn detach(&self, surface: &Rc<Surface>, view: &NshView) {
        match view.kind() {
            ViewKind::Modal => return crate::navigation::dismiss(surface, view),
            ViewKind::HeaderItem => return crate::navigation::header_item_removed(surface, view),
            _ => {}
        }
        let parent = view.parent_view();
        if view.has_parent() {
            view.unparent();
        }
        if let Some(parent) = parent
            && parent.kind() == ViewKind::Stack
        {
            crate::navigation::stack_changed(surface, &parent, None);
        }
    }

    fn command(&self, surface: &Rc<Surface>, id: NodeId, command: &Command) {
        let view = self.views.get(&id);
        match command {
            // An input edits; a pressable takes the keyboard focus as Tab
            // gives it.
            Command::Focus => match view {
                Some(view) if view.kind() == ViewKind::Input => crate::text_input::focus(view),
                Some(view) if id != ROOT_ID => crate::input::focus_control(surface, view),
                _ => {}
            },
            Command::Blur => match view {
                Some(view) if view.kind() == ViewKind::Input => crate::text_input::blur(view),
                Some(view) if id != ROOT_ID => {
                    crate::input::blur_control(surface, view);
                    crate::text_input::blur_all(surface);
                }
                _ => crate::text_input::blur_all(surface),
            },
            Command::SetSelection { start, end } => {
                if let Some(view) = view {
                    crate::text_input::set_selection(view, *start, *end);
                }
            }
            Command::ScrollTo { y, animated, .. }
                if view.is_some_and(|v| v.kind() == ViewKind::Input) =>
            {
                crate::text_input::scroll_to(view.expect("an input"), *y, *animated);
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
                    crate::access::focus(view);
                }
            }
            Command::ImageInfo { .. } => crate::image::command(surface, id, command),
            // A window of the app's own (`Window.open`) shows dialog root
            // `id`.
            Command::Desktop(desktop) if id != ROOT_ID => {
                crate::window::command(surface, id, view, desktop);
            }
            Command::SetJsResponder { .. } | Command::ClearJsResponder => {
                crate::input::command(surface, id, command);
            }
            Command::Reload
            | Command::GoBack
            | Command::GoForward
            | Command::StopLoading
            | Command::InjectJavaScript(_)
            | Command::PostMessage(_)
            | Command::SendInput(_)
            | Command::Load(_)
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
