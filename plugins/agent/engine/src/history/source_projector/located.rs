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

//! Bind directory leaves to their original immutable payload bytes.
use super::*;
use maka_agent_facts::history::semantic::directory::{ByteRange, JsonSpan, TextSpan};
use std::ops::Range;

pub(super) fn range(value: ByteRange) -> io::Result<Range<u64>> {
    Ok(value.start..value.start.checked_add(value.len).ok_or_else(invalid)?)
}
fn bytes(value: ByteRange, context: &ProjectContext<'_>) -> io::Result<SourceBytes> {
    let captured = context.captured.ok_or_else(invalid)?;
    let root = context.payload_root.ok_or_else(invalid)?;
    Ok(SourceBytes::Source(
        captured
            .byte_range(root, value.start, value.len)
            .map_err(io::Error::other)?,
    ))
}
pub(super) fn text(value: TextSpan, context: &ProjectContext<'_>) -> io::Result<TextSource> {
    Ok(TextSource::measured(
        bytes(value.range, context)?,
        TextEncoding::JsonString,
        value.measure,
    ))
}
pub(super) fn json(value: JsonSpan, context: &ProjectContext<'_>) -> io::Result<JsonSource> {
    Ok(JsonSource::measured(
        bytes(value.range, context)?,
        value.measure,
    ))
}
