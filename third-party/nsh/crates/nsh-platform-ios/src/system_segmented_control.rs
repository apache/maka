//! `nsh/mobile`'s `SegmentedControl` on iOS: a `UISegmentedControl` in the
//! system's look (Liquid Glass when linked against the iOS 26 SDK and run
//! on iOS 26 or later). The app places it and owns the selection; the
//! component reports the control's own size for what the style leaves
//! open and the user's choice as `change` with the segment's index.

use std::{ptr::NonNull, rc::Rc};

use block2::RcBlock;
use nsh_core::JsonValue;
use objc2::{
    MainThreadMarker, MainThreadOnly, msg_send,
    rc::{Retained, Weak},
};
use objc2_core_foundation::{CGRect, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{UIAction, UIControlEvents, UIImage, UISegmentedControl, UIView};

use crate::component::{ComponentContext, ComponentFactory, NativeComponent};

/// One segment as the props give it.
#[derive(Debug, Clone, Default, PartialEq)]
struct Segment {
    title: String,
    icon: String,
    disabled: bool,
}

/// The segments of an `items` prop; anything but objects is skipped.
fn parse_items(items: &[JsonValue]) -> Vec<Segment> {
    items
        .iter()
        .filter_map(JsonValue::as_object)
        .map(|item| Segment {
            title: item
                .get("title")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned(),
            icon: item
                .get("icon")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned(),
            disabled: item
                .get("disabled")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false),
        })
        .collect()
}

/// The control's selected index for `selected` among `count` segments:
/// none (`UISegmentedControlNoSegment`) past the last.
fn selected_segment(selected: u64, count: usize) -> isize {
    if (selected as usize) < count {
        selected as isize
    } else {
        objc2_ui_kit::UISegmentedControlNoSegment as isize
    }
}

struct SystemSegmentedControl {
    control: Retained<UISegmentedControl>,
    segments: Vec<Segment>,
    selected: u64,
    context: ComponentContext,
}

impl SystemSegmentedControl {
    /// Shows `segments`: in place when their number is kept (no flash of
    /// the control), made again otherwise.
    fn set_segments(&mut self, segments: Vec<Segment>) {
        let control = &self.control;
        if segments.len() != self.segments.len() {
            control.removeAllSegments();
            for (index, segment) in segments.iter().enumerate() {
                control.insertSegmentWithTitle_atIndex_animated(
                    Some(&NSString::from_str(&segment.title)),
                    index,
                    false,
                );
                show(control, index, segment);
            }
        } else {
            for (index, (old, segment)) in self.segments.iter().zip(&segments).enumerate() {
                if old != segment {
                    show(control, index, segment);
                }
            }
        }
        self.segments = segments;
        self.control
            .setSelectedSegmentIndex(selected_segment(self.selected, self.segments.len()));
        self.report_size();
    }

    /// The control's own size, for the dimensions the style leaves open.
    fn report_size(&self) {
        let size = self.control.sizeThatFits(CGSize::new(0.0, 0.0));
        self.context.set_size(size.width as f32, size.height as f32);
    }
}

/// Shows `segment` at `index`: its icon (an SF Symbol, which VoiceOver
/// names by the title) or its title, and whether it can be chosen.
fn show(control: &UISegmentedControl, index: usize, segment: &Segment) {
    let image = (!segment.icon.is_empty())
        .then(|| UIImage::systemImageNamed(&NSString::from_str(&segment.icon)))
        .flatten();
    match image {
        Some(image) => {
            let title = NSString::from_str(&segment.title);
            // SAFETY: `accessibilityLabel` is UIAccessibility's NSString
            // property, which every NSObject has.
            let _: () = unsafe { msg_send![&*image, setAccessibilityLabel: &*title] };
            // A segment shows an image or a title, never both: clear the
            // title a title-to-icon change leaves behind.
            control.setTitle_forSegmentAtIndex(None, index);
            control.setImage_forSegmentAtIndex(Some(&image), index);
        }
        None => {
            if !segment.icon.is_empty() {
                log::warn!(
                    target: "js",
                    "SegmentedControl: no SF Symbol is named `{}`; the segment shows its title",
                    segment.icon
                );
            }
            // Likewise the image an icon-to-title change leaves behind.
            control.setImage_forSegmentAtIndex(None, index);
            control.setTitle_forSegmentAtIndex(Some(&NSString::from_str(&segment.title)), index);
        }
    }
    control.setEnabled_forSegmentAtIndex(!segment.disabled, index);
}

impl NativeComponent for SystemSegmentedControl {
    fn view(&self) -> &UIView {
        &self.control
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "items" => {
                let segments = parse_items(value.and_then(JsonValue::as_array).map_or(&[], |v| v));
                self.set_segments(segments);
            }
            "selectedIndex" => {
                self.selected = value.and_then(JsonValue::as_u64).unwrap_or(0);
                self.control
                    .setSelectedSegmentIndex(selected_segment(self.selected, self.segments.len()));
            }
            "disabled" => {
                let disabled = value.and_then(JsonValue::as_bool).unwrap_or(false);
                self.control.setEnabled(!disabled);
            }
            _ => {}
        }
    }
}

/// Makes the control of each `SegmentedControl` element
/// (`nsh_core::platform::SEGMENTED_CONTROL_COMPONENT`), which every surface
/// has (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm =
            MainThreadMarker::new().expect("the segmented control is made on the main thread");
        let control =
            UISegmentedControl::initWithFrame(UISegmentedControl::alloc(mtm), CGRect::default());
        // The user's choice, read from the control the action came from: a
        // weak reference, as the control keeps the action and its block.
        let weak = Weak::from_retained(&control);
        let emit = context.clone();
        let changed = RcBlock::new(move |_: NonNull<UIAction>| {
            if let Some(control) = weak.load() {
                let index = control.selectedSegmentIndex();
                if index >= 0 {
                    emit.emit("change", JsonValue::from(index as u64));
                }
            }
        });
        // SAFETY: the handler is a block UIKit copies; it runs on the main
        // thread, as the control's events do.
        let action = unsafe { UIAction::actionWithHandler(RcBlock::as_ptr(&changed), mtm) };
        control.addAction_forControlEvents(&action, UIControlEvents::ValueChanged);
        Box::new(SystemSegmentedControl {
            control,
            segments: Vec::new(),
            selected: 0,
            context,
        }) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Segment, parse_items, selected_segment};

    #[test]
    fn segments_carry_titles_icons_and_disabled() {
        let segments = parse_items(&[
            json!({ "title": "Light", "icon": "sun.max" }),
            json!({ "title": "Dark", "disabled": true }),
            json!("not a segment"),
        ]);
        assert_eq!(
            segments,
            [
                Segment {
                    title: "Light".into(),
                    icon: "sun.max".into(),
                    disabled: false,
                },
                Segment {
                    title: "Dark".into(),
                    icon: String::new(),
                    disabled: true,
                },
            ]
        );
    }

    #[test]
    fn an_index_past_the_segments_selects_none() {
        assert_eq!(selected_segment(1, 2), 1);
        assert_eq!(selected_segment(2, 2), -1);
        assert_eq!(selected_segment(0, 0), -1);
    }
}
