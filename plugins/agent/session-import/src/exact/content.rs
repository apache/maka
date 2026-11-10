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
    Error, ExactContent, ExactMedia, ExactMessage, ExactPart, MediaBody, access::ReadSource,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_agent_facts::{
    history_snapshot::{HistoricalRole, ImportedTurnOrdinal},
    input::MessageInput,
    model::{ModelPart, ModelToolCall, TextKind, ToolInput},
    tool_output::{ImageDetail, ToolOutput},
};
use maka_capabilities::filesystem::ReadRange;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc};

pub(crate) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Unsupported(format!("missing source {key}")))
}

pub(crate) fn timestamp(value: Option<&Value>, codex: bool) -> Result<Option<u64>, Error> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let value: crate::transcript::Timestamp = serde_json::from_value(value.clone())?;
    let result = if codex {
        value.codex_millis()
    } else {
        value.millis()
    };
    result
        .map(Some)
        .ok_or(Error::Invalid("invalid original source timestamp"))
}

pub(crate) fn text(text: &str, thinking: bool, options: Option<Value>) -> ExactPart {
    ExactPart::Model {
        part: ModelPart::Text {
            text_kind: if thinking {
                TextKind::Thinking
            } else {
                TextKind::Text
            },
            text: text.to_owned().into(),
            provider_options: options.map(Arc::new),
        },
    }
}
pub(crate) fn options(block: &Value) -> Option<Value> {
    block
        .get("provider_options")
        .or_else(|| block.get("providerOptions"))
        .or_else(|| block.get("providerMetadata"))
        .filter(|value| !value.is_null())
        .cloned()
}

pub(crate) fn assistant(
    block: &Value,
    calls: &mut BTreeMap<String, String>,
    adapter: &str,
) -> Result<ExactPart, Error> {
    let kind = string(block, "type")?;
    let mut opts = if adapter == "codex" && matches!(kind, "function_call" | "custom_tool_call") {
        responses_options(block)?
    } else {
        options(block)
    };
    if adapter == "claude-code" {
        for (from, to) in [("signature", "signature"), ("data", "redactedData")] {
            if (kind == "thinking" || kind == "redacted_thinking")
                && let Some(value) = block.get(from)
            {
                let root = opts
                    .get_or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or(Error::Invalid("source thinking options are not an object"))?;
                let anthropic = root
                    .entry("anthropic")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or(Error::Invalid("source Anthropic options are not an object"))?;
                if anthropic.get(to).is_some_and(|old| old != value) {
                    return Err(Error::Invalid(
                        "source thinking signature conflicts with its options",
                    ));
                }
                anthropic.insert(to.into(), value.clone());
            }
        }
    }
    match kind {
        "text" | "output_text" | "Text" => Ok(text(string(block, "text")?, false, opts)),
        "thinking" => Ok(text(string(block, "thinking")?, true, opts)),
        "reasoning" => Ok(text(string(block, "text")?, true, opts)),
        "redacted_thinking" => Ok(text("", true, opts)),
        "tool_use" | "function_call" | "custom_tool_call" => {
            let id = block
                .get("call_id")
                .or_else(|| block.get("id"))
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("source tool call identity is absent"))?;
            let name = string(block, "name")?;
            crate::transcript::identity(id)?;
            crate::transcript::identity(name)?;
            if calls.insert(id.into(), name.into()).is_some() {
                return Err(Error::Unsupported(
                    "overlapping original tool call ids".into(),
                ));
            }
            let input = match kind {
                "function_call" => ToolInput::from_json(string(block, "arguments")?.into()),
                "custom_tool_call" => {
                    ToolInput::Json(Value::String(string(block, "input")?.into()))
                }
                _ => ToolInput::Json(
                    block
                        .get("input")
                        .cloned()
                        .ok_or(Error::Invalid("source tool input is absent"))?,
                ),
            };
            Ok(ExactPart::Model {
                part: ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: id.into(),
                        name: name.into(),
                        input,
                        provider_options: opts,
                        provider_executed: block
                            .get("provider_executed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    },
                },
            })
        }
        _ => Err(Error::Unsupported(format!(
            "{adapter} assistant block {kind}"
        ))),
    }
}

pub(crate) async fn input(
    views: &(impl ReadSource + ?Sized),
    block: &Value,
    cwd: Option<&str>,
) -> Result<ExactPart, Error> {
    if let Some(text) = block.as_str() {
        return Ok(ExactPart::Input {
            content: text.to_owned().into(),
            media: vec![],
        });
    }
    match string(block, "type")? {
        "text" | "input_text" | "Text" => Ok(ExactPart::Input {
            content: string(block, "text")?.to_owned().into(),
            media: vec![],
        }),
        "image" | "input_image" | "local_image" | "Image" | "LocalImage" | "audio"
        | "input_audio" | "Audio" | "document" | "file" => Ok(ExactPart::Input {
            content: MessageInput::from(String::new()),
            media: vec![media(views, block, cwd).await?],
        }),
        kind => Err(Error::Unsupported(format!("input content block {kind}"))),
    }
}

pub(crate) async fn tool_result(
    views: &(impl ReadSource + ?Sized),
    call_id: &str,
    name: String,
    body: &Value,
    is_error: bool,
    cwd: Option<&str>,
) -> Result<ExactPart, Error> {
    let output = match body {
        Value::String(text) => ToolOutput::Text(text.clone()),
        _ => ToolOutput::Json(body.clone()),
    };
    let mut projection = Vec::new();
    match body {
        Value::String(text) => projection.push(ExactContent::Text(text.clone())),
        Value::Array(blocks) => {
            for block in blocks {
                if let Some(text) = block.as_str() {
                    projection.push(ExactContent::Text(text.into()));
                    continue;
                }
                match string(block, "type")? {
                    "text" | "input_text" | "output_text" => {
                        projection.push(ExactContent::Text(string(block, "text")?.into()))
                    }
                    "image" | "input_image" | "audio" | "input_audio" | "file" | "document" => {
                        projection.push(ExactContent::Media(media(views, block, cwd).await?));
                    }
                    kind => {
                        return Err(Error::Unsupported(format!(
                            "tool return content block {kind}"
                        )));
                    }
                }
            }
        }
        value => projection.push(ExactContent::Text(serde_json::to_string(value)?)),
    }
    Ok(ExactPart::ToolReturn {
        call_id: call_id.into(),
        name,
        output,
        is_error,
        projection,
    })
}

pub(crate) fn source_id(value: Option<&Value>) -> Result<Option<&str>, Error> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => {
            crate::transcript::identity(id)?;
            Ok(Some(id))
        }
        Some(_) => Err(Error::Invalid("source identity is not a string")),
    }
}
pub(crate) fn next_turn(
    previous: Option<ImportedTurnOrdinal>,
) -> Result<ImportedTurnOrdinal, Error> {
    let value = match previous {
        None => 0,
        Some(value) => value
            .0
            .checked_add(1)
            .ok_or(Error::Invalid("imported turn ordinal overflows"))?,
    };
    if value > maka_agent_facts::interaction::MAX_SAFE_INTEGER {
        return Err(Error::Invalid("imported turn ordinal overflows"));
    }
    Ok(ImportedTurnOrdinal(value))
}

pub(crate) fn messages(
    parts: Vec<(HistoricalRole, ExactPart)>,
    id: Option<&str>,
    turn: Option<&str>,
    turn_ordinal: ImportedTurnOrdinal,
    timestamp: Option<u64>,
    metadata: &Value,
) -> Vec<ExactMessage> {
    parts
        .into_iter()
        .map(|(role, part)| ExactMessage {
            source_message_id: id.map(str::to_owned),
            source_turn_id: turn.map(str::to_owned),
            turn_ordinal,
            timestamp,
            role,
            parts: vec![part],
            provider_metadata: metadata.clone(),
        })
        .collect()
}

pub(crate) async fn media(
    views: &(impl ReadSource + ?Sized),
    block: &Value,
    cwd: Option<&str>,
) -> Result<ExactMedia, Error> {
    let source = block
        .get("source")
        .or_else(|| block.get("input_audio"))
        .unwrap_or(block);
    let detail = block
        .get("detail")
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value::<ImageDetail>(v.clone()))
        .transpose()?;
    let mut mime = source
        .get("media_type")
        .or_else(|| source.get("mime_type"))
        .or_else(|| block.get("mime_type"))
        .or_else(|| block.get("mime"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if mime.is_none() {
        mime = match source.get("format").and_then(Value::as_str) {
            Some("wav") => Some("audio/wav".into()),
            Some("mp3") => Some("audio/mpeg".into()),
            _ => None,
        };
    }
    if source.get("type").and_then(Value::as_str) == Some("base64")
        || source.get("data").and_then(Value::as_str).is_some()
    {
        let bytes = match source.get("type").and_then(Value::as_str) {
            Some("text") => string(source, "data")?.as_bytes().to_vec(),
            Some("base64" | "image" | "audio" | "input_audio") => {
                decode_media(string(source, "data")?).await?
            }
            None if block.get("input_audio").is_some() => {
                decode_media(string(source, "data")?).await?
            }
            kind => {
                return Err(Error::Unsupported(format!(
                    "source media data encoding {kind:?}"
                )));
            }
        };
        let mime_type = mime
            .or_else(|| maka_agent_facts::attachment::sniff_binary_mime(&bytes).map(str::to_owned))
            .ok_or_else(|| Error::Unsupported("source media has no MIME type".into()))?;
        return Ok(ExactMedia {
            name: block
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("imported media")
                .into(),
            mime_type,
            detail,
            body: MediaBody::Inline(bytes),
        });
    }
    let uri = block
        .get("image_url")
        .and_then(|v| v.as_str().or_else(|| v.get("url").and_then(Value::as_str)))
        .or_else(|| source.get("url").and_then(Value::as_str))
        .or_else(|| block.get("path").and_then(Value::as_str))
        .or_else(|| block.get("image_path").and_then(Value::as_str))
        .ok_or_else(|| Error::Unsupported("source media has no readable bytes or file".into()))?;
    if let Some(data) = uri.strip_prefix("data:") {
        let (header, body) = data
            .split_once(',')
            .ok_or(Error::Invalid("invalid source data URL"))?;
        let mime_type = header
            .strip_suffix(";base64")
            .ok_or_else(|| Error::Unsupported("non-base64 source data URL".into()))?;
        return Ok(ExactMedia {
            name: "imported media".into(),
            mime_type: mime_type.into(),
            detail,
            body: MediaBody::Inline(decode_media(body).await?),
        });
    }
    let path = if let Some(file) = uri.strip_prefix("file://") {
        if file.contains('%') {
            return Err(Error::Unsupported("percent-encoded source file URL".into()));
        }
        Path::new(file).to_path_buf()
    } else if uri.contains("://") {
        return Err(Error::Unsupported(
            "remote media URL is not a captured file".into(),
        ));
    } else {
        Path::new(uri).to_path_buf()
    };
    let path = if path.is_absolute() {
        path
    } else {
        Path::new(cwd.ok_or(Error::Invalid(
            "relative source media has no original workspace",
        ))?)
        .join(path)
    };
    let filename = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or(Error::Invalid("invalid source media filename"))?;
    let file = views
        .open_file(
            path.to_str()
                .ok_or(Error::Invalid("source media path is not UTF-8"))?
                .into(),
        )
        .await?;
    if mime.is_none() {
        let prefix = file
            .read(ReadRange {
                offset: 0,
                limit: 1024,
            })
            .await?;
        mime = maka_agent_facts::attachment::sniff_binary_mime(&prefix.bytes).map(str::to_owned);
        if mime.is_none()
            && prefix.bytes.starts_with(b"RIFF")
            && prefix.bytes.get(8..12) == Some(b"WAVE")
        {
            mime = Some("audio/wav".into());
        }
    }
    let Some(mime_type) = mime else {
        file.close().await?;
        return Err(Error::Unsupported(
            "source file media type is unknown".into(),
        ));
    };
    Ok(ExactMedia {
        name: filename.into(),
        mime_type,
        detail,
        body: MediaBody::File(file),
    })
}

pub(crate) fn metadata(record: &Value) -> Value {
    let header = |value: &Value| -> serde_json::Map<String, Value> {
        value
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| {
                !["content", "message", "payload", "output", "data"].contains(&key.as_str())
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    };
    let mut result = header(record);
    if let Some(message) = record.get("message").filter(|value| value.is_object()) {
        result.insert("message".into(), Value::Object(header(message)));
    }
    Value::Object(result)
}

pub(crate) fn responses_options(item: &Value) -> Result<Option<Value>, Error> {
    let replay = maka_provider_protocol::responses::replay::capture(item)
        .ok_or_else(|| Error::Unsupported("Codex response replay metadata".into()))?;
    let mut options = options(item).unwrap_or_else(|| json!({}));
    let root = options
        .as_object_mut()
        .ok_or(Error::Invalid("Codex provider options are not an object"))?;
    let openai = root
        .entry("openai")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(Error::Invalid("Codex OpenAI options are not an object"))?;
    let mut captured = vec![("responsesReplay", serde_json::to_value(replay)?)];
    if let Some(encrypted) = item.get("encrypted_content") {
        captured.push(("reasoningEncryptedContent", encrypted.clone()));
    }
    if let Some(id) = item.get("id") {
        captured.push(("itemId", id.clone()));
    }
    for (key, value) in captured {
        if openai.get(key).is_some_and(|old| old != &value) {
            return Err(Error::Invalid(
                "original Codex options conflict with response metadata",
            ));
        }
        openai.insert(key.into(), value);
    }
    Ok(Some(options))
}

async fn decode_media(value: &str) -> Result<Vec<u8>, Error> {
    let value = value.to_owned();
    Ok(tokio::task::spawn_blocking(move || STANDARD.decode(value)).await??)
}
