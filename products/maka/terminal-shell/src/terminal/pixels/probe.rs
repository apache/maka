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

use super::geometry::PixelSizeQuery;
use std::{
    num::NonZeroU32,
    time::{Duration, Instant},
};
use termina::{
    Event, WindowSize,
    escape::{
        csi::{
            Csi, DecModeSetting, DecPrivateMode, DecPrivateModeCode, GraphicsAttributeResponse,
            Mode,
        },
        dcs::Dcs,
    },
};

const TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy)]
pub(super) struct Slots {
    pub query: u32,
    pub first: u32,
    pub second: u32,
}

impl Default for Slots {
    fn default() -> Self {
        let random = uuid::Uuid::new_v4();
        let query = u32::from_le_bytes(random.as_bytes()[..4].try_into().unwrap()).max(1);
        let first = query.wrapping_add(1).max(1);
        let second = first.wrapping_add(1).max(1);
        Self {
            query,
            first,
            second,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Protocol {
    Kitty,
    Sixel,
    Iterm2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PixelOrigin {
    Zero,
    One,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MouseCoordinates {
    Cells,
    Pixels(PixelOrigin),
}

/// The terminal's optional XTSMGRAPHICS maximum, independent of its viewport.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SixelGeometry {
    #[default]
    Unknown,
    Unbounded,
    Finite {
        width: NonZeroU32,
        height: NonZeroU32,
    },
    Unavailable(u16),
}

impl SixelGeometry {
    fn response(reply: &GraphicsAttributeResponse) -> Option<Self> {
        if reply.item != 2 {
            return None;
        }
        if reply.status != 0 {
            return reply
                .values
                .is_empty()
                .then_some(Self::Unavailable(reply.status));
        }
        match reply.values.as_slice() {
            [0, 0] => Some(Self::Unbounded),
            [width, height] => Some(Self::Finite {
                width: NonZeroU32::new(*width)?,
                height: NonZeroU32::new(*height)?,
            }),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Capabilities {
    pub size: WindowSize,
    pub ui_scale: f32,
    pub mouse: MouseCoordinates,
    // None during startup, before any image protocol has replied positively.
    pub protocol: Option<Protocol>,
    pub synchronized: bool,
    pub sixel_geometry: SixelGeometry,
}

impl Capabilities {
    pub fn pixel_size(self) -> Option<gpui::Size<gpui::DevicePixels>> {
        let width = self.size.pixel_width?;
        let height = self.size.pixel_height?;
        (width != 0 && height != 0).then(|| {
            gpui::size(
                gpui::DevicePixels(i32::from(width)),
                gpui::DevicePixels(i32::from(height)),
            )
        })
    }

    pub fn viewport(self) -> Option<gpui::Size<gpui::DevicePixels>> {
        if self.size.cols == 0 || self.size.rows == 0 {
            return None;
        }
        let mut viewport = self.pixel_size()?;
        if self.protocol == Some(Protocol::Sixel)
            && let SixelGeometry::Finite { width, height } = self.sixel_geometry
        {
            // Keep the actual terminal geometry for pointer conversion. The
            // crop applies only to the device target, not to its logical density.
            viewport.width.0 = (viewport.width.0 as u32).min(width.get()) as i32;
            viewport.height.0 = (viewport.height.0 as u32).min(height.get()) as i32;
        }
        Some(viewport)
    }

    /// Follow the user's terminal font size, independent of OS or image protocol.
    /// An ordinary 16-device-pixel cell is one logical UI unit of density;
    /// Retina/font zoom increases resolution without shrinking the interface.
    pub fn scale_factor(self) -> f32 {
        self.ui_scale
            * self
                .size
                .pixel_height
                .filter(|height| *height > 0)
                .filter(|_| self.size.rows > 0)
                .map_or(1.0, |height| {
                    f32::from(height) / f32::from(self.size.rows) / 16.0
                })
    }

    pub fn logical_viewport(self) -> Option<gpui::Size<gpui::Pixels>> {
        let viewport = self.viewport()?;
        let scale = self.scale_factor();
        Some(gpui::size(
            gpui::px(viewport.width.0 as f32 / scale),
            gpui::px(viewport.height.0 as f32 / scale),
        ))
    }

    pub fn contains(self, position: gpui::Point<gpui::Pixels>) -> bool {
        self.logical_viewport().is_some_and(|viewport| {
            position.x >= gpui::px(0.0)
                && position.y >= gpui::px(0.0)
                && f32::from(position.x) < f32::from(viewport.width)
                && f32::from(position.y) < f32::from(viewport.height)
        })
    }
}

#[derive(Default)]
pub(crate) struct Probe {
    pub(super) slots: Slots,
    deadline: Option<Instant>,
    kitty: Option<(bool, Instant)>,
    mouse: Option<(bool, Instant)>,
    identity: Option<(Option<PixelOrigin>, Instant)>,
    sixel: Option<(bool, Instant)>,
    sixel_mode: Option<(DecModeSetting, Instant)>,
    inline: Option<(Features, Instant)>,
    synchronized: Option<(bool, Instant)>,
    pub(crate) sixel_geometry: SixelGeometry,
    pub(super) measurement: PixelSizeQuery,
    cancelled: bool,
}

impl Probe {
    /// Errors remain fatal for both session-owned slots after their write
    /// receipts. An image id alone cannot identify which reuse failed.
    pub fn check_graphics_response(&self, event: &Event) -> Result<(), String> {
        if let Event::KittyGraphicsResponse(reply) = event
            && [self.slots.first, self.slots.second].contains(&reply.image_id)
            && let Err(error) = &reply.result
        {
            return Err(format!("terminal rejected the pixel frame: {error}"));
        }
        Ok(())
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn query(&mut self) -> Result<Vec<u8>, String> {
        if !self.measurement.begin(1)? {
            return Err("terminal geometry query is already in flight".into());
        }
        let mut bytes = nsh_gpui_terminal::kitty::capability_query(self.slots.query)
            .map_err(|error| error.to_string())?;
        // DA1 is already requested by the character image probe. Mouse
        // precision, identity, static Sixel mode and synchronization remain
        // independent facts, irrespective of the selected image transport.
        bytes.extend_from_slice(
            b"\x1b[?1016$p\x1b[?80$p\x1b[?2026$p\x1b[>q\x1b]1337;Capabilities\x1b\\\x1b[14t\x1b[?2;4;0S",
        );
        Ok(bytes)
    }

    pub fn flushed(&mut self, at: Instant) {
        let deadline = at + TIMEOUT;
        self.deadline = Some(deadline);
        self.kitty = self.kitty.filter(|(_, at)| *at <= deadline);
        self.mouse = self.mouse.filter(|(_, at)| *at <= deadline);
        self.identity = self.identity.filter(|(_, at)| *at <= deadline);
        self.sixel = self.sixel.filter(|(_, at)| *at <= deadline);
        self.sixel_mode = self.sixel_mode.filter(|(_, at)| *at <= deadline);
        self.inline = self.inline.filter(|(_, at)| *at <= deadline);
        self.synchronized = self.synchronized.filter(|(_, at)| *at <= deadline);
        self.measurement.flushed(at);
    }

    pub fn observe(&mut self, event: &Event, now: Instant) {
        self.measurement.observe(event, now);
        // This optional maximum neither delays discovery nor expires with it.
        // Only one max query is issued; current/max replies have no action id.
        if self.sixel_geometry == SixelGeometry::Unknown
            && let Event::Csi(Csi::GraphicsAttributes(reply)) = event
            && let Some(geometry) = SixelGeometry::response(reply)
        {
            self.sixel_geometry = geometry;
        }
        if self.cancelled || self.deadline.is_some_and(|deadline| now > deadline) {
            return;
        }
        match event {
            Event::KittyGraphicsResponse(reply)
                if reply.image_id == self.slots.query && reply.placement_id.is_none() =>
            {
                self.kitty.get_or_insert((reply.result.is_ok(), now));
            }
            Event::Csi(Csi::Mode(Mode::ReportDecPrivateMode {
                mode: DecPrivateMode::Code(mode),
                setting,
            })) => match mode {
                DecPrivateModeCode::SGRPixelsMouse => {
                    self.mouse.get_or_insert((supported(*setting), now));
                }
                DecPrivateModeCode::SixelDisplayMode => {
                    self.sixel_mode.get_or_insert((*setting, now));
                }
                DecPrivateModeCode::SynchronizedOutput => {
                    self.synchronized.get_or_insert((supported(*setting), now));
                }
                _ => {}
            },
            Event::Csi(Csi::PrimaryDeviceAttributes(attributes)) => {
                self.sixel
                    .get_or_insert((attributes.attributes.contains(&4), now));
            }
            Event::Dcs(Dcs::TerminalNameAndVersion(identity)) => {
                self.identity.get_or_insert((pixel_origin(identity), now));
            }
            Event::Iterm2Capabilities(features) => {
                self.inline.get_or_insert((Features::parse(features), now));
            }
            Event::WindowResized(_) => self.cancelled = true,
            _ => {}
        }
    }

    pub fn needs_static_sixel(&self) -> bool {
        matches!(self.sixel_mode, Some((DecModeSetting::Reset, _)))
    }

    /// Image support, real geometry and pointer coordinates are independent.
    /// Unknown 1016 origins keep real cell precision; never infer the origin
    /// from the image protocol or an environment-variable terminal name.
    pub fn decision(&self, now: Instant, mut size: WindowSize) -> Option<Option<Capabilities>> {
        if self.cancelled {
            return Some(None);
        }
        let deadline = self.deadline?;
        let kitty = self.kitty.is_some_and(|(supported, _)| supported);
        if now < deadline
            && !(kitty
                && self.mouse.is_some()
                && self.identity.is_some()
                && self.measurement.pixels_before(deadline).is_some())
        {
            return None;
        }
        let features = self
            .inline
            .map(|(features, _)| features)
            .unwrap_or_default();
        let protocol = if kitty {
            Protocol::Kitty
        } else if features.file {
            Protocol::Iterm2
        } else if (features.sixel || self.sixel.is_some_and(|(supported, _)| supported))
            && self.sixel_mode.is_some_and(|(mode, _)| supported(mode))
        {
            Protocol::Sixel
        } else {
            return Some(None);
        };
        if let Some((width, height)) = self.measurement.pixels_before(deadline) {
            size.pixel_width = Some(width);
            size.pixel_height = Some(height);
        }
        let mouse = if self.mouse.is_some_and(|(supported, _)| supported) {
            self.identity
                .and_then(|(origin, _)| origin)
                .map(MouseCoordinates::Pixels)
                .unwrap_or(MouseCoordinates::Cells)
        } else {
            MouseCoordinates::Cells
        };
        let capabilities = Capabilities {
            size,
            mouse,
            protocol: Some(protocol),
            synchronized: features.synchronized
                || self.synchronized.is_some_and(|(supported, _)| supported),
            sixel_geometry: self.sixel_geometry,
            ui_scale: 1.0,
        };
        if protocol == Protocol::Sixel && capabilities.pixel_size() != capabilities.viewport() {
            // No app exists yet: use the original Unicode path instead of
            // starting a native scene larger than the reported image device.
            return Some(None);
        }
        Some(capabilities.viewport().map(|_| capabilities))
    }
}

fn supported(setting: DecModeSetting) -> bool {
    matches!(
        setting,
        DecModeSetting::Set | DecModeSetting::Reset | DecModeSetting::PermanentlySet
    )
}

fn pixel_origin(identity: &str) -> Option<PixelOrigin> {
    // These are actual XTVERSION replies, not image-protocol fingerprints.
    // Kitty/Ghostty emit zero-based pixels; xterm and iTerm2 add one.
    if identity
        .strip_prefix("kitty(")
        .and_then(|v| v.strip_suffix(')'))
        .is_some_and(|v| !v.is_empty())
        || identity
            .strip_prefix("ghostty ")
            .is_some_and(|v| !v.is_empty())
    {
        Some(PixelOrigin::Zero)
    } else if identity
        .strip_prefix("XTerm(")
        .and_then(|v| v.strip_suffix(')'))
        .is_some_and(|v| !v.is_empty() && v.bytes().all(|byte| byte.is_ascii_digit()))
        || identity
            .strip_prefix("iTerm2 ")
            .is_some_and(|v| !v.is_empty())
    {
        Some(PixelOrigin::One)
    } else {
        None
    }
}

#[derive(Clone, Copy, Default)]
struct Features {
    file: bool,
    sixel: bool,
    synchronized: bool,
}

impl Features {
    fn parse(raw: &str) -> Self {
        let prefix = raw
            .as_bytes()
            .split(|byte| !byte.is_ascii_alphanumeric())
            .next()
            .unwrap_or_default();
        let mut features = Self::default();
        let mut bare_f = 0;
        let mut remaining = prefix;
        while let Some(first) = remaining.first() {
            if !first.is_ascii_uppercase() {
                break;
            }
            let end = remaining[1..]
                .iter()
                .position(|byte| byte.is_ascii_uppercase())
                .map_or(remaining.len(), |at| at + 1);
            match &remaining[..end] {
                b"F" => bare_f += 1,
                b"Sx" => features.sixel = true,
                b"Sy" => features.synchronized = true,
                _ => {}
            }
            remaining = &remaining[end..];
        }
        // iTerm2 654bb137 VT100Output.m encodes focusReporting and file
        // separately with the same F. Two bare tokens prove both in that
        // emitter; a single F is ambiguous and never authorizes File.
        features.file = bare_f >= 2;
        features
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size() -> WindowSize {
        WindowSize {
            cols: 120,
            rows: 40,
            pixel_width: None,
            pixel_height: None,
        }
    }

    fn probe() -> Probe {
        let mut probe = Probe {
            slots: Slots {
                query: 99,
                first: 41,
                second: 73,
            },
            ..Default::default()
        };
        probe.query().unwrap();
        probe
    }

    fn reply(probe: &mut Probe, bytes: &[u8], at: Instant) {
        let mut parser = termina::Parser::default();
        parser.parse(bytes, false).unwrap();
        while let Some(event) = parser.pop() {
            probe.observe(&event, at);
        }
    }

    #[test]
    fn negative_replies_for_either_owned_slot_remain_fatal_after_discovery() {
        let now = Instant::now();
        let mut probe = probe();
        probe.flushed(now);
        reply(&mut probe, b"\x1b_Gi=99;OK\x1b\\", now);
        // Discovery may already have expired when an old frame's error arrives.
        let late = now + TIMEOUT + Duration::from_secs(1);
        let mut parser = termina::Parser::default();
        parser.parse(b"\x1b_Gi=41,p=1;OK\x1b\\\x1b_Gi=73;OK\x1b\\\x1b_Gi=99;EINVAL:query\x1b\\\x1b_Gi=100,p=1;EINVAL:unowned\x1b\\\x1b_Gi=41,p=1;EINVAL:first\x1b\\\x1b_Gi=73;EINVAL:old\x1b\\", false).unwrap();
        let mut results = Vec::new();
        while let Some(event) = parser.pop() {
            probe.observe(&event, late);
            results.push(probe.check_graphics_response(&event));
        }
        assert_eq!(
            results,
            vec![
                Ok(()),
                Ok(()),
                Ok(()),
                Ok(()),
                Err("terminal rejected the pixel frame: EINVAL:first".into()),
                Err("terminal rejected the pixel frame: EINVAL:old".into())
            ]
        );
    }

    #[test]
    fn graphics_pixel_geometry_and_mouse_precision_are_independent_replies() {
        let now = Instant::now();
        for (mode, precision) in [(2, true), (0, false)] {
            let mut probe = probe();
            probe.flushed(now);
            reply(
                &mut probe,
                format!("\x1b_Gi=99;OK\x1b\\\x1b[?1016;{mode}$y\x1bP>|kitty(0.49.2)\x1b\\\x1b[4;640;960t\x1b[?2;0;100;100S").as_bytes(),
                now,
            );
            let result = probe.decision(now, size()).unwrap().unwrap();
            assert_eq!(
                matches!(result.mouse, MouseCoordinates::Pixels(_)),
                precision
            );
            assert_eq!(
                result.viewport(),
                Some(gpui::size(gpui::DevicePixels(960), gpui::DevicePixels(640)))
            );
        }
    }

    #[test]
    fn sixel_requires_real_static_mode_and_keeps_mouse_and_sync_independent() {
        let now = Instant::now();
        for (mode, accepted, changed) in [
            (0, false, false),
            (1, true, false),
            (2, true, true),
            (3, true, false),
            (4, false, false),
        ] {
            let mut probe = probe();
            probe.flushed(now);
            reply(&mut probe, format!("\x1b[?62;4c\x1b[?80;{mode}$y\x1b[?2026;2$y\x1b[?1016;2$y\x1bP>|XTerm(390)\x1b\\\x1b[4;627;960t").as_bytes(), now);
            let result = probe.decision(now + TIMEOUT, size()).unwrap();
            assert_eq!(result.is_some(), accepted);
            if let Some(caps) = result {
                assert_eq!(caps.protocol, Some(Protocol::Sixel));
                assert_eq!(caps.mouse, MouseCoordinates::Pixels(PixelOrigin::One));
                assert!(caps.synchronized);
                assert_eq!(probe.needs_static_sixel(), changed);
            }
        }
        // Windows Terminal advertises Sixel with DA1 level 61, independently
        // of its supported DECSDM and virtual Sixel pixel dimensions.
        let mut probe = probe();
        probe.flushed(now);
        reply(
            &mut probe,
            b"\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c\x1b[?80;2$y\x1b[?1016;0$y\x1b[4;800;1200t",
            now,
        );
        let caps = probe.decision(now + TIMEOUT, size()).unwrap().unwrap();
        assert_eq!(caps.protocol, Some(Protocol::Sixel));
        assert_eq!(caps.mouse, MouseCoordinates::Cells);
        assert_eq!(caps.sixel_geometry, SixelGeometry::Unknown);
        assert_eq!(
            caps.viewport(),
            Some(gpui::size(
                gpui::DevicePixels(1200),
                gpui::DevicePixels(800)
            ))
        );
        assert!(probe.needs_static_sixel());
    }

    #[test]
    fn optional_sixel_maximum_honors_the_device_without_waiting_for_metadata() {
        let now = Instant::now();
        let finite = SixelGeometry::Finite {
            width: NonZeroU32::new(1200).unwrap(),
            height: NonZeroU32::new(800).unwrap(),
        };
        for (report, maximum, accepted) in [
            (b"".as_slice(), SixelGeometry::Unknown, true),
            (b"\x1b[?2;0;0;0S".as_slice(), SixelGeometry::Unbounded, true),
            (b"\x1b[?2;0;1200;800S".as_slice(), finite, true),
            (
                b"\x1b[?2;1S".as_slice(),
                SixelGeometry::Unavailable(1),
                true,
            ),
            (
                b"\x1b[?2;2S".as_slice(),
                SixelGeometry::Unavailable(2),
                true,
            ),
            (
                b"\x1b[?2;3S".as_slice(),
                SixelGeometry::Unavailable(3),
                true,
            ),
            (
                b"\x1b[?1;0;1000;1000S".as_slice(),
                SixelGeometry::Unknown,
                true,
            ),
            (b"\x1b[?2;0;0;800S".as_slice(), SixelGeometry::Unknown, true),
            (
                b"\x1b[?2;0;1000;1000S".as_slice(),
                SixelGeometry::Finite {
                    width: NonZeroU32::new(1000).unwrap(),
                    height: NonZeroU32::new(1000).unwrap(),
                },
                false,
            ),
        ] {
            let mut probe = probe();
            probe.flushed(now);
            reply(&mut probe, b"\x1b[?61;4c\x1b[?80;2$y\x1b[4;800;1200t", now);
            reply(&mut probe, report, now);
            assert_eq!(probe.sixel_geometry, maximum);
            let selected = probe.decision(now + TIMEOUT, size()).unwrap();
            assert_eq!(selected.is_some(), accepted, "{report:?}");
            if let Some(caps) = selected {
                assert_eq!(caps.protocol, Some(Protocol::Sixel));
                assert_eq!(caps.sixel_geometry, maximum);
                assert_eq!(caps.size.pixel_width, Some(1200));
                assert_eq!(caps.size.pixel_height, Some(800));
            }
        }
        // Max metadata can arrive after discovery. Before select it must still
        // choose the existing Unicode path, rather than overwrite that fact.
        let mut probe = probe();
        probe.flushed(now);
        reply(&mut probe, b"\x1b[?61;4c\x1b[?80;2$y\x1b[4;800;1200t", now);
        let late = now + TIMEOUT + Duration::from_millis(1);
        reply(&mut probe, b"\x1b[?2;0;1000;1000S", late);
        assert!(matches!(probe.decision(late, size()), Some(None)));
    }

    #[test]
    fn only_a_complete_unambiguous_file_report_selects_iterm_images() {
        let now = Instant::now();
        // iTerm2's actual VT100Output emitter reports both focus and File as
        // bare F, in this complete string. The ambiguity cannot be resolved
        // from one F, from digits, or by joining separate reports.
        for (features, file) in [
            ("T3CwLrMSc7UUw15Ts3BFGsSyHNoSxFP", true),
            ("T3F", false),
            ("F1F", false),
            ("F;F", false),
            ("FFx", false),
            ("_FF", false),
        ] {
            let mut probe = probe();
            probe.flushed(now);
            reply(
                &mut probe,
                format!("\x1b]1337;Capabilities={features}\x07\x1b[4;627;960t").as_bytes(),
                now,
            );
            let result = probe.decision(now + TIMEOUT, size()).unwrap();
            assert_eq!(result.is_some(), file, "{features}");
            if let Some(caps) = result {
                assert_eq!(caps.protocol, Some(Protocol::Iterm2));
                assert_eq!(caps.mouse, MouseCoordinates::Cells);
                assert!(caps.synchronized);
            }
        }
        let mut probe = probe();
        probe.flushed(now);
        reply(&mut probe, b"\x1b[200~\x1b]1337;Capabilities=FF\x07\x1b[201~\x1b]1337;Capabilities=F\x07\x1b]1337;Capabilities=F\x07\x1b[4;627;960t", now);
        assert!(probe.decision(now + TIMEOUT, size()).unwrap().is_none());
    }

    #[test]
    fn a_graphics_ack_does_not_authorize_an_unknown_pixel_coordinate_origin() {
        let now = Instant::now();
        for (identity, coordinates) in [
            ("kitty(0.49.2)", MouseCoordinates::Pixels(PixelOrigin::Zero)),
            ("ghostty 1.2.3", MouseCoordinates::Pixels(PixelOrigin::Zero)),
            ("XTerm(390)", MouseCoordinates::Pixels(PixelOrigin::One)),
            ("iTerm2 3.5.0", MouseCoordinates::Pixels(PixelOrigin::One)),
            ("another-kitty(1)", MouseCoordinates::Cells),
            ("unknown 1", MouseCoordinates::Cells),
        ] {
            let mut probe = probe();
            probe.flushed(now);
            reply(
                &mut probe,
                format!("\x1b_Gi=99;OK\x1b\\\x1b[?1016;2$y\x1bP>|{identity}\x1b\\\x1b[4;627;960t")
                    .as_bytes(),
                now,
            );
            let caps = probe.decision(now + TIMEOUT, size()).unwrap().unwrap();
            assert_eq!(caps.protocol, Some(Protocol::Kitty));
            assert_eq!(caps.mouse, coordinates, "{identity}");
        }
    }

    #[test]
    fn startup_geometry_reply_debt_survives_the_capability_observation_window() {
        let flushed = Instant::now();
        let mut probe = probe();
        probe.flushed(flushed);
        reply(&mut probe, b"\x1b_Gi=99;OK\x1b\\\x1b[?1016;2$y", flushed);
        let mut ioctl = size();
        ioctl.pixel_width = Some(960);
        ioctl.pixel_height = Some(640);
        assert!(probe.decision(flushed + TIMEOUT, ioctl).unwrap().is_some());
        // A resize cannot reassign the still-unfinished startup query. Its
        // late reply belongs to geometry 1, even after discovery has ended.
        assert!(!probe.measurement.begin(2).unwrap());
        let after_discovery = flushed + TIMEOUT + Duration::from_millis(10);
        reply(&mut probe, b"\x1b[4;640;960t", after_discovery);
        assert_eq!(
            probe.measurement.poll(after_discovery).unwrap(),
            Some((1, 960, 640))
        );
        assert!(probe.measurement.begin(2).unwrap());
        ioctl.pixel_width = Some(0);
        assert!(
            Capabilities {
                size: ioctl,
                mouse: MouseCoordinates::Cells,
                protocol: None,
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            }
            .viewport()
            .is_none()
        );
    }

    #[test]
    fn foreign_late_or_resized_replies_cannot_choose_the_pixel_renderer() {
        let flushed = Instant::now();
        let late = flushed + TIMEOUT + Duration::from_millis(1);
        for (nonce, arrival, resized) in
            [(98, flushed, false), (99, late, false), (99, flushed, true)]
        {
            let mut probe = probe();
            probe.flushed(flushed);
            if resized {
                probe.observe(&Event::WindowResized(size()), flushed);
            }
            reply(
                &mut probe,
                format!("\x1b_Gi={nonce};OK\x1b\\\x1b[?1016;2$y\x1b[4;640;960t").as_bytes(),
                arrival,
            );
            assert!(matches!(probe.decision(late, size()), Some(None)));
        }
    }
}
