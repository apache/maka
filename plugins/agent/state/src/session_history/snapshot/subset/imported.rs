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
use maka_agent_facts::history_snapshot::{ImportedMessage, OriginalRecordsPage, OriginalSource};
use std::collections::BTreeSet;

pub(super) fn ranges(
    c: &Connection,
    parent: &Snapshot,
    section: usize,
) -> Result<Vec<Range>, StoreError> {
    let mut groups = BTreeMap::<ImportedTurnOrdinal, (u64, u64)>::new();
    let mut statement=c.prepare_cached("SELECT position FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' ORDER BY position")?;
    let mut rows = statement.query([parent.id.to_string()])?;
    let mut previous = None;
    while let Some(row) = rows.next()? {
        let position = read_u64(row, 0)?;
        let message = read::ImportedItem(parent.clone(), position).execute(c)?;
        if previous.is_some_and(|ordinal| ordinal > message.original_ordinal) {
            return Err(invalid(
                "imported messages disagree with original raw record order",
            ));
        }
        previous = Some(message.original_ordinal);
        groups
            .entry(message.turn_ordinal)
            .and_modify(|range| range.1 = position)
            .or_insert((position, position));
    }
    Ok(groups
        .into_iter()
        .map(|(ordinal, (first, last))| Range {
            turn: Turn::Imported { section, ordinal },
            first,
            last,
        })
        .collect())
}
pub(super) struct Boundary(pub Snapshot, pub u64, pub bool);
impl Query for Boundary {
    type Output = Option<u64>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        read::authorize(c, &self.0)?;
        let through = if self.2 {
            self.1.checked_sub(1)
        } else {
            Some(self.1)
        };
        validate_boundary(c, &self.0, through)?;
        Ok(through)
    }
}
fn validate_boundary(
    c: &Connection,
    parent: &Snapshot,
    through: Option<u64>,
) -> Result<(), StoreError> {
    let Some(through) = through else {
        return Ok(());
    };
    let last = read::ImportedItem(parent.clone(), through).execute(c)?;
    let next:Option<u64>=c.query_row("SELECT position FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position>? ORDER BY position LIMIT 1",params![parent.id.to_string(),bind_u64(through)?],|row|read_u64(row,0)).optional()?;
    if let Some(next) = next {
        let next = read::ImportedItem(parent.clone(), next).execute(c)?;
        if next.original_ordinal == last.original_ordinal || next.turn_ordinal == last.turn_ordinal
        {
            return Err(invalid(
                "fork source cut splits an original imported record or complete Turn",
            ));
        }
    }
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(
    c: &Connection,
    parent: &Snapshot,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    let id = read::pinned(c, parent, reference, None)?;
    super::super::super::sql::read_blob(c, id, reference, |reader| {
        Ok(serde_json::from_reader(std::io::BufReader::new(reader))?)
    })
}
fn payload(builder: &mut capture::Builder<'_>, content: ContentRef) -> Result<(), StoreError> {
    builder.add(Entry::Payload {
        run: None,
        introduced_sequence: None,
        content,
    })
}
fn generated(
    c: &Connection,
    builder: &mut capture::Builder<'_>,
    value: &impl Serialize,
) -> Result<ContentRef, StoreError> {
    let blob = ContentBlob::json(value)?;
    blob.store(c)?;
    payload(builder, blob.reference().clone())?;
    Ok(blob.reference().clone())
}
pub(super) fn copy(
    c: &Connection,
    parent: &Snapshot,
    id: SnapshotId,
    through: Option<u64>,
) -> Result<ContentRef, StoreError> {
    validate_boundary(c, parent, through)?;
    let Origin::Imported {
        source,
        fingerprint,
    } = read::Header(parent.clone()).execute(c)?.origin
    else {
        return Err(invalid(
            "imported subset differs from its actual parent source",
        ));
    };
    let original: OriginalSource = decode(c, parent, &fingerprint)?;
    if original.version != SNAPSHOT_VERSION {
        return Err(invalid("unsupported original imported source version"));
    }
    let mut builder = capture::Builder::new(c, id);
    let mut last_raw = None;
    if let Some(through) = through {
        let mut statement=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='imported' AND position<=? ORDER BY position")?;
        let mut rows = statement.query(params![parent.id.to_string(), bind_u64(through)?])?;
        let mut next = 0u64;
        while let Some(row) = rows.next()? {
            let entry: Entry = serde_json::from_str(&row.get::<_, String>(0)?)?;
            let Entry::Imported { ordinal, message } = &entry else {
                return Err(invalid("imported subset index kind corrupt"));
            };
            if *ordinal != next {
                return Err(invalid("imported subset is not a complete source prefix"));
            }
            next = next
                .checked_add(1)
                .ok_or_else(|| invalid("imported ordinal exhausted"))?;
            let decoded: ImportedMessage = decode(c, parent, message)?;
            if last_raw.is_some_and(|raw| raw > decoded.original_ordinal) {
                return Err(invalid("imported raw prefix order corrupt"));
            }
            last_raw = Some(decoded.original_ordinal);
            for content in decoded
                .parts
                .iter()
                .chain(std::iter::once(&decoded.original))
                .chain(decoded.provider_metadata.iter())
            {
                read::pinned(c, parent, content, None)?;
                payload(&mut builder, content.clone())?;
            }
            for artifact in &decoded.media {
                let scope = &decoded.artifact_scope;
                let record = read::ArtifactMetadata(
                    parent.clone(),
                    scope.owner.clone(),
                    scope.session.clone(),
                    None,
                    artifact.clone(),
                )
                .execute(c)?
                .ok_or_else(|| {
                    invalid("selected imported message has missing declared copied media")
                })?;
                let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_artifact WHERE snapshot=?1 AND kind='artifact' AND json_extract(entry_json,'$.owner')=?2 AND json_extract(entry_json,'$.session')=?3 AND json_extract(entry_json,'$.record.artifact.id')=?4 AND run IS NULL AND sequence IS NULL ORDER BY ordinal LIMIT 1",params![parent.id.to_string(),serde_json::to_string(&scope.owner)?,scope.session,artifact],|row|row.get(0))?;
                let original: Entry = serde_json::from_str(&raw)?;
                payload(&mut builder, record.payload.clone())?;
                builder.add(original)?;
            }
            builder.add(entry)?;
        }
        if next
            != through
                .checked_add(1)
                .ok_or_else(|| invalid("imported boundary exhausted"))?
        {
            return Err(invalid("selected imported message is missing"));
        }
        let mut positions=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='position' AND sequence<=? ORDER BY ordinal")?;
        let mut rows = positions.query(params![parent.id.to_string(), bind_u64(through)?])?;
        while let Some(row) = rows.next()? {
            let entry: Entry = serde_json::from_str(&row.get::<_, String>(0)?)?;
            if !matches!(
                entry,
                Entry::Position {
                    row: SnapshotPosition::Imported { .. }
                }
            ) {
                return Err(invalid("imported source has non-imported positions"));
            }
            builder.add(entry)?;
        }
    }
    let records = raw_prefix(c, parent, &mut builder, original.records, last_raw)?;
    let fingerprint = generated(
        c,
        &mut builder,
        &OriginalSource {
            version: original.version,
            fingerprint: original.fingerprint,
            records,
        },
    )?;
    let manifest = builder.finish(Origin::Imported {
        source,
        fingerprint,
    })?;
    let footer = ContentBlob::json(&manifest)?;
    footer.store(c)?;
    pin(c, id, footer.reference(), None)?;
    Ok(footer.reference().clone())
}
fn raw_prefix(
    c: &Connection,
    parent: &Snapshot,
    builder: &mut capture::Builder<'_>,
    mut page: Option<ContentRef>,
    through: Option<u64>,
) -> Result<Option<ContentRef>, StoreError> {
    let Some(through) = through else {
        return Ok(None);
    };
    // The original source is a backwards page chain. Keep only page metadata
    // while locating the prefix; no original record body is read or rewritten.
    let mut pages = vec![];
    let mut seen = BTreeSet::new();
    while let Some(current) = page {
        if !seen.insert(current.digest.clone()) {
            return Err(invalid("original imported record page cycle"));
        }
        let decoded: OriginalRecordsPage = decode(c, parent, &current)?;
        page = decoded.previous;
        pages.push(current);
    }
    let mut previous = None;
    let mut current = Vec::with_capacity(PAGE_ENTRIES);
    let mut ordinal = 0u64;
    let count = through
        .checked_add(1)
        .ok_or_else(|| invalid("original raw prefix exhausted"))?;
    'pages: for page in pages.into_iter().rev() {
        let page: OriginalRecordsPage = decode(c, parent, &page)?;
        for record in page.records {
            if ordinal == count {
                break 'pages;
            }
            read::pinned(c, parent, &record, None)?;
            payload(builder, record.clone())?;
            current.push(record);
            ordinal = ordinal
                .checked_add(1)
                .ok_or_else(|| invalid("original raw ordinal exhausted"))?;
            if current.len() == PAGE_ENTRIES {
                previous = Some(generated(
                    c,
                    builder,
                    &OriginalRecordsPage {
                        previous,
                        records: std::mem::replace(&mut current, Vec::with_capacity(PAGE_ENTRIES)),
                    },
                )?);
            }
        }
    }
    if ordinal != count {
        return Err(invalid(
            "selected imported record is missing from original raw source",
        ));
    }
    if !current.is_empty() {
        previous = Some(generated(
            c,
            builder,
            &OriginalRecordsPage {
                previous,
                records: current,
            },
        )?);
    }
    Ok(previous)
}
