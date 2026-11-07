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

use crate::StoreError;
use maka_agent_facts::attachment::AttachmentRef;
use maka_presentation::{Content, Row, ToolContent, TurnState};
use rusqlite::{Connection, params};
use std::borrow::Cow;

pub(crate) fn record_rows(
    db: &Connection,
    session: &str,
    source: i64,
    rows: &[Row],
) -> Result<(), StoreError> {
    let mut identity = db.prepare_cached(
        "SELECT rowid,message_id FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3",
    )?;
    let mut insert = db.prepare_cached("INSERT INTO recall_terms(rowid,grams) VALUES(?1,?2)")?;
    for row in rows {
        let (id, message): (i64, String) = identity.query_row(
            params![session, source, super::number(row.position.item_index)?],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if message != row.message.id {
            return Err(StoreError::TranscriptConflict);
        }
        let body = body(db, &row.message.content)?;
        let folded = super::fold(&body);
        if !folded.is_empty() {
            insert.execute(params![id, super::grams(&folded)])?;
        }
    }
    Ok(())
}

pub(super) fn body<'a>(db: &Connection, content: &'a Content) -> Result<Cow<'a, str>, StoreError> {
    Ok(match content {
        Content::User {
            text,
            display_text,
            attachments,
            directory_references,
            ..
        } => {
            let text = display_text.as_ref().unwrap_or(text);
            if attachments.as_ref().is_none_or(Vec::is_empty)
                && directory_references.as_ref().is_none_or(Vec::is_empty)
            {
                return Ok(Cow::Borrowed(text));
            }
            let mut lines = Vec::new();
            if !text.is_empty() {
                lines.push(text.clone());
            }
            for attachment in attachments.iter().flatten() {
                let bytes = attachment.bytes;
                let size = if bytes < 1024 {
                    format!("{bytes} B")
                } else if bytes < 1_048_576 {
                    db.query_row(
                        "SELECT printf('%.1f KiB',?1 / 1024.0)",
                        [bytes as f64],
                        |row| row.get::<_, String>(0),
                    )?
                } else {
                    db.query_row(
                        "SELECT printf('%.1f MiB',?1 / 1048576.0)",
                        [bytes as f64],
                        |row| row.get::<_, String>(0),
                    )?
                };
                lines.push(format!("↳ {} · {size}", attachment.name));
            }
            for directory in directory_references.iter().flatten() {
                lines.push(format!("▱ {}", directory.path));
            }
            Cow::Owned(lines.join("\n"))
        }
        Content::Assistant { text, .. } => Cow::Borrowed(text),
        Content::ModelInterruption { message } => Cow::Borrowed(message),
        Content::TurnState {
            state:
                TurnState::Failed {
                    error_class,
                    failure_message,
                },
        } => Cow::Borrowed(
            failure_message
                .as_deref()
                .filter(|message| !message.is_empty())
                .or_else(|| (!error_class.is_empty()).then_some(error_class.as_str()))
                .unwrap_or("failed"),
        ),
        Content::ToolCall {
            tool_name, args, ..
        } => tool_call_text(tool_name, args),
        Content::ToolResult { content, .. } => match content {
            ToolContent::Text { text } => Cow::Borrowed(text),
            ToolContent::Json { value } => Cow::Owned(json_text(value)),
            ToolContent::Operation { reply } => match &reply.receipt {
                maka_plugin_core::operation::Receipt::Recorded {
                    outcome: maka_plugin_core::operation::OperationOutcome::Returned { value },
                    ..
                } => Cow::Owned(json_text(value)),
                _ => Cow::Borrowed(""),
            },
            ToolContent::Image { .. } => Cow::Borrowed(""),
        },
        _ => Cow::Borrowed(""),
    })
}

pub(super) fn attachments(content: &Content) -> Vec<AttachmentRef> {
    match content {
        Content::User {
            attachments: Some(attachments),
            ..
        } => attachments.clone(),
        _ => Vec::new(),
    }
}

fn tool_call_text<'a>(tool_name: &'a str, args: &'a serde_json::Value) -> Cow<'a, str> {
    let mut out = String::new();
    append_tool_args(&mut out, None, args);
    if out.is_empty() {
        return Cow::Borrowed(tool_name);
    }
    if tool_name.is_empty() {
        return Cow::Owned(out);
    }
    let mut full = String::with_capacity(tool_name.len() + 1 + out.len());
    full.push_str(tool_name);
    full.push('\n');
    full.push_str(&out);
    Cow::Owned(full)
}

fn append_tool_args(out: &mut String, prefix: Option<&str>, value: &serde_json::Value) {
    match value {
        serde_json::Value::Null => {}
        serde_json::Value::Bool(flag) => {
            push_arg_line(out, prefix, if *flag { "true" } else { "false" })
        }
        serde_json::Value::Number(number) => push_arg_line(out, prefix, &number.to_string()),
        serde_json::Value::String(text) => {
            if !text.is_empty() {
                push_arg_line(out, prefix, text);
            }
        }
        serde_json::Value::Array(values) => {
            for item in values {
                append_tool_args(out, prefix, item);
            }
        }
        serde_json::Value::Object(entries) => {
            for (key, entry) in entries {
                match prefix {
                    Some(parent) if !parent.is_empty() => {
                        let nested = format!("{parent}.{key}");
                        append_tool_args(out, Some(&nested), entry);
                    }
                    _ => append_tool_args(out, Some(key), entry),
                }
            }
        }
    }
}

fn push_arg_line(out: &mut String, prefix: Option<&str>, text: &str) {
    if !out.is_empty() {
        out.push('\n');
    }
    if let Some(key) = prefix {
        out.push_str(key);
        out.push_str(": ");
    }
    out.push_str(text);
}

fn json_text(value: &serde_json::Value) -> String {
    fn append(value: &serde_json::Value, body: &mut String, first: &mut bool) {
        match value {
            serde_json::Value::String(text) => {
                if !*first {
                    body.push('\n');
                }
                *first = false;
                body.push_str(text);
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    append(value, body, first);
                }
            }
            serde_json::Value::Object(values) => {
                for value in values.values() {
                    append(value, body, first);
                }
            }
            _ => {}
        }
    }
    let mut body = String::new();
    let mut first = true;
    append(value, &mut body, &mut first);
    body
}

pub(crate) fn mark_progress(
    db: &Connection,
    session: &str,
    through: i64,
) -> Result<(), StoreError> {
    db.prepare_cached("INSERT INTO recall_progress VALUES(?1,?2) ON CONFLICT(owner_key) DO UPDATE SET through_source_sequence=excluded.through_source_sequence")?
        .execute(params![session, through])?;
    Ok(())
}

pub(crate) fn reset_session(db: &Connection, session: &str) -> Result<(), StoreError> {
    db.prepare_cached("DELETE FROM recall_progress WHERE owner_key=?")?
        .execute([session])?;
    Ok(())
}

pub(super) fn visible_sessions(
    db: &Connection,
    prefix: &str,
    session: Option<&str>,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<String>, StoreError> {
    let query = format!(
        "SELECT s.id FROM session_control s {} AND (?2 IS NULL OR s.id=?2) ORDER BY s.id",
        super::VISIBLE,
    );
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![prefix, session])?;
    let mut sessions = Vec::new();
    while let Some(row) = rows.next()? {
        super::check(cancellation)?;
        sessions.push(row.get(0)?);
    }
    Ok(sessions)
}

pub(super) fn ensure_session(
    db: &Connection,
    session: &str,
    through: u64,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), StoreError> {
    super::check(cancellation)?;
    crate::transcript::directory::ensure_recall_on_handle(db, session, through, cancellation)
}
