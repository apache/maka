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
//!   text inside them), its description (`accessibilityDescription` and
//!   `accessibilityHint`), its value
//!   (`accessibilityValue`: a range for range roles, else read as part of
//!   the description) and its states (`accessibilityState`,
//!   `accessibilityElementsHidden`, which hides the subtree, and
//!   `visibility: hidden`, which does too, as in a browser);
//! - its `testID` as the widget name (what GTK Inspector shows);
//! - press handlers and app-drawn window controls as the parameterless `nsh.activate`
//!   action, exposed by GTK through AT-SPI's Action interface.
//!
//! Not yet supported: `accessible={true}` grouping (children stay
//! separate elements; buttons still read the text inside them),
//! `accessibilityActions` and live regions, which are
//! emulated by announcing a changed label or text
//! (`gtk_accessible_announce`).
//!
//! Every update is diffed against what was last given to GTK
//! ([`Applied`]): `ViewProps` also carries touch properties, and `Text`
//! items come again on every relayout.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use gtk4::{self as gtk, AccessibleRole as Gtk, accessible, prelude::*};
use nsh_core::{
    Accessibility, AccessibilityRole as Role, AttributedText, Checked, EventKind, EventMask,
    LiveRegion, MountBatch, MountItem, NodeId, ViewKind, ViewStyle,
};
use rustc_hash::FxHashMap;

use crate::{surface::Surface, view::NshView};

/// What was last given to GTK for one view.
#[derive(Debug, Default)]
pub(crate) struct Applied {
    /// The native action, allocated for a press handler or app-drawn window control.
    activation: Option<ActivationGroup>,
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
    /// `Pressed` for buttons (toggle buttons, as ARIA's `aria-pressed`:
    /// `accessibilityState.pressed`, else `checked`; GTK's `ToggleButton`
    /// role would lose the name computed from the content), `Checked` for
    /// the rest.
    checked: Option<Checked>,
    /// A heading's level, a tree item's depth (`accessibilityLevel`).
    level: Option<u32>,
    expanded: Option<bool>,
    busy: bool,
    /// The content does not pass the app's checks (AT-SPI's invalid entry).
    invalid: bool,
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

gtk::glib::wrapper! {
    /// Private AT action: GTK's AT-SPI bridge queries admission on every call.
    /// This is not a signal-driven GtkActionable binding: no enabled state is cached.
    pub(crate) struct ActivationGroup(ObjectSubclass<activation_group::Group>) @implements gtk::gio::ActionGroup;
}

impl ActivationGroup {
    fn new(surface: &Rc<Surface>, view: &NshView) -> Self {
        use gtk::glib::subclass::prelude::*;
        let group: Self = gtk::glib::Object::new();
        assert!(
            group
                .imp()
                .target
                .set((Rc::downgrade(surface), view.downgrade()))
                .is_ok()
        );
        group
    }
}

mod activation_group {
    use std::{cell::OnceCell, rc::Weak};

    use gio::subclass::prelude::*;
    use gtk::{gio, glib};

    use super::*;

    #[derive(Default)]
    pub(crate) struct Group {
        pub(super) target: OnceCell<(Weak<Surface>, glib::WeakRef<NshView>)>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Group {
        const NAME: &'static str = "NshActivationGroup";
        type Type = ActivationGroup;
        type Interfaces = (gio::ActionGroup,);
    }

    impl ObjectImpl for Group {}

    impl Group {
        fn target(&self) -> Option<(Rc<Surface>, NshView)> {
            let (surface, view) = self.target.get()?;
            Some((surface.upgrade()?, view.upgrade()?))
        }

        fn enabled(&self) -> bool {
            self.target()
                .is_some_and(|(surface, view)| can_activate(&surface, &view))
        }
    }

    impl ActionGroupImpl for Group {
        fn list_actions(&self) -> Vec<String> {
            vec!["activate".into()]
        }
        // Keep this local name owned even when blocked: do not fall through to a parent.
        fn has_action(&self, name: &str) -> bool {
            name == "activate"
        }
        fn query_action(
            &self,
            name: &str,
        ) -> Option<(
            bool,
            Option<glib::VariantType>,
            Option<glib::VariantType>,
            Option<glib::Variant>,
            Option<glib::Variant>,
        )> {
            (name == "activate").then(|| (self.enabled(), None, None, None, None))
        }
        fn change_action_state(&self, _: &str, _: &glib::Variant) {}
        fn activate_action(&self, name: &str, parameter: Option<&glib::Variant>) {
            if name == "activate"
                && parameter.is_none()
                && let Some((surface, view)) = self.target()
            {
                activate(&surface, &view);
            }
        }
    }
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
    let mut drafts: FxHashMap<NodeId, (ViewKind, Option<&nsh_core::ViewProps>, bool)> =
        FxHashMap::default();
    for item in &batch.items {
        match item {
            MountItem::Create { id, kind } => {
                drafts.insert(*id, (*kind, None, false));
            }
            MountItem::ViewProps { id, props } => {
                if let Some(d) = drafts.get_mut(id) {
                    d.1 = Some(props);
                }
            }
            MountItem::Events { id, events } => {
                if let Some(d) = drafts.get_mut(id) {
                    d.2 = has_press_role(*events);
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
        for (id, (kind, props, pressable)) in drafts {
            let role = role_for(
                props.map_or(&none, |p| &p.accessibility),
                kind,
                pressable || props.is_some_and(|p| p.window_control.is_some()),
            );
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
pub(crate) fn props_changed(surface: &Rc<Surface>, view: &NshView) {
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
    events_changed(surface, view);
}

/// The view's event listeners changed: views with press handlers are
/// buttons.
pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    let install = {
        let s = view.state();
        (s.events.contains(EventKind::Press) || s.props.window_control.is_some())
            && s.access.activation.is_none()
    };
    if install {
        let group = ActivationGroup::new(surface, view);
        view.insert_action_group("nsh", Some(&group));
        view.state_mut().access.activation = Some(group);
    }
    update(view);
}

fn can_activate(surface: &Surface, view: &NshView) -> bool {
    let (Ok(mounter), Ok(state)) = (surface.mounter.try_borrow(), view.try_state()) else {
        return false;
    };
    let a = &state.props.accessibility;
    if !(state.events.contains(EventKind::Press) || state.props.window_control.is_some())
        || a.state.disabled
        || a.accessible == Some(false)
        || !view.is_sensitive()
        || !view.is_mapped()
        || mounter.views.get(&state.id) != Some(view)
    {
        return false;
    }
    drop(state);
    drop(mounter);
    if crate::system::blocks_activation(view)
        || !crate::navigation::in_focus_scope(surface, view)
        || crate::window::blocked_by_modal(surface, view)
    {
        return false;
    }
    let mut at = Some(view.clone());
    while let Some(view) = at {
        {
            let Ok(s) = view.try_state() else {
                return false;
            };
            if !view.can_target()
                || !view.is_visible()
                || s.style.hidden
                || s.props.accessibility.hidden
                || s.live.as_ref().is_some_and(|live| live.dying())
            {
                return false;
            }
        }
        at = view.parent_view();
    }
    true
}

fn activate(surface: &Rc<Surface>, view: &NshView) {
    if !can_activate(surface, view) {
        return;
    }
    let control = view.state().props.window_control;
    if let Some(control) = control {
        let Some(window) = view.root().and_downcast::<gtk::Window>() else {
            return;
        };
        let window = window.downgrade();
        let weak_view = view.downgrade();
        let weak_surface = Rc::downgrade(surface);
        // Closing a window may dispose this action while GTK is dispatching it.
        gtk::glib::idle_add_local_once(move || {
            let (Some(surface), Some(view), Some(window)) = (
                weak_surface.upgrade(),
                weak_view.upgrade(),
                window.upgrade(),
            ) else {
                return;
            };
            if can_activate(&surface, &view)
                && view.state().props.window_control == Some(control)
                && view.root().as_ref() == Some(window.upcast_ref())
            {
                crate::window::control(&surface, &window, control);
            }
        });
    } else {
        crate::input::activate(surface, view);
    }
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
            Some(old)
                if Arc::ptr_eq(&old, &drawn.text)
                    || old.visible_text() == drawn.text.visible_text() =>
            {
                return;
            }
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
        // An app-drawn window button is a button, as the system's is.
        let pressable = has_press_role(s.events) || s.props.window_control.is_some();
        // Hidden runs are not read.
        let text = s.text.as_ref().map(|t| t.text.visible_text());
        let spec = spec_for(a, s.kind, pressable, text.as_deref(), s.style.hidden);
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
fn has_press_role(events: EventMask) -> bool {
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
    if old.is_none_or(|o| o.level != new.level) {
        match new.level {
            Some(l) => props.push(accessible::Property::Level(l.min(i32::MAX as u32) as i32)),
            None if old.is_some_and(|o| o.level.is_some()) => {
                reset.push(gtk::AccessibleProperty::Level)
            }
            None => {}
        }
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
            new.invalid,
            old.map(|o| o.invalid),
            accessible::State::Invalid(gtk::AccessibleInvalidState::True),
            gtk::AccessibleState::Invalid,
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
    let description = a.help_text(value_text);
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
        checked: match role {
            Gtk::Button => a.state.pressed.or(a.state.checked),
            _ => a.state.checked,
        },
        level: a.level,
        expanded: a.state.expanded,
        busy: a.state.busy,
        invalid: a.state.invalid,
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
        Role::Menuitem | Role::MenuItemCheckbox if a.state.checked.is_some() => {
            Gtk::MenuItemCheckbox
        }
        Role::Menuitem => Gtk::MenuItem,
        Role::MenuItemCheckbox => Gtk::MenuItemCheckbox,
        Role::MenuItemRadio => Gtk::MenuItemRadio,
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
        Role::Group => Gtk::Group,
        Role::Region => Gtk::Region,
        Role::Navigation => Gtk::Navigation,
        Role::Tree => Gtk::Tree,
        Role::TreeItem => Gtk::TreeItem,
        Role::Dialog => Gtk::Dialog,
        Role::AlertDialog => Gtk::AlertDialog,
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
                view.announce(&t.text.visible_text(), priority(live));
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
    use nsh_core::{AccessibilityState, AccessibilityValue, EventPayload};

    use super::*;

    #[test]
    fn activation_tracks_current_listeners_and_props() {
        use crate::gtk_test::{apply, run, surface, view};

        run(|| {
            let surface = surface();
            apply(
                &surface,
                &[MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                }],
            );
            let button = view(&surface, 2);
            assert!(button.state().access.activation.is_none());
            let mut props = button.state().props.clone();
            props.accessibility.role = Role::Button;
            apply(
                &surface,
                &[MountItem::ViewProps {
                    id: 2,
                    props: props.clone(),
                }],
            );
            let mut events = EventMask::default();
            events.set(EventKind::Press, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            assert!(!button.is_mapped());
            let _window = TestWindow(crate::gtk_test::show(&surface));
            apply(
                &surface,
                &[MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 2,
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
            let action = button.state().access.activation.clone().unwrap();
            assert!(action.is_action_enabled("activate"));
            assert!(action.action_parameter_type("activate").is_none());

            props.accessibility.accessible = Some(false);
            apply(
                &surface,
                &[MountItem::ViewProps {
                    id: 2,
                    props: props.clone(),
                }],
            );
            assert!(!action.is_action_enabled("activate"));
            props.accessibility.accessible = None;
            apply(
                &surface,
                &[MountItem::ViewProps {
                    id: 2,
                    props: props.clone(),
                }],
            );
            assert!(action.is_action_enabled("activate"));
            events.set(EventKind::Press, false);
            events.set(EventKind::LongPress, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            assert!(!action.is_action_enabled("activate"));
            events.set(EventKind::Press, true);
            apply(&surface, &[MountItem::Events { id: 2, events }]);
            assert!(action.is_action_enabled("activate"));

            props.accessibility.state.disabled = true;
            apply(
                &surface,
                &[MountItem::ViewProps {
                    id: 2,
                    props: props.clone(),
                }],
            );
            assert!(!action.is_action_enabled("activate"));
            props.accessibility.state.disabled = false;
            props.accessibility.hidden = true;
            apply(
                &surface,
                &[MountItem::ViewProps {
                    id: 2,
                    props: props.clone(),
                }],
            );
            assert!(!action.is_action_enabled("activate"));
            props.accessibility.hidden = false;
            apply(&surface, &[MountItem::ViewProps { id: 2, props }]);
            assert!(action.is_action_enabled("activate"));
            assert_eq!(button.state().access.activation.as_ref(), Some(&action));

            let mut style = button.state().style.clone();
            style.hidden = true;
            apply(
                &surface,
                &[MountItem::ViewStyle {
                    id: 2,
                    style: style.clone(),
                }],
            );
            assert!(!action.is_action_enabled("activate"));
            style.hidden = false;
            apply(&surface, &[MountItem::ViewStyle { id: 2, style }]);
            assert!(action.is_action_enabled("activate"));

            for (id, kind, event) in [
                (4, ViewKind::View, EventKind::LongPress),
                (5, ViewKind::View, EventKind::PressDown),
            ] {
                let mut events = EventMask::default();
                events.set(event, true);
                apply(
                    &surface,
                    &[
                        MountItem::Create { id, kind },
                        MountItem::Events { id, events },
                    ],
                );
                assert!(view(&surface, id).state().access.activation.is_none());
            }
        });
    }

    type Recorded = Arc<std::sync::Mutex<Vec<(EventKind, EventPayload)>>>;

    struct Recorder(Recorded);

    #[nsh_core::element::component]
    fn Activation() -> impl nsh_core::element::IntoElement {
        use nsh_core::prelude::*;

        recording_target(view())
    }

    #[nsh_core::element::component]
    fn ImageActivation() -> impl nsh_core::element::IntoElement {
        recording_target(nsh_core::element::image(""))
    }

    #[nsh_core::element::component]
    fn TextActivation() -> impl nsh_core::element::IntoElement {
        recording_target(nsh_core::element::text("Press text"))
    }

    #[cfg(feature = "dev")]
    #[nsh_core::element::component]
    fn InputActivation() -> impl nsh_core::element::IntoElement {
        use nsh_core::prelude::*;

        recording_target(nsh_core::element::input().p(px(12.0)))
    }

    fn recording_target(
        target: impl nsh_core::element::Interactive + nsh_core::element::Accessible,
    ) -> impl nsh_core::element::IntoElement {
        use nsh_core::prelude::*;

        let events = engine_context::<Recorder>().unwrap().0.clone();
        let down = events.clone();
        let up = events.clone();
        target
            .test_id("activation")
            .label("Activate")
            .w(px(100.0))
            .h(px(40.0))
            .on(EventKind::PressDown, move |payload: &EventPayload| {
                down.lock()
                    .unwrap()
                    .push((EventKind::PressDown, payload.clone()));
            })
            .on(EventKind::PressUp, move |payload: &EventPayload| {
                up.lock()
                    .unwrap()
                    .push((EventKind::PressUp, payload.clone()));
            })
            .on(EventKind::Press, move |payload: &EventPayload| {
                events
                    .lock()
                    .unwrap()
                    .push((EventKind::Press, payload.clone()));
            })
    }

    fn flush(surface: &crate::surface::Surface) {
        let (sent, received) = std::sync::mpsc::channel();
        surface.control(|control| {
            control.flush(move |done| {
                let _ = sent.send(done);
            });
        });
        assert!(crate::gtk_test::wait_until(
            || received.try_recv() == Ok(true)
        ));
    }

    fn with_activation(
        check: impl FnOnce(&Rc<Surface>, &NshView, &Recorded) + Send + 'static,
    ) -> Option<()> {
        with_root(nsh_engine::Root::of::<Activation>(), check)
    }

    fn with_root(
        root: nsh_engine::Root,
        check: impl FnOnce(&Rc<Surface>, &NshView, &Recorded) + Send + 'static,
    ) -> Option<()> {
        crate::gtk_test::run(move || {
            let surface = crate::gtk_test::surface();
            let events = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut config = nsh_engine::EngineConfig::new(root);
            config.context = config.context.with(Recorder(events.clone()));
            surface.start(config);
            let window = TestWindow(crate::gtk_test::show(&surface));
            let mut button = None;
            assert!(crate::gtk_test::wait_until(|| {
                button = surface
                    .mounter
                    .borrow()
                    .views
                    .values()
                    .find(|view| view.state().props.test_id.as_deref() == Some("activation"))
                    .filter(|view| view.is_mapped())
                    .cloned();
                button.is_some()
            }));
            let button = button.unwrap();
            assert!(!button.is_focus());
            check(&surface, &button, &events);
            drop(window);
        })
    }

    struct TestWindow(gtk::Window);

    impl Drop for TestWindow {
        fn drop(&mut self) {
            self.0.destroy();
        }
    }

    fn expected_press() -> [(EventKind, EventPayload); 3] {
        [EventKind::PressDown, EventKind::PressUp, EventKind::Press]
            .map(|kind| (kind, EventPayload::None))
    }

    fn activation_case(activate: impl FnOnce(&NshView) + Send + 'static) -> Option<()> {
        with_activation(move |surface, button, events| {
            activate(button);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            assert!(!button.is_focus());

            events.lock().unwrap().clear();
            let mut props = surface.root.state().props.clone();
            props.accessibility.hidden = true;
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: nsh_core::ROOT_ID,
                    props: props.clone(),
                }],
            );
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "a hidden ancestor blocks activation"
            );
            props.accessibility.hidden = false;
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: nsh_core::ROOT_ID,
                    props,
                }],
            );
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());

            events.lock().unwrap().clear();
            crate::gtk_test::apply(surface, &[MountItem::Remove { id: button.id() }]);
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "a retained removed button cannot activate"
            );
        })
    }

    fn atspi_activate() {
        atspi_attempt(true);
    }

    fn atspi_attempt(enabled: bool) {
        let mut client = std::process::Command::new("python3")
            .arg("-I")
            .arg("-c")
            .arg(include_str!("atspi_test.py"))
            .args(if enabled { &[][..] } else { &["--blocked"][..] })
            .spawn()
            .expect("the AT-SPI client starts");
        let mut status = None;
        let finished = crate::gtk_test::wait_until(|| {
            status = client.try_wait().expect("the AT-SPI client can be polled");
            status.is_some()
        });
        if !finished {
            let _ = client.kill();
            let _ = client.wait();
            panic!("the AT-SPI client timed out");
        }
        assert!(status.unwrap().success(), "AT-SPI activation failed");
    }

    #[cfg(feature = "dev")]
    fn show_test_dialog(surface: &Rc<Surface>, sheet: bool) {
        crate::system::command(
            surface,
            nsh_core::ROOT_ID,
            &nsh_core::Command::Dialog(Box::new(nsh_core::Dialog {
                id: 1,
                title: Some("Confirm".into()),
                message: None,
                buttons: vec![nsh_core::DialogButton {
                    text: "Done".into(),
                    style: nsh_core::DialogButtonStyle::Default,
                }],
                cancelable: false,
                sheet,
            })),
        );
    }

    #[test]
    #[cfg(feature = "dev")]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_respects_system_dialogs() {
        assert!(
            with_activation(|surface, button, events| {
                for sheet in [false, true] {
                    show_test_dialog(surface, sheet);
                    atspi_attempt(false);
                    flush(surface);
                    assert!(events.lock().unwrap().is_empty(), "dialog sheet={sheet}");
                    let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
                    assert!(
                        gtk::prelude::GtkWindowExt::focus(&window)
                            .is_some_and(|w| !w.is::<NshView>())
                    );
                    real_key(&window);
                    assert!(crate::gtk_test::wait_until(|| {
                        !crate::system::blocks_activation(button)
                    }));
                    flush(surface);
                    assert!(
                        events.lock().unwrap().is_empty(),
                        "Return answers the native dialog"
                    );
                    atspi_activate();
                    flush(surface);
                    assert_eq!(*events.lock().unwrap(), expected_press());
                    events.lock().unwrap().clear();
                }
            })
            .is_some()
        );
    }

    struct AtspiClient {
        child: std::process::Child,
        lines: std::sync::mpsc::Receiver<String>,
    }

    impl AtspiClient {
        fn new() -> Self {
            use std::io::BufRead;
            let mut child = std::process::Command::new("python3")
                .args(["-I", "-c", include_str!("atspi_test.py"), "--interactive"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let output = child.stdout.take().unwrap();
            let (send, lines) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(output).lines() {
                    if send.send(line.unwrap()).is_err() {
                        break;
                    }
                }
            });
            Self { child, lines }
        }

        fn attempt(&mut self, enabled: bool) {
            use std::io::Write;
            writeln!(self.child.stdin.as_mut().unwrap(), "{}", u8::from(enabled)).unwrap();
            let mut reply = None;
            assert!(
                crate::gtk_test::wait_until(|| {
                    reply = self.lines.try_recv().ok();
                    if let Some(status) = self.child.try_wait().unwrap() {
                        assert!(status.success(), "persistent AT-SPI client failed");
                    }
                    reply.is_some()
                }),
                "persistent AT-SPI client timed out"
            );
            println!("{}", reply.unwrap());
        }
    }

    impl Drop for AtspiClient {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_queries_a_retained_action_live() {
        assert!(
            with_activation(|surface, button, events| {
                let mut client = AtspiClient::new();
                client.attempt(true);
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                events.lock().unwrap().clear();
                button.set_can_target(false);
                client.attempt(false);
                flush(surface);
                assert!(events.lock().unwrap().is_empty());
                button.set_can_target(true);
                client.attempt(true);
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                events.lock().unwrap().clear();
                surface.root.set_can_target(false);
                client.attempt(false);
                surface.root.set_can_target(true);
                client.attempt(true);
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                events.lock().unwrap().clear();
                let modal = present_modal(surface, 9000, nsh_core::ROOT_ID);
                client.attempt(false);
                flush(surface);
                assert!(events.lock().unwrap().is_empty());
                crate::gtk_test::apply(surface, &[MountItem::Remove { id: modal.id() }]);
                crate::navigation::end_batch(surface);
                client.attempt(true);
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
            })
            .is_some()
        );
    }

    #[test]
    fn activation_delivers_one_press_without_keyboard_focus() {
        let _ = activation_case(|button| button.activate_action("nsh.activate", None).unwrap());
    }

    #[test]
    fn activation_queries_fail_closed_during_mutations() {
        with_activation(|surface, button, events| {
            use gtk::{gio::subclass::prelude::ActionGroupImpl, glib::subclass::prelude::*};
            let group = button.state().access.activation.clone().unwrap();
            assert!(group.is_action_enabled("activate"));
            assert!(!group.has_action("item-1"));
            assert!(group.imp().query_action("item-1").is_none());
            let parent = gtk::gio::SimpleActionGroup::new();
            let fallback = gtk::gio::SimpleAction::new("activate", None);
            let calls = Rc::new(std::cell::Cell::new(0));
            let called = calls.clone();
            fallback.connect_activate(move |_, _| called.set(called.get() + 1));
            parent.add_action(&fallback);
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            window.insert_action_group("nsh", Some(&parent));
            let blocked = || {
                assert!(group.has_action("activate"));
                assert_eq!(
                    group.imp().query_action("activate"),
                    Some((false, None, None, None, None))
                );
                assert!(!group.is_action_enabled("activate"));
                button.activate_action("nsh.activate", None).unwrap();
                assert_eq!(calls.get(), 0, "a disabled local name never falls through");
            };
            {
                let _borrow = surface.mounter.borrow_mut();
                blocked();
            }
            {
                let _borrow = surface.windows.borrow_mut();
                blocked();
            }
            {
                let _borrow = surface.nav.borrow_mut();
                blocked();
            }
            {
                let _borrow = button.state_mut();
                blocked();
            }
            {
                let _borrow = surface.root.state_mut();
                blocked();
            }
            assert!(group.is_action_enabled("activate"));
            group.change_action_state("activate", &true.to_variant());
            group.activate_action("activate", Some(&true.to_variant()));
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
            crate::gtk_test::apply(surface, &[MountItem::Remove { id: button.id() }]);
            blocked();
            let detached = NshView::new(9901, ViewKind::View);
            let dead_group = ActivationGroup::new(surface, &detached);
            drop(detached);
            assert_eq!(
                dead_group.imp().query_action("activate"),
                Some((false, None, None, None, None))
            );
        });
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_delivers_one_press_without_keyboard_focus() {
        let ran = activation_case(|_| {
            atspi_activate();
        });
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    fn present_modal(surface: &Rc<Surface>, id: NodeId, window: NodeId) -> NshView {
        let config = nsh_core::ModalConfig {
            animation: nsh_core::ModalAnimation::None,
            window,
            ..Default::default()
        };
        crate::gtk_test::apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig { id, config },
                MountItem::Insert {
                    parent: window,
                    child: id,
                    before: None,
                },
            ],
        );
        crate::navigation::end_batch(surface);
        let modal = crate::gtk_test::view(surface, id);
        assert!(crate::gtk_test::wait_until(|| modal.is_mapped()));
        modal
    }

    #[test]
    fn activation_respects_targetability_changes() {
        with_activation(|surface, button, events| {
            button.set_can_target(false);
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert!(events.lock().unwrap().is_empty(), "untargetable button");
            button.set_can_target(true);
            surface.root.set_can_target(false);
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert!(events.lock().unwrap().is_empty(), "untargetable ancestor");
            surface.root.set_can_target(true);
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        });
    }

    #[test]
    fn activation_stays_inside_the_newest_modal() {
        with_activation(|surface, button, events| {
            let modal = present_modal(surface, 9000, nsh_core::ROOT_ID);
            assert!(button.is_mapped());
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "background button under a modal"
            );
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: modal.id(),
                    child: button.id(),
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        });
    }

    fn keyboard_activate(button: &NshView) -> bool {
        crate::key_focus::focus(button);
        assert!(button.is_focus());
        let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
        let controllers = window.observe_controllers();
        (0..controllers.n_items()).any(|i| {
            controllers
                .item(i)
                .and_downcast::<gtk::EventControllerKey>()
                .is_some_and(|keys| {
                    keys.emit_by_name::<bool>(
                        "key-pressed",
                        &[
                            &gtk::gdk::Key::Return,
                            &0_u32,
                            &gtk::gdk::ModifierType::empty(),
                        ],
                    )
                })
        })
    }

    #[test]
    fn activation_payload_matches_keyboard() {
        with_activation(|surface, button, events| {
            assert!(keyboard_activate(button));
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            crate::key_focus::blur(button);
            button.activate_action("nsh.activate", None).unwrap();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            assert!(!button.is_focus());
        });
    }

    #[test]
    fn activation_keyboard_keeps_its_accessibility_admission() {
        with_activation(|surface, button, events| {
            let mut props = button.state().props.clone();
            props.accessibility.accessible = Some(false);
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: button.id(),
                    props,
                }],
            );
            let mut props = surface.root.state().props.clone();
            props.accessibility.hidden = true;
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: nsh_core::ROOT_ID,
                    props,
                }],
            );
            assert!(keyboard_activate(button));
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        });
    }

    #[test]
    fn activation_follows_listeners_without_changing_roles() {
        crate::gtk_test::run(|| {
            let surface = crate::gtk_test::surface();
            let mut events = EventMask::default();
            events.set(EventKind::Press, true);
            for (id, kind, label, role) in [
                (2, ViewKind::View, None, Gtk::Button),
                (3, ViewKind::Image, None, Gtk::Button),
                (4, ViewKind::Text, None, Gtk::Label),
                (5, ViewKind::Image, Some("Image"), Gtk::Img),
            ] {
                let mut props = nsh_core::ViewProps::default();
                props.accessibility.label = label.map(Arc::from);
                crate::gtk_test::apply(
                    &surface,
                    &[
                        MountItem::Create { id, kind },
                        MountItem::ViewProps {
                            id,
                            props: Box::new(props),
                        },
                        MountItem::Events { id, events },
                    ],
                );
                let view = crate::gtk_test::view(&surface, id);
                assert_eq!(view.accessible_role(), role);
                assert!(
                    view.state()
                        .access
                        .activation
                        .as_ref()
                        .unwrap()
                        .has_action("activate")
                );
            }
        });
    }

    fn pending_window(
        surface: &Rc<Surface>,
        id: NodeId,
        open: nsh_core::desktop::OpenWindow,
    ) -> (NshView, TestWindow) {
        crate::gtk_test::apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::Modal,
                },
                MountItem::Command {
                    id,
                    command: nsh_core::Command::Desktop(Box::new(
                        nsh_core::desktop::DesktopCommand::OpenWindow(Box::new(open)),
                    )),
                },
            ],
        );
        let root = crate::gtk_test::view(surface, id);
        let window = TestWindow(root.root().unwrap().downcast::<gtk::Window>().unwrap());
        (root, window)
    }

    fn show_window(surface: &Rc<Surface>, root: &NshView) {
        crate::window::batch_applied(surface);
        crate::window::batch_applied(surface);
        assert!(crate::gtk_test::wait_until(|| root.is_mapped()));
    }

    fn secondary_window(surface: &Rc<Surface>, id: NodeId) -> (NshView, TestWindow) {
        let pair = pending_window(surface, id, Default::default());
        show_window(surface, &pair.0);
        pair
    }

    fn native_modal_window(
        surface: &Rc<Surface>,
        id: NodeId,
        parent: NodeId,
    ) -> (NshView, TestWindow) {
        let mut open = nsh_core::desktop::OpenWindow::default();
        open.parent = Some(parent);
        open.options.modal = true;
        let pair = pending_window(surface, id, open);
        show_window(surface, &pair.0);
        assert!(pair.1.0.is_modal());
        let parent_window = crate::window::host_root(surface, parent)
            .root()
            .unwrap()
            .downcast::<gtk::Window>()
            .unwrap();
        assert_eq!(pair.1.0.transient_for().as_ref(), Some(&parent_window));
        pair
    }

    #[cfg(feature = "dev")]
    fn real_key(window: &gtk::Window) {
        let released = Rc::new(std::cell::Cell::new(false));
        let controllers: Vec<_> = gtk::Window::list_toplevels()
            .into_iter()
            .map(|window| {
                let keys = gtk::EventControllerKey::new();
                keys.set_propagation_phase(gtk::PropagationPhase::Capture);
                let released = released.clone();
                keys.connect_key_released(move |_, key, _, _| {
                    if key == gtk::gdk::Key::Return {
                        released.set(true);
                    }
                });
                window.add_controller(keys.clone());
                (window, keys)
            })
            .collect();
        crate::xtest::Xtest::with(|x| {
            x.focus(window);
            assert!(x.stroke(&[], 0xff0d));
        })
        .expect("real XTest is required");
        assert!(
            crate::gtk_test::wait_until(|| released.get()),
            "real Return release is observed"
        );
        for (window, keys) in controllers {
            window.remove_controller(&keys);
        }
    }

    fn move_to_window(surface: &Rc<Surface>, button: &NshView, parent: NodeId) {
        crate::gtk_test::apply(
            surface,
            &[MountItem::Insert {
                parent,
                child: button.id(),
                before: None,
            }],
        );
        assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_respects_native_modal_windows() {
        let ran = with_activation(|surface, button, events| {
            atspi_activate();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            let (modal_root, modal_window) = native_modal_window(surface, 9600, nsh_core::ROOT_ID);
            assert!(button.is_mapped(), "the background button remains mapped");
            atspi_attempt(false);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "a parented native modal blocks AT-SPI in its parent"
            );
            move_to_window(surface, button, modal_root.id());
            atspi_activate();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            move_to_window(surface, button, nsh_core::ROOT_ID);
            modal_window.0.close();
            assert!(crate::gtk_test::wait_until(|| !modal_window.0.is_visible()));
            atspi_activate();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        });
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_native_modals_follow_transient_ownership() {
        let ran = with_activation(|surface, button, events| {
            let (parent_root, parent_window) =
                native_modal_window(surface, 9600, nsh_core::ROOT_ID);
            let (child_root, child_window) = native_modal_window(surface, 9700, parent_root.id());
            let (independent_root, _independent_window) = secondary_window(surface, 9800);
            let attempt = |parent: NodeId, expected: &[(EventKind, EventPayload)]| {
                move_to_window(surface, button, parent);
                atspi_attempt(!expected.is_empty());
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected, "window {parent}");
                events.lock().unwrap().clear();
            };
            let pressed = expected_press();
            attempt(nsh_core::ROOT_ID, &[]);
            attempt(parent_root.id(), &[]);
            attempt(child_root.id(), &pressed);
            attempt(independent_root.id(), &pressed);
            child_window.0.close();
            assert!(crate::gtk_test::wait_until(|| !child_window.0.is_visible()));
            attempt(parent_root.id(), &pressed);
            attempt(nsh_core::ROOT_ID, &[]);
            parent_window.0.close();
            assert!(crate::gtk_test::wait_until(|| !parent_window
                .0
                .is_visible()));
            attempt(nsh_core::ROOT_ID, &pressed);
            attempt(independent_root.id(), &pressed);
        });
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    #[test]
    fn activation_native_modals_follow_visibility_and_modality() {
        with_activation(|surface, button, _events| {
            let mut open = nsh_core::desktop::OpenWindow::default();
            open.parent = Some(nsh_core::ROOT_ID);
            open.options.modal = true;
            let (root, window) = pending_window(surface, 9600, open);
            assert!(!window.0.is_visible());
            assert!(
                can_activate(surface, button),
                "an unshown modal does not block"
            );
            show_window(surface, &root);
            assert!(
                !can_activate(surface, button),
                "the shown modal blocks its parent"
            );
            let hide =
                nsh_core::desktop::DesktopCommand::Request(nsh_core::desktop::WindowRequest::Hide);
            crate::window::command(surface, root.id(), Some(&root), &hide);
            assert!(!window.0.is_visible());
            assert!(
                can_activate(surface, button),
                "a hidden modal does not block"
            );
            let mut open = nsh_core::desktop::OpenWindow::default();
            open.parent = Some(nsh_core::ROOT_ID);
            let (root, window) = pending_window(surface, 9700, open);
            show_window(surface, &root);
            assert!(!window.0.is_modal());
            assert!(
                can_activate(surface, button),
                "a shown nonmodal transient does not block"
            );
        });
    }

    #[test]
    fn activation_deferred_control_rechecks_native_modal_admission() {
        with_activation(|surface, button, events| {
            let control = window_control(surface);
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let count = count_closes(&window);
            control.activate_action("nsh.activate", None).unwrap();
            let (_root, modal) = native_modal_window(surface, 9600, nsh_core::ROOT_ID);
            let settled = Rc::new(std::cell::Cell::new(false));
            let idle = settled.clone();
            gtk::glib::idle_add_local_once(move || idle.set(true));
            assert!(crate::gtk_test::wait_until(|| settled.get()));
            assert_eq!(
                count.get(),
                0,
                "a new modal cancels the pending native operation"
            );
            modal.0.close();
            assert!(crate::gtk_test::wait_until(|| !modal.0.is_visible()));
            control.activate_action("nsh.activate", None).unwrap();
            assert!(crate::gtk_test::wait_until(|| count.get() == 1));
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
        });
    }

    fn window_scope_case(activate: impl Fn(bool) + Send + 'static) -> Option<()> {
        with_activation(move |surface, button, events| {
            let (other_root, _window) = secondary_window(surface, 9100);
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: other_root.id(),
                    child: button.id(),
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
            present_modal(surface, 9000, nsh_core::ROOT_ID);
            activate(true);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            let modal = present_modal(surface, 9200, other_root.id());
            activate(false);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "the target window's modal blocks activation"
            );
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: modal.id(),
                    child: button.id(),
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
            present_modal(surface, 9300, nsh_core::ROOT_ID);
            activate(true);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        })
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_uses_target_window_scope() {
        assert!(window_scope_case(atspi_attempt).is_some());
    }

    fn window_control(surface: &Rc<Surface>) -> NshView {
        let original = surface
            .mounter
            .borrow()
            .views
            .values()
            .find(|view| view.state().props.test_id.as_deref() == Some("activation"))
            .cloned()
            .unwrap();
        let mut props = original.state().props.clone();
        props.accessibility.label = Some("Ordinary".into());
        crate::gtk_test::apply(
            surface,
            &[MountItem::ViewProps {
                id: original.id(),
                props,
            }],
        );
        let mut props = nsh_core::ViewProps::default();
        props.accessibility.label = Some("Activate".into());
        props.window_control = Some(nsh_core::desktop::WindowControl::Close);
        props.focusable = Some(true);
        crate::gtk_test::apply(
            surface,
            &[
                MountItem::Create {
                    id: 9400,
                    kind: ViewKind::View,
                },
                MountItem::ViewProps {
                    id: 9400,
                    props: Box::new(props),
                },
                MountItem::Frame {
                    id: 9400,
                    frame: crate::gtk_test::frame(100.0, 0.0, 40.0, 40.0),
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 9400,
                    before: None,
                },
            ],
        );
        let control = crate::gtk_test::view(surface, 9400);
        assert!(crate::gtk_test::wait_until(|| control.is_mapped()));
        assert_eq!(control.accessible_role(), Gtk::Button);
        control
    }

    fn count_closes(window: &gtk::Window) -> Rc<std::cell::Cell<u32>> {
        let count = Rc::new(std::cell::Cell::new(0));
        let closed = count.clone();
        window.connect_close_request(move |_| {
            closed.set(closed.get() + 1);
            gtk::glib::Propagation::Stop
        });
        count
    }

    #[test]
    fn activation_window_controls_are_deferred_and_rechecked() {
        with_activation(|surface, button, events| {
            let control = window_control(surface);
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let count = count_closes(&window);
            assert!(
                !keyboard_activate(&control),
                "keyboard keeps requiring a Press listener"
            );
            control.activate_action("nsh.activate", None).unwrap();
            assert_eq!(count.get(), 0, "native close is deferred");
            let mut props = control.state().props.clone();
            props.window_control = Some(nsh_core::desktop::WindowControl::Minimize);
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: control.id(),
                    props,
                }],
            );
            assert!(control.is_mapped());
            assert!(can_activate(surface, &control));
            let settled = Rc::new(std::cell::Cell::new(false));
            let idle = settled.clone();
            gtk::glib::idle_add_local_once(move || idle.set(true));
            assert!(crate::gtk_test::wait_until(|| settled.get()));
            assert_eq!(
                count.get(),
                0,
                "a retained action rechecks its window control"
            );
            let mut props = control.state().props.clone();
            props.window_control = Some(nsh_core::desktop::WindowControl::Close);
            crate::gtk_test::apply(
                surface,
                &[MountItem::ViewProps {
                    id: control.id(),
                    props,
                }],
            );
            control.activate_action("nsh.activate", None).unwrap();
            assert!(crate::gtk_test::wait_until(|| count.get() == 1));
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn activation_deferred_control_rechecks_its_window() {
        with_activation(|surface, button, events| {
            let control = window_control(surface);
            let main = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let main_closes = count_closes(&main);
            let (other_root, other_window) = secondary_window(surface, 9500);
            control.activate_action("nsh.activate", None).unwrap();
            // Reparent synchronously: draining the loop while unmapped would
            // let the pending operation reject for the wrong reason.
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: other_root.id(),
                    child: control.id(),
                    before: None,
                }],
            );
            assert!(control.is_mapped());
            assert!(can_activate(surface, &control));
            assert_eq!(control.root().as_ref(), Some(other_window.0.upcast_ref()));
            let settled = Rc::new(std::cell::Cell::new(false));
            let idle = settled.clone();
            gtk::glib::idle_add_local_once(move || idle.set(true));
            assert!(crate::gtk_test::wait_until(|| settled.get()));
            assert_eq!(main_closes.get(), 0);
            assert!(main.is_visible());
            assert!(other_window.0.is_visible());
            control.activate_action("nsh.activate", None).unwrap();
            assert!(crate::gtk_test::wait_until(|| !other_window.0.is_visible()));
            assert!(main.is_visible());
            assert_eq!(main_closes.get(), 0);
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
        });
    }

    fn stacked_modal_case(activate: impl Fn(&NshView, bool) + Send + 'static) -> Option<()> {
        with_activation(move |surface, button, events| {
            let older = present_modal(surface, 9000, nsh_core::ROOT_ID);
            move_to_window(surface, button, older.id());
            activate(button, true);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            let newer = present_modal(surface, 9100, nsh_core::ROOT_ID);
            assert!(older.is_mapped());
            assert!(button.is_mapped());
            activate(button, false);
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
            crate::gtk_test::apply(surface, &[MountItem::Remove { id: newer.id() }]);
            crate::navigation::end_batch(surface);
            activate(button, true);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        })
    }

    #[test]
    fn activation_respects_stacked_modals() {
        stacked_modal_case(|button, _| button.activate_action("nsh.activate", None).unwrap());
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_respects_stacked_modals() {
        let ran = stacked_modal_case(|_, enabled| atspi_attempt(enabled));
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    fn non_view_case(atspi: bool) -> Option<()> {
        let mut ran = None;
        for (root, kind, role) in [
            (
                nsh_engine::Root::of::<ImageActivation>(),
                ViewKind::Image,
                Gtk::Img,
            ),
            (
                nsh_engine::Root::of::<TextActivation>(),
                ViewKind::Text,
                Gtk::Label,
            ),
        ] {
            ran = with_root(root, move |surface, target, events| {
                assert_eq!(target.state().kind, kind);
                assert_eq!(target.accessible_role(), role);
                let window = target.root().unwrap().downcast::<gtk::Window>().unwrap();
                let focus = gtk::prelude::GtkWindowExt::focus(&window);
                if atspi {
                    atspi_activate();
                } else {
                    target.activate_action("nsh.activate", None).unwrap();
                }
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                assert_eq!(gtk::prelude::GtkWindowExt::focus(&window), focus);
            });
        }
        ran
    }

    #[test]
    fn activation_delivers_non_view_press_payloads() {
        non_view_case(false);
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_delivers_non_view_press_payloads() {
        assert!(
            non_view_case(true).is_some(),
            "the AT-SPI test requires a GTK display"
        );
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_window_controls_without_press_listeners() {
        let ran = with_activation(|surface, button, events| {
            let control = window_control(surface);
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let main_closes = count_closes(&window);
            let (other_root, other_window) = secondary_window(surface, 9500);
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: other_root.id(),
                    child: control.id(),
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| control.is_mapped()));
            atspi_activate();
            assert!(crate::gtk_test::wait_until(|| !other_window.0.is_visible()));
            assert!(window.is_visible(), "the main window stays open");
            assert_eq!(main_closes.get(), 0, "the control acts on its own window");
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
        });
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    #[test]
    #[cfg(feature = "dev")]
    fn activation_input_wrapper_preserves_native_editing() {
        with_root(
            nsh_engine::Root::of::<InputActivation>(),
            |surface, input, events| {
                assert_eq!(input.state().kind, ViewKind::Input);
                let window = input.root().unwrap().downcast::<gtk::Window>().unwrap();
                let (editor, rect) = {
                    let state = input.state();
                    let native = state
                        .natives
                        .iter()
                        .find(|native| native.widget.is::<gtk::Text>())
                        .unwrap();
                    (native.widget.clone(), native.rect)
                };
                let point = |x, y| {
                    input
                        .compute_point(&surface.root, &gtk::graphene::Point::new(x, y))
                        .unwrap()
                };
                let click = |point: gtk::graphene::Point| {
                    crate::input::simulate(
                        surface,
                        crate::input::Simulated::Down(point.x(), point.y()),
                    );
                    crate::input::simulate(
                        surface,
                        crate::input::Simulated::Up(point.x(), point.y()),
                    );
                    flush(surface);
                };
                assert!(crate::gtk_test::wait_until(|| editor.is_mapped()
                    && editor.width() > 0
                    && editor.height() > 0));
                let center = gtk::graphene::Point::new(
                    editor.width() as f32 / 2.0,
                    editor.height() as f32 / 2.0,
                );
                assert!(
                    editor
                        .pick(
                            center.x() as f64,
                            center.y() as f64,
                            gtk::PickFlags::DEFAULT
                        )
                        .is_some()
                );
                click(editor.compute_point(&surface.root, &center).unwrap());
                assert!(
                    events.lock().unwrap().is_empty(),
                    "the hosted editor does not dispatch Press: {:?}",
                    *events.lock().unwrap()
                );
                assert!(crate::synth::focused_text(&window).is_some());
                crate::synth::type_text(&window, "native");
                let editable = editor.downcast::<gtk::Editable>().unwrap();
                assert_eq!(editable.text(), "native");
                flush(surface);
                assert!(events.lock().unwrap().is_empty());
                assert!(rect.origin.x.0 > 2.0 && rect.origin.y.0 > 2.0);
                click(point(2.0, 2.0));
                let pointer_events = events.lock().unwrap().clone();
                assert_eq!(
                    pointer_events
                        .iter()
                        .map(|(kind, _)| *kind)
                        .collect::<Vec<_>>(),
                    [EventKind::PressDown, EventKind::PressUp, EventKind::Press]
                );
                assert!(
                    pointer_events
                        .iter()
                        .all(|(_, payload)| matches!(payload, EventPayload::Press(_)))
                );
                events.lock().unwrap().clear();
                let focus = gtk::prelude::GtkWindowExt::focus(&window);
                input.activate_action("nsh.activate", None).unwrap();
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                assert_eq!(gtk::prelude::GtkWindowExt::focus(&window), focus);
                crate::gtk_test::apply(
                    surface,
                    &[MountItem::Create {
                        id: 9900,
                        kind: ViewKind::Input,
                    }],
                );
                assert!(
                    crate::gtk_test::view(surface, 9900)
                        .state()
                        .access
                        .activation
                        .is_none()
                );
            },
        );
    }

    #[test]
    fn activation_keeps_parent_menu_actions_reachable() {
        with_activation(|_surface, button, _events| {
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let group = gtk::gio::SimpleActionGroup::new();
            let action = gtk::gio::SimpleAction::new("item-1", None);
            let calls = Rc::new(std::cell::Cell::new(0));
            let called = calls.clone();
            action.connect_activate(move |_, _| called.set(called.get() + 1));
            group.add_action(&action);
            window.insert_action_group("nsh", Some(&group));
            button.activate_action("nsh.item-1", None).unwrap();
            assert_eq!(calls.get(), 1);
        });
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_blocks_background_and_untargetable_buttons() {
        let ran = with_activation(|surface, button, events| {
            let modal = present_modal(surface, 9000, nsh_core::ROOT_ID);
            assert!(button.is_mapped());
            atspi_attempt(false);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "AT-SPI cannot press behind a modal"
            );
            crate::gtk_test::apply(
                surface,
                &[MountItem::Insert {
                    parent: modal.id(),
                    child: button.id(),
                    before: None,
                }],
            );
            assert!(crate::gtk_test::wait_until(|| button.is_mapped()));
            button.set_can_target(false);
            atspi_attempt(false);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "AT-SPI cannot press an untargetable button"
            );
            button.set_can_target(true);
            modal.set_can_target(false);
            atspi_attempt(false);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "AT-SPI cannot press below an untargetable ancestor"
            );
            modal.set_can_target(true);
            atspi_activate();
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            assert!(!button.is_focus());
        });
        assert!(ran.is_some(), "the AT-SPI test requires a GTK display");
    }

    fn gtk_sensitivity_case(scope: &'static str) {
        with_activation(move |surface, button, events| {
            let group = button.state().access.activation.clone().unwrap();
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let target: gtk::Widget = match scope {
                "target" => button.clone().upcast(),
                "ancestor" => surface.root.clone().upcast(),
                "window" => window.upcast(),
                _ => unreachable!(),
            };
            group.activate_action("activate", None);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
            events.lock().unwrap().clear();
            target.set_sensitive(false);
            assert!(button.is_mapped() && button.can_target());
            assert!(!button.is_sensitive());
            assert!(!button.state().props.accessibility.state.disabled);
            // Call the group directly: GTK's AT bridge cannot mask a missing
            // activation-time check of inherited native sensitivity.
            group.activate_action("activate", None);
            flush(surface);
            assert!(
                events.lock().unwrap().is_empty(),
                "GTK-insensitive {scope} dispatched {:?}",
                *events.lock().unwrap()
            );
            assert!(!group.is_action_enabled("activate"));
            target.set_sensitive(true);
            assert!(button.is_sensitive());
            assert!(group.is_action_enabled("activate"));
            group.activate_action("activate", None);
            flush(surface);
            assert_eq!(*events.lock().unwrap(), expected_press());
        });
    }

    #[test]
    fn activation_gtk_sensitivity_target() {
        gtk_sensitivity_case("target");
    }

    #[test]
    fn activation_gtk_sensitivity_ancestor() {
        gtk_sensitivity_case("ancestor");
    }

    #[test]
    fn activation_gtk_sensitivity_window() {
        gtk_sensitivity_case("window");
    }

    #[test]
    fn activation_gtk_sensitivity_deferred_close() {
        with_activation(|surface, button, events| {
            let control = window_control(surface);
            let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
            let closes = count_closes(&window);
            assert!(control.is_sensitive());
            control.activate_action("nsh.activate", None).unwrap();
            window.set_sensitive(false);
            assert!(control.is_mapped() && control.can_target());
            assert!(!control.is_sensitive());
            assert_eq!(
                control.state().props.window_control,
                Some(nsh_core::desktop::WindowControl::Close)
            );
            let done = Rc::new(std::cell::Cell::new(false));
            let complete = done.clone();
            gtk::glib::idle_add_local_once(move || complete.set(true));
            assert!(crate::gtk_test::wait_until(|| done.get()));
            assert_eq!(
                closes.get(),
                0,
                "a newly insensitive host cancels pending Close"
            );
            window.set_sensitive(true);
            control.activate_action("nsh.activate", None).unwrap();
            assert!(crate::gtk_test::wait_until(|| closes.get() == 1));
            flush(surface);
            assert!(events.lock().unwrap().is_empty());
        });
    }

    #[test]
    #[ignore = "requires an AT-SPI session bus, Python 3 and libatspi"]
    fn atspi_activation_gtk_sensitivity_dynamic() {
        assert!(
            with_activation(|surface, button, events| {
                let window = button.root().unwrap().downcast::<gtk::Window>().unwrap();
                let mut client = AtspiClient::new();
                client.attempt(true);
                flush(surface);
                assert_eq!(*events.lock().unwrap(), expected_press());
                events.lock().unwrap().clear();
                for target in [
                    button.clone().upcast::<gtk::Widget>(),
                    surface.root.clone().upcast(),
                    window.upcast(),
                ] {
                    target.set_sensitive(false);
                    assert!(button.is_mapped() && !button.is_sensitive());
                    client.attempt(false);
                    flush(surface);
                    assert!(events.lock().unwrap().is_empty());
                    target.set_sensitive(true);
                    client.attempt(true);
                    flush(surface);
                    assert_eq!(*events.lock().unwrap(), expected_press());
                    events.lock().unwrap().clear();
                }
            })
            .is_some()
        );
    }

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
        for (role, gtk) in [
            (Role::Group, Gtk::Group),
            (Role::Region, Gtk::Region),
            (Role::Navigation, Gtk::Navigation),
            (Role::Tree, Gtk::Tree),
            (Role::TreeItem, Gtk::TreeItem),
            (Role::MenuItemCheckbox, Gtk::MenuItemCheckbox),
            (Role::MenuItemRadio, Gtk::MenuItemRadio),
            (Role::Dialog, Gtk::Dialog),
            (Role::AlertDialog, Gtk::AlertDialog),
        ] {
            assert_eq!(
                role_for(&with_role(role), ViewKind::View, false),
                gtk,
                "{role:?}"
            );
        }
    }

    /// A button's pressed state is GTK's `Pressed`; a level is kept.
    #[test]
    fn pressed_and_level() {
        let toggle = Accessibility {
            role: Role::Button,
            level: Some(2),
            state: AccessibilityState {
                pressed: Some(Checked::Mixed),
                ..Default::default()
            },
            ..Default::default()
        };
        let s = spec_for(&toggle, ViewKind::View, true, None, false);
        assert_eq!(s.role, Gtk::Button);
        assert_eq!(s.checked, Some(Checked::Mixed));
        assert_eq!(s.level, Some(2));
        // Outside buttons, a pressed state is not a checked one.
        let checkbox = Accessibility {
            role: Role::Checkbox,
            ..toggle
        };
        assert_eq!(
            spec_for(&checkbox, ViewKind::View, true, None, false).checked,
            None
        );
    }

    /// An invalid field is AT-SPI's invalid entry (GTK's `Invalid`).
    #[test]
    fn invalid() {
        let field = Accessibility {
            label: Some("Email".into()),
            state: AccessibilityState {
                invalid: true,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(spec_for(&field, ViewKind::Input, false, None, false).invalid);
        assert!(!spec_for(&with_role(Role::Button), ViewKind::View, true, None, false).invalid);
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
        // The app's description goes between the value and the hint.
        let described = Accessibility {
            description: Some("The whole album".into()),
            ..button
        };
        let s = spec_for(&described, ViewKind::View, false, None, false);
        assert_eq!(
            s.description.as_deref(),
            Some("3 of 10. The whole album. Plays")
        );
        let dialog = Accessibility {
            role: Role::AlertDialog,
            label: Some("Delete file?".into()),
            description: Some("This can't be undone.".into()),
            ..Default::default()
        };
        let s = spec_for(&dialog, ViewKind::View, false, None, false);
        assert_eq!(s.description.as_deref(), Some("This can't be undone."));
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
