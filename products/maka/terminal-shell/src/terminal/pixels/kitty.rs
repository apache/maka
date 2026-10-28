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

use std::time::{Duration, Instant};
use termina::{
    Event,
    escape::csi::{Csi, Cursor},
};

// Otty can anchor an image at the preceding caret unless the cursor move is
// acknowledged before the image batch, even with CUP inside that batch.
pub(super) const ORIGIN: &[u8] = b"\x1b[H\x1b[6n";
// Use the same terminal-response budget as pixel geometry queries, after flush.
const TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
pub(super) enum Reply {
    Origin,
    Image(u32),
}

#[derive(Default)]
pub(super) struct Transfer {
    pending: Option<Pending>,
}

struct Pending {
    reply: Reply,
    flushed: Option<Instant>,
    received: Option<Instant>,
}

impl Transfer {
    pub fn begin(&mut self, reply: Reply) {
        assert!(self.pending.is_none(), "Kitty transfers must be serialized");
        self.pending = Some(Pending {
            reply,
            flushed: None,
            received: None,
        });
    }

    pub fn flushed(&mut self, at: Instant) {
        self.pending
            .as_mut()
            .expect("active Kitty transfer")
            .flushed = Some(at);
    }

    pub fn observe(&mut self, event: &Event, at: Instant) -> Result<(), String> {
        let Some(pending) = &mut self.pending else {
            return Ok(());
        };
        let matches = match (pending.reply, event) {
            (
                Reply::Origin,
                Event::Csi(Csi::Cursor(Cursor::ActivePositionReport { line, col })),
            ) => {
                if line.get() != 1 || col.get() != 1 {
                    return Err("terminal did not position the pixel frame at the origin".into());
                }
                true
            }
            (Reply::Image(image), Event::KittyGraphicsResponse(reply))
                if reply.image_id == image =>
            {
                reply
                    .result
                    .as_ref()
                    .map_err(|error| format!("terminal rejected the pixel frame: {error}"))?;
                reply.placement_id.is_none_or(|placement| placement == 1)
            }
            _ => false,
        };
        if matches {
            pending.received.get_or_insert(at);
        }
        Ok(())
    }

    pub fn poll(&mut self, now: Instant) -> Result<bool, String> {
        let Some(Pending {
            reply,
            flushed: Some(flushed),
            received,
        }) = &self.pending
        else {
            return Ok(false);
        };
        let deadline = *flushed + TIMEOUT;
        if received.is_some_and(|at| at <= deadline) {
            self.pending = None;
            return Ok(true);
        }
        if now >= deadline {
            // The driver exits: an untagged late CPR must never satisfy a new frame.
            return Err(match reply {
                Reply::Origin => "terminal did not acknowledge the pixel frame origin",
                Reply::Image(_) => "terminal did not acknowledge the pixel frame upload",
            }
            .into());
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(transfer: &mut Transfer, bytes: &[u8], at: Instant) -> Result<(), String> {
        let mut parser = termina::Parser::default();
        parser.parse(bytes, false).unwrap();
        while let Some(event) = parser.pop() {
            transfer.observe(&event, at)?;
        }
        Ok(())
    }

    #[test]
    fn origin_and_image_replies_require_their_own_completed_write() {
        let mut transfer = Transfer::default();
        let now = Instant::now();
        transfer.begin(Reply::Origin);
        response(&mut transfer, b"\x1b_Gi=41;OK\x1b\\", now).unwrap();
        assert!(!transfer.poll(now).unwrap());
        response(&mut transfer, b"\x1b[1;1R", now).unwrap();
        assert!(!transfer.poll(now).unwrap());
        transfer.flushed(now);
        assert!(transfer.poll(now).unwrap());
        transfer.begin(Reply::Image(41));
        transfer.flushed(now);
        response(&mut transfer, b"\x1b_Gi=73;OK\x1b\\\x1b[1;1R", now).unwrap();
        assert!(!transfer.poll(now).unwrap());
        response(&mut transfer, b"\x1b_Gi=41;OK\x1b\\", now).unwrap();
        assert!(transfer.poll(now).unwrap());
        transfer.begin(Reply::Image(73));
        response(&mut transfer, b"\x1b_Gi=73,p=1;OK\x1b\\", now).unwrap();
        assert!(!transfer.poll(now).unwrap());
        transfer.flushed(now);
        assert!(transfer.poll(now).unwrap());
    }

    #[test]
    fn incorrect_origin_rejected_upload_and_missing_reply_end_the_transfer() {
        let now = Instant::now();
        let mut transfer = Transfer::default();
        transfer.begin(Reply::Origin);
        assert!(response(&mut transfer, b"\x1b[3;5R", now).is_err());
        let mut transfer = Transfer::default();
        transfer.begin(Reply::Image(41));
        assert!(response(&mut transfer, b"\x1b_Gi=41;EINVAL:broken\x1b\\", now).is_err());
        for reply in [Reply::Origin, Reply::Image(41)] {
            let mut transfer = Transfer::default();
            transfer.begin(reply);
            transfer.flushed(now);
            let late = now + TIMEOUT + Duration::from_millis(1);
            response(&mut transfer, b"\x1b[1;1R\x1b_Gi=41;OK\x1b\\", late).unwrap();
            assert!(transfer.poll(late).is_err());
        }
    }
}
