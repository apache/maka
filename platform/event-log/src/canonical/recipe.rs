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

//! Lossless canonical event recipes over a header and its optional body slot.
use crate::StoreError;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::borrow::Cow;

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
/// The logical event size and optional body slot determine the stored header size.
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
    pub fn decode(
        &self,
        body: Option<&'a [u8]>,
    ) -> Result<(maka_agent_facts::event::RuntimeEvent, [&'a [u8]; 3]), StoreError> {
        match (self.layout.slot, body) {
            (None, None) => Ok((
                serde_json::from_str(self.header)?,
                [self.header.as_bytes(), &[], &[]],
            )),
            (Some(slot), Some(body)) => {
                if body.len() as u64 != slot.bytes {
                    return Err(invalid("canonical body length changed"));
                }
                let position = usize::try_from(slot.offset)
                    .map_err(|_| invalid("slot offset exceeds memory range"))?;
                let event = super::event::decode(self.header, position, body)?;
                Ok((
                    event,
                    [
                        &self.header.as_bytes()[..position],
                        body,
                        &self.header.as_bytes()[position + 4..],
                    ],
                ))
            }
            _ => Err(invalid("canonical body does not match its slot")),
        }
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
    fn extraction_and_reconstruction_preserve_original_bytes() {
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
