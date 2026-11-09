/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// A nonactivating panel can remain key while a different app handles a click.
use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask};
use std::{ptr::NonNull, rc::Rc};

pub(super) struct DismissObservers {
    clicks: Vec<Retained<AnyObject>>,
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
        // Window deactivation is observed by the panel itself. A workspace notification
        // can still report the previous application while the panel is becoming key.
        Self {
            clicks: global.into_iter().chain(local).collect(),
        }
    }
}

impl Drop for DismissObservers {
    fn drop(&mut self) {
        unsafe {
            for token in &self.clicks {
                NSEvent::removeMonitor(token);
            }
        }
    }
}
