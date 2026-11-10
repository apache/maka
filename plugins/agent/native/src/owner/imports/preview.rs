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
use futures_util::future::BoxFuture;
use maka_agent_facts::{
    history_snapshot::HistoricalRole,
    model::{ModelPart, TextKind},
};
use maka_session_import::{Error, ExactContent, ExactPart, ExactRecord, ExactSink, MediaBody};

pub(super) struct Preview {
    after: u64,
    pub count: u64,
    pub items: Vec<ImportPreviewItem>,
}
impl Preview {
    pub fn new(after: u64) -> Self {
        Self {
            after,
            count: 0,
            items: Vec::with_capacity(8),
        }
    }
}
impl ExactSink for Preview {
    fn record(&mut self, record: ExactRecord) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            for message in record.messages {
                for part in message.parts {
                    if self.count >= self.after && self.items.len() < 8 {
                        self.items.push(item(self.count, message.role, &part)?);
                    }
                    close(part).await?;
                    self.count = self
                        .count
                        .checked_add(1)
                        .filter(|value| *value <= maka_agent_facts::interaction::MAX_SAFE_INTEGER)
                        .ok_or(Error::Invalid("source preview ordinal overflows"))?;
                }
            }
            Ok(())
        })
    }
}
async fn close(part: ExactPart) -> Result<(), Error> {
    let media = match part {
        ExactPart::Input { media, .. } => media,
        ExactPart::ToolReturn { projection, .. } => projection
            .into_iter()
            .filter_map(|part| match part {
                ExactContent::Media(media) => Some(media),
                ExactContent::Text(_) => None,
            })
            .collect(),
        ExactPart::Model { .. } => vec![],
    };
    for media in media {
        if let MediaBody::File(file) = media.body {
            file.close().await?;
        }
    }
    Ok(())
}
fn item(index: u64, role: HistoricalRole, part: &ExactPart) -> Result<ImportPreviewItem, Error> {
    let mut output = PreviewText::default();
    let kind = match part {
        ExactPart::Input { content, media } => {
            output.text(&content.text);
            for media in media {
                output.text("\n[");
                output.text(&media.name);
                output.text("; ");
                output.text(&media.mime_type);
                output.text("]");
            }
            if matches!(role, HistoricalRole::System | HistoricalRole::Context) {
                ImportRecordKind::Note
            } else {
                ImportRecordKind::User
            }
        }
        ExactPart::Model { part } => match part {
            ModelPart::Text {
                text, text_kind, ..
            } => {
                for chunk in text.chunks() {
                    output.text(chunk);
                }
                if text.is_empty() && *text_kind == TextKind::Thinking {
                    output.text("[Source reasoning metadata]");
                }
                ImportRecordKind::Assistant
            }
            ModelPart::ToolCall { call } => {
                output.text(&call.name);
                output.text("\n");
                output.json(&call.input)?;
                ImportRecordKind::ToolCall
            }
            ModelPart::ToolResult { output: body, .. } => {
                output.json(body)?;
                ImportRecordKind::ToolResult
            }
            ModelPart::Source { source } => {
                output.json(source)?;
                ImportRecordKind::Note
            }
        },
        ExactPart::ToolReturn { output: body, .. } => {
            output.json(body)?;
            ImportRecordKind::ToolResult
        }
    };
    let valid = std::str::from_utf8(&output.bytes)
        .map(|_| output.bytes.len())
        .unwrap_or_else(|error| error.valid_up_to());
    Ok(ImportPreviewItem {
        index,
        kind,
        text: std::str::from_utf8(&output.bytes[..valid])
            .expect("complete UTF-8 prefix")
            .into(),
        truncated: output.truncated,
    })
}
#[derive(Default)]
struct PreviewText {
    bytes: Vec<u8>,
    truncated: bool,
}
impl PreviewText {
    fn text(&mut self, value: &str) {
        let keep = (4096 - self.bytes.len()).min(value.len());
        self.bytes.extend_from_slice(&value.as_bytes()[..keep]);
        self.truncated |= keep != value.len();
    }
    fn json(&mut self, value: &impl serde::Serialize) -> Result<(), Error> {
        match serde_json::to_writer(&mut *self, value) {
            Err(_) if self.truncated => Ok(()),
            result => result.map_err(Error::Json),
        }
    }
}
impl std::io::Write for PreviewText {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let keep = (4096 - self.bytes.len()).min(bytes.len());
        self.bytes.extend_from_slice(&bytes[..keep]);
        if keep == bytes.len() {
            Ok(keep)
        } else {
            self.truncated = true;
            Err(std::io::Error::other("source preview display is full"))
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn digest(fingerprint: &maka_session_import::Fingerprint) -> Result<String, Failure> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(fingerprint).map_err(|_| Failure::Invalid)?,
    )))
}
