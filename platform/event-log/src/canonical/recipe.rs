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

//! Lossless canonical event recipes and byte-range mapping.
use crate::StoreError;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{borrow::Cow, ops::Range};

fn invalid(reason: &'static str) -> StoreError {
    StoreError::Sqlite(rusqlite::Error::InvalidParameterName(reason.into()))
}

/// A projection token borrowed from the original complete canonical event.
pub(crate) struct Projection<'a> {
    pub offset: usize,
    pub json: &'a str,
}
pub(crate) fn projection<'a>(
    kind: &str,
    json: &'a str,
) -> Result<Option<Projection<'a>>, StoreError> {
    if kind != "tool_settled" {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct Envelope<'a> {
        #[serde(borrow)]
        fact: Fact<'a>,
    }
    #[derive(Deserialize)]
    struct Fact<'a> {
        #[serde(borrow)]
        outcome: Outcome<'a>,
    }
    #[derive(Deserialize)]
    struct Outcome<'a> {
        kind: String,
        #[serde(borrow)]
        model_projection: Option<&'a RawValue>,
    }
    let envelope: Envelope<'_> = serde_json::from_str(json)?;
    if envelope.fact.outcome.kind != "succeeded" {
        return Ok(None);
    }
    let token = envelope
        .fact
        .outcome
        .model_projection
        .ok_or_else(|| invalid("successful tool result lacks its projection"))?
        .get();
    let offset = (token.as_ptr() as usize)
        .checked_sub(json.as_ptr() as usize)
        .ok_or_else(|| invalid("projection does not borrow its event"))?;
    offset
        .checked_add(token.len())
        .filter(|end| *end <= json.len())
        .ok_or_else(|| invalid("projection lies outside its event"))?;
    Ok(Some(Projection {
        offset,
        json: token,
    }))
}
impl Projection<'_> {
    /// SQLite json() preserves standard JSON tokens and removes only the four
    /// insignificant ASCII whitespace bytes. This token was validated by Serde;
    /// counting does not validate JSON or normalize numbers/Unicode escapes.
    pub fn sqlite_json_bytes(&self) -> usize {
        let mut quoted = false;
        let mut escaped = false;
        let mut bytes = 0;
        for byte in self.json.bytes() {
            if quoted {
                bytes += 1;
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    quoted = false;
                }
            } else if !matches!(byte, b' ' | b'\t' | b'\n' | b'\r') {
                bytes += 1;
                quoted = byte == b'"';
            }
        }
        bytes
    }

    pub fn header(&self, original: &str) -> Result<String, StoreError> {
        let end = self
            .offset
            .checked_add(self.json.len())
            .ok_or_else(|| invalid("projection range overflows"))?;
        if original.get(self.offset..end) != Some(self.json) {
            return Err(invalid("projection differs from its event"));
        }
        let mut header = String::with_capacity(original.len() - self.json.len() + 4);
        header.push_str(&original[..self.offset]);
        header.push_str("null");
        header.push_str(&original[end..]);
        Ok(header)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Slot {
    pub offset: u64,
    pub bytes: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Segment {
    Header { offset: u64, bytes: u64 },
    Body { offset: u64, bytes: u64 },
}
/// Logical positions map to physical spans without loading the header body.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Layout {
    bytes: u64,
    slot: Option<Slot>,
}
impl Layout {
    pub fn new(bytes: u64, slot: Option<Slot>) -> Result<Self, StoreError> {
        if let Some(slot) = slot {
            if slot.bytes == 0
                || slot
                    .offset
                    .checked_add(slot.bytes)
                    .is_none_or(|end| end > bytes)
            {
                return Err(invalid("invalid canonical body slot range"));
            }
            bytes
                .checked_sub(slot.bytes)
                .and_then(|len| len.checked_add(4))
                .ok_or_else(|| invalid("canonical header length overflows"))?;
        }
        Ok(Self { bytes, slot })
    }
    pub fn header_bytes(self) -> u64 {
        match self.slot {
            Some(slot) => self.bytes - slot.bytes + 4,
            None => self.bytes,
        }
    }
    /// A logical byte range touches at most the prefix, body, and suffix.
    pub fn segments(&self, range: Range<u64>) -> Result<[Option<Segment>; 3], StoreError> {
        if range.start > range.end || range.end > self.bytes {
            return Err(invalid("canonical byte range is outside its event"));
        }
        let mut segments = [None; 3];
        if range.is_empty() {
            return Ok(segments);
        }
        let Some(slot) = self.slot else {
            segments[0] = Some(Segment::Header {
                offset: range.start,
                bytes: range.end - range.start,
            });
            return Ok(segments);
        };
        let body_end = slot
            .offset
            .checked_add(slot.bytes)
            .ok_or_else(|| invalid("canonical slot range overflows"))?;
        let prefix_end = range.end.min(slot.offset);
        if range.start < prefix_end {
            segments[0] = Some(Segment::Header {
                offset: range.start,
                bytes: prefix_end - range.start,
            });
        }
        let body_start = range.start.max(slot.offset);
        let body_limit = range.end.min(body_end);
        if body_start < body_limit {
            segments[1] = Some(Segment::Body {
                offset: body_start - slot.offset,
                bytes: body_limit - body_start,
            });
        }
        let suffix_start = range.start.max(body_end);
        if suffix_start < range.end {
            segments[2] = Some(Segment::Header {
                offset: suffix_start - body_end + slot.offset + 4,
                bytes: range.end - suffix_start,
            });
        }
        Ok(segments)
    }
}

/// The header and optional typed body slot describe exactly one event.
pub(crate) struct Recipe<'a> {
    header: &'a str,
    layout: Layout,
}
impl<'a> Recipe<'a> {
    pub fn new(header: &'a str, bytes: u64, slot: Option<Slot>) -> Result<Self, StoreError> {
        let layout = Layout::new(bytes, slot)?;
        if header.len() as u64 != layout.header_bytes() {
            return Err(invalid("canonical event length differs from its recipe"));
        }
        if let Some(slot) = slot {
            let position = usize::try_from(slot.offset)
                .map_err(|_| invalid("slot offset exceeds memory range"))?;
            let end = position
                .checked_add(4)
                .ok_or_else(|| invalid("slot offset overflows"))?;
            if header.as_bytes().get(position..end) != Some(b"null") {
                return Err(invalid("invalid canonical body slot"));
            }
        }
        Ok(Self { header, layout })
    }
    pub fn reconstruct(&self, body: Option<&[u8]>) -> Result<Cow<'a, str>, StoreError> {
        let Some(slot) = self.layout.slot else {
            if body.is_some() {
                return Err(invalid("canonical body has no slot"));
            }
            return Ok(Cow::Borrowed(self.header));
        };
        let body = body.ok_or_else(|| invalid("canonical slot lacks its body"))?;
        if body.len() as u64 != slot.bytes {
            return Err(invalid("canonical body length changed"));
        }
        self.reconstruct_with(|bytes| {
            bytes.extend_from_slice(body);
            Ok(())
        })
    }
    pub fn reconstruct_with(
        &self,
        append_body: impl FnOnce(&mut Vec<u8>) -> Result<(), StoreError>,
    ) -> Result<Cow<'a, str>, StoreError> {
        let Some(slot) = self.layout.slot else {
            return Ok(Cow::Borrowed(self.header));
        };
        let position = usize::try_from(slot.offset)
            .map_err(|_| invalid("slot offset exceeds memory range"))?;
        let capacity = usize::try_from(self.layout.bytes)
            .map_err(|_| invalid("canonical event exceeds memory range"))?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(capacity)
            .map_err(std::io::Error::other)?;
        bytes.extend_from_slice(&self.header.as_bytes()[..position]);
        append_body(&mut bytes)?;
        if bytes.len() as u64 != slot.offset + slot.bytes {
            return Err(invalid("canonical body length changed"));
        }
        bytes.extend_from_slice(&self.header.as_bytes()[position + 4..]);
        Ok(Cow::Owned(
            String::from_utf8(bytes).map_err(|_| invalid("canonical body is not UTF-8"))?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &str = r#"{ "outside":null, "fact": {"kind":"tool_settled", "outcome":{"kind":"succeeded", "model_projection": { "kind":"text", "text":"汉字\n\u0061 null" }}}, "after":null }"#;
    #[test]
    fn impossible_declared_capacity_fails_before_consuming_body() {
        let recipe = Recipe::new(
            "null",
            u64::MAX,
            Some(Slot {
                offset: 0,
                bytes: u64::MAX,
            }),
        )
        .unwrap();
        assert!(
            recipe
                .reconstruct_with(|_| panic!("invalid capacity must fail first"))
                .is_err()
        );
    }
    #[test]
    fn projection_measure_matches_sqlite_without_binding_a_whole_event() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let numbers = [
            "1e+00",
            "1E-009",
            "-0",
            "-0.00",
            "1e9999",
            "123456789012345678901234567890",
        ];
        let strings = [
            r#""汉🦀""#,
            r#""\u0061\uD83E\uDD80""#,
            r#""\\\" \\ \t\r\n""#,
        ];
        for number in numbers {
            for text in strings {
                let token = format!(
                    "{{ \"kind\" : \"json\", \"value\" : {{ \"n\" : {number}, \"text\" : {text}, \"n\": [ true, null, false ] }} }}"
                );
                let event = format!(
                    "{{\"fact\":{{\"outcome\":{{\"kind\":\"succeeded\",\"model_projection\":{token}}}}}}}"
                );
                let source = projection("tool_settled", &event).unwrap().unwrap();
                let expected: i64 = db
                    .query_row(
                        "SELECT length(CAST(json(?1) AS BLOB))",
                        [source.json],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(source.sqlite_json_bytes(), expected as usize);
            }
        }
    }
    #[test]
    fn extraction_and_every_byte_range_preserve_original_bytes() {
        let projection = projection("tool_settled", ORIGINAL).unwrap().unwrap();
        let header = projection.header(ORIGINAL).unwrap();
        let recipe = Recipe::new(
            &header,
            ORIGINAL.len() as u64,
            Some(Slot {
                offset: projection.offset as u64,
                bytes: projection.json.len() as u64,
            }),
        )
        .unwrap();
        assert_eq!(
            recipe
                .reconstruct(Some(projection.json.as_bytes()))
                .unwrap(),
            ORIGINAL
        );
        for start in 0..=ORIGINAL.len() {
            for end in start..=ORIGINAL.len() {
                let mut result = Vec::new();
                for segment in recipe
                    .layout
                    .segments(start as u64..end as u64)
                    .unwrap()
                    .into_iter()
                    .flatten()
                {
                    let (source, offset, bytes) = match segment {
                        Segment::Header { offset, bytes } => (header.as_bytes(), offset, bytes),
                        Segment::Body { offset, bytes } => {
                            (projection.json.as_bytes(), offset, bytes)
                        }
                    };
                    result.extend_from_slice(&source[offset as usize..(offset + bytes) as usize]);
                }
                assert_eq!(
                    result,
                    &ORIGINAL.as_bytes()[start..end],
                    "range {start}..{end}"
                );
            }
        }
    }
    #[test]
    fn escaped_success_tag_preserves_its_original_encoding() {
        let original = ORIGINAL.replace("succeeded", r"succe\u0065ded");
        let projection = projection("tool_settled", &original).unwrap().unwrap();
        let header = projection.header(&original).unwrap();
        let recipe = Recipe::new(
            &header,
            original.len() as u64,
            Some(Slot {
                offset: projection.offset as u64,
                bytes: projection.json.len() as u64,
            }),
        )
        .unwrap();
        assert_eq!(
            recipe
                .reconstruct(Some(projection.json.as_bytes()))
                .unwrap(),
            original
        );
    }
    #[test]
    fn inline_and_failed_events_have_no_hidden_body() {
        assert!(
            projection("invocation_ended", r#"{"outcome":"completed"}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            projection("tool_settled", r#"{"fact":{"outcome":{"kind":"failed"}}}"#)
                .unwrap()
                .is_none()
        );
        let recipe = Recipe::new("null", 4, None).unwrap();
        assert_eq!(recipe.reconstruct(None).unwrap(), "null");
        assert!(recipe.reconstruct(Some(b"null")).is_err());
        assert!(recipe.layout.segments(0..5).is_err());
    }
    #[test]
    fn invalid_recipes_do_not_silently_become_inline_events() {
        assert!(Recipe::new("null", 8, None).is_err());
        assert!(
            Recipe::new(
                "true",
                4,
                Some(Slot {
                    offset: 0,
                    bytes: 4
                })
            )
            .is_err()
        );
        let recipe = Recipe::new(
            "null",
            8,
            Some(Slot {
                offset: 0,
                bytes: 8,
            }),
        )
        .unwrap();
        assert!(recipe.reconstruct(None).is_err());
        assert!(recipe.reconstruct(Some(b"null")).is_err());
        assert!(recipe.reconstruct(Some(&[255; 8])).is_err());
    }
}
