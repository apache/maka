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

//! A latest-frame image preview over NSH's native image renderer.

use base64::Engine as _;
use nsh_core::{
    ResizeMode,
    element::ImageSrc,
    geometry::{DevicePixels, Size},
    image::Natural,
    prelude::*,
};

const MAX_FRAME_BYTES: usize = 8 << 20;
const MAX_FRAME_PIXELS: u64 = 16 << 20;

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct LiveImageFrame {
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Props)]
pub(crate) struct LiveImageProps {
    #[prop(default)]
    pub frame: Prop<Option<LiveImageFrame>>,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct LiveImageError {
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct LiveImageLoad {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Event)]
pub(crate) enum LiveImageEvent {
    #[args(event)]
    Load(LiveImageLoad),
    #[args(event)]
    Error(LiveImageError),
}

/// Setting `frame` to null clears the preview; unmounting disposes it.
/// This is a JPEG/PNG live image preview, not a video decoder.
#[component]
pub(crate) fn LiveImage(props: LiveImageProps, cx: Scope<LiveImageEvent>) -> impl IntoElement {
    let source = signal(None::<ImageSrc>);
    effect(move || {
        let next = props.frame.get().map(frame_source).transpose();
        match next {
            Ok(next) => source.set(next),
            Err(message) => {
                source.set(None);
                cx.emit(LiveImageEvent::Error(LiveImageError { message }));
            }
        }
    });
    // The caller keys the owner by immutable source generation. Within it,
    // Load means a valid frame decoded, not necessarily the latest frame.
    image(move || source.get().unwrap_or_else(|| ImageSrc::from("")))
        .size_full()
        .object_fit(ResizeMode::Contain)
        .fade_duration(0.0)
        .retain_previous(true)
        .on_load(move |size: &Size<DevicePixels>| {
            if source.get().is_some() {
                cx.emit(LiveImageEvent::Load(LiveImageLoad {
                    width: size.width.0 as u32,
                    height: size.height.0 as u32,
                }));
            }
        })
        .on_error(move |message: &str| {
            cx.emit(LiveImageEvent::Error(LiveImageError {
                message: message.to_owned(),
            }));
        })
}

fn frame_source(frame: LiveImageFrame) -> Result<ImageSrc, String> {
    if frame.width == 0
        || frame.height == 0
        || frame.width > 8192
        || frame.height > 8192
        || u64::from(frame.width) * u64::from(frame.height) > MAX_FRAME_PIXELS
    {
        return Err("live image frame dimensions exceed the preview limit".into());
    }
    if frame.data_base64.len() > MAX_FRAME_BYTES.div_ceil(3) * 4 {
        return Err("live image frame exceeds 8 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&frame.data_base64)
        .map_err(|e| format!("invalid live image base64: {e}"))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("live image frame exceeds 8 MiB".into());
    }
    match frame.mime_type.as_str() {
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => {}
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {
            // APNG would multiply the decoded memory by its frame count.
            let mut rest = &bytes[8..];
            while !rest.is_empty() {
                if rest.len() < 12 {
                    return Err("truncated live PNG chunk".into());
                }
                let len = u32::from_be_bytes(rest[..4].try_into().expect("four bytes")) as usize;
                if &rest[4..8] == b"acTL" {
                    return Err("animated PNG is not a live image frame".into());
                }
                let end = len
                    .checked_add(12)
                    .filter(|end| *end <= rest.len())
                    .ok_or("truncated live PNG chunk")?;
                rest = &rest[end..];
            }
        }
        _ => {
            return Err("live image frame must contain JPEG or PNG bytes matching mimeType".into());
        }
    }
    if Natural::of(&bytes) != Some(Natural::Pixels(frame.width, frame.height)) {
        return Err("live image dimensions do not match its encoded header".into());
    }
    Ok(ImageSrc::live_frame(&frame.mime_type, bytes.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_core::{MountBatch, MountItem, element::Root};
    use nsh_engine::EngineConfig;
    use nsh_testing::Headless;
    use std::sync::{Arc, Mutex};

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

    fn png() -> LiveImageFrame {
        LiveImageFrame {
            mime_type: "image/png".into(),
            data_base64: PNG.into(),
            width: 1,
            height: 1,
        }
    }

    // A baseline grayscale JPEG: one quantization table, one-symbol DC/AC
    // Huffman tables, and a single neutral 1x1 block.
    fn jpeg() -> LiveImageFrame {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xdb, 0, 67, 0];
        bytes.extend([1; 64]);
        bytes.extend([0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
        bytes.extend([0xff, 0xc4, 0, 38, 0, 1]);
        bytes.extend([0; 15]);
        bytes.extend([0, 0x10, 1]);
        bytes.extend([0; 15]);
        bytes.extend([0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9]);
        LiveImageFrame {
            mime_type: "image/jpeg".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            width: 1,
            height: 1,
        }
    }

    #[test]
    fn rejects_invalid_dimensions_before_allocating_a_frame() {
        for (width, height) in [(0, 1), (1, 0), (8193, 1), (1, 8193), (8192, 8192)] {
            let mut frame = png();
            frame.width = width;
            frame.height = height;
            assert_eq!(
                frame_source(frame).unwrap_err(),
                "live image frame dimensions exceed the preview limit"
            );
        }
    }

    #[test]
    fn rejects_invalid_base64_mime_and_header_mismatch() {
        let mut frame = png();
        frame.data_base64 = "%%%".into();
        assert!(
            frame_source(frame)
                .unwrap_err()
                .starts_with("invalid live image base64:")
        );
        for mime in ["image/gif", "image/jpeg"] {
            let mut frame = png();
            frame.mime_type = mime.into();
            assert_eq!(
                frame_source(frame).unwrap_err(),
                "live image frame must contain JPEG or PNG bytes matching mimeType"
            );
        }
        let mut frame = png();
        frame.width = 2;
        assert_eq!(
            frame_source(frame).unwrap_err(),
            "live image dimensions do not match its encoded header"
        );
        let mut frame = jpeg();
        frame.data_base64 = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff]);
        assert_eq!(
            frame_source(frame).unwrap_err(),
            "live image dimensions do not match its encoded header"
        );
    }

    #[test]
    fn rejects_oversized_encoded_frames_and_animated_png() {
        let mut frame = png();
        frame.data_base64 = "A".repeat(MAX_FRAME_BYTES.div_ceil(3) * 4 + 1);
        assert_eq!(
            frame_source(frame).unwrap_err(),
            "live image frame exceeds 8 MiB"
        );
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .unwrap();
        bytes.splice(
            33..33,
            [
                0, 0, 0, 8, b'a', b'c', b'T', b'L', 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
        );
        let mut frame = png();
        frame.data_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            frame_source(frame).unwrap_err(),
            "animated PNG is not a live image frame"
        );
    }

    #[component]
    fn FrameHarness() -> impl IntoElement {
        let frame = signal(Some(png()));
        let shown = signal(true);
        let loaded = signal(None::<LiveImageLoad>);
        let error = signal(String::new());
        view()
            .child(view().h(px(60.0)).child(when(
                move || shown.get(),
                move || {
                    live_image()
                        .frame(move || frame.get())
                        .on_load(move |event: &LiveImageLoad| loaded.set(Some(event.clone())))
                        .on_error(move |event: &LiveImageError| error.set(event.message.clone()))
                },
            )))
            .child(
                view()
                    .on_press(move || {
                        frame.set(None);
                        loaded.set(None);
                    })
                    .child(text("Clear")),
            )
            .child(
                view()
                    .on_press(move || {
                        frame.set(Some(jpeg()));
                        loaded.set(None);
                    })
                    .child(text("JPEG")),
            )
            .child(
                view()
                    .on_press(move || {
                        let mut invalid = png();
                        invalid.width = 0;
                        frame.set(Some(invalid));
                        loaded.set(None);
                    })
                    .child(text("Invalid")),
            )
            .child(text(move || error.get()))
            .child(text(move || {
                loaded.get().map_or_else(
                    || "pending".to_owned(),
                    |event| format!("loaded {}x{}", event.width, event.height),
                )
            }))
            .child(
                view()
                    .on_press(move || {
                        shown.set(false);
                        loaded.set(None);
                    })
                    .child(text("Unmount")),
            )
    }

    #[test]
    fn valid_frames_mount_native_bytes_and_clear_and_unmount_reach_the_renderer() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<FrameHarness>())).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        app.observe(move |_: &str, batch: &MountBatch| {
            // Keep no source or ImageData alive in the observer.
            for item in &batch.items {
                match item {
                    MountItem::Image {
                        id,
                        source,
                        resize_mode,
                        ..
                    } => {
                        let bytes = source
                            .as_ref()
                            .and_then(|s| s.data.as_ref())
                            .map(|b| b.bytes().to_vec());
                        observed
                            .lock()
                            .unwrap()
                            .push((*id, bytes, Some(*resize_mode)));
                    }
                    MountItem::Delete { id } => observed.lock().unwrap().push((*id, None, None)),
                    _ => {}
                }
            }
        });
        app.first_render().unwrap();
        let (id, bytes, fit) = seen
            .lock()
            .unwrap()
            .iter()
            .find(|(_, b, _)| b.is_some())
            .cloned()
            .unwrap();
        assert_eq!(
            bytes.unwrap(),
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap()
        );
        assert_eq!(fit, Some(ResizeMode::Contain));
        assert!(app.shows("pending"), "accepting encoded bytes is not ready");
        app.engine().control().dispatch_event(
            id,
            nsh_core::EventKind::Load,
            nsh_core::EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(7),
                DevicePixels(9),
            )),
        );
        app.wait_for("loaded 7x9").unwrap();
        seen.lock().unwrap().clear();
        app.press("Clear").unwrap();
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(node, bytes, mode)| *node == id && bytes.is_none() && mode.is_some())
        );
        app.engine().control().dispatch_event(
            id,
            nsh_core::EventKind::Load,
            nsh_core::EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(7),
                DevicePixels(9),
            )),
        );
        assert!(app.settle());
        assert!(app.shows("pending"));
        assert!(!app.shows("loaded 7x9"));
        seen.lock().unwrap().clear();
        app.press("JPEG").unwrap();
        let expected = base64::engine::general_purpose::STANDARD
            .decode(jpeg().data_base64)
            .unwrap();
        let jpeg_id = seen
            .lock()
            .unwrap()
            .iter()
            .find(|(_, bytes, _)| bytes.as_deref() == Some(expected.as_slice()))
            .map(|(node, _, _)| *node)
            .unwrap();
        assert_eq!(jpeg_id, id, "new frames must reuse the native image node");
        assert!(app.shows("pending"), "encoded replacement is not ready");
        app.engine().control().dispatch_event(
            jpeg_id,
            nsh_core::EventKind::Load,
            nsh_core::EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(1),
                DevicePixels(1),
            )),
        );
        app.wait_for("loaded 1x1").unwrap();
        app.press("Invalid").unwrap();
        app.wait_for("live image frame dimensions exceed the preview limit")
            .unwrap();
        app.engine().control().dispatch_event(
            id,
            nsh_core::EventKind::Load,
            nsh_core::EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(1),
                DevicePixels(1),
            )),
        );
        assert!(app.settle());
        assert!(app.shows("pending"));
        app.press("JPEG").unwrap();
        seen.lock().unwrap().clear();
        app.press("Unmount").unwrap();
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(node, bytes, mode)| *node == jpeg_id && bytes.is_none() && mode.is_none())
        );
        app.engine().control().dispatch_event(
            id,
            nsh_core::EventKind::Load,
            nsh_core::EventPayload::Image(nsh_core::geometry::size(
                DevicePixels(1),
                DevicePixels(1),
            )),
        );
        assert!(app.settle());
        assert!(app.shows("pending"));
    }
}
