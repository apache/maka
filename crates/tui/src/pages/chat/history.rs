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

use super::{render::Transcript, *};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use uuid::Uuid;

const PAGE_MATCHES: usize = 32;
const BACK_PAGES: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub generation: u64,
    pub subscription: String,
    pub through: Option<u64>,
}
#[derive(Clone)]
pub enum Work {
    Scan(TranscriptSearchInput),
    Preview(SessionTranscriptPageInput, u64),
}
#[derive(Clone)]
pub struct Request {
    id: Uuid,
    revision: u64,
    pub context: Context,
    pub work: Work,
}
pub enum Output {
    Scan(TranscriptSearchResult),
    Preview(TranscriptBatch),
}
pub struct History {
    id: Uuid,
    revision: u64,
    query: String,
    trace: bool,
    context: Option<Context>,
    ready_at: Instant,
    scan: bool,
    cursor: Option<String>,
    start: Option<String>,
    previous: VecDeque<(Option<String>, usize)>,
    offset: usize,
    pub matches: Vec<TranscriptSearchMatch>,
    pub selected: usize,
    last_on_page: bool,
    pub more: bool,
    pub scanning: bool,
    preview_wanted: bool,
    pub preview: Option<Transcript>,
    pub reader_surface: crate::ui::Surface<crate::ui::transcript::search::Command>,
    preview_rows: BTreeMap<u64, Value>,
    preview_dirty: bool,
    pub preview_loading: bool,
    pub error: Option<String>,
    pub list_area: Option<Rect>,
    pub preview_area: Option<Rect>,
}
impl Default for History {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            revision: 0,
            query: String::new(),
            trace: false,
            context: None,
            ready_at: Instant::now(),
            scan: false,
            cursor: None,
            start: None,
            previous: VecDeque::new(),
            offset: 0,
            matches: vec![],
            selected: 0,
            last_on_page: false,
            more: false,
            scanning: false,
            preview_wanted: false,
            preview: None,
            reader_surface: Default::default(),
            preview_rows: BTreeMap::new(),
            preview_dirty: false,
            preview_loading: false,
            error: None,
            list_area: None,
            preview_area: None,
        }
    }
}
impl History {
    pub fn query_empty(&self) -> bool {
        self.query.is_empty()
    }
    pub fn changed(&mut self, query: &str, trace: bool) {
        if self.query == query && self.trace == trace {
            return;
        }
        self.query = query.into();
        self.trace = trace;
        self.restart();
    }
    pub fn restart(&mut self) {
        self.context = None;
        self.previous.clear();
        self.offset = 0;
        self.page(None);
    }
    fn page(&mut self, cursor: Option<String>) {
        self.revision += 1;
        self.start = cursor.clone();
        self.cursor = cursor;
        self.matches.clear();
        self.selected = 0;
        self.last_on_page = false;
        self.scan = !self.query.is_empty();
        self.scanning = self.scan;
        self.more = false;
        self.error = None;
        self.preview = None;
        self.preview_rows.clear();
        self.preview_loading = false;
        self.preview_wanted = false;
        self.ready_at = Instant::now() + Duration::from_millis(180);
        self.invalidate_geometry();
    }
    pub fn invalidate_geometry(&mut self) {
        self.reader_surface.invalidate();
        self.list_area = None;
        self.preview_area = None;
    }
    pub fn wait(&self) -> Option<Duration> {
        (self.scan && self.error.is_none())
            .then(|| self.ready_at.saturating_duration_since(Instant::now()))
    }
    pub fn count(&self) -> String {
        if self.matches.is_empty() {
            return if self.scanning {
                "…".into()
            } else {
                "0/0".into()
            };
        }
        format!(
            "{}/{}{}",
            self.offset + self.selected + 1,
            self.offset + self.matches.len(),
            if self.more || self.scanning { "+" } else { "" }
        )
    }
    pub fn pick(&mut self, sequence: u64) {
        let Some(index) = self
            .matches
            .iter()
            .position(|item| item.sequence == sequence)
        else {
            return;
        };
        if index == self.selected && (self.preview.is_some() || self.preview_loading) {
            return;
        }
        self.selected = index;
        self.preview = None;
        self.preview_rows.clear();
        self.preview_wanted = true;
        self.preview_loading = true;
    }
    pub fn navigate(&mut self, forward: bool) {
        if self.matches.is_empty() {
            return;
        }
        let next = if forward {
            self.selected + 1
        } else {
            self.selected.saturating_sub(1)
        };
        if !forward && self.selected == 0 {
            if let Some((cursor, offset)) = self.previous.pop_back() {
                self.offset = offset;
                self.page(cursor);
                self.last_on_page = true;
            }
        } else if let Some(item) = self.matches.get(next) {
            self.pick(item.sequence);
        } else if self.more && !self.scanning {
            if self.previous.len() == BACK_PAGES {
                self.previous.pop_front();
            }
            self.previous.push_back((self.start.clone(), self.offset));
            self.offset += self.matches.len();
            self.page(self.cursor.clone());
        }
    }
    pub fn request(&mut self, context: Context) -> Option<Request> {
        if self.error.is_some() || self.query.is_empty() {
            return None;
        }
        let context = self.context.get_or_insert(context).clone();
        let work = if self.preview_wanted {
            let sequence = self.matches.get(self.selected)?.sequence;
            self.preview_wanted = false;
            Work::Preview(
                SessionTranscriptPageInput {
                    subscription_id: context.subscription.clone(),
                    direction: SessionTranscriptPageDirection::Newer,
                    through_sequence: context.through,
                    cursor: None,
                    anchor_sequence: sequence.checked_sub(1),
                    // Complete only this row, not the rest of the conversation.
                    max_bytes: 1,
                },
                sequence,
            )
        } else if self.scan && self.ready_at <= Instant::now() {
            self.scan = false;
            Work::Scan(TranscriptSearchInput {
                subscription_id: context.subscription.clone(),
                through_sequence: context.through,
                query: self.query.clone(),
                include_internal: self.trace,
                cursor: self.cursor.clone(),
                max_matches: PAGE_MATCHES - self.matches.len(),
            })
        } else {
            return None;
        };
        Some(Request {
            id: self.id,
            revision: self.revision,
            context,
            work,
        })
    }
    pub fn fail(&mut self, error: String) {
        self.error = Some(error);
        self.scan = false;
        self.scanning = false;
        self.preview_loading = false;
    }
    pub fn complete(
        &mut self,
        request: Request,
        result: Result<Output, String>,
        i18n: &I18n,
        ascii: bool,
    ) {
        if request.id != self.id
            || request.revision != self.revision
            || self.context.as_ref() != Some(&request.context)
        {
            return;
        }
        if let Work::Preview(_, sequence) = &request.work
            && self
                .matches
                .get(self.selected)
                .is_none_or(|item| item.sequence != *sequence)
        {
            return;
        }
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.fail(error);
                return;
            }
        };
        match (request.work, result) {
            (Work::Scan(_), Output::Scan(result)) => {
                if self.matches.len() + result.matches.len() > PAGE_MATCHES {
                    self.fail("History search exceeds page capacity".into());
                    return;
                }
                if self
                    .matches
                    .last()
                    .zip(result.matches.first())
                    .is_some_and(|(last, first)| first.sequence <= last.sequence)
                {
                    self.fail("History search order changed".into());
                    return;
                }
                self.cursor = result.next_cursor;
                let first = self.matches.is_empty();
                self.matches.extend(result.matches);
                self.more = self.cursor.is_some();
                self.scan = self.more && self.matches.len() < PAGE_MATCHES;
                self.scanning = self.scan;
                self.ready_at = Instant::now();
                if self.last_on_page && !self.scanning {
                    self.last_on_page = false;
                    if let Some(item) = self.matches.last() {
                        self.pick(item.sequence);
                    }
                } else if first
                    && !self.last_on_page
                    && let Some(item) = self.matches.first()
                {
                    self.pick(item.sequence);
                }
            }
            (Work::Preview(_, sequence), Output::Preview(batch)) => {
                self.preview_loading = false;
                if batch.rows.len() != 1 || batch.rows[0].sequence != sequence {
                    self.fail("Search result is no longer available".into());
                    return;
                }
                if let Err(error) = validate_row(&batch.rows[0].value) {
                    self.fail(error.to_string());
                    return;
                }
                self.preview_rows = batch
                    .rows
                    .into_iter()
                    .map(|row| (row.sequence, row.value))
                    .collect();
                self.preview_dirty = true;
                self.prepare_preview(i18n, ascii);
            }
            _ => self.fail("History search response kind changed".into()),
        }
    }
    pub fn invalidate_labels(&mut self) {
        self.preview_dirty = true;
        if let Some(preview) = &mut self.preview {
            preview.invalidate_labels();
        }
    }
    pub fn prepare_preview(&mut self, i18n: &I18n, ascii: bool) {
        if !self.preview_dirty || self.preview_rows.is_empty() {
            return;
        }
        self.preview_dirty = false;
        let fresh = self.preview.is_none();
        let preview = self.preview.get_or_insert_with(Transcript::default);
        preview.trace = self.trace;
        presentation::Presentation::default().sync(
            preview,
            &self.preview_rows,
            &[],
            0,
            i18n,
            ascii,
        );
        if fresh {
            if let Some(key) = preview.first_visible()
                && preview.folded(&key)
            {
                preview.toggle(&key);
            }
            preview.search_command(render::search::Command::Open);
            preview.search_input(&crossterm::event::Event::Paste(self.query.clone()));
        }
    }
}

pub async fn execute(client: &Client, request: &Request) -> Result<Output, Error> {
    match &request.work {
        Work::Scan(input) => Ok(Output::Scan(client.transcript_search(input.clone()).await?)),
        Work::Preview(input, _) => {
            let page = client.transcript_page(input.clone()).await?;
            Ok(Output::Preview(
                client
                    .complete_transcript_page(&input.subscription_id, page)
                    .await?,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use maka_client::transcript::TranscriptRow;
    use serde_json::json;
    fn context() -> Context {
        Context {
            generation: 1,
            subscription: "sub".into(),
            through: Some(1000),
        }
    }
    fn locale() -> I18n {
        I18n::new(LocalePreference::Explicit(Locale::En), Locale::En)
    }
    fn request(history: &mut History) -> Request {
        history.ready_at = Instant::now();
        history.request(context()).unwrap()
    }
    fn results(sequences: impl IntoIterator<Item = u64>, cursor: Option<&str>) -> Output {
        Output::Scan(TranscriptSearchResult {
            session_id: "s".into(),
            through_sequence: Some(1000),
            matches: sequences
                .into_iter()
                .map(|sequence| TranscriptSearchMatch {
                    sequence,
                    preview: format!("needle {sequence}"),
                })
                .collect(),
            next_cursor: cursor.map(str::to_owned),
        })
    }
    fn preview(sequence: u64) -> Output {
        Output::Preview(TranscriptBatch {
            through_sequence: Some(1000),
            next_cursor: Some("later".into()),
            rows: vec![TranscriptRow {
                sequence,
                value: json!({"type":"assistant","id":format!("m{sequence}"),"turnId":"t","text":"needle message"}),
            }],
        })
    }
    #[test]
    fn history_pages_empty_scan_batches_freeze_fence_and_read_only_the_selected_message() {
        let mut history = History::default();
        history.changed("needle", false);
        assert!(history.wait().unwrap() > Duration::ZERO);
        assert!(history.request(context()).is_none(), "typing is debounced");
        let first = request(&mut history);
        history.complete(first, Ok(results([], Some("empty"))), &locale(), false);
        assert!(history.scanning && history.matches.is_empty());
        let second = request(&mut history);
        assert!(
            matches!(&second.work, Work::Scan(input) if input.cursor.as_deref() == Some("empty"))
        );
        history.complete(second, Ok(results(1..=32, Some("next"))), &locale(), false);
        assert_eq!(history.count(), "1/32+");
        let message = history
            .request(Context {
                through: Some(2000),
                ..context()
            })
            .unwrap();
        assert!(
            matches!(&message.work, Work::Preview(input, 1) if input.anchor_sequence == Some(0) && input.max_bytes == 1 && input.through_sequence == Some(1000))
        );
        history.complete(message, Ok(preview(1)), &locale(), false);
        assert_eq!(history.preview_rows.len(), 1);
        history.pick(32);
        history.navigate(true);
        assert!(history.preview_rows.is_empty() && history.matches.is_empty());
        let page = request(&mut history);
        history.complete(page, Ok(results([40, 41], None)), &locale(), false);
        assert_eq!(history.count(), "33/34");
        history.navigate(false);
        let previous = request(&mut history);
        assert!(matches!(&previous.work, Work::Scan(input) if input.cursor.is_none()));
        history.complete(
            previous,
            Ok(results(1..=32, Some("next"))),
            &locale(),
            false,
        );
        assert_eq!(history.count(), "32/32+");
        assert!(history.preview_rows.is_empty());
        for _ in 0..100 {
            history.matches = (1..=32)
                .map(|sequence| TranscriptSearchMatch {
                    sequence,
                    preview: "needle".into(),
                })
                .collect();
            history.selected = 31;
            history.more = true;
            history.scanning = false;
            history.cursor = Some("next".into());
            history.navigate(true);
        }
        assert_eq!(history.previous.len(), BACK_PAGES);
        history.restart();
        assert!(history.previous.is_empty() && history.context.is_none());
    }
    #[test]
    fn history_rejects_aba_queries_closed_searches_and_late_preview_without_mutating_chat() {
        let i18n = locale();
        let mut history = History::default();
        history.changed("needle", false);
        let stale = request(&mut history);
        history.changed("other", false);
        history.changed("needle", false);
        history.complete(stale.clone(), Ok(results([1], None)), &i18n, false);
        assert!(history.matches.is_empty());
        let fresh = request(&mut history);
        history.complete(fresh, Ok(results([2, 3], None)), &i18n, false);
        let stale_preview = request(&mut history);
        history.pick(3);
        history.complete(stale_preview, Ok(preview(2)), &i18n, false);
        assert!(history.preview.is_none());
        let fresh_preview = request(&mut history);
        history.complete(fresh_preview, Ok(preview(3)), &i18n, false);
        assert!(history.preview.is_some());
        history.invalidate_labels();
        history.prepare_preview(
            &I18n::new(LocalePreference::Explicit(Locale::ZhCn), Locale::ZhCn),
            true,
        );
        assert_eq!(
            history.preview_rows.len(),
            1,
            "locale reflow needs no extra Host query"
        );
        let mut reopened = History::default();
        reopened.changed("needle", false);
        reopened.complete(stale, Ok(results([1], None)), &i18n, false);
        assert!(reopened.matches.is_empty());

        let mut chat = Chat {
            subscription: Some("sub".into()),
            generation: 1,
            ..Default::default()
        };
        let mut search = render::search::Search::default();
        history.restart();
        let request = request(&mut history);
        search.history = true;
        chat.history = Some(Box::new(history));
        chat.view.search = Some(search);
        chat.select(&Route::Session("other".into()));
        chat.history_completed(request, Ok(results([1], None)), &i18n, false);
        assert!(chat.view.search.is_none() && chat.rows.is_empty());
    }
}
