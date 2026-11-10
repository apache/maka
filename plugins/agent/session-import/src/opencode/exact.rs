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

use crate::{
    Error, ExactContent, ExactPart, ExactRecord, ExactSink, ExactTranscript, Fingerprint,
    access::ReadSource, exact::content,
};
use maka_agent_facts::{
    history_snapshot::HistoricalRole,
    model::{ModelPart, ModelToolCall, ToolInput},
};
use maka_capabilities::filesystem::database::{Cell, Query, Read, Table};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub async fn read(
    views: &(impl ReadSource + ?Sized),
    path: String,
    expected: &str,
    sink: &mut dyn ExactSink,
) -> Result<ExactTranscript, Error> {
    crate::transcript::identity(expected)?;
    let tables = views
        .query_database(Read {
            path,
            queries: [
                "SELECT * FROM session WHERE id=?1",
                "SELECT * FROM message WHERE session_id=?1 ORDER BY time_created,id",
                "SELECT * FROM part WHERE session_id=?1 ORDER BY message_id,id",
            ]
            .into_iter()
            .map(|sql| Query {
                sql: sql.into(),
                parameters: vec![Cell::Text(expected.into())],
            })
            .collect(),
        })
        .await?;
    let [session, messages, parts]: [Table; 3] = tables
        .try_into()
        .map_err(|_| Error::Invalid("incomplete OpenCode source snapshot"))?;
    let [session_row]: [Vec<Cell>; 1] = session
        .rows
        .try_into()
        .map_err(|_| Error::Invalid("OpenCode session missing or ambiguous"))?;
    if text(field(&session.columns, &session_row, "id")?)? != expected {
        return Err(Error::Invalid(
            "OpenCode snapshot differs from selected session",
        ));
    }
    if optional_text(field(&session.columns, &session_row, "parent_id")?)?
        .is_some_and(|value| !value.is_empty())
    {
        return Err(Error::Unsupported(
            "OpenCode child session is not a root transcript".into(),
        ));
    }
    let cwd = crate::transcript::source_cwd(
        optional_text(field(&session.columns, &session_row, "directory")?)?.map(str::to_owned),
    );
    let source_title = optional_text(field(&session.columns, &session_row, "title")?)?
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let revert = optional_text(field(&session.columns, &session_row, "revert")?)?
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let mut evidence = Evidence::default();
    emit(
        sink,
        &mut evidence,
        "session",
        &session.columns,
        &session_row,
        vec![],
    )
    .await?;
    let mut by_message = BTreeMap::<String, Vec<Vec<Cell>>>::new();
    let mut part_ids = BTreeSet::new();
    for row in parts.rows {
        let id = text(field(&parts.columns, &row, "id")?)?;
        crate::transcript::identity(id)?;
        if !part_ids.insert(id.to_owned()) {
            return Err(Error::Invalid("duplicate OpenCode part identity"));
        }
        let message = text(field(&parts.columns, &row, "message_id")?)?.to_owned();
        by_message.entry(message).or_default().push(row);
    }
    drop(part_ids);
    let mut turn = None;
    let mut seen = BTreeSet::new();
    let mut keep_messages = true;
    let mut saw_revert = revert.is_none();
    let mut title = source_title;
    let mut readable = false;
    for message_row in messages.rows {
        let id = text(field(&messages.columns, &message_row, "id")?)?;
        crate::transcript::identity(id)?;
        if !seen.insert(id.to_owned()) {
            return Err(Error::Invalid("duplicate OpenCode message identity"));
        }
        let data = decode_json(text(field(&messages.columns, &message_row, "data")?)?).await?;
        let role = content::string(&data, "role")?;
        if !matches!(role, "user" | "assistant") {
            return Err(Error::Unsupported(format!("OpenCode message role {role}")));
        }
        if role == "user" || turn.is_none() {
            turn = Some(content::next_turn(turn)?);
        }
        let turn = turn.expect("message establishes an imported turn group");
        let timestamp = if let Some(time) = data
            .get("time")
            .and_then(|time| time.get("created"))
            .filter(|time| !time.is_null())
        {
            content::timestamp(Some(time), false)?
        } else {
            match field(&messages.columns, &message_row, "time_created")? {
                Cell::Integer(value) if (0..=9_007_199_254_740_991).contains(value) => {
                    Some(*value as u64)
                }
                Cell::Null => None,
                _ => return Err(Error::Invalid("invalid OpenCode original timestamp")),
            }
        };
        let at_revert = revert
            .as_ref()
            .is_some_and(|value| value["messageID"] == id);
        let revert_part = revert
            .as_ref()
            .filter(|_| at_revert)
            .and_then(|value| value.get("partID"))
            .and_then(Value::as_str);
        if at_revert {
            saw_revert = true;
            if revert_part.is_none() {
                keep_messages = false;
            }
        }
        emit(
            sink,
            &mut evidence,
            "message",
            &messages.columns,
            &message_row,
            vec![],
        )
        .await?;
        let mut keep_parts = keep_messages;
        let mut saw_part = revert_part.is_none();
        for row in by_message.remove(id).unwrap_or_default() {
            let part_id = text(field(&parts.columns, &row, "id")?)?;
            if revert_part == Some(part_id) {
                keep_parts = false;
                saw_part = true;
            }
            let part = decode_json(text(field(&parts.columns, &row, "data")?)?).await?;
            let mut projected = Vec::new();
            if keep_parts {
                let kind = content::string(&part, "type")?;
                match kind {
                    "text" | "reasoning" => {
                        let text = content::string(&part, "text")?;
                        let options = content::options(&part)
                            .or_else(|| part.get("metadata").filter(|v| !v.is_null()).cloned());
                        let (role, value) = if role == "assistant" {
                            (
                                HistoricalRole::Assistant,
                                content::text(text, kind == "reasoning", options),
                            )
                        } else if kind == "reasoning" {
                            return Err(Error::Unsupported("OpenCode user reasoning part".into()));
                        } else {
                            (
                                if part
                                    .get("synthetic")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                                {
                                    HistoricalRole::Context
                                } else {
                                    HistoricalRole::User
                                },
                                ExactPart::Input {
                                    content: text.to_owned().into(),
                                    media: vec![],
                                },
                            )
                        };
                        if title.is_none()
                            && !text.trim().is_empty()
                            && role == HistoricalRole::User
                        {
                            title = Some(crate::transcript::title(text));
                        }
                        projected.push((role, value));
                    }
                    "file" if role == "user" => projected.push((
                        HistoricalRole::User,
                        content::input(views, &part, cwd.as_deref()).await?,
                    )),
                    "tool" if role == "assistant" => {
                        let call_id = content::string(&part, "callID")?;
                        let name = content::string(&part, "tool")?;
                        let state = part
                            .get("state")
                            .ok_or(Error::Invalid("OpenCode tool state is absent"))?;
                        let status = content::string(state, "status")?;
                        if status == "pending" {
                            return Err(Error::Unsupported(
                                "OpenCode pending tool input is not a complete call".into(),
                            ));
                        }
                        let input = state
                            .get("input")
                            .cloned()
                            .ok_or(Error::Invalid("OpenCode original tool input is absent"))?;
                        projected.push((
                            HistoricalRole::Assistant,
                            ExactPart::Model {
                                part: ModelPart::ToolCall {
                                    call: ModelToolCall {
                                        id: call_id.into(),
                                        name: name.into(),
                                        input: ToolInput::Json(input),
                                        provider_options: content::options(&part).or_else(|| {
                                            part.get("metadata").filter(|v| !v.is_null()).cloned()
                                        }),
                                        provider_executed: false,
                                    },
                                },
                            },
                        ));
                        match status {
                            "completed" | "error" => {
                                let output = if status == "error" {
                                    state.get("error")
                                } else {
                                    state.get("output")
                                }
                                .ok_or(Error::Invalid("OpenCode tool result body is absent"))?;
                                let mut result = content::tool_result(
                                    views,
                                    call_id,
                                    name.into(),
                                    output,
                                    status == "error",
                                    cwd.as_deref(),
                                )
                                .await?;
                                if let Some(attachments) =
                                    state.get("attachments").filter(|value| !value.is_null())
                                {
                                    let attachments =
                                        attachments.as_array().ok_or(Error::Invalid(
                                            "OpenCode tool attachments are not an array",
                                        ))?;
                                    let ExactPart::ToolReturn { projection, .. } = &mut result
                                    else {
                                        unreachable!()
                                    };
                                    for attachment in attachments {
                                        projection.push(ExactContent::Media(
                                            content::media(views, attachment, cwd.as_deref())
                                                .await?,
                                        ));
                                    }
                                }
                                projected.push((HistoricalRole::Tool, result));
                            }
                            "running" => {}
                            _ => {
                                return Err(Error::Unsupported(format!(
                                    "OpenCode tool status {status}"
                                )));
                            }
                        }
                    }
                    "step-start" | "step-finish" | "snapshot" | "patch" | "retry"
                    | "compaction" | "agent" => {}
                    _ => return Err(Error::Unsupported(format!("OpenCode {role} part {kind}"))),
                }
            }
            let metadata = json!({"originalProviderRole":role,"sourceMessageId":id,"sourcePartId":part_id,"message":content::metadata(&data),"part":content::metadata(&part)});
            let normalized =
                content::messages(projected, Some(id), None, turn, timestamp, &metadata);
            readable |= !normalized.is_empty();
            emit(
                sink,
                &mut evidence,
                "part",
                &parts.columns,
                &row,
                normalized,
            )
            .await?;
        }
        if !saw_part {
            return Err(Error::Invalid("OpenCode revert part is missing"));
        }
        if at_revert {
            keep_messages = false;
        }
    }
    if !by_message.is_empty() {
        return Err(Error::Invalid("orphaned OpenCode source part"));
    }
    if !saw_revert {
        return Err(Error::Invalid("OpenCode revert message is missing"));
    }
    if !readable {
        return Err(Error::Invalid("source contains no readable conversation"));
    }
    Ok(ExactTranscript {
        source: maka_agent_facts::import::Source {
            adapter: "opencode".into(),
            session_id: expected.into(),
        },
        cwd,
        title: title.unwrap_or_else(|| expected.into()),
        fingerprint: evidence.finish(),
    })
}
fn field<'a>(columns: &[String], row: &'a [Cell], name: &str) -> Result<&'a Cell, Error> {
    let index = columns
        .iter()
        .position(|column| column == name)
        .ok_or(Error::Invalid("OpenCode source column is absent"))?;
    row.get(index)
        .ok_or(Error::Invalid("OpenCode source row width is invalid"))
}
fn text(cell: &Cell) -> Result<&str, Error> {
    match cell {
        Cell::Text(value) => Ok(value),
        _ => Err(Error::Invalid("OpenCode source field is not text")),
    }
}
fn optional_text(cell: &Cell) -> Result<Option<&str>, Error> {
    match cell {
        Cell::Null => Ok(None),
        cell => text(cell).map(Some),
    }
}
#[derive(Default)]
struct Evidence {
    digest: Sha256,
    bytes: u64,
}
impl Evidence {
    fn finish(self) -> Fingerprint {
        Fingerprint {
            bytes: self.bytes,
            sha256: hex::encode(self.digest.finalize()),
            incomplete_tail: false,
        }
    }
}
async fn emit(
    sink: &mut dyn ExactSink,
    evidence: &mut Evidence,
    table: &str,
    columns: &[String],
    cells: &[Cell],
    messages: Vec<crate::ExactMessage>,
) -> Result<(), Error> {
    #[derive(Serialize)]
    struct Original<'a> {
        table: &'a str,
        columns: &'a [String],
        cells: &'a [Cell],
    }
    let raw_record = serde_json::to_vec(&Original {
        table,
        columns,
        cells,
    })?;
    let bytes = u64::try_from(raw_record.len())
        .map_err(|_| Error::Invalid("OpenCode original row size overflows"))?;
    evidence.digest.update(bytes.to_be_bytes());
    evidence.digest.update(&raw_record);
    evidence.bytes = evidence
        .bytes
        .checked_add(bytes)
        .ok_or(Error::Invalid("OpenCode source size overflows"))?;
    sink.record(ExactRecord {
        raw_record,
        messages,
    })
    .await
}

async fn decode_json(data: &str) -> Result<Value, Error> {
    let data = data.to_owned();
    Ok(tokio::task::spawn_blocking(move || serde_json::from_str(&data)).await??)
}
