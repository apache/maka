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

use super::read::{row_position, sql_number, sql_position};
use crate::{EventLog, StoreError, sequence_number, sessions};
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::SourceField;
use regex::{Regex, RegexBuilder};
use serde_json::Value;
use sqlx::{Row, SqliteConnection};

pub struct TranscriptSearch {
    pub through: u64,
    /// Exclusive last scanned row; None starts at the beginning.
    pub after: Option<RowPosition>,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_internal: bool,
    pub max_matches: usize,
}
pub struct TranscriptMatch {
    pub position: RowPosition,
    pub field: SourceField,
    pub preview: String,
}
pub struct TranscriptSearchBatch {
    pub matches: Vec<TranscriptMatch>,
    pub next_after: Option<RowPosition>,
}

impl EventLog {
    /// Search complete directory rows, reconstructing only each visited producer.
    /// At most 64 rows / 16 MiB of payload are searched per call. A body miss
    /// reconstructs and caches the selected producer, which can contain other rows.
    pub async fn search_transcript(
        &self,
        session: &str,
        input: TranscriptSearch,
    ) -> Result<TranscriptSearchBatch, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        let through = sql_number(input.through)?;
        let after = input.after.map(sql_position).transpose()?;
        if input.query.is_empty()
            || !(1..=64).contains(&input.max_matches)
            || input
                .after
                .is_some_and(|position| position.source_sequence > input.through)
        {
            return Err(StoreError::InvalidTransition(
                "invalid transcript search".into(),
            ));
        }
        let escaped = regex::escape(&input.query);
        let pattern = if input.whole_word {
            format!(r"\b{{start-half}}{escaped}\b{{end-half}}")
        } else {
            escaped
        };
        let matcher = RegexBuilder::new(&pattern)
            .case_insensitive(!input.case_sensitive)
            .build()
            .map_err(|_| StoreError::InvalidTransition("invalid transcript search".into()))?;
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| Box::pin(async move {
                    super::directory::ensure(tx, &session, input.through).await?;
                    let query = if after.is_some() {
                        "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 AND (source_sequence,item_index)>(?3,?4) ORDER BY source_sequence,item_index LIMIT 65"
                    } else {
                        "SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence,item_index LIMIT 65"
                    };
                    let mut query=sqlx::query(sqlx::AssertSqlSafe(query)).bind(&session).bind(through);
                    if let Some((source,item))=after { query=query.bind(source).bind(item); }
                    let headers=query.fetch_all(&mut *tx).await?;
                    let mut result = TranscriptSearchBatch {
                        matches: vec![],
                        next_after: None,
                    };
                    let mut bytes = 0;
                    let mut position = input.after;
                    for (index, header) in headers.iter().enumerate() {
                        if index == 64 || result.matches.len() == input.max_matches {
                            result.next_after = position;
                            break;
                        }
                        let locator = row_position(header.try_get(0)?,header.try_get(1)?)?;
                        super::bodycache::ensure(tx,&session,locator).await?;
                        let size: i64 = sqlx::query_scalar("SELECT total_bytes FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                            .bind(&session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_one(&mut *tx).await?;
                        let size = sequence_number(size)?;
                        if index > 0 && bytes + size > 16 * 1024 * 1024 {
                            result.next_after = position;
                            break;
                        }
                        bytes += size;
                        position = Some(locator);
                        let payload: Vec<u8> = sqlx::query_scalar(
                    "SELECT payload FROM temp.transcript_rows WHERE session_id = ? AND source_sequence = ? AND item_index = ?"
                ).bind(&session).bind(sql_position(locator)?.0).bind(sql_position(locator)?.1).fetch_one(&mut *tx).await?;
                        let row: Value = serde_json::from_slice(&payload)?;
                        if !input.include_internal
                            && internal(tx, &session, through, locator, &row).await?
                        {
                            continue;
                        }
                        if let Some((field, preview)) = matching_text(&row, &matcher) {
                            result.matches.push(TranscriptMatch {
                                position: locator,
                                field,
                                preview,
                            });
                        }
                    }

                    Ok(result)
                }))
            })
            .await
    }
}

async fn internal(
    tx: &mut SqliteConnection,
    session: &str,
    through: i64,
    position: RowPosition,
    row: &Value,
) -> Result<bool, StoreError> {
    // Errors remain discoverable even when normal orchestration is hidden.
    if row["isError"] == true {
        return Ok(false);
    }
    let owned;
    let call = if row["type"] == "tool_result" {
        owned = super::tool_metadata::read(tx, session, position, through).await?;
        let Some(call) = owned.call.as_ref() else {
            return Ok(false);
        };
        (row["origin"].as_str(), Some(call.name.as_str()))
    } else if row["type"] == "tool_call" {
        (row["origin"].as_str(), row["toolName"].as_str())
    } else {
        return Ok(false);
    };
    Ok(matches!(
        call,
        (Some("provider"), Some("wait" | "tool_search"))
            | (Some("code_mode"), Some("code_cell" | "tool_search"))
    ))
}

fn matching_text(row: &Value, matcher: &Regex) -> Option<(SourceField, String)> {
    let find = |field, value: &str| text(value, matcher).map(|preview| (field, preview));
    match row["type"].as_str()? {
        "user" => find(
            SourceField::Body,
            row["displayText"]
                .as_str()
                .or_else(|| row["text"].as_str())?,
        ),
        "assistant" => find(SourceField::Body, row["text"].as_str().unwrap_or("")).or_else(|| {
            find(
                SourceField::Thinking,
                row["thinking"]["text"].as_str().unwrap_or(""),
            )
        }),
        "tool_call" => find(
            SourceField::ToolName,
            row["toolName"].as_str().unwrap_or(""),
        )
        .or_else(|| {
            json_text(&row["args"], matcher).map(|preview| (SourceField::Arguments, preview))
        }),
        "tool_result" => match row["content"]["kind"].as_str()? {
            "text" => find(SourceField::Result, row["content"]["text"].as_str()?),
            "json" => json_text(&row["content"]["value"], matcher)
                .map(|preview| (SourceField::Result, preview)),
            "operation" => json_text(
                &row["content"]["reply"]["receipt"]["outcome"]["value"],
                matcher,
            )
            .map(|preview| (SourceField::Result, preview)),
            _ => None, // No searching image bytes or storage locators.
        },
        "turn_state" if row["status"] == "failed" => find(
            SourceField::FailureMessage,
            row["failureMessage"].as_str().unwrap_or(""),
        )
        .or_else(|| {
            find(
                SourceField::ErrorClass,
                row["errorClass"].as_str().unwrap_or(""),
            )
        }),
        _ => None,
    }
}
fn json_text(value: &Value, matcher: &Regex) -> Option<String> {
    match value {
        Value::String(value) => text(value, matcher),
        Value::Array(values) => values.iter().find_map(|value| json_text(value, matcher)),
        Value::Object(values) => {
            if matches!(value["type"].as_str(), Some("image" | "audio")) || value["kind"] == "image"
            {
                return None;
            }
            values
                .iter()
                .find_map(|(key, value)| text(key, matcher).or_else(|| json_text(value, matcher)))
        }
        Value::Null => None,
        value => text(&value.to_string(), matcher),
    }
}
fn text(value: &str, matcher: &Regex) -> Option<String> {
    let found = matcher.find(value)?.start();
    let start = value.floor_char_boundary(found.saturating_sub(64));
    let end = value.floor_char_boundary((start + 378).min(value.len()));
    let mut preview = String::new();
    if start > 0 {
        preview.push('…');
    }
    preview.extend(
        value[start..end]
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c }),
    );
    if end < value.len() {
        preview.push('…');
    }
    Some(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn literal(query: &str) -> Regex {
        Regex::new(&regex::escape(query)).unwrap()
    }
    #[test]
    fn search_is_literal_content_only_and_previews_are_bounded_unicode() {
        let row = json!({"type":"user","id":"private-id","text":"raw hidden","displayText":"中文🦀 needle"});
        assert_eq!(
            matching_text(&row, &literal("中文"))
                .map(|(_, preview)| preview)
                .as_deref(),
            Some("中文🦀 needle")
        );
        assert!(matching_text(&row, &literal("private-id")).is_none());
        assert!(matching_text(&row, &literal("hidden")).is_none());
        assert!(matching_text(&row, &literal("NEEDLE")).is_none());
        let operation = json!({"type":"tool_result","content":{"kind":"operation","reply":{
            "reference":{"method":"private-reference"},"receipt":{"outcome":{"value":{"text":"business 中😀", "number":42}}}
        }}});
        assert_eq!(
            matching_text(&operation, &literal("中😀")),
            Some((SourceField::Result, "business 中😀".into()))
        );
        assert!(matching_text(&operation, &literal("private-reference")).is_none());
        // Shape alone does not change ordinary JSON's content semantics.
        let ordinary = json!({"type":"tool_result","content":{"kind":"json","value":operation["content"]["reply"]}});
        assert!(matching_text(&ordinary, &literal("private-reference")).is_some());
        assert!(
            matching_text(
                &json!({"type":"tool_result","content":{"kind":"image","ref":"needle"}}),
                &literal("needle")
            )
            .is_none()
        );
        assert!(
            json_text(
                &json!({"content":[{"type":"image","data":"needle"}]}),
                &literal("needle")
            )
            .is_none()
        );
        assert!(
            json_text(
                &json!({"content":[{"type":"text","text":"needle"}]}),
                &literal("needle")
            )
            .is_some()
        );
        let preview = text(
            &format!("{}needle\n{}", "界".repeat(100), "界".repeat(200)),
            &literal("needle"),
        )
        .unwrap();
        assert!(
            preview.len() <= 384
                && preview.contains("needle ")
                && preview.starts_with('…')
                && preview.ends_with('…')
        );
        assert_eq!(text("a .* b", &literal(".*")).as_deref(), Some("a .* b"));
    }
}
