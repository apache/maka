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

use maka_event_log::StoreError;
use rusqlite::{Connection, params};
use serde::{Deserialize, de::IgnoredAny};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeSet;

// The v50 host appended this exact paragraph to the caller's frozen declaration.
const FILE_READER_SUFFIX: &str = "\n\nAlso reads Maka resources (maka://session/<id>, maka://session/<id>/tool-results/<event-id>, attachment:<id>, archive:<event-id>). Pass page.next unchanged to continue reading.";

#[derive(Default, Deserialize)]
#[serde(default)]
struct FrozenSelection {
    definitions: Vec<Definition>,
    services: Vec<Service>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Definition {
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct Service {
    history_reader: Option<String>,
    selection: Option<Binding>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Binding {
    name: String,
    method: String,
    description: Option<String>,
    input: Option<String>,
    result: Option<String>,
}

impl Service {
    fn reader(&self, binding: &Binding, definitions: &BTreeSet<(&str, &str)>) -> &'static str {
        match self.history_reader.as_deref() {
            Some("file") => "file",
            Some("session") => "opaque",
            _ if binding.method == "execute"
                && binding.input.as_deref() == Some("shell")
                && binding.result.as_deref() == Some("json") =>
            {
                "plain"
            }
            _ if binding.method == "read"
                && binding
                    .description
                    .as_deref()
                    .is_some_and(|desc| definitions.contains(&(binding.name.as_str(), desc))) =>
            {
                "file"
            }
            _ => "opaque",
        }
    }
}

fn classify_bindings(c: &Connection) -> Result<(), StoreError> {
    let mut selections = c.prepare(
        "SELECT b.id,b.payload FROM (SELECT DISTINCT selection_id FROM legacy_run_selections) s
         CROSS JOIN contents b ON b.id=s.selection_id",
    )?;
    let mut insert = c.prepare("INSERT INTO legacy_bindings VALUES(?,?,?)")?;
    let mut rows = selections.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let payload = row.get_ref(1)?.as_bytes().map_err(rusqlite::Error::from)?;
        let selection: FrozenSelection = match serde_json::from_slice(payload) {
            Ok(selection) => selection,
            Err(error) if error.is_data() => continue, // Unrecognized bindings remain opaque.
            Err(error) => return Err(error.into()),
        };
        let file_definitions = selection
            .definitions
            .iter()
            .filter_map(|d| {
                Some((
                    d.name.as_str(),
                    d.description.as_deref()?.strip_suffix(FILE_READER_SUFFIX)?,
                ))
            })
            .collect();
        for service in &selection.services {
            if let Some(binding) = &service.selection {
                insert.execute(params![
                    id,
                    binding.name,
                    service.reader(binding, &file_definitions)
                ])?;
            }
        }
    }
    Ok(())
}

fn absent_or_empty(value: &Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

// Read the old wire shape directly. Text and any nested tool data can be large.
#[derive(Deserialize)]
struct ImportedPart<'a> {
    kind: String,
    #[serde(borrow)]
    content: Option<ImportedInput<'a>>,
}

#[derive(Deserialize)]
struct ImportedInput<'a> {
    #[serde(borrow)]
    text: Option<&'a RawValue>,
    directory_references: Option<Vec<IgnoredAny>>,
    attachments: Option<Vec<IgnoredAny>>,
    quotes: Option<Vec<IgnoredAny>>,
    inline_references: Option<Vec<IgnoredAny>>,
    preparation: Option<Vec<IgnoredAny>>,
}

fn text_only_part(payload: &[u8]) -> Result<bool, StoreError> {
    let part: ImportedPart = match serde_json::from_slice(payload) {
        Ok(part) => part,
        Err(error) if error.is_data() => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let Some(input) = part.content else {
        return Ok(false);
    };
    Ok(part.kind == "input"
        && input.text.is_some_and(|text| text.get().starts_with('"'))
        && [
            input.directory_references,
            input.attachments,
            input.quotes,
            input.inline_references,
            input.preparation,
        ]
        .iter()
        .flatten()
        .all(Vec::is_empty))
}

fn text_only_message(
    parts: &mut rusqlite::Statement<'_>,
    payload: &[u8],
) -> Result<bool, StoreError> {
    let message: Value = serde_json::from_slice(payload)?;
    if message["role"] != "user"
        || !message["providerMetadata"].is_null()
        || !absent_or_empty(&message["media"])
    {
        return Ok(false);
    }
    let Some(references) = message["parts"].as_array().filter(|p| !p.is_empty()) else {
        return Ok(false);
    };
    for reference in references {
        let Some(digest) = reference["digest"].as_str() else {
            return Ok(false);
        };
        let mut rows = parts.query([digest])?;
        let Some(row) = rows.next()? else {
            return Ok(false);
        };
        let payload = row.get_ref(0)?.as_bytes().map_err(rusqlite::Error::from)?;
        if !text_only_part(payload)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn classify_imports(c: &Connection) -> Result<(), StoreError> {
    let mut snapshots = c.prepare(
        "SELECT s.snapshot FROM (SELECT DISTINCT a.snapshot FROM legacy_candidates old
           JOIN agent_runs r ON r.run=old.run AND r.local=0
           JOIN agent_history_snapshot_adoptions a ON a.run=r.run) a
         CROSS JOIN agent_history_snapshots s ON s.snapshot=a.snapshot
         CROSS JOIN contents b ON b.id=s.manifest_content_id
         WHERE b.payload->>'$.origin.kind'='imported' AND NOT EXISTS (
           SELECT 1 FROM agent_history_snapshot_entries e WHERE e.snapshot=s.snapshot
           AND e.kind IN ('run','fact','source'))",
    )?;
    let mut messages = c.prepare(
        "SELECT m.payload FROM agent_history_snapshot_entries e
         LEFT JOIN contents m ON m.content_sha256=e.entry_json->>'$.message.digest'
         WHERE e.snapshot=? AND e.kind='imported'",
    )?;
    let mut parts = c.prepare("SELECT payload FROM contents WHERE content_sha256=?")?;
    let mut insert = c.prepare("INSERT INTO legacy_text_imports VALUES(?)")?;
    for snapshot in snapshots.query_map([], |r| r.get::<_, String>(0))? {
        let snapshot = snapshot?;
        let mut rows = messages.query([&snapshot])?;
        let mut text_only = false;
        while let Some(row) = rows.next()? {
            let payload = row
                .get_ref(0)?
                .as_bytes_or_null()
                .map_err(rusqlite::Error::from)?;
            text_only = match payload {
                Some(payload) => text_only_message(&mut parts, payload)?,
                None => false,
            };
            if !text_only {
                break;
            }
        }
        if text_only {
            insert.execute([snapshot])?;
        }
    }
    Ok(())
}

pub(crate) fn migrate(c: &Connection) -> Result<(), StoreError> {
    classify_bindings(c)?;
    classify_imports(c)?;
    c.execute_batch(
        "INSERT OR IGNORE INTO legacy_opaque SELECT run FROM legacy_opaque_calls;
         INSERT OR IGNORE INTO legacy_opaque
          SELECT r.run FROM legacy_candidates old JOIN agent_runs r ON r.run=old.run
          LEFT JOIN agent_history_snapshot_adoptions a ON a.run=r.run
          LEFT JOIN legacy_text_imports t ON t.snapshot=a.snapshot
          WHERE r.local=0 AND t.snapshot IS NULL;
         INSERT INTO legacy_boundary SELECT r.owner,r.session,min(r.admission_sequence)
          FROM legacy_opaque o JOIN agent_runs r ON r.run=o.run GROUP BY r.owner,r.session;
         INSERT INTO agent_memory_history_reads(run,revision)
          SELECT r.run,-1 FROM legacy_boundary b JOIN agent_runs r ON r.owner=b.owner AND r.session=b.session
          AND r.admission_sequence>=b.first_run JOIN legacy_candidates c ON c.run=r.run;
         INSERT INTO agent_memory_external_epochs(session)
          SELECT DISTINCT r.session FROM legacy_candidates c JOIN agent_run_specs r ON r.run=c.run
          JOIN session_control s ON s.id=r.session WHERE r.session IN (SELECT session FROM legacy_boundary);
         UPDATE agent_run_specs AS s SET unmarked_replay_shared=1 FROM agent_runs r, contents spec
          WHERE s.run=r.run AND spec.id=s.spec_content_id AND spec.payload->>'$.memoryAdmission' IS NULL
          AND NOT EXISTS(SELECT 1 FROM legacy_boundary b WHERE b.owner=r.owner
                         AND b.session=r.session AND b.first_run<=r.admission_sequence);
         DROP VIEW legacy_opaque_calls;
         DROP TABLE legacy_run_selections;
         DROP TABLE legacy_bindings;
         DROP TABLE legacy_text_imports;
         DROP TABLE legacy_boundary;
         DROP TABLE legacy_candidates;
         DROP TABLE legacy_opaque;",
    )?;
    crate::queue::migrate_memory_admissions(c)?;
    c.execute_batch("DROP TABLE pinned_queue_admissions;")?;
    Ok(())
}
