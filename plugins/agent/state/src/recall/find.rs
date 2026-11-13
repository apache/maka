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
use super::*;
use regex::{Regex, RegexBuilder};
use rusqlite::params;
/// Request-local verification work, shared across historical tree sections.
#[derive(Clone, Copy, Default)]
pub(crate) struct FindWork {
    documents: u32,
    bytes: u64,
    stopped: bool,
}
impl FindWork {
    pub(crate) fn admit(&mut self, bytes: u64) -> bool {
        // One oversized first document still makes forward progress, as before.
        if self.documents == 64
            || (self.documents > 0 && self.bytes.saturating_add(bytes) > 16 * 1024 * 1024)
        {
            self.stopped = true;
            return false;
        }
        self.documents += 1;
        self.bytes = self.bytes.saturating_add(bytes);
        true
    }
    pub(crate) fn stopped(self) -> bool {
        self.stopped
    }
}
pub struct Find {
    pub after: Option<RowPosition>,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_internal: bool,
}
pub struct Found {
    pub position: RowPosition,
    pub field: Field,
    pub preview: String,
}
pub struct FindPage {
    pub matches: Vec<Found>,
    pub next_after: Option<RowPosition>,
}
pub struct Landmark {
    pub turn_id: String,
    pub position: RowPosition,
    pub last_position: RowPosition,
    pub label: String,
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
}
pub(super) struct ReadFind(
    pub RecallStore,
    pub HistoryCut,
    pub Find,
    pub CancellationToken,
);
impl Query for ReadFind {
    type Output = FindPage;
    fn execute(self, c: &Connection) -> Result<FindPage, StoreError> {
        let Self(store, cut, input, stop) = self;
        check(&stop)?;
        query::checked_cut(c, &store, &cut)?;
        let mut work = FindWork::default();
        find_index(c, &store.key()?, &cut, input, &stop, 0, &mut work).map(|(page, _)| page)
    }
}
/// Callers validate their own real scoped cut before entering this shared index.
pub(crate) fn find_index(
    c: &Connection,
    owner_key: &str,
    cut: &HistoryCut,
    input: Find,
    stop: &CancellationToken,
    min_admission: u64,
    work: &mut FindWork,
) -> Result<(FindPage, Option<RowPosition>), StoreError> {
    if input.query.is_empty()
        || input
            .after
            .is_some_and(|p| p.source_sequence > cut.through_sequence)
    {
        return Err(invalid("invalid history search"));
    }
    let escaped = regex::escape(&input.query);
    let pattern = if input.whole_word {
        format!(r"\b{{start-half}}{escaped}\b{{end-half}}")
    } else {
        escaped
    };
    let matcher = RegexBuilder::new(&pattern)
        .case_insensitive(!input.case_sensitive)
        .build()
        .map_err(|e| invalid(e.to_string()))?;
    if let Some(after) = input.after {
        let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?)",params![owner_key,cut.session,number(after.source_sequence)?,number(after.item_index)?],|r|r.get(0))?;
        if !exists {
            return Err(invalid(
                "history search cursor is not an indexed source row",
            ));
        }
    }
    let after = input.after.unwrap_or(RowPosition {
        source_sequence: 0,
        item_index: 0,
    });
    // Fetch headers before bodies, keeping one oversized source from multiplying
    // memory with the next 64 sources. The first row may itself exceed the budget.
    let visible = if input.include_internal {
        ""
    } else {
        " AND d.internal=0"
    };
    let headers:Vec<(i64,i64,i64)>=c.prepare_cached(&format!("SELECT d.sequence,d.ordinal,length(CAST(d.body AS BLOB)) FROM agent_recall_messages d JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence WHERE d.owner=? AND d.session=? AND d.sequence<=? AND (d.sequence,d.ordinal)>(?,?) AND h.admission_sequence>?{visible} AND d.role<>'\"compaction\"' ORDER BY d.sequence,d.ordinal LIMIT 65"))?.query_map(params![owner_key,cut.session,number(cut.through_sequence)?,number(after.source_sequence)?,number(after.item_index)?,number(min_admission)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
    let mut matches = vec![];
    let mut next_after = None;
    let mut position = input.after;
    let sql = format!(
        "SELECT {} FROM agent_recall_messages d WHERE d.owner=? AND d.session=? AND d.sequence=? AND d.ordinal=?",
        query::COLUMNS
    );
    let mut statement = c.prepare_cached(&sql)?;
    for (sequence, ordinal, size) in headers {
        check(stop)?;
        let size = unsigned(size)?;
        if matches.len() == 16 || !work.admit(size) {
            next_after = position;
            break;
        }
        let locator = RowPosition {
            source_sequence: unsigned(sequence)?,
            item_index: unsigned(ordinal)?,
        };
        let mut rows = statement.query(params![owner_key, cut.session, sequence, ordinal])?;
        let message = query::read_message(rows.next()?.ok_or(StoreError::EventConflict)?)?;
        position = Some(locator);
        for span in message.fields {
            if span.internal && !input.include_internal {
                continue;
            }
            let text = message.body.get(span.start..span.end).ok_or_else(|| {
                invalid("Recall source field span corrupt; explicit rebuild required")
            })?;
            if let Some(preview) = preview(text, &matcher) {
                matches.push(Found {
                    position: locator,
                    field: span.field,
                    preview,
                });
                break;
            }
        }
    }
    check(stop)?;
    Ok((
        FindPage {
            matches,
            next_after,
        },
        position,
    ))
}

fn preview(value: &str, matcher: &Regex) -> Option<String> {
    let found = matcher.find(value)?.start();
    let start = value.floor_char_boundary(found.saturating_sub(64));
    let end = value.floor_char_boundary(start.saturating_add(378).min(value.len()));
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(
        value[start..end]
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c }),
    );
    if end < value.len() {
        out.push('…');
    }
    Some(out)
}
pub(super) struct ReadLandmarks(
    pub RecallStore,
    pub HistoryCut,
    pub u32,
    pub CancellationToken,
);
impl Query for ReadLandmarks {
    type Output = Vec<Landmark>;
    fn execute(self, c: &Connection) -> Result<Vec<Landmark>, StoreError> {
        let Self(store, cut, limit, stop) = self;
        check(&stop)?;
        if !(1..=64).contains(&limit) {
            return Err(invalid("landmark limit must be 1..=64"));
        }
        query::checked_cut(c, &store, &cut)?;
        landmarks_index(c, &store.key()?, &cut, limit, &stop, 0)
    }
}
pub(crate) fn landmarks_index(
    c: &Connection,
    owner_key: &str,
    cut: &HistoryCut,
    limit: u32,
    stop: &CancellationToken,
    min_admission: u64,
) -> Result<Vec<Landmark>, StoreError> {
    landmarks_selected_index(c, owner_key, cut, limit, stop, min_admission, None)
}
pub(crate) fn landmarks_selected_index(
    c: &Connection,
    owner_key: &str,
    cut: &HistoryCut,
    limit: u32,
    stop: &CancellationToken,
    min_admission: u64,
    ranks: Option<&[u64]>,
) -> Result<Vec<Landmark>, StoreError> {
    check(stop)?;
    if !(1..=64).contains(&limit) {
        return Err(invalid("landmark limit must be 1..=64"));
    }
    let sql = "WITH grouped AS(SELECT turn,MIN(CASE WHEN d.role='\"user\"' AND d.origin_json IS NULL THEN sequence END) AS first,MAX(sequence) AS last FROM agent_recall_messages d WHERE owner=?1 AND session=?2 AND sequence<=?3 AND d.internal=0 AND EXISTS(SELECT 1 FROM agent_session_history h WHERE h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence AND h.admission_sequence>?5) GROUP BY turn HAVING first IS NOT NULL), ranked AS(SELECT *,row_number() OVER(ORDER BY first,turn)-1 AS ordinal,count(*) OVER() AS total FROM grouped),sampled AS(SELECT * FROM ranked WHERE (?6 IS NULL AND (total<=?4 OR ordinal=0 OR ordinal=total-1 OR (ordinal*(?4-1)/(total-1))<>((ordinal-1)*(?4-1)/(total-1)))) OR ordinal IN(SELECT value FROM json_each(?6)) ORDER BY first,turn LIMIT ?4) SELECT turn,first,last FROM sampled";
    let mut statement = c.prepare_cached(sql)?;
    let mut rows = statement.query(params![
        owner_key,
        cut.session,
        number(cut.through_sequence)?,
        i64::from(limit),
        number(min_admission)?,
        ranks.map(serde_json::to_string).transpose()?
    ])?;
    let mut out = vec![];
    while let Some(row) = rows.next()? {
        check(stop)?;
        let turn: String = row.get(0)?;
        let first: i64 = row.get(1)?;
        let last: i64 = row.get(2)?;
        let (ordinal,body,origin):(i64,String,Option<String>)=c.query_row("SELECT ordinal,substr(body,1,96),origin_json FROM agent_recall_messages WHERE owner=? AND session=? AND turn=? AND sequence=? AND internal=0 AND role='\"user\"' AND origin_json IS NULL ORDER BY ordinal LIMIT 1",params![owner_key,cut.session,turn,first],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let last_ordinal:i64=c.query_row("SELECT MAX(ordinal) FROM agent_recall_messages WHERE owner=? AND session=? AND turn=? AND sequence=? AND internal=0",params![owner_key,cut.session,turn,last],|r|r.get(0))?;
        let end = body.floor_char_boundary(body.len().min(96));
        let label = body[..end]
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        out.push(Landmark {
            turn_id: turn,
            position: RowPosition {
                source_sequence: unsigned(first)?,
                item_index: unsigned(ordinal)?,
            },
            last_position: RowPosition {
                source_sequence: unsigned(last)?,
                item_index: unsigned(last_ordinal)?,
            },
            label,
            origin: origin.map(|s| serde_json::from_str(&s)).transpose()?,
        });
    }
    check(stop)?;
    Ok(out)
}

pub(super) struct ReadPositions(
    pub RecallStore,
    pub HistoryCut,
    pub Option<RowPosition>,
    pub bool,
    pub bool,
    pub u32,
    pub CancellationToken,
);
impl Query for ReadPositions {
    type Output = Vec<RowPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Self(store, cut, anchor, reverse, include_internal, limit, stop) = self;
        check(&stop)?;
        query::checked_cut(c, &store, &cut)?;
        if !(1..=256).contains(&limit)
            || anchor.is_some_and(|p| p.source_sequence > cut.through_sequence)
        {
            return Err(invalid("invalid indexed history window"));
        }
        if let Some(anchor) = anchor {
            let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?)",params![store.key()?,cut.session,number(anchor.source_sequence)?,number(anchor.item_index)?],|r|r.get(0))?;
            if !exists {
                return Err(invalid("history window anchor is not a source row"));
            }
        }
        let (comparison, order) = if reverse {
            ("<=", "DESC")
        } else {
            (">=", "ASC")
        };
        let bound = anchor.unwrap_or(if reverse {
            RowPosition {
                source_sequence: cut.through_sequence,
                item_index: u64::try_from(i64::MAX).expect("positive maximum"),
            }
        } else {
            RowPosition {
                source_sequence: 0,
                item_index: 0,
            }
        });
        let visible = if include_internal {
            ""
        } else {
            "AND d.internal=0"
        };
        let mut statement=c.prepare_cached(&format!("SELECT d.sequence,d.ordinal FROM agent_recall_messages d WHERE d.owner=? AND d.session=? AND d.sequence<=? AND (d.sequence,d.ordinal){comparison}(?,?) {visible} ORDER BY d.sequence {order},d.ordinal {order} LIMIT ?"))?;
        let mut rows = statement.query(params![
            store.key()?,
            cut.session,
            number(cut.through_sequence)?,
            number(bound.source_sequence)?,
            number(bound.item_index)?,
            i64::from(limit)
        ])?;
        let mut positions = vec![];
        while let Some(row) = rows.next()? {
            check(&stop)?;
            positions.push(RowPosition {
                source_sequence: unsigned(row.get(0)?)?,
                item_index: unsigned(row.get(1)?)?,
            });
        }
        Ok(positions)
    }
}

pub(crate) fn landmarks_count_index(
    c: &Connection,
    owner_key: &str,
    cut: &HistoryCut,
    min_admission: u64,
) -> Result<u64, StoreError> {
    let count:i64=c.query_row("SELECT COUNT(*) FROM(SELECT d.turn FROM agent_recall_messages d JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence WHERE d.owner=? AND d.session=? AND d.sequence<=? AND h.admission_sequence>? AND d.internal=0 AND d.role='\"user\"' AND d.origin_json IS NULL GROUP BY d.turn)",params![owner_key,cut.session,number(cut.through_sequence)?,number(min_admission)?],|r|r.get(0))?;
    unsigned(count)
}
pub(crate) fn landmark_ranks(total: u64, limit: u32) -> Vec<u64> {
    if total <= u64::from(limit) {
        return (0..total).collect();
    }
    if limit == 1 {
        return vec![0];
    }
    (0..u64::from(limit))
        .map(|i| {
            ((u128::from(i) * u128::from(total - 1) + u128::from(limit - 2))
                / u128::from(limit - 1)) as u64
        })
        .collect()
}
