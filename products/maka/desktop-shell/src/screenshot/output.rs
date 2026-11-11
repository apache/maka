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

//! Where a finished picture goes: the pasteboard or a file.

use nsh_platform_macos::{
    objc2::{AllocAnyThread, rc::Retained},
    objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG,
        NSPasteboardTypeTIFF,
    },
    objc2_foundation::{NSData, NSDate, NSDateFormatter, NSDictionary, NSString, NSUserDefaults},
};
use objc2_core_graphics::CGImage;
use std::path::PathBuf;

pub(super) fn copy(image: &CGImage) -> Result<(), String> {
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
    let png = png(&rep)?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    // SAFETY: extern statics AppKit defines.
    unsafe {
        pasteboard.setData_forType(Some(&png), NSPasteboardTypePNG);
        if let Some(tiff) = rep.TIFFRepresentation() {
            pasteboard.setData_forType(Some(&tiff), NSPasteboardTypeTIFF);
        }
    }
    Ok(())
}

/// Saves a PNG where macOS puts its own screenshots, the desktop unless that was changed.
pub(super) fn save(image: &CGImage) -> Result<PathBuf, String> {
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
    let png = png(&rep)?;
    let folder = folder().ok_or("cannot find the screenshot folder")?;
    let formatter = NSDateFormatter::new();
    formatter.setDateFormat(Some(&NSString::from_str("yyyy-MM-dd HH.mm.ss")));
    let stamp = formatter.stringFromDate(&NSDate::now());
    let mut path = folder.join(format!("Maka {stamp}.png"));
    let mut copy = 2;
    while path.exists() {
        path = folder.join(format!("Maka {stamp} ({copy}).png"));
        copy += 1;
    }
    std::fs::write(&path, png.to_vec())
        .map_err(|error| format!("cannot save {}: {error}", path.display()))?;
    Ok(path)
}

fn png(rep: &NSBitmapImageRep) -> Result<Retained<NSData>, String> {
    // SAFETY: an empty property dictionary, which PNG encoding accepts.
    unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| "cannot encode the screenshot as PNG".into())
}

fn folder() -> Option<PathBuf> {
    let chosen = NSUserDefaults::initWithSuiteName(
        NSUserDefaults::alloc(),
        Some(&NSString::from_str("com.apple.screencapture")),
    )
    .and_then(|defaults| defaults.stringForKey(&NSString::from_str("location")))
    .map(|location| location.stringByExpandingTildeInPath().to_string())
    .map(PathBuf::from)
    .filter(|location| location.is_dir());
    chosen.or_else(|| std::env::home_dir().map(|home| home.join("Desktop")))
}
