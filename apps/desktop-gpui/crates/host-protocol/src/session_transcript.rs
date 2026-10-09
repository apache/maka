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

//! `session.transcript.page`, the transcript bootstrap, and fragment
//! reassembly.
//!
//! Sources: `packages/runtime-host/src/protocol/session-transcript.ts`
//! (`decodeSessionTranscriptPage`, `decodeSessionTranscriptFragment`,
//! `decodeSessionTranscriptBootstrap`, `decodeSessionTranscriptPageInput`) and
//! `TranscriptFragmentAssembler` in
//! `packages/runtime-host/src/client/session-subscription.ts`.
//!
//! A page carries byte fragments of durable rows. Each row is one JSON
//! document (a [`StoredMessage`]) that may be split across fragments and even
//! across pages. An `older` page lists rows newest first and the fragments of
//! one row from its end backwards; a `newer` page runs the other way.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

use crate::{Operation, StoredMessage};

/// `SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES`: the largest `tail.maxBytes`.
pub const SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES: u64 = 16 * 1024;

/// `SESSION_TRANSCRIPT_PAGE_MAX_BYTES`: the largest page `maxBytes`.
pub const SESSION_TRANSCRIPT_PAGE_MAX_BYTES: u64 = 512 * 1024;

wire_enum! {
    /// `SessionTranscriptPageDirection`.
    pub enum TranscriptDirection {
        Older = "older",
        Newer = "newer",
    }
}

wire_tag! {
    /// `SessionTranscriptPage.kind`.
    PageKind = "page"
}

/// `SessionTranscriptPage` (`decodeSessionTranscriptPage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTranscriptPage {
    kind: PageKind,
    pub session_id: String,
    pub direction: TranscriptDirection,
    /// The watermark the page was read at; `null` for an empty transcript.
    pub through_sequence: Option<u64>,
    /// Decoded bytes across all fragments.
    pub raw_bytes: u64,
    /// At most 256 fragments, in the page's direction.
    pub fragments: Vec<SessionTranscriptFragment>,
    /// `null` when the read reached the end in its direction.
    pub next_cursor: Option<String>,
    /// Whether every Turn with rows on this page has all of them here.
    pub ends_at_turn_boundary: bool,
}

/// `SessionTranscriptFragment` (`decodeSessionTranscriptFragment`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTranscriptFragment {
    /// The durable row sequence. Rows are sparse: a sequence is an event
    /// ordinal times a stride, so consecutive rows are not `n` and `n + 1`.
    pub sequence: u64,
    pub byte_offset: u64,
    /// Size of the whole row.
    pub total_bytes: u64,
    /// `sha256:<64 hex>` of the whole row, when the Host supplies it.
    pub payload_digest: Option<String>,
    /// Canonical padded base64 of this fragment's bytes.
    pub data: String,
}

/// `SessionTranscriptBootstrap`: the `older` tail page `subscription.open`
/// returns when the input asked for `tail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTranscriptBootstrap {
    pub durable: SessionTranscriptPage,
}

/// `SessionTranscriptPageInput` (`decodeSessionTranscriptPageInput`). Every
/// field is sent; the optional ones as `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTranscriptPageInput {
    pub subscription_id: String,
    pub direction: TranscriptDirection,
    /// Must not exceed the latest announced watermark
    /// (`subscription.transcript_advanced`); `null` reads an empty transcript.
    pub through_sequence: Option<u64>,
    /// Continues a previous page. Exclusive with `anchor_sequence`.
    pub cursor: Option<String>,
    /// For a `newer` read without a cursor: return rows after this sequence.
    pub anchor_sequence: Option<u64>,
    /// 1 to [`SESSION_TRANSCRIPT_PAGE_MAX_BYTES`].
    pub max_bytes: u64,
}

impl SessionTranscriptPageInput {
    /// The catch-up read the Desktop issues after the watermark moves
    /// (`#readToWatermark` in `apps/desktop/src/main/desktop-transcript-replica.ts`):
    /// rows after `anchor_sequence` through `through_sequence`.
    pub fn newer(
        subscription_id: impl Into<String>,
        through_sequence: u64,
        anchor_sequence: Option<u64>,
    ) -> Self {
        Self {
            subscription_id: subscription_id.into(),
            direction: TranscriptDirection::Newer,
            through_sequence: Some(through_sequence),
            cursor: None,
            anchor_sequence,
            max_bytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
        }
    }

    /// One page of older history: the rows before `cursor`, which a previous
    /// `older` page (or the bootstrap tail) returned. The Host binds a cursor
    /// to its subscription, Session, direction, and watermark, so
    /// `through_sequence` must be the one that page was read at, not the
    /// latest (`readOlderPage` in
    /// `apps/desktop/src/main/desktop-transcript-replica.ts`).
    pub fn older(
        subscription_id: impl Into<String>,
        through_sequence: Option<u64>,
        cursor: impl Into<String>,
        max_bytes: u64,
    ) -> Self {
        Self {
            subscription_id: subscription_id.into(),
            direction: TranscriptDirection::Older,
            through_sequence,
            cursor: Some(cursor.into()),
            anchor_sequence: None,
            max_bytes,
        }
    }

    /// The next page after `page`, reading on in the same direction.
    pub fn continue_after(
        subscription_id: impl Into<String>,
        page: &SessionTranscriptPage,
        cursor: impl Into<String>,
    ) -> Self {
        Self {
            subscription_id: subscription_id.into(),
            direction: page.direction.clone(),
            through_sequence: page.through_sequence,
            cursor: Some(cursor.into()),
            anchor_sequence: None,
            max_bytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
        }
    }
}

/// `session.transcript.page` (mode `query`). Named for its mode because
/// [`SessionTranscriptPage`] is the result type.
#[derive(Debug)]
pub enum SessionTranscriptPageQuery {}

impl Operation for SessionTranscriptPageQuery {
    const NAME: &'static str = "session.transcript.page";
    type Input = SessionTranscriptPageInput;
    type Output = SessionTranscriptPage;
}

/// One reassembled durable row.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct TranscriptEntry {
    pub sequence: u64,
    pub message: StoredMessage,
}

/// Why fragments could not be reassembled. Mirrors the
/// `correlation_changed` failures of `TranscriptFragmentAssembler`; any of
/// them means the subscription's transcript can no longer be trusted.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TranscriptAssemblyError {
    #[error("transcript row {sequence}: fragment data is not canonical base64")]
    InvalidBase64 { sequence: u64 },
    #[error("transcript row {sequence}: identity changed between fragments")]
    IdentityChanged { sequence: u64 },
    #[error("transcript row {sequence}: fragment gap")]
    FragmentGap { sequence: u64 },
    #[error("transcript row {sequence}: fragment exceeds the declared row size")]
    FragmentOverflow { sequence: u64 },
    #[error("transcript row {sequence}: rows out of order")]
    OrderChanged { sequence: u64 },
    #[error("transcript row {sequence}: payload digest mismatch")]
    DigestMismatch { sequence: u64 },
    #[error("transcript row {sequence} is not a stored message")]
    InvalidMessage {
        sequence: u64,
        #[source]
        source: serde_json::Error,
    },
    #[error("transcript row {sequence} ended before every fragment arrived")]
    Incomplete { sequence: u64 },
}

/// Reassembles rows from fragments that arrive across one or more pages of
/// one read (`TranscriptFragmentAssembler`).
#[derive(Debug)]
pub struct TranscriptAssembler {
    direction: TranscriptDirection,
    entries: Vec<TranscriptEntry>,
    current: Option<PartialRow>,
    last_started: Option<u64>,
}

#[derive(Debug)]
struct PartialRow {
    sequence: u64,
    total_bytes: u64,
    payload_digest: Option<String>,
    data: Vec<u8>,
    /// The next byte to fill: counts down from `total_bytes` for `older`,
    /// up from 0 for `newer`.
    edge: u64,
}

impl TranscriptAssembler {
    /// An assembler for a read in `direction`.
    pub fn new(direction: TranscriptDirection) -> Self {
        Self { direction, entries: Vec::new(), current: None, last_started: None }
    }

    /// Accepts the fragments of one page, in page order.
    pub fn accept(
        &mut self,
        fragments: &[SessionTranscriptFragment],
    ) -> Result<(), TranscriptAssemblyError> {
        fragments.iter().try_for_each(|fragment| self.accept_one(fragment))
    }

    /// Bytes still missing from a row cut at the page edge; `None` when the
    /// last accepted page ended on a row boundary.
    pub fn continuation_bytes(&self) -> Option<u64> {
        let current = self.current.as_ref()?;
        Some(if self.older() { current.edge } else { current.total_bytes - current.edge })
    }

    /// Removes and returns the rows completed so far, oldest first, so a
    /// reader can apply rows page by page while a row cut at the page edge
    /// waits for the next page.
    pub fn take_complete(&mut self) -> Vec<TranscriptEntry> {
        let mut entries = std::mem::take(&mut self.entries);
        if self.older() {
            entries.reverse();
        }
        entries
    }

    /// The rows, oldest first. Fails if a row is still incomplete.
    pub fn finish(self) -> Result<Vec<TranscriptEntry>, TranscriptAssemblyError> {
        if let Some(current) = &self.current {
            return Err(TranscriptAssemblyError::Incomplete { sequence: current.sequence });
        }
        Ok(self.into_entries())
    }

    /// The complete rows, oldest first, plus the sequence of a row cut at the
    /// page edge, which is dropped. For a tail bootstrap that is the oldest
    /// row; a reader that wants it continues with the page's cursor instead.
    pub fn finish_complete(self) -> (Vec<TranscriptEntry>, Option<u64>) {
        let incomplete = self.current.as_ref().map(|current| current.sequence);
        (self.into_entries(), incomplete)
    }

    fn older(&self) -> bool {
        self.direction == TranscriptDirection::Older
    }

    fn into_entries(mut self) -> Vec<TranscriptEntry> {
        if self.older() {
            self.entries.reverse();
        }
        self.entries
    }

    fn accept_one(
        &mut self,
        fragment: &SessionTranscriptFragment,
    ) -> Result<(), TranscriptAssemblyError> {
        let sequence = fragment.sequence;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&fragment.data)
            .map_err(|_| TranscriptAssemblyError::InvalidBase64 { sequence })?;
        if bytes.is_empty() {
            return Err(TranscriptAssemblyError::InvalidBase64 { sequence });
        }
        if self.current.is_none() {
            self.start(fragment)?;
        }
        let older = self.older();
        let Some(current) = self.current.as_mut() else {
            return Err(TranscriptAssemblyError::IdentityChanged { sequence });
        };
        if current.sequence != sequence
            || current.total_bytes != fragment.total_bytes
            || current.payload_digest != fragment.payload_digest
        {
            return Err(TranscriptAssemblyError::IdentityChanged { sequence });
        }
        let length = bytes.len() as u64;
        let expected = if older { current.edge.checked_sub(length) } else { Some(current.edge) };
        if expected != Some(fragment.byte_offset) {
            return Err(TranscriptAssemblyError::FragmentGap { sequence });
        }
        let end = fragment.byte_offset + length;
        if end > current.total_bytes {
            return Err(TranscriptAssemblyError::FragmentOverflow { sequence });
        }
        // Bounded by `total_bytes`, which was allocated in `start`.
        let range = fragment.byte_offset as usize..end as usize;
        current.data[range].copy_from_slice(&bytes);
        current.edge = if older { fragment.byte_offset } else { end };
        let complete = if older { current.edge == 0 } else { current.edge == current.total_bytes };
        if complete {
            self.complete_current()?;
        }
        Ok(())
    }

    fn start(
        &mut self,
        fragment: &SessionTranscriptFragment,
    ) -> Result<(), TranscriptAssemblyError> {
        let sequence = fragment.sequence;
        if let Some(last) = self.last_started {
            let in_order = if self.older() { sequence < last } else { sequence > last };
            if !in_order {
                return Err(TranscriptAssemblyError::OrderChanged { sequence });
            }
        }
        let total = usize::try_from(fragment.total_bytes)
            .map_err(|_| TranscriptAssemblyError::FragmentOverflow { sequence })?;
        self.last_started = Some(sequence);
        self.current = Some(PartialRow {
            sequence,
            total_bytes: fragment.total_bytes,
            payload_digest: fragment.payload_digest.clone(),
            data: vec![0; total],
            edge: if self.older() { fragment.total_bytes } else { 0 },
        });
        Ok(())
    }

    fn complete_current(&mut self) -> Result<(), TranscriptAssemblyError> {
        let Some(current) = self.current.take() else {
            return Ok(());
        };
        let sequence = current.sequence;
        if let Some(expected) = &current.payload_digest {
            let actual = format!("sha256:{}", hex(&Sha256::digest(&current.data)));
            if &actual != expected {
                return Err(TranscriptAssemblyError::DigestMismatch { sequence });
            }
        }
        let message = serde_json::from_slice(&current.data)
            .map_err(|source| TranscriptAssemblyError::InvalidMessage { sequence, source })?;
        self.entries.push(TranscriptEntry { sequence, message });
        Ok(())
    }
}

impl SessionTranscriptPage {
    /// Reassembles this page alone: its complete rows, oldest first, and the
    /// sequence of a row cut at the page edge (dropped). See
    /// [`TranscriptAssembler`] to join rows across pages.
    pub fn assemble(&self) -> Result<(Vec<TranscriptEntry>, Option<u64>), TranscriptAssemblyError> {
        let mut assembler = TranscriptAssembler::new(self.direction.clone());
        assembler.accept(&self.fragments)?;
        Ok(assembler.finish_complete())
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn fragment(
        sequence: u64,
        offset: usize,
        total: &[u8],
        len: usize,
    ) -> SessionTranscriptFragment {
        SessionTranscriptFragment {
            sequence,
            byte_offset: offset as u64,
            total_bytes: total.len() as u64,
            payload_digest: None,
            data: encode(&total[offset..offset + len]),
        }
    }

    fn row(id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "user", "id": id, "turnId": id, "ts": 1, "text": format!("text {id}")
        }))
        .expect("json")
    }

    #[test]
    fn older_rows_reassemble_backwards_and_come_out_oldest_first() {
        let newest = row("b");
        let oldest = row("a");
        let split = newest.len() / 2;
        let mut assembler = TranscriptAssembler::new(TranscriptDirection::Older);
        assembler
            .accept(&[
                fragment(24, split, &newest, newest.len() - split),
                fragment(24, 0, &newest, split),
                fragment(16, 0, &oldest, oldest.len()),
            ])
            .expect("accept");
        let entries = assembler.finish().expect("finish");
        assert_eq!(entries.iter().map(|entry| entry.sequence).collect::<Vec<_>>(), [16, 24]);
        assert_eq!(entries[1].message.id(), "b");
    }

    #[test]
    fn newer_rows_join_across_pages() {
        let first = row("a");
        let split = 10;
        let mut assembler = TranscriptAssembler::new(TranscriptDirection::Newer);
        assembler.accept(&[fragment(8, 0, &first, split)]).expect("page 1");
        assert_eq!(assembler.continuation_bytes(), Some((first.len() - split) as u64));
        assembler.accept(&[fragment(8, split, &first, first.len() - split)]).expect("page 2");
        assert_eq!(assembler.continuation_bytes(), None);
        assert_eq!(assembler.finish().expect("finish").len(), 1);
    }

    #[test]
    fn a_row_cut_at_the_edge_is_reported_and_dropped() {
        let newest = row("b");
        let oldest = row("a");
        let mut assembler = TranscriptAssembler::new(TranscriptDirection::Older);
        assembler
            .accept(&[
                fragment(24, 0, &newest, newest.len()),
                fragment(16, 5, &oldest, oldest.len() - 5),
            ])
            .expect("accept");
        let (entries, incomplete) = assembler.finish_complete();
        assert_eq!(entries.len(), 1);
        assert_eq!(incomplete, Some(16));
    }

    #[test]
    fn gaps_order_and_digests_are_checked() {
        let data = row("a");
        let mut gap = TranscriptAssembler::new(TranscriptDirection::Newer);
        assert!(matches!(
            gap.accept(&[fragment(8, 3, &data, 4)]),
            Err(TranscriptAssemblyError::FragmentGap { .. })
        ));

        let mut order = TranscriptAssembler::new(TranscriptDirection::Newer);
        order.accept(&[fragment(8, 0, &data, data.len())]).expect("first");
        assert!(matches!(
            order.accept(&[fragment(8, 0, &data, data.len())]),
            Err(TranscriptAssemblyError::OrderChanged { .. })
        ));

        let mut digest = TranscriptAssembler::new(TranscriptDirection::Newer);
        let mut bad = fragment(8, 0, &data, data.len());
        bad.payload_digest = Some(format!("sha256:{}", "0".repeat(64)));
        assert!(matches!(
            digest.accept(&[bad]),
            Err(TranscriptAssemblyError::DigestMismatch { .. })
        ));

        let mut good = fragment(8, 0, &data, data.len());
        good.payload_digest = Some(format!("sha256:{}", hex(&Sha256::digest(&data))));
        let mut verified = TranscriptAssembler::new(TranscriptDirection::Newer);
        verified.accept(&[good]).expect("digest matches");
    }

    #[test]
    fn non_canonical_base64_is_rejected() {
        let mut assembler = TranscriptAssembler::new(TranscriptDirection::Newer);
        let bad = SessionTranscriptFragment {
            sequence: 1,
            byte_offset: 0,
            total_bytes: 1,
            payload_digest: None,
            data: "QR==".into(),
        };
        assert!(matches!(
            assembler.accept(&[bad]),
            Err(TranscriptAssemblyError::InvalidBase64 { .. })
        ));
    }

    #[test]
    fn newer_input_matches_the_desktop_catch_up_read() {
        assert_eq!(
            serde_json::to_value(SessionTranscriptPageInput::newer("sub", 31, Some(24)))
                .expect("encode"),
            json!({
                "subscriptionId": "sub", "direction": "newer", "throughSequence": 31,
                "cursor": null, "anchorSequence": 24, "maxBytes": SESSION_TRANSCRIPT_PAGE_MAX_BYTES
            })
        );
    }

    #[test]
    fn older_input_continues_a_cursor_at_its_watermark() {
        assert_eq!(
            serde_json::to_value(SessionTranscriptPageInput::older("sub", Some(31), "c1", 4096))
                .expect("encode"),
            json!({
                "subscriptionId": "sub", "direction": "older", "throughSequence": 31,
                "cursor": "c1", "anchorSequence": null, "maxBytes": 4096
            })
        );
    }
}
