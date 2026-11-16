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

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryReference {
    pub host_id: String,
    pub path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRef {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SessionQuoteSource>,
}

/// Display provenance of an immutable excerpt, never authority to read its source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuoteSource {
    pub session_id: String,
    pub session_name: String,
    pub captured_at: CaptureTime,
    pub truncated: bool,
}

/// JavaScript epoch milliseconds, preserving fractional timestamps within Date's range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "serde_json::Number", into = "serde_json::Number")]
pub struct CaptureTime(serde_json::Number);

impl TryFrom<serde_json::Number> for CaptureTime {
    type Error = &'static str;

    fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> {
        if value
            .as_f64()
            .is_some_and(|value| (0.0..=8_640_000_000_000_000.0).contains(&value))
        {
            Ok(Self(value))
        } else {
            Err("invalid Session quote capture time")
        }
    }
}

impl From<CaptureTime> for serde_json::Number {
    fn from(value: CaptureTime) -> Self {
        value.0
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineReference {
    pub kind: InlineReferenceKind,
    pub value: String,
    pub label: String,
    pub start: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InlineReferenceKind {
    Skill,
    WorkspaceFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionReferenceKind {
    Room,
    Conversation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReference {
    pub kind: SessionReferenceKind,
    pub label: String,
    pub session_id: String,
}

/// Extract [#Room](maka://session/<id>) and [@Conversation](maka://session/<id>) links.
pub fn extract_session_references(text: &str) -> Vec<SessionReference> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let label_start = i + 1;
        let mut j = label_start;
        let mut raw_label = String::new();
        let mut closed = false;
        while j < bytes.len() {
            let ch = text[j..].chars().next().unwrap();
            if ch == '\\' && j + 1 < bytes.len() {
                let next = text[j + 1..].chars().next().unwrap();
                raw_label.push(next);
                j += 1 + next.len_utf8();
                continue;
            }
            if ch == ']' {
                closed = true;
                j += 1;
                break;
            }
            if ch == '\n' || ch == '\r' {
                break;
            }
            raw_label.push(ch);
            j += ch.len_utf8();
        }
        if !closed || !text[j..].starts_with("(maka://session/") {
            i += 1;
            continue;
        }
        let id_start = j + "(maka://session/".len();
        let Some(rel_end) = text[id_start..].find(')') else {
            i += 1;
            continue;
        };
        let candidate = text[id_start..id_start + rel_end].trim_end_matches('/');
        if crate::interaction::entity_id(candidate).is_ok() && seen.insert(candidate.to_owned()) {
            let (kind, clean_label) = if let Some(rest) = raw_label.strip_prefix('#') {
                (SessionReferenceKind::Room, rest.trim().to_owned())
            } else if let Some(rest) = raw_label.strip_prefix('@') {
                (SessionReferenceKind::Conversation, rest.trim().to_owned())
            } else {
                (
                    SessionReferenceKind::Conversation,
                    raw_label.trim().to_owned(),
                )
            };
            found.push(SessionReference {
                kind,
                label: if clean_label.is_empty() {
                    candidate.to_owned()
                } else {
                    clean_label
                },
                session_id: candidate.to_owned(),
            });
        }
        i = id_start + rel_end + 1;
    }
    found
}

fn escape_xml_json(json: &str, out: &mut String) {
    for ch in json.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            _ => out.push(ch),
        }
    }
}

pub fn render_quotes(
    quotes: &[QuoteRef],
    language: crate::language::Language,
) -> Result<String, String> {
    use crate::language::Language;
    let mut text = String::new();
    for (index, quote) in quotes.iter().enumerate() {
        if index != 0 {
            text.push('\n');
        }
        text.push_str("<quoted_excerpt");
        if let Some(label) = &quote.label {
            text.push_str(" label=\"");
            text.push_str(&label.replace('"', "'"));
            text.push('"');
        }
        text.push_str(">\n");
        if let Some(source) = &quote.source {
            let provenance = serde_json::to_string(source).map_err(|e| e.to_string())?;
            text.push_str(match language {
                Language::En => "Session snapshot provenance (display-only): ",
                Language::ZhCn => "会话快照来源（仅供展示）：",
                Language::ZhTw => "工作階段快照來源（僅供顯示）：",
            });
            escape_xml_json(&provenance, &mut text);
            text.push('\n');
        }
        text.push_str(&quote.text);
        text.push_str("\n</quoted_excerpt>");
    }
    Ok(text)
}

pub fn render_directory_references(
    references: &[DirectoryReference],
    language: crate::language::Language,
) -> Result<String, String> {
    use crate::language::Language;
    let json = serde_json::to_string(references).map_err(|e| e.to_string())?;
    let mut text = String::from("<directory_references>\n");
    text.push_str(match language {
        Language::En => {
            "Live directory paths on the originating Runtime Host, available to Shell and Read according to workspace permissions. The project and working directory are unchanged.\n"
        }
        Language::ZhCn => {
            "原始运行时主机上的实时目录路径，Shell 和 Read 可按工作区权限访问。项目与工作目录不变。\n"
        }
        Language::ZhTw => {
            "原始執行階段主機上的即時目錄路徑，Shell 和 Read 可依工作區權限存取。專案與工作目錄不變。\n"
        }
    });
    escape_xml_json(&json, &mut text);
    text.push_str("\n</directory_references>");
    Ok(text)
}

pub fn render_session_references(
    message_text: &str,
    language: crate::language::Language,
) -> Option<String> {
    use crate::language::Language;
    let refs = extract_session_references(message_text);
    if refs.is_empty() {
        return None;
    }
    let mut out = String::from("<session_references>\n");
    out.push_str(match language {
        Language::En => {
            "Referenced Maka Sessions/Rooms for context. Read their messages with Read (or SessionRead if Read is unavailable):\n"
        }
        Language::ZhCn => {
            "消息中引用的 Maka 会话或房间上下文，需要时可直接用 Read（无 Read 权限时用 SessionRead）读取：\n"
        }
        Language::ZhTw => {
            "訊息中引用的 Maka 對話或房間脈絡，需要時可直接用 Read（無 Read 權限時用 SessionRead）讀取：\n"
        }
    });
    for r in refs {
        let kind_label = match (language, r.kind) {
            (Language::ZhCn, SessionReferenceKind::Room) => "房间",
            (Language::ZhTw, SessionReferenceKind::Room) => "房間",
            (_, SessionReferenceKind::Room) => "Room",
            (Language::ZhCn, SessionReferenceKind::Conversation) => "会话",
            (Language::ZhTw, SessionReferenceKind::Conversation) => "對話",
            (_, SessionReferenceKind::Conversation) => "Conversation",
        };
        let read_arg = serde_json::json!({"path": format!("maka://session/{}", r.session_id)});
        let label = serde_json::to_string(&r.label).expect("label string");
        out.push_str(&format!("- {kind_label} {label}: Read({read_arg})\n"));
    }
    out.push_str("</session_references>");
    Some(out)
}
