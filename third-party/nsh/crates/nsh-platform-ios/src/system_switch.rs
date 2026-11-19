//! `nsh/mobile`'s `Switch` on iOS: a `UISwitch` in the system's look
//! (Liquid Glass when linked against the iOS 26 SDK and run on iOS 26 or
//! later), its motion, haptics and VoiceOver. The app places it and owns the
//! value; the component reports the switch's own size for what the style
//! leaves open and the user's flip as `change` with the value it asks for.
//! It is on in the style's `accentColor`, else the theme's `tint`.

use std::{ptr::NonNull, rc::Rc};

use block2::RcBlock;
use nsh_core::JsonValue;
use objc2::{
    MainThreadMarker, MainThreadOnly, msg_send,
    rc::{Retained, Weak},
};
use objc2_core_foundation::{CGRect, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{UIAction, UIColor, UIControlEvents, UISwitch, UIView};

use crate::component::{ComponentContext, ComponentFactory, NativeComponent};

/// The color of a `tint` or `accentColor` prop (`"#rrggbb"` or
/// `"#rrggbbaa"`); `None` for none.
fn parse_tint(value: Option<&JsonValue>) -> Option<nsh_core::Color> {
    let hex = value?.as_str()?;
    nsh_core::Hsla::parse_hex(hex)
        .ok()
        .map(nsh_core::Color::from)
}

struct SystemSwitch {
    switch: Retained<UISwitch>,
    /// The app's value, which a `revision` shows again.
    on: bool,
    /// The theme's color (`tint`).
    tint: Option<nsh_core::Color>,
    /// The style's `accentColor`, over `tint`.
    accent: Option<nsh_core::Color>,
}

impl SystemSwitch {
    /// Moves the switch to the app's value, as the system moves it; the
    /// value it already shows (the user's flip the app took) moves nothing.
    fn show(&self) {
        if self.switch.isOn() != self.on {
            let shown = self.switch.window().is_some();
            self.switch.setOn_animated(self.on, shown);
        }
    }

    /// Its color when on: the accent, else the tint, else the system's green.
    fn paint(&self) {
        let color = self.accent.or(self.tint).map(|c| {
            let (r, g, b, a) = c.to_f64();
            UIColor::colorWithRed_green_blue_alpha(r, g, b, a)
        });
        self.switch.setOnTintColor(color.as_deref());
    }
}

impl NativeComponent for SystemSwitch {
    fn view(&self) -> &UIView {
        &self.switch
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "checked" => {
                self.on = value.and_then(JsonValue::as_bool).unwrap_or(false);
                self.show();
            }
            // A flip the app has heard: a value it kept moves the switch back.
            "revision" => self.show(),
            "disabled" => {
                let disabled = value.and_then(JsonValue::as_bool).unwrap_or(false);
                self.switch.setEnabled(!disabled);
            }
            "accessibilityLabel" => {
                let label = value.and_then(JsonValue::as_str).map(NSString::from_str);
                // SAFETY: `accessibilityLabel` is UIAccessibility's NSString
                // property, which every NSObject has; nil removes it.
                let _: () =
                    unsafe { msg_send![&*self.switch, setAccessibilityLabel: label.as_deref()] };
            }
            "tint" => {
                self.tint = parse_tint(value);
                self.paint();
            }
            "accentColor" => {
                self.accent = parse_tint(value);
                self.paint();
            }
            _ => {}
        }
    }
}

/// Makes the switch of each `Switch` element
/// (`nsh_core::platform::SWITCH_COMPONENT`), which every surface has
/// (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm = MainThreadMarker::new().expect("the switch is made on the main thread");
        let switch = UISwitch::initWithFrame(UISwitch::alloc(mtm), CGRect::default());
        // The user's flip, read from the switch the action came from: a weak
        // reference, as the switch keeps the action and its block.
        let weak = Weak::from_retained(&switch);
        let emit = context.clone();
        let changed = RcBlock::new(move |_: NonNull<UIAction>| {
            if let Some(switch) = weak.load() {
                emit.emit("change", JsonValue::Bool(switch.isOn()));
            }
        });
        // SAFETY: the handler is a block UIKit copies; it runs on the main
        // thread, as the switch's events do.
        let action = unsafe { UIAction::actionWithHandler(RcBlock::as_ptr(&changed), mtm) };
        switch.addAction_forControlEvents(&action, UIControlEvents::ValueChanged);
        // Its own size, for the dimensions the style leaves open: the
        // system's, which no prop changes.
        let size = switch.sizeThatFits(CGSize::new(0.0, 0.0));
        context.set_size(size.width as f32, size.height as f32);
        Box::new(SystemSwitch {
            switch,
            on: false,
            tint: None,
            accent: None,
        }) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_tint;

    #[test]
    fn a_tint_is_a_hex_color_or_none() {
        assert!(parse_tint(Some(&json!("#3366ff"))).is_some());
        assert!(parse_tint(Some(&json!(null))).is_none());
        assert!(parse_tint(Some(&json!("not a color"))).is_none());
        assert!(parse_tint(None).is_none());
    }
}
