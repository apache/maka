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

//! The text a find in the conversation searches, read from the transcript
//! model, not from the views: the virtualized list draws only the rows in
//! view, and a match must count wherever its row is.
//!
//! Each held item contributes the text its row shows or would show open:
//! a user message as written, a reply's visible Markdown text
//! ([`markdown`]), a reasoning's text (capped as its row caps it), a Tool
//! call's name, its one-line summary, and the output (or, before a result,
//! the input) its card shows, collapsed or not. Prompt cards, the edits
//! card and diffs are not searched. No GPUI: the main thread hands over
//! what changed ([`ItemSource`]) and a background task extracts and
//! searches it.

mod markdown;

use std::ops::Range;
use std::sync::Arc;

use search::SearchQuery;
use search::matching::{find_ranges, find_ranges_in_cut};
use shared::copy::Locale;
use transcript_model::{ToolItem, TurnItem, TurnView};

use crate::rows::{
    RowKey, cap_cut, hidden_tool, tool_detail_text, tool_name_text, tool_summary_cut,
};

pub(crate) use markdown::VisibleText;

/// Which text of a row a match is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Field {
    /// A user message, a reply or a reasoning: the row's own text.
    Body,
    /// A Tool call's name, in its header.
    ToolName,
    /// A Tool call's one-line summary, in its header.
    ToolSummary,
    /// What a Tool call's card shows open: its output, or its input.
    ToolDetail,
}

/// One occurrence of a query in the transcript: the row, the text of the
/// row, and the range. In a reply ([`Field::Body`] of a text row) the
/// range is of the Markdown source, which the row maps to what it draws;
/// elsewhere it is of the text the row shows. Equal matches are the same
/// text of the same row, however the rows around it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptMatch {
    pub(crate) row: Arc<RowKey>,
    pub(crate) field: Field,
    pub(crate) range: Range<usize>,
}

/// An item's searchable text, extracted once per revision of the item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ItemText {
    fields: Vec<FieldText>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FieldText {
    /// Text the row shows, and the character it went on with where the row
    /// cut it (before the cut's mark, which is not searched).
    Plain(Field, String, Option<char>),
    /// A reply's visible text, matched there and mapped to its source.
    Markdown(VisibleText),
}

impl ItemText {
    /// Every occurrence of `query` in the item, in the order its row reads,
    /// appended to `out`.
    fn find(&self, row: &Arc<RowKey>, query: &SearchQuery, out: &mut Vec<TranscriptMatch>) {
        for field in &self.fields {
            match field {
                FieldText::Plain(field, text, next) => {
                    out.extend(
                        find_ranges_in_cut(text, *next, query).into_iter().map(|range| {
                            TranscriptMatch { row: row.clone(), field: *field, range }
                        }),
                    );
                }
                FieldText::Markdown(visible) => {
                    out.extend(find_ranges(visible.text(), query).into_iter().filter_map(
                        |range| {
                            let range = visible.source_range(range)?;
                            Some(TranscriptMatch { row: row.clone(), field: Field::Body, range })
                        },
                    ));
                }
            }
        }
    }
}

/// What the main thread hands a background search for an item whose text
/// it does not hold yet: the item's own data, owned.
#[derive(Debug)]
pub(crate) enum ItemSource {
    User(String),
    Reply(String),
    Reasoning(String),
    Tool(Box<ToolItem>, Locale),
}

impl ItemSource {
    /// The source of `item` of `turn`, or `None` for an item a find does
    /// not search (a prompt) or a row the transcript does not show.
    pub(crate) fn of(turn: &TurnView, item: &TurnItem, locale: Locale) -> Option<Self> {
        Some(match item {
            TurnItem::User(user) => Self::User(user.text().to_owned()),
            TurnItem::Text(text) => Self::Reply(text.text.clone()),
            TurnItem::Thinking(thinking) => Self::Reasoning(thinking.text.clone()),
            TurnItem::Tool(tool) if hidden_tool(tool, turn.status) => return None,
            TurnItem::Tool(tool) => Self::Tool(Box::new(tool.clone()), locale),
            _ => return None,
        })
    }

    /// The text the item's row shows, ready to search.
    pub(crate) fn extract(self) -> ItemText {
        let fields = match self {
            Self::User(text) => vec![FieldText::Plain(Field::Body, text, None)],
            Self::Reply(text) => vec![FieldText::Markdown(markdown::visible_text(&text))],
            Self::Reasoning(text) => {
                let (kept, next) = cap_cut(&text);
                vec![FieldText::Plain(Field::Body, kept.to_owned(), next)]
            }
            Self::Tool(tool, locale) => {
                let mut fields =
                    vec![FieldText::Plain(Field::ToolName, tool_name_text(&tool), None)];
                fields
                    .extend(tool_summary_cut(&tool).map(|(summary, next)| {
                        FieldText::Plain(Field::ToolSummary, summary, next)
                    }));
                fields.extend(
                    tool_detail_text(&tool, locale)
                        .map(|detail| FieldText::Plain(Field::ToolDetail, detail, None)),
                );
                fields
            }
        };
        ItemText { fields }
    }
}

/// One held item, in transcript order, as a search reads it.
#[derive(Debug)]
pub(crate) enum Entry {
    /// Text extracted by an earlier search and still current.
    Ready(Arc<RowKey>, Arc<ItemText>),
    /// To be extracted by this one.
    Pending(Arc<RowKey>, ItemSource),
}

/// What a search found, and the text it extracted on the way, for the
/// next one to reuse.
#[derive(Debug, Default)]
pub(crate) struct Found {
    pub(crate) matches: Vec<TranscriptMatch>,
    pub(crate) extracted: Vec<(Arc<RowKey>, Arc<ItemText>)>,
}

/// Searches `entries` for `query`: every match, in transcript order. Runs
/// on a background thread.
pub(crate) fn search(entries: Vec<Entry>, query: &SearchQuery) -> Found {
    let mut found = Found::default();
    for entry in entries {
        let (row, text) = match entry {
            Entry::Ready(row, text) => (row, text),
            Entry::Pending(row, source) => {
                let text = Arc::new(source.extract());
                found.extracted.push((row.clone(), text.clone()));
                (row, text)
            }
        };
        text.find(&row, query, &mut found.matches);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use search::SearchOptions;
    use transcript_model::ItemKey;

    fn row(id: &str) -> Arc<RowKey> {
        Arc::new(RowKey::Item { turn_id: "t".into(), key: ItemKey::Text(id.into()) })
    }

    #[test]
    fn a_search_reads_every_item_in_order_and_hands_back_what_it_extracted() {
        let query = SearchQuery::new("fish", SearchOptions::new());
        let cached = Arc::new(ItemSource::User("one fish".into()).extract());
        let entries = vec![
            Entry::Ready(row("a"), cached),
            Entry::Pending(row("b"), ItemSource::Reply("**Fish** and `fish`".into())),
            Entry::Pending(row("c"), ItemSource::Reasoning("no match".into())),
        ];
        let found = search(entries, &query);
        let summary: Vec<(String, std::ops::Range<usize>)> = found
            .matches
            .iter()
            .map(|found| (found.row.element_id().to_string(), found.range.clone()))
            .collect();
        assert_eq!(summary.len(), 3);
        assert_eq!(summary[0].1, 4..8);
        assert_eq!(summary[1].1, 2..6, "the reply's match is a range of its source");
        assert_eq!(summary[2].1, 14..18);
        assert_eq!(found.extracted.len(), 2, "both pending items, none of the cached");
    }
}
