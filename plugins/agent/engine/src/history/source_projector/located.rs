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

//! Checked positions only for original payload navigation that contains artifact references.
use super::*;
use maka_event_log::context::semantic::{PayloadEncoding, PayloadSource};
use std::ops::Range;

#[derive(Clone)]
pub(super) struct LocatedJson {
    pub root: PayloadSource,
    pub range: Range<u64>,
}
pub(super) struct Value {
    pub value: JsonValue,
    pub location: Option<LocatedJson>,
}
impl LocatedJson {
    pub fn child(&self, relative: Range<u64>) -> io::Result<Self> {
        if relative.start > relative.end || relative.end > self.range.end - self.range.start {
            return Err(invalid());
        }
        let start = self
            .range
            .start
            .checked_add(relative.start)
            .ok_or_else(invalid)?;
        let end = self
            .range
            .start
            .checked_add(relative.end)
            .ok_or_else(invalid)?;
        Ok(Self {
            root: self.root.clone(),
            range: start..end,
        })
    }
    fn source(&self, context: &ProjectContext<'_>) -> io::Result<JsonSource> {
        let captured = context.captured.ok_or_else(invalid)?;
        Ok(JsonSource {
            bytes: SourceBytes::Source(
                captured
                    .byte_range(
                        &self.root,
                        self.range.start,
                        self.range.end - self.range.start,
                    )
                    .map_err(io::Error::other)?,
            ),
        })
    }
    async fn field(&self, name: &str, context: &ProjectContext<'_>) -> io::Result<Option<Self>> {
        let source = self.source(context)?;
        let mut fields = fields(&source, Some(self), &[name], context).await?;
        Ok(fields.pop().flatten().and_then(|value| value.location))
    }
}
fn payload(context: &ProjectContext<'_>) -> io::Result<Option<LocatedJson>> {
    let Some(root) = context.payload_root else {
        return Ok(None);
    };
    let end = root.byte_len().ok_or_else(invalid)?;
    Ok(Some(LocatedJson {
        root: root.clone(),
        range: 0..end,
    }))
}
pub(super) async fn attachments(context: &ProjectContext<'_>) -> io::Result<Option<LocatedJson>> {
    let Some(payload) = payload(context)? else {
        return Ok(None);
    };
    let user = payload.field("User", context).await?.ok_or_else(invalid)?;
    user.field("attachments", context).await
}
pub(super) async fn tool_parts(context: &ProjectContext<'_>) -> io::Result<Option<LocatedJson>> {
    let Some(payload) = payload(context)? else {
        return Ok(None);
    };
    let tool = if payload.root.encoding() == PayloadEncoding::CanonicalProjection {
        payload
    } else {
        payload.field("Tool", context).await?.ok_or_else(invalid)?
    };
    tool.field("parts", context).await
}
pub(super) async fn fields(
    source: &JsonSource,
    location: Option<&LocatedJson>,
    names: &[&str],
    context: &ProjectContext<'_>,
) -> io::Result<Vec<Option<Value>>> {
    let mut output: Vec<Option<Value>> = (0..names.len()).map(|_| None).collect();
    let mut cursor = json::ObjectCursor::open(source.clone(), context.budget.clone()).await?;
    while let Some(spans) = cursor.next_spans().await? {
        let key = TextSource {
            bytes: source.bytes.slice(spans.key_range)?,
            encoding: TextEncoding::JsonString,
        };
        for (index, name) in names.iter().enumerate() {
            if json::text_eq(&key, name, context.budget.clone()).await? {
                output[index] = Some(Value {
                    value: JsonValue {
                        source: source.slice(spans.value_range.clone())?,
                        kind: spans.kind,
                    },
                    location: location
                        .map(|parent| parent.child(spans.value_range.clone()))
                        .transpose()?,
                });
            }
        }
    }
    Ok(output)
}
pub(super) struct Values {
    source: JsonSource,
    location: Option<LocatedJson>,
    cursor: json::ArrayCursor,
}
impl Values {
    pub async fn open(
        source: JsonSource,
        location: Option<LocatedJson>,
        context: &ProjectContext<'_>,
    ) -> io::Result<Self> {
        let cursor = json::ArrayCursor::open(source.clone(), context.budget.clone()).await?;
        Ok(Self {
            source,
            location,
            cursor,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<Value>> {
        let Some(span) = self.cursor.next_span().await? else {
            return Ok(None);
        };
        Ok(Some(Value {
            value: JsonValue {
                source: self.source.slice(span.value_range.clone())?,
                kind: span.kind,
            },
            location: self
                .location
                .as_ref()
                .map(|parent| parent.child(span.value_range))
                .transpose()?,
        }))
    }
}
