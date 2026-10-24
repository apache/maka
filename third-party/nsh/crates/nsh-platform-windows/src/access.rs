//! Accessibility: a UI Automation provider tree over the views, with
//! control types, names and states from the views' `ViewProps` and text.
//!
//! Windows asks the window for its accessible tree with `WM_GETOBJECT`
//! ([`get_object`]); the answer is the root of a server-side provider tree
//! ([`uia`]): one provider per exposed view, made on demand and holding
//! only the surface's key and the node id, so nothing assistive
//! technologies keep alive holds a view (a node that is gone answers
//! `UIA_E_ELEMENTNOTAVAILABLE`).
//!
//! Which views are elements ([`part`], as the Linux backend decides which
//! widgets have a role): text views, labelled images, inputs, scroll
//! views, views with press handlers, labelled views and every view with an
//! `accessibilityRole`. Other views are plain containers: they are
//! flattened, their elements becoming children of the nearest element
//! above. `accessibilityElementsHidden`, `importantForAccessibility:
//! "no-hide-descendants"`, `visibility: hidden` (as in a browser) and
//! screens below the top of a stack hide a whole subtree;
//! `importantForAccessibility: "no"` / `accessible={false}` only the view
//! itself.
//!
//! Buttons, links, checkboxes, tabs, ... and `accessible={true}` views
//! group their content, as iOS and Android do: texts, images and groups
//! inside them are not separate elements but name the element when it has
//! no `accessibilityLabel` ([`name_of`]); controls inside them (a switch in
//! a row) stay elements.
//!
//! Each element gets a control type ([`control_for`]: the
//! `accessibilityRole`'s, `Text` for text views, `Button` for views with
//! press handlers, `Image` for labelled images, `Group` for other labelled
//! views), its `testID` as the automation id, its `accessibilityHint` as
//! help text, and the patterns its role and state call for: Invoke
//! (presses; [`activate`] sends the press as a tap would, or the
//! `activate` action), Toggle (`accessibilityState.checked`),
//! ExpandCollapse (`expanded`), SelectionItem (tabs, radios, `selected`),
//! RangeValue (the `accessibilityValue` of sliders, progress bars, ...),
//! Value (inputs) and Scroll (scroll views).
//!
//! Events are raised only while a client listens (`UiaClientsAreListening`,
//! checked once per batch): the mount hooks queue the views a batch
//! changed, and [`batch_applied`] compares what each now exposes with what
//! was exposed last ([`Applied`]; `ViewProps` also carries touch
//! properties, and `Text` items come again on every relayout), raising
//! property changes, a structure change when views came or went, and a
//! notification for changed labels and texts in live regions
//! (`accessibilityLiveRegion`; UIA's equivalent of announcements).

mod uia;

use std::{cell::RefCell, rc::Rc, sync::Arc};

use nsh_core::{
    Accessibility, AccessibilityRole as Role, AttributedText, Checked, EventKind, EventMask,
    LiveRegion, MountBatch, MountItem, NodeId, ViewKind, ViewStyle,
};
use rustc_hash::FxHashMap;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// What accessibility last exposed for a view (kept while clients listen).
#[derive(Debug, Default)]
pub(crate) struct Applied {
    /// The exposed description; `None` until it was first compared.
    spec: Option<Box<Spec>>,
    /// The text a text view's name was taken from.
    text: Option<Arc<AttributedText>>,
}

/// The text, the access and the kind of password of an input, for the
/// Value pattern ([`crate::text_input::accessible_value`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct FieldValue {
    /// The text (empty for secure fields: assistive technologies must not
    /// read it).
    pub(crate) text: String,
    /// The field cannot be edited.
    pub(crate) read_only: bool,
    /// A secure (password) field.
    pub(crate) password: bool,
}

/// The UIA control types nsh's elements take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Control {
    /// `UIA_ButtonControlTypeId`.
    Button,
    /// `UIA_HyperlinkControlTypeId`.
    Hyperlink,
    /// `UIA_EditControlTypeId`.
    Edit,
    /// An edit field read as "search box".
    SearchBox,
    /// `UIA_ImageControlTypeId`.
    Image,
    /// `UIA_TextControlTypeId`.
    Text,
    /// A text read as "heading" (with a heading level).
    Heading,
    /// `UIA_SliderControlTypeId`.
    Slider,
    /// `UIA_StatusBarControlTypeId`.
    Status,
    /// A group read as "alert".
    Alert,
    /// `UIA_CheckBoxControlTypeId`.
    CheckBox,
    /// `UIA_ComboBoxControlTypeId`.
    ComboBox,
    /// `UIA_MenuControlTypeId`.
    Menu,
    /// `UIA_MenuBarControlTypeId`.
    MenuBar,
    /// `UIA_MenuItemControlTypeId`.
    MenuItem,
    /// `UIA_ProgressBarControlTypeId`.
    ProgressBar,
    /// `UIA_RadioButtonControlTypeId`.
    RadioButton,
    /// A group read as "radio group".
    RadioGroup,
    /// `UIA_ScrollBarControlTypeId`.
    ScrollBar,
    /// `UIA_SpinnerControlTypeId`.
    Spinner,
    /// A button read as "toggle switch" (WinUI's `ToggleSwitch`).
    Switch,
    /// `UIA_TabItemControlTypeId`.
    TabItem,
    /// `UIA_TabControlTypeId`.
    TabList,
    /// A text read as "timer".
    Timer,
    /// `UIA_ToolBarControlTypeId`.
    ToolBar,
    /// `UIA_ListControlTypeId`.
    List,
    /// A group read as "grid" (UIA's data grids need the Grid pattern).
    Grid,
    /// `UIA_GroupControlTypeId`.
    Group,
    /// `UIA_PaneControlTypeId` (scroll views).
    Pane,
}

impl Control {
    /// Content folded into the name of an element that groups it.
    fn is_content(self) -> bool {
        matches!(
            self,
            Control::Text
                | Control::Heading
                | Control::Image
                | Control::Group
                | Control::Timer
                | Control::Status
        )
    }

    /// Controls that group their content (a button reads the text inside
    /// it).
    fn groups(self) -> bool {
        matches!(
            self,
            Control::Button
                | Control::Hyperlink
                | Control::CheckBox
                | Control::RadioButton
                | Control::Switch
                | Control::TabItem
                | Control::MenuItem
        )
    }

    /// Controls whose value is a range (the RangeValue pattern).
    fn is_range(self) -> bool {
        matches!(
            self,
            Control::Slider | Control::ProgressBar | Control::Spinner | Control::ScrollBar
        )
    }

    /// Controls that take the keyboard focus.
    fn focusable(self) -> bool {
        matches!(
            self,
            Control::Button
                | Control::Hyperlink
                | Control::Edit
                | Control::SearchBox
                | Control::Slider
                | Control::CheckBox
                | Control::ComboBox
                | Control::MenuItem
                | Control::RadioButton
                | Control::Spinner
                | Control::Switch
                | Control::TabItem
        )
    }

    /// What the control is called where UIA's name for its control type
    /// does not fit.
    fn localized(self) -> Option<&'static str> {
        Some(match self {
            Control::SearchBox => "search box",
            Control::Heading => "heading",
            Control::Alert => "alert",
            Control::RadioGroup => "radio group",
            Control::Switch => "toggle switch",
            Control::Timer => "timer",
            Control::Grid => "grid",
            _ => return None,
        })
    }
}

/// How a view takes part in the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// Neither it nor its subtree is exposed.
    Hidden,
    /// A plain container: its elements belong to the element above.
    Flat,
    /// An element.
    Element(Control),
}

/// Everything exposed of an element that changes are raised for.
#[derive(Debug, Clone, PartialEq)]
struct Spec {
    part: Part,
    /// Its own name (label or text; a grouping element's name from its
    /// content is followed through its texts' changes).
    name: Option<Arc<str>>,
    help: Option<String>,
    disabled: bool,
    selected: bool,
    checked: Option<Checked>,
    expanded: Option<bool>,
    busy: bool,
    /// The current value of a range.
    now: Option<f32>,
    live: LiveRegion,
}

/// Views with press handlers are buttons.
fn is_pressable(events: EventMask) -> bool {
    events.contains(EventKind::Press) || events.contains(EventKind::LongPress)
}

/// The control type of a view of `kind`, with press handlers or not;
/// `None` for plain containers.
pub(crate) fn control_for(a: &Accessibility, kind: ViewKind, pressable: bool) -> Option<Control> {
    if a.accessible == Some(false) {
        return None;
    }
    Some(match a.role {
        Role::None => match kind {
            ViewKind::Text => Control::Text,
            ViewKind::Input => Control::Edit,
            ViewKind::Image if a.label.is_some() => Control::Image,
            _ if pressable => Control::Button,
            _ if a.label.is_some() || a.accessible == Some(true) => Control::Group,
            ViewKind::Scroll => Control::Pane,
            _ => return None,
        },
        Role::Button | Role::ImageButton | Role::KeyboardKey => Control::Button,
        Role::Link => Control::Hyperlink,
        Role::Search => Control::SearchBox,
        Role::Image => Control::Image,
        Role::Text => Control::Text,
        Role::Adjustable => Control::Slider,
        Role::Header => Control::Heading,
        Role::Summary => Control::Status,
        Role::Alert => Control::Alert,
        Role::Checkbox => Control::CheckBox,
        Role::Combobox => Control::ComboBox,
        Role::Menu => Control::Menu,
        Role::Menubar => Control::MenuBar,
        Role::Menuitem => Control::MenuItem,
        Role::Progressbar => Control::ProgressBar,
        Role::Radio => Control::RadioButton,
        Role::Radiogroup => Control::RadioGroup,
        Role::Scrollbar => Control::ScrollBar,
        Role::Spinbutton => Control::Spinner,
        Role::Switch => Control::Switch,
        Role::Tab => Control::TabItem,
        Role::Tablist => Control::TabList,
        Role::Timer => Control::Timer,
        Role::Toolbar => Control::ToolBar,
        Role::List => Control::List,
        Role::Grid => Control::Grid,
    })
}

/// How the view of `s` takes part in the tree (its own state only).
pub(crate) fn part(s: &ViewState) -> Part {
    let a = &s.props.accessibility;
    // `visibility: hidden` takes the subtree out, as a browser does: what
    // is not drawn is not read either.
    if s.concealed || s.style.hidden || a.hidden {
        return Part::Hidden;
    }
    match control_for(a, s.kind, is_pressable(s.events)) {
        Some(c) => Part::Element(c),
        None => Part::Flat,
    }
}

/// True when the element folds its content into its name.
fn groups(s: &ViewState, control: Control) -> bool {
    control.groups() || s.props.accessibility.accessible == Some(true)
}

/// The view's part, `Hidden` while its state is borrowed elsewhere.
fn part_of(view: &NshView) -> Part {
    view.try_state().map_or(Part::Hidden, |s| part(&s))
}

/// The elements under `view` (it excluded), in reading order, as the
/// children of the element `view` is (or the root): plain containers are
/// looked through, hidden subtrees skipped, and inside a grouping element
/// its content is folded into it.
pub(crate) fn children(view: &NshView, grouping: bool, out: &mut Vec<NshView>) {
    view.with_children(|kids| {
        for child in kids {
            match part_of(child) {
                Part::Hidden => {}
                Part::Flat => children(child, grouping, out),
                Part::Element(c) if grouping && c.is_content() => {}
                Part::Element(_) => out.push(child.clone()),
            }
        }
    });
}

/// The children of the element `view` is.
pub(crate) fn element_children(view: &NshView, root: bool) -> Vec<NshView> {
    let grouping = !root
        && view.try_state().is_some_and(|s| match part(&s) {
            Part::Element(c) => groups(&s, c),
            _ => false,
        });
    let mut out = Vec::new();
    children(view, grouping, &mut out);
    out
}

/// The element `view` belongs to in the tree: itself when it is exposed,
/// else the element that folds it (or `None`, for the root, when it is in
/// no element); `Err` when it is hidden or detached.
pub(crate) fn exposed(view: &NshView) -> Result<Option<NshView>, ()> {
    let mut chain = Vec::new();
    let mut at = Some(view.clone());
    while let Some(v) = at {
        at = v.parent_view();
        if at.is_none() {
            // The root: it must be a surface's.
            if !v.attached() {
                return Err(());
            }
            break;
        }
        chain.push(v);
    }
    // From the top: the outermost grouping element folds everything
    // inside it but controls.
    let mut found: Option<NshView> = None;
    let mut folding = false;
    for v in chain.iter().rev() {
        let Some(s) = v.try_state() else {
            return Err(());
        };
        match part(&s) {
            Part::Hidden => return Err(()),
            Part::Flat => {}
            Part::Element(c) if folding && c.is_content() => {}
            Part::Element(c) => {
                found = Some(v.clone());
                folding = groups(&s, c);
            }
        }
    }
    Ok(found)
}

/// The parent element of the exposed element `view`, `None` for the root.
pub(crate) fn parent_element(view: &NshView) -> Option<NshView> {
    let mut at = view.parent_view();
    while let Some(v) = at {
        let parent = v.parent_view();
        parent.as_ref()?;
        if matches!(part_of(&v), Part::Element(_)) {
            return Some(v);
        }
        at = parent;
    }
    None
}

/// The name of an element: its `accessibilityLabel`, a text view's text,
/// else (for elements that group their content) the texts and labels
/// inside it.
pub(crate) fn name_of(view: &NshView) -> Option<String> {
    let s = view.try_state()?;
    if let Some(label) = &s.props.accessibility.label {
        return Some(label.to_string());
    }
    if let Some(t) = &s.text {
        return Some(t.text.text.clone());
    }
    let grouping = match part(&s) {
        Part::Element(c) => groups(&s, c),
        _ => false,
    };
    drop(s);
    if !grouping {
        return None;
    }
    let mut name = String::new();
    content_name(view, &mut name);
    (!name.is_empty()).then_some(name)
}

/// The longest name gathered from content.
const MAX_NAME: usize = 1000;

/// Appends the texts and labels of `view`'s content to `out`.
fn content_name(view: &NshView, out: &mut String) {
    view.with_children(|kids| {
        for child in kids {
            if out.len() >= MAX_NAME {
                return;
            }
            let Some(s) = child.try_state() else { continue };
            let own = match part(&s) {
                Part::Hidden => continue,
                // Controls inside are elements of their own.
                Part::Element(c) if !c.is_content() => continue,
                _ => s
                    .props
                    .accessibility
                    .label
                    .as_deref()
                    .or(s.text.as_ref().map(|t| t.text.text.as_str())),
            };
            match own {
                Some(text) => {
                    let text = text.trim();
                    if !text.is_empty() {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str(text);
                    }
                }
                None => {
                    drop(s);
                    content_name(child, out);
                }
            }
        }
    });
}

/// The help text: a value that is not a range's, and the hint.
pub(crate) fn help_of(a: &Accessibility, control: Option<Control>) -> Option<String> {
    let ranged = control.is_some_and(Control::is_range);
    let value_text = a
        .value
        .as_ref()
        .and_then(|v| v.text.as_deref())
        .filter(|_| !ranged);
    match (value_text, a.hint.as_deref()) {
        (Some(v), Some(h)) => Some(format!("{v}. {h}")),
        (Some(t), None) | (None, Some(t)) => Some(t.to_owned()),
        (None, None) => None,
    }
}

/// A range's minimum, maximum and current value (the RangeValue pattern),
/// or `None` when the element has no range.
pub(crate) fn range_of(a: &Accessibility, control: Control) -> Option<(f64, f64, f64)> {
    if !control.is_range() {
        return None;
    }
    let v = a.value.as_ref()?;
    let min = v.min.unwrap_or(0.0) as f64;
    let max = v.max.map_or(100.0f64.max(min), |m| m as f64);
    let now = v.now? as f64;
    Some((min, max.max(min), now.clamp(min, max.max(min))))
}

fn spec_of(s: &ViewState) -> Spec {
    let a = &s.props.accessibility;
    let part = part(s);
    let control = match part {
        Part::Element(c) => Some(c),
        _ => None,
    };
    Spec {
        part,
        name: a
            .label
            .clone()
            .or_else(|| s.text.as_ref().map(|t| Arc::from(t.text.text.as_str()))),
        help: help_of(a, control),
        disabled: a.state.disabled,
        selected: a.state.selected,
        checked: a.state.checked,
        expanded: a.state.expanded,
        busy: a.state.busy,
        now: a.value.as_ref().and_then(|v| v.now),
        live: a.live_region,
    }
}

/// The live region a view is in.
fn live_region(view: &NshView) -> LiveRegion {
    let mut at = Some(view.clone());
    while let Some(v) = at {
        let live = v
            .try_state()
            .map_or(LiveRegion::None, |s| s.props.accessibility.live_region);
        if live != LiveRegion::None {
            return live;
        }
        at = v.parent_view();
    }
    LiveRegion::None
}

/// What changed in a batch, for [`batch_applied`].
#[derive(Default)]
struct Pending {
    /// A client listens: the batch is followed.
    listening: bool,
    /// Views came, went or moved.
    structure: bool,
    /// Views whose exposed state may have changed.
    dirty: Vec<NshView>,
}

thread_local! {
    static PENDING: RefCell<Pending> = RefCell::default();
    /// The element given the accessibility focus (`AccessibilityFocus`,
    /// UIA's `SetFocus`), by surface key.
    static FOCUS: RefCell<FxHashMap<u64, NodeId>> = RefCell::default();
}

/// True when an assistive technology listens to UIA events.
fn clients_listening() -> bool {
    // SAFETY: plain call.
    unsafe { windows::Win32::UI::Accessibility::UiaClientsAreListening() }.as_bool()
}

/// Queues `view` for comparison when a client listens.
fn mark(view: &NshView) {
    PENDING.with_borrow_mut(|p| {
        if p.listening {
            p.dirty.push(view.clone());
        }
    });
}

/// A batch is about to be applied: follows it if a client listens.
pub(crate) fn prepare(batch: &MountBatch) {
    let listening = clients_listening();
    let structure = listening
        && batch.items.iter().any(|item| {
            matches!(
                item,
                MountItem::Create { .. }
                    | MountItem::Insert { .. }
                    | MountItem::ProjectRoot { .. }
                    | MountItem::Remove { .. }
                    | MountItem::RetireListCell { .. }
                    | MountItem::Delete { .. }
            )
        });
    PENDING.with_borrow_mut(|p| {
        p.listening = listening;
        p.structure |= structure;
        if !listening {
            p.dirty.clear();
        }
    });
}

/// A batch was applied: raises the events for what it changed.
pub(crate) fn batch_applied(surface: &Rc<Surface>) {
    let (structure, mut dirty) = PENDING.with_borrow_mut(|p| {
        if !p.listening {
            return (false, Vec::new());
        }
        (
            std::mem::take(&mut p.structure),
            std::mem::take(&mut p.dirty),
        )
    });
    if dirty.is_empty() && !structure {
        return;
    }
    dirty.sort_by_key(|v| v.try_state().map_or(0, |s| s.id));
    dirty.dedup();
    let mut structure = structure;
    for view in &dirty {
        structure |= update(surface, view);
    }
    if structure {
        uia::structure_changed(surface);
    }
}

/// Compares what `view` exposes with what it exposed last and raises the
/// changes; true when the tree's structure changed.
fn update(surface: &Rc<Surface>, view: &NshView) -> bool {
    let (spec, old, text_changed, text) = {
        let mut s = view.state_mut();
        let s = &mut *s;
        let spec = spec_of(s);
        let mut text_changed = false;
        let mut text = None;
        if let Some(drawn) = &s.text {
            let old = s.access.text.replace(drawn.text.clone());
            if let Some(old) = old
                && !Arc::ptr_eq(&old, &drawn.text)
                && old.text != drawn.text.text
            {
                text_changed = true;
                text = Some(drawn.text.text.clone());
            }
        }
        if s.access.spec.as_deref() == Some(&spec) && !text_changed {
            return false;
        }
        let old = s.access.spec.replace(Box::new(spec.clone()));
        (spec, old, text_changed, text)
    };
    let Some(old) = old else {
        return false;
    };
    let Ok(element) = exposed(view) else {
        return old.part != spec.part;
    };
    let structure = old.part != spec.part;
    match element {
        Some(e) if e == *view => uia::changed(surface, view, &exposed_of(&old), &exposed_of(&spec)),
        // Folded into an element: its name follows this one's text.
        Some(e) if old.name != spec.name => uia::name_changed(surface, &e),
        _ => {}
    }
    let label_changed = old.name != spec.name;
    if label_changed || text_changed {
        let live = live_region(view);
        if live != LiveRegion::None {
            let said = text.or_else(|| spec.name.as_deref().map(str::to_owned));
            if let Some(said) = said.filter(|s| !s.is_empty()) {
                uia::notify(surface, Some(view), &said, live == LiveRegion::Assertive);
            }
        }
    }
    structure
}

/// The states of a spec UIA raises changes for.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Exposed {
    /// The name.
    pub(crate) name: Option<Arc<str>>,
    /// The help text.
    pub(crate) help: Option<String>,
    /// Enabled.
    pub(crate) enabled: bool,
    /// Selected.
    pub(crate) selected: bool,
    /// The toggle state.
    pub(crate) checked: Option<Checked>,
    /// Expanded or collapsed.
    pub(crate) expanded: Option<bool>,
    /// Busy.
    pub(crate) busy: bool,
    /// A range's value.
    pub(crate) now: Option<f32>,
}

fn exposed_of(s: &Spec) -> Exposed {
    Exposed {
        name: s.name.clone(),
        help: s.help.clone(),
        enabled: !s.disabled,
        selected: s.selected,
        checked: s.checked,
        expanded: s.expanded,
        busy: s.busy,
        now: s.now,
    }
}

/// A view was made.
pub(crate) fn created(view: &NshView) {
    let _ = view;
}

/// The view's props changed.
pub(crate) fn props_changed(view: &NshView) {
    mark(view);
}

/// The view's events changed: views with press handlers are buttons.
pub(crate) fn events_changed(view: &NshView) {
    mark(view);
}

/// The view's text changed.
pub(crate) fn text_changed(view: &NshView) {
    mark(view);
}

/// The view's style changed: `visibility` hides or shows its subtree.
pub(crate) fn style_changed(view: &NshView, old: &ViewStyle) {
    if view.state().style.hidden != old.hidden {
        mark(view);
    }
}

/// `AccessibilityLabel`: the view's label changed, and nothing else. The
/// label is kept in the view's props, so that the next `ViewProps` diffs
/// against it.
pub(crate) fn label(view: &NshView, label: &Option<Arc<str>>) {
    {
        let mut s = view.state_mut();
        if s.props.accessibility.label == *label {
            return;
        }
        s.props.accessibility.label = label.clone();
    }
    mark(view);
}

/// `AccessibilityFocus`: the view gets the accessibility focus.
pub(crate) fn focus(surface: &Rc<Surface>, view: &NshView) {
    let element = match exposed(view) {
        Ok(Some(e)) => e,
        _ => return,
    };
    let id = element.id();
    FOCUS.with_borrow_mut(|f| f.insert(surface.key(), id));
    if clients_listening() {
        uia::focus_changed(surface, &element);
    }
}

/// The keyboard focus moved to `view` (a text field): tells assistive
/// technologies. Called by the modules that move it.
pub(crate) fn focus_changed(surface: &Rc<Surface>, view: &NshView) {
    FOCUS.with_borrow_mut(|f| f.remove(&surface.key()));
    if clients_listening()
        && let Ok(Some(element)) = exposed(view)
    {
        uia::focus_changed(surface, &element);
    }
}

/// The element with the accessibility focus.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    if let Some(field) = crate::text_input::focused(surface) {
        return Some(field);
    }
    let id = FOCUS.with_borrow(|f| f.get(&surface.key()).copied())?;
    let view = surface.view(id)?;
    match exposed(&view) {
        Ok(Some(e)) => Some(e),
        _ => None,
    }
}

/// Has assistive technologies read `text` (`announce`).
#[allow(dead_code, reason = "system.rs calls it for `Command::Announce`")]
pub(crate) fn announce(surface: &Rc<Surface>, text: &str) {
    if clients_listening() {
        uia::notify(surface, None, text, false);
    }
}

/// Activates an element as a tap would: its `activate` action when it
/// declares one, else a press. False when it has neither.
pub(crate) fn activate(surface: &Surface, view: &NshView) -> bool {
    action_or_press(surface, view, "activate", true)
}

/// Sends the accessibility action `name` if the view declares it, else
/// (with `press`) a press if it has press handlers.
fn action_or_press(surface: &Surface, view: &NshView, name: &str, press: bool) -> bool {
    let (id, has_action, pressable) = {
        let s = view.state();
        (
            s.id,
            s.props
                .accessibility
                .actions
                .iter()
                .any(|a| &*a.name == name),
            s.events.contains(EventKind::Press),
        )
    };
    if has_action {
        surface.event(
            id,
            EventKind::AccessibilityAction,
            nsh_core::EventPayload::Map(vec![(
                "actionName",
                nsh_core::PayloadValue::Str(name.to_owned()),
            )]),
        );
        true
    } else if press && pressable {
        surface.event(id, EventKind::Press, nsh_core::EventPayload::None);
        true
    } else {
        false
    }
}

/// `WM_GETOBJECT`: the root of the provider tree for UI Automation.
pub(crate) fn get_object(
    surface: &Rc<Surface>,
    hwnd: HWND,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    uia::get_object(surface, hwnd, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use nsh_core::{AccessibilityState, AccessibilityValue, ViewProps};

    use super::*;

    fn with_role(role: Role) -> Accessibility {
        Accessibility {
            role,
            ..Default::default()
        }
    }

    fn labelled(label: &str) -> Accessibility {
        Accessibility {
            label: Some(label.into()),
            ..Default::default()
        }
    }

    #[test]
    fn controls() {
        let none = Accessibility::default();
        assert_eq!(control_for(&none, ViewKind::View, false), None);
        assert_eq!(
            control_for(&none, ViewKind::Text, false),
            Some(Control::Text)
        );
        assert_eq!(
            control_for(&none, ViewKind::Input, false),
            Some(Control::Edit)
        );
        assert_eq!(
            control_for(&none, ViewKind::Scroll, false),
            Some(Control::Pane)
        );
        assert_eq!(
            control_for(&none, ViewKind::View, true),
            Some(Control::Button)
        );
        assert_eq!(control_for(&none, ViewKind::Image, false), None);
        let not_element = Accessibility {
            accessible: Some(false),
            ..Default::default()
        };
        assert_eq!(control_for(&not_element, ViewKind::View, true), None);
        let grouped = Accessibility {
            accessible: Some(true),
            ..Default::default()
        };
        assert_eq!(
            control_for(&grouped, ViewKind::View, false),
            Some(Control::Group)
        );
        let logo = labelled("Logo");
        assert_eq!(
            control_for(&logo, ViewKind::Image, false),
            Some(Control::Image)
        );
        assert_eq!(
            control_for(&logo, ViewKind::View, false),
            Some(Control::Group)
        );
        assert_eq!(
            control_for(&logo, ViewKind::View, true),
            Some(Control::Button)
        );
        for (role, control) in [
            (Role::Button, Control::Button),
            (Role::ImageButton, Control::Button),
            (Role::Link, Control::Hyperlink),
            (Role::Header, Control::Heading),
            (Role::Adjustable, Control::Slider),
            (Role::Checkbox, Control::CheckBox),
            (Role::Switch, Control::Switch),
            (Role::Tab, Control::TabItem),
            (Role::Tablist, Control::TabList),
            (Role::Search, Control::SearchBox),
            (Role::Progressbar, Control::ProgressBar),
            (Role::List, Control::List),
            (Role::Radio, Control::RadioButton),
            (Role::Menuitem, Control::MenuItem),
        ] {
            assert_eq!(
                control_for(&with_role(role), ViewKind::View, false),
                Some(control),
                "{role:?}"
            );
        }
        // An explicit role wins over the text view's.
        assert_eq!(
            control_for(&with_role(Role::Header), ViewKind::Text, false),
            Some(Control::Heading)
        );
        assert_eq!(Control::Switch.localized(), Some("toggle switch"));
        assert_eq!(Control::Button.localized(), None);
    }

    fn view(id: NodeId, kind: ViewKind, a: Accessibility) -> NshView {
        let v = NshView::new(id, kind);
        *v.state_mut().props = ViewProps {
            accessibility: a,
            ..Default::default()
        };
        v
    }

    fn text(id: NodeId, s: &str) -> NshView {
        let v = view(id, ViewKind::Text, Accessibility::default());
        crate::text::set(
            &v,
            &Arc::new(AttributedText {
                text: s.into(),
                ..Default::default()
            }),
            &nsh_core::TextLayout(Arc::new(())),
            Default::default(),
        );
        v
    }

    fn pressable(id: NodeId, a: Accessibility) -> NshView {
        let v = view(id, ViewKind::View, a);
        v.state_mut().events.set(EventKind::Press, true);
        v
    }

    fn ids(views: &[NshView]) -> Vec<NodeId> {
        views.iter().map(NshView::id).collect()
    }

    /// root
    /// ├ 2 plain
    /// │ ├ 4 text "Title"
    /// │ └ 6 button
    /// │   ├ 8 plain
    /// │   │ └ 10 text "Save"
    /// │   ├ 12 image labelled "icon"
    /// │   └ 14 switch "Auto"
    /// ├ 16 hidden
    /// │ └ 18 text "secret"
    /// └ 20 accessible={false}
    ///   └ 22 text "Footer"
    fn tree() -> (NshView, Vec<NshView>) {
        let root = view(0, ViewKind::View, Accessibility::default());
        root.set_invalidate(Rc::new(|| {}));
        let plain = view(2, ViewKind::View, Accessibility::default());
        let title = text(4, "Title");
        let button = pressable(6, Accessibility::default());
        let inner = view(8, ViewKind::View, Accessibility::default());
        let save = text(10, "Save");
        let icon = view(12, ViewKind::Image, labelled("icon"));
        let switch = view(
            14,
            ViewKind::View,
            Accessibility {
                role: Role::Switch,
                label: Some("Auto".into()),
                ..Default::default()
            },
        );
        let hidden = view(
            16,
            ViewKind::View,
            Accessibility {
                hidden: true,
                ..Default::default()
            },
        );
        let secret = text(18, "secret");
        let no = view(
            20,
            ViewKind::View,
            Accessibility {
                accessible: Some(false),
                ..Default::default()
            },
        );
        let footer = text(22, "Footer");
        plain.insert_before(&root, None);
        title.insert_before(&plain, None);
        button.insert_before(&plain, None);
        inner.insert_before(&button, None);
        save.insert_before(&inner, None);
        icon.insert_before(&button, None);
        switch.insert_before(&button, None);
        hidden.insert_before(&root, None);
        secret.insert_before(&hidden, None);
        no.insert_before(&root, None);
        footer.insert_before(&no, None);
        let all = vec![
            plain, title, button, inner, save, icon, switch, hidden, secret, no, footer,
        ];
        (root, all)
    }

    fn find(all: &[NshView], id: NodeId) -> NshView {
        all.iter().find(|v| v.id() == id).unwrap().clone()
    }

    #[test]
    fn elements() {
        let (root, all) = tree();
        // Plain containers are flattened, hidden subtrees skipped.
        assert_eq!(ids(&element_children(&root, true)), [4, 6, 22]);
        // The button folds its text and image, keeps the switch.
        let button = find(&all, 6);
        assert_eq!(ids(&element_children(&button, false)), [14]);
        assert_eq!(exposed(&find(&all, 10)), Ok(Some(button.clone())));
        assert_eq!(exposed(&find(&all, 12)), Ok(Some(button.clone())));
        assert_eq!(exposed(&find(&all, 14)), Ok(Some(find(&all, 14))));
        assert_eq!(exposed(&find(&all, 18)), Err(()));
        assert_eq!(exposed(&find(&all, 2)), Ok(None));
        assert_eq!(parent_element(&find(&all, 14)), Some(button.clone()));
        assert_eq!(parent_element(&button), None);
        // A detached view is not available.
        let lone = text(30, "lone");
        assert_eq!(exposed(&lone), Err(()));
    }

    /// `visibility: hidden` takes the view and its subtree out of the tree,
    /// as a browser does, and showing it again brings them back.
    #[test]
    fn a_hidden_style_hides_the_subtree() {
        let (root, all) = tree();
        let plain = find(&all, 2);
        plain.state_mut().style.hidden = true;
        assert_eq!(part(&plain.state()), Part::Hidden);
        assert_eq!(ids(&element_children(&root, true)), [22]);
        assert_eq!(exposed(&find(&all, 4)), Err(()));
        assert_eq!(exposed(&find(&all, 10)), Err(()));
        // On an element itself.
        plain.state_mut().style.hidden = false;
        find(&all, 6).state_mut().style.hidden = true;
        assert_eq!(ids(&element_children(&root, true)), [4, 22]);
        assert_eq!(exposed(&find(&all, 14)), Err(()));
        find(&all, 6).state_mut().style.hidden = false;
        assert_eq!(ids(&element_children(&root, true)), [4, 6, 22]);
    }

    #[test]
    fn names() {
        let (_root, all) = tree();
        // From content: texts and labels, not the controls inside.
        assert_eq!(name_of(&find(&all, 6)).as_deref(), Some("Save icon"));
        assert_eq!(name_of(&find(&all, 4)).as_deref(), Some("Title"));
        assert_eq!(name_of(&find(&all, 14)).as_deref(), Some("Auto"));
        // A label wins over the content.
        find(&all, 6).state_mut().props.accessibility.label = Some("Store".into());
        assert_eq!(name_of(&find(&all, 6)).as_deref(), Some("Store"));
        // A label wins over a text view's text too.
        find(&all, 4).state_mut().props.accessibility.label = Some("Heading".into());
        assert_eq!(name_of(&find(&all, 4)).as_deref(), Some("Heading"));
        // Plain containers have no name.
        assert_eq!(name_of(&find(&all, 2)), None);
    }

    #[test]
    fn help_and_ranges() {
        let value = AccessibilityValue {
            min: Some(0.0),
            max: Some(10.0),
            now: Some(3.0),
            text: Some("3 of 10".into()),
        };
        let slider = Accessibility {
            role: Role::Adjustable,
            value: Some(value.clone()),
            ..Default::default()
        };
        assert_eq!(range_of(&slider, Control::Slider), Some((0.0, 10.0, 3.0)));
        assert_eq!(help_of(&slider, Some(Control::Slider)), None);
        // Outside range controls the value is part of the help text.
        let button = Accessibility {
            role: Role::Button,
            hint: Some("Plays".into()),
            value: Some(value),
            ..Default::default()
        };
        assert_eq!(range_of(&button, Control::Button), None);
        assert_eq!(
            help_of(&button, Some(Control::Button)).as_deref(),
            Some("3 of 10. Plays")
        );
        // Defaults: 0 to 100; the value is clamped; no value, no range.
        let progress = Accessibility {
            value: Some(AccessibilityValue {
                now: Some(140.0),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            range_of(&progress, Control::ProgressBar),
            Some((0.0, 100.0, 100.0))
        );
        let empty = Accessibility {
            value: Some(AccessibilityValue::default()),
            ..Default::default()
        };
        assert_eq!(range_of(&empty, Control::ProgressBar), None);
    }

    #[test]
    fn spec_changes() {
        let v = view(
            2,
            ViewKind::View,
            Accessibility {
                role: Role::Checkbox,
                state: AccessibilityState {
                    checked: Some(Checked::False),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        let a = spec_of(&v.state());
        v.state_mut().props.accessibility.state.checked = Some(Checked::True);
        let b = spec_of(&v.state());
        assert_ne!(a, b);
        assert_eq!(a.part, Part::Element(Control::CheckBox));
        // Touch properties do not change what is exposed.
        v.state_mut().props.long_press_delay = Some(800.0);
        assert_eq!(spec_of(&v.state()), b);
    }
}
