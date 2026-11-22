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
    escape::csi::{Csi, Window},
};

pub(super) const QUERY: &[u8] = b"\x1b[14t";
const TIMEOUT: Duration = Duration::from_secs(1);
const UNAVAILABLE: &str = "the terminal did not report its pixel dimensions; a late geometry reply cannot be reused for another resize";

/// CSI 14 replies have no nonce. Finish the one original query before issuing
/// another, including when resize changes its geometry while it is in flight.
#[derive(Default)]
pub(super) enum PixelSizeQuery {
    #[default]
    Idle,
    Pending {
        geometry: u64,
        deadline: Option<Instant>,
        reply: Option<(u16, u16, Instant)>,
    },
    Unavailable,
}

impl PixelSizeQuery {
    pub fn next_deadline(&self) -> Option<Instant> {
        match self {
            Self::Pending { deadline, .. } => *deadline,
            Self::Idle | Self::Unavailable => None,
        }
    }

    pub fn begin(&mut self, geometry: u64) -> Result<bool, String> {
        match self {
            Self::Idle => {
                *self = Self::Pending {
                    geometry,
                    deadline: None,
                    reply: None,
                };
                Ok(true)
            }
            Self::Pending { .. } => Ok(false),
            Self::Unavailable => Err(UNAVAILABLE.into()),
        }
    }

    pub fn flushed(&mut self, at: Instant) {
        if let Self::Pending {
            deadline, reply, ..
        } = self
        {
            let end = at + TIMEOUT;
            *deadline = Some(end);
            *reply = reply.filter(|(_, _, received)| *received <= end);
        }
    }

    pub fn observe(&mut self, event: &Event, at: Instant) {
        let Self::Pending {
            deadline, reply, ..
        } = self
        else {
            return;
        };
        if deadline.is_some_and(|deadline| at > deadline) {
            return;
        }
        if let Event::Csi(Csi::Window(window)) = event
            && let Window::ReportTextAreaSizePixelsResponse {
                width: Some(width),
                height: Some(height),
            } = window.as_ref()
            && let (Ok(width), Ok(height)) = (u16::try_from(*width), u16::try_from(*height))
            && width != 0
            && height != 0
        {
            reply.get_or_insert((width, height, at));
        }
    }

    pub fn pixels_before(&self, before: Instant) -> Option<(u16, u16)> {
        let Self::Pending {
            deadline: Some(deadline),
            reply: Some((width, height, at)),
            ..
        } = self
        else {
            return None;
        };
        (*at <= *deadline && *at <= before).then_some((*width, *height))
    }

    pub fn poll(&mut self, now: Instant) -> Result<Option<(u64, u16, u16)>, String> {
        let Self::Pending {
            geometry,
            deadline: Some(deadline),
            reply,
            ..
        } = self
        else {
            return Ok(None);
        };
        if let Some((width, height, at)) = reply
            && *at <= *deadline
        {
            let result = (*geometry, *width, *height);
            *self = Self::Idle;
            return Ok(Some(result));
        }
        if now >= *deadline {
            *self = Self::Unavailable;
            return Err(UNAVAILABLE.into());
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(query: &mut PixelSizeQuery, bytes: &[u8], at: Instant) {
        let mut parser = termina::Parser::default();
        parser.parse(bytes, false).unwrap();
        while let Some(event) = parser.pop() {
            query.observe(&event, at);
        }
    }

    #[test]
    fn early_reply_keeps_the_original_resize_until_its_actual_flush_receipt() {
        let mut query = PixelSizeQuery::default();
        let flushed = Instant::now();
        assert!(query.begin(7).unwrap());
        response(&mut query, b"\x1b[4;627;960t", flushed);
        assert!(
            !query.begin(8).unwrap(),
            "another resize cannot replace an unfinished query"
        );
        assert!(query.poll(flushed).unwrap().is_none());
        query.flushed(flushed);
        assert_eq!(query.poll(flushed).unwrap(), Some((7, 960, 627)));
        assert!(query.begin(8).unwrap());
    }

    #[test]
    fn a_timed_out_query_cannot_misattribute_its_late_reply_to_another_resize() {
        let mut query = PixelSizeQuery::default();
        let flushed = Instant::now();
        query.begin(7).unwrap();
        query.flushed(flushed);
        let late = flushed + TIMEOUT + Duration::from_millis(1);
        assert!(query.poll(late).is_err());
        assert!(query.begin(8).is_err());
        response(&mut query, b"\x1b[4;627;960t", late);
        assert!(query.poll(late).unwrap().is_none());
    }
}
