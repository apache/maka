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

pub(super) struct Capture(
    pub HistoryNamespace,
    pub CaptureRequest,
    pub Option<maka_event_log::root_store::SessionRevisionGuard>,
);
impl Statement for Capture {
    type Value = ContentRef;
    type Output = ContentRef;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let owner = serde_json::to_string(&self.0.owner)?;
        let original:Option<(String,String,String,u64)>=c.query_row("SELECT s.request_json,s.owner,b.content_sha256,length(b.payload) FROM agent_history_snapshots s JOIN contents b ON b.id=s.manifest_content_id WHERE s.snapshot=?",[self.1.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,read_u64(r,3)?))).optional()?;
        if let Some((request, original_owner, digest, bytes)) = original {
            if original_owner != owner
                || serde_json::from_str::<CaptureRequest>(&request)? != self.1
            {
                return Err(StoreError::EventConflict);
            }
            return Ok(Prepared {
                value: ContentRef { digest, bytes },
                changed: false,
                notification: Notification::NONE,
            });
        }
        if let Some(guard) = &self.2 {
            guard.validate(c)?;
            super::super::fork::validate_current(c, &self.0, &self.1.cut)?;
        }
        super::super::sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1.cut)?;
        let mut builder = Builder::new(c, self.1.id);
        let mut admissions = std::collections::BTreeMap::new();
        {
            let mut statement=c.prepare_cached("SELECT s.run,f.sequence,f.body_content_id FROM agent_run_specs s JOIN agent_facts f ON f.run=s.run AND f.revision=1 WHERE s.owner=? AND s.session=? AND f.sequence<=? ORDER BY f.sequence")?;
            let mut rows = statement.query(params![
                owner,
                self.0.session,
                bind_u64(self.1.cut.through_sequence)?
            ])?;
            while let Some(row) = rows.next()? {
                let run = super::super::sql::identity(row.get(0)?)?;
                let source = super::super::sql::run_source(c, &self.0, run)?;
                let sequence = read_u64(row, 1)?;
                admissions.insert(
                    run,
                    (
                        source.admission.id,
                        sequence,
                        source.spec_ref.clone(),
                        false,
                    ),
                );
                builder.add(Entry::Run {
                    run,
                    admission_sequence: sequence,
                    spec: source.spec_ref,
                    admission: reference(c, row.get(2)?)?,
                })?;
            }
        }
        let mut prefix = super::super::sql::seed(&self.0.owner, &self.0.session)?;
        {
            let mut statement=c.prepare_cached("SELECT h.run,h.sequence,h.admission_sequence,h.step,h.attempt,f.id,f.revision,f.body_content_id,h.prefix_digest,h.tool_use_id,h.fact_id,f.run FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN agent_run_specs s ON s.run=f.run AND s.owner=h.owner AND s.session=h.session WHERE h.owner=? AND h.session=? AND h.sequence<=? ORDER BY h.sequence")?;
            let mut rows = statement.query(params![
                owner,
                self.0.session,
                bind_u64(self.1.cut.through_sequence)?
            ])?;
            while let Some(row) = rows.next()? {
                let run = super::super::sql::identity(row.get(0)?)?;
                let sequence = read_u64(row, 1)?;
                let body = reference(c, row.get(7)?)?;
                let fact = super::super::sql::identity(row.get(10)?)?;
                let actual_fact: FactId = super::super::sql::identity(row.get(5)?)?;
                let actual_run: RunId = super::super::sql::identity(row.get(11)?)?;
                if fact != actual_fact || run != actual_run {
                    return Err(invalid(
                        "canonical history header identity differs from its original fact",
                    ));
                }
                let admission_sequence = read_u64(row, 2)?;
                let scope = super::super::HistoryScope {
                    step: row
                        .get::<_, Option<String>>(3)?
                        .map(super::super::sql::identity)
                        .transpose()?,
                    attempt: row
                        .get::<_, Option<String>>(4)?
                        .map(super::super::sql::identity)
                        .transpose()?,
                };
                pin(c, self.1.id, &body, Some(run))?;
                let original: RecordedFact = metrics_metadata::original(c, self.1.id, run, &body)?;
                super::super::sql::validate_source_record(
                    c,
                    run,
                    fact,
                    admission_sequence,
                    &scope,
                    &original,
                )?;
                if original.revision != read_u64(row, 6)? {
                    return Err(invalid("canonical history original revision differs"));
                }
                let admitted = admissions
                    .get_mut(&run)
                    .ok_or_else(|| invalid("snapshot fact has no original owned Run admission"))?;
                if let Fact::RunAdmitted { spec } = &original.fact {
                    if admitted.0 != original.id
                        || admitted.1 != sequence
                        || &admitted.2 != spec
                        || admitted.3
                    {
                        return Err(invalid("snapshot Run/fact admission identities differ"));
                    }
                    admitted.3 = true;
                }
                prefix = super::super::sql::chain(&prefix, sequence, &body.digest)?;
                if prefix != row.get::<_, String>(8)? {
                    return Err(invalid(
                        "snapshot source prefix index is incomplete; explicit history rebuild required",
                    ));
                }
                builder.add(Entry::Fact {
                    run,
                    sequence,
                    admission_sequence,
                    step: scope.step,
                    attempt: scope.attempt,
                    tool_use_id: row.get(9)?,
                    id: fact,
                    revision: read_u64(row, 6)?,
                    body,
                })?;
                let mut after = None;
                loop {
                    let page = super::super::sql::sources_at(
                        c,
                        &self.0.owner,
                        &self.0.session,
                        &self.1.cut,
                        sequence,
                        after,
                        128,
                    )?;
                    for source in page.sources {
                        builder.add(Entry::Source {
                            run,
                            sequence,
                            position: source.position,
                            source: source.request.source,
                            resources: source.request.resources,
                        })?;
                    }
                    match page.next {
                        Some(next) => after = Some(next),
                        None => break,
                    }
                }
            }
        }
        if admissions.values().any(|admission| !admission.3) {
            return Err(invalid(
                "snapshot canonical Run admission is missing from its fact inventory",
            ));
        }
        if prefix != self.1.cut.digest {
            return Err(invalid(
                "snapshot source does not reach the original captured cut",
            ));
        }
        {
            let mut statement=c.prepare_cached("SELECT r.run,b.content_sha256,length(b.payload),r.first_sequence,p.content_id FROM agent_history_content_refs r LEFT JOIN agent_content_pins p ON p.run=r.run AND p.content_id=r.content_id JOIN contents b ON b.id=r.content_id WHERE r.owner=? AND r.session=? AND r.first_sequence<=? ORDER BY r.run,r.content_id")?;
            let mut rows = statement.query(params![
                owner,
                self.0.session,
                bind_u64(self.1.cut.through_sequence)?
            ])?;
            while let Some(row) = rows.next()? {
                if row.get::<_, Option<i64>>(4)?.is_none() {
                    return Err(invalid(
                        "snapshot payload lost its original Run content custody",
                    ));
                }
                builder.add(Entry::Payload {
                    run: Some(super::super::sql::identity(row.get(0)?)?),
                    introduced_sequence: Some(read_u64(row, 3)?),
                    content: ContentRef {
                        digest: row.get(1)?,
                        bytes: read_u64(row, 2)?,
                    },
                })?;
            }
        }
        {
            let mut statement=c.prepare_cached("SELECT r.run,h.sequence,a.record_json,b.content_sha256,length(b.payload),p.content_id FROM agent_artifact_run_bindings r JOIN agent_facts f ON f.id=r.fact JOIN agent_session_history h ON h.sequence=f.sequence JOIN agent_artifacts a ON a.session=r.session AND a.artifact=r.artifact JOIN contents b ON b.id=a.content_id LEFT JOIN agent_content_pins p ON p.run=r.run AND p.content_id=a.content_id WHERE h.owner=? AND h.session=? AND h.sequence<=? ORDER BY h.sequence,r.artifact")?;
            let mut rows = statement.query(params![
                owner,
                self.0.session,
                bind_u64(self.1.cut.through_sequence)?
            ])?;
            while let Some(row) = rows.next()? {
                if row.get::<_, Option<i64>>(5)?.is_none() {
                    return Err(invalid(
                        "snapshot artifact lost its original Run content custody",
                    ));
                }
                let record: PublishedArtifact = serde_json::from_str(&row.get::<_, String>(2)?)?;
                if record.payload
                    != (ContentRef {
                        digest: row.get(3)?,
                        bytes: read_u64(row, 4)?,
                    })
                {
                    return Err(invalid(
                        "snapshot artifact payload differs from its original content",
                    ));
                }
                builder.add(Entry::Artifact {
                    owner: self.0.owner.clone(),
                    session: self.0.session.clone(),
                    run: Some(super::super::sql::identity(row.get(0)?)?),
                    through_sequence: Some(read_u64(row, 1)?),
                    record,
                })?;
            }
        }
        super::positions::capture(c, &self.0, &self.1.cut, &mut builder)?;
        let manifest = builder.finish(Origin::Canonical {
            cut: self.1.cut.clone(),
        })?;
        let blob = ContentBlob::json(&manifest)?;
        let manifest_id = blob.store(c)?;
        c.execute(
            "INSERT INTO agent_history_snapshots VALUES(?,?,?,?,?)",
            params![
                self.1.id.to_string(),
                owner,
                self.0.session,
                serde_json::to_string(&self.1)?,
                manifest_id
            ],
        )?;
        pin(c, self.1.id, blob.reference(), None)?;
        metrics_metadata::validate_complete(c, self.1.id)?;
        Ok(Prepared {
            value: blob.reference().clone(),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::SessionRevisionConflict { .. }
        )
    }
}

pub(super) fn reference(c: &Connection, row: i64) -> Result<ContentRef, StoreError> {
    c.query_row(
        "SELECT content_sha256,length(payload) FROM contents WHERE id=?",
        [row],
        |r| {
            Ok(ContentRef {
                digest: r.get(0)?,
                bytes: read_u64(r, 1)?,
            })
        },
    )
    .map_err(Into::into)
}

pub(super) struct Builder<'a> {
    c: &'a Connection,
    id: SnapshotId,
    ordinal: u64,
    previous: Option<ContentRef>,
    entries: Vec<Entry>,
}
impl<'a> Builder<'a> {
    pub(super) fn new(c: &'a Connection, id: SnapshotId) -> Self {
        Self {
            c,
            id,
            ordinal: 0,
            previous: None,
            entries: Vec::with_capacity(PAGE_ENTRIES),
        }
    }
    pub(super) fn add(&mut self, entry: Entry) -> Result<(), StoreError> {
        index_entry(self.c, self.id, self.ordinal, &entry)?;
        self.ordinal = self
            .ordinal
            .checked_add(1)
            .ok_or_else(|| invalid("snapshot inventory ordinal exhausted"))?;
        self.entries.push(entry);
        if self.entries.len() == PAGE_ENTRIES {
            self.flush()?;
        }
        Ok(())
    }
    fn flush(&mut self) -> Result<(), StoreError> {
        if self.entries.is_empty() {
            return Ok(());
        }
        let page = InventoryPage {
            previous: self.previous.take(),
            entries: std::mem::replace(&mut self.entries, Vec::with_capacity(PAGE_ENTRIES)),
        };
        page.validate().map_err(invalid)?;
        let blob = ContentBlob::json(&page)?;
        blob.store(self.c)?;
        pin(self.c, self.id, blob.reference(), None)?;
        self.previous = Some(blob.reference().clone());
        Ok(())
    }
    pub(super) fn finish(mut self, origin: Origin) -> Result<Manifest, StoreError> {
        self.flush()?;
        let objects: u64 = self.c.query_row(
            "SELECT count(*) FROM agent_history_snapshot_pins WHERE snapshot=?",
            [self.id.to_string()],
            |r| read_u64(r, 0),
        )?;
        let manifest = Manifest {
            version: SNAPSHOT_VERSION,
            id: self.id,
            origin,
            inventory: self.previous,
            objects: objects
                .checked_add(1)
                .ok_or_else(|| invalid("snapshot object count overflow"))?,
        };
        manifest.validate().map_err(invalid)?;
        Ok(manifest)
    }
}
pub(super) fn index_entry(
    c: &Connection,
    id: SnapshotId,
    ordinal: u64,
    entry: &Entry,
) -> Result<(), StoreError> {
    let (kind, run, sequence, position) = match entry {
        Entry::Position { row } => {
            super::positions::index(c, id, row)?;
            match row {
                maka_agent_facts::history_snapshot::SnapshotPosition::Canonical {
                    run,
                    sequence,
                    item_index,
                    ..
                } => ("position", Some(*run), Some(*sequence), Some(*item_index)),
                maka_agent_facts::history_snapshot::SnapshotPosition::Imported {
                    message_ordinal,
                    part_ordinal,
                    ..
                } => (
                    "position",
                    None,
                    Some(*message_ordinal),
                    Some(*part_ordinal),
                ),
            }
        }
        Entry::Run {
            run,
            admission_sequence,
            ..
        } => ("run", Some(*run), Some(*admission_sequence), None),
        Entry::Fact { run, sequence, .. } => ("fact", Some(*run), Some(*sequence), None),
        Entry::Source {
            run,
            sequence,
            position,
            ..
        } => ("source", Some(*run), Some(*sequence), Some(*position)),
        Entry::Artifact {
            run,
            through_sequence,
            ..
        } => ("artifact", *run, *through_sequence, None),
        Entry::Imported { ordinal, .. } => ("imported", None, None, Some(*ordinal)),
        Entry::Payload { run, .. } => ("payload", *run, None, None),
    };
    for reference in entry.content_refs() {
        pin(c, id, reference, run)?;
    }
    let historical = if let Entry::Run { run, spec, .. } = entry {
        let value: RunSpec = read::decode_registered(c, id, spec, Some(*run))?;
        super::super::sql::historical_backend(&value)?
    } else {
        false
    };
    let (fact_kind, model_metadata) = super::metrics_metadata::classify(
        c,
        id,
        entry,
        super::metrics_metadata::IndexPhase::Inventory,
    )?;
    c.execute(
        "INSERT INTO agent_history_snapshot_entries(snapshot,ordinal,kind,run,sequence,position,entry_json,historical,fact_kind,model_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![
            id.to_string(),
            bind_u64(ordinal)?,
            kind,
            run.map(|r| r.to_string()),
            sequence.map(bind_u64).transpose()?,
            position.map(bind_u64).transpose()?,
            serde_json::to_string(entry)?,
            historical,
            fact_kind,
            model_metadata.as_ref().map(serde_json::to_string).transpose()?
        ],
    )?;
    Ok(())
}
