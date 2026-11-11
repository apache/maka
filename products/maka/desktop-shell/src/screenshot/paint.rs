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

//! Drawing marks, on the stage and into the picture that is copied, saved or pinned.

use super::{
    annotate::{Mark, Shape},
    area::{Area, Pixel},
};
use nsh_platform_macos::{
    objc2::{AllocAnyThread, rc::Retained, runtime::AnyObject},
    objc2_app_kit::{
        NSBezierPath, NSColor, NSCompositingOperation, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSGraphicsContext, NSImage, NSImageInterpolation,
        NSLineCapStyle, NSLineJoinStyle, NSStringDrawing,
    },
    objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString},
};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage,
    CGImageAlphaInfo, CGInterpolationQuality, kCGColorSpaceSRGB,
};

/// Where marks land: picture pixels from `origin`, `zoom` drawing units each.
pub(super) struct Canvas<'a> {
    pub picture: &'a CGImage,
    pub whole: Area,
    pub origin: Pixel,
    pub zoom: f64,
}

impl Canvas<'_> {
    /// The middle of a pixel.
    fn point(&self, (x, y): Pixel) -> NSPoint {
        NSPoint::new(
            ((x - self.origin.0) as f64 + 0.5) * self.zoom,
            ((y - self.origin.1) as f64 + 0.5) * self.zoom,
        )
    }

    pub fn rect(&self, area: Area) -> NSRect {
        NSRect::new(
            NSPoint::new(
                (area.x - self.origin.0) as f64 * self.zoom,
                (area.y - self.origin.1) as f64 * self.zoom,
            ),
            NSSize::new(
                area.width as f64 * self.zoom,
                area.height as f64 * self.zoom,
            ),
        )
    }

    /// Draws `area` of the picture, as it is under the marks.
    pub fn picture(&self, area: Area) {
        if let Some(part) = CGImage::with_image_in_rect(Some(self.picture), cg_rect(area)) {
            draw_image(&part, area, self.rect(area), NSImageInterpolation::Default);
        }
    }

    pub fn paint(&self, mark: &Mark) {
        let [r, g, b] = mark.ink.color;
        let color = NSColor::colorWithSRGBRed_green_blue_alpha(
            r as f64 / 255.0,
            g as f64 / 255.0,
            b as f64 / 255.0,
            1.0,
        );
        let pixels = |points: f64| points * mark.ink.scale * self.zoom;
        let width = pixels(mark.ink.size.stroke());
        let font = pixels(mark.ink.size.font());
        match &mark.shape {
            Shape::Rectangle(area) => {
                let path = NSBezierPath::bezierPathWithRect(inset(self.rect(*area), width / 2.0));
                stroke(&path, &color, width);
            }
            Shape::Ellipse(area) => {
                let path =
                    NSBezierPath::bezierPathWithOvalInRect(inset(self.rect(*area), width / 2.0));
                stroke(&path, &color, width);
            }
            Shape::Arrow(from, to) => self.arrow(*from, *to, &color, width),
            Shape::Pen(points) => stroke(&self.line(points), &color, width),
            Shape::Marker(points) => {
                let translucent = color.colorWithAlphaComponent(0.4);
                stroke(&self.line(points), &translucent, width * 4.0);
            }
            Shape::Text { at, text } => {
                let corner = self.rect(Area::spanning(*at, *at)).origin;
                draw_text(text, corner, NSFont::systemFontOfSize(font), &color);
            }
            Shape::Mosaic(area) => self.mosaic(*area, mark.ink.scale),
            Shape::Number { at, number } => {
                let center = self.point(*at);
                let side = font * 1.4;
                color.setFill();
                NSBezierPath::bezierPathWithOvalInRect(NSRect::new(
                    NSPoint::new(center.x - side / 2.0, center.y - side / 2.0),
                    NSSize::new(side, side),
                ))
                .fill();
                let text = number.to_string();
                let label = NSFont::boldSystemFontOfSize(font * 0.8);
                let size = text_size(&text, &label);
                draw_text(
                    &text,
                    NSPoint::new(center.x - size.width / 2.0, center.y - size.height / 2.0),
                    label,
                    &NSColor::whiteColor(),
                );
            }
        }
    }

    fn line(&self, points: &[Pixel]) -> Retained<NSBezierPath> {
        let path = NSBezierPath::bezierPath();
        let mut points = points.iter().map(|point| self.point(*point));
        if let Some(first) = points.next() {
            path.moveToPoint(first);
            path.lineToPoint(first);
        }
        for point in points {
            path.lineToPoint(point);
        }
        path
    }

    fn arrow(&self, from: Pixel, to: Pixel, color: &NSColor, width: f64) {
        let (a, b) = (self.point(from), self.point(to));
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let length = dx.hypot(dy);
        if length < 1.0 {
            return;
        }
        let (ux, uy) = (dx / length, dy / length);
        let head = (width * 4.0).max(10.0 * self.zoom).min(length);
        let base = NSPoint::new(b.x - ux * head, b.y - uy * head);
        let shaft = NSBezierPath::bezierPath();
        shaft.moveToPoint(a);
        shaft.lineToPoint(NSPoint::new(b.x - ux * head * 0.5, b.y - uy * head * 0.5));
        stroke(&shaft, color, width);
        let tip = NSBezierPath::bezierPath();
        let half = head * 0.45;
        tip.moveToPoint(b);
        tip.lineToPoint(NSPoint::new(base.x - uy * half, base.y + ux * half));
        tip.lineToPoint(NSPoint::new(base.x + uy * half, base.y - ux * half));
        tip.closePath();
        color.setFill();
        tip.fill();
    }

    fn mosaic(&self, area: Area, scale: f64) {
        let Some(area) = area.intersection(self.whole) else {
            return;
        };
        let block = (10.0 * scale).round().max(2.0) as i64;
        let Some(part) = CGImage::with_image_in_rect(Some(self.picture), cg_rect(area)) else {
            return;
        };
        let columns = ((area.width + block - 1) / block) as usize;
        let rows = ((area.height + block - 1) / block) as usize;
        let Some(context) = bitmap(columns, rows, self.picture) else {
            return;
        };
        CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::Medium);
        let all = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(columns as f64, rows as f64),
        );
        CGContext::draw_image(Some(&context), all, Some(&part));
        if let Some(blocks) = CGBitmapContextCreateImage(Some(&context)) {
            draw_image(&blocks, area, self.rect(area), NSImageInterpolation::None);
        }
    }
}

/// The selection of the picture with the marks on it.
pub(super) fn render(
    picture: &CGImage,
    whole: Area,
    area: Area,
    marks: &[Mark],
) -> Option<CFRetained<CGImage>> {
    let context = bitmap(area.width as usize, area.height as usize, picture)?;
    // AppKit draws top-down, as on the stage.
    CGContext::translate_ctm(Some(&context), 0.0, area.height as f64);
    CGContext::scale_ctm(Some(&context), 1.0, -1.0);
    let graphics = NSGraphicsContext::graphicsContextWithCGContext_flipped(&context, true);
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&graphics));
    let canvas = Canvas {
        picture,
        whole,
        origin: (area.x, area.y),
        zoom: 1.0,
    };
    canvas.picture(area);
    for mark in marks {
        canvas.paint(mark);
    }
    NSGraphicsContext::restoreGraphicsState_class();
    CGBitmapContextCreateImage(Some(&context))
}

/// A blank bitmap in the picture's colors, or sRGB when those cannot back one.
fn bitmap(width: usize, height: usize, picture: &CGImage) -> Option<CFRetained<CGContext>> {
    let premultiplied = CGImageAlphaInfo::PremultipliedLast.0;
    let create = |space: &CGColorSpace| {
        // SAFETY: no data pointer, so Core Graphics allocates the bitmap.
        unsafe {
            CGBitmapContextCreate(
                std::ptr::null_mut(),
                width.max(1),
                height.max(1),
                8,
                0,
                Some(space),
                premultiplied,
            )
        }
    };
    CGImage::color_space(Some(picture))
        .and_then(|space| create(&space))
        .or_else(|| {
            // SAFETY: an extern static Core Graphics defines.
            CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
                .and_then(|space| create(&space))
        })
}

fn cg_rect(area: Area) -> CGRect {
    CGRect::new(
        CGPoint::new(area.x as f64, area.y as f64),
        CGSize::new(area.width as f64, area.height as f64),
    )
}

fn draw_image(image: &CGImage, area: Area, into: NSRect, interpolation: NSImageInterpolation) {
    let size = NSSize::new(area.width as f64, area.height as f64);
    let image = NSImage::initWithCGImage_size(NSImage::alloc(), image, size);
    if let Some(context) = NSGraphicsContext::currentContext() {
        context.setImageInterpolation(interpolation);
    }
    // SAFETY: no hints dictionary.
    unsafe {
        image.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
            into,
            NSRect::ZERO,
            NSCompositingOperation::SourceOver,
            1.0,
            true,
            None,
        );
    }
}

fn stroke(path: &NSBezierPath, color: &NSColor, width: f64) {
    color.setStroke();
    path.setLineWidth(width);
    path.setLineCapStyle(NSLineCapStyle::Round);
    path.setLineJoinStyle(NSLineJoinStyle::Round);
    path.stroke();
}

fn attributes(
    font: Retained<NSFont>,
    color: &NSColor,
) -> Retained<NSDictionary<NSString, AnyObject>> {
    // SAFETY: extern statics AppKit defines.
    let keys = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
    NSDictionary::from_slices(&keys, &[&**font as &AnyObject, color as &AnyObject])
}

fn text_size(text: &str, font: &Retained<NSFont>) -> NSSize {
    let attributes = attributes(font.clone(), &NSColor::whiteColor());
    // SAFETY: string-keyed attributes with an NSFont and an NSColor.
    unsafe { NSString::from_str(text).sizeWithAttributes(Some(&attributes)) }
}

fn draw_text(text: &str, at: NSPoint, font: Retained<NSFont>, color: &NSColor) {
    let attributes = attributes(font, color);
    // SAFETY: as above.
    unsafe { NSString::from_str(text).drawAtPoint_withAttributes(at, Some(&attributes)) };
}

pub(super) fn inset(rect: NSRect, by: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.origin.x + by, rect.origin.y + by),
        NSSize::new(
            (rect.size.width - 2.0 * by).max(0.0),
            (rect.size.height - 2.0 * by).max(0.0),
        ),
    )
}
