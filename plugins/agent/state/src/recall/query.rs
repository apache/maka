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
use rusqlite::{OptionalExtension, params};
use std::cmp::Ordering;
const ORIGINAL: &str = "CROSS JOIN agent_namespaces ns ON ns.id=d.namespace_id
 LEFT JOIN agent_session_history h ON h.sequence=d.sequence
 AND h.namespace_id=d.namespace_id AND h.run=d.run";
// The Recall index also serves original history. Only shareable checkpoints may
// contribute an anchor or adjacent text to a different model conversation.
const SHARED_CONTEXT: &str = r#"CASE WHEN d.role='"compaction"' THEN EXISTS (
 SELECT 1 FROM contents b WHERE b.content_sha256=d.references_json->>'$[1].digest' AND
 (maka_content_text(b.payload,b.encoding)->>'memoryReplay'='shared' OR NOT EXISTS (
  SELECT 1 FROM agent_memory_tool_inputs i
  WHERE i.run=coalesce(maka_content_text(b.payload,b.encoding)->>'$.memoryReplay.run',maka_content_text(b.payload,b.encoding)->>'$.summaryOrigin.run',d.run)
 ))) ELSE 1 END"#;
const COLUMNS: &str = concat!(
    "d.message,d.sequence,d.ordinal,d.run,d.turn,d.at,d.role,d.body,d.attachments,d.references_json,d.fields_json,d.origin_json,
 (SELECT json_group_array(json_array(start,end)) FROM (",
    crate::memory::recall::restricted_spans_sql!(
        "SELECT s.start,s.end FROM",
        "s.namespace=ns.owner AND s.fact=h.fact_id AND s.ordinal=d.ordinal",
    ),
    ")),
 EXISTS(SELECT 1 FROM agent_memory_recall_outputs r WHERE r.owner=ns.owner AND r.fact=h.fact_id),
 h.fact_id,d.body_ref_sequence,d.body_ref_start,d.body_ref_end,d.namespace_id"
);
pub(super) fn read_message(c: &Connection, row: &rusqlite::Row<'_>) -> Result<Message, StoreError> {
    let get = |i| -> Result<String, StoreError> { Ok(row.get(i)?) };
    let sequence = unsigned(row.get(1)?)?;
    let fields: Vec<FieldSpan> = serde_json::from_str(&get(10)?)?;
    let mut body: String = row.get(7)?;
    let mut attachments = serde_json::from_str(&get(8)?)?;
    if row.get::<_, bool>(13)? {
        body.clear();
        attachments = vec![];
    } else {
        if let Some(ref_seq) = row.get::<_, Option<i64>>(15)? {
            let ref_start: Option<i64> = row.get(16)?;
            let ref_end: Option<i64> = row.get(17)?;
            let ns_id: crate::namespace::NamespaceId = row.get(18)?;
            body = index::resolve_body_ref(c, ns_id, sequence, ref_seq, ref_start, ref_end)?;
        }
        if let spans = row.get::<_, String>(12)?
            && spans != "[]"
        {
            crate::memory::recall::mask(&mut body, 0, &serde_json::from_str::<Vec<_>>(&spans)?);
            attachments = vec![];
        }
    }
    Ok(Message {
        fact: serde_json::from_value(serde_json::Value::String(get(14)?))?,
        message_id: get(0)?,
        position: RowPosition {
            source_sequence: sequence,
            item_index: unsigned(row.get(2)?)?,
        },
        run: serde_json::from_value(serde_json::Value::String(get(3)?))?,
        turn_id: get(4)?,
        timestamp: unsigned(row.get(5)?)?,
        role: serde_json::from_str(&get(6)?)?,
        body,
        attachments,
        references: serde_json::from_str(&get(9)?)?,
        fields,
        origin: row
            .get::<_, Option<String>>(11)?
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
    })
}

fn unsealed_message_from_header(
    c: &Connection,
    owner: &str,
    ns_id: crate::namespace::NamespaceId,
    header: &index::ExternalSegmentHeader,
    since: Option<u64>,
    until: Option<u64>,
) -> Result<Option<Message>, StoreError> {
    if since.is_some_and(|s| header.tail_end_at < s)
        || until.is_some_and(|u| header.tail_start_at > u)
    {
        return Ok(None);
    }
    let fact_str = header.fact.to_string();
    let tail_end_fact_str = header.tail_end_fact.to_string();
    let (spans_json, recall_redacted): (String, bool) = c.query_row(
        concat!(
            "SELECT (SELECT json_group_array(json_array(start,end)) FROM (",
            crate::memory::recall::restricted_spans_sql!(
                "SELECT s.start,s.end FROM",
                "s.namespace=?1 AND s.fact IN (?2, ?3) AND s.ordinal=0",
            ),
            ")), EXISTS(SELECT 1 FROM agent_memory_recall_outputs r WHERE r.owner=?1 AND r.fact IN (?2, ?3))"
        ),
        params![owner, fact_str, tail_end_fact_str],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let restrictions: Vec<(u64, u64)> = if !recall_redacted && spans_json != "[]" {
        serde_json::from_str(&spans_json)?
    } else {
        Vec::new()
    };
    let Some(mut delta) =
        index::hydrate_external_segment(c, ns_id, header, since, until, &restrictions)?
    else {
        return Ok(None);
    };
    if recall_redacted {
        delta.body.clear();
    }
    let end = delta.body.len();
    Ok(Some(Message {
        fact: delta.fact,
        message_id: fact_str,
        position: RowPosition {
            source_sequence: delta.sequence,
            item_index: 0,
        },
        run: delta.run,
        turn_id: delta.turn_id,
        timestamp: delta.timestamp,
        role: Role::Assistant,
        body: delta.body,
        attachments: vec![],
        references: vec![delta.reference],
        fields: vec![FieldSpan {
            field: if delta.is_thinking {
                Field::Thinking
            } else {
                Field::Body
            },
            start: 0,
            end,
            internal: delta.is_thinking,
        }],
        origin: None,
    }))
}

fn visible_unsealed_segments(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    session: &str,
    through: u64,
    exclude: Option<&ExcludedTail>,
) -> Result<Vec<index::ExternalSegmentHeader>, StoreError> {
    let mut out: Vec<index::ExternalSegmentHeader> =
        index::unsealed_external_segment_headers(c, ns_id, through, 0)?
            .into_iter()
            .filter(|seg| !is_excluded(exclude, session, &seg.turn_id, seg.sequence))
            .collect();
    if let Some(excl) = exclude
        && excl.session_id == session
        && excl.covered_through < through
    {
        for seg in index::unsealed_external_segment_headers(c, ns_id, excl.covered_through, 0)? {
            if seg.turn_id == excl.turn_id
                && !out.iter().any(|existing| existing.sequence == seg.sequence)
            {
                out.push(seg);
            }
        }
    }
    Ok(out)
}

fn is_excluded(
    exclude: Option<&ExcludedTail>,
    session: &str,
    turn_id: &str,
    sequence: u64,
) -> bool {
    exclude.is_some_and(|excl| {
        excl.session_id == session && excl.turn_id == turn_id && sequence > excl.covered_through
    })
}
pub(super) fn checked_cut(
    c: &Connection,
    store: &RecallStore,
    cut: &HistoryCut,
) -> Result<(), StoreError> {
    store.session(&cut.session)?;
    checked_source_cut(c, &store.owner, cut)
}
pub(crate) fn checked_source_cut(
    c: &Connection,
    namespace: &RunOwner,
    cut: &HistoryCut,
) -> Result<(), StoreError> {
    crate::session_history::validate_cut(c, namespace, &cut.session, cut)?;
    let owner = serde_json::to_string(namespace)?;
    if cut.through_sequence > 0 {
        let indexed: Option<(i64, String)> = c
            .query_row(
                "SELECT sequence,digest FROM agent_recall_heads WHERE owner=? AND session=?",
                params![owner, cut.session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (sequence, digest) = indexed
            .filter(|(sequence, _)| {
                *sequence >= number(cut.through_sequence).expect("validated cut range")
            })
            .ok_or_else(|| {
                invalid("Recall index is incomplete for this cut; explicit rebuild required")
            })?;
        let expected: Option<String> = match crate::namespace::find_id(c, &owner, &cut.session)? {
            Some(ns_id) => c
                .query_row(
                    "SELECT prefix_digest FROM agent_session_history WHERE namespace_id=? AND sequence=?",
                    params![ns_id, sequence],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        if expected.as_ref() != Some(&digest) {
            return Err(StoreError::EventConflict);
        }
    }
    let gap:Option<(i64,String)>=c.query_row("SELECT sequence,reason FROM agent_recall_gaps WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence LIMIT 1",params![owner,cut.session,number(cut.through_sequence)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((sequence, reason)) = gap {
        return Err(invalid(format!(
            "Recall source {sequence} unreadable: {reason}"
        )));
    }
    Ok(())
}
fn record(
    c: &Connection,
    store: &RecallStore,
    session: &str,
) -> Result<Record, crate::session_history::snapshot::IndexedReadError> {
    crate::session_catalog::records_in_snapshot(c, &store.catalog()?, &[session.to_owned()])?
        .pop()
        .ok_or_else(|| StoreError::SessionNotFound.into())
}
pub(super) fn context(
    c: &Connection,
    input: ReadContext,
) -> Result<Context, crate::session_history::snapshot::IndexedReadError> {
    let ReadContext(store, session, anchor, before, after, cut, exclude, stop) = input;
    check(&stop)?;
    store.session(&session)?;
    let cut = match cut {
        Some(cut) => cut,
        None => crate::session_history::capture_at(c, &store.owner, &session, None)?,
    };
    if cut.session != session {
        return Err(StoreError::EventConflict.into());
    }
    checked_cut(c, &store, &cut)?;
    let owner = store.key()?;
    let Some(ns_id) = crate::namespace::find_id(c, &owner, &session)? else {
        return Err(invalid("Recall anchor not visible in this exact cut").into());
    };
    let mut statement=c.prepare_cached(&format!("SELECT {COLUMNS} FROM agent_recall_messages d {ORIGINAL} WHERE d.namespace_id=? AND d.message=? AND {SHARED_CONTEXT} AND d.sequence<=? AND NOT(ns.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0))"))?;
    let mut rows = statement.query(params![
        ns_id,
        anchor,
        number(cut.through_sequence)?,
        exclude.as_ref().map(|x| x.session_id.as_str()),
        exclude.as_ref().map(|x| x.turn_id.as_str()),
        exclude
            .as_ref()
            .map(|x| number(x.covered_through))
            .transpose()?
    ])?;
    let anchor = match rows.next()? {
        Some(row) => read_message(c, row)?,
        None => {
            let found = visible_unsealed_segments(
                c,
                ns_id,
                &session,
                cut.through_sequence,
                exclude.as_ref(),
            )?
            .into_iter()
            .find(|seg| seg.fact.to_string() == anchor)
            .ok_or_else(|| invalid("Recall anchor not visible in this exact cut"))?;
            unsealed_message_from_header(c, &owner, ns_id, &found, None, None)?
                .ok_or_else(|| invalid("Recall anchor not visible in this exact cut"))?
        }
    };
    let (messages, has_more_before, has_more_after) = neighbors(
        c,
        &store,
        &cut,
        &anchor,
        ContextWindow { before, after },
        exclude.as_ref(),
        &stop,
    )?;
    Ok(Context {
        session: record(c, &store, &session)?,
        cut,
        anchor,
        messages,
        has_more_before,
        has_more_after,
    })
}
fn neighbors(
    c: &Connection,
    store: &RecallStore,
    cut: &HistoryCut,
    anchor: &Message,
    window: ContextWindow,
    exclude: Option<&ExcludedTail>,
    stop: &CancellationToken,
) -> Result<(Vec<Message>, bool, bool), StoreError> {
    let owner = store.key()?;
    let Some(ns_id) = crate::namespace::find_id(c, &owner, &cut.session)? else {
        return Ok((vec![anchor.clone()], false, false));
    };
    let seq = number(anchor.position.source_sequence)?;
    let ordinal = number(anchor.position.item_index)?;
    let mut sides = [vec![], vec![]];
    let mut more = [false, false];
    let unsealed_in_turn: Vec<index::ExternalSegmentHeader> =
        visible_unsealed_segments(c, ns_id, &cut.session, cut.through_sequence, exclude)?
            .into_iter()
            .filter(|seg| seg.turn_id == anchor.turn_id)
            .collect();
    for (side, size) in [window.before, window.after].into_iter().enumerate() {
        let (comparison, order) = if side == 0 {
            ("<", "DESC")
        } else {
            (">", "ASC")
        };
        let mut statement=c.prepare_cached(&format!("SELECT {COLUMNS} FROM agent_recall_messages d {ORIGINAL} WHERE d.namespace_id=? AND d.turn=? AND {SHARED_CONTEXT} AND d.sequence<=? AND (d.sequence,d.ordinal){comparison}(?,?) AND NOT(ns.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0)) ORDER BY d.sequence {order},d.ordinal {order} LIMIT ?"))?;
        let cap = size
            .checked_add(1)
            .ok_or_else(|| invalid("Recall context limit overflow"))?;
        let cap =
            i64::try_from(cap).map_err(|_| invalid("Recall context size exceeds SQLite range"))?;
        let mut rows = statement.query(params![
            ns_id,
            anchor.turn_id,
            number(cut.through_sequence)?,
            seq,
            ordinal,
            exclude.map(|x| x.session_id.as_str()),
            exclude.map(|x| x.turn_id.as_str()),
            exclude.map(|x| number(x.covered_through)).transpose()?,
            cap
        ])?;
        while let Some(row) = rows.next()? {
            check(stop)?;
            if sides[side].len() == size {
                more[side] = true;
                break;
            }
            sides[side].push(read_message(c, row)?);
        }
    }
    if !unsealed_in_turn.is_empty() {
        let anchor_key = (anchor.position.source_sequence, anchor.position.item_index);
        for seg in unsealed_in_turn {
            let key = (seg.sequence, 0);
            if key < anchor_key {
                if let Some(msg) = unsealed_message_from_header(c, &owner, ns_id, &seg, None, None)?
                {
                    sides[0].push(msg);
                }
            } else if key > anchor_key
                && let Some(msg) = unsealed_message_from_header(c, &owner, ns_id, &seg, None, None)?
            {
                sides[1].push(msg);
            }
        }
        sides[0].sort_by(|a, b| {
            (b.position.source_sequence, b.position.item_index)
                .cmp(&(a.position.source_sequence, a.position.item_index))
        });
        if sides[0].len() > window.before {
            more[0] = true;
            sides[0].truncate(window.before);
        }
        sides[1].sort_by(|a, b| {
            (a.position.source_sequence, a.position.item_index)
                .cmp(&(b.position.source_sequence, b.position.item_index))
        });
        if sides[1].len() > window.after {
            more[1] = true;
            sides[1].truncate(window.after);
        }
    }
    sides[0].reverse();
    let mut messages = std::mem::take(&mut sides[0]);
    messages.push(anchor.clone());
    messages.append(&mut sides[1]);
    Ok((messages, more[0], more[1]))
}
struct Candidate {
    session: String,
    message: Message,
    matched: Vec<String>,
    score: f64,
}
fn operation_receipt_settled(c: &Connection, sequence: u64) -> Result<bool, StoreError> {
    use maka_agent_facts::cells::CellEvent;
    let bytes: Vec<u8> = c
        .prepare_cached(
            "SELECT maka_content_bytes(x.payload,x.encoding) FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.sequence=?",
        )?
        .query_row([number(sequence)?], |r| r.get(0))?;
    let recorded: RecordedFact = serde_json::from_slice(&bytes)?;
    Ok(match &recorded.fact {
        Fact::OperationObserved { reply, .. }
        | Fact::Cell {
            event: CellEvent::ChildObserved { reply, .. },
        } => maka_agent_facts::operation::has_recorded_settlement(reply),
        _ => true,
    })
}
fn rank(a: &Candidate, b: &Candidate) -> Ordering {
    b.matched
        .len()
        .cmp(&a.matched.len())
        .then_with(|| b.score.total_cmp(&a.score))
        .then_with(|| b.message.timestamp.cmp(&a.message.timestamp))
        .then_with(|| a.message.message_id.cmp(&b.message.message_id))
        .then_with(|| a.session.cmp(&b.session))
        .then_with(|| a.message.turn_id.cmp(&b.message.turn_id))
}
fn density(
    text: &str,
    terms: &[String],
    stop: &CancellationToken,
) -> Result<(Vec<String>, f64), StoreError> {
    let mut matched = vec![];
    let mut coverage = 0f64;
    for term in terms {
        check(stop)?;
        let n = text.matches(term.as_str()).count();
        if n > 0 {
            matched.push(term.clone());
            coverage += n as f64 * term.chars().count() as f64;
        }
    }
    let score = if matched.is_empty() {
        0.0
    } else {
        coverage / (text.chars().count() as f64).sqrt()
    };
    Ok((matched, score))
}
fn ensure_session_cut(
    c: &Connection,
    store: &RecallStore,
    session: &str,
    cuts: &mut BTreeMap<String, HistoryCut>,
    gaps: &mut BTreeMap<String, String>,
) -> Result<bool, StoreError> {
    if gaps.contains_key(session) {
        return Ok(false);
    }
    if !cuts.contains_key(session) {
        let cut = crate::session_history::capture_at(c, &store.owner, session, None)?;
        match checked_cut(c, store, &cut) {
            Ok(()) => {
                cuts.insert(session.to_owned(), cut);
            }
            Err(error)
                if matches!(
                    error,
                    StoreError::InvalidTransition(_) | StoreError::EventConflict
                ) =>
            {
                gaps.insert(session.to_owned(), error.to_string());
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn consider_candidate(
    session: String,
    message: Message,
    query: &SearchQuery,
    ranked: &mut BTreeMap<(String, String), Candidate>,
    stop: &CancellationToken,
) -> Result<(), StoreError> {
    let text = fold(&message.body);
    let (matched, score) = density(&text, &query.terms, stop)?;
    if matched.is_empty() {
        return Ok(());
    }
    let factor = match message.role {
        Role::ToolCall => 0.75,
        Role::ToolResult => 0.5,
        _ => 1.0,
    };
    let key = (session.clone(), message.turn_id.clone());
    let candidate = Candidate {
        session,
        message,
        matched,
        score: score * factor,
    };
    if ranked
        .get(&key)
        .is_none_or(|old| rank(&candidate, old).is_lt())
    {
        ranked.insert(key, candidate);
        if query.limit.is_some_and(|limit| ranked.len() > limit) {
            let worst = ranked
                .iter()
                .max_by(|(_, a), (_, b)| rank(a, b))
                .map(|(key, _)| key.clone())
                .expect("nonempty ranks");
            ranked.remove(&worst);
        }
    }
    Ok(())
}

pub(super) fn search(
    c: &Connection,
    input: Search,
) -> Result<Batch, crate::session_history::snapshot::IndexedReadError> {
    let Search(store, query, before, after, stop) = input;
    check(&stop)?;
    if let Some(session) = &query.session_id {
        store.session(session)?;
        record(c, &store, session)?;
    }
    let owner = store.key()?;
    let expression = terms::expression(&query.terms);
    let mut ranked: BTreeMap<(String, String), Candidate> = BTreeMap::new();
    let mut cuts = BTreeMap::new();
    let mut gaps = BTreeMap::new();
    // Detect missing indexes even when they yield no FTS candidate.
    let mut failures=c.prepare_cached("SELECT DISTINCT r.session FROM agent_run_specs r JOIN session_control s ON s.id=r.session JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1 WHERE r.owner=? AND r.session>=? AND r.session<? AND substr(r.session,1,length(?))=? AND (? IS NULL OR r.session=?) AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1) AND EXISTS(SELECT 1 FROM agent_facts f WHERE f.run=r.run) AND (COALESCE((SELECT sequence FROM agent_recall_heads x WHERE x.owner=r.owner AND x.session=r.session),0)<>(SELECT MAX((SELECT f.sequence FROM agent_facts f WHERE f.run=spec.run ORDER BY f.revision DESC LIMIT 1)) FROM agent_run_specs spec WHERE spec.owner=r.owner AND spec.session=r.session) OR COALESCE((SELECT digest FROM agent_recall_heads x WHERE x.owner=r.owner AND x.session=r.session),'')<>COALESCE((SELECT prefix_digest FROM agent_session_history h WHERE h.namespace_id=(SELECT id FROM agent_namespaces ns WHERE ns.owner=r.owner AND ns.session=r.session) ORDER BY h.sequence DESC LIMIT 1),''))")?;
    let mut failed = failures.query(params![
        owner,
        store.prefix,
        format!("{}\u{10ffff}", store.prefix),
        store.prefix,
        store.prefix,
        query.session_id,
        query.session_id
    ])?;
    while let Some(row) = failed.next()? {
        check(&stop)?;
        gaps.insert(
            row.get::<_, String>(0)?,
            "Recall index is incomplete; explicit rebuild required".into(),
        );
    }
    let mut unreadable=c.prepare_cached("SELECT DISTINCT g.session,g.sequence,g.reason FROM agent_recall_gaps g JOIN session_control s ON s.id=g.session JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1 WHERE g.owner=? AND g.session>=? AND g.session<? AND substr(g.session,1,length(?))=? AND (? IS NULL OR g.session=?) AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1) ORDER BY g.session,g.sequence")?;
    let mut unread = unreadable.query(params![
        owner,
        store.prefix,
        format!("{}\u{10ffff}", store.prefix),
        store.prefix,
        store.prefix,
        query.session_id,
        query.session_id
    ])?;
    while let Some(row) = unread.next()? {
        check(&stop)?;
        gaps.entry(row.get::<_, String>(0)?).or_insert(format!(
            "Recall source {} unreadable: {}",
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?
        ));
    }
    let (settlement_col, transcript_filter) = if query.transcript_only {
        (
            ",CASE WHEN h.kind='operation_observed' THEN 1 WHEN h.kind='cell' AND NOT h.tool_start AND (SELECT json_extract(maka_content_text(b.payload,b.encoding),'$.fact.event.kind') FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.sequence=h.sequence)='child_observed' THEN 1 ELSE 0 END",
            format!(
                " AND h.kind<>'model_interrupted'{}",
                crate::session_history::source_tree::TRANSCRIPT_CELL_SQL
            ),
        )
    } else {
        (",0", String::new())
    };
    let has_time_window = query.since.is_some() || query.until.is_some();
    let (seg_cols, seg_join, until_expr) = if has_time_window {
        (
            ",seg.task,seg.message_id,seg.is_thinking,seg.tail_start_sequence,seg.tail_end_sequence,seg.tail_start_at",
            " LEFT JOIN agent_recall_external_segments seg ON seg.namespace_id=d.namespace_id AND seg.tail_end_sequence=d.sequence AND seg.sealed=1",
            "COALESCE(seg.tail_start_at,d.at)",
        )
    } else {
        ("", "", "d.at")
    };
    let mut cursor = 0i64;
    loop {
        let sql = format!(
            r#"SELECT {COLUMNS},ns.session,d.id{settlement_col}{seg_cols}
               FROM agent_recall_terms
               CROSS JOIN agent_recall_messages d ON d.id=agent_recall_terms.rowid
               {ORIGINAL}{seg_join}
               CROSS JOIN session_control s ON s.id=ns.session
               CROSS JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1
               WHERE agent_recall_terms MATCH ?
                 AND d.role<>'"compaction"'
                 AND ns.owner=?
                 AND ns.session>=? AND ns.session<? AND substr(ns.session,1,length(?))=?
                 AND (? IS NULL OR ns.session=?)
                 AND (? IS NULL OR d.at>=?)
                 AND (? IS NULL OR {until_expr}<=?)
                 AND NOT(ns.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0))
                 AND agent_recall_terms.rowid>?{transcript_filter}
                 AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1)
               ORDER BY agent_recall_terms.rowid LIMIT 128"#
        );
        let mut statement = c.prepare_cached(&sql)?;
        let since = query.since.map(number).transpose()?;
        let until = query.until.map(number).transpose()?;
        let mut rows = statement.query(params![
            expression,
            owner,
            store.prefix,
            format!("{}\u{10ffff}", store.prefix),
            store.prefix,
            store.prefix,
            query.session_id,
            query.session_id,
            since,
            since,
            until,
            until,
            query.exclude.as_ref().map(|x| x.session_id.as_str()),
            query.exclude.as_ref().map(|x| x.turn_id.as_str()),
            query
                .exclude
                .as_ref()
                .map(|x| number(x.covered_through))
                .transpose()?,
            cursor
        ])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            check(&stop)?;
            count += 1;
            let ns_id: crate::namespace::NamespaceId = row.get(18)?;
            let session: String = row.get(19)?;
            cursor = row.get(20)?;
            if !cuts.contains_key(&session) && !gaps.contains_key(&session) {
                let cut = crate::session_history::capture_at(c, &store.owner, &session, None)?;
                match checked_cut(c, &store, &cut) {
                    Ok(()) => {
                        cuts.insert(session.clone(), cut);
                    }
                    Err(error)
                        if matches!(
                            error,
                            StoreError::InvalidTransition(_) | StoreError::EventConflict
                        ) =>
                    {
                        gaps.insert(session.clone(), error.to_string());
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            if gaps.contains_key(&session) {
                continue;
            }
            let needs_settlement_check: bool = row.get(21)?;
            let mut message = read_message(c, row)?;
            if message.fields.iter().all(|f| f.internal) {
                continue;
            }
            if needs_settlement_check
                && !operation_receipt_settled(c, message.position.source_sequence)?
            {
                continue;
            }
            if has_time_window
                && !row.get::<_, bool>(13)?
                && let Some(task_str) = row.get::<_, Option<String>>(22)?
            {
                let start_at = unsigned(row.get::<_, i64>(27)?)?;
                let straddles = query.since.is_some_and(|s| start_at < s)
                    || query.until.is_some_and(|u| message.timestamp > u);
                if straddles {
                    let span = index::SealedSegmentSpan {
                        run: message.run,
                        task: crate::sql::identity(task_str)?,
                        message_id: row.get::<_, String>(23)?,
                        is_thinking: row.get::<_, bool>(24)?,
                        tail_start_sequence: unsigned(row.get::<_, i64>(25)?)?,
                        tail_end_sequence: unsigned(row.get::<_, i64>(26)?)?,
                    };
                    let spans_json: String = row.get(12)?;
                    let restrictions: Vec<(u64, u64)> = if spans_json != "[]" {
                        serde_json::from_str(&spans_json)?
                    } else {
                        Vec::new()
                    };
                    let Some((sliced_body, sliced_ts)) = index::slice_sealed_external_segment(
                        c,
                        ns_id,
                        &span,
                        query.since,
                        query.until,
                        &restrictions,
                    )?
                    else {
                        continue;
                    };
                    let sliced_len = sliced_body.len();
                    message.body = sliced_body;
                    message.timestamp = sliced_ts;
                    if let Some(first) = message.fields.first_mut() {
                        first.start = 0;
                        first.end = sliced_len;
                    }
                }
            }
            consider_candidate(session, message, &query, &mut ranked, &stop)?;
        }
        if count == 0 {
            break;
        }
    }
    // Supplement 1: when `exclude` cuts between a superseded row (`LocalToolReturned` or
    // `CellEvent::Completed`) and its explicit `body_ref_sequence` target, or strictly inside
    // a streaming external delta segment, hydrate the visible pre-cut rows for that turn.
    if let Some(excl) = &query.exclude {
        let in_scope = excl.session_id.starts_with(&store.prefix)
            && query
                .session_id
                .as_deref()
                .is_none_or(|target| target == excl.session_id);
        if in_scope && !gaps.contains_key(&excl.session_id) {
            let visible: bool = c.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM session_control s
                   JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1
                   WHERE s.id=?1
                     AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1)
                 )",
                [&excl.session_id],
                |r| r.get(0),
            )?;
            if visible
                && ensure_session_cut(c, &store, &excl.session_id, &mut cuts, &mut gaps)?
                && let Some(excl_ns_id) = crate::namespace::find_id(c, &owner, &excl.session_id)?
            {
                let since = query.since.map(number).transpose()?;
                let until = query.until.map(number).transpose()?;
                let covered_i64 = number(excl.covered_through)?;
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT {COLUMNS}
                     FROM agent_recall_messages d {ORIGINAL}
                     WHERE d.namespace_id=?1 AND d.turn=?2
                       AND d.sequence<=?3 AND d.body_ref_sequence>?3
                       AND (?4 IS NULL OR d.at>=?5) AND (?6 IS NULL OR d.at<=?7){transcript_filter}"
                ))?;
                let mut rows = stmt.query(params![
                    excl_ns_id,
                    excl.turn_id,
                    covered_i64,
                    since,
                    since,
                    until,
                    until
                ])?;
                while let Some(row) = rows.next()? {
                    check(&stop)?;
                    let message = read_message(c, row)?;
                    if !message.fields.iter().all(|f| f.internal) {
                        consider_candidate(
                            excl.session_id.clone(),
                            message,
                            &query,
                            &mut ranked,
                            &stop,
                        )?;
                    }
                }
                for seg in index::unsealed_external_segment_headers(
                    c,
                    excl_ns_id,
                    excl.covered_through,
                    0,
                )? {
                    check(&stop)?;
                    if seg.turn_id != excl.turn_id || seg.is_thinking {
                        continue;
                    }
                    if let Some(message) = unsealed_message_from_header(
                        c,
                        &owner,
                        excl_ns_id,
                        &seg,
                        query.since,
                        query.until,
                    )? {
                        consider_candidate(
                            excl.session_id.clone(),
                            message,
                            &query,
                            &mut ranked,
                            &stop,
                        )?;
                    }
                }
            }
        }
    }
    // Supplement 2: unsealed external streaming delta tails.
    // Uses `agent_recall_external_segments_open` and returns 0 rows in steady state.
    {
        let mut active_stmt = c.prepare_cached(
            "SELECT DISTINCT seg.namespace_id, ns.session
             FROM agent_recall_external_segments seg
             JOIN agent_namespaces ns ON ns.id=seg.namespace_id
             JOIN session_control s ON s.id=ns.session
             JOIN session_creations route
               ON route.session_id=s.id AND route.ready=1 AND route.visible=1
             WHERE ns.owner=?1 AND ns.session>=?2 AND ns.session<?3
               AND substr(ns.session,1,length(?4))=?5
               AND (?6 IS NULL OR ns.session=?7)
               AND seg.sealed=0 AND seg.tail_start_sequence IS NOT NULL
               AND NOT EXISTS(
                 SELECT 1 FROM session_retirements retired
                 WHERE retired.session_id=s.id AND retired.remove_session=1
               )",
        )?;
        let active_sessions: Vec<(crate::namespace::NamespaceId, String)> = active_stmt
            .query_map(
                params![
                    owner,
                    store.prefix,
                    format!("{}\u{10ffff}", store.prefix),
                    store.prefix,
                    store.prefix,
                    query.session_id,
                    query.session_id
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?
            .collect::<Result<_, _>>()?;
        for (ns_id, session) in active_sessions {
            check(&stop)?;
            if gaps.contains_key(&session)
                || !ensure_session_cut(c, &store, &session, &mut cuts, &mut gaps)?
            {
                continue;
            }
            let through = cuts[&session].through_sequence;
            for seg in index::unsealed_external_segment_headers(c, ns_id, through, 0)? {
                check(&stop)?;
                if seg.is_thinking
                    || is_excluded(query.exclude.as_ref(), &session, &seg.turn_id, seg.sequence)
                {
                    continue;
                }
                if let Some(message) =
                    unsealed_message_from_header(c, &owner, ns_id, &seg, query.since, query.until)?
                {
                    consider_candidate(session.clone(), message, &query, &mut ranked, &stop)?;
                }
            }
        }
    }
    let mut candidates = ranked.into_values().collect::<Vec<_>>();
    candidates.sort_by(rank);
    if let Some(limit) = query.limit {
        candidates.truncate(limit);
    }
    // Metadata and title visibility share this single SQL snapshot with the texts.
    let mut title_ids = vec![];
    let mut last = String::new();
    loop {
        check(&stop)?;
        let rows:Vec<(String,String)>=c.prepare_cached("SELECT s.id,COALESCE(json_extract(s.configuration,'$.title'),'') FROM session_control s JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1 WHERE s.id>? AND s.id>=? AND s.id<? AND substr(s.id,1,length(?))=? AND (? IS NULL OR s.id=?) AND NOT EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=s.id AND r.remove_session=1) AND (? IS NULL OR COALESCE((SELECT MAX(at) FROM agent_catalog_messages m WHERE m.owner=? AND m.session=s.id),s.created_at)>=?) AND (? IS NULL OR COALESCE((SELECT MAX(at) FROM agent_catalog_messages m WHERE m.owner=? AND m.session=s.id),s.created_at)<=?) ORDER BY s.id LIMIT 128")?.query_map(params![last,store.prefix,format!("{}\u{10ffff}",store.prefix),store.prefix,store.prefix,query.session_id,query.session_id,query.since.map(number).transpose()?,owner,query.since.map(number).transpose()?,query.until.map(number).transpose()?,owner,query.until.map(number).transpose()?],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (id, title) in rows {
            last = id.clone();
            let title = fold(&title);
            if query.terms.iter().any(|term| title.contains(term)) {
                title_ids.push(id);
            }
        }
    }
    let mut ids = title_ids.clone();
    ids.extend(candidates.iter().map(|x| x.session.clone()));
    ids.sort();
    ids.dedup();
    let metadata = crate::session_catalog::records_in_snapshot(c, &store.catalog()?, &ids)?
        .into_iter()
        .map(|r| (r.metadata.id.clone(), r))
        .collect::<BTreeMap<_, _>>();
    let mut titles = title_ids
        .into_iter()
        .map(|id| {
            metadata
                .get(&id)
                .cloned()
                .ok_or(StoreError::SessionNotFound)
        })
        .collect::<Result<Vec<_>, _>>()?;
    titles.sort_by(|a, b| {
        b.last_message
            .as_ref()
            .map(|m| m.recorded_at)
            .unwrap_or(b.metadata.created_at)
            .cmp(
                &a.last_message
                    .as_ref()
                    .map(|m| m.recorded_at)
                    .unwrap_or(a.metadata.created_at),
            )
            .then_with(|| a.metadata.id.cmp(&b.metadata.id))
    });
    if let Some(limit) = query.limit {
        titles.truncate(limit);
    }
    let mut hits = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        check(&stop)?;
        let cut = cuts
            .get(&candidate.session)
            .ok_or(StoreError::EventConflict)?
            .clone();
        let (messages, has_more_before, has_more_after) = neighbors(
            c,
            &store,
            &cut,
            &candidate.message,
            ContextWindow { before, after },
            query.exclude.as_ref(),
            &stop,
        )?;
        hits.push(Hit {
            session: metadata
                .get(&candidate.session)
                .cloned()
                .ok_or(StoreError::SessionNotFound)?,
            cut,
            anchor: candidate.message,
            messages,
            matched_terms: candidate.matched,
            score: candidate.score,
            has_more_before,
            has_more_after,
        });
    }
    check(&stop)?;
    Ok(Batch {
        titles,
        hits,
        gaps: gaps
            .into_iter()
            .map(|(session, reason)| format!("Session {session} was not fully read: {reason}"))
            .collect(),
    })
}
pub(super) fn exclusion(
    c: &Connection,
    store: &RecallStore,
    run: RunId,
) -> Result<ExcludedTail, StoreError> {
    let bytes:Vec<u8>=c.query_row("SELECT maka_content_bytes(x.payload,x.encoding) FROM agent_run_specs r JOIN contents x ON x.id=r.spec_content_id WHERE r.run=? AND r.owner=?",params![run.to_string(),store.key()?],|r|r.get(0))?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    store.session(&spec.session_id)?;
    let row: Option<(String, Vec<u8>)> = match crate::namespace::find_id(c, &store.key()?, &spec.session_id)? {
        Some(ns_id) => c
            .query_row(
                "SELECT f.run,maka_content_bytes(x.payload,x.encoding) FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents x ON x.id=f.body_content_id WHERE h.namespace_id=? AND h.kind='context_compacted' ORDER BY h.sequence DESC LIMIT 1",
                params![ns_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?,
        None => None,
    };
    let covered_through = if let Some((source, bytes)) = row {
        let fact: RecordedFact = serde_json::from_slice(&bytes)?;
        let Fact::ContextCompacted { baseline } = fact.fact else {
            return Err(StoreError::EventConflict);
        };
        let source: RunId = serde_json::from_value(serde_json::Value::String(source))?;
        let compact: maka_agent_facts::context::CompactedContext =
            serde_json::from_slice(&crate::sql::owned_content(c, source, &baseline)?)?;
        compact.validate().map_err(invalid)?;
        compact.checkpoint.covered_through
    } else {
        0
    };
    Ok(ExcludedTail {
        session_id: spec.session_id,
        turn_id: spec.turn_id,
        covered_through,
    })
}
