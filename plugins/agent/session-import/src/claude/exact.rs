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

use super::{Metadata, lineage::Index, wire::Row};
use crate::{
    Error, ExactPart, ExactRecord, ExactSink, ExactTranscript,
    access::ReadSource,
    exact::{
        content,
        lines::{Rows, unchanged},
    },
    jsonl,
};
use maka_agent_facts::history_snapshot::HistoricalRole;
use maka_capabilities::filesystem::PinnedFile;
use serde_json::Value;
use std::collections::BTreeMap;

pub async fn read(
    views: &(impl ReadSource + ?Sized),
    file: &PinnedFile,
    expected: &str,
    sink: &mut dyn ExactSink,
) -> Result<ExactTranscript, Error> {
    crate::transcript::identity(expected)?;
    let expected_owned = expected.to_owned();
    let length = file.info().length;
    let (index, metadata, fingerprint) = file
        .with_reader(move |reader| {
            Ok((|| {
                let mut index = Index::default();
                let mut metadata = Metadata::default();
                let fingerprint = jsonl::scan(reader, length, |line| {
                    let row: Row<'_> = line.decode()?;
                    metadata.accept(&row, &expected_owned)?;
                    index.accept(&row, &line)
                })?;
                if !metadata.matched {
                    return Err(Error::Invalid("Claude session identity is missing"));
                }
                Ok::<_, Error>((index.resolve(), metadata, fingerprint))
            })())
        })
        .await??;
    let mut rows = Rows::new(file);
    let mut calls = BTreeMap::new();
    let mut turn = None;
    let mut first_title = None;
    let mut readable = false;
    while let Some(raw) = rows.next().await {
        let mut messages = vec![];
        if let Some(row) = &raw.value {
            if index.keep_id(row.get("uuid").and_then(Value::as_str), raw.number) {
                let role = row.get("type").and_then(Value::as_str).unwrap_or("");
                let id = content::source_id(row.get("uuid"))?;
                if let Some(message) = row.get("message").filter(|message| message.is_object()) {
                    let content = message
                        .get("content")
                        .ok_or(Error::Invalid("Claude message content is absent"))?;
                    let has_results = content.as_array().is_some_and(|blocks| {
                        blocks.iter().any(|block| block["type"] == "tool_result")
                    });
                    if turn.is_none() || (role == "user" && !has_results) {
                        turn = Some(content::next_turn(turn)?);
                    }
                    let turn = turn.expect("message establishes an imported turn group");
                    let timestamp = content::timestamp(row.get("timestamp"), false)?;
                    let mut parts = Vec::new();
                    let blocks: Vec<&Value> = match content {
                        Value::Array(values) => values.iter().collect(),
                        value => vec![value],
                    };
                    for block in blocks {
                        match role {
                            "assistant" => {
                                let part = if let Some(value) = block.as_str() {
                                    content::text(value, false, content::options(message))
                                } else {
                                    content::assistant(block, &mut calls, "claude-code")?
                                };
                                parts.push((HistoricalRole::Assistant, part));
                            }
                            "user" | "system" => {
                                if block.get("type").and_then(Value::as_str) == Some("tool_result")
                                {
                                    let call = content::string(block, "tool_use_id")?;
                                    let name = calls.remove(call).ok_or_else(|| {
                                        Error::Unsupported(format!(
                                            "Claude tool result has no original call {call}"
                                        ))
                                    })?;
                                    let part = content::tool_result(
                                        views,
                                        call,
                                        name,
                                        block.get("content").ok_or(Error::Invalid(
                                            "Claude tool result content is absent",
                                        ))?,
                                        block
                                            .get("is_error")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false),
                                        metadata.cwd.as_deref(),
                                    )
                                    .await?;
                                    parts.push((HistoricalRole::Tool, part));
                                } else {
                                    let part =
                                        content::input(views, block, metadata.cwd.as_deref())
                                            .await?;
                                    let role = if role == "system" {
                                        HistoricalRole::System
                                    } else if row
                                        .get("isMeta")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false)
                                        || row
                                            .get("isCompactSummary")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false)
                                    {
                                        HistoricalRole::Context
                                    } else {
                                        HistoricalRole::User
                                    };
                                    if first_title.is_none()
                                        && let ExactPart::Input { content, .. } = &part
                                        && !content.text.trim().is_empty()
                                    {
                                        first_title = Some(crate::transcript::title(&content.text));
                                    }
                                    parts.push((role, part));
                                }
                            }
                            _ => {
                                return Err(Error::Unsupported(format!(
                                    "Claude message role {role}"
                                )));
                            }
                        }
                    }
                    let mut evidence = content::metadata(&row);
                    evidence
                        .as_object_mut()
                        .expect("metadata is an object")
                        .insert("originalProviderRole".into(), Value::String(role.into()));
                    messages = content::messages(parts, id, None, turn, timestamp, &evidence);
                    readable |= !messages.is_empty();
                }
            }
        }
        sink.record(ExactRecord {
            raw_record: raw.raw_record,
            messages,
        })
        .await?;
    }
    unchanged(&fingerprint, rows.finish().await?)?;
    if !readable {
        return Err(Error::Invalid("source contains no readable conversation"));
    }
    Ok(ExactTranscript {
        source: maka_agent_facts::import::Source {
            adapter: "claude-code".into(),
            session_id: expected.into(),
        },
        cwd: metadata.cwd,
        title: metadata
            .title
            .or(first_title)
            .unwrap_or_else(|| expected.into()),
        fingerprint,
    })
}
