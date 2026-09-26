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

//! A current source owns one cancellable preparation and one measured window.
use super::{block_layout::Request, frame_work, layout, preparation, selection::rebase::Rebase};
use crate::theme::Palette;
use layout::prepared::{Cursor, Document, SeekStatus};
use std::{sync::Arc, task::Poll};
mod window;

pub(super) const INLINE_BYTES: usize = 8192;
pub(super) struct State {
    document: Option<Document>,
    job: Option<preparation::Job>,
    waiting: Option<(Arc<str>, preparation::Input)>,
    previous: Option<Arc<str>>,
    rebase: Option<Rebase>,
    error: Option<&'static str>,
    cursor: Option<Cursor>,
    committed: Vec<layout::VisualLine>,
    committed_origin: usize,
    committed_bytes: usize,
    width: u16,
    ascii: bool,
    colors: Palette,
    request: Option<Request>,
    ready: bool,
    measured: usize,
    advanced: Option<u64>,
    located: Option<usize>,
}
impl State {
    pub fn new(ascii: bool, colors: Palette) -> Self {
        Self {
            document: None,
            job: None,
            waiting: None,
            previous: None,
            rebase: None,
            error: None,
            cursor: None,
            committed: vec![],
            committed_origin: 0,
            committed_bytes: 0,
            width: 0,
            ascii,
            colors,
            request: None,
            ready: false,
            measured: 0,
            advanced: None,
            located: None,
        }
    }
    pub fn with_previous(mut self, previous: Option<Arc<str>>) -> Self {
        self.previous = previous;
        self
    }
    pub fn prepares_text(&self, text: &Arc<str>) -> bool {
        self.previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, text))
            || self
                .document
                .as_ref()
                .is_some_and(|document| Arc::ptr_eq(&document.shared_text(), text))
    }
    pub fn rebase(&self) -> Option<(&Arc<str>, &Rebase)> {
        self.previous.as_ref().zip(self.rebase.as_ref())
    }
    pub fn finish_rebase(&mut self) {
        self.previous = None;
        self.rebase = None;
    }
    pub fn matches(&self, ascii: bool, colors: Palette) -> bool {
        self.ascii == ascii && self.colors == colors
    }
    pub fn prepare(
        &mut self,
        text: &str,
        input: impl FnOnce() -> preparation::Input,
    ) -> Result<bool, &'static str> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if self.document.is_some() {
            return Ok(true);
        }
        if self.job.is_none() {
            let (source, input) = self
                .waiting
                .take()
                .unwrap_or_else(|| (Arc::from(text), input()));
            self.job = match preparation::submit_rebasing(
                source.clone(),
                input.clone(),
                self.ascii,
                self.colors,
                self.previous.clone(),
            ) {
                Ok(job) => Some(job),
                Err(preparation::Admission::Busy) => {
                    self.waiting = Some((source, input));
                    return Ok(false);
                }
                Err(preparation::Admission::TooLarge) => {
                    self.error = Some("Prepared transcript exceeds local capacity");
                    return Err(self.error.unwrap());
                }
                Err(preparation::Admission::WorkerFailed) => {
                    self.error = Some("Transcript preparation worker is unavailable");
                    return Err(self.error.unwrap());
                }
            };
        }
        match self.job.as_mut().unwrap().poll() {
            Poll::Pending => Ok(false),
            Poll::Ready(result) => {
                self.job = None;
                match result {
                    Ok(prepared) => {
                        self.document = Some(prepared.document);
                        if let Some((previous, rebase)) = prepared.previous {
                            self.previous = Some(previous);
                            self.rebase = Some(rebase);
                        }
                        Ok(true)
                    }
                    Err(error) => {
                        let error = match error {
                            preparation::Failure::Preparation(error) => error,
                            preparation::Failure::WorkerFailed => {
                                "Transcript preparation worker is unavailable"
                            }
                        };
                        self.error = Some(error);
                        Err(error)
                    }
                }
            }
        }
    }
    pub fn text(&self) -> Option<&str> {
        self.document.as_ref().map(Document::text)
    }
    pub fn shares_text(&self, text: &Arc<str>) -> bool {
        self.previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, text))
            || self
                .document
                .as_ref()
                .is_some_and(|document| Arc::ptr_eq(&document.shared_text(), text))
    }
    #[cfg(test)]
    pub fn prepared(document: Document, ascii: bool, colors: Palette) -> Self {
        Self {
            document: Some(document),
            ..Self::new(ascii, colors)
        }
    }
    #[cfg(test)]
    pub fn pending(job: preparation::Job, ascii: bool, colors: Palette) -> Self {
        Self {
            job: Some(job),
            ..Self::new(ascii, colors)
        }
    }
    pub fn shared_text(&self) -> Option<Arc<str>> {
        self.document.as_ref().map(Document::shared_text)
    }
    pub fn ready(&self) -> bool {
        self.ready
    }
    pub fn lines(&self) -> &[layout::VisualLine] {
        &self.committed
    }
    pub fn origin(&self) -> usize {
        self.committed_origin
    }
    pub fn measured_at(&self, width: u16) -> Option<usize> {
        (self.width == width).then(|| self.rows()).flatten()
    }
    pub fn rows(&self) -> Option<usize> {
        self.cursor.as_ref().and_then(Cursor::total_rows)
    }
    pub fn measured(&self) -> usize {
        self.measured
    }
    pub fn located(&self) -> Option<usize> {
        if self.located.is_some() {
            return self.located;
        }
        match self.cursor.as_ref()?.seek_status() {
            SeekStatus::Ready { row } => Some(row),
            _ => None,
        }
    }
    pub fn bytes(&self) -> usize {
        self.document.as_ref().map_or(0, Document::bytes)
            + self.committed_bytes
            + if self.job.is_none() {
                self.previous.as_ref().map_or(0, |text| text.len())
            } else {
                0
            }
            + self.waiting.as_ref().map_or(0, |(source, input)| {
                source.len()
                    + match input {
                        preparation::Input::Diff(rows) => std::mem::size_of_val(rows.as_ref()),
                        _ => 0,
                    }
            })
            + self
                .job
                .as_ref()
                .map_or(0, preparation::Job::retained_bytes)
            + self.cursor.as_ref().map_or(0, Cursor::retained_bytes)
    }
    pub fn cancel_preparation(&mut self) {
        self.job = None;
        self.waiting = None;
    }
    pub fn evict_geometry(&mut self) {
        self.cursor = None;
        self.committed = vec![];
        self.committed_bytes = 0;
        self.committed_origin = 0;
        self.request = None;
        self.ready = false;
        self.located = None;
    }
}
