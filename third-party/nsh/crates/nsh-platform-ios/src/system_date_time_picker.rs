//! `nsh/mobile`'s `DateTimePicker` on iOS: a `UIDatePicker` in its compact
//! style, the system's capsule of the value that opens its calendar or time
//! wheels. The app places it and owns the value; the component reports the
//! picker's own size for what the style leaves open and the user's pick as
//! `change` with its fields (`{ year, month, day, hour, minute }`).
//!
//! The values are wall-clock times: they become dates in the user's
//! calendar and time zone, which the picker shows them in, and its dates
//! come back as the same fields.

use std::{ptr::NonNull, rc::Rc};

use block2::RcBlock;
use nsh_core::JsonValue;
use objc2::{
    MainThreadMarker, MainThreadOnly, msg_send,
    rc::{Retained, Weak},
};
use objc2_core_foundation::{CGRect, CGSize};
use objc2_foundation::{NSCalendar, NSCalendarUnit, NSDate, NSDateComponents, NSString};
use objc2_ui_kit::{
    UIAccessibilityContainerType, UIAction, UIControlEvents, UIDatePicker, UIDatePickerMode,
    UIDatePickerStyle, UIView,
};

use crate::component::{ComponentContext, ComponentFactory, NativeComponent};

/// The picker's mode for a `mode` prop (`"date"` by default).
fn picker_mode(mode: Option<&str>) -> UIDatePickerMode {
    match mode {
        Some("time") => UIDatePickerMode::Time,
        Some("dateTime") => UIDatePickerMode::DateAndTime,
        _ => UIDatePickerMode::Date,
    }
}

/// The value's fields that are there: a day, a time of day or both.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Fields {
    date: Option<(isize, isize, isize)>,
    time: Option<(isize, isize)>,
}

/// The fields of a value prop (`{ year, month, day }`, `{ hour, minute }`
/// or all five); `None` for none.
fn parse_fields(value: Option<&JsonValue>) -> Option<Fields> {
    let value = value?.as_object()?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(JsonValue::as_i64)
            .map(|v| v as isize)
    };
    let date = (|| Some((field("year")?, field("month")?, field("day")?)))();
    let time = (|| Some((field("hour")?, field("minute")?)))();
    (date.is_some() || time.is_some()).then_some(Fields { date, time })
}

/// The date `fields` are in the user's calendar: a time of day falls on
/// today, a day alone at noon (midnight is missing on days a time zone
/// starts its summer time at it).
fn date_of(calendar: &NSCalendar, fields: Fields) -> Option<Retained<NSDate>> {
    let components = calendar.components_fromDate(
        NSCalendarUnit::Year | NSCalendarUnit::Month | NSCalendarUnit::Day,
        &NSDate::now(),
    );
    if let Some((year, month, day)) = fields.date {
        components.setYear(year);
        components.setMonth(month);
        components.setDay(day);
    }
    let (hour, minute) = fields.time.unwrap_or((12, 0));
    components.setHour(hour);
    components.setMinute(minute);
    calendar.dateFromComponents(&components)
}

/// The fields of `date` in the user's calendar.
fn fields_of(calendar: &NSCalendar, date: &NSDate) -> JsonValue {
    let c: Retained<NSDateComponents> = calendar.components_fromDate(
        NSCalendarUnit::Year
            | NSCalendarUnit::Month
            | NSCalendarUnit::Day
            | NSCalendarUnit::Hour
            | NSCalendarUnit::Minute,
        date,
    );
    serde_json::json!({
        "year": c.year(),
        "month": c.month(),
        "day": c.day(),
        "hour": c.hour(),
        "minute": c.minute(),
    })
}

struct SystemDateTimePicker {
    picker: Retained<UIDatePicker>,
    context: ComponentContext,
}

impl SystemDateTimePicker {
    fn date(&self, value: Option<&JsonValue>) -> Option<Retained<NSDate>> {
        date_of(&NSCalendar::currentCalendar(), parse_fields(value)?)
    }

    /// The picker's own size, for the dimensions the style leaves open: a
    /// compact picker's changes with its mode and with the value it shows.
    fn report_size(&self) {
        let size = self.picker.sizeThatFits(CGSize::new(0.0, 0.0));
        self.context.set_size(size.width as f32, size.height as f32);
    }
}

impl NativeComponent for SystemDateTimePicker {
    fn view(&self) -> &UIView {
        &self.picker
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "mode" => {
                self.picker
                    .setDatePickerMode(picker_mode(value.and_then(JsonValue::as_str)));
                self.report_size();
            }
            "value" => {
                // None shows the present, as a new picker does.
                let date = self.date(value).unwrap_or_else(NSDate::now);
                self.picker.setDate_animated(&date, false);
                self.report_size();
            }
            "min" => self.picker.setMinimumDate(self.date(value).as_deref()),
            "max" => self.picker.setMaximumDate(self.date(value).as_deref()),
            "minuteInterval" => {
                let interval = value.and_then(JsonValue::as_i64).unwrap_or(1);
                self.picker.setMinuteInterval(interval as isize);
            }
            "disabled" => {
                let disabled = value.and_then(JsonValue::as_bool).unwrap_or(false);
                self.picker.setEnabled(!disabled);
            }
            "accessibilityLabel" => {
                let label = value.and_then(JsonValue::as_str).map(NSString::from_str);
                // VoiceOver moves to the capsules inside a compact picker, so
                // the picker names them as a group, read as VoiceOver enters it.
                let group = if label.is_some() {
                    UIAccessibilityContainerType::SemanticGroup
                } else {
                    UIAccessibilityContainerType::None
                };
                // SAFETY: `accessibilityLabel` and `accessibilityContainerType`
                // are UIAccessibility's properties, which every NSObject has;
                // a nil label removes it.
                unsafe {
                    let () = msg_send![&*self.picker, setAccessibilityLabel: label.as_deref()];
                    let () = msg_send![&*self.picker, setAccessibilityContainerType: group];
                }
            }
            _ => {}
        }
    }
}

/// Makes the picker of each `DateTimePicker` element
/// (`nsh_core::platform::DATE_TIME_PICKER_COMPONENT`), which every surface
/// has (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm = MainThreadMarker::new().expect("the date picker is made on the main thread");
        let picker = UIDatePicker::initWithFrame(UIDatePicker::alloc(mtm), CGRect::default());
        picker.setPreferredDatePickerStyle(UIDatePickerStyle::Compact);
        picker.setDatePickerMode(UIDatePickerMode::Date);
        // The user's pick, read from the picker the action came from: a weak
        // reference, as the picker keeps the action and its block.
        let weak = Weak::from_retained(&picker);
        let emit = context.clone();
        let changed = RcBlock::new(move |_: NonNull<UIAction>| {
            if let Some(picker) = weak.load() {
                emit.emit(
                    "change",
                    fields_of(&NSCalendar::currentCalendar(), &picker.date()),
                );
                let size = picker.sizeThatFits(CGSize::new(0.0, 0.0));
                emit.set_size(size.width as f32, size.height as f32);
            }
        });
        // SAFETY: the handler is a block UIKit copies; it runs on the main
        // thread, as the picker's events do.
        let action = unsafe { UIAction::actionWithHandler(RcBlock::as_ptr(&changed), mtm) };
        picker.addAction_forControlEvents(&action, UIControlEvents::ValueChanged);
        let component = SystemDateTimePicker { picker, context };
        component.report_size();
        Box::new(component) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Fields, parse_fields};

    #[test]
    fn values_carry_the_fields_they_have() {
        assert_eq!(
            parse_fields(Some(&json!({ "year": 2026, "month": 11, "day": 17 }))),
            Some(Fields {
                date: Some((2026, 11, 17)),
                time: None,
            })
        );
        assert_eq!(
            parse_fields(Some(&json!({ "hour": 9, "minute": 30 }))),
            Some(Fields {
                date: None,
                time: Some((9, 30)),
            })
        );
        assert_eq!(parse_fields(Some(&json!(null))), None);
        assert_eq!(parse_fields(Some(&json!({ "hour": 9 }))), None);
        assert_eq!(parse_fields(None), None);
    }
}
