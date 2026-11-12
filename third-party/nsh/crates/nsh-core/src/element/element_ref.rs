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
    Command, EditAction, JsonValue, LayoutAnimation, LayoutTransition, ListScrollPosition,
    Measurement, NodeId,
    geometry::{Bounds, Percentage, Point, Points},
};

/// An element of a view: made with [`super::element_ref`], put on
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
    scoped_keys: Cell<u32>,
    executor: Weak<Executor>,
}

impl Target {
    fn notify_keys(&self) {
        if self.scoped_keys.get() > 0
            && let Some(executor) = self.executor.upgrade()
        {
            executor.keys.borrow_mut().changed = true;
        }
    }
}

/// What the element carrying a ref holds, to tell the ref where it is.
#[derive(Clone)]
pub(crate) struct RefTarget(Rc<Target>);

impl RefTarget {
    pub(crate) fn node(&self) -> Option<NodeId> {
        Some(self.0.node.get()).filter(|&n| n != 0)
    }

    pub(crate) fn watch_keys(&self) {
        self.0
            .scoped_keys
            .set(self.0.scoped_keys.get().saturating_add(1));
    }

    pub(crate) fn unwatch_keys(&self) {
        self.0
            .scoped_keys
            .set(self.0.scoped_keys.get().saturating_sub(1));
    }

    pub(crate) fn attach(&self, node: NodeId) {
        if self.0.node.replace(node) != node {
            self.0.notify_keys();
        }
    }

    /// Forgets `node` when it is the one carrying the ref.
    pub(crate) fn detach(&self, node: NodeId) {
        if self.0.node.get() == node {
            self.0.node.set(0);
            self.0.notify_keys();
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

/// The element a view's frame follows ([`super::View::follow`]): whatever
/// element carries the ref, looked up as the core lays out, so the
/// element may be rendered after the view that follows it.
#[derive(Debug, Clone, PartialEq)]
pub struct FollowTarget(pub(crate) RefTarget);

impl FollowTarget {
    /// The node carrying the ref now.
    pub(crate) fn node(&self) -> Option<NodeId> {
        Some(self.0.0.node.get()).filter(|&n| n != 0)
    }

    /// A target carried by `node`, with no ref behind it (the core's
    /// tests).
    #[cfg(test)]
    pub(crate) fn of_node(node: NodeId) -> Self {
        Self(RefTarget(Rc::new(Target {
            node: Cell::new(node),
            scoped_keys: Cell::new(0),
            executor: Weak::new(),
        })))
    }
}

/// An element another one names for assistive technologies
/// ([`crate::AccessibilityProp::ActiveDescendant`],
/// [`crate::AccessibilityProp::Controls`]): a node JS passes (a `ref`),
/// or whatever element carries a Rust [`ElementRef`], looked up as the
/// core commits, so the element may be rendered after the one naming it
/// (a list's row made as the list lays out).
#[derive(Debug, Clone, PartialEq)]
pub struct ElementTarget(pub(crate) Named);

/// What an [`ElementTarget`] names.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Named {
    /// A node JS made.
    Node(NodeId),
    /// The node carrying a Rust ref.
    Ref(RefTarget),
}

impl ElementTarget {
    /// Node `node` (JS's ref).
    pub(crate) fn of_node(node: NodeId) -> Self {
        Self(Named::Node(node))
    }

    /// The node it names now.
    pub(crate) fn node(&self) -> Option<NodeId> {
        match &self.0 {
            Named::Node(node) => Some(*node),
            Named::Ref(target) => Some(target.0.node.get()).filter(|&n| n != 0),
        }
    }
}

impl ElementRef {
    /// What names the element carrying it for assistive technologies
    /// ([`ElementTarget`]); `None` once its owner is gone.
    pub(crate) fn element_target(&self) -> Option<ElementTarget> {
        self.target().map(|t| ElementTarget(Named::Ref(t)))
    }

    pub(crate) fn new(executor: &Rc<Executor>) -> Self {
        Self(Kept::new(Rc::new(Target {
            node: Cell::new(0),
            scoped_keys: Cell::new(0),
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

    pub(crate) fn send(&self, command: Command) {
        self.reach(|node, executor| executor.act(Action::Command(node, command)));
    }

    /// Focuses an input (showing the keyboard), or gives a view that takes
    /// presses the keyboard focus where Tab stops at it (macOS, the web),
    /// as Tab does: `focus:` styles, `on_focus`. A view `focusable(false)`,
    /// disabled or hidden stays unfocused.
    pub fn focus(&self) {
        self.send(Command::Focus);
    }

    /// Ends the press going on in the element (or inside it) without its
    /// release: no `on_press_up` or `on_press` follow, and its `active:`
    /// styles reset (`nsh-base`'s context menu opened by a held finger).
    #[doc(hidden)]
    pub fn cancel_press(&self) {
        self.send(Command::CancelPress);
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

    /// Animates with `transition` the frames that the element's change
    /// moves in the next commit: its own and its subtree's, its siblings'
    /// and those of its ancestors' siblings, which its size pushes along
    /// (and the content of those that change size). The commit's other
    /// frames change at once, as do its insertions and removals: a region
    /// that grows (a reveal) springs, while a list updating in the same
    /// commit elsewhere does not. [`super::animate_layout`] animates the
    /// whole commit instead, and wins when both are asked for.
    pub fn animate_layout(&self, transition: LayoutTransition) {
        self.send(Command::LayoutAnimation(LayoutAnimation {
            update: Some(transition),
            ..LayoutAnimation::default()
        }));
    }

    /// Selects `start..end` of an input (UTF-16 units; a caret when equal).
    pub fn set_selection(&self, start: u32, end: u32) {
        self.send(Command::SetSelection { start, end });
    }

    /// Inserts `text` into an input in place of its selection, as the
    /// user's edit ([`Command::InsertText`]): reported by `on_change`, a
    /// step of the input's undo history where the platform keeps one. With
    /// [`crate::PasteBehavior::Report`], what `on_paste` reported goes in
    /// this way once the app allows it (or what the app made of it).
    pub fn insert_text(&self, text: impl Into<String>) {
        self.send(Command::InsertText(text.into()));
    }

    /// Opens the system's edit menu over `bounds` (in the root view) on a
    /// focused input, offering `actions` ([`Command::OpenEditMenu`]): a
    /// chosen action comes back as [`super::EventKind::EditAction`], a
    /// paste as the input's `on_paste`.
    pub fn open_edit_menu(
        &self,
        bounds: Bounds<Points>,
        actions: impl IntoIterator<Item = EditAction>,
    ) {
        self.send(Command::OpenEditMenu {
            bounds,
            actions: actions.into_iter().collect(),
        });
    }

    /// Closes the edit menu [`ElementRef::open_edit_menu`] opened.
    pub fn close_edit_menu(&self) {
        self.send(Command::CloseEditMenu);
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

    /// Scrolls the scroll views around the element so it shows, placed by
    /// `options` (TS: `ref.reveal(options)`), with the layout of
    /// the commit this call goes out with. Lists keep their rows' offsets
    /// to `scroll_to_index`.
    pub fn reveal(&self, options: crate::RevealOptions) {
        self.send(Command::Reveal(options));
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

    /// Runs `script` in a web view's page and answers with its result
    /// (TS: `ref.evaluate(script, options)`): the script's completion value,
    /// a returned Promise's once it settles, as JSON. Fails with
    /// [`codes::WEBVIEW_SCRIPT`](super::codes::WEBVIEW_SCRIPT) when the
    /// script throws, its Promise rejects or its value is not JSON,
    /// [`codes::WEBVIEW_ABORTED`](super::codes::WEBVIEW_ABORTED) when the
    /// page navigates or the web view goes away first,
    /// [`codes::TIMED_OUT`](super::codes::TIMED_OUT) after
    /// `options.timeout`, and
    /// [`codes::UNAVAILABLE`](super::codes::UNAVAILABLE) where the platform
    /// has none ([`web_evaluate_available`](super::web_evaluate_available)).
    /// Await it in a task.
    pub fn evaluate(
        &self,
        script: impl Into<String>,
        options: EvaluateOptions,
    ) -> Answer<Result<Evaluation, super::JsError>> {
        let (answer, slot) = Answer::new();
        let pending = slot.clone();
        let script = script.into();
        if self
            .reach(|node, executor| {
                executor.act(Action::Evaluate(node, script, options.timeout, pending))
            })
            .is_none()
        {
            slot.borrow_mut().deliver(Err(super::JsError::Error(
                "the ref names no web view".into(),
            )
            .with_code(super::codes::WEBVIEW_ABORTED)));
        }
        answer
    }

    /// Sends `data` to a web view's page (a `message` event on `window`).
    pub fn post_message(&self, data: impl Into<String>) {
        self.send(Command::PostMessage(data.into()));
    }

    /// Gives a web view's page `input` as the user's own: its events are
    /// trusted. Needs the `webview.input` capability; macOS delivers it,
    /// the other platforms ignore it for now
    /// ([`web_input_available`](super::web_input_available) tells).
    pub fn send_input(&self, input: crate::WebInput) {
        self.send(Command::SendInput(input));
    }

    /// Loads `load.src` in a web view with `load.headers` on the document
    /// request only (not its subresources, later navigations or reloads),
    /// as an `Authorization` header for a signed-in page. Its host must be
    /// one the `webview` capability allows.
    pub fn load(&self, load: crate::WebLoad) {
        self.send(Command::Load(load));
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

    /// Where a list's viewport starts among its rows (TS:
    /// `ref.measureScrollPosition()`): the row there and how far into it,
    /// as the list lays its rows out, from the layout of the commit this
    /// call goes out with. [`ElementRef::scroll_to_index`] with the row
    /// and a view offset of `-offset` puts the viewport's start back
    /// there, as for a list made anew. `None` when no rendered list
    /// carries the ref or it has no items. Await it in a task.
    pub fn measure_scroll_position(&self) -> Answer<Option<ListScrollPosition>> {
        let (answer, slot) = Answer::new();
        let pending = slot.clone();
        if self
            .reach(|node, executor| executor.act(Action::MeasureScrollPosition(node, pending)))
            .is_none()
        {
            slot.borrow_mut().deliver(None);
        }
        answer
    }
}

impl ElementRef {
    /// Passes a press on into the element: the innermost, topmost view in
    /// it under `press.page_position` (in its root view, as a pointer's)
    /// that hears presses gets `onPress`, its `position` in that view, with
    /// the layout of the commit this call goes out with. Answers whether a
    /// view took it. For a component whose own hit layer lies over content
    /// the app renders (a table's cells): that content's pressable views
    /// get the presses on them. The element's own `pointerEvents` do not
    /// count; hover and press states stay the hit layer's. Await it in a
    /// task.
    pub fn press_at(&self, press: crate::PressEvent) -> Answer<bool> {
        let (answer, slot) = Answer::new();
        let pending = slot.clone();
        if self
            .reach(|node, executor| executor.act(Action::PressAt(node, press, pending)))
            .is_none()
        {
            slot.borrow_mut().deliver(false);
        }
        answer
    }

    /// How long the element's transitions run (`transition*`: the
    /// longest duration plus its delay), with the styles of the commit
    /// this call goes out with, so a class or style set before it counts;
    /// zero when it has none or no rendered element carries the ref. The
    /// platforms run transitions without reporting their end: a component
    /// that keeps an element through its exit (a popup's ending style)
    /// waits this long. Await it in a task.
    pub fn transition_time(&self) -> Answer<std::time::Duration> {
        let (answer, slot) = Answer::new();
        let pending = slot.clone();
        if self
            .reach(|node, executor| executor.act(Action::TransitionTime(node, pending)))
            .is_none()
        {
            slot.borrow_mut().deliver(std::time::Duration::ZERO);
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
/// with [`super::component_ref`], put on the component's element
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

/// How [`ElementRef::evaluate`] runs (TS: `ref.evaluate`'s options).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EvaluateOptions {
    /// How long the script may take to answer, a returned Promise
    /// included; past it the call fails with
    /// [`codes::TIMED_OUT`](super::codes::TIMED_OUT). 30 seconds by
    /// default.
    pub timeout: std::time::Duration,
}

impl Default for EvaluateOptions {
    fn default() -> Self {
        Self {
            timeout: std::time::Duration::from_secs(30),
        }
    }
}

/// What a web view's script answered ([`ElementRef::evaluate`]; TS:
/// `{ value }`).
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Evaluation {
    /// The script's result as JSON: `null`, a boolean, a finite number, a
    /// string, an array or a plain object of these. It comes from the page:
    /// check it before trusting it.
    pub value: JsonValue,
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
