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
//! Indexed coordinates and bounded verification over derived UTF-8 chunks.
use super::*;
use regex::{Regex, RegexBuilder};
const POSITION_JSON: &str = "CASE WHEN p.kind='canonical' THEN json_object('kind','canonical','run',p.run,'sequence',p.major,'admission_sequence',p.admission_sequence,'fact',p.fact,'item_index',p.minor,'internal',json(CASE p.internal WHEN 1 THEN 'true' ELSE 'false' END)) ELSE json_object('kind','imported','message_ordinal',p.major,'part_ordinal',p.minor,'internal',json(CASE p.internal WHEN 1 THEN 'true' ELSE 'false' END)) END";
#[derive(Clone)]
pub(in crate::session_history) struct FindInput {
    pub after: Option<(u64, u64)>,
    pub min_admission: u64,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_internal: bool,
    pub work: crate::recall::FindWork,
}
pub(in crate::session_history) struct LocalFound {
    pub row: SnapshotPosition,
    pub field: Field,
    pub preview: String,
}
pub(in crate::session_history) struct LocalFindPage {
    pub matches: Vec<LocalFound>,
    pub next_after: Option<SnapshotPosition>,
    pub last_processed: Option<SnapshotPosition>,
    pub work: crate::recall::FindWork,
}
pub(in crate::session_history) struct LocalLandmark {
    pub turn_id: Option<String>,
    pub imported_turn: Option<ImportedTurnOrdinal>,
    pub position: SnapshotPosition,
    pub last_position: SnapshotPosition,
    pub label: String,
    pub origin: Option<MessageOrigin>,
}
impl Snapshot {
    pub(in crate::session_history) async fn navigation_find(
        &self,
        input: FindInput,
        stop: CancellationToken,
    ) -> Result<LocalFindPage, StoreError> {
        self.data.query(FindQuery(self.clone(), input, stop)).await
    }
    pub(in crate::session_history) async fn navigation_landmark_count(
        &self,
        min_admission: u64,
    ) -> Result<u64, StoreError> {
        self.data
            .query(LandmarkCount(self.clone(), min_admission))
            .await
    }
    pub(in crate::session_history) async fn navigation_landmarks(
        &self,
        min_admission: u64,
        ranks: Vec<u64>,
        stop: CancellationToken,
    ) -> Result<Vec<LocalLandmark>, StoreError> {
        self.data
            .query(LandmarkQuery(self.clone(), min_admission, ranks, stop))
            .await
    }
}
struct FindQuery(Snapshot, FindInput, CancellationToken);
impl Query for FindQuery {
    type Output = LocalFindPage;
    fn execute(self, c: &Connection) -> Result<LocalFindPage, StoreError> {
        let Self(snapshot, input, stop) = self;
        check(&stop)?;
        require_ready(c, &snapshot)?;
        if input.query.is_empty() {
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
        let (major, minor) = input
            .after
            .map(|(a, b)| Ok::<_, StoreError>((bind_u64(a)?, bind_u64(b)?)))
            .transpose()?
            .unwrap_or((-1, -1));
        if let Some((major, minor)) = input.after {
            let found:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_positions WHERE snapshot=? AND major=? AND minor=?)",params![snapshot.id.to_string(),bind_u64(major)?,bind_u64(minor)?],|r|r.get(0))?;
            if !found {
                return Err(invalid("source search cursor is not an indexed row"));
            }
        }
        // Literal raw grams are safe only for exact-case pruning. Unicode regex simple
        // folding is not NFC/lowercase; that path verifies a bounded indexed range.
        let grams = if input.case_sensitive {
            Some(crate::recall::terms::expression(&[input
                .query
                .chars()
                .take(3)
                .collect::<String>()]))
        } else {
            None
        };
        let visible = if input.include_internal {
            ""
        } else {
            " AND p.internal=0"
        };
        let fields_visible = if input.include_internal {
            ""
        } else {
            " AND f.internal=0"
        };
        let mut sql = format!(
            "SELECT d.id,{POSITION_JSON},COALESCE((SELECT SUM(f.bytes) FROM agent_history_snapshot_nav_fields f WHERE f.document=d.id{fields_visible}),0) FROM agent_history_snapshot_nav_documents d JOIN agent_history_snapshot_positions p ON p.snapshot=d.snapshot AND p.kind=d.kind AND p.major=d.major AND p.minor=d.minor WHERE d.snapshot=?1 AND (d.major,d.minor)>(?2,?3) AND (p.kind='imported' OR p.admission_sequence>?4){visible} AND d.role<>'\"compaction\"'",
        );
        if grams.is_some() {
            sql.push_str(&format!(" AND EXISTS(SELECT 1 FROM agent_history_snapshot_nav_chunks k JOIN agent_history_snapshot_nav_fields f ON f.document=k.document AND f.ordinal=k.field_ordinal JOIN agent_history_snapshot_nav_terms t ON t.rowid=k.id WHERE k.document=d.id{fields_visible} AND agent_history_snapshot_nav_terms MATCH ?5)"));
        }
        sql.push_str(" ORDER BY d.kind,d.major,d.minor LIMIT 65");
        let mut statement = c.prepare_cached(&sql)?;
        let headers = if let Some(grams) = grams {
            statement
                .query_map(
                    params![
                        snapshot.id.to_string(),
                        major,
                        minor,
                        bind_u64(input.min_admission)?,
                        grams
                    ],
                    header,
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(
                    params![
                        snapshot.id.to_string(),
                        major,
                        minor,
                        bind_u64(input.min_admission)?
                    ],
                    header,
                )?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut matches = Vec::new();
        let mut processed = 0;
        let mut work = input.work;
        let mut last = None;
        for (id, raw, bytes) in &headers {
            check(&stop)?;
            let row: SnapshotPosition = serde_json::from_str(raw)?;
            let bytes =
                u64::try_from(*bytes).map_err(|_| invalid("negative derived field bytes"))?;
            if !work.admit(bytes) {
                break;
            }
            let fields=c.prepare_cached(&format!("SELECT f.ordinal,f.field FROM agent_history_snapshot_nav_fields f WHERE f.document=?{fields_visible} ORDER BY f.ordinal"))?.query_map([id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            for (ordinal, field) in fields {
                if let Some(preview) = search_field(c, *id, ordinal, &matcher, &input.query, &stop)?
                {
                    matches.push(LocalFound {
                        row: row.clone(),
                        field: serde_json::from_str(&field)?,
                        preview,
                    });
                    break;
                }
            }
            processed += 1;
            last = Some(row);
            if matches.len() == 16 {
                break;
            }
        }
        let next_after = if processed < headers.len() {
            last.clone()
        } else {
            None
        };
        Ok(LocalFindPage {
            matches,
            next_after,
            last_processed: last,
            work,
        })
    }
}
fn header(r: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, String, i64)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
}
fn search_field(
    c: &Connection,
    document: i64,
    field: i64,
    matcher: &Regex,
    query: &str,
    stop: &CancellationToken,
) -> Result<Option<String>, StoreError> {
    let expected: i64 = c.query_row(
        "SELECT bytes FROM agent_history_snapshot_nav_fields WHERE document=? AND ordinal=?",
        params![document, field],
        |r| r.get(0),
    )?;
    let expected = u64::try_from(expected).map_err(|_| invalid("negative field byte count"))?;
    let keep = query
        .chars()
        .count()
        .checked_mul(4)
        .and_then(|n| n.checked_add(448))
        .ok_or_else(|| invalid("search query size overflow"))?;
    let mut ordinal = 0i64;
    let mut window = String::new();
    let mut offset = 0u64;
    loop {
        check(stop)?;
        let chunk=c.query_row("SELECT body FROM agent_history_snapshot_nav_chunks WHERE document=? AND field_ordinal=? AND ordinal=?",params![document,field,ordinal],|r|r.get::<_,String>(0)).optional()?;
        if let Some(chunk) = chunk {
            window.push_str(&chunk);
        } else if offset + window.len() as u64 != expected {
            return Err(invalid(
                "derived document chunk is missing; rebuild required",
            ));
        }
        let eof = offset + window.len() as u64 == expected;
        let start = if offset > 0 {
            window.chars().next().map_or(0, char::len_utf8)
        } else {
            0
        };
        if let Some(found) = matcher.find_at(&window, start)
            && (eof
                || (found.end().saturating_add(4) <= window.len()
                    && found.start().saturating_add(378) <= window.len()))
        {
            let begin = window.floor_char_boundary(found.start().saturating_sub(64));
            let end = window.floor_char_boundary((begin + 378).min(window.len()));
            let mut preview = String::new();
            if offset > 0 || begin > 0 {
                preview.push('…');
            }
            preview.extend(
                window[begin..end]
                    .chars()
                    .map(|c| if c.is_control() { ' ' } else { c }),
            );
            if !eof || end < window.len() {
                preview.push('…');
            }
            return Ok(Some(preview));
        }
        if eof {
            return Ok(None);
        }
        if window.len() > keep {
            let begin = window.floor_char_boundary(window.len() - keep);
            window.drain(..begin);
            offset = offset
                .checked_add(begin as u64)
                .ok_or_else(|| invalid("field offset overflow"))?;
        }
        ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| invalid("chunk ordinal overflow"))?;
    }
}
struct LandmarkQuery(Snapshot, u64, Vec<u64>, CancellationToken);
impl Query for LandmarkQuery {
    type Output = Vec<LocalLandmark>;
    fn execute(self, c: &Connection) -> Result<Vec<LocalLandmark>, StoreError> {
        let Self(snapshot, min_admission, ranks, stop) = self;
        check(&stop)?;
        require_ready(c, &snapshot)?;
        if ranks.is_empty() || ranks.len() > 64 {
            return Err(invalid("invalid landmarks limit"));
        }
        let sql = format!(
            "WITH visible AS (SELECT d.*,{POSITION_JSON} AS position_json,ROW_NUMBER() OVER(PARTITION BY d.kind,CASE WHEN d.kind='canonical' THEN d.turn ELSE NULL END,d.turn_ordinal ORDER BY (d.role='\"user\"' AND d.origin_json IS NULL) DESC,d.major,d.minor) AS first_rank,ROW_NUMBER() OVER(PARTITION BY d.kind,CASE WHEN d.kind='canonical' THEN d.turn ELSE NULL END,d.turn_ordinal ORDER BY d.major DESC,d.minor DESC) AS last_rank FROM agent_history_snapshot_nav_documents d JOIN agent_history_snapshot_positions p ON p.snapshot=d.snapshot AND p.kind=d.kind AND p.major=d.major AND p.minor=d.minor WHERE d.snapshot=?1 AND p.internal=0 AND (p.kind='imported' OR p.admission_sequence>?2)), grouped AS(SELECT a.turn,a.turn_ordinal,a.position_json AS first_position,b.position_json AS last_position,a.label,a.origin_json,a.kind,a.major,a.minor FROM visible a JOIN visible b ON b.kind=a.kind AND (a.kind='imported' OR b.turn IS a.turn) AND b.turn_ordinal IS a.turn_ordinal AND b.last_rank=1 WHERE a.first_rank=1 AND a.role='\"user\"' AND a.origin_json IS NULL), ranked AS(SELECT *,ROW_NUMBER() OVER(ORDER BY kind,major,minor)-1 AS ordinal,COUNT(*) OVER() AS total FROM grouped) SELECT turn,turn_ordinal,first_position,last_position,label,origin_json FROM ranked WHERE ordinal IN(SELECT value FROM json_each(?3)) ORDER BY kind,major,minor LIMIT 64"
        );
        let rows = c
            .prepare_cached(&sql)?
            .query_map(
                params![
                    snapshot.id.to_string(),
                    bind_u64(min_admission)?,
                    serde_json::to_string(&ranks)?
                ],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(turn_id, ordinal, first, last, label, origin)| {
                check(&stop)?;
                Ok(LocalLandmark {
                    turn_id,
                    imported_turn: ordinal
                        .map(|v| {
                            u64::try_from(v)
                                .map(ImportedTurnOrdinal)
                                .map_err(|_| invalid("negative imported turn ordinal"))
                        })
                        .transpose()?,
                    position: serde_json::from_str(&first)?,
                    last_position: serde_json::from_str(&last)?,
                    label,
                    origin: origin.map(|v| serde_json::from_str(&v)).transpose()?,
                })
            })
            .collect()
    }
}

struct LandmarkCount(Snapshot, u64);
impl Query for LandmarkCount {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        require_ready(c, &self.0)?;
        let count:i64=c.query_row("SELECT COUNT(*) FROM(SELECT d.kind,CASE WHEN d.kind='canonical' THEN d.turn ELSE NULL END,d.turn_ordinal FROM agent_history_snapshot_nav_documents d JOIN agent_history_snapshot_positions p ON p.snapshot=d.snapshot AND p.kind=d.kind AND p.major=d.major AND p.minor=d.minor WHERE d.snapshot=? AND p.internal=0 AND d.role='\"user\"' AND d.origin_json IS NULL AND (p.kind='imported' OR p.admission_sequence>?) GROUP BY d.kind,CASE WHEN d.kind='canonical' THEN d.turn ELSE NULL END,d.turn_ordinal)",params![self.0.id.to_string(),bind_u64(self.1)?],|r|r.get(0))?;
        u64::try_from(count).map_err(|_| invalid("negative source turn count"))
    }
}
