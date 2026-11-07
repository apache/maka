/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
// A nonactivating panel can remain key while a different app handles a click.
use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSWorkspace, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSOperationQueue};
use std::{ptr::NonNull, rc::Rc};

pub(super) struct DismissObservers {
    clicks: Vec<Retained<AnyObject>>,
    center: Retained<NSNotificationCenter>,
    activation: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

impl DismissObservers {
    pub(super) fn new(panel_number: isize, dismiss: impl Fn() + 'static) -> Self {
        let dismiss = Rc::new(dismiss);
        let mask =
            NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;
        let outside = dismiss.clone();
        let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            mask,
            &RcBlock::new(move |_: NonNull<NSEvent>| outside()),
        );
        let other_window = dismiss.clone();
        // AppKit runs the monitors on the main thread. The local monitor passes the event through.
        let local = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                mask,
                &RcBlock::new(move |event: NonNull<NSEvent>| {
                    if event.as_ref().windowNumber() != panel_number {
                        other_window();
                    }
                    event.as_ptr()
                }),
            )
        };
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let activation = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &RcBlock::new(move |_| {
                    if NSWorkspace::sharedWorkspace()
                        .frontmostApplication()
                        .is_some_and(|app| app.processIdentifier() != std::process::id() as i32)
                    {
                        dismiss();
                    }
                }),
            )
        };
        Self {
            clicks: global.into_iter().chain(local).collect(),
            center,
            activation,
        }
    }
}

impl Drop for DismissObservers {
    fn drop(&mut self) {
        unsafe {
            for token in &self.clicks {
                NSEvent::removeMonitor(token);
            }
            self.center.removeObserver((*self.activation).as_ref());
        }
    }
}
