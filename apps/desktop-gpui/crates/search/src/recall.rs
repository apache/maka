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

//! What a search of every task (`recall.query`) found, made ready for the
//! Search page, and the task titles that match the same phrase.
//!
//! - [`recall_input`]: the phrase as Desktop's search box sends it, its
//!   distinct words (at most 8) as literal terms, with the most passages
//!   one answer may hold.
//! - [`Answer`]: the passages grouped by task, in the order the Host ranked
//!   each task's best passage, every message as a result shows it
//!   ([`Excerpt`]), the facts from memory, and whether the Host left tasks
//!   out; or why there is nothing ([`SearchFailure`]).
//! - [`title_matches`]: the tasks whose titles match, by the command
//!   palette's fuzzy match, from the window's own list.
//!
//! Terms are found as the Host finds them (`foldForMatch` in
//! `packages/core/src/transcript-search.ts`): literal substrings after NFC,
//! in any case. Pure: a background task builds an [`Answer`].

use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;

use gpui_kit::SharedString;
use host_protocol::{
    RECALL_MAX_LIMIT, RecallFailureReason, RecallPassage, RecallQueryError, RecallQueryInput,
    RecallQueryResult, RecallRole, recall_terms_for,
};
use icu_normalizer::ComposingNormalizerBorrowed;
use workspace::HostRequestError;

use crate::matching::{find_ranges, fuzzy_score};
use crate::{SearchOptions, SearchQuery};

/// The most task titles shown above the passages.
pub const TITLE_MATCH_LIMIT: usize = 5;

/// `MAX_SESSIONS_SCANNED` (`packages/core/src/transcript-search.ts`): a
/// search reads at most this many tasks, the most recently active first.
pub const MAX_TASKS_SEARCHED: usize = 200;

/// A message's first match further in than this many characters starts
/// its excerpt [`EXCERPT_LEAD`] characters before the match.
const EXCERPT_LATE_MATCH: usize = 60;
const EXCERPT_LEAD: usize = 24;
/// The most characters of a message an excerpt keeps: more than the lines
/// a result shows of it.
const EXCERPT_MAX_CHARS: usize = 480;

const ELLIPSIS: char = '…';

/// The `recall.query` for `phrase`: its distinct words, at most
/// [`host_protocol::RECALL_MAX_TERMS`], as literal terms
/// ([`recall_terms_for`]), asking for [`RECALL_MAX_LIMIT`] passages.
/// `Ok(None)` for a blank phrase; an error for one the Host would refuse.
pub fn recall_input(phrase: &str) -> Result<Option<RecallQueryInput>, RecallQueryError> {
    let terms = recall_terms_for(phrase);
    if terms.is_empty() {
        return Ok(None);
    }
    RecallQueryInput::new(terms).and_then(|input| input.with_limit(RECALL_MAX_LIMIT)).map(Some)
}

/// `text` in Unicode NFC, the form the Host matches.
pub fn nfc(text: &str) -> Cow<'_, str> {
    ComposingNormalizerBorrowed::new_nfc().normalize(text)
}

/// Where `terms` occur in `text` (already NFC): every occurrence of each,
/// in any case, as byte ranges in order, overlapping ones merged.
pub fn term_ranges(text: &str, terms: &[impl AsRef<str>]) -> Vec<Range<usize>> {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for term in terms {
        let term = nfc(term.as_ref().trim());
        let query = SearchQuery::new(term.as_ref(), SearchOptions::new());
        ranges.extend(find_ranges(text, &query));
    }
    ranges.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

/// A text as a result shows it: NFC, its runs of whitespace one space,
/// starting a little before its first match when that lies far in, and
/// cut to a few hundred characters; with the ranges its terms occupy.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Excerpt {
    text: SharedString,
    marks: Vec<Range<usize>>,
}

impl Excerpt {
    /// The excerpt of `text` for `terms`.
    pub fn new(text: &str, terms: &[impl AsRef<str>]) -> Self {
        let mut text = nfc(text).split_whitespace().collect::<Vec<_>>().join(" ");
        let mut marks = term_ranges(&text, terms);
        if let Some(first) = marks.first()
            && text[..first.start].chars().count() > EXCERPT_LATE_MATCH
        {
            let start = lead_start(&text, first.start);
            let prefix = ELLIPSIS.len_utf8();
            text = format!("{ELLIPSIS}{}", &text[start..]);
            marks = marks
                .into_iter()
                .map(|range| range.start - start + prefix..range.end - start + prefix)
                .collect();
        }
        if let Some((end, _)) = text.char_indices().nth(EXCERPT_MAX_CHARS) {
            text.truncate(end);
            text.push(ELLIPSIS);
            marks.retain_mut(|range| {
                range.end = range.end.min(end);
                range.start < range.end
            });
        }
        Self { text: text.into(), marks }
    }

    pub fn text(&self) -> &SharedString {
        &self.text
    }

    /// Byte ranges of [`Self::text`] the terms occupy, in order, apart.
    pub fn marks(&self) -> &[Range<usize>] {
        &self.marks
    }
}

/// Where an excerpt starts to lead into a match at byte `at`: about
/// [`EXCERPT_LEAD`] characters before it, at the start of a word when one
/// starts there.
fn lead_start(text: &str, at: usize) -> usize {
    let before: Vec<(usize, char)> = text[..at].char_indices().collect();
    let from = before.len().saturating_sub(EXCERPT_LEAD);
    before[from..]
        .iter()
        .position(|(_, c)| *c == ' ')
        .and_then(|space| before.get(from + space + 1))
        .or_else(|| before.get(from))
        .map_or(at, |(ix, _)| *ix)
}

/// Where to open a task at a passage: the message the terms matched, by
/// its id and by its 0-based index in the task's transcript, its Turn, and
/// the term to find there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassageTarget {
    session_id: SharedString,
    anchor_message_id: SharedString,
    sequence: u64,
    turn_id: Option<SharedString>,
    term: Option<SharedString>,
}

impl PassageTarget {
    pub fn new(
        session_id: impl Into<SharedString>,
        anchor_message_id: impl Into<SharedString>,
        sequence: u64,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            anchor_message_id: anchor_message_id.into(),
            sequence,
            turn_id: None,
            term: None,
        }
    }

    /// The Turn the message is in.
    pub fn with_turn_id(mut self, turn_id: impl Into<SharedString>) -> Self {
        self.turn_id = Some(turn_id.into());
        self
    }

    /// The term the find bar looks for once the task shows the message.
    pub fn with_term(mut self, term: impl Into<SharedString>) -> Self {
        self.term = Some(term.into());
        self
    }

    pub fn session_id(&self) -> &SharedString {
        &self.session_id
    }

    pub fn anchor_message_id(&self) -> &SharedString {
        &self.anchor_message_id
    }

    /// The message's index in the task's transcript.
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn turn_id(&self) -> Option<&SharedString> {
        self.turn_id.as_ref()
    }

    pub fn term(&self) -> Option<&SharedString> {
        self.term.as_ref()
    }
}

/// One message of a passage.
#[derive(Debug, Clone, PartialEq)]
pub struct PassageMessage {
    role: RecallRole,
    anchor: bool,
    excerpt: Excerpt,
}

impl PassageMessage {
    pub fn role(&self) -> &RecallRole {
        &self.role
    }

    /// Whether this is the message the terms matched.
    pub fn is_anchor(&self) -> bool {
        self.anchor
    }

    pub fn excerpt(&self) -> &Excerpt {
        &self.excerpt
    }
}

/// A message the terms matched, with its neighbours in the same Turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Passage {
    target: PassageTarget,
    messages: Vec<PassageMessage>,
    has_more_before: bool,
    has_more_after: bool,
    truncated: bool,
}

impl Passage {
    fn new(passage: RecallPassage) -> Self {
        let terms = &passage.matched_terms;
        let mut target = PassageTarget::new(
            passage.session_id.clone(),
            passage.anchor_message_id.clone(),
            passage.sequence,
        );
        if let Some(turn_id) = passage.turn_id.clone() {
            target = target.with_turn_id(turn_id);
        }
        if let Some(term) = seed_term(&passage) {
            target = target.with_term(term);
        }
        let messages = passage
            .messages
            .iter()
            .map(|message| PassageMessage {
                role: message.role.clone(),
                anchor: message.is_anchor,
                excerpt: Excerpt::new(&message.text, terms),
            })
            .collect();
        Self {
            target,
            messages,
            has_more_before: passage.has_more_before,
            has_more_after: passage.has_more_after,
            truncated: passage.truncated,
        }
    }

    /// Where opening it goes.
    pub fn target(&self) -> &PassageTarget {
        &self.target
    }

    /// In the Turn's order.
    pub fn messages(&self) -> &[PassageMessage] {
        &self.messages
    }

    pub fn anchor(&self) -> Option<&PassageMessage> {
        self.messages.iter().find(|message| message.anchor)
    }

    /// The Turn has messages before the ones kept.
    pub fn has_more_before(&self) -> bool {
        self.has_more_before
    }

    /// The Turn has messages after the ones kept.
    pub fn has_more_after(&self) -> bool {
        self.has_more_after
    }

    /// The Host cut its text to the passage caps.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }
}

/// The term the find bar looks for in the task: the first of the matched
/// terms the anchor message holds, else the first matched term.
fn seed_term(passage: &RecallPassage) -> Option<String> {
    let anchor = passage.anchor().map(|message| nfc(&message.text).into_owned());
    passage
        .matched_terms
        .iter()
        .find(|term| anchor.as_deref().is_some_and(|text| !term_ranges(text, &[term]).is_empty()))
        .or_else(|| passage.matched_terms.first())
        .cloned()
}

/// One task's passages, best first.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskPassages {
    session_id: SharedString,
    session_title: SharedString,
    last_message_at: Option<u64>,
    passages: Vec<Passage>,
}

impl TaskPassages {
    pub fn session_id(&self) -> &SharedString {
        &self.session_id
    }

    /// The task's title as the Host named it in the answer; empty for an
    /// unnamed task.
    pub fn session_title(&self) -> &SharedString {
        &self.session_title
    }

    /// The latest of its passages' last messages, Unix milliseconds.
    pub fn last_message_at(&self) -> Option<u64> {
        self.last_message_at
    }

    pub fn passages(&self) -> &[Passage] {
        &self.passages
    }
}

/// What a search found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Found {
    facts: Vec<Excerpt>,
    tasks: Vec<TaskPassages>,
    scan_capped: bool,
}

impl Found {
    /// `passages` (best first) grouped by task, each task where its best
    /// passage ranks; `facts` with `terms` marked.
    fn new(facts: Vec<String>, passages: Vec<RecallPassage>, gaps: &str, terms: &[String]) -> Self {
        let mut tasks: Vec<TaskPassages> = Vec::new();
        for passage in passages {
            let last = passage.last_message_at;
            let ix = match tasks.iter().position(|task| task.session_id == passage.session_id) {
                Some(ix) => ix,
                None => {
                    tasks.push(TaskPassages {
                        session_id: passage.session_id.clone().into(),
                        session_title: passage.session_title.clone().into(),
                        last_message_at: None,
                        passages: Vec::new(),
                    });
                    tasks.len() - 1
                }
            };
            let task = &mut tasks[ix];
            task.last_message_at = task.last_message_at.max(last);
            task.passages.push(Passage::new(passage));
        }
        Self {
            facts: facts.iter().map(|fact| Excerpt::new(fact, terms)).collect(),
            tasks,
            scan_capped: scan_capped(gaps),
        }
    }

    /// Leaves out the passages of the Sessions in `hidden` (a side chat's
    /// fork copies its task's words, but is no task of its own).
    pub(crate) fn drop_sessions(&mut self, hidden: &HashSet<SharedString>) {
        self.tasks.retain(|task| !hidden.contains(&task.session_id));
    }

    /// Distilled facts from memory that match.
    pub fn facts(&self) -> &[Excerpt] {
        &self.facts
    }

    /// The tasks with passages, in the order the Host ranked their best.
    pub fn tasks(&self) -> &[TaskPassages] {
        &self.tasks
    }

    /// Whether the Host searched only the [`MAX_TASKS_SEARCHED`] most
    /// recently active tasks, leaving older ones out.
    pub fn is_scan_capped(&self) -> bool {
        self.scan_capped
    }

    /// Nothing found: no passage and no fact.
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty() && self.facts.is_empty()
    }
}

/// Whether the answer's `gaps` say the Host stopped at
/// [`MAX_TASKS_SEARCHED`] tasks: its one statement for people about what
/// was left out (`describeGaps` in `packages/core/src/recall.ts`; the rest
/// of `gaps` is written for the model, in English). `searchedEverySession`
/// does not say this: it is false whenever the Host's index narrowed the
/// tasks to read, an index that names every task that can match.
fn scan_capped(gaps: &str) -> bool {
    gaps.contains("Session scan capped at")
}

/// Why a search shows nothing.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SearchFailure {
    /// The Host's search refused (`ok: false`).
    Refused(RecallFailureReason),
    /// The query cannot be sent as it is (a term too long).
    Invalid,
    /// No connection to the Host.
    NotConnected,
    /// The request did not reach the search or came back unreadable.
    Unreachable,
}

/// A search's outcome, ready to show.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Found(Found),
    Failed(SearchFailure),
}

impl Answer {
    /// The Host's answer to a search for `terms`.
    pub fn from_result(
        result: Result<RecallQueryResult, HostRequestError>,
        terms: &[String],
    ) -> Self {
        match result {
            Ok(RecallQueryResult::Found { facts, passages, gaps, .. }) => {
                let facts = facts.into_iter().map(|fact| fact.content).collect();
                Self::Found(Found::new(facts, passages, &gaps, terms))
            }
            Ok(RecallQueryResult::Failed { reason, message }) => {
                log::info!("search refused: {reason} ({message})");
                Self::Failed(SearchFailure::Refused(reason))
            }
            Err(HostRequestError::NotConnected) => Self::Failed(SearchFailure::NotConnected),
            Err(error) => {
                log::warn!("search failed: {error}");
                Self::Failed(SearchFailure::Unreachable)
            }
            Ok(_) => Self::Failed(SearchFailure::Unreachable),
        }
    }
}

/// A task the window lists, as the Search page shows it: its title as the
/// sidebar shows it, its project's name when it has one, whether it is
/// archived, and when it was last active (Unix milliseconds).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TaskEntry {
    pub id: SharedString,
    pub title: SharedString,
    pub project: Option<SharedString>,
    pub archived: bool,
    pub activity_at: u64,
}

impl TaskEntry {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self { id: id.into(), title: title.into(), project: None, archived: false, activity_at: 0 }
    }

    pub fn with_project(mut self, project: Option<SharedString>) -> Self {
        self.project = project;
        self
    }

    pub fn archived(mut self, archived: bool) -> Self {
        self.archived = archived;
        self
    }

    pub fn with_activity_at(mut self, activity_at: u64) -> Self {
        self.activity_at = activity_at;
        self
    }
}

/// The positions in `tasks` of the titles `phrase` matches, best first (the
/// palette's fuzzy match; the more recently active first among equals), at
/// most [`TITLE_MATCH_LIMIT`]. None for a blank phrase.
pub fn title_matches(tasks: &[TaskEntry], phrase: &str) -> Vec<usize> {
    let phrase = phrase.trim();
    if phrase.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, i32)> = tasks
        .iter()
        .enumerate()
        .filter_map(|(ix, task)| fuzzy_score(phrase, &task.title).map(|score| (ix, score)))
        .collect();
    scored.sort_by_key(|(ix, score)| {
        (std::cmp::Reverse(*score), std::cmp::Reverse(tasks[*ix].activity_at))
    });
    scored.into_iter().take(TITLE_MATCH_LIMIT).map(|(ix, _)| ix).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn marked(excerpt: &Excerpt) -> Vec<&str> {
        excerpt.marks().iter().map(|range| &excerpt.text()[range.clone()]).collect()
    }

    #[test]
    fn a_phrase_becomes_its_distinct_words_and_asks_for_every_passage() {
        let input = recall_input("  reconnect backoff reconnect ").expect("valid").expect("terms");
        assert_eq!(input.terms, ["reconnect", "backoff"]);
        assert_eq!(input.limit, Some(25));
        assert_eq!(recall_input(" \t ").expect("valid"), None);
        let nine = "a b c d e f g h i";
        assert_eq!(recall_input(nine).expect("valid").expect("terms").terms.len(), 8);
        assert!(recall_input(&"x".repeat(501)).is_err(), "a term past 500 characters");
    }

    #[test]
    fn every_occurrence_of_each_term_is_marked_in_any_case_and_in_nfc() {
        let excerpt =
            Excerpt::new("Reconnect, then RECONNECT with backoff.", &["reconnect", "backoff"]);
        assert_eq!(marked(&excerpt), ["Reconnect", "RECONNECT", "backoff"]);
        // A Chinese term inside a run of Chinese.
        let excerpt = Excerpt::new("客户端的重连退避从 100 毫秒开始，重连成功后清零。", &["重连"]);
        assert_eq!(marked(&excerpt), ["重连", "重连"]);
        // "é" written as e and a combining acute matches "é" composed.
        let excerpt = Excerpt::new("Cafe\u{301} au lait", &["café"]);
        assert_eq!(excerpt.text(), "Café au lait");
        assert_eq!(marked(&excerpt), ["Café"]);
        // Overlapping terms mark one range.
        let excerpt = Excerpt::new("backoffice", &["back", "backoff"]);
        assert_eq!(marked(&excerpt), ["backoff"]);
    }

    #[test]
    fn an_excerpt_folds_whitespace_and_starts_near_a_late_match() {
        let excerpt = Excerpt::new("one\n\n  two\tthree", &["two"]);
        assert_eq!(excerpt.text(), "one two three");
        let lead = "word ".repeat(30);
        let excerpt = Excerpt::new(&format!("{lead}the needle here"), &["needle"]);
        assert!(excerpt.text().starts_with('…'), "{}", excerpt.text());
        assert!(excerpt.text().ends_with("the needle here"));
        assert!(excerpt.text().chars().count() < 40, "{}", excerpt.text());
        assert_eq!(marked(&excerpt), ["needle"]);
        // An early match keeps the start; a long text is cut.
        let long = format!("needle {}", "x".repeat(600));
        let excerpt = Excerpt::new(&long, &["needle"]);
        assert!(excerpt.text().starts_with("needle"));
        assert_eq!(excerpt.text().chars().count(), EXCERPT_MAX_CHARS + 1);
        assert!(excerpt.text().ends_with('…'));
    }

    fn passage(session: &str, anchor: &str, terms: &[&str], last: u64) -> serde_json::Value {
        json!({
            "sessionId": session, "sessionTitle": format!("Task {session}"),
            "turnId": format!("{session}-t"), "anchorMessageId": anchor, "sequence": 3,
            "messages": [
                {"messageId": "m0", "role": "user", "matchKind": "user_message",
                 "text": "Why does it retry?", "timestamp": 1, "isAnchor": false},
                {"messageId": anchor, "role": "assistant", "matchKind": "assistant_message",
                 "text": "It retries with backoff.", "timestamp": 2, "isAnchor": true}
            ],
            "matchedTerms": terms, "score": 1.0, "lastMessageAt": last,
            "hasMoreBefore": true, "hasMoreAfter": false
        })
    }

    fn found(passages: Vec<serde_json::Value>, gaps: &str) -> Found {
        let result: RecallQueryResult = serde_json::from_value(json!({
            "ok": true, "facts": [{"content": "Retries back off.", "kind": "fact",
                                   "observedAt": 1}],
            "passages": passages, "gaps": gaps, "searchedEverySession": false
        }))
        .expect("result");
        match Answer::from_result(Ok(result), &["retry".into()]) {
            Answer::Found(found) => found,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn passages_group_by_task_where_each_task_s_best_ranks() {
        let found = found(
            vec![
                passage("s1", "a1", &["backoff"], 5),
                passage("s2", "b1", &["retry"], 9),
                passage("s1", "a2", &["retry", "backoff"], 7),
            ],
            "Searched 3 Session(s).",
        );
        let tasks: Vec<(&str, Vec<&str>)> = found
            .tasks()
            .iter()
            .map(|task| {
                let anchors =
                    task.passages().iter().map(|p| p.target().anchor_message_id().as_ref());
                (task.session_id().as_ref(), anchors.collect())
            })
            .collect();
        assert_eq!(tasks, [("s1", vec!["a1", "a2"]), ("s2", vec!["b1"])]);
        assert_eq!(found.tasks()[0].last_message_at(), Some(7), "its latest passage");
        assert_eq!(found.tasks()[0].session_title(), "Task s1");
        let first = &found.tasks()[0].passages()[0];
        assert!(first.has_more_before() && !first.has_more_after() && !first.is_truncated());
        assert_eq!(
            first.anchor().map(|m| m.excerpt().text().as_ref()),
            Some("It retries with backoff.")
        );
        assert_eq!(first.target().turn_id().map(|t| t.as_ref()), Some("s1-t"));
        assert_eq!(found.facts().len(), 1);
        assert!(!found.is_scan_capped(), "searchedEverySession false is not a gap");
    }

    #[test]
    fn the_find_term_is_the_first_matched_term_the_anchor_holds() {
        let found = found(vec![passage("s1", "a1", &["why", "backoff"], 1)], "");
        let target = found.tasks()[0].passages()[0].target();
        assert_eq!(target.term().map(|t| t.as_ref()), Some("backoff"), "\"why\" is a neighbour's");
        let found = found_with_terms(&["absent"]);
        assert_eq!(
            found.tasks()[0].passages()[0].target().term().map(|t| t.as_ref()),
            Some("absent")
        );
    }

    fn found_with_terms(terms: &[&str]) -> Found {
        found(vec![passage("s1", "a1", terms, 1)], "")
    }

    #[test]
    fn a_capped_scan_is_told_and_other_gaps_are_not() {
        let gaps = "No distilled facts matched. Searched 200 Session(s). Session scan capped at \
                    200; older Sessions were not read.";
        assert!(found(vec![], gaps).is_scan_capped());
        assert!(
            !found(vec![], "No transcript match for: x. Searched 28 Session(s).").is_scan_capped()
        );
    }

    #[test]
    fn failures_say_whether_the_search_or_the_connection_refused() {
        let refused: RecallQueryResult = serde_json::from_value(
            json!({"ok": false, "reason": "incognito_active", "message": "m"}),
        )
        .expect("result");
        assert_eq!(
            Answer::from_result(Ok(refused), &[]),
            Answer::Failed(SearchFailure::Refused(RecallFailureReason::IncognitoActive))
        );
        assert_eq!(
            Answer::from_result(Err(HostRequestError::NotConnected), &[]),
            Answer::Failed(SearchFailure::NotConnected)
        );
        assert_eq!(
            Answer::from_result(Err(HostRequestError::Transport("closed".into())), &[]),
            Answer::Failed(SearchFailure::Unreachable)
        );
    }

    #[test]
    fn titles_match_fuzzily_best_first_at_most_five() {
        let tasks: Vec<TaskEntry> = [
            ("s1", "Plan the release", 1),
            ("s2", "Release notes", 2),
            ("s3", "Unrelated", 3),
            ("s4", "release 4", 4),
            ("s5", "release 5", 5),
            ("s6", "release 6", 6),
            ("s7", "release 7", 7),
        ]
        .into_iter()
        .map(|(id, title, at)| TaskEntry::new(id, title).with_activity_at(at))
        .collect();
        let ids: Vec<&str> =
            title_matches(&tasks, "release").into_iter().map(|ix| tasks[ix].id.as_ref()).collect();
        assert_eq!(ids.len(), TITLE_MATCH_LIMIT);
        assert_eq!(&ids[..4], ["s7", "s6", "s5", "s4"], "prefix matches, the latest first");
        assert!(!ids.contains(&"s3"));
        assert!(title_matches(&tasks, "  ").is_empty());
    }
}

/// The answers F33 recorded from a real Host.
#[cfg(test)]
mod fixture_tests {
    use serde_json::Value;

    use super::*;

    fn recorded() -> Vec<Value> {
        include_str!("../../host-protocol/fixtures/sequences/recall.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).expect("JSON"))
            .collect()
    }

    fn answer(line: &Value, terms: &[String]) -> Answer {
        let result: RecallQueryResult =
            serde_json::from_value(line["result"].clone()).expect("result");
        Answer::from_result(Ok(result), terms)
    }

    #[test]
    fn a_recorded_answer_groups_and_marks_as_the_page_shows_it() {
        let lines = recorded();
        let terms: Vec<String> =
            serde_json::from_value(lines[0]["input"]["terms"].clone()).expect("terms");
        let Answer::Found(found) = answer(&lines[1], &terms) else { panic!("found") };
        let titles: Vec<&str> =
            found.tasks().iter().map(|task| task.session_title().as_ref()).collect();
        assert_eq!(titles, ["Explain the reconnect backoff", "Map the workspace crates"]);
        let first = &found.tasks()[0].passages()[0];
        assert_eq!(first.target().sequence(), 0);
        assert_eq!(first.target().term().map(|term| term.as_ref()), Some("backoff"));
        let anchor = first.anchor().expect("anchor").excerpt();
        let marked: Vec<&str> =
            anchor.marks().iter().map(|range| &anchor.text()[range.clone()]).collect();
        assert_eq!(marked, ["reconnect", "backoff"]);
        // The reply's neighbour marks its terms too, in any case.
        let reply = first.messages()[1].excerpt();
        assert!(reply.marks().len() >= 2, "{reply:?}");
        assert_eq!(
            found.tasks()[1].passages()[0].target().term().map(|t| t.as_ref()),
            Some("reconnect")
        );
        assert!(!found.is_scan_capped(), "28 tasks searched");

        let Answer::Failed(failure) = answer(&lines[3], &[]) else { panic!("failed") };
        assert_eq!(failure, SearchFailure::Refused(RecallFailureReason::InvalidQuery));
    }
}
