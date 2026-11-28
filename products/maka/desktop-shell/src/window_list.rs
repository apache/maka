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

//! WindowServer geometry in global display points. Reading bounds requires no TCC grant.

use nsh_platform_macos::{
    objc2::{rc::Retained, runtime::AnyObject},
    objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString},
};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGWindowListCopyWindowInfo, CGWindowListOption};

/// A window as the window server lists it, in global points.
#[derive(Clone, Copy)]
pub(crate) struct Window {
    pub pid: i32,
    pub bounds: CGRect,
}

/// The on-screen windows of the normal level, front to back.
pub(crate) fn on_screen(owner: Option<i32>) -> Vec<Window> {
    let Some(list) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return Vec::new();
    };
    // SAFETY: CFArray is toll-free bridged to NSArray, and the window server's entries are
    // dictionaries with string keys; `list` outlives the borrow.
    let list: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*CFRetained::as_ptr(&list).as_ptr().cast() };
    let number = |info: &NSDictionary<NSString, AnyObject>, key: &str| {
        info.objectForKey(&NSString::from_str(key))?
            .downcast::<NSNumber>()
            .ok()
            .map(|number| number.doubleValue())
    };
    list.iter()
        .filter_map(|info| {
            if number(&info, "kCGWindowLayer")? != 0.0 || number(&info, "kCGWindowAlpha")? == 0.0 {
                return None;
            }
            let pid = number(&info, "kCGWindowOwnerPID")? as i32;
            if owner.is_some_and(|owner| owner != pid) {
                return None;
            }
            let bounds = info
                .objectForKey(&NSString::from_str("kCGWindowBounds"))?
                .downcast::<NSDictionary>()
                .ok()?;
            // SAFETY: the window server keys a window's bounds by string.
            let bounds: Retained<NSDictionary<NSString, AnyObject>> =
                unsafe { Retained::cast_unchecked(bounds) };
            Some(Window {
                pid,
                bounds: CGRect::new(
                    CGPoint::new(number(&bounds, "X")?, number(&bounds, "Y")?),
                    CGSize::new(number(&bounds, "Width")?, number(&bounds, "Height")?),
                ),
            })
        })
        .collect()
}
