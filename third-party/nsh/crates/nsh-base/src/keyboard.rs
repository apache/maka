//! The software keyboard: `Keyboard` and `KeyboardAvoidingView`.

use nsh_core::ui::{LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition, prelude::*};

/// The software keyboard.
#[module]
#[derive(Debug)]
pub struct Keyboard;

#[module]
impl Keyboard {
    /// Unfocuses the focused input, hiding the keyboard.
    pub fn dismiss(cx: &mut ModuleCx) {
        cx.dismiss_keyboard();
    }
}

/// The props of [`KeyboardAvoidingView`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct KeyboardAvoidingViewProps {
    /// Avoid the keyboard (default true).
    #[prop(default = true)]
    pub enabled: Prop<bool>,
    /// `padding` (default) pads the bottom by the keyboard's height;
    /// `height` shrinks the view instead (a bottom margin, so its
    /// background ends at the keyboard).
    #[prop(default)]
    pub behavior: Prop<AvoidBehavior>,
    /// Added to the keyboard's height while it shows (a tab bar below the
    /// view, say).
    #[prop(default)]
    pub offset: Prop<Points>,
    /// The content.
    pub children: Prop<Children>,
}

/// How a [`KeyboardAvoidingView`] makes room.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum AvoidBehavior {
    /// Pads its bottom.
    #[default]
    Padding,
    /// Shrinks.
    Height,
}

/// A view that keeps its content above the software keyboard, animated
/// with the keyboard. For content outside scroll views, such as a message
/// bar at the bottom of a screen (inputs inside scroll views are kept
/// visible natively). It assumes it reaches the bottom of the surface, as
/// a screen's content does. Where the window shrinks for the keyboard
/// instead (an Android host that resizes), nothing moves.
#[component]
pub fn KeyboardAvoidingView(props: KeyboardAvoidingViewProps) -> impl IntoElement {
    // Moves with the keyboard: the frame change animates natively.
    let shown = std::cell::Cell::new(None);
    effect(move || {
        let height = keyboard_height();
        let previous = shown.replace(Some(height));
        let duration = untracked(keyboard_duration);
        if previous.is_some_and(|p| p != height)
            && untracked(|| props.enabled.get())
            && duration > 0.0
        {
            animate_layout(LayoutAnimation {
                create: None,
                update: Some(LayoutTransition {
                    curve: LayoutCurve::Keyboard,
                    property: LayoutProperty::Opacity,
                    duration_ms: duration * 1000.0,
                    delay_ms: 0.0,
                }),
                delete: None,
            });
        }
    });
    let lift = computed(move || {
        let height = keyboard_height();
        if !props.enabled.get() || height == Points::ZERO {
            Points::ZERO
        } else {
            (height + props.offset.get()).max(Points::ZERO)
        }
    });
    // The room it makes, by `behavior`.
    let room = move |behavior: AvoidBehavior| {
        move || EdgeInsets {
            bottom: if props.behavior.get() == behavior {
                lift.get()
            } else {
                Points::ZERO
            },
            ..EdgeInsets::default()
        }
    };
    view()
        .inset_padding(room(AvoidBehavior::Padding))
        .inset_margin(room(AvoidBehavior::Height))
        .child(props.children)
}
