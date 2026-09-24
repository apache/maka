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

//! Newly streamed text fades in. What fades is decided by when each byte of
//! the source arrived, so restyling (`**bo` becoming bold "bo") never fades
//! text again, and text already there when a view attaches never fades.
//! Only colors change, never the laid-out text.

use super::parse::Text;
use std::{
    ops::Range,
    time::{Duration, Instant},
};

const MIN: f32 = 120.;
const MAX: f32 = 400.;

struct Chunk {
    start: usize,
    at: Instant,
    duration: Duration,
}

pub struct Arrivals {
    chunks: Vec<Chunk>,
    /// Smoothed gap between updates: a slow stream fades slowly, a fast one
    /// quickly, so the fade never trails far behind the text.
    gap_ms: f32,
    last: Option<Instant>,
}

impl Arrivals {
    /// `source` was already on screen; it shows at full opacity.
    pub fn seeded() -> Self {
        Self {
            chunks: Vec::new(),
            gap_ms: 160.,
            last: None,
        }
    }

    pub fn record(&mut self, old: &str, new: &str, now: Instant) {
        let mut prefix = old
            .bytes()
            .zip(new.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        while !new.is_char_boundary(prefix) {
            prefix -= 1;
        }
        self.chunks.retain(|chunk| chunk.start < prefix);
        // A chunk's range ends where the next begins, so only a finished
        // run at the front can go without changing the others.
        let finished = self
            .chunks
            .iter()
            .take_while(|chunk| now - chunk.at >= chunk.duration)
            .count();
        self.chunks.drain(..finished);
        if new.len() <= prefix {
            return;
        }
        if let Some(last) = self.last {
            let gap = (now - last).as_secs_f32() * 1000.;
            self.gap_ms = 0.7 * self.gap_ms + 0.3 * gap.min(1000.);
        }
        self.last = Some(now);
        self.chunks.push(Chunk {
            start: prefix,
            at: now,
            duration: Duration::from_secs_f32((3. * self.gap_ms).clamp(MIN, MAX) / 1000.),
        });
    }

    pub fn fading(&self, now: Instant) -> bool {
        self.chunks
            .iter()
            .any(|chunk| now - chunk.at < chunk.duration)
    }

    /// Byte ranges of `text` that are still fading in, with their opacity.
    pub fn spans(&self, text: &Text, now: Instant) -> Vec<(Range<usize>, f32)> {
        let mut spans = Vec::new();
        for (ix, chunk) in self.chunks.iter().enumerate() {
            let progress = (now - chunk.at).as_secs_f32() / chunk.duration.as_secs_f32();
            if progress >= 1. {
                continue;
            }
            let end = self
                .chunks
                .get(ix + 1)
                .map_or(usize::MAX, |next| next.start);
            let range = text_offset(text, chunk.start)..text_offset(text, end);
            if !range.is_empty() {
                spans.push((range, 1. - (1. - progress.max(0.)).powf(1.6)));
            }
        }
        spans
    }
}

/// First byte of `text` whose source is at or after `source`.
fn text_offset(text: &Text, source: usize) -> usize {
    let pieces = &text.origins;
    let ix = pieces.partition_point(|(_, start)| *start <= source);
    let Some(ix) = ix.checked_sub(1) else {
        return 0;
    };
    let (offset, start) = pieces[ix];
    let piece_end = pieces.get(ix + 1).map_or(text.text.len(), |next| next.0);
    let mut at = (offset + (source - start)).min(piece_end);
    while !text.text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::md::parse::parse;

    #[test]
    fn only_the_new_source_fades() {
        let start = Instant::now();
        let mut arrivals = Arrivals::seeded();
        arrivals.record("", "Hello ", start);
        arrivals.record(
            "Hello ",
            "Hello **world**",
            start + Duration::from_millis(120),
        );
        let text = &parse("Hello **world**", 0).blocks[0].texts[0];
        let now = start + Duration::from_millis(200);
        let spans = arrivals.spans(text, now);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[1].0, 6..11);
        assert!(spans[0].1 > spans[1].1);
    }

    #[test]
    fn text_already_shown_and_finished_chunks_are_opaque() {
        let start = Instant::now();
        let mut arrivals = Arrivals::seeded();
        arrivals.record("", "Hello", start);
        let text = &parse("Hello", 0).blocks[0].texts[0];
        assert!(
            arrivals
                .spans(text, start + Duration::from_secs(1))
                .is_empty()
        );
        assert!(!arrivals.fading(start + Duration::from_secs(1)));
        assert!(Arrivals::seeded().spans(text, start).is_empty());
    }

    #[test]
    fn a_rewrite_refades_only_past_the_common_prefix() {
        let start = Instant::now();
        let mut arrivals = Arrivals::seeded();
        arrivals.record("", "abc def", start);
        let later = start + Duration::from_secs(2);
        arrivals.record("abc def", "abc xyz", later);
        let text = &parse("abc xyz", 0).blocks[0].texts[0];
        let spans = arrivals.spans(text, later);
        assert_eq!(spans, vec![(4..7, 0.)]);
    }

    #[test]
    fn a_long_stream_keeps_only_the_chunks_still_fading() {
        let start = Instant::now();
        let mut arrivals = Arrivals::seeded();
        let mut source = String::new();
        for step in 0..100u64 {
            let old = source.clone();
            source.push_str("word ");
            arrivals.record(&old, &source, start + Duration::from_millis(step * 120));
        }
        assert!(arrivals.chunks.len() <= 5, "{}", arrivals.chunks.len());
    }
}
