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

//! Closed hosted-result schemas encoded through bounded, replayable source cursors.

use super::super::source::{FragmentCursor, SourceFragment};
use crate::ModelError;
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::source::{
    self, ByteCursor, ByteSource, ChargedBuffer, JsonSource, ParsedToolError, ReadSource,
    SourceBudget, SourceBytes, TextEncoding, TextSource, ToolOutputRecipe,
    json::{self, ArrayCursor, JsonKind, JsonValue},
};
use std::{collections::VecDeque, io, sync::Arc};

#[derive(Clone, Copy)]
enum Schema {
    String,
    Number,
    Bool,
    Tag(&'static str),
    Object(&'static [Field]),
    Array(&'static Schema),
    Code,
    Advisor,
    DocumentSource,
    Without(&'static str),
}
#[derive(Clone, Copy)]
enum Missing {
    Required,
    Null,
    Omit,
    EmptyArray,
}
#[derive(Clone, Copy)]
struct Field {
    name: &'static str,
    schema: Schema,
    missing: Missing,
}
const fn required(name: &'static str, schema: Schema) -> Field {
    Field {
        name,
        schema,
        missing: Missing::Required,
    }
}
const fn optional(name: &'static str, schema: Schema) -> Field {
    Field {
        name,
        schema,
        missing: Missing::Null,
    }
}
const fn omitted(name: &'static str, schema: Schema) -> Field {
    Field {
        name,
        schema,
        missing: Missing::Omit,
    }
}
const fn default_array(name: &'static str, schema: Schema) -> Field {
    Field {
        name,
        schema,
        missing: Missing::EmptyArray,
    }
}
const STRINGS: Schema = Schema::String;
const CODE_FILES: Schema = Schema::Object(&[
    required("type", Schema::Tag("code_execution_output")),
    required("file_id", Schema::String),
]);
const BASH_FILES: Schema = Schema::Object(&[
    required("type", Schema::Tag("bash_code_execution_output")),
    required("file_id", Schema::String),
]);
const SEARCH: Schema = Schema::Object(&[
    required("type", Schema::Tag("web_search_result")),
    required("url", Schema::String),
    optional("title", Schema::String),
    optional("page_age", Schema::String),
    required("encrypted_content", Schema::String),
]);
const REFERENCES: Schema = Schema::Object(&[
    required("type", Schema::Tag("tool_reference")),
    required("tool_name", Schema::String),
]);
const FETCH: Schema = Schema::Object(&[
    required("type", Schema::Tag("web_fetch_result")),
    required("url", Schema::String),
    optional("retrieved_at", Schema::String),
    required(
        "content",
        Schema::Object(&[
            required("type", Schema::Tag("document")),
            optional("title", Schema::String),
            omitted(
                "citations",
                Schema::Object(&[required("enabled", Schema::Bool)]),
            ),
            required("source", Schema::DocumentSource),
        ]),
    ),
]);
const CODE_EXECUTION_RESULT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("code_execution_result")),
    required("stdout", Schema::String),
    required("stderr", Schema::String),
    required("return_code", Schema::Number),
    default_array("content", Schema::Array(&CODE_FILES)),
];
const ENCRYPTED_CODE_EXECUTION_RESULT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("encrypted_code_execution_result")),
    required("encrypted_stdout", Schema::String),
    required("stderr", Schema::String),
    required("return_code", Schema::Number),
    default_array("content", Schema::Array(&CODE_FILES)),
];
const BASH_CODE_EXECUTION_RESULT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("bash_code_execution_result")),
    required("stdout", Schema::String),
    required("stderr", Schema::String),
    required("return_code", Schema::Number),
    required("content", Schema::Array(&BASH_FILES)),
];
const BASH_CODE_EXECUTION_TOOL_RESULT_ERROR_FIELDS: &[Field] = &[
    required("type", Schema::Tag("bash_code_execution_tool_result_error")),
    required("error_code", Schema::String),
];
const TEXT_EDITOR_CODE_EXECUTION_TOOL_RESULT_ERROR_FIELDS: &[Field] = &[
    required(
        "type",
        Schema::Tag("text_editor_code_execution_tool_result_error"),
    ),
    required("error_code", Schema::String),
];
const TEXT_EDITOR_CODE_EXECUTION_VIEW_RESULT_FIELDS: &[Field] = &[
    required(
        "type",
        Schema::Tag("text_editor_code_execution_view_result"),
    ),
    required("content", Schema::String),
    required("file_type", Schema::String),
    optional("num_lines", Schema::Number),
    optional("start_line", Schema::Number),
    optional("total_lines", Schema::Number),
];
const TEXT_EDITOR_CODE_EXECUTION_CREATE_RESULT_FIELDS: &[Field] = &[
    required(
        "type",
        Schema::Tag("text_editor_code_execution_create_result"),
    ),
    required("is_file_update", Schema::Bool),
];
const TEXT_EDITOR_CODE_EXECUTION_STR_REPLACE_RESULT_FIELDS: &[Field] = &[
    required(
        "type",
        Schema::Tag("text_editor_code_execution_str_replace_result"),
    ),
    optional("lines", Schema::Array(&STRINGS)),
    optional("new_lines", Schema::Number),
    optional("new_start", Schema::Number),
    optional("old_lines", Schema::Number),
    optional("old_start", Schema::Number),
];
const ADVISOR_RESULT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("advisor_result")),
    required("text", Schema::String),
    omitted("stop_reason", Schema::String),
];
const ADVISOR_REDACTED_RESULT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("advisor_redacted_result")),
    required("encrypted_content", Schema::String),
    omitted("stop_reason", Schema::String),
];
const ADVISOR_TOOL_RESULT_ERROR_FIELDS: &[Field] = &[
    required("type", Schema::Tag("advisor_tool_result_error")),
    required("error_code", Schema::String),
];
const BASE64_FIELDS: &[Field] = &[
    required("type", Schema::Tag("base64")),
    required("media_type", Schema::Tag("application/pdf")),
    required("data", Schema::String),
];
const TEXT_FIELDS: &[Field] = &[
    required("type", Schema::Tag("text")),
    required("media_type", Schema::Tag("text/plain")),
    required("data", Schema::String),
];

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn failure(error: io::Error) -> ModelError {
    ModelError::Adapter(error.to_string())
}
fn literal(bytes: &'static [u8]) -> SourceFragment {
    SourceFragment::literal(bytes)
}
fn generated(value: impl serde::Serialize) -> SourceFragment {
    SourceFragment::owned(serde_json::to_vec(&value).expect("hosted protocol literal"))
}
fn text(value: &'static str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::from_static(value.as_bytes())),
        TextEncoding::Utf8,
    )
}
fn normalized(source: JsonSource, schema: Schema) -> JsonSource {
    JsonSource::new(SourceBytes::Source(Arc::new(Normalized { source, schema })))
}
fn normalized_fragment(source: JsonSource, schema: Schema) -> SourceFragment {
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(std::alloc::Layout::new::<Normalized>())
        .expect("fixed hosted source allocation layout");
    SourceFragment::owned_raw(normalized(source, schema), layout.pad_to_align().size())
}
struct Normalized {
    source: JsonSource,
    schema: Schema,
}
impl ByteSource for Normalized {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            source: Some((self.source.clone(), self.schema)),
            budget,
            fragments: VecDeque::new(),
            active: None,
            pending: Bytes::new(),
            array: None,
            object: None,
            first: true,
        })
    }
}
struct Cursor {
    source: Option<(JsonSource, Schema)>,
    budget: Arc<dyn SourceBudget>,
    fragments: VecDeque<SourceFragment>,
    active: Option<FragmentCursor>,
    pending: Bytes,
    array: Option<(ArrayCursor, &'static Schema)>,
    object: Option<(json::ObjectCursor, &'static str)>,
    first: bool,
}
impl Cursor {
    async fn next_bytes(&mut self) -> io::Result<Option<Bytes>> {
        if let Some((source, schema)) = self.source.take() {
            // Closed schemas contain at most six fields; arrays retain only the current record.
            if let Schema::Array(item) = schema {
                self.array = Some((ArrayCursor::open(source, self.budget.clone()).await?, item));
                self.fragments.push_back(literal(b"["));
            } else if let Schema::Without(omit) = schema {
                self.object = Some((
                    json::ObjectCursor::open(source, self.budget.clone()).await?,
                    omit,
                ));
                self.fragments.push_back(literal(b"{"));
            } else {
                self.fragments = prepare(source, schema, self.budget.clone()).await?.into();
            }
        }
        loop {
            if let Some(active) = &mut self.active {
                if let Some(bytes) = active.next(self.budget.clone()).await? {
                    if bytes.is_empty() {
                        continue;
                    }
                    return Ok(Some(bytes));
                }
                self.active = None;
            }
            if let Some(fragment) = self.fragments.pop_front() {
                self.active = Some(FragmentCursor::new(fragment));
                continue;
            }
            if let Some((cursor, schema)) = &mut self.array {
                if let Some(value) = cursor.next().await? {
                    if !self.first {
                        self.fragments.push_back(literal(b","));
                    }
                    self.first = false;
                    self.fragments
                        .push_back(SourceFragment::Raw(normalized(value.source, **schema)));
                    continue;
                }
                self.array = None;
                self.fragments.push_back(literal(b"]"));
                continue;
            }
            if let Some((cursor, omit)) = &mut self.object {
                if let Some((field, selected)) = cursor.next_named([*omit].into_iter()).await? {
                    if selected.is_some() {
                        continue;
                    }
                    if !self.first {
                        self.fragments.push_back(literal(b","));
                    }
                    self.first = false;
                    self.fragments.extend([
                        literal(b"\""),
                        SourceFragment::Text(field.key),
                        literal(b"\":"),
                        SourceFragment::Raw(field.value.source),
                    ]);
                    continue;
                }
                self.object = None;
                self.fragments.push_back(literal(b"}"));
                continue;
            }
            return Ok(None);
        }
    }
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            if buffer.as_mut().is_empty() {
                return Err(invalid("empty hosted-result output allocation"));
            }
            if self.pending.is_empty() {
                self.pending = Bytes::new();
                self.pending = self.next_bytes().await?.unwrap_or_default();
            }
            let length = buffer.as_mut().len().min(self.pending.len());
            buffer.as_mut()[..length].copy_from_slice(&self.pending[..length]);
            self.pending = self.pending.slice(length..);
            if self.pending.is_empty() {
                self.pending = Bytes::new();
                self.pending = self.next_bytes().await?.unwrap_or_default();
            }
            Ok(source::SourceRead {
                buffer,
                bytes_read: length,
                eof: self.pending.is_empty(),
            })
        })
    }
}
async fn discriminator(
    source: &JsonSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<TextSource>> {
    json::field(source, &["type"], budget)
        .await?
        .filter(|value| value.kind == JsonKind::String)
        .map(|value| value.text())
        .transpose()
}
async fn selected(
    source: &JsonSource,
    options: &[&'static str],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<&'static str> {
    let tag = discriminator(source, budget.clone())
        .await?
        .ok_or_else(|| invalid("hosted result requires a string type"))?;
    for option in options {
        if json::text_eq(&tag, option, budget.clone()).await? {
            return Ok(option);
        }
    }
    Err(invalid("unknown hosted result type"))
}
async fn object(
    source: JsonSource,
    fields: &'static [Field],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    let names: Vec<_> = fields.iter().map(|field| field.name).collect();
    let values = json::fields(&source, &names, budget.clone()).await?;
    let mut output = Vec::with_capacity(fields.len() * 4 + 2);
    output.push(literal(b"{"));
    let mut first = true;
    for (field, value) in fields.iter().zip(values) {
        let absent = value
            .as_ref()
            .is_none_or(|value| value.kind == JsonKind::Null);
        if absent && matches!(field.missing, Missing::Omit) {
            continue;
        }
        if !first {
            output.push(literal(b","));
        }
        first = false;
        output.push(generated(field.name));
        output.push(literal(b":"));
        match (value, field.missing) {
            (None, Missing::Required) => {
                return Err(invalid("missing required hosted result field"));
            }
            (None, Missing::EmptyArray) => output.push(literal(b"[]")),
            (None, _) => output.push(literal(b"null")),
            (Some(value), Missing::Null | Missing::Omit) if value.kind == JsonKind::Null => {
                output.push(literal(b"null"))
            }
            (Some(value), _) => {
                output.push(SourceFragment::Raw(normalized(value.source, field.schema)))
            }
        }
    }
    output.push(literal(b"}"));
    Ok(output)
}
async fn prepare(
    source: JsonSource,
    schema: Schema,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    match schema {
        Schema::Object(fields) => object(source, fields, budget).await,
        Schema::String | Schema::Tag(_) => {
            let value = JsonValue {
                kind: json::kind(&source, budget.clone()).await?,
                source,
            };
            let value = value.text()?;
            if let Schema::Tag(expected) = schema
                && !json::text_eq(&value, expected, budget).await?
            {
                return Err(invalid("invalid hosted result field discriminator"));
            }
            Ok(vec![
                literal(b"\""),
                SourceFragment::Text(value),
                literal(b"\""),
            ])
        }
        Schema::Bool => {
            let value = json::bool_value(&source, budget).await?;
            Ok(vec![generated(value)])
        }
        Schema::Number => number(source, budget).await,
        Schema::Code => {
            let kind = selected(
                &source,
                &[
                    "code_execution_result",
                    "encrypted_code_execution_result",
                    "bash_code_execution_result",
                    "bash_code_execution_tool_result_error",
                    "text_editor_code_execution_tool_result_error",
                    "text_editor_code_execution_view_result",
                    "text_editor_code_execution_create_result",
                    "text_editor_code_execution_str_replace_result",
                ],
                budget.clone(),
            )
            .await?;
            let fields: &'static [Field] = match kind {
                "code_execution_result" => CODE_EXECUTION_RESULT_FIELDS,
                "encrypted_code_execution_result" => ENCRYPTED_CODE_EXECUTION_RESULT_FIELDS,
                "bash_code_execution_result" => BASH_CODE_EXECUTION_RESULT_FIELDS,
                "bash_code_execution_tool_result_error" => {
                    BASH_CODE_EXECUTION_TOOL_RESULT_ERROR_FIELDS
                }
                "text_editor_code_execution_tool_result_error" => {
                    TEXT_EDITOR_CODE_EXECUTION_TOOL_RESULT_ERROR_FIELDS
                }
                "text_editor_code_execution_view_result" => {
                    TEXT_EDITOR_CODE_EXECUTION_VIEW_RESULT_FIELDS
                }
                "text_editor_code_execution_create_result" => {
                    TEXT_EDITOR_CODE_EXECUTION_CREATE_RESULT_FIELDS
                }
                _ => TEXT_EDITOR_CODE_EXECUTION_STR_REPLACE_RESULT_FIELDS,
            };
            object(source, fields, budget).await
        }
        Schema::Advisor => {
            let fields: &'static [Field] = match selected(
                &source,
                &[
                    "advisor_result",
                    "advisor_redacted_result",
                    "advisor_tool_result_error",
                ],
                budget.clone(),
            )
            .await?
            {
                "advisor_result" => ADVISOR_RESULT_FIELDS,
                "advisor_redacted_result" => ADVISOR_REDACTED_RESULT_FIELDS,
                _ => ADVISOR_TOOL_RESULT_ERROR_FIELDS,
            };
            object(source, fields, budget).await
        }
        Schema::DocumentSource => {
            let fields: &'static [Field] =
                match selected(&source, &["base64", "text"], budget.clone()).await? {
                    "base64" => BASE64_FIELDS,
                    _ => TEXT_FIELDS,
                };
            object(source, fields, budget).await
        }
        Schema::Without(_) => unreachable!("open objects have a streaming cursor"),
        Schema::Array(_) => unreachable!("arrays have a streaming cursor"),
    }
}
async fn number(
    source: JsonSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    if json::kind(&source, budget.clone()).await? != JsonKind::Number {
        return Err(invalid("hosted result field is not a number"));
    }
    let mut number = json::number::NumberValidator::new();
    let mut cursor = source.bytes().open(budget.clone());
    loop {
        let read = cursor.read_chunk(budget.allocate(2048).await?).await?;
        if read.bytes_read == 0 && !read.eof {
            return Err(invalid("numeric source made no progress"));
        }
        for byte in &read.buffer.as_ref()[..read.bytes_read] {
            number.push(*byte)?;
        }
        if read.eof {
            break;
        }
    }
    // Internally tagged hosted results buffer fields before decoding f64.
    // Use the same serde buffer so arbitrary-precision Numbers keep that policy.
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum BufferedNumber {
        Number(f64),
    }
    let BufferedNumber::Number(value) = serde_json::from_value(number.into_representative_value()?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(vec![generated(value)])
}

pub(super) fn normalize_object_without(source: JsonSource, omit: &'static str) -> SourceFragment {
    normalized_fragment(source, Schema::Without(omit))
}

pub(super) async fn hosted_result(
    tool: &'static str,
    output: ToolOutputRecipe,
    parsed_error: Option<ParsedToolError>,
    budget: Arc<dyn SourceBudget>,
) -> Result<Option<(&'static str, Vec<SourceFragment>)>, ModelError> {
    hosted(tool, output, parsed_error, budget)
        .await
        .map_err(failure)
}
async fn hosted(
    tool: &'static str,
    output: ToolOutputRecipe,
    parsed_error: Option<ParsedToolError>,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<(&'static str, Vec<SourceFragment>)>> {
    let (source, error) = match output {
        ToolOutputRecipe::Json(source) => (source, false),
        ToolOutputRecipe::ErrorJson(source) => (source, true),
        ToolOutputRecipe::ErrorText(_) if tool == "code_execution" => (
            parsed_error
                .as_ref()
                .ok_or_else(|| invalid("missing frozen parsed tool error"))?
                .value
                .clone(),
            true,
        ),
        _ => return Ok(None),
    };
    if tool == "code_execution" && error {
        let source = error_value(source, parsed_error.as_ref(), budget.clone()).await?;
        let code_source = parsed_error
            .as_ref()
            .map_or_else(|| source.clone(), |parsed| parsed.code_value.clone());
        let kind = discriminator(&source, budget.clone()).await?;
        let standard = match kind {
            Some(kind) => {
                json::text_eq(&kind, "code_execution_tool_result_error", budget.clone()).await?
            }
            None => false,
        };
        let (wrapper, tag) = if standard {
            (
                "code_execution_tool_result",
                "code_execution_tool_result_error",
            )
        } else {
            (
                "bash_code_execution_tool_result",
                "bash_code_execution_tool_result_error",
            )
        };
        return Ok(Some((
            wrapper,
            error_result(code_source, tag, "unknown", budget).await?,
        )));
    }
    let (wrapper, schema) = match tool {
        "code_execution" => {
            if discriminator(&source, budget.clone()).await?.is_none() {
                return Ok(None);
            }
            let kind = selected(
                &source,
                &[
                    "code_execution_result",
                    "encrypted_code_execution_result",
                    "bash_code_execution_result",
                    "bash_code_execution_tool_result_error",
                    "text_editor_code_execution_tool_result_error",
                    "text_editor_code_execution_view_result",
                    "text_editor_code_execution_create_result",
                    "text_editor_code_execution_str_replace_result",
                ],
                budget.clone(),
            )
            .await?;
            (
                match kind {
                    "code_execution_result" | "encrypted_code_execution_result" => {
                        "code_execution_tool_result"
                    }
                    "bash_code_execution_result" | "bash_code_execution_tool_result_error" => {
                        "bash_code_execution_tool_result"
                    }
                    _ => "text_editor_code_execution_tool_result",
                },
                Schema::Code,
            )
        }
        "web_fetch" => ("web_fetch_tool_result", FETCH),
        "web_search" => ("web_search_tool_result", Schema::Array(&SEARCH)),
        "tool_search_tool_regex" | "tool_search_tool_bm25" => {
            let is_error = match discriminator(&source, budget.clone()).await? {
                Some(kind) => {
                    json::text_eq(&kind, "tool_search_tool_result_error", budget.clone()).await?
                }
                None => false,
            };
            if error || is_error {
                return Ok(Some((
                    "tool_search_tool_result",
                    error_result(
                        error_value(source, parsed_error.as_ref(), budget.clone()).await?,
                        "tool_search_tool_result_error",
                        "unavailable",
                        budget,
                    )
                    .await?,
                )));
            }
            return Ok(Some((
                "tool_search_tool_result",
                vec![
                    literal(b"{\"type\":\"tool_search_tool_search_result\",\"tool_references\":"),
                    normalized_fragment(source, Schema::Array(&REFERENCES)),
                    literal(b"}"),
                ],
            )));
        }
        "advisor" => ("advisor_tool_result", Schema::Advisor),
        _ => return Ok(None),
    };
    if error && matches!(tool, "web_fetch" | "web_search") {
        let tag = if tool == "web_fetch" {
            "web_fetch_tool_result_error"
        } else {
            "web_search_tool_result_error"
        };
        return Ok(Some((
            wrapper,
            error_result(
                error_value(source, parsed_error.as_ref(), budget.clone()).await?,
                tag,
                "unavailable",
                budget,
            )
            .await?,
        )));
    }
    Ok(Some((wrapper, vec![normalized_fragment(source, schema)])))
}
async fn error_value(
    source: JsonSource,
    parsed: Option<&ParsedToolError>,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<JsonSource> {
    if let Some(parsed) = parsed {
        return Ok(parsed.value.clone());
    }
    if json::kind(&source, budget).await? == JsonKind::String {
        return Err(invalid("missing frozen parsed tool error"));
    }
    Ok(source)
}
async fn error_result(
    source: JsonSource,
    tag: &'static str,
    default: &'static str,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    let code = json::field(&source, &["error_code"], budget)
        .await?
        .filter(|value| value.kind == JsonKind::String)
        .map(|value| value.text())
        .transpose()?
        .unwrap_or_else(|| text(default));
    Ok(vec![
        literal(b"{\"type\":"),
        generated(tag),
        literal(b",\"error_code\":\""),
        SourceFragment::Text(code),
        literal(b"\"}"),
    ])
}

#[cfg(test)]
mod tests;
