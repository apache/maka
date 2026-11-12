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

//! The controls in the frozen windows, read through Accessibility, which Maka may not be allowed
//! to use.

use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use std::{
    ffi::{c_char, c_void},
    time::{Duration, Instant},
};

/// A window as the window server lists it, in global points.
#[derive(Clone, Copy)]
pub(super) struct Source {
    pub pid: i32,
    pub bounds: CGRect,
}

/// Points a control must span on each side to be a target.
const SMALLEST: f64 = 6.0;
/// Bounds on one window's walk: some apps (browsers) have tens of thousands of nodes.
const MOST_PER_WINDOW: usize = 4000;
const DEEPEST: usize = 40;
const BUDGET: Duration = Duration::from_millis(1500);

pub(super) fn trusted() -> bool {
    // SAFETY: no arguments.
    unsafe { AXIsProcessTrusted() }
}

/// Asks macOS to list Maka under Accessibility, with its prompt to open the settings.
pub(super) fn request() {
    let key = Cf::string("AXTrustedCheckOptionPrompt");
    // SAFETY: a one-entry dictionary of CF objects, retained by the dictionary for the call.
    unsafe {
        let keys = [key.0];
        let values = [kCFBooleanTrue];
        let options = Cf(CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        ));
        AXIsProcessTrustedWithOptions(options.0);
    }
}

/// The controls of each of `windows`, in global points; none for a window Accessibility cannot
/// read. Blocks on the apps' answers, so it runs off the main thread.
pub(super) fn scan(windows: &[Source]) -> Vec<Vec<CGRect>> {
    let mut found = vec![Vec::new(); windows.len()];
    let deadline = Instant::now() + BUDGET;
    let attributes = Attributes::new();
    // SAFETY: a fresh system-wide element; the timeout bounds every request this process makes.
    unsafe {
        let system = Cf(AXUIElementCreateSystemWide());
        AXUIElementSetMessagingTimeout(system.0, 0.25);
    }
    let mut pids: Vec<i32> = windows.iter().map(|window| window.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    for pid in pids {
        // SAFETY: an application element for a pid, owned here.
        let application = Cf(unsafe { AXUIElementCreateApplication(pid) });
        let Some(list) = application.copy(&attributes.windows) else {
            continue;
        };
        for window in list.items() {
            let Some(frame) = frame(window, &attributes) else {
                continue;
            };
            let matching = windows
                .iter()
                .position(|source| source.pid == pid && close(source.bounds, frame));
            if let Some(index) = matching
                && found[index].is_empty()
            {
                walk(window, &attributes, 0, deadline, &mut found[index]);
            }
            if Instant::now() >= deadline {
                return found;
            }
        }
    }
    found
}

fn walk(
    element: CfRef,
    attributes: &Attributes,
    depth: usize,
    deadline: Instant,
    out: &mut Vec<CGRect>,
) {
    if depth > DEEPEST || out.len() >= MOST_PER_WINDOW || Instant::now() >= deadline {
        return;
    }
    let Some(children) = Cf::borrowed(element).copy(&attributes.children) else {
        return;
    };
    for child in children.items() {
        if let Some(frame) = frame(child, attributes)
            && frame.size.width >= SMALLEST
            && frame.size.height >= SMALLEST
        {
            out.push(frame);
        }
        walk(child, attributes, depth + 1, deadline, out);
    }
}

fn frame(element: CfRef, attributes: &Attributes) -> Option<CGRect> {
    let element = Cf::borrowed(element);
    let mut origin = CGPoint::new(0.0, 0.0);
    let mut size = CGSize::new(0.0, 0.0);
    let position = element.copy(&attributes.position)?;
    let extent = element.copy(&attributes.size)?;
    // SAFETY: AXValues read into the struct their type names; a mismatch returns false.
    let read = unsafe {
        AXValueGetValue(position.0, AX_VALUE_CG_POINT, (&raw mut origin).cast())
            && AXValueGetValue(extent.0, AX_VALUE_CG_SIZE, (&raw mut size).cast())
    };
    read.then(|| CGRect::new(origin, size))
}

fn close(a: CGRect, b: CGRect) -> bool {
    let near = |a: f64, b: f64| (a - b).abs() <= 1.0;
    near(a.origin.x, b.origin.x)
        && near(a.origin.y, b.origin.y)
        && near(a.size.width, b.size.width)
        && near(a.size.height, b.size.height)
}

struct Attributes {
    windows: Cf,
    children: Cf,
    position: Cf,
    size: Cf,
}

impl Attributes {
    fn new() -> Self {
        Self {
            windows: Cf::string("AXWindows"),
            children: Cf::string("AXChildren"),
            position: Cf::string("AXPosition"),
            size: Cf::string("AXSize"),
        }
    }
}

type CfRef = *const c_void;

/// An owned Core Foundation object, released when dropped; null when a call returned nothing.
struct Cf(CfRef);

impl Cf {
    /// `element` retained for as long as this lives.
    fn borrowed(element: CfRef) -> Self {
        // SAFETY: `element` is a live CF object a caller holds.
        Self(unsafe { CFRetain(element) })
    }

    fn string(text: &str) -> Self {
        let text = std::ffi::CString::new(text).expect("attribute names have no NUL");
        // SAFETY: a NUL-terminated UTF-8 string.
        Self(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
    }

    /// The element's `attribute`, if it has one.
    fn copy(&self, attribute: &Cf) -> Option<Cf> {
        let mut value: CfRef = std::ptr::null();
        // SAFETY: an AXUIElement and a CFString; the value comes back retained.
        let error = unsafe { AXUIElementCopyAttributeValue(self.0, attribute.0, &mut value) };
        (error == 0 && !value.is_null()).then_some(Cf(value))
    }

    /// The items of an array, alive while the array is.
    fn items(&self) -> impl Iterator<Item = CfRef> + '_ {
        // SAFETY: Accessibility returns arrays for the list attributes read here.
        let count = unsafe { CFArrayGetCount(self.0) };
        // SAFETY: indexes within the count.
        (0..count).map(|index| unsafe { CFArrayGetValueAtIndex(self.0, index) })
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a reference this value owns.
            unsafe { CFRelease(self.0) };
        }
    }
}

const UTF8: u32 = 0x0800_0100;
const AX_VALUE_CG_POINT: u32 = 1;
const AX_VALUE_CG_SIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CfRef) -> bool;
    fn AXUIElementCreateSystemWide() -> CfRef;
    fn AXUIElementCreateApplication(pid: i32) -> CfRef;
    fn AXUIElementSetMessagingTimeout(element: CfRef, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: CfRef, attribute: CfRef, value: *mut CfRef) -> i32;
    fn AXValueGetValue(value: CfRef, kind: u32, out: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: CfRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFRetain(object: CfRef) -> CfRef;
    fn CFRelease(object: CfRef);
    fn CFArrayGetCount(array: CfRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
    fn CFStringCreateWithCString(allocator: CfRef, text: *const c_char, encoding: u32) -> CfRef;
    fn CFDictionaryCreate(
        allocator: CfRef,
        keys: *const CfRef,
        values: *const CfRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CfRef;
}
