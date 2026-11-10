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

use super::{ReadMetadata, ReadPage, ReadRequest, TextPageScan};
use crate::model::prompt_source::source::{
    self as pull, JsonSource, SourceBudget, SourceBytes, TextEncoding, TextSource,
    json::{self, JsonKind, JsonValue},
};
use serde_json::Value;
use std::{collections::BTreeMap, io, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Render an already selected projection; callers retain responsibility for read authority.
pub async fn projection_page(
    projection: JsonSource,
    tool_name: &str,
    request: &ReadRequest,
    max_chars: usize,
    budget: Arc<dyn SourceBudget>,
    stop: &CancellationToken,
) -> io::Result<ReadPage> {
    let (parts, metadata) = projection_parts(projection, tool_name, &budget).await?;
    page(parts, metadata, request, max_chars, budget, stop).await
}

pub async fn json_page(
    source: JsonSource,
    tool_name: &str,
    request: &ReadRequest,
    max_chars: usize,
    budget: Arc<dyn SourceBudget>,
    stop: &CancellationToken,
) -> io::Result<ReadPage> {
    let value = json::inspect(&source, budget.clone()).await?;
    let (parts, metadata) = display(value, source.into_bytes(), tool_name, &budget).await?;
    page(parts, metadata, request, max_chars, budget, stop).await
}

async fn page(
    parts: Vec<SourceBytes>,
    metadata: Option<ReadMetadata>,
    request: &ReadRequest,
    max_chars: usize,
    budget: Arc<dyn SourceBudget>,
    stop: &CancellationToken,
) -> io::Result<ReadPage> {
    let overhead = metadata
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(io::Error::other)?
        .map_or(0, |value| value.encode_utf16().count() + 12);
    let mut page = Utf8Page::new(request, max_chars.saturating_sub(overhead));
    let mut previous = false;
    for bytes in parts {
        let mut cursor = bytes.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await.map_err(io::Error::other)?;
        let mut started = false;
        loop {
            if stop.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "tool call was cancelled",
                ));
            }
            let read = cursor.read_chunk(buffer).await.map_err(io::Error::other)?;
            if read.bytes_read > 0 {
                if !started && previous {
                    page.push(b"\n")?;
                }
                page.push(&read.buffer.as_ref()[..read.bytes_read])?;
                started = true;
                previous = true;
            }
            buffer = read.buffer;
            if read.eof {
                break;
            }
        }
    }
    let mut page = page.finish()?;
    page.metadata = metadata;
    Ok(page)
}

async fn small(value: JsonValue, budget: &Arc<dyn SourceBudget>) -> io::Result<Value> {
    let bytes = collect(value.source.into_bytes(), budget, 1024).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}
async fn collect(
    source: SourceBytes,
    budget: &Arc<dyn SourceBudget>,
    maximum: usize,
) -> io::Result<Vec<u8>> {
    let mut reader = source.open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await.map_err(io::Error::other)?;
    let mut bytes = Vec::new();
    loop {
        let read = reader.read_chunk(buffer).await.map_err(io::Error::other)?;
        if bytes.len() + read.bytes_read > maximum {
            return Err(io::Error::other(
                "Original tool result descriptor is too large",
            ));
        }
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            return Ok(bytes);
        }
    }
}

async fn projection_parts(
    projection: JsonSource,
    tool_name: &str,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<(Vec<SourceBytes>, Option<ReadMetadata>)> {
    let mut fields = json::fields(&projection, &["kind", "value"], budget.clone())
        .await
        .map_err(io::Error::other)?
        .into_iter();
    let kind = fields
        .next()
        .flatten()
        .ok_or_else(|| io::Error::other("Original archived tool projection kind is missing"))?;
    let value = fields.next().flatten();
    let kind = small(kind, budget).await?;
    let encoded = SourceBytes::Source(crate::archive::projection_source(projection));
    match kind.as_str() {
        Some("text" | "failure") => Ok((
            vec![pull::text::bytes(
                TextSource::new(encoded, TextEncoding::JsonString),
                budget.clone(),
            )],
            None,
        )),
        Some("content") => Ok((vec![encoded], None)),
        Some("json") => {
            let value = value
                .ok_or_else(|| io::Error::other("Original archived JSON projection is missing"))?;
            display(value, encoded, tool_name, budget).await
        }
        _ => Err(io::Error::other(
            "Original archived tool projection codec is unsupported",
        )),
    }
}

async fn display(
    value: JsonValue,
    serialized: SourceBytes,
    tool_name: &str,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<(Vec<SourceBytes>, Option<ReadMetadata>)> {
    if value.kind == JsonKind::String {
        return Ok((
            vec![pull::text::bytes(
                value.text().map_err(io::Error::other)?,
                budget.clone(),
            )],
            None,
        ));
    }
    if value.kind == JsonKind::Object {
        if matches!(tool_name, "Shell" | "Read") {
            if let Some(shell) = shell(&value.source, budget).await? {
                return Ok(shell);
            }
        }
        let mut object = json::ObjectCursor::open(value.source.clone(), budget.clone())
            .await
            .map_err(io::Error::other)?;
        let mut count = 0;
        let mut only_known = true;
        while let Some((_, name)) = object
            .next_named_spans(["kind", "text", "content"].into_iter())
            .await
            .map_err(io::Error::other)?
        {
            count += 1;
            only_known &= name.is_some();
        }
        if only_known && count == 2 {
            let fields = json::fields(&value.source, &["kind", "text"], budget.clone())
                .await
                .map_err(io::Error::other)?;
            if let [Some(kind), Some(text)] = fields.as_slice()
                && kind.kind == JsonKind::String
                && text.kind == JsonKind::String
                && json::text_eq(
                    &kind.text().map_err(io::Error::other)?,
                    "text",
                    budget.clone(),
                )
                .await
                .map_err(io::Error::other)?
            {
                return Ok((
                    vec![pull::text::bytes(
                        text.text().map_err(io::Error::other)?,
                        budget.clone(),
                    )],
                    None,
                ));
            }
        }
        if only_known && count == 1 && tool_name == "Read" {
            if let Some(content) = json::field(&value.source, &["content"], budget.clone())
                .await
                .map_err(io::Error::other)?
                && content.kind == JsonKind::String
            {
                return Ok((
                    vec![pull::text::bytes(
                        content.text().map_err(io::Error::other)?,
                        budget.clone(),
                    )],
                    None,
                ));
            }
        }
    }
    Ok((vec![serialized], None))
}

async fn shell(
    source: &JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<Option<(Vec<SourceBytes>, Option<ReadMetadata>)>> {
    let names = [
        "kind",
        "status",
        "mode",
        "revision",
        "exitCode",
        "output",
        "failureMessage",
    ];
    let spans = json::fields(source, &names, budget.clone())
        .await
        .map_err(io::Error::other)?;
    let mut fields: BTreeMap<_, _> = names
        .into_iter()
        .zip(spans)
        .filter_map(|(name, value)| value.map(|value| (name, value)))
        .collect();
    let Some(kind) = fields.get("kind") else {
        return Ok(None);
    };
    if kind.kind != JsonKind::String {
        return Ok(None);
    }
    let shell_run = json::text_eq(
        &kind.text().map_err(io::Error::other)?,
        "shell_run",
        budget.clone(),
    )
    .await
    .map_err(io::Error::other)?;
    let terminal = json::text_eq(
        &kind.text().map_err(io::Error::other)?,
        "terminal",
        budget.clone(),
    )
    .await
    .map_err(io::Error::other)?;
    if !shell_run && !terminal {
        return Ok(None);
    }
    let mut metadata = serde_json::Map::new();
    for name in ["kind", "status", "mode", "revision", "exitCode"] {
        if !shell_run && matches!(name, "mode" | "revision") {
            continue;
        }
        if let Some(value) = fields.remove(name) {
            if value.kind != JsonKind::Null {
                metadata.insert(name.to_owned(), small(value, budget).await?);
            }
        }
    }
    let mut parts = Vec::new();
    if let Some(output) = fields.remove("output")
        && output.kind != JsonKind::Null
    {
        let names = [
            "mode",
            "stdout",
            "stderr",
            "scrollback",
            "screen",
            "lastAlternateScreen",
            "stdoutTruncated",
            "stderrTruncated",
            "truncated",
            "redacted",
        ];
        let spans = json::fields(&output.source, &names, budget.clone())
            .await
            .map_err(io::Error::other)?;
        let mut output: BTreeMap<_, _> = names
            .into_iter()
            .zip(spans)
            .filter_map(|(name, value)| value.map(|value| (name, value)))
            .collect();
        let mode = output
            .remove("mode")
            .ok_or_else(|| io::Error::other("Original tool result field is missing"))?;
        let pipes = json::text_eq(
            &mode.text().map_err(io::Error::other)?,
            "pipes",
            budget.clone(),
        )
        .await
        .map_err(io::Error::other)?;
        let pty = json::text_eq(
            &mode.text().map_err(io::Error::other)?,
            "pty",
            budget.clone(),
        )
        .await
        .map_err(io::Error::other)?;
        let (texts, flags): (&[&str], &[&str]) = if pipes {
            (
                &["stdout", "stderr"],
                &["stdoutTruncated", "stderrTruncated", "redacted"],
            )
        } else if pty {
            (
                &["scrollback", "screen", "lastAlternateScreen"],
                &["truncated", "redacted"],
            )
        } else {
            return Ok(None);
        };
        for name in texts {
            if let Some(text) = output.remove(*name)
                && text.kind != JsonKind::Null
            {
                parts.push(pull::text::bytes(
                    text.text().map_err(io::Error::other)?,
                    budget.clone(),
                ));
            }
        }
        for name in flags {
            if let Some(flag) = output.remove(*name) {
                metadata.insert((*name).to_owned(), small(flag, budget).await?);
            }
        }
    }
    if let Some(failure) = fields.remove("failureMessage")
        && failure.kind != JsonKind::Null
    {
        parts.push(pull::text::bytes(
            failure.text().map_err(io::Error::other)?,
            budget.clone(),
        ));
    }
    let metadata = serde_json::from_value(Value::Object(metadata)).map_err(io::Error::other)?;
    Ok(Some((parts, Some(metadata))))
}

pub struct Utf8Page<'a> {
    scan: TextPageScan<'a>,
    pending: Vec<u8>,
}
impl<'a> Utf8Page<'a> {
    pub fn new(request: &'a ReadRequest, budget: usize) -> Self {
        Self {
            scan: request.scan_with_budget(budget),
            pending: Vec::new(),
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.pending.extend_from_slice(bytes);
        let end = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => {
                return Err(io::Error::other(
                    "Read cannot decode this binary content as UTF-8 text",
                ));
            }
        };
        let text = std::str::from_utf8(&self.pending[..end]).map_err(io::Error::other)?;
        if text.contains('\0') {
            return Err(io::Error::other(
                "Read cannot decode this binary content as text",
            ));
        }
        self.scan.push(text);
        self.pending.drain(..end);
        Ok(())
    }
    pub fn finish(self) -> io::Result<ReadPage> {
        if !self.pending.is_empty() {
            return Err(io::Error::other("Read cannot decode incomplete UTF-8 text"));
        }
        self.scan.finish().map_err(io::Error::other)
    }
}
