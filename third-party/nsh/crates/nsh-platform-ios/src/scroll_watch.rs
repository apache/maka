//! Scroll views the embedding app watches ([`crate::AppView::watch_scroll`]):
//! native UI of the host that moves with the app's content in every frame (a
//! sheet the end of the content pulls up) follows a `<Scroll>` by its
//! `nativeID`, on the main thread, in the frame of the scroll. `onScroll`
//! through JS would be a frame late.
//!
//! The mounter keys a scroll view by the `nativeID` of its props (the newest of
//! an id wins) and unkeys it when it is deleted, loses the id or its app
//! stops; unkeying tells the watcher and kills the handle. The event target
//! calls the handle's listeners from `scrollViewDidScroll`, after the core's
//! report, without borrowing the mounter (a listener may scroll, which calls
//! back in); the mounter calls them when a content height changes without a
//! scroll. Nothing runs for a scroll view no host watches.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use nsh_core::NodeId;
use objc2::rc::{Retained, Weak};
use objc2_core_foundation::{CGFloat, CGPoint, CGSize};
use objc2_ui_kit::{UIScrollView, UIView};
use rustc_hash::FxHashMap;

use crate::target::EventTarget;

/// Hears a scroll view the host watches come and go, on the main thread.
pub trait ScrollWatcher {
    /// The scroll view is there: at once when it already is, and again with
    /// a new handle when the app replaces the element or another app loads.
    fn on_attached(&self, handle: ScrollHandle);

    /// The scroll view is gone (deleted, its `nativeID` changed or its app
    /// stopped): its handle is dead.
    fn on_detached(&self);
}

/// The watchers of a view's apps, by `nativeID`, and the scroll views keyed
/// now (shared by the view's options and its surface's mounter).
#[derive(Clone, Default)]
pub struct ScrollWatchers(Rc<RefCell<Registry>>);

impl std::fmt::Debug for ScrollWatchers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set()
            .entries(self.0.borrow().watchers.keys())
            .finish()
    }
}

#[derive(Default)]
struct Registry {
    watchers: FxHashMap<Arc<str>, Rc<dyn ScrollWatcher>>,
    keyed: FxHashMap<Arc<str>, ScrollHandle>,
}

impl ScrollWatchers {
    /// Watches the scroll view with `native_id` (`None`: stops watching).
    pub(crate) fn watch(&self, native_id: &str, watcher: Option<Rc<dyn ScrollWatcher>>) {
        let attach = {
            let mut registry = self.0.borrow_mut();
            match watcher {
                None => {
                    registry.watchers.remove(native_id);
                    None
                }
                Some(watcher) => {
                    registry.watchers.insert(native_id.into(), watcher.clone());
                    registry.keyed.get(native_id).cloned().map(|h| (watcher, h))
                }
            }
        };
        // Outside the borrow: the watcher may watch again.
        if let Some((watcher, handle)) = attach {
            watcher.on_attached(handle);
        }
    }

    /// `handle`'s scroll view now has `native_id`: an older one of the id
    /// makes way.
    fn key(&self, native_id: Arc<str>, handle: &ScrollHandle) {
        let (previous, watcher) = {
            let mut registry = self.0.borrow_mut();
            let previous = registry.keyed.insert(native_id.clone(), handle.clone());
            (previous, registry.watchers.get(&native_id).cloned())
        };
        if let Some(previous) = previous {
            previous.kill();
            if let Some(w) = &watcher {
                w.on_detached();
            }
        }
        if let Some(w) = watcher {
            w.on_attached(handle.clone());
        }
    }

    /// `handle`'s scroll view is gone or lost `native_id`.
    fn unkey(&self, native_id: &str, handle: &ScrollHandle) {
        handle.kill();
        let watcher = {
            let mut registry = self.0.borrow_mut();
            if !registry
                .keyed
                .get(native_id)
                .is_some_and(|h| h.same(handle))
            {
                return;
            }
            registry.keyed.remove(native_id);
            registry.watchers.get(native_id).cloned()
        };
        if let Some(w) = watcher {
            w.on_detached();
        }
    }
}

/// The keyed scroll views of a surface: their `nativeID` and handle, by node id.
type Keyed = FxHashMap<NodeId, (Arc<str>, ScrollHandle)>;

/// The scroll views of one surface the host may watch, by node id (its
/// mounter keys them, its event target reports their scrolls).
#[derive(Clone, Default)]
pub(crate) struct SurfaceScrolls(Rc<RefCell<Keyed>>);

impl SurfaceScrolls {
    /// Scroll view `id`'s props were applied, with `native_id`.
    pub(crate) fn props(
        &self,
        watchers: &ScrollWatchers,
        id: NodeId,
        scroll: &Retained<UIScrollView>,
        target: &Retained<EventTarget>,
        native_id: Option<Arc<str>>,
    ) {
        let current = self.0.borrow().get(&id).map(|(k, _)| k.clone());
        if current == native_id {
            return;
        }
        self.remove(watchers, id);
        let Some(native_id) = native_id else { return };
        let handle = ScrollHandle::new(scroll, target);
        self.0
            .borrow_mut()
            .insert(id, (native_id.clone(), handle.clone()));
        watchers.key(native_id, &handle);
    }

    /// Scroll view `id` is deleted, or lost its id.
    pub(crate) fn remove(&self, watchers: &ScrollWatchers, id: NodeId) {
        let removed = self.0.borrow_mut().remove(&id);
        if let Some((native_id, handle)) = removed {
            watchers.unkey(&native_id, &handle);
        }
    }

    /// The app stopped: every keyed scroll view goes.
    pub(crate) fn clear(&self, watchers: &ScrollWatchers) {
        let all: Vec<_> = self.0.borrow_mut().drain().collect();
        for (_, (native_id, handle)) in all {
            watchers.unkey(&native_id, &handle);
        }
    }

    fn handle(&self, id: NodeId) -> Option<ScrollHandle> {
        self.0.borrow().get(&id).map(|(_, h)| h.clone())
    }

    /// Scroll view `id` scrolled (`scrollViewDidScroll`).
    pub(crate) fn scrolled(&self, id: NodeId) {
        if let Some(handle) = self.handle(id) {
            handle.scrolled();
        }
    }

    /// Scroll view `id`'s content got a new size.
    pub(crate) fn resized(&self, id: NodeId) {
        if let Some(handle) = self.handle(id) {
            handle.resized();
        }
    }
}

/// A listener of a [`ScrollHandle`].
enum Listener {
    Scroll(Rc<dyn Fn(CGPoint, CGPoint)>),
    ContentSize(Rc<dyn Fn(CGSize)>),
}

struct HandleState {
    scroll: Weak<UIScrollView>,
    target: Weak<EventTarget>,
    alive: Cell<bool>,
    /// The offset and content size last reported.
    offset: Cell<CGPoint>,
    size: Cell<CGSize>,
    listeners: RefCell<Vec<(u64, Listener)>>,
    next: Cell<u64>,
}

/// A `<Scroll>` of the app ([`crate::AppView::watch_scroll`]), for native UI
/// of the host that follows or drives the app's scrolling in the frame of the
/// scroll, without JS. Both axes; lengths are points, offsets from the start
/// of the content (the scroll view's insets are not counted). Main thread.
/// The same API as Android's `NshScrollHandle`.
///
/// Once the scroll view is deleted, loses its `nativeID` or its app stops,
/// [`ScrollHandle::is_alive`] is false, reads give 0 and the rest does
/// nothing.
#[derive(Clone)]
pub struct ScrollHandle(Rc<HandleState>);

impl std::fmt::Debug for ScrollHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScrollHandle")
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl ScrollHandle {
    fn new(scroll: &Retained<UIScrollView>, target: &Retained<EventTarget>) -> Self {
        let handle = ScrollHandle(Rc::new(HandleState {
            scroll: Weak::from_retained(scroll),
            target: Weak::from_retained(target),
            alive: Cell::new(true),
            offset: Cell::new(CGPoint::ZERO),
            size: Cell::new(CGSize::ZERO),
            listeners: RefCell::default(),
            next: Cell::new(1),
        }));
        handle.0.offset.set(handle.offset());
        handle.0.size.set(handle.content_size());
        handle
    }

    fn same(&self, other: &ScrollHandle) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    fn kill(&self) {
        self.0.alive.set(false);
        self.0.listeners.borrow_mut().clear();
    }

    fn scroll(&self) -> Option<Retained<UIScrollView>> {
        if !self.0.alive.get() {
            return None;
        }
        self.0.scroll.load()
    }

    /// Whether the scroll view is still the app's, with the watched
    /// `nativeID`.
    pub fn is_alive(&self) -> bool {
        self.scroll().is_some()
    }

    fn offset(&self) -> CGPoint {
        self.scroll().map_or(CGPoint::ZERO, |s| {
            let (offset, inset) = (s.contentOffset(), s.adjustedContentInset());
            CGPoint::new(offset.x + inset.left, offset.y + inset.top)
        })
    }

    fn content_size(&self) -> CGSize {
        self.scroll().map_or(CGSize::ZERO, |s| {
            let (size, viewport) = (s.contentSize(), Self::viewport(&s));
            CGSize::new(
                size.width.max(viewport.width),
                size.height.max(viewport.height),
            )
        })
    }

    fn viewport(s: &UIScrollView) -> CGSize {
        let (inset, size) = (s.adjustedContentInset(), s.bounds().size);
        CGSize::new(
            (size.width - inset.left - inset.right).max(0.0),
            (size.height - inset.top - inset.bottom).max(0.0),
        )
    }

    /// The horizontal offset.
    pub fn scroll_x(&self) -> CGFloat {
        self.offset().x
    }

    /// The vertical offset.
    pub fn scroll_y(&self) -> CGFloat {
        self.offset().y
    }

    /// The content's width (at least the viewport's).
    pub fn content_width(&self) -> CGFloat {
        self.content_size().width
    }

    /// The content's height (at least the viewport's).
    pub fn content_height(&self) -> CGFloat {
        self.content_size().height
    }

    /// The visible width (inside the scroll view's insets).
    pub fn viewport_width(&self) -> CGFloat {
        self.scroll().map_or(0.0, |s| Self::viewport(&s).width)
    }

    /// The visible height (inside the scroll view's insets).
    pub fn viewport_height(&self) -> CGFloat {
        self.scroll().map_or(0.0, |s| Self::viewport(&s).height)
    }

    /// The view the app's content is laid out in: the positions of the views
    /// inside are relative to it.
    pub fn content_view(&self) -> Option<Retained<UIView>> {
        self.scroll().map(Retained::into_super)
    }

    /// Scrolls by `dx`, `dy`, clamped to the content, as the user's scroll
    /// would (the app's `onScroll` hears it); `animated` uses UIKit's
    /// animation.
    pub fn scroll_by(&self, dx: CGFloat, dy: CGFloat, animated: bool) {
        let Some(s) = self.scroll() else { return };
        let (inset, offset) = (s.adjustedContentInset(), s.contentOffset());
        let (size, bounds) = (s.contentSize(), s.bounds().size);
        let max_x = (size.width + inset.right - bounds.width).max(-inset.left);
        let max_y = (size.height + inset.bottom - bounds.height).max(-inset.top);
        let x = (offset.x + dx).clamp(-inset.left, max_x);
        let y = (offset.y + dy).clamp(-inset.top, max_y);
        s.setContentOffset_animated(CGPoint::new(x, y), animated);
    }

    /// Ends a fling or an animated scroll where it is; nothing at rest.
    pub fn stop_scrolling(&self) {
        let Some(s) = self.scroll() else { return };
        let gliding = s.isDecelerating();
        // Setting the current offset without animation ends UIKit's motion.
        s.setContentOffset_animated(s.contentOffset(), false);
        if gliding && let Some(target) = self.0.target.load() {
            target.glide_stopped(&s);
        }
    }

    /// Calls `f(offset, delta)` on every offset change (`delta` positive:
    /// the content moved left / up). Returns an id for
    /// [`ScrollHandle::remove_listener`].
    pub fn on_scroll(&self, f: impl Fn(CGPoint, CGPoint) + 'static) -> u64 {
        self.add(Listener::Scroll(Rc::new(f)))
    }

    /// Calls `f(content_size)` when the content gets larger or smaller
    /// without a scroll. Returns an id for [`ScrollHandle::remove_listener`].
    pub fn on_content_size_change(&self, f: impl Fn(CGSize) + 'static) -> u64 {
        self.add(Listener::ContentSize(Rc::new(f)))
    }

    /// Stops calling listener `id`.
    pub fn remove_listener(&self, id: u64) {
        self.0.listeners.borrow_mut().retain(|(i, _)| *i != id);
    }

    fn add(&self, listener: Listener) -> u64 {
        if !self.is_alive() {
            return 0;
        }
        let id = self.0.next.get();
        self.0.next.set(id + 1);
        self.0.listeners.borrow_mut().push((id, listener));
        id
    }

    fn scrolled(&self) {
        let offset = self.offset();
        let old = self.0.offset.replace(offset);
        let delta = CGPoint::new(offset.x - old.x, offset.y - old.y);
        if delta.x == 0.0 && delta.y == 0.0 {
            return;
        }
        // Outside the borrow: a listener may scroll or remove itself.
        let listeners: Vec<_> = self
            .0
            .listeners
            .borrow()
            .iter()
            .filter_map(|(_, l)| match l {
                Listener::Scroll(f) => Some(f.clone()),
                Listener::ContentSize(_) => None,
            })
            .collect();
        for f in listeners {
            f(offset, delta);
        }
    }

    fn resized(&self) {
        let size = self.content_size();
        if self.0.size.replace(size) == size {
            return;
        }
        let listeners: Vec<_> = self
            .0
            .listeners
            .borrow()
            .iter()
            .filter_map(|(_, l)| match l {
                Listener::ContentSize(f) => Some(f.clone()),
                Listener::Scroll(_) => None,
            })
            .collect();
        for f in listeners {
            f(size);
        }
    }
}
