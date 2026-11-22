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

//! In-process native view capture, shared by terminal and development hosts.
use objc2::{AnyThread, rc::Retained};
use objc2_app_kit::{
    NSBitmapFormat, NSBitmapImageRep, NSColorSpace, NSDeviceRGBColorSpace, NSWindow,
};
use objc2_foundation::NSSize;

pub(crate) fn bitmap(
    window: &NSWindow,
    pixels: Option<(u32, u32)>,
) -> Result<Retained<NSBitmapImageRep>, String> {
    let view = window.contentView().ok_or("the window has no content")?;
    view.layoutSubtreeIfNeeded();
    if let Some(layer) = view.layer() {
        crate::surface::quiet(|| order_by_z(&layer));
    }
    let bounds = view.bounds();
    let rep = if let Some((width, height)) = pixels {
        // SAFETY: AppKit owns the interleaved premultiplied RGBA allocation; no external
        // planes are supplied, dimensions were bounded by FrameClock, and the color space
        // is retagged to sRGB before CoreGraphics creates its bitmap context.
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(), std::ptr::null_mut(), width as isize, height as isize,
                8, 4, true, false, NSDeviceRGBColorSpace, NSBitmapFormat::empty(),
                width as isize * 4, 32)
        };
        let rep = rep.ok_or("cannot allocate native RGBA bitmap")?;
        let rep = rep
            .bitmapImageRepByRetaggingWithColorSpace(&NSColorSpace::sRGBColorSpace())
            .ok_or("cannot tag native RGBA bitmap as sRGB")?;
        rep.setSize(NSSize::new(bounds.size.width, bounds.size.height));
        rep
    } else {
        view.bitmapImageRepForCachingDisplayInRect(bounds)
            .ok_or("cannot make a bitmap of the window")?
    };
    let hidden = crate::shader::hide_masked(window);
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
    hidden.iter().for_each(|view| view.setHidden(false));
    Ok(rep)
}

#[cfg(feature = "terminal")]
pub(crate) fn rgba(window: &NSWindow, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let rep = bitmap(window, Some((width, height)))?;
    let row_bytes = width as usize * 4;
    let stride = rep.bytesPerRow().max(0) as usize;
    if stride < row_bytes {
        return Err("native bitmap row stride is smaller than width".into());
    }
    // SAFETY: the retained bitmap owns `stride * height` premultiplied RGBA bytes,
    // allocated above, and AppKit drawing has completed on the main thread.
    let src = unsafe {
        let data = rep.bitmapData();
        if data.is_null() {
            return Err("native bitmap has no pixel storage".into());
        }
        std::slice::from_raw_parts(data, stride * height as usize)
    };
    let unpremultiply = |c: u8, a: u8| -> u8 {
        ((u16::from(c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8
    };
    let mut out = vec![0u8; row_bytes * height as usize];
    for y in 0..height as usize {
        let src_row = &src[y * stride..y * stride + row_bytes];
        let dst_row = &mut out[y * row_bytes..(y + 1) * row_bytes];
        for (s, d) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
            match s[3] {
                255 => d.copy_from_slice(s),
                0 => d.fill(0),
                a => {
                    d[0] = unpremultiply(s[0], a);
                    d[1] = unpremultiply(s[1], a);
                    d[2] = unpremultiply(s[2], a);
                    d[3] = a;
                }
            }
        }
    }
    Ok(out)
}

/// Orders the sublayers of `layer` and its sublayers by their `zPosition`
/// (keeping their order where it is equal), as Core Animation composites
/// them: `cacheDisplayInRect:` draws sublayers in their order and ignores
/// `zPosition`, so a decoration added before a layer it is above (a
/// border's stroke before a gradient) would look covered in the shot. The
/// window looks the same either way.
pub(crate) fn order_by_z(layer: &objc2_quartz_core::CALayer) {
    // SAFETY: the main thread reads the layer tree, which nothing else
    // changes meanwhile.
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let layers: Vec<Retained<objc2_quartz_core::CALayer>> = sublayers.to_vec();
    let sorted = layers
        .windows(2)
        .all(|w| w[0].zPosition() <= w[1].zPosition());
    if !sorted {
        let mut by_z = layers.clone();
        by_z.sort_by(|a, b| a.zPosition().total_cmp(&b.zPosition()));
        for (i, l) in by_z.iter().enumerate() {
            layer.insertSublayer_atIndex(l, i as u32);
        }
    }
    for l in &layers {
        order_by_z(l);
    }
}
