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

use crate::{Error, Result, input::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct PromptOptions {
    pub provider_namespace: String,
    pub metadata_namespace: String,
    pub multipart_tool_content: bool,
}
fn metadata<'a>(extensions: &'a Extensions, namespace: &str) -> Option<&'a Value> {
    extensions.as_ref()?.get(namespace)
}
fn overlay(mut value: Value, extensions: &Extensions) -> Value {
    if let Some(fields) = metadata(extensions, "openaiCompatible").and_then(Value::as_object) {
        value
            .as_object_mut()
            .expect("wire object")
            .extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    value
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Content {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
    VideoUrl { video_url: Url },
    InputAudio { input_audio: Audio },
    File { file: FileData },
}
#[derive(Serialize)]
struct ImageUrl {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<ImageDetail>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}
#[derive(Serialize)]
struct Url {
    url: String,
}
#[derive(Serialize)]
struct Audio {
    data: String,
    format: &'static str,
}
#[derive(Serialize)]
#[serde(untagged)]
enum FileData {
    Reference { file_id: Value },
    Inline { filename: String, file_data: String },
}
fn file(file: &File, provider: &str) -> Result<Content> {
    match &file.source {
        FileSource::Reference(_) => {
            return Ok(Content::File {
                file: FileData::Reference {
                    file_id: file.reference(provider)?.clone(),
                },
            });
        }
        FileSource::Text(_) => return Err(Error::unsupported("text file parts")),
        _ => {}
    }
    let top = file.media_type.split('/').next().unwrap_or_default();
    match top {
        "image" | "video" => {
            let url = match &file.source {
                FileSource::Url(url) => url.clone(),
                FileSource::Inline(data) => format!(
                    "data:{};base64,{}",
                    file.resolved_media_type()?,
                    data.base64()
                ),
                _ => unreachable!("handled source"),
            };
            Ok(if top == "image" {
                Content::ImageUrl {
                    image_url: ImageUrl {
                        url,
                        detail: metadata(&file.extensions, "openai")
                            .and_then(|value| value.get("imageDetail"))
                            .map(|value| {
                                serde_json::from_value(value.clone()).map_err(|_| {
                                    Error::InvalidArgument {
                                        field: "image detail".into(),
                                        value: value.clone(),
                                    }
                                })
                            })
                            .transpose()?,
                    },
                }
            } else {
                Content::VideoUrl {
                    video_url: Url { url },
                }
            })
        }
        "audio" => {
            let FileSource::Inline(data) = &file.source else {
                return Err(Error::unsupported("audio file parts with URLs"));
            };
            let mime = file.resolved_media_type()?;
            let format = match mime.as_ref() {
                "audio/wav" => "wav",
                "audio/mp3" | "audio/mpeg" => "mp3",
                _ => return Err(Error::unsupported(format!("audio media type {mime}"))),
            };
            Ok(Content::InputAudio {
                input_audio: Audio {
                    data: data.base64().into_owned(),
                    format,
                },
            })
        }
        "application" => {
            let FileSource::Inline(data) = &file.source else {
                return Err(Error::unsupported("PDF file parts with URLs"));
            };
            let mime = file.resolved_media_type()?;
            if mime != "application/pdf" {
                return Err(Error::unsupported(format!("file part media type {mime}")));
            }
            Ok(Content::File {
                file: FileData::Inline {
                    filename: file
                        .filename
                        .clone()
                        .unwrap_or_else(|| "document.pdf".into()),
                    file_data: format!("data:application/pdf;base64,{}", data.base64()),
                },
            })
        }
        "text" => {
            let text = match &file.source {
                FileSource::Url(url) => url.clone(),
                FileSource::Inline(data) => String::from_utf8_lossy(&data.bytes()?).into_owned(),
                _ => unreachable!("handled source"),
            };
            Ok(Content::Text { text })
        }
        _ => Err(Error::unsupported(format!(
            "file part media type {}",
            file.media_type
        ))),
    }
}
fn part(part: &UserPart, provider: &str) -> Result<Value> {
    let content = match part {
        UserPart::Text { text, .. } => Content::Text { text: text.clone() },
        UserPart::File(value) => file(value, provider)?,
        UserPart::Custom { .. } => return Err(Error::unsupported("custom tool content parts")),
    };
    Ok(overlay(
        serde_json::to_value(content).expect("content"),
        part.extensions(),
    ))
}
#[derive(Serialize)]
struct Function<'a> {
    name: &'a str,
    arguments: String,
}
#[derive(Serialize)]
struct Call<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    function: Function<'a>,
}
#[derive(Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
enum WireMessage {
    System {
        content: String,
    },
    User {
        content: Value,
    },
    Assistant {
        content: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
    },
    Tool {
        tool_call_id: String,
        content: Value,
    },
}
/// Tool content without multipart support is sent as a JSON string. This is
/// a wire representation, constructed from native media without borrowing a
/// JavaScript request or retaining its object graph.
fn textual_content(parts: &[UserPart]) -> Value {
    let values = parts
        .iter()
        .map(|part| {
            let mut value = match part {
                UserPart::Text { text, .. } => json!({"type":"text","text":text}),
                UserPart::Custom { kind, .. } => json!({"type":"custom","kind":kind}),
                UserPart::File(file) => {
                    let data = match &file.source {
                        FileSource::Url(url) => json!({"type":"url","url":url}),
                        FileSource::Text(text) => json!({"type":"text","text":text}),
                        FileSource::Reference(reference) => {
                            json!({"type":"reference","reference":reference})
                        }
                        FileSource::Inline(InlineData::Base64(data)) => {
                            json!({"type":"data","data":data})
                        }
                        FileSource::Inline(InlineData::Bytes(data)) => {
                            json!({"type":"data","data":data})
                        }
                    };
                    let mut value = json!({"type":"file","data":data,"mediaType":file.media_type});
                    if let Some(name) = &file.filename {
                        value["filename"] = json!(name);
                    }
                    value
                }
            };
            if let Some(extensions) = part.extensions() {
                value["providerOptions"] = json!(extensions);
            }
            value
        })
        .collect::<Vec<_>>();
    json!(serde_json::to_string(&values).expect("content JSON"))
}
pub fn messages(messages: &[Message], options: &PromptOptions) -> Result<Vec<Value>> {
    let mut result = vec![];
    for message in messages {
        let (wire, extensions) = match message {
            Message::System { text, extensions } => (
                WireMessage::System {
                    content: text.clone(),
                },
                extensions,
            ),
            Message::User { parts, extensions } => {
                if let [UserPart::Text { text, extensions }] = parts.as_slice() {
                    result.push(overlay(
                        serde_json::to_value(WireMessage::User {
                            content: json!(text),
                        })
                        .expect("message"),
                        extensions,
                    ));
                    continue;
                }
                (
                    WireMessage::User {
                        content: json!(
                            parts
                                .iter()
                                .map(|v| part(v, &options.provider_namespace))
                                .collect::<Result<Vec<_>>>()?
                        ),
                    },
                    extensions,
                )
            }
            Message::Assistant { parts, extensions } => {
                let mut text = String::new();
                let mut reasoning = String::new();
                let mut calls = vec![];
                for part in parts {
                    match part {
                        AssistantPart::Text { text: delta, .. } => text.push_str(delta),
                        AssistantPart::Reasoning { text: delta, .. } => reasoning.push_str(delta),
                        AssistantPart::ToolCall(call) => {
                            let mut wire = overlay(
                                serde_json::to_value(Call {
                                    id: &call.id,
                                    kind: "function",
                                    function: Function {
                                        name: &call.name,
                                        arguments: call.input.to_string(),
                                    },
                                })
                                .expect("tool call"),
                                &call.extensions,
                            );
                            let signature = metadata(&call.extensions, &options.metadata_namespace)
                                .and_then(|v| v.get("thoughtSignature"))
                                .filter(|v| !v.is_null())
                                .or_else(|| {
                                    metadata(&call.extensions, "google")
                                        .and_then(|v| v.get("thoughtSignature"))
                                });
                            if let Some(signature) =
                                signature.filter(|v| !v.is_null() && **v != false && **v != "")
                            {
                                wire["extra_content"] = json!({"google":{"thought_signature":signature.as_str().map(str::to_owned).unwrap_or_else(||signature.to_string())}});
                            }
                            calls.push(wire);
                        }
                        _ => {}
                    }
                }
                (
                    WireMessage::Assistant {
                        content: if !calls.is_empty() && text.is_empty() {
                            None
                        } else {
                            Some(text)
                        },
                        tool_calls: calls,
                        reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
                    },
                    extensions,
                )
            }
            Message::Tool { results, .. } => {
                for tool in results {
                    let content = match &tool.output.value {
                        ToolValue::Text(value) | ToolValue::ErrorText(value) => json!(value),
                        ToolValue::Json(value) | ToolValue::ErrorJson(value) => {
                            json!(value.to_string())
                        }
                        ToolValue::Denied { reason } => {
                            json!(reason.as_deref().unwrap_or("Tool call execution denied."))
                        }
                        ToolValue::Content(parts) if options.multipart_tool_content => json!(
                            parts
                                .iter()
                                .map(|v| part(v, &options.provider_namespace))
                                .collect::<Result<Vec<_>>>()?
                        ),
                        ToolValue::Content(parts) => textual_content(parts),
                    };
                    result.push(overlay(
                        serde_json::to_value(WireMessage::Tool {
                            tool_call_id: tool.id.clone(),
                            content,
                        })
                        .expect("message"),
                        &tool.extensions,
                    ));
                }
                continue;
            }
        };
        result.push(overlay(
            serde_json::to_value(wire).expect("message"),
            extensions,
        ));
    }
    Ok(result)
}
