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

//! Width-independent preparation, separate from resumable visual measurement.
//! Preparation visits the complete input and belongs outside an interactive draw.
mod cursor;
mod operations;
mod seeking;
pub(super) mod tables;
use super::*;
pub use cursor::{Cursor, Progress};
pub(super) use operations::{Band, Operation, prepare_fence, record};
pub(super) use seeking::Probe;
pub use seeking::SeekStatus;
use std::sync::Arc;

/// Keep an indivisible terminal grapheme bounded before any interactive measurement.
const MAX_GRAPHEME_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub struct Document {
    operations: Arc<[Operation]>,
    text: Arc<str>,
    colors: crate::theme::Palette,
    bytes: usize,
    max_grapheme: usize,
}
impl Document {
    pub fn plain(text: &str) -> Result<Self, &'static str> {
        let mut writer = Self::writer(crate::theme::Palette::default());
        writer.text(text, 0..text.len(), true)?;
        Self::finish(writer)
    }
    pub fn markdown(
        text: &str,
        ascii: bool,
        colors: crate::theme::Palette,
    ) -> Result<Self, &'static str> {
        let mut writer = Self::writer(colors);
        render_events_into(
            text,
            resolved_events(text),
            ascii,
            &mut syntax::Cache::new(colors),
            &mut writer,
        )?;
        Self::finish(writer)
    }
    pub fn diff(
        text: &str,
        rows: &[diff::Row],
        ascii: bool,
        colors: crate::theme::Palette,
    ) -> Result<Self, &'static str> {
        let mut writer = Self::writer(colors);
        diff::prepare(&mut writer, text, rows, ascii, colors)?;
        Self::finish(writer)
    }
    fn events<'a>(
        source: &str,
        events: impl IntoIterator<Item = (Event<'a>, Range<usize>)>,
        ascii: bool,
        colors: crate::theme::Palette,
    ) -> Result<Self, &'static str> {
        let mut writer = Self::writer(colors);
        render_events_into(
            source,
            events,
            ascii,
            &mut syntax::Cache::new(colors),
            &mut writer,
        )?;
        Self::finish(writer)
    }
    pub fn shared_text(&self) -> Arc<str> {
        self.text.clone()
    }
    fn writer(colors: crate::theme::Palette) -> Writer {
        let mut writer = Writer::new(1);
        writer.recording = Some(Vec::new());
        writer.colors = colors;
        writer
    }
    fn finish(mut writer: Writer) -> Result<Self, &'static str> {
        writer.boundary()?;
        writer
            .text
            .truncate(writer.text.trim_end_matches('\n').len());
        let operations = writer.recording.take().expect("recording writer");
        let mut max_grapheme = 1;
        // Decoded adjacent Markdown tokens can form one semantic grapheme.
        for grapheme in writer.text.graphemes(true) {
            if grapheme.len() > MAX_GRAPHEME_BYTES {
                return Err("Transcript grapheme exceeds 16 KiB local capacity");
            }
            max_grapheme = max_grapheme.max(grapheme.len());
        }
        for operation in &operations {
            let text = match operation {
                Operation::Write(run) => Some(run.text.as_str()),
                Operation::FenceStart { info, .. } => Some(info.as_ref()),
                Operation::Table(table) => {
                    max_grapheme = max_grapheme.max(table.max_grapheme());
                    None
                }
                _ => None,
            };
            if let Some(text) = text {
                for grapheme in text.graphemes(true) {
                    if grapheme.len() > MAX_GRAPHEME_BYTES {
                        return Err("Transcript grapheme exceeds 16 KiB local capacity");
                    }
                    max_grapheme = max_grapheme.max(grapheme.len());
                }
            }
        }
        let bytes = writer.text.len()
            + operations.len() * std::mem::size_of::<Operation>()
            + operations.iter().map(Operation::bytes).sum::<usize>();
        if bytes > MAX_BYTES {
            return Err("Prepared transcript exceeds local capacity");
        }
        Ok(Self {
            operations: operations.into(),
            text: writer.text.into(),
            colors: writer.colors,
            bytes,
            max_grapheme,
        })
    }
    /// Complete semantic copy/selection text, available before width measurement.
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn cursor(&self, width: u16, window: Range<usize>) -> Cursor {
        Cursor::new(self.clone(), width, window)
    }
}

#[cfg(test)]
mod tests;
