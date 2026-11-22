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

//! Native presentation policy shared by the two macOS permission-window hosts.

use nsh_platform_macos::{
    objc2::MainThreadOnly,
    objc2_app_kit::{NSFloatingWindowLevel, NSScreen, NSWindow},
    objc2_foundation::{NSPoint, NSRect, NSSize},
};

/// Only for a newly opened permission utility, never its parent workbench or a
/// same-key focus: the user may have moved an existing utility deliberately.
pub(crate) fn configure(window: &NSWindow) {
    window.setLevel(NSFloatingWindowLevel);
    if let Some(screen) = NSScreen::mainScreen(window.mtm()).or_else(|| window.screen()) {
        let visible = screen.visibleFrame();
        let size = window.frame().size;
        let size = NSSize::new(
            size.width.min(visible.size.width),
            size.height.min(visible.size.height),
        );
        window.setFrame_display(
            NSRect::new(
                NSPoint::new(
                    (visible.origin.x + visible.size.width - size.width - 16.0)
                        .max(visible.origin.x),
                    (visible.origin.y + visible.size.height - size.height - 16.0)
                        .max(visible.origin.y),
                ),
                size,
            ),
            false,
        );
    }
}
