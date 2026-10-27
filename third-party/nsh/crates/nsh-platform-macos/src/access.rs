//! Accessibility: roles, labels, values and states of views for VoiceOver
//! (`NSAccessibility`), from the views' `ViewProps` and text.
//!
//! Every [`NshView`] is an `NSView`, which implements `NSAccessibility`
//! with settable attributes; this module sets them. Each view gets:
//!
//! - a role ([`role_for`]): the `accessibilityRole`'s, static text for
//!   text views, a button for views with press handlers, an image for
//!   labelled images, a group for other labelled views, none otherwise (the
//!   view is no element then, and VoiceOver goes through to its children);
//! - its label (`accessibilityLabel`; a text view's text is its value, as
//!   VoiceOver reads static text), its help (`accessibilityHint`), its
//!   value (`accessibilityValue`: a range for range roles, the text
//!   otherwise; the checked state of checkable roles) and its states
//!   (`accessibilityState`);
//! - `accessible={true}` makes it one element: its children are hidden
//!   from VoiceOver (the core labels it with their text);
//!   `accessibilityElementsHidden` hides it and its subtree, and so does
//!   `visibility: hidden`, as in a browser (only its layer is hidden, which
//!   VoiceOver does not see);
//! - its `testID` as its accessibility identifier (what UI tests find).
//!
//! Live regions are emulated by announcing a changed label or text
//! (`NSAccessibilityAnnouncementRequestedNotification`);
//! `accessibilityActions` are not exposed.
//!
//! Every update is diffed against what was last given to AppKit
//! ([`Applied`]): `ViewProps` also carries touch properties, and `Text`
//! items come again on every relayout.

use std::sync::Arc;

use nsh_core::{
    Accessibility, AccessibilityRole as Role, AttributedText, Checked, EventKind, EventMask,
    LiveRegion, MountBatch, ViewKind, ViewStyle,
};
use objc2::{MainThreadOnly, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSAccessibility, NSAccessibilityAnnouncementKey,
    NSAccessibilityAnnouncementRequestedNotification, NSAccessibilityLayoutChangedNotification,
    NSAccessibilityPostNotificationWithUserInfo, NSAccessibilityPriorityKey,
    NSAccessibilityPriorityLevel, NSAccessibilityUIElementsKey, NSView,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

use crate::view::{NshView, ViewState};

/// What was last given to AppKit for one view.
#[derive(Debug, Default)]
pub(crate) struct Applied {
    /// The applied description; `None` until the first update.
    spec: Option<Box<Spec>>,
    /// The text a text view's label was taken from.
    text: Option<Arc<AttributedText>>,
    /// The `testID` set as the identifier.
    test_id: Option<Arc<str>>,
    /// Whether the view was an accessibility element last time: AppKit is
    /// only called for a role or a hidden flag that changed, since writing
    /// all fifteen attributes per changed text is what a ticking table
    /// spends most of its main-thread time on.
    ax: AxState,
}

/// Whether the view hides its children from VoiceOver (`accessible={true}`,
/// `accessibilityElementsHidden`, `visibility: hidden`): its
/// `accessibilityChildren` are none then, AppKit's otherwise.
///
/// The view answers them itself: `setAccessibilityChildren:` cannot be
/// undone, as `nil` leaves the view without children rather than with
/// AppKit's again, so a subtree shown again stayed out of reach.
pub(crate) fn hides_children(s: &ViewState) -> bool {
    s.access.ax.grouped
}

/// What `apply` last wrote, field by field.
///
/// Each attribute is its own entry: AppKit lets every one of them change while
/// the role stays put (a slider becomes disabled, a checkbox becomes checked, a
/// container's children are hidden). Grouping them under the role would leave
/// VoiceOver reporting the old state.
#[derive(Debug, Clone, PartialEq, Default)]
struct AxState {
    element: bool,
    hidden: bool,
    role: Option<u8>,
    help: Option<String>,
    label: Option<String>,
    /// The value and its description, as one comparable pair: a range's
    /// `text` changes without `now` changing.
    value: (ValueKind, Option<String>),
    enabled: bool,
    selected: bool,
    expanded: bool,
    /// The children are hidden as a group (`grouped`, or the view is
    /// hidden): the view answers none ([`hides_children`]).
    grouped: bool,
    /// The value's lower and upper bounds.
    range: (Option<u64>, Option<u64>),
}

/// The kinds of element nsh makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ax {
    /// No element.
    Generic,
    Button,
    Link,
    Text,
    Image,
    Group,
    Heading,
    Slider,
    CheckBox,
    Switch,
    Radio,
    RadioGroup,
    ComboBox,
    Menu,
    MenuBar,
    MenuItem,
    Progress,
    ScrollBar,
    SpinButton,
    Tab,
    TabList,
    Toolbar,
    List,
    /// An option of a listbox.
    Option,
    Grid,
    Search,
    Alert,
    Status,
    Timer,
}

/// A view's value.
#[derive(Debug, Clone, PartialEq)]
enum Value {
    None,
    /// Read as text.
    Text(String),
    /// A checked state (0, 1, 2: mixed).
    Checked(i32),
    /// A range.
    Range {
        min: Option<f32>,
        max: Option<f32>,
        now: Option<f32>,
        text: Option<Arc<str>>,
    },
}

/// Everything set on a view's accessibility attributes.
#[derive(Debug, Clone, PartialEq)]
struct Spec {
    role: Ax,
    label: Option<String>,
    help: Option<String>,
    value: Value,
    disabled: bool,
    selected: bool,
    expanded: Option<bool>,
    /// Hidden with its subtree.
    hidden: bool,
    /// One element: its children are not exposed.
    grouped: bool,
}

/// A batch is about to be applied. (AppKit takes roles at any time, so
/// views get theirs with their props.)
pub(crate) fn prepare(_batch: &MountBatch) {}

/// A view was created: it is no element until its props say so.
pub(crate) fn created(view: &NshView) {
    view.ns().setAccessibilityElement(false);
}

/// The view's props changed.
pub(crate) fn props_changed(view: &NshView) {
    let test_id = {
        let s = view.state();
        let id = &s.props.test_id;
        (*id != s.access.test_id).then(|| id.clone())
    };
    if let Some(id) = test_id {
        let ns = id.as_deref().map(NSString::from_str);
        view.ns().setAccessibilityIdentifier(ns.as_deref());
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

/// Moves VoiceOver and, for an input or a stop of Tab, keyboard focus to `view`.
pub(crate) fn focus(view: &NshView) {
    if view.kind() == ViewKind::Input {
        crate::text_input::focus(view);
    } else if crate::input::is_key_stop(view)
        && let Some(window) = view.ns().window()
    {
        window.makeFirstResponder(Some(view.ns()));
    }
    let elements = NSArray::from_slice(&[AsRef::<AnyObject>::as_ref(view.ns())]);
    // SAFETY: immutable AppKit constants; the user info holds the elements
    // VoiceOver moves to, as the notification documents.
    unsafe {
        let info = NSDictionary::from_slices(
            &[NSAccessibilityUIElementsKey],
            &[AsRef::<AnyObject>::as_ref(&*elements)],
        );
        NSAccessibilityPostNotificationWithUserInfo(
            view.ns().as_ref(),
            NSAccessibilityLayoutChangedNotification,
            Some(&info),
        );
    }
}

/// Has VoiceOver read `text` (`announce`, live
/// regions).
pub(crate) fn announce(element: &NSView, text: &str, priority: NSAccessibilityPriorityLevel) {
    let text = NSString::from_str(text);
    let priority = NSNumber::new_isize(priority.0);
    // SAFETY: immutable AppKit constants with values of their documented
    // types (a string, a priority number).
    unsafe {
        let info = NSDictionary::from_slices(
            &[NSAccessibilityAnnouncementKey, NSAccessibilityPriorityKey],
            &[
                AsRef::<AnyObject>::as_ref(&*text),
                AsRef::<AnyObject>::as_ref(&*priority),
            ],
        );
        // Announcements are the application's.
        let app = objc2_app_kit::NSApplication::sharedApplication(element.mtm());
        NSAccessibilityPostNotificationWithUserInfo(
            app.as_ref(),
            NSAccessibilityAnnouncementRequestedNotification,
            Some(&info),
        );
    }
}

/// Brings what AppKit knows of the view up to date; true if its label
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
    let written = apply(view.ns(), &spec, &view.state().access.ax);
    view.state_mut().access.ax = written;
    let label_changed = old.is_some_and(|o| o.label != spec.label);
    let is_text = view.state().text.is_some();
    if label_changed
        && live != LiveRegion::None
        && !is_text
        && let Some(label) = &spec.label
    {
        announce(view.ns(), label, priority(live));
    }
    view.state_mut().access.spec = Some(Box::new(spec));
    label_changed
}

/// Views with press handlers are buttons.
fn is_pressable(events: EventMask) -> bool {
    events.contains(EventKind::Press) || events.contains(EventKind::LongPress)
}

/// Writes what changed of `spec` on `view`'s attributes, and returns what it
/// wrote.
///
/// AppKit has no "unchanged" notion here: every setter stores an object in
/// its attribute table. A price that changes every frame would otherwise
/// rewrite all fifteen attributes of its text block per frame — measured at
/// 182 µs of main-thread time in a 40-row table, half the frame's mount cost.
fn apply(view: &NSView, spec: &Spec, was: &AxState) -> AxState {
    let element = spec.role != Ax::Generic && !spec.hidden;
    let label: Option<String> = spec.label.as_deref().map(str::to_owned);
    let help: Option<String> = spec.help.as_deref().map(str::to_owned);

    // The value and its description, as `accessibilityValue` and
    // `accessibilityValueDescription` take them.
    let (value, description): (Option<Retained<AnyObject>>, Option<String>) = match &spec.value {
        Value::None => (None, None),
        Value::Text(t) => (Some(NSString::from_str(t).into()), None),
        Value::Checked(c) => (Some(NSNumber::new_i32(*c).into()), None),
        Value::Range { now, text, .. } => (
            now.map(|v| NSNumber::new_f64(v as f64)).map(Into::into),
            text.as_deref().map(str::to_owned),
        ),
    };
    let (min, max) = match &spec.value {
        Value::Range { min, max, .. } => (
            min.map(|v| v.to_bits() as u64),
            max.map(|v| v.to_bits() as u64),
        ),
        _ => (None, None),
    };
    let enabled = !spec.disabled;
    let selected = spec.selected;
    let expanded = spec.expanded.unwrap_or(false);
    let grouped = spec.grouped || spec.hidden;

    // The role group: a different role is a different kind of element.
    if was.element != element
        || was.hidden != spec.hidden
        || was.role != Some(spec.role as u8)
        || was.help != help
    {
        view.setAccessibilityElement(element);
        view.setAccessibilityHidden(spec.hidden);
        let (role_name, subrole) = ax_role(spec.role);
        view.setAccessibilityRole(role_name.as_deref());
        view.setAccessibilitySubrole(subrole.as_deref());
        view.setAccessibilityHelp(help.as_deref().map(NSString::from_str).as_deref());
    }
    if was.range != (min, max) {
        // SAFETY: the bounds take numbers.
        unsafe {
            view.setAccessibilityMinValue(
                min.map(|v| NSNumber::new_f64(f32::from_bits(v as u32) as f64))
                    .as_deref()
                    .map(|n| n.as_ref()),
            );
            view.setAccessibilityMaxValue(
                max.map(|v| NSNumber::new_f64(f32::from_bits(v as u32) as f64))
                    .as_deref()
                    .map(|n| n.as_ref()),
            );
        }
    }
    if was.label.as_deref() != label.as_deref() {
        let text = label.as_deref().map(NSString::from_str);
        view.setAccessibilityLabel(text.as_deref());
    }
    if was.value != (value_kind(&spec.value), description.clone()) {
        // SAFETY: the value attributes take numbers or strings.
        unsafe { view.setAccessibilityValue(value.as_deref()) };
        view.setAccessibilityValueDescription(
            description.as_deref().map(NSString::from_str).as_deref(),
        );
    }
    if was.enabled != enabled {
        view.setAccessibilityEnabled(enabled);
    }
    if was.selected != selected {
        view.setAccessibilitySelected(selected);
    }
    if was.expanded != expanded {
        view.setAccessibilityExpanded(expanded);
    }
    AxState {
        element,
        hidden: spec.hidden,
        role: Some(spec.role as u8),
        help,
        label,
        value: (value_kind(&spec.value), description),
        enabled,
        selected,
        expanded,
        grouped,
        range: (min, max),
    }
}

/// The value as it compares: which kind of value AppKit was given, and its
/// contents — without the description (`apply` compares that next to it).
///
/// The kind matters as much as the contents: a checkbox's value must be an
/// `NSNumber`, and `accessibilityValue={{ text: "1" }}` on a view that later
/// becomes `checked` keeps the same contents while changing what AppKit must
/// be handed. Comparing the contents alone left the `NSString` in place.
#[derive(Debug, Clone, PartialEq, Default)]
enum ValueKind {
    #[default]
    None,
    Text(String),
    Checked(i32),
    Range(Option<u64>),
}

fn value_kind(v: &Value) -> ValueKind {
    match v {
        Value::None => ValueKind::None,
        Value::Text(t) => ValueKind::Text(t.clone()),
        Value::Checked(c) => ValueKind::Checked(*c),
        // The bits, so NaN compares equal to itself.
        Value::Range { now, .. } => ValueKind::Range(now.map(|n| n.to_bits() as u64)),
    }
}

/// The AppKit role and subrole of `role`.
fn ax_role(role: Ax) -> (Option<Retained<NSString>>, Option<Retained<NSString>>) {
    use objc2_app_kit::*;
    let named = |s: &'static str| Some(NSString::from_str(s));
    // SAFETY: immutable AppKit constants.
    let constant = |s: &'static NSString| Some(Retained::from(s));
    // SAFETY: immutable AppKit constants.
    unsafe {
        match role {
            Ax::Generic => (None, None),
            Ax::Button => (constant(NSAccessibilityButtonRole), None),
            Ax::Link => (constant(NSAccessibilityLinkRole), None),
            Ax::Text => (constant(NSAccessibilityStaticTextRole), None),
            Ax::Image => (constant(NSAccessibilityImageRole), None),
            Ax::Group => (constant(NSAccessibilityGroupRole), None),
            // WebKit's role for headings, which VoiceOver's rotor lists.
            Ax::Heading => (named("AXHeading"), None),
            Ax::Slider => (constant(NSAccessibilitySliderRole), None),
            Ax::CheckBox => (constant(NSAccessibilityCheckBoxRole), None),
            Ax::Switch => (
                constant(NSAccessibilityCheckBoxRole),
                constant(NSAccessibilitySwitchSubrole),
            ),
            Ax::Radio => (constant(NSAccessibilityRadioButtonRole), None),
            Ax::RadioGroup => (constant(NSAccessibilityRadioGroupRole), None),
            Ax::ComboBox => (constant(NSAccessibilityComboBoxRole), None),
            Ax::Menu => (constant(NSAccessibilityMenuRole), None),
            Ax::MenuBar => (constant(NSAccessibilityMenuBarRole), None),
            Ax::MenuItem => (constant(NSAccessibilityMenuItemRole), None),
            Ax::Progress => (constant(NSAccessibilityProgressIndicatorRole), None),
            Ax::ScrollBar => (constant(NSAccessibilityScrollBarRole), None),
            Ax::SpinButton => (constant(NSAccessibilityIncrementorRole), None),
            Ax::Tab => (
                constant(NSAccessibilityRadioButtonRole),
                constant(NSAccessibilityTabButtonSubrole),
            ),
            Ax::TabList => (constant(NSAccessibilityTabGroupRole), None),
            Ax::Toolbar => (constant(NSAccessibilityToolbarRole), None),
            Ax::List => (constant(NSAccessibilityListRole), None),
            // WebKit's and Chromium's role for ARIA's `option`: AppKit's
            // rows are a table's or an outline's (they need the table's
            // columns and row index), and its menu items a menu's; an option
            // of a list is static text that reports `AXSelected`.
            Ax::Option => (constant(NSAccessibilityStaticTextRole), None),
            Ax::Grid => (constant(NSAccessibilityGridRole), None),
            Ax::Search => (
                constant(NSAccessibilityTextFieldRole),
                constant(NSAccessibilitySearchFieldSubrole),
            ),
            // ARIA's landmark subroles, as WebKit maps them.
            Ax::Alert => (
                constant(NSAccessibilityGroupRole),
                named("AXApplicationAlert"),
            ),
            Ax::Status => (
                constant(NSAccessibilityGroupRole),
                named("AXApplicationStatus"),
            ),
            Ax::Timer => (
                constant(NSAccessibilityGroupRole),
                named("AXApplicationTimer"),
            ),
        }
    }
}

/// What to give AppKit for a view of `kind` with accessibility `a`;
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
    let checkable = matches!(
        role,
        Ax::CheckBox | Ax::Switch | Ax::Radio | Ax::MenuItem | Ax::Button | Ax::Tab
    );
    let value_text = a.value.as_ref().and_then(|v| v.text.as_deref());
    let (label, value) = match (role, &a.value, a.state.checked) {
        (r, Some(v), _) if is_range(r) => (
            label,
            Value::Range {
                min: v.min,
                max: v.max,
                now: v.now,
                text: v.text.clone(),
            },
        ),
        (_, _, Some(c)) if checkable => (
            label,
            Value::Checked(match c {
                Checked::False => 0,
                Checked::True => 1,
                Checked::Mixed => 2,
            }),
        ),
        // VoiceOver reads static text's value, not its label.
        (Ax::Text | Ax::Heading | Ax::Option, _, _) => (
            None,
            label.map_or(Value::None, |l| match value_text {
                Some(v) => Value::Text(format!("{l}, {v}")),
                None => Value::Text(l),
            }),
        ),
        (_, _, _) => (
            label,
            value_text.map_or(Value::None, |v| Value::Text(v.to_owned())),
        ),
    };
    Spec {
        role,
        label,
        help: a.hint.as_deref().map(str::to_owned),
        value,
        disabled: a.state.disabled,
        selected: a.state.selected,
        expanded: a.state.expanded,
        hidden: a.hidden || invisible,
        grouped: a.accessible == Some(true) && kind != ViewKind::Text,
    }
}

/// The element a view of `kind` is, with press handlers or not.
fn role_for(a: &Accessibility, kind: ViewKind, pressable: bool) -> Ax {
    match a.role {
        Role::None => match kind {
            ViewKind::Text => Ax::Text,
            ViewKind::Image if a.label.is_some() => Ax::Image,
            _ if a.accessible == Some(false) => Ax::Generic,
            _ if pressable => Ax::Button,
            _ if a.label.is_some() || a.accessible == Some(true) => Ax::Group,
            _ => Ax::Generic,
        },
        Role::Button | Role::ImageButton | Role::KeyboardKey => Ax::Button,
        Role::Link => Ax::Link,
        Role::Search => Ax::Search,
        Role::Image => Ax::Image,
        Role::Text => Ax::Text,
        Role::Adjustable => Ax::Slider,
        Role::Header => Ax::Heading,
        Role::Summary => Ax::Status,
        Role::Alert => Ax::Alert,
        Role::Checkbox => Ax::CheckBox,
        Role::Combobox => Ax::ComboBox,
        Role::Menu => Ax::Menu,
        Role::Menubar => Ax::MenuBar,
        Role::Menuitem => Ax::MenuItem,
        Role::Progressbar => Ax::Progress,
        Role::Radio => Ax::Radio,
        Role::Radiogroup => Ax::RadioGroup,
        Role::Scrollbar => Ax::ScrollBar,
        Role::Spinbutton => Ax::SpinButton,
        Role::Switch => Ax::Switch,
        Role::Tab => Ax::Tab,
        Role::Tablist => Ax::TabList,
        Role::Timer => Ax::Timer,
        Role::Toolbar => Ax::Toolbar,
        // A listbox is a list, as WebKit and Chromium map ARIA's `listbox`.
        Role::List | Role::Listbox => Ax::List,
        Role::Option => Ax::Option,
        Role::Grid | Role::Table => Ax::Grid,
        // Groups that read their children, a cell's text among them.
        Role::Row | Role::Cell | Role::ColumnHeader | Role::RowGroup => Ax::Group,
    }
}

/// Roles whose value is a range.
fn is_range(role: Ax) -> bool {
    matches!(
        role,
        Ax::Slider | Ax::Progress | Ax::SpinButton | Ax::ScrollBar
    )
}

/// How urgently a live region's change is announced.
fn priority(live: LiveRegion) -> NSAccessibilityPriorityLevel {
    match live {
        LiveRegion::Assertive => NSAccessibilityPriorityLevel::High,
        _ => NSAccessibilityPriorityLevel::Medium,
    }
}

/// A text view's text changed: announces it if it is in a live region.
fn announce_live(view: &NshView) {
    let mut at = Some(view.clone());
    while let Some(v) = at {
        let live = v.state().props.accessibility.live_region;
        if live != LiveRegion::None {
            let text = view.state().text.as_ref().map(|t| t.text.text.clone());
            if let Some(text) = text {
                announce(view.ns(), &text, priority(live));
            }
            return;
        }
        at = v.parent_view();
    }
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
        assert_eq!(role_for(&none, ViewKind::View, false), Ax::Generic);
        assert_eq!(role_for(&none, ViewKind::Text, false), Ax::Text);
        assert_eq!(role_for(&none, ViewKind::View, true), Ax::Button);
        assert_eq!(role_for(&none, ViewKind::Image, false), Ax::Generic);
        let not_element = Accessibility {
            accessible: Some(false),
            ..Default::default()
        };
        assert_eq!(role_for(&not_element, ViewKind::View, true), Ax::Generic);
        let labelled = Accessibility {
            label: Some("Logo".into()),
            ..Default::default()
        };
        assert_eq!(role_for(&labelled, ViewKind::Image, false), Ax::Image);
        assert_eq!(role_for(&labelled, ViewKind::View, false), Ax::Group);
        assert_eq!(role_for(&labelled, ViewKind::View, true), Ax::Button);
        assert_eq!(
            role_for(&with_role(Role::Header), ViewKind::Text, false),
            Ax::Heading
        );
        assert_eq!(
            role_for(&with_role(Role::Switch), ViewKind::View, false),
            Ax::Switch
        );
        assert_eq!(
            role_for(&with_role(Role::Listbox), ViewKind::View, false),
            Ax::List
        );
        assert_eq!(
            role_for(&with_role(Role::Option), ViewKind::View, true),
            Ax::Option
        );
    }

    #[test]
    fn labels_and_values() {
        // A text view reads its text as its value unless it has a label.
        let s = spec_for(
            &Accessibility::default(),
            ViewKind::Text,
            false,
            Some("Title"),
            false,
        );
        assert_eq!(s.label, None);
        assert_eq!(s.value, Value::Text("Title".into()));
        let labelled = Accessibility {
            label: Some("Label".into()),
            hint: Some("Opens it".into()),
            ..Default::default()
        };
        let s = spec_for(&labelled, ViewKind::View, true, None, false);
        assert_eq!(s.role, Ax::Button);
        assert_eq!(s.label.as_deref(), Some("Label"));
        assert_eq!(s.help.as_deref(), Some("Opens it"));

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
        assert!(matches!(s.value, Value::Range { now: Some(3.0), .. }));
        let checkbox = Accessibility {
            role: Role::Checkbox,
            state: AccessibilityState {
                checked: Some(Checked::True),
                ..Default::default()
            },
            ..Default::default()
        };
        let s = spec_for(&checkbox, ViewKind::View, false, None, false);
        assert_eq!(s.value, Value::Checked(1));
        // Outside range roles the value is read as text.
        let button = Accessibility {
            role: Role::Button,
            value: Some(value),
            ..Default::default()
        };
        let s = spec_for(&button, ViewKind::View, false, None, false);
        assert_eq!(s.value, Value::Text("3 of 10".into()));
        // An option is static text: its label is read as its value, and it
        // reports its selected state.
        let option = Accessibility {
            role: Role::Option,
            label: Some("Apple".into()),
            state: AccessibilityState {
                selected: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let s = spec_for(&option, ViewKind::View, true, None, false);
        assert_eq!(s.role, Ax::Option);
        assert_eq!(s.label, None);
        assert_eq!(s.value, Value::Text("Apple".into()));
        assert!(s.selected);
    }
    /// The reviewer's case: `accessibilityValue={{ text: "1" }}` on a view
    /// that later becomes checked. The contents are `1` both times; what
    /// AppKit must be handed changes from an NSString to an NSNumber.
    #[test]
    fn a_checkbox_value_compared_by_kind_not_contents() {
        let text_value = ValueKind::Text("1".into());
        let checked = ValueKind::Checked(1);
        assert_ne!(
            text_value, checked,
            "a checkbox's number must replace the string"
        );

        // The same contents on the same kind is unchanged.
        assert_eq!(ValueKind::Text("1".into()), ValueKind::Text("1".into()));
        assert_eq!(ValueKind::Checked(1), ValueKind::Checked(1));
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

    /// A hidden container's `element` is false either way, so `hidden` has to
    /// be compared on its own: mounting hidden and then unhiding must reach
    /// AppKit, or its children stay out of reach.
    #[test]
    fn a_hidden_change_reaches_appkit_without_a_role_change() {
        let hidden = AxState {
            element: false,
            hidden: true,
            role: Some(Ax::Group as u8),
            ..Default::default()
        };
        let shown = AxState {
            hidden: false,
            ..hidden.clone()
        };
        assert_eq!(
            hidden.element, shown.element,
            "an accessible=false container is never an element"
        );
        assert_eq!(hidden.role, shown.role, "and its role does not change");
        assert_ne!(hidden, shown, "so hidden itself must differ");
    }
}
