//! `Haptics` of `nsh/mobile` on iOS: UIKit's feedback generators, kept for
//! the surface (on its [`crate::target::EventTarget`]) and prepared as
//! interactions start, so a haptic comes right as the app asks for it.
//! Devices without a Taptic Engine, or with system haptics off, play nothing.

use std::cell::RefCell;

use nsh_core::{Haptic, HapticImpact, HapticNotification};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_ui_kit::{
    UIFeedbackGenerator, UIImpactFeedbackGenerator, UIImpactFeedbackStyle,
    UINotificationFeedbackGenerator, UINotificationFeedbackType, UISelectionFeedbackGenerator,
};

/// The impact styles, in the order of [`Generators::impacts`].
const IMPACT_STYLES: [UIImpactFeedbackStyle; 5] = [
    UIImpactFeedbackStyle::Light,
    UIImpactFeedbackStyle::Medium,
    UIImpactFeedbackStyle::Heavy,
    UIImpactFeedbackStyle::Soft,
    UIImpactFeedbackStyle::Rigid,
];

#[derive(Default)]
struct Generators {
    selection: Option<Retained<UISelectionFeedbackGenerator>>,
    impacts: [Option<Retained<UIImpactFeedbackGenerator>>; IMPACT_STYLES.len()],
    notification: Option<Retained<UINotificationFeedbackGenerator>>,
}

/// The feedback generators of a surface.
#[derive(Default)]
pub(crate) struct Haptics {
    generators: RefCell<Generators>,
}

impl Haptics {
    /// Plays `haptic` now, creating its generator the first time.
    // `initWithStyle:` is deprecated from iOS 17.5 for `feedbackGeneratorForView:`,
    // which iOS 15 lacks.
    #[allow(deprecated)]
    pub(crate) fn play(&self, haptic: Haptic, mtm: MainThreadMarker) {
        let mut generators = self.generators.borrow_mut();
        let impact = |generators: &mut Generators, index: usize| {
            let generator = generators.impacts[index].get_or_insert_with(|| {
                UIImpactFeedbackGenerator::initWithStyle(mtm.alloc(), IMPACT_STYLES[index])
            });
            generator.impactOccurred();
        };
        let notification = |generators: &mut Generators, kind| {
            generators
                .notification
                .get_or_insert_with(|| UINotificationFeedbackGenerator::new(mtm))
                .notificationOccurred(kind);
        };
        match haptic {
            Haptic::Selection => generators
                .selection
                .get_or_insert_with(|| UISelectionFeedbackGenerator::new(mtm))
                .selectionChanged(),
            Haptic::Impact(HapticImpact::Light) => impact(&mut generators, 0),
            Haptic::Impact(HapticImpact::Medium) => impact(&mut generators, 1),
            Haptic::Impact(HapticImpact::Heavy) => impact(&mut generators, 2),
            Haptic::Impact(HapticImpact::Soft) => impact(&mut generators, 3),
            Haptic::Impact(HapticImpact::Rigid) => impact(&mut generators, 4),
            Haptic::Notification(HapticNotification::Success) => {
                notification(&mut generators, UINotificationFeedbackType::Success)
            }
            Haptic::Notification(HapticNotification::Warning) => {
                notification(&mut generators, UINotificationFeedbackType::Warning)
            }
            Haptic::Notification(HapticNotification::Error) => {
                notification(&mut generators, UINotificationFeedbackType::Error)
            }
            // `Haptic`, `HapticImpact` and `HapticNotification` are non-exhaustive.
            _ => {}
        }
    }

    /// An interaction started: prepares the generators played before, so a
    /// haptic it plays comes at once. UIKit keeps a generator prepared for a
    /// few seconds, then lets the Taptic Engine idle again.
    pub(crate) fn prepare(&self) {
        let generators = self.generators.borrow();
        let all = generators
            .selection
            .iter()
            .map(|g| -> &UIFeedbackGenerator { g })
            .chain(
                generators
                    .impacts
                    .iter()
                    .flatten()
                    .map(|g| -> &UIFeedbackGenerator { g }),
            )
            .chain(
                generators
                    .notification
                    .iter()
                    .map(|g| -> &UIFeedbackGenerator { g }),
            );
        for generator in all {
            generator.prepare();
        }
    }
}
