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
use crate::recall::{number, unsigned};

pub struct SearchFacts {
    pub personal: Scope,
    pub project: Option<(Scope, String)>,
    pub terms: Vec<String>,
    pub after: u64,
    pub limit: usize,
    pub since: Option<u64>,
    pub until: Option<u64>,
}

#[derive(Default)]
pub struct FactPage {
    pub facts: Vec<RecallFact>,
    pub next: Option<u64>,
    pub gaps: Vec<String>,
}

const SEARCH: &str = "
WITH hits AS MATERIALIZED (
 SELECT rowid seq FROM agent_memory_recall_terms
 WHERE agent_memory_recall_terms MATCH ?1 AND rowid>?2 ORDER BY rowid LIMIT 65
)
SELECT k.seq,k.scope,k.id,m.revision,m.assertion,v.body,m.modified_at,v.metadata,
 (SELECT json_group_array(json_object('source',json_remove(e.source,'$.reference.quote','$.reference.fingerprint'),'visible',
     CASE WHEN s.id IS NOT NULL AND s.archived=0 AND COALESCE(s.configuration->>'incognito',0)=0
     AND EXISTS(SELECT 1 FROM session_creations route WHERE route.session_id=s.id AND route.ready=1 AND route.visible=1)
     AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1)
     AND h.fact_id=e.source->>'$.reference.factId'
     AND NOT EXISTS(SELECT 1 FROM agent_memory_hidden_spans hidden WHERE hidden.namespace=k.namespace AND hidden.fact=h.fact_id
       AND hidden.ordinal=e.source->>'$.reference.itemIndex' AND hidden.start<e.source->>'$.reference.end' AND hidden.end>e.source->>'$.reference.start')
     AND NOT EXISTS(SELECT 1 FROM agent_memory_operation_spans hidden WHERE hidden.namespace=k.namespace AND hidden.fact=h.fact_id
       AND hidden.ordinal=e.source->>'$.reference.itemIndex' AND hidden.start<e.source->>'$.reference.end' AND hidden.end>e.source->>'$.reference.start')
     AND NOT EXISTS(SELECT 1 FROM agent_memory_sibling_spans hidden WHERE hidden.namespace=k.namespace AND hidden.fact=h.fact_id
       AND hidden.ordinal=e.source->>'$.reference.itemIndex' AND hidden.start<e.source->>'$.reference.end' AND hidden.end>e.source->>'$.reference.start')
     AND NOT EXISTS(SELECT 1 FROM agent_memory_recall_outputs r WHERE r.owner=k.namespace AND r.fact=h.fact_id)
     THEN json('true') ELSE json('false') END))
  FROM (SELECT source FROM agent_memory_evidence WHERE namespace=k.namespace AND scope=k.scope AND id=k.id AND assertion=m.assertion
        ORDER BY sequence LIMIT 5) e
  LEFT JOIN session_control s ON s.id=e.source->>'$.reference.sessionId'
  LEFT JOIN agent_session_history h ON h.owner=m.namespace AND h.session=s.id AND h.sequence=e.source->>'$.reference.sequence')
FROM hits f CROSS JOIN agent_memory_recall_keys k ON k.seq=f.seq
 CROSS JOIN agent_memories m USING(namespace,scope,id)
 CROSS JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=m.assertion
 WHERE k.namespace=?3 AND k.scope IN (?4,?5) AND m.state='active' AND v.disposition='current'
 ORDER BY f.seq";

#[derive(serde::Deserialize)]
struct SourceRow {
    source: StoredSource,
    visible: bool,
}
#[derive(serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum StoredSource {
    UserOperation { operation_id: uuid::Uuid },
    Conversation { reference: Locator },
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Locator {
    session_id: String,
    sequence: u64,
    item_index: u64,
    fact_id: maka_agent_facts::durable::FactId,
    start: u32,
    end: u32,
}

impl Query for SearchFacts {
    type Output = FactPage;
    fn execute(self, c: &Connection) -> Result<FactPage, StoreError> {
        register_read_classifier(c)?;
        self.personal.validate(c)?;
        let namespace = &self.personal.namespace;
        let location = |s: &Scope| {
            format!(
                "location:\"{}x{}\"",
                hex::encode(namespace),
                hex::encode(&s.location)
            )
        };
        let mut page = FactPage::default();
        let project = self.project.filter(|(scope, _)| match scope.validate(c) {
            Ok(()) => true,
            Err(reason) => {
                page.gaps.push(reason.to_string());
                false
            }
        });
        let mut locations = location(&self.personal);
        if let Some((scope, _)) = &project {
            locations.push_str(" OR ");
            locations.push_str(&location(scope));
        }
        let terms = self
            .terms
            .iter()
            .map(|t| format!("body:\"{}\"*", t.replace('"', "\"\"")))
            .collect::<Vec<_>>();
        if terms.is_empty() {
            return Ok(page);
        }
        let expression = format!("({locations}) AND ({})", terms.join(" OR "));
        let mut stmt = c.prepare_cached(SEARCH)?;
        let limit = self.limit.min(16);
        let mut rows = stmt.query(params![
            expression,
            number(self.after)?,
            namespace,
            self.personal.location,
            project.as_ref().map(|(s, _)| &s.location),
        ])?;
        let now: i64 = c.query_row(
            "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
            [],
            |row| row.get(0),
        )?;
        let mut last = self.after;
        let mut bytes = 0;
        let mut examined = 0;
        while let Some(row) = rows.next()? {
            if examined == 64 {
                page.next = Some(last);
                break;
            }
            examined += 1;
            let seq = unsigned(row.get(0)?)?;
            let modified = unsigned(row.get(6)?)?;
            if self.since.is_some_and(|since| modified < since)
                || self.until.is_some_and(|until| modified > until)
            {
                last = seq;
                continue;
            }
            let metadata: MemoryMetadata = serde_json::from_str(&row.get::<_, String>(7)?)?;
            if let MemoryTemporal::Interval { start, end } = &metadata.temporal
                && (now < *start || end.is_some_and(|end| now >= end))
            {
                last = seq;
                continue;
            }
            let body: String = row.get(5)?;
            let evidence: Vec<SourceRow> = serde_json::from_str(&row.get::<_, String>(8)?)?;
            let count = evidence.len();
            let sources: Vec<_> = evidence
                .into_iter()
                .take(4)
                .filter_map(|row| match row.source {
                    StoredSource::UserOperation { operation_id } => {
                        Some(RecallFactSource::UserOperation { operation_id })
                    }
                    StoredSource::Conversation { reference: r } if row.visible => {
                        Some(RecallFactSource::Conversation {
                            session_id: r.session_id,
                            start: r.start,
                            end: r.end,
                            row: maka_agent_facts::history::HistoryRowAddress::Live {
                                sequence: r.sequence,
                                fact: r.fact_id,
                                item_index: r.item_index,
                            },
                        })
                    }
                    _ => None,
                })
                .collect();
            let sources_complete = count > 0 && sources.len() == count;
            let scope = if row.get::<_, String>(1)? == self.personal.location {
                MemoryScope::Personal
            } else {
                MemoryScope::Project {
                    session_id: project
                        .as_ref()
                        .ok_or_else(|| invalid("missing project binding"))?
                        .1
                        .clone(),
                }
            };
            let fact = RecallFact {
                id: MemoryId(
                    uuid::Uuid::parse_str(&row.get::<_, String>(2)?)
                        .map_err(|e| invalid(e.to_string()))?,
                ),
                revision: revision_value(row.get(3)?)?,
                assertion: revision_value(row.get(4)?)?,
                scope,
                metadata,
                body,
                sources,
                sources_complete,
            };
            // Include the model renderer's line prefix and newline in the byte bound.
            let size = serde_json::to_vec(&fact)?.len() + "Memory fact: ".len() + 1;
            const BYTE_BUDGET: usize = 32 * 1024;
            if size > BYTE_BUDGET {
                last = seq;
                page.gaps
                    .push("A memory fact exceeds the Recall output budget".into());
                continue;
            }
            if page.facts.len() == limit || bytes + size > BYTE_BUDGET {
                page.next = Some(last);
                break;
            }
            if !sources_complete && !page.gaps.iter().any(|g| g == "Memory evidence incomplete") {
                page.gaps.push("Memory evidence incomplete".into());
            }
            bytes += size;
            last = seq;
            page.facts.push(fact);
        }
        Ok(page)
    }
}

/// Byte offsets refer to the unmodified indexed body. History pages can begin
/// inside a restricted span, so intersect each span with the returned window.
pub fn mask(text: &mut String, offset: u64, spans: &[(u64, u64)]) {
    let end = offset.saturating_add(text.len() as u64);
    for &(a, b) in spans {
        let start = a.max(offset);
        let stop = b.min(end);
        if start < stop {
            let range = (start - offset) as usize..(stop - offset) as usize;
            if !text.is_char_boundary(range.start) || !text.is_char_boundary(range.end) {
                text.clear();
                return;
            }
            text.replace_range(range.clone(), &"*".repeat(range.len()));
        }
    }
}

pub(crate) fn register_read_classifier(c: &Connection) -> Result<(), StoreError> {
    use rusqlite::functions::FunctionFlags;
    if c.prepare_cached("SELECT maka_reads_history_resource(NULL)")
        .is_ok()
    {
        return Ok(());
    }
    c.create_scalar_function(
        "maka_reads_history_resource",
        1,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            Ok(maka_agent_facts::read::reads_history_resource(
                &ctx.get::<String>(0)?,
            ))
        },
    )?;
    Ok(())
}

pub type RestrictionMap =
    std::collections::BTreeMap<maka_agent_facts::history::HistoryRowAddress, Vec<(u64, u64)>>;
pub struct ReadRestrictions {
    pub owner: maka_agent_facts::durable::RunOwner,
    pub addresses: Vec<maka_agent_facts::history::HistoryRowAddress>,
}

impl Query for ReadRestrictions {
    type Output = RestrictionMap;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(self
            .by_index(c)?
            .into_iter()
            .map(|(index, spans)| (self.addresses[index].clone(), spans))
            .collect())
    }
}
impl ReadRestrictions {
    /// Look up a batch in the same transaction that verifies the candidate documents.
    pub(crate) fn by_index(
        &self,
        c: &Connection,
    ) -> Result<std::collections::BTreeMap<usize, Vec<(u64, u64)>>, StoreError> {
        use maka_agent_facts::history::HistoryRowAddress::*;
        let mut canonical = Vec::new();
        let mut imported = Vec::new();
        for (index, address) in self.addresses.iter().enumerate() {
            match address {
                Live {
                    fact, item_index, ..
                }
                | Snapshot {
                    fact, item_index, ..
                } => canonical.push((index, *fact, *item_index)),
                Imported {
                    snapshot,
                    message_ordinal,
                    part_ordinal,
                    ..
                } => imported.push((index, *snapshot, *message_ordinal, *part_ordinal)),
            }
        }
        indexed_spans(c, &self.owner, &canonical, &imported)
    }
}

pub(crate) fn indexed_spans(
    c: &Connection,
    owner: &maka_agent_facts::durable::RunOwner,
    canonical: &[(usize, maka_agent_facts::durable::FactId, u64)],
    imported: &[(
        usize,
        maka_agent_facts::history_snapshot::SnapshotId,
        u64,
        u64,
    )],
) -> Result<std::collections::BTreeMap<usize, Vec<(u64, u64)>>, StoreError> {
    register_read_classifier(c)?;
    let mut stmt=c.prepare_cached("WITH keys AS MATERIALIZED (SELECT value->>0 idx,value->>1 fact,value->>2 ordinal FROM json_each(?2))
        SELECT k.idx,s.start,s.end FROM keys k CROSS JOIN agent_memory_hidden_spans s
        WHERE s.namespace=?1 AND s.fact=k.fact AND s.ordinal=k.ordinal
        UNION ALL SELECT k.idx,s.start,s.end FROM keys k CROSS JOIN agent_memory_operation_spans s
        WHERE s.namespace=?1 AND s.fact=k.fact AND s.ordinal=k.ordinal
        UNION ALL SELECT k.idx,s.start,s.end FROM keys k CROSS JOIN agent_memory_sibling_spans s
        WHERE s.namespace=?1 AND s.fact=k.fact AND s.ordinal=k.ordinal
        UNION ALL SELECT k.idx,0,9223372036854775807 FROM keys k
        WHERE EXISTS(SELECT 1 FROM agent_memory_recall_outputs r WHERE r.owner=?1 AND r.fact=k.fact)
        UNION ALL SELECT i.value->>0,0,9223372036854775807 FROM json_each(?3) i CROSS JOIN agent_memory_imported_outputs r
        WHERE r.snapshot=i.value->>1 AND r.message=i.value->>2 AND r.part=i.value->>3 AND (r.read_path IS NULL OR maka_reads_history_resource(r.read_path))")?;
    let mut result = std::collections::BTreeMap::<_, Vec<_>>::new();
    let mut rows = stmt.query(params![
        serde_json::to_string(owner)?,
        serde_json::to_string(canonical)?,
        serde_json::to_string(imported)?
    ])?;
    while let Some(r) = rows.next()? {
        let index =
            usize::try_from(r.get::<_, i64>(0)?).map_err(|_| invalid("invalid address index"))?;
        result
            .entry(index)
            .or_default()
            .push((unsigned(r.get(1)?)?, unsigned(r.get(2)?)?));
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveRestriction {
    Source,
    PairedResult,
}

pub(crate) struct RestrictedArchives {
    pub owner: maka_agent_facts::durable::RunOwner,
    pub facts: Vec<maka_agent_facts::durable::FactId>,
}

impl Query for RestrictedArchives {
    type Output = std::collections::BTreeMap<maka_agent_facts::durable::FactId, ArchiveRestriction>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        register_read_classifier(c)?;
        let mut stmt = c.prepare_cached(
            "WITH sources(fact,direct) AS MATERIALIZED (
                SELECT value, EXISTS(SELECT 1 FROM agent_memory_hidden_spans WHERE namespace=?1 AND fact=input.value)
                OR EXISTS(SELECT 1 FROM agent_memory_operation_spans WHERE namespace=?1 AND fact=input.value)
                OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans WHERE namespace=?1 AND fact=input.value)
                OR EXISTS(SELECT 1 FROM agent_memory_recall_outputs WHERE owner=?1 AND fact=input.value)
                FROM json_each(?2) AS input)
             SELECT fact,direct FROM sources WHERE direct OR EXISTS(
                SELECT 1 FROM agent_session_history call CROSS JOIN agent_session_history result
                WHERE call.owner=?1 AND call.fact_id=sources.fact AND call.tool_start=1
                  AND result.owner=call.owner AND result.session=call.session AND result.run=call.run
                  AND result.tool_use_id=call.tool_use_id
                  AND (result.result_source=1 OR result.kind='operation_observed')
                  AND (EXISTS(SELECT 1 FROM agent_memory_hidden_spans s WHERE s.namespace=?1 AND s.fact=result.fact_id)
                    OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=?1 AND s.fact=result.fact_id)
                    OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=?1 AND s.fact=result.fact_id)))",
        )?;
        let mut rows = stmt.query(params![
            serde_json::to_string(&self.owner)?,
            serde_json::to_string(&self.facts)?
        ])?;
        let mut restricted = Self::Output::new();
        while let Some(row) = rows.next()? {
            let id = serde_json::from_value(serde_json::Value::String(row.get(0)?))?;
            let reason = if row.get::<_, bool>(1)? {
                ArchiveRestriction::Source
            } else {
                ArchiveRestriction::PairedResult
            };
            restricted.insert(id, reason);
        }
        Ok(restricted)
    }
}

#[derive(Clone)]
pub struct MaterialAccess {
    pub scope: crate::artifacts::SessionScope,
    pub artifact: String,
}
impl Query for MaterialAccess {
    type Output = ();
    fn execute(self, c: &Connection) -> Result<(), StoreError> {
        let restricted: bool = c.query_row(
            "WITH RECURSIVE origins(session,artifact,needs_registration) AS (
                SELECT ?2,?3,0 UNION
                SELECT json_extract(CAST(b.payload AS TEXT),'$.origin.source.scope.session'),
                       json_extract(CAST(b.payload AS TEXT),'$.origin.source.id'),
                       json_extract(CAST(b.payload AS TEXT),'$.origin.source.kind')='session'
                FROM origins o JOIN agent_session_artifact_registrations r
                  ON r.session=o.session AND r.artifact=o.artifact AND r.owner=?1
                JOIN contents b ON b.id=r.body_content_id
                WHERE json_extract(CAST(b.payload AS TEXT),'$.origin.kind')='copy'
            ) SELECT EXISTS(SELECT 1 FROM origins o CROSS JOIN agent_memory_recall_attachments a
            CROSS JOIN agent_recall_messages d ON d.id=a.message CROSS JOIN agent_session_history h ON h.sequence=d.sequence
            WHERE a.namespace=?1 AND a.session=o.session AND a.artifact=o.artifact
            AND (EXISTS(SELECT 1 FROM agent_memory_hidden_spans WHERE namespace=a.namespace AND fact=h.fact_id AND ordinal=d.ordinal)
                 OR EXISTS(SELECT 1 FROM agent_memory_operation_spans WHERE namespace=a.namespace AND fact=h.fact_id AND ordinal=d.ordinal)
                 OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans WHERE namespace=a.namespace AND fact=h.fact_id AND ordinal=d.ordinal)))
            OR EXISTS(SELECT 1 FROM origins o WHERE
                EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=o.session AND retired.remove_session=1)
                OR (o.needs_registration AND NOT EXISTS(SELECT 1 FROM agent_session_artifact_registrations r
                      WHERE r.owner=?1 AND r.session=o.session AND r.artifact=o.artifact)))",
            params![serde_json::to_string(&self.scope.owner)?, self.scope.session, self.artifact],
            |row| row.get(0),
        )?;
        if restricted {
            Err(invalid(
                "Historical attachment has restricted memory evidence",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn broad_prefix_pages_current_assertions_over_large_restricted_history() {
        let mut db = Connection::open_in_memory().unwrap();
        let catalog = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect::<Vec<_>>();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        let scope = Scope {
            namespace: "owner".into(),
            location: "personal".into(),
            binding: None,
        };
        let query = |after| SearchFacts {
            personal: scope.clone(),
            project: None,
            terms: vec!["a".into()],
            after,
            limit: 16,
            since: None,
            until: None,
        };
        let source = serde_json::to_string(&MemorySource::UserOperation {
            operation_id: uuid::Uuid::new_v4(),
            observed_at: 0,
        })
        .unwrap();
        let mut active = BTreeSet::new();
        let tx = db.transaction().unwrap();
        for n in 0..4352 {
            let id = uuid::Uuid::new_v4();
            let state = if n % 17 == 0 {
                active.insert(id);
                "active"
            } else {
                "suppressed"
            };
            tx.execute(
                "INSERT INTO agent_memories VALUES('owner','personal',?,1,1,'user_recall',?,0,0)",
                params![id.to_string(), state],
            )
            .unwrap();
            tx.execute("INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition) VALUES('owner','personal',?,1,'apricot',?,'digest',?)",params![id.to_string(),source,if state=="active" {"current"}else{"suppressed"}]).unwrap();
            tx.execute("INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES('owner','personal',?,1,?,'original')",params![id.to_string(),source]).unwrap();
        }
        tx.commit().unwrap();
        let mut lost_project = query(0);
        lost_project.project = Some((
            Scope {
                namespace: scope.namespace.clone(),
                location: "project".into(),
                binding: Some((
                    "retired-session".into(),
                    maka_sandbox::workspace::PermissionBasis {
                        boundary_revision: 1,
                        binding: maka_sandbox::workspace::BindingStamp {
                            id: uuid::Uuid::new_v4(),
                            permission_epoch: 1,
                        },
                    },
                )),
            },
            "retired-session".into(),
        ));
        let fallback = lost_project.execute(&db).unwrap();
        assert_eq!(fallback.facts.len(), 16);
        assert!(
            fallback
                .gaps
                .iter()
                .any(|reason| reason.contains("memory scope binding changed"))
        );
        let start = std::time::Instant::now();
        let mut pages = 0;
        let mut after = 0;
        loop {
            let page = query(after).execute(&db).unwrap();
            assert!(page.gaps.is_empty(), "{:?}", page.gaps);
            assert_eq!(page.facts.len(), 16);
            for fact in page.facts {
                assert!(active.remove(&fact.id.0));
            }
            pages += 1;
            let Some(next) = page.next else {
                break;
            };
            assert!(next > after);
            after = next;
        }
        eprintln!(
            "Recall: 4096 suppressed, 256 active, {pages} pages in {:?}",
            start.elapsed()
        );
        assert!(active.is_empty());
        db.execute(
            "UPDATE agent_memory_versions SET metadata=json_set(metadata,'$.temporal',json(?))
             WHERE disposition='current'",
            [r#"{"kind":"interval","start":0,"end":1}"#],
        )
        .unwrap();
        let expired = query(0).execute(&db).unwrap();
        assert!(expired.facts.is_empty());
        assert!(
            expired.next.is_some(),
            "time filtering must preserve the bounded scan cursor"
        );
    }

    #[test]
    fn unicode_fact_search_preserves_old_and_new_assertion_bytes() {
        use unicode_normalization::UnicodeNormalization;
        let c = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let previous: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 50)
            .collect();
        maka_event_log::migration::run(&c, &previous).unwrap();
        let body: String = "한글 설정 🧭".nfd().collect();
        let source = serde_json::to_string(&MemorySource::UserOperation {
            operation_id: uuid::Uuid::new_v4(),
            observed_at: 0,
        })
        .unwrap();
        let insert = || {
            let key = uuid::Uuid::new_v4().to_string();
            c.execute("INSERT INTO agent_memories VALUES('owner','personal',?,1,1,'user_recall','active',0,0)", [&key]).unwrap();
            c.execute("INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition) VALUES('owner','personal',?,1,?,?, 'digest','current')", params![key,body,source]).unwrap();
            c.execute("INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES('owner','personal',?,1,?,'original')",params![key,source]).unwrap();
        };
        insert();
        maka_event_log::migration::run(&c, &catalog).unwrap();
        insert();
        let search = |terms: &[&str]| {
            SearchFacts {
                personal: Scope {
                    namespace: "owner".into(),
                    location: "personal".into(),
                    binding: None,
                },
                project: None,
                terms: terms.iter().map(|term| (*term).to_owned()).collect(),
                limit: 16,
                after: 0,
                since: None,
                until: None,
            }
            .execute(&c)
            .unwrap()
        };
        for terms in [&["한"][..], &["🧭"], &["!", "🧭", "absent"]] {
            let page = search(terms);
            assert_eq!(page.facts.len(), 2, "terms {terms:?}");
            assert!(page.facts.iter().all(|fact| fact.body == body));
        }
        assert!(search(&["!"]).facts.is_empty());
    }

    #[test]
    fn read_continuations_are_classified_on_upgrade_and_on_new_writes() {
        use maka_agent_facts::read::ReadInput;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("root.sqlite");
        let db = Connection::open(&path).unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let previous: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 50)
            .collect();
        maka_event_log::migration::run(&db, &previous).unwrap();
        db.execute_batch("INSERT INTO contents VALUES(1,'spec',x'7b7d'); INSERT INTO agent_run_specs VALUES('run',1,'owner','chat',1);").unwrap();

        let record = |db: &Connection, n: i64, target: &str| {
            let next = ReadInput {
                path: target.into(),
                offset: None,
                limit: None,
            }
            .resolve()
            .unwrap()
            .page(&"x".repeat(16_000))
            .unwrap()
            .next
            .unwrap();
            let call = serde_json::json!({"fact":{"part":{"call":{"name":"Read","input":{"data":{"path":next.path}}}}}});
            for (seq, kind, payload, is_call) in [
                (n, "model_observed", call, true),
                (
                    n + 1,
                    "local_tool_returned",
                    serde_json::json!({"fact":{}}),
                    false,
                ),
            ] {
                let fact = format!("fact-{seq}");
                db.execute(
                    "INSERT INTO contents VALUES(?1,?2,?3)",
                    params![seq + 1, fact, serde_json::to_vec(&payload).unwrap()],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO agent_facts VALUES(?1,?2,'run',?1,1,1,?3)",
                    params![seq, fact, seq + 1],
                )
                .unwrap();
                db.execute("INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_use_id,tool_start,opening_message,fact_id,result_source)
                    VALUES('owner','chat',?1,'run',1,?2,'prefix',?3,?4,0,?5,?6)",params![seq,kind,n.to_string(),is_call,fact,!is_call]).unwrap();
            }
        };
        record(&db, 1, "notes.txt");
        record(&db, 3, "session:sample");
        maka_event_log::migration::run(&db, &catalog).unwrap();
        drop(db);
        let db = Connection::open(&path).unwrap();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        record(&db, 5, "notes.txt");
        record(&db, 7, "attachment:photo");
        let rows = |sql: &str| {
            db.prepare(sql)
                .unwrap()
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            rows("SELECT tool_use_id FROM agent_memory_recall_calls ORDER BY sequence"),
            ["3", "7"]
        );
        assert_eq!(
            rows("SELECT fact FROM agent_memory_recall_outputs ORDER BY fact"),
            ["fact-4", "fact-8"]
        );
    }

    #[test]
    fn cell_observations_follow_evidence_changes_without_rescanning_notifications() {
        use rusqlite::StatementStatus;

        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let previous: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 50)
            .collect();
        maka_event_log::migration::run(&db, &previous).unwrap();
        db.execute_batch(
            "INSERT INTO contents VALUES(1,'spec',x'7b7d');
            INSERT INTO agent_run_specs VALUES('run',1,'owner','chat',1);",
        )
        .unwrap();
        let notification = |n: i64, cell: &str| {
            let id = format!("notice-{n}");
            let payload = serde_json::to_vec(&serde_json::json!({"fact":{"kind":"cell","event":{
                "kind":"notification_queued","cell":cell,"notification":id
            }}}))
            .unwrap();
            db.execute(
                "INSERT INTO contents VALUES(?1,?2,?3)",
                params![n + 1, id, payload],
            )
            .unwrap();
            db.execute("INSERT INTO agent_facts(sequence,id,run,revision,schema_version,at,body_content_id)
                VALUES(?1,?2,'run',?1,1,1,?3)",params![n,id,n+1]).unwrap();
            db.execute("INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_start,opening_message,fact_id,result_source)
                VALUES('owner','chat',?1,'run',1,'cell','prefix',0,0,?2,0)",params![n,id]).unwrap();
        };
        notification(1, "one");
        notification(2, "one");
        db.execute_batch(r#"INSERT INTO agent_memories VALUES('owner','personal','entry',1,1,'user_recall','suppressed',0,0);
            INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition)
            VALUES('owner','personal','entry',1,'Meeting time','{}','digest','current');
            INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES('owner','personal','entry',1,
            '{"kind":"conversation","reference":{"sessionId":"chat","sequence":1,"factId":"notice-1","itemIndex":0,"start":0,"end":4}}','source');"#).unwrap();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        db.execute_batch(r#"INSERT INTO agent_run_specs VALUES('reader-run',1,'owner','chat',1);
            INSERT INTO contents VALUES(1000,'wait-result',CAST('{"body":{"isError":false,"output":{"format":"cell","value":{"cell":"one"}}}}' AS BLOB)),
                                       (1001,'wait-fact',CAST('{"fact":{"result":{"digest":"wait-result"}}}' AS BLOB));
            INSERT INTO agent_facts VALUES(1000,'wait','reader-run',1,1,1,1001);
            INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_start,opening_message,fact_id,result_source)
            VALUES('owner','chat',1000,'reader-run',1000,'local_tool_returned','prefix',0,0,'wait',1);"#).unwrap();
        let restricted = || {
            db.query_row(
                "SELECT count(*) FROM agent_memory_recall_outputs
            WHERE owner='owner' AND fact IN ('notice-2','wait')",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(restricted(), 2);
        db.execute("UPDATE agent_memories SET state='active'", [])
            .unwrap();
        assert_eq!(restricted(), 0);
        db.execute(
            "UPDATE agent_memory_versions SET disposition='corrected'",
            [],
        )
        .unwrap();
        assert_eq!(restricted(), 2);
        db.execute("UPDATE agent_memory_versions SET disposition='current'", [])
            .unwrap();
        assert_eq!(restricted(), 0);

        let page_cost = |last: i64| {
            let mut stmt = db.prepare("SELECT count(*) FROM agent_session_history h WHERE h.sequence BETWEEN ?1 AND ?2
                AND EXISTS(SELECT 1 FROM agent_memory_recall_outputs r WHERE r.owner=h.owner AND r.fact=h.fact_id)").unwrap();
            assert_eq!(
                stmt.query_row(params![last - 15, last], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            stmt.get_status(StatementStatus::VmStep)
        };
        for n in 3..=32 {
            notification(n, "one");
        }
        let short = page_cost(32);
        for n in 33..=128 {
            notification(n, "one");
        }
        let long = page_cost(128);
        assert!(
            long < short * 2,
            "same 16-address page after a longer prefix: {short} -> {long}"
        );
        db.execute_batch("INSERT INTO agent_memories VALUES('owner','personal','other',1,1,'user_recall','suppressed',0,0);
            INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition)
            VALUES('owner','personal','other',1,'Other meeting','{}','digest','current');").unwrap();
        for n in 129..=192 {
            notification(n, "other-cell");
            let source = serde_json::json!({"kind":"conversation","reference":{
                "sessionId":"chat","sequence":n,"factId":format!("notice-{n}"),"itemIndex":0,"start":0,"end":4
            }});
            db.execute(
                "INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key)
                VALUES('owner','personal','other',1,?1,?2)",
                params![source.to_string(), n],
            )
            .unwrap();
        }
        let dense = page_cost(128);
        assert!(
            dense < long * 2,
            "same page with unrelated restricted evidence in the Run: {long} -> {dense}"
        );
    }

    #[test]
    fn masked_windows_preserve_independent_utf8_evidence_and_cursor_offsets() {
        let mut text = "好，继续 PostgreSQL".to_string();
        let offset = "偏".len() as u64;
        let spans = [(0, "偏好".len() as u64), (3, 6)];
        mask(&mut text, offset, &spans);
        assert_eq!(text, "***，继续 PostgreSQL");
    }
}
