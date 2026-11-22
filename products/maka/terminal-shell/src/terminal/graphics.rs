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

use nsh_platform_tui::{ImageProtocol, ProtocolType};
use termina::{
    Event,
    escape::csi::{Csi, Window},
};

/// Neither reply carries a request identifier. A resized negotiation must
/// consume both original replies before another query can measure the new cells.
pub(super) const QUERY: &[u8] = b"\x1b[c\x1b[16t";

pub(super) struct Probe(State);

enum State {
    Pending(Replies),
    Draining(Replies),
    NeedQuery,
    Complete,
}

#[derive(Default)]
struct Replies {
    flushed: bool,
    sixel: Option<bool>,
    cell: Option<(u16, u16)>,
}

impl Default for Probe {
    fn default() -> Self {
        Self(State::Pending(Replies::default()))
    }
}

impl Probe {
    pub fn flushed(&mut self) {
        if let State::Pending(replies) | State::Draining(replies) = &mut self.0 {
            replies.flushed = true;
        }
    }

    pub fn resize(&mut self) {
        let state = std::mem::replace(&mut self.0, State::NeedQuery);
        self.0 = match state {
            State::Pending(replies) | State::Draining(replies) => State::Draining(replies),
            State::NeedQuery | State::Complete => State::NeedQuery,
        };
    }

    /// Called only by the sole output owner while its previous frame is complete.
    pub fn query(&mut self) -> Option<&'static [u8]> {
        if !matches!(self.0, State::NeedQuery) {
            return None;
        }
        self.0 = State::Pending(Replies::default());
        Some(QUERY)
    }

    pub fn observe(&mut self, event: &Event) {
        let (State::Pending(replies) | State::Draining(replies)) = &mut self.0 else {
            return;
        };
        match event {
            Event::Csi(Csi::PrimaryDeviceAttributes(attributes)) => {
                replies
                    .sixel
                    .get_or_insert(attributes.attributes.contains(&4));
            }
            Event::Csi(Csi::Window(window)) => {
                if let Window::ReportCellSizePixelsResponse {
                    width: Some(width),
                    height: Some(height),
                } = window.as_ref()
                    && let (Ok(width), Ok(height)) = (u16::try_from(*width), u16::try_from(*height))
                    && width != 0
                    && height != 0
                {
                    replies.cell.get_or_insert((width, height));
                }
            }
            _ => {}
        }
    }

    pub fn take_ready(&mut self) -> Option<ImageProtocol> {
        let (replies, stale) = match &self.0 {
            State::Pending(replies) => (replies, false),
            State::Draining(replies) => (replies, true),
            _ => return None,
        };
        if !replies.flushed {
            return None;
        }
        if let Some(supported) = replies.sixel
            && let Some((width, height)) = replies.cell
        {
            let protocol = (!stale && supported)
                .then(|| ImageProtocol::new(ProtocolType::Sixel, width, height).ok())
                .flatten();
            self.0 = if stale {
                State::NeedQuery
            } else {
                State::Complete
            };
            return protocol;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termina::Parser;

    fn observe(probe: &mut Probe, input: &[u8]) {
        let mut parser = Parser::default();
        parser.parse(input, false).unwrap();
        while let Some(event) = parser.pop() {
            probe.observe(&event);
        }
    }

    #[test]
    fn negotiation_requires_both_sixel_attribute_and_real_cell_pixels() {
        let mut probe = Probe::default();
        // A fast reply may precede the driver's observation of its flush receipt.
        observe(&mut probe, b"\x1b[?62;1;4;22c");
        assert!(probe.take_ready().is_none());
        probe.flushed();
        assert!(probe.take_ready().is_none());
        observe(&mut probe, b"\x1b[6;0;8t\x1b[6;17;9t");
        let protocol = probe.take_ready().unwrap();
        assert_eq!(protocol.protocol_type(), ProtocolType::Sixel);
        assert_eq!(protocol.cell_size(), (9, 17));
        assert!(probe.take_ready().is_none());
    }

    #[test]
    fn late_current_query_replies_complete_without_overlapping_queries() {
        let mut probe = Probe::default();
        probe.flushed();
        assert!(probe.take_ready().is_none());
        assert!(probe.query().is_none());
        observe(&mut probe, b"\x1b[?62;4c");
        assert!(probe.take_ready().is_none());
        assert!(
            probe.query().is_none(),
            "the original cell reply is still owed"
        );
        observe(&mut probe, b"\x1b[6;17;9t");
        let protocol = probe.take_ready().unwrap();
        assert_eq!(protocol.protocol_type(), ProtocolType::Sixel);
        assert_eq!(protocol.cell_size(), (9, 17));
        assert!(probe.take_ready().is_none());
        assert!(probe.query().is_none());
    }

    #[test]
    fn complete_replies_wait_for_observation_of_the_actual_flush() {
        let mut probe = Probe::default();
        observe(&mut probe, b"\x1b[?62;4c\x1b[6;16;8t");
        assert!(probe.take_ready().is_none());
        assert!(probe.query().is_none());
        // Complete replies cannot activate before the original flush is observed.
        probe.flushed();
        let protocol = probe.take_ready().unwrap();
        assert_eq!(protocol.protocol_type(), ProtocolType::Sixel);
        assert_eq!(protocol.cell_size(), (8, 16));
        assert!(probe.take_ready().is_none());
    }

    #[test]
    fn resized_cells_are_measured_only_after_the_original_replies_are_consumed() {
        let mut probe = Probe::default();
        probe.flushed();
        observe(&mut probe, b"\x1b[?61;4c\x1b[6;20;10t");
        assert_eq!(probe.take_ready().unwrap().cell_size(), (10, 20));

        probe.resize();
        assert_eq!(probe.query(), Some(b"\x1b[c\x1b[16t".as_slice()));
        observe(&mut probe, b"\x1b[6;22;11t");
        probe.resize();
        probe.resize();
        assert!(probe.take_ready().is_none());
        assert!(probe.query().is_none());
        // Resize can arrive before the driver's observation of this flush.
        probe.flushed();
        assert!(probe.take_ready().is_none());
        assert!(
            probe.query().is_none(),
            "the original DA reply is still owed"
        );
        observe(&mut probe, b"\x1b[?61;4c");
        assert!(probe.take_ready().is_none(), "old cells are drain-only");

        assert_eq!(probe.query(), Some(b"\x1b[c\x1b[16t".as_slice()));
        assert!(
            probe.query().is_none(),
            "only one fresh query may be outstanding"
        );
        observe(&mut probe, b"\x1b[?61;4c\x1b[6;24;12t");
        assert!(probe.take_ready().is_none());
        probe.flushed();
        let protocol = probe.take_ready().unwrap();
        assert_eq!(protocol.protocol_type(), ProtocolType::Sixel);
        assert_eq!(protocol.cell_size(), (12, 24));
    }

    #[test]
    fn either_missing_reply_keeps_the_original_query_outstanding_after_resize() {
        for reply in [b"\x1b[?61;4c".as_slice(), b"\x1b[6;20;10t"] {
            let mut probe = Probe::default();
            probe.flushed();
            observe(&mut probe, reply);
            assert!(probe.take_ready().is_none());
            for _ in 0..3 {
                probe.resize();
                assert!(probe.take_ready().is_none());
                assert!(probe.query().is_none(), "one original reply is still owed");
            }
        }
    }

    #[test]
    fn unsupported_attributes_and_invalid_cell_reports_never_enable_graphics() {
        for reply in [b"\x1b[?4;14c".as_slice(), b"\x1b[?62;14c"] {
            let mut probe = Probe::default();
            probe.flushed();
            observe(&mut probe, reply);
            observe(&mut probe, b"\x1b[6;16;8t");
            assert!(
                probe.take_ready().is_none(),
                "terminal type and substring are not attributes"
            );
        }
        let mut probe = Probe::default();
        probe.flushed();
        observe(&mut probe, b"\x1b[?62;4c");
        for reply in [
            b"\x1b[6;0;8t".as_slice(),
            b"\x1b[6;16;0t",
            b"\x1b[6;16;65536t",
        ] {
            observe(&mut probe, reply);
            assert!(probe.take_ready().is_none());
            assert!(probe.query().is_none());
        }
    }
}
