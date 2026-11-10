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
pub(super) const COLUMNS: &str = "d.message,d.sequence,d.ordinal,d.run,d.turn,d.at,d.role,d.body,d.attachments,d.references_json,d.fields_json,d.origin_json";
pub(super) fn read_message(row: &rusqlite::Row<'_>) -> Result<Message, StoreError> {
    let get = |i| -> Result<String, StoreError> { Ok(row.get(i)?) };
    Ok(Message {
        message_id: get(0)?,
        position: RowPosition {
            source_sequence: unsigned(row.get(1)?)?,
            item_index: unsigned(row.get(2)?)?,
        },
        run: serde_json::from_value(serde_json::Value::String(get(3)?))?,
        turn_id: get(4)?,
        timestamp: unsigned(row.get(5)?)?,
        role: serde_json::from_str(&get(6)?)?,
        body: get(7)?,
        attachments: serde_json::from_str(&get(8)?)?,
        references: serde_json::from_str(&get(9)?)?,
        fields: serde_json::from_str(&get(10)?)?,
        origin: row
            .get::<_, Option<String>>(11)?
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
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
        let expected:Option<String>=c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![owner,cut.session,sequence],|r|r.get(0)).optional()?;
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
fn record(c: &Connection, store: &RecallStore, session: &str) -> Result<Record, StoreError> {
    crate::session_catalog::records_in_snapshot(c, &store.catalog()?, &[session.to_owned()])?
        .pop()
        .ok_or(StoreError::SessionNotFound)
}
pub(super) fn context(c: &Connection, input: ReadContext) -> Result<Context, StoreError> {
    let ReadContext(store, session, anchor, before, after, cut, exclude, stop) = input;
    check(&stop)?;
    store.session(&session)?;
    let cut = match cut {
        Some(cut) => cut,
        None => crate::session_history::capture_at(c, &store.owner, &session, None)?,
    };
    if cut.session != session {
        return Err(StoreError::EventConflict);
    }
    checked_cut(c, &store, &cut)?;
    let owner = store.key()?;
    let mut statement=c.prepare_cached(&format!("SELECT {COLUMNS} FROM agent_recall_messages d WHERE d.owner=? AND d.session=? AND d.message=? AND d.sequence<=? AND NOT(d.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0))"))?;
    let mut rows = statement.query(params![
        owner,
        session,
        anchor,
        number(cut.through_sequence)?,
        exclude.as_ref().map(|x| x.session_id.as_str()),
        exclude.as_ref().map(|x| x.turn_id.as_str()),
        exclude
            .as_ref()
            .map(|x| number(x.covered_through))
            .transpose()?
    ])?;
    let anchor = read_message(
        rows.next()?
            .ok_or_else(|| invalid("Recall anchor not visible in this exact cut"))?,
    )?;
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
    let seq = number(anchor.position.source_sequence)?;
    let ordinal = number(anchor.position.item_index)?;
    let mut sides = [vec![], vec![]];
    let mut more = [false, false];
    for (side, size) in [window.before, window.after].into_iter().enumerate() {
        let (comparison, order) = if side == 0 {
            ("<", "DESC")
        } else {
            (">", "ASC")
        };
        let mut statement=c.prepare_cached(&format!("SELECT {COLUMNS} FROM agent_recall_messages d WHERE d.owner=? AND d.session=? AND d.turn=? AND d.sequence<=? AND (d.sequence,d.ordinal){comparison}(?,?) AND NOT(d.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0)) ORDER BY d.sequence {order},d.ordinal {order} LIMIT ?"))?;
        let cap = size
            .checked_add(1)
            .ok_or_else(|| invalid("Recall context limit overflow"))?;
        let cap =
            i64::try_from(cap).map_err(|_| invalid("Recall context size exceeds SQLite range"))?;
        let mut rows = statement.query(params![
            owner,
            cut.session,
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
            sides[side].push(read_message(row)?);
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
pub(super) fn search(c: &Connection, input: Search) -> Result<Batch, StoreError> {
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
    let mut failures=c.prepare_cached("SELECT DISTINCT r.session FROM agent_run_specs r JOIN session_control s ON s.id=r.session JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1 WHERE r.owner=? AND r.session>=? AND r.session<? AND substr(r.session,1,length(?))=? AND (? IS NULL OR r.session=?) AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1) AND EXISTS(SELECT 1 FROM agent_facts f WHERE f.run=r.run) AND (COALESCE((SELECT sequence FROM agent_recall_heads x WHERE x.owner=r.owner AND x.session=r.session),0)<>(SELECT MAX((SELECT f.sequence FROM agent_facts f WHERE f.run=spec.run ORDER BY f.revision DESC LIMIT 1)) FROM agent_run_specs spec WHERE spec.owner=r.owner AND spec.session=r.session) OR COALESCE((SELECT digest FROM agent_recall_heads x WHERE x.owner=r.owner AND x.session=r.session),'')<>COALESCE((SELECT prefix_digest FROM agent_session_history h WHERE h.owner=r.owner AND h.session=r.session ORDER BY h.sequence DESC LIMIT 1),''))")?;
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
    let mut cursor = 0i64;
    loop {
        let sql = format!(
            "SELECT {COLUMNS},d.session,d.id,d.folded FROM agent_recall_terms CROSS JOIN agent_recall_messages d ON d.id=agent_recall_terms.rowid CROSS JOIN session_control s ON s.id=d.session JOIN session_creations route ON route.session_id=s.id AND route.ready=1 AND route.visible=1 WHERE agent_recall_terms MATCH ? AND d.role<>'\"compaction\"' AND d.owner=? AND d.session>=? AND d.session<? AND substr(d.session,1,length(?))=? AND (? IS NULL OR d.session=?) AND (? IS NULL OR d.at>=?) AND (? IS NULL OR d.at<=?) AND NOT(d.session=COALESCE(?,'') AND d.turn=COALESCE(?,'') AND d.sequence>COALESCE(?,0)) AND agent_recall_terms.rowid>? AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1) ORDER BY agent_recall_terms.rowid LIMIT 128"
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
            cursor = row.get(13)?;
            let session: String = row.get(12)?;
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
                    Err(error) => return Err(error),
                }
            }
            if gaps.contains_key(&session) {
                continue;
            }
            let message = read_message(row)?;
            if message.fields.iter().all(|f| f.internal) {
                continue;
            }
            let text: String = row.get(14)?;
            let (matched, score) = density(&text, &query.terms, &stop)?;
            if matched.is_empty() {
                continue;
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
        }
        if count == 0 {
            break;
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
    let bytes:Vec<u8>=c.query_row("SELECT x.payload FROM agent_run_specs r JOIN contents x ON x.id=r.spec_content_id WHERE r.run=? AND r.owner=?",params![run.to_string(),store.key()?],|r|r.get(0))?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    store.session(&spec.session_id)?;
    let row:Option<(String,Vec<u8>)>=c.query_row("SELECT f.run,x.payload FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents x ON x.id=f.body_content_id WHERE h.owner=? AND h.session=? AND h.kind='context_compacted' ORDER BY h.sequence DESC LIMIT 1",params![store.key()?,spec.session_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
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
