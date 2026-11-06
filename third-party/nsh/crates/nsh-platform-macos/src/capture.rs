//! In-process native view capture, shared by terminal and development hosts.
use objc2::{AnyThread, rc::Retained};
use objc2_app_kit::{NSBitmapFormat, NSBitmapImageRep, NSDeviceRGBColorSpace, NSWindow};
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
        // SAFETY: AppKit owns the interleaved RGBA allocation; no external planes
        // are supplied, dimensions were bounded by FrameClock, and the color space is immutable.
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(), std::ptr::null_mut(), width as isize, height as isize,
                8, 4, true, false, NSDeviceRGBColorSpace, NSBitmapFormat::AlphaNonpremultiplied,
                width as isize * 4, 32)
        };
        let rep = rep.ok_or("cannot allocate native RGBA bitmap")?;
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
    // SAFETY: the retained bitmap owns width * height tightly packed RGBA bytes,
    // allocated above, and AppKit drawing has completed on the main thread.
    unsafe {
        let data = rep.bitmapData();
        if data.is_null() {
            return Err("native bitmap has no pixel storage".into());
        }
        Ok(std::slice::from_raw_parts(data, width as usize * height as usize * 4).to_vec())
    }
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
