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

//! What a terminal sends its PTY through `runtime.resource.controller.control`:
//! keystrokes and sizes, numbered from the acquire's `nextSequence`, one
//! request in flight, later input queued and coalesced, a resize sent only
//! when the size changes.

use host_protocol::{
    PtyControl, PtySize, RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES,
    RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
};

/// One control the queue handed out and has not heard back about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Sent {
    sequence: u64,
    resize: Option<PtySize>,
}

/// The controls of one terminal, while this connection holds its
/// controller. Pure bookkeeping: the terminal sends what [`Self::next`]
/// hands out and reports the answer.
#[derive(Debug, Default)]
pub(crate) struct ControlQueue {
    /// The sequence of the next control; `None` until an acquire answers,
    /// and again once the controller is lost.
    next_sequence: Option<u64>,
    in_flight: Option<Sent>,
    /// Input not sent yet, in order.
    input: String,
    /// A size to send.
    resize: Option<PtySize>,
    /// The size the PTY has, as far as this client knows: the snapshot's,
    /// then each resize the Host accepted.
    pty_size: Option<PtySize>,
}

impl ControlQueue {
    /// An acquire answered: controls go on from `next_sequence`, and the
    /// PTY has `size`. Queued input stays queued.
    pub(crate) fn acquired(&mut self, next_sequence: u64, size: PtySize) {
        self.next_sequence = Some(next_sequence);
        self.in_flight = None;
        self.pty_size = Some(size);
        if self.resize == Some(size) {
            self.resize = None;
        }
    }

    pub(crate) fn push_input(&mut self, input: &str) {
        self.input.push_str(input);
    }

    /// Asks for the PTY to have `size`. Nothing is sent when it has that
    /// size, or will once the resize in flight is accepted; a resize not
    /// sent yet is replaced.
    pub(crate) fn request_resize(&mut self, size: PtySize) {
        let settled = self.in_flight.and_then(|sent| sent.resize).or(self.pty_size);
        self.resize = (settled != Some(size)).then_some(size);
    }

    /// The next control to send and its sequence, if one is due: none while
    /// one is in flight or before an acquire. Queued input goes in one
    /// control of at most 32 KiB, with a pending resize when there is one.
    pub(crate) fn next(&mut self) -> Option<(u64, PtyControl)> {
        if self.in_flight.is_some() {
            return None;
        }
        let sequence = self.next_sequence?;
        let input = take_prefix(&mut self.input, RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES);
        let resize = self.resize.take();
        let control = match (input.is_empty(), resize) {
            (true, None) => return None,
            (true, Some(size)) => PtyControl::resize(size),
            (false, None) => PtyControl::input(input).ok()?,
            (false, Some(size)) => PtyControl::input_and_resize(input, size).ok()?,
        };
        self.in_flight = Some(Sent { sequence, resize });
        Some((sequence, control))
    }

    /// The Host accepted the control in flight. Past the last sequence the
    /// Host releases the controller, and an acquire is due again.
    pub(crate) fn accepted(&mut self) {
        let Some(sent) = self.in_flight.take() else {
            return;
        };
        if let Some(size) = sent.resize {
            self.pty_size = Some(size);
        }
        self.next_sequence =
            (sent.sequence < RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE).then_some(sent.sequence + 1);
    }

    /// The Host refused the control in flight without using its sequence
    /// (an invalid request): it is dropped and the next one reuses it.
    pub(crate) fn refused(&mut self) {
        self.in_flight = None;
    }

    /// The controller is gone (lost, released, out of sequence): nothing
    /// is sent until the next acquire, which may change the PTY's size.
    /// Queued input waits for it.
    pub(crate) fn lost(&mut self) {
        self.next_sequence = None;
        self.in_flight = None;
        self.pty_size = None;
    }

    /// Drops queued input that was never sent: on release, and when the
    /// connection dropped (a control in flight then is neither retried nor
    /// replayed, which could type it twice).
    pub(crate) fn clear(&mut self) {
        self.lost();
        self.input.clear();
        self.resize = None;
    }

    /// The input queued and not sent yet.
    #[cfg(test)]
    pub(crate) fn queued_input(&self) -> &str {
        &self.input
    }

    /// Whether a control is in flight.
    #[cfg(test)]
    pub(crate) fn is_busy(&self) -> bool {
        self.in_flight.is_some()
    }
}

/// Removes and returns the longest prefix of `text` of at most `max` bytes
/// that ends on a character boundary.
fn take_prefix(text: &mut String, max: usize) -> String {
    if text.len() <= max {
        return std::mem::take(text);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let rest = text.split_off(end);
    std::mem::replace(text, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(cols: u16, rows: u16) -> PtySize {
        PtySize::new(cols, rows).expect("size")
    }

    #[test]
    fn sequences_rise_by_one_with_one_control_in_flight_and_input_coalesced() {
        let mut queue = ControlQueue::default();
        queue.push_input("e");
        assert_eq!(queue.next(), None, "nothing before an acquire");
        queue.acquired(7, size(80, 24));
        assert_eq!(queue.next(), Some((7, PtyControl::input("e").expect("input"))));
        queue.push_input("c");
        queue.push_input("ho");
        assert_eq!(queue.next(), None, "one in flight");
        queue.accepted();
        assert_eq!(queue.next(), Some((8, PtyControl::input("cho").expect("input"))));
        queue.accepted();
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn input_goes_in_controls_of_at_most_32_kib_on_character_boundaries() {
        let mut queue = ControlQueue::default();
        queue.acquired(1, size(80, 24));
        // 'é' is two bytes: 32 KiB of them plus one byte cannot split one.
        queue.push_input(&format!("x{}", "é".repeat(RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES / 2)));
        let Some((1, PtyControl::Input { input })) = queue.next() else { panic!("input") };
        assert_eq!(input.len(), RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES - 1);
        queue.accepted();
        let Some((2, PtyControl::Input { input })) = queue.next() else { panic!("rest") };
        assert_eq!(input, "é");
    }

    #[test]
    fn resizes_coalesce_and_go_only_when_the_size_changes() {
        let mut queue = ControlQueue::default();
        queue.acquired(1, size(80, 24));
        queue.request_resize(size(80, 24));
        assert_eq!(queue.next(), None, "the PTY has that size");
        queue.request_resize(size(90, 30));
        queue.request_resize(size(100, 30));
        assert_eq!(queue.next(), Some((1, PtyControl::resize(size(100, 30)))));
        // Back and forth while it is in flight: only the last differs.
        queue.request_resize(size(80, 24));
        queue.request_resize(size(100, 30));
        queue.accepted();
        assert_eq!(queue.next(), None);
        queue.request_resize(size(120, 40));
        queue.push_input("ls\r");
        assert_eq!(
            queue.next(),
            Some((2, PtyControl::input_and_resize("ls\r", size(120, 40)).expect("control")))
        );
    }

    #[test]
    fn a_lost_controller_keeps_input_and_a_cleared_queue_drops_it() {
        let mut queue = ControlQueue::default();
        queue.acquired(3, size(80, 24));
        queue.push_input("a");
        assert!(queue.next().is_some());
        queue.push_input("b");
        queue.lost();
        assert_eq!(queue.next(), None);
        queue.acquired(9, size(80, 24));
        assert_eq!(queue.next(), Some((9, PtyControl::input("b").expect("input"))));
        queue.push_input("c");
        queue.clear();
        assert_eq!(queue.queued_input(), "");
        queue.acquired(1, size(80, 24));
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn a_refused_control_gives_its_sequence_to_the_next() {
        let mut queue = ControlQueue::default();
        queue.acquired(4, size(80, 24));
        queue.push_input("a");
        assert!(queue.next().is_some());
        queue.refused();
        queue.push_input("b");
        assert_eq!(queue.next(), Some((4, PtyControl::input("b").expect("input"))));
        assert!(queue.is_busy());
    }
}
