//! Non-style view properties: touch handling, accessibility, gesture values
//! and layout animations.

use std::sync::Arc;

use crate::{
    element::PropEnum,
    geometry::{Edges, Points, px},
    js::host::HostProps,
};

/// Edge insets in points.
pub type EdgeInsets = Edges<Points>;

/// Which touches a view and its children receive (`pointerEvents`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PointerEvents {
    /// The view and its children receive touches (default).
    #[default]
    Auto,
    /// Neither the view nor its children receive touches.
    None,
    /// Only the children receive touches; the view itself is transparent to them.
    #[prop(rename = "box-none")]
    BoxNone,
    /// Only the view receives touches, never its children.
    #[prop(rename = "box-only")]
    BoxOnly,
}

/// What an element is, for assistive technologies (`role`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AccessibilityRole {
    /// No particular role.
    #[default]
    None,
    /// A button.
    Button,
    /// A link.
    Link,
    /// A search field.
    Search,
    /// An image.
    Image,
    /// An image that acts as a button.
    #[prop(rename = "imagebutton")]
    ImageButton,
    /// A key of a keyboard.
    #[prop(rename = "keyboardkey")]
    KeyboardKey,
    /// Static text.
    Text,
    /// A value that can be adjusted (slider).
    Adjustable,
    /// A section header.
    Header,
    /// A summary of the app's state.
    Summary,
    /// An alert.
    Alert,
    /// A checkbox.
    Checkbox,
    /// A combo box.
    Combobox,
    /// A menu.
    Menu,
    /// A menu bar.
    Menubar,
    /// An item of a menu.
    Menuitem,
    /// A progress bar.
    Progressbar,
    /// A radio button.
    Radio,
    /// A group of radio buttons.
    Radiogroup,
    /// A scroll bar.
    Scrollbar,
    /// A spin button.
    Spinbutton,
    /// A switch.
    Switch,
    /// A tab.
    Tab,
    /// A list of tabs.
    Tablist,
    /// A timer.
    Timer,
    /// A toolbar.
    Toolbar,
    /// A list.
    List,
    /// A grid.
    Grid,
    /// A table: rows of cells under column headers.
    Table,
    /// A row of a table.
    Row,
    /// A cell of a table's row.
    Cell,
    /// A column's header cell.
    #[prop(rename = "columnheader")]
    ColumnHeader,
    /// A group of a table's rows: its header, body or footer.
    #[prop(rename = "rowgroup")]
    RowGroup,
    /// A list of options to choose from: a select's or combo box's popup.
    Listbox,
    /// An option of a listbox; `accessibilityState.selected` marks the chosen
    /// one.
    Option,
}

/// Whether a checkable element is checked (`accessibilityState.checked`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checked {
    /// Not checked.
    False,
    /// Checked.
    True,
    /// Partially checked.
    Mixed,
}

/// Dynamic state of an element (`accessibilityState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccessibilityState {
    /// Disabled.
    pub disabled: bool,
    /// Selected.
    pub selected: bool,
    /// Checked state of checkable elements.
    pub checked: Option<Checked>,
    /// Busy (loading).
    pub busy: bool,
    /// Expanded or collapsed, for expandable elements.
    pub expanded: Option<bool>,
}

/// The value of a range or textual element (`accessibilityValue`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccessibilityValue {
    /// Minimum of the range.
    pub min: Option<f32>,
    /// Maximum of the range.
    pub max: Option<f32>,
    /// Current value in the range.
    pub now: Option<f32>,
    /// A textual description of the value; wins over the range.
    pub text: Option<Arc<str>>,
}

/// How changes of an element are announced (Android `accessibilityLiveRegion`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum LiveRegion {
    /// Not announced.
    #[default]
    None,
    /// Announced when the user is idle.
    Polite,
    /// Announced right away.
    Assertive,
}

/// A custom action offered to assistive technologies.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessibilityActionDef {
    /// Name reported back in `onAccessibilityAction` (`activate`,
    /// `increment`, `decrement` and `longpress` are standard actions).
    pub name: Arc<str>,
    /// Label shown to the user; required for custom actions.
    pub label: Option<Arc<str>>,
}

/// Accessibility of one view.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Accessibility {
    /// `accessible`: the view is one element for assistive technologies
    /// (its children are not exposed separately). `None` keeps the
    /// platform default: views with text or touch handlers are elements.
    pub accessible: Option<bool>,
    /// `accessibilityLabel`.
    pub label: Option<Arc<str>>,
    /// `accessibilityHint`.
    pub hint: Option<Arc<str>>,
    /// `role`.
    pub role: AccessibilityRole,
    /// `accessibilityState`.
    pub state: AccessibilityState,
    /// `accessibilityValue`.
    pub value: Option<AccessibilityValue>,
    /// `accessibilityElementsHidden` / `importantForAccessibility:
    /// "no-hide-descendants"`: hide the view and its subtree.
    pub hidden: bool,
    /// `accessibilityLiveRegion`.
    pub live_region: LiveRegion,
    /// `accessibilityActions`.
    pub actions: Vec<AccessibilityActionDef>,
}

impl Accessibility {
    /// True if nothing is set.
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// One accessibility property, as set from JS.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum AccessibilityProp {
    /// `accessible`: the view is one element for assistive technologies (its
    /// children are not exposed separately).
    #[prop(js = "accessible")]
    Accessible(Option<bool>),
    /// `accessibilityLabel`: what screen readers read.
    #[prop(js = "accessibilityLabel")]
    Label(Option<Arc<str>>),
    /// `accessibilityHint`: what activating the element does.
    #[prop(js = "accessibilityHint")]
    Hint(Option<Arc<str>>),
    /// `role`: what the element is.
    #[prop(js = "role", with = crate::js::host_values::role, reset = AccessibilityProp::Role(AccessibilityRole::None))]
    Role(AccessibilityRole),
    /// `accessibilityState`.
    #[prop(js = "accessibilityState")]
    State(AccessibilityState),
    /// `accessibilityValue`: the value of a range or textual element.
    #[prop(js = "accessibilityValue")]
    Value(Option<AccessibilityValue>),
    /// `accessibilityElementsHidden`: hides the view and its subtree from assistive
    /// technologies.
    #[prop(js = "accessibilityElementsHidden")]
    Hidden(bool),
    /// `importantForAccessibility`: `"auto"`, `"yes"`, `"no"` or
    /// `"no-hide-descendants"`.
    #[prop(js = "importantForAccessibility", with = crate::js::host_values::important, reset = AccessibilityProp::Important(None, false), ts = "\"auto\" | \"yes\" | \"no\" | \"no-hide-descendants\"")]
    Important(Option<bool>, bool),
    /// `accessibilityLiveRegion` (Android): how changes of the view are announced
    /// to TalkBack.
    #[prop(android = "accessibilityLiveRegion")]
    LiveRegion(LiveRegion),
    /// `accessibilityActions`: custom actions offered to assistive technologies
    /// (`onAccessibilityAction` reports them).
    #[prop(js = "accessibilityActions")]
    Actions(Vec<AccessibilityActionDef>),
}

/// Android's press ripple (`android={{ ripple }}`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Ripple {
    /// Ripple color; the theme's when `None`.
    pub color: Option<crate::style::Color>,
    /// The ripple is not clipped to the view.
    pub borderless: bool,
    /// Radius in points; the platform's when `None`.
    pub radius: Option<Points>,
    /// Drawn over the view's content (else behind it).
    pub foreground: bool,
}

/// Non-style properties of a view that only the platform needs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ViewProps {
    /// Which touches the view and its subtree receive.
    pub pointer_events: PointerEvents,
    /// Extends the touch area beyond the view's bounds.
    pub hit_slop: EdgeInsets,
    /// Milliseconds before a press becomes a long press (platform default
    /// when `None`).
    pub long_press_delay: Option<f32>,
    /// Ripple while pressed (Android).
    pub ripple: Option<Ripple>,
    /// Accessibility.
    pub accessibility: Accessibility,
    /// `testID`: an identifier for UI tests.
    pub test_id: Option<Arc<str>>,
    /// `panActivation`: the view's touch responder waits for a pan the
    /// platform recognizes.
    pub pan_activation: Option<PanActivation>,
    /// A vertical pan cooperates with descendant scroll views on iOS.
    pub pan_scroll_handoff: bool,
    /// `windowDrag` (desktops): pressing the view drags the window; `None`
    /// leaves it to the views around it.
    pub window_drag: Option<bool>,
    /// `focusable`: whether the view is a stop of the keyboard focus (Tab):
    /// `Some(true)` makes any view one, whether or not it takes presses (a
    /// chart, a slider, a list that moves its selection with the arrow
    /// keys); `Some(false)` keeps a view that takes presses out; `None`, the
    /// default, leaves it to the presses ([`ViewProps::focus_stop`]).
    pub focusable: Option<bool>,
    /// The logical parent of a popup's native focus-return scope: another
    /// popup, or the surface/modal root. Overlays have native siblings even when
    /// logically nested, so native ancestry cannot recover this relation.
    /// `None` leaves focus unchanged. The terminal and GPUI backends capture
    /// the real opener before a batch, focus popup controls after it, and
    /// restore a still-valid opener when their popup closes.
    pub focus_return_parent: Option<crate::NodeId>,
    /// The view is a selectable view (`View` with `selectable`): the
    /// texts in its subtree that are not `selectable={false}` share one
    /// selection, from text to text ([`crate::selection`]); an area inside
    /// another is part of the outer one. Texts outside areas select alone.
    pub selectable_view: bool,
}

impl ViewProps {
    /// Whether a view with these props is a stop of the keyboard focus
    /// (Tab and Shift+Tab reach it; it hears `onFocus` / `onBlur` and takes
    /// the `focus:` styles), given whether it `takes_presses` (listens for
    /// `onPress`): `focusable` decides when it is set, else taking presses
    /// does; a disabled view is never one.
    ///
    /// Focus and presses are separate: a stop that takes no presses is not
    /// pressed by Return or Space (its keys reach it through the app's
    /// keymap while it has the focus), and a view needs no press handler to
    /// be focusable, which would take the presses of a pressable around it
    /// (a chart in a card that opens a page). The platforms that move the
    /// keyboard focus between views (macOS, the web, the headless driver)
    /// all decide with this; inputs that edit are stops by their own rule,
    /// and each platform adds what it knows of visibility.
    pub fn focus_stop(&self, takes_presses: bool) -> bool {
        self.focusable.unwrap_or(takes_presses) && !self.accessibility.state.disabled
    }
}

/// When a pan on a view activates (`panActivation`; react-native-gesture-
/// handler's `activeOffsetX` / `failOffsetY`), decided by the platform on
/// the main thread as the fingers move: once the finger has moved further
/// than an active offset from where it went down, the pan activates (the
/// view becomes the touch responder and the scroll views around it can no
/// longer take these touches); once it has moved further than a fail offset
/// first, the pan fails and the scroll views keep the touches. Offsets are
/// distances in points along one axis, either direction. Without active
/// offsets, the pan activates after [`PanActivation::MIN_DISTANCE`] in any
/// direction.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PanActivation {
    /// Activates once the finger moved further than this horizontally.
    pub active_offset_x: Option<Points>,
    /// Activates once the finger moved further than this vertically.
    pub active_offset_y: Option<Points>,
    /// Fails once the finger moved further than this horizontally first.
    pub fail_offset_x: Option<Points>,
    /// Fails once the finger moved further than this vertically first.
    pub fail_offset_y: Option<Points>,
}

impl PanActivation {
    /// How far the finger moves before a pan without active offsets
    /// activates, in points.
    pub const MIN_DISTANCE: Points = px(10.0);

    /// A pan that activates horizontally past `active` and fails when it
    /// moves vertically past `fail` first (a scrubber in a vertical scroll
    /// view).
    pub const fn horizontal(active: Points, fail: Points) -> Self {
        Self {
            active_offset_x: Some(active),
            active_offset_y: None,
            fail_offset_x: None,
            fail_offset_y: Some(fail),
        }
    }

    /// A pan that activates vertically past `active` and fails when it
    /// moves horizontally past `fail` first.
    pub const fn vertical(active: Points, fail: Points) -> Self {
        Self {
            active_offset_x: None,
            active_offset_y: Some(active),
            fail_offset_x: Some(fail),
            fail_offset_y: None,
        }
    }

    /// The decision once the finger moved by (`dx`, `dy`) since it went
    /// down: `Some(true)` activates, `Some(false)` fails (a fail offset
    /// passed wins over an active one passed by the same move), `None`
    /// waits. The platforms ask it on every move until it decides.
    pub fn decide(&self, dx: Points, dy: Points) -> Option<bool> {
        let (dx, dy) = (dx.0, dy.0);
        let past = |limit: Option<Points>, d: f32| limit.is_some_and(|l| d.abs() > l.0);
        if past(self.fail_offset_x, dx) || past(self.fail_offset_y, dy) {
            return Some(false);
        }
        let activates = if self.active_offset_x.is_some() || self.active_offset_y.is_some() {
            past(self.active_offset_x, dx) || past(self.active_offset_y, dy)
        } else {
            dx.hypot(dy) > Self::MIN_DISTANCE.0
        };
        activates.then_some(true)
    }
}

/// Native animation values driven by gestures on a view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GestureValues {
    /// Horizontal drag translation (`pan={{ x }}`).
    pub pan_x: Option<crate::animation::NodeId>,
    /// Vertical drag translation (`pan={{ y }}`).
    pub pan_y: Option<crate::animation::NodeId>,
    /// Pinch scale (`pinch={{ scale }}`), multiplied from its value when the
    /// pinch starts.
    pub pinch: Option<crate::animation::NodeId>,
    /// Two-finger rotation in degrees (`rotation={{ angle }}`), added to its
    /// value when the rotation starts.
    pub rotation: Option<crate::animation::NodeId>,
}

impl GestureValues {
    /// True if no value is driven.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Timing curve of a layout animation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayoutCurve {
    /// Constant speed.
    Linear,
    /// Accelerates.
    EaseIn,
    /// Decelerates.
    EaseOut,
    /// Accelerates, then decelerates.
    EaseInEaseOut,
    /// A spring with the given damping ratio (0..1).
    Spring {
        /// Damping ratio: 1 does not overshoot.
        damping: f32,
    },
    /// The software keyboard's motion (`type: "keyboard"`): the curve the
    /// system moves its keyboard with, timed from when the keyboard
    /// started to move, so that what makes room for it moves with it (the
    /// duration is the keyboard's, `keyboard_duration`). Where there is no
    /// software keyboard, or nothing moved it, it eases in and out.
    Keyboard,
}

/// The property animated when views appear or disappear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutProperty {
    /// Fade in / out.
    Opacity,
    /// Grow / shrink from the center.
    Scale,
}

/// How one kind of change animates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutTransition {
    /// Curve.
    pub curve: LayoutCurve,
    /// Animated property of appearing / disappearing views.
    pub property: LayoutProperty,
    /// Duration in milliseconds.
    pub duration_ms: f32,
    /// Delay in milliseconds.
    pub delay_ms: f32,
}

/// Animates the layout changes of the next commit
/// (`LayoutAnimation.configureNext`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LayoutAnimation {
    /// Views inserted by the commit.
    pub create: Option<LayoutTransition>,
    /// Views whose frame changes.
    pub update: Option<LayoutTransition>,
    /// Views removed by the commit.
    pub delete: Option<LayoutTransition>,
}

impl LayoutTransition {
    /// `curve` over `duration_ms`, appearing views fading.
    pub const fn new(curve: LayoutCurve, duration_ms: f32) -> Self {
        Self {
            curve,
            property: LayoutProperty::Opacity,
            duration_ms,
            delay_ms: 0.0,
        }
    }
}

impl LayoutAnimation {
    /// `transition` for every kind of change.
    pub const fn all(transition: LayoutTransition) -> Self {
        Self {
            create: Some(transition),
            update: Some(transition),
            delete: Some(transition),
        }
    }

    /// React Native's `LayoutAnimation.Presets.easeInEaseOut`: 300 ms,
    /// views fading in and out.
    pub const EASE_IN_EASE_OUT: Self =
        Self::all(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 300.0));

    /// `Presets.linear`: 500 ms at constant speed.
    pub const LINEAR: Self = Self::all(LayoutTransition::new(LayoutCurve::Linear, 500.0));

    /// `Presets.spring`: frames spring (damping 0.4) over 700 ms, views
    /// fade linearly.
    pub const SPRING: Self = Self {
        create: Some(LayoutTransition::new(LayoutCurve::Linear, 700.0)),
        update: Some(LayoutTransition::new(
            LayoutCurve::Spring { damping: 0.4 },
            700.0,
        )),
        delete: Some(LayoutTransition::new(LayoutCurve::Linear, 700.0)),
    };
}
