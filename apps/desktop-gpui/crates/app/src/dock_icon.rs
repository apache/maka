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

//! The app icon on the macOS Dock (Maka Desktop's `app.dock.setIcon` in
//! apps/desktop/src/main/app-icon-surface.ts): the art Settings chose, as
//! `settings::DockIcon` resolves it for the appearance the app is in.
//!
//! Electron sets `NSApplication.applicationIconImage`, whose setter
//! objc2-app-kit exposes only as `unsafe` (its header does not promise to
//! accept nil), and this workspace forbids `unsafe`. The Dock tile's
//! content view is AppKit's other documented way to draw the tile, and its
//! calls are safe: the art goes in an image view that fills the tile. It
//! draws the Dock tile only; the app switcher (⌘Tab) keeps the bundle's
//! icon, where Desktop's call changes both. Like Desktop's, the choice
//! lasts while the app runs; the bundle's icon shows before launch.
//!
//! Elsewhere it does nothing: Desktop sets each window's icon on Windows
//! and Linux, which GPUI has no call for.

/// Draws `png` as the Dock tile. Must run on the main thread, as every
/// GPUI callback does; elsewhere it logs and does nothing.
#[cfg(target_os = "macos")]
pub fn set_dock_icon(png: &[u8]) {
    use objc2::{AllocAnyThread as _, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage, NSImageScaling, NSImageView, NSView};
    use objc2_foundation::{NSData, NSPoint, NSRect};

    let Some(main_thread) = MainThreadMarker::new() else {
        log::warn!("the Dock icon is set from the main thread only");
        return;
    };
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png)) else {
        log::warn!("the app icon's art does not decode");
        return;
    };
    let tile = NSApplication::sharedApplication(main_thread).dockTile();
    let view = NSImageView::imageViewWithImage(&image, main_thread);
    view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
    view.setFrame(NSRect::new(NSPoint::new(0., 0.), tile.size()));
    let view: &NSView = &view;
    tile.setContentView(Some(view));
    tile.display();
}

/// Does nothing: only macOS has a Dock.
#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon(_png: &[u8]) {}
