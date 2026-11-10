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
use maka_agent_facts::{
    attachment::StorageRef,
    cells::{CellEvent, CellId},
    tool_output::ImageOutput,
};
use rusqlite::Connection;
use serde::de::IgnoredAny;
use std::collections::BTreeSet;

// Metadata-only view of facts::cells::CellObservation/CellOutput. IgnoredAny
// streams past arbitrary user values and inline media without allocating them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    #[serde(rename = "state")]
    _state: Completed,
    cell_id: CellId,
    content: Vec<Output>,
    #[serde(rename = "result")]
    _result: IgnoredAny,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Completed {
    Completed,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum OutputKind {
    Text,
    Image,
    Media,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Output {
    kind: OutputKind,
    image: Option<ImageOutput>,
    #[serde(rename = "text")]
    _text: Option<IgnoredAny>,
    #[serde(rename = "content")]
    _content: Option<IgnoredAny>,
    #[serde(rename = "detail")]
    _detail: Option<IgnoredAny>,
}
pub(super) fn completed(
    c: &Connection,
    run: RunId,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    let Fact::Cell {
        event: CellEvent::Completed { cell, result, .. },
    } = &recorded.fact
    else {
        return Ok(());
    };
    let Observation {
        cell_id, content, ..
    } = tool::owned_decode(c, run, result)?;
    if cell_id != *cell || recorded.run != run {
        return Err(invalid(
            "Cell completion media source differs from original Cell/Run",
        ));
    }
    let spec = tool::run_spec(c, run)?;
    let run_scope = ArtifactReadScope::from(ArtifactScope {
        owner: spec.owner.clone(),
        session: spec.session_id.clone(),
        run,
        through: recorded.revision,
    });
    let session_scope = ArtifactReadScope::from(SessionScope {
        owner: spec.owner.clone(),
        session: spec.session_id.clone(),
    });
    let mut seen = BTreeSet::new();
    for output in content {
        let image = match (output.kind, output.image) {
            (OutputKind::Image, Some(image)) => image,
            (OutputKind::Text | OutputKind::Media, None) => continue,
            _ => {
                return Err(invalid(
                    "Cell image descriptor differs from its output kind",
                ));
            }
        };
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &image.reference
        else {
            return Err(invalid(
                "Cell image requires an immutable artifact captured by its native producer",
            ));
        };
        if session_id != &spec.session_id {
            return Err(invalid(
                "Cell image requires an explicitly authorized session copy",
            ));
        }
        let material = match read::lookup(c, &run_scope, relative_path)? {
            Some(material) => material,
            None => read::lookup(c, &session_scope, relative_path)?.ok_or_else(|| {
                invalid("Cell image lacks original Run/session artifact evidence")
            })?,
        };
        if material.record.artifact.mime_type.as_deref() != Some(image.mime_type.as_str()) {
            return Err(invalid("Cell image MIME differs from original artifact"));
        }
        if !seen.insert(relative_path.clone()) {
            continue;
        }
        tool::bind(
            c,
            run,
            &spec,
            &material.record,
            tool::BindingEvidence {
                fact: recorded.id,
                revision: recorded.revision,
                source: result,
                origin: &tool::BindingOrigin::Cell { cell: *cell },
            },
        )?;
    }
    Ok(())
}
