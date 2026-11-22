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
use maka_agent_facts::executor::TaskDescriptor;
use maka_event_log::connection::Query;
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::IgnoredAny;

pub(crate) struct ReadItem(pub RunId, pub ExternalPublicationKey);
impl Query for ReadItem {
    type Output = Option<PublicationItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let body:Option<String>=c.query_row(
            "SELECT body FROM agent_external_publication_items WHERE run=? AND publication=? AND item_index=?",
            params![self.0.to_string(),self.1.publication.to_string(),signed(self.1.index)?],|row|row.get(0)
        ).optional()?;
        body.map(|body| {
            let item: PublicationItem = serde_json::from_str(&body)?;
            if item.key != self.1 {
                return Err(invalid(
                    "publication item differs from its original indexed identity",
                ));
            }
            Ok(item)
        })
        .transpose()
    }
}

pub(crate) struct ReadPublication(pub RunId, pub ExternalTaskId);
impl Query for ReadPublication {
    type Output = Option<ExternalPublication>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let value = load_run(c, self.0, &[], false)?;
        if value
            .as_ref()
            .is_some_and(|publication| publication.task != self.1)
        {
            return Err(invalid("publication belongs to another external task"));
        }
        Ok(value)
    }
}

fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("publication integer exceeds SQLite range"))
}
fn content_id(c: &Connection, reference: &ContentRef) -> Result<i64, StoreError> {
    reference.validate().map_err(invalid)?;
    Ok(c.query_row(
        "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
        params![reference.digest, signed(reference.bytes)?],
        |r| r.get(0),
    )?)
}
fn pin(c: &Connection, run: RunId, reference: &ContentRef) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO agent_content_pins(run,content_id) VALUES(?,?) ON CONFLICT DO NOTHING",
        params![run.to_string(), content_id(c, reference)?],
    )?;
    Ok(())
}
fn spec(c: &Connection, run: RunId) -> Result<RunSpec, StoreError> {
    let bytes:Vec<u8>=c.query_row("SELECT c.payload FROM agent_run_specs s JOIN contents c ON c.id=s.spec_content_id WHERE s.run=?",[run.to_string()],|r|r.get(0))?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    if spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported publication Run schema"));
    }
    Ok(spec)
}
fn header(c: &Connection, run: RunId) -> Result<Option<(u64, ExternalPublication)>, StoreError> {
    let value: Option<(i64, String, String, String)> = c
        .query_row(
            "SELECT revision,publication,task,body FROM agent_external_publications WHERE run=?",
            [run.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    value
        .map(|(revision, id, task, body)| {
            let publication: ExternalPublication = serde_json::from_str(&body)?;
            if publication.id.to_string() != id || publication.task.to_string() != task {
                return Err(invalid(
                    "publication index differs from its canonical identity",
                ));
            }
            Ok((
                u64::try_from(revision).map_err(|_| invalid("negative publication revision"))?,
                publication,
            ))
        })
        .transpose()
}

pub(crate) fn load_run(
    c: &Connection,
    run: RunId,
    facts: &[&Fact],
    all: bool,
) -> Result<Option<ExternalPublication>, StoreError> {
    let Some((_, mut publication)) = header(c, run)? else {
        return Ok(None);
    };
    let targets: Vec<u64> = facts
        .iter()
        .filter_map(|fact| match fact {
            Fact::ExternalPublication { event } => event.key(),
            Fact::Blocked {
                reason: BlockerKind::ExternalPublicationItem { key, .. },
                ..
            } => Some(*key),
            _ => None,
        })
        .filter(|key| key.publication == publication.id)
        .map(|key| key.index)
        .collect();
    let sql = if all {
        "SELECT item_index,body FROM agent_external_publication_items WHERE run=?1 AND publication=?2"
    } else {
        "SELECT item_index,body FROM agent_external_publication_items WHERE run=?1 AND publication=?2 AND retained=1
         UNION ALL SELECT item_index,body FROM agent_external_publication_items WHERE run=?1 AND publication=?2 AND retained=0 AND item_index IN (SELECT value FROM json_each(?3))"
    };
    let mut statement = c.prepare_cached(sql)?;
    let mut rows = if all {
        statement.query(params![run.to_string(), publication.id.to_string()])?
    } else {
        statement.query(params![
            run.to_string(),
            publication.id.to_string(),
            serde_json::to_string(&targets)?
        ])?
    };
    while let Some(row) = rows.next()? {
        let index = u64::try_from(row.get::<_, i64>(0)?)
            .map_err(|_| invalid("negative publication item index"))?;
        let item: PublicationItem = serde_json::from_str(&row.get::<_, String>(1)?)?;
        if item.key.publication != publication.id || item.key.index != index {
            return Err(invalid(
                "publication item index differs from its original identity",
            ));
        }
        publication.items.insert(index, item);
    }
    Ok(Some(publication))
}

pub(crate) fn persist(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    if recorded.run != run {
        return Err(invalid("publication event belongs to another Run"));
    }
    let Fact::ExternalPublication { event } = &recorded.fact else {
        return Err(invalid("not an external publication event"));
    };
    match event {
        ExternalPublicationEvent::Pending { task, source, .. } => {
            let original: ExternalPublicationSource<IgnoredAny> =
                serde_json::from_slice(&crate::sql::owned_content(c, run, source)?)?;
            let spec = spec(c, run)?;
            if original.schema_version != SCHEMA_VERSION
                || original.task != *task
                || original.execution.run_id != run
                || original.execution.session_id != spec.session_id
                || original.execution.turn_id != spec.turn_id
            {
                return Err(invalid(
                    "publication source differs from the original task execution",
                ));
            }
            // The public task envelope pins the original preparation independently
            // of the private snapshot descriptor. Neither is an execution grant.
            let bytes: Option<String> = c.query_row(
                "SELECT external FROM agent_runs WHERE run=?",
                [run.to_string()],
                |r| r.get(0),
            )?;
            let original_task: crate::fold::ExternalTask = serde_json::from_str(
                &bytes.ok_or_else(|| invalid("publication source has no actual task"))?,
            )?;
            if original_task.task != *task || !original_task.admitted {
                return Err(invalid("publication source belongs to another task"));
            }
            let _: TaskDescriptor<IgnoredAny> = serde_json::from_slice(
                &crate::sql::owned_content(c, run, &original_task.descriptor)?,
            )?;
            pin(c, run, &original_task.descriptor)?;
        }
        ExternalPublicationEvent::Prepared {
            id,
            manifest,
            item_count,
        } => {
            let (_, publication) =
                header(c, run)?.ok_or_else(|| invalid("publication has no pending source"))?;
            let plan: PublicationManifest<IgnoredAny, IgnoredAny> =
                serde_json::from_slice(&crate::sql::owned_content(c, run, manifest)?)?;
            let spec = spec(c, run)?;
            plan.basis.validate().map_err(invalid)?;
            if plan.schema_version != SCHEMA_VERSION
                || plan.publication != *id
                || plan.publication != publication.id
                || plan.task != publication.task
                || plan.source != publication.source
                || plan.basis != spec.permission_basis
                || u64::try_from(plan.changes.len())
                    .map_err(|_| invalid("publication manifest count exceeds u64"))?
                    != *item_count
            {
                return Err(invalid(
                    "publication manifest differs from its original source or actual item count",
                ));
            }
            signed(*item_count)?;
            for reference in plan.content_refs() {
                pin(c, run, reference)?;
            }
        }
        ExternalPublicationEvent::Admitted { basis, .. } => {
            let spec = spec(c, run)?;
            if !matches!(spec.origin, RunOrigin::Local)
                || *basis != spec.permission_basis
                || crate::interactions::sql::current_basis(c, &spec.session_id)? != Some(*basis)
            {
                return Err(invalid(
                    "publication item lacks its actual current permission boundary",
                ));
            }
        }
        _ => {}
    }
    replay(c, run, recorded)?;
    if let ExternalPublicationEvent::Bound { key, original } = event {
        c.execute("INSERT INTO agent_operation_pins(run,tool,reference_json) VALUES(?,?,?) ON CONFLICT DO NOTHING",params![run.to_string(),format!("publication:{}:{}",key.publication,key.index),serde_json::to_string(original)?])?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    id: ExternalPublicationId,
    task: ExternalTaskId,
    source: &'a ContentRef,
    manifest: Option<&'a ContentRef>,
    item_count: Option<u64>,
    admitted: u64,
    settled: u64,
    abandoned: bool,
}

/// Only historical facts shape these indexes; replay never consults today's
/// permission basis, dispatches a handler or reacquires a private capture.
pub(crate) fn replay(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    if recorded.run != run || recorded.schema_version != SCHEMA_VERSION {
        return Err(invalid("publication canonical identity mismatch"));
    }
    let Fact::ExternalPublication { event } = &recorded.fact else {
        return Err(invalid("not an external publication event"));
    };
    if header(c, run)?.is_some_and(|(revision, _)| revision >= recorded.revision) {
        return Err(invalid("publication projection revision is not increasing"));
    }
    let mut publication = load_run(c, run, &[&recorded.fact], false)?;
    update(&mut publication, event)?;
    let publication = publication.as_ref().expect("folded publication");
    let body = serde_json::to_string(&Header {
        id: publication.id,
        task: publication.task,
        source: &publication.source,
        manifest: publication.manifest.as_ref(),
        item_count: publication.item_count,
        admitted: publication.admitted,
        settled: publication.settled,
        abandoned: publication.abandoned,
    })?;
    c.execute("INSERT INTO agent_external_publications(run,publication,task,revision,body) VALUES(?,?,?,?,?) ON CONFLICT(run) DO UPDATE SET revision=excluded.revision,body=excluded.body",params![run.to_string(),publication.id.to_string(),publication.task.to_string(),signed(recorded.revision)?,body])?;
    if let Some(key) = event.key() {
        let item = publication
            .items
            .get(&key.index)
            .expect("folded publication item");
        c.execute("INSERT INTO agent_external_publication_items(run,publication,item_index,revision,retained,body) VALUES(?,?,?,?,?,?) ON CONFLICT(run,publication,item_index) DO UPDATE SET revision=excluded.revision,retained=excluded.retained,body=excluded.body",params![run.to_string(),key.publication.to_string(),signed(key.index)?,signed(recorded.revision)?,item.retained(),serde_json::to_string(item)?])?;
    }
    Ok(())
}
