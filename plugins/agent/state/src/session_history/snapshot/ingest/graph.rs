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
use maka_agent_facts::history_snapshot::ImportedMessage;

pub(super) fn register(
    c: &Connection,
    ingest: &str,
    target: &HistoryNamespace,
    reference: &ContentRef,
    root: &Manifest,
) -> Result<(), StoreError> {
    enqueue(c, ingest, reference, root.objects)?;
    loop {
        let row: Option<(String, i64)> = c.query_row(
            "SELECT snapshot,manifest_content_id FROM agent_history_snapshot_ingest_nodes WHERE ingest=? AND state=0 AND remaining=0 ORDER BY snapshot LIMIT 1",
            [ingest], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        let Some((snapshot, content)) = row else {
            break;
        };
        let reference = capture::reference(c, content)?;
        let manifest: Manifest = decode(c, ingest, &reference)?;
        let old: Option<i64> = c
            .query_row(
                "SELECT manifest_content_id FROM agent_history_snapshots WHERE snapshot=?",
                [&snapshot],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            if old != content {
                return Err(StoreError::EventConflict);
            }
        } else {
            let (owner, session) = match &manifest.origin {
                Origin::Canonical { cut } => {
                    (serde_json::to_string(&cut.owner)?, cut.session.clone())
                }
                Origin::Imported { .. } => (
                    serde_json::to_string(&target.owner)?,
                    target.session.clone(),
                ),
            };
            c.execute(
                "INSERT INTO agent_history_snapshots VALUES(?,?,?,?,?)",
                params![
                    snapshot,
                    owner,
                    session,
                    serde_json::to_string(
                        &serde_json::json!({"kind":"verified_archive","manifest":reference})
                    )?,
                    content
                ],
            )?;
        }
        pin(c, manifest.id, &reference, None)?;
        if let Origin::Imported { fingerprint, .. } = &manifest.origin {
            copied(c, ingest, fingerprint)?;
            pin(c, manifest.id, fingerprint, None)?;
        }
        let total = page_entries(c, ingest, &manifest)?;
        let mut remaining = total;
        let mut page_ref = manifest.inventory.clone();
        while let Some(reference) = page_ref {
            let page: InventoryPage = decode(c, ingest, &reference)?;
            let size = page.entries.len() as u64;
            remaining = remaining
                .checked_sub(size)
                .ok_or_else(|| invalid("snapshot page chain changed"))?;
            pin(c, manifest.id, &reference, None)?;
            for (offset, entry) in page.entries.iter().enumerate() {
                entry_refs(c, ingest, &manifest, entry, root.objects)?;
                let ordinal = remaining
                    .checked_add(offset as u64)
                    .ok_or_else(|| invalid("snapshot inventory ordinal exhausted"))?;
                let old: Option<String> = c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND ordinal=?", params![snapshot, bind_u64(ordinal)?], |row| row.get(0)).optional()?;
                if let Some(old) = old {
                    if serde_json::from_str::<Entry>(&old)? != *entry {
                        return Err(StoreError::EventConflict);
                    }
                    for content in entry.content_refs() {
                        pin(c, manifest.id, content, entry_run(entry))?;
                    }
                } else {
                    capture::index_entry(c, manifest.id, ordinal, entry)?;
                }
            }
            page_ref = page.previous;
        }
        if remaining != 0 {
            return Err(invalid("snapshot page chain is incomplete"));
        }
        let indexed: u64 = c.query_row(
            "SELECT count(*) FROM agent_history_snapshot_entries WHERE snapshot=?",
            [&snapshot],
            |row| read_u64(row, 0),
        )?;
        if indexed != total {
            return Err(invalid(
                "snapshot immutable index differs from its original pages",
            ));
        }
        validate_index(c, &manifest)?;
        c.execute(
            "UPDATE agent_history_snapshot_ingest_nodes SET state=1 WHERE ingest=? AND snapshot=?",
            params![ingest, snapshot],
        )?;
    }
    c.execute("UPDATE agent_history_snapshot_ingest_nodes SET remaining=(SELECT count(DISTINCT child) FROM agent_history_snapshot_ingest_edges e WHERE e.ingest=agent_history_snapshot_ingest_nodes.ingest AND e.parent=agent_history_snapshot_ingest_nodes.snapshot) WHERE ingest=?", [ingest])?;
    // Resolve children first, with a SQL worklist instead of recursively growing
    // the Rust stack or retaining the complete graph/frame list in memory.
    loop {
        let ready: Option<(String, i64)> = c.query_row(
            "SELECT snapshot,manifest_content_id FROM agent_history_snapshot_ingest_nodes WHERE ingest=? AND state=1 AND remaining=0 ORDER BY snapshot LIMIT 1",
            [ingest], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        let Some((snapshot, content)) = ready else {
            break;
        };
        let reference = capture::reference(c, content)?;
        let manifest: Manifest = decode(c, ingest, &reference)?;
        c.execute("INSERT OR IGNORE INTO agent_history_snapshot_pins(snapshot,content_id) SELECT ?2,p.content_id FROM agent_history_snapshot_ingest_edges e JOIN agent_history_snapshot_pins p ON p.snapshot=e.child WHERE e.ingest=?1 AND e.parent=?2", params![ingest, snapshot])?;
        c.execute("INSERT OR IGNORE INTO agent_history_snapshot_run_refs(snapshot,run,content_id) SELECT ?2,e.run,p.content_id FROM agent_history_snapshot_ingest_edges e JOIN agent_history_snapshot_pins p ON p.snapshot=e.child WHERE e.ingest=?1 AND e.parent=?2", params![ingest, snapshot])?;
        if manifest.id == root.id {
            c.execute("INSERT OR IGNORE INTO agent_history_snapshot_pins(snapshot,content_id) SELECT ?2,content_id FROM agent_history_snapshot_ingest_frames WHERE ingest=?1", params![ingest, snapshot])?;
        }
        let count: u64 = c.query_row(
            "SELECT count(*) FROM agent_history_snapshot_pins WHERE snapshot=?",
            [&snapshot],
            |row| read_u64(row, 0),
        )?;
        let missing: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_pins p WHERE p.snapshot=?2 AND NOT EXISTS(SELECT 1 FROM agent_history_snapshot_ingest_frames f WHERE f.ingest=?1 AND f.content_id=p.content_id))", params![ingest, snapshot], |row| row.get(0))?;
        if count != manifest.objects || missing {
            return Err(invalid(
                "snapshot original immutable object closure is incomplete or widened",
            ));
        }
        c.execute(
            "UPDATE agent_history_snapshot_ingest_nodes SET state=2 WHERE ingest=? AND snapshot=?",
            params![ingest, snapshot],
        )?;
        c.execute("UPDATE agent_history_snapshot_ingest_nodes SET remaining=remaining-1 WHERE ingest=?1 AND state=1 AND snapshot IN (SELECT parent FROM agent_history_snapshot_ingest_edges WHERE ingest=?1 AND child=?2)", params![ingest,snapshot])?;
    }
    let incomplete: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_ingest_nodes WHERE ingest=? AND state!=2)", [ingest], |row| row.get(0))?;
    if incomplete {
        return Err(invalid(
            "snapshot nested manifest graph is cyclic or incomplete",
        ));
    }
    Ok(())
}

fn enqueue(
    c: &Connection,
    ingest: &str,
    reference: &ContentRef,
    frames: u64,
) -> Result<Manifest, StoreError> {
    let content = copied(c, ingest, reference)?;
    let manifest: Manifest = decode(c, ingest, reference)?;
    manifest.validate().map_err(invalid)?;
    if manifest.objects == 0 || manifest.objects > frames {
        return Err(invalid(
            "nested snapshot declares an incomplete file object inventory",
        ));
    }
    let old: Option<i64> = c.query_row("SELECT manifest_content_id FROM agent_history_snapshot_ingest_nodes WHERE ingest=? AND snapshot=?", params![ingest,manifest.id.to_string()], |row| row.get(0)).optional()?;
    if let Some(old) = old {
        if old != content {
            return Err(StoreError::EventConflict);
        }
    } else {
        c.execute(
            "INSERT INTO agent_history_snapshot_ingest_nodes VALUES(?,?,?,0,0)",
            params![ingest, manifest.id.to_string(), content],
        )?;
    }
    Ok(manifest)
}

fn page_entries(c: &Connection, ingest: &str, manifest: &Manifest) -> Result<u64, StoreError> {
    let mut reference = manifest.inventory.clone();
    let mut pages = 0u64;
    let mut entries = 0u64;
    while let Some(current) = reference {
        pages = pages
            .checked_add(1)
            .ok_or_else(|| invalid("snapshot page count overflow"))?;
        if pages >= manifest.objects {
            return Err(invalid("snapshot page chain exceeds its object inventory"));
        }
        let page: InventoryPage = decode(c, ingest, &current)?;
        page.validate().map_err(invalid)?;
        entries = entries
            .checked_add(page.entries.len() as u64)
            .ok_or_else(|| invalid("snapshot entry count overflow"))?;
        reference = page.previous;
    }
    Ok(entries)
}

fn entry_run(entry: &Entry) -> Option<RunId> {
    match entry {
        Entry::Run { run, .. } | Entry::Fact { run, .. } | Entry::Source { run, .. } => Some(*run),
        Entry::Artifact { run, .. } | Entry::Payload { run, .. } => *run,
        Entry::Imported { .. } | Entry::Position { .. } => None,
    }
}

fn entry_refs(
    c: &Connection,
    ingest: &str,
    manifest: &Manifest,
    entry: &Entry,
    frames: u64,
) -> Result<(), StoreError> {
    for reference in entry.content_refs() {
        copied(c, ingest, reference)?;
    }
    match entry {
        Entry::Run {
            run,
            admission_sequence,
            spec,
            admission,
        } => {
            let value: RunSpec = decode(c, ingest, spec)?;
            let Origin::Canonical { cut } = &manifest.origin else {
                return Err(invalid(
                    "imported-message source contains a canonical Run entry",
                ));
            };
            if value.schema_version != SCHEMA_VERSION
                || value.owner != cut.owner
                || value.session_id != cut.session
                || *admission_sequence == 0
                || *admission_sequence > cut.through_sequence
            {
                return Err(invalid(
                    "snapshot Run metadata differs from its original source scope/cut",
                ));
            }
            let admitted: RecordedFact = decode(c, ingest, admission)?;
            if admitted.schema_version != SCHEMA_VERSION
                || admitted.run != *run
                || admitted.revision != 1
                || !matches!(&admitted.fact, Fact::RunAdmitted { spec: original } if original==spec)
            {
                return Err(invalid(
                    "snapshot Run differs from its original immutable admission",
                ));
            }
            for reference in value.content_refs() {
                copied(c, ingest, reference)?;
                pin(c, manifest.id, reference, Some(*run))?;
            }
            if let RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } = &value.origin
            {
                let child = enqueue(c, ingest, source, frames)?;
                c.execute(
                    "INSERT INTO agent_history_snapshot_ingest_edges VALUES(?,?,?,?)",
                    params![
                        ingest,
                        manifest.id.to_string(),
                        run.to_string(),
                        child.id.to_string()
                    ],
                )?;
            }
        }
        Entry::Fact {
            run,
            id,
            revision,
            body,
            ..
        } => {
            // Ignore the opaque fact payload while checking its envelope; large
            // original model/tool strings stay in the immutable Blob.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Envelope {
                schema_version: u32,
                run: RunId,
                id: FactId,
                revision: u64,
            }
            let value: Envelope = decode(c, ingest, body)?;
            if value.schema_version != SCHEMA_VERSION
                || value.run != *run
                || value.id != *id
                || value.revision != *revision
            {
                return Err(invalid(
                    "snapshot fact identity differs from its original body",
                ));
            }
        }
        Entry::Artifact {
            owner,
            session,
            through_sequence,
            record,
            ..
        } => {
            record.artifact.validate().map_err(invalid)?;
            if record.artifact.session_id != *session
                || record.artifact.size_bytes != record.payload.bytes
            {
                return Err(invalid(
                    "snapshot artifact metadata differs from its original payload/scope",
                ));
            }
            if let Origin::Canonical { cut } = &manifest.origin {
                if owner != &cut.owner
                    || session != &cut.session
                    || through_sequence.is_some_and(|sequence| sequence > cut.through_sequence)
                {
                    return Err(invalid(
                        "snapshot artifact is outside its original source scope/cut",
                    ));
                }
            }
        }
        Entry::Imported { message, .. } => {
            let value: ImportedMessage = decode(c, ingest, message)?;
            for reference in value
                .parts
                .iter()
                .chain(value.provider_metadata.iter())
                .chain(std::iter::once(&value.original))
            {
                copied(c, ingest, reference)?;
                pin(c, manifest.id, reference, None)?;
            }
        }
        Entry::Source { .. } | Entry::Payload { .. } | Entry::Position { .. } => {}
    }
    Ok(())
}

fn validate_index(c: &Connection, manifest: &Manifest) -> Result<(), StoreError> {
    if let Origin::Imported { model_start, .. } = &manifest.origin {
        super::super::imported::validate_model_start(c, manifest.id, *model_start)?;
    }
    let snapshot = manifest.id.to_string();
    let orphan: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries e WHERE e.snapshot=?1 AND e.run IS NOT NULL AND e.kind!='run' AND NOT EXISTS(SELECT 1 FROM agent_history_snapshot_entries r WHERE r.snapshot=e.snapshot AND r.kind='run' AND r.run=e.run))", [&snapshot], |row| row.get(0))?;
    let duplicates: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' GROUP BY run HAVING count(*)!=1)", [&snapshot], |row| row.get(0))?;
    if orphan || duplicates {
        return Err(invalid(
            "snapshot inventory has missing or duplicate original Runs",
        ));
    }
    let admission: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries r WHERE r.snapshot=?1 AND r.kind='run' AND NOT EXISTS(SELECT 1 FROM agent_history_snapshot_entries f WHERE f.snapshot=r.snapshot AND f.kind='fact' AND f.run=r.run AND f.sequence=r.sequence AND json_extract(f.entry_json,'$.revision')=1 AND json_extract(f.entry_json,'$.body')=json_extract(r.entry_json,'$.admission')))", [&snapshot], |row|row.get(0))?;
    let scope: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries f JOIN agent_history_snapshot_entries r ON r.snapshot=f.snapshot AND r.kind='run' AND r.run=f.run WHERE f.snapshot=? AND f.kind='fact' AND json_extract(f.entry_json,'$.admission_sequence')!=r.sequence)", [&snapshot], |row|row.get(0))?;
    let source: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries s WHERE s.snapshot=? AND s.kind='source' AND NOT EXISTS(SELECT 1 FROM agent_history_snapshot_entries f WHERE f.snapshot=s.snapshot AND f.kind='fact' AND f.sequence=s.sequence AND f.run=s.run))", [&snapshot], |row|row.get(0))?;
    if admission || scope || source {
        return Err(invalid(
            "snapshot metadata does not retain its original admission/source binding",
        ));
    }
    if let Origin::Canonical { cut } = &manifest.origin {
        let mut prefix = super::super::super::sql::seed(&cut.owner, &cut.session)?;
        let mut through = 0;
        let mut query = c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' ORDER BY sequence")?;
        let mut rows = query.query([&snapshot])?;
        while let Some(row) = rows.next()? {
            let Entry::Fact { sequence, body, .. } =
                serde_json::from_str(&row.get::<_, String>(0)?)?
            else {
                return Err(invalid("snapshot fact index has another entry kind"));
            };
            if sequence == 0 || sequence <= through || sequence > cut.through_sequence {
                return Err(invalid(
                    "snapshot fact lies outside its original source cut",
                ));
            }
            prefix = super::super::super::sql::chain(&prefix, sequence, &body.digest)?;
            through = sequence;
        }
        if through != cut.through_sequence || prefix != cut.digest {
            return Err(invalid(
                "snapshot inventory does not reach its original canonical prefix",
            ));
        }
    }
    Ok(())
}
