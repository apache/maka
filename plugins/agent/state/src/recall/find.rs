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
use rusqlite::{ToSql, params, params_from_iter};

const FIND_BATCH: u32 = 64;
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
        if self.documents == FIND_BATCH
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
        find_index(c, &store.key()?, &cut, input, &stop, 0, None, &mut work).map(|(page, _)| page)
    }
}
/// Callers validate their own real scoped cut before entering this shared index.
#[expect(
    clippy::too_many_arguments,
    reason = "The verified section cut, reader and shared work budget come from the enclosing history search"
)]
pub(crate) fn find_index(
    c: &Connection,
    owner_key: &str,
    cut: &HistoryCut,
    input: Find,
    stop: &CancellationToken,
    min_admission: u64,
    reader: Option<&RunOwner>,
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
    // Wide global postings cost more than walking a session's ordered rows.
    let candidate_ids = if input.after.is_none()
        && let Some(expression) = terms::find_expression(&input.query, input.case_sensitive)
    {
        let mut statement = c.prepare_cached(
            "SELECT rowid FROM agent_recall_terms WHERE agent_recall_terms MATCH ? LIMIT ?",
        )?;
        let ids = statement
            .query_map(params![expression, FIND_BATCH + 1], |row| {
                row.get::<_, i64>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if ids.is_empty() {
            check(stop)?;
            return Ok((
                FindPage {
                    matches: Vec::new(),
                    next_after: None,
                },
                None,
            ));
        }
        (ids.len() <= FIND_BATCH as usize).then_some(ids)
    } else {
        None
    };
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
    let source = if candidate_ids.is_some() {
        "json_each(?8) candidate CROSS JOIN agent_recall_messages d ON d.id=candidate.value"
    } else {
        "agent_recall_messages d"
    };
    let mut statement = c.prepare_cached(&format!(
        "SELECT d.sequence,d.ordinal,octet_length(d.body),h.fact_id FROM {source}
         CROSS JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence
         WHERE d.owner=?1 AND d.session=?2 AND d.sequence<=?3 AND (d.sequence,d.ordinal)>(?4,?5)
           AND h.admission_sequence>?6{visible} AND d.role<>'\"compaction\"'
         ORDER BY d.sequence,d.ordinal LIMIT ?7"
    ))?;
    let encoded = candidate_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let bounds = params![
        owner_key,
        cut.session,
        number(cut.through_sequence)?,
        number(after.source_sequence)?,
        number(after.item_index)?,
        number(min_admission)?,
        FIND_BATCH + 1
    ];
    let headers = statement
        .query_map(
            params_from_iter(
                bounds
                    .iter()
                    .copied()
                    .chain(encoded.as_ref().map(|ids| ids as &dyn ToSql)),
            ),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let restrictions = if let Some(owner) = reader {
        use maka_agent_facts::history::HistoryRowAddress;
        let addresses = headers
            .iter()
            .map(|(sequence, ordinal, _, fact)| {
                Ok(HistoryRowAddress::Live {
                    sequence: unsigned(*sequence)?,
                    item_index: unsigned(*ordinal)?,
                    fact: serde_json::from_value(serde_json::Value::String(fact.clone()))?,
                })
            })
            .collect::<Result<_, StoreError>>()?;
        crate::memory::recall::ReadRestrictions {
            owner: owner.clone(),
            addresses,
        }
        .by_index(c)?
    } else {
        BTreeMap::new()
    };
    let mut matches = vec![];
    let mut next_after = None;
    let mut position = input.after;
    let mut statement = c.prepare_cached(
        "SELECT body,fields_json FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?",
    )?;
    for (index, (sequence, ordinal, size, _)) in headers.into_iter().enumerate() {
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
        let row = rows.next()?.ok_or(StoreError::EventConflict)?;
        let mut body: String = row.get(0)?;
        let fields: Vec<FieldSpan> = serde_json::from_str(&row.get::<_, String>(1)?)?;
        position = Some(locator);
        if let Some(spans) = restrictions.get(&index) {
            if spans.iter().any(|&(a, b)| a == 0 && b >= body.len() as u64) {
                continue;
            }
            crate::memory::recall::mask(&mut body, 0, spans);
            if body.is_empty() {
                continue;
            }
        }
        for span in fields {
            if span.internal && !input.include_internal {
                continue;
            }
            let text = body.get(span.start..span.end).ok_or_else(|| {
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
    let sql = "WITH prompts AS (
        SELECT d.turn, MIN(d.sequence) AS first
        FROM agent_recall_messages d
        WHERE d.owner=?1 AND d.session=?2 AND d.sequence<=?3 AND d.internal=0
          AND d.role='\"user\"' AND d.origin_json IS NULL
          AND EXISTS(SELECT 1 FROM agent_session_history h
                     WHERE h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence
                       AND h.admission_sequence>?5)
        GROUP BY d.turn
    ), ranked AS (
        SELECT *, row_number() OVER(ORDER BY first,turn)-1 AS ordinal, count(*) OVER() AS total
        FROM prompts
    ), sampled AS (
        SELECT * FROM ranked
        WHERE (?6 IS NULL AND (total<=?4 OR ordinal=0 OR ordinal=total-1
               OR (ordinal*(?4-1)/(total-1))<>((ordinal-1)*(?4-1)/(total-1))))
           OR ordinal IN(SELECT value FROM json_each(?6))
        ORDER BY first,turn LIMIT ?4
    )
    SELECT s.turn, s.first, (
        SELECT d.sequence FROM agent_recall_messages d INDEXED BY agent_recall_turn
        WHERE d.owner=?1 AND d.session=?2 AND d.turn=s.turn AND d.sequence<=?3 AND d.internal=0
          AND EXISTS(SELECT 1 FROM agent_session_history h
                     WHERE h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence
                       AND h.admission_sequence>?5)
        ORDER BY d.sequence DESC LIMIT 1
    )
    FROM sampled s ORDER BY s.first,s.turn";
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
        let label = landmark_label(&body);
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
