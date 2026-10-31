//! Accessibility: the views as AccessKit nodes in GPUI's accessibility
//! tree, with roles, names and states from the views' `ViewProps` and
//! text, and AccessKit's actions sent back as presses and accessibility
//! actions.
//!
//! GPUI builds one AccessKit tree per window, every frame while an
//! assistive technology is attached ([`gpui::Window::is_a11y_active`]),
//! and hands it to AccessKit's adapter for the platform (NSAccessibility on
//! macOS, UI Automation on Windows, AT-SPI on Linux), which compares it
//! with the last and raises the platform's events: nodes that came or
//! went, changed names and states, live regions, the focus. An element
//! with an id and a role pushes a node as it prepaints; the
//! [`crate::render::SurfaceElement`] is one (role [`ROLE`]), and the views
//! are its *synthetic children* ([`synthetic`]): nodes it adds after its
//! prepaint, with ids of nsh's choosing ([`node_id`]: the surface's key and
//! the view's node id, stable across frames, so AccessKit sees a changed
//! node rather than a new one). Nothing is kept between frames: the tree is
//! rebuilt ([`build`]) whenever the surface draws, and a batch applied while
//! a client is attached draws it again ([`batch_applied`]), so labels and
//! states that change nothing on screen still reach the tree.
//!
//! Which views are elements ([`part`]) and how they fold follows the
//! Windows and Linux backends: text views, labelled images, inputs,
//! scroll views, views with press handlers, labelled views and every view
//! with an `accessibilityRole` are elements; plain containers are looked
//! through; `accessibilityElementsHidden`, `importantForAccessibility:
//! "no-hide-descendants"`, `visibility: hidden` (as in a browser) and
//! screens below the top of a stack hide a whole subtree, its texts naming
//! nothing, `importantForAccessibility: "no"` / `accessible={false}` only
//! the view itself. Buttons, links, checkboxes, tabs, ... and
//! `accessible={true}` views group their content: texts, images and groups
//! inside them name the element ([`own_name`]); controls inside stay
//! elements.
//!
//! Each element gets a role ([`role_for`]), its name (AccessKit reads a
//! `Label`'s name from its value), its `accessibilityHint` (and a value text
//! that is not a range's) as description, its `testID` as author id (UIA's
//! `AutomationId`, `AXIdentifier`, AT-SPI's accessible id), its states
//! (disabled, selected, checked as toggled, expanded, busy), a range's
//! numeric value, a field's value ([`crate::text_input::accessible_value`]),
//! a scroll view's offsets, the live region it is in, and the actions it
//! takes: `Click` (its `activate` action, else a press), `Focus`,
//! `Increment` / `Decrement`, `Expand` / `Collapse`, `ShowContextMenu`
//! (`longpress`), `SetValue`, custom actions (the other
//! `accessibilityActions`, by their labels), scrolling and
//! `ScrollIntoView`. The listeners are registered as the surface paints
//! ([`paint`]); each sends the action to the view's node by id, so a
//! request for a view that is gone does nothing.
//!
//! **The focus.** GPUI reports as focused the node of the element whose
//! focus handle is focused, and only elements it prepaints themselves can
//! be focusable: synthetic nodes cannot. So the element with the
//! accessibility focus (the focused text field, else the one
//! `AccessibilityFocus` named) is not a synthetic node but a real one: a
//! `div` that tracks the app view's focus handle, prepainted inside the
//! surface element at the element's bounds ([`prepaint`]), whose node takes
//! the element's description and subtree. While the app view has the
//! keyboard focus, assistive technologies are on that element. The
//! surface element registers its focus handle after it, so keys still go
//! to the surface.
//!
//! Announcements (`announce`, [`announce`]) are a polite
//! live `Label` node added under the surface's: all three adapters read a
//! live node that appears.
//!
//! The environment's `screenReader` is GPUI's accessibility activation: an
//! assistive technology asked the window for its tree (on Windows any UI
//! Automation client does, on Linux the AT-SPI bus being enabled does).
//!
//! **Limits** (AccessKit 0.24, as GPUI Fast 0.1.8 uses it). The adapters
//! pass on only some actions: `Click`, `Focus`, `SetValue` and
//! `ScrollIntoView` everywhere, `Increment` / `Decrement` on macOS,
//! `Expand` / `Collapse` on Windows. Custom actions, `ShowContextMenu` and
//! the scroll actions are in the nodes but no adapter calls them yet (a
//! range's `SetValue` steps it with `increment` / `decrement`, as the
//! Windows backend does). The focus proxy reports a focus only while the
//! app view's focus handle is focused, and a host that also tracks that
//! handle on an element of its own makes GPUI report two focused nodes (a
//! debug assertion in GPUI).

use std::{
    cell::RefCell,
    hash::{Hash, Hasher},
    rc::Rc,
    sync::Arc,
};

use gpui::{
    A11ySubtreeBuilder, AnyElement, App, AvailableSpace, FocusHandle, InteractiveElement,
    IntoElement, StatefulInteractiveElement, Styled, Window,
    accesskit::{self, Action, ActionData, CustomAction, Live, Node, Role, ScrollUnit, Toggled},
    div, point, px, size,
};
use nsh_core::{
    Accessibility, AccessibilityRole as AxRole, Checked, Command, EventKind, EventMask, LiveRegion,
    MountBatch, NodeId, ViewKind, geometry::Points,
};
use rustc_hash::FxHashMap;

use crate::{
    geom::Mat4,
    surface::Surface,
    view::{NshView, ViewState},
};

/// The role of the surface's own node, which the views' nodes hang off.
pub(crate) const ROLE: Role = Role::Group;

/// The text, the access and the kind of password of an input
/// ([`crate::text_input::accessible_value`]).
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

/// Roles whose content folds into the name of an element that groups it.
fn is_content(role: Role) -> bool {
    matches!(
        role,
        Role::Label | Role::Heading | Role::Image | Role::Group | Role::Timer | Role::Status
    )
}

/// Roles that group their content (a button reads the text inside it).
fn groups_role(role: Role) -> bool {
    matches!(
        role,
        Role::Button
            | Role::Link
            | Role::CheckBox
            | Role::RadioButton
            | Role::Switch
            | Role::Tab
            | Role::MenuItem
            | Role::ListBoxOption
    )
}

/// Roles whose value is a range.
fn is_range(role: Role) -> bool {
    matches!(
        role,
        Role::Slider | Role::ProgressIndicator | Role::SpinButton | Role::ScrollBar
    )
}

/// Roles that take the keyboard focus.
fn focusable(role: Role) -> bool {
    matches!(
        role,
        Role::Button
            | Role::Link
            | Role::TextInput
            | Role::PasswordInput
            | Role::SearchInput
            | Role::Slider
            | Role::CheckBox
            | Role::ComboBox
            | Role::MenuItem
            | Role::RadioButton
            | Role::SpinButton
            | Role::Switch
            | Role::Tab
            | Role::ListBoxOption
    )
}

/// How a view takes part in the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// Neither it nor its subtree is exposed.
    Hidden,
    /// A plain container: its elements belong to the element above.
    Flat,
    /// An element.
    Element(Role),
}

/// Views with press handlers are buttons.
fn is_pressable(events: EventMask) -> bool {
    events.contains(EventKind::Press) || events.contains(EventKind::LongPress)
}

/// The role of a view of `kind`, with press handlers or not; `None` for
/// plain containers.
pub(crate) fn role_for(a: &Accessibility, kind: ViewKind, pressable: bool) -> Option<Role> {
    if a.accessible == Some(false) {
        return None;
    }
    Some(match a.role {
        AxRole::None => match kind {
            ViewKind::Text => Role::Label,
            ViewKind::Input => Role::TextInput,
            ViewKind::Image if a.label.is_some() => Role::Image,
            _ if pressable => Role::Button,
            _ if a.label.is_some() || a.accessible == Some(true) => Role::Group,
            ViewKind::Scroll => Role::ScrollView,
            _ => return None,
        },
        AxRole::Button | AxRole::ImageButton | AxRole::KeyboardKey => Role::Button,
        AxRole::Link => Role::Link,
        AxRole::Search => Role::SearchInput,
        AxRole::Image => Role::Image,
        AxRole::Text => Role::Label,
        AxRole::Adjustable => Role::Slider,
        AxRole::Header => Role::Heading,
        AxRole::Summary => Role::Status,
        AxRole::Alert => Role::Alert,
        AxRole::Checkbox => Role::CheckBox,
        AxRole::Combobox => Role::ComboBox,
        AxRole::Menu => Role::Menu,
        AxRole::Menubar => Role::MenuBar,
        AxRole::Menuitem => Role::MenuItem,
        AxRole::Progressbar => Role::ProgressIndicator,
        AxRole::Radio => Role::RadioButton,
        AxRole::Radiogroup => Role::RadioGroup,
        AxRole::Scrollbar => Role::ScrollBar,
        AxRole::Spinbutton => Role::SpinButton,
        AxRole::Switch => Role::Switch,
        AxRole::Tab => Role::Tab,
        AxRole::Tablist => Role::TabList,
        AxRole::Timer => Role::Timer,
        AxRole::Toolbar => Role::Toolbar,
        AxRole::List => Role::List,
        AxRole::Grid => Role::Grid,
        AxRole::Table => Role::Table,
        AxRole::Row => Role::Row,
        AxRole::Cell => Role::Cell,
        AxRole::ColumnHeader => Role::ColumnHeader,
        AxRole::RowGroup => Role::RowGroup,
        AxRole::Listbox => Role::ListBox,
        AxRole::Option => Role::ListBoxOption,
    })
}

/// How the view of `s` takes part in the tree (its own state only).
pub(crate) fn part(s: &ViewState) -> Part {
    let a = &s.props.accessibility;
    // `visibility: hidden` takes the subtree out, as a browser does: what
    // is not drawn is not read either, nor part of a name.
    if s.concealed || s.style.hidden || a.hidden {
        return Part::Hidden;
    }
    match role_for(a, s.kind, is_pressable(s.events)) {
        Some(r) => Part::Element(r),
        None => Part::Flat,
    }
}

/// True when the element folds its content into its name.
fn groups(s: &ViewState, role: Role) -> bool {
    groups_role(role) || s.props.accessibility.accessible == Some(true)
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
            Part::Element(r) if folding && is_content(r) => {}
            Part::Element(r) => {
                found = Some(v.clone());
                folding = groups(&s, r);
            }
        }
    }
    Ok(found)
}

/// The views of `surface` labelled `label` (`accessibilityLabel`) that take
/// presses and are in the tree, as an assistive technology finds them.
pub(crate) fn pressable_labelled(surface: &Surface, label: &str) -> Vec<NshView> {
    let views = surface.mounter.borrow().views.all();
    views
        .into_iter()
        .filter(|view| {
            view.try_state().is_some_and(|s| {
                is_pressable(s.events) && s.props.accessibility.label.as_deref() == Some(label)
            }) && exposed(view).is_ok()
        })
        .collect()
}

/// [`own_name`] of a view.
#[cfg(test)]
pub(crate) fn name_of(view: &NshView) -> Option<String> {
    let s = view.try_state()?;
    let role = match part(&s) {
        Part::Element(r) => Some(r),
        _ => None,
    };
    own_name(view, &s, role)
}

/// The name of an element: its `accessibilityLabel`, a text view's text,
/// else (for elements that group their content) the texts and labels
/// inside it.
fn own_name(view: &NshView, s: &ViewState, role: Option<Role>) -> Option<String> {
    if let Some(label) = &s.props.accessibility.label {
        return Some(label.to_string());
    }
    if let Some(t) = &s.text {
        return Some(t.text.text.clone());
    }
    if !role.is_some_and(|r| groups(s, r)) {
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
                Part::Element(r) if !is_content(r) => continue,
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

/// The description: a value that is not a range's, and the hint.
pub(crate) fn help_of(a: &Accessibility, role: Role) -> Option<String> {
    let value_text = a
        .value
        .as_ref()
        .and_then(|v| v.text.as_deref())
        .filter(|_| !is_range(role));
    match (value_text, a.hint.as_deref()) {
        (Some(v), Some(h)) => Some(format!("{v}. {h}")),
        (Some(t), None) | (None, Some(t)) => Some(t.to_owned()),
        (None, None) => None,
    }
}

/// A range's minimum, maximum and current value, or `None` when the
/// element has no range.
pub(crate) fn range_of(a: &Accessibility, role: Role) -> Option<(f64, f64, f64)> {
    if !is_range(role) {
        return None;
    }
    let v = a.value.as_ref()?;
    let min = v.min.unwrap_or(0.0) as f64;
    let max = v.max.map_or(100.0f64.max(min), |m| m as f64);
    let now = v.now? as f64;
    Some((min, max.max(min), now.clamp(min, max.max(min))))
}

/// The actions assistive technologies send by name rather than as custom
/// actions.
const STANDARD_ACTIONS: [&str; 8] = [
    "activate",
    "increment",
    "decrement",
    "longpress",
    "expand",
    "collapse",
    "magicTap",
    "escape",
];

/// The AccessKit id of the view `id` of the surface `key`: stable across
/// frames, and apart from every other surface's.
pub(crate) fn node_id(key: u64, id: NodeId) -> accesskit::NodeId {
    // `DefaultHasher::new` has fixed keys: the same id every frame.
    let mut h = std::hash::DefaultHasher::new();
    ("nsh", key, id).hash(&mut h);
    accesskit::NodeId(h.finish())
}

/// The id of an announcement's node.
fn announcement_id(key: u64, sequence: u64) -> accesskit::NodeId {
    let mut h = std::hash::DefaultHasher::new();
    ("nsh-announce", key, sequence).hash(&mut h);
    accesskit::NodeId(h.finish())
}

/// The AccessKit node of the element `view` (its children and bounds
/// aside), and the actions it takes.
fn describe(
    view: &NshView,
    s: &ViewState,
    role: Role,
    field: Option<&FieldValue>,
    live: LiveRegion,
) -> (Node, Vec<Action>) {
    describe_props(
        &s.props,
        s.events,
        own_name(view, s, Some(role)),
        role,
        field,
        live,
        Some(s),
    )
}

fn describe_props(
    props: &nsh_core::ViewProps,
    events: EventMask,
    name: Option<String>,
    role: Role,
    field: Option<&FieldValue>,
    live: LiveRegion,
    view_state: Option<&ViewState>,
) -> (Node, Vec<Action>) {
    let a = &props.accessibility;
    let declares = |name: &str| a.actions.iter().any(|action| &*action.name == name);
    let mut node = Node::new(match role {
        Role::TextInput if field.is_some_and(|f| f.password) => Role::PasswordInput,
        r => r,
    });
    match name {
        // AccessKit reads a label's name from its value.
        Some(name) if role == Role::Label => node.set_value(name),
        Some(name) => node.set_label(name),
        None => {}
    }
    if let Some(f) = field {
        if !f.password {
            node.set_value(f.text.as_str());
        }
        if f.read_only {
            node.set_read_only();
        }
    }
    if let Some(help) = help_of(a, role) {
        node.set_description(help);
    }
    if let Some(id) = &props.test_id {
        node.set_author_id(&**id);
    }
    let state = &a.state;
    if state.disabled {
        node.set_disabled();
    }
    // Tabs and options are selectable whether selected or not: a `false`
    // tells assistive technologies they can be.
    if state.selected || matches!(role, Role::Tab | Role::ListBoxOption) {
        node.set_selected(state.selected);
    }
    if let Some(checked) = state.checked {
        node.set_toggled(match checked {
            Checked::False => Toggled::False,
            Checked::True => Toggled::True,
            Checked::Mixed => Toggled::Mixed,
        });
    }
    if let Some(expanded) = state.expanded {
        node.set_expanded(expanded);
    }
    if state.busy {
        node.set_busy();
    }
    let range = range_of(a, role);
    if let Some((min, max, now)) = range {
        node.set_min_numeric_value(min);
        node.set_max_numeric_value(max);
        node.set_numeric_value(now);
        node.set_numeric_value_step((max - min) / 20.0);
        if let Some(text) = a.value.as_ref().and_then(|v| v.text.as_deref()) {
            node.set_value(text);
        }
    }
    match live {
        LiveRegion::None => {}
        LiveRegion::Polite => node.set_live(Live::Polite),
        LiveRegion::Assertive => node.set_live(Live::Assertive),
    }
    let mut actions = vec![Action::ScrollIntoView];
    if let Some(s) = view_state
        && let Some(sc) = &s.scroll
    {
        let max = sc.max(s.frame.size);
        let (mx, my) = (max.x.0, max.y.0);
        node.set_scroll_x(sc.x.0 as f64);
        node.set_scroll_x_min(0.0);
        node.set_scroll_x_max(mx as f64);
        node.set_scroll_y(sc.y.0 as f64);
        node.set_scroll_y_min(0.0);
        node.set_scroll_y_max(my as f64);
        if my > 0.0 {
            actions.extend([Action::ScrollUp, Action::ScrollDown]);
        }
        if mx > 0.0 {
            actions.extend([Action::ScrollLeft, Action::ScrollRight]);
        }
        actions.push(Action::SetScrollOffset);
    }
    if view_state.is_some_and(|s| s.scroll.is_some() || s.clips()) {
        node.set_clips_children();
    }
    if !state.disabled {
        let pressable = events.contains(EventKind::Press) || declares("activate");
        if pressable {
            actions.push(Action::Click);
        }
        if focusable(role) {
            actions.push(Action::Focus);
        }
        if declares("increment") {
            actions.push(Action::Increment);
        }
        if declares("decrement") {
            actions.push(Action::Decrement);
        }
        if state.expanded.is_some() && (pressable || declares("expand")) {
            actions.push(Action::Expand);
        }
        if state.expanded.is_some() && (pressable || declares("collapse")) {
            actions.push(Action::Collapse);
        }
        if declares("longpress") || events.contains(EventKind::LongPress) {
            actions.push(Action::ShowContextMenu);
        }
        let stepped = range.is_some() && (declares("increment") || declares("decrement"));
        if field.is_some_and(|f| !f.read_only) || stepped {
            actions.push(Action::SetValue);
        }
        let custom: Vec<CustomAction> = a
            .actions
            .iter()
            .enumerate()
            .filter(|(_, d)| !STANDARD_ACTIONS.contains(&&*d.name))
            .map(|(i, d)| CustomAction {
                id: i as i32,
                description: d.label.as_deref().unwrap_or(&d.name).into(),
            })
            .collect();
        if !custom.is_empty() {
            node.set_custom_actions(custom);
            actions.push(Action::CustomAction);
        }
    }
    for action in &actions {
        node.add_action(*action);
    }
    (node, actions)
}

/// One element's node.
struct Entry {
    id: accesskit::NodeId,
    view: NodeId,
    node: Node,
    actions: Vec<Action>,
}

/// A surface's views as AccessKit nodes.
#[derive(Default)]
pub(crate) struct Built {
    /// Every element's node, its children set (children before parents).
    entries: Vec<Entry>,
    /// The elements at the top: children of the surface's node.
    top: Vec<accesskit::NodeId>,
}

impl Built {
    fn index(&self, id: accesskit::NodeId) -> Option<usize> {
        self.entries.iter().position(|e| e.id == id)
    }

    /// Takes the element `id` and its subtree out.
    fn take_subtree(&mut self, id: accesskit::NodeId) -> Option<(Entry, Vec<Entry>)> {
        let entry = self.entries.swap_remove(self.index(id)?);
        let mut below = Vec::new();
        let mut queue: Vec<accesskit::NodeId> = entry.node.children().to_vec();
        while let Some(child) = queue.pop() {
            if let Some(i) = self.index(child) {
                let e = self.entries.swap_remove(i);
                queue.extend_from_slice(e.node.children());
                below.push(e);
            }
        }
        Some((entry, below))
    }
}

/// What the walk over the views needs.
struct Walk<'a> {
    key: u64,
    /// Physical pixels per point.
    scale: f32,
    field: &'a dyn Fn(&NshView) -> Option<FieldValue>,
    out: Built,
}

/// Builds the nodes of the views of `root` (the surface's root view, drawn
/// at `origin` in the window, points).
pub(crate) fn build(
    key: u64,
    root: &NshView,
    origin: (f32, f32),
    scale: f32,
    field: &dyn Fn(&NshView) -> Option<FieldValue>,
) -> Built {
    let mut w = Walk {
        key,
        scale,
        field,
        out: Built::default(),
    };
    let (m, live) = {
        let s = root.state();
        let mut m = Mat4::new().translate(origin.0, origin.1);
        if let Some(t) = s.transform() {
            m = Mat4::mul(&t, &m);
        }
        (m, s.props.accessibility.live_region)
    };
    let mut top = Vec::new();
    walk(&mut w, root, &m, false, live, &mut top);
    w.out.top = top;
    w.out
}

/// Adds the elements under `view` (drawn with `m`) to the walk and their
/// ids to `kids`: plain containers are looked through, hidden subtrees
/// skipped, and inside a grouping element its content is folded into it.
fn walk(
    w: &mut Walk<'_>,
    view: &NshView,
    m: &Mat4,
    grouping: bool,
    live: LiveRegion,
    kids: &mut Vec<accesskit::NodeId>,
) {
    for child in &view.child_views() {
        let Some(s) = child.try_state() else { continue };
        let part = part(&s);
        if part == Part::Hidden {
            continue;
        }
        let (x, y) = view.state().child_origin(s.frame, s.shift);
        let mut local = Mat4::new().translate(x, y);
        if let Some(t) = s.transform() {
            local = Mat4::mul(&t, &local);
        }
        let cm = Mat4::mul(&local, m);
        let live = match s.props.accessibility.live_region {
            LiveRegion::None => live,
            own => own,
        };
        let drawing = s.canvas.as_ref().and_then(|c| c.drawing.clone());
        let role = match part {
            Part::Element(r) if !(grouping && is_content(r)) => r,
            Part::Flat => {
                let id = s.id;
                drop(s);
                walk(w, child, &cm, grouping, live, kids);
                canvas_nodes(w, id, drawing.as_deref(), &cm, kids);
                continue;
            }
            _ => continue,
        };
        let folds = groups(&s, role);
        let input = s.kind == ViewKind::Input;
        drop(s);
        let field = if input { (w.field)(child) } else { None };
        let mut sub = Vec::new();
        walk(w, child, &cm, folds, live, &mut sub);
        let s = child.state();
        if let Some(text) = &s.text {
            for link in &text.text.links {
                let a = &link.props.accessibility;
                if a.hidden {
                    continue;
                }
                let Some(role) = role_for(a, ViewKind::View, is_pressable(link.events)) else {
                    continue;
                };
                let Some(rect) = crate::text::range_bounds(&s, link.start, link.end) else {
                    continue;
                };
                let Some((x, y, width, height)) = cm.bounds(rect.0, rect.1, rect.2, rect.3) else {
                    continue;
                };
                let start = nsh_core::text_edit::utf16_to_byte(&text.text.text, link.start);
                let end = nsh_core::text_edit::utf16_to_byte(&text.text.text, link.end);
                let name = a
                    .label
                    .as_deref()
                    .unwrap_or(&text.text.text[start..end])
                    .to_owned();
                let (mut node, actions) =
                    describe_props(&link.props, link.events, Some(name), role, None, live, None);
                let k = w.scale as f64;
                node.set_bounds(accesskit::Rect {
                    x0: x as f64 * k,
                    y0: y as f64 * k,
                    x1: (x + width) as f64 * k,
                    y1: (y + height) as f64 * k,
                });
                let id = node_id(w.key, link.node);
                w.out.entries.push(Entry {
                    id,
                    view: link.node,
                    node,
                    actions,
                });
                sub.push(id);
            }
        }
        canvas_nodes(w, s.id, drawing.as_deref(), &cm, &mut sub);
        let (mut node, actions) = describe(child, &s, role, field.as_ref(), live);
        if let Some((x, y, bw, bh)) =
            cm.bounds(0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)
        {
            let k = w.scale as f64;
            node.set_bounds(accesskit::Rect {
                x0: x as f64 * k,
                y0: y as f64 * k,
                x1: (x + bw) as f64 * k,
                y1: (y + bh) as f64 * k,
            });
        }
        if !sub.is_empty() {
            node.set_children(sub);
        }
        let id = node_id(w.key, s.id);
        w.out.entries.push(Entry {
            id,
            view: s.id,
            node,
            actions,
        });
        kids.push(id);
    }
}

/// The nodes of canvas `canvas`'s drawing ([`nsh_core::canvas::CanvasNode`])
/// as elements at their bounds (the canvas drawn with `m`), their ids
/// added to `kids`. They take no actions: a pointer presses what is under
/// them.
fn canvas_nodes(
    w: &mut Walk<'_>,
    canvas: NodeId,
    drawing: Option<&nsh_core::canvas::Drawing>,
    m: &Mat4,
    kids: &mut Vec<accesskit::NodeId>,
) {
    let Some(drawing) = drawing else { return };
    for (index, part) in drawing.nodes.iter().enumerate() {
        let a = Accessibility {
            role: part.role,
            label: Some(part.label.clone()),
            ..Accessibility::default()
        };
        let role = role_for(&a, ViewKind::View, false).unwrap_or(Role::Label);
        let mut node = Node::new(role);
        if role == Role::Label {
            node.set_value(&*part.label);
        } else {
            node.set_label(&*part.label);
        }
        if let Some(id) = &part.test_id {
            node.set_author_id(&**id);
        }
        if part.selected {
            node.set_selected(true);
        }
        let b = part.bounds;
        if let Some((x, y, bw, bh)) =
            m.bounds(b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0)
        {
            let k = w.scale as f64;
            node.set_bounds(accesskit::Rect {
                x0: x as f64 * k,
                y0: y as f64 * k,
                x1: (x + bw) as f64 * k,
                y1: (y + bh) as f64 * k,
            });
        }
        let mut h = std::hash::DefaultHasher::new();
        ("nsh-canvas", w.key, canvas, index).hash(&mut h);
        let id = accesskit::NodeId(h.finish());
        w.out.entries.push(Entry {
            id,
            view: canvas,
            node,
            actions: Vec::new(),
        });
        kids.push(id);
    }
}

/// What accessibility keeps for a surface.
#[derive(Default)]
struct State {
    /// A client was attached when the surface last drew.
    active: bool,
    /// The element `AccessibilityFocus` gave the focus to.
    focus: Option<NodeId>,
    /// This frame's nodes, between the prepaint and the synthetic
    /// children.
    built: Option<Built>,
    /// The element the focus proxy stands for this frame, with its
    /// actions.
    proxied: Option<(NodeId, Vec<Action>)>,
    /// The focus proxy, prepainted, to paint (in this frame's element
    /// arena: taken by the paint that follows).
    proxy: Option<AnyElement>,
    /// The listeners to register as the surface paints.
    listeners: Vec<(accesskit::NodeId, NodeId, Vec<Action>)>,
    /// The last announcement and its sequence number.
    announcement: Option<(u64, String)>,
}

thread_local! {
    static STATES: RefCell<FxHashMap<u64, State>> = RefCell::default();
}

fn with_state<R>(surface: &Surface, f: impl FnOnce(&mut State) -> R) -> R {
    STATES.with_borrow_mut(|states| f(states.entry(surface.key()).or_default()))
}

/// True when a client was attached when the surface last drew.
fn active(surface: &Surface) -> bool {
    STATES.with_borrow(|s| s.get(&surface.key()).is_some_and(|s| s.active))
}

/// A view was made.
pub(crate) fn created(_view: &NshView) {}

/// A view's events changed (the next frame's tree has them).
pub(crate) fn events_changed(_view: &NshView) {}

/// A view's props changed (the next frame's tree has them).
pub(crate) fn props_changed(_view: &NshView) {}

/// A view's text changed (the next frame's tree has it).
pub(crate) fn text_changed(_view: &NshView) {}

/// `AccessibilityLabel`: the view's label changed, and nothing else. The
/// label is kept in the view's props, so that the next `ViewProps` diffs
/// against it.
pub(crate) fn label(view: &NshView, label: &Option<Arc<str>>) {
    let mut s = view.state_mut();
    if s.props.accessibility.label != *label {
        s.props.accessibility.label = label.clone();
    }
}

/// A batch is about to be applied.
pub(crate) fn prepare(_batch: &MountBatch) {}

/// A batch was applied: while a client is attached, the surface draws
/// again, so the tree follows changes that draw nothing (labels, states).
pub(crate) fn batch_applied(surface: &Surface) {
    if active(surface) {
        surface.invalidate();
    }
}

/// `AccessibilityFocus`: the view gets the accessibility focus.
pub(crate) fn focus(surface: &Rc<Surface>, view: &NshView) {
    let Ok(Some(element)) = exposed(view) else {
        return;
    };
    with_state(surface, |s| s.focus = Some(element.id()));
    surface.invalidate();
}

/// The keyboard focus moved to `view` (a text field): it takes the
/// accessibility focus. Called by the modules that move it.
pub(crate) fn focus_changed(surface: &Rc<Surface>, _view: &NshView) {
    with_state(surface, |s| s.focus = None);
    surface.invalidate();
}

/// The element with the accessibility focus.
fn focused(surface: &Surface) -> Option<NodeId> {
    if let Some(target) = crate::text_input::focused_target(surface) {
        return Some(target.id());
    }
    let id = STATES.with_borrow(|s| s.get(&surface.key()).and_then(|s| s.focus))?;
    let view = surface.view(id)?;
    match exposed(&view) {
        Ok(Some(e)) => Some(e.id()),
        _ => None,
    }
}

/// Has assistive technologies read `text` (`announce`).
pub(crate) fn announce(surface: &Rc<Surface>, text: &str) {
    if text.is_empty() {
        return;
    }
    with_state(surface, |s| {
        let sequence = s.announcement.as_ref().map_or(0, |a| a.0 + 1);
        s.announcement = Some((sequence, text.to_owned()));
    });
    surface.invalidate();
}

/// The surface element prepaints (before it registers its focus handle):
/// follows the client's attachment into the environment and, while one is
/// attached, builds the nodes and prepaints the focus proxy.
pub(crate) fn prepaint(
    surface: &Rc<Surface>,
    focus_handle: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) {
    let active = window.is_a11y_active();
    let mut env = surface.environment.get();
    if env.screen_reader != active {
        env.screen_reader = active;
        surface.set_environment(env);
    }
    let key = surface.key();
    STATES.with_borrow_mut(|states| {
        // Surfaces that are gone.
        states.retain(|k, _| *k == key || Surface::by_key(*k).is_some());
    });
    if !active {
        with_state(surface, |s| {
            s.active = false;
            s.built = None;
            s.proxied = None;
            s.proxy = None;
            s.listeners.clear();
        });
        return;
    }
    let field = |v: &NshView| crate::text_input::accessible_value(v);
    let scale = window.scale_factor();
    let mut built = build(key, &surface.root, surface.origin.get(), scale, &field);
    let mut proxied = None;
    let mut proxy = None;
    if let Some(view) = focused(surface)
        && let Some((entry, below)) = built.take_subtree(node_id(key, view))
    {
        let node = entry.node;
        let k = scale.max(f32::EPSILON) as f64;
        let b = node.bounds().unwrap_or_default();
        let (x, y) = ((b.x0 / k) as f32, (b.y0 / k) as f32);
        let (w, h) = (((b.x1 - b.x0) / k) as f32, ((b.y1 - b.y0) / k) as f32);
        let mut element = div()
            .id("nsh-a11y-focus")
            .track_focus(focus_handle)
            .role(node.role())
            .w(px(w))
            .h(px(h))
            .a11y_synthetic_children(move |builder: &mut A11ySubtreeBuilder| {
                let children = node.children().to_vec();
                *builder.parent_node() = node;
                for e in below {
                    builder.push_child(e.id, e.node);
                }
                builder.parent_node().set_children(children);
            })
            .into_any_element();
        element.prepaint_as_root(
            point(px(x), px(y)),
            size(
                AvailableSpace::Definite(px(w)),
                AvailableSpace::Definite(px(h)),
            ),
            window,
            cx,
        );
        proxied = Some((view, entry.actions));
        proxy = Some(element);
    }
    with_state(surface, |s| {
        s.active = true;
        s.built = Some(built);
        s.proxied = proxied;
        s.proxy = proxy;
    });
}

/// The surface element's synthetic children: the views' nodes, the focus
/// proxy put where its element is, and the last announcement.
pub(crate) fn synthetic(surface: &Surface, builder: &mut A11ySubtreeBuilder) {
    let key = surface.key();
    let (built, proxied, announcement) = with_state(surface, |s| {
        (s.built.take(), s.proxied.take(), s.announcement.clone())
    });
    let Some(mut built) = built else { return };
    // The proxy is the one node pushed under the surface's so far.
    let proxy = proxied.and_then(|(view, actions)| {
        let id = builder.parent_node().children().first().copied()?;
        Some((id, view, actions))
    });
    if let Some((proxy_id, view, _)) = &proxy {
        let stood_for = node_id(key, *view);
        let swap = |ids: &[accesskit::NodeId]| -> Option<Vec<accesskit::NodeId>> {
            ids.contains(&stood_for).then(|| {
                ids.iter()
                    .map(|&id| if id == stood_for { *proxy_id } else { id })
                    .collect()
            })
        };
        if let Some(top) = swap(&built.top) {
            built.top = top;
        } else {
            for e in &mut built.entries {
                if let Some(children) = swap(e.node.children()) {
                    e.node.set_children(children);
                    break;
                }
            }
        }
    }
    let mut listeners = Vec::with_capacity(built.entries.len() + 1);
    for e in built.entries {
        listeners.push((e.id, e.view, e.actions));
        builder.push_child(e.id, e.node);
    }
    if let Some((id, view, actions)) = proxy {
        listeners.push((id, view, actions));
    }
    let mut top = built.top;
    if let Some((sequence, text)) = announcement {
        let id = announcement_id(key, sequence);
        let mut node = Node::new(Role::Label);
        node.set_value(text);
        node.set_live(Live::Polite);
        if builder.push_child(id, node) {
            top.push(id);
        }
    }
    builder.parent_node().set_children(top);
    with_state(surface, |s| s.listeners = listeners);
}

/// The surface element paints: paints the focus proxy and registers the
/// action listeners.
pub(crate) fn paint(surface: &Surface, window: &mut Window, cx: &mut App) {
    let (proxy, listeners) = with_state(surface, |s| {
        (s.proxy.take(), std::mem::take(&mut s.listeners))
    });
    if let Some(mut proxy) = proxy {
        proxy.paint(window, cx);
    }
    let key = surface.key();
    for (node, view, actions) in listeners {
        for action in actions {
            window.on_a11y_action(node, action, move |data, window, cx| {
                if let Some(surface) = Surface::by_key(key) {
                    if let Some(view) = surface.view(view) {
                        perform(&surface, &view, action, data, window.scale_factor());
                    } else if let Some(target) = crate::text_input::link_target(&surface, view) {
                        perform_link(&surface, target, action, data);
                    }
                }
                crate::rt::flush(cx);
            });
        }
    }
}

/// A virtual link takes the same application action as its pointer press.
fn perform_link(
    surface: &Rc<Surface>,
    target: crate::text_input::FocusTarget,
    action: Action,
    data: Option<&ActionData>,
) {
    let Some(link) = target.link().filter(|link| link.is_enabled()) else {
        return;
    };
    match action {
        Action::Focus => {
            crate::input::focus_link(surface, target.view(), link.node);
        }
        Action::ScrollIntoView => crate::text_input::reveal_target(surface, &target),
        Action::Click => {
            action_or_press_props(
                surface,
                link.node,
                &link.props.accessibility,
                link.events,
                "activate",
                true,
            );
        }
        Action::ShowContextMenu => {
            if !action_or_press_props(
                surface,
                link.node,
                &link.props.accessibility,
                link.events,
                "longpress",
                false,
            ) && link.events.contains(EventKind::LongPress)
            {
                surface.event(
                    link.node,
                    EventKind::LongPress,
                    nsh_core::EventPayload::None,
                );
            }
        }
        Action::CustomAction => {
            if let Some(ActionData::CustomAction(index)) = data
                && let Some(action) = link.props.accessibility.actions.get(*index as usize)
            {
                send_action(surface, link.node, &action.name);
            }
        }
        Action::Increment | Action::Decrement | Action::Expand | Action::Collapse => {
            let name = match action {
                Action::Increment => "increment",
                Action::Decrement => "decrement",
                Action::Expand => "expand",
                _ => "collapse",
            };
            action_or_press_props(
                surface,
                link.node,
                &link.props.accessibility,
                link.events,
                name,
                false,
            );
        }
        _ => {}
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
    let s = view.state();
    action_or_press_props(surface, s.id, &s.props.accessibility, s.events, name, press)
}

fn action_or_press_props(
    surface: &Surface,
    id: NodeId,
    accessibility: &Accessibility,
    events: EventMask,
    name: &str,
    press: bool,
) -> bool {
    let has_action = accessibility
        .actions
        .iter()
        .any(|action| &*action.name == name);
    let pressable = events.contains(EventKind::Press);
    if has_action {
        send_action(surface, id, name);
        true
    } else if press && pressable {
        surface.event(id, EventKind::Press, nsh_core::EventPayload::None);
        true
    } else {
        false
    }
}

/// Sends `onAccessibilityAction` with `name`.
fn send_action(surface: &Surface, id: NodeId, name: &str) {
    surface.event(
        id,
        EventKind::AccessibilityAction,
        nsh_core::EventPayload::Map(vec![(
            "actionName",
            nsh_core::PayloadValue::Str(name.to_owned()),
        )]),
    );
}

/// What a scroll by `unit` moves in a viewport of `size`: a page, or a
/// tenth of one for an item.
fn scroll_step(unit: Option<&ActionData>, size: f32) -> f32 {
    match unit {
        Some(ActionData::ScrollUnit(ScrollUnit::Item)) => (size * 0.1).max(16.0),
        _ => size,
    }
}

/// Performs the AccessKit `action` on `view`.
fn perform(
    surface: &Rc<Surface>,
    view: &NshView,
    action: Action,
    data: Option<&ActionData>,
    scale: f32,
) {
    match action {
        Action::Click => {
            activate(surface, view);
        }
        Action::Focus => {
            if view.kind() == ViewKind::Input {
                crate::text_input::focus(view);
                focus_changed(surface, view);
            } else {
                focus(surface, view);
            }
        }
        Action::Increment => {
            action_or_press(surface, view, "increment", false);
        }
        Action::Decrement => {
            action_or_press(surface, view, "decrement", false);
        }
        Action::Expand | Action::Collapse => {
            let expand = action == Action::Expand;
            if view.state().props.accessibility.state.expanded != Some(expand) {
                let name = if expand { "expand" } else { "collapse" };
                if !action_or_press(surface, view, name, false) {
                    activate(surface, view);
                }
            }
        }
        Action::ShowContextMenu => {
            if !action_or_press(surface, view, "longpress", false) {
                surface.event(
                    view.id(),
                    EventKind::LongPress,
                    nsh_core::EventPayload::None,
                );
            }
        }
        Action::SetValue => match data {
            Some(ActionData::Value(text)) => {
                crate::text_input::set_accessible_value(surface, view, text);
            }
            Some(ActionData::NumericValue(value)) => {
                let now = {
                    let s = view.state();
                    match part(&s) {
                        Part::Element(r) => range_of(&s.props.accessibility, r).map(|r| r.2),
                        _ => None,
                    }
                };
                // Apps change their value in steps: one step toward it.
                match now {
                    Some(now) if *value > now => {
                        action_or_press(surface, view, "increment", false);
                    }
                    Some(now) if *value < now => {
                        action_or_press(surface, view, "decrement", false);
                    }
                    _ => {}
                }
            }
            _ => {}
        },
        Action::CustomAction => {
            if let Some(ActionData::CustomAction(i)) = data {
                let name = usize::try_from(*i).ok().and_then(|i| {
                    let s = view.state();
                    s.props.accessibility.actions.get(i).map(|a| a.name.clone())
                });
                if let Some(name) = name {
                    send_action(surface, view.id(), &name);
                }
            }
        }
        Action::ScrollUp | Action::ScrollDown | Action::ScrollLeft | Action::ScrollRight => {
            let target = {
                let s = view.state();
                s.scroll.as_ref().map(|sc| {
                    let (w, h) = (s.frame.size.width.0, s.frame.size.height.0);
                    let max = sc.max(s.frame.size);
                    let (mx, my) = (max.x.0, max.y.0);
                    let (dx, dy) = match action {
                        Action::ScrollUp => (0.0, -scroll_step(data, h)),
                        Action::ScrollDown => (0.0, scroll_step(data, h)),
                        Action::ScrollLeft => (-scroll_step(data, w), 0.0),
                        _ => (scroll_step(data, w), 0.0),
                    };
                    ((sc.x.0 + dx).clamp(0.0, mx), (sc.y.0 + dy).clamp(0.0, my))
                })
            };
            if let Some((x, y)) = target {
                scroll_to(surface, view, x, y);
            }
        }
        Action::SetScrollOffset => {
            if let Some(ActionData::SetScrollOffset(p)) = data {
                let k = scale.max(f32::EPSILON) as f64;
                scroll_to(surface, view, (p.x / k) as f32, (p.y / k) as f32);
            }
        }
        Action::ScrollIntoView => crate::scroll::reveal(surface, view),
        _ => log::debug!("access: {action:?} is not supported"),
    }
}

/// Scrolls the scroll view `view` to the offset.
fn scroll_to(surface: &Rc<Surface>, view: &NshView, x: f32, y: f32) {
    let command = Command::ScrollTo {
        x: Points(x),
        y: Points(y),
        animated: false,
    };
    crate::scroll::command(surface, view, &command);
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        AccessibilityActionDef, AccessibilityState, AccessibilityValue, AttributedText, ViewProps,
    };

    use super::*;

    fn with_role(role: AxRole) -> Accessibility {
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
    fn roles() {
        let none = Accessibility::default();
        assert_eq!(role_for(&none, ViewKind::View, false), None);
        assert_eq!(role_for(&none, ViewKind::Text, false), Some(Role::Label));
        assert_eq!(
            role_for(&none, ViewKind::Input, false),
            Some(Role::TextInput)
        );
        assert_eq!(
            role_for(&none, ViewKind::Scroll, false),
            Some(Role::ScrollView)
        );
        assert_eq!(role_for(&none, ViewKind::View, true), Some(Role::Button));
        assert_eq!(role_for(&none, ViewKind::Image, false), None);
        let not_element = Accessibility {
            accessible: Some(false),
            ..Default::default()
        };
        assert_eq!(role_for(&not_element, ViewKind::View, true), None);
        let grouped = Accessibility {
            accessible: Some(true),
            ..Default::default()
        };
        assert_eq!(role_for(&grouped, ViewKind::View, false), Some(Role::Group));
        let logo = labelled("Logo");
        assert_eq!(role_for(&logo, ViewKind::Image, false), Some(Role::Image));
        assert_eq!(role_for(&logo, ViewKind::View, false), Some(Role::Group));
        assert_eq!(role_for(&logo, ViewKind::View, true), Some(Role::Button));
        for (role, expected) in [
            (AxRole::Button, Role::Button),
            (AxRole::ImageButton, Role::Button),
            (AxRole::Link, Role::Link),
            (AxRole::Header, Role::Heading),
            (AxRole::Adjustable, Role::Slider),
            (AxRole::Checkbox, Role::CheckBox),
            (AxRole::Switch, Role::Switch),
            (AxRole::Tab, Role::Tab),
            (AxRole::Tablist, Role::TabList),
            (AxRole::Search, Role::SearchInput),
            (AxRole::Progressbar, Role::ProgressIndicator),
            (AxRole::List, Role::List),
            (AxRole::Radio, Role::RadioButton),
            (AxRole::Menuitem, Role::MenuItem),
            (AxRole::Listbox, Role::ListBox),
            (AxRole::Option, Role::ListBoxOption),
            (AxRole::Summary, Role::Status),
            (AxRole::Alert, Role::Alert),
        ] {
            assert_eq!(
                role_for(&with_role(role), ViewKind::View, false),
                Some(expected),
                "{role:?}"
            );
        }
        // An explicit role wins over the text view's.
        assert_eq!(
            role_for(&with_role(AxRole::Header), ViewKind::Text, false),
            Some(Role::Heading)
        );
    }

    fn view(id: NodeId, kind: ViewKind, a: Accessibility) -> NshView {
        let v = NshView::new(id, kind);
        *v.state_mut().props = ViewProps {
            accessibility: a,
            ..Default::default()
        };
        v.state_mut().frame = crate::geom::rect(0.0, id as f32, 100.0, 20.0);
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
                role: AxRole::Switch,
                label: Some("Auto".into()),
                state: AccessibilityState {
                    checked: Some(Checked::True),
                    ..Default::default()
                },
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

    fn built(root: &NshView) -> Built {
        build(7, root, (10.0, 20.0), 2.0, &|_| None)
    }

    fn node(b: &Built, id: NodeId) -> &Node {
        &b.entries
            .iter()
            .find(|e| e.view == id)
            .unwrap_or_else(|| panic!("no node for {id}"))
            .node
    }

    #[test]
    fn hierarchy() {
        let (root, all) = tree();
        let b = built(&root);
        // Plain containers are flattened, hidden subtrees skipped, folded
        // content has no node.
        assert_eq!(b.top, [node_id(7, 4), node_id(7, 6), node_id(7, 22)]);
        let mut views: Vec<NodeId> = b.entries.iter().map(|e| e.view).collect();
        views.sort();
        assert_eq!(views, [4, 6, 14, 22]);
        // The button keeps the switch inside it.
        assert_eq!(node(&b, 6).children(), [node_id(7, 14)]);
        assert_eq!(exposed(&find(&all, 10)), Ok(Some(find(&all, 6))));
        assert_eq!(exposed(&find(&all, 18)), Err(()));
        // Ids are per surface.
        assert_ne!(node_id(7, 4), node_id(8, 4));
    }

    #[test]
    fn descriptions() {
        let (root, all) = tree();
        find(&all, 22).state_mut().props.test_id = Some("footer".into());
        let b = built(&root);
        // Texts are labels, named by their value.
        assert_eq!(node(&b, 4).role(), Role::Label);
        assert_eq!(node(&b, 4).value(), Some("Title"));
        // The button reads its content, not the switch inside it.
        assert_eq!(node(&b, 6).role(), Role::Button);
        assert_eq!(node(&b, 6).label(), Some("Save icon"));
        assert!(node(&b, 6).supports_action(Action::Click));
        assert!(node(&b, 6).supports_action(Action::Focus));
        assert_eq!(node(&b, 14).role(), Role::Switch);
        assert_eq!(node(&b, 14).label(), Some("Auto"));
        assert_eq!(node(&b, 14).toggled(), Some(Toggled::True));
        assert_eq!(node(&b, 22).author_id(), Some("footer"));
        // Bounds in physical pixels, at the surface's origin: text 4 is at
        // (0, 4) in the plain view at (0, 2).
        let r = node(&b, 4).bounds().unwrap();
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (20.0, 52.0, 220.0, 92.0));
        // A label wins over the content.
        find(&all, 6).state_mut().props.accessibility.label = Some("Store".into());
        assert_eq!(name_of(&find(&all, 6)).as_deref(), Some("Store"));
        assert_eq!(node(&built(&root), 6).label(), Some("Store"));
    }

    #[test]
    fn states_and_actions() {
        let root = view(0, ViewKind::View, Accessibility::default());
        root.set_invalidate(Rc::new(|| {}));
        let slider = view(
            2,
            ViewKind::View,
            Accessibility {
                role: AxRole::Adjustable,
                hint: Some("Volume".into()),
                value: Some(AccessibilityValue {
                    min: Some(0.0),
                    max: Some(10.0),
                    now: Some(3.0),
                    text: Some("3 of 10".into()),
                }),
                actions: vec![
                    AccessibilityActionDef {
                        name: "increment".into(),
                        label: None,
                    },
                    AccessibilityActionDef {
                        name: "reset".into(),
                        label: Some("Reset".into()),
                    },
                ],
                state: AccessibilityState {
                    busy: true,
                    ..Default::default()
                },
                live_region: LiveRegion::Assertive,
                ..Default::default()
            },
        );
        let off = pressable(
            4,
            Accessibility {
                state: AccessibilityState {
                    disabled: true,
                    expanded: Some(false),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        let field = view(6, ViewKind::Input, labelled("Password"));
        slider.insert_before(&root, None);
        off.insert_before(&root, None);
        field.insert_before(&root, None);
        let b = build(1, &root, (0.0, 0.0), 1.0, &|v| {
            (v.id() == 6).then(|| FieldValue {
                text: "hunter2".into(),
                read_only: false,
                password: true,
            })
        });
        let s = node(&b, 2);
        assert_eq!(s.role(), Role::Slider);
        assert_eq!(s.numeric_value(), Some(3.0));
        assert_eq!(s.max_numeric_value(), Some(10.0));
        assert_eq!(s.value(), Some("3 of 10"));
        assert_eq!(s.description(), Some("Volume"));
        assert!(s.is_busy());
        assert_eq!(s.live(), Some(Live::Assertive));
        assert!(s.supports_action(Action::Increment));
        assert!(!s.supports_action(Action::Decrement));
        assert!(s.supports_action(Action::SetValue));
        assert_eq!(s.custom_actions().len(), 1);
        assert_eq!(&*s.custom_actions()[0].description, "Reset");
        assert_eq!(s.custom_actions()[0].id, 1);
        // Disabled: no actions but scrolling into view.
        let o = node(&b, 4);
        assert!(o.is_disabled());
        assert_eq!(o.is_expanded(), Some(false));
        assert!(!o.supports_action(Action::Click));
        assert!(o.supports_action(Action::ScrollIntoView));
        // Secure fields are password inputs and do not show their text.
        let f = node(&b, 6);
        assert_eq!(f.role(), Role::PasswordInput);
        assert_eq!(f.label(), Some("Password"));
        assert_eq!(f.value(), None);
        assert!(f.supports_action(Action::SetValue));
    }

    /// `visibility: hidden` takes the view and its subtree out of the tree,
    /// of names folded from content and of the accessibility focus, as a
    /// browser does.
    #[test]
    fn a_hidden_style_hides_the_subtree() {
        let (root, all) = tree();
        find(&all, 8).state_mut().style.hidden = true;
        assert_eq!(part(&find(&all, 8).state()), Part::Hidden);
        assert_eq!(name_of(&find(&all, 6)).as_deref(), Some("icon"));
        assert_eq!(node(&built(&root), 6).label(), Some("icon"));
        assert_eq!(exposed(&find(&all, 10)), Err(()));
        find(&all, 2).state_mut().style.hidden = true;
        let b = built(&root);
        assert_eq!(b.top, [node_id(7, 22)]);
        assert_eq!(exposed(&find(&all, 14)), Err(()));
        find(&all, 2).state_mut().style.hidden = false;
        find(&all, 8).state_mut().style.hidden = false;
        assert_eq!(node(&built(&root), 6).label(), Some("Save icon"));
    }

    #[test]
    fn canvas_nodes_are_elements() {
        use nsh_core::canvas::{CanvasNode, Drawing};
        let root = view(0, ViewKind::View, Accessibility::default());
        root.set_invalidate(Rc::new(|| {}));
        let grid = view(2, ViewKind::Canvas, Accessibility::default());
        let at = |x: f32| {
            nsh_core::geometry::Bounds::new(
                nsh_core::geometry::point(Points(x), Points(0.0)),
                nsh_core::geometry::size(Points(40.0), Points(20.0)),
            )
        };
        let drawing = Drawing {
            nodes: vec![
                CanvasNode::new(at(0.0), AxRole::Header, "A"),
                CanvasNode::new(at(40.0), AxRole::Text, "12")
                    .test_id("cell-a1")
                    .selected(true),
            ],
            ..Drawing::default()
        };
        let mut state = crate::canvas::CanvasState::default();
        state.drawing = Some(Arc::new(drawing));
        grid.state_mut().canvas = Some(state);
        grid.insert_before(&root, None);
        let b = built(&root);
        assert_eq!(b.top.len(), 2);
        let entry = |label: &str| {
            b.entries
                .iter()
                .find(|e| e.node.label() == Some(label) || e.node.value() == Some(label))
                .unwrap_or_else(|| panic!("no node {label}"))
        };
        let header = entry("A");
        assert_eq!(header.node.role(), Role::Heading);
        assert_eq!(header.view, 2);
        let cell = entry("12");
        assert_eq!(cell.node.role(), Role::Label);
        assert_eq!(cell.node.author_id(), Some("cell-a1"));
        assert_eq!(cell.node.is_selected(), Some(true));
        assert!(cell.actions.is_empty());
        // At the surface's origin (10, 20) and the canvas's (0, 2), in
        // physical pixels.
        let r = cell.node.bounds().unwrap();
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (100.0, 44.0, 180.0, 84.0));
    }

    #[test]
    fn subtrees() {
        let (root, _all) = tree();
        let mut b = built(&root);
        let (entry, below) = b.take_subtree(node_id(7, 6)).unwrap();
        assert_eq!(entry.view, 6);
        assert_eq!(below.iter().map(|e| e.view).collect::<Vec<_>>(), [14]);
        let mut left: Vec<NodeId> = b.entries.iter().map(|e| e.view).collect();
        left.sort();
        assert_eq!(left, [4, 22]);
    }

    #[test]
    fn help_and_ranges() {
        let value = AccessibilityValue {
            min: Some(0.0),
            max: Some(10.0),
            now: Some(3.0),
            text: Some("3 of 10".into()),
        };
        let button = Accessibility {
            role: AxRole::Button,
            hint: Some("Plays".into()),
            value: Some(value),
            ..Default::default()
        };
        assert_eq!(range_of(&button, Role::Button), None);
        assert_eq!(
            help_of(&button, Role::Button).as_deref(),
            Some("3 of 10. Plays")
        );
        let progress = Accessibility {
            value: Some(AccessibilityValue {
                now: Some(140.0),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            range_of(&progress, Role::ProgressIndicator),
            Some((0.0, 100.0, 100.0))
        );
    }
}
