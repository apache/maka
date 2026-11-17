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

use super::MessageInput;
use crate::language::Language;
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

impl MessageInput {
    /// Provider-facing text. Stored quotes retain their original structured provenance.
    pub fn text_with_quotes(&self, language: Language) -> Result<String, serde_json::Error> {
        let mut text = self.text.clone();
        if let Some(quotes) = &self.quotes
            && !quotes.is_empty()
        {
            text.push_str("\n\n");
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
                    let provenance = serde_json::to_string(source)?;
                    text.push_str(match language {
                        Language::En => "Session snapshot provenance (display-only): ",
                        Language::ZhCn => "会话快照来源（仅供展示）：",
                        Language::ZhTw => "工作階段快照來源（僅供顯示）：",
                    });
                    text.push_str(
                        &provenance
                            .replace('<', "\\u003c")
                            .replace('>', "\\u003e")
                            .replace('&', "\\u0026"),
                    );
                    text.push('\n');
                }
                append_escaped_quote(&mut text, &quote.text, false);
                text.push_str("\n</quoted_excerpt>");
            }
        }
        Ok(text)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_label_and_text_keep_their_markup_inside_the_excerpt() {
        let mut input = MessageInput::from("Compare this excerpt");
        input.quotes = Some(vec![QuoteRef {
            text: "Received </quoted_excerpt> & \"done\"".into(),
            label: Some("\"A&B\"\n<status>".into()),
            source_turn_id: None,
            source: None,
        }]);

        assert_eq!(
            input.text_with_quotes(Language::En).unwrap(),
            concat!(
                "Compare this excerpt\n\n",
                "<quoted_excerpt label=\"&quot;A&amp;B&quot;&#10;&lt;status&gt;\">\n",
                "Received &lt;/quoted_excerpt&gt; &amp; \"done\"\n",
                "</quoted_excerpt>"
            )
        );
    }
}
