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

use super::super::view::{identifier, route, safe};
use super::*;
use crate::Error;

fn invalid() -> Error {
    Error::Invalid("Invalid terminal transcript".into())
}
fn bounded(value: &impl Serialize, limit: usize) -> Result<(), Error> {
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > limit {
        return Err(invalid());
    }
    Ok(())
}
fn cursor(value: &Option<String>) -> Result<(), Error> {
    if let Some(value) = value {
        identifier(value)?;
    }
    Ok(())
}
fn range(text: &str, range: &Range<usize>) -> Result<(), Error> {
    if range.start >= range.end
        || range.end > text.len()
        || !text.is_char_boundary(range.start)
        || !text.is_char_boundary(range.end)
    {
        return Err(invalid());
    }
    Ok(())
}
impl Key {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.turn)?;
        identifier(&self.message)
    }
}
impl Resource {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.id)?;
        crate::identifier(&self.read)?;
        crate::identifier(&self.stream)?;
        if self.read == self.stream {
            return Err(invalid());
        }
        route(&self.route)
    }
}
impl Block {
    pub fn validate(&self) -> Result<(), Error> {
        self.key.validate()?;
        identifier(&self.revision)?;
        if (self.kind == Kind::Tool) != self.state.is_some()
            || (self.kind != Kind::Tool && self.affinity.is_some())
            || self.key.part
                != match self.kind {
                    Kind::Thinking => Part::Thinking,
                    Kind::Tool => Part::Tool,
                    _ => Part::Text,
                }
            || self.timestamp_ms.is_some_and(|at| at > i64::MAX as u64)
        {
            return Err(invalid());
        }
        self.content.validate()?;
        bounded(self, MAX_RECORD_BYTES)
    }
}
impl Content {
    pub fn validate(&self) -> Result<(), Error> {
        if self.text.len() > MAX_RECORD_BYTES
            || !safe(&self.text, true)
            || self.diff.len() > 131_072
        {
            return Err(invalid());
        }
        let mut end = 0;
        for row in &self.diff {
            range(&self.text, &row.source)?;
            if row.source.start < end {
                return Err(invalid());
            }
            end = row.source.end;
            if let Some(language) = &row.language {
                if language.len() > 64 {
                    return Err(invalid());
                }
                identifier(language)?;
            }
        }
        if let Some(link) = &self.link {
            range(&self.text, &link.source)?;
            if link.path.trim().is_empty()
                || link.path.len() > 4096
                || !safe(&link.path, false)
                || link.path.contains("://")
                || link.path.contains(['\u{061c}', '\u{200e}', '\u{200f}'])
            {
                return Err(invalid());
            }
        }
        if let Some(emphasis) = &self.emphasis {
            range(&self.text, emphasis)?;
        }
        Ok(())
    }
}
impl Timing {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.turn)?;
        if self.start_ms < 0
            || self
                .end
                .as_ref()
                .is_some_and(|end| end.at_ms < self.start_ms)
            || self.active && self.end.is_some()
        {
            return Err(invalid());
        }
        Ok(())
    }
}
impl Open {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.resource)?;
        identifier(&self.locale)?;
        if self.locale.len() > 32 {
            return Err(invalid());
        }
        route(&self.route)
    }
}
impl Read {
    pub fn validate(&self) -> Result<(), Error> {
        identifier(&self.resource)?;
        cursor(&self.cursor)?;
        if (self.direction == Direction::Tail) != self.cursor.is_none() {
            return Err(invalid());
        }
        Ok(())
    }
}
impl Record {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Block { block } => block.validate(),
            Self::Fragment {
                key,
                revision,
                offset,
                total,
                json,
            } => {
                key.validate()?;
                identifier(revision)?;
                if *total == 0
                    || *total > MAX_RECORD_BYTES
                    || json.is_empty()
                    || json.len() > MAX_FRAGMENT_BYTES
                    || offset
                        .checked_add(json.len())
                        .is_none_or(|end| end > *total)
                {
                    return Err(invalid());
                }
                Ok(())
            }
        }
    }
}
impl Page {
    pub fn validate(&self) -> Result<(), Error> {
        if self.records.len() > MAX_RECORDS
            || self.timings.len() > MAX_RECORDS
            || self.continuation.is_some() && (self.older.is_some() || self.newer.is_some())
        {
            return Err(invalid());
        }
        cursor(&self.older)?;
        cursor(&self.newer)?;
        cursor(&self.continuation)?;
        for record in &self.records {
            record.validate()?;
        }
        for timing in &self.timings {
            timing.validate()?;
        }
        bounded(self, super::super::view::MAX_BYTES)
    }
}
impl Event {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Ready { .. } | Self::Invalidated => {}
            Self::Replace {
                base,
                revision,
                record,
                ..
            } => {
                next(*base, *revision)?;
                record.validate()?;
            }
            Self::Append {
                base,
                revision,
                key,
                block_base,
                block_revision,
                offset,
                text,
            } => {
                next(*base, *revision)?;
                key.validate()?;
                identifier(block_base)?;
                identifier(block_revision)?;
                if block_base == block_revision
                    || !safe(text, true)
                    || text.is_empty()
                    || offset
                        .checked_add(text.len())
                        .is_none_or(|end| end > MAX_RECORD_BYTES)
                {
                    return Err(invalid());
                }
            }
            Self::Remove {
                base,
                revision,
                key,
            } => {
                next(*base, *revision)?;
                key.validate()?;
            }
            Self::Timing {
                base,
                revision,
                timing,
            } => {
                next(*base, *revision)?;
                timing.validate()?;
            }
        }
        bounded(self, super::super::view::MAX_BYTES)
    }
}
fn next(base: u64, revision: u64) -> Result<(), Error> {
    if base.checked_add(1) != Some(revision) {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block() -> Block {
        Block {
            key: Key {
                turn: "group".into(),
                message: "entry".into(),
                part: Part::Tool,
            },
            revision: "r1".into(),
            kind: Kind::Tool,
            state: Some(ToolState::Returned),
            content: Content {
                text: "中文🦀\nfile.rs".into(),
                ..Default::default()
            },
            timestamp_ms: None,
            affinity: Some(Affinity::Read),
        }
    }

    #[test]
    fn omitted_defaults_do_not_make_a_valid_sdk_page_exceed_the_wire_budget() {
        let records: Vec<_> = (0..253)
            .map(|n| {
                serde_json::json!({
                    "kind":"block", "block": {
                        "key":{"turn":"activity","message":format!("message-{n}"),"part":"text"},
                        "revision":"1","kind":"assistant","content":{"text":"x".repeat(58)}
                    }
                })
            })
            .collect();
        let value = serde_json::json!({"fence":0,"records":records,"continuation":"next"});
        let received = serde_json::to_vec(&value).unwrap().len();
        assert!(received <= super::super::super::view::MAX_BYTES);
        let page: Page = serde_json::from_value(value).unwrap();
        page.validate().unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= received);
    }

    #[test]
    fn ranges_are_utf8_bounded_and_ordered_before_rendering() {
        let mut value = block();
        value.content.emphasis = Some(0..6);
        value.content.diff = vec![DiffRow {
            source: 0..10,
            kind: DiffKind::Added,
            language: Some("rust".into()),
        }];
        value.validate().unwrap();
        for invalid in [1..6, 0..5, Range { start: 5, end: 2 }, 0..100, 0..0] {
            value.content.emphasis = Some(invalid);
            assert!(value.validate().is_err());
        }
        value.content.emphasis = None;
        value.content.diff.push(DiffRow {
            source: 6..10,
            kind: DiffKind::Removed,
            language: None,
        });
        assert!(
            value.validate().is_err(),
            "overlapping changes cannot reach text slicing"
        );
        value.content.diff.clear();
        value.content.link = Some(Link {
            source: 11..18,
            path: "\u{1b}[31m".into(),
        });
        assert!(value.validate().is_err());
    }

    #[test]
    fn public_keys_cannot_claim_reader_summaries_or_native_authority() {
        let mut value = block();
        value.state = None;
        assert!(value.validate().is_err());
        value.kind = Kind::Assistant;
        value.affinity = None;
        assert!(value.validate().is_err(), "kind and key part disagree");
        value.key.part = Part::Text;
        value.validate().unwrap();
        let mut json = serde_json::to_value(value).unwrap();
        json["branchable"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Block>(json).is_err());
        for part in ["activity", "reasoning", "timing"] {
            assert!(
                serde_json::from_value::<Key>(
                    serde_json::json!({"turn":"t","message":"m","part":part})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn fragments_bound_allocation_and_stream_revisions_cannot_jump() {
        let value = block();
        for (offset, total, json) in [
            (usize::MAX, 8, "x".into()),
            (0, MAX_RECORD_BYTES + 1, "x".into()),
            (0, MAX_RECORD_BYTES, "x".repeat(MAX_FRAGMENT_BYTES + 1)),
        ] {
            assert!(
                Record::Fragment {
                    key: value.key.clone(),
                    revision: "r1".into(),
                    offset,
                    total,
                    json
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            Event::Replace {
                base: 1,
                revision: 3,
                append: true,
                record: Record::Block {
                    block: value.clone()
                }
            }
            .validate()
            .is_err()
        );
        Event::Replace {
            base: 1,
            revision: 2,
            append: true,
            record: Record::Block { block: value },
        }
        .validate()
        .unwrap();
    }
}
