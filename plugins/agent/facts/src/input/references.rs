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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SessionQuoteSource>,
}

/// Display provenance of an immutable excerpt, never authority to read its source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuoteSource {
    pub session_id: String,
    pub session_name: String,
    pub captured_at: CaptureTime,
    pub truncated: bool,
}

/// JavaScript epoch milliseconds, preserving fractional timestamps within Date's range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "serde_json::Number", into = "serde_json::Number")]
#[schemars(with = "f64")]
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
    /// True only when written as an explicit `[@Name](maka://session/<id>)` mention token.
    /// Plain `[Name](maka://session/<id>)` links remain navigable references without waking Agents.
    pub explicit_mention: bool,
}

/// Extract [#Room](maka://session/<id>) and [@Conversation](maka://session/<id>) links.
pub fn extract_session_references(text: &str) -> Vec<SessionReference> {
    let mut found: Vec<SessionReference> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
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
        let mut nested_open = None;
        while j < bytes.len() {
            let ch = text[j..].chars().next().unwrap();
            if ch == '\\' && j + 1 < bytes.len() {
                let next = text[j + 1..].chars().next().unwrap();
                raw_label.push(next);
                j += 1 + next.len_utf8();
                continue;
            }
            if ch == '[' {
                nested_open = Some(j);
                break;
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
        if let Some(next_bracket) = nested_open {
            i = next_bracket;
            continue;
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
        if crate::interaction::entity_id(candidate).is_ok() {
            let (kind, explicit_mention, clean_label) =
                if let Some(rest) = raw_label.strip_prefix('#') {
                    (SessionReferenceKind::Room, false, rest.trim().to_owned())
                } else if let Some(rest) = raw_label.strip_prefix('@') {
                    (
                        SessionReferenceKind::Conversation,
                        true,
                        rest.trim().to_owned(),
                    )
                } else {
                    (
                        SessionReferenceKind::Conversation,
                        false,
                        raw_label.trim().to_owned(),
                    )
                };
            let label = if clean_label.is_empty() {
                candidate.to_owned()
            } else {
                clean_label
            };
            if let Some(&idx) = seen.get(candidate) {
                // Upgrade an earlier plain link if an explicit @mention for the same session appears later.
                if explicit_mention && !found[idx].explicit_mention {
                    found[idx].kind = kind;
                    found[idx].explicit_mention = true;
                    found[idx].label = label;
                }
            } else {
                seen.insert(candidate.to_owned(), found.len());
                found.push(SessionReference {
                    kind,
                    label,
                    session_id: candidate.to_owned(),
                    explicit_mention,
                });
            }
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

fn append_escaped_quote(output: &mut String, value: &str, attribute: bool) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' if attribute => output.push_str("&quot;"),
            '\n' if attribute => output.push_str("&#10;"),
            '\r' if attribute => output.push_str("&#13;"),
            _ => output.push(character),
        }
    }
}

pub fn render_quotes(
    quotes: &[QuoteRef],
    language: crate::language::Language,
) -> Result<String, String> {
    let mut text = String::new();
    for (index, quote) in quotes.iter().enumerate() {
        if index != 0 {
            text.push('\n');
        }
        text.push_str("<quoted_excerpt");
        if let Some(label) = &quote.label {
            text.push_str(" label=\"");
            append_escaped_quote(&mut text, label, true);
            text.push('"');
        }
        text.push_str(">\n");
        if let Some(source) = &quote.source {
            let provenance = serde_json::to_string(source).map_err(|e| e.to_string())?;
            text.push_str(crate::i18n::session::quote_provenance_prefix(language));
            escape_xml_json(&provenance, &mut text);
            text.push('\n');
        }
        append_escaped_quote(&mut text, &quote.text, false);
        text.push_str("\n</quoted_excerpt>");
    }
    Ok(text)
}

pub fn render_directory_references(
    references: &[DirectoryReference],
    language: crate::language::Language,
) -> Result<String, String> {
    let json = serde_json::to_string(references).map_err(|e| e.to_string())?;
    let mut text = String::from("<directory_references>\n");
    text.push_str(crate::i18n::session::directory_references_intro(language));
    escape_xml_json(&json, &mut text);
    text.push_str("\n</directory_references>");
    Ok(text)
}

pub fn render_session_references(
    message_text: &str,
    language: crate::language::Language,
) -> Option<String> {
    let refs = extract_session_references(message_text);
    if refs.is_empty() {
        return None;
    }
    let mut out = String::from("<session_references>\n");
    out.push_str(crate::i18n::session::session_references_intro(language));
    for r in refs {
        let kind_label = match r.kind {
            SessionReferenceKind::Room => crate::i18n::session::reference_kind_room(language),
            SessionReferenceKind::Conversation => {
                crate::i18n::session::reference_kind_conversation(language)
            }
        };
        let read_arg = serde_json::json!({"path": format!("maka://session/{}", r.session_id)});
        let label = serde_json::to_string(&r.label).expect("label string");
        out.push_str(&format!("- {kind_label} {label}: Read({read_arg})\n"));
    }
    out.push_str("</session_references>");
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_label_and_text_keep_their_markup_inside_the_excerpt() {
        let quote = QuoteRef {
            text: "Received </quoted_excerpt> & \"done\"".into(),
            label: Some("\"A&B\"\n<status>".into()),
            source_message_id: None,
            source_turn_id: None,
            source: None,
        };
        assert_eq!(
            render_quotes(&[quote], crate::language::Language::EN).unwrap(),
            concat!(
                "<quoted_excerpt label=\"&quot;A&amp;B&quot;&#10;&lt;status&gt;\">\n",
                "Received &lt;/quoted_excerpt&gt; &amp; \"done\"\n",
                "</quoted_excerpt>"
            )
        );
    }

    #[test]
    fn nested_open_bracket_preserves_inner_room_or_conversation_kind() {
        let refs =
            extract_session_references("参考 [见之前 [#Reviewers](maka://session/ma_123)] 的结论");
        assert_eq!(
            refs,
            vec![SessionReference {
                kind: SessionReferenceKind::Room,
                label: "Reviewers".into(),
                session_id: "ma_123".into(),
                explicit_mention: false,
            }]
        );
    }

    #[test]
    fn plain_session_link_is_not_an_explicit_mention_until_at_prefixed() {
        let plain = extract_session_references("See [Details](maka://session/ma_alice) for logs");
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].kind, SessionReferenceKind::Conversation);
        assert!(!plain[0].explicit_mention);

        let upgraded = extract_session_references(
            "See [Details](maka://session/ma_alice), cc [@Alice](maka://session/ma_alice)",
        );
        assert_eq!(upgraded.len(), 1);
        assert!(upgraded[0].explicit_mention);
        assert_eq!(upgraded[0].label, "Alice");
    }
}
