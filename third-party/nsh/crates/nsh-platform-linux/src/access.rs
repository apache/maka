//! Accessibility: GTK accessible roles, labels and states from the views'
//! `ViewProps` and text.
//!
//! GTK exposes widgets to assistive technologies (AT-SPI) through
//! `GtkAccessible`; every [`NshView`] is one. Each view gets:
//!
//! - a role ([`role_for`]): the `accessibilityRole`'s, `Label` for text
//!   views, `Button` for views with press handlers, `Img` for labelled
//!   images, `Group` for other labelled views (GTK names no generic
//!   element), `Generic` otherwise;
//! - its label (`accessibilityLabel`, or a text view's text; GTK computes
//!   the name of buttons, links, headings, ... without a label from the
//!   text inside them), its description (`accessibilityHint`), its value
//!   (`accessibilityValue`: a range for range roles, else read as part of
//!   the description) and its states (`accessibilityState`,
//!   `accessibilityElementsHidden`, which hides the subtree, and
//!   `visibility: hidden`, which does too, as in a browser);
//! - its `testID` as the widget name (what GTK Inspector shows).
//!
//! What GTK cannot express: `accessible={true}` grouping (children stay
//! separate elements; buttons still read the text inside them),
//! `accessibilityActions` (GTK has no custom actions; AT-SPI's "activate"
//! of a button needs an activate signal) and live regions, which are
//! emulated by announcing a changed label or text
//! (`gtk_accessible_announce`).
//!
//! Every update is diffed against what was last given to GTK
//! ([`Applied`]): `ViewProps` also carries touch properties, and `Text`
//! items come again on every relayout.

use std::{cell::RefCell, sync::Arc};

use gtk4::{self as gtk, AccessibleRole as Gtk, accessible, prelude::*};
use nsh_core::{
    Accessibility, AccessibilityRole as Role, AttributedText, Checked, EventKind, EventMask,
    LiveRegion, MountBatch, MountItem, NodeId, ViewKind, ViewStyle,
};
use rustc_hash::FxHashMap;

use crate::view::NshView;

/// What was last given to GTK for one view.
#[derive(Debug, Default)]
pub(crate) struct Applied {
    /// The applied description; `None` until the first update.
    spec: Option<Box<Spec>>,
    /// The text a text view's label was taken from.
    text: Option<Arc<AttributedText>>,
    /// The `testID` set as the widget name.
    test_id: Option<Arc<str>>,
}

/// Everything set on a view's `GtkAccessible`.
#[derive(Debug, Clone, PartialEq)]
struct Spec {
    role: Gtk,
    label: Option<String>,
    description: Option<String>,
    /// Min, max, now and text of a range.
    range: Option<Range>,
    disabled: bool,
    selected: bool,
    /// `Pressed` for buttons (toggle buttons, as ARIA's `aria-pressed`;
    /// GTK's `ToggleButton` role would lose the name computed from the
    /// content), `Checked` for the rest.
    checked: Option<Checked>,
    expanded: Option<bool>,
    busy: bool,
    hidden: bool,
}

/// The value of a range role.
#[derive(Debug, Clone, PartialEq)]
struct Range {
    min: Option<f32>,
    max: Option<f32>,
    now: Option<f32>,
    text: Option<Arc<str>>,
}

thread_local! {
    /// The roles of the views the batch being applied creates
    /// ([`prepare`]), taken when they are created ([`created`]).
    static PENDING: RefCell<FxHashMap<NodeId, Gtk>> = RefCell::default();
}

/// A batch is about to be applied: finds the roles of the views it
/// creates.
///
/// GTK keeps a widget's role once its AT context is realized, and an
/// assistive technology that watches the window realizes it as soon as
/// the view is inserted, which comes before its props in a batch. Views
/// get their role when they are created instead, before anything sees
/// them.
pub(crate) fn prepare(batch: &MountBatch) {
    let mut drafts: FxHashMap<NodeId, (ViewKind, Option<&Accessibility>, bool)> =
        FxHashMap::default();
    for item in &batch.items {
        match item {
            MountItem::Create { id, kind } => {
                drafts.insert(*id, (*kind, None, false));
            }
            MountItem::ViewProps { id, props } => {
                if let Some(d) = drafts.get_mut(id) {
                    d.1 = Some(&props.accessibility);
                }
            }
            MountItem::Events { id, events } => {
                if let Some(d) = drafts.get_mut(id) {
                    d.2 = is_pressable(*events);
                }
            }
            _ => {}
        }
    }
    if drafts.is_empty() {
        return;
    }
    let none = Accessibility::default();
    PENDING.with_borrow_mut(|pending| {
        pending.clear();
        for (id, (kind, a, pressable)) in drafts {
            let role = role_for(a.unwrap_or(&none), kind, pressable);
            if role != Gtk::Generic {
                pending.insert(id, role);
            }
        }
    });
}

/// A view was created: gives it the role [`prepare`] found.
pub(crate) fn created(view: &NshView) {
    let id = view.id();
    if let Some(role) = PENDING.with_borrow_mut(|p| p.remove(&id)) {
        view.set_accessible_role(role);
    }
}

/// The view's props changed.
pub(crate) fn props_changed(view: &NshView) {
    let test_id = {
        let s = view.state();
        let id = &s.props.test_id;
        (*id != s.access.test_id).then(|| id.clone())
    };
    if let Some(id) = test_id {
        // The type name is what GTK shows for unnamed widgets.
        view.set_widget_name(id.as_deref().unwrap_or("NshView"));
        view.state_mut().access.test_id = id;
    }
    update(view);
}

/// The view's event listeners changed: views with press handlers are
/// buttons.
pub(crate) fn events_changed(view: &NshView) {
    update(view);
}

/// The view's style changed: `visibility` hides or shows its subtree.
pub(crate) fn style_changed(view: &NshView, old: &ViewStyle) {
    if view.state().style.hidden != old.hidden {
        update(view);
    }
}

/// A text view's text changed.
pub(crate) fn text_changed(view: &NshView) {
    let first = {
        let mut s = view.state_mut();
        let s = &mut *s;
        let Some(drawn) = &s.text else { return };
        let old = s.access.text.replace(drawn.text.clone());
        match old {
            Some(old) if Arc::ptr_eq(&old, &drawn.text) || old.text == drawn.text.text => return,
            old => old.is_none(),
        }
    };
    if update(view) && !first {
        announce_live(view);
    }
}

/// Has assistive technologies read `text` (`announce`).
pub(crate) fn announce(widget: &impl IsA<gtk::Accessible>, text: &str) {
    widget.announce(text, gtk::AccessibleAnnouncementPriority::Medium);
}

/// Brings what GTK knows of the view up to date; true if its label
/// changed.
fn update(view: &NshView) -> bool {
    let (spec, old, live) = {
        let mut s = view.state_mut();
        let s = &mut *s;
        let a = &s.props.accessibility;
        let pressable = is_pressable(s.events);
        let text = s.text.as_ref().map(|t| t.text.text.as_str());
        let spec = spec_for(a, s.kind, pressable, text, s.style.hidden);
        if s.access.spec.as_deref() == Some(&spec) {
            return false;
        }
        (spec, s.access.spec.take(), a.live_region)
    };
    let old = old.as_deref();
    if spec.role != view.accessible_role() {
        set_role(view, spec.role);
    }
    apply(view, old, &spec);
    let label_changed = old.is_some_and(|o| o.label != spec.label);
    let is_text = view.state().text.is_some();
    if label_changed
        && live != LiveRegion::None
        && !is_text
        && let Some(label) = &spec.label
    {
        view.announce(label, priority(live));
    }
    view.state_mut().access.spec = Some(Box::new(spec));
    label_changed
}

/// Changes the role of a view that has one already.
///
/// GTK refuses (with a critical) to change the role of a widget whose AT
/// context is realized, and nothing tells whether it is; taking the view
/// out of the window unrealizes it. Roles rarely change after a view is
/// made ([`prepare`] gives the first one), so the view is detached and
/// put back in its place.
fn set_role(view: &NshView, role: Gtk) {
    match view.parent() {
        Some(parent) if view.root().is_some() => {
            let next = view.next_sibling();
            view.unparent();
            view.set_accessible_role(role);
            view.insert_before(&parent, next.as_ref());
        }
        _ => view.set_accessible_role(role),
    }
}

/// Views with press handlers are buttons.
fn is_pressable(events: EventMask) -> bool {
    events.contains(EventKind::Press) || events.contains(EventKind::LongPress)
}

/// Sets on GTK what differs between `old` and `new`.
fn apply(view: &NshView, old: Option<&Spec>, new: &Spec) {
    let mut props: Vec<accessible::Property<'_>> = Vec::new();
    let mut reset: Vec<gtk::AccessibleProperty> = Vec::new();
    push_text(
        &mut props,
        &mut reset,
        old.map(|o| o.label.as_deref()),
        new.label.as_deref(),
        accessible::Property::Label,
        gtk::AccessibleProperty::Label,
    );
    push_text(
        &mut props,
        &mut reset,
        old.map(|o| o.description.as_deref()),
        new.description.as_deref(),
        accessible::Property::Description,
        gtk::AccessibleProperty::Description,
    );
    let old_range = old.map(|o| o.range.as_ref());
    if old_range != Some(new.range.as_ref()) {
        let r = new.range.as_ref();
        let was = old_range.flatten();
        for (now, before, make, key) in [
            (
                r.and_then(|r| r.min),
                was.and_then(|r| r.min),
                accessible::Property::ValueMin as fn(f64) -> accessible::Property<'static>,
                gtk::AccessibleProperty::ValueMin,
            ),
            (
                r.and_then(|r| r.max),
                was.and_then(|r| r.max),
                accessible::Property::ValueMax,
                gtk::AccessibleProperty::ValueMax,
            ),
            (
                r.and_then(|r| r.now),
                was.and_then(|r| r.now),
                accessible::Property::ValueNow,
                gtk::AccessibleProperty::ValueNow,
            ),
        ] {
            match now {
                Some(v) => props.push(make(v as f64)),
                None if before.is_some() => reset.push(key),
                None => {}
            }
        }
        push_text(
            &mut props,
            &mut reset,
            old_range.map(|r| r.and_then(|r| r.text.as_deref())),
            r.and_then(|r| r.text.as_deref()),
            accessible::Property::ValueText,
            gtk::AccessibleProperty::ValueText,
        );
    }
    if !props.is_empty() {
        view.update_property(&props);
    }
    for p in reset {
        view.reset_property(p);
    }

    let mut states: Vec<accessible::State> = Vec::new();
    let mut reset: Vec<gtk::AccessibleState> = Vec::new();
    for (on, was, state, key) in [
        (
            new.disabled,
            old.map(|o| o.disabled),
            accessible::State::Disabled(true),
            gtk::AccessibleState::Disabled,
        ),
        (
            new.selected,
            old.map(|o| o.selected),
            accessible::State::Selected(Some(true)),
            gtk::AccessibleState::Selected,
        ),
        (
            new.busy,
            old.map(|o| o.busy),
            accessible::State::Busy(true),
            gtk::AccessibleState::Busy,
        ),
        (
            new.hidden,
            old.map(|o| o.hidden),
            accessible::State::Hidden(true),
            gtk::AccessibleState::Hidden,
        ),
    ] {
        if was == Some(on) {
            continue;
        }
        if on {
            states.push(state);
        } else if was.is_some() {
            reset.push(key);
        }
    }
    if old.is_none_or(|o| o.expanded != new.expanded) {
        match new.expanded {
            Some(e) => states.push(accessible::State::Expanded(Some(e))),
            None if old.is_some() => reset.push(gtk::AccessibleState::Expanded),
            None => {}
        }
    }
    if old.is_none_or(|o| o.checked != new.checked || o.role != new.role) {
        let key = |role| {
            if role == Gtk::Button {
                gtk::AccessibleState::Pressed
            } else {
                gtk::AccessibleState::Checked
            }
        };
        if let Some(o) = old.filter(|o| o.checked.is_some())
            && (new.checked.is_none() || key(o.role) != key(new.role))
        {
            reset.push(key(o.role));
        }
        if let Some(c) = new.checked {
            let t = match c {
                Checked::False => gtk::AccessibleTristate::False,
                Checked::True => gtk::AccessibleTristate::True,
                Checked::Mixed => gtk::AccessibleTristate::Mixed,
            };
            states.push(if new.role == Gtk::Button {
                accessible::State::Pressed(t)
            } else {
                accessible::State::Checked(t)
            });
        }
    }
    for s in reset {
        view.reset_state(s);
    }
    if !states.is_empty() {
        view.update_state(&states);
    }
}

/// Queues a string property: set when it has a value, reset when it lost
/// one, nothing when it did not change.
fn push_text<'a>(
    props: &mut Vec<accessible::Property<'a>>,
    reset: &mut Vec<gtk::AccessibleProperty>,
    was: Option<Option<&str>>,
    now: Option<&'a str>,
    make: fn(&'a str) -> accessible::Property<'a>,
    key: gtk::AccessibleProperty,
) {
    if was == Some(now) {
        return;
    }
    match now {
        Some(v) => props.push(make(v)),
        None if was.is_some() => reset.push(key),
        None => {}
    }
}

/// What to give GTK for a view of `kind` with accessibility `a`;
/// `invisible` for `visibility: hidden`, which hides the subtree as
/// `accessibilityElementsHidden` does: what is not drawn is not read either.
fn spec_for(
    a: &Accessibility,
    kind: ViewKind,
    pressable: bool,
    text: Option<&str>,
    invisible: bool,
) -> Spec {
    let role = role_for(a, kind, pressable);
    let label = a.label.as_deref().or(text).map(str::to_owned);
    let ranged = is_range(role);
    let value = a.value.as_ref();
    // Outside range roles, a value is only read as part of the
    // description.
    let value_text = value.and_then(|v| v.text.as_deref()).filter(|_| !ranged);
    let description = match (value_text, a.hint.as_deref()) {
        (Some(v), Some(h)) => Some(format!("{v}. {h}")),
        (Some(t), None) | (None, Some(t)) => Some(t.to_owned()),
        (None, None) => None,
    };
    Spec {
        role,
        label,
        description,
        range: value.filter(|_| ranged).map(|v| Range {
            min: v.min,
            max: v.max,
            now: v.now,
            text: v.text.clone(),
        }),
        disabled: a.state.disabled,
        selected: a.state.selected,
        checked: a.state.checked,
        expanded: a.state.expanded,
        busy: a.state.busy,
        hidden: a.hidden || invisible,
    }
}

/// The GTK role of a view of `kind`, with press handlers or not.
fn role_for(a: &Accessibility, kind: ViewKind, pressable: bool) -> Gtk {
    match a.role {
        Role::None => match kind {
            ViewKind::Text => Gtk::Label,
            ViewKind::Image if a.label.is_some() => Gtk::Img,
            _ if pressable && a.accessible != Some(false) => Gtk::Button,
            // GTK gives generic elements no name: a labelled view is a
            // group, which reads its label.
            _ if a.label.is_some() && a.accessible != Some(false) => Gtk::Group,
            _ => Gtk::Generic,
        },
        Role::Button | Role::ImageButton | Role::KeyboardKey => Gtk::Button,
        Role::Link => Gtk::Link,
        Role::Search => Gtk::SearchBox,
        Role::Image => Gtk::Img,
        Role::Text => Gtk::Label,
        Role::Adjustable => Gtk::Slider,
        Role::Header => Gtk::Heading,
        Role::Summary => Gtk::Status,
        Role::Alert => Gtk::Alert,
        Role::Checkbox => Gtk::Checkbox,
        Role::Combobox => Gtk::ComboBox,
        Role::Menu => Gtk::Menu,
        Role::Menubar => Gtk::MenuBar,
        Role::Menuitem if a.state.checked.is_some() => Gtk::MenuItemCheckbox,
        Role::Menuitem => Gtk::MenuItem,
        Role::Progressbar => Gtk::ProgressBar,
        Role::Radio => Gtk::Radio,
        Role::Radiogroup => Gtk::RadioGroup,
        Role::Scrollbar => Gtk::Scrollbar,
        Role::Spinbutton => Gtk::SpinButton,
        Role::Switch => Gtk::Switch,
        Role::Tab => Gtk::Tab,
        Role::Tablist => Gtk::TabList,
        Role::Timer => Gtk::Timer,
        Role::Toolbar => Gtk::Toolbar,
        Role::List => Gtk::List,
        Role::Grid => Gtk::Grid,
        Role::Table => Gtk::Table,
        Role::Row => Gtk::Row,
        Role::Cell => Gtk::Cell,
        Role::ColumnHeader => Gtk::ColumnHeader,
        Role::RowGroup => Gtk::RowGroup,
        Role::Listbox => Gtk::ListBox,
        Role::Option => Gtk::Option,
    }
}

/// Roles whose value is a range (AT-SPI's Value interface).
fn is_range(role: Gtk) -> bool {
    matches!(
        role,
        Gtk::Slider | Gtk::ProgressBar | Gtk::SpinButton | Gtk::Scrollbar | Gtk::Meter
    )
}

/// How urgently a live region's change is announced.
fn priority(live: LiveRegion) -> gtk::AccessibleAnnouncementPriority {
    match live {
        LiveRegion::Assertive => gtk::AccessibleAnnouncementPriority::High,
        _ => gtk::AccessibleAnnouncementPriority::Medium,
    }
}

/// A text view's text changed: announces it if it is in a live region.
fn announce_live(view: &NshView) {
    let mut at = Some(view.clone());
    while let Some(v) = at {
        let live = v.state().props.accessibility.live_region;
        if live != LiveRegion::None {
            if let Some(t) = &view.state().text {
                view.announce(&t.text.text, priority(live));
            }
            return;
        }
        at = v.parent_view();
    }
}

/// `MountItem::AccessibilityLabel`: the view's label changed, and nothing
/// else. The label is kept in the view's props, so that the next
/// `ViewProps` diffs against it; a label of a live region is announced.
pub(crate) fn label(view: &NshView, label: &Option<Arc<str>>) {
    {
        let mut s = view.state_mut();
        if s.props.accessibility.label == *label {
            return;
        }
        s.props.accessibility.label = label.clone();
    }
    update(view);
}

#[cfg(test)]
mod tests {
    use nsh_core::{AccessibilityState, AccessibilityValue};

    use super::*;

    fn with_role(role: Role) -> Accessibility {
        Accessibility {
            role,
            ..Default::default()
        }
    }

    #[test]
    fn roles() {
        let none = Accessibility::default();
        assert_eq!(role_for(&none, ViewKind::View, false), Gtk::Generic);
        assert_eq!(role_for(&none, ViewKind::Text, false), Gtk::Label);
        assert_eq!(role_for(&none, ViewKind::View, true), Gtk::Button);
        assert_eq!(role_for(&none, ViewKind::Image, false), Gtk::Generic);
        let not_element = Accessibility {
            accessible: Some(false),
            ..Default::default()
        };
        assert_eq!(role_for(&not_element, ViewKind::View, true), Gtk::Generic);
        let labelled = Accessibility {
            label: Some("Logo".into()),
            ..Default::default()
        };
        assert_eq!(role_for(&labelled, ViewKind::Image, false), Gtk::Img);
        assert_eq!(role_for(&labelled, ViewKind::View, false), Gtk::Group);
        assert_eq!(role_for(&labelled, ViewKind::View, true), Gtk::Button);
        for (role, gtk) in [
            (Role::Button, Gtk::Button),
            (Role::ImageButton, Gtk::Button),
            (Role::Link, Gtk::Link),
            (Role::Header, Gtk::Heading),
            (Role::Adjustable, Gtk::Slider),
            (Role::Checkbox, Gtk::Checkbox),
            (Role::Switch, Gtk::Switch),
            (Role::Tab, Gtk::Tab),
            (Role::Tablist, Gtk::TabList),
            (Role::Search, Gtk::SearchBox),
            (Role::Progressbar, Gtk::ProgressBar),
            (Role::List, Gtk::List),
            (Role::Listbox, Gtk::ListBox),
            (Role::Option, Gtk::Option),
        ] {
            assert_eq!(
                role_for(&with_role(role), ViewKind::View, false),
                gtk,
                "{role:?}"
            );
        }
        // An explicit role wins over the text view's.
        assert_eq!(
            role_for(&with_role(Role::Header), ViewKind::Text, false),
            Gtk::Heading
        );
        let checked_item = Accessibility {
            role: Role::Menuitem,
            state: AccessibilityState {
                checked: Some(Checked::True),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            role_for(&checked_item, ViewKind::View, false),
            Gtk::MenuItemCheckbox
        );
    }

    #[test]
    fn labels_and_values() {
        // A text view reads its text unless it has a label.
        let s = spec_for(
            &with_role(Role::Header),
            ViewKind::Text,
            false,
            Some("Title"),
            false,
        );
        assert_eq!(s.label.as_deref(), Some("Title"));
        let labelled = Accessibility {
            label: Some("Label".into()),
            hint: Some("Opens it".into()),
            ..Default::default()
        };
        let s = spec_for(&labelled, ViewKind::Text, false, Some("Title"), false);
        assert_eq!(s.label.as_deref(), Some("Label"));
        assert_eq!(s.description.as_deref(), Some("Opens it"));

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
        let s = spec_for(&slider, ViewKind::View, false, None, false);
        assert_eq!(s.range.as_ref().and_then(|r| r.now), Some(3.0));
        assert_eq!(s.description, None);
        // Outside range roles the value is part of the description.
        let button = Accessibility {
            role: Role::Button,
            hint: Some("Plays".into()),
            value: Some(value),
            ..Default::default()
        };
        let s = spec_for(&button, ViewKind::View, false, None, false);
        assert_eq!(s.range, None);
        assert_eq!(s.description.as_deref(), Some("3 of 10. Plays"));
    }

    /// `visibility: hidden` hides the view and its subtree as
    /// `accessibilityElementsHidden` does, whatever the view is.
    #[test]
    fn a_hidden_style_hides_the_subtree() {
        let labelled = Accessibility {
            label: Some("Save".into()),
            ..Default::default()
        };
        let none = Accessibility::default();
        for (a, kind, pressable, text) in [
            (&labelled, ViewKind::View, true, None),
            (&none, ViewKind::Text, false, Some("Title")),
            (&none, ViewKind::View, false, None),
        ] {
            let shown = spec_for(a, kind, pressable, text, false);
            assert!(!shown.hidden, "{kind:?}");
            let hidden = spec_for(a, kind, pressable, text, true);
            assert!(hidden.hidden, "{kind:?}");
            assert_eq!(hidden.role, shown.role, "only hidden changes");
        }
    }
}
