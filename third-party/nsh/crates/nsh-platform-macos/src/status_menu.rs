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

//! A process-owned menu-bar entry, independent of any NSH surface.

use std::rc::Rc;

use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
    runtime::AnyObject, sel,
};
use objc2_app_kit::{NSMenu, NSMenuItem, NSStatusBar, NSStatusItem, NSVariableStatusItemLength};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};

struct Actions {
    open: Rc<dyn Fn()>,
    quit: Rc<dyn Fn()>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshStatusMenuTarget"]
    #[ivars = Actions]
    struct Target;

    unsafe impl NSObjectProtocol for Target {}

    impl Target {
        // A callback may destroy its menu and target; keep the action alive.
        #[unsafe(method(open:))]
        fn open(&self, _sender: Option<&AnyObject>) {
            let action = self.ivars().open.clone();
            action();
        }

        #[unsafe(method(quit:))]
        fn quit(&self, _sender: Option<&AnyObject>) {
            let action = self.ivars().quit.clone();
            action();
        }
    }
);

/// Application-owned labels for a resident application's menu-bar entry.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct StatusMenuOptions {
    /// The menu-bar button's title.
    pub title: String,
    /// The menu command that opens or focuses the window.
    pub open_label: String,
    /// The menu command that exits the application.
    pub quit_label: String,
}

/// A native menu-bar entry with Open and Quit actions. Own it on the main
/// thread for the application's lifetime; dropping it removes the entry.
/// Callbacks run on the main thread and need not retain any window or engine.
pub struct StatusMenu {
    item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    // NSMenuItem does not retain its action target.
    _target: Retained<Target>,
}

impl StatusMenu {
    /// Installs a button and Open / Quit actions with application-owned labels.
    /// Must be called on AppKit's main thread, after creating NSApplication.
    pub fn new(
        options: StatusMenuOptions,
        open: impl Fn() + 'static,
        quit: impl Fn() + 'static,
    ) -> Self {
        let mtm = MainThreadMarker::new().expect("StatusMenu must be created on the main thread");
        let target = Target::alloc(mtm).set_ivars(Actions {
            open: Rc::new(open),
            quit: Rc::new(quit),
        });
        // SAFETY: NSObject's initializer, on our allocated main-thread subclass.
        let target: Retained<Target> = unsafe { msg_send![super(target), init] };
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
        if let Some(button) = item.button(mtm) {
            button.setTitle(&NSString::from_str(&options.title));
        }
        let menu = NSMenu::new(mtm);
        for (title, action) in [
            (options.open_label.as_str(), sel!(open:)),
            (options.quit_label.as_str(), sel!(quit:)),
        ] {
            // SAFETY: both selectors are defined on Target; the target is kept
            // alive until after the status item and its menu are removed.
            let entry = unsafe {
                let entry = NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &NSString::from_str(title),
                    Some(action),
                    &NSString::from_str(""),
                );
                entry.setTarget(Some(&target));
                entry
            };
            menu.addItem(&entry);
        }
        item.setMenu(Some(&menu));
        Self {
            item,
            menu,
            _target: target,
        }
    }
}

impl Drop for StatusMenu {
    fn drop(&mut self) {
        // A callback may release the menu while AppKit is still tracking it.
        for entry in self.menu.itemArray() {
            // SAFETY: detach the non-owning targets before releasing them.
            unsafe {
                entry.setTarget(None);
                entry.setAction(None);
            }
        }
        self.item.setMenu(None);
        NSStatusBar::systemStatusBar().removeStatusItem(&self.item);
    }
}
