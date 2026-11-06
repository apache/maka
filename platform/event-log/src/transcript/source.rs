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

use super::{
    read::{row_position, sql_number, sql_position},
    tool_metadata::read as tool_metadata,
};
use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::HistorySource;
use maka_agent_ports::session::history::SourceField;
use maka_agent_ports::session::history::SourceFormat;
use maka_agent_ports::session::history::SourcePosition;
use maka_agent_ports::session::history::SourceRole;
use maka_agent_ports::session::history::SourceSegment;
use rusqlite::OptionalExtension;

fn source_sql() -> String {
    format!("WITH original AS (SELECT
    CASE ?4
    WHEN 'body' THEN CASE WHEN json_extract(payload, '$.type') IN ('user', 'assistant', 'tool_call', 'tool_result', 'model_interruption') OR (json_extract(payload, '$.type') = 'turn_state' AND json_extract(payload, '$.status') = 'failed') THEN {body} END
    WHEN 'thinking' THEN CASE WHEN json_extract(payload, '$.type') = 'assistant' THEN json_extract(payload, '$.thinking.text') END
    WHEN 'tool_name' THEN CASE WHEN json_extract(payload, '$.type') = 'tool_call' THEN json_extract(payload, '$.toolName') END
    WHEN 'failure_message' THEN CASE WHEN json_extract(payload, '$.type') = 'turn_state' AND json_extract(payload, '$.status') = 'failed' THEN json_extract(payload, '$.failureMessage') END
    WHEN 'error_class' THEN CASE WHEN json_extract(payload, '$.type') = 'turn_state' AND json_extract(payload, '$.status') = 'failed' THEN json_extract(payload, '$.errorClass') END
    WHEN 'arguments' THEN CASE WHEN json_extract(payload, '$.type') = 'tool_call' THEN payload -> '$.args' END
    WHEN 'result' THEN CASE WHEN json_extract(payload, '$.type') = 'tool_result' THEN
        CASE json_extract(payload, '$.content.kind') WHEN 'text' THEN json_extract(payload, '$.content.text')
        WHEN 'json' THEN payload -> '$.content.value' WHEN 'image' THEN payload -> '$.content'
        WHEN 'operation' THEN payload -> '$.content.reply.receipt.outcome.value' END END
    WHEN 'receipt' THEN CASE WHEN json_extract(payload, '$.type') = 'tool_result' AND json_extract(payload, '$.content.kind') = 'operation' THEN payload -> '$.content.reply' END END AS body,
    CASE ?4 WHEN 'arguments' THEN 'json' WHEN 'receipt' THEN 'json' WHEN 'result' THEN
        CASE json_extract(payload, '$.content.kind') WHEN 'text' THEN 'text' WHEN 'json' THEN 'json'
        WHEN 'image' THEN 'image_descriptor' WHEN 'operation' THEN 'json' END ELSE 'text' END AS format,
    json_extract(payload, '$.type') AS role,
    CASE WHEN json_extract(payload, '$.type') = 'user' THEN payload -> '$.origin' END AS message_origin,
    json_extract(payload, '$.ts') AS timestamp,
    json_type(payload, '$.thinking.text') IS 'text' AS thinking,
    json_type(payload, '$.failureMessage') IS 'text' AS failure_message,
    json_type(payload, '$.errorClass') IS 'text' AS error_class,
    json_extract(payload, '$.content.kind') IS 'operation' AS operation
    FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3),
    source AS (SELECT
        CASE WHEN ?5 IS NULL THEN body WHEN format = 'json' THEN
            CASE json_type(body, ?5) WHEN 'text' THEN json_extract(body, ?5) ELSE body -> ?5 END END AS body,
        CASE WHEN ?5 IS NULL THEN format WHEN format = 'json' THEN
            CASE json_type(body, ?5) WHEN 'text' THEN 'text' ELSE 'json' END END AS format,
        role, timestamp, thinking, failure_message, error_class, operation, message_origin FROM original)", body = super::history::BODY)
}

impl EventLog {
    /// Locate the original call in the complete immutable directory.
    pub async fn tool_source_position(
        &self,
        session: &str,
        through: u64,
        tool_use_id: &str,
    ) -> Result<RowPosition, StoreError> {
        crate::sessions::validate_id(session)?;
        let fence = through;
        let fence_sql = sql_number(fence)?;
        let session = session.to_owned();
        let tool_use_id = tool_use_id.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, fence)?;
                    let (source, item): (i64, i64) = tx
                        .query_row(
                            "SELECT source_sequence,item_index FROM transcript_directory
                 WHERE owner_key = ? AND message_id = ? AND source_sequence <= ?
                 AND role = 'tool_call'",
                            rusqlite::params![&session, tool_use_id, fence_sql],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?
                        .ok_or_else(|| invalid("history source was not found"))?;
                    row_position(source, item)
                })
            })
            .await
    }
    /// Reads one selected immutable canonical field with a bounded UTF-8 body.
    pub async fn history_source(
        &self,
        session: &str,
        through: u64,
        selection: crate::transcript::SourceSelection,
        position: SourcePosition,
        max_bytes: usize,
    ) -> Result<HistorySource, StoreError> {
        let crate::transcript::SourceSelection {
            locator,
            field,
            path,
        } = selection;
        crate::sessions::validate_id(session)?;
        if !(4..=128 * 1024).contains(&max_bytes) {
            return Err(invalid("invalid history source limits"));
        }
        let json_path = json_path(field, path.as_deref())?;
        let fence = through;
        if locator.source_sequence > fence {
            return Err(invalid("history source exceeds its fence"));
        }
        let (source_sequence_sql, item_sql) = sql_position(locator)?;
        let fence_sql = sql_number(fence)?;
        let session = session.to_owned();
        let selected = match field {
            SourceField::Body => "body",
            SourceField::Thinking => "thinking",
            SourceField::ToolName => "tool_name",
            SourceField::FailureMessage => "failure_message",
            SourceField::ErrorClass => "error_class",
            SourceField::Arguments => "arguments",
            SourceField::Result => "result",
            SourceField::Receipt => "receipt",
        };
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, fence)?;
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)", rusqlite::params![&session], |row| row.get(0))
                    ?;
                    if !exists {
                        return Err(invalid("Session no longer exists"));
                    }
                    super::bodycache::ensure(tx, &session, locator)?;
                    let sql = source_sql();
                    let header = format!(
                        "{sql} SELECT format, length(CAST(body AS BLOB)), role, thinking, failure_message, error_class, timestamp, operation, message_origin FROM source"
                    );
                    let header = tx.query_row(&header, rusqlite::params![&session, source_sequence_sql, item_sql, selected, json_path.as_deref()], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, String>(2)?, row.get::<_, bool>(3)?, row.get::<_, bool>(4)?, row.get::<_, bool>(5)?, row.get::<_, i64>(6)?, row.get::<_, bool>(7)?, row.get::<_, Option<String>>(8)?,))).optional()
                            ?
                            .ok_or_else(|| invalid("history source was not found"))?;
                    let format: Option<String> = header.0;
                    let total: Option<i64> = header.1;
                    let role: String = header.2;
                    let thinking: bool = header.3;
                    let failure_message: bool = header.4;
                    let error_class: bool = header.5;
                    let timestamp: i64 = header.6;
                    let operation: bool = header.7;
                    let origin: Option<String> = header.8;
                    let total = sequence_number(
                        total.ok_or_else(|| invalid("field is not a history source"))?,
                    )?;
                    let format = match format.as_deref() {
                        Some("text") => SourceFormat::Text,
                        Some("json") => SourceFormat::Json,
                        Some("image_descriptor") => SourceFormat::ImageDescriptor,
                        _ => return Err(invalid("invalid history source format")),
                    };
                    let (role, fields) = match role.as_str() {
                        "user" => (SourceRole::User, vec![SourceField::Body]),
                        "assistant" => (SourceRole::Assistant, if thinking {
                            vec![SourceField::Thinking, SourceField::Body]
                        } else { vec![SourceField::Body] }),
                        "tool_call" => (SourceRole::ToolCall, vec![SourceField::ToolName, SourceField::Body, SourceField::Arguments]),
                        "tool_result" => (SourceRole::ToolResult, if operation { vec![SourceField::Body, SourceField::Result, SourceField::Receipt] } else { vec![SourceField::Body, SourceField::Result] }),
                        "model_interruption" => (SourceRole::Failure, vec![SourceField::Body]),
                        "turn_state" => (SourceRole::Failure, [
                            Some(SourceField::Body),
                            error_class.then_some(SourceField::ErrorClass),
                            failure_message.then_some(SourceField::FailureMessage),
                        ].into_iter().flatten().collect()),
                        _ => return Err(invalid("invalid history source role")),
                    };
                    if !fields.contains(&field) { return Err(invalid("field is not a history source")); }
                    let read =
                        format!("{sql} SELECT substr(CAST(body AS BLOB), ?6, ?7) FROM source");
                    let offset = match position {
                        SourcePosition::Start => 0,
                        SourcePosition::Tail => total,
                        SourcePosition::Before { offset } | SourcePosition::After { offset } => {
                            offset
                        }
                    };
                    sql_number(offset)?;
                    if offset > total {
                        return Err(invalid("history source offset exceeds field"));
                    }
                    if offset < total {
                        let byte: Vec<u8> = tx.query_row(read.as_str(), rusqlite::params![&session, source_sequence_sql, item_sql, selected, json_path.as_deref(), sql_number(offset)? + 1, 1i64], |row| row.get(0))?;
                        if byte.first().is_some_and(|byte| byte & 0xc0 == 0x80) {
                            return Err(invalid("history source offset splits UTF-8"));
                        }
                    }
                    let reverse = matches!(
                        position,
                        SourcePosition::Tail | SourcePosition::Before { .. }
                    );
                    let (mut start, end) = if reverse {
                        (offset.saturating_sub(max_bytes as u64), offset)
                    } else {
                        (offset, total.min(offset + max_bytes as u64))
                    };
                    let bytes: Vec<u8> = if start == end {
                        Vec::new()
                    } else {
                        tx.query_row(read.as_str(), rusqlite::params![&session, source_sequence_sql, item_sql, selected, json_path.as_deref(), sql_number(start)? + 1, (end - start) as i64], |row| row.get(0))?
                    };
                    let text = if reverse {
                        let skipped = bytes
                            .iter()
                            .take_while(|byte| **byte & 0xc0 == 0x80)
                            .count();
                        start += skipped as u64;
                        std::str::from_utf8(&bytes[skipped..])
                            .map_err(|_| invalid("invalid UTF-8 history source"))?
                    } else {
                        match std::str::from_utf8(&bytes) {
                            Ok(text) => text,
                            Err(error) if error.error_len().is_none() => {
                                std::str::from_utf8(&bytes[..error.valid_up_to()])
                                    .map_err(|_| invalid("invalid UTF-8 history source"))?
                            }
                            Err(_) => return Err(invalid("invalid UTF-8 history source")),
                        }
                    };
                    if text.is_empty() && start < total && !(reverse && offset == 0) {
                        return Err(invalid("history source made no progress"));
                    }
                    let tool = if matches!(role, SourceRole::ToolCall | SourceRole::ToolResult) {
                        Some(tool_metadata(tx, &session, locator, fence_sql)?)
                    } else {
                        None
                    };
                    let model = if role == SourceRole::Assistant {
                        super::model::resolve(tx, &session, locator, sql_number(through)?)?.model
                    } else { None };
                    let source = HistorySource {
                        model,
                        origin: origin.map(|value| serde_json::from_str(&value)).transpose()?,
                        position: locator,
                        timestamp: sequence_number(timestamp)?,
                        role,
                        fields,
                        field,
                        path,
                        format,
                        offset: start,
                        total_bytes: total,
                        text: text.to_owned(),
                        tool,
                    };

                    Ok(source)
                })
            })
            .await
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn json_path(
    field: SourceField,
    path: Option<&[SourceSegment]>,
) -> Result<Option<String>, StoreError> {
    let Some(path) = path else { return Ok(None) };
    if !matches!(
        field,
        SourceField::Arguments | SourceField::Result | SourceField::Receipt
    ) {
        return Err(invalid("invalid structured history source path"));
    }
    let mut result = String::from("$");
    for segment in path {
        match segment {
            SourceSegment::Key(key) => {
                result.push('.');
                result.push_str(&serde_json::to_string(key)?);
            }
            SourceSegment::Index(index) => result.push_str(&format!("[{index}]")),
        }
    }
    Ok(Some(result))
}
