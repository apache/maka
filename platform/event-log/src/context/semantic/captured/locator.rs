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

//! Only the typed semantic writer's fixed metadata schema is decoded here.
use crate::StoreError;
use maka_agent_facts::history::RowPosition;
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
struct Row {
    revision: u64,
    kind: Kind,
}
#[derive(Deserialize)]
enum Kind {
    User { payload: RowPosition },
    ImportedUser { payload: RowPosition },
    ImportedAssistant { payload: RowPosition },
    ExecutorText { payload: RowPosition },
    ToolResult { payload: RowPosition },
    Notification { payload: RowPosition },
    AssistantPart { payload: Part },
    UnknownTool {},
}
#[derive(Deserialize)]
enum Part {
    Complete(RowPosition),
    Text { part: RowPosition, end: u64 },
}
pub(super) enum Locator {
    Fragment(RowPosition),
    Text { part: RowPosition, through: u64 },
}
#[derive(Deserialize)]
struct ArtifactRow {
    source: maka_agent_facts::artifact::ArtifactSource,
}
pub(super) fn artifact_user_deletable(reader: &mut dyn Read) -> Result<bool, StoreError> {
    let mut reader = Buffered {
        reader,
        bytes: [0; 32 * 1024],
        start: 0,
        end: 0,
    };
    let row: ArtifactRow = serde_json::from_reader(&mut reader)?;
    Ok(row.source.user_deletable())
}

pub(super) fn read(reader: &mut dyn Read, revision: u64) -> Result<Option<Locator>, StoreError> {
    // The metadata writer emits fixed short keys and externally tagged variants.
    // Omitted identifiers are skipped with IgnoredAny, never String/Value/RawValue.
    let mut reader = Buffered {
        reader,
        bytes: [0; 32 * 1024],
        start: 0,
        end: 0,
    };
    let row: Row = serde_json::from_reader(&mut reader)?;
    if row.revision != revision {
        return Err(super::invalid(
            "captured semantic metadata revision changed",
        ));
    }
    let locator = match row.kind {
        Kind::User { payload }
        | Kind::ImportedUser { payload }
        | Kind::ImportedAssistant { payload }
        | Kind::ExecutorText { payload }
        | Kind::ToolResult { payload }
        | Kind::Notification { payload }
        | Kind::AssistantPart {
            payload: Part::Complete(payload),
        } => Some(Locator::Fragment(payload)),
        Kind::AssistantPart {
            payload: Part::Text { part, end },
        } => Some(Locator::Text { part, through: end }),
        Kind::UnknownTool {} => None,
    };
    Ok(locator)
}
struct Buffered<'a> {
    reader: &'a mut dyn Read,
    bytes: [u8; 32 * 1024],
    start: usize,
    end: usize,
}
impl Read for Buffered<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.start == self.end {
            self.end = self.reader.read(&mut self.bytes)?;
            self.start = 0;
        }
        let take = output.len().min(self.end - self.start);
        output[..take].copy_from_slice(&self.bytes[self.start..self.start + take]);
        self.start += take;
        Ok(take)
    }
}
