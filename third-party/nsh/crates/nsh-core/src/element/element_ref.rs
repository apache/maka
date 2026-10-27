//! Handles to the elements a component renders (TS: `ref`), to send
//! them commands: focus an input, scroll a scroll view, drive a web view or
//! a video, call a native component; and to the components it renders, to
//! call their methods ([`ComponentRef`]).
//!
//! Both are `Copy` handles kept by the reactive owner current when one is
//! made (the component, a region, a row), as signals are: closures share
//! them as they are, and they are released when that owner is disposed.
//! Used after that, a ref does nothing and names no node (no panic). The
//! element carrying a ref holds what it names ([`RefTarget`]) for as long
//! as it is mounted, so mounting and unmounting it never reach the ref's
//! owner. Listeners and tasks run under the owner that made them, so a ref
//! one makes is that owner's; made with no owner at all (outside any
//! component), a ref lives as long as the surface, as a signal made there
//! does.

use std::{
    cell::Cell,
    fmt,
    marker::PhantomData,
    rc::{Rc, Weak},
};

use super::{
    Answer, Component,
    reactive::Kept,
    task::{Action, Executor},
};
use crate::{
    Command, JsonValue, Measurement, NodeId,
    geometry::{Percentage, Point, Points},
};

/// An element of a view: made with [`super::ambient::element_ref`], put on
/// the element ([`super::Element::element_ref`]). Its commands go to
/// whatever element carries it now, in order with the component's other
/// changes; they do nothing while no rendered element carries it, and once
/// the owner it was made under is gone. Works from listeners and tasks
/// alike. A `Copy` handle (see the module's docs).
#[derive(Clone, Copy)]
pub struct ElementRef(Kept<Target>);

/// What an element ref names: the node carrying it and where its commands
/// go.
pub(crate) struct Target {
    /// The node, 0 while none carries it.
    node: Cell<NodeId>,
    executor: Weak<Executor>,
}

/// What the element carrying a ref holds, to tell the ref where it is.
#[derive(Clone)]
pub(crate) struct RefTarget(Rc<Target>);

impl RefTarget {
    pub(crate) fn attach(&self, node: NodeId) {
        self.0.node.set(node);
    }

    /// Forgets `node` when it is the one carrying the ref.
    pub(crate) fn detach(&self, node: NodeId) {
        if self.0.node.get() == node {
            self.0.node.set(0);
        }
    }
}

impl fmt::Debug for RefTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("RefTarget")
            .field(&self.0.node.get())
            .finish()
    }
}

impl PartialEq for RefTarget {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl ElementRef {
    pub(crate) fn new(executor: &Rc<Executor>) -> Self {
        Self(Kept::new(Rc::new(Target {
            node: Cell::new(0),
            executor: Rc::downgrade(executor),
        })))
    }

    /// The element's node, while one is rendered (and the ref's owner
    /// lives).
    pub fn node(&self) -> Option<NodeId> {
        self.0.with(|t| t.node.get()).filter(|&n| n != 0)
    }

    /// What an element carrying the ref holds; `None` once its owner is
    /// gone.
    pub(crate) fn target(&self) -> Option<RefTarget> {
        self.0.get().map(RefTarget)
    }

    /// `act` of the node carrying it and its executor, if one does (it
    /// runs inside the graph's borrow: queuing an action reaches only the
    /// executor).
    fn reach<R>(&self, act: impl FnOnce(NodeId, &Executor) -> R) -> Option<R> {
        self.0
            .with(|t| {
                let node = t.node.get();
                let executor = t.executor.upgrade().filter(|_| node != 0)?;
                Some(act(node, &executor))
            })
            .flatten()
    }

    fn send(&self, command: Command) {
        self.reach(|node, executor| executor.act(Action::Command(node, command)));
    }

    /// Focuses an input (showing the keyboard), or gives a view that takes
    /// presses the keyboard focus where Tab stops at it (macOS, the web),
    /// as Tab does: `focus:` styles, `on_focus`. A view `focusable(false)`,
    /// disabled or hidden stays unfocused.
    pub fn focus(&self) {
        self.send(Command::Focus);
    }

    /// Unfocuses an input, or takes the keyboard focus off a view that
    /// takes presses.
    pub fn blur(&self) {
        self.send(Command::Blur);
    }

    /// Moves the screen reader's focus to the element (TS:
    /// `setAccessibilityFocus(ref)`).
    pub fn set_accessibility_focus(&self) {
        self.send(Command::AccessibilityFocus);
    }

    /// Selects `start..end` of an input (UTF-16 units; a caret when equal).
    pub fn set_selection(&self, start: u32, end: u32) {
        self.send(Command::SetSelection { start, end });
    }

    /// Replaces a UTF-16 input range as one undoable native edit while its
    /// observed text and selection still match (GPUI and terminal backends).
    pub fn replace_range(
        &self,
        range: std::ops::Range<u32>,
        text: impl Into<String>,
        expected_text: impl Into<String>,
        expected_selection: std::ops::Range<u32>,
    ) {
        self.send(Command::ReplaceRange {
            range,
            text: text.into(),
            expected_text: expected_text.into(),
            expected_selection,
            count: 0,
        });
    }

    /// Scrolls a scroll view to a content offset.
    pub fn scroll_to(&self, offset: Point<Points>, animated: bool) {
        self.send(Command::ScrollTo {
            x: offset.x,
            y: offset.y,
            animated,
        });
    }

    /// Scrolls a list to `offset` along its axis.
    pub fn scroll_to_offset(&self, offset: Points, animated: bool) {
        self.send(Command::ScrollTo {
            x: offset,
            y: offset,
            animated,
        });
    }

    /// Scrolls a scroll view or a list to the end of its content.
    pub fn scroll_to_end(&self, animated: bool) {
        self.send(Command::ScrollToEnd { animated });
    }

    /// Scrolls a list to row `index`: `view_position` 0% puts it at the
    /// start of the viewport, 100% at the end, `view_offset` further.
    pub fn scroll_to_index(
        &self,
        index: u32,
        view_position: Percentage,
        view_offset: Points,
        animated: bool,
    ) {
        self.send(Command::ScrollToIndex {
            index,
            animated,
            automatic: false,
            view_position,
            view_offset,
        });
    }

    /// Zooms a scroll view to `scale`, around `center` (in the content) or
    /// keeping the middle.
    pub fn zoom_to(&self, scale: f32, center: Option<Point<Points>>, animated: bool) {
        self.send(Command::ZoomTo {
            scale,
            center,
            animated,
        });
    }

    /// Reloads a web view's page.
    pub fn reload(&self) {
        self.send(Command::Reload);
    }

    /// Goes back in a web view's history.
    pub fn go_back(&self) {
        self.send(Command::GoBack);
    }

    /// Goes forward in a web view's history.
    pub fn go_forward(&self) {
        self.send(Command::GoForward);
    }

    /// Stops a web view loading.
    pub fn stop_loading(&self) {
        self.send(Command::StopLoading);
    }

    /// Runs `script` in a web view's page.
    pub fn inject_java_script(&self, script: impl Into<String>) {
        self.send(Command::InjectJavaScript(script.into()));
    }

    /// Sends `data` to a web view's page (a `message` event on `window`).
    pub fn post_message(&self, data: impl Into<String>) {
        self.send(Command::PostMessage(data.into()));
    }

    /// Jumps a video to `seconds`.
    pub fn seek(&self, seconds: f64) {
        self.send(Command::Seek(seconds));
    }

    /// Calls command `name` of a native component with `args`.
    pub fn command(&self, name: &str, args: JsonValue) {
        self.send(Command::Native {
            name: name.into(),
            args,
        });
    }

    /// Where the element is (TS: `ref.measure()`): its frame in its parent
    /// and its top left corner in the root view it is in (the surface or
    /// its modal; scroll offsets applied), from the layout of the commit
    /// this call goes out with, so changes made before it count. `None`
    /// when no rendered element carries the ref or it is not laid out.
    /// Await it in a task.
    pub fn measure(&self) -> Answer<Option<Measurement>> {
        let (answer, slot) = Answer::new();
        let pending = slot.clone();
        if self
            .reach(|node, executor| executor.act(Action::Measure(node, pending)))
            .is_none()
        {
            slot.borrow_mut().deliver(None);
        }
        answer
    }
}

impl PartialEq for ElementRef {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl fmt::Debug for ElementRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ElementRef")
            .field(&self.node().unwrap_or(0))
            .finish()
    }
}

/// A component of a view (TS: a `ref` to a component, its methods): made
/// with [`super::ambient::component_ref`], put on the component's element
/// ([`super::ComponentElement::component_ref`]); [`Self::api`] reaches its
/// methods, with no encoding. A `Copy` handle, as [`ElementRef`] is.
pub struct ComponentRef<C: Component> {
    element: ElementRef,
    _component: PhantomData<fn() -> C>,
}

impl<C: Component> ComponentRef<C> {
    pub(crate) fn new(executor: &Rc<Executor>) -> Self {
        Self {
            element: ElementRef::new(executor),
            _component: PhantomData,
        }
    }

    pub(crate) fn element(&self) -> &ElementRef {
        &self.element
    }

    /// The component's host node, while one is rendered (and the ref's
    /// owner lives).
    pub fn node(&self) -> Option<NodeId> {
        self.element.node()
    }

    /// The API a component that runs once registered
    /// ([`super::Scope::methods`]), while one is mounted: Rust calls its
    /// methods directly (`stepper.api::<StepperApi>()?.set_value(5.0)`).
    pub fn api<A: super::Api>(&self) -> Option<Rc<A>> {
        super::reactive::api_of::<A>(self.node()?)
    }
}

impl<C: Component> Clone for ComponentRef<C> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<C: Component> Copy for ComponentRef<C> {}

impl<C: Component> PartialEq for ComponentRef<C> {
    fn eq(&self, other: &Self) -> bool {
        self.element == other.element
    }
}

impl<C: Component> fmt::Debug for ComponentRef<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ComponentRef")
            .field(&self.node().unwrap_or(0))
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        element::reactive::{Runtime, create_root},
        geometry::{point, px},
    };

    fn commands(executor: &Executor) -> Vec<(NodeId, Command)> {
        executor
            .take_actions()
            .into_iter()
            .filter_map(|a| match a {
                Action::Command(node, command) => Some((node, command)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn refs_are_copies_until_their_owner_goes() {
        let runtime = Runtime::default();
        let entered = runtime.enter();
        let executor = Rc::new(Executor::default());
        let (owner, field) = create_root(|| ElementRef::new(&executor));
        let carried = field.target().expect("live");
        carried.attach(7);
        // Copies, in closures or not, name the one element.
        let focus = move || field.focus();
        let blur = move || field.blur();
        focus();
        blur();
        let copy = field;
        assert_eq!((copy, copy.node()), (field, Some(7)));
        assert_eq!(format!("{field:?}"), "ElementRef(7)");
        assert_eq!(
            commands(&executor),
            [(7, Command::Focus), (7, Command::Blur)]
        );

        // Its owner goes: it names nothing and does nothing; the element
        // still holding what it named mounts and unmounts as before.
        owner.dispose();
        assert_eq!(field.node(), None);
        focus();
        field.scroll_to(point(px(0.0), px(10.0)), false);
        assert_eq!(commands(&executor), []);
        assert!(field.target().is_none());
        carried.detach(7);
        carried.attach(9);
        assert_eq!(field.node(), None);
        assert_eq!(format!("{field:?}"), "ElementRef(0)");

        // Off the engine thread (no graph entered), a live ref names
        // nothing either, and does not panic.
        let live = ElementRef::new(&executor);
        live.target().expect("live").attach(3);
        drop(entered);
        assert_eq!(live.node(), None);
    }
}
