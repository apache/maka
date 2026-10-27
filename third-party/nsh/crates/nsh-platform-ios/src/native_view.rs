//! `NshView`: the UIView behind `<view>` and `<image>` (and, through
//! [`crate::text_view::TextView`], `<text>`). It implements what plain
//! UIViews cannot: `pointerEvents`, `hitSlop` and accessibility computed
//! from the app's properties.

use std::cell::RefCell;

use block2::RcBlock;
use nsh_core::{
    Accessibility, AccessibilityRole, Checked, EventKind, EventPayload, NodeId, PayloadValue,
    PointerEvents, ViewProps,
};
use nsh_engine::EngineControl;
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSObject, NSString};
use objc2_ui_kit::{
    UIAccessibilityCustomAction, UIAccessibilityTraitAdjustable, UIAccessibilityTraitButton,
    UIAccessibilityTraitHeader, UIAccessibilityTraitImage, UIAccessibilityTraitKeyboardKey,
    UIAccessibilityTraitLink, UIAccessibilityTraitNone, UIAccessibilityTraitNotEnabled,
    UIAccessibilityTraitSearchField, UIAccessibilityTraitSelected, UIAccessibilityTraitStaticText,
    UIAccessibilityTraitSummaryElement, UIAccessibilityTraitUpdatesFrequently,
    UIAccessibilityTraits, UIEvent, UIResponder, UIView,
};

#[derive(Default)]
pub(crate) struct NshViewIvars {
    props: RefCell<ViewProps>,
    /// Where accessibility actions are reported (set once the view is mounted).
    control: RefCell<Option<EngineControl>>,
    /// The view handles presses: an accessibility element by default, and
    /// "activate" presses it.
    pressable: std::cell::Cell<bool>,
    /// The area descendants cover outside the bounds (`MountItem::Overflow`):
    /// touches there are looked for in the subviews.
    overflow: std::cell::Cell<Option<CGRect>>,
    /// An `increment` / `decrement` reported whose value has not arrived
    /// yet, and the value VoiceOver read since (`Some` once it asked).
    step: RefCell<Option<Option<String>>>,
}

define_class!(
    /// A UIView with React Native's touch and accessibility properties.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NshViewIvars]
    pub(crate) struct NshView;

    impl NshView {
        /// Sets this class's ivars for subclasses (`TextView`) too.
        #[unsafe(method_id(initWithFrame:))]
        fn init_with_frame(this: objc2::rc::Allocated<Self>, frame: CGRect) -> Retained<Self> {
            let this = this.set_ivars(NshViewIvars::default());
            // SAFETY: UIView's designated initializer.
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }

        #[unsafe(method_id(hitTest:withEvent:))]
        fn hit_test(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
            self.hit(point, event)
        }

        #[unsafe(method(pointInside:withEvent:))]
        fn point_inside(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
            self.inside(point, event)
        }

        #[unsafe(method(isAccessibilityElement))]
        fn is_accessibility_element(&self) -> bool {
            self.a11y_element()
        }

        #[unsafe(method_id(accessibilityLabel))]
        fn accessibility_label(&self) -> Option<Retained<NSString>> {
            self.a11y_label()
        }

        #[unsafe(method_id(accessibilityHint))]
        fn accessibility_hint(&self) -> Option<Retained<NSString>> {
            self.ivars()
                .props
                .borrow()
                .accessibility
                .hint
                .as_deref()
                .map(NSString::from_str)
        }

        #[unsafe(method_id(accessibilityValue))]
        fn accessibility_value(&self) -> Option<Retained<NSString>> {
            let value = accessibility_value(&self.ivars().props.borrow());
            if let Some(read) = self.ivars().step.borrow_mut().as_mut() {
                *read = Some(value.clone().unwrap_or_default());
            }
            value.map(|v| NSString::from_str(&v))
        }

        #[unsafe(method(accessibilityTraits))]
        fn accessibility_traits(&self) -> UIAccessibilityTraits {
            self.a11y_traits()
        }

        #[unsafe(method(accessibilityElementsHidden))]
        fn accessibility_elements_hidden(&self) -> bool {
            self.ivars().props.borrow().accessibility.hidden
        }

        #[unsafe(method_id(accessibilityIdentifier))]
        fn accessibility_identifier(&self) -> Option<Retained<NSString>> {
            self.ivars().props.borrow().test_id.as_deref().map(NSString::from_str)
        }

        #[unsafe(method_id(accessibilityCustomActions))]
        fn accessibility_custom_actions(&self) -> Option<Retained<NSArray<UIAccessibilityCustomAction>>> {
            self.a11y_actions()
        }

        #[unsafe(method(accessibilityActivate))]
        fn accessibility_activate(&self) -> bool {
            self.a11y_activate()
        }

        #[unsafe(method(accessibilityIncrement))]
        fn accessibility_increment(&self) {
            self.standard_action("increment");
        }

        #[unsafe(method(accessibilityDecrement))]
        fn accessibility_decrement(&self) {
            self.standard_action("decrement");
        }
    }
);

impl NshView {
    /// `pointerEvents`.
    pub(crate) fn pointer_events(&self) -> PointerEvents {
        self.ivars().props.borrow().pointer_events
    }

    fn hit(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
        let mode = self.ivars().props.borrow().pointer_events;
        // SAFETY: calling the superclass implementation.
        let hit = || -> Option<Retained<UIView>> {
            unsafe { msg_send![super(self), hitTest: point, withEvent: event] }
        };
        match mode {
            PointerEvents::Auto | PointerEvents::BoxNone
                if self.outside_in_overflow(point, event) =>
            {
                self.hit_overflow(point, event)
            }
            PointerEvents::Auto => hit(),
            PointerEvents::None => None,
            PointerEvents::BoxNone => {
                hit().filter(|v| !std::ptr::eq::<UIView>(&**v, self.as_ref()))
            }
            PointerEvents::BoxOnly => {
                let visible =
                    self.isUserInteractionEnabled() && !self.isHidden() && self.alpha() > 0.01;
                (visible && self.inside(point, event)).then(|| Retained::into_super(self.retain()))
            }
        }
    }

    /// The point is outside the view (and its hit slop) but in the area
    /// its descendants cover, which UIKit's hit test never looks at.
    fn outside_in_overflow(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
        let Some(e) = self.ivars().overflow.get() else {
            return false;
        };
        point.x >= e.origin.x
            && point.y >= e.origin.y
            && point.x < e.origin.x + e.size.width
            && point.y < e.origin.y + e.size.height
            && !self.clipsToBounds()
            && self.isUserInteractionEnabled()
            && !self.isHidden()
            && self.alpha() > 0.01
            && !self.inside(point, event)
    }

    /// UIKit's hit test of the subviews, without its bounds check: the
    /// topmost subview with a target under the point; never the view itself
    /// (the point is outside it).
    fn hit_overflow(&self, point: CGPoint, event: Option<&UIEvent>) -> Option<Retained<UIView>> {
        let subviews = self.subviews();
        for i in (0..subviews.count()).rev() {
            let sub = subviews.objectAtIndex(i);
            let local = self.convertPoint_toView(point, Some(&sub));
            if let Some(hit) = sub.hitTest_withEvent(local, event) {
                return Some(hit);
            }
        }
        None
    }

    fn inside(&self, point: CGPoint, event: Option<&UIEvent>) -> bool {
        let slop = self.ivars().props.borrow().hit_slop.map(|v| v.0);
        if slop == Default::default() {
            // SAFETY: calling the superclass implementation.
            return unsafe { msg_send![super(self), pointInside: point, withEvent: event] };
        }
        let b = self.bounds();
        let x0 = b.origin.x - slop.left as f64;
        let y0 = b.origin.y - slop.top as f64;
        let x1 = b.origin.x + b.size.width + slop.right as f64;
        let y1 = b.origin.y + b.size.height + slop.bottom as f64;
        point.x >= x0 && point.x < x1 && point.y >= y0 && point.y < y1
    }

    fn a11y_element(&self) -> bool {
        let props = self.ivars().props.borrow();
        let a = &props.accessibility;
        !a.hidden
            && a.accessible
                .unwrap_or_else(|| self.ivars().pressable.get() || a.label.is_some())
    }

    fn a11y_label(&self) -> Option<Retained<NSString>> {
        if let Some(label) = &self.ivars().props.borrow().accessibility.label {
            return Some(NSString::from_str(label));
        }
        // Like React Native: an element without a label reads the text
        // inside it.
        let mut text = String::new();
        collect_text(self, &mut text);
        (!text.is_empty()).then(|| NSString::from_str(&text))
    }

    fn a11y_traits(&self) -> UIAccessibilityTraits {
        let props = self.ivars().props.borrow();
        let mut traits = traits(&props);
        if self.ivars().pressable.get() && props.accessibility.role == AccessibilityRole::None {
            // SAFETY: an immutable UIKit constant.
            traits |= unsafe { UIAccessibilityTraitButton };
        }
        traits
    }

    fn a11y_actions(&self) -> Option<Retained<NSArray<UIAccessibilityCustomAction>>> {
        let props = self.ivars().props.borrow();
        let id = self.tag() as NodeId;
        let control = self.ivars().control.borrow().clone()?;
        let mtm = self.mtm();
        let actions: Vec<_> = props
            .accessibility
            .actions
            .iter()
            .filter(|a| !is_standard_action(&a.name))
            .map(|a| {
                let name = a.name.clone();
                let control = control.clone();
                let handler: RcBlock<
                    dyn Fn(std::ptr::NonNull<UIAccessibilityCustomAction>) -> objc2::runtime::Bool,
                > = RcBlock::new(move |_| {
                    action(&control, id, &name);
                    objc2::runtime::Bool::YES
                });
                let label = NSString::from_str(a.label.as_deref().unwrap_or(&a.name));
                // SAFETY: a block-based custom action (iOS 13+); UIKit copies
                // the block.
                unsafe {
                    UIAccessibilityCustomAction::initWithName_actionHandler(
                        UIAccessibilityCustomAction::alloc(mtm),
                        &label,
                        RcBlock::as_ptr(&handler),
                    )
                }
            })
            .collect();
        (!actions.is_empty()).then(|| NSArray::from_retained_slice(&actions))
    }

    fn a11y_activate(&self) -> bool {
        let id = self.tag() as NodeId;
        let Some(control) = self.ivars().control.borrow().clone() else {
            return false;
        };
        if self.has_action("activate") {
            action(&control, id, "activate");
            return true;
        }
        if self.ivars().pressable.get() {
            control.dispatch_event(id, EventKind::Press, EventPayload::None);
            return true;
        }
        false
    }
}

impl NshView {
    pub(crate) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // SAFETY: our designated initializer.
        unsafe {
            msg_send![Self::alloc(mtm), initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::ZERO)]
        }
    }

    /// Sets the touch, accessibility and test properties.
    pub(crate) fn set_props(&self, props: ViewProps, control: &EngineControl) {
        let late = self.late_step_value(&props);
        *self.ivars().props.borrow_mut() = props;
        *self.ivars().control.borrow_mut() = Some(control.clone());
        if let Some(value) = late {
            crate::system::announce(&value);
        }
    }

    /// The value an `increment` / `decrement` led to, when it arrives after
    /// VoiceOver read the element's value (the action is answered on the
    /// engine thread, so it usually does): VoiceOver reads the value right
    /// after `accessibilityIncrement` returns and never again, so the new
    /// one is announced. A value that arrives before VoiceOver asks is the
    /// one it reads, and is not announced twice.
    fn late_step_value(&self, props: &ViewProps) -> Option<String> {
        if self.ivars().step.borrow().is_none() {
            return None;
        }
        let value = accessibility_value(props).unwrap_or_default();
        if accessibility_value(&self.ivars().props.borrow()).unwrap_or_default() == value {
            return None;
        }
        let read = self.ivars().step.take().flatten()?;
        // SAFETY: `UIAccessibilityFocus`'s informal protocol on NSObject.
        let focused: bool = unsafe { msg_send![self, accessibilityElementIsFocused] };
        (focused && !value.is_empty() && read != value).then_some(value)
    }

    /// The view is a selectable view (`ViewProps::selectable_view`).
    pub(crate) fn is_selectable_view(&self) -> bool {
        self.ivars().props.borrow().selectable_view
    }

    /// The area descendants cover outside the bounds, in the view's
    /// coordinates (`MountItem::Overflow`).
    pub(crate) fn set_overflow(&self, extent: Option<CGRect>) {
        self.ivars().overflow.set(extent);
    }

    /// Replaces the label of the props set last (`MountItem::AccessibilityLabel`).
    pub(crate) fn set_accessibility_label(&self, label: Option<std::sync::Arc<str>>) {
        self.ivars().props.borrow_mut().accessibility.label = label;
    }

    /// The view has press handlers.
    pub(crate) fn set_pressable(&self, pressable: bool, control: &EngineControl) {
        self.ivars().pressable.set(pressable);
        if pressable && self.ivars().control.borrow().is_none() {
            *self.ivars().control.borrow_mut() = Some(control.clone());
        }
    }

    fn has_action(&self, name: &str) -> bool {
        self.ivars()
            .props
            .borrow()
            .accessibility
            .actions
            .iter()
            .any(|a| &*a.name == name)
    }

    fn standard_action(&self, name: &str) {
        if self.has_action(name)
            && let Some(control) = self.ivars().control.borrow().as_ref()
        {
            if matches!(name, "increment" | "decrement") {
                *self.ivars().step.borrow_mut() = Some(None);
            }
            action(control, self.tag() as NodeId, name);
        }
    }
}

fn action(control: &EngineControl, id: NodeId, name: &str) {
    control.dispatch_event(
        id,
        EventKind::AccessibilityAction,
        EventPayload::Map(vec![("actionName", PayloadValue::Str(name.to_owned()))]),
    );
}

/// Actions VoiceOver performs with gestures rather than from the actions
/// menu.
fn is_standard_action(name: &str) -> bool {
    matches!(
        name,
        "activate" | "increment" | "decrement" | "magicTap" | "escape"
    )
}

/// The element steps its value (`increment` / `decrement` among its
/// actions): VoiceOver performs those (swipe up / down) only on adjustable
/// elements, whatever their role.
fn steps(a: &Accessibility) -> bool {
    a.actions
        .iter()
        .any(|x| matches!(&*x.name, "increment" | "decrement"))
}

/// The traits of `props`' role, state and actions.
fn traits(props: &ViewProps) -> UIAccessibilityTraits {
    let a = &props.accessibility;
    // SAFETY: immutable UIKit constants.
    unsafe {
        let mut t = match a.role {
            AccessibilityRole::Button
            | AccessibilityRole::ImageButton
            | AccessibilityRole::Checkbox
            | AccessibilityRole::Radio
            | AccessibilityRole::Switch
            | AccessibilityRole::Tab
            | AccessibilityRole::Menuitem
            // UIKit has no option trait: an option is chosen by activating
            // it, and the selected one carries the Selected trait below.
            | AccessibilityRole::Option => UIAccessibilityTraitButton,
            AccessibilityRole::Link => UIAccessibilityTraitLink,
            AccessibilityRole::Search => UIAccessibilityTraitSearchField,
            AccessibilityRole::Image => UIAccessibilityTraitImage,
            AccessibilityRole::KeyboardKey => UIAccessibilityTraitKeyboardKey,
            AccessibilityRole::Text => UIAccessibilityTraitStaticText,
            AccessibilityRole::Adjustable | AccessibilityRole::Spinbutton => {
                UIAccessibilityTraitAdjustable
            }
            AccessibilityRole::Header | AccessibilityRole::ColumnHeader => {
                UIAccessibilityTraitHeader
            }
            AccessibilityRole::Summary => UIAccessibilityTraitSummaryElement,
            AccessibilityRole::Progressbar | AccessibilityRole::Timer => {
                UIAccessibilityTraitUpdatesFrequently
            }
            _ => UIAccessibilityTraitNone,
        };
        if a.role == AccessibilityRole::ImageButton {
            t |= UIAccessibilityTraitImage;
        }
        if steps(a) {
            t |= UIAccessibilityTraitAdjustable;
        }
        if a.state.disabled {
            t |= UIAccessibilityTraitNotEnabled;
        }
        if a.state.selected {
            t |= UIAccessibilityTraitSelected;
        }
        if a.state.busy {
            t |= UIAccessibilityTraitUpdatesFrequently;
        }
        t
    }
}

/// The spoken value: an explicit `accessibilityValue`, plus checked and
/// expanded states (UIKit has no traits for those).
fn accessibility_value(props: &ViewProps) -> Option<String> {
    let a = &props.accessibility;
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = &a.value {
        if let Some(text) = &v.text {
            parts.push(text.to_string());
        } else if let Some(now) = v.now {
            match (v.min, v.max) {
                (Some(min), Some(max)) if max > min => {
                    parts.push(format!(
                        "{}%",
                        (((now - min) / (max - min)) * 100.0).round()
                    ));
                }
                _ => parts.push(format!("{now}")),
            }
        }
    }
    match a.state.checked {
        Some(Checked::True) => parts.push("checked".into()),
        Some(Checked::False) => parts.push("not checked".into()),
        Some(Checked::Mixed) => parts.push("mixed".into()),
        None => {}
    }
    match a.state.expanded {
        Some(true) => parts.push("expanded".into()),
        Some(false) => parts.push("collapsed".into()),
        None => {}
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// Appends the accessibility labels of the text inside `view`.
fn collect_text(view: &UIView, out: &mut String) {
    for child in view.subviews().iter() {
        if child.isHidden() {
            continue;
        }
        // SAFETY: an NSObject; asking whether it is a text view.
        let is_text: bool =
            unsafe { msg_send![&*child, isKindOfClass: crate::text_view::TextView::class()] };
        if is_text {
            let label: Option<Retained<NSString>> =
                unsafe { msg_send![&*child, accessibilityLabel] };
            if let Some(label) = label {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&label.to_string());
            }
        } else {
            collect_text(&child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::AccessibilityActionDef;

    use super::*;

    fn props(role: AccessibilityRole, actions: &[&str]) -> ViewProps {
        let mut props = ViewProps::default();
        props.accessibility.role = role;
        props.accessibility.actions = actions
            .iter()
            .map(|name| AccessibilityActionDef {
                name: Arc::from(*name),
                label: None,
            })
            .collect();
        props
    }

    /// `increment` / `decrement` add the adjustable trait to the role's.
    #[test]
    fn stepping_actions_make_the_element_adjustable() {
        // SAFETY: immutable UIKit constants.
        let (image, adjustable, button) = unsafe {
            (
                UIAccessibilityTraitImage,
                UIAccessibilityTraitAdjustable,
                UIAccessibilityTraitButton,
            )
        };
        let traits_of = |role, actions: &[&str]| traits(&props(role, actions));
        assert_eq!(
            traits_of(AccessibilityRole::Image, &["increment", "decrement"]),
            image | adjustable
        );
        assert_eq!(
            traits_of(AccessibilityRole::Image, &["decrement"]),
            image | adjustable
        );
        assert_eq!(
            traits_of(AccessibilityRole::None, &["increment"]),
            adjustable
        );
        assert_eq!(traits_of(AccessibilityRole::Adjustable, &[]), adjustable);
        // Without them every role keeps its traits.
        assert_eq!(traits_of(AccessibilityRole::Image, &[]), image);
        assert_eq!(
            traits_of(AccessibilityRole::Button, &["activate", "archive"]),
            button
        );
        assert_eq!(traits_of(AccessibilityRole::None, &["magicTap"]), 0);
    }
}
